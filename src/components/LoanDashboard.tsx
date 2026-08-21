import React, { useState, useEffect } from 'react';
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
  Receipt
} from 'lucide-react';
import { runSql, persistTablesToStorage, logEmployeeAudit } from '../db';
import { StoreSettings, Loan, LoanAmortizationSchedule, AutomatedDeductionLog } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { jsPDF } from 'jspdf';

interface LoanDashboardProps {
  settings: StoreSettings;
  userRole: string; // 'owner' | 'manager' | 'sales'
  activeStore: string;
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

export default function LoanDashboard({ settings, userRole, activeStore }: LoanDashboardProps) {
  // DB states Loaded live safely
  const [loans, setLoans] = useState<Loan[]>([]);
  const [amortization, setAmortization] = useState<LoanAmortizationSchedule[]>([]);
  const [deductions, setDeductions] = useState<AutomatedDeductionLog[]>([]);

  // Sub-navigation navigation tab state
  const [subTab, setSubTab] = useState<'expenses' | 'transfers' | 'procurement' | 'statements' | 'loans' | 'assets_equity'>('loans');
  const [expenseSubView, setExpenseSubView] = useState<'all' | 'operating' | 'purchase_orders'>('all');

  // DB tables for Expenses, Transfers and Transit Procurement
  const [expensesList, setExpensesList] = useState<any[]>([]);
  const [transfersList, setTransfersList] = useState<any[]>([]);
  const [transitPurchasesList, setTransitPurchasesList] = useState<any[]>([]);
  const [productList, setProductList] = useState<any[]>([]);

  // Expenses Form states
  const [expenseCategory, setExpenseCategory] = useState('Operating - Rent & Premises');
  const [expenseAccountId, setExpenseAccountId] = useState('acc_cash');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDescription, setExpenseDescription] = useState('');
  const [expenseRef, setExpenseRef] = useState('');
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().split('T')[0]);
  const [expenseStoreId, setExpenseStoreId] = useState(activeStore || 'lusaka');
  const [expenseSearchQuery, setExpenseSearchQuery] = useState('');
  const [expenseFilterCategory, setExpenseFilterCategory] = useState('ALL');

  // Money Transfers Form states
  const [transferSourceAcc, setTransferSourceAcc] = useState('acc_bank');
  const [transferDestAcc, setTransferDestAcc] = useState('acc_cash');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferRef, setTransferRef] = useState('');
  const [transferDate, setTransferDate] = useState(new Date().toISOString().split('T')[0]);

  // Goods in Transit / Procurement Form states
  const [showNewTransitModal, setShowNewTransitModal] = useState(false);
  const [transitSupplierName, setTransitSupplierName] = useState('');
  const [transitStoreId, setTransitStoreId] = useState(activeStore || 'lusaka');
  const [transitPaymentAcc, setTransitPaymentAcc] = useState('acc_bank');
  const [transitPaymentMethod, setTransitPaymentMethod] = useState('BANK_TRANSFER');
  const [transitNotes, setTransitNotes] = useState('');
  const [transitItems, setTransitItems] = useState<Array<{ productId: string | number; productName: string; quantity: number; baseUnitPrice: number }>>([]);
  const [transitAddExpenses, setTransitAddExpenses] = useState<Array<{ name: string; amount: number; category: string }>>([
    { name: 'Freight & Road Transport', amount: 0, category: 'Freight' },
    { name: 'Port & Customs Clearing Fee', amount: 0, category: 'Handling' },
    { name: 'Handling & Offloading', amount: 0, category: 'Handling' }
  ]);

  // Item form inside transit modal
  const [selectedTransitProduct, setSelectedTransitProduct] = useState('');
  const [customTransitProductName, setCustomTransitProductName] = useState('');
  const [transitItemQty, setTransitItemQty] = useState('10');
  const [transitItemUnitPrice, setTransitItemUnitPrice] = useState('100');

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
      const rxPt = runSql("SELECT * FROM purchases_transit ORDER BY created_at DESC", 'Transit Procurement: Fetch purchases in transit');
      if (rxPt.success && Array.isArray(rxPt.data)) {
        setTransitPurchasesList(rxPt.data);
      }

      // 7. Load product list for selection
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

  // Load custom assets and equity on mount or activeStore changes
  useEffect(() => {
    const savedAssets = localStorage.getItem(`pos_custom_assets_${activeStore}`);
    const savedEquity = localStorage.getItem(`pos_custom_equity_${activeStore}`);

    if (savedAssets) {
      try {
        const parsed = JSON.parse(savedAssets);
        // Migrate legacy assets safely to the new format
        const migrated: Asset[] = parsed.map((a: any) => ({
          id: a.id || 'asset-' + Math.floor(1000 + Math.random() * 9000),
          name: a.name || 'Unnamed Asset',
          category: a.category || 'Fixed',
          type: a.type || 'Equipment',
          purchaseDate: a.purchaseDate || '2025-01-01',
          value: Number(a.value || 0),
          depreciationMethod: a.depreciationMethod || 'None',
          depreciationRate: a.depreciationRate !== undefined ? Number(a.depreciationRate) : 0,
          status: a.status || 'Active',
          notes: a.notes || '',
          linkedEquityId: a.linkedEquityId || undefined
        }));
        setAssets(migrated);
      } catch (e) {
        console.error('Error migrating loaded assets', e);
      }
    } else {
      const defaultAssets: Asset[] = [
        {
          id: 'asset-1',
          name: 'Shop Fixtures & Shelving',
          category: 'Fixed',
          type: 'Equipment',
          purchaseDate: '2025-01-15',
          value: 15000,
          depreciationMethod: 'Straight Line',
          depreciationRate: 10,
          status: 'Active',
          notes: 'Standard storage shelving and metal display cabinet structures'
        },
        {
          id: 'asset-2',
          name: 'Commercial Espresso Machine & Brewer',
          category: 'Fixed',
          type: 'Equipment',
          purchaseDate: '2025-04-22',
          value: 25000,
          depreciationMethod: 'Straight Line',
          depreciationRate: 15,
          status: 'Active',
          notes: 'Premium commercial espresso brewer with matching grinders'
        },
        {
          id: 'asset-3',
          name: 'Stock Security Cash Float',
          category: 'Current',
          type: 'Other',
          purchaseDate: '2026-01-01',
          value: 5000,
          depreciationMethod: 'None',
          depreciationRate: 0,
          status: 'Active',
          notes: 'Petty cash and secure vault cash float to facilitate POS transactions'
        }
      ];
      setAssets(defaultAssets);
      localStorage.setItem(`pos_custom_assets_${activeStore}`, JSON.stringify(defaultAssets));
    }

    if (savedEquity) {
      setEquity(JSON.parse(savedEquity));
    } else {
      const defaultEquity = [
        { id: 'equity-1', name: 'Owner\'s Invested Capital', value: 40000 },
        { id: 'equity-2', name: 'SME Start-up Matching Grant', value: 5000 },
      ];
      setEquity(defaultEquity);
      localStorage.setItem(`pos_custom_equity_${activeStore}`, JSON.stringify(defaultEquity));
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
    const amt = parseFloat(transferAmount);
    if (isNaN(amt) || amt <= 0) {
      alert('Please enter a valid transfer amount.');
      return;
    }
    if (transferSourceAcc === transferDestAcc) {
      alert('Source and destination accounts must be different.');
      return;
    }

    const txId = 'tx-trf-' + Date.now();
    const createdAt = new Date().toISOString();

    const accLabels: Record<string, string> = {
      'acc_cash': 'Counter Cash Drawer',
      'acc_momo': 'Mobile Wallet Account',
      'acc_bank': 'Commercial Bank Account'
    };

    const narration = `Internal Transfer: ${accLabels[transferSourceAcc] || transferSourceAcc} -> ${accLabels[transferDestAcc] || transferDestAcc} (${transferRef || 'Float Movement'})`;

    runSql(
      `INSERT INTO transactions VALUES ('${txId}', 'idem-${txId}', 'FINANCE-TRANSFER', 'INTERNAL_TRANSFER', '${transferRef || 'TRF-REF'}', ${amt}, 0, 'SUCCESS', '${narration.replace(/'/g, "''")}', '${createdAt}', '${createdAt}', '${userRole}')`,
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

    persistTablesToStorage();
    loadData();
    loadStatementData();

    setTransferAmount('');
    setTransferRef('');
    alert(`Successfully moved ${settings.currency}${amt.toFixed(2)} from ${accLabels[transferSourceAcc]} to ${accLabels[transferDestAcc]}.`);
  };

  // --- TRANSIT PROCUREMENT ENGINE ---
  const handleAddTransitItem = () => {
    let pName = customTransitProductName;
    let pId: string | number = 'custom-' + Date.now();

    if (selectedTransitProduct) {
      const found = productList.find(p => String(p.id) === String(selectedTransitProduct));
      if (found) {
        pName = found.name;
        pId = found.id;
      }
    }

    if (!pName) {
      alert('Please select a product or enter a custom item name.');
      return;
    }

    const qty = parseInt(transitItemQty);
    const unitPrice = parseFloat(transitItemUnitPrice);

    if (isNaN(qty) || qty <= 0 || isNaN(unitPrice) || unitPrice < 0) {
      alert('Please enter valid quantity and unit price.');
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

  const handleCreateTransitPurchase = (e: React.FormEvent) => {
    e.preventDefault();
    if (!transitSupplierName) {
      alert('Please enter supplier name.');
      return;
    }
    if (transitItems.length === 0) {
      alert('Please add at least one product line item.');
      return;
    }

    const totalBase = transitItems.reduce((sum, item) => sum + (item.quantity * item.baseUnitPrice), 0);
    const totalAdditional = transitAddExpenses.reduce((sum, exp) => sum + Number(exp.amount || 0), 0);
    const totalLanded = totalBase + totalAdditional;

    const transitId = 'pt-' + Date.now();
    const createdAt = new Date().toISOString();

    runSql(
      `INSERT INTO purchases_transit VALUES ('${transitId}', '${transitSupplierName.replace(/'/g, "''")}', '${transitStoreId}', '${transitPaymentAcc}', '${transitPaymentMethod}', '${JSON.stringify(transitItems).replace(/'/g, "''")}', '${JSON.stringify(transitAddExpenses).replace(/'/g, "''")}', ${totalBase}, ${totalAdditional}, ${totalLanded}, 'IN_TRANSIT', '${transitNotes.replace(/'/g, "''")}', '${createdAt}', '${createdAt}', '', '')`,
      'Transit Procurement: Create shipment in transit'
    );

    const txId = 'tx-pt-' + Date.now();
    runSql(
      `INSERT INTO transactions VALUES ('${txId}', 'idem-${transitId}', 'PROCUREMENT', 'PURCHASE_TRANSIT', '${transitId}', ${totalLanded}, 0, 'SUCCESS', 'Transit Purchase: ${transitSupplierName.replace(/'/g, "''")} (Landed Cost: ${settings.currency}${totalLanded.toFixed(2)})', '${createdAt}', '${createdAt}', '${userRole}')`,
      'Transit Procurement: Journal'
    );

    runSql(
      `INSERT INTO ledger_entries VALUES ('le-${Date.now()}-1', '${txId}', 'acc_transit', 'DEBIT', ${totalLanded}, '${createdAt}')`,
      'Transit Ledger: Debit Goods in Transit'
    );
    runSql(
      `INSERT INTO ledger_entries VALUES ('le-${Date.now()}-2', '${txId}', '${transitPaymentAcc}', 'CREDIT', ${totalLanded}, '${createdAt}')`,
      'Transit Ledger: Credit Payment Source'
    );

    // Sync Purchase Order into expenses table for central audit trail
    const expId = 'exp-po-' + Date.now();
    runSql(
      `INSERT INTO expenses (id, category, account_id, amount, description, reference_no, expense_date, store_id, created_at, created_by) VALUES ('${expId}', 'Purchase Order - Goods & Transit', '${transitPaymentAcc}', ${totalLanded}, 'PO #${transitId}: Supplier ${transitSupplierName.replace(/'/g, "''")} (${transitItems.length} items)', '${transitId}', '${createdAt.split('T')[0]}', '${transitStoreId}', '${createdAt}', '${userRole}')`,
      'Transit Procurement: Sync Purchase Order to Expenses'
    );

    logEmployeeAudit('PURCHASE', 'Created Purchase Order', `PO #${transitId}, Supplier: ${transitSupplierName}, Items: ${transitItems.length}, Landed Cost: K${totalLanded.toFixed(2)}`, totalLanded, transitStoreId, userRole);

    persistTablesToStorage();
    loadData();
    loadStatementData();

    setShowNewTransitModal(false);
    setTransitSupplierName('');
    setTransitItems([]);
    setTransitNotes('');

    alert(`Transit Shipment #${transitId} recorded for ${settings.currency}${totalLanded.toFixed(2)} total landed cost.`);
  };

  const handleUpdateTransitStage = (transitId: string, newStage: string) => {
    runSql(
      `UPDATE purchases_transit SET stage = '${newStage}', updated_at = '${new Date().toISOString()}' WHERE id = '${transitId}'`,
      `Transit Procurement: Update stage to ${newStage}`
    );
    logEmployeeAudit('PURCHASE', 'Updated Purchase Order Stage', `PO #${transitId} stage updated to ${newStage}`, 0, 'lusaka', userRole);
    persistTablesToStorage();
    loadData();
  };

  const handleAcceptTransitDelivery = (po: any) => {
    if (!confirm(`Are you sure you want to accept stock for Shipment #${po.id}? Stock quantities for ${po.store_id.toUpperCase()} branch will be increased according to final landed cost calculations.`)) {
      return;
    }

    const receivedAt = new Date().toISOString();
    let items: any[] = [];
    try { items = JSON.parse(po.items_json); } catch (e) {}

    const totalBase = Number(po.total_base_amount || 0);
    const totalAdditional = Number(po.total_additional_expenses || 0);
    const overheadRatio = totalBase > 0 ? (totalAdditional / totalBase) : 0;

    runSql(
      `UPDATE purchases_transit SET stage = 'LANDED_AT_STORE', updated_at = '${receivedAt}', received_at = '${receivedAt}', received_by = '${userRole}' WHERE id = '${po.id}'`,
      'Transit Procurement: Accept stock at store'
    );

    logEmployeeAudit('PURCHASE', 'Received Procurement Goods', `PO #${po.id} accepted & received into branch ${po.store_id.toUpperCase()}. Items landed: ${items.length}`, Number(po.total_landed_cost || 0), po.store_id, userRole);

    items.forEach((it: any) => {
      const landedUnitPrice = parseFloat((it.baseUnitPrice * (1 + overheadRatio)).toFixed(2));
      const qty = Number(it.quantity || 0);

      runSql(
        `UPDATE products SET stock = stock + ${qty}, cost = ${landedUnitPrice} WHERE id = ${it.productId} OR id = '${it.productId}'`,
        `Transit Stock Acceptance: Add ${qty} units to product #${it.productId}`
      );

      const storeProdCheck = runSql(`SELECT * FROM store_products WHERE product_id = '${it.productId}' AND store_id = '${po.store_id}'`, 'Check store_products');
      if (storeProdCheck.success && Array.isArray(storeProdCheck.data) && storeProdCheck.data.length > 0) {
        runSql(
          `UPDATE store_products SET stock = stock + ${qty}, price = ${landedUnitPrice * 1.3} WHERE product_id = '${it.productId}' AND store_id = '${po.store_id}'`,
          `Transit Stock Acceptance: Update store stock for product #${it.productId}`
        );
      } else {
        const spId = 'sp-' + Date.now() + '-' + Math.random().toString(36).substring(2, 5);
        runSql(
          `INSERT INTO store_products VALUES ('${spId}', '${it.productId}', '${po.store_id}', ${qty}, ${landedUnitPrice * 1.3})`,
          `Transit Stock Acceptance: Insert store product record`
        );
      }
    });

    const txId = 'tx-land-' + Date.now();
    runSql(
      `INSERT INTO transactions VALUES ('${txId}', 'idem-${po.id}-landed', 'STORE-${po.store_id.toUpperCase()}', 'STOCK_LANDED', '${po.id}', ${po.total_landed_cost}, 0, 'SUCCESS', 'Stock Accepted: Order #${po.id} landed at ${po.store_id}', '${receivedAt}', '${receivedAt}', '${userRole}')`,
      'Transit Procurement: Stock landed journal'
    );
    runSql(
      `INSERT INTO ledger_entries VALUES ('le-${Date.now()}-1', '${txId}', 'acc_inventory', 'DEBIT', ${po.total_landed_cost}, '${receivedAt}')`,
      'Transit Ledger: Debit Store Inventory'
    );
    runSql(
      `INSERT INTO ledger_entries VALUES ('le-${Date.now()}-2', '${txId}', 'acc_transit', 'CREDIT', ${po.total_landed_cost}, '${receivedAt}')`,
      'Transit Ledger: Credit Goods in Transit'
    );

    persistTablesToStorage();
    loadData();
    loadStatementData();

    alert(`Stock successfully received into ${po.store_id.toUpperCase()} inventory! Product cost updated to final landed price.`);
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

      doc.save(`CREDIT_AGREEMENT_${ln.id}.pdf`);
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
    const matchesStore = !activeStore || ex.store_id === activeStore || ex.store_id === 'lusaka';
    const matchesPeriod = isDateInPeriod(ex.expense_date || ex.created_at);
    return matchesStore && matchesPeriod;
  });

  const recordedExpensesTotal = filteredExpenses.reduce((sum, ex) => sum + Number(ex.amount || 0), 0);

  // Period multiplier for baseline fixed expenses if no recorded expenses exist
  let periodMonthsMultiplier = 1;
  if (selectedPeriod === 'this_quarter') periodMonthsMultiplier = 3;
  else if (selectedPeriod === 'this_year') periodMonthsMultiplier = 12;
  else if (selectedPeriod === 'all_time') periodMonthsMultiplier = 4; // defaults to 4 months average baseline 

  const rentExpense = 4500 * periodMonthsMultiplier;
  const utilitiesExpense = 1200 * periodMonthsMultiplier;
  const generalOfficeExpense = 800 * periodMonthsMultiplier;

  const totalExpenses = filteredExpenses.length > 0
    ? recordedExpensesTotal + payrollExpense
    : payrollExpense + rentExpense + utilitiesExpense + generalOfficeExpense;

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
      balanceAccounts.push({
        id: acc.account_id,
        name: acc.account_name,
        balance: Math.abs(Number(acc.current_balance || 0))
      });
      if (acc.account_id && (acc.account_id.includes('clearing') || acc.account_id.includes('wallet') || acc.account_id.includes('cash'))) {
        ledgersCash += Math.abs(Number(acc.current_balance || 0));
      }
    });
  }

  // Baseline positive cash for active systems
  const computedCash = Math.max(30000 + netRevenue - payrollExpense - totalRepaidCapital, ledgersCash || 20000);
  
  // Inventory Value
  const prodRes = runSql("SELECT SUM(stock * cost) AS stock_value FROM products", 'Balance Sheet: Inventory pricing', true);
  const inventoryValuation = prodRes.success && prodRes.data[0]?.stock_value ? Number(prodRes.data[0].stock_value) : 23500;

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

  const startingPeriodCash = Math.max(5000, computedCash - netChangeInCash);
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
      
      doc.save(`FINANCIAL_REPORT_${selectedPeriod}_${activeStore}.pdf`);
    } catch (e) {
      console.error(e);
      alert('Error rendering statements PDF document: ' + String(e));
    }
  };
  // --- END OF FINANCIAL REPORT ENGINE
  return (
    <div className="flex-1 flex overflow-hidden flex-col bg-slate-50 text-slate-800 p-4 md:p-6 select-text">
      
      {/* SUB-TAB COMPONENT SELECTOR */}
      <div className="flex border-b border-slate-200 mb-5 gap-1.5 select-none pb-0.5 shrink-0 overflow-x-auto scrollbar-none">
        <button
          onClick={() => { setSubTab('expenses'); setExpenseSubView('all'); }}
          className={`px-3.5 py-2 text-xs font-black uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
            subTab === 'expenses'
              ? 'border-indigo-600 text-indigo-700 font-extrabold bg-indigo-50/50 rounded-t-lg'
              : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-t-lg'
          }`}
        >
          <DollarSign size={14} />
          <span>Expenses & Purchase Orders</span>
        </button>

        <button
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
          onClick={() => { setSubTab('expenses'); setExpenseSubView('purchase_orders'); }}
          className={`px-3.5 py-2 text-xs font-black uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
            subTab === 'procurement' || (subTab === 'expenses' && expenseSubView === 'purchase_orders')
              ? 'border-indigo-600 text-indigo-700 font-extrabold bg-indigo-50/50 rounded-t-lg'
              : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-t-lg'
          }`}
        >
          <Truck size={14} />
          <span>Goods in Transit & POs</span>
        </button>

        <button
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
          onClick={() => setSubTab('loans')}
          className={`px-3.5 py-2 text-xs font-black uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
            subTab === 'loans'
              ? 'border-indigo-600 text-indigo-700 font-extrabold bg-indigo-50/50 rounded-t-lg'
              : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-t-lg'
          }`}
        >
          <Coins size={14} />
          <span>Advances & Sweeps</span>
        </button>

        <button
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

      <AnimatePresence mode="wait">
        {/* EXPENSES SUBTAB */}
        {subTab === 'expenses' && (
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
                    <span>Business Expenses, Outflows & Purchase Orders</span>
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Manage store operating costs (rent, utilities, wages) and supplier Purchase Orders (goods in transit, freight, customs, and landed prices).
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setShowNewTransitModal(true)}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-3.5 py-2 rounded-xl text-xs uppercase tracking-wider shadow-sm transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <PackagePlus size={15} />
                    <span>+ Create Purchase Order</span>
                  </button>
                </div>
              </div>

              {/* Metric Summary Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border-t border-slate-100 pt-3">
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-200/70">
                  <span className="text-[10px] text-slate-400 font-extrabold uppercase block">Operating Expenses</span>
                  <span className="text-base font-black text-slate-900">
                    {settings.currency}{expensesList.reduce((sum, e) => sum + Number(e.amount || 0), 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-slate-500 block">{expensesList.length} recorded entries</span>
                </div>

                <div className="bg-indigo-50/50 p-3 rounded-xl border border-indigo-100">
                  <span className="text-[10px] text-indigo-500 font-extrabold uppercase block">Purchase Orders & Landed Costs</span>
                  <span className="text-base font-black text-indigo-900">
                    {settings.currency}{transitPurchasesList.reduce((sum, po) => sum + Number(po.total_landed_cost || 0), 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-indigo-600 block">{transitPurchasesList.length} active purchase orders</span>
                </div>

                <div className="bg-rose-50/50 p-3 rounded-xl border border-rose-100">
                  <span className="text-[10px] text-rose-500 font-extrabold uppercase block">Combined Business Outflows</span>
                  <span className="text-base font-black text-rose-700">
                    {settings.currency}{(
                      expensesList.reduce((sum, e) => sum + Number(e.amount || 0), 0) +
                      transitPurchasesList.reduce((sum, po) => sum + Number(po.total_landed_cost || 0), 0)
                    ).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-rose-600 block">Total Expenses + PO Investments</span>
                </div>
              </div>

              {/* Sub-section Selector Tabs */}
              <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-xl w-fit border border-slate-200 text-xs font-extrabold select-none mt-1">
                <button
                  onClick={() => setExpenseSubView('all')}
                  className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                    expenseSubView === 'all'
                      ? 'bg-white text-indigo-700 shadow-xs font-black'
                      : 'text-slate-600 hover:text-slate-900 font-bold'
                  }`}
                >
                  <Layers size={14} />
                  <span>All Expenses & POs ({expensesList.length + transitPurchasesList.length})</span>
                </button>
                <button
                  onClick={() => setExpenseSubView('operating')}
                  className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                    expenseSubView === 'operating'
                      ? 'bg-white text-indigo-700 shadow-xs font-black'
                      : 'text-slate-600 hover:text-slate-900 font-bold'
                  }`}
                >
                  <Receipt size={14} />
                  <span>Operating Expenses ({expensesList.length})</span>
                </button>
                <button
                  onClick={() => setExpenseSubView('purchase_orders')}
                  className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                    expenseSubView === 'purchase_orders'
                      ? 'bg-white text-indigo-700 shadow-xs font-black'
                      : 'text-slate-600 hover:text-slate-900 font-bold'
                  }`}
                >
                  <Truck size={14} />
                  <span>Purchase Orders ({transitPurchasesList.length})</span>
                </button>
              </div>
            </div>

            {/* OPERATING EXPENSES SECTION */}
            {(expenseSubView === 'all' || expenseSubView === 'operating') && (
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
                      <option value="acc_cash">Counter Cash Drawer (acc_cash)</option>
                      <option value="acc_momo">Mobile Money Wallet (acc_momo)</option>
                      <option value="acc_bank">Commercial Bank Account (acc_bank)</option>
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
                        <option value="lusaka">Lusaka Branch</option>
                        <option value="kitwe">Kitwe Branch</option>
                        <option value="ndola">Ndola Branch</option>
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
                                {ex.account_id === 'acc_cash' ? 'Cash Drawer' : ex.account_id === 'acc_momo' ? 'Mobile Wallet' : 'Bank Account'}
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
            )}

            {/* PURCHASE ORDERS & GOODS IN TRANSIT SECTION (INCLUDED UNDER EXPENSES) */}
            {(expenseSubView === 'all' || expenseSubView === 'purchase_orders') && (
              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col gap-4">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b pb-3">
                  <div>
                    <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-2">
                      <Truck className="text-indigo-600" size={18} />
                      <span>Purchase Orders & Goods in Transit ({transitPurchasesList.length})</span>
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Supplier purchase orders, freight charges, customs clearing fees, landed cost calculation, and stock receiving.
                    </p>
                  </div>
                  <button
                    onClick={() => setShowNewTransitModal(true)}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-3.5 py-2 rounded-xl text-xs uppercase tracking-wider shadow-xs transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <PackagePlus size={15} />
                    <span>+ New Purchase Order</span>
                  </button>
                </div>

                <div className="space-y-4">
                  {transitPurchasesList.map((po) => {
                    let items: any[] = [];
                    let addExpenses: any[] = [];
                    try { items = JSON.parse(po.items_json); } catch (e) {}
                    try { addExpenses = JSON.parse(po.additional_expenses_json); } catch (e) {}

                    const baseTotal = Number(po.total_base_amount || 0);
                    const addTotal = Number(po.total_additional_expenses || 0);
                    const landedTotal = Number(po.total_landed_cost || 0);
                    const overheadPct = baseTotal > 0 ? ((addTotal / baseTotal) * 100).toFixed(1) : '0.0';

                    return (
                      <div key={po.id} className="bg-slate-50 p-4 rounded-xl border border-slate-200 flex flex-col gap-3">
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 border-b border-slate-200 pb-2.5">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-black text-slate-900 font-mono">PO #{po.id}</span>
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider ${
                                po.stage === 'LANDED_AT_STORE' 
                                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' 
                                  : 'bg-amber-100 text-amber-800 border border-amber-200'
                              }`}>
                                {po.stage === 'LANDED_AT_STORE' ? 'Received at Store' : po.stage || 'IN_TRANSIT'}
                              </span>
                              <span className="text-[10px] font-bold text-slate-500 uppercase bg-slate-200/70 px-2 py-0.5 rounded">
                                Store: {po.store_id || 'lusaka'}
                              </span>
                            </div>
                            <span className="text-xs font-bold text-slate-700 block mt-1">Supplier: {po.supplier_name}</span>
                          </div>

                          <div className="flex items-center gap-2">
                            {po.stage !== 'LANDED_AT_STORE' && (
                              <button
                                onClick={() => handleAcceptTransitDelivery(po)}
                                className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-3 py-1.5 rounded-lg text-xs uppercase tracking-wider cursor-pointer flex items-center gap-1 shadow-xs"
                              >
                                <PackageCheck size={14} />
                                <span>Receive Stock</span>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* PO LINE ITEMS SUMMARY */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                          <div className="bg-white p-3 rounded-lg border border-slate-200/80">
                            <span className="text-[10px] font-extrabold uppercase text-slate-400 block mb-1">Purchased Line Items ({items.length})</span>
                            <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
                              {items.map((it, idx) => (
                                <div key={idx} className="flex justify-between text-slate-700 text-[11px] font-medium border-b border-slate-100 pb-0.5">
                                  <span>{it.productName} (x{it.quantity})</span>
                                  <span className="font-bold">{settings.currency}{(it.quantity * it.baseUnitPrice).toFixed(2)}</span>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="bg-white p-3 rounded-lg border border-slate-200/80 flex flex-col justify-between">
                            <div>
                              <span className="text-[10px] font-extrabold uppercase text-slate-400 block mb-1">Landed Overhead Breakdown</span>
                              <div className="space-y-1 text-[11px] text-slate-600">
                                <div className="flex justify-between">
                                  <span>Supplier Base Invoice:</span>
                                  <span className="font-bold">{settings.currency}{baseTotal.toFixed(2)}</span>
                                </div>
                                <div className="flex justify-between text-indigo-600 font-semibold">
                                  <span>Freight & Customs Landing Fees:</span>
                                  <span>+{settings.currency}{addTotal.toFixed(2)} ({overheadPct}%)</span>
                                </div>
                              </div>
                            </div>

                            <div className="border-t border-slate-200 pt-1.5 mt-2 flex justify-between items-center font-black text-slate-900 text-xs">
                              <span>Total Landed Expense:</span>
                              <span className="text-indigo-600 text-sm font-mono">{settings.currency}{landedTotal.toFixed(2)}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {transitPurchasesList.length === 0 && (
                    <div className="bg-slate-50 p-8 rounded-xl border border-dashed border-slate-300 text-center">
                      <Truck className="mx-auto text-slate-300 mb-2" size={32} />
                      <h4 className="text-xs font-bold text-slate-700">No Purchase Orders Recorded</h4>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        Create supplier purchase orders to track goods in transit and apportion landing freight costs into expenses.
                      </p>
                      <button
                        onClick={() => setShowNewTransitModal(true)}
                        className="mt-3 bg-indigo-600 text-white font-bold px-3 py-1.5 rounded-lg text-xs uppercase tracking-wider inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <PackagePlus size={14} />
                        <span>Create First Purchase Order</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
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
                    {settings.currency}{(
                      runSql("SELECT current_balance FROM view_account_balances WHERE account_id = 'acc_cash'", 'Check cash balance', true).data?.[0]?.current_balance || 15400
                    ).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-slate-400 block mt-0.5">Account ID: acc_cash</span>
                </div>
              </div>

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-4">
                <div className="p-3 bg-indigo-50 text-indigo-600 rounded-xl">
                  <CreditCard size={24} />
                </div>
                <div>
                  <span className="text-xs text-slate-400 font-bold block uppercase tracking-wider">Mobile Money Wallet</span>
                  <span className="text-lg font-black text-slate-900">
                    {settings.currency}{(
                      runSql("SELECT current_balance FROM view_account_balances WHERE account_id = 'acc_momo'", 'Check momo balance', true).data?.[0]?.current_balance || 8200
                    ).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                  <span className="text-[10px] text-slate-400 block mt-0.5">MTN / Airtel Merchant</span>
                </div>
              </div>

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-4">
                <div className="p-3 bg-blue-50 text-blue-600 rounded-xl">
                  <Building2 size={24} />
                </div>
                <div>
                  <span className="text-xs text-slate-400 font-bold block uppercase tracking-wider">Commercial Bank Account</span>
                  <span className="text-lg font-black text-slate-900">
                    {settings.currency}{(
                      runSql("SELECT current_balance FROM view_account_balances WHERE account_id = 'acc_bank'", 'Check bank balance', true).data?.[0]?.current_balance || 42000
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

                <form onSubmit={handleTransferMoney} className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">From Account (Source)</label>
                    <select
                      value={transferSourceAcc}
                      onChange={(e) => setTransferSourceAcc(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="acc_bank">Commercial Bank Account</option>
                      <option value="acc_cash">Counter Cash Drawer</option>
                      <option value="acc_momo">Mobile Money Wallet</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">To Account (Destination)</label>
                    <select
                      value={transferDestAcc}
                      onChange={(e) => setTransferDestAcc(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="acc_cash">Counter Cash Drawer</option>
                      <option value="acc_momo">Mobile Money Wallet</option>
                      <option value="acc_bank">Commercial Bank Account</option>
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

                  <div>
                    <label className="block text-xs font-bold text-slate-600 mb-1">Reference / Reason</label>
                    <input
                      type="text"
                      placeholder="e.g. Daily cash float deposit to bank"
                      value={transferRef}
                      onChange={(e) => setTransferRef(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>

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
                        <th className="py-2.5 px-3">Reference</th>
                        <th className="py-2.5 px-3 text-right">Amount ({settings.currency})</th>
                        <th className="py-2.5 px-3 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {transfersList.map((tr) => (
                        <tr key={tr.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-3 px-3 font-medium text-slate-600 whitespace-nowrap">
                            {tr.created_at ? new Date(tr.created_at).toLocaleDateString() : 'N/A'}
                          </td>
                          <td className="py-3 px-3 font-bold text-slate-800">
                            {tr.narration || 'Internal Account Transfer'}
                          </td>
                          <td className="py-3 px-3 font-mono text-[11px] text-slate-500">
                            {tr.reference_no || 'TRF-REF'}
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
                      ))}
                      {transfersList.length === 0 && (
                        <tr>
                          <td colSpan={5} className="text-center py-8 text-slate-400 font-medium text-xs">
                            No account transfers logged yet.
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

        {/* PROCUREMENT / GOODS IN TRANSIT SUBTAB */}
        {subTab === 'procurement' && (
          <motion.div
            key="procurement-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-6 pr-1"
          >
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
              <div>
                <h2 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
                  <Truck className="text-indigo-600" size={20} />
                  <span>Purchases in Transit & Landed Cost Engine</span>
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Track goods in transit, add landing overhead (freight, customs, handling) to calculate final landed price, and accept stock into store inventory.
                </p>
              </div>
              <button
                onClick={() => setShowNewTransitModal(true)}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-4 py-2.5 rounded-xl text-xs uppercase tracking-wider shadow-md hover:shadow-indigo-200 transition-all cursor-pointer flex items-center gap-2"
              >
                <PackagePlus size={16} />
                <span>+ Create Transit Purchase</span>
              </button>
            </div>

            {/* TRANSIT SHIPMENTS LIST */}
            <div className="space-y-4">
              {transitPurchasesList.map((po) => {
                let items: any[] = [];
                let addExpenses: any[] = [];
                try { items = JSON.parse(po.items_json); } catch (e) {}
                try { addExpenses = JSON.parse(po.additional_expenses_json); } catch (e) {}

                const baseTotal = Number(po.total_base_amount || 0);
                const addTotal = Number(po.total_additional_expenses || 0);
                const landedTotal = Number(po.total_landed_cost || 0);
                const overheadPct = baseTotal > 0 ? ((addTotal / baseTotal) * 100).toFixed(1) : '0.0';

                return (
                  <div key={po.id} className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col gap-4">
                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b pb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-black text-slate-900">Shipment #{po.id}</span>
                          <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase ${
                            po.stage === 'LANDED_AT_STORE'
                              ? 'bg-emerald-100 text-emerald-800'
                              : po.stage === 'CUSTOMS_HANDLING'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-indigo-100 text-indigo-800'
                          }`}>
                            {po.stage.replace(/_/g, ' ')}
                          </span>
                        </div>
                        <span className="text-xs text-slate-500 block mt-0.5">
                          Supplier: <strong className="text-slate-800">{po.supplier_name}</strong> | Target Branch: <strong className="text-slate-800 uppercase">{po.store_id}</strong>
                        </span>
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <span className="text-[10px] text-slate-400 block font-semibold uppercase">Total Landed Cost</span>
                          <span className="text-base font-black text-slate-900">
                            {settings.currency}{landedTotal.toFixed(2)}
                          </span>
                          <span className="text-[10px] text-emerald-600 block font-bold">
                            (Includes +{overheadPct}% freight overhead)
                          </span>
                        </div>

                        {po.stage !== 'LANDED_AT_STORE' && (
                          <button
                            onClick={() => handleAcceptTransitDelivery(po)}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-3 py-2 rounded-xl text-xs uppercase tracking-wider shadow-sm transition-all cursor-pointer flex items-center gap-1.5"
                          >
                            <PackageCheck size={14} />
                            <span>Accept Stock at Store</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* EXPENSES & ITEMS BREAKDOWN */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-50/70 p-4 rounded-xl border border-slate-100 text-xs">
                      <div>
                        <span className="font-extrabold text-slate-700 block mb-2 uppercase text-[11px]">Product Line Items</span>
                        <ul className="space-y-1.5">
                          {items.map((it: any, idx: number) => {
                            const ratio = baseTotal > 0 ? (addTotal / baseTotal) : 0;
                            const landedUnit = it.baseUnitPrice * (1 + ratio);
                            return (
                              <li key={idx} className="flex justify-between items-center text-slate-600 border-b border-slate-200/50 pb-1">
                                <span>{it.quantity}x <strong>{it.productName}</strong></span>
                                <span className="font-semibold text-slate-800">
                                  Base: {settings.currency}{it.baseUnitPrice.toFixed(2)} -&gt; <strong className="text-indigo-700">Landed: {settings.currency}{landedUnit.toFixed(2)}/unit</strong>
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>

                      <div>
                        <span className="font-extrabold text-slate-700 block mb-2 uppercase text-[11px]">Landing Overhead Expenses</span>
                        <div className="space-y-1 text-slate-600">
                          <div className="flex justify-between">
                            <span>Base Goods Invoice Total:</span>
                            <span className="font-bold">{settings.currency}{baseTotal.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between text-rose-600 font-medium">
                            <span>Freight & Customs Landing Fees:</span>
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
              })}

              {transitPurchasesList.length === 0 && (
                <div className="bg-white p-12 rounded-2xl border border-slate-200 text-center">
                  <Truck className="mx-auto text-slate-300 mb-3" size={40} />
                  <h3 className="text-sm font-bold text-slate-700">No Goods in Transit Currently</h3>
                  <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                    Create a purchase order in transit to track goods prior to store arrival and automatically apportion freight costs to arrive at true landed prices.
                  </p>
                  <button
                    onClick={() => setShowNewTransitModal(true)}
                    className="mt-4 bg-indigo-600 text-white font-bold px-4 py-2 rounded-xl text-xs uppercase tracking-wider inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <PackagePlus size={14} />
                    <span>Create Transit Order</span>
                  </button>
                </div>
              )}
            </div>

            {/* NEW TRANSIT MODAL */}
            {showNewTransitModal && (
              <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="bg-white w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden border border-slate-200 flex flex-col max-h-[90vh]"
                >
                  <div className="p-4 bg-slate-900 text-white flex justify-between items-center">
                    <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2">
                      <Truck size={18} className="text-indigo-400" />
                      <span>New Transit Purchase & Landed Cost PO</span>
                    </h3>
                    <button
                      onClick={() => setShowNewTransitModal(false)}
                      className="text-slate-400 hover:text-white cursor-pointer"
                    >
                      <X size={18} />
                    </button>
                  </div>

                  <form onSubmit={handleCreateTransitPurchase} className="p-5 overflow-y-auto space-y-4 flex-1">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-bold text-slate-600 mb-1">Supplier Name</label>
                        <input
                          type="text"
                          placeholder="e.g. Dubai Wholesale Wholesalers"
                          value={transitSupplierName}
                          onChange={(e) => setTransitSupplierName(e.target.value)}
                          required
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-600 mb-1">Landing Target Branch</label>
                        <select
                          value={transitStoreId}
                          onChange={(e) => setTransitStoreId(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                          <option value="lusaka">Lusaka Branch</option>
                          <option value="kitwe">Kitwe Branch</option>
                          <option value="ndola">Ndola Branch</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-bold text-slate-600 mb-1">Payment Account Source</label>
                        <select
                          value={transitPaymentAcc}
                          onChange={(e) => setTransitPaymentAcc(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                          <option value="acc_bank">Commercial Bank Account (acc_bank)</option>
                          <option value="acc_cash">Counter Cash Drawer (acc_cash)</option>
                          <option value="acc_momo">Mobile Money Wallet (acc_momo)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-600 mb-1">Payment Method</label>
                        <select
                          value={transitPaymentMethod}
                          onChange={(e) => setTransitPaymentMethod(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                          <option value="BANK_TRANSFER">Bank Wire Transfer</option>
                          <option value="MOBILE_MONEY">Mobile Money</option>
                          <option value="CASH">Cash</option>
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
                            onChange={(e) => setSelectedTransitProduct(e.target.value)}
                            className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-medium"
                          >
                            <option value="">-- Select Existing Product --</option>
                            {productList.map(p => (
                              <option key={p.id} value={p.id}>{p.name} (Cost: {settings.currency}{p.cost})</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <input
                            type="number"
                            placeholder="Qty"
                            value={transitItemQty}
                            onChange={(e) => setTransitItemQty(e.target.value)}
                            className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-medium"
                          />
                        </div>
                        <div>
                          <input
                            type="number"
                            step="0.01"
                            placeholder="Base Unit Price"
                            value={transitItemUnitPrice}
                            onChange={(e) => setTransitItemUnitPrice(e.target.value)}
                            className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-medium"
                          />
                        </div>
                      </div>

                      {!selectedTransitProduct && (
                        <input
                          type="text"
                          placeholder="Or type custom item name if new..."
                          value={customTransitProductName}
                          onChange={(e) => setCustomTransitProductName(e.target.value)}
                          className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-medium"
                        />
                      )}

                      <button
                        type="button"
                        onClick={handleAddTransitItem}
                        className="bg-slate-800 text-white text-xs font-bold py-1.5 px-3 rounded-lg hover:bg-slate-900 cursor-pointer"
                      >
                        + Add Item Line
                      </button>

                      {/* ADDED ITEMS LIST */}
                      {transitItems.length > 0 && (
                        <div className="space-y-1 pt-2">
                          {transitItems.map((it, idx) => (
                            <div key={idx} className="flex justify-between items-center bg-white p-2 rounded border text-xs">
                              <span><strong>{it.quantity}x</strong> {it.productName} @ {settings.currency}{it.baseUnitPrice.toFixed(2)}/unit</span>
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-slate-900">{settings.currency}{(it.quantity * it.baseUnitPrice).toFixed(2)}</span>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveTransitItem(idx)}
                                  className="text-rose-500 hover:text-rose-700"
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
                      <span className="text-xs font-black uppercase tracking-wider text-indigo-900 block">Landing Overhead Expenses (Transport & Customs)</span>
                      <div className="grid grid-cols-3 gap-2">
                        {transitAddExpenses.map((exp, idx) => (
                          <div key={idx}>
                            <label className="block text-[10px] font-bold text-indigo-800 mb-1">{exp.name}</label>
                            <input
                              type="number"
                              step="0.01"
                              placeholder="0.00"
                              value={exp.amount || ''}
                              onChange={(e) => {
                                const val = parseFloat(e.target.value) || 0;
                                const updated = [...transitAddExpenses];
                                updated[idx].amount = val;
                                setTransitAddExpenses(updated);
                              }}
                              className="w-full bg-white border border-indigo-200 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-900"
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="p-3 bg-slate-900 text-white rounded-xl flex justify-between items-center text-xs">
                      <div>
                        <span className="text-slate-400 block font-semibold">Calculated Total Landed Value</span>
                        <span className="text-lg font-black text-emerald-400">
                          {settings.currency}{(
                            transitItems.reduce((s, i) => s + (i.quantity * i.baseUnitPrice), 0) +
                            transitAddExpenses.reduce((s, e) => s + Number(e.amount || 0), 0)
                          ).toFixed(2)}
                        </span>
                      </div>
                      <button
                        type="submit"
                        className="bg-emerald-500 hover:bg-emerald-600 text-white font-extrabold px-4 py-2 rounded-xl text-xs uppercase tracking-wider cursor-pointer"
                      >
                        Dispatch Shipment
                      </button>
                    </div>
                  </form>
                </motion.div>
              </div>
            )}
          </motion.div>
        )}

        {subTab === 'loans' && (
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
                      placeholder="45000"
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
        {showApplyModal && (
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

    </div>
  );
}
