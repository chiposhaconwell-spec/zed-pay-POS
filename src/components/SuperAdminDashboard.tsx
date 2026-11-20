import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ClipboardList,
  CreditCard,
  Flag,
  LogOut,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Store,
  Trash2,
  TrendingUp,
  Users,
  X,
  Ban,
  Package,
} from 'lucide-react';
import {
  fetchPlatformAuditLogs,
  fetchPlatformBusinesses,
  hardDeleteBusinessAccount,
  PlatformAuditLogEntry,
  PlatformBusinessRecord,
  PlatformKpiSummary,
  PlanTier,
  restoreBusinessAccount,
  setBusinessFraudFlag,
  SuperAdminSession,
  suspendBusinessAccount,
  updateBusinessPlanTier,
} from '../services/superAdminService';

interface SuperAdminDashboardProps {
  session: SuperAdminSession;
  onLogout: () => Promise<void> | void;
}

type AdminTab = 'directory' | 'audit';
type DirectoryFilter = 'ALL' | 'ACTIVE' | 'SUSPENDED' | 'FRAUD';

function formatMoney(amount: number, currency: string = 'K'): string {
  const num = Number(amount) || 0;
  return `${currency} ${num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 19);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const ACTION_LABELS: Record<PlatformAuditLogEntry['action'], string> = {
  SUSPEND_BUSINESS: 'Account Suspended',
  RESTORE_BUSINESS: 'Account Restored',
  FLAG_FRAUD: 'Flagged for Fraud',
  CLEAR_FRAUD: 'Fraud Flag Cleared',
  UPDATE_PLAN: 'Plan Tier Changed',
  HARD_DELETE_BUSINESS: 'Permanently Deleted',
};

export default function SuperAdminDashboard({
  session,
  onLogout,
}: SuperAdminDashboardProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>('directory');
  const [businesses, setBusinesses] = useState<PlatformBusinessRecord[]>([]);
  const [kpis, setKpis] = useState<PlatformKpiSummary>({
    totalBusinesses: 0,
    activePaidShops: 0,
    totalPlatformGmv: 0,
    activeCount: 0,
    suspendedCount: 0,
    flaggedFraudCount: 0,
    totalOrders: 0,
  });
  const [auditLogs, setAuditLogs] = useState<PlatformAuditLogEntry[]>([]);
  const [cloudSynced, setCloudSynced] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Directory filtering
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<DirectoryFilter>('ALL');

  // Audit log filtering
  const [auditSearch, setAuditSearch] = useState('');

  // Selected Business Detail Drawer
  const [selectedBizId, setSelectedBizId] = useState<string | null>(null);

  // Moderation Modals
  const [suspendTarget, setSuspendTarget] = useState<PlatformBusinessRecord | null>(null);
  const [suspendReason, setSuspendReason] = useState('');
  const [fraudTarget, setFraudTarget] = useState<{
    biz: PlatformBusinessRecord;
    nextFlagged: boolean;
  } | null>(null);
  const [fraudReason, setFraudReason] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<PlatformBusinessRecord | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [isMutating, setIsMutating] = useState(false);

  const selectedBiz = useMemo(
    () => businesses.find((b) => b.id === selectedBizId) || null,
    [businesses, selectedBizId]
  );

  const loadAllPlatformData = useCallback(async () => {
    setIsLoading(true);
    setErrorBanner(null);
    try {
      const [dirRes, logsRes] = await Promise.all([
        fetchPlatformBusinesses(session),
        fetchPlatformAuditLogs(session),
      ]);
      setBusinesses(dirRes.businesses);
      setKpis(dirRes.kpis);
      setCloudSynced(dirRes.cloudSynced);
      setAuditLogs(logsRes);
    } catch (err: any) {
      setErrorBanner(err?.message || 'Unable to load platform directory.');
    } finally {
      setIsLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void loadAllPlatformData();
  }, [loadAllPlatformData]);

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 4000);
    return () => clearTimeout(t);
  }, [toastMsg]);

  const filteredBusinesses = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return businesses.filter((b) => {
      if (statusFilter === 'ACTIVE' && b.status !== 'ACTIVE') return false;
      if (statusFilter === 'SUSPENDED' && b.status !== 'SUSPENDED') return false;
      if (statusFilter === 'FRAUD' && !b.flagged_for_fraud) return false;
      if (!q) return true;
      return (
        b.name.toLowerCase().includes(q) ||
        b.owner.toLowerCase().includes(q) ||
        b.email.toLowerCase().includes(q) ||
        b.id.toLowerCase().includes(q) ||
        b.tpin.toLowerCase().includes(q)
      );
    });
  }, [businesses, searchQuery, statusFilter]);

  const filteredAuditLogs = useMemo(() => {
    const q = auditSearch.trim().toLowerCase();
    if (!q) return auditLogs;
    return auditLogs.filter(
      (log) =>
        log.target_business_name.toLowerCase().includes(q) ||
        log.target_business_id.toLowerCase().includes(q) ||
        log.reason.toLowerCase().includes(q) ||
        log.action.toLowerCase().includes(q) ||
        log.performed_by_email.toLowerCase().includes(q)
    );
  }, [auditLogs, auditSearch]);

  const activePct =
    kpis.totalBusinesses > 0
      ? Math.round((kpis.activeCount / kpis.totalBusinesses) * 100)
      : 0;
  const suspendedPct =
    kpis.totalBusinesses > 0 ? 100 - activePct : 0;

  const handleConfirmSuspend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!suspendTarget || !suspendReason.trim()) return;
    setIsMutating(true);
    setErrorBanner(null);
    try {
      await suspendBusinessAccount(suspendTarget, suspendReason.trim(), session);
      setToastMsg(`Suspended "${suspendTarget.name}".`);
      setSuspendTarget(null);
      setSuspendReason('');
      await loadAllPlatformData();
    } catch (err: any) {
      setErrorBanner(err?.message || 'Failed to suspend business account.');
    } finally {
      setIsMutating(false);
    }
  };

  const handleRestoreBusiness = async (biz: PlatformBusinessRecord) => {
    setIsMutating(true);
    setErrorBanner(null);
    try {
      await restoreBusinessAccount(
        biz,
        'Account reviewed and restored by Platform Super Admin',
        session
      );
      setToastMsg(`Restored "${biz.name}" to Active status.`);
      await loadAllPlatformData();
    } catch (err: any) {
      setErrorBanner(err?.message || 'Failed to restore business account.');
    } finally {
      setIsMutating(false);
    }
  };

  const handleConfirmFraudToggle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fraudTarget) return;
    if (fraudTarget.nextFlagged && !fraudReason.trim()) return;
    setIsMutating(true);
    setErrorBanner(null);
    try {
      await setBusinessFraudFlag(
        fraudTarget.biz,
        fraudTarget.nextFlagged,
        fraudReason.trim() ||
          (fraudTarget.nextFlagged
            ? 'Flagged for fraud investigation'
            : 'Fraud flag cleared after platform review'),
        session
      );
      setToastMsg(
        fraudTarget.nextFlagged
          ? `Flagged "${fraudTarget.biz.name}" for fraud review.`
          : `Cleared fraud flag for "${fraudTarget.biz.name}".`
      );
      setFraudTarget(null);
      setFraudReason('');
      await loadAllPlatformData();
    } catch (err: any) {
      setErrorBanner(err?.message || 'Failed to update fraud flag.');
    } finally {
      setIsMutating(false);
    }
  };

  const handleChangePlanTier = async (biz: PlatformBusinessRecord, tier: PlanTier) => {
    if (biz.plan_tier === tier) return;
    setIsMutating(true);
    setErrorBanner(null);
    try {
      await updateBusinessPlanTier(biz, tier, session);
      setToastMsg(`Updated "${biz.name}" plan tier to ${tier}.`);
      await loadAllPlatformData();
    } catch (err: any) {
      setErrorBanner(err?.message || 'Failed to update business plan.');
    } finally {
      setIsMutating(false);
    }
  };

  const handleConfirmHardDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deleteTarget) return;
    if (deleteConfirmName.trim() !== deleteTarget.name.trim()) return;
    setIsMutating(true);
    setErrorBanner(null);
    try {
      const deletedName = deleteTarget.name;
      const deletedId = deleteTarget.id;
      await hardDeleteBusinessAccount(
        deleteTarget,
        deleteConfirmName.trim(),
        deleteReason.trim(),
        session
      );
      setDeleteTarget(null);
      setDeleteConfirmName('');
      setDeleteReason('');
      if (selectedBizId === deletedId) {
        setSelectedBizId(null);
      }
      setToastMsg(`Permanently deleted "${deletedName}" and logged audit event.`);
      await loadAllPlatformData();
    } catch (err: any) {
      setErrorBanner(err?.message || 'Failed to permanently delete business.');
    } finally {
      setIsMutating(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#F8FAFC] text-slate-900 flex flex-col lg:flex-row font-sans">
      {/* Left Governance Sidebar */}
      <aside className="w-full lg:w-64 shrink-0 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col justify-between">
        <div>
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
                <ShieldCheck size={18} />
              </div>
              <div className="min-w-0">
                <h1 className="text-sm font-semibold text-slate-900 tracking-tight truncate">
                  Super Admin
                </h1>
                <p className="text-[11px] text-slate-500 truncate">
                  Platform Governance
                </p>
              </div>
            </div>
            <button
              onClick={onLogout}
              className="lg:hidden inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut size={13} />
              <span>Sign Out</span>
            </button>
          </div>

          <nav className="p-3 flex lg:flex-col gap-1.5 overflow-x-auto">
            <button
              onClick={() => setActiveTab('directory')}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'directory'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <Building2 size={15} />
              <span>Overview & Directory</span>
              <span
                className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-mono tabular-nums ${
                  activeTab === 'directory'
                    ? 'bg-slate-700 text-slate-100'
                    : 'bg-slate-100 text-slate-600'
                }`}
              >
                {kpis.totalBusinesses}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('audit')}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'audit'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <ClipboardList size={15} />
              <span>Admin Audit Log</span>
              <span
                className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-mono tabular-nums ${
                  activeTab === 'audit'
                    ? 'bg-slate-700 text-slate-100'
                    : 'bg-slate-100 text-slate-600'
                }`}
              >
                {auditLogs.length}
              </span>
            </button>
          </nav>
        </div>

        {/* Isolated Platform Admin Identity Footer */}
        <div className="hidden lg:block p-4 border-t border-slate-200 bg-slate-50/70">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Platform Role
            </span>
            <span className="text-[10px] font-mono font-semibold text-indigo-700">
              SUPER_ADMIN
            </span>
          </div>
          <p className="text-xs font-medium text-slate-900 truncate" title={session.email}>
            {session.email}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {cloudSynced ? 'Cloud Firestore Live' : 'Local + Cache View'}
          </p>
          <button
            onClick={onLogout}
            className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg text-xs font-medium text-slate-700 transition-colors cursor-pointer"
          >
            <LogOut size={14} />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top 3-Zone Workspace Header */}
        <header className="h-14 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-4 sticky top-0 z-10">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-sm sm:text-base font-semibold text-slate-900 truncate">
              {activeTab === 'directory'
                ? 'Platform Overview & Business Directory'
                : 'Super Admin Moderation Audit Log'}
            </h2>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => void loadAllPlatformData()}
              disabled={isLoading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-700 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
            >
              <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
              <span>{isLoading ? 'Refreshing...' : 'Refresh'}</span>
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto space-y-6">
          {errorBanner && (
            <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-lg flex items-start justify-between gap-3 text-xs text-rose-800">
              <div className="flex items-start gap-2">
                <AlertTriangle size={15} className="shrink-0 mt-0.5 text-rose-600" />
                <span>{errorBanner}</span>
              </div>
              <button
                onClick={() => setErrorBanner(null)}
                className="text-rose-500 hover:text-rose-800 cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {toastMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center justify-between gap-3 text-xs text-emerald-800">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={15} className="text-emerald-600 shrink-0" />
                <span className="font-medium">{toastMsg}</span>
              </div>
              <button
                onClick={() => setToastMsg(null)}
                className="text-emerald-600 hover:text-emerald-900 cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {activeTab === 'directory' ? (
            <>
              {/* 1. Global Statistics Overview (Top KPI Bar + Status Breakdown) */}
              <section className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-white border border-slate-200 rounded-xl p-5">
                    <div className="flex items-center justify-between text-slate-500">
                      <span className="text-xs font-medium">Total Registered Businesses</span>
                      <Building2 size={16} className="text-slate-400" />
                    </div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className="text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                        {kpis.totalBusinesses}
                      </span>
                      <span className="text-xs text-slate-500">
                        tenants on platform
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-4 text-xs text-slate-600">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-500" />
                        <span className="font-mono tabular-nums font-medium">{kpis.activeCount}</span> Active
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-rose-500" />
                        <span className="font-mono tabular-nums font-medium">{kpis.suspendedCount}</span> Suspended
                      </span>
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-xl p-5">
                    <div className="flex items-center justify-between text-slate-500">
                      <span className="text-xs font-medium">Active Paid Shops</span>
                      <CreditCard size={16} className="text-slate-400" />
                    </div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className="text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                        {kpis.activePaidShops}
                      </span>
                      <span className="text-xs text-slate-500">
                        of {kpis.activeCount} active tenants
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-4 text-xs text-slate-600">
                      <span>
                        Flagged for Fraud:{' '}
                        <strong className="font-mono tabular-nums text-amber-700">
                          {kpis.flaggedFraudCount}
                        </strong>
                      </span>
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-xl p-5">
                    <div className="flex items-center justify-between text-slate-500">
                      <span className="text-xs font-medium">Total Platform GMV (Sales Volume)</span>
                      <TrendingUp size={16} className="text-slate-400" />
                    </div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className="text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                        {formatMoney(kpis.totalPlatformGmv, 'K')}
                      </span>
                    </div>
                    <div className="mt-3 text-xs text-slate-600">
                      Across{' '}
                      <span className="font-mono tabular-nums font-medium text-slate-900">
                        {kpis.totalOrders.toLocaleString()}
                      </span>{' '}
                      completed orders
                    </div>
                  </div>
                </div>

                {/* Clean Visual Breakdown by Status */}
                <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                    <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                      Business Status Breakdown
                    </h3>
                    <div className="flex items-center gap-4 text-xs">
                      <span className="inline-flex items-center gap-1.5 text-slate-700">
                        <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />
                        <span>Active</span>
                        <span className="font-mono tabular-nums font-semibold">
                          {kpis.activeCount} ({activePct}%)
                        </span>
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-slate-700">
                        <span className="w-2.5 h-2.5 rounded-sm bg-rose-500" />
                        <span>Suspended</span>
                        <span className="font-mono tabular-nums font-semibold">
                          {kpis.suspendedCount} ({suspendedPct}%)
                        </span>
                      </span>
                    </div>
                  </div>
                  <div className="w-full h-3 rounded-full bg-slate-100 overflow-hidden flex">
                    {kpis.totalBusinesses === 0 ? (
                      <div className="w-full h-full bg-slate-200" />
                    ) : (
                      <>
                        {kpis.activeCount > 0 && (
                          <div
                            className="h-full bg-emerald-500 transition-all duration-300"
                            style={{ width: `${activePct}%` }}
                            title={`Active: ${kpis.activeCount}`}
                          />
                        )}
                        {kpis.suspendedCount > 0 && (
                          <div
                            className="h-full bg-rose-500 transition-all duration-300"
                            style={{ width: `${suspendedPct}%` }}
                            title={`Suspended: ${kpis.suspendedCount}`}
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>
              </section>

              {/* 2. Business Directory & Fraud Moderation */}
              <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div className="relative flex-1 max-w-md">
                    <Search
                      size={15}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                    />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search business name, owner, email, ID, or TPIN..."
                      className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 placeholder:text-slate-400 focus:outline-hidden focus:border-slate-400 focus:bg-white"
                    />
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    {(
                      [
                        { id: 'ALL', label: `All (${kpis.totalBusinesses})` },
                        { id: 'ACTIVE', label: `Active (${kpis.activeCount})` },
                        { id: 'SUSPENDED', label: `Suspended (${kpis.suspendedCount})` },
                        { id: 'FRAUD', label: `Flagged for Fraud (${kpis.flaggedFraudCount})` },
                      ] as const
                    ).map((f) => (
                      <button
                        key={f.id}
                        onClick={() => setStatusFilter(f.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                          statusFilter === f.id
                            ? 'bg-slate-900 text-white'
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                        <th className="py-3 px-4">Business</th>
                        <th className="py-3 px-4">Owner Contact</th>
                        <th className="py-3 px-4">Plan</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4">Fraud Review</th>
                        <th className="py-3 px-4 text-right">GMV Volume</th>
                        <th className="py-3 px-4 text-right">Orders / Branches</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {filteredBusinesses.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="py-12 text-center text-slate-500">
                            {isLoading
                              ? 'Loading registered businesses...'
                              : 'No registered businesses match the selected filter.'}
                          </td>
                        </tr>
                      ) : (
                        filteredBusinesses.map((biz) => (
                          <tr
                            key={biz.id}
                            onClick={() => setSelectedBizId(biz.id)}
                            className={`transition-colors cursor-pointer ${
                              selectedBizId === biz.id
                                ? 'bg-slate-100/80'
                                : 'hover:bg-slate-50'
                            }`}
                          >
                            <td className="py-3.5 px-4">
                              <div className="font-semibold text-slate-900">{biz.name}</div>
                              <div className="text-[11px] text-slate-500 font-mono">
                                {biz.id}
                              </div>
                            </td>
                            <td className="py-3.5 px-4">
                              <div className="font-medium text-slate-800">{biz.owner}</div>
                              <div className="text-[11px] text-slate-500">{biz.email || '—'}</div>
                            </td>
                            <td className="py-3.5 px-4">
                              <span
                                className={`inline-block text-[11px] font-mono font-semibold ${
                                  biz.plan_tier === 'PAID'
                                    ? 'text-indigo-700'
                                    : biz.plan_tier === 'TRIAL'
                                      ? 'text-amber-700'
                                      : 'text-slate-600'
                                }`}
                              >
                                {biz.plan_tier}
                              </span>
                            </td>
                            <td className="py-3.5 px-4">
                              {biz.status === 'ACTIVE' ? (
                                <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
                                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                                  Active
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5 text-rose-700 font-medium">
                                  <span className="w-2 h-2 rounded-full bg-rose-500" />
                                  Suspended
                                </span>
                              )}
                            </td>
                            <td className="py-3.5 px-4">
                              {biz.flagged_for_fraud ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-800 font-medium text-[11px]">
                                  <Flag size={11} />
                                  Flagged
                                </span>
                              ) : (
                                <span className="text-slate-400 text-[11px]">Clear</span>
                              )}
                            </td>
                            <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-slate-900">
                              {formatMoney(biz.gmv, biz.currency || 'K')}
                            </td>
                            <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-600">
                              {biz.orderCount} / {biz.branchCount}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : (
            /* 3. Admin Audit Log Tab (Chronological, Read-Only) */
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Moderation Audit Trail
                  </h3>
                  <p className="text-xs text-slate-500">
                    Immutable chronological log of every platform moderation action.
                  </p>
                </div>
                <div className="relative w-full sm:w-80">
                  <Search
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    type="text"
                    value={auditSearch}
                    onChange={(e) => setAuditSearch(e.target.value)}
                    placeholder="Filter by business, action, or reason..."
                    className="w-full pl-8 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 placeholder:text-slate-400 focus:outline-hidden focus:border-slate-400 focus:bg-white"
                  />
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      <th className="py-3 px-4">Timestamp</th>
                      <th className="py-3 px-4">Action</th>
                      <th className="py-3 px-4">Target Business</th>
                      <th className="py-3 px-4">Reason</th>
                      <th className="py-3 px-4">Performed By</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {filteredAuditLogs.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-12 text-center text-slate-500">
                          No moderation audit events recorded yet.
                        </td>
                      </tr>
                    ) : (
                      filteredAuditLogs.map((log) => {
                        const isDestructive =
                          log.action === 'HARD_DELETE_BUSINESS' ||
                          log.action === 'SUSPEND_BUSINESS';
                        const isPositive =
                          log.action === 'RESTORE_BUSINESS' ||
                          log.action === 'CLEAR_FRAUD';
                        return (
                          <tr key={log.id} className="hover:bg-slate-50">
                            <td className="py-3 px-4 font-mono tabular-nums text-[11px] text-slate-600 whitespace-nowrap">
                              {formatDateTime(log.timestamp)}
                            </td>
                            <td className="py-3 px-4 whitespace-nowrap">
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border ${
                                  isDestructive
                                    ? 'bg-rose-50 text-rose-800 border-rose-200'
                                    : isPositive
                                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                      : log.action === 'FLAG_FRAUD'
                                        ? 'bg-amber-50 text-amber-800 border-amber-200'
                                        : 'bg-slate-100 text-slate-700 border-slate-200'
                                }`}
                              >
                                {ACTION_LABELS[log.action] || log.action}
                              </span>
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-semibold text-slate-900">
                                {log.target_business_name}
                              </div>
                              <div className="text-[11px] font-mono text-slate-500">
                                {log.target_business_id}
                              </div>
                            </td>
                            <td className="py-3 px-4 text-slate-700 max-w-md">
                              {log.reason}
                            </td>
                            <td className="py-3 px-4 text-[11px] font-mono text-slate-500 whitespace-nowrap">
                              {log.performed_by_email}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </main>
      </div>

      {/* Business Detail Drawer */}
      {selectedBiz && (
        <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40">
          <div
            className="flex-1"
            onClick={() => setSelectedBizId(null)}
          />
          <aside className="w-full max-w-xl bg-white h-full shadow-2xl border-l border-slate-200 flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-base font-semibold text-slate-900 truncate">
                    {selectedBiz.name}
                  </h3>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border ${
                      selectedBiz.status === 'ACTIVE'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-rose-50 text-rose-700 border-rose-200'
                    }`}
                  >
                    {selectedBiz.status}
                  </span>
                  {selectedBiz.flagged_for_fraud && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-800 border border-amber-200">
                      <Flag size={11} /> Flagged for Fraud
                    </span>
                  )}
                </div>
                <p className="text-xs font-mono text-slate-500 mt-1">
                  ID: {selectedBiz.id} · Registered {formatDateTime(selectedBiz.created_at)}
                </p>
              </div>
              <button
                onClick={() => setSelectedBizId(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg cursor-pointer"
                aria-label="Close drawer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Alert banners for Suspended / Fraud state */}
              {selectedBiz.status === 'SUSPENDED' && (
                <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl space-y-1">
                  <div className="text-xs font-semibold text-rose-900 flex items-center gap-1.5">
                    <Ban size={14} /> Account Currently Suspended
                  </div>
                  <p className="text-xs text-rose-800">
                    Reason: {selectedBiz.suspended_reason || 'No reason recorded.'}
                  </p>
                  {selectedBiz.suspended_at && (
                    <p className="text-[11px] text-rose-600 font-mono">
                      Suspended {formatDateTime(selectedBiz.suspended_at)} by{' '}
                      {selectedBiz.suspended_by || 'Super Admin'}
                    </p>
                  )}
                </div>
              )}

              {selectedBiz.flagged_for_fraud && (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-1">
                  <div className="text-xs font-semibold text-amber-900 flex items-center gap-1.5">
                    <ShieldAlert size={14} /> Flagged for Fraud Investigation
                  </div>
                  <p className="text-xs text-amber-800">
                    Notes: {selectedBiz.fraud_flag_reason || 'Flagged by moderation team.'}
                  </p>
                  {selectedBiz.flagged_at && (
                    <p className="text-[11px] text-amber-700 font-mono">
                      Flagged {formatDateTime(selectedBiz.flagged_at)}
                    </p>
                  )}
                </div>
              )}

              {/* Owner Contact Info */}
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
                  Owner & Contact Information
                </h4>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="text-[11px] text-slate-500">Business Owner</div>
                    <div className="font-semibold text-slate-900 mt-0.5">
                      {selectedBiz.owner}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">Primary Email</div>
                    <div className="font-mono text-slate-800 mt-0.5 flex items-center gap-1 break-all">
                      <Mail size={12} className="text-slate-400 shrink-0" />
                      {selectedBiz.email || '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">Billing Phone</div>
                    <div className="font-mono text-slate-800 mt-0.5 flex items-center gap-1">
                      <Phone size={12} className="text-slate-400 shrink-0" />
                      {selectedBiz.billing_phone || '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">Tax ID / TPIN</div>
                    <div className="font-mono text-slate-800 mt-0.5">
                      {selectedBiz.tpin || 'Not provided'}
                    </div>
                  </div>
                  <div className="sm:col-span-2">
                    <div className="text-[11px] text-slate-500">Billing Location</div>
                    <div className="text-slate-800 mt-0.5 flex items-start gap-1">
                      <MapPin size={12} className="text-slate-400 shrink-0 mt-0.5" />
                      <span>
                        {[
                          selectedBiz.billing_address,
                          selectedBiz.billing_city,
                          selectedBiz.billing_country,
                        ]
                          .filter(Boolean)
                          .join(', ') || 'No billing address recorded'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Usage Stats */}
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
                  Usage & Sales Metrics
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div className="border border-slate-200 rounded-xl p-3">
                    <div className="text-[11px] text-slate-500">Total GMV</div>
                    <div className="text-sm font-semibold font-mono tabular-nums text-slate-900 mt-1">
                      {formatMoney(selectedBiz.gmv, selectedBiz.currency || 'K')}
                    </div>
                  </div>
                  <div className="border border-slate-200 rounded-xl p-3">
                    <div className="text-[11px] text-slate-500">Orders</div>
                    <div className="text-sm font-semibold font-mono tabular-nums text-slate-900 mt-1">
                      {selectedBiz.orderCount}
                    </div>
                  </div>
                  <div className="border border-slate-200 rounded-xl p-3">
                    <div className="text-[11px] text-slate-500 flex items-center gap-1">
                      <Store size={11} /> Branches
                    </div>
                    <div className="text-sm font-semibold font-mono tabular-nums text-slate-900 mt-1">
                      {selectedBiz.branchCount}
                    </div>
                  </div>
                  <div className="border border-slate-200 rounded-xl p-3">
                    <div className="text-[11px] text-slate-500 flex items-center gap-1">
                      <Package size={11} /> Products
                    </div>
                    <div className="text-sm font-semibold font-mono tabular-nums text-slate-900 mt-1">
                      {selectedBiz.productCount}
                    </div>
                  </div>
                  <div className="border border-slate-200 rounded-xl p-3">
                    <div className="text-[11px] text-slate-500 flex items-center gap-1">
                      <Users size={11} /> Staff
                    </div>
                    <div className="text-sm font-semibold font-mono tabular-nums text-slate-900 mt-1">
                      {selectedBiz.staffCount}
                    </div>
                  </div>
                  <div className="border border-slate-200 rounded-xl p-3">
                    <div className="text-[11px] text-slate-500">Customers</div>
                    <div className="text-sm font-semibold font-mono tabular-nums text-slate-900 mt-1">
                      {selectedBiz.customerCount}
                    </div>
                  </div>
                </div>
              </div>

              {/* Manual Subscription Management */}
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
                  Subscription Tier (Manual Management)
                </h4>
                <div className="flex items-center gap-2">
                  {(['PAID', 'TRIAL', 'FREE'] as PlanTier[]).map((tier) => (
                    <button
                      key={tier}
                      disabled={isMutating}
                      onClick={() => void handleChangePlanTier(selectedBiz, tier)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium border cursor-pointer transition-colors ${
                        selectedBiz.plan_tier === tier
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      {tier}
                    </button>
                  ))}
                </div>
              </div>

              {/* Fraud & Moderation Controls */}
              <div className="pt-4 border-t border-slate-200 space-y-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Fraud & Account Moderation Controls
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {selectedBiz.status === 'ACTIVE' ? (
                    <button
                      disabled={isMutating}
                      onClick={() => {
                        setSuspendTarget(selectedBiz);
                        setSuspendReason('');
                      }}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-60"
                    >
                      <Ban size={14} />
                      <span>Suspend Account</span>
                    </button>
                  ) : (
                    <button
                      disabled={isMutating}
                      onClick={() => void handleRestoreBusiness(selectedBiz)}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-60"
                    >
                      <RotateCcw size={14} />
                      <span>Restore Account</span>
                    </button>
                  )}

                  {selectedBiz.flagged_for_fraud ? (
                    <button
                      disabled={isMutating}
                      onClick={() => {
                        setFraudTarget({ biz: selectedBiz, nextFlagged: false });
                        setFraudReason('');
                      }}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-white hover:bg-slate-50 border border-slate-300 text-slate-800 rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-60"
                    >
                      <ShieldCheck size={14} />
                      <span>Clear Fraud Flag</span>
                    </button>
                  ) : (
                    <button
                      disabled={isMutating}
                      onClick={() => {
                        setFraudTarget({ biz: selectedBiz, nextFlagged: true });
                        setFraudReason('');
                      }}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-900 rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-60"
                    >
                      <Flag size={14} />
                      <span>Flag for Fraud</span>
                    </button>
                  )}
                </div>

                {/* Permanently Delete (Hard Delete) — Restricted strictly to Suspended or Fraud-Flagged businesses */}
                <div className="pt-3 border-t border-slate-200">
                  {selectedBiz.status === 'SUSPENDED' || selectedBiz.flagged_for_fraud ? (
                    <button
                      disabled={isMutating}
                      onClick={() => {
                        setDeleteTarget(selectedBiz);
                        setDeleteConfirmName('');
                        setDeleteReason('');
                      }}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-white hover:bg-rose-50 border border-rose-300 text-rose-700 rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-60"
                    >
                      <Trash2 size={14} />
                      <span>Permanently Delete (Hard Delete)</span>
                    </button>
                  ) : (
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-[11px] text-slate-500">
                      Permanent Hard Delete is only unlocked after an account is{' '}
                      <strong className="text-slate-700">Suspended</strong> or{' '}
                      <strong className="text-slate-700">Flagged for Fraud</strong>.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </aside>
        </div>
      )}

      {/* Suspend Account Reason Modal */}
      {suspendTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmSuspend}
            className="bg-white border border-slate-200 rounded-xl shadow-xl max-w-md w-full p-5 space-y-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Suspend Business Account
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Target: <strong className="text-slate-800">{suspendTarget.name}</strong>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSuspendTarget(null)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Suspension Reason *
              </label>
              <textarea
                required
                rows={3}
                value={suspendReason}
                onChange={(e) => setSuspendReason(e.target.value)}
                placeholder="Enter policy violation, billing hold, or fraud reason..."
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-hidden focus:border-slate-400 focus:bg-white"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setSuspendTarget(null)}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isMutating || !suspendReason.trim()}
                className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg cursor-pointer disabled:opacity-50"
              >
                {isMutating ? 'Suspending...' : 'Confirm Suspension'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Flag / Clear Fraud Modal */}
      {fraudTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmFraudToggle}
            className="bg-white border border-slate-200 rounded-xl shadow-xl max-w-md w-full p-5 space-y-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  {fraudTarget.nextFlagged
                    ? 'Flag Business for Fraud'
                    : 'Clear Fraud Flag'}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Target: <strong className="text-slate-800">{fraudTarget.biz.name}</strong>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFraudTarget(null)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {fraudTarget.nextFlagged
                  ? 'Fraud Investigation Notes *'
                  : 'Resolution Notes (Optional)'}
              </label>
              <textarea
                required={fraudTarget.nextFlagged}
                rows={3}
                value={fraudReason}
                onChange={(e) => setFraudReason(e.target.value)}
                placeholder={
                  fraudTarget.nextFlagged
                    ? 'Describe suspicious transactions, chargebacks, or identity anomalies...'
                    : 'Enter review outcome or clearance note...'
                }
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-hidden focus:border-slate-400 focus:bg-white"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setFraudTarget(null)}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  isMutating || (fraudTarget.nextFlagged && !fraudReason.trim())
                }
                className={`px-4 py-2 text-xs font-semibold text-white rounded-lg cursor-pointer disabled:opacity-50 ${
                  fraudTarget.nextFlagged
                    ? 'bg-amber-600 hover:bg-amber-700'
                    : 'bg-emerald-600 hover:bg-emerald-700'
                }`}
              >
                {isMutating
                  ? 'Saving...'
                  : fraudTarget.nextFlagged
                    ? 'Flag for Fraud'
                    : 'Clear Fraud Flag'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* High-Friction Hard Delete Modal (Requires typing exact business name) */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmHardDelete}
            className="bg-white border border-rose-200 rounded-xl shadow-2xl max-w-md w-full p-5 space-y-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-rose-100 text-rose-700 flex items-center justify-center shrink-0">
                  <AlertTriangle size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-rose-900">
                    Permanently Delete Business
                  </h3>
                  <p className="text-xs text-slate-600 mt-0.5">
                    This will irreversibly erase the business, branches, inventory, orders, customers, and ledgers.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Deletion Reason (Optional)
              </label>
              <input
                type="text"
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                placeholder="e.g. Confirmed fraudulent merchant account"
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-hidden focus:border-slate-400 focus:bg-white"
              />
            </div>

            <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg space-y-2">
              <label className="block text-xs text-rose-900">
                Type exact business name{' '}
                <strong className="font-mono select-all">{deleteTarget.name}</strong>{' '}
                to confirm permanent deletion:
              </label>
              <input
                type="text"
                required
                value={deleteConfirmName}
                onChange={(e) => setDeleteConfirmName(e.target.value)}
                placeholder={deleteTarget.name}
                autoComplete="off"
                className="w-full px-3 py-2 bg-white border border-rose-300 rounded-lg text-xs font-mono text-slate-900 focus:outline-hidden focus:border-rose-500"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  isMutating ||
                  deleteConfirmName.trim() !== deleteTarget.name.trim()
                }
                className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg cursor-pointer disabled:opacity-40"
              >
                {isMutating ? 'Deleting...' : 'Permanently Delete Business'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
