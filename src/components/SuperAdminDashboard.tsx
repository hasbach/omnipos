import React, { useState, useEffect } from 'react';
import { Tenant } from '../types';
import { 
  Users, 
  Shield, 
  Calendar, 
  Clock, 
  CheckCircle2, 
  XCircle, 
  Save, 
  RefreshCw,
  Globe,
  Monitor,
  Zap
} from 'lucide-react';
import { motion } from 'motion/react';

export default function SuperAdminDashboard() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<Partial<Tenant>>({});

  const fetchTenants = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/tenants');
      if (res.ok) {
        const data = await res.json();
        setTenants(data);
      }
    } catch (err) {
      console.error('Fetch tenants error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTenants();
  }, []);

  const handleEdit = (tenant: Tenant) => {
    setEditingId(tenant.id);
    setEditForm(tenant);
  };

  const handleSave = async (id: number) => {
    try {
      const res = await fetch(`/api/admin/tenants/${id}/license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm)
      });
      if (res.ok) {
        setEditingId(null);
        fetchTenants();
      }
    } catch (err) {
      console.error('Save license error:', err);
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
    <div className="space-y-6 p-6 h-full overflow-y-auto">
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

      {/* System Update Trigger */}
      <div className="p-8 bg-app-ink text-app-bg rounded-3xl space-y-6 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 p-8 opacity-10">
          <RefreshCw size={120} />
        </div>
        <div className="relative z-10 space-y-4">
          <div className="flex items-center gap-3">
            <Zap className="text-yellow-400" />
            <h2 className="text-xl font-black uppercase tracking-tight">System-Wide Update</h2>
          </div>
          <p className="text-sm opacity-70 max-w-md">Push a new version to all connected terminals. This will notify all business owners to install or schedule the update.</p>
          
          <div className="flex gap-4 items-end">
            <div className="space-y-2">
              <p className="text-[10px] font-black uppercase opacity-50">Target Version</p>
              <input 
                type="text" 
                placeholder="e.g. 2.6.0"
                className="bg-white/10 border border-white/20 rounded-xl px-4 py-2 text-sm outline-none focus:border-white transition-all"
                id="update-version-input"
              />
            </div>
            <button 
              onClick={async () => {
                const input = document.getElementById('update-version-input') as HTMLInputElement;
                if (!input.value) return alert('Please enter a version number');
                if (confirm(`Are you sure you want to push version ${input.value} to ALL tenants?`)) {
                  try {
                    const res = await fetch('/api/admin/tenants/trigger-update', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ version: input.value })
                    });
                    if (res.ok) {
                      alert('Update pushed successfully!');
                      input.value = '';
                    }
                  } catch (err) {
                    console.error(err);
                  }
                }
              }}
              className="px-8 py-2 bg-white text-app-ink rounded-xl font-black uppercase text-[10px] tracking-widest hover:bg-yellow-400 transition-all"
            >
              Push Update
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-4">
        {tenants.map(tenant => (
          <motion.div 
            key={tenant.id}
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
              
              {editingId === tenant.id ? (
                <button 
                  onClick={() => handleSave(tenant.id)}
                  className="px-4 py-2 bg-app-ink text-app-bg rounded-lg font-bold uppercase text-[10px] flex items-center gap-2"
                >
                  <Save size={14} /> Save Changes
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
                
                {editingId === tenant.id ? (
                  <div className="space-y-3">
                    <select 
                      className="w-full bg-app-surface border border-app-border rounded-lg p-2 text-xs"
                      value={editForm.local_license_type}
                      onChange={e => setEditForm({...editForm, local_license_type: e.target.value as any})}
                    >
                      <option value="year">Yearly</option>
                      <option value="lifetime">Lifetime</option>
                    </select>
                    {editForm.local_license_type === 'year' && (
                      <input 
                        type="date"
                        className="w-full bg-app-surface border border-app-border rounded-lg p-2 text-xs"
                        value={editForm.local_license_expiry?.split('T')[0] || ''}
                        onChange={e => setEditForm({...editForm, local_license_expiry: e.target.value})}
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
                
                {editingId === tenant.id ? (
                  <div className="space-y-3">
                    <select 
                      className="w-full bg-app-surface border border-app-border rounded-lg p-2 text-xs"
                      value={editForm.online_license_type}
                      onChange={e => setEditForm({...editForm, online_license_type: e.target.value as any})}
                    >
                      <option value="monthly">Monthly</option>
                      <option value="lifetime">Lifetime</option>
                    </select>
                    {editForm.online_license_type === 'monthly' && (
                      <input 
                        type="date"
                        className="w-full bg-app-surface border border-app-border rounded-lg p-2 text-xs"
                        value={editForm.online_license_expiry?.split('T')[0] || ''}
                        onChange={e => setEditForm({...editForm, online_license_expiry: e.target.value})}
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
