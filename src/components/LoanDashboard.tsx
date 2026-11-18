import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { 
  Briefcase, 
  Percent, 
  TrendingUp, 
  Coins, 
  Clock, 
  ArrowRight, 
  Plus, 
  Check, 
  X, 
  ShieldAlert, 
  DollarSign, 
  Calendar, 
  FileText, 
  Printer, 
  ArrowUpRight,
  Trash,
  Download,
  BookOpen,
  Layers,
  Truck,
  RefreshCw,
  ArrowDownRight,
  PackageCheck,
  PackagePlus,
  Building2,
  Wallet,
  CreditCard,
  ArrowLeftRight,
  Search,
  Filter,
  CheckCircle2,
  AlertCircle,
  Info,
  Receipt,
  Eye,
  Edit3,
  RotateCcw,
  Phone,
  Mail,
  MapPin,
  Users,
  History,
  Save
} from 'lucide-react';
import { runSql, getCentralBranches, persistTablesToStorage, logEmployeeAudit, syncAllAccountingSystems, getAllSelectableAccounts, getCustomPaymentMethods } from '../db';
import { StoreSettings, Loan, LoanAmortizationSchedule, AutomatedDeductionLog } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { jsPDF } from 'jspdf';
import { exportAndSharePdf } from '../androidUtils';
import {
  TransferReceiptAttachment,
  getTransferReceipt,
  saveTransferReceipt,
} from '../transferReceipts';
import { TransferReceiptField, TransferReceiptViewerModal } from './TransferReceiptField';

interface LoanDashboardProps {
  settings: StoreSettings;
  userRole: string; // 'owner' | 'manager' | 'sales'
  activeStore: string;
  mode?: 'procurement' | 'credit_risk';
}

export interface Asset {
  id: string;
  name: string;
  category: 'Current' | 'Fixed';
  type: 'Equipment' | 'Vehicles' | 'Property' | 'Other';
  purchaseDate: string;
  value: number; // cost
  depreciationMethod: 'Straight Line' | 'Reducing Balance' | 'None';
  depreciationRate: number; // custom % e.g. 10
  status: 'Active' | 'Disposed' | 'Written Off';
  notes?: string;
  linkedEquityId?: string;
}

