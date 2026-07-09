import React, { useState, useEffect, useCallback } from 'react';

import { 
  LayoutDashboard, 
  Package, 
  Users, 
  FileText, 
  BarChart3, 
  Settings as SettingsIcon,
  Plus,
  Edit2,
  Trash2,
  Save,
  X,
  Search,
  ArrowLeft,
  ShoppingCart,
  Sun,
  Moon,
  Globe,
  Coins,
  ClipboardList,
  Activity,
  Zap,
  Wallet,
  CalendarCheck,
  RotateCcw,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Printer,
  Download,
  Upload,
  Shield,
  Monitor,
  RefreshCw,
  Clock,
  ArrowRight
} from 'lucide-react';

import { motion, AnimatePresence } from 'motion/react';

import { Product, Stakeholder, Currency, Tenant } from '../types';

import { Link, Routes, Route, useNavigate, useLocation } from 'react-router-dom';

import WindowFrame from '../components/WindowFrame';

import { useTheme } from '../hooks/useTheme';

import { translations, Language } from '../i18n';

import * as XLSX from 'xlsx';

import { jsPDF } from 'jspdf';

import 'jspdf-autotable';


export const CURRENCIES = [
  { code: 'USD', symbol: '$', rate: 1 },
  { code: 'EUR', symbol: '€', rate: 0.92 },
  { code: 'LBP', symbol: 'LL', rate: 89500 },
];

export default function UserLogs() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/logs')
      .then(res => res.json())
      .then(data => {
        setLogs(data);
        setLoading(false);
      });
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-4xl font-black tracking-tighter uppercase">User Activity Logs</h1>
        <p className="opacity-50 font-medium">Audit trail of all significant actions in the system.</p>
      </header>

      <div className="bg-app-surface border border-app-border rounded-2xl overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-app-bg/50 text-[10px] uppercase tracking-widest font-black opacity-50">
              <th className="p-4 border-b border-app-border">Timestamp</th>
              <th className="p-4 border-b border-app-border">User</th>
              <th className="p-4 border-b border-app-border">Action</th>
              <th className="p-4 border-b border-app-border">Details</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {loading ? (
              <tr>
                <td colSpan={4} className="p-12 text-center opacity-30 italic">Loading logs...</td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-12 text-center opacity-30 italic">No logs found.</td>
              </tr>
            ) : (
              logs.map(log => (
                <tr key={log.id} className="hover:bg-app-bg/30 transition-colors group">
                  <td className="p-4 border-b border-app-border font-mono text-[10px] opacity-50">
                    {new Date(log.created_at).toLocaleString()}
                  </td>
                  <td className="p-4 border-b border-app-border font-bold">
                    {log.user_name || 'System'}
                  </td>
                  <td className="p-4 border-b border-app-border">
                    <span className="px-2 py-1 bg-app-ink/5 text-app-ink text-[10px] font-black uppercase rounded">
                      {log.action}
                    </span>
                  </td>
                  <td className="p-4 border-b border-app-border opacity-70 text-xs">
                    {log.details}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}