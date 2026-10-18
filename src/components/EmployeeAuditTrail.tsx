import React, { useState, useEffect, useRef } from 'react';
import { 
  ShieldCheck, Search, Filter, Calendar, User, FileText, 
  ShoppingCart, CreditCard, ShoppingBag, Package, DollarSign, 
  Building, Download, RefreshCw, Layers, CheckCircle2, AlertCircle, Clock,
  ChevronLeft, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown, ArrowRight,
  Maximize2, Minimize2, Copy, Check, SlidersHorizontal, ArrowLeftRight, Landmark
} from 'lucide-react';
import { runSql, persistTablesToStorage } from '../db';
import { exportAndShareCsv } from '../androidUtils';
import { StoreSettings } from '../types';

interface EmployeeAuditTrailProps {
  settings: StoreSettings;
  activeStore: string;
  userRole: string;
}

export interface AuditLogItem {
  id: string;
  module: 'SALES' | 'LAYBY' | 'PURCHASE' | 'EXPENSES' | 'STOCK' | 'FINANCE' | 'TRANSFER' | 'LOAN' | 'PROCUREMENT' | 'EXPENSE' | string;
  action: string;
  details: string;
  amount: number;
  store_id: string;
  performed_by: string;
  created_at: string;
}

export default function EmployeeAuditTrail({ settings, activeStore, userRole }: EmployeeAuditTrailProps) {
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [selectedModule, setSelectedModule] = useState<string>('ALL');
  const [selectedStore, setSelectedStore] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedStaff, setSelectedStaff] = useState<string>('ALL');
  const [staffList, setStaffList] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Pagination & view preferences
  const [pageSize, setPageSize] = useState<number>(50);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [isCompact, setIsCompact] = useState<boolean>(false);
  const [dateFilter, setDateFilter] = useState<'ALL' | 'TODAY' | 'WEEK' | 'MONTH'>('ALL');

  // Scroll references & indicators
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState<boolean>(false);
  const [canScrollRight, setCanScrollRight] = useState<boolean>(true);
  const [scrollProgress, setScrollProgress] = useState<number>(0);

  // Fetch audit logs from DB (combining audit_logs table and transactions table as fallbacks)
  const fetchAuditLogs = () => {
    setIsLoading(true);
    try {
      // 1. Fetch from audit_logs table
      const auditRes = runSql('SELECT * FROM audit_logs ORDER BY created_at DESC', 'Audit Trail: Query audit_logs table');
      let combined: AuditLogItem[] = [];

      if (auditRes.success && Array.isArray(auditRes.data)) {
        combined = [...auditRes.data];
      }

      // 2. Fetch fallback records from transactions table if audit_logs has fewer entries
      const txRes = runSql(
        "SELECT * FROM transactions WHERE pos_terminal_id = 'AUDIT_TRAIL' OR channel IN ('SALES', 'LAYBY', 'PURCHASE', 'EXPENSES', 'STOCK', 'MANUAL_EDIT', 'RECEIVE', 'FINANCE', 'TRANSFER', 'LOAN') ORDER BY created_at DESC", 
        'Audit Trail: Query transactions fallback'
      );
      
      if (txRes.success && Array.isArray(txRes.data)) {
        const existingIds = new Set(combined.map(c => c.id));
        txRes.data.forEach((tx: any) => {
          const mappedId = tx.provider_reference || tx.id;
          if (!existingIds.has(mappedId)) {
            let mod = tx.channel || 'SALES';
            if (mod === 'MANUAL_EDIT' || mod === 'RECEIVE' || mod === 'INVENTORY') mod = 'STOCK';
            if (mod === 'PURCHASE_TRANSIT' || mod === 'PROCUREMENT') mod = 'PURCHASE';
            if (mod === 'EXPENSE') mod = 'EXPENSES';
            if (mod === 'INTER_ACCOUNT') mod = 'TRANSFER';
            
            combined.push({
              id: tx.id,
              module: mod,
              action: tx.status === 'SUCCESS' ? `Recorded ${mod} Transaction` : 'Audit Event',
              details: tx.narration || 'System action executed',
              amount: Number(tx.amount || 0),
              store_id: tx.pos_terminal_id?.toLowerCase() || 'lusaka',
              performed_by: tx.performed_by || 'Staff Operator',
              created_at: tx.created_at || new Date().toISOString()
            });
          }
        });
      }

      // Sort combined descending by timestamp
      combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setLogs(combined);

      // Extract unique staff names
      const staffSet = new Set<string>();
      combined.forEach(item => {
        if (item.performed_by && item.performed_by.trim()) {
          staffSet.add(item.performed_by.trim());
        }
      });
      setStaffList(Array.from(staffSet));
    } catch (err) {
      console.warn('Failed fetching audit logs', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditLogs();

    const handleUpdate = () => {
      fetchAuditLogs();
    };

    window.addEventListener('pos_sale_completed', handleUpdate);
    window.addEventListener('pos_data_updated', handleUpdate);
    window.addEventListener('storage', handleUpdate);

    return () => {
      window.removeEventListener('pos_sale_completed', handleUpdate);
      window.removeEventListener('pos_data_updated', handleUpdate);
      window.removeEventListener('storage', handleUpdate);
    };
  }, []);

  // Update scroll indicators
  const checkScroll = () => {
    if (!tableContainerRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = tableContainerRef.current;
    setCanScrollLeft(scrollLeft > 10);
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 10);
    const maxScroll = scrollWidth - clientWidth;
    if (maxScroll > 0) {
      setScrollProgress(Math.round((scrollLeft / maxScroll) * 100));
    }
  };

  useEffect(() => {
    checkScroll();
    window.addEventListener('resize', checkScroll);
    return () => window.removeEventListener('resize', checkScroll);
  }, [logs, selectedModule, searchQuery]);

  const scrollTable = (direction: 'left' | 'right' | 'top' | 'bottom') => {
    if (!tableContainerRef.current) return;
    if (direction === 'left') {
      tableContainerRef.current.scrollBy({ left: -320, behavior: 'smooth' });
    } else if (direction === 'right') {
      tableContainerRef.current.scrollBy({ left: 320, behavior: 'smooth' });
    } else if (direction === 'top') {
      tableContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (direction === 'bottom') {
      tableContainerRef.current.scrollTo({ top: tableContainerRef.current.scrollHeight, behavior: 'smooth' });
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(text);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Filter logic
  const now = new Date();
  const filteredLogs = logs.filter(log => {
    // Module filter
    if (selectedModule !== 'ALL') {
      const target = selectedModule.toUpperCase();
      const itemMod = (log.module || '').toUpperCase();
      if (target === 'PURCHASE' && itemMod !== 'PURCHASE' && itemMod !== 'PROCUREMENT') return false;
      if (target === 'EXPENSES' && itemMod !== 'EXPENSES' && itemMod !== 'EXPENSE') return false;
      if (target === 'FINANCE' && itemMod !== 'FINANCE' && itemMod !== 'TRANSFER') return false;
      if (target !== 'PURCHASE' && target !== 'EXPENSES' && target !== 'FINANCE' && itemMod !== target) {
        return false;
      }
    }
    // Store filter
    if (selectedStore !== 'ALL' && (log.store_id || '').toLowerCase() !== selectedStore.toLowerCase()) {
      return false;
    }
    // Staff filter
    if (selectedStaff !== 'ALL' && (log.performed_by || '').toLowerCase() !== selectedStaff.toLowerCase()) {
      return false;
    }
    // Date filter
    if (dateFilter !== 'ALL') {
      const logDate = new Date(log.created_at);
      if (dateFilter === 'TODAY') {
        if (logDate.toDateString() !== now.toDateString()) return false;
      } else if (dateFilter === 'WEEK') {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        if (logDate < weekAgo) return false;
      } else if (dateFilter === 'MONTH') {
        const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        if (logDate < monthAgo) return false;
      }
    }
    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchAction = (log.action || '').toLowerCase().includes(q);
      const matchDetails = (log.details || '').toLowerCase().includes(q);
      const matchStaff = (log.performed_by || '').toLowerCase().includes(q);
      const matchId = (log.id || '').toLowerCase().includes(q);
      const matchModule = (log.module || '').toLowerCase().includes(q);
      const matchStore = (log.store_id || '').toLowerCase().includes(q);
      if (!matchAction && !matchDetails && !matchStaff && !matchId && !matchModule && !matchStore) {
        return false;
      }
    }
    return true;
  });

  // Pagination calculation
  const totalItems = filteredLogs.length;
  const totalPages = pageSize === -1 ? 1 : Math.ceil(totalItems / pageSize) || 1;
  const paginatedLogs = pageSize === -1 
    ? filteredLogs 
    : filteredLogs.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // Calculate counts per module
  const totalCount = logs.length;
  const salesCount = logs.filter(l => (l.module || '').toUpperCase() === 'SALES').length;
  const laybyCount = logs.filter(l => (l.module || '').toUpperCase() === 'LAYBY').length;
  const purchaseCount = logs.filter(l => ['PURCHASE', 'PROCUREMENT'].includes((l.module || '').toUpperCase())).length;
  const expensesCount = logs.filter(l => ['EXPENSES', 'EXPENSE'].includes((l.module || '').toUpperCase())).length;
  const stockCount = logs.filter(l => (l.module || '').toUpperCase() === 'STOCK').length;
  const financeCount = logs.filter(l => ['FINANCE', 'TRANSFER'].includes((l.module || '').toUpperCase())).length;
  const loanCount = logs.filter(l => (l.module || '').toUpperCase() === 'LOAN').length;

  const totalValueImpact = filteredLogs.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);

  // Helper badge style
  const getModuleBadge = (module: string) => {
    const mod = (module || '').toUpperCase();
    switch (mod) {
      case 'SALES':
        return {
          bg: 'bg-emerald-50 text-emerald-700 border-emerald-200',
          icon: <ShoppingCart size={13} className="text-emerald-600 shrink-0" />,
          label: 'Sales & Orders'
        };
      case 'LAYBY':
        return {
          bg: 'bg-purple-50 text-purple-700 border-purple-200',
          icon: <CreditCard size={13} className="text-purple-600 shrink-0" />,
          label: 'Layby & Instalments'
        };
      case 'PURCHASE':
      case 'PROCUREMENT':
        return {
          bg: 'bg-blue-50 text-blue-700 border-blue-200',
          icon: <ShoppingBag size={13} className="text-blue-600 shrink-0" />,
          label: 'Procurement & POs'
        };
      case 'EXPENSES':
      case 'EXPENSE':
        return {
          bg: 'bg-amber-50 text-amber-700 border-amber-200',
          icon: <FileText size={13} className="text-amber-600 shrink-0" />,
          label: 'Operating Expenses'
        };
      case 'STOCK':
        return {
          bg: 'bg-indigo-50 text-indigo-700 border-indigo-200',
          icon: <Package size={13} className="text-indigo-600 shrink-0" />,
          label: 'Stock & Inventory'
        };
      case 'FINANCE':
      case 'TRANSFER':
        return {
          bg: 'bg-teal-50 text-teal-700 border-teal-200',
          icon: <Landmark size={13} className="text-teal-600 shrink-0" />,
          label: 'Finance & Transfers'
        };
      case 'LOAN':
        return {
          bg: 'bg-rose-50 text-rose-700 border-rose-200',
          icon: <DollarSign size={13} className="text-rose-600 shrink-0" />,
          label: 'Loan & Financing'
        };
      default:
        return {
          bg: 'bg-slate-100 text-slate-700 border-slate-200',
          icon: <Layers size={13} className="text-slate-600 shrink-0" />,
          label: module
        };
    }
  };

  // CSV Export
  const exportCsv = () => {
    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "ID,Module,Action,Details,Amount,Store,Performed By,Date Time\n";

    filteredLogs.forEach(row => {
      const line = [
        `"${row.id}"`,
        `"${row.module}"`,
        `"${(row.action || '').replace(/"/g, '""')}"`,
        `"${(row.details || '').replace(/"/g, '""')}"`,
        `"${row.amount}"`,
        `"${row.store_id}"`,
        `"${(row.performed_by || '').replace(/"/g, '""')}"`,
        `"${new Date(row.created_at).toLocaleString()}"`
      ].join(",");
      csvContent += line + "\n";
    });

    const filename = `employee_audit_trail_${new Date().toISOString().split('T')[0]}.csv`;
    exportAndShareCsv(filename, csvContent);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-50 text-slate-900 overflow-hidden select-text">
      {/* Top Header Banner */}
      <div className="bg-white border-b border-slate-200 px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0 shadow-3xs z-10">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="p-2 bg-indigo-50 border border-indigo-150 rounded-xl text-indigo-600">
              <ShieldCheck size={20} />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-black text-slate-900 tracking-tight">
                  Employee Audit Trail & Ledger
                </h1>
                <span className="text-[10px] bg-indigo-100 text-indigo-800 font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider font-mono">
                  Live Sync
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-medium">
                Comprehensive 2D scrollable compliance trail tracking staff operations across all system functions
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
          {/* Quick Navigation Scroll controls */}
          <div className="hidden md:flex items-center bg-slate-100 border border-slate-250 rounded-xl p-0.5 text-xs">
            <button
              onClick={() => scrollTable('left')}
              disabled={!canScrollLeft}
              className={`p-1.5 rounded-lg transition-all ${canScrollLeft ? 'text-slate-700 hover:bg-white cursor-pointer shadow-3xs' : 'text-slate-300 cursor-not-allowed'}`}
              title="Pan table horizontally to left"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="px-2 text-[10px] font-mono font-bold text-slate-500">
              Pan View
            </span>
            <button
              onClick={() => scrollTable('right')}
              disabled={!canScrollRight}
              className={`p-1.5 rounded-lg transition-all ${canScrollRight ? 'text-slate-700 hover:bg-white cursor-pointer shadow-3xs' : 'text-slate-300 cursor-not-allowed'}`}
              title="Pan table horizontally to right"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <button
            onClick={() => setIsCompact(!isCompact)}
            className={`px-3 py-1.5 font-bold text-xs rounded-xl border flex items-center gap-1.5 transition-all cursor-pointer ${
              isCompact ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'bg-slate-100 border-slate-250 text-slate-700 hover:bg-slate-200'
            }`}
            title="Toggle compact row view"
          >
            <SlidersHorizontal size={13} />
            <span className="hidden sm:inline">{isCompact ? 'Compact View' : 'Comfortable View'}</span>
          </button>

          <button
            onClick={fetchAuditLogs}
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-250 font-bold text-xs rounded-xl flex items-center gap-1.5 transition-all cursor-pointer"
            title="Refresh logs from SQLite database"
          >
            <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">Refresh</span>
          </button>

          <button
            onClick={exportCsv}
            className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl shadow-xs flex items-center gap-1.5 transition-all cursor-pointer"
          >
            <Download size={13} />
            Export CSV
          </button>
        </div>
      </div>

      {/* Main Container - Scrollable Vertically */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
        {/* Module Category Selector Tabs (All Functional Modules) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          {[
            { id: 'ALL', label: 'All Functions', count: totalCount, icon: <Layers size={14} /> },
            { id: 'SALES', label: 'Sales & Invoices', count: salesCount, icon: <ShoppingCart size={14} /> },
            { id: 'LAYBY', label: 'Laybys & Deposits', count: laybyCount, icon: <CreditCard size={14} /> },
            { id: 'PURCHASE', label: 'Procurement', count: purchaseCount, icon: <ShoppingBag size={14} /> },
            { id: 'EXPENSES', label: 'Operating Expenses', count: expensesCount, icon: <FileText size={14} /> },
            { id: 'STOCK', label: 'Stock & Catalog', count: stockCount, icon: <Package size={14} /> },
            { id: 'FINANCE', label: 'Cash & Transfers', count: financeCount, icon: <Landmark size={14} /> },
            { id: 'LOAN', label: 'Loans & Sweeps', count: loanCount, icon: <DollarSign size={14} /> },
          ].map((mod) => {
            const isActive = selectedModule === mod.id;
            return (
              <button
                key={mod.id}
                onClick={() => {
                  setSelectedModule(mod.id);
                  setCurrentPage(1);
                }}
                className={`p-2.5 rounded-xl border text-left flex flex-col justify-between transition-all cursor-pointer ${
                  isActive 
                    ? 'bg-slate-900 text-white border-slate-900 shadow-sm ring-2 ring-indigo-500/20' 
                    : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between w-full mb-1">
                  <span className={`p-1 rounded-lg ${isActive ? 'bg-slate-800 text-indigo-400' : 'bg-slate-100 text-slate-600'}`}>
                    {mod.icon}
                  </span>
                  <span className={`text-[10px] font-mono font-extrabold px-1.5 py-0.5 rounded-md ${
                    isActive ? 'bg-slate-800 text-slate-200' : 'bg-slate-100 text-slate-700'
                  }`}>
                    {mod.count}
                  </span>
                </div>
                <div>
                  <p className="text-[11px] font-black tracking-tight truncate">{mod.label}</p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Filters and Search Bar Row */}
        <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-3xs flex flex-col lg:flex-row items-center justify-between gap-3">
          <div className="relative flex-1 w-full">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              placeholder="Search by staff member, action summary, transaction ID, tender details..."
              className="w-full pl-9 pr-8 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-800 focus:bg-white focus:border-indigo-500 focus:outline-hidden transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                ✕
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto shrink-0">
            {/* Date filter */}
            <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1">
              <Calendar size={13} className="text-slate-400 shrink-0" />
              <select
                value={dateFilter}
                onChange={(e) => {
                  setDateFilter(e.target.value as any);
                  setCurrentPage(1);
                }}
                className="bg-transparent text-xs font-bold text-slate-800 focus:outline-hidden cursor-pointer"
              >
                <option value="ALL">All Time</option>
                <option value="TODAY">Today Only</option>
                <option value="WEEK">Past 7 Days</option>
                <option value="MONTH">Past 30 Days</option>
              </select>
            </div>

            {/* Store Filter */}
            <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1">
              <Building size={13} className="text-slate-400 shrink-0" />
              <select
                value={selectedStore}
                onChange={(e) => {
                  setSelectedStore(e.target.value);
                  setCurrentPage(1);
                }}
                className="bg-transparent text-xs font-bold text-slate-800 focus:outline-hidden cursor-pointer"
              >
                <option value="ALL">All Branches</option>
                <option value="lusaka">Lusaka Main</option>
                <option value="kitwe">Kitwe Yard</option>
                <option value="ndola">Ndola Station</option>
              </select>
            </div>

            {/* Staff Filter */}
            <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1">
              <User size={13} className="text-slate-400 shrink-0" />
              <select
                value={selectedStaff}
                onChange={(e) => {
                  setSelectedStaff(e.target.value);
                  setCurrentPage(1);
                }}
                className="bg-transparent text-xs font-bold text-slate-800 focus:outline-hidden cursor-pointer"
              >
                <option value="ALL">All Staff</option>
                {staffList.map(st => (
                  <option key={st} value={st}>{st}</option>
                ))}
              </select>
            </div>

            {(selectedModule !== 'ALL' || selectedStore !== 'ALL' || selectedStaff !== 'ALL' || searchQuery !== '' || dateFilter !== 'ALL') && (
              <button
                onClick={() => {
                  setSelectedModule('ALL');
                  setSelectedStore('ALL');
                  setSelectedStaff('ALL');
                  setDateFilter('ALL');
                  setSearchQuery('');
                  setCurrentPage(1);
                }}
                className="text-xs font-extrabold text-indigo-600 hover:text-indigo-800 underline px-1.5 cursor-pointer"
              >
                Reset
              </button>
            )}
          </div>
        </div>

        {/* Audit Metric & Pan Navigation Toolbar */}
        <div className="bg-slate-900 text-white rounded-xl px-4 py-2.5 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="p-1.5 bg-slate-800 rounded-lg text-indigo-400 border border-slate-700">
              <ArrowLeftRight size={16} />
            </span>
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                Scope: {filteredLogs.length} Records Found {selectedModule !== 'ALL' && `(${selectedModule})`}
              </p>
              <p className="text-xs text-slate-200 font-bold">
                Total Financial Value Impact: <span className="font-mono text-emerald-400 font-black">{settings.currency}{totalValueImpact.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end">
            {/* Scroll Navigation Pills */}
            <div className="flex items-center gap-1.5 bg-slate-800 px-2.5 py-1 rounded-lg border border-slate-700 text-xs">
              <span className="text-[10px] uppercase font-mono font-bold text-slate-400 mr-1">Horizontal Pan:</span>
              <button
                onClick={() => scrollTable('left')}
                className="px-2 py-0.5 bg-slate-700 hover:bg-slate-600 rounded text-[11px] font-bold text-white cursor-pointer transition-colors"
              >
                ← Left
              </button>
              <button
                onClick={() => scrollTable('right')}
                className="px-2 py-0.5 bg-slate-700 hover:bg-slate-600 rounded text-[11px] font-bold text-white cursor-pointer transition-colors"
              >
                Right →
              </button>
              <div className="w-12 bg-slate-700 rounded-full h-1.5 ml-1 overflow-hidden">
                <div 
                  className="bg-indigo-400 h-full transition-all duration-150"
                  style={{ width: `${scrollProgress}%` }}
                />
              </div>
            </div>

            {/* Vertical Jump controls */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => scrollTable('top')}
                className="p-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-slate-300 hover:text-white cursor-pointer transition-colors"
                title="Scroll to table top"
              >
                <ArrowUp size={13} />
              </button>
              <button
                onClick={() => scrollTable('bottom')}
                className="p-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-slate-300 hover:text-white cursor-pointer transition-colors"
                title="Scroll to table bottom"
              >
                <ArrowDown size={13} />
              </button>
            </div>
          </div>
        </div>

        {/* Audit Log Table - Fully 2D Scrollable (Vertical & Horizontal) */}
        <div className="bg-white border border-slate-200 rounded-2xl shadow-3xs overflow-hidden flex flex-col">
          {/* Scrollable Container with max height and bidirectional overflow */}
          <div 
            ref={tableContainerRef}
            onScroll={checkScroll}
            className="overflow-x-auto overflow-y-auto max-h-[620px] relative scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-slate-100"
          >
            <table className="w-full text-left border-collapse min-w-[1300px]">
              {/* Sticky Table Header for vertical scroll persistence */}
              <thead className="sticky top-0 bg-slate-100/95 backdrop-blur-xs border-b border-slate-250 z-20 shadow-3xs">
                <tr className="text-[10px] font-black uppercase text-slate-600 tracking-wider">
                  <th className="py-3 px-4 w-36 bg-slate-100/95">Timestamp</th>
                  <th className="py-3 px-4 w-44 bg-slate-100/95">Function Module</th>
                  <th className="py-3 px-4 w-48 bg-slate-100/95">Employee / Operator</th>
                  <th className="py-3 px-4 w-60 bg-slate-100/95">Action Summary</th>
                  <th className="py-3 px-4 min-w-[340px] bg-slate-100/95">Transaction & Operation Details</th>
                  <th className="py-3 px-4 w-32 text-right bg-slate-100/95">Value Impact</th>
                  <th className="py-3 px-4 w-28 text-center bg-slate-100/95">Branch Store</th>
                  <th className="py-3 px-4 w-36 text-center bg-slate-100/95">Reference ID</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 text-xs font-medium text-slate-700">
                {paginatedLogs.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-16 text-center text-slate-400">
                      <div className="flex flex-col items-center justify-center gap-2.5">
                        <AlertCircle size={32} className="text-slate-300" />
                        <p className="font-extrabold text-slate-700 text-sm">No employee audit records match this filter</p>
                        <p className="text-xs text-slate-400">Try adjusting your search query, date filter, or module selection.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  paginatedLogs.map((log, idx) => {
                    const badge = getModuleBadge(log.module);
                    const logDate = new Date(log.created_at);
                    const formattedDate = logDate.toLocaleDateString('en-GB', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric'
                    });
                    const formattedTime = logDate.toLocaleTimeString('en-GB', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit'
                    });

                    const pyClass = isCompact ? 'py-2 px-4' : 'py-3 px-4';

                    return (
                      <tr 
                        key={log.id || `log_${idx}`} 
                        className={`hover:bg-slate-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}
                      >
                        {/* Timestamp */}
                        <td className={`${pyClass} font-mono text-[11px] text-slate-600 whitespace-nowrap`}>
                          <div className="font-bold text-slate-800">{formattedDate}</div>
                          <div className="text-[10px] text-slate-400">{formattedTime}</div>
                        </td>

                        {/* Module Badge */}
                        <td className={`${pyClass} whitespace-nowrap`}>
                          <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] font-extrabold uppercase ${badge.bg}`}>
                            {badge.icon}
                            <span>{badge.label}</span>
                          </span>
                        </td>

                        {/* Performed By / Employee */}
                        <td className={`${pyClass} font-bold text-slate-900 whitespace-nowrap`}>
                          <div className="flex items-center gap-2">
                            <span className="w-6 h-6 rounded-full bg-slate-200 border border-slate-300 flex items-center justify-center text-[10px] font-black text-slate-700 shrink-0">
                              {(log.performed_by || 'S')[0].toUpperCase()}
                            </span>
                            <div className="truncate max-w-[140px]">
                              <div className="text-xs font-black text-slate-800 truncate">{log.performed_by || 'Staff Operator'}</div>
                              <div className="text-[9px] font-mono text-slate-400 uppercase">Operator ID</div>
                            </div>
                          </div>
                        </td>

                        {/* Action Title */}
                        <td className={`${pyClass} font-extrabold text-slate-800`}>
                          <div className="flex items-center gap-1.5">
                            <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                            <span className="truncate">{log.action}</span>
                          </div>
                        </td>

                        {/* Details Description */}
                        <td className={`${pyClass} text-slate-700 text-xs font-mono break-words`}>
                          <div className="bg-slate-100/70 border border-slate-200/80 rounded-lg p-2 text-[11px] leading-relaxed max-w-xl text-slate-800">
                            {log.details}
                          </div>
                        </td>

                        {/* Amount / Value Impact */}
                        <td className={`${pyClass} text-right font-extrabold font-mono whitespace-nowrap`}>
                          {Number(log.amount) > 0 ? (
                            <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-md">
                              {settings.currency}{Number(log.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          ) : (
                            <span className="text-slate-400 font-normal">-</span>
                          )}
                        </td>

                        {/* Branch Store */}
                        <td className={`${pyClass} text-center whitespace-nowrap`}>
                          <span className="px-2 py-0.5 bg-slate-100 text-slate-700 font-mono text-[10px] font-extrabold uppercase rounded-md border border-slate-250">
                            {(log.store_id || 'lusaka').toUpperCase()}
                          </span>
                        </td>

                        {/* Reference / Audit ID with Copy */}
                        <td className={`${pyClass} text-center whitespace-nowrap`}>
                          <button
                            onClick={() => copyToClipboard(log.id)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-mono font-bold rounded border border-slate-200 transition-colors cursor-pointer"
                            title="Click to copy full Audit ID"
                          >
                            <span>{log.id ? `${log.id.slice(0, 10)}...` : 'ID'}</span>
                            {copiedId === log.id ? (
                              <Check size={11} className="text-emerald-600" />
                            ) : (
                              <Copy size={11} className="text-slate-400" />
                            )}
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Table Footer & Pagination Navigation */}
          <div className="bg-slate-50 border-t border-slate-200 px-4 py-2.5 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600 shrink-0">
            <div className="flex items-center gap-3">
              <span className="font-medium">
                Showing {paginatedLogs.length > 0 ? (currentPage - 1) * (pageSize === -1 ? totalItems : pageSize) + 1 : 0} to{' '}
                {pageSize === -1 ? totalItems : Math.min(currentPage * pageSize, totalItems)} of {totalItems} entries
              </span>

              {/* Rows per page selector */}
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-slate-400">Rows:</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                  className="bg-white border border-slate-250 rounded px-2 py-0.5 text-xs font-bold text-slate-700 cursor-pointer"
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={250}>250</option>
                  <option value={-1}>All ({totalItems})</option>
                </select>
              </div>
            </div>

            {/* Pagination Controls */}
            {pageSize !== -1 && totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setCurrentPage(1)}
                  disabled={currentPage === 1}
                  className="px-2 py-1 bg-white border border-slate-250 rounded hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed font-bold text-xs cursor-pointer"
                >
                  First
                </button>
                <button
                  onClick={() => setCurrentPage(p => Math.max(p - 1, 1))}
                  disabled={currentPage === 1}
                  className="p-1 bg-white border border-slate-250 rounded hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  <ChevronLeft size={14} />
                </button>

                <span className="px-2.5 py-0.5 bg-indigo-50 border border-indigo-200 text-indigo-700 font-mono font-bold rounded text-xs">
                  {currentPage} / {totalPages}
                </span>

                <button
                  onClick={() => setCurrentPage(p => Math.min(p + 1, totalPages))}
                  disabled={currentPage === totalPages}
                  className="p-1 bg-white border border-slate-250 rounded hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  <ChevronRight size={14} />
                </button>
                <button
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={currentPage === totalPages}
                  className="px-2 py-1 bg-white border border-slate-250 rounded hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed font-bold text-xs cursor-pointer"
                >
                  Last
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
