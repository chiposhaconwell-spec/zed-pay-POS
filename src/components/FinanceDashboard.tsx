import React, { useState, useEffect, useMemo } from 'react';
import {
  DollarSign,
  FileText,
  Download,
  Plus,
  RefreshCw,
  Layers,
  Search,
  CheckCircle2,
  Building2,
  Wallet,
  ArrowLeftRight,
  TrendingUp,
  AlertCircle,
  Receipt,
  Eye,
  Edit3,
  Trash2,
  Check,
  X,
  Calendar,
  Landmark,
  ShieldAlert,
  Ban,
} from 'lucide-react';
import {
  runSql,
  getCentralBranches,
  persistTablesToStorage,
  logEmployeeAudit,
  syncAllAccountingSystems,
  getAllSelectableAccounts,
  getActiveBusinessId,
  getActiveStoreId,
  getTenantAccountBalances,
  sqlEsc,
  calculateAssetValuation,
  getCachedReceiptsFromSqlite,
  type LocalReceiptRecord,
} from '../db';
import { fetchCentralSqlReport, flushPendingFinalizedTxMirrors } from '../firebase';
import { StoreSettings } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { jsPDF } from 'jspdf';
import { exportAndSharePdf } from '../androidUtils';
import {
  TransferReceiptAttachment,
  encodeTransferNotesWithReceipt,
  getTransferReceipt,
  saveTransferReceipt,
} from '../transferReceipts';
import { TransferReceiptField, TransferReceiptViewerModal } from './TransferReceiptField';

interface FinanceDashboardProps {
  settings: StoreSettings;
  userRole: string; // 'owner' | 'manager' | 'sales'
  activeStore: string;
}

export interface Asset {
  id: string;
  assetTag: string;
  name: string;
  category: 'Current' | 'Fixed';
  type: 'Equipment' | 'Vehicles' | 'Property' | 'IT & POS Hardware' | 'Furniture & Fixtures' | 'Other';
  serialNumber: string;
  purchaseDate: string;
  value: number; // acquisition cost
  salvageValue: number;
  usefulLifeYears: number;
  depreciationMethod: 'Straight Line' | 'Reducing Balance' | 'None';
  depreciationRate: number; // % per year
  fundingSource: string; // 'owner_equity' | account_id
  status: 'Active' | 'Disposed' | 'Written Off';
  disposalDate?: string;
  disposalProceeds?: number;
  notes?: string;
  linkedEquityId?: string;
  storeId: string;
}

export interface EquityEntry {
  id: string;
  name: string;
  equityType:
    | 'Owner Capital'
    | 'Share Capital'
    | 'Additional Paid-In Capital'
    | 'Asset Contribution'
    | 'Drawings / Dividends'
    | 'Retained Earnings Reserve';
  shareholderName: string;
  contributionDate: string;
  value: number;
  accountId: string;
  referenceNo: string;
  notes: string;
  status: 'Active' | 'Reversed';
  linkedAssetId?: string;
  storeId: string;
  createdAt?: string;
}

type PeriodOption = 'all_time' | 'this_month' | 'last_month' | 'this_quarter' | 'this_year' | 'custom';
type BranchMode = 'all' | 'single' | 'custom';

interface FinancialSummary {
  grossSales: number;
  salesRefunds: number;
  discountsAllowed: number;
  vatCollected: number;
  totalRevenue: number;
  totalCogs: number;
  grossProfit: number;
  rentExpense: number;
  utilitiesExpense: number;
  generalOperatingExpense: number;
  totalOperatingExpenses: number;
  totalPayroll: number;
  totalExpenses: number;
  netProfit: number;
  cashAndEquivalents: number;
  cashDrawerBalance: number;
  mobileMoneyBalance: number;
  bankCardBalance: number;
  inventoryAssetValue: number;
  goodsInTransitValue: number;
  fixedAssetsValue: number;
  totalAssetVal: number;
  vatPayableLiability: number;
  laybyDepositsLiability: number;
  loansPayableLiability: number;
  totalLiabilitiesVal: number;
  ownerCapitalEquity: number;
  retainedEarnings: number;
  totalEquityVal: number;
  operatingCashFlow: number;
  investingCashFlow: number;
  financingCashFlow: number;
  netCashFlow: number;
  beginningCashBalance: number;
  closingCashBalance: number;
}

const ASSET_CLASSES: Asset['type'][] = [
  'Equipment',
  'IT & POS Hardware',
  'Vehicles',
  'Property',
  'Furniture & Fixtures',
  'Other',
];

const EQUITY_TYPES: EquityEntry['equityType'][] = [
  'Owner Capital',
  'Share Capital',
  'Additional Paid-In Capital',
  'Asset Contribution',
  'Drawings / Dividends',
  'Retained Earnings Reserve',
];

const EMPTY_FINANCIALS: FinancialSummary = {
  grossSales: 0,
  salesRefunds: 0,
  discountsAllowed: 0,
  vatCollected: 0,
  totalRevenue: 0,
  totalCogs: 0,
  grossProfit: 0,
  rentExpense: 0,
  utilitiesExpense: 0,
  generalOperatingExpense: 0,
  totalOperatingExpenses: 0,
  totalPayroll: 0,
  totalExpenses: 0,
  netProfit: 0,
  cashAndEquivalents: 0,
  cashDrawerBalance: 0,
  mobileMoneyBalance: 0,
  bankCardBalance: 0,
  inventoryAssetValue: 0,
  goodsInTransitValue: 0,
  fixedAssetsValue: 0,
  totalAssetVal: 0,
  vatPayableLiability: 0,
  laybyDepositsLiability: 0,
  loansPayableLiability: 0,
  totalLiabilitiesVal: 0,
  ownerCapitalEquity: 0,
  retainedEarnings: 0,
  totalEquityVal: 0,
  operatingCashFlow: 0,
  investingCashFlow: 0,
  financingCashFlow: 0,
  netCashFlow: 0,
  beginningCashBalance: 0,
  closingCashBalance: 0,
};

