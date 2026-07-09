import React, { useState, useEffect } from 'react';
import {
  Users,
  Shield,
  CheckCircle2,
  XCircle,
  Save,
  RefreshCw,
  Globe,
  Monitor,
} from 'lucide-react';
import { motion } from 'motion/react';
import { supabase } from '../lib/supabase';

// Web counterpart to src/components/SuperAdminDashboard.tsx (desktop). That version reads/
// writes a local SQLite database via local Express endpoints, which only ever reflects
// whatever tenant data has synced to that specific machine. This version talks to Supabase
// directly, so it can see every tenant regardless of which machine registered them —
// gated by the "Super admin read all tenants" RLS policy and the admin_update_tenant_license
// RPC (see supabase_super_admin.sql), both scoped to the hasbach account only.
//
// Deliberately excluded here: the desktop dashboard's "System-Wide Update" push button —
// that broadcasts over a local WebSocket to LAN-connected terminals, which has no meaning
// from a standalone web app with no connection to any specific business's local network.

interface AdminTenant {
  global_id: string;
  name: string;
  email: string;
  local_license_type: 'year' | 'lifetime';
  local_license_expiry?: string;
  online_license_type: 'monthly' | 'lifetime';
  online_license_expiry?: string;
  created_at?: string;
}

export default function SuperAdminWeb() {
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<AdminTenant>>({});
  const [saving, setSaving] = useState(false);

  const fetchTenants = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('tenants')
        .select('global_id, name, email, local_license_type, local_license_expiry, online_license_type, online_license_expiry, created_at')
        .order('created_at', { ascending: false });

      if (!error && data) setTenants(data as AdminTenant[]);
    } catch (err) {
      console.error('Fetch tenants error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTenants();
  }, []);

  const handleEdit = (tenant: AdminTenant) => {
    setEditingId(tenant.global_id);
    setEditForm(tenant);
  };

  const handleSave = async (globalId: string) => {
    setSaving(true);
    try {
      const { error } = await supabase.rpc('admin_update_tenant_license', {
        p_tenant_id: globalId,
        p_local_license_type: editForm.local_license_type,
        p_local_license_expiry: editForm.local_license_expiry || null,
        p_online_license_type: editForm.online_license_type,
        p_online_license_expiry: editForm.online_license_expiry || null,
      });

      if (!error) {
        setEditingId(null);
        fetchTenants();
      } else {
        alert(`Failed to save: ${error.message}`);
      }
    } catch (err) {
      console.error('Save license error:', err);
    } finally {
      setSaving(false);
    }
  };

  const isExpired = (expiry?: string) => {
    if (!expiry) return false;
    return new Date(expiry) < new Date();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin opacity-20" size={32} />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <header className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black tracking-tighter uppercase flex items-center gap-3">
            <Shield className="text-app-ink" /> Super Admin Control
          </h1>
          <p className="opacity-50 font-medium">Manage business licenses and subscriptions.</p>
        </div>
        <button
          onClick={fetchTenants}
          className="p-3 bg-app-surface border border-app-border rounded-xl hover:bg-app-bg transition-all"
        >
          <RefreshCw size={20} />
        </button>
      </header>

      <div className="grid gap-4">
        {tenants.map(tenant => (
          <motion.div
            key={tenant.global_id}
            layout
            className="bg-app-surface border border-app-border rounded-2xl p-6 shadow-sm hover:shadow-md transition-all"
          >
            <div className="flex justify-between items-start">
              <div className="flex gap-4">
                <div className="w-12 h-12 bg-app-ink/5 rounded-xl flex items-center justify-center">
                  <Users className="opacity-40" />
                </div>
                <div>
                  <h3 className="font-black uppercase text-lg">{tenant.name}</h3>
                  <p className="text-xs opacity-50 font-mono">{tenant.email}</p>
                </div>
              </div>

              {editingId === tenant.global_id ? (
                <button
                  onClick={() => handleSave(tenant.global_id)}
                  disabled={saving}
                  className="px-4 py-2 bg-app-ink text-app-bg rounded-lg font-bold uppercase text-[10px] flex items-center gap-2 disabled:opacity-50"
                >
                  <Save size={14} /> {saving ? 'Saving...' : 'Save Changes'}
                </button>
              ) : (
                <button
                  onClick={() => handleEdit(tenant)}
                  className="px-4 py-2 bg-app-bg border border-app-border rounded-lg font-bold uppercase text-[10px]"
                >
                  Edit License
                </button>
              )}
            </div>

            <div className="grid md:grid-cols-2 gap-6 mt-6">
              {/* Local Software License */}
              <div className="space-y-3 p-4 bg-app-bg/50 rounded-xl border border-app-border">
                <div className="flex items-center gap-2 text-[10px] font-black uppercase opacity-40">
                  <Monitor size={14} /> Local Software
                </div>

                {editingId === tenant.global_id ? (
                  <div className="space-y-3">
                    <select
                      className="w-full bg-app-surface border border-app-border rounded-lg p-2 text-xs"
                      value={editForm.local_license_type}
                      onChange={e => setEditForm({ ...editForm, local_license_type: e.target.value as any })}
                    >
                      <option value="year">Yearly</option>
                      <option value="lifetime">Lifetime</option>
                    </select>
                    {editForm.local_license_type === 'year' && (
                      <input
                        type="date"
                        className="w-full bg-app-surface border border-app-border rounded-lg p-2 text-xs"
                        value={editForm.local_license_expiry?.split('T')[0] || ''}
                        onChange={e => setEditForm({ ...editForm, local_license_expiry: e.target.value })}
                      />
                    )}
                  </div>
                ) : (
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <span className="font-black uppercase text-sm">{tenant.local_license_type}</span>
                      {tenant.local_license_type === 'year' && (
                        <span className="text-[10px] opacity-50">
                          Exp: {tenant.local_license_expiry ? new Date(tenant.local_license_expiry).toLocaleDateString() : 'N/A'}
                        </span>
                      )}
                    </div>
                    {tenant.local_license_type === 'lifetime' || !isExpired(tenant.local_license_expiry) ? (
                      <CheckCircle2 className="text-green-500" size={18} />
                    ) : (
                      <XCircle className="text-red-500" size={18} />
                    )}
                  </div>
                )}
              </div>

              {/* Online Monitor License */}
              <div className="space-y-3 p-4 bg-app-bg/50 rounded-xl border border-app-border">
                <div className="flex items-center gap-2 text-[10px] font-black uppercase opacity-40">
                  <Globe size={14} /> Online Monitor
                </div>

                {editingId === tenant.global_id ? (
                  <div className="space-y-3">
                    <select
                      className="w-full bg-app-surface border border-app-border rounded-lg p-2 text-xs"
                      value={editForm.online_license_type}
                      onChange={e => setEditForm({ ...editForm, online_license_type: e.target.value as any })}
                    >
                      <option value="monthly">Monthly</option>
                      <option value="lifetime">Lifetime</option>
                    </select>
                    {editForm.online_license_type === 'monthly' && (
                      <input
                        type="date"
                        className="w-full bg-app-surface border border-app-border rounded-lg p-2 text-xs"
                        value={editForm.online_license_expiry?.split('T')[0] || ''}
                        onChange={e => setEditForm({ ...editForm, online_license_expiry: e.target.value })}
                      />
                    )}
                  </div>
                ) : (
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <span className="font-black uppercase text-sm">{tenant.online_license_type}</span>
                      {tenant.online_license_type === 'monthly' && (
                        <span className="text-[10px] opacity-50">
                          Exp: {tenant.online_license_expiry ? new Date(tenant.online_license_expiry).toLocaleDateString() : 'N/A'}
                        </span>
                      )}
                    </div>
                    {tenant.online_license_type === 'lifetime' || !isExpired(tenant.online_license_expiry) ? (
                      <CheckCircle2 className="text-green-500" size={18} />
                    ) : (
                      <XCircle className="text-red-500" size={18} />
                    )}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