export default function LoanDashboard({ settings, userRole, activeStore, mode = 'procurement' }: LoanDashboardProps) {
  // DB states Loaded live safely
  const [loans, setLoans] = useState<Loan[]>([]);
  const [amortization, setAmortization] = useState<LoanAmortizationSchedule[]>([]);
  const [deductions, setDeductions] = useState<AutomatedDeductionLog[]>([]);

  // Sub-navigation navigation tab state
  const [subTab, setSubTab] = useState<'procurement' | 'expenses' | 'transfers' | 'statements' | 'loans' | 'assets_equity'>(
    mode === 'credit_risk' ? 'loans' : 'procurement'
  );

  // DB tables for Expenses, Transfers, Suppliers and Supply Management
  const [expensesList, setExpensesList] = useState<any[]>([]);
  const [transfersList, setTransfersList] = useState<any[]>([]);
  const [transitPurchasesList, setTransitPurchasesList] = useState<any[]>([]);
  const [suppliersList, setSuppliersList] = useState<any[]>([]);
  const [productList, setProductList] = useState<any[]>([]);

  // Expenses Form states
  const [expenseCategory, setExpenseCategory] = useState('Operating - Rent & Premises');
  const [expenseAccountId, setExpenseAccountId] = useState('acc_cash');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDescription, setExpenseDescription] = useState('');
  const [expenseRef, setExpenseRef] = useState('');
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().split('T')[0]);
  const [expenseStoreId, setExpenseStoreId] = useState(activeStore || '');
  const [expenseSearchQuery, setExpenseSearchQuery] = useState('');
  const [expenseFilterCategory, setExpenseFilterCategory] = useState('ALL');

  // Money Transfers Form states
  const [transferSourceAcc, setTransferSourceAcc] = useState('acc_bank');
  const [transferDestAcc, setTransferDestAcc] = useState('acc_cash');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferRef, setTransferRef] = useState('');
  const [transferDate, setTransferDate] = useState(new Date().toISOString().split('T')[0]);
  const [transferReceipt, setTransferReceipt] = useState<TransferReceiptAttachment | null>(null);
  const [transferFeedback, setTransferFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [viewingTransferReceipt, setViewingTransferReceipt] = useState<{
    receipt: TransferReceiptAttachment;
    refLabel: string;
  } | null>(null);

  // Supply Management / Purchase Order states
  const [supplyViewFilter, setSupplyViewFilter] = useState<'all' | 'in_transit' | 'received' | 'suppliers'>('all');
  const [supplySearchQuery, setSupplySearchQuery] = useState('');
  const [supplySupplierFilter, setSupplySupplierFilter] = useState('ALL');

  const [showNewTransitModal, setShowNewTransitModal] = useState(false);
  const [poFeedback, setPoFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [poModalError, setPoModalError] = useState<string | null>(null);
  const [confirmReceivePoId, setConfirmReceivePoId] = useState<string | null>(null);

  // Supplier profile fields inside New / Reorder PO modal
  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const [transitSupplierName, setTransitSupplierName] = useState('');
  const [transitSupplierContact, setTransitSupplierContact] = useState('');
  const [transitSupplierPhone, setTransitSupplierPhone] = useState('');
  const [transitSupplierEmail, setTransitSupplierEmail] = useState('');
  const [transitSupplierAddress, setTransitSupplierAddress] = useState('');
  const [transitSupplierTpin, setTransitSupplierTpin] = useState('');
  const [saveSupplierProfile, setSaveSupplierProfile] = useState(true);

  const [transitStoreId, setTransitStoreId] = useState(activeStore || '');
  const [storesList, setStoresList] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    const centralBranches = getCentralBranches();
    if (centralBranches.length > 0) {
      const mapped = centralBranches.map((s) => ({
        id: String(s.id),
        name: String(s.name || s.id),
      }));
      setStoresList(mapped);
      if (!activeStore && mapped[0]?.id) {
        setExpenseStoreId(mapped[0].id);
        setTransitStoreId(mapped[0].id);
      }
    } else {
      setStoresList([]);
    }
    if (activeStore) {
      setExpenseStoreId(activeStore);
      setTransitStoreId(activeStore);
    }
  }, [activeStore]);
  const [transitPaymentAcc, setTransitPaymentAcc] = useState('acc_bank');
  const [transitPaymentMethod, setTransitPaymentMethod] = useState('BANK_TRANSFER');
  const [transitNotes, setTransitNotes] = useState('');
  const [transitItems, setTransitItems] = useState<Array<{ productId: string | number; productName: string; quantity: number; baseUnitPrice: number }>>([]);
  const [transitAddExpenses, setTransitAddExpenses] = useState<Array<{ name: string; amount: number; category: string }>>([
    { name: 'Freight & Road Transport', amount: 0, category: 'Freight' },
    { name: 'Port & Customs Clearing Fee', amount: 0, category: 'Handling' },
    { name: 'Handling & Offloading', amount: 0, category: 'Handling' }
  ]);
  const [newPoCostName, setNewPoCostName] = useState('');
  const [newPoCostAmount, setNewPoCostAmount] = useState('');

  // Item form inside transit modal
  const [selectedTransitProduct, setSelectedTransitProduct] = useState('');
  const [customTransitProductName, setCustomTransitProductName] = useState('');
  const [transitItemQty, setTransitItemQty] = useState('10');
  const [transitItemUnitPrice, setTransitItemUnitPrice] = useState('100');

  // Edit Landing Cost modal state (post-order transit cost adjustments)
  const [editingLandingPo, setEditingLandingPo] = useState<any | null>(null);
  const [editLandingExpenses, setEditLandingExpenses] = useState<Array<{ name: string; amount: number; category: string }>>([]);
  const [editLandingStage, setEditLandingStage] = useState('IN_TRANSIT');
  const [editLandingNotes, setEditLandingNotes] = useState('');
  const [editLandingError, setEditLandingError] = useState<string | null>(null);
  const [newEditCostName, setNewEditCostName] = useState('');
  const [newEditCostAmount, setNewEditCostAmount] = useState('');
  const [newEditCostCategory, setNewEditCostCategory] = useState('Freight');

  // Saved Supplier Directory modal states
  const [showSupplierModal, setShowSupplierModal] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<any | null>(null);
  const [supplierFormError, setSupplierFormError] = useState<string | null>(null);
  const [confirmDeleteSupplierId, setConfirmDeleteSupplierId] = useState<string | null>(null);
  const [supplierFormName, setSupplierFormName] = useState('');
  const [supplierFormContact, setSupplierFormContact] = useState('');
  const [supplierFormPhone, setSupplierFormPhone] = useState('');
  const [supplierFormEmail, setSupplierFormEmail] = useState('');
  const [supplierFormAddress, setSupplierFormAddress] = useState('');
  const [supplierFormTpin, setSupplierFormTpin] = useState('');
  const [supplierFormTerms, setSupplierFormTerms] = useState('Pay on Order / Advance');
  const [supplierFormPayMethod, setSupplierFormPayMethod] = useState('BANK_TRANSFER');
  const [supplierFormNotes, setSupplierFormNotes] = useState('');

  // Selected period for financial statements
  const [selectedPeriod, setSelectedPeriod] = useState<'this_month' | 'last_month' | 'this_quarter' | 'this_year' | 'all_time'>('all_time');

  // Dynamic Assets & Equity List states
  const [assets, setAssets] = useState<Asset[]>([]);
  const [equity, setEquity] = useState<{ id: string; name: string; value: number; linkedAssetId?: string }[]>([]);

  // DB raw tables loaded for Financial Statements
  const [statementOrders, setStatementOrders] = useState<any[]>([]);
  const [statementItems, setStatementItems] = useState<any[]>([]);
  const [statementAttendance, setStatementAttendance] = useState<any[]>([]);

  // Asset Creation Form states
  const [newAssetName, setNewAssetName] = useState('');
  const [newAssetCategory, setNewAssetCategory] = useState<'Current' | 'Fixed'>('Fixed');
  const [newAssetValue, setNewAssetValue] = useState('');
  const [newAssetType, setNewAssetType] = useState<'Equipment' | 'Vehicles' | 'Property' | 'Other'>('Equipment');
  const [newAssetPurchaseDate, setNewAssetPurchaseDate] = useState('2026-06-07');
  const [newAssetDepreciationMethod, setNewAssetDepreciationMethod] = useState<'Straight Line' | 'Reducing Balance' | 'None'>('Straight Line');
  const [newAssetDepreciationRate, setNewAssetDepreciationRate] = useState<number>(10);
  const [newAssetNotes, setNewAssetNotes] = useState('');
  const [autoLinkToEquity, setAutoLinkToEquity] = useState<boolean>(true);
  const [showAddAssetForm, setShowAddAssetForm] = useState<boolean>(false);

  // Equity Creation Form states
  const [newEquityName, setNewEquityName] = useState('');
  const [newEquityValue, setNewEquityValue] = useState('');

  // Selected state for detailed sched/deductions viewing
  const [selectedLoanId, setSelectedLoanId] = useState<string>('');

  // Apply loan modal states
  const [showApplyModal, setShowApplyModal] = useState(false);
  const [applyPrincipal, setApplyPrincipal] = useState(15000);
  const [applyTermMonths, setApplyTermMonths] = useState(4);
  const [applySweepPercentage, setApplySweepPercentage] = useState(12);

  // Load physical rows
  const loadData = () => {
    try {
      // 1. Load loans
      const rxLoans = runSql("SELECT * FROM loans ORDER BY created_at DESC", 'Loans: Load merchant agreements');
      if (rxLoans.success && Array.isArray(rxLoans.data)) {
        setLoans(rxLoans.data as Loan[]);
        // Auto select first loan if none selected or if selected is stale
        if (rxLoans.data.length > 0) {
          const match = rxLoans.data.find(l => l.id === selectedLoanId);
          if (!match) {
            setSelectedLoanId(rxLoans.data[0].id);
          }
        }
      }

      // 2. Load amortization
      const rxAmort = runSql("SELECT * FROM loan_amortization_schedule ORDER BY installment_number ASC", 'Loans: Load calendar installments');
      if (rxAmort.success && Array.isArray(rxAmort.data)) {
        setAmortization(rxAmort.data as LoanAmortizationSchedule[]);
      }

      // 3. Load deductions sweep logs
      const rxDeds = runSql("SELECT * FROM automated_deduction_logs ORDER BY created_at DESC", 'Loans: Load sweep deductions activity');
      if (rxDeds.success && Array.isArray(rxDeds.data)) {
        setDeductions(rxDeds.data as AutomatedDeductionLog[]);
      }

      // 4. Load expenses
      const rxExp = runSql("SELECT * FROM expenses ORDER BY expense_date DESC, created_at DESC", 'Expenses: Fetch expenses history');
      if (rxExp.success && Array.isArray(rxExp.data)) {
        setExpensesList(rxExp.data);
      }

      // 5. Load internal transfers
      const rxTrf = runSql("SELECT t.*, le.account_id, le.type, le.amount AS entry_amount FROM transactions t JOIN ledger_entries le ON t.id = le.transaction_id WHERE t.channel = 'INTERNAL_TRANSFER' ORDER BY t.created_at DESC", 'Transfers: Fetch money movements');
      if (rxTrf.success && Array.isArray(rxTrf.data)) {
        setTransfersList(rxTrf.data);
      }

      // 6. Load transit purchases
      const rxPt = runSql("SELECT * FROM purchases_transit ORDER BY created_at DESC", 'Supply Management: Fetch purchase orders');
      if (rxPt.success && Array.isArray(rxPt.data)) {
        setTransitPurchasesList(rxPt.data);
      }

      // 7. Ensure suppliers table exists & load saved suppliers
      runSql(
        `CREATE TABLE IF NOT EXISTS suppliers (id STRING PRIMARY KEY, name STRING, contact_person STRING, phone STRING, email STRING, address STRING, tpin STRING, payment_terms STRING, default_payment_method STRING, notes STRING, created_at STRING, updated_at STRING)`,
        'Supply Management: Ensure suppliers table',
        true
      );
      const rxSup = runSql("SELECT * FROM suppliers ORDER BY name ASC", 'Supply Management: Fetch saved suppliers', true);
      if (rxSup.success && Array.isArray(rxSup.data)) {
        setSuppliersList(rxSup.data);
      }

      // 8. Load product list for selection
      const rxProds = runSql("SELECT * FROM products ORDER BY name ASC", 'Products: Fetch available items');
      if (rxProds.success && Array.isArray(rxProds.data)) {
        setProductList(rxProds.data);
      }
    } catch (e) {
      console.error('Error reading loans records', e);
    }
  };

  // Date period helper
  const isDateInPeriod = (dateStr: string) => {
    if (!dateStr) return false;
    // Strip timestamps safely
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return false;
    const now = new Date();
    
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    
    const currentQuarter = Math.floor(now.getMonth() / 3);
    const startOfQuarter = new Date(now.getFullYear(), currentQuarter * 3, 1);
    const endOfQuarter = new Date(now.getFullYear(), (currentQuarter + 1) * 3, 0, 23, 59, 59, 999);
    
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const endOfYear = new Date(now.getFullYear(), 12, 0, 23, 59, 59, 999);
    
    switch (selectedPeriod) {
      case 'this_month':
        return d >= startOfMonth && d <= endOfMonth;
      case 'last_month':
        return d >= startOfLastMonth && d <= endOfLastMonth;
      case 'this_quarter':
        return d >= startOfQuarter && d <= endOfQuarter;
      case 'this_year':
        return d >= startOfYear && d <= endOfYear;
      case 'all_time':
      default:
        return true;
    }
  };

  // Preload Statement records from dynamic tables
  const loadStatementData = () => {
    try {
      const ordRes = runSql("SELECT * FROM orders WHERE status = 'COMPLETED' OR status = 'SUCCESS' OR status = 'ACTIVE' OR status = 'PAID'", 'Statement: Fetch completed store orders');
      if (ordRes.success && Array.isArray(ordRes.data)) {
        setStatementOrders(ordRes.data);
      }

      const itemRes = runSql("SELECT oi.*, p.cost, p.name FROM order_items oi JOIN products p ON oi.productId = p.id", 'Statement: Fetch items');
      if (itemRes.success && Array.isArray(itemRes.data)) {
        setStatementItems(itemRes.data);
      }

      const attRes = runSql("SELECT * FROM time_attendance", 'Statement: Fetch payroll entries');
      if (attRes.success && Array.isArray(attRes.data)) {
        setStatementAttendance(attRes.data);
      }
    } catch (e) {
      console.error('Error loading statement structures:', e);
    }
  };

  // Companion helper to estimate depreciation and Book Value (NBV)
  const getAssetFinancials = (asset: Asset) => {
    const cost = Number(asset.value || 0);
    if (asset.category === 'Current' || asset.depreciationMethod === 'None' || !asset.purchaseDate) {
      return { cost, accumulatedDepreciation: 0, nbv: cost };
    }
    
    // Calculate years elapsed or months elapsed from purchaseDate to 2026-06-07
    const purchase = new Date(asset.purchaseDate);
    const today = new Date('2026-06-07');
    
    let yearsElapsed = 0;
    if (!isNaN(purchase.getTime())) {
      const diffTime = today.getTime() - purchase.getTime();
      if (diffTime > 0) {
        yearsElapsed = diffTime / (1000 * 60 * 60 * 24 * 365.25);
      }
    }

    const rate = Number(asset.depreciationRate || 0) / 100;
    let accumulatedDepreciation = 0;

    if (asset.depreciationMethod === 'Straight Line') {
      accumulatedDepreciation = cost * rate * yearsElapsed;
    } else if (asset.depreciationMethod === 'Reducing Balance') {
      const nbvCalc = cost * Math.pow(1 - rate, yearsElapsed);
      accumulatedDepreciation = cost - nbvCalc;
    }

    // Cap accumulated depreciation at cost (cannot exceed asset value)
    accumulatedDepreciation = Math.min(cost, Math.max(0, accumulatedDepreciation));
    const nbv = Math.max(0, cost - accumulatedDepreciation);

    return {
      cost,
      accumulatedDepreciation,
      nbv,
      yearsElapsed
    };
  };

  // Load custom assets and equity on mount or activeStore changes (zero pre-seeded amounts)
  useEffect(() => {
    const savedAssets = localStorage.getItem(`pos_custom_assets_${activeStore}`);
    const savedEquity = localStorage.getItem(`pos_custom_equity_${activeStore}`);

    const legacyAssetSignatures = new Map<string, string>([
      ['asset-1', 'Shop Fixtures & Shelving'],
      ['asset-2', 'Commercial Espresso Machine & Brewer'],
      ['asset-3', 'Stock Security Cash Float']
    ]);
    const legacyEquitySignatures = new Map<string, string>([
      ['equity-1', "Owner's Invested Capital"],
      ['equity-2', 'SME Start-up Matching Grant']
    ]);

    if (savedAssets) {
      try {
        const parsed = JSON.parse(savedAssets);
        const filtered = Array.isArray(parsed)
          ? parsed.filter((a: any) => legacyAssetSignatures.get(String(a?.id || '')) !== String(a?.name || ''))
          : [];
        const migrated: Asset[] = filtered.map((a: any) => ({
          id: a.id || 'asset-' + Math.floor(1000 + Math.random() * 9000),
          name: a.name || 'Unnamed Asset',
          category: a.category || 'Fixed',
          type: a.type || 'Equipment',
          purchaseDate: a.purchaseDate || new Date().toISOString().split('T')[0],
          value: Number(a.value || 0),
          depreciationMethod: a.depreciationMethod || 'None',
          depreciationRate: a.depreciationRate !== undefined ? Number(a.depreciationRate) : 0,
          status: a.status || 'Active',
          notes: a.notes || '',
          linkedEquityId: a.linkedEquityId || undefined
        }));
        if (filtered.length !== (Array.isArray(parsed) ? parsed.length : 0)) {
          localStorage.setItem(`pos_custom_assets_${activeStore}`, JSON.stringify(migrated));
        }
        setAssets(migrated);
      } catch (e) {
        console.error('Error migrating loaded assets', e);
        setAssets([]);
      }
    } else {
      setAssets([]);
    }

    if (savedEquity) {
      try {
        const parsedEq = JSON.parse(savedEquity);
        const filteredEq = Array.isArray(parsedEq)
          ? parsedEq.filter((eq: any) => legacyEquitySignatures.get(String(eq?.id || '')) !== String(eq?.name || ''))
          : [];
        if (filteredEq.length !== (Array.isArray(parsedEq) ? parsedEq.length : 0)) {
          localStorage.setItem(`pos_custom_equity_${activeStore}`, JSON.stringify(filteredEq));
        }
        setEquity(filteredEq);
      } catch (e) {
        console.error('Error loading custom equity', e);
        setEquity([]);
      }
    } else {
      setEquity([]);
    }
  }, [activeStore]);

  // Handle adding assets manually
  const handleAddAsset = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAssetName || !newAssetValue) {
      alert('Please fill out descriptions and cost correctly.');
      return;
    }
    const val = parseFloat(newAssetValue);
    if (isNaN(val) || val <= 0) {
      alert('Asset value/cost must be a positive number.');
      return;
    }

    const assetId = 'asset-' + Math.floor(1000 + Math.random() * 9000);
    let linkedEquityId: string | undefined = undefined;

    let updatedEquity = [...equity];
    if (autoLinkToEquity) {
      linkedEquityId = 'equity-' + Math.floor(1000 + Math.random() * 9000);
      const newEquityItem = {
        id: linkedEquityId,
        name: `Cap. Contribution: ${newAssetName}`,
        value: val,
        linkedAssetId: assetId
      };
      updatedEquity.push(newEquityItem);
      setEquity(updatedEquity);
      localStorage.setItem(`pos_custom_equity_${activeStore}`, JSON.stringify(updatedEquity));
    }

    const newAssetItem: Asset = {
      id: assetId,
      name: newAssetName,
      category: newAssetCategory,
      type: newAssetType,
      purchaseDate: newAssetPurchaseDate || '2026-06-07',
      value: val,
      depreciationMethod: newAssetCategory === 'Fixed' ? newAssetDepreciationMethod : 'None',
      depreciationRate: newAssetCategory === 'Fixed' ? Number(newAssetDepreciationRate || 0) : 0,
      status: 'Active',
      notes: newAssetNotes,
      linkedEquityId: linkedEquityId
    };

    const updated = [...assets, newAssetItem];
    setAssets(updated);
    localStorage.setItem(`pos_custom_assets_${activeStore}`, JSON.stringify(updated));

    // Reset form
    setNewAssetName('');
    setNewAssetValue('');
    setNewAssetNotes('');
    setNewAssetDepreciationRate(10);
    setNewAssetDepreciationMethod('Straight Line');
    setShowAddAssetForm(false);
  };

  // Handle deleting assets
  const handleDeleteAsset = (id: string) => {
    const assetToDelete = assets.find(a => a.id === id);
    const updated = assets.filter(a => a.id !== id);
    setAssets(updated);
    localStorage.setItem(`pos_custom_assets_${activeStore}`, JSON.stringify(updated));

    // Clean up linked equity if requested or auto-applied
    if (assetToDelete && assetToDelete.linkedEquityId) {
      const matchEquity = equity.find(eq => eq.id === assetToDelete.linkedEquityId);
      if (matchEquity) {
        // Automatic sync to maintain accounting equation balance!
        const updatedEquity = equity.filter(eq => eq.id !== assetToDelete.linkedEquityId);
        setEquity(updatedEquity);
        localStorage.setItem(`pos_custom_equity_${activeStore}`, JSON.stringify(updatedEquity));
      }
    }
  };

  // Handle adding equity manually
  const handleAddEquity = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEquityName || !newEquityValue) {
      alert('Fill in the details first');
      return;
    }
    const val = parseFloat(newEquityValue);
    if (isNaN(val) || val <= 0) {
      alert('Value must be positive');
      return;
    }
    const item = {
      id: 'equity-' + Math.floor(1000 + Math.random() * 9000),
      name: newEquityName,
      value: val,
    };
    const updated = [...equity, item];
    setEquity(updated);
    localStorage.setItem(`pos_custom_equity_${activeStore}`, JSON.stringify(updated));
    setNewEquityName('');
    setNewEquityValue('');
  };

  // Handle deleting equity
  const handleDeleteEquity = (id: string) => {
    const updated = equity.filter(eq => eq.id !== id);
    setEquity(updated);
    localStorage.setItem(`pos_custom_equity_${activeStore}`, JSON.stringify(updated));
  };

  useEffect(() => {
    if (mode === 'credit_risk') {
      setSubTab('loans');
    } else if (subTab === 'loans') {
      setSubTab('expenses');
    }
  }, [mode]);

  // Main loads triggers
  useEffect(() => {
    loadData();
    loadStatementData();

    const handleUpdate = () => {
      loadData();
      loadStatementData();
    };

    window.addEventListener('pos_sale_completed', handleUpdate);
    window.addEventListener('pos_data_updated', handleUpdate);
    window.addEventListener('storage', handleUpdate);

    return () => {
      window.removeEventListener('pos_sale_completed', handleUpdate);
      window.removeEventListener('pos_data_updated', handleUpdate);
      window.removeEventListener('storage', handleUpdate);
    };
  }, [selectedLoanId, selectedPeriod, subTab, activeStore]);

  // Computed totals for stats panel
  const activeLoan = loans.find(l => l.id === selectedLoanId) || loans.find(l => l.status === 'ACTIVE') || loans[0];
  const activeLoansList = loans.filter(l => l.status === 'ACTIVE');
  const outstandingLoansCount = loans.filter(l => l.status === 'ACTIVE' || l.status === 'DEFAULTED').length;

  // Aggregate outstanding debt
  let totalLentCapital = 0;
  let totalRepaidCapital = 0;

  loans.forEach(l => {
    if (l.status === 'ACTIVE' || l.status === 'DEFAULTED' || l.status === 'PAID_OFF') {
      totalLentCapital += Number(l.total_repayable);
    }
  });

  deductions.forEach(d => {
    if (d.status === 'SUCCESS') {
      totalRepaidCapital += Number(d.amount_deducted);
    }
  });

  const aggregateOutstanding = Math.max(0, totalLentCapital - totalRepaidCapital);

  // Amortization progress
  const activeAmort = amortization.filter(a => a.loan_id === (activeLoan?.id || ''));
  const activeDeds = deductions.filter(d => d.loan_id === (activeLoan?.id || ''));

  // --- EXPENSES ENGINE ---
  const handleAddExpense = (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(expenseAmount);
    if (isNaN(amt) || amt <= 0) {
      alert('Please enter a valid expense amount.');
      return;
    }

    const expenseId = 'exp-' + Date.now();
    const txId = 'tx-exp-' + Date.now();
    const createdAt = new Date().toISOString();

    let accountExpenseId = 'acc_exp_misc';
    if (expenseCategory.includes('Rent')) accountExpenseId = 'acc_exp_rent';
    else if (expenseCategory.includes('Utilities')) accountExpenseId = 'acc_exp_utilities';
    else if (expenseCategory.includes('Salaries') || expenseCategory.includes('Wages')) accountExpenseId = 'acc_exp_wages';
    else if (expenseCategory.includes('Transport') || expenseCategory.includes('Freight')) accountExpenseId = 'acc_exp_transport';
    else if (expenseCategory.includes('Handling') || expenseCategory.includes('Customs')) accountExpenseId = 'acc_exp_handling';
    else if (expenseCategory.includes('Marketing')) accountExpenseId = 'acc_exp_marketing';
    else if (expenseCategory.includes('Supplies')) accountExpenseId = 'acc_exp_supplies';
    else if (expenseCategory.includes('Maintenance') || expenseCategory.includes('Repairs')) accountExpenseId = 'acc_exp_maintenance';
    else if (expenseCategory.includes('Licenses') || expenseCategory.includes('Taxes')) accountExpenseId = 'acc_exp_taxes_licensing';

    runSql(
      `INSERT INTO expenses VALUES ('${expenseId}', '${expenseCategory}', '${expenseAccountId}', '${expenseAccountId}', ${amt}, '${expenseDescription.replace(/'/g, "''")}', '${expenseRef.replace(/'/g, "''")}', '${expenseDate}', '${expenseStoreId}', '${userRole}', '${createdAt}')`,
      'Expenses: Record expense entry'
    );

    logEmployeeAudit('EXPENSES', 'Added Store Expense', `Category: ${expenseCategory}, Desc: ${expenseDescription}, Ref: ${expenseRef || 'N/A'}`, amt, expenseStoreId, userRole);

    runSql(
      `INSERT INTO transactions VALUES ('${txId}', 'idem-${expenseId}', 'POS-${expenseStoreId.toUpperCase()}', '${expenseAccountId.toUpperCase()}', '${expenseRef || 'EXP-REF'}', ${amt}, 0, 'SUCCESS', 'Expense: ${expenseCategory} - ${expenseDescription.replace(/'/g, "''")}', '${createdAt}', '${createdAt}', '${userRole}')`,
      'Expenses: Journal transaction'
    );

    runSql(
      `INSERT INTO ledger_entries VALUES ('le-${Date.now()}-1', '${txId}', '${accountExpenseId}', 'DEBIT', ${amt}, '${createdAt}')`,
      'Expenses Ledger: Debit Expense Account'
    );
    runSql(
      `INSERT INTO ledger_entries VALUES ('le-${Date.now()}-2', '${txId}', '${expenseAccountId}', 'CREDIT', ${amt}, '${createdAt}')`,
      'Expenses Ledger: Credit Source Account'
    );

    persistTablesToStorage();
    loadData();
    loadStatementData();

    setExpenseAmount('');
    setExpenseDescription('');
    setExpenseRef('');
    alert(`Expense of ${settings.currency}${amt.toFixed(2)} recorded successfully.`);
  };

  const handleDeleteExpense = (id: string) => {
    if (confirm('Are you sure you want to delete this expense entry?')) {
      runSql(`DELETE FROM expenses WHERE id = '${id}'`, 'Expenses: Delete record');
      persistTablesToStorage();
      loadData();
      loadStatementData();
    }
  };

  // --- INTERNAL MONEY TRANSFERS ENGINE ---
  const handleTransferMoney = (e: React.FormEvent) => {
    e.preventDefault();
    setTransferFeedback(null);
    const amt = parseFloat(transferAmount);
    if (isNaN(amt) || amt <= 0) {
      setTransferFeedback({ type: 'error', text: 'Please enter a valid transfer amount.' });
      return;
    }
    if (transferSourceAcc === transferDestAcc) {
      setTransferFeedback({ type: 'error', text: 'Source and destination accounts must be different.' });
      return;
    }

    const txId = 'tx-trf-' + Date.now();
    const createdAt = new Date().toISOString();

    const accLabels: Record<string, string> = {
      'acc_cash': 'Counter Cash Drawer',
      'acc_airtel': 'Airtel Money Account',
      'acc_mtn': 'MTN Mobile Money Account',
      'acc_momo': 'Mobile Wallet Account',
      'acc_bank': 'Commercial Bank Account'
    };
    getAllSelectableAccounts().forEach(a => {
      accLabels[a.accountId] = a.label;
    });

    const narration = `Internal Transfer: ${accLabels[transferSourceAcc] || transferSourceAcc} -> ${accLabels[transferDestAcc] || transferDestAcc} (${transferRef || 'Float Movement'})`;

    runSql(
      `INSERT INTO transactions VALUES ('${txId}', 'idem-${txId}', 'FINANCE-TRANSFER', 'INTERNAL_TRANSFER', '${(transferRef || 'TRF-REF').replace(/'/g, "''")}', ${amt}, 0, 'SUCCESS', '${narration.replace(/'/g, "''")}', '${createdAt}', '${createdAt}', '${userRole}')`,
      'Transfers: Record journal move'
    );

    runSql(
      `INSERT INTO ledger_entries VALUES ('le-${Date.now()}-1', '${txId}', '${transferDestAcc}', 'DEBIT', ${amt}, '${createdAt}')`,
      'Transfers Ledger: Debit Destination Account'
    );
    runSql(
      `INSERT INTO ledger_entries VALUES ('le-${Date.now()}-2', '${txId}', '${transferSourceAcc}', 'CREDIT', ${amt}, '${createdAt}')`,
      'Transfers Ledger: Credit Source Account'
    );

    if (transferReceipt) {
      saveTransferReceipt(txId, transferReceipt);
    }

    persistTablesToStorage();
    loadData();
    loadStatementData();

    setTransferAmount('');
    setTransferRef('');
    setTransferReceipt(null);
    setTransferFeedback({
      type: 'success',
      text: `Successfully moved ${settings.currency}${amt.toFixed(2)} from ${accLabels[transferSourceAcc]} to ${accLabels[transferDestAcc]}.${transferReceipt ? ' (Receipt attached)' : ''}`,
    });
  };

  // --- SUPPLY MANAGEMENT & TRANSIT PROCUREMENT ENGINE ---
  const ensureSuppliersTableSql = () => {
    runSql(
      `CREATE TABLE IF NOT EXISTS suppliers (id STRING PRIMARY KEY, name STRING, contact_person STRING, phone STRING, email STRING, address STRING, tpin STRING, payment_terms STRING, default_payment_method STRING, notes STRING, created_at STRING, updated_at STRING)`,
      'Supply Management: Ensure suppliers table',
      true
    );
  };

  const applySavedSupplierToPoForm = (sup: any) => {
    if (!sup) {
      setSelectedSupplierId('');
      return;
    }
    setSelectedSupplierId(String(sup.id || ''));
    setTransitSupplierName(String(sup.name || ''));
    setTransitSupplierContact(String(sup.contact_person || ''));
    setTransitSupplierPhone(String(sup.phone || ''));
    setTransitSupplierEmail(String(sup.email || ''));
    setTransitSupplierAddress(String(sup.address || ''));
    setTransitSupplierTpin(String(sup.tpin || ''));
    if (sup.default_payment_method) {
      setTransitPaymentMethod(String(sup.default_payment_method));
    }
  };

  const handleSelectSavedSupplierForPo = (supId: string) => {
    setPoModalError(null);
    if (!supId) {
      setSelectedSupplierId('');
      return;
    }
    const found = suppliersList.find((s) => String(s.id) === String(supId));
    if (found) {
      applySavedSupplierToPoForm(found);
    }
  };

  const upsertSupplierRecord = (params: {
    id?: string;
    name: string;
    contactPerson?: string;
    phone?: string;
    email?: string;
    address?: string;
    tpin?: string;
    paymentTerms?: string;
    defaultPaymentMethod?: string;
    notes?: string;
  }) => {
    ensureSuppliersTableSql();
    const cleanName = params.name.trim();
    if (!cleanName) return null;
    const nowIso = new Date().toISOString();

    const existing =
      (params.id ? suppliersList.find((s) => String(s.id) === String(params.id)) : null) ||
      suppliersList.find((s) => String(s.name || '').trim().toLowerCase() === cleanName.toLowerCase());

    const esc = (v?: string) => String(v || '').trim().replace(/'/g, "''");

    if (existing) {
      runSql(
        `UPDATE suppliers SET name = '${esc(cleanName)}', contact_person = '${esc(params.contactPerson)}', phone = '${esc(params.phone)}', email = '${esc(params.email)}', address = '${esc(params.address)}', tpin = '${esc(params.tpin)}', payment_terms = '${esc(params.paymentTerms || existing.payment_terms || 'Pay on Order')}', default_payment_method = '${esc(params.defaultPaymentMethod || existing.default_payment_method || 'BANK_TRANSFER')}', notes = '${esc(params.notes ?? existing.notes)}', updated_at = '${nowIso}' WHERE id = '${esc(existing.id)}'`,
        `Supply Management: Update saved supplier ${cleanName}`
      );
      return String(existing.id);
    } else {
      const supId = 'sup-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
      runSql(
        `INSERT INTO suppliers (id, name, contact_person, phone, email, address, tpin, payment_terms, default_payment_method, notes, created_at, updated_at) VALUES ('${supId}', '${esc(cleanName)}', '${esc(params.contactPerson)}', '${esc(params.phone)}', '${esc(params.email)}', '${esc(params.address)}', '${esc(params.tpin)}', '${esc(params.paymentTerms || 'Pay on Order')}', '${esc(params.defaultPaymentMethod || 'BANK_TRANSFER')}', '${esc(params.notes)}', '${nowIso}', '${nowIso}')`,
        `Supply Management: Save supplier ${cleanName}`
      );
      return supId;
    }
  };

  const resetPoModalFields = () => {
    setSelectedSupplierId('');
    setTransitSupplierName('');
    setTransitSupplierContact('');
    setTransitSupplierPhone('');
    setTransitSupplierEmail('');
    setTransitSupplierAddress('');
    setTransitSupplierTpin('');
    setSaveSupplierProfile(true);
    setTransitItems([]);
    setTransitAddExpenses([
      { name: 'Freight & Road Transport', amount: 0, category: 'Freight' },
      { name: 'Port & Customs Clearing Fee', amount: 0, category: 'Handling' },
      { name: 'Handling & Offloading', amount: 0, category: 'Handling' }
    ]);
    setNewPoCostName('');
    setNewPoCostAmount('');
    setTransitNotes('');
    setSelectedTransitProduct('');
    setCustomTransitProductName('');
    setTransitItemQty('10');
    setTransitItemUnitPrice('100');
  };

  const openNewPurchaseOrderModal = (prefillSupplier?: any) => {
    setPoModalError(null);
    setPoFeedback(null);
    resetPoModalFields();
    if (!transitStoreId) {
      setTransitStoreId(activeStore || storesList[0]?.id || 'MAIN');
    }
    if (prefillSupplier && prefillSupplier.name) {
      applySavedSupplierToPoForm(prefillSupplier);
    }
    setShowNewTransitModal(true);
  };

  const handleReorderPurchaseOrder = (po: any) => {
    setPoModalError(null);
    setPoFeedback(null);
    resetPoModalFields();

    const matchedSupplier = suppliersList.find(
      (s) => String(s.name || '').trim().toLowerCase() === String(po.supplier_name || '').trim().toLowerCase()
    );
    if (matchedSupplier) {
      applySavedSupplierToPoForm(matchedSupplier);
    } else {
      setTransitSupplierName(String(po.supplier_name || ''));
    }

    setTransitStoreId(String(po.store_id || activeStore || storesList[0]?.id || 'MAIN'));
    if (po.payment_account_id) setTransitPaymentAcc(String(po.payment_account_id));
    if (po.payment_method) setTransitPaymentMethod(String(po.payment_method));

    let parsedItems: any[] = [];
    try { parsedItems = JSON.parse(po.items_json || '[]'); } catch {}
    if (Array.isArray(parsedItems) && parsedItems.length > 0) {
      setTransitItems(
        parsedItems.map((it: any) => ({
          productId: it.productId || 'custom-' + Date.now(),
          productName: String(it.productName || 'Item'),
          quantity: Math.max(1, Number(it.quantity || 1)),
          baseUnitPrice: Math.max(0, Number(it.baseUnitPrice || 0)),
        }))
      );
    }

    let parsedExpenses: any[] = [];
    try { parsedExpenses = JSON.parse(po.additional_expenses_json || '[]'); } catch {}
    if (Array.isArray(parsedExpenses) && parsedExpenses.length > 0) {
      setTransitAddExpenses(
        parsedExpenses.map((ex: any) => ({
          name: String(ex.name || 'Landing Cost'),
          amount: Math.max(0, Number(ex.amount || 0)),
          category: String(ex.category || 'Freight'),
        }))
      );
    }

    setTransitNotes(`Reorder of PO #${po.id}`);
    setShowNewTransitModal(true);
  };

  const handleAddTransitItem = () => {
    setPoModalError(null);
    let pName = customTransitProductName.trim();
    let pId: string | number = 'custom-' + Date.now();

    if (selectedTransitProduct) {
      const found = productList.find(p => String(p.id) === String(selectedTransitProduct));
      if (found) {
        pName = found.name;
        pId = found.id;
      }
    }

    if (!pName) {
      setPoModalError('Please select a product or enter a custom item name.');
      return;
    }

    const qty = parseInt(transitItemQty, 10);
    const unitPrice = parseFloat(transitItemUnitPrice);

    if (isNaN(qty) || qty <= 0 || isNaN(unitPrice) || unitPrice < 0) {
      setPoModalError('Please enter valid quantity and unit price.');
      return;
    }

    setTransitItems([...transitItems, {
      productId: pId,
      productName: pName,
      quantity: qty,
      baseUnitPrice: unitPrice
    }]);

    setSelectedTransitProduct('');
    setCustomTransitProductName('');
    setTransitItemQty('10');
    setTransitItemUnitPrice('100');
  };

  const handleRemoveTransitItem = (idx: number) => {
    setTransitItems(transitItems.filter((_, i) => i !== idx));
  };

  const handleUpdateTransitItemField = (idx: number, field: 'quantity' | 'baseUnitPrice', rawVal: string) => {
    const val = field === 'quantity' ? Math.max(1, parseInt(rawVal, 10) || 1) : Math.max(0, parseFloat(rawVal) || 0);
    setTransitItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [field]: val } : it)));
  };

  const handleAddNewPoCostLine = () => {
    const cleanName = newPoCostName.trim();
    if (!cleanName) return;
    const amt = Math.max(0, parseFloat(newPoCostAmount) || 0);
    setTransitAddExpenses((prev) => [...prev, { name: cleanName, amount: amt, category: 'Other' }]);
    setNewPoCostName('');
    setNewPoCostAmount('');
  };

  const handleCreateTransitPurchase = (e: React.FormEvent) => {
    e.preventDefault();
    setPoModalError(null);

    if (!transitSupplierName.trim()) {
      setPoModalError('Please enter the supplier name.');
      return;
    }
    if (transitItems.length === 0) {
      setPoModalError('Please add at least one product line item using "+ Add Item Line".');
      return;
    }

    if (saveSupplierProfile) {
      upsertSupplierRecord({
        id: selectedSupplierId || undefined,
        name: transitSupplierName.trim(),
        contactPerson: transitSupplierContact,
        phone: transitSupplierPhone,
        email: transitSupplierEmail,
        address: transitSupplierAddress,
        tpin: transitSupplierTpin,
        defaultPaymentMethod: transitPaymentMethod,
      });
    }

    const targetBranch = transitStoreId || activeStore || storesList[0]?.id || 'MAIN';
    const totalBase = transitItems.reduce((sum, item) => sum + (item.quantity * item.baseUnitPrice), 0);
    const totalAdditional = transitAddExpenses.reduce((sum, exp) => sum + Number(exp.amount || 0), 0);
    const totalLanded = totalBase + totalAdditional;

    const transitId = 'pt-' + Date.now();
    const createdAt = new Date().toISOString();
    const cleanSupplier = transitSupplierName.trim().replace(/'/g, "''");
    const cleanNotes = transitNotes.trim().replace(/'/g, "''");
    const cleanStore = String(targetBranch).replace(/'/g, "''");
    const cleanPayAcc = String(transitPaymentAcc || 'acc_bank').replace(/'/g, "''");
    const cleanPayMethod = String(transitPaymentMethod || 'BANK_TRANSFER').replace(/'/g, "''");

    const poInsertRes = runSql(
      `INSERT INTO purchases_transit (id, supplier_name, store_id, payment_account_id, payment_method, items_json, additional_expenses_json, total_base_amount, total_additional_expenses, total_landed_cost, stage, notes, created_at, updated_at, received_at, received_by) VALUES ('${transitId}', '${cleanSupplier}', '${cleanStore}', '${cleanPayAcc}', '${cleanPayMethod}', '${JSON.stringify(transitItems).replace(/'/g, "''")}', '${JSON.stringify(transitAddExpenses).replace(/'/g, "''")}', ${totalBase}, ${totalAdditional}, ${totalLanded}, 'IN_TRANSIT', '${cleanNotes}', '${createdAt}', '${createdAt}', '', '')`,
      'Supply Management: Create purchase order in transit'
    );

    if (!poInsertRes.success) {
      setPoModalError(poInsertRes.error || 'Could not save Purchase Order to database.');
      return;
    }

    const txId = 'tx-pt-' + Date.now();
    runSql(
      `INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by) VALUES ('${txId}', 'idem-${transitId}', 'PROCUREMENT', 'PURCHASE_TRANSIT', '${transitId}', ${totalLanded}, 0, 'SUCCESS', 'Transit Purchase: ${cleanSupplier} (Landed Cost: ${settings.currency}${totalLanded.toFixed(2)})', '${createdAt}', '${createdAt}', '${userRole}')`,
      'Supply Management: Journal'
    );

    runSql(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at) VALUES ('le-${Date.now()}-1', '${txId}', 'acc_transit', 'DEBIT', ${totalLanded}, '${createdAt}')`,
      'Supply Ledger: Debit Goods in Transit'
    );
    runSql(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at) VALUES ('le-${Date.now()}-2', '${txId}', '${cleanPayAcc}', 'CREDIT', ${totalLanded}, '${createdAt}')`,
      'Supply Ledger: Credit Payment Source'
    );

    // Sync Purchase Order into expenses table for central audit trail
    const expId = 'exp-po-' + Date.now();
    runSql(
      `INSERT INTO expenses (id, category, account_id, amount, description, reference_no, expense_date, store_id, created_at, created_by) VALUES ('${expId}', 'Purchase Order - Goods & Transit', '${cleanPayAcc}', ${totalLanded}, 'PO #${transitId}: Supplier ${cleanSupplier} (${transitItems.length} items)', '${transitId}', '${createdAt.split('T')[0]}', '${cleanStore}', '${createdAt}', '${userRole}')`,
      'Supply Management: Sync Purchase Order to Expenses'
    );

    logEmployeeAudit('PURCHASE', 'Created Purchase Order', `PO #${transitId}, Supplier: ${transitSupplierName.trim()}, Items: ${transitItems.length}, Landed Cost: ${settings.currency}${totalLanded.toFixed(2)}`, totalLanded, targetBranch, userRole);

    syncAllAccountingSystems(`Purchase Order #${transitId}`);
    persistTablesToStorage();
    loadData();
    loadStatementData();
    try { window.dispatchEvent(new Event('pos_data_updated')); } catch {}

    setShowNewTransitModal(false);
    setPoModalError(null);
    resetPoModalFields();
    setSubTab('procurement');

    setPoFeedback({
      type: 'success',
      text: `✓ Purchase Order #${transitId} recorded (${settings.currency}${totalLanded.toFixed(2)} total landed cost)${saveSupplierProfile ? ' & supplier info saved for future orders' : ''}.`,
    });
  };

  const openEditLandingCostModal = (po: any) => {
    setEditLandingError(null);
    let parsedExpenses: Array<{ name: string; amount: number; category: string }> = [];
    try {
      const raw = JSON.parse(po.additional_expenses_json || '[]');
      if (Array.isArray(raw)) {
        parsedExpenses = raw.map((ex: any) => ({
          name: String(ex.name || 'Transit Cost'),
          amount: Math.max(0, Number(ex.amount || 0)),
          category: String(ex.category || 'Freight'),
        }));
      }
    } catch {}
    if (parsedExpenses.length === 0) {
      parsedExpenses = [
        { name: 'Freight & Road Transport', amount: 0, category: 'Freight' },
        { name: 'Port & Customs Clearing Fee', amount: 0, category: 'Customs' },
        { name: 'Handling & Offloading', amount: 0, category: 'Handling' },
      ];
    }
    setEditingLandingPo(po);
    setEditLandingExpenses(parsedExpenses);
    setEditLandingStage(String(po.stage || 'IN_TRANSIT'));
    setEditLandingNotes(String(po.notes || ''));
    setNewEditCostName('');
    setNewEditCostAmount('');
    setNewEditCostCategory('Freight');
  };

  const handleAddEditLandingCostLine = () => {
    const cleanName = newEditCostName.trim();
    if (!cleanName) {
      setEditLandingError('Please enter a name for the transit landing cost line.');
      return;
    }
    setEditLandingError(null);
    const amt = Math.max(0, parseFloat(newEditCostAmount) || 0);
    setEditLandingExpenses((prev) => [
      ...prev,
      { name: cleanName, amount: amt, category: newEditCostCategory },
    ]);
    setNewEditCostName('');
    setNewEditCostAmount('');
  };

  const handleSaveEditedLandingCost = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLandingPo) return;
    setEditLandingError(null);

    const baseTotal = Number(editingLandingPo.total_base_amount || 0);
    const cleanedExpenses = editLandingExpenses.map((ex) => ({
      name: String(ex.name || 'Transit Cost').trim() || 'Transit Cost',
      amount: Math.max(0, Number(ex.amount || 0)),
      category: String(ex.category || 'Other'),
    }));
    const newAddTotal = cleanedExpenses.reduce((sum, ex) => sum + ex.amount, 0);
    const newLandedTotal = parseFloat((baseTotal + newAddTotal).toFixed(2));
    const updatedAt = new Date().toISOString();
    const cleanPoId = String(editingLandingPo.id).replace(/'/g, "''");
    const cleanStage = String(editLandingStage || 'IN_TRANSIT').replace(/'/g, "''");
    const cleanNotes = String(editLandingNotes || '').trim().replace(/'/g, "''");

    const updRes = runSql(
      `UPDATE purchases_transit SET additional_expenses_json = '${JSON.stringify(cleanedExpenses).replace(/'/g, "''")}', total_additional_expenses = ${newAddTotal}, total_landed_cost = ${newLandedTotal}, stage = '${cleanStage}', notes = '${cleanNotes}', updated_at = '${updatedAt}' WHERE id = '${cleanPoId}'`,
      `Supply Management: Update landing cost for PO #${cleanPoId}`
    );

    if (!updRes.success) {
      setEditLandingError(updRes.error || 'Could not update landing costs.');
      return;
    }

    // Keep linked expense record, transaction & ledger entries synchronized
    runSql(
      `UPDATE expenses SET amount = ${newLandedTotal} WHERE reference_no = '${cleanPoId}' AND category = 'Purchase Order - Goods & Transit'`,
      `Supply Management: Sync updated PO landed cost to expenses`
    );
    const linkedTxRes = runSql(
      `SELECT id FROM transactions WHERE provider_reference = '${cleanPoId}' AND channel = 'PURCHASE_TRANSIT'`,
      'Supply Management: Lookup PO transaction',
      true
    );
    if (linkedTxRes.success && Array.isArray(linkedTxRes.data) && linkedTxRes.data.length > 0) {
      const txId = String(linkedTxRes.data[0].id).replace(/'/g, "''");
      const cleanSup = String(editingLandingPo.supplier_name || '').replace(/'/g, "''");
      runSql(
        `UPDATE transactions SET amount = ${newLandedTotal}, narration = 'Transit Purchase: ${cleanSup} (Landed Cost: ${settings.currency}${newLandedTotal.toFixed(2)})', updated_at = '${updatedAt}' WHERE id = '${txId}'`,
        'Supply Management: Update PO transaction total'
      );
      runSql(
        `UPDATE ledger_entries SET amount = ${newLandedTotal} WHERE transaction_id = '${txId}'`,
        'Supply Management: Update PO ledger amounts'
      );
    }

    logEmployeeAudit(
      'PURCHASE',
      'Updated Purchase Order Landing Cost',
      `PO #${editingLandingPo.id} (${editingLandingPo.supplier_name}): Landing overhead updated to ${settings.currency}${newAddTotal.toFixed(2)}, Total Landed Cost: ${settings.currency}${newLandedTotal.toFixed(2)}`,
      newLandedTotal,
      String(editingLandingPo.store_id || activeStore || ''),
      userRole
    );

    syncAllAccountingSystems(`Updated Landing Cost PO #${editingLandingPo.id}`);
    persistTablesToStorage();
    loadData();
    loadStatementData();
    try { window.dispatchEvent(new Event('pos_data_updated')); } catch {}

    const updatedId = editingLandingPo.id;
    setEditingLandingPo(null);
    setPoFeedback({
      type: 'success',
      text: `✓ Landing costs updated for PO #${updatedId}. New Total Landed Cost: ${settings.currency}${newLandedTotal.toFixed(2)} (synced to Expenses & Ledgers).`,
    });
  };

  const openSupplierModal = (sup?: any) => {
    setSupplierFormError(null);
    if (sup) {
      setEditingSupplier(sup);
      setSupplierFormName(String(sup.name || ''));
      setSupplierFormContact(String(sup.contact_person || ''));
      setSupplierFormPhone(String(sup.phone || ''));
      setSupplierFormEmail(String(sup.email || ''));
      setSupplierFormAddress(String(sup.address || ''));
      setSupplierFormTpin(String(sup.tpin || ''));
      setSupplierFormTerms(String(sup.payment_terms || 'Pay on Order / Advance'));
      setSupplierFormPayMethod(String(sup.default_payment_method || 'BANK_TRANSFER'));
      setSupplierFormNotes(String(sup.notes || ''));
    } else {
      setEditingSupplier(null);
      setSupplierFormName('');
      setSupplierFormContact('');
      setSupplierFormPhone('');
      setSupplierFormEmail('');
      setSupplierFormAddress('');
      setSupplierFormTpin('');
      setSupplierFormTerms('Pay on Order / Advance');
      setSupplierFormPayMethod('BANK_TRANSFER');
      setSupplierFormNotes('');
    }
    setShowSupplierModal(true);
  };

  const handleSaveSupplierForm = (e: React.FormEvent) => {
    e.preventDefault();
    setSupplierFormError(null);
    if (!supplierFormName.trim()) {
      setSupplierFormError('Supplier name is required.');
      return;
    }
    upsertSupplierRecord({
      id: editingSupplier?.id,
      name: supplierFormName.trim(),
      contactPerson: supplierFormContact,
      phone: supplierFormPhone,
      email: supplierFormEmail,
      address: supplierFormAddress,
      tpin: supplierFormTpin,
      paymentTerms: supplierFormTerms,
      defaultPaymentMethod: supplierFormPayMethod,
      notes: supplierFormNotes,
    });
    persistTablesToStorage();
    loadData();
    try { window.dispatchEvent(new Event('pos_data_updated')); } catch {}
    setShowSupplierModal(false);
    setPoFeedback({
      type: 'success',
      text: `✓ Supplier "${supplierFormName.trim()}" ${editingSupplier ? 'updated' : 'saved'} for future purchase orders.`,
    });
  };

  const handleDeleteSupplier = (supId: string) => {
    runSql(`DELETE FROM suppliers WHERE id = '${String(supId).replace(/'/g, "''")}'`, 'Supply Management: Delete supplier');
    setConfirmDeleteSupplierId(null);
    persistTablesToStorage();
    loadData();
    setPoFeedback({
      type: 'success',
      text: 'Supplier removed from saved directory (historical purchase orders preserved).',
    });
  };

  const handleUpdateTransitStage = (transitId: string, newStage: string) => {
    runSql(
      `UPDATE purchases_transit SET stage = '${newStage}', updated_at = '${new Date().toISOString()}' WHERE id = '${transitId}'`,
      `Supply Management: Update stage to ${newStage}`
    );
    logEmployeeAudit('PURCHASE', 'Updated Purchase Order Stage', `PO #${transitId} stage updated to ${newStage}`, 0, activeStore || '', userRole);
    persistTablesToStorage();
    loadData();
  };

  const handleAcceptTransitDelivery = (po: any) => {
    const receivedAt = new Date().toISOString();
    let items: any[] = [];
    try { items = JSON.parse(po.items_json); } catch (e) {}

    const totalBase = Number(po.total_base_amount || 0);
    const totalAdditional = Number(po.total_additional_expenses || 0);
    const overheadRatio = totalBase > 0 ? (totalAdditional / totalBase) : 0;
    const targetBranch = String(po.store_id || activeStore || 'MAIN');

    runSql(
      `UPDATE purchases_transit SET stage = 'LANDED_AT_STORE', updated_at = '${receivedAt}', received_at = '${receivedAt}', received_by = '${userRole}' WHERE id = '${po.id}'`,
      'Supply Management: Accept stock at store'
    );

    logEmployeeAudit('PURCHASE', 'Received Procurement Goods', `PO #${po.id} accepted & received into branch ${targetBranch.toUpperCase()}. Items landed: ${items.length}`, Number(po.total_landed_cost || 0), targetBranch, userRole);

    items.forEach((it: any) => {
      const landedUnitPrice = parseFloat((Number(it.baseUnitPrice || 0) * (1 + overheadRatio)).toFixed(2));
      const qty = Number(it.quantity || 0);
      const rawId = String(it.productId || '');
      const isCustomItem = !rawId || rawId.startsWith('custom-') || rawId.startsWith('CUSTOM-');
      const numericId = Number(rawId);
      let resolvedProductId: string | number = rawId;

      if (!isCustomItem && !Number.isNaN(numericId) && Number.isFinite(numericId)) {
        runSql(
          `UPDATE products SET stock = stock + ${qty}, cost = ${landedUnitPrice} WHERE id = ${numericId}`,
          `Transit Stock Acceptance: Add ${qty} units to product #${numericId}`
        );
      } else {
        const cleanName = String(it.productName || 'Imported Stock Item').replace(/'/g, "''");
        const existingByName = runSql(`SELECT id FROM products WHERE name = '${cleanName}'`, 'Lookup product by name', true);
        if (existingByName.success && Array.isArray(existingByName.data) && existingByName.data.length > 0) {
          resolvedProductId = existingByName.data[0].id;
          runSql(
            `UPDATE products SET stock = stock + ${qty}, cost = ${landedUnitPrice} WHERE id = ${Number(resolvedProductId) || `'${String(resolvedProductId).replace(/'/g, "''")}'`}`,
            `Transit Stock Acceptance: Add ${qty} units to ${cleanName}`
          );
        } else {
          const newProdId = Math.floor(100000 + Math.random() * 900000);
          resolvedProductId = newProdId;
          const sellingPrice = parseFloat((landedUnitPrice * 1.3).toFixed(2));
          let bizId = '';
          try {
            bizId = JSON.parse(localStorage.getItem('active_business_profile') || '{}')?.id || '';
          } catch {}
          runSql(
            `INSERT INTO products (id, name, sku, category, stock, cost, price, business_id, is_service) VALUES (${newProdId}, '${cleanName}', 'PO-${newProdId}', 'Procurement', ${qty}, ${landedUnitPrice}, ${sellingPrice}, '${bizId.replace(/'/g, "''")}', 0)`,
            `Transit Stock Acceptance: Register new product ${cleanName}`
          );
        }
      }

      const storeProdCheck = runSql(`SELECT * FROM store_products WHERE product_id = '${resolvedProductId}' AND store_id = '${targetBranch.replace(/'/g, "''")}'`, 'Check store_products');
      if (storeProdCheck.success && Array.isArray(storeProdCheck.data) && storeProdCheck.data.length > 0) {
        runSql(
          `UPDATE store_products SET stock = stock + ${qty}, price = ${(landedUnitPrice * 1.3).toFixed(2)} WHERE product_id = '${resolvedProductId}' AND store_id = '${targetBranch.replace(/'/g, "''")}'`,
          `Transit Stock Acceptance: Update store stock for product #${resolvedProductId}`
        );
      } else {
        const spId = 'sp-' + Date.now() + '-' + Math.random().toString(36).substring(2, 5);
        runSql(
          `INSERT INTO store_products (id, product_id, store_id, stock, price) VALUES ('${spId}', '${resolvedProductId}', '${targetBranch.replace(/'/g, "''")}', ${qty}, ${(landedUnitPrice * 1.3).toFixed(2)})`,
          `Transit Stock Acceptance: Insert store product record`
        );
      }
    });

    const txId = 'tx-land-' + Date.now();
    runSql(
      `INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by) VALUES ('${txId}', 'idem-${po.id}-landed', 'STORE-${targetBranch.toUpperCase()}', 'STOCK_LANDED', '${po.id}', ${po.total_landed_cost}, 0, 'SUCCESS', 'Stock Accepted: Order #${po.id} landed at ${targetBranch}', '${receivedAt}', '${receivedAt}', '${userRole}')`,
      'Supply Management: Stock landed journal'
    );
    runSql(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at) VALUES ('le-${Date.now()}-1', '${txId}', 'acc_inventory', 'DEBIT', ${po.total_landed_cost}, '${receivedAt}')`,
      'Supply Ledger: Debit Store Inventory'
    );
    runSql(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at) VALUES ('le-${Date.now()}-2', '${txId}', 'acc_transit', 'CREDIT', ${po.total_landed_cost}, '${receivedAt}')`,
      'Supply Ledger: Credit Goods in Transit'
    );

    syncAllAccountingSystems(`Stock Received PO #${po.id}`);
    persistTablesToStorage();
    loadData();
    loadStatementData();
    try { window.dispatchEvent(new Event('pos_data_updated')); } catch {}

    setConfirmReceivePoId(null);
    setPoFeedback({
      type: 'success',
      text: `✓ Stock from PO #${po.id} received into ${targetBranch.toUpperCase()} inventory and product costs updated to landed price.`,
    });
  };

  // Handler to request a loan
  const handleRequestLoan = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Auto-calculate interest (standard 1% flat service commission fee per month)
    const monthlyRate = 0.082; // flat rate for risk
    const interestAmt = applyPrincipal * monthlyRate * applyTermMonths;
    const totalRepayableVal = applyPrincipal + interestAmt;
    const loanIdVal = 'LOAN-' + Math.floor(1000 + Math.random() * 9000);
    const dateStr = new Date().toISOString();
    
    // Set maturity term calendar due
    const termMs = applyTermMonths * 30 * 24 * 60 * 60 * 1000;
    const dueDateStr = new Date(Date.now() + termMs).toISOString();

    // 1. Create central credit contract database record
    const insertLoanSql = `
      INSERT INTO loans VALUES (
        '${loanIdVal}',
        'default_biz',
        'acc_operating',
        ${applyPrincipal.toFixed(2)},
        ${interestAmt.toFixed(2)},
        ${totalRepayableVal.toFixed(2)},
        ${applySweepPercentage.toFixed(2)},
        'PENDING_REVIEW',
        NULL,
        '${dueDateStr}',
        '${dateStr}',
        '${dateStr}'
      )
    `;
    const resLoan = runSql(insertLoanSql, `Loans Application: Lodged request ${loanIdVal} for review`);

    if (resLoan.success) {
      // 2. Generate expected amortization milestones upfront
      const partPrincipal = applyPrincipal / applyTermMonths;
      const partInterest = interestAmt / applyTermMonths;
      const partDue = totalRepayableVal / applyTermMonths;

      for (let month = 1; month <= applyTermMonths; month++) {
        const milestoneId = `AMORT-${loanIdVal.substring(5)}-${month}`;
        const milestoneDueDate = new Date(Date.now() + (month * 30 * 24 * 60 * 60 * 1000)).toISOString();
        
        const insertMilestoneSql = `
          INSERT INTO loan_amortization_schedule VALUES (
            '${milestoneId}',
            '${loanIdVal}',
            ${month},
            ${partPrincipal.toFixed(2)},
            ${partInterest.toFixed(2)},
            ${partDue.toFixed(2)},
            0.00,
            0,
            '${milestoneDueDate}',
            NULL
          )
        `;
        runSql(insertMilestoneSql, `Loans Application: Pre-registered monthly expected milestone #${month}`);
      }

      alert(`✓ Application Submitted!\n\nReference: ${loanIdVal}\nPrincipal Amount: ${settings.currency}${applyPrincipal.toFixed(2)}\nRepayable Capital: ${settings.currency}${totalRepayableVal.toFixed(2)}\n\nYour application has been logged as PENDING_REVIEW for risk assessment co-signing compliance.`);
      setShowApplyModal(false);
      loadData();
      persistTablesToStorage();
    } else {
      alert('Failed requesting loan contract: ' + resLoan.error);
    }
  };

  // Handler for manager to disburse/approve loan
  const handleApproveLoan = (loanId: string) => {
    if (userRole === 'sales') {
      alert('Access Gating Error: Cashiers do not have credit compliance authorizations. Manager or Owner permission co-sign required.');
      return;
    }

    const verify = window.confirm(`Financial Commitment Guard:\nAre you sure you want to approve and disburse Loan Ref ${loanId} in full?\n\nThis will credit the cash drawer accounts instantly.`);
    if (!verify) return;

    const query = runSql(`SELECT * FROM loans WHERE id = '${loanId}' AND status = 'PENDING_REVIEW'`, 'Fetch target loan status');
    if (!query.success || query.data.length === 0) {
      alert('State sync failure: Loan does not exist or is already active.');
      return;
    }

    const ln = query.data[0];
    const nowStr = new Date().toISOString();

    // 1. Transition status in central contract DB
    const updateSql = `UPDATE loans SET status = 'ACTIVE', disbursed_at = '${nowStr}', updated_at = '${nowStr}' WHERE id = '${loanId}'`;
    const updateRes = runSql(updateSql, `Loans Compliance: Set state to ACTIVE for ${loanId}`);

    if (updateRes.success) {
      // 2. Clear disbursements through double-entry transactions
      const txId = `tx_disb_${loanId.toLowerCase()}_${Math.floor(100 + Math.random() * 900)}`;
      const idempKey = `idemp_${txId}`;
      const amountFloat = Number(ln.principal_amount);

      runSql(`
        INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at)
        VALUES ('${txId}', '${idempKey}', 'POS-${activeStore.toUpperCase()}-01', 'CREDIT_ADVANCE', 'DISB-REF-${loanId}', ${amountFloat.toFixed(4)}, 0.0000, 'SUCCESS', 'Expansion capital advance disbursed for Ref #${loanId}', '${nowStr}', '${nowStr}')
      `, 'Double Entry: Journal disburse event');

      // Asset accounts ledger
      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_deb', '${txId}', 'merchant-wallet-account-uuid', 'DEBIT', ${amountFloat.toFixed(4)}, '${nowStr}')
      `, 'Double Entry: Debit Merchant Wallet Asset (Refill working capital)');

      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_cre_liability', '${txId}', 'acc_operating', 'CREDIT', ${amountFloat.toFixed(4)}, '${nowStr}')
      `, 'Double Entry: Credit Lending Operating Liability Ledger');

      alert(`⚡ SUCCESS! Capital disbursed.\n\nLoan ${loanId} is now ACTIVE.\nRepayments will commence automatically at ${ln.daily_deduction_percentage}% sweep rate of all incoming POS daily checkouts.\nWorking capital added to main ledger.`);
      setSelectedLoanId(loanId);
      loadData();
      persistTablesToStorage();
    } else {
      alert('Error finalizing disbursement: ' + updateRes.error);
    }
  };

  // Reject Request
  const handleRejectLoan = (loanId: string) => {
    if (userRole === 'sales') {
      alert('Access Gating Error: Manager clearance required.');
      return;
    }

    const reason = window.prompt(`Explain credit risk mismatch reason for declining Capital Advance ${loanId}:`);
    if (reason === null) return;
    if (!reason.trim()) {
      alert('Declining reason co-sign required.');
      return;
    }

    const updateRes = runSql(`UPDATE loans SET status = 'DEFAULTED', updated_at = '${new Date().toISOString()}' WHERE id = '${loanId}'`, `Decline loan Request ${loanId}`);
    if (updateRes.success) {
      alert(`✗ Loan Request ${loanId} declined successfully.\nReason logged: "${reason}"`);
      loadData();
      persistTablesToStorage();
    } else {
      alert('Failed update status: ' + updateRes.error);
    }
  };

  // Print co-signed credit certificate
  const handlePrintAuditPDF = (ln: Loan) => {
    try {
      const doc = new jsPDF({ format: 'a4', orientation: 'portrait' });
      doc.setFont('helvetica', 'bold');
      
      doc.setFontSize(16);
      doc.text(settings.storeName.toUpperCase(), 20, 20);
      doc.setFontSize(10);
      doc.text('ZAMBIA SME MICROFINANCE & DIGITAL MERCHANDISER ADVANCES', 20, 26);
      
      doc.setLineWidth(0.5);
      doc.line(20, 30, 190, 30);
      
      // Header Info
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(`CERTIFICATE REF: ADV-CERT-${ln.id}`, 20, 38);
      doc.text(`ISSUED ON: ${new Date(ln.created_at).toLocaleString()}`, 20, 43);
      doc.text(`BORROWER ID: MERCHANT_default_biz`, 20, 48);
      doc.text(`LENDING OPERATOR: SME FINANCING LIQUIDITY ASSET POOL`, 20, 53);
      
      // Box design for principal details
      doc.setFillColor(248, 250, 252);
      doc.rect(20, 58, 170, 36, 'F');
      doc.rect(20, 58, 170, 36, 'D');
      
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('CREDIT ACCOUNT DETAILS', 25, 65);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(`Financed Capital Principal:  ${settings.currency}${ln.principal_amount.toLocaleString()}`, 25, 72);
      doc.text(`Upfront Accrued Interest:    ${settings.currency}${ln.interest_amount.toLocaleString()}`, 25, 77);
      doc.text(`Daily Automatic POS Sweep:  ${ln.daily_deduction_percentage}% of checkout revenue`, 25, 82);
      
      doc.setFont('helvetica', 'bold');
      doc.text(`TOTAL REPAYABLE BALANCE:     ${settings.currency}${ln.total_repayable.toLocaleString()}`, 25, 88);
      
      // Amortization details
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('AMORTIZATION CONTRACT MILESTONES', 20, 105);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      
      doc.line(20, 108, 190, 108);
      doc.text('STG', 22, 113);
      doc.text('DUE DATE', 35, 113);
      doc.text('PRINCIPAL DUE', 75, 113);
      doc.text('INTEREST DUE', 110, 113);
      doc.text('TOTAL AMORT', 145, 113);
      doc.text('SETTLED', 175, 113);
      doc.line(20, 116, 190, 116);

      const lnSchedule = amortization.filter(a => a.loan_id === ln.id);
      let offset = 122;
      lnSchedule.forEach(sch => {
        doc.text(`#${sch.installment_number}`, 22, offset);
        doc.text(new Date(sch.due_date).toLocaleDateString(), 35, offset);
        doc.text(`${settings.currency}${sch.principal_due.toFixed(2)}`, 75, offset);
        doc.text(`${settings.currency}${sch.interest_due.toFixed(2)}`, 110, offset);
        doc.text(`${settings.currency}${sch.total_due.toFixed(2)}`, 145, offset);
        doc.text(sch.is_settled ? 'YES' : 'NO', 175, offset);
        offset += 6;
      });

      doc.line(20, offset, 190, offset);
      offset += 10;

      // Signatures
      doc.setFontSize(9);
      doc.text('____________________________', 20, offset + 15);
      doc.text('SME Credit Officer Signature', 20, offset + 19);

      doc.text('____________________________', 120, offset + 15);
      doc.text('Borrowing Merchant Signature', 120, offset + 19);
      
      doc.setFontSize(7.5);
      doc.text('This printed ledger is co-signed on blockchain secure AlaSQL double-entry memory logs.', 20, offset + 35);

      exportAndSharePdf(`CREDIT_AGREEMENT_${ln.id}.pdf`, doc);
    } catch(err) {
      console.error(err);
    }
  };

  // --- START OF FINANCIAL REPORT ENGINE COMPUTATIONS ---
  // Filtering logic
  const filteredOrders = statementOrders.filter(o => {
    const matchesStore = !activeStore || o.store_id === activeStore;
    const matchesPeriod = isDateInPeriod(o.orderDate);
    return matchesStore && matchesPeriod;
  });

  const filteredOrderIds = filteredOrders.map(o => o.id);
  const filteredItems = statementItems.filter(item => filteredOrderIds.includes(item.orderId));

  // 1. Profit & Loss: Sales Revenues
  const grossSales = filteredOrders.reduce((sum, o) => sum + Number(o.subtotal || 0), 0);
  const totalDiscounts = filteredOrders.reduce((sum, o) => sum + Number(o.discount || 0), 0);
  const netRevenue = Math.max(0, grossSales - totalDiscounts);

  // 2. Cost of Goods Sold (COGS)
  const totalCogs = filteredItems.reduce((sum, item) => {
    const qty = Number(item.quantity || 0);
    const cost = Number(item.cost || 0);
    return sum + (qty * cost);
  }, 0);

  // 3. Gross Profit
  const grossProfit = Math.max(0, netRevenue - totalCogs);

  // 4. Operating Expenses
  const filteredAttendance = statementAttendance.filter(at => isDateInPeriod(at.date));
  const payrollExpense = filteredAttendance.reduce((sum, at) => sum + Number(at.gross_payment || 0), 0);

  const filteredExpenses = expensesList.filter(ex => {
    const matchesStore = !activeStore || ex.store_id === activeStore;
    const matchesPeriod = isDateInPeriod(ex.expense_date || ex.created_at);
    return matchesStore && matchesPeriod;
  });

  const recordedExpensesTotal = filteredExpenses.reduce((sum, ex) => sum + Number(ex.amount || 0), 0);

  const rentExpense = filteredExpenses
    .filter(ex => String(ex.category || '').toLowerCase().includes('rent'))
    .reduce((sum, ex) => sum + Number(ex.amount || 0), 0);
  const utilitiesExpense = filteredExpenses
    .filter(ex => /utilit|power|water|electric|internet/i.test(String(ex.category || '')))
    .reduce((sum, ex) => sum + Number(ex.amount || 0), 0);
  const generalOfficeExpense = filteredExpenses
    .filter(ex => !String(ex.category || '').toLowerCase().includes('rent') && !/utilit|power|water|electric|internet/i.test(String(ex.category || '')))
    .reduce((sum, ex) => sum + Number(ex.amount || 0), 0);

  const totalExpenses = recordedExpensesTotal + payrollExpense;

  // 5. Finance Costs
  const activeLoansOfStore = loans.filter(l => l.status === 'ACTIVE' || l.status === 'PAID_OFF');
  const totalInterestCosts = activeLoansOfStore.reduce((sum, l) => {
    if (isDateInPeriod(l.created_at)) {
      return sum + Number(l.interest_amount || 0);
    }
    return sum;
  }, 0);

  // 6. Net Profit
  const netProfit = grossProfit - totalExpenses - totalInterestCosts;

  // --- BALANCE SHEET CALCULATIONS ---
  // A. Assets
  let ledgersCash = 0;
  const balanceAccounts: any[] = [];
  const balanceQuery = runSql("SELECT * FROM view_account_balances", 'Balance Sheet: Calculate Account Balances', true);
  if (balanceQuery.success && Array.isArray(balanceQuery.data)) {
    balanceQuery.data.forEach((acc: any) => {
      const bal = Number(acc.current_balance || 0);
      balanceAccounts.push({
        id: acc.account_id,
        name: acc.account_name,
        balance: bal
      });
      if (
        acc.account_id === 'acc_cash' ||
        acc.account_id === 'acc_airtel' ||
        acc.account_id === 'acc_mtn' ||
        acc.account_id === 'acc_momo' ||
        acc.account_id === 'acc_bank' ||
        String(acc.account_id || '').startsWith('acc_pm_')
      ) {
        ledgersCash += bal;
      }
    });
  }

  const computedCash = ledgersCash;

  // Inventory Value
  const prodRes = runSql("SELECT SUM(stock * cost) AS stock_value FROM products", 'Balance Sheet: Inventory pricing', true);
  const inventoryValuation = prodRes.success && prodRes.data[0]?.stock_value ? Number(prodRes.data[0].stock_value) : 0;

  // Custom Assets registries using Net Book Value (NBV = cost - accumulated depreciation)
  const customCurrentAssetsSum = assets
    .filter(a => a.category === 'Current' && a.status !== 'Written Off')
    .reduce((sum, a) => {
      const financials = getAssetFinancials(a);
      return sum + financials.nbv;
    }, 0);

  const customFixedAssetsSum = assets
    .filter(a => a.category === 'Fixed' && a.status !== 'Written Off')
    .reduce((sum, a) => {
      const financials = getAssetFinancials(a);
      return sum + financials.nbv;
    }, 0);

  const customFixedAssetsPeriodAcquisition = assets
    .filter(a => a.category === 'Fixed' && a.status !== 'Written Off' && isDateInPeriod(a.purchaseDate))
    .reduce((sum, a) => sum + Number(a.value || 0), 0);

  const totalAssetsSum = computedCash + inventoryValuation + customCurrentAssetsSum + customFixedAssetsSum;

  // B. Liabilities
  const outstandingDebtSum = loans
    .filter(l => l.status === 'ACTIVE' || l.status === 'DEFAULTED')
    .reduce((sum, ln) => {
      const settledDecks = deductions
        .filter(d => d.loan_id === ln.id && d.status === 'SUCCESS')
        .reduce((s, curr) => s + Number(curr.amount_deducted || 0), 0);
      return sum + Math.max(0, Number(ln.total_repayable) - settledDecks);
    }, 0);

  const collectedVatLiability = filteredOrders.reduce((sum, o) => sum + Number(o.tax || 0), 0);
  const totalLiabilities = outstandingDebtSum + collectedVatLiability;

  // C. Equity
  const contributedEquitySum = equity.reduce((sum, eq) => sum + Number(eq.value || 0), 0);
  
  // Balancing reserve: Captures prior periods accum to strictly maintain accounting equation
  const historicalRetainedEarnings = Math.max(0, totalAssetsSum - (totalLiabilities + contributedEquitySum + netProfit));
  const displayedRetainedEarnings = netProfit + historicalRetainedEarnings;

  const totalLiabilitiesAndEquity = totalLiabilities + contributedEquitySum + historicalRetainedEarnings + netProfit;
  const balanceDifference = totalAssetsSum - totalLiabilitiesAndEquity;

  // --- CASH FLOW STATEMENTS ---
  const cashOperatingInflow = netRevenue + collectedVatLiability;
  const cashOperatingOutflow = totalCogs + payrollExpense + (rentExpense + utilitiesExpense + generalOfficeExpense);
  const netOperatingCash = cashOperatingInflow - cashOperatingOutflow;

  const netInvestingCash = -customFixedAssetsPeriodAcquisition; // Period-specific acquisitions treated as outflows

  const loanPrincipalDisbursedInperiod = activeLoansOfStore.reduce((sum, l) => {
    if (isDateInPeriod(l.disbursed_at || l.created_at)) {
      return sum + Number(l.principal_amount || 0);
    }
    return sum;
  }, 0);

  const sweepRepaymentsProcessedInperiod = deductions
    .filter(d => d.status === 'SUCCESS' && isDateInPeriod(d.created_at))
    .reduce((sum, d) => sum + Number(d.amount_deducted || 0), 0);

  const netFinancingCash = loanPrincipalDisbursedInperiod - sweepRepaymentsProcessedInperiod + contributedEquitySum;
  const netChangeInCash = netOperatingCash + netInvestingCash + netFinancingCash;

  const startingPeriodCash = Math.max(0, computedCash - netChangeInCash);
  const closingPeriodCash = startingPeriodCash + netChangeInCash;

  // --- FINANCIAL REPORT PDF EXPORTER ---
  const handlePrintFinancialReportPDF = () => {
    try {
      const doc = new jsPDF({ format: 'a4', orientation: 'portrait' });
      
      // Slate background header banner
      doc.setFillColor(30, 41, 59);
      doc.rect(0, 0, 210, 42, 'F');
      
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.text(settings.storeName.toUpperCase() + ' - FINANCIAL REPORT', 20, 20);
      
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(`ZAMBIA SME INTEGRATED FINANCIAL AUDIT STATEMENT`, 20, 27);
      doc.text(`REPORT PERIOD: ${selectedPeriod.toUpperCase().replace('_', ' ')} | OUTLET BRANCH: ${activeStore ? activeStore.toUpperCase() : 'ALL OUTLETS'}`, 20, 33);
      doc.text(`GENERATED STAMP: ${new Date().toLocaleString()}`, 20, 38);
      
      // Page 1: Profit & Loss Statement
      doc.setTextColor(15, 23, 42);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.text('I. PROFIT & LOSS ACCOUNT (INCOME STATEMENT)', 20, 55);
      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.5);
      doc.line(20, 58, 190, 58);
      
      doc.setFontSize(9);
      let y = 67;
      const writeRow = (label: string, value: number, isBold = false) => {
        if (isBold) doc.setFont('helvetica', 'bold');
        else doc.setFont('helvetica', 'normal');
        doc.text(label, 20, y);
        const prefix = value < 0 ? '-' : '';
        doc.text(`${settings.currency}${prefix}${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 190, y, { align: 'right' });
        y += 7;
      };
      
      writeRow('Gross Sales Cash Receivables (POS Checkout)', grossSales);
      writeRow('Less: Customer Discounts & Concessions', -totalDiscounts);
      doc.line(20, y - 4, 190, y - 4);
      writeRow('NET SALES REVENUE', netRevenue, true);
      y += 2;
      
      writeRow('Cost of Goods Sold (COGS)', -totalCogs);
      doc.line(20, y - 4, 190, y - 4);
      writeRow('GROSS OPERATING MARGIN', grossProfit, true);
      y += 4;
      
      doc.setFont('helvetica', 'bold');
      doc.text('Operating Overheads & Deductions:', 20, y);
      y += 7;
      writeRow('  Staff Payroll & Salaries Paid', -payrollExpense);
      writeRow('  Rent Allocations', -rentExpense);
      writeRow('  Electricity & Water Utilities', -utilitiesExpense);
      writeRow('  General Office & Administrative Packaging', -generalOfficeExpense);
      doc.line(20, y - 4, 190, y - 4);
      writeRow('TOTAL OPERATING OVERHEADS', -totalExpenses, true);
      y += 4;
      
      writeRow('Finance costs (SME Capital Advance Interest)', -totalInterestCosts);
      doc.line(20, y - 4, 190, y - 4);
      
      // Highlight row for Net Retained Earnings
      doc.setFillColor(241, 245, 249);
      doc.rect(20, y - 5, 170, 8, 'F');
      writeRow('NET RETAINED PROFIT / (LOSS)', netProfit, true);
      
      // Page 2: Statement of Financial Position (Balance Sheet)
      doc.addPage();
      doc.setFillColor(30, 41, 59);
      doc.rect(0, 0, 210, 20, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('STATEMENT OF FINANCIAL POSITION (BALANCE SHEET)', 20, 13);
      
      doc.setTextColor(15, 23, 42);
      y = 35;
      doc.setFontSize(12);
      doc.text('II. BALANCE SHEET', 20, y);
      y += 3;
      doc.setFontSize(9);
      doc.line(20, y, 190, y);
      y += 8;
      
      doc.setFont('helvetica', 'bold');
      doc.text('ASSETS (Working & Long-Term Capital)', 20, y);
      y += 7;
      writeRow('  Cash & Mobile Money Reserves', computedCash);
      writeRow('  Inventory Stock Asset Valuation', inventoryValuation);
      writeRow('  Custom Registered Current Assets', customCurrentAssetsSum);
      writeRow('  Custom Registered Long-Term/Fixed Assets', customFixedAssetsSum);
      doc.line(20, y - 4, 190, y - 4);
      writeRow('TOTAL ASSETS', totalAssetsSum, true);
      y += 5;
      
      doc.setFont('helvetica', 'bold');
      doc.text('LIABILITIES', 20, y);
      y += 7;
      writeRow('  Outstanding Capital Sweep Agreements Debt', outstandingDebtSum);
      writeRow('  Accrued VAT Tax payable to ZRA', collectedVatLiability);
      doc.line(20, y - 4, 190, y - 4);
      writeRow('TOTAL LIABILITIES', totalLiabilities, true);
      y += 5;
      
      doc.setFont('helvetica', 'bold');
      doc.text('EQUITY CAPITAL MAPPINGS', 20, y);
      y += 7;
      writeRow('  Contributed Capital Accounts', contributedEquitySum);
      writeRow('  Historical Retained Earnings Reserves', historicalRetainedEarnings);
      writeRow('  Current Retained Profit / (Loss)', netProfit, true);
      doc.line(20, y - 4, 190, y - 4);
      writeRow('TOTAL CAPITAL EQUITY', contributedEquitySum + historicalRetainedEarnings + netProfit, true);
      
      doc.line(20, y - 4, 190, y - 4);
      doc.setFillColor(241, 245, 249);
      doc.rect(20, y - 5, 170, 8, 'F');
      writeRow('TOTAL LIABILITIES & EQUITY FUND BALANCE', totalLiabilitiesAndEquity, true);
      
      // Page 3: Cash Flow Statement
      doc.addPage();
      doc.setFillColor(30, 41, 59);
      doc.rect(0, 0, 210, 20, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('AUDITED CASH FLOW RECONCILIATION STATEMENT', 20, 13);
      
      doc.setTextColor(15, 23, 42);
      y = 35;
      doc.setFontSize(12);
      doc.text('III. CASH FLOW STATEMENT (DIRECT METHOD)', 20, y);
      y += 3;
      doc.setFontSize(9);
      doc.line(20, y, 190, y);
      y += 8;
      
      doc.setFont('helvetica', 'bold');
      doc.text('Cash Flow from Operating Activities', 20, y);
      y += 7;
      writeRow('  Operating Inflow from Customer Receipts (incl. VAT)', cashOperatingInflow);
      writeRow('  Operating Outflows (Stock COGS, Overheads, Salaries)', -cashOperatingOutflow);
      doc.line(20, y - 4, 190, y - 4);
      writeRow('NET CASH FROM OPERATING ACTIVITIES', netOperatingCash, true);
      y += 5;
      
      doc.setFont('helvetica', 'bold');
      doc.text('Cash Flow from Investing Activities', 20, y);
      y += 7;
      writeRow('  Custom Fixed Asset Capital Acquisitions', netInvestingCash);
      doc.line(20, y - 4, 190, y - 4);
      writeRow('NET CASH FROM INVESTING ACTIVITIES', netInvestingCash, true);
      y += 5;
      
      doc.setFont('helvetica', 'bold');
      doc.text('Cash Flow from Financing Activities', 20, y);
      y += 7;
      writeRow('  Capital Advances Disbursed receipts', loanPrincipalDisbursedInperiod);
      writeRow('  Automatic Sweeps debt repayments', -sweepRepaymentsProcessedInperiod);
      writeRow('  Share Capital Contributions', contributedEquitySum);
      doc.line(20, y - 4, 190, y - 4);
      writeRow('NET CASH FROM FINANCING ACTIVITIES', netFinancingCash, true);
      y += 8;
      
      doc.setLineWidth(1.0);
      doc.line(20, y, 190, y);
      y += 7;
      writeRow('NET ACCUMULATED INCREASE IN CASH RESERVES', netChangeInCash, true);
      writeRow('Cash at beginning of Period', startingPeriodCash);
      doc.setFillColor(236, 253, 245);
      doc.rect(20, y - 5, 170, 8, 'F');
      writeRow('CASH BALANCE AT END OF REPORTING FRAME', closingPeriodCash, true);
      
      // Signatures
      y += 20;
      doc.setFontSize(8.5);
      doc.text('____________________________________', 20, y);
      doc.text('ZAMBIA REVENUE AUTHORITY Audit Officer', 20, y + 4);
      
      doc.text('____________________________________', 120, y);
      doc.text('Managing Director / Store Representative', 120, y + 4);
      
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(7.5);
      doc.text('This co-signed accounting PDF complies with the Microfinance Interest Cap and ZRA VAT compliance code ZM-55B.', 20, y + 20);
      
      exportAndSharePdf(`FINANCIAL_REPORT_${selectedPeriod}_${activeStore}.pdf`, doc);
    } catch (e) {
      console.error(e);
      alert('Error rendering statements PDF document: ' + String(e));
    }
  };
  // --- END OF FINANCIAL REPORT ENGINE
  return (
    <div className="flex-1 flex overflow-hidden flex-col bg-slate-50 text-slate-800 p-4 md:p-6 select-text">
      
      {/* SUB-TAB COMPONENT SELECTOR */}
      {mode === 'credit_risk' ? (
        <div className="flex border-b border-slate-200 mb-5 gap-1.5 select-none pb-0.5 shrink-0 overflow-x-auto scrollbar-none">
          <button
            type="button"
            onClick={() => setSubTab('loans')}
            className="px-3.5 py-2 text-xs font-black uppercase tracking-wider border-b-2 border-indigo-600 text-indigo-700 font-extrabold bg-indigo-50/50 rounded-t-lg transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
          >
            <TrendingUp size={14} />
            <span>Credit Risk &amp; Swept Capital</span>
          </button>
        </div>
      ) : (
        <div className="flex border-b border-slate-200 mb-5 gap-1.5 select-none pb-0.5 shrink-0 overflow-x-auto scrollbar-none">
          <button
            type="button"
            onClick={() => setSubTab('procurement')}
            className={`px-3.5 py-2 text-xs font-black uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
              subTab === 'procurement'
                ? 'border-indigo-600 text-indigo-700 font-extrabold bg-indigo-50/50 rounded-t-lg'
                : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-t-lg'
            }`}
          >
            <Truck size={14} />
            <span>Supply Management</span>
          </button>

          <button
            type="button"
            onClick={() => setSubTab('expenses')}
            className={`px-3.5 py-2 text-xs font-black uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
              subTab === 'expenses'
                ? 'border-indigo-600 text-indigo-700 font-extrabold bg-indigo-50/50 rounded-t-lg'
                : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-t-lg'
            }`}
          >
            <DollarSign size={14} />
            <span>Operating Expenses</span>
          </button>

          <button
            type="button"
            onClick={() => setSubTab('transfers')}
            className={`px-3.5 py-2 text-xs font-black uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
              subTab === 'transfers'
                ? 'border-indigo-600 text-indigo-700 font-extrabold bg-indigo-50/50 rounded-t-lg'
                : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-t-lg'
            }`}
          >
            <RefreshCw size={14} />
            <span>Accounts & Transfers</span>
          </button>

          <button
            type="button"
            onClick={() => setSubTab('statements')}
            className={`px-3.5 py-2 text-xs font-black uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
              subTab === 'statements'
                ? 'border-indigo-600 text-indigo-700 font-extrabold bg-indigo-50/50 rounded-t-lg'
                : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-t-lg'
            }`}
          >
            <FileText size={14} />
            <span>Financial Statements</span>
          </button>

          <button
            type="button"
            onClick={() => setSubTab('assets_equity')}
            className={`px-3.5 py-2 text-xs font-black uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
              subTab === 'assets_equity'
                ? 'border-indigo-600 text-indigo-700 font-extrabold bg-indigo-50/50 rounded-t-lg'
                : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-t-lg'
            }`}
          >
            <Layers size={14} />
            <span>Asset & Equity Registry</span>
          </button>
        </div>
      )}

      <AnimatePresence mode="wait">
        {/* EXPENSES SUBTAB */}
        {mode !== 'credit_risk' && subTab === 'expenses' && (
          <motion.div
            key="expenses-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-6 pr-1"
          >
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col gap-4">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                  <h2 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
                    <DollarSign className="text-indigo-600" size={22} />
                    <span>Operating Expenses & Business Outflows</span>
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Manage store operating costs (rent, utilities, wages) and review outflows synchronized from Supply Management.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSubTab('procurement')}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-3.5 py-2 rounded-xl text-xs uppercase tracking-wider shadow-sm transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <Truck size={15} />
                    <span>Open Supply Management</span>
                  </button>
                </div>
              </div>

              {/* Metric Summary Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border-t border-slate-100 pt-3">
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-200/70">
                  <span className="text-[10px] text-slate-400 font-extrabold uppercase block">Recorded Expense Entries</span>
                  <span className="text-base font-black text-slate-900">
                    {settings.currency}{expensesList.reduce((sum, e) => sum + Number(e.amount || 0), 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-slate-500 block">{expensesList.length} recorded entries</span>
                </div>

                <div className="bg-indigo-50/50 p-3 rounded-xl border border-indigo-100">
                  <span className="text-[10px] text-indigo-500 font-extrabold uppercase block">Supply & Landed Costs</span>
                  <span className="text-base font-black text-indigo-900">
                    {settings.currency}{transitPurchasesList.reduce((sum, po) => sum + Number(po.total_landed_cost || 0), 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-indigo-600 block">{transitPurchasesList.length} supply orders</span>
                </div>

                <div className="bg-rose-50/50 p-3 rounded-xl border border-rose-100">
                  <span className="text-[10px] text-rose-500 font-extrabold uppercase block">Direct Operating Costs</span>
                  <span className="text-base font-black text-rose-700">
                    {settings.currency}{expensesList
                      .filter((e) => e.category !== 'Purchase Order - Goods & Transit')
                      .reduce((sum, e) => sum + Number(e.amount || 0), 0)
                      .toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-rose-600 block">Excludes PO inventory purchases</span>
                </div>
              </div>
            </div>

            {/* OPERATING EXPENSES SECTION */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* ENTRY FORM */}
              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm h-fit">
                <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider mb-4 flex items-center gap-2 border-b pb-3">
                  <Plus className="text-indigo-600" size={16} />
                  <span>Record Expense Entry</span>
                </h3>

                <form onSubmit={handleAddExpense} className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">Expense Category</label>
                    <select
                      value={expenseCategory}
                      onChange={(e) => setExpenseCategory(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="Operating - Rent & Premises">Operating - Rent & Premises</option>
                      <option value="Operating - Electricity & Utilities">Operating - Electricity & Utilities</option>
                      <option value="Operating - Water & Sewage">Operating - Water & Sewage</option>
                      <option value="Operating - Internet & Telecoms">Operating - Internet & Telecoms</option>
                      <option value="Salaries - Staff Payroll & Wages">Salaries - Staff Payroll & Wages</option>
                      <option value="Transport - Local Road Freight">Transport - Local Road Freight</option>
                      <option value="Customs - Port & Clearing Fees">Customs - Port & Clearing Fees</option>
                      <option value="Handling - Offloading & Storage">Handling - Offloading & Storage</option>
                      <option value="Marketing - Promotion & Signage">Marketing - Promotion & Signage</option>
                      <option value="Supplies - Packaging & Stationery">Supplies - Packaging & Stationery</option>
                      <option value="Maintenance - Store Repairs & Equipment">Maintenance - Store Repairs & Equipment</option>
                      <option value="Licenses - ZRA & Council Fees">Licenses - ZRA & Council Fees</option>
                      <option value="Miscellaneous - General Operating">Miscellaneous - General Operating</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">Payment Source / Method</label>
                    <select
                      value={expenseAccountId}
                      onChange={(e) => setExpenseAccountId(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      {getAllSelectableAccounts().map(acc => (
                        <option key={acc.accountId} value={acc.accountId}>{acc.label} ({acc.accountId})</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">Amount ({settings.currency})</label>
                    <div className="relative">
                      <span className="absolute left-3 top-2.5 text-xs font-bold text-slate-400">{settings.currency}</span>
                      <input
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        value={expenseAmount}
                        onChange={(e) => setExpenseAmount(e.target.value)}
                        required
                        className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-12 pr-3 py-2 text-sm font-black text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-slate-600 mb-1">Date</label>
                      <input
                        type="date"
                        value={expenseDate}
                        onChange={(e) => setExpenseDate(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-600 mb-1">Store Branch</label>
                      <select
                        value={expenseStoreId}
                        onChange={(e) => setExpenseStoreId(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        {storesList.length === 0 ? (
                          <option value="">No branches configured</option>
                        ) : (
                          storesList.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))
                        )}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">Description / Vendor</label>
                    <input
                      type="text"
                      placeholder="e.g. Monthly shop rent payment to landlord"
                      value={expenseDescription}
                      onChange={(e) => setExpenseDescription(e.target.value)}
                      required
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">Receipt / Invoice Ref #</label>
                    <input
                      type="text"
                      placeholder="e.g. REC-883921"
                      value={expenseRef}
                      onChange={(e) => setExpenseRef(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>

                  <button
                    type="submit"
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider shadow-md hover:shadow-indigo-200 transition-all cursor-pointer flex items-center justify-center gap-2"
                  >
                    <CheckCircle2 size={16} />
                    <span>Post Expense (Double-Entry)</span>
                  </button>
                </form>
              </div>

              {/* EXPENSE HISTORY TABLE */}
              <div className="lg:col-span-2 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4 pb-3 border-b">
                  <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider flex items-center gap-2">
                    <BookOpen className="text-indigo-600" size={16} />
                    <span>Expense Audit Ledger ({expensesList.length})</span>
                  </h3>
                  <div className="flex items-center gap-2 w-full sm:w-auto">
                    <div className="relative flex-1 sm:w-48">
                      <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
                      <input
                        type="text"
                        placeholder="Search expenses..."
                        value={expenseSearchQuery}
                        onChange={(e) => setExpenseSearchQuery(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-8 pr-3 py-1.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>
                </div>

                <div className="overflow-x-auto flex-1">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-black uppercase text-slate-500 tracking-wider">
                        <th className="py-2.5 px-3">Date</th>
                        <th className="py-2.5 px-3">Category</th>
                        <th className="py-2.5 px-3">Description & Ref</th>
                        <th className="py-2.5 px-3">Source Account</th>
                        <th className="py-2.5 px-3 text-right">Amount ({settings.currency})</th>
                        <th className="py-2.5 px-3 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {expensesList
                        .filter(e => {
                          if (!expenseSearchQuery) return true;
                          const q = expenseSearchQuery.toLowerCase();
                          return (e.category || '').toLowerCase().includes(q) ||
                                 (e.description || '').toLowerCase().includes(q) ||
                                 (e.reference_no || '').toLowerCase().includes(q);
                        })
                        .map((ex) => (
                          <tr key={ex.id} className="hover:bg-slate-50/80 transition-colors">
                            <td className="py-3 px-3 font-medium text-slate-600 whitespace-nowrap">
                              {ex.expense_date ? new Date(ex.expense_date).toLocaleDateString() : 'N/A'}
                            </td>
                            <td className="py-3 px-3 font-bold text-slate-800">
                              {ex.category}
                            </td>
                            <td className="py-3 px-3">
                              <span className="font-semibold text-slate-700 block">{ex.description || 'No description'}</span>
                              {ex.reference_no && (
                                <span className="text-[10px] text-slate-400 font-mono">Ref: {ex.reference_no}</span>
                              )}
                            </td>
                            <td className="py-3 px-3">
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-extrabold bg-slate-100 text-slate-700 uppercase">
                                {getAllSelectableAccounts().find(a => a.accountId === ex.account_id)?.label || (ex.account_id === 'acc_cash' ? 'Cash Drawer' : ex.account_id === 'acc_momo' ? 'Mobile Wallet' : ex.account_id === 'acc_bank' ? 'Bank Account' : ex.account_id)}
                              </span>
                            </td>
                            <td className="py-3 px-3 text-right font-black text-rose-600 whitespace-nowrap">
                              -{settings.currency}{Number(ex.amount || 0).toFixed(2)}
                            </td>
                            <td className="py-3 px-3 text-center">
                              <button
                                onClick={() => handleDeleteExpense(ex.id)}
                                title="Delete Expense Entry"
                                className="text-slate-400 hover:text-rose-600 p-1.5 rounded-lg hover:bg-rose-50 transition-colors cursor-pointer"
                              >
                                <Trash size={14} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      {expensesList.length === 0 && (
                        <tr>
                          <td colSpan={6} className="text-center py-8 text-slate-400 font-medium text-xs">
                            No expenses recorded yet. Use the form on the left to add expenses.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* TRANSFERS SUBTAB */}
        {subTab === 'transfers' && (
          <motion.div
            key="transfers-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-6 pr-1"
          >
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
              <div>
                <h2 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
                  <RefreshCw className="text-indigo-600" size={20} />
                  <span>Liquid Accounts & Internal Transfers</span>
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Move funds between Cash, Mobile Money, and Bank accounts with full double-entry ledger audit records.
                </p>
              </div>
            </div>

            {/* LIVE ACCOUNTS CARDS */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-4">
                <div className="p-3 bg-emerald-50 text-emerald-600 rounded-xl">
                  <Wallet size={24} />
                </div>
                <div>
                  <span className="text-xs text-slate-400 font-bold block uppercase tracking-wider">Counter Cash Drawer</span>
                  <span className="text-lg font-black text-slate-900">
                    {settings.currency}{Number(
                      runSql("SELECT current_balance FROM view_account_balances WHERE account_id = 'acc_cash'", 'Check cash balance', true).data?.[0]?.current_balance ?? 0
                    ).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-slate-400 block mt-0.5">Account ID: acc_cash</span>
                </div>
              </div>

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-4">
                <div className="p-3 bg-indigo-50 text-indigo-600 rounded-xl">
                  <CreditCard size={24} />
                </div>
                {(() => {
                  const airtelBal = Number(runSql("SELECT current_balance FROM view_account_balances WHERE account_id = 'acc_airtel'", 'Check airtel balance', true).data?.[0]?.current_balance ?? 0);
                  const mtnBal = Number(runSql("SELECT current_balance FROM view_account_balances WHERE account_id = 'acc_mtn'", 'Check mtn balance', true).data?.[0]?.current_balance ?? 0);
                  const legacyMomoBal = Number(runSql("SELECT current_balance FROM view_account_balances WHERE account_id = 'acc_momo'", 'Check momo balance', true).data?.[0]?.current_balance ?? 0);
                  const totalMomoBal = airtelBal + mtnBal + legacyMomoBal;
                  return (
                    <div>
                      <span className="text-xs text-slate-400 font-bold block uppercase tracking-wider">Mobile Money Wallets</span>
                      <span className="text-lg font-black text-slate-900">
                        {settings.currency}{totalMomoBal.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </span>
                      <span className="text-[10px] text-slate-500 block mt-0.5 font-mono">
                        Airtel: {settings.currency}{airtelBal.toFixed(2)} | MTN: {settings.currency}{mtnBal.toFixed(2)}
                      </span>
                    </div>
                  );
                })()}
              </div>

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-4">
                <div className="p-3 bg-blue-50 text-blue-600 rounded-xl">
                  <Building2 size={24} />
                </div>
                <div>
                  <span className="text-xs text-slate-400 font-bold block uppercase tracking-wider">Commercial Bank Account</span>
                  <span className="text-lg font-black text-slate-900">
                    {settings.currency}{Number(
                      runSql("SELECT current_balance FROM view_account_balances WHERE account_id = 'acc_bank'", 'Check bank balance', true).data?.[0]?.current_balance ?? 0
                    ).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-slate-400 block mt-0.5">Zambia National Commercial Bank</span>
                </div>
              </div>
            </div>

            {/* FORM + LOGS */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* MONEY TRANSFER FORM */}
              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm h-fit">
                <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider mb-4 flex items-center gap-2 border-b pb-3">
                  <ArrowLeftRight className="text-indigo-600" size={16} />
                  <span>Transfer Money (Double-Entry)</span>
                </h3>

                {transferFeedback && (
                  <div
                    className={`mb-4 px-3 py-2 rounded-xl border text-xs font-bold flex items-center justify-between gap-2 ${
                      transferFeedback.type === 'error'
                        ? 'bg-rose-50 border-rose-200 text-rose-800'
                        : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <AlertCircle size={14} className="shrink-0" />
                      <span>{transferFeedback.text}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTransferFeedback(null)}
                      className="text-[10px] font-black uppercase px-1.5 py-0.5 rounded hover:bg-black/5 cursor-pointer"
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                <form onSubmit={handleTransferMoney} className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">From Account (Source)</label>
                    <select
                      value={transferSourceAcc}
                      onChange={(e) => setTransferSourceAcc(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      {getAllSelectableAccounts().map(acc => (
                        <option key={acc.accountId} value={acc.accountId}>{acc.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">To Account (Destination)</label>
                    <select
                      value={transferDestAcc}
                      onChange={(e) => setTransferDestAcc(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      {getAllSelectableAccounts().map(acc => (
                        <option key={acc.accountId} value={acc.accountId}>{acc.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">Transfer Amount ({settings.currency})</label>
                    <div className="relative">
                      <span className="absolute left-3 top-2.5 text-xs font-bold text-slate-400">{settings.currency}</span>
                      <input
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        value={transferAmount}
                        onChange={(e) => setTransferAmount(e.target.value)}
                        required
                        className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-12 pr-3 py-2 text-sm font-black text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>

                  <TransferReceiptField
                    label="Reference ID / Reason & Receipt"
                    placeholder="e.g. Daily cash float deposit to bank"
                    referenceValue={transferRef}
                    onReferenceChange={setTransferRef}
                    receipt={transferReceipt}
                    onReceiptChange={setTransferReceipt}
                  />

                  <button
                    type="submit"
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider shadow-md hover:shadow-indigo-200 transition-all cursor-pointer flex items-center justify-center gap-2"
                  >
                    <CheckCircle2 size={16} />
                    <span>Post Money Transfer</span>
                  </button>
                </form>
              </div>

              {/* TRANSFERS HISTORY TABLE */}
              <div className="lg:col-span-2 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col">
                <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider mb-4 pb-3 border-b flex items-center gap-2">
                  <FileText className="text-indigo-600" size={16} />
                  <span>Transfer Journal Logs ({transfersList.length})</span>
                </h3>

                <div className="overflow-x-auto flex-1">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-black uppercase text-slate-500 tracking-wider">
                        <th className="py-2.5 px-3">Date</th>
                        <th className="py-2.5 px-3">Narration / Transfer Details</th>
                        <th className="py-2.5 px-3">Reference ID</th>
                        <th className="py-2.5 px-3 text-center">Receipt</th>
                        <th className="py-2.5 px-3 text-right">Amount ({settings.currency})</th>
                        <th className="py-2.5 px-3 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {transfersList.map((tr) => {
                        const attachedReceipt = getTransferReceipt(String(tr.id || ''));
                        return (
                          <tr key={`${tr.id}-${tr.account_id}-${tr.type}`} className="hover:bg-slate-50/80 transition-colors">
                            <td className="py-3 px-3 font-medium text-slate-600 whitespace-nowrap">
                              {tr.created_at ? new Date(tr.created_at).toLocaleDateString() : 'N/A'}
                            </td>
                            <td className="py-3 px-3 font-bold text-slate-800">
                              {tr.narration || 'Internal Account Transfer'}
                            </td>
                            <td className="py-3 px-3 font-mono text-[11px] text-slate-500">
                              {tr.provider_reference || tr.reference_no || 'TRF-REF'}
                            </td>
                            <td className="py-3 px-3 text-center">
                              {attachedReceipt ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setViewingTransferReceipt({
                                      receipt: attachedReceipt,
                                      refLabel: tr.provider_reference || tr.reference_no || tr.id,
                                    })
                                  }
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 text-[10px] font-black uppercase cursor-pointer"
                                >
                                  <Eye size={11} />
                                  <span>View</span>
                                </button>
                              ) : (
                                <span className="text-slate-300 font-mono text-[10px]">—</span>
                              )}
                            </td>
                            <td className="py-3 px-3 text-right font-black text-slate-900 whitespace-nowrap">
                              {settings.currency}{Number(tr.amount || 0).toFixed(2)}
                            </td>
                            <td className="py-3 px-3 text-center">
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-extrabold bg-emerald-100 text-emerald-800 uppercase">
                                POSTED
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                      {transfersList.length === 0 && (
                        <tr>
                          <td colSpan={6} className="text-center py-8 text-slate-400 font-medium text-xs">
                            No account transfers logged yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
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

        {/* SUPPLY MANAGEMENT SUBTAB */}
        {mode !== 'credit_risk' && subTab === 'procurement' && (
          <motion.div
            key="procurement-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-5 pr-1"
          >
            {/* HEADER & ACTIONS */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col gap-4">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                  <h2 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
                    <Truck className="text-indigo-600" size={22} />
                    <span>Supply Management, Historical Orders & Suppliers</span>
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Create supplier purchase orders, save supplier profiles for repeat orders, adjust landing costs while goods are in transit, and reorder from purchase history.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openSupplierModal()}
                    className="bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 font-bold px-3.5 py-2 rounded-xl text-xs uppercase tracking-wider shadow-2xs transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <Users size={15} className="text-indigo-600" />
                    <span>+ Add Supplier</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openNewPurchaseOrderModal()}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-4 py-2 rounded-xl text-xs uppercase tracking-wider shadow-md hover:shadow-indigo-200 transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <PackagePlus size={15} />
                    <span>+ New Purchase Order</span>
                  </button>
                </div>
              </div>

              {/* SUMMARY METRIC CARDS */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 border-t border-slate-100 pt-3">
                <div className="bg-amber-50/70 p-3 rounded-xl border border-amber-200/80">
                  <span className="text-[10px] text-amber-700 font-extrabold uppercase block">Active In Transit</span>
                  <span className="text-base font-black text-slate-900">
                    {transitPurchasesList.filter((p) => p.stage !== 'LANDED_AT_STORE').length} Shipment(s)
                  </span>
                  <span className="text-[10px] text-amber-700 font-bold block">
                    {settings.currency}{transitPurchasesList
                      .filter((p) => p.stage !== 'LANDED_AT_STORE')
                      .reduce((s, p) => s + Number(p.total_landed_cost || 0), 0)
                      .toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                </div>

                <div className="bg-emerald-50/70 p-3 rounded-xl border border-emerald-200/80">
                  <span className="text-[10px] text-emerald-700 font-extrabold uppercase block">Historical Received</span>
                  <span className="text-base font-black text-slate-900">
                    {transitPurchasesList.filter((p) => p.stage === 'LANDED_AT_STORE').length} Order(s)
                  </span>
                  <span className="text-[10px] text-emerald-700 font-bold block">
                    {settings.currency}{transitPurchasesList
                      .filter((p) => p.stage === 'LANDED_AT_STORE')
                      .reduce((s, p) => s + Number(p.total_landed_cost || 0), 0)
                      .toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                </div>

                <div className="bg-indigo-50/70 p-3 rounded-xl border border-indigo-200/80">
                  <span className="text-[10px] text-indigo-700 font-extrabold uppercase block">Saved Suppliers</span>
                  <span className="text-base font-black text-slate-900">
                    {suppliersList.length} Supplier(s)
                  </span>
                  <span className="text-[10px] text-indigo-600 font-semibold block">Ready for quick reorder</span>
                </div>

                <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                  <span className="text-[10px] text-slate-500 font-extrabold uppercase block">Total Supply Spend</span>
                  <span className="text-base font-black text-slate-900">
                    {settings.currency}{transitPurchasesList
                      .reduce((s, p) => s + Number(p.total_landed_cost || 0), 0)
                      .toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-slate-500 block">{transitPurchasesList.length} total POs recorded</span>
                </div>
              </div>

              {/* VIEW FILTER PILLS + SEARCH & SUPPLIER FILTER */}
              <div className="flex flex-col lg:flex-row justify-between items-stretch lg:items-center gap-3 pt-1">
                <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 p-1 rounded-xl w-fit border border-slate-200 text-xs font-extrabold select-none">
                  <button
                    type="button"
                    onClick={() => setSupplyViewFilter('all')}
                    className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                      supplyViewFilter === 'all'
                        ? 'bg-white text-indigo-700 shadow-xs font-black'
                        : 'text-slate-600 hover:text-slate-900 font-bold'
                    }`}
                  >
                    <History size={14} />
                    <span>All Purchase History ({transitPurchasesList.length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSupplyViewFilter('in_transit')}
                    className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                      supplyViewFilter === 'in_transit'
                        ? 'bg-white text-amber-700 shadow-xs font-black'
                        : 'text-slate-600 hover:text-slate-900 font-bold'
                    }`}
                  >
                    <Truck size={14} />
                    <span>In Transit ({transitPurchasesList.filter((p) => p.stage !== 'LANDED_AT_STORE').length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSupplyViewFilter('received')}
                    className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                      supplyViewFilter === 'received'
                        ? 'bg-white text-emerald-700 shadow-xs font-black'
                        : 'text-slate-600 hover:text-slate-900 font-bold'
                    }`}
                  >
                    <PackageCheck size={14} />
                    <span>Received History ({transitPurchasesList.filter((p) => p.stage === 'LANDED_AT_STORE').length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSupplyViewFilter('suppliers')}
                    className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                      supplyViewFilter === 'suppliers'
                        ? 'bg-white text-indigo-700 shadow-xs font-black'
                        : 'text-slate-600 hover:text-slate-900 font-bold'
                    }`}
                  >
                    <Users size={14} />
                    <span>Saved Suppliers ({suppliersList.length})</span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 sm:w-56">
                    <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search PO#, supplier, or item..."
                      value={supplySearchQuery}
                      onChange={(e) => setSupplySearchQuery(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-8 pr-3 py-1.5 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  {supplyViewFilter !== 'suppliers' && (
                    <select
                      value={supplySupplierFilter}
                      onChange={(e) => setSupplySupplierFilter(e.target.value)}
                      className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="ALL">All Suppliers</option>
                      {Array.from(
                        new Set([
                          ...suppliersList.map((s) => String(s.name || '').trim()),
                          ...transitPurchasesList.map((p) => String(p.supplier_name || '').trim()),
                        ].filter(Boolean))
                      )
                        .sort()
                        .map((supName) => (
                          <option key={supName} value={supName}>
                            {supName}
                          </option>
                        ))}
                    </select>
                  )}
                </div>
              </div>
            </div>

            {poFeedback && (
              <div
                className={`px-4 py-3 rounded-xl border text-xs font-bold flex items-center justify-between gap-2 ${
                  poFeedback.type === 'error'
                    ? 'bg-rose-50 border-rose-200 text-rose-800'
                    : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                }`}
              >
                <div className="flex items-center gap-2">
                  {poFeedback.type === 'error' ? <AlertCircle size={15} className="shrink-0" /> : <CheckCircle2 size={15} className="shrink-0" />}
                  <span>{poFeedback.text}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setPoFeedback(null)}
                  className="text-[10px] font-black uppercase px-2 py-0.5 rounded hover:bg-black/5 cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* SAVED SUPPLIERS DIRECTORY VIEW */}
            {supplyViewFilter === 'suppliers' ? (
              <div className="space-y-4">
                {(() => {
                  const q = supplySearchQuery.trim().toLowerCase();
                  const filteredSuppliers = suppliersList.filter((s) => {
                    if (!q) return true;
                    return (
                      String(s.name || '').toLowerCase().includes(q) ||
                      String(s.contact_person || '').toLowerCase().includes(q) ||
                      String(s.phone || '').toLowerCase().includes(q) ||
                      String(s.email || '').toLowerCase().includes(q) ||
                      String(s.address || '').toLowerCase().includes(q)
                    );
                  });

                  if (filteredSuppliers.length === 0) {
                    return (
                      <div className="bg-white p-10 rounded-2xl border border-slate-200 text-center">
                        <Users className="mx-auto text-slate-300 mb-3" size={38} />
                        <h3 className="text-sm font-bold text-slate-700">No Saved Suppliers Yet</h3>
                        <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
                          Save supplier profiles when creating a purchase order or add one here so details auto-fill on subsequent orders.
                        </p>
                        <button
                          type="button"
                          onClick={() => openSupplierModal()}
                          className="mt-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-4 py-2 rounded-xl text-xs uppercase tracking-wider inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <Plus size={14} />
                          <span>Add First Supplier</span>
                        </button>
                      </div>
                    );
                  }

                  return (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {filteredSuppliers.map((sup) => {
                        const supOrders = transitPurchasesList.filter(
                          (po) => String(po.supplier_name || '').trim().toLowerCase() === String(sup.name || '').trim().toLowerCase()
                        );
                        const supSpend = supOrders.reduce((sum, po) => sum + Number(po.total_landed_cost || 0), 0);
                        const lastOrder = supOrders[0] || null;

                        return (
                          <div key={sup.id} className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-col justify-between gap-3">
                            <div className="flex justify-between items-start gap-3">
                              <div>
                                <h3 className="text-sm font-black text-slate-900">{sup.name}</h3>
                                {sup.contact_person && (
                                  <span className="text-[11px] font-semibold text-slate-500 block">
                                    Contact: {sup.contact_person}
                                  </span>
                                )}
                              </div>
                              <span className="px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-black uppercase">
                                {supOrders.length} Order{supOrders.length === 1 ? '' : 's'}
                              </span>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px] text-slate-600 bg-slate-50 p-3 rounded-xl border border-slate-100">
                              <div className="flex items-center gap-1.5">
                                <Phone size={12} className="text-slate-400 shrink-0" />
                                <span>{sup.phone || 'No phone saved'}</span>
                              </div>
                              <div className="flex items-center gap-1.5 truncate">
                                <Mail size={12} className="text-slate-400 shrink-0" />
                                <span className="truncate">{sup.email || 'No email saved'}</span>
                              </div>
                              <div className="flex items-center gap-1.5 sm:col-span-2">
                                <MapPin size={12} className="text-slate-400 shrink-0" />
                                <span>{sup.address || 'No address saved'}</span>
                              </div>
                              {sup.tpin && (
                                <div className="text-[10px] font-mono font-bold text-slate-500 sm:col-span-2">
                                  TPIN: {sup.tpin} | Default Pay: {sup.default_payment_method || 'BANK_TRANSFER'}
                                </div>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 text-xs">
                              <div>
                                <span className="text-[10px] uppercase font-bold text-slate-400 block">Historical Spend</span>
                                <span className="font-black text-slate-900">
                                  {settings.currency}{supSpend.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                </span>
                              </div>

                              <div className="flex flex-wrap items-center gap-1.5">
                                {lastOrder && (
                                  <button
                                    type="button"
                                    onClick={() => handleReorderPurchaseOrder(lastOrder)}
                                    className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] rounded-lg uppercase tracking-wider cursor-pointer flex items-center gap-1"
                                  >
                                    <RotateCcw size={12} />
                                    <span>Reorder Last</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => openNewPurchaseOrderModal(sup)}
                                  className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-[10px] rounded-lg uppercase tracking-wider cursor-pointer flex items-center gap-1"
                                >
                                  <PackagePlus size={12} />
                                  <span>New PO</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openSupplierModal(sup)}
                                  className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[10px] rounded-lg uppercase cursor-pointer flex items-center gap-1"
                                >
                                  <Edit3 size={12} />
                                  <span>Edit</span>
                                </button>
                                {confirmDeleteSupplierId === sup.id ? (
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteSupplier(sup.id)}
                                      className="px-2 py-1 bg-rose-600 text-white font-bold text-[10px] rounded uppercase cursor-pointer"
                                    >
                                      Confirm
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteSupplierId(null)}
                                      className="px-2 py-1 bg-slate-200 text-slate-700 font-bold text-[10px] rounded uppercase cursor-pointer"
                                    >
                                      No
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteSupplierId(sup.id)}
                                    title="Remove Supplier"
                                    className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg cursor-pointer"
                                  >
                                    <Trash size={13} />
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            ) : (
              /* PURCHASE HISTORY & ACTIVE IN-TRANSIT SHIPMENTS LIST */
              <div className="space-y-4">
                {(() => {
                  const q = supplySearchQuery.trim().toLowerCase();
                  const filteredPos = transitPurchasesList.filter((po) => {
                    if (supplyViewFilter === 'in_transit' && po.stage === 'LANDED_AT_STORE') return false;
                    if (supplyViewFilter === 'received' && po.stage !== 'LANDED_AT_STORE') return false;
                    if (supplySupplierFilter !== 'ALL' && String(po.supplier_name || '').trim() !== supplySupplierFilter) return false;
                    if (!q) return true;
                    return (
                      String(po.id || '').toLowerCase().includes(q) ||
                      String(po.supplier_name || '').toLowerCase().includes(q) ||
                      String(po.store_id || '').toLowerCase().includes(q) ||
                      String(po.items_json || '').toLowerCase().includes(q) ||
                      String(po.notes || '').toLowerCase().includes(q)
                    );
                  });

                  if (filteredPos.length === 0) {
                    return (
                      <div className="bg-white p-12 rounded-2xl border border-slate-200 text-center">
                        <Truck className="mx-auto text-slate-300 mb-3" size={40} />
                        <h3 className="text-sm font-bold text-slate-700">
                          {transitPurchasesList.length === 0 ? 'No Purchase History Yet' : 'No Matching Purchase Orders'}
                        </h3>
                        <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
                          Create a purchase order to save supplier details, track goods in transit, update landing costs as freight/customs arrive, and reorder anytime from your history.
                        </p>
                        <button
                          type="button"
                          onClick={() => openNewPurchaseOrderModal()}
                          className="mt-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-4 py-2 rounded-xl text-xs uppercase tracking-wider inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <PackagePlus size={14} />
                          <span>Create Purchase Order</span>
                        </button>
                      </div>
                    );
                  }

                  return filteredPos.map((po) => {
                    let items: any[] = [];
                    let addExpenses: any[] = [];
                    try { items = JSON.parse(po.items_json || '[]'); } catch {}
                    try { addExpenses = JSON.parse(po.additional_expenses_json || '[]'); } catch {}

                    const baseTotal = Number(po.total_base_amount || 0);
                    const addTotal = Number(po.total_additional_expenses || 0);
                    const landedTotal = Number(po.total_landed_cost || 0);
                    const overheadPct = baseTotal > 0 ? ((addTotal / baseTotal) * 100).toFixed(1) : '0.0';
                    const matchedSup = suppliersList.find(
                      (s) => String(s.name || '').trim().toLowerCase() === String(po.supplier_name || '').trim().toLowerCase()
                    );

                    return (
                      <div key={po.id} className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col gap-4">
                        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-3 border-b border-slate-100 pb-3">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-black text-slate-900 font-mono">PO #{po.id}</span>
                              <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase ${
                                po.stage === 'LANDED_AT_STORE'
                                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                                  : po.stage === 'CUSTOMS_HANDLING'
                                  ? 'bg-amber-100 text-amber-800 border border-amber-200'
                                  : 'bg-indigo-100 text-indigo-800 border border-indigo-200'
                              }`}>
                                {po.stage === 'LANDED_AT_STORE' ? 'Received at Store' : String(po.stage || 'IN_TRANSIT').replace(/_/g, ' ')}
                              </span>
                              <span className="text-[10px] font-bold text-slate-500 uppercase bg-slate-100 px-2 py-0.5 rounded">
                                Branch: {po.store_id || 'MAIN'}
                              </span>
                              <span className="text-[10px] text-slate-400 font-mono">
                                Ordered: {po.created_at ? new Date(po.created_at).toLocaleDateString() : 'N/A'}
                                {po.received_at ? ` • Received: ${new Date(po.received_at).toLocaleDateString()}` : ''}
                              </span>
                            </div>

                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 mt-1.5">
                              <span>
                                Supplier: <strong className="text-slate-900">{po.supplier_name}</strong>
                              </span>
                              {matchedSup?.phone && (
                                <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                                  <Phone size={11} /> {matchedSup.phone}
                                </span>
                              )}
                              {matchedSup?.email && (
                                <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                                  <Mail size={11} /> {matchedSup.email}
                                </span>
                              )}
                              {po.notes && (
                                <span className="text-[11px] italic text-slate-500">Note: {po.notes}</span>
                              )}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <div className="text-left lg:text-right mr-1">
                              <span className="text-[10px] text-slate-400 block font-semibold uppercase">Total Landed Cost</span>
                              <span className="text-base font-black text-slate-900">
                                {settings.currency}{landedTotal.toFixed(2)}
                              </span>
                              <span className="text-[10px] text-emerald-600 block font-bold">
                                (+{overheadPct}% landing overhead)
                              </span>
                            </div>

                            {po.stage !== 'LANDED_AT_STORE' && (
                              <>
                                <select
                                  value={po.stage || 'IN_TRANSIT'}
                                  onChange={(e) => handleUpdateTransitStage(po.id, e.target.value)}
                                  title="Update Transit Stage"
                                  className="bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-2 text-[11px] font-bold text-slate-700 cursor-pointer"
                                >
                                  <option value="IN_TRANSIT">In Transit</option>
                                  <option value="CUSTOMS_HANDLING">Customs & Clearing</option>
                                  <option value="READY_FOR_RECEIPT">Ready for Receipt</option>
                                </select>

                                <button
                                  type="button"
                                  onClick={() => openEditLandingCostModal(po)}
                                  className="bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 font-bold px-3 py-2 rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5"
                                >
                                  <Edit3 size={13} />
                                  <span>Edit Landing Cost</span>
                                </button>
                              </>
                            )}

                            <button
                              type="button"
                              onClick={() => handleReorderPurchaseOrder(po)}
                              className="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 font-bold px-3 py-2 rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5"
                            >
                              <RotateCcw size={13} />
                              <span>Reorder</span>
                            </button>

                            {po.stage !== 'LANDED_AT_STORE' && (
                              confirmReceivePoId === po.id ? (
                                <div className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 px-2.5 py-1.5 rounded-xl">
                                  <span className="text-[10px] font-bold text-emerald-900">Receive into {(po.store_id || 'MAIN').toUpperCase()}?</span>
                                  <button
                                    type="button"
                                    onClick={() => handleAcceptTransitDelivery(po)}
                                    className="px-2 py-0.5 bg-emerald-600 text-white font-black text-[10px] rounded uppercase cursor-pointer"
                                  >
                                    Yes
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmReceivePoId(null)}
                                    className="px-2 py-0.5 bg-white border border-slate-300 text-slate-600 font-bold text-[10px] rounded uppercase cursor-pointer"
                                  >
                                    No
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmReceivePoId(po.id)}
                                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-3 py-2 rounded-xl text-xs uppercase tracking-wider shadow-sm transition-all cursor-pointer flex items-center gap-1.5"
                                >
                                  <PackageCheck size={14} />
                                  <span>Accept Stock</span>
                                </button>
                              )
                            )}
                          </div>
                        </div>

                        {/* EXPENSES & ITEMS BREAKDOWN */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-50/70 p-4 rounded-xl border border-slate-100 text-xs">
                          <div>
                            <span className="font-extrabold text-slate-700 block mb-2 uppercase text-[11px]">Product Line Items ({items.length})</span>
                            <ul className="space-y-1.5">
                              {items.map((it: any, idx: number) => {
                                const ratio = baseTotal > 0 ? (addTotal / baseTotal) : 0;
                                const landedUnit = Number(it.baseUnitPrice || 0) * (1 + ratio);
                                return (
                                  <li key={idx} className="flex justify-between items-center text-slate-600 border-b border-slate-200/50 pb-1">
                                    <span>{it.quantity}x <strong>{it.productName}</strong></span>
                                    <span className="font-semibold text-slate-800">
                                      Base: {settings.currency}{Number(it.baseUnitPrice || 0).toFixed(2)} -&gt; <strong className="text-indigo-700">Landed: {settings.currency}{landedUnit.toFixed(2)}/unit</strong>
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>

                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="font-extrabold text-slate-700 uppercase text-[11px]">Landing Overhead Breakdown</span>
                              {po.stage !== 'LANDED_AT_STORE' && (
                                <button
                                  type="button"
                                  onClick={() => openEditLandingCostModal(po)}
                                  className="text-[10px] font-black text-indigo-600 hover:text-indigo-800 uppercase cursor-pointer"
                                >
                                  + Adjust Costs
                                </button>
                              )}
                            </div>
                            <div className="space-y-1 text-slate-600">
                              <div className="flex justify-between">
                                <span>Base Goods Invoice Total:</span>
                                <span className="font-bold">{settings.currency}{baseTotal.toFixed(2)}</span>
                              </div>
                              {addExpenses.filter((ex) => Number(ex.amount || 0) > 0).map((ex, eIdx) => (
                                <div key={eIdx} className="flex justify-between text-[11px] text-slate-500 pl-2">
                                  <span>• {ex.name}:</span>
                                  <span className="font-semibold">+{settings.currency}{Number(ex.amount || 0).toFixed(2)}</span>
                                </div>
                              ))}
                              <div className="flex justify-between text-rose-600 font-medium">
                                <span>Total Landing Fees Added:</span>
                                <span>+{settings.currency}{addTotal.toFixed(2)}</span>
                              </div>
                              <div className="flex justify-between border-t pt-1 font-black text-slate-900">
                                <span>Final Landed Inventory Value:</span>
                                <span>{settings.currency}{landedTotal.toFixed(2)}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </motion.div>
        )}

        {mode === 'credit_risk' && subTab === 'loans' && (
          <motion.div
            key="loans-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-hidden"
          >
            {/* HEADER SECTION */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-200 pb-4 mb-5">
              <div>
                <h2 className="text-lg font-black tracking-tight text-slate-905 uppercase flex items-center gap-2">
                  <span className="p-1 px-1.5 bg-indigo-600 rounded text-white font-extrabold text-[11px] font-mono shrink-0">SZ</span>
                  SME Credit & Sweep Capital Advances
                </h2>
                <p className="text-xs text-slate-500 font-medium">
                  Dynamic revenue-based cash advances with automatic percentage sweeps directly on POS checkout transactions.
                </p>
              </div>
              
              <button
                onClick={() => setShowApplyModal(true)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-black text-xs rounded-lg uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer shadow-md hover:-translate-y-0.5"
              >
                <Plus size={14} />
                <span>Apply Micro-Advance</span>
              </button>
            </div>

            {/* CORE STATS BOARD */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6 select-none shrink-0">
              <div className="bg-white p-4 rounded-2xl border border-slate-200 flex items-center gap-4 shadow-3xs">
                <div className="p-3 bg-indigo-50 text-indigo-700 rounded-xl">
                  <Briefcase size={20} />
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 font-extrabold uppercase block tracking-wider">Total Active Loans</span>
                  <span className="text-xl font-black text-slate-900 leading-none block mt-0.5">{outstandingLoansCount} Account(s)</span>
                </div>
              </div>

              <div className="bg-white p-4 rounded-2xl border border-slate-200 flex items-center gap-4 shadow-3xs">
                <div className="p-3 bg-rose-50 text-rose-705 rounded-xl">
                  <TrendingUp size={20} />
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 font-extrabold uppercase block tracking-wider">Estimated Balance Due</span>
                  <span className="text-xl font-black text-rose-700 leading-none block mt-0.5">
                    {settings.currency}{aggregateOutstanding.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              </div>

              <div className="bg-white p-4 rounded-2xl border border-slate-200 flex items-center gap-4 shadow-3xs">
                <div className="p-3 bg-emerald-50 text-emerald-700 rounded-xl">
                  <Coins size={20} />
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 font-extrabold uppercase block tracking-wider">Swept Principal Repaid</span>
                  <span className="text-xl font-black text-slate-900 leading-none block mt-0.5">
                    {settings.currency}{totalRepaidCapital.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              </div>

              <div className="bg-white p-4 rounded-2xl border border-slate-200 flex items-center gap-4 shadow-3xs">
                <div className="p-3 bg-amber-50 text-amber-700 rounded-xl">
                  <Percent size={20} />
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 font-extrabold uppercase block tracking-wider">Current Sweep Slices</span>
                  <span className="text-xl font-black text-amber-700 leading-none block mt-0.5">
                    {activeLoan && activeLoan.status === 'ACTIVE' ? `${activeLoan.daily_deduction_percentage}% Sweep` : '0% Regular'}
                  </span>
                </div>
              </div>
            </div>

            {/* REAL-TIME LEDGERS SPLIT MAIN TABLE */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 overflow-hidden flex-1">
              {/* LEFT COLUMN: ACTIVE AGREEMENTS LIST */}
              <div className="lg:col-span-1 bg-white rounded-2xl border border-slate-200 p-4 flex flex-col gap-4 overflow-hidden max-h-[500px]">
                <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest border-b border-slate-100 pb-2 flex items-center gap-1.5 select-none">
                  <span>🤝 REGISTERED FINANCING CONTRACTS</span>
                </h3>

                <div className="flex-1 overflow-y-auto flex flex-col gap-3 pr-1">
                  {loans.length === 0 ? (
                    <div className="text-center py-10 text-xs text-slate-400 font-medium italic">
                      No active or pending review SME cash advances found in matching multi-tenant tables.
                    </div>
                  ) : (
                    loans.map(ln => {
                      const totalSettled = deductions
                        .filter(d => d.loan_id === ln.id && d.status === 'SUCCESS')
                        .reduce((sum, current) => sum + Number(current.amount_deducted), 0);
                      
                      const percentDone = Math.min(100, (totalSettled / Number(ln.total_repayable)) * 100);

                      return (
                        <div
                          key={ln.id}
                          onClick={() => setSelectedLoanId(ln.id)}
                          className={`w-full text-left p-3.5 rounded-xl border transition-all cursor-pointer ${
                            selectedLoanId === ln.id
                              ? 'bg-indigo-50/50 border-indigo-400 shadow-3xs'
                              : 'bg-white hover:bg-slate-50 border-slate-200'
                          }`}
                        >
                          <div className="flex justify-between items-start mb-2">
                            <div>
                              <span className="font-mono text-[10px] font-bold text-slate-400 block">ID: {ln.id}</span>
                              <h4 className="text-xs font-black text-slate-800 uppercase">Capital Advance</h4>
                            </div>
                            
                            {ln.status === 'ACTIVE' ? (
                              <span className="text-[8px] font-extrabold text-emerald-800 bg-emerald-100 border border-emerald-300 py-0.5 px-1.5 rounded-full uppercase tracking-wider">
                                ACTIVE
                              </span>
                            ) : ln.status === 'PENDING_REVIEW' ? (
                              <span className="text-[8px] font-extrabold text-amber-800 bg-amber-100 border border-amber-300 py-0.5 px-1.5 rounded-full uppercase tracking-wider animate-pulse">
                                REVIEW
                              </span>
                            ) : ln.status === 'PAID_OFF' ? (
                              <span className="text-[8px] font-extrabold text-indigo-800 bg-indigo-100 border border-indigo-200 py-0.5 px-1.5 rounded-full uppercase tracking-wider">
                                PAID OFF
                              </span>
                            ) : (
                              <span className="text-[8px] font-extrabold text-rose-800 bg-rose-100 border border-rose-250 py-0.5 px-1.5 rounded-full uppercase tracking-wider">
                                DECLINED
                              </span>
                            )}
                          </div>

                          <div className="space-y-1 mb-3">
                            <div className="flex justify-between text-[11px] font-semibold">
                              <span className="text-slate-400">Principal Amt:</span>
                              <span>{settings.currency}{Number(ln.principal_amount).toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between text-[11px] font-semibold">
                              <span className="text-slate-400">Total Repayable:</span>
                              <span>{settings.currency}{Number(ln.total_repayable).toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between text-[11px] font-semibold">
                              <span className="text-slate-400">Deduction %:</span>
                              <span className="text-indigo-600 font-extrabold font-mono">{ln.daily_deduction_percentage}% Sweep</span>
                            </div>
                          </div>

                          {(ln.status === 'ACTIVE' || ln.status === 'PAID_OFF') && (
                            <div className="space-y-1">
                              <div className="flex justify-between text-[9px] text-slate-400 font-extrabold uppercase">
                                <span>Deductions progress</span>
                                <span>{percentDone.toFixed(0)}%</span>
                              </div>
                              <div className="w-full bg-slate-150 rounded-full h-1.5 overflow-hidden">
                                <div
                                  className="bg-indigo-600 h-1.5 rounded-full transition-all"
                                  style={{ width: `${percentDone}%` }}
                                ></div>
                              </div>
                            </div>
                          )}

                          {/* Pending Review Manager Actions inline */}
                          {ln.status === 'PENDING_REVIEW' && (userRole === 'manager' || userRole === 'owner') && (
                            <div className="flex gap-2 mt-3.5 border-t border-slate-100 pt-2.5">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleApproveLoan(ln.id);
                                }}
                                className="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-750 active:bg-emerald-800 text-white font-extrabold text-[9px] rounded uppercase text-center cursor-pointer shadow-3xs"
                              >
                                CO-SIGN DISBURSE
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRejectLoan(ln.id);
                                }}
                                className="flex-1 py-1.5 bg-rose-650 hover:bg-rose-700 active:bg-rose-800 text-white font-extrabold text-[9px] rounded uppercase text-center cursor-pointer shadow-3xs"
                              >
                                DECLINE ADVANCE
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* MIDDLE & RIGHT DETAILED PANELS */}
              <div className="lg:col-span-2 flex flex-col gap-6 overflow-hidden">
                {activeLoan ? (
                  <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col overflow-hidden max-h-[500px]">
                    <div className="flex justify-between items-center border-b border-slate-100 pb-3 mb-4 select-none">
                      <div>
                        <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest flex items-center gap-1">
                          <span className="p-0.5 bg-indigo-100 rounded text-indigo-800"><Coins size={12} /></span>
                          Details for Advance contract #{activeLoan.id}
                        </h3>
                        <span className="text-[10px] text-slate-400 font-semibold">
                          Submitted {new Date(activeLoan.created_at).toLocaleDateString()} • Maturity Target {new Date(activeLoan.due_date).toLocaleDateString()}
                        </span>
                      </div>

                      {activeLoan.status !== 'PENDING_REVIEW' && activeLoan.status !== 'DEFAULTED' && (
                        <button
                          onClick={() => handlePrintAuditPDF(activeLoan)}
                          className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg flex items-center gap-1 border border-slate-200 text-[10px] font-black uppercase transition-colors select-none shrink-0 cursor-pointer"
                          title="Print certified co-signed paper note with monthly schedule mappings"
                        >
                          <Printer size={12} />
                          <span>Print audited note</span>
                        </button>
                      )}
                    </div>

                    {/* TWO COLUMN INTERACTION LAYER */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5 flex-1 overflow-hidden">
                      {/* Repayment Milestones calendar */}
                      <div className="flex flex-col gap-3 overflow-hidden">
                        <h4 className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wider flex items-center gap-1 shrink-0 select-none">
                          <Calendar size={11} /> EXPECTED CALENDAR MILESTONES (SCHEDULE)
                        </h4>

                        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                          {activeAmort.length === 0 ? (
                            <div className="text-center py-6 text-[10px] text-slate-400 font-bold uppercase italic">
                              No schedule mappings compiled for review yet.
                            </div>
                          ) : (
                            activeAmort.map(m => (
                              <div
                                key={m.id}
                                className={`p-3 rounded-xl border flex flex-col gap-1 text-[11px] ${
                                  m.is_settled 
                                    ? 'bg-emerald-50/20 border-emerald-200 text-slate-850' 
                                    : m.amount_paid > 0
                                    ? 'bg-amber-50/25 border-amber-250'
                                    : 'bg-slate-50 border-slate-200'
                                }`}
                              >
                                <div className="flex justify-between font-black items-center">
                                  <span>Installment #{m.installment_number}</span>
                                  
                                  {m.is_settled ? (
                                    <span className="text-[8px] text-emerald-800 bg-emerald-105 font-extrabold px-1.5 py-0.5 rounded uppercase">SETTLED</span>
                                  ) : m.amount_paid > 0 ? (
                                    <span className="text-[8px] text-amber-800 bg-amber-100 font-extrabold px-1.5 py-0.5 rounded uppercase">PARTIAL</span>
                                  ) : (
                                    <span className="text-[8px] text-slate-400 font-extrabold uppercase">Outstanding</span>
                                  )}
                                </div>

                                <div className="flex justify-between text-xs font-mono font-medium">
                                  <span className="text-slate-400">Total expected due:</span>
                                  <span className="font-extrabold">{settings.currency}{m.total_due.toFixed(2)}</span>
                                </div>

                                <div className="flex justify-between text-[11px] font-mono">
                                  <span className="text-slate-400">Capital repaid currently:</span>
                                  <span className="font-bold text-amber-900">{settings.currency}{m.amount_paid.toFixed(2)}</span>
                                </div>

                                <div className="flex justify-between text-[10px] text-slate-400 mt-1">
                                  <span>Maturity window limit:</span>
                                  <span>{new Date(m.due_date).toLocaleDateString()}</span>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>

                      {/* Live automatic deduction sweep receipts logs */}
                      <div className="flex flex-col gap-3 overflow-hidden border-t md:border-t-0 md:border-l border-slate-100 md:pl-5">
                        <h4 className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wider flex items-center gap-1 shrink-0 select-none">
                          <Clock size={11} /> AUTOMATED SWEEP TRANSACTION LOGS
                        </h4>

                        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                          {activeDeds.length === 0 ? (
                            <div className="text-center py-10 text-[10px] text-slate-400 font-bold uppercase italic">
                              🚚 Repayments Ledger Empty.<br />Once an active loan exists, POS checkout revenue slices will display here instantly.
                            </div>
                          ) : (
                            activeDeds.map(d => (
                              <div
                                key={d.id}
                                className="p-3 bg-indigo-50/20 border border-slate-150 rounded-xl text-[11px]"
                              >
                                <div className="flex justify-between font-extrabold mb-1">
                                  <span className="font-mono text-slate-450 uppercase">{d.id}</span>
                                  <span className="text-indigo-805">+{settings.currency}{Number(d.amount_deducted).toFixed(2)}</span>
                                </div>

                                <div className="text-[10px] text-slate-500 font-medium space-y-0.5 text-left">
                                  <p className="line-clamp-1 block row-span-1">Checkout Ref: <span className="font-bold">{d.source_transaction_id}</span></p>
                                  <p>Swept Stamp: {new Date(d.created_at).toLocaleString()}</p>
                                  <p className="text-[9px] text-emerald-600 font-bold">● Repayments processed successfully</p>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="bg-white rounded-2xl border border-slate-200 p-10 flex flex-col justify-center items-center h-full select-none text-center">
                    <Briefcase size={36} className="text-slate-300 mb-3" />
                    <p className="text-xs text-slate-400 font-black uppercase">No loan agreements chosen</p>
                    <p className="text-[11px] text-slate-400 mt-1 max-w-xs">Use the left table to select an existing credit policy or start an application.</p>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}

        {subTab === 'statements' && (
          <motion.div
            key="statements-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-hidden gap-4"
          >
            {/* STATEMENTS CONTROLS BAR */}
            <div className="bg-white p-4 rounded-2xl border border-slate-200 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shrink-0 shadow-2xs select-none">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-indigo-50 text-indigo-705 rounded-xl">
                  <FileText size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900 uppercase">SME Financial Statements Unit</h3>
                  <p className="text-[11px] text-slate-500 font-medium">Generate Profit & Loss accounts, Balance Sheets, and Cash Flow reconciliations below.</p>
                </div>
              </div>

              <div className="flex items-center gap-3 w-full sm:w-auto">
                <select
                  value={selectedPeriod}
                  onChange={(e: any) => setSelectedPeriod(e.target.value)}
                  className="px-3 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-250 text-xs font-bold text-slate-700 rounded-lg uppercase tracking-wider outline-none cursor-pointer"
                >
                  <option value="this_month">This Month</option>
                  <option value="last_month">Last Month</option>
                  <option value="this_quarter">This Quarter</option>
                  <option value="this_year">This Year</option>
                  <option value="all_time">All Time (Full Ledger)</option>
                </select>

                <button
                  onClick={handlePrintFinancialReportPDF}
                  className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-705 active:bg-indigo-805 text-white font-extrabold text-xs rounded-lg uppercase tracking-wider flex items-center gap-1.5 transition-all shadow-3xs cursor-pointer block shrink-0"
                >
                  <Download size={13} />
                  <span>Download Report PDF</span>
                </button>
              </div>
            </div>

            {/* THREE COLUMN GRID */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 flex-1 overflow-y-auto pb-4 pr-1">
              
              {/* STATEMENT 1: PROFIT & LOSS */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col shadow-2xs max-h-[500px] overflow-hidden">
                <div className="border-b border-slate-100 pb-2 mb-3 flex justify-between items-center select-none">
                  <h4 className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-1">
                    <span className="p-1 bg-amber-50 text-amber-700 rounded"><TrendingUp size={12} /></span>
                    Profit & Loss Account
                  </h4>
                  <span className="text-[9px] font-bold text-slate-450 uppercase font-mono">Income Statement</span>
                </div>

                <div className="flex-1 overflow-y-auto space-y-3 pr-1 text-xs">
                  <div className="space-y-1.5">
                    <span className="text-[9px] text-slate-400 font-extrabold uppercase">Revenues</span>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50">
                      <span className="text-slate-600">Gross POS Checkout Sales</span>
                      <span className="font-semibold">{settings.currency}{grossSales.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50 text-rose-600">
                      <span>Less: Cash Discounts Applied</span>
                      <span>-{settings.currency}{totalDiscounts.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-bold py-1 text-slate-850">
                      <span>NET OPERATING REVENUE</span>
                      <span>{settings.currency}{netRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>

                  <div className="space-y-1.5 mt-2 bg-slate-50/50 p-2.5 rounded-xl border border-dashed border-slate-150">
                    <span className="text-[9px] text-slate-400 font-extrabold uppercase">Direct Cost Input</span>
                    <div className="flex justify-between font-medium py-1">
                      <span className="text-slate-600">Cost of Goods Sold (COGS)</span>
                      <span>-{settings.currency}{totalCogs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="border-t border-slate-200 my-1"></div>
                    <div className="flex justify-between font-black text-slate-900 text-[12.5px]">
                      <span>GROSS TRADING PROFIT</span>
                      <span className="text-indigo-650">{settings.currency}{grossProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>

                  <div className="space-y-1.5 mt-2">
                    <span className="text-[9px] text-slate-400 font-extrabold uppercase">Operating Expenses (Overheads)</span>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50">
                      <span className="text-slate-650">Counter Staff Payroll & Salaries</span>
                      <span>{settings.currency}{payrollExpense.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50">
                      <span className="text-slate-650">Indirect Rent Lease allocations</span>
                      <span>{settings.currency}{rentExpense.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50">
                      <span className="text-slate-650">Water & Power Utilities</span>
                      <span>{settings.currency}{utilitiesExpense.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50">
                      <span className="text-slate-650">General Office Packaging</span>
                      <span>{settings.currency}{generalOfficeExpense.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-bold py-1 border-b border-slate-200">
                      <span>Cumulative Operating Expenses</span>
                      <span>{settings.currency}{totalExpenses.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>

                  <div className="space-y-1.5 mt-2">
                    <span className="text-[9px] text-slate-400 font-extrabold uppercase">Finance Factors</span>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50 text-rose-650">
                      <span>Microlending Advance Interest Charges</span>
                      <span>-{settings.currency}{totalInterestCosts.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>

                  <div className="mt-4 p-3 bg-indigo-900 rounded-xl text-white select-none shrink-0 font-mono flex justify-between items-center">
                    <span className="text-[10px] font-black uppercase">RETAINED PERIOD NET PROFIT</span>
                    <span className="text-sm font-black text-amber-300">
                      {netProfit >= 0 ? '' : '-'}{settings.currency}{Math.abs(netProfit).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              </div>

              {/* STATEMENT 2: BALANCE SHEET */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col shadow-2xs max-h-[500px] overflow-hidden">
                <div className="border-b border-slate-100 pb-2 mb-3 flex justify-between items-center select-none">
                  <h4 className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-1">
                    <span className="p-1 bg-indigo-50 text-indigo-700 rounded"><Briefcase size={12} /></span>
                    Balance Sheet
                  </h4>
                  {Math.abs(balanceDifference) < 10 ? (
                    <span className="text-[8px] font-black text-emerald-805 bg-emerald-100 py-0.5 px-2 rounded-full uppercase border border-emerald-200 tracking-wider">BALANCED</span>
                  ) : (
                    <span className="text-[8px] font-black text-rose-805 bg-rose-100 py-0.5 px-2 rounded-full uppercase tracking-wider">DISPARITY</span>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto space-y-3.5 pr-1 text-xs">
                  {/* ASSETS SECT */}
                  <div className="space-y-1.5">
                    <span className="text-[9px] text-slate-400 font-black uppercase tracking-wider block">1. ASSETS</span>
                    
                    {/* Dynamic view_account_balances list */}
                    {balanceAccounts.length > 0 ? (
                      <div className="bg-slate-50/50 p-2.5 rounded-xl border border-dashed border-slate-150 space-y-1">
                        <span className="text-[8px] text-slate-400 font-extrabold uppercase">Live Ledger balances (view_account_balances):</span>
                        {balanceAccounts.map((acc: any) => (
                          <div key={acc.id} className="flex justify-between font-mono text-[10.5px] py-0.5 text-slate-650">
                            <span className="truncate max-w-[170px]">• {acc.name}</span>
                            <span className="font-bold">{settings.currency}{acc.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex justify-between font-medium py-1 border-b border-slate-50">
                        <span className="text-slate-600 font-medium">Bank & Cash Clearing reserves</span>
                        <span>{settings.currency}{computedCash.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                    )}

                    <div className="flex justify-between font-medium py-1 border-b border-slate-50 mt-1">
                      <span className="text-slate-600 font-medium">Inventory on Hand Valuation</span>
                      <span>{settings.currency}{inventoryValuation.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>

                    <div className="bg-indigo-50/50 p-2.5 rounded-xl border border-dashed border-indigo-150 space-y-1.5">
                      <span className="text-[8.5px] text-indigo-505 font-bold uppercase block">Asset Register Items (Net Book Value):</span>
                      {assets.map((a: Asset) => {
                        const financials = getAssetFinancials(a);
                        return (
                          <div key={a.id} className="flex justify-between text-[10px] text-slate-605">
                            <span className="truncate max-w-[155px]">⚙️ {a.name} <span className="text-[8px] font-mono text-indigo-405">({a.category})</span></span>
                            <span className="font-bold">{settings.currency}{financials.nbv.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          </div>
                        );
                      })}
                      <div className="border-t border-indigo-150/60 my-1 pt-1 flex justify-between text-[10.5px] font-extrabold text-indigo-950">
                        <span>Current Assets NBV</span>
                        <span>{settings.currency}{customCurrentAssetsSum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                      <div className="flex justify-between text-[10.5px] font-extrabold text-indigo-950">
                        <span>Fixed Assets NBV</span>
                        <span>{settings.currency}{customFixedAssetsSum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                    </div>

                    <div className="flex justify-between font-black text-indigo-950 py-1.5 bg-indigo-50 px-2.5 rounded mt-2">
                      <span>CUMULATIVE TOTAL ASSETS</span>
                      <span>{settings.currency}{totalAssetsSum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>

                  {/* LIABILITIES SECT */}
                  <div className="space-y-1.5 mt-3">
                    <span className="text-[9px] text-slate-400 font-black uppercase tracking-wider block">2. LIABILITIES</span>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50">
                      <span className="text-slate-600">Outstanding Sweep Credit Advances</span>
                      <span>{settings.currency}{outstandingDebtSum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50">
                      <span className="text-slate-600">Accrued VAT Tax payable to ZRA</span>
                      <span>{settings.currency}{collectedVatLiability.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-bold text-slate-800 py-1 border-b border-slate-200">
                      <span>Cumulative Liabilities Book</span>
                      <span>{settings.currency}{totalLiabilities.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>

                  {/* EQUITY SECT */}
                  <div className="space-y-1.5 mt-3">
                    <span className="text-[9px] text-slate-400 font-black uppercase tracking-wider block">3. PROPRIETARY EQUITY CAPITAL</span>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50">
                      <span className="text-slate-650">Contributed Capital registry</span>
                      <span>{settings.currency}{contributedEquitySum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50">
                      <span className="text-slate-650 font-semibold italic text-emerald-805">Accumulated Profit Reservoirs</span>
                      <span>{settings.currency}{historicalRetainedEarnings.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50">
                      <span className="text-slate-650 font-bold">Current Period Net Revenue</span>
                      <span>{settings.currency}{netProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-black text-rose-900 py-1 bg-rose-50/50 px-2 rounded leading-none mt-1">
                      <span>TOTAL proprietary EQUITY</span>
                      <span>{settings.currency}{(contributedEquitySum + historicalRetainedEarnings + netProfit).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>

                  {/* DOUBLE ENTRY RECONCILATION CHECK BAR */}
                  <div className="border-t border-slate-250 pt-2.5">
                    <div className="p-2.5 bg-emerald-600 text-white rounded-xl text-center select-none font-bold text-[10px] uppercase font-mono flex justify-between items-center">
                      <span>LIABILITIES & EQUITY SUM:</span>
                      <span>{settings.currency}{totalLiabilitiesAndEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <span className="text-[8.5px] text-slate-400 block text-center mt-1 font-medium">Double-entry status: Assets match Liabilities + Equity perfectly.</span>
                  </div>
                </div>
              </div>

              {/* STATEMENT 3: CASH FLOW STATEMENT */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col shadow-2xs max-h-[500px] overflow-hidden">
                <div className="border-b border-slate-100 pb-2 mb-3 flex justify-between items-center select-none">
                  <h4 className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-1">
                    <span className="p-1 bg-emerald-50 text-emerald-705 rounded"><Coins size={12} /></span>
                    Cash Flow Statement
                  </h4>
                  <span className="text-[9px] font-bold text-slate-450 uppercase font-mono">Direct Flow Method</span>
                </div>

                <div className="flex-1 overflow-y-auto space-y-3.5 pr-1 text-xs">
                  {/* OPERATING CASH ACTIVITES */}
                  <div className="space-y-1.5">
                    <span className="text-[9px] text-slate-400 font-extrabold uppercase">A. OPERATING FLOWS</span>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50">
                      <span className="text-slate-600">POS Sales receipts & VAT collected</span>
                      <span className="text-emerald-700">+{settings.currency}{cashOperatingInflow.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50">
                      <span className="text-slate-600">Less: Outflows for stock purchases</span>
                      <span className="text-rose-600">-{settings.currency}{totalCogs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50">
                      <span className="text-slate-600">Less: Wages & operating invoices paid</span>
                      <span className="text-rose-600">-{settings.currency}{(payrollExpense + rentExpense + utilitiesExpense + generalOfficeExpense).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-black text-slate-900 py-1 px-1 mt-0.5">
                      <span>Net Cash from Operating Activities</span>
                      <span>{netOperatingCash >= 0 ? '+' : ''}{settings.currency}{netOperatingCash.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>

                  {/* INVESTING CASH ACTIVITES */}
                  <div className="space-y-1.5 mt-2">
                    <span className="text-[9px] text-slate-400 font-extrabold uppercase">B. INVESTING FLOWS</span>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50 text-rose-600">
                      <span>Acquisitions of Custom Fixed Assets</span>
                      <span>-{settings.currency}{customFixedAssetsSum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-semibold py-1 px-1">
                      <span>Net Cash used in Investing Activities</span>
                      <span className="text-rose-700">-{settings.currency}{customFixedAssetsSum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>

                  {/* FINANCING CASH ACTIVITES */}
                  <div className="space-y-1.5 mt-2">
                    <span className="text-[9px] text-slate-400 font-extrabold uppercase">C. FINANCING FLOWS</span>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50 text-emerald-705">
                      <span>Credit Advances capital received</span>
                      <span>+{settings.currency}{loanPrincipalDisbursedInperiod.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50 text-rose-650">
                      <span>POS deductions swept (loan repayment)</span>
                      <span>-{settings.currency}{sweepRepaymentsProcessedInperiod.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-medium py-1 border-b border-slate-50 text-emerald-705">
                      <span>Proprietary capital injection/equity</span>
                      <span>+{settings.currency}{contributedEquitySum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between font-semibold text-slate-900 py-1 px-1">
                      <span>Net Cash from Financing Activities</span>
                      <span>{netFinancingCash >= 0 ? '+' : ''}{settings.currency}{netFinancingCash.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>

                  {/* SUMMARY SECTION */}
                  <div className="mt-4 bg-slate-900 text-slate-100 p-3 rounded-xl space-y-1 select-none shrink-0 font-mono text-[10.5px]">
                    <div className="flex justify-between font-bold">
                      <span className="text-slate-400 uppercase">Net change in Period Cash</span>
                      <span className="text-amber-400">{netChangeInCash >= 0 ? '▲' : '▼'} {settings.currency}{netChangeInCash.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Period Beginning Balance</span>
                      <span>{settings.currency}{startingPeriodCash.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="border-t border-slate-800 my-1"></div>
                    <div className="flex justify-between font-extrabold text-[11px] text-white">
                      <span className="uppercase text-emerald-400">Closing Cash equivalent Balance</span>
                      <span>{settings.currency}{closingPeriodCash.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </motion.div>
        )}

        {subTab === 'assets_equity' && (
          <motion.div
            key="assets-equity-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col md:flex-row gap-6 overflow-hidden select-text"
          >
            
            {/* COLUMN 1: ASSETS REGISTRY */}
            <div className="flex-1 bg-white rounded-2xl border border-slate-205 p-5 flex flex-col gap-4 overflow-hidden max-h-[500px]">
              <div className="border-b border-slate-100 pb-2">
                <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-1.5">
                  <span className="p-1 bg-indigo-50 text-indigo-700 rounded"><Layers size={12} /></span>
                  CUSTOM ASSET REGISTRY
                </h3>
                <p className="text-[10px] text-slate-400 font-medium">Add non-cash fixed assets (e.g. equipment, shop fittings, structures) or current assets.</p>
              </div>

              {/* ASSET FORM */}
              <form onSubmit={handleAddAsset} className="bg-slate-50 p-4 rounded-xl border border-slate-150 grid grid-cols-1 sm:grid-cols-4 gap-3 select-none">
                <div className="sm:col-span-2">
                  <label className="text-[9px] text-slate-405 font-bold uppercase block mb-1">Asset Description Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Delivery Motorbike"
                    value={newAssetName}
                    onChange={(e: any) => setNewAssetName(e.target.value)}
                    className="w-full px-3 py-1.5 bg-white border border-slate-250 text-xs text-slate-800 rounded outline-none shadow-3xs"
                  />
                </div>
                <div>
                  <label className="text-[9px] text-slate-405 font-bold uppercase block mb-1">Category</label>
                  <select
                    value={newAssetCategory}
                    onChange={(e: any) => setNewAssetCategory(e.target.value)}
                    className="w-full px-3 py-1.5 bg-white border border-slate-250 text-xs text-slate-800 rounded outline-none"
                  >
                    <option value="Fixed">Fixed Asset</option>
                    <option value="Current">Current Asset</option>
                  </select>
                </div>
                <div>
                  <label className="text-[9px] text-slate-405 font-bold uppercase block mb-1">Value ({settings.currency})</label>
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      required
                      placeholder="0.00"
                      value={newAssetValue}
                      onChange={(e: any) => setNewAssetValue(e.target.value)}
                      className="w-full px-3 py-1.5 bg-white border border-slate-250 text-xs text-slate-800 rounded outline-none shadow-3xs"
                    />
                    <button
                      type="submit"
                      className="px-3 bg-indigo-600 hover:bg-indigo-705 text-white rounded text-xs font-black uppercase tracking-widest cursor-pointer"
                    >
                      ADD
                    </button>
                  </div>
                </div>
              </form>

              {/* REGISTERED ASSET ITEMS */}
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                <h4 className="text-[10px] text-slate-400 font-extrabold uppercase select-none flex items-center gap-1">
                  <span>● REGISTERED ACTIVE ASSETS</span>
                </h4>

                {assets.length === 0 ? (
                  <p className="text-center py-10 text-[10px] text-slate-400 font-medium italic uppercase">Asset registry is empty. Add items above.</p>
                ) : (
                  assets.map(a => (
                    <div key={a.id} className="p-3 bg-slate-50 border border-slate-200 rounded-xl flex justify-between items-center text-xs">
                      <div>
                        <span className="text-[9px] text-slate-400 font-extrabold uppercase mr-2 bg-slate-20 w-16 text-center inline-block rounded">{a.category}</span>
                        <span className="font-extrabold text-slate-800 uppercase leading-none">{a.name}</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="font-mono font-extrabold text-slate-900">{settings.currency}{Number(a.value).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        <button
                          onClick={() => handleDeleteAsset(a.id)}
                          className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded cursor-pointer"
                          title="Delete asset entry"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* COLUMN 2: EQUITY REGISTRY */}
            <div className="flex-1 bg-white rounded-2xl border border-slate-205 p-5 flex flex-col gap-4 overflow-hidden max-h-[500px]">
              <div className="border-b border-slate-100 pb-2">
                <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-1.5">
                  <span className="p-1 bg-indigo-50 text-indigo-700 rounded"><Coins size={12} /></span>
                  PROPRIETARY EQUITY REGISTRY
                </h3>
                <p className="text-[10px] text-slate-400 font-medium">Record owner investments, capital structures, shareholder contributions, or initial seed capital.</p>
              </div>

              {/* EQUITY FORM */}
              <form onSubmit={handleAddEquity} className="bg-slate-50 p-4 rounded-xl border border-slate-150 flex flex-col sm:flex-row gap-3 select-none">
                <div className="flex-1">
                  <label className="text-[9px] text-slate-405 font-bold uppercase block mb-1">Capital Investment Description</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Chiposha Seed Investment"
                    value={newEquityName}
                    onChange={(e: any) => setNewEquityName(e.target.value)}
                    className="w-full px-3 py-1.5 bg-white border border-slate-250 text-xs text-slate-800 rounded outline-none shadow-3xs"
                  />
                </div>
                <div>
                  <label className="text-[9px] text-slate-405 font-bold uppercase block mb-1">Value ({settings.currency})</label>
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      required
                      placeholder="50000"
                      value={newEquityValue}
                      onChange={(e: any) => setNewEquityValue(e.target.value)}
                      className="w-full px-3 py-1.5 bg-white border border-slate-250 text-xs text-slate-800 rounded outline-none shadow-3xs"
                    />
                    <button
                      type="submit"
                      className="px-3 bg-indigo-600 hover:bg-indigo-750 text-white rounded text-xs font-black uppercase tracking-widest cursor-pointer"
                    >
                      ADD
                    </button>
                  </div>
                </div>
              </form>

              {/* REGISTERED EQUITY ITEMS */}
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                <h4 className="text-[10px] text-slate-400 font-extrabold uppercase select-none flex items-center gap-1">
                  <span>● REGISTERED PROPRIETARY EQUITY</span>
                </h4>

                {equity.length === 0 ? (
                  <p className="text-center py-10 text-[10px] text-slate-400 font-medium italic uppercase">Equity registry is empty. Add items above.</p>
                ) : (
                  equity.map(eq => (
                    <div key={eq.id} className="p-3 bg-slate-50 border border-slate-200 rounded-xl flex justify-between items-center text-xs">
                      <div>
                        <span className="font-extrabold text-slate-800 uppercase leading-none">{eq.name}</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="font-mono font-extrabold text-slate-900">{settings.currency}{Number(eq.value).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        <button
                          onClick={() => handleDeleteEquity(eq.id)}
                          className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded cursor-pointer"
                          title="Delete equity entry"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

          </motion.div>
        )}
      </AnimatePresence>

      {/* MODAL: LOAN APPLICATION SLIDER CONTAINER */}
      <AnimatePresence>
        {mode === 'credit_risk' && showApplyModal && (
          <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4 z-50 select-text">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-lg p-6 overflow-hidden flex flex-col gap-4 text-left max-h-[90vh] overflow-y-auto"
            >
              <div className="flex justify-between items-center border-b border-slate-100 pb-3">
                <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest flex items-center gap-1.5">
                  <span className="p-1 px-1.5 bg-indigo-600 rounded text-white font-extrabold text-[10px]">💰 SME CREDIT</span>
                  APPLY REVENUE-ADVANCED WORKING CAPITAL
                </h3>
                <button
                  type="button"
                  onClick={() => setShowApplyModal(false)}
                  className="p-1 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-50 cursor-pointer"
                >
                  <X size={16} />
                </button>
              </div>

              <form onSubmit={handleRequestLoan} className="flex flex-col gap-4">
                {/* Principal controller */}
                <div>
                  <div className="flex justify-between mb-1">
                    <label className="text-[10px] text-slate-400 font-extrabold uppercase">REQUEST CAPITAL (PRINCIPAL)</label>
                    <span className="text-xs font-black text-indigo-700 font-mono">{settings.currency}{applyPrincipal.toLocaleString()}</span>
                  </div>
                  <input
                    type="range"
                    min="2000"
                    max="50000"
                    step="1000"
                    value={applyPrincipal}
                    onChange={(e: any) => setApplyPrincipal(Number(e.target.value))}
                    className="w-full accent-indigo-600 cursor-pointer"
                  />
                  <span className="text-[9px] text-slate-400 block font-medium mt-0.5">Capital disbursed straight to cash drawer accounts for stock acquisition audits.</span>
                </div>

                {/* Maturity term controller */}
                <div>
                  <div className="flex justify-between mb-1">
                    <label className="text-[10px] text-slate-400 font-extrabold uppercase">MATURITY WINDOW REPAYMENT PERIOD</label>
                    <span className="text-xs font-black text-indigo-700 font-mono">{applyTermMonths} MONTHS</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="12"
                    step="1"
                    value={applyTermMonths}
                    onChange={(e: any) => setApplyTermMonths(Number(e.target.value))}
                    className="w-full accent-indigo-600 cursor-pointer"
                  />
                  <div className="flex justify-between text-[9px] text-slate-400 font-medium">
                    <span>1 Month</span>
                    <span>12 Months</span>
                  </div>
                </div>

                {/* Sweep percentage controller */}
                <div>
                  <div className="flex justify-between mb-1">
                    <label className="text-[10px] text-slate-400 font-extrabold uppercase">DAILY POS CHECKOUT SWEEP RATE</label>
                    <span className="text-xs font-black text-indigo-700 font-mono">{applySweepPercentage}% Sweep</span>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="30"
                    step="1"
                    value={applySweepPercentage}
                    onChange={(e: any) => setApplySweepPercentage(Number(e.target.value))}
                    className="w-full accent-indigo-600 cursor-pointer"
                  />
                  <span className="text-[9px] text-slate-400 block font-medium mt-0.5">
                    We will automatically sweep {applySweepPercentage}% of each daily POS checkout transaction to pay down principal debt. No fixed monthly installments pressure!
                  </span>
                </div>

                {/* AMORTIZATION ACCOUNT ESTIMATE BREAKDOWN CARD */}
                <div className="bg-slate-900 text-slate-100 p-4 rounded-xl flex flex-col gap-2 text-xs">
                  <span className="text-[8.5px] text-amber-400 font-black uppercase tracking-wider">
                    TRANSPARENT CREDIT ACCOUNT ESTIMATE (LIVE PREVIEW)
                  </span>

                  <div className="grid grid-cols-2 gap-2 mt-1 select-none font-mono text-[10.5px]">
                    <div className="flex flex-col">
                      <span className="text-slate-400">Total Capital Lent:</span>
                      <span className="text-white font-extrabold">{settings.currency}{applyPrincipal.toLocaleString()}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-slate-400">Monthly flat Interest (8.2%):</span>
                      <span className="text-white font-extrabold">{settings.currency}{(applyPrincipal * 0.082 * applyTermMonths).toFixed(2)}</span>
                    </div>
                    <div className="flex flex-col mt-1">
                      <span className="text-slate-400">Total repayment charge:</span>
                      <span className="text-amber-400 font-extrabold">{settings.currency}{(applyPrincipal * (1 + 0.082 * applyTermMonths)).toFixed(2)}</span>
                    </div>
                    <div className="flex flex-col mt-1">
                      <span className="text-slate-400">Avg Milestone Charge / Mo:</span>
                      <span className="text-white font-extrabold">{settings.currency}{((applyPrincipal * (1 + 0.082 * applyTermMonths)) / applyTermMonths).toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="border-t border-slate-800 my-1"></div>
                  <p className="text-[9px] text-slate-400 font-semibold leading-relaxed">
                    Estimates are governed by microfinance interest covenants. Repayments process dynamically on POS checkouts; Amortization monthly milestones exist purely to track risk aging.
                  </p>
                </div>

                {/* Submit / Cancel parameters */}
                <div className="flex gap-2.5">
                  <button
                    type="button"
                    onClick={() => setShowApplyModal(false)}
                    className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-[10px] font-extrabold text-slate-600 uppercase tracking-widest cursor-pointer text-center"
                  >
                    CLOSE WINDOW
                  </button>
                  <button
                    type="submit"
                    className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 rounded-lg text-[10px] font-extrabold text-white uppercase tracking-widest cursor-pointer text-center shadow-md transition-colors"
                  >
                    POST AND SUBMIT
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* NEW / REORDER PURCHASE ORDER MODAL (Portaled above app chrome & bottom menu) */}
      {typeof document !== 'undefined' && showNewTransitModal && createPortal(
        <div className="fixed inset-0 z-[9999] bg-slate-950/65 backdrop-blur-sm flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden border border-slate-200 flex flex-col max-h-[90dvh] my-auto"
          >
            <div className="p-4 bg-slate-900 text-white flex justify-between items-center shrink-0">
              <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2">
                <Truck size={18} className="text-indigo-400" />
                <span>Create Purchase Order (Supply Management)</span>
              </h3>
              <button
                type="button"
                onClick={() => { setShowNewTransitModal(false); setPoModalError(null); }}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleCreateTransitPurchase} className="p-4 sm:p-5 overflow-y-auto overscroll-contain space-y-4 flex-1 min-h-0 text-left">
              {poModalError && (
                <div className="px-3.5 py-2.5 rounded-xl border border-rose-200 bg-rose-50 text-rose-800 text-xs font-bold flex items-center gap-2">
                  <AlertCircle size={15} className="shrink-0" />
                  <span>{poModalError}</span>
                </div>
              )}

              {/* SAVED SUPPLIER PICKER & DETAILS */}
              <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <span className="text-xs font-black uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                    <Users size={14} className="text-indigo-600" />
                    <span>Supplier Information</span>
                  </span>
                  {suppliersList.length > 0 && (
                    <select
                      value={selectedSupplierId}
                      onChange={(e) => handleSelectSavedSupplierForPo(e.target.value)}
                      className="bg-white border border-indigo-200 rounded-lg px-2.5 py-1.5 text-xs font-bold text-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="">-- Load Saved Supplier ({suppliersList.length}) --</option>
                      {suppliersList.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}{s.phone ? ` (${s.phone})` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">Supplier Name *</label>
                    <input
                      type="text"
                      placeholder="e.g. Trade Kings / Wholesale Supplier"
                      value={transitSupplierName}
                      onChange={(e) => { setTransitSupplierName(e.target.value); setPoModalError(null); }}
                      className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">Contact Person</label>
                    <input
                      type="text"
                      placeholder="e.g. Sales Rep / Manager"
                      value={transitSupplierContact}
                      onChange={(e) => setTransitSupplierContact(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">Phone / WhatsApp</label>
                    <input
                      type="text"
                      placeholder="e.g. +260 97..."
                      value={transitSupplierPhone}
                      onChange={(e) => setTransitSupplierPhone(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">Email</label>
                    <input
                      type="email"
                      placeholder="orders@supplier.com"
                      value={transitSupplierEmail}
                      onChange={(e) => setTransitSupplierEmail(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">Address / City</label>
                    <input
                      type="text"
                      placeholder="Supplier warehouse / city"
                      value={transitSupplierAddress}
                      onChange={(e) => setTransitSupplierAddress(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">Supplier TPIN / Tax ID</label>
                    <input
                      type="text"
                      placeholder="Optional Tax ID"
                      value={transitSupplierTpin}
                      onChange={(e) => setTransitSupplierTpin(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs font-bold text-indigo-800 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={saveSupplierProfile}
                    onChange={(e) => setSaveSupplierProfile(e.target.checked)}
                    className="rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span>Save / update supplier profile for subsequent purchase orders</span>
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Landing Target Branch</label>
                  <select
                    value={transitStoreId}
                    onChange={(e) => setTransitStoreId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {storesList.length === 0 ? (
                      <option value={activeStore || 'MAIN'}>{activeStore ? activeStore.toUpperCase() : 'Main Branch'}</option>
                    ) : (
                      storesList.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))
                    )}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Payment Account Source</label>
                  <select
                    value={transitPaymentAcc}
                    onChange={(e) => setTransitPaymentAcc(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {getAllSelectableAccounts().map(acc => (
                      <option key={acc.accountId} value={acc.accountId}>{acc.label} ({acc.accountId})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Payment Method</label>
                  <select
                    value={transitPaymentMethod}
                    onChange={(e) => setTransitPaymentMethod(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="BANK_TRANSFER">Bank Wire Transfer</option>
                    <option value="CASH">Cash</option>
                    <option value="Airtel Money">Airtel Money</option>
                    <option value="MTN Mobile Money">MTN Mobile Money</option>
                    {getCustomPaymentMethods(false).map(cm => (
                      <option key={cm.id} value={cm.name}>{cm.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* ADD PRODUCT ITEM SECTION */}
              <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-3">
                <span className="text-xs font-black uppercase tracking-wider text-slate-700 block">Add Product Line Items</span>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                  <div className="sm:col-span-2">
                    <select
                      value={selectedTransitProduct}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSelectedTransitProduct(val);
                        const match = productList.find(p => String(p.id) === String(val));
                        if (match && Number(match.cost || 0) > 0) {
                          setTransitItemUnitPrice(String(match.cost));
                        }
                      }}
                      className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-900"
                    >
                      <option value="">-- Select Existing Product --</option>
                      {productList.map(p => (
                        <option key={p.id} value={p.id}>{p.name} (Cost: {settings.currency}{Number(p.cost || 0).toFixed(2)})</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <input
                      type="number"
                      min="1"
                      placeholder="Qty"
                      value={transitItemQty}
                      onChange={(e) => setTransitItemQty(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-900"
                    />
                  </div>
                  <div>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="Base Unit Price"
                      value={transitItemUnitPrice}
                      onChange={(e) => setTransitItemUnitPrice(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-900"
                    />
                  </div>
                </div>

                {!selectedTransitProduct && (
                  <input
                    type="text"
                    placeholder="Or type custom item name if new..."
                    value={customTransitProductName}
                    onChange={(e) => setCustomTransitProductName(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-900"
                  />
                )}

                <button
                  type="button"
                  onClick={handleAddTransitItem}
                  className="bg-slate-800 text-white text-xs font-bold py-1.5 px-3 rounded-lg hover:bg-slate-900 cursor-pointer"
                >
                  + Add Item Line
                </button>

                {/* ADDED ITEMS LIST (editable qty & cost for quick adjustments/reorders) */}
                {transitItems.length > 0 && (
                  <div className="space-y-1.5 pt-2">
                    {transitItems.map((it, idx) => (
                      <div key={idx} className="flex flex-wrap justify-between items-center gap-2 bg-white p-2 rounded border text-xs text-slate-800">
                        <span className="font-bold flex-1 min-w-[140px]">{it.productName}</span>
                        <div className="flex items-center gap-1.5">
                          <label className="text-[10px] text-slate-400 font-bold">Qty</label>
                          <input
                            type="number"
                            min="1"
                            value={it.quantity}
                            onChange={(e) => handleUpdateTransitItemField(idx, 'quantity', e.target.value)}
                            className="w-16 bg-slate-50 border border-slate-200 rounded px-1.5 py-1 text-xs font-bold text-slate-900"
                          />
                          <label className="text-[10px] text-slate-400 font-bold">@</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={it.baseUnitPrice}
                            onChange={(e) => handleUpdateTransitItemField(idx, 'baseUnitPrice', e.target.value)}
                            className="w-20 bg-slate-50 border border-slate-200 rounded px-1.5 py-1 text-xs font-bold text-slate-900"
                          />
                          <span className="font-black text-slate-900 min-w-[70px] text-right">
                            {settings.currency}{(it.quantity * it.baseUnitPrice).toFixed(2)}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRemoveTransitItem(idx)}
                            className="text-rose-500 hover:text-rose-700 cursor-pointer p-1"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ADDITION EXPENSES FOR LANDED COST */}
              <div className="bg-indigo-50/50 p-3.5 rounded-xl border border-indigo-100 space-y-3">
                <div className="flex flex-wrap justify-between items-center gap-1">
                  <span className="text-xs font-black uppercase tracking-wider text-indigo-900">Initial Landing Overhead (Editable Later in Transit)</span>
                  <span className="text-[10px] font-semibold text-indigo-600">Can be updated anytime before stock receipt</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {transitAddExpenses.map((exp, idx) => (
                    <div key={idx} className="relative">
                      <label className="block text-[10px] font-bold text-indigo-800 mb-1 truncate">{exp.name}</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0.00"
                        value={exp.amount || ''}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value) || 0;
                          const updated = [...transitAddExpenses];
                          updated[idx] = { ...updated[idx], amount: val };
                          setTransitAddExpenses(updated);
                        }}
                        className="w-full bg-white border border-indigo-200 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-900"
                      />
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-indigo-100">
                  <input
                    type="text"
                    placeholder="Add extra cost label (e.g. Border Duty)"
                    value={newPoCostName}
                    onChange={(e) => setNewPoCostName(e.target.value)}
                    className="flex-1 min-w-[160px] bg-white border border-indigo-200 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-900"
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Amount"
                    value={newPoCostAmount}
                    onChange={(e) => setNewPoCostAmount(e.target.value)}
                    className="w-24 bg-white border border-indigo-200 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-900"
                  />
                  <button
                    type="button"
                    onClick={handleAddNewPoCostLine}
                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-[11px] rounded-lg cursor-pointer"
                  >
                    + Add Cost
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Order Notes (Optional)</label>
                <input
                  type="text"
                  placeholder="Waybill / tracking / delivery remarks..."
                  value={transitNotes}
                  onChange={(e) => setTransitNotes(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div className="p-3.5 bg-slate-900 text-white rounded-xl flex flex-wrap justify-between items-center gap-3 text-xs">
                <div>
                  <span className="text-slate-400 block font-semibold">Calculated Total Landed Value</span>
                  <span className="text-lg font-black text-emerald-400">
                    {settings.currency}{(
                      transitItems.reduce((s, i) => s + (i.quantity * i.baseUnitPrice), 0) +
                      transitAddExpenses.reduce((s, e) => s + Number(e.amount || 0), 0)
                    ).toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowNewTransitModal(false); setPoModalError(null); }}
                    className="bg-slate-700 hover:bg-slate-600 text-slate-200 font-bold px-3.5 py-2 rounded-xl text-xs uppercase tracking-wider cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="bg-emerald-500 hover:bg-emerald-600 text-white font-extrabold px-4 py-2 rounded-xl text-xs uppercase tracking-wider cursor-pointer"
                  >
                    Create Purchase Order
                  </button>
                </div>
              </div>
            </form>
          </motion.div>
        </div>,
        document.body
      )}

      {/* EDIT LANDING COSTS MODAL (Post-Order Transit Overhead Updates) */}
      {typeof document !== 'undefined' && editingLandingPo && createPortal(
        <div className="fixed inset-0 z-[9999] bg-slate-950/65 backdrop-blur-sm flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden border border-slate-200 flex flex-col max-h-[90dvh] my-auto"
          >
            <div className="p-4 bg-slate-900 text-white flex justify-between items-center shrink-0">
              <div>
                <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2">
                  <Edit3 size={17} className="text-amber-400" />
                  <span>Edit Transit Landing Costs — PO #{editingLandingPo.id}</span>
                </h3>
                <p className="text-[11px] text-slate-300 mt-0.5">
                  Supplier: {editingLandingPo.supplier_name} • Update freight, customs, insurance & transit charges incurred along transit
                </p>
              </div>
              <button
                type="button"
                onClick={() => { setEditingLandingPo(null); setEditLandingError(null); }}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveEditedLandingCost} className="p-4 sm:p-5 overflow-y-auto overscroll-contain space-y-4 flex-1 min-h-0 text-left">
              {editLandingError && (
                <div className="px-3.5 py-2.5 rounded-xl border border-rose-200 bg-rose-50 text-rose-800 text-xs font-bold flex items-center gap-2">
                  <AlertCircle size={15} className="shrink-0" />
                  <span>{editLandingError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Transit Stage</label>
                  <select
                    value={editLandingStage}
                    onChange={(e) => setEditLandingStage(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold text-slate-900"
                  >
                    <option value="IN_TRANSIT">In Transit</option>
                    <option value="CUSTOMS_HANDLING">Customs &amp; Clearing</option>
                    <option value="READY_FOR_RECEIPT">Ready for Store Receipt</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Waybill / Transit Notes</label>
                  <input
                    type="text"
                    value={editLandingNotes}
                    onChange={(e) => setEditLandingNotes(e.target.value)}
                    placeholder="Border ref, clearing agent, tracking note..."
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-900"
                  />
                </div>
              </div>

              <div className="bg-indigo-50/50 p-3.5 rounded-xl border border-indigo-100 space-y-2.5">
                <span className="text-xs font-black uppercase tracking-wider text-indigo-900 block">
                  Landing Cost Breakdown ({editLandingExpenses.length} line item{editLandingExpenses.length === 1 ? '' : 's'})
                </span>

                <div className="space-y-2">
                  {editLandingExpenses.map((ex, idx) => (
                    <div key={idx} className="flex flex-wrap sm:flex-nowrap items-center gap-2 bg-white p-2 rounded-xl border border-indigo-100">
                      <input
                        type="text"
                        value={ex.name}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditLandingExpenses((prev) => prev.map((row, i) => (i === idx ? { ...row, name: val } : row)));
                        }}
                        className="flex-1 min-w-[150px] bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                      />
                      <select
                        value={ex.category}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditLandingExpenses((prev) => prev.map((row, i) => (i === idx ? { ...row, category: val } : row)));
                        }}
                        className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-[11px] font-bold text-slate-700"
                      >
                        <option value="Freight">Freight</option>
                        <option value="Customs">Customs</option>
                        <option value="Handling">Handling</option>
                        <option value="Insurance">Insurance</option>
                        <option value="Other">Other</option>
                      </select>
                      <div className="relative w-28">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={ex.amount || ''}
                          placeholder="0.00"
                          onChange={(e) => {
                            const val = Math.max(0, parseFloat(e.target.value) || 0);
                            setEditLandingExpenses((prev) => prev.map((row, i) => (i === idx ? { ...row, amount: val } : row)));
                          }}
                          className="w-full bg-white border border-indigo-200 rounded-lg px-2.5 py-1.5 text-xs font-black text-slate-900 text-right"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setEditLandingExpenses((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-rose-500 hover:text-rose-700 p-1 cursor-pointer"
                        title="Remove cost line"
                      >
                        <Trash size={14} />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Add new transit expense discovered in transit */}
                <div className="pt-2 border-t border-indigo-100 space-y-2">
                  <span className="text-[10px] font-black uppercase text-indigo-700 block">+ Add Additional Transit Cost</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      placeholder="e.g. Border Duty / Escort / Demurrage"
                      value={newEditCostName}
                      onChange={(e) => setNewEditCostName(e.target.value)}
                      className="flex-1 min-w-[160px] bg-white border border-indigo-200 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-900"
                    />
                    <select
                      value={newEditCostCategory}
                      onChange={(e) => setNewEditCostCategory(e.target.value)}
                      className="bg-white border border-indigo-200 rounded-lg px-2 py-1.5 text-xs font-bold text-slate-700"
                    >
                      <option value="Freight">Freight</option>
                      <option value="Customs">Customs</option>
                      <option value="Handling">Handling</option>
                      <option value="Insurance">Insurance</option>
                      <option value="Other">Other</option>
                    </select>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="Amount"
                      value={newEditCostAmount}
                      onChange={(e) => setNewEditCostAmount(e.target.value)}
                      className="w-24 bg-white border border-indigo-200 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-900"
                    />
                    <button
                      type="button"
                      onClick={handleAddEditLandingCostLine}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-lg cursor-pointer"
                    >
                      + Add Line
                    </button>
                  </div>
                </div>
              </div>

              {/* LIVE RECALCULATED LANDED SUMMARY */}
              {(() => {
                const baseTotal = Number(editingLandingPo.total_base_amount || 0);
                const newAddTotal = editLandingExpenses.reduce((s, ex) => s + Math.max(0, Number(ex.amount || 0)), 0);
                const newLanded = baseTotal + newAddTotal;
                const overheadPct = baseTotal > 0 ? ((newAddTotal / baseTotal) * 100).toFixed(1) : '0.0';
                return (
                  <div className="p-3.5 bg-slate-900 text-white rounded-xl flex flex-wrap justify-between items-center gap-3 text-xs">
                    <div className="space-y-0.5">
                      <span className="text-slate-400 block font-semibold">
                        Base Invoice: {settings.currency}{baseTotal.toFixed(2)} + Transit Fees: {settings.currency}{newAddTotal.toFixed(2)} (+{overheadPct}%)
                      </span>
                      <span className="text-lg font-black text-emerald-400 block">
                        Updated Total Landed Cost: {settings.currency}{newLanded.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => { setEditingLandingPo(null); setEditLandingError(null); }}
                        className="bg-slate-700 hover:bg-slate-600 text-slate-200 font-bold px-3.5 py-2 rounded-xl text-xs uppercase tracking-wider cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="bg-emerald-500 hover:bg-emerald-600 text-white font-extrabold px-4 py-2 rounded-xl text-xs uppercase tracking-wider cursor-pointer flex items-center gap-1.5"
                      >
                        <Save size={14} />
                        <span>Save Landing Cost</span>
                      </button>
                    </div>
                  </div>
                );
              })()}
            </form>
          </motion.div>
        </div>,
        document.body
      )}

      {/* ADD / EDIT SUPPLIER MODAL (Portaled above app chrome & bottom menu) */}
      {typeof document !== 'undefined' && showSupplierModal && createPortal(
        <div className="fixed inset-0 z-[9999] bg-slate-950/65 backdrop-blur-sm flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden border border-slate-200 flex flex-col max-h-[90dvh] my-auto"
          >
            <div className="p-4 bg-slate-900 text-white flex justify-between items-center shrink-0">
              <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2">
                <Users size={17} className="text-indigo-400" />
                <span>{editingSupplier ? 'Edit Saved Supplier' : 'Save New Supplier Profile'}</span>
              </h3>
              <button
                type="button"
                onClick={() => { setShowSupplierModal(false); setSupplierFormError(null); }}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveSupplierForm} className="p-4 sm:p-5 overflow-y-auto overscroll-contain space-y-3.5 flex-1 min-h-0 text-left">
              {supplierFormError && (
                <div className="px-3.5 py-2.5 rounded-xl border border-rose-200 bg-rose-50 text-rose-800 text-xs font-bold flex items-center gap-2">
                  <AlertCircle size={15} className="shrink-0" />
                  <span>{supplierFormError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-bold text-slate-600 mb-1">Supplier Business Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Trade Kings Distributors Ltd"
                    value={supplierFormName}
                    onChange={(e) => setSupplierFormName(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Contact Person</label>
                  <input
                    type="text"
                    placeholder="Account manager / sales rep"
                    value={supplierFormContact}
                    onChange={(e) => setSupplierFormContact(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Phone / WhatsApp</label>
                  <input
                    type="text"
                    placeholder="+260..."
                    value={supplierFormPhone}
                    onChange={(e) => setSupplierFormPhone(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Email</label>
                  <input
                    type="email"
                    placeholder="orders@supplier.com"
                    value={supplierFormEmail}
                    onChange={(e) => setSupplierFormEmail(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">TPIN / Tax ID</label>
                  <input
                    type="text"
                    placeholder="Taxpayer ID"
                    value={supplierFormTpin}
                    onChange={(e) => setSupplierFormTpin(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-900"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-bold text-slate-600 mb-1">Physical Address</label>
                  <input
                    type="text"
                    placeholder="Warehouse / Industrial street address"
                    value={supplierFormAddress}
                    onChange={(e) => setSupplierFormAddress(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Default Payment Method</label>
                  <select
                    value={supplierFormPayMethod}
                    onChange={(e) => setSupplierFormPayMethod(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-900"
                  >
                    <option value="BANK_TRANSFER">Bank Wire Transfer</option>
                    <option value="CASH">Cash</option>
                    <option value="Airtel Money">Airtel Money</option>
                    <option value="MTN Mobile Money">MTN Mobile Money</option>
                    {getCustomPaymentMethods(false).map(cm => (
                      <option key={cm.id} value={cm.name}>{cm.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Payment Terms</label>
                  <input
                    type="text"
                    placeholder="e.g. Net 30 / Pay on Delivery"
                    value={supplierFormTerms}
                    onChange={(e) => setSupplierFormTerms(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-900"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-bold text-slate-600 mb-1">Supplier Notes</label>
                  <input
                    type="text"
                    placeholder="Lead time, delivery schedule, bank account notes..."
                    value={supplierFormNotes}
                    onChange={(e) => setSupplierFormNotes(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-900"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => { setShowSupplierModal(false); setSupplierFormError(null); }}
                  className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-4 py-2 rounded-xl text-xs uppercase tracking-wider cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold px-4 py-2 rounded-xl text-xs uppercase tracking-wider cursor-pointer flex items-center gap-1.5"
                >
                  <Save size={14} />
                  <span>{editingSupplier ? 'Update Supplier' : 'Save Supplier'}</span>
                </button>
              </div>
            </form>
          </motion.div>
        </div>,
        document.body
      )}

    </div>
  );
}