export default function FinanceDashboard({ settings, userRole, activeStore }: FinanceDashboardProps) {
  // Sub-navigation tab state
  const [subTab, setSubTab] = useState<
    'statements' | 'payment_methods' | 'receipt_refund' | 'cash_flow' | 'double_entry' | 'expenses' | 'transfers' | 'assets_equity'
  >('statements');

  // Branch & Period selection for Financial Statements
  const [statementBranchMode, setStatementBranchMode] = useState<BranchMode>(() =>
    activeStore ? 'single' : 'all'
  );
  const [statementStoreFilter, setStatementStoreFilter] = useState<string>(() => activeStore || 'all');
  const [selectedStatementBranches, setSelectedStatementBranches] = useState<string[]>(() =>
    activeStore ? [activeStore] : []
  );
  const [selectedPeriod, setSelectedPeriod] = useState<PeriodOption>('all_time');
  const [customDateFrom, setCustomDateFrom] = useState<string>(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().split('T')[0];
  });
  const [customDateTo, setCustomDateTo] = useState<string>(() => new Date().toISOString().split('T')[0]);

  // Global in-UI feedback banner & confirm modal (no window.alert/window.confirm)
  const [financeFeedback, setFinanceFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    tone: 'danger' | 'amber';
    onConfirm: () => void;
  } | null>(null);

  // DB tables for Expenses and Transfers
  const [expensesList, setExpensesList] = useState<any[]>([]);
  const [allExpensesRaw, setAllExpensesRaw] = useState<any[]>([]);
  const [transfersList, setTransfersList] = useState<any[]>([]);

  // Double-entry synchronized accounting tables
  const [allStatementRows, setAllStatementRows] = useState<any[]>([]);
  const [allPaymentMethodRows, setAllPaymentMethodRows] = useState<any[]>([]);
  const [allReceiptRefundRows, setAllReceiptRefundRows] = useState<any[]>([]);
  const [allCashFlowRows, setAllCashFlowRows] = useState<any[]>([]);
  const [doubleEntryJournal, setDoubleEntryJournal] = useState<any[]>([]);
  const [eodCashUps, setEodCashUps] = useState<any[]>([]);
  const [ledgerFilterType, setLedgerFilterType] = useState<'ALL' | 'RECEIPT' | 'REFUND' | 'LAYBY_RECEIPT'>('ALL');

  // Expenses Form states
  const [expenseCategory, setExpenseCategory] = useState('Operating - Rent & Premises');
  const [expenseAccountId, setExpenseAccountId] = useState('acc_cash');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDescription, setExpenseDescription] = useState('');
  const [expenseRef, setExpenseRef] = useState('');
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().split('T')[0]);
  const [expenseStoreId, setExpenseStoreId] = useState(activeStore || '');

  // Money Transfers Form states
  const [transferSourceAcc, setTransferSourceAcc] = useState('acc_bank');
  const [transferDestAcc, setTransferDestAcc] = useState('acc_cash');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferRef, setTransferRef] = useState('');
  const [transferDate] = useState(new Date().toISOString().split('T')[0]);
  const [transferReceipt, setTransferReceipt] = useState<TransferReceiptAttachment | null>(null);
  const [transferFeedback, setTransferFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [viewingTransferReceipt, setViewingTransferReceipt] = useState<{
    receipt: TransferReceiptAttachment;
    refLabel: string;
  } | null>(null);

  const [storesList, setStoresList] = useState<Array<{ id: string; name: string }>>([]);

  // Dynamic Assets & Equity List states
  const [assets, setAssets] = useState<Asset[]>([]);
  const [equity, setEquity] = useState<EquityEntry[]>([]);
  const [accountBalances, setAccountBalances] = useState<any[]>([]);
  const [selectableAccounts, setSelectableAccounts] = useState(() => getAllSelectableAccounts());

  // DB raw tables loaded for Financial Statements
  const [statementOrders, setStatementOrders] = useState<any[]>([]);
  const [statementItems, setStatementItems] = useState<any[]>([]);
  const [statementProducts, setStatementProducts] = useState<any[]>([]);
  const [statementAttendance, setStatementAttendance] = useState<any[]>([]);
  const [statementPayrollEntries, setStatementPayrollEntries] = useState<any[]>([]);

  // Standardized Asset Form states (Add & Edit)
  const [showAssetForm, setShowAssetForm] = useState<boolean>(false);
  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [assetTagInput, setAssetTagInput] = useState('');
  const [newAssetName, setNewAssetName] = useState('');
  const [newAssetCategory, setNewAssetCategory] = useState<'Current' | 'Fixed'>('Fixed');
  const [newAssetType, setNewAssetType] = useState<Asset['type']>('Equipment');
  const [newAssetSerial, setNewAssetSerial] = useState('');
  const [newAssetPurchaseDate, setNewAssetPurchaseDate] = useState(new Date().toISOString().split('T')[0]);
  const [newAssetValue, setNewAssetValue] = useState('');
  const [newAssetSalvage, setNewAssetSalvage] = useState('0');
  const [newAssetUsefulLife, setNewAssetUsefulLife] = useState('5');
  const [newAssetDepreciationMethod, setNewAssetDepreciationMethod] = useState<'Straight Line' | 'Reducing Balance' | 'None'>('Straight Line');
  const [newAssetDepreciationRate, setNewAssetDepreciationRate] = useState<string>('20');
  const [newAssetFundingSource, setNewAssetFundingSource] = useState<string>('owner_equity');
  const [newAssetStatus, setNewAssetStatus] = useState<Asset['status']>('Active');
  const [newAssetDisposalDate, setNewAssetDisposalDate] = useState('');
  const [newAssetDisposalProceeds, setNewAssetDisposalProceeds] = useState('');
  const [newAssetStoreId, setNewAssetStoreId] = useState<string>(activeStore || '');
  const [newAssetNotes, setNewAssetNotes] = useState('');

  // Disposal modal state
  const [disposingAsset, setDisposingAsset] = useState<Asset | null>(null);
  const [disposeModalDate, setDisposeModalDate] = useState(new Date().toISOString().split('T')[0]);
  const [disposeModalProceeds, setDisposeModalProceeds] = useState('0');

  // Standardized Equity Form states (Add & Edit)
  const [showEquityForm, setShowEquityForm] = useState<boolean>(false);
  const [editingEquityId, setEditingEquityId] = useState<string | null>(null);
  const [newEquityName, setNewEquityName] = useState('');
  const [newEquityType, setNewEquityType] = useState<EquityEntry['equityType']>('Owner Capital');
  const [newEquityShareholder, setNewEquityShareholder] = useState('');
  const [newEquityDate, setNewEquityDate] = useState(new Date().toISOString().split('T')[0]);
  const [newEquityValue, setNewEquityValue] = useState('');
  const [newEquityAccountId, setNewEquityAccountId] = useState('acc_bank');
  const [newEquityReference, setNewEquityReference] = useState('');
  const [newEquityStoreId, setNewEquityStoreId] = useState<string>(activeStore || '');
  const [newEquityNotes, setNewEquityNotes] = useState('');

  // Assets & Equity Registry Filters
  const [registrySearch, setRegistrySearch] = useState('');
  const [registryBranchFilter, setRegistryBranchFilter] = useState<string>('all');
  const [registryStatusFilter, setRegistryStatusFilter] = useState<'ALL' | 'Active' | 'Disposed' | 'Written Off'>('ALL');

  // Central SQL Reporting & SQLite Receipt Cache state
  const [centralSqlReport, setCentralSqlReport] = useState<any | null>(null);
  const [centralSqlLoading, setCentralSqlLoading] = useState(false);
  const [centralSqlError, setCentralSqlError] = useState<string | null>(null);
  const [cachedReceipts, setCachedReceipts] = useState<LocalReceiptRecord[]>([]);

  const loadCentralSqlAndReceiptCache = async () => {
    const bizId = getActiveBusinessId();
    if (!bizId) return;
    const scopeStore =
      statementBranchMode === 'single' && statementStoreFilter !== 'all' ? statementStoreFilter : 'all';

    try {
      const localRows = await getCachedReceiptsFromSqlite(bizId, scopeStore, 50);
      setCachedReceipts(localRows);
    } catch {}

    setCentralSqlLoading(true);
    setCentralSqlError(null);
    try {
      await flushPendingFinalizedTxMirrors();
      const report = await fetchCentralSqlReport({
        businessId: bizId,
        storeId: scopeStore,
        startDate: periodMeta.from || undefined,
        endDate: periodMeta.to || undefined,
      });
      setCentralSqlReport(report);
    } catch (err: any) {
      setCentralSqlError(err?.message || 'Unable to load Central SQL report');
    } finally {
      setCentralSqlLoading(false);
    }
  };

  const notifyFinance = (type: 'success' | 'error', text: string) => {
    setFinanceFeedback({ type, text });
  };

  useEffect(() => {
    if (activeStore) {
      setStatementStoreFilter(activeStore);
      setStatementBranchMode((prev) => (prev === 'all' && activeStore ? 'single' : prev));
      setSelectedStatementBranches((prev) => (prev.length === 0 ? [activeStore] : prev));
      setExpenseStoreId(activeStore);
      setNewAssetStoreId((prev) => prev || activeStore);
      setNewEquityStoreId((prev) => prev || activeStore);
      loadFinanceData();
    }
  }, [activeStore]);

  const loadFinanceData = () => {
    syncAllAccountingSystems('Finance Dashboard Load');
    setSelectableAccounts(getAllSelectableAccounts());

    const activeBizId = getActiveBusinessId();
    const bizWhere = activeBizId ? `WHERE business_id = '${sqlEsc(activeBizId)}'` : '';
    const bizAnd = activeBizId ? `AND business_id = '${sqlEsc(activeBizId)}'` : '';
    const fallbackStore = getActiveStoreId(activeStore, activeBizId).toLowerCase().trim();

    // 1. Load Statement Snapshots & Payment Method Ledgers for ALL stores in business
    const stmtRes = runSql(
      `SELECT * FROM financial_statements_ledger ${bizWhere}`,
      'Finance: Fetch all branch financial statements'
    );
    const stmtRows = stmtRes.success && Array.isArray(stmtRes.data) ? stmtRes.data : [];
    setAllStatementRows(stmtRows);

    const pmRes = runSql(
      `SELECT * FROM payment_method_ledger ${bizWhere}`,
      'Finance: Fetch all branch payment method ledgers'
    );
    setAllPaymentMethodRows(pmRes.success && Array.isArray(pmRes.data) ? pmRes.data : []);

    // Build deduplicated branch list from Central Branches + any branches discovered in ledgers/assets/equity
    const branchMap = new Map<string, { id: string; name: string }>();
    const addBranchOption = (idRaw: any, nameRaw?: any) => {
      const cleanId = String(idRaw || '').trim();
      if (!cleanId || cleanId.toLowerCase() === 'all') return;
      const key = cleanId.toLowerCase();
      if (!branchMap.has(key)) {
        branchMap.set(key, {
          id: cleanId,
          name: String(nameRaw || cleanId),
        });
      }
    };

    getCentralBranches(activeBizId).forEach((s) => addBranchOption(s.id, s.name || s.id));
    stmtRows.forEach((r: any) => addBranchOption(r.store_id, r.store_id));

    // 2. Load Operating Expenses
    const expRes = runSql(
      `SELECT * FROM expenses ${bizWhere} ORDER BY expense_date DESC`,
      'Finance: Fetch operating expenses'
    );
    const expRows = expRes.success && Array.isArray(expRes.data) ? expRes.data : [];
    setAllExpensesRaw(expRows);
    expRows.forEach((ex: any) => addBranchOption(ex.store_id));

    // 3. Load Transfers
    const trRes = runSql(
      `SELECT * FROM money_transfers ${bizWhere} ORDER BY transfer_date DESC`,
      'Finance: Fetch transfers'
    );
    if (trRes.success && Array.isArray(trRes.data)) {
      setTransfersList(trRes.data);
    }

    // 4. Load Raw Orders (include refunded so period P&L matches double-entry), Order Items, Products & Attendance
    const ordRes = runSql(
      `SELECT * FROM orders 
       WHERE LOWER(TRIM(COALESCE(status, 'Completed'))) NOT IN ('cancelled', 'voided', 'deleted')
       ${bizAnd}
       ORDER BY orderDate DESC`,
      'Finance: Fetch orders for period P&L'
    );
    if (ordRes.success && Array.isArray(ordRes.data)) {
      setStatementOrders(ordRes.data);
      ordRes.data.forEach((o: any) => addBranchOption(o.store_id));
    }

    const itmRes = runSql(`SELECT * FROM order_items ${bizWhere}`, 'Finance: Fetch order items');
    if (itmRes.success && Array.isArray(itmRes.data)) setStatementItems(itmRes.data);

    const prodRes = runSql(`SELECT id, cost, price FROM products ${bizWhere}`, 'Finance: Fetch products cost map');
    if (prodRes.success && Array.isArray(prodRes.data)) setStatementProducts(prodRes.data);

    const attRes = runSql(
      `SELECT * FROM time_attendance WHERE status = 'PAID' ${bizAnd}`,
      'Finance: Fetch paid payroll'
    );
    if (attRes.success && Array.isArray(attRes.data)) setStatementAttendance(attRes.data);

    const payRes = runSql(
      `SELECT * FROM payroll_entries WHERE status = 'PAID' ${bizAnd}`,
      'Finance: Fetch paid salary payroll entries',
      true
    );
    if (payRes.success && Array.isArray(payRes.data)) setStatementPayrollEntries(payRes.data);

    // 5. Load Live Account Balances scoped to active business
    setAccountBalances(getTenantAccountBalances(activeBizId));

    // 6. Load Receipt/Refund, Cash Flow, Journal & EOD Ledgers
    const rrRes = runSql(
      `SELECT * FROM receipt_refund_ledger ${bizWhere} ORDER BY date DESC`,
      'Finance: Fetch Receipt & Refund Ledger'
    );
    if (rrRes.success && Array.isArray(rrRes.data)) {
      setAllReceiptRefundRows(rrRes.data);
    }

    const cfRes = runSql(
      `SELECT * FROM cash_flow_ledger ${bizWhere} ORDER BY date DESC`,
      'Finance: Fetch Cash Flow Ledger'
    );
    if (cfRes.success && Array.isArray(cfRes.data)) {
      setAllCashFlowRows(cfRes.data);
    }

    const jrnRes = runSql(
      `SELECT * FROM double_entry_journal ${bizWhere} ORDER BY date DESC`,
      'Finance: Fetch Double-Entry General Journal'
    );
    if (jrnRes.success && Array.isArray(jrnRes.data)) {
      setDoubleEntryJournal(jrnRes.data);
    }

    const eodRes = runSql(
      `SELECT * FROM cash_ups ${bizWhere} ORDER BY created_at DESC`,
      'Finance: Fetch EOD Cash-Ups'
    );
    if (eodRes.success && Array.isArray(eodRes.data)) {
      setEodCashUps(eodRes.data);
    }

    // 7. Load Standardized Assets & Equity
    const assetRes = runSql(`SELECT * FROM assets ${bizWhere}`, 'Finance: Fetch assets');
    if (assetRes.success && Array.isArray(assetRes.data)) {
      const parsedAssets: Asset[] = assetRes.data.map((a: any) => ({
        id: String(a.id),
        assetTag: String(a.asset_tag || a.id || ''),
        name: String(a.name || 'Unnamed Asset'),
        category: a.category === 'Current' ? 'Current' : 'Fixed',
        type: (ASSET_CLASSES.includes(a.type) ? a.type : 'Equipment') as Asset['type'],
        serialNumber: String(a.serial_number || ''),
        purchaseDate: String(a.purchase_date || new Date().toISOString().split('T')[0]),
        value: Number(a.value || 0),
        salvageValue: Number(a.salvage_value || 0),
        usefulLifeYears: Math.max(1, Number(a.useful_life_years || (Number(a.depreciation_rate || 0) > 0 ? Math.round(100 / Number(a.depreciation_rate)) : 5))),
        depreciationMethod:
          a.depreciation_method === 'Reducing Balance' || a.depreciation_method === 'None'
            ? a.depreciation_method
            : 'Straight Line',
        depreciationRate: Number(a.depreciation_rate ?? 20),
        fundingSource: String(a.funding_source || (a.linked_equity_id ? 'owner_equity' : 'owner_equity')),
        status:
          a.status === 'Disposed' || a.status === 'Written Off'
            ? a.status
            : 'Active',
        disposalDate: a.disposal_date ? String(a.disposal_date) : '',
        disposalProceeds: Number(a.disposal_proceeds || 0),
        notes: String(a.notes || ''),
        linkedEquityId: String(a.linked_equity_id || ''),
        storeId: String(a.store_id || fallbackStore),
      }));
      parsedAssets.forEach((a) => addBranchOption(a.storeId));
      setAssets(parsedAssets);
    } else {
      setAssets([]);
    }

    const eqRes = runSql(`SELECT * FROM equity ${bizWhere}`, 'Finance: Fetch equity');
    if (eqRes.success && Array.isArray(eqRes.data)) {
      const parsedEquity: EquityEntry[] = eqRes.data.map((e: any) => ({
        id: String(e.id),
        name: String(e.name || 'Capital Entry'),
        equityType: (EQUITY_TYPES.includes(e.equity_type)
          ? e.equity_type
          : e.linked_asset_id
            ? 'Asset Contribution'
            : 'Owner Capital') as EquityEntry['equityType'],
        shareholderName: String(e.shareholder_name || ''),
        contributionDate: String(e.contribution_date || String(e.created_at || '').split('T')[0] || new Date().toISOString().split('T')[0]),
        value: Number(e.value || 0),
        accountId: String(e.account_id || 'acc_bank'),
        referenceNo: String(e.reference_no || ''),
        notes: String(e.notes || ''),
        status: e.status === 'Reversed' ? 'Reversed' : 'Active',
        linkedAssetId: String(e.linked_asset_id || ''),
        storeId: String(e.store_id || fallbackStore),
        createdAt: String(e.created_at || ''),
      }));
      parsedEquity.forEach((eq) => addBranchOption(eq.storeId));
      setEquity(parsedEquity);
    } else {
      setEquity([]);
    }

    const discoveredBranches = Array.from(branchMap.values());
    setStoresList(discoveredBranches);
    if (!expenseStoreId && (activeStore || discoveredBranches[0]?.id)) {
      setExpenseStoreId(activeStore || discoveredBranches[0].id);
    }
    if (!newAssetStoreId && (activeStore || discoveredBranches[0]?.id)) {
      setNewAssetStoreId(activeStore || discoveredBranches[0].id);
    }
    if (!newEquityStoreId && (activeStore || discoveredBranches[0]?.id)) {
      setNewEquityStoreId(activeStore || discoveredBranches[0].id);
    }
    setSelectedStatementBranches((prev) => {
      if (prev.length > 0) return prev;
      if (activeStore) return [activeStore];
      return discoveredBranches.map((b) => b.id);
    });
  };

  useEffect(() => {
    loadFinanceData();

    const handleDataUpdate = () => {
      loadFinanceData();
    };

    window.addEventListener('pos_sale_completed', handleDataUpdate);
    window.addEventListener('pos_data_updated', handleDataUpdate);
    window.addEventListener('storage', handleDataUpdate);

    return () => {
      window.removeEventListener('pos_sale_completed', handleDataUpdate);
      window.removeEventListener('pos_data_updated', handleDataUpdate);
      window.removeEventListener('storage', handleDataUpdate);
    };
  }, [subTab, activeStore]);

  // Compute scoped expenses list dynamically
  useEffect(() => {
    if (statementBranchMode === 'all') {
      setExpensesList(allExpensesRaw);
    } else if (statementBranchMode === 'single' && statementStoreFilter !== 'all') {
      const target = statementStoreFilter.toLowerCase().trim();
      setExpensesList(allExpensesRaw.filter((ex: any) => String(ex.store_id || '').toLowerCase().trim() === target));
    } else if (statementBranchMode === 'custom') {
      const setLower = new Set(selectedStatementBranches.map((b) => b.toLowerCase().trim()));
      setExpensesList(allExpensesRaw.filter((ex: any) => setLower.has(String(ex.store_id || '').toLowerCase().trim())));
    } else {
      setExpensesList(allExpensesRaw);
    }
  }, [allExpensesRaw, statementBranchMode, statementStoreFilter, selectedStatementBranches]);

  const branchNameLookup = useMemo(() => {
    const map = new Map<string, string>();
    storesList.forEach((s) => map.set(s.id.toLowerCase().trim(), s.name));
    return map;
  }, [storesList]);

  const getBranchLabel = (storeId?: string) => {
    const key = String(storeId || '').toLowerCase().trim();
    if (!key) return 'Main Branch';
    return branchNameLookup.get(key) || storeId || 'Main Branch';
  };

  // Resolved branch scope for statements & payment method ledgers
  const activeScopeBranches = useMemo<string[] | 'all'>(() => {
    if (statementBranchMode === 'all') return 'all';
    if (statementBranchMode === 'single') {
      if (!statementStoreFilter || statementStoreFilter === 'all') return 'all';
      return [statementStoreFilter];
    }
    return selectedStatementBranches;
  }, [statementBranchMode, statementStoreFilter, selectedStatementBranches]);

  const activeScopeLabel = useMemo(() => {
    if (activeScopeBranches === 'all') return 'All Branches Consolidated';
    if (activeScopeBranches.length === 0) return 'No Branches Selected';
    if (activeScopeBranches.length === 1) return getBranchLabel(activeScopeBranches[0]);
    return `${activeScopeBranches.length} Selected Branches (${activeScopeBranches.map((b) => getBranchLabel(b)).join(', ')})`;
  }, [activeScopeBranches, storesList]);

  const scopedPaymentMethodLedger = useMemo(() => {
    if (activeScopeBranches === 'all') {
      return allPaymentMethodRows.filter((pm) => String(pm.store_id || '').toLowerCase().trim() === 'all');
    }
    if (activeScopeBranches.length === 0) return [];
    if (activeScopeBranches.length === 1) {
      const target = activeScopeBranches[0].toLowerCase().trim();
      return allPaymentMethodRows.filter((pm) => String(pm.store_id || '').toLowerCase().trim() === target);
    }
    const targetSet = new Set(activeScopeBranches.map((b) => b.toLowerCase().trim()));
    const grouped = new Map<string, any>();
    allPaymentMethodRows
      .filter((pm) => {
        const st = String(pm.store_id || '').toLowerCase().trim();
        return st !== 'all' && targetSet.has(st);
      })
      .forEach((pm) => {
        const key = `${pm.payment_method}__${pm.account_id}`;
        const prev = grouped.get(key) || {
          id: `CUSTOM_${key}`,
          payment_method: pm.payment_method,
          account_id: pm.account_id,
          gross_receipts: 0,
          layby_receipts: 0,
          refunds_out: 0,
          expenses_out: 0,
          transfers_in: 0,
          transfers_out: 0,
          net_balance: 0,
          transaction_count: 0,
        };
        prev.gross_receipts += Number(pm.gross_receipts || 0);
        prev.layby_receipts += Number(pm.layby_receipts || 0);
        prev.refunds_out += Number(pm.refunds_out || 0);
        prev.expenses_out += Number(pm.expenses_out || 0);
        prev.transfers_in += Number(pm.transfers_in || 0);
        prev.transfers_out += Number(pm.transfers_out || 0);
        prev.net_balance += Number(pm.net_balance || 0);
        prev.transaction_count += Number(pm.transaction_count || 0);
        grouped.set(key, prev);
      });
    return Array.from(grouped.values());
  }, [allPaymentMethodRows, activeScopeBranches]);

  const scopedReceiptRefundLedger = useMemo(() => {
    if (activeScopeBranches === 'all') return allReceiptRefundRows;
    const targetSet = new Set(activeScopeBranches.map((b) => b.toLowerCase().trim()));
    return allReceiptRefundRows.filter((r) => targetSet.has(String(r.store_id || '').toLowerCase().trim()));
  }, [allReceiptRefundRows, activeScopeBranches]);

  const scopedCashFlowLedger = useMemo(() => {
    if (activeScopeBranches === 'all') return allCashFlowRows;
    const targetSet = new Set(activeScopeBranches.map((b) => b.toLowerCase().trim()));
    return allCashFlowRows.filter((r) => targetSet.has(String(r.store_id || '').toLowerCase().trim()));
  }, [allCashFlowRows, activeScopeBranches]);

  // Handle adding expense
  const handleRecordExpense = (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(expenseAmount);
    if (isNaN(amt) || amt <= 0) {
      notifyFinance('error', 'Please enter a valid expense amount greater than 0.');
      return;
    }

    const expId = 'EXP-' + Math.floor(10000 + Math.random() * 90000);
    const dateVal = expenseDate || new Date().toISOString().split('T')[0];

    const operatorName = (
      localStorage.getItem('logged_in_user_name') ||
      localStorage.getItem('logged_in_user_email') ||
      userRole ||
      'Staff'
    ).replace(/'/g, "''");
    const activeBizId = getActiveBusinessId();
    const resolvedStoreId = getActiveStoreId(expenseStoreId || activeStore, activeBizId);
    runSql(
      `INSERT INTO expenses (id, category, account_id, amount, description, reference_no, expense_date, store_id, performed_by, created_at, business_id)
       VALUES ('${expId}', '${sqlEsc(expenseCategory)}', '${sqlEsc(expenseAccountId)}', ${amt}, '${sqlEsc(expenseDescription)}', '${sqlEsc(expenseRef)}', '${sqlEsc(dateVal)}', '${sqlEsc(resolvedStoreId)}', '${operatorName}', '${new Date().toISOString()}', '${sqlEsc(activeBizId)}')`,
      'Record Operating Expense'
    );

    logEmployeeAudit(
      'EXPENSE',
      'Recorded Operating Expense',
      `Expense #${expId} recorded for ${expenseCategory} - K${amt.toFixed(2)} (${expenseDescription})`,
      amt,
      resolvedStoreId
    );
    syncAllAccountingSystems(`Expense Recorded #${expId}`);
    persistTablesToStorage();

    setExpenseAmount('');
    setExpenseDescription('');
    setExpenseRef('');
    loadFinanceData();
    try {
      window.dispatchEvent(new Event('pos_data_updated'));
    } catch {}
    notifyFinance('success', `Expense record #${expId} created & synced across Double-Entry Accounting Ledgers.`);
  };

  // Handle Cash / Account Transfer
  const handleExecuteTransfer = (e: React.FormEvent) => {
    e.preventDefault();
    setTransferFeedback(null);
    const amt = parseFloat(transferAmount);
    if (isNaN(amt) || amt <= 0) {
      setTransferFeedback({ type: 'error', text: 'Please enter a valid transfer amount.' });
      return;
    }
    if (transferSourceAcc === transferDestAcc) {
      setTransferFeedback({ type: 'error', text: 'Source and destination accounts must be different!' });
      return;
    }

    const trId = 'TRF-' + Math.floor(10000 + Math.random() * 90000);
    const dateVal = transferDate || new Date().toISOString().split('T')[0];
    const encodedNotes = encodeTransferNotesWithReceipt(transferRef, transferReceipt);
    const activeBizId = getActiveBusinessId();
    const resolvedStoreId = getActiveStoreId(activeStore, activeBizId);

    const operatorName = (
      localStorage.getItem('logged_in_user_name') ||
      localStorage.getItem('logged_in_user_email') ||
      userRole ||
      'Staff'
    ).replace(/'/g, "''");
    runSql(
      `INSERT INTO money_transfers (id, source_account, dest_account, amount, reference_no, transfer_date, performed_by, notes, business_id, store_id)
       VALUES ('${trId}', '${sqlEsc(transferSourceAcc)}', '${sqlEsc(transferDestAcc)}', ${amt}, '${sqlEsc(transferRef)}', '${sqlEsc(dateVal)}', '${operatorName}', '${sqlEsc(encodedNotes)}', '${sqlEsc(activeBizId)}', '${sqlEsc(resolvedStoreId)}')`,
      'Record Cash Transfer'
    );

    if (transferReceipt) {
      saveTransferReceipt(trId, transferReceipt);
    }

    logEmployeeAudit(
      'TRANSFER',
      'Account Transfer',
      `Transfer #${trId} from ${transferSourceAcc} to ${transferDestAcc} - K${amt.toFixed(2)}`,
      amt,
      resolvedStoreId
    );
    syncAllAccountingSystems(`Transfer Executed #${trId}`);
    persistTablesToStorage();

    setTransferAmount('');
    setTransferRef('');
    setTransferReceipt(null);
    loadFinanceData();
    try {
      window.dispatchEvent(new Event('pos_data_updated'));
    } catch {}
    setTransferFeedback({
      type: 'success',
      text: `Cash transfer #${trId} executed & updated in Payment Method & Double-Entry Ledgers.${transferReceipt ? ' (Receipt attached)' : ''}`,
    });
  };

  // --- STANDARDIZED ASSET & EQUITY HANDLERS ---
  const resetAssetForm = () => {
    setEditingAssetId(null);
    setAssetTagInput('');
    setNewAssetName('');
    setNewAssetCategory('Fixed');
    setNewAssetType('Equipment');
    setNewAssetSerial('');
    setNewAssetPurchaseDate(new Date().toISOString().split('T')[0]);
    setNewAssetValue('');
    setNewAssetSalvage('0');
    setNewAssetUsefulLife('5');
    setNewAssetDepreciationMethod('Straight Line');
    setNewAssetDepreciationRate('20');
    setNewAssetFundingSource('owner_equity');
    setNewAssetStatus('Active');
    setNewAssetDisposalDate('');
    setNewAssetDisposalProceeds('');
    setNewAssetStoreId(activeStore || storesList[0]?.id || '');
    setNewAssetNotes('');
    setShowAssetForm(false);
  };

  const openEditAsset = (ast: Asset) => {
    setEditingAssetId(ast.id);
    setAssetTagInput(ast.assetTag || ast.id);
    setNewAssetName(ast.name);
    setNewAssetCategory(ast.category);
    setNewAssetType(ast.type);
    setNewAssetSerial(ast.serialNumber || '');
    setNewAssetPurchaseDate(ast.purchaseDate || new Date().toISOString().split('T')[0]);
    setNewAssetValue(String(ast.value));
    setNewAssetSalvage(String(ast.salvageValue || 0));
    setNewAssetUsefulLife(String(ast.usefulLifeYears || 5));
    setNewAssetDepreciationMethod(ast.depreciationMethod || 'Straight Line');
    setNewAssetDepreciationRate(String(ast.depreciationRate ?? 20));
    setNewAssetFundingSource(ast.fundingSource || (ast.linkedEquityId ? 'owner_equity' : 'acc_bank'));
    setNewAssetStatus(ast.status || 'Active');
    setNewAssetDisposalDate(ast.disposalDate || '');
    setNewAssetDisposalProceeds(String(ast.disposalProceeds || 0));
    setNewAssetStoreId(ast.storeId || activeStore || storesList[0]?.id || '');
    setNewAssetNotes(ast.notes || '');
    setShowAssetForm(true);
  };

  const handleSaveAsset = (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(newAssetValue);
    if (isNaN(val) || val <= 0 || !newAssetName.trim()) {
      notifyFinance('error', 'Please enter a valid asset name and positive acquisition cost.');
      return;
    }
    const salvageVal = Math.max(0, Math.min(val, parseFloat(newAssetSalvage) || 0));
    const usefulLife = Math.max(1, parseInt(newAssetUsefulLife, 10) || 5);
    const depRate = newAssetDepreciationMethod === 'None' ? 0 : Math.max(0, Math.min(100, parseFloat(newAssetDepreciationRate) || 0));
    const dispProceeds = newAssetStatus === 'Disposed' ? Math.max(0, parseFloat(newAssetDisposalProceeds) || 0) : 0;
    const dispDate = newAssetStatus === 'Disposed' ? newAssetDisposalDate || new Date().toISOString().split('T')[0] : '';

    const activeBizId = getActiveBusinessId();
    const resolvedStoreId = getActiveStoreId(newAssetStoreId || activeStore, activeBizId).toLowerCase().trim();
    const nowIso = new Date().toISOString();
    const isEquityFunded = newAssetFundingSource === 'owner_equity';

    if (editingAssetId) {
      const existing = assets.find((a) => a.id === editingAssetId);
      let linkedEqId = existing?.linkedEquityId || '';
      const assetTag = assetTagInput.trim() || existing?.assetTag || editingAssetId;

      if (isEquityFunded) {
        const eqStatus = newAssetStatus === 'Active' ? 'Active' : 'Reversed';
        if (linkedEqId) {
          runSql(
            `UPDATE equity SET name = 'Asset Contribution (${sqlEsc(newAssetName)})', equity_type = 'Asset Contribution', contribution_date = '${sqlEsc(newAssetPurchaseDate)}', value = ${val}, account_id = 'acc_owner_capital', store_id = '${sqlEsc(resolvedStoreId)}', status = '${eqStatus}', notes = '${sqlEsc(newAssetNotes)}' WHERE id = '${sqlEsc(linkedEqId)}' AND business_id = '${sqlEsc(activeBizId)}'`,
            'Update Linked Capital Equity'
          );
        } else {
          linkedEqId = 'EQ-' + Math.floor(10000 + Math.random() * 90000);
          runSql(
            `INSERT INTO equity (id, name, equity_type, shareholder_name, contribution_date, value, account_id, reference_no, notes, status, linked_asset_id, business_id, store_id, created_at)
             VALUES ('${linkedEqId}', 'Asset Contribution (${sqlEsc(newAssetName)})', 'Asset Contribution', 'Owner', '${sqlEsc(newAssetPurchaseDate)}', ${val}, 'acc_owner_capital', '${sqlEsc(assetTag)}', '${sqlEsc(newAssetNotes)}', '${eqStatus}', '${sqlEsc(editingAssetId)}', '${sqlEsc(activeBizId)}', '${sqlEsc(resolvedStoreId)}', '${nowIso}')`,
            'Create Linked Capital Equity'
          );
        }
      } else if (linkedEqId) {
        runSql(
          `DELETE FROM equity WHERE id = '${sqlEsc(linkedEqId)}' AND business_id = '${sqlEsc(activeBizId)}'`,
          'Remove Unlinked Capital Equity'
        );
        linkedEqId = '';
      }

      runSql(
        `UPDATE assets SET asset_tag = '${sqlEsc(assetTag)}', name = '${sqlEsc(newAssetName)}', category = '${sqlEsc(newAssetCategory)}', type = '${sqlEsc(newAssetType)}', serial_number = '${sqlEsc(newAssetSerial)}', purchase_date = '${sqlEsc(newAssetPurchaseDate)}', value = ${val}, salvage_value = ${salvageVal}, useful_life_years = ${usefulLife}, depreciation_method = '${sqlEsc(newAssetDepreciationMethod)}', depreciation_rate = ${depRate}, funding_source = '${sqlEsc(newAssetFundingSource)}', status = '${sqlEsc(newAssetStatus)}', disposal_date = '${sqlEsc(dispDate)}', disposal_proceeds = ${dispProceeds}, notes = '${sqlEsc(newAssetNotes)}', linked_equity_id = '${sqlEsc(linkedEqId)}', store_id = '${sqlEsc(resolvedStoreId)}', updated_at = '${nowIso}' WHERE id = '${sqlEsc(editingAssetId)}' AND business_id = '${sqlEsc(activeBizId)}'`,
        'Update Asset Record'
      );

      logEmployeeAudit('FINANCE', 'Updated Asset Record', `Updated ${newAssetName} (${assetTag}) - Cost ${settings.currency}${val.toFixed(2)}`, val, resolvedStoreId);
      syncAllAccountingSystems(`Asset Updated #${editingAssetId}`);
      persistTablesToStorage();
      resetAssetForm();
      loadFinanceData();
      try {
        window.dispatchEvent(new Event('pos_data_updated'));
      } catch {}
      notifyFinance('success', `Asset #${editingAssetId} updated and Balance Sheet synchronized.`);
      return;
    }

    const astId = 'AST-' + Math.floor(10000 + Math.random() * 90000);
    const assetTag = assetTagInput.trim() || `TAG-${astId.replace('AST-', '')}`;
    const eqId = isEquityFunded ? 'EQ-' + Math.floor(10000 + Math.random() * 90000) : '';

    runSql(
      `INSERT INTO assets (id, asset_tag, name, category, type, serial_number, purchase_date, value, salvage_value, useful_life_years, depreciation_method, depreciation_rate, funding_source, status, disposal_date, disposal_proceeds, notes, linked_equity_id, business_id, store_id, updated_at)
       VALUES ('${astId}', '${sqlEsc(assetTag)}', '${sqlEsc(newAssetName)}', '${sqlEsc(newAssetCategory)}', '${sqlEsc(newAssetType)}', '${sqlEsc(newAssetSerial)}', '${sqlEsc(newAssetPurchaseDate)}', ${val}, ${salvageVal}, ${usefulLife}, '${sqlEsc(newAssetDepreciationMethod)}', ${depRate}, '${sqlEsc(newAssetFundingSource)}', '${sqlEsc(newAssetStatus)}', '${sqlEsc(dispDate)}', ${dispProceeds}, '${sqlEsc(newAssetNotes)}', '${sqlEsc(eqId)}', '${sqlEsc(activeBizId)}', '${sqlEsc(resolvedStoreId)}', '${nowIso}')`,
      'Add Asset Record'
    );

    if (isEquityFunded && eqId) {
      const eqStatus = newAssetStatus === 'Active' ? 'Active' : 'Reversed';
      runSql(
        `INSERT INTO equity (id, name, equity_type, shareholder_name, contribution_date, value, account_id, reference_no, notes, status, linked_asset_id, business_id, store_id, created_at)
         VALUES ('${eqId}', 'Asset Contribution (${sqlEsc(newAssetName)})', 'Asset Contribution', 'Owner', '${sqlEsc(newAssetPurchaseDate)}', ${val}, 'acc_owner_capital', '${sqlEsc(assetTag)}', '${sqlEsc(newAssetNotes)}', '${eqStatus}', '${astId}', '${sqlEsc(activeBizId)}', '${sqlEsc(resolvedStoreId)}', '${nowIso}')`,
        'Add Linked Capital Equity'
      );
    }

    logEmployeeAudit(
      'FINANCE',
      'Registered Asset',
      `Asset ${newAssetName} (${assetTag}) registered for ${settings.currency}${val.toFixed(2)}`,
      val,
      resolvedStoreId
    );
    syncAllAccountingSystems(`Asset Added #${astId}`);
    persistTablesToStorage();
    resetAssetForm();
    loadFinanceData();
    try {
      window.dispatchEvent(new Event('pos_data_updated'));
    } catch {}
    notifyFinance('success', `Asset ${assetTag} (#${astId}) registered in Balance Sheet & Double-Entry Ledger.`);
  };

  const handleConfirmDisposeAsset = (e: React.FormEvent) => {
    e.preventDefault();
    if (!disposingAsset) return;
    const proceeds = Math.max(0, parseFloat(disposeModalProceeds) || 0);
    const activeBizId = getActiveBusinessId();
    const nowIso = new Date().toISOString();

    runSql(
      `UPDATE assets SET status = 'Disposed', disposal_date = '${sqlEsc(disposeModalDate)}', disposal_proceeds = ${proceeds}, updated_at = '${nowIso}' WHERE id = '${sqlEsc(disposingAsset.id)}' AND business_id = '${sqlEsc(activeBizId)}'`,
      'Dispose Asset'
    );

    logEmployeeAudit(
      'FINANCE',
      'Disposed Asset',
      `Disposed ${disposingAsset.name} (${disposingAsset.assetTag}) for proceeds ${settings.currency}${proceeds.toFixed(2)}`,
      proceeds,
      disposingAsset.storeId
    );
    syncAllAccountingSystems(`Asset Disposed #${disposingAsset.id}`);
    persistTablesToStorage();
    setDisposingAsset(null);
    loadFinanceData();
    try {
      window.dispatchEvent(new Event('pos_data_updated'));
    } catch {}
    notifyFinance('success', `Asset "${disposingAsset.name}" marked as Disposed (${settings.currency}${proceeds.toFixed(2)} proceeds).`);
  };

  const handleWriteOffAsset = (ast: Asset) => {
    setConfirmAction({
      title: 'Write Off Asset',
      message: `Write off "${ast.name}" (${ast.assetTag})? Its Net Book Value will drop to 0 on the Balance Sheet.`,
      confirmLabel: 'Write Off Asset',
      tone: 'amber',
      onConfirm: () => {
        const activeBizId = getActiveBusinessId();
        runSql(
          `UPDATE assets SET status = 'Written Off', disposal_date = '${new Date().toISOString().split('T')[0]}', disposal_proceeds = 0, updated_at = '${new Date().toISOString()}' WHERE id = '${sqlEsc(ast.id)}' AND business_id = '${sqlEsc(activeBizId)}'`,
          'Write Off Asset'
        );
        syncAllAccountingSystems(`Asset Written Off #${ast.id}`);
        persistTablesToStorage();
        loadFinanceData();
        try {
          window.dispatchEvent(new Event('pos_data_updated'));
        } catch {}
        notifyFinance('success', `Asset "${ast.name}" marked as Written Off.`);
      },
    });
  };

  const handleDeleteAsset = (ast: Asset) => {
    setConfirmAction({
      title: 'Delete Asset Record',
      message: `Permanently delete "${ast.name}" (${ast.assetTag}) and reverse any linked accounting entries?`,
      confirmLabel: 'Delete Asset',
      tone: 'danger',
      onConfirm: () => {
        const activeBizId = getActiveBusinessId();
        runSql(
          `DELETE FROM assets WHERE id = '${sqlEsc(ast.id)}' AND business_id = '${sqlEsc(activeBizId)}'`,
          'Delete Asset'
        );
        if (ast.linkedEquityId) {
          runSql(
            `DELETE FROM equity WHERE id = '${sqlEsc(ast.linkedEquityId)}' AND business_id = '${sqlEsc(activeBizId)}'`,
            'Delete Linked Equity'
          );
        }
        syncAllAccountingSystems(`Asset Deleted #${ast.id}`);
        persistTablesToStorage();
        loadFinanceData();
        try {
          window.dispatchEvent(new Event('pos_data_updated'));
        } catch {}
        notifyFinance('success', `Asset "${ast.name}" deleted and accounting ledgers rebuilt.`);
      },
    });
  };

  const resetEquityForm = () => {
    setEditingEquityId(null);
    setNewEquityName('');
    setNewEquityType('Owner Capital');
    setNewEquityShareholder('');
    setNewEquityDate(new Date().toISOString().split('T')[0]);
    setNewEquityValue('');
    setNewEquityAccountId('acc_bank');
    setNewEquityReference('');
    setNewEquityStoreId(activeStore || storesList[0]?.id || '');
    setNewEquityNotes('');
    setShowEquityForm(false);
  };

  const openEditEquity = (eq: EquityEntry) => {
    setEditingEquityId(eq.id);
    setNewEquityName(eq.name);
    setNewEquityType(eq.equityType);
    setNewEquityShareholder(eq.shareholderName);
    setNewEquityDate(eq.contributionDate || new Date().toISOString().split('T')[0]);
    setNewEquityValue(String(eq.value));
    setNewEquityAccountId(eq.accountId || 'acc_bank');
    setNewEquityReference(eq.referenceNo || '');
    setNewEquityStoreId(eq.storeId || activeStore || storesList[0]?.id || '');
    setNewEquityNotes(eq.notes || '');
    setShowEquityForm(true);
  };

  const handleSaveEquity = (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(newEquityValue);
    if (isNaN(val) || val <= 0 || !newEquityName.trim()) {
      notifyFinance('error', 'Please enter a valid equity entry description and positive amount.');
      return;
    }

    const activeBizId = getActiveBusinessId();
    const resolvedStoreId = getActiveStoreId(newEquityStoreId || activeStore, activeBizId).toLowerCase().trim();
    const nowIso = new Date().toISOString();

    if (editingEquityId) {
      runSql(
        `UPDATE equity SET name = '${sqlEsc(newEquityName)}', equity_type = '${sqlEsc(newEquityType)}', shareholder_name = '${sqlEsc(newEquityShareholder)}', contribution_date = '${sqlEsc(newEquityDate)}', value = ${val}, account_id = '${sqlEsc(newEquityAccountId)}', reference_no = '${sqlEsc(newEquityReference)}', notes = '${sqlEsc(newEquityNotes)}', store_id = '${sqlEsc(resolvedStoreId)}' WHERE id = '${sqlEsc(editingEquityId)}' AND business_id = '${sqlEsc(activeBizId)}'`,
        'Update Capital Equity Record'
      );
      logEmployeeAudit('FINANCE', 'Updated Equity Entry', `${newEquityType}: ${newEquityName} (${settings.currency}${val.toFixed(2)})`, val, resolvedStoreId);
      syncAllAccountingSystems(`Equity Updated #${editingEquityId}`);
      persistTablesToStorage();
      resetEquityForm();
      loadFinanceData();
      try {
        window.dispatchEvent(new Event('pos_data_updated'));
      } catch {}
      notifyFinance('success', `Capital equity entry #${editingEquityId} updated.`);
      return;
    }

    const eqId = 'EQ-' + Math.floor(10000 + Math.random() * 90000);
    runSql(
      `INSERT INTO equity (id, name, equity_type, shareholder_name, contribution_date, value, account_id, reference_no, notes, status, linked_asset_id, business_id, store_id, created_at)
       VALUES ('${eqId}', '${sqlEsc(newEquityName)}', '${sqlEsc(newEquityType)}', '${sqlEsc(newEquityShareholder)}', '${sqlEsc(newEquityDate)}', ${val}, '${sqlEsc(newEquityAccountId)}', '${sqlEsc(newEquityReference)}', '${sqlEsc(newEquityNotes)}', 'Active', '', '${sqlEsc(activeBizId)}', '${sqlEsc(resolvedStoreId)}', '${nowIso}')`,
      'Add Capital Equity Record'
    );

    logEmployeeAudit('FINANCE', 'Recorded Capital Equity', `${newEquityType}: ${newEquityName} (${settings.currency}${val.toFixed(2)})`, val, resolvedStoreId);
    syncAllAccountingSystems(`Equity Added #${eqId}`);
    persistTablesToStorage();
    resetEquityForm();
    loadFinanceData();
    try {
      window.dispatchEvent(new Event('pos_data_updated'));
    } catch {}
    notifyFinance('success', `Capital equity #${eqId} recorded & reflected in Balance Sheet and Cash Flow.`);
  };

  const handleToggleReverseEquity = (eq: EquityEntry) => {
    const nextStatus = eq.status === 'Reversed' ? 'Active' : 'Reversed';
    const activeBizId = getActiveBusinessId();
    runSql(
      `UPDATE equity SET status = '${nextStatus}' WHERE id = '${sqlEsc(eq.id)}' AND business_id = '${sqlEsc(activeBizId)}'`,
      'Toggle Equity Status'
    );
    syncAllAccountingSystems(`Equity ${nextStatus} #${eq.id}`);
    persistTablesToStorage();
    loadFinanceData();
    try {
      window.dispatchEvent(new Event('pos_data_updated'));
    } catch {}
    notifyFinance('success', `Equity entry "${eq.name}" marked as ${nextStatus}.`);
  };

  const handleDeleteEquity = (eq: EquityEntry) => {
    setConfirmAction({
      title: 'Delete Equity Record',
      message: `Permanently delete equity entry "${eq.name}" (${settings.currency}${eq.value.toFixed(2)})?`,
      confirmLabel: 'Delete Entry',
      tone: 'danger',
      onConfirm: () => {
        const activeBizId = getActiveBusinessId();
        runSql(
          `DELETE FROM equity WHERE id = '${sqlEsc(eq.id)}' AND business_id = '${sqlEsc(activeBizId)}'`,
          'Delete Equity Record'
        );
        if (eq.linkedAssetId) {
          runSql(
            `UPDATE assets SET linked_equity_id = '' WHERE id = '${sqlEsc(eq.linkedAssetId)}' AND business_id = '${sqlEsc(activeBizId)}'`,
            'Unlink Asset Equity Reference'
          );
        }
        syncAllAccountingSystems(`Equity Deleted #${eq.id}`);
        persistTablesToStorage();
        loadFinanceData();
        try {
          window.dispatchEvent(new Event('pos_data_updated'));
        } catch {}
        notifyFinance('success', `Equity entry "${eq.name}" deleted.`);
      },
    });
  };

  // --- PERIOD & MULTI-BRANCH FINANCIAL STATEMENT ENGINE ---
  const periodMeta = useMemo(() => {
    const now = new Date();
    const startOfMonth = (y: number, m: number) => new Date(y, m, 1, 0, 0, 0, 0).getTime();
    const endOfMonth = (y: number, m: number) => new Date(y, m + 1, 0, 23, 59, 59, 999).getTime();

    if (selectedPeriod === 'this_month') {
      return {
        startMs: startOfMonth(now.getFullYear(), now.getMonth()),
        endMs: endOfMonth(now.getFullYear(), now.getMonth()),
        label: now.toLocaleString('default', { month: 'long', year: 'numeric' }),
      };
    }
    if (selectedPeriod === 'last_month') {
      const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return {
        startMs: startOfMonth(lm.getFullYear(), lm.getMonth()),
        endMs: endOfMonth(lm.getFullYear(), lm.getMonth()),
        label: lm.toLocaleString('default', { month: 'long', year: 'numeric' }),
      };
    }
    if (selectedPeriod === 'this_quarter') {
      const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
      const qNum = Math.floor(now.getMonth() / 3) + 1;
      return {
        startMs: startOfMonth(now.getFullYear(), qStartMonth),
        endMs: endOfMonth(now.getFullYear(), qStartMonth + 2),
        label: `Q${qNum} ${now.getFullYear()}`,
      };
    }
    if (selectedPeriod === 'this_year') {
      return {
        startMs: startOfMonth(now.getFullYear(), 0),
        endMs: endOfMonth(now.getFullYear(), 11),
        label: `FY ${now.getFullYear()}`,
      };
    }
    if (selectedPeriod === 'custom') {
      const sMs = customDateFrom ? new Date(`${customDateFrom}T00:00:00`).getTime() : null;
      const eMs = customDateTo ? new Date(`${customDateTo}T23:59:59.999`).getTime() : null;
      return {
        startMs: Number.isFinite(sMs as number) ? sMs : null,
        endMs: Number.isFinite(eMs as number) ? eMs : null,
        label: `${customDateFrom || '...'} to ${customDateTo || '...'}`,
      };
    }
    return { startMs: null as number | null, endMs: null as number | null, label: 'All-Time Cumulative' };
  }, [selectedPeriod, customDateFrom, customDateTo]);

  const productCostLookup = useMemo(() => {
    const map = new Map<number, any>();
    statementProducts.forEach((p) => map.set(Number(p.id), p));
    return map;
  }, [statementProducts]);

  const orderItemsByOrderLookup = useMemo(() => {
    const map = new Map<string, any[]>();
    statementItems.forEach((it) => {
      const k = String(it.orderId);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(it);
    });
    return map;
  }, [statementItems]);

  const calculateFinancialsForScope = (targetScope: string[] | 'all'): FinancialSummary => {
    if (Array.isArray(targetScope) && targetScope.length === 0) {
      return { ...EMPTY_FINANCIALS };
    }

    const activeBizId = getActiveBusinessId();
    const defaultFallbackStore = getActiveStoreId(undefined, activeBizId).toLowerCase().trim();
    const targetSet =
      targetScope === 'all' ? null : new Set(targetScope.map((s) => s.toLowerCase().trim()));
    const matchScope = (rowStore: any) =>
      targetSet === null || targetSet.has(String(rowStore || defaultFallbackStore).toLowerCase().trim());

    // 1. Point-in-time Balance Sheet & All-Time ledger rows from financial_statements_ledger
    let matchingStmtRows: any[] = [];
    if (targetSet === null) {
      const allRow = allStatementRows.find((r) => String(r.store_id || '').toLowerCase().trim() === 'all');
      matchingStmtRows = allRow
        ? [allRow]
        : allStatementRows.filter((r) => String(r.store_id || '').toLowerCase().trim() !== 'all');
    } else {
      matchingStmtRows = allStatementRows.filter((r) => {
        const st = String(r.store_id || '').toLowerCase().trim();
        return st !== 'all' && targetSet.has(st);
      });
    }

    const sumRowField = (field: string) =>
      matchingStmtRows.reduce((s, r) => s + Number(r[field] || 0), 0);

    const balanceSheetPart = {
      cashAndEquivalents: sumRowField('cash_and_equivalents'),
      cashDrawerBalance: sumRowField('cash_drawer_balance'),
      mobileMoneyBalance: sumRowField('mobile_money_balance'),
      bankCardBalance: sumRowField('bank_card_balance'),
      inventoryAssetValue: sumRowField('inventory_asset_value'),
      goodsInTransitValue: sumRowField('goods_in_transit_value'),
      fixedAssetsValue: sumRowField('fixed_assets_value'),
      totalAssetVal: sumRowField('total_assets'),
      vatPayableLiability: sumRowField('vat_payable_liability'),
      laybyDepositsLiability: sumRowField('layby_deposits_liability'),
      loansPayableLiability: sumRowField('loans_payable_liability'),
      totalLiabilitiesVal: sumRowField('total_liabilities'),
      ownerCapitalEquity: sumRowField('owner_capital_equity'),
      retainedEarnings: sumRowField('retained_earnings'),
      totalEquityVal: sumRowField('total_equity'),
    };

    const isInPeriod = (rawDate: any) => {
      if (periodMeta.startMs === null && periodMeta.endMs === null) return true;
      const ms = Date.parse(String(rawDate || ''));
      if (!Number.isFinite(ms)) return false;
      if (periodMeta.startMs !== null && ms < periodMeta.startMs) return false;
      if (periodMeta.endMs !== null && ms > periodMeta.endMs) return false;
      return true;
    };

    const computeExpenseBreakdown = (expectedOpExTotal: number, filterByPeriod: boolean) => {
      let rentRaw = 0;
      let utilRaw = 0;
      allExpensesRaw.forEach((ex) => {
        if (!matchScope(ex.store_id)) return;
        if (filterByPeriod && !isInPeriod(ex.expense_date || ex.created_at)) return;
        const amt = Number(ex.amount || 0);
        const cat = String(ex.category || '').toLowerCase();
        if (cat.includes('rent') || cat.includes('premises')) {
          rentRaw += amt;
        } else if (
          cat.includes('utilit') ||
          cat.includes('electric') ||
          cat.includes('water') ||
          cat.includes('internet') ||
          cat.includes('telecom')
        ) {
          utilRaw += amt;
        }
      });
      const rentExpense = Math.min(expectedOpExTotal, rentRaw);
      const utilitiesExpense = Math.min(Math.max(0, expectedOpExTotal - rentExpense), utilRaw);
      const generalOperatingExpense = Math.max(0, expectedOpExTotal - rentExpense - utilitiesExpense);
      return { rentExpense, utilitiesExpense, generalOperatingExpense };
    };

    // 2. If All-Time and snapshot rows exist, use exact synchronized ledger numbers
    if (selectedPeriod === 'all_time' && matchingStmtRows.length > 0) {
      const opEx = sumRowField('operating_expenses');
      const payroll = sumRowField('payroll_expenses');
      const opCash = sumRowField('operating_cash_flow');
      const invCash = sumRowField('investing_cash_flow');
      const finCash = sumRowField('financing_cash_flow');
      const netCash = sumRowField('net_cash_flow');
      const closingCashBalance = balanceSheetPart.cashAndEquivalents;
      const beginningCashBalance = closingCashBalance - netCash;
      const expBreakdown = computeExpenseBreakdown(opEx, false);

      return {
        grossSales: sumRowField('gross_sales_revenue'),
        salesRefunds: sumRowField('sales_returns_refunds'),
        discountsAllowed: sumRowField('discounts_allowed'),
        vatCollected: sumRowField('vat_tax_collected'),
        totalRevenue: sumRowField('net_sales_revenue'),
        totalCogs: sumRowField('cost_of_goods_sold'),
        grossProfit: sumRowField('gross_profit'),
        ...expBreakdown,
        totalOperatingExpenses: opEx,
        totalPayroll: payroll,
        totalExpenses: opEx + payroll,
        netProfit: sumRowField('net_operating_income'),
        ...balanceSheetPart,
        operatingCashFlow: opCash,
        investingCashFlow: invCash,
        financingCashFlow: finCash,
        netCashFlow: netCash,
        beginningCashBalance,
        closingCashBalance,
      };
    }

    // 3. Period-filtered P&L & Cash Flow (This Month / Last Month / Quarter / Year / Custom Date Range)
    let grossSales = 0;
    let salesRefunds = 0;
    let discountsAllowed = 0;
    let vatCollected = 0;
    let totalCogs = 0;

    statementOrders.forEach((o) => {
      if (!matchScope(o.store_id)) return;
      if (!isInPeriod(o.orderDate || o.created_at)) return;
      const sLower = String(o.status || 'Completed').toLowerCase().trim();
      const isRef = sLower === 'refunded';
      const tot = Number(o.total || o.total_amount || 0);
      const disc = Number(o.discount || 0);
      const tx = Number(o.tax || 0);

      grossSales += tot + disc;
      discountsAllowed += disc;
      if (isRef) {
        salesRefunds += tot;
      } else {
        vatCollected += tx;
        const oItems = orderItemsByOrderLookup.get(String(o.id)) || [];
        oItems.forEach((it) => {
          const prod = productCostLookup.get(Number(it.productId));
          const uCost = prod ? Number(prod.cost || Number(it.unitPrice || 0) * 0.7) : Number(it.unitPrice || 0) * 0.7;
          totalCogs += uCost * Number(it.quantity || 1);
        });
      }
    });

    const totalRevenue = Math.max(0, grossSales - discountsAllowed - salesRefunds - vatCollected);
    const grossProfit = totalRevenue - totalCogs;
    const totalOperatingExpenses = allExpensesRaw
      .filter((ex) => matchScope(ex.store_id) && isInPeriod(ex.expense_date || ex.created_at))
      .reduce((s, ex) => s + Number(ex.amount || 0), 0);
    const expBreakdown = computeExpenseBreakdown(totalOperatingExpenses, true);
    const attendancePayroll = statementAttendance
      .filter(() => matchScope(defaultFallbackStore))
      .filter((a) => isInPeriod(a.date || a.created_at))
      .reduce((s, a) => s + Number(a.gross_payment || 0), 0);
    const salaryPayroll = statementPayrollEntries
      .filter((p) => matchScope(p.store_id))
      .filter((p) => isInPeriod(p.payment_date || p.updated_at || p.created_at))
      .reduce((s, p) => s + Math.max(0, Number(p.net_salary || 0)), 0);
    const totalPayroll = attendancePayroll + salaryPayroll;
    const totalExpenses = totalOperatingExpenses + totalPayroll;
    const netProfit = grossProfit - totalExpenses;

    const scopedCf = allCashFlowRows.filter(
      (cf) => matchScope(cf.store_id) && isInPeriod(cf.date || cf.created_at)
    );
    const operatingCashFlow = scopedCf
      .filter((cf) => cf.activity_type === 'OPERATING')
      .reduce((s, cf) => s + Number(cf.net_cash_change || 0), 0);
    const investingCashFlow = scopedCf
      .filter((cf) => cf.activity_type === 'INVESTING')
      .reduce((s, cf) => s + Number(cf.net_cash_change || 0), 0);
    const financingCashFlow = scopedCf
      .filter((cf) => cf.activity_type === 'FINANCING')
      .reduce((s, cf) => s + Number(cf.net_cash_change || 0), 0);
    const netCashFlow = operatingCashFlow + investingCashFlow + financingCashFlow;
    const closingCashBalance = balanceSheetPart.cashAndEquivalents;
    const beginningCashBalance = closingCashBalance - netCashFlow;

    return {
      grossSales,
      salesRefunds,
      discountsAllowed,
      vatCollected,
      totalRevenue,
      totalCogs,
      grossProfit,
      ...expBreakdown,
      totalOperatingExpenses,
      totalPayroll,
      totalExpenses,
      netProfit,
      ...balanceSheetPart,
      operatingCashFlow,
      investingCashFlow,
      financingCashFlow,
      netCashFlow,
      beginningCashBalance,
      closingCashBalance,
    };
  };

  const financials = calculateFinancialsForScope(activeScopeBranches);

  // Export Financial Statements PDF (Formal 3-Page Financial Report Format)
  const handleExportPDF = () => {
    try {
      const doc = new jsPDF();
      const storeName = (settings.storeName || 'POS MERCHANT').toUpperCase();
      const curr = settings.currency || 'K';
      const fmt = (n: number) =>
        `${n < 0 ? '-' : ''}${curr}${Math.abs(n).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;

      let y = 0;
      const writeRow = (label: string, val: string, isBold = false) => {
        doc.setFont('helvetica', isBold ? 'bold' : 'normal');
        doc.setFontSize(9.5);
        doc.setTextColor(30, 41, 59);
        doc.text(label, 20, y);
        doc.text(val, 190, y, { align: 'right' });
        y += 6.5;
      };

      // ================= PAGE 1: PROFIT & LOSS (INCOME STATEMENT) =================
      doc.setFillColor(30, 41, 59);
      doc.rect(0, 0, 210, 42, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(17);
      doc.text(`${storeName} - FINANCIAL REPORT`, 15, 16);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text('FINANCIAL STATEMENTS (P&L, BALANCE SHEET & CASH FLOW)', 15, 23);
      doc.text(
        `REPORT PERIOD: ${periodMeta.label.toUpperCase()}  |  SCOPE: ${activeScopeLabel.toUpperCase()}`,
        15,
        30
      );
      doc.text(`GENERATED STAMP: ${new Date().toLocaleString()}`, 15, 36);

      y = 54;
      doc.setTextColor(30, 41, 59);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.text('I. PROFIT & LOSS ACCOUNT (INCOME STATEMENT)', 15, y);
      doc.setDrawColor(203, 213, 225);
      doc.line(15, y + 2, 195, y + 2);
      y += 10;

      writeRow('Gross POS Sales Revenue', fmt(financials.grossSales), true);
      writeRow('Less: Sales Returns & Refunds', `(${fmt(financials.salesRefunds)})`);
      writeRow('Less: Discounts Allowed', `(${fmt(financials.discountsAllowed)})`);
      writeRow('Less: Output VAT Collected', `(${fmt(financials.vatCollected)})`);
      writeRow('Net Sales Revenue', fmt(financials.totalRevenue), true);
      writeRow('Less: Cost of Goods Sold (COGS)', `(${fmt(financials.totalCogs)})`);

      doc.setDrawColor(148, 163, 184);
      doc.line(15, y - 2, 195, y - 2);
      y += 2;
      writeRow('GROSS TRADING PROFIT', fmt(financials.grossProfit), true);
      y += 4;

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(71, 85, 105);
      doc.text('OPERATING EXPENSES & OVERHEADS:', 20, y);
      y += 6.5;

      writeRow('Staff Payroll & Salaries Paid', `(${fmt(financials.totalPayroll)})`);
      writeRow('Rent & Premises Allocations', `(${fmt(financials.rentExpense)})`);
      writeRow('Electricity, Water & Utilities', `(${fmt(financials.utilitiesExpense)})`);
      writeRow('General Operating & Administrative Expenses', `(${fmt(financials.generalOperatingExpense)})`);
      writeRow('Total Operating Expenses & Payroll', `(${fmt(financials.totalExpenses)})`, true);

      doc.setFillColor(241, 245, 249);
      doc.rect(15, y - 1, 180, 11, 'F');
      y += 6.5;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      doc.text('NET OPERATING PROFIT / (LOSS)', 20, y);
      doc.text(fmt(financials.netProfit), 190, y, { align: 'right' });

      // ================= PAGE 2: STATEMENT OF FINANCIAL POSITION (BALANCE SHEET) =================
      doc.addPage();
      doc.setFillColor(30, 41, 59);
      doc.rect(0, 0, 210, 30, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(15);
      doc.text('STATEMENT OF FINANCIAL POSITION (BALANCE SHEET)', 15, 18);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.text(`${storeName}  |  AS OF: ${new Date().toLocaleDateString()}  |  SCOPE: ${activeScopeLabel.toUpperCase()}`, 15, 24);

      y = 42;
      doc.setTextColor(30, 41, 59);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('II. BALANCE SHEET — ASSETS', 15, y);
      doc.setDrawColor(203, 213, 225);
      doc.line(15, y + 2, 195, y + 2);
      y += 9;

      writeRow('Cash in Counter Drawer', fmt(financials.cashDrawerBalance));
      writeRow('Mobile Money Wallets', fmt(financials.mobileMoneyBalance));
      writeRow('Commercial Bank & Card Settlement', fmt(financials.bankCardBalance));
      writeRow('Inventory Stock Asset Valuation (At Cost)', fmt(financials.inventoryAssetValue));
      writeRow('Goods in Transit Asset', fmt(financials.goodsInTransitValue));
      writeRow('Fixed Equipment & Property Assets (Net Book Value)', fmt(financials.fixedAssetsValue));
      doc.line(15, y - 2, 195, y - 2);
      y += 2;
      writeRow('TOTAL ASSETS', fmt(financials.totalAssetVal), true);

      y += 10;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('LIABILITIES & OWNER EQUITY', 15, y);
      doc.line(15, y + 2, 195, y + 2);
      y += 9;

      writeRow('VAT / Tax Output Payable', fmt(financials.vatPayableLiability));
      writeRow('Customer Layby Unearned Deposits', fmt(financials.laybyDepositsLiability));
      writeRow('Working Capital Loans Payable', fmt(financials.loansPayableLiability));
      writeRow('Total Liabilities', fmt(financials.totalLiabilitiesVal), true);
      y += 2;

      writeRow('Owner / Contributed Capital Equity', fmt(financials.ownerCapitalEquity));
      writeRow('Retained Earnings & Reserves', fmt(financials.retainedEarnings));
      writeRow('Total Owner Equity', fmt(financials.totalEquityVal), true);

      doc.setFillColor(241, 245, 249);
      doc.rect(15, y - 1, 180, 11, 'F');
      y += 6.5;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(15, 23, 42);
      doc.text('TOTAL LIABILITIES & EQUITY FUND BALANCE', 20, y);
      doc.text(fmt(financials.totalLiabilitiesVal + financials.totalEquityVal), 190, y, { align: 'right' });

      // ================= PAGE 3: CASH FLOW STATEMENT & SIGNATURES =================
      doc.addPage();
      doc.setFillColor(30, 41, 59);
      doc.rect(0, 0, 210, 30, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(15);
      doc.text('AUDITED CASH FLOW RECONCILIATION STATEMENT', 15, 18);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.text(`${storeName}  |  PERIOD: ${periodMeta.label.toUpperCase()}  |  SCOPE: ${activeScopeLabel.toUpperCase()}`, 15, 24);

      y = 42;
      doc.setTextColor(30, 41, 59);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('III. CASH FLOW STATEMENT (DIRECT METHOD)', 15, y);
      doc.setDrawColor(203, 213, 225);
      doc.line(15, y + 2, 195, y + 2);
      y += 10;

      writeRow('Net Cash Flow from Operating Activities', fmt(financials.operatingCashFlow));
      writeRow('Net Cash Flow from Investing Activities', fmt(financials.investingCashFlow));
      writeRow('Net Cash Flow from Financing Activities', fmt(financials.financingCashFlow));

      doc.setDrawColor(30, 41, 59);
      doc.setLineWidth(0.5);
      doc.line(15, y - 2, 195, y - 2);
      doc.setLineWidth(0.2);
      y += 3;

      writeRow('NET CHANGE IN CASH RESERVES', fmt(financials.netCashFlow), true);
      writeRow('Cash Balance at Beginning of Period', fmt(financials.beginningCashBalance));

      doc.setFillColor(236, 253, 245);
      doc.rect(15, y - 1, 180, 12, 'F');
      y += 7.5;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(6, 78, 59);
      doc.text('CLOSING CASH & EQUIVALENTS BALANCE', 20, y);
      doc.text(fmt(financials.closingCashBalance), 190, y, { align: 'right' });

      y += 28;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(100, 116, 139);
      doc.text('Prepared By / Store Accountant: ___________________________', 15, y);
      doc.text('Date: ______________', 145, y);
      y += 14;
      doc.text('Managing Director / Store Representative: ___________________', 15, y);
      doc.text('Date: ______________', 145, y);

      exportAndSharePdf(`Financial_Statements_${new Date().toISOString().split('T')[0]}.pdf`, doc);
      notifyFinance('success', 'Financial Statements PDF exported.');
    } catch (e) {
      notifyFinance('error', 'Error exporting PDF statement: ' + String(e));
    }
  };

  // Filtered Asset & Equity Lists for Registry Tab
  const filteredAssets = useMemo(() => {
    const q = registrySearch.trim().toLowerCase();
    return assets.filter((ast) => {
      if (registryBranchFilter !== 'all' && ast.storeId.toLowerCase().trim() !== registryBranchFilter.toLowerCase().trim()) {
        return false;
      }
      if (registryStatusFilter !== 'ALL' && ast.status !== registryStatusFilter) {
        return false;
      }
      if (q) {
        const hay = `${ast.assetTag} ${ast.id} ${ast.name} ${ast.type} ${ast.serialNumber} ${ast.notes || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [assets, registrySearch, registryBranchFilter, registryStatusFilter]);

  const filteredEquity = useMemo(() => {
    const q = registrySearch.trim().toLowerCase();
    return equity.filter((eq) => {
      if (registryBranchFilter !== 'all' && eq.storeId.toLowerCase().trim() !== registryBranchFilter.toLowerCase().trim()) {
        return false;
      }
      if (q) {
        const hay = `${eq.id} ${eq.name} ${eq.equityType} ${eq.shareholderName} ${eq.referenceNo} ${eq.notes}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [equity, registrySearch, registryBranchFilter]);

  const registryMetrics = useMemo(() => {
    let grossCostActive = 0;
    let accumDepActive = 0;
    let totalNbvActive = 0;
    filteredAssets.forEach((ast) => {
      if (ast.status === 'Active') {
        const val = calculateAssetValuation(ast);
        grossCostActive += val.cost;
        accumDepActive += val.accumulatedDepreciation;
        totalNbvActive += val.netBookValue;
      }
    });

    let contributedCapital = 0;
    let drawingsTotal = 0;
    filteredEquity.forEach((eq) => {
      if (eq.status === 'Reversed') return;
      const t = eq.equityType.toLowerCase();
      if (t.includes('drawing') || t.includes('dividend')) {
        drawingsTotal += Number(eq.value || 0);
      } else {
        contributedCapital += Number(eq.value || 0);
      }
    });

    return {
      grossCostActive,
      accumDepActive,
      totalNbvActive,
      contributedCapital,
      drawingsTotal,
      netContributedEquity: contributedCapital - drawingsTotal,
    };
  }, [filteredAssets, filteredEquity]);

  const handleExportRegistryPDF = () => {
    try {
      const doc = new jsPDF();
      let y = 18;
      const ensureSpace = (needed = 12) => {
        if (y + needed > 278) {
          doc.addPage();
          y = 18;
        }
      };

      doc.setFontSize(15);
      doc.text(`${settings.storeName || 'POS Merchant'} — Assets & Capital Equity Registry`, 14, y);
      y += 7;
      doc.setFontSize(9);
      doc.text(
        `Generated: ${new Date().toLocaleString()} | Branch Filter: ${registryBranchFilter === 'all' ? 'All Branches' : getBranchLabel(registryBranchFilter)}`,
        14,
        y
      );
      y += 9;

      doc.setFontSize(11);
      doc.text(`I. FIXED & CURRENT ASSETS (${filteredAssets.length})`, 14, y);
      y += 6;
      doc.setFontSize(8.5);
      filteredAssets.forEach((ast) => {
        ensureSpace(10);
        const val = calculateAssetValuation(ast);
        doc.text(
          `${ast.assetTag} | ${ast.name} (${ast.type} - ${getBranchLabel(ast.storeId)}) | Cost: ${settings.currency}${val.cost.toFixed(2)} | NBV: ${settings.currency}${val.netBookValue.toFixed(2)} | ${ast.status}`,
          14,
          y
        );
        y += 5;
      });

      y += 5;
      ensureSpace(20);
      doc.setFontSize(11);
      doc.text(`II. CAPITAL EQUITY & DRAWINGS (${filteredEquity.length})`, 14, y);
      y += 6;
      doc.setFontSize(8.5);
      filteredEquity.forEach((eq) => {
        ensureSpace(10);
        const isDraw = eq.equityType.toLowerCase().includes('drawing') || eq.equityType.toLowerCase().includes('dividend');
        doc.text(
          `${eq.id} | ${eq.name} (${eq.equityType}) | ${eq.shareholderName || 'Owner'} | ${eq.contributionDate} | ${isDraw ? '-' : '+'}${settings.currency}${eq.value.toFixed(2)} | ${eq.status}`,
          14,
          y
        );
        y += 5;
      });

      exportAndSharePdf(`Asset_Equity_Registry_${new Date().toISOString().split('T')[0]}.pdf`, doc);
      notifyFinance('success', 'Asset & Equity Registry PDF exported.');
    } catch (e) {
      notifyFinance('error', 'Failed to export Asset & Equity PDF: ' + String(e));
    }
  };

  // Preview valuation inside Asset Form
  const liveFormValuation = useMemo(() => {
    const cost = Math.max(0, parseFloat(newAssetValue) || 0);
    const salvage = Math.max(0, Math.min(cost, parseFloat(newAssetSalvage) || 0));
    const life = Math.max(1, parseInt(newAssetUsefulLife, 10) || 5);
    const rate = newAssetDepreciationMethod === 'None' ? 0 : Math.max(0, parseFloat(newAssetDepreciationRate) || 0);
    return calculateAssetValuation({
      value: cost,
      salvage_value: salvage,
      useful_life_years: life,
      category: newAssetCategory,
      depreciation_method: newAssetDepreciationMethod,
      depreciation_rate: rate,
      purchase_date: newAssetPurchaseDate,
      status: newAssetStatus,
    });
  }, [
    newAssetValue,
    newAssetSalvage,
    newAssetUsefulLife,
    newAssetCategory,
    newAssetDepreciationMethod,
    newAssetDepreciationRate,
    newAssetPurchaseDate,
    newAssetStatus,
  ]);

  return (
    <div className="flex-1 flex overflow-hidden flex-col bg-slate-50 text-slate-800 p-3 md:p-6 select-text min-w-0 w-full">
      {/* IN-UI FEEDBACK BANNER */}
      {financeFeedback && (
        <div
          className={`mb-3 px-4 py-2.5 rounded-xl border text-xs font-bold flex items-center justify-between gap-2 shrink-0 ${
            financeFeedback.type === 'error'
              ? 'bg-rose-50 border-rose-200 text-rose-800'
              : 'bg-emerald-50 border-emerald-200 text-emerald-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {financeFeedback.type === 'error' ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
            <span>{financeFeedback.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setFinanceFeedback(null)}
            className="text-[10px] font-black uppercase px-2 py-0.5 rounded hover:bg-black/5 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* IN-UI CONFIRMATION MODAL */}
      {confirmAction && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-5 space-y-4">
            <div className="flex items-start gap-3">
              <div
                className={`p-2.5 rounded-xl shrink-0 ${
                  confirmAction.tone === 'danger' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'
                }`}
              >
                <ShieldAlert size={20} />
              </div>
              <div>
                <h3 className="text-sm font-black text-slate-900 uppercase tracking-wide">{confirmAction.title}</h3>
                <p className="text-xs text-slate-600 mt-1">{confirmAction.message}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const fn = confirmAction.onConfirm;
                  setConfirmAction(null);
                  fn();
                }}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase text-white cursor-pointer ${
                  confirmAction.tone === 'danger'
                    ? 'bg-rose-600 hover:bg-rose-700'
                    : 'bg-amber-600 hover:bg-amber-700'
                }`}
              >
                {confirmAction.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ASSET DISPOSAL MODAL */}
      {disposingAsset && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmDisposeAsset}
            className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-5 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-sm font-black text-slate-900 uppercase">
                Dispose Asset: {disposingAsset.assetTag}
              </h3>
              <button
                type="button"
                onClick={() => setDisposingAsset(null)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-xs text-slate-600">
              Recording disposal for <span className="font-bold text-slate-900">{disposingAsset.name}</span>.
              Proceeds will post to Commercial Bank (`acc_bank`) and Investing Cash Flow.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Disposal Date</label>
                <input
                  type="date"
                  value={disposeModalDate}
                  onChange={(e) => setDisposeModalDate(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold"
                  required
                />
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                  Sale Proceeds ({settings.currency})
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={disposeModalProceeds}
                  onChange={(e) => setDisposeModalProceeds(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold"
                  required
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setDisposingAsset(null)}
                className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-black uppercase cursor-pointer"
              >
                Confirm Disposal
              </button>
            </div>
          </form>
        </div>
      )}

      {/* SUB-TAB SELECTOR (Horizontally wrapped for mobile & desktop) */}
      <div className="flex flex-wrap border-b border-slate-200 mb-4 gap-1.5 select-none pb-2 shrink-0">
        <button
          onClick={() => setSubTab('statements')}
          className={`px-3 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
            subTab === 'statements'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
          }`}
        >
          <FileText size={14} />
          <span>Financial Statements</span>
        </button>

        <button
          onClick={() => setSubTab('payment_methods')}
          className={`px-3 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
            subTab === 'payment_methods'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Wallet size={14} />
          <span>Cash by Payment Method & EOD</span>
        </button>

        <button
          onClick={() => setSubTab('receipt_refund')}
          className={`px-3 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
            subTab === 'receipt_refund'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Receipt size={14} />
          <span>Receipt & Refund Ledger</span>
        </button>

        <button
          onClick={() => setSubTab('cash_flow')}
          className={`px-3 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
            subTab === 'cash_flow'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
          }`}
        >
          <TrendingUp size={14} />
          <span>Cash Flow Ledger</span>
        </button>

        <button
          onClick={() => setSubTab('double_entry')}
          className={`px-3 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
            subTab === 'double_entry'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
          }`}
        >
          <ArrowLeftRight size={14} />
          <span>Double-Entry Journal</span>
        </button>

        <button
          onClick={() => setSubTab('expenses')}
          className={`px-3 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
            subTab === 'expenses'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
          }`}
        >
          <DollarSign size={14} />
          <span>Expenses</span>
        </button>

        <button
          onClick={() => setSubTab('transfers')}
          className={`px-3 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
            subTab === 'transfers'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
          }`}
        >
          <RefreshCw size={14} />
          <span>Transfers</span>
        </button>

        <button
          onClick={() => setSubTab('assets_equity')}
          className={`px-3 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
            subTab === 'assets_equity'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Layers size={14} />
          <span>Assets & Equity</span>
        </button>
      </div>

      <AnimatePresence mode="wait">
        {/* FINANCIAL STATEMENTS: P&L, BALANCE SHEET & CASH FLOW TAB */}
        {subTab === 'statements' && (
          <motion.div
            key="statements-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-5 pr-1"
          >
            {/* Header & Branch Selection Controls */}
            <div className="bg-white p-4 md:p-5 rounded-2xl border border-slate-200 shadow-xs space-y-4">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                  <h2 className="text-base md:text-lg font-black tracking-tight text-slate-900 uppercase flex items-center gap-2">
                    <FileText className="text-indigo-600" size={20} />
                    <span>Financial Statements (P&L, Balance Sheet & Cash Flow)</span>
                  </h2>
                  <p className="text-xs text-slate-500 font-medium">
                    Scope: <span className="font-bold text-indigo-700">{activeScopeLabel}</span> • Period:{' '}
                    <span className="font-bold text-slate-700">{periodMeta.label}</span>
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* Period Filter */}
                  <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-1.5">
                    <Calendar size={14} className="text-slate-500" />
                    <select
                      value={selectedPeriod}
                      onChange={(e) => setSelectedPeriod(e.target.value as PeriodOption)}
                      className="bg-transparent text-xs font-bold text-slate-800 focus:outline-hidden cursor-pointer"
                    >
                      <option value="all_time">All-Time Cumulative</option>
                      <option value="this_month">This Month</option>
                      <option value="last_month">Last Month</option>
                      <option value="this_quarter">This Quarter</option>
                      <option value="this_year">This Year</option>
                      <option value="custom">Custom Date Range</option>
                    </select>
                  </div>

                  <button
                    onClick={handleExportPDF}
                    className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-extrabold uppercase tracking-wider flex items-center gap-1.5 transition-all shadow-xs cursor-pointer"
                  >
                    <Download size={14} />
                    <span>Export Statements PDF</span>
                  </button>
                </div>
              </div>

              {/* Custom Date Range Inputs */}
              {selectedPeriod === 'custom' && (
                <div className="flex flex-wrap items-center gap-3 bg-indigo-50/60 border border-indigo-200 rounded-xl p-3 text-xs">
                  <span className="font-black uppercase text-indigo-900 text-[10px]">Reporting Date Range:</span>
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-slate-600">From</span>
                    <input
                      type="date"
                      value={customDateFrom}
                      onChange={(e) => setCustomDateFrom(e.target.value)}
                      className="bg-white border border-slate-300 rounded-lg px-2.5 py-1 text-xs font-bold"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-slate-600">To</span>
                    <input
                      type="date"
                      value={customDateTo}
                      onChange={(e) => setCustomDateTo(e.target.value)}
                      className="bg-white border border-slate-300 rounded-lg px-2.5 py-1 text-xs font-bold"
                    />
                  </div>
                </div>
              )}

              {/* Branch Selection Mode Bar */}
              <div className="flex flex-col gap-3 pt-3 border-t border-slate-100">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider mr-1 flex items-center gap-1">
                      <Building2 size={12} /> Branches:
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setStatementBranchMode('all');
                        setStatementStoreFilter('all');
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-extrabold transition-all cursor-pointer ${
                        statementBranchMode === 'all'
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      All Branches Consolidated
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setStatementBranchMode('single');
                        if (!statementStoreFilter || statementStoreFilter === 'all') {
                          setStatementStoreFilter(activeStore || storesList[0]?.id || 'all');
                        }
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-extrabold transition-all cursor-pointer ${
                        statementBranchMode === 'single'
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      Single Branch
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setStatementBranchMode('custom');
                        if (selectedStatementBranches.length === 0) {
                          setSelectedStatementBranches(storesList.map((s) => s.id));
                        }
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-extrabold transition-all cursor-pointer ${
                        statementBranchMode === 'custom'
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      Select Specific Branches ({selectedStatementBranches.length}/{storesList.length || 1})
                    </button>
                  </div>

                  {statementBranchMode === 'single' && (
                    <select
                      value={statementStoreFilter}
                      onChange={(e) => setStatementStoreFilter(e.target.value)}
                      className="bg-slate-50 border border-slate-300 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-800 focus:outline-hidden"
                    >
                      {storesList.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {statementBranchMode === 'custom' && (
                  <div className="flex flex-wrap items-center gap-2 bg-slate-50 p-3 rounded-xl border border-slate-200">
                    {storesList.map((s) => {
                      const isChecked = selectedStatementBranches.some(
                        (id) => id.toLowerCase().trim() === s.id.toLowerCase().trim()
                      );
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => {
                            setSelectedStatementBranches((prev) =>
                              isChecked
                                ? prev.filter((id) => id.toLowerCase().trim() !== s.id.toLowerCase().trim())
                                : [...prev, s.id]
                            );
                          }}
                          className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border flex items-center gap-1.5 transition-all cursor-pointer ${
                            isChecked
                              ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                          }`}
                        >
                          <span
                            className={`w-3.5 h-3.5 rounded flex items-center justify-center border ${
                              isChecked ? 'bg-white text-indigo-600 border-white' : 'border-slate-300'
                            }`}
                          >
                            {isChecked && <Check size={10} strokeWidth={3} />}
                          </span>
                          <span>{s.name}</span>
                        </button>
                      );
                    })}
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedStatementBranches(storesList.map((s) => s.id))}
                        className="text-[11px] font-black text-indigo-600 hover:underline cursor-pointer"
                      >
                        Select All
                      </button>
                      <span className="text-slate-300">|</span>
                      <button
                        type="button"
                        onClick={() => setSelectedStatementBranches([])}
                        className="text-[11px] font-black text-slate-500 hover:underline cursor-pointer"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Overview Metric Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">Net Sales Revenue</span>
                  <span className="text-xl font-black text-slate-900 block mt-0.5">
                    {settings.currency}{financials.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-slate-500 font-semibold">Gross: {settings.currency}{financials.grossSales.toFixed(2)} | Refunds: -{settings.currency}{financials.salesRefunds.toFixed(2)}</span>
                </div>
                <div className="p-3 bg-emerald-50 text-emerald-600 rounded-xl">
                  <TrendingUp size={22} />
                </div>
              </div>

              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">Gross Profit (Net of COGS)</span>
                  <span className="text-xl font-black text-emerald-700 block mt-0.5">
                    {settings.currency}{financials.grossProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-slate-500 font-semibold">COGS: -{settings.currency}{financials.totalCogs.toFixed(2)}</span>
                </div>
                <div className="p-3 bg-emerald-100 text-emerald-700 rounded-xl">
                  <DollarSign size={22} />
                </div>
              </div>

              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">Total Assets (Balance Sheet)</span>
                  <span className="text-xl font-black text-indigo-700 block mt-0.5">
                    {settings.currency}{financials.totalAssetVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-slate-500 font-semibold">Cash+Liquid: {settings.currency}{financials.cashAndEquivalents.toFixed(2)}</span>
                </div>
                <div className="p-3 bg-indigo-50 text-indigo-600 rounded-xl">
                  <Layers size={22} />
                </div>
              </div>

              <div className={`p-4 rounded-2xl border shadow-xs flex items-center justify-between ${
                financials.netProfit >= 0 ? 'bg-emerald-950 text-white border-emerald-800' : 'bg-rose-950 text-white border-rose-800'
              }`}>
                <div>
                  <span className="text-[10px] font-extrabold text-emerald-300 uppercase tracking-wider block">Net Operating Profit</span>
                  <span className="text-2xl font-black block mt-0.5">
                    {settings.currency}{financials.netProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-emerald-200 font-semibold">Net Cash Flow: {settings.currency}{financials.netCashFlow.toFixed(2)}</span>
                </div>
                <div className="p-3 bg-emerald-800/60 text-emerald-200 rounded-xl">
                  <Wallet size={22} />
                </div>
              </div>
            </div>

            {/* 2-Column Grid: P&L Statement + Balance Sheet Statement */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* 1. PROFIT & LOSS (P&L) STATEMENT */}
              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest">
                    1. PROFIT & LOSS (INCOME STATEMENT)
                  </h3>
                  <span className="text-[10px] font-bold px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-md border border-emerald-200">
                    LIVE DOUBLE-ENTRY
                  </span>
                </div>

                <div className="space-y-2 font-mono text-xs">
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="font-sans font-bold text-slate-700">Gross POS Sales Revenue</span>
                    <span className="font-extrabold text-slate-900">+{settings.currency}{financials.grossSales.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100 text-rose-600 pl-3">
                    <span className="font-sans font-medium">(-) Sales Returns & Refunds Ledger</span>
                    <span className="font-extrabold">-{settings.currency}{financials.salesRefunds.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100 text-amber-700 pl-3">
                    <span className="font-sans font-medium">(-) Customer Discounts Allowed</span>
                    <span className="font-extrabold">-{settings.currency}{financials.discountsAllowed.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100 text-slate-600 pl-3">
                    <span className="font-sans font-medium">(-) Output VAT Collected (ZRA Liability)</span>
                    <span className="font-extrabold">-{settings.currency}{financials.vatCollected.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-2 bg-slate-50 px-3 rounded-lg font-bold text-slate-900">
                    <span className="font-sans font-black">NET SALES REVENUE</span>
                    <span className="font-black text-indigo-700">{settings.currency}{financials.totalRevenue.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100 text-rose-600 pl-3">
                    <span className="font-sans font-medium">(-) Cost of Goods Sold (COGS)</span>
                    <span className="font-extrabold">-{settings.currency}{financials.totalCogs.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-2 bg-emerald-50/70 px-3 rounded-lg font-bold text-emerald-950">
                    <span className="font-sans font-black">GROSS PROFIT MARGIN</span>
                    <span className="font-black text-emerald-700">{settings.currency}{financials.grossProfit.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100 text-rose-600 pl-3">
                    <span className="font-sans font-medium">(-) Operating Expenses & Overhead</span>
                    <span className="font-extrabold">-{settings.currency}{financials.totalOperatingExpenses.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100 text-rose-600 pl-3">
                    <span className="font-sans font-medium">(-) Staff Payroll & Wages Paid</span>
                    <span className="font-extrabold">-{settings.currency}{financials.totalPayroll.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100 text-rose-600 pl-3">
                    <span className="font-sans font-medium">(-) Rent & Premises Allocations</span>
                    <span className="font-extrabold">-{settings.currency}{financials.rentExpense.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100 text-rose-600 pl-3">
                    <span className="font-sans font-medium">(-) Electricity, Water & Utilities</span>
                    <span className="font-extrabold">-{settings.currency}{financials.utilitiesExpense.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100 text-rose-600 pl-3">
                    <span className="font-sans font-medium">(-) General Operating & Admin Expenses</span>
                    <span className="font-extrabold">-{settings.currency}{financials.generalOperatingExpense.toFixed(2)}</span>
                  </div>
                  <div className={`flex justify-between py-2.5 px-3.5 rounded-xl font-black text-xs ${
                    financials.netProfit >= 0 ? 'bg-emerald-100 text-emerald-950 border border-emerald-300' : 'bg-rose-100 text-rose-950 border border-rose-300'
                  }`}>
                    <span className="font-sans uppercase">NET OPERATING PROFIT / INCOME</span>
                    <span>{settings.currency}{financials.netProfit.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* 2. BALANCE SHEET STATEMENT */}
              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5 gap-2">
                  <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest">
                    2. BALANCE SHEET STATEMENT
                  </h3>
                  <div className="flex items-center gap-1.5">
                    {Math.abs(financials.totalAssetVal - (financials.totalLiabilitiesVal + financials.totalEquityVal)) < 10 ? (
                      <span className="text-[10px] font-black px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-md border border-emerald-200">
                        BALANCED
                      </span>
                    ) : (
                      <span className="text-[10px] font-black px-2 py-0.5 bg-amber-50 text-amber-700 rounded-md border border-amber-200">
                        DISPARITY
                      </span>
                    )}
                    <span className="text-[10px] font-bold px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded-md border border-indigo-200">
                      ASSETS = L + E
                    </span>
                  </div>
                </div>

                <div className="space-y-2 font-mono text-xs">
                  <div className="text-[10px] font-sans font-black uppercase text-slate-400 tracking-wider">Current & Fixed Assets</div>
                  <div className="flex justify-between py-1 border-b border-slate-100 pl-2">
                    <span className="font-sans font-medium text-slate-700">Cash in Counter Drawer</span>
                    <span className="font-bold text-slate-900">{settings.currency}{financials.cashDrawerBalance.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-100 pl-2">
                    <span className="font-sans font-medium text-slate-700">Mobile Money Wallets</span>
                    <span className="font-bold text-slate-900">{settings.currency}{financials.mobileMoneyBalance.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-100 pl-2">
                    <span className="font-sans font-medium text-slate-700">Commercial Bank & Card Settlement</span>
                    <span className="font-bold text-slate-900">{settings.currency}{financials.bankCardBalance.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-100 pl-2">
                    <span className="font-sans font-medium text-slate-700">Store Merchandise Inventory (At Cost)</span>
                    <span className="font-bold text-slate-900">{settings.currency}{financials.inventoryAssetValue.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-100 pl-2">
                    <span className="font-sans font-medium text-slate-700">Goods in Transit Asset</span>
                    <span className="font-bold text-slate-900">{settings.currency}{financials.goodsInTransitValue.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-100 pl-2">
                    <span className="font-sans font-medium text-slate-700">Fixed Equipment & Property Assets</span>
                    <span className="font-bold text-slate-900">{settings.currency}{financials.fixedAssetsValue.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-2 bg-indigo-50 px-3 rounded-lg font-black text-indigo-950">
                    <span className="font-sans">TOTAL ASSETS</span>
                    <span>{settings.currency}{financials.totalAssetVal.toFixed(2)}</span>
                  </div>

                  <div className="text-[10px] font-sans font-black uppercase text-slate-400 tracking-wider pt-1">Liabilities & Owner Equity</div>
                  <div className="flex justify-between py-1 border-b border-slate-100 pl-2">
                    <span className="font-sans font-medium text-slate-700">VAT / Tax Output Payable</span>
                    <span className="font-bold text-rose-700">{settings.currency}{financials.vatPayableLiability.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-100 pl-2">
                    <span className="font-sans font-medium text-slate-700">Customer Layby Unearned Deposits</span>
                    <span className="font-bold text-rose-700">{settings.currency}{financials.laybyDepositsLiability.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-100 pl-2">
                    <span className="font-sans font-medium text-slate-700">Working Capital Loans Payable</span>
                    <span className="font-bold text-rose-700">{settings.currency}{financials.loansPayableLiability.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-100 pl-2">
                    <span className="font-sans font-medium text-slate-700">Owner / Contributed Capital Equity</span>
                    <span className="font-bold text-emerald-700">{settings.currency}{financials.ownerCapitalEquity.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-100 pl-2">
                    <span className="font-sans font-medium text-slate-700">Retained Earnings & Reserves</span>
                    <span className="font-bold text-emerald-700">{settings.currency}{financials.retainedEarnings.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-2 bg-slate-900 text-white px-3 rounded-lg font-black">
                    <span className="font-sans">TOTAL LIABILITIES & EQUITY</span>
                    <span>{settings.currency}{(financials.totalLiabilitiesVal + financials.totalEquityVal).toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 3. CASH FLOW STATEMENT (DIRECT METHOD) */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest">
                  3. CASH FLOW STATEMENT (DIRECT METHOD)
                </h3>
                <span className="text-[10px] font-bold px-2 py-0.5 bg-slate-100 text-slate-600 rounded-md">
                  {periodMeta.label}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                  <span className="text-[10px] font-black uppercase text-slate-400 block">Operating Cash Flow</span>
                  <span className="text-base font-black text-slate-900 mt-1 block font-mono">
                    {settings.currency}{financials.operatingCashFlow.toFixed(2)}
                  </span>
                  <span className="text-[10px] text-slate-500">Sales & Laybys minus Refunds, POs & Expenses</span>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                  <span className="text-[10px] font-black uppercase text-slate-400 block">Investing Cash Flow</span>
                  <span className="text-base font-black text-indigo-700 mt-1 block font-mono">
                    {settings.currency}{financials.investingCashFlow.toFixed(2)}
                  </span>
                  <span className="text-[10px] text-slate-500">Asset Acquisitions & Disposals</span>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                  <span className="text-[10px] font-black uppercase text-slate-400 block">Financing Cash Flow</span>
                  <span className="text-base font-black text-emerald-700 mt-1 block font-mono">
                    {settings.currency}{financials.financingCashFlow.toFixed(2)}
                  </span>
                  <span className="text-[10px] text-slate-500">Capital Injections, Drawings & Loans</span>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs pt-1">
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between">
                  <span className="font-bold text-slate-600">Net Change in Cash Reserves</span>
                  <span className="font-mono font-black text-slate-900">{settings.currency}{financials.netCashFlow.toFixed(2)}</span>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between">
                  <span className="font-bold text-slate-600">Cash at Beginning of Period</span>
                  <span className="font-mono font-black text-slate-700">{settings.currency}{financials.beginningCashBalance.toFixed(2)}</span>
                </div>
                <div className="p-3 rounded-xl bg-emerald-950 text-white border border-emerald-800 flex items-center justify-between">
                  <span className="font-black uppercase text-[11px] text-emerald-200">Closing Cash & Equivalents</span>
                  <span className="font-mono font-black text-base text-white">{settings.currency}{financials.closingCashBalance.toFixed(2)}</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* CASH BASED ON PAYMENT METHOD & LIVE EOD TAB */}
        {subTab === 'payment_methods' && (
          <motion.div
            key="payment-methods-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-5 pr-1"
          >
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-4">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
                <div>
                  <h2 className="text-base md:text-lg font-black text-slate-900 uppercase flex items-center gap-2">
                    <Wallet className="text-indigo-600" size={20} />
                    <span>Cash Based on Payment Method & Live EOD Register</span>
                  </h2>
                  <p className="text-xs text-slate-500 font-medium">
                    Scope: <span className="font-bold text-indigo-700">{activeScopeLabel}</span>
                  </p>
                </div>
                <select
                  value={statementBranchMode === 'all' ? 'all' : statementBranchMode === 'single' ? statementStoreFilter : 'custom'}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === 'all') {
                      setStatementBranchMode('all');
                      setStatementStoreFilter('all');
                    } else if (val !== 'custom') {
                      setStatementBranchMode('single');
                      setStatementStoreFilter(val);
                    }
                  }}
                  className="bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold text-slate-800"
                >
                  <option value="all">All Branches Consolidated</option>
                  {statementBranchMode === 'custom' && (
                    <option value="custom">Custom Selection ({selectedStatementBranches.length} branches)</option>
                  )}
                  {storesList.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 text-slate-600 uppercase font-black border-b border-slate-200">
                      <th className="p-3">Payment Method</th>
                      <th className="p-3">Ledger Account</th>
                      <th className="p-3 text-right">Sales Receipts (+)</th>
                      <th className="p-3 text-right">Layby Receipts (+)</th>
                      <th className="p-3 text-right">Refunds Paid (-)</th>
                      <th className="p-3 text-right">Expenses / POs (-)</th>
                      <th className="p-3 text-right">Transfers Net</th>
                      <th className="p-3 text-center">Tx Count</th>
                      <th className="p-3 text-right">Net Available Cash</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {scopedPaymentMethodLedger.map(pm => {
                      const netTransfers = Number(pm.transfers_in || 0) - Number(pm.transfers_out || 0);
                      return (
                        <tr key={pm.id} className="hover:bg-slate-50 transition-colors">
                          <td className="p-3 font-black text-slate-900">{pm.payment_method}</td>
                          <td className="p-3 font-mono text-slate-500">{pm.account_id}</td>
                          <td className="p-3 text-right font-bold text-emerald-700">+{settings.currency}{Number(pm.gross_receipts || 0).toFixed(2)}</td>
                          <td className="p-3 text-right font-bold text-teal-700">+{settings.currency}{Number(pm.layby_receipts || 0).toFixed(2)}</td>
                          <td className="p-3 text-right font-bold text-rose-600">-{settings.currency}{Number(pm.refunds_out || 0).toFixed(2)}</td>
                          <td className="p-3 text-right font-bold text-amber-700">-{settings.currency}{Number(pm.expenses_out || 0).toFixed(2)}</td>
                          <td className="p-3 text-right font-mono text-slate-700">{netTransfers >= 0 ? `+${settings.currency}${netTransfers.toFixed(2)}` : `-${settings.currency}${Math.abs(netTransfers).toFixed(2)}`}</td>
                          <td className="p-3 text-center font-bold text-slate-700">{pm.transaction_count}</td>
                          <td className="p-3 text-right font-black text-indigo-700">{settings.currency}{Number(pm.net_balance || 0).toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* LIVE EOD CASH-UP REGISTER TABLE */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
              <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest border-b border-slate-100 pb-2.5">
                END-OF-DAY (EOD) LIVE & HISTORICAL CASH-UP DATABASE LEDGER (`cash_ups`)
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 text-slate-600 uppercase font-black border-b border-slate-200">
                      <th className="p-3">EOD ID</th>
                      <th className="p-3">Date</th>
                      <th className="p-3">Store</th>
                      <th className="p-3">Status / Cashier</th>
                      <th className="p-3 text-right">Expected Cash</th>
                      <th className="p-3 text-right">Expected Card</th>
                      <th className="p-3 text-right">Expected Mobile</th>
                      <th className="p-3">Audit Breakdown</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {eodCashUps.map(cu => (
                      <tr key={cu.id} className="hover:bg-slate-50">
                        <td className="p-3 font-mono font-bold text-slate-800">{cu.id}</td>
                        <td className="p-3 font-mono text-slate-600">{cu.date}</td>
                        <td className="p-3 font-bold uppercase text-slate-700">{cu.store_id}</td>
                        <td className="p-3 font-semibold text-indigo-700">{cu.cashier_name}</td>
                        <td className="p-3 text-right font-black text-emerald-700">{settings.currency}{Number(cu.sum_cash_expected || 0).toFixed(2)}</td>
                        <td className="p-3 text-right font-bold text-sky-700">{settings.currency}{Number(cu.sum_card_expected || 0).toFixed(2)}</td>
                        <td className="p-3 text-right font-bold text-purple-700">{settings.currency}{Number(cu.sum_momo_expected || 0).toFixed(2)}</td>
                        <td className="p-3 text-slate-500 text-[11px]">{cu.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* CENTRAL SQL REPORTING & ON-DEVICE RECEIPT CACHE */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
                <div>
                  <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest">
                    CENTRAL SQL REPORTING LEDGER &amp; ON-DEVICE RECEIPT CACHE
                  </h3>
                  <p className="text-xs text-slate-500 font-medium mt-0.5">
                    Finalized Firestore transactions mirror to PostgreSQL for consolidated reporting, while SQLite caches {cachedReceipts.length} recent receipt(s) locally on-device.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadCentralSqlAndReceiptCache()}
                  disabled={centralSqlLoading}
                  className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-black uppercase tracking-wider flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
                >
                  <RefreshCw size={13} className={centralSqlLoading ? 'animate-spin' : ''} />
                  <span>{centralSqlLoading ? 'Querying Central SQL...' : 'Refresh Central SQL Report'}</span>
                </button>
              </div>

              {centralSqlError && (
                <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs font-semibold text-amber-800">
                  {centralSqlError}
                </div>
              )}

              {centralSqlReport?.metrics ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                    <span className="text-[10px] font-bold text-slate-500 uppercase block">SQL Gross Sales</span>
                    <span className="text-base font-black text-slate-900 mt-0.5 block">
                      {settings.currency}{Number(centralSqlReport.metrics.grossSales || 0).toFixed(2)}
                    </span>
                    <span className="text-[10px] text-slate-500">{centralSqlReport.metrics.completedOrderCount} order(s)</span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                    <span className="text-[10px] font-bold text-slate-500 uppercase block">SQL Net Revenue</span>
                    <span className="text-base font-black text-emerald-700 mt-0.5 block">
                      {settings.currency}{Number(centralSqlReport.metrics.netRevenue || 0).toFixed(2)}
                    </span>
                    <span className="text-[10px] text-slate-500">Tax: {settings.currency}{Number(centralSqlReport.metrics.taxCollected || 0).toFixed(2)}</span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                    <span className="text-[10px] font-bold text-slate-500 uppercase block">SQL Gross Profit</span>
                    <span className="text-base font-black text-indigo-700 mt-0.5 block">
                      {settings.currency}{Number(centralSqlReport.metrics.grossProfit || 0).toFixed(2)}
                    </span>
                    <span className="text-[10px] text-slate-500">COGS: {settings.currency}{Number(centralSqlReport.metrics.cogsAmount || 0).toFixed(2)}</span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                    <span className="text-[10px] font-bold text-slate-500 uppercase block">SQL Refunds</span>
                    <span className="text-base font-black text-rose-600 mt-0.5 block">
                      -{settings.currency}{Number(centralSqlReport.metrics.refundTotal || 0).toFixed(2)}
                    </span>
                    <span className="text-[10px] text-slate-500">{centralSqlReport.metrics.refundOrderCount} refund(s)</span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-500 font-medium">
                  Click &ldquo;Refresh Central SQL Report&rdquo; to query the PostgreSQL reporting warehouse for the selected branch and period.
                </p>
              )}
            </div>
          </motion.div>
        )}

        {/* RECEIPT & REFUND LEDGER TAB */}
        {subTab === 'receipt_refund' && (
          <motion.div
            key="receipt-refund-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-4 pr-1"
          >
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-4">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
                <div>
                  <h2 className="text-base md:text-lg font-black text-slate-900 uppercase flex items-center gap-2">
                    <Receipt className="text-indigo-600" size={20} />
                    <span>Receipt & Refund Accounting Ledger</span>
                  </h2>
                  <p className="text-xs text-slate-500 font-medium">
                    Complete double-entry audit trail of every POS Sales Receipt, Layby Receipt, and Reversing Refund Credit Note.
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(['ALL', 'RECEIPT', 'REFUND', 'LAYBY_RECEIPT'] as const).map(ft => (
                    <button
                      key={ft}
                      onClick={() => setLedgerFilterType(ft)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-black uppercase cursor-pointer ${
                        ledgerFilterType === ft ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {ft.replace('_', ' ')}
                    </button>
                  ))}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 text-slate-600 uppercase font-black border-b border-slate-200">
                      <th className="p-3">Ledger ID</th>
                      <th className="p-3">Order Ref</th>
                      <th className="p-3">Type</th>
                      <th className="p-3">Date</th>
                      <th className="p-3">Customer</th>
                      <th className="p-3">Payment Method</th>
                      <th className="p-3 text-right">VAT Tax</th>
                      <th className="p-3 text-right">COGS</th>
                      <th className="p-3 text-right">Cash Impact</th>
                      <th className="p-3">Journal Ref</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {scopedReceiptRefundLedger
                      .filter(r => ledgerFilterType === 'ALL' || r.entry_type === ledgerFilterType)
                      .map(r => (
                        <tr key={r.id} className="hover:bg-slate-50">
                          <td className="p-3 font-mono font-bold text-slate-700">{r.id}</td>
                          <td className="p-3 font-mono font-bold text-slate-900">{r.order_id}</td>
                          <td className="p-3">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase ${
                              r.entry_type === 'REFUND'
                                ? 'bg-rose-100 text-rose-800 border border-rose-300'
                                : r.entry_type === 'LAYBY_RECEIPT'
                                ? 'bg-amber-100 text-amber-800 border border-amber-300'
                                : 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                            }`}>
                              {r.entry_type}
                            </span>
                          </td>
                          <td className="p-3 font-mono text-slate-500">{String(r.date || '').replace('T', ' ').substring(0, 16)}</td>
                          <td className="p-3 font-semibold text-slate-800">{r.customer_name}</td>
                          <td className="p-3 font-bold text-slate-700">{r.payment_method}</td>
                          <td className="p-3 text-right font-mono text-slate-600">{settings.currency}{Number(r.tax || 0).toFixed(2)}</td>
                          <td className="p-3 text-right font-mono text-slate-600">{settings.currency}{Number(r.cogs_amount || 0).toFixed(2)}</td>
                          <td className={`p-3 text-right font-black ${Number(r.cash_impact || 0) >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                            {Number(r.cash_impact || 0) >= 0 ? `+${settings.currency}${Number(r.cash_impact || 0).toFixed(2)}` : `-${settings.currency}${Math.abs(Number(r.cash_impact || 0)).toFixed(2)}`}
                          </td>
                          <td className="p-3 font-mono text-indigo-600">{r.journal_ref}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          </motion.div>
        )}

        {/* CASH FLOW LEDGER TAB */}
        {subTab === 'cash_flow' && (
          <motion.div
            key="cash-flow-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-4 pr-1"
          >
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-4">
              <div>
                <h2 className="text-base md:text-lg font-black text-slate-900 uppercase flex items-center gap-2">
                  <TrendingUp className="text-indigo-600" size={20} />
                  <span>Direct Cash Flow Statement Ledger (`cash_flow_ledger`)</span>
                </h2>
                <p className="text-xs text-slate-500 font-medium">
                  Every cash inflow (sales, layby installments, equity) and cash outflow (refunds, expenses, payroll, supplier POs) in real time.
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 text-slate-600 uppercase font-black border-b border-slate-200">
                      <th className="p-3">Cash Flow ID</th>
                      <th className="p-3">Date</th>
                      <th className="p-3">Activity</th>
                      <th className="p-3">Category</th>
                      <th className="p-3">Payment Method</th>
                      <th className="p-3">Description</th>
                      <th className="p-3 text-right">Inflow (+)</th>
                      <th className="p-3 text-right">Outflow (-)</th>
                      <th className="p-3 text-right">Net Cash Change</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {scopedCashFlowLedger.map(cf => (
                      <tr key={cf.id} className="hover:bg-slate-50">
                        <td className="p-3 font-mono font-bold text-slate-700">{cf.id}</td>
                        <td className="p-3 font-mono text-slate-500">{String(cf.date || '').replace('T', ' ').substring(0, 16)}</td>
                        <td className="p-3 font-bold text-indigo-700">{cf.activity_type}</td>
                        <td className="p-3 font-bold text-slate-800">{cf.category}</td>
                        <td className="p-3 font-semibold text-slate-700">{cf.payment_method}</td>
                        <td className="p-3 text-slate-600">{cf.description}</td>
                        <td className="p-3 text-right font-bold text-emerald-700">
                          {Number(cf.inflow_amount || 0) > 0 ? `+${settings.currency}${Number(cf.inflow_amount).toFixed(2)}` : '—'}
                        </td>
                        <td className="p-3 text-right font-bold text-rose-600">
                          {Number(cf.outflow_amount || 0) > 0 ? `-${settings.currency}${Number(cf.outflow_amount).toFixed(2)}` : '—'}
                        </td>
                        <td className={`p-3 text-right font-black ${Number(cf.net_cash_change || 0) >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                          {Number(cf.net_cash_change || 0) >= 0 ? `+${settings.currency}${Number(cf.net_cash_change).toFixed(2)}` : `-${settings.currency}${Math.abs(Number(cf.net_cash_change)).toFixed(2)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </motion.div>
        )}

        {/* DOUBLE-ENTRY GENERAL JOURNAL & TRIAL BALANCE TAB */}
        {subTab === 'double_entry' && (
          <motion.div
            key="double-entry-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-5 pr-1"
          >
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
              <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest border-b border-slate-100 pb-2.5">
                CHART OF ACCOUNTS LIVE TRIAL BALANCES (`view_account_balances`)
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 text-slate-600 uppercase font-black border-b border-slate-200">
                      <th className="p-2.5">Account ID</th>
                      <th className="p-2.5">Account Name</th>
                      <th className="p-2.5">Currency</th>
                      <th className="p-2.5 text-right">Current Ledger Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {accountBalances
                      .filter(ab => Math.abs(Number(ab.current_balance || 0)) > 0.001)
                      .map(ab => (
                        <tr key={ab.account_id} className="hover:bg-slate-50">
                          <td className="p-2.5 font-mono font-bold text-slate-700">{ab.account_id}</td>
                          <td className="p-2.5 font-bold text-slate-900">{ab.account_name}</td>
                          <td className="p-2.5 font-mono text-slate-500">{ab.currency}</td>
                          <td className="p-2.5 text-right font-black text-indigo-700">
                            {settings.currency}{Number(ab.current_balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
              <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest border-b border-slate-100 pb-2.5">
                GENERAL DOUBLE-ENTRY JOURNAL (`double_entry_journal`)
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 text-slate-600 uppercase font-black border-b border-slate-200">
                      <th className="p-2.5">Journal ID</th>
                      <th className="p-2.5">Date</th>
                      <th className="p-2.5">Ref</th>
                      <th className="p-2.5">Description</th>
                      <th className="p-2.5">Debit Account (DR)</th>
                      <th className="p-2.5">Credit Account (CR)</th>
                      <th className="p-2.5 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {doubleEntryJournal.map(j => (
                      <tr key={j.id} className="hover:bg-slate-50">
                        <td className="p-2.5 font-mono font-bold text-slate-700">{j.id}</td>
                        <td className="p-2.5 font-mono text-slate-500">{String(j.date || '').replace('T', ' ').substring(0, 16)}</td>
                        <td className="p-2.5 font-mono font-bold text-slate-800">{j.reference}</td>
                        <td className="p-2.5 text-slate-700">{j.description}</td>
                        <td className="p-2.5 font-mono font-bold text-emerald-700">{j.account_debit}</td>
                        <td className="p-2.5 font-mono font-bold text-indigo-700">{j.account_credit}</td>
                        <td className="p-2.5 text-right font-black text-slate-900">{settings.currency}{Number(j.amount || 0).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </motion.div>
        )}

        {/* OPERATING EXPENSES TAB */}
        {subTab === 'expenses' && (
          <motion.div
            key="expenses-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-6 pr-1"
          >
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex flex-col gap-4">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                  <h2 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
                    <DollarSign className="text-indigo-600" size={22} />
                    <span>Operating Expenses & Cash Outflows</span>
                  </h2>
                  <p className="text-xs text-slate-500 font-medium">
                    Log and track all store operating costs, utility payments, rent, and overhead bills.
                  </p>
                </div>
              </div>

              {/* RECORD EXPENSE FORM */}
              <form onSubmit={handleRecordExpense} className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200">
                <div className="lg:col-span-2">
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Expense Category</label>
                  <select
                    value={expenseCategory}
                    onChange={(e) => setExpenseCategory(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                  >
                    <option value="Operating - Rent & Premises">Operating - Rent & Premises</option>
                    <option value="Operating - Electricity & Utilities">Operating - Electricity & Utilities</option>
                    <option value="Operating - Internet & Telecom">Operating - Internet & Telecom</option>
                    <option value="Logistics - Transport & Fuel">Logistics - Transport & Fuel</option>
                    <option value="Marketing & Promotions">Marketing & Promotions</option>
                    <option value="Maintenance & Repairs">Maintenance & Repairs</option>
                    <option value="Staff Meals & Refreshments">Staff Meals & Refreshments</option>
                    <option value="Miscellaneous Overhead">Miscellaneous Overhead</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Amount ({settings.currency})</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={expenseAmount}
                    onChange={(e) => setExpenseAmount(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    required
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Payment Account</label>
                  <select
                    value={expenseAccountId}
                    onChange={(e) => setExpenseAccountId(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                  >
                    {selectableAccounts.map(acc => (
                      <option key={acc.accountId} value={acc.accountId}>{acc.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Description / Notes</label>
                  <input
                    type="text"
                    placeholder="e.g. June Shop Rent"
                    value={expenseDescription}
                    onChange={(e) => setExpenseDescription(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                  />
                </div>

                <div className="flex items-end">
                  <button
                    type="submit"
                    className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-lg uppercase tracking-wider transition-all cursor-pointer shadow-xs flex items-center justify-center gap-1.5"
                  >
                    <Plus size={14} />
                    <span>Log Expense</span>
                  </button>
                </div>
              </form>

              {/* EXPENSES LEDGER TABLE */}
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 text-slate-600 uppercase font-black border-b border-slate-200">
                      <th className="p-3">Ref ID</th>
                      <th className="p-3">Category</th>
                      <th className="p-3">Description</th>
                      <th className="p-3">Account</th>
                      <th className="p-3">Date</th>
                      <th className="p-3 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {expensesList.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-6 text-center text-slate-400 font-medium italic">
                          No operating expense records logged yet.
                        </td>
                      </tr>
                    ) : (
                      expensesList.map(exp => (
                        <tr key={exp.id} className="hover:bg-slate-50 transition-colors">
                          <td className="p-3 font-mono font-bold text-slate-700">{exp.id}</td>
                          <td className="p-3 font-bold text-slate-800">{exp.category}</td>
                          <td className="p-3 text-slate-600">{exp.description || '—'}</td>
                          <td className="p-3 font-semibold text-slate-500">{exp.account_id}</td>
                          <td className="p-3 font-mono text-slate-500">{exp.expense_date}</td>
                          <td className="p-3 text-right font-black text-rose-600">
                            {settings.currency}{Number(exp.amount).toFixed(2)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </motion.div>
        )}

        {/* TRANSFERS TAB */}
        {subTab === 'transfers' && (
          <motion.div
            key="transfers-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-6 pr-1"
          >
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
              <h2 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2 mb-4">
                <RefreshCw className="text-indigo-600" size={22} />
                <span>Inter-Account & Cash Transfers</span>
              </h2>

              {transferFeedback && (
                <div
                  className={`mb-4 px-3.5 py-2.5 rounded-xl border text-xs font-bold flex items-center justify-between gap-2 ${
                    transferFeedback.type === 'error'
                      ? 'bg-rose-50 border-rose-200 text-rose-800'
                      : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <AlertCircle size={15} className="shrink-0" />
                    <span>{transferFeedback.text}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTransferFeedback(null)}
                    className="text-[10px] font-black uppercase px-2 py-0.5 rounded hover:bg-black/5 cursor-pointer"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              <form onSubmit={handleExecuteTransfer} className="grid grid-cols-1 md:grid-cols-6 gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200">
                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Source Account</label>
                  <select
                    value={transferSourceAcc}
                    onChange={(e) => setTransferSourceAcc(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                  >
                    {selectableAccounts.map(acc => (
                      <option key={acc.accountId} value={acc.accountId}>{acc.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Destination Account</label>
                  <select
                    value={transferDestAcc}
                    onChange={(e) => setTransferDestAcc(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                  >
                    {selectableAccounts.map(acc => (
                      <option key={acc.accountId} value={acc.accountId}>{acc.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Amount ({settings.currency})</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={transferAmount}
                    onChange={(e) => setTransferAmount(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    required
                  />
                </div>

                <div className="md:col-span-2">
                  <TransferReceiptField
                    compact
                    label="Reference ID / Receipt"
                    placeholder="e.g. Bank Deposit Ref #8492"
                    referenceValue={transferRef}
                    onReferenceChange={setTransferRef}
                    receipt={transferReceipt}
                    onReceiptChange={setTransferReceipt}
                  />
                </div>

                <div className="flex items-end">
                  <button
                    type="submit"
                    className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-lg uppercase tracking-wider cursor-pointer shadow-xs"
                  >
                    Transfer Funds
                  </button>
                </div>
              </form>
            </div>

            {/* TRANSFERS LOG TABLE */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-100 text-slate-600 uppercase font-black border-b border-slate-200">
                    <th className="p-3">Transfer ID</th>
                    <th className="p-3">From</th>
                    <th className="p-3">To</th>
                    <th className="p-3">Date</th>
                    <th className="p-3">Reference ID</th>
                    <th className="p-3 text-center">Receipt</th>
                    <th className="p-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {transfersList.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-slate-400 font-medium italic">
                        No internal account transfers recorded.
                      </td>
                    </tr>
                  ) : (
                    transfersList.map(tr => {
                      const attachedReceipt = getTransferReceipt(String(tr.id || ''), tr.notes);
                      return (
                        <tr key={tr.id} className="hover:bg-slate-50 transition-colors">
                          <td className="p-3 font-mono font-bold text-slate-800">{tr.id}</td>
                          <td className="p-3 font-bold text-slate-700">{tr.source_account}</td>
                          <td className="p-3 font-bold text-slate-700">{tr.dest_account}</td>
                          <td className="p-3 font-mono text-slate-500">{tr.transfer_date}</td>
                          <td className="p-3 text-slate-600 font-semibold">{tr.reference_no || '—'}</td>
                          <td className="p-3 text-center">
                            {attachedReceipt ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setViewingTransferReceipt({
                                    receipt: attachedReceipt,
                                    refLabel: tr.reference_no || tr.id,
                                  })
                                }
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 text-[10px] font-black uppercase cursor-pointer"
                              >
                                <Eye size={11} />
                                <span>View Receipt</span>
                              </button>
                            ) : (
                              <span className="text-slate-300 font-mono text-[10px]">—</span>
                            )}
                          </td>
                          <td className="p-3 text-right font-black text-indigo-700">
                            {settings.currency}{Number(tr.amount).toFixed(2)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {viewingTransferReceipt && (
              <TransferReceiptViewerModal
                receipt={viewingTransferReceipt.receipt}
                referenceLabel={viewingTransferReceipt.refLabel}
                onClose={() => setViewingTransferReceipt(null)}
              />
            )}
          </motion.div>
        )}

        {/* STANDARDIZED ASSET & CAPITAL EQUITY REGISTRY TAB */}
        {subTab === 'assets_equity' && (
          <motion.div
            key="assets-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-5 pr-1"
          >
            {/* Header */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
              <div>
                <h2 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2 uppercase">
                  <Landmark className="text-indigo-600" size={22} />
                  <span>Standardized Assets & Capital Equity Registry</span>
                </h2>
                <p className="text-xs text-slate-500 font-medium">
                  Track Fixed & Current Assets with live Straight-Line / Reducing-Balance Depreciation, Net Book Value, Disposals, Owner Capital & Drawings.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (showAssetForm) {
                      resetAssetForm();
                    } else {
                      resetAssetForm();
                      setShowAssetForm(true);
                    }
                  }}
                  className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl uppercase tracking-wider cursor-pointer shadow-xs flex items-center gap-1.5"
                >
                  <Plus size={14} />
                  <span>{showAssetForm ? 'Close Asset Form' : 'Register Asset'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (showEquityForm) {
                      resetEquityForm();
                    } else {
                      resetEquityForm();
                      setShowEquityForm(true);
                    }
                  }}
                  className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-xl uppercase tracking-wider cursor-pointer shadow-xs flex items-center gap-1.5"
                >
                  <Plus size={14} />
                  <span>{showEquityForm ? 'Close Equity Form' : 'Record Equity / Drawings'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleExportRegistryPDF}
                  className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-xs rounded-xl uppercase tracking-wider cursor-pointer shadow-xs flex items-center gap-1.5"
                >
                  <Download size={14} />
                  <span>Export PDF</span>
                </button>
              </div>
            </div>

            {/* KPI Summary Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
                <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider block">Gross Active Asset Cost</span>
                <span className="text-xl font-black text-slate-900 block mt-1">
                  {settings.currency}{registryMetrics.grossCostActive.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className="text-[11px] text-slate-500">Original acquisition value (Active)</span>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
                <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider block">Accumulated Depreciation</span>
                <span className="text-xl font-black text-amber-700 block mt-1">
                  -{settings.currency}{registryMetrics.accumDepActive.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className="text-[11px] text-slate-500">Straight-Line & Reducing Balance to date</span>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
                <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider block">Net Book Value (Balance Sheet)</span>
                <span className="text-xl font-black text-indigo-700 block mt-1">
                  {settings.currency}{registryMetrics.totalNbvActive.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className="text-[11px] text-slate-500">Carrying value on Financial Statements</span>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
                <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider block">Net Contributed Equity</span>
                <span className="text-xl font-black text-emerald-700 block mt-1">
                  {settings.currency}{registryMetrics.netContributedEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className="text-[11px] text-slate-500">
                  Contributions {settings.currency}{registryMetrics.contributedCapital.toFixed(0)} − Drawings {settings.currency}{registryMetrics.drawingsTotal.toFixed(0)}
                </span>
              </div>
            </div>

            {/* Filter & Search Bar */}
            <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[200px] relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={registrySearch}
                  onChange={(e) => setRegistrySearch(e.target.value)}
                  placeholder="Search Asset Tag, Name, Serial No., Shareholder or Reference..."
                  className="w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-800"
                />
              </div>
              <select
                value={registryBranchFilter}
                onChange={(e) => setRegistryBranchFilter(e.target.value)}
                className="bg-slate-50 border border-slate-300 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-800"
              >
                <option value="all">All Branches</option>
                {storesList.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <select
                value={registryStatusFilter}
                onChange={(e) => setRegistryStatusFilter(e.target.value as any)}
                className="bg-slate-50 border border-slate-300 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-800"
              >
                <option value="ALL">All Asset Statuses</option>
                <option value="Active">Active</option>
                <option value="Disposed">Disposed</option>
                <option value="Written Off">Written Off</option>
              </select>
            </div>

            {/* STANDARDIZED ASSET ADD / EDIT FORM */}
            {showAssetForm && (
              <form onSubmit={handleSaveAsset} className="bg-white p-5 rounded-2xl border-2 border-indigo-200 shadow-xs space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <h3 className="text-xs font-black text-indigo-900 uppercase tracking-wider">
                    {editingAssetId ? `EDIT ASSET RECORD (${editingAssetId})` : 'REGISTER NEW FIXED / CURRENT ASSET'}
                  </h3>
                  <span className="text-[11px] font-bold text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded-lg border border-indigo-200">
                    Preview NBV: {settings.currency}{liveFormValuation.netBookValue.toFixed(2)} (Accum. Depr. {settings.currency}{liveFormValuation.accumulatedDepreciation.toFixed(2)})
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Asset Tag / Code</label>
                    <input
                      type="text"
                      placeholder="Auto-generated if blank (e.g. TAG-1001)"
                      value={assetTagInput}
                      onChange={(e) => setAssetTagInput(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    />
                  </div>
                  <div className="lg:col-span-2">
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Asset Name *</label>
                    <input
                      type="text"
                      placeholder="e.g. Commercial Chest Freezer / Delivery Van"
                      value={newAssetName}
                      onChange={(e) => setNewAssetName(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Assigned Branch</label>
                    <select
                      value={newAssetStoreId}
                      onChange={(e) => setNewAssetStoreId(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    >
                      {storesList.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Category</label>
                    <select
                      value={newAssetCategory}
                      onChange={(e) => setNewAssetCategory(e.target.value as 'Current' | 'Fixed')}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    >
                      <option value="Fixed">Fixed Asset</option>
                      <option value="Current">Current Asset</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Asset Class</label>
                    <select
                      value={newAssetType}
                      onChange={(e) => setNewAssetType(e.target.value as Asset['type'])}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    >
                      {ASSET_CLASSES.map((cls) => (
                        <option key={cls} value={cls}>{cls}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Serial / Reg. Number</label>
                    <input
                      type="text"
                      placeholder="Serial / Plate / Chassis No."
                      value={newAssetSerial}
                      onChange={(e) => setNewAssetSerial(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Acquisition Date</label>
                    <input
                      type="date"
                      value={newAssetPurchaseDate}
                      onChange={(e) => setNewAssetPurchaseDate(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Acquisition Cost ({settings.currency}) *</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder="0.00"
                      value={newAssetValue}
                      onChange={(e) => setNewAssetValue(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Salvage Value ({settings.currency})</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={newAssetSalvage}
                      onChange={(e) => setNewAssetSalvage(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Useful Life (Years)</label>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={newAssetUsefulLife}
                      onChange={(e) => {
                        const yrs = e.target.value;
                        setNewAssetUsefulLife(yrs);
                        const num = parseFloat(yrs);
                        if (num > 0 && newAssetDepreciationMethod === 'Straight Line') {
                          setNewAssetDepreciationRate((100 / num).toFixed(2));
                        }
                      }}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Depreciation Method</label>
                    <select
                      value={newAssetDepreciationMethod}
                      onChange={(e) => setNewAssetDepreciationMethod(e.target.value as any)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    >
                      <option value="Straight Line">Straight Line</option>
                      <option value="Reducing Balance">Reducing Balance</option>
                      <option value="None">None (Non-Depreciable)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Annual Rate (%)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      disabled={newAssetDepreciationMethod === 'None'}
                      value={newAssetDepreciationRate}
                      onChange={(e) => setNewAssetDepreciationRate(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800 disabled:bg-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Funding Source</label>
                    <select
                      value={newAssetFundingSource}
                      onChange={(e) => setNewAssetFundingSource(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    >
                      <option value="owner_equity">Owner Capital Contribution (Equity)</option>
                      {selectableAccounts.map((acc) => (
                        <option key={acc.accountId} value={acc.accountId}>
                          Paid via: {acc.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Status</label>
                    <select
                      value={newAssetStatus}
                      onChange={(e) => setNewAssetStatus(e.target.value as Asset['status'])}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    >
                      <option value="Active">Active</option>
                      <option value="Disposed">Disposed</option>
                      <option value="Written Off">Written Off</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Notes</label>
                    <input
                      type="text"
                      placeholder="Warranty, vendor, location..."
                      value={newAssetNotes}
                      onChange={(e) => setNewAssetNotes(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    />
                  </div>
                </div>

                {newAssetStatus === 'Disposed' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-amber-50 p-3 rounded-xl border border-amber-200">
                    <div>
                      <label className="block text-[10px] font-black uppercase text-amber-800 mb-1">Disposal Date</label>
                      <input
                        type="date"
                        value={newAssetDisposalDate}
                        onChange={(e) => setNewAssetDisposalDate(e.target.value)}
                        className="w-full bg-white border border-amber-300 rounded-lg px-2.5 py-1.5 text-xs font-bold"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-black uppercase text-amber-800 mb-1">
                        Disposal Proceeds ({settings.currency})
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={newAssetDisposalProceeds}
                        onChange={(e) => setNewAssetDisposalProceeds(e.target.value)}
                        className="w-full bg-white border border-amber-300 rounded-lg px-2.5 py-1.5 text-xs font-bold"
                      />
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={resetAssetForm}
                    className="px-4 py-2 border border-slate-300 text-slate-600 font-bold text-xs rounded-xl uppercase cursor-pointer hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl uppercase tracking-wider cursor-pointer shadow-xs"
                  >
                    {editingAssetId ? 'Update Asset Record' : 'Save Asset Record'}
                  </button>
                </div>
              </form>
            )}

            {/* STANDARDIZED CAPITAL EQUITY & DRAWINGS FORM */}
            {showEquityForm && (
              <form onSubmit={handleSaveEquity} className="bg-white p-5 rounded-2xl border-2 border-emerald-200 shadow-xs space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <h3 className="text-xs font-black text-emerald-900 uppercase tracking-wider">
                    {editingEquityId ? `EDIT CAPITAL EQUITY ENTRY (${editingEquityId})` : 'RECORD CAPITAL CONTRIBUTION OR OWNER DRAWINGS'}
                  </h3>
                  <span className="text-[11px] font-semibold text-slate-500">
                    {newEquityType.toLowerCase().includes('drawing')
                      ? 'Posts Financing Cash Outflow & reduces Owner Capital Equity'
                      : 'Posts Financing Cash Inflow & increases Owner Capital Equity'}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="lg:col-span-2">
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Description / Title *</label>
                    <input
                      type="text"
                      placeholder="e.g. Q2 Working Capital Injection or Owner Dividend Payout"
                      value={newEquityName}
                      onChange={(e) => setNewEquityName(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Equity Classification</label>
                    <select
                      value={newEquityType}
                      onChange={(e) => setNewEquityType(e.target.value as EquityEntry['equityType'])}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    >
                      {EQUITY_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Shareholder / Owner</label>
                    <input
                      type="text"
                      placeholder="e.g. Managing Director"
                      value={newEquityShareholder}
                      onChange={(e) => setNewEquityShareholder(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Amount ({settings.currency}) *</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder="0.00"
                      value={newEquityValue}
                      onChange={(e) => setNewEquityValue(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Settlement Account</label>
                    <select
                      value={newEquityAccountId}
                      onChange={(e) => setNewEquityAccountId(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    >
                      {selectableAccounts.map((acc) => (
                        <option key={acc.accountId} value={acc.accountId}>{acc.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Branch</label>
                    <select
                      value={newEquityStoreId}
                      onChange={(e) => setNewEquityStoreId(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    >
                      {storesList.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Transaction Date</label>
                    <input
                      type="date"
                      value={newEquityDate}
                      onChange={(e) => setNewEquityDate(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Reference No.</label>
                    <input
                      type="text"
                      placeholder="Bank / Resolution Ref"
                      value={newEquityReference}
                      onChange={(e) => setNewEquityReference(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    />
                  </div>
                  <div className="lg:col-span-3">
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Notes</label>
                    <input
                      type="text"
                      placeholder="Board resolution or capital memorandum notes..."
                      value={newEquityNotes}
                      onChange={(e) => setNewEquityNotes(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={resetEquityForm}
                    className="px-4 py-2 border border-slate-300 text-slate-600 font-bold text-xs rounded-xl uppercase cursor-pointer hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-xl uppercase tracking-wider cursor-pointer shadow-xs"
                  >
                    {editingEquityId ? 'Update Equity Entry' : 'Save Equity Entry'}
                  </button>
                </div>
              </form>
            )}

            {/* STANDARDIZED ASSETS TABLE */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest">
                  I. FIXED & CURRENT ASSETS REGISTER ({filteredAssets.length})
                </h3>
                <span className="text-[11px] font-bold text-slate-500">
                  Total Active NBV: {settings.currency}{registryMetrics.totalNbvActive.toFixed(2)}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 text-slate-600 uppercase font-black border-b border-slate-200">
                      <th className="p-3">Tag & Asset</th>
                      <th className="p-3">Class & Branch</th>
                      <th className="p-3">Acquired</th>
                      <th className="p-3">Depreciation</th>
                      <th className="p-3 text-right">Acq. Cost</th>
                      <th className="p-3 text-right">Net Book Value</th>
                      <th className="p-3">Funding</th>
                      <th className="p-3 text-center">Status</th>
                      <th className="p-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredAssets.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="p-6 text-center text-slate-400 font-medium italic">
                          No assets match the current filter. Click "Register Asset" to add fixed or current assets.
                        </td>
                      </tr>
                    ) : (
                      filteredAssets.map((ast) => {
                        const val = calculateAssetValuation(ast);
                        const fundingLabel =
                          ast.fundingSource === 'owner_equity'
                            ? 'Owner Equity'
                            : selectableAccounts.find((a) => a.accountId === ast.fundingSource)?.label || ast.fundingSource;
                        return (
                          <tr key={ast.id} className="hover:bg-slate-50 transition-colors">
                            <td className="p-3">
                              <div className="font-mono text-[10px] font-black text-indigo-700">{ast.assetTag}</div>
                              <div className="font-bold text-slate-900">{ast.name}</div>
                              {ast.serialNumber && (
                                <div className="text-[10px] text-slate-500 font-mono">S/N: {ast.serialNumber}</div>
                              )}
                            </td>
                            <td className="p-3">
                              <div className="font-bold text-slate-800">
                                {ast.category} • {ast.type}
                              </div>
                              <div className="text-[10px] text-slate-500">{getBranchLabel(ast.storeId)}</div>
                            </td>
                            <td className="p-3 font-mono text-slate-600">{ast.purchaseDate}</td>
                            <td className="p-3">
                              <div className="font-semibold text-slate-700">
                                {ast.depreciationMethod} ({ast.depreciationRate}%)
                              </div>
                              <div className="text-[10px] text-amber-700 font-mono">
                                Accum: -{settings.currency}{val.accumulatedDepreciation.toFixed(2)}
                              </div>
                            </td>
                            <td className="p-3 text-right font-mono font-bold text-slate-800">
                              {settings.currency}{val.cost.toFixed(2)}
                            </td>
                            <td className="p-3 text-right font-mono font-black text-indigo-700">
                              {settings.currency}{val.netBookValue.toFixed(2)}
                            </td>
                            <td className="p-3 text-[11px] font-semibold text-slate-600">{fundingLabel}</td>
                            <td className="p-3 text-center">
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase border ${
                                  ast.status === 'Active'
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                    : ast.status === 'Disposed'
                                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                                      : 'bg-rose-50 text-rose-700 border-rose-200'
                                }`}
                              >
                                {ast.status}
                              </span>
                            </td>
                            <td className="p-3">
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  type="button"
                                  title="Edit Asset"
                                  onClick={() => openEditAsset(ast)}
                                  className="p-1.5 rounded-lg bg-slate-100 hover:bg-indigo-100 text-slate-600 hover:text-indigo-700 cursor-pointer"
                                >
                                  <Edit3 size={13} />
                                </button>
                                {ast.status === 'Active' && (
                                  <>
                                    <button
                                      type="button"
                                      title="Dispose Asset"
                                      onClick={() => {
                                        setDisposingAsset(ast);
                                        setDisposeModalDate(new Date().toISOString().split('T')[0]);
                                        setDisposeModalProceeds('0');
                                      }}
                                      className="p-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 cursor-pointer"
                                    >
                                      <DollarSign size={13} />
                                    </button>
                                    <button
                                      type="button"
                                      title="Write Off Asset"
                                      onClick={() => handleWriteOffAsset(ast)}
                                      className="p-1.5 rounded-lg bg-slate-100 hover:bg-rose-100 text-slate-600 hover:text-rose-700 cursor-pointer"
                                    >
                                      <Ban size={13} />
                                    </button>
                                  </>
                                )}
                                <button
                                  type="button"
                                  title="Delete Asset"
                                  onClick={() => handleDeleteAsset(ast)}
                                  className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 cursor-pointer"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* STANDARDIZED CAPITAL EQUITY & DRAWINGS TABLE */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest">
                  II. CAPITAL EQUITY & OWNER DRAWINGS LEDGER ({filteredEquity.length})
                </h3>
                <span className="text-[11px] font-bold text-emerald-700">
                  Net Contributed Equity: {settings.currency}{registryMetrics.netContributedEquity.toFixed(2)}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 text-slate-600 uppercase font-black border-b border-slate-200">
                      <th className="p-3">Equity ID</th>
                      <th className="p-3">Description & Ref</th>
                      <th className="p-3">Type</th>
                      <th className="p-3">Shareholder / Branch</th>
                      <th className="p-3">Date</th>
                      <th className="p-3">Account</th>
                      <th className="p-3 text-right">Amount</th>
                      <th className="p-3 text-center">Status</th>
                      <th className="p-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredEquity.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="p-6 text-center text-slate-400 font-medium italic">
                          No equity contributions or drawings recorded yet. Click "Record Equity / Drawings" to add one.
                        </td>
                      </tr>
                    ) : (
                      filteredEquity.map((eq) => {
                        const isDraw =
                          eq.equityType.toLowerCase().includes('drawing') ||
                          eq.equityType.toLowerCase().includes('dividend');
                        const accLabel =
                          eq.accountId === 'acc_owner_capital'
                            ? 'Asset Capitalization'
                            : selectableAccounts.find((a) => a.accountId === eq.accountId)?.label || eq.accountId;
                        return (
                          <tr key={eq.id} className="hover:bg-slate-50 transition-colors">
                            <td className="p-3 font-mono font-bold text-slate-700">
                              {eq.id}
                              {eq.linkedAssetId && (
                                <div className="text-[10px] text-indigo-600 font-semibold">Linked: {eq.linkedAssetId}</div>
                              )}
                            </td>
                            <td className="p-3">
                              <div className="font-bold text-slate-900">{eq.name}</div>
                              {eq.referenceNo && (
                                <div className="text-[10px] text-slate-500 font-mono">Ref: {eq.referenceNo}</div>
                              )}
                            </td>
                            <td className="p-3">
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase border ${
                                  isDraw
                                    ? 'bg-rose-50 text-rose-700 border-rose-200'
                                    : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                }`}
                              >
                                {eq.equityType}
                              </span>
                            </td>
                            <td className="p-3">
                              <div className="font-semibold text-slate-800">{eq.shareholderName || 'Owner'}</div>
                              <div className="text-[10px] text-slate-500">{getBranchLabel(eq.storeId)}</div>
                            </td>
                            <td className="p-3 font-mono text-slate-600">{eq.contributionDate}</td>
                            <td className="p-3 text-[11px] font-semibold text-slate-600">{accLabel}</td>
                            <td
                              className={`p-3 text-right font-mono font-black ${
                                eq.status === 'Reversed'
                                  ? 'text-slate-400 line-through'
                                  : isDraw
                                    ? 'text-rose-600'
                                    : 'text-emerald-700'
                              }`}
                            >
                              {isDraw ? '-' : '+'}{settings.currency}{eq.value.toFixed(2)}
                            </td>
                            <td className="p-3 text-center">
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase border ${
                                  eq.status === 'Reversed'
                                    ? 'bg-slate-100 text-slate-600 border-slate-300'
                                    : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                }`}
                              >
                                {eq.status}
                              </span>
                            </td>
                            <td className="p-3">
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  type="button"
                                  title="Edit Equity Entry"
                                  onClick={() => openEditEquity(eq)}
                                  className="p-1.5 rounded-lg bg-slate-100 hover:bg-indigo-100 text-slate-600 hover:text-indigo-700 cursor-pointer"
                                >
                                  <Edit3 size={13} />
                                </button>
                                <button
                                  type="button"
                                  title={eq.status === 'Reversed' ? 'Restore Entry' : 'Reverse Entry'}
                                  onClick={() => handleToggleReverseEquity(eq)}
                                  className="p-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 cursor-pointer"
                                >
                                  <RefreshCw size={13} />
                                </button>
                                <button
                                  type="button"
                                  title="Delete Equity Entry"
                                  onClick={() => handleDeleteEquity(eq)}
                                  className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 cursor-pointer"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* CAPITAL EQUITY RECONCILIATION SUMMARY */}
            <div className="bg-slate-900 text-white p-5 rounded-2xl shadow-xs grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
              <div>
                <span className="text-[10px] font-black uppercase text-slate-400 block">Paid-In & Asset Capital</span>
                <span className="text-lg font-black text-emerald-400 mt-1 block">
                  {settings.currency}{registryMetrics.contributedCapital.toFixed(2)}
                </span>
              </div>
              <div>
                <span className="text-[10px] font-black uppercase text-slate-400 block">Less: Owner Drawings / Dividends</span>
                <span className="text-lg font-black text-rose-400 mt-1 block">
                  -{settings.currency}{registryMetrics.drawingsTotal.toFixed(2)}
                </span>
              </div>
              <div>
                <span className="text-[10px] font-black uppercase text-slate-400 block">Retained Earnings (Net Accum.)</span>
                <span className="text-lg font-black text-indigo-300 mt-1 block">
                  {settings.currency}{financials.retainedEarnings.toFixed(2)}
                </span>
              </div>
              <div>
                <span className="text-[10px] font-black uppercase text-slate-400 block">Balance Sheet Total Equity (A − L)</span>
                <span className="text-lg font-black text-white mt-1 block">
                  {settings.currency}{financials.totalEquityVal.toFixed(2)}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
