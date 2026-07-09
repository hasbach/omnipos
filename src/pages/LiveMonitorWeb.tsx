import React, { useState, useEffect } from 'react';
import { Zap, Globe } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { supabase } from '../lib/supabase';
import { Tenant } from '../types';

export default function LiveMonitorWeb({ tenant }: { tenant: Tenant }) {
  const [activities, setActivities] = useState<any[]>([]);
  const [stats, setStats] = useState({
    todayTotal: 0,
    todayCount: 0,
    activeUsers: new Set<string>(),
  });

  useEffect(() => {
    const fetchTodayData = async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const { data, error } = await supabase
        .from('transactions')
        .select(`
          local_id, global_id, type, total_amount, currency, created_at,
          users ( name ),
          stakeholders ( name )
        `)
        .eq('tenant_id', tenant.global_id)
        .order('created_at', { ascending: false })
        .limit(1000);

      if (error) {
        console.error('Error fetching data:', error);
        return;
      }

      if (data) {
        const formatted = data.map((tx: any) => ({
          ...tx,
          // Append Z to force UTC parsing since SQLite/Supabase stored it as UTC without timezone
          created_at: tx.created_at.includes('Z') ? tx.created_at : `${tx.created_at}Z`,
          user_name: tx.users?.name || 'Unknown',
          stakeholder_name: tx.stakeholders?.name
        }));
        setActivities(formatted.slice(0, 50));

        // Filter for "Today's Stats"
        const todaysTransactions = formatted.filter((t: any) => new Date(t.created_at) >= today);
        const total = todaysTransactions.reduce((acc: number, t: any) => acc + t.total_amount, 0);
        const users = new Set(todaysTransactions.map((t: any) => t.user_name));
        setStats({
          todayTotal: total,
          todayCount: todaysTransactions.length,
          activeUsers: users as Set<string>
        });
      }
    };

    fetchTodayData();

    // Subscribe to Real-time Inserts
    const channel = supabase.channel('monitor-transactions')
      .on('postgres_changes', { 
        event: 'INSERT', 
        schema: 'public', 
        table: 'transactions',
        filter: `tenant_id=eq.${tenant.global_id}`
      }, async (payload) => {
        const newTx = payload.new;
        
        // Fetch user and stakeholder names for the new tx since payload only has FKs
        const { data: user } = await supabase.from('users').select('name').eq('global_id', newTx.user_id).single();
        const { data: stakeholder } = newTx.stakeholder_id ? await supabase.from('stakeholders').select('name').eq('global_id', newTx.stakeholder_id).single() : { data: null };

        const formattedTx = {
          ...newTx,
          created_at: newTx.created_at && newTx.created_at.includes('Z') ? newTx.created_at : `${newTx.created_at}Z`,
          user_name: user?.name || 'Unknown',
          stakeholder_name: stakeholder?.name
        };

        setActivities(prev => [formattedTx, ...prev].slice(0, 50));
        setStats(prev => ({
          todayTotal: prev.todayTotal + newTx.total_amount,
          todayCount: prev.todayCount + 1,
          activeUsers: new Set([...Array.from(prev.activeUsers), formattedTx.user_name])
        }));
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [tenant.global_id]);

  const isOnlineExpired = tenant.email !== 'hasbach' && (tenant.online_license_type !== 'lifetime' && (!tenant.online_license_expiry || new Date(tenant.online_license_expiry) < new Date()));

  if (isOnlineExpired) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-12 text-center space-y-6">
        <div className="w-20 h-20 bg-orange-500/10 text-orange-500 rounded-full flex items-center justify-center">
          <Globe size={40} />
        </div>
        <div className="max-w-md space-y-2">
          <h2 className="text-2xl font-black uppercase tracking-tight">Online Monitor Expired</h2>
          <p className="opacity-50 text-sm">Your online monitoring subscription has expired. Please renew to access real-time terminal tracking.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      {/* Real-time Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="p-8 bg-app-surface border border-app-border rounded-3xl shadow-sm">
          <p className="text-[10px] font-black uppercase opacity-50 tracking-widest mb-1">Sales Today</p>
          <p className="text-4xl font-black font-mono">${stats.todayTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
        </div>
        <div className="p-8 bg-app-surface border border-app-border rounded-3xl shadow-sm">
          <p className="text-[10px] font-black uppercase opacity-50 tracking-widest mb-1">Transactions</p>
          <p className="text-4xl font-black font-mono">{stats.todayCount}</p>
        </div>
        <div className="p-8 bg-app-surface border border-app-border rounded-3xl shadow-sm">
          <p className="text-[10px] font-black uppercase opacity-50 tracking-widest mb-1">Active Staff</p>
          <p className="text-4xl font-black font-mono">{stats.activeUsers.size}</p>
        </div>
      </div>

      {/* Activity Feed */}
      <div className="bg-app-surface border border-app-border rounded-[40px] overflow-hidden shadow-xl">
        <div className="p-8 border-b border-app-border flex items-center justify-between bg-app-bg/10">
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 bg-emerald-500 rounded-full animate-pulse" />
            <h2 className="font-black uppercase tracking-widest text-xs">Live Cloud Feed</h2>
          </div>
          <span className="text-[10px] font-bold opacity-30 uppercase">Showing last 50 events</span>
        </div>
        <div className="divide-y divide-app-border/5">
          <AnimatePresence initial={false}>
            {activities.length > 0 ? (
              activities.map((activity) => (
                <motion.div 
                  key={activity.global_id || activity.local_id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="p-6 flex items-center justify-between hover:bg-app-bg/20 transition-colors group"
                >
                  <div className="flex items-center gap-6">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black text-xl ${
                      activity.type === 'sale' ? 'bg-emerald-500/10 text-emerald-600' : 
                      activity.type === 'refund' ? 'bg-red-500/10 text-red-600' : 'bg-blue-500/10 text-blue-600'
                    }`}>
                      {activity.type === 'sale' ? '$' : activity.type === 'refund' ? 'R' : 'P'}
                    </div>
                    <div>
                      <div className="flex items-center gap-3">
                        <p className="font-black uppercase tracking-tight">{activity.type}</p>
                        <span className="text-[10px] font-bold opacity-30">{new Date(activity.created_at).toLocaleTimeString()}</span>
                      </div>
                      <p className="text-xs font-bold opacity-50">
                        Processed by <span className="text-app-ink">{activity.user_name}</span> 
                        {activity.stakeholder_name && <> for <span className="text-app-ink">{activity.stakeholder_name}</span></>}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`text-xl font-black font-mono ${activity.type === 'refund' ? 'text-red-500' : 'text-app-ink'}`}>
                      {activity.type === 'refund' ? '-' : ''}${activity.total_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </p>
                    <p className="text-[10px] font-black uppercase opacity-30 tracking-widest">{activity.currency}</p>
                  </div>
                </motion.div>
              ))
            ) : (
              <div className="p-20 text-center opacity-20">
                <Zap size={48} className="mx-auto mb-4" strokeWidth={1} />
                <p className="font-black uppercase tracking-widest">Waiting for activity...</p>
              </div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
