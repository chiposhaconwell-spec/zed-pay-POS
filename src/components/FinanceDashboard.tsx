import React, { useState, useEffect } from 'react';
import { 
  DollarSign, 
  FileText, 
  Printer, 
  Download, 
  Plus, 
  Truck, 
  RefreshCw, 
  Layers, 
  Search, 
  Filter, 
  CheckCircle2, 
  Building2, 
  Wallet, 
  CreditCard, 
  ArrowLeftRight, 
  TrendingUp, 
  X,
  PackagePlus,
  PackageCheck,
  AlertCircle,
  Receipt
} from 'lucide-react';
import { runSql, persistTablesToStorage, logEmployeeAudit } from '../db';
import { StoreSettings } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { jsPDF } from 'jspdf';

interface FinanceDashboardProps {
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

export default function FinanceDashboard({ settings, userRole, activeStore }: FinanceDashboardProps) {
  // Sub-navigation tab state
  const [subTab, setSubTab] = useState<'statements' | 'expenses' | 'procurement' | 'transfers' | 'assets_equity'>('statements');
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
  const [accountBalances, setAccountBalances] = useState<any[]>([]);

  // DB raw tables loaded for Financial Statements
  const [statementOrders, setStatementOrders] = useState<any[]>([]);
  const [statementItems, setStatementItems] = useState<any[]>([]);
  const [statementAttendance, setStatementAttendance] = useState<any[]>([]);

  // Asset Creation Form states
  const [newAssetName, setNewAssetName] = useState('');
  const [newAssetCategory, setNewAssetCategory] = useState<'Current' | 'Fixed'>('Fixed');
  const [newAssetValue, setNewAssetValue] = useState('');
  const [newAssetType, setNewAssetType] = useState<'Equipment' | 'Vehicles' | 'Property' | 'Other'>('Equipment');
  const [newAssetPurchaseDate, setNewAssetPurchaseDate] = useState(new Date().toISOString().split('T')[0]);
  const [newAssetDepreciationMethod, setNewAssetDepreciationMethod] = useState<'Straight Line' | 'Reducing Balance' | 'None'>('Straight Line');
  const [newAssetDepreciationRate, setNewAssetDepreciationRate] = useState<number>(10);
  const [newAssetNotes, setNewAssetNotes] = useState('');
  const [autoLinkToEquity, setAutoLinkToEquity] = useState<boolean>(true);
  const [showAddAssetForm, setShowAddAssetForm] = useState<boolean>(false);

  // Equity Creation Form states
  const [newEquityName, setNewEquityName] = useState('');
  const [newEquityValue, setNewEquityValue] = useState('');

  // Load finance tables on mount or store change
  const loadFinanceData = () => {
    // 1. Load Operating Expenses
    const expRes = runSql('SELECT * FROM expenses ORDER BY expense_date DESC', 'Finance: Fetch operating expenses');
    if (expRes.success && Array.isArray(expRes.data)) {
      setExpensesList(expRes.data);
    }

    // 2. Load Transfers
    const trRes = runSql('SELECT * FROM money_transfers ORDER BY transfer_date DESC', 'Finance: Fetch transfers');
    if (trRes.success && Array.isArray(trRes.data)) {
      setTransfersList(trRes.data);
    }

    // 3. Load Transit Purchases & Products
    const poRes = runSql('SELECT * FROM transit_purchases ORDER BY created_at DESC', 'Finance: Fetch POs');
    if (poRes.success && Array.isArray(poRes.data)) {
      setTransitPurchasesList(poRes.data);
    }

    const prRes = runSql('SELECT * FROM products ORDER BY name ASC', 'Finance: Fetch products');
    if (prRes.success && Array.isArray(prRes.data)) {
      setProductList(prRes.data);
    }

    // 4. Load Raw Tables for Financial P&L
    const ordRes = runSql(`
      SELECT * FROM orders 
      WHERE LOWER(TRIM(status)) NOT IN ('cancelled', 'voided', 'refunded', 'deleted')
      AND (
        LOWER(TRIM(status)) IN ('completed', 'paid', 'success', 'active', 'quicksale')
        OR status IS NULL 
        OR status = ''
      )
      ORDER BY orderDate DESC
    `, 'Finance: Fetch completed orders for P&L');
    if (ordRes.success && Array.isArray(ordRes.data)) setStatementOrders(ordRes.data);

    const itmRes = runSql('SELECT * FROM order_items', 'Finance: Fetch order items for P&L');
    if (itmRes.success && Array.isArray(itmRes.data)) setStatementItems(itmRes.data);

    const attRes = runSql("SELECT * FROM time_attendance WHERE status = 'PAID'", 'Finance: Fetch paid payroll');
    if (attRes.success && Array.isArray(attRes.data)) setStatementAttendance(attRes.data);

    // 5. Load Live Account Balances from SQL View
    const balRes = runSql('SELECT * FROM view_account_balances', 'Finance: Fetch live double-entry account balances');
    if (balRes.success && Array.isArray(balRes.data)) {
      setAccountBalances(balRes.data);
    }

    // 6. Load Assets and Equity
    const assetRes = runSql('SELECT * FROM assets', 'Finance: Fetch assets');
    if (assetRes.success && Array.isArray(assetRes.data)) {
      const parsedAssets = assetRes.data.map((a: any) => ({
        id: a.id,
        name: a.name,
        category: a.category || 'Fixed',
        type: a.type || 'Equipment',
        purchaseDate: a.purchase_date || '2026-01-01',
        value: Number(a.value || 0),
        depreciationMethod: a.depreciation_method || 'Straight Line',
        depreciationRate: Number(a.depreciation_rate || 0),
        status: a.status || 'Active',
        notes: a.notes || '',
        linkedEquityId: a.linked_equity_id || ''
      }));
      setAssets(parsedAssets);
    }

    const eqRes = runSql('SELECT * FROM equity', 'Finance: Fetch equity');
    if (eqRes.success && Array.isArray(eqRes.data)) {
      const parsedEquity = eqRes.data.map((e: any) => ({
        id: e.id,
        name: e.name,
        value: Number(e.value || 0),
        linkedAssetId: e.linked_asset_id || ''
      }));
      setEquity(parsedEquity);
    }
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

  // Handle adding expense
  const handleRecordExpense = (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(expenseAmount);
    if (isNaN(amt) || amt <= 0) {
      alert('Please enter a valid expense amount greater than 0.');
      return;
    }

    const expId = 'EXP-' + Math.floor(10000 + Math.random() * 90000);
    const dateVal = expenseDate || new Date().toISOString().split('T')[0];

    runSql(
      `INSERT INTO expenses (id, category, account_id, amount, description, reference_no, expense_date, store_id, performed_by)
       VALUES ('${expId}', '${expenseCategory.replace(/'/g, "''")}', '${expenseAccountId}', ${amt}, '${expenseDescription.replace(/'/g, "''")}', '${expenseRef.replace(/'/g, "''")}', '${dateVal}', '${expenseStoreId}', 'Finance Admin')`,
      'Record Operating Expense'
    );

    logEmployeeAudit('EXPENSE', 'Recorded Operating Expense', `Expense #${expId} recorded for ${expenseCategory} - K${amt.toFixed(2)} (${expenseDescription})`, amt, expenseStoreId, 'Finance Admin');
    persistTablesToStorage();

    setExpenseAmount('');
    setExpenseDescription('');
    setExpenseRef('');
    loadFinanceData();
    alert(`✓ Expense record #${expId} created successfully!`);
  };

  // Handle Cash / Account Transfer
  const handleExecuteTransfer = (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(transferAmount);
    if (isNaN(amt) || amt <= 0) {
      alert('Please enter a valid transfer amount.');
      return;
    }
    if (transferSourceAcc === transferDestAcc) {
      alert('Source and destination accounts must be different!');
      return;
    }

    const trId = 'TRF-' + Math.floor(10000 + Math.random() * 90000);
    const dateVal = transferDate || new Date().toISOString().split('T')[0];

    runSql(
      `INSERT INTO money_transfers (id, source_account, dest_account, amount, reference_no, transfer_date, performed_by)
       VALUES ('${trId}', '${transferSourceAcc}', '${transferDestAcc}', ${amt}, '${transferRef.replace(/'/g, "''")}', '${dateVal}', 'Finance Admin')`,
      'Record Cash Transfer'
    );

    logEmployeeAudit('TRANSFER', 'Account Transfer', `Transfer #${trId} from ${transferSourceAcc} to ${transferDestAcc} - K${amt.toFixed(2)}`, amt, activeStore, 'Finance Admin');
    persistTablesToStorage();

    setTransferAmount('');
    setTransferRef('');
    loadFinanceData();
    alert(`✓ Cash transfer #${trId} executed successfully!`);
  };

  // Handle PO Goods in Transit Item Add
  const handleAddTransitItem = () => {
    const qty = parseInt(transitItemQty);
    const price = parseFloat(transitItemUnitPrice);
    if (isNaN(qty) || qty <= 0 || isNaN(price) || price < 0) {
      alert('Please enter a valid item quantity and unit price.');
      return;
    }

    let pId: string | number = 'CUSTOM-' + Date.now();
    let pName = customTransitProductName || 'Custom Goods Item';

    if (selectedTransitProduct && selectedTransitProduct !== 'custom') {
      const found = productList.find(p => String(p.id) === String(selectedTransitProduct));
      if (found) {
        pId = found.id;
        pName = found.name;
      }
    }

    setTransitItems([...transitItems, { productId: pId, productName: pName, quantity: qty, baseUnitPrice: price }]);
    setSelectedTransitProduct('');
    setCustomTransitProductName('');
    setTransitItemQty('10');
    setTransitItemUnitPrice('100');
  };

  // Handle PO Creation
  const handleSaveTransitOrder = () => {
    if (transitItems.length === 0) {
      alert('Please add at least one product item to the purchase order.');
      return;
    }

    const poId = 'PO-' + Math.floor(10000 + Math.random() * 90000);
    const baseTotal = transitItems.reduce((acc, item) => acc + (item.quantity * item.baseUnitPrice), 0);
    const addlTotal = transitAddExpenses.reduce((acc, exp) => acc + Number(exp.amount || 0), 0);
    const grandLandedTotal = baseTotal + addlTotal;

    const itemsJson = JSON.stringify(transitItems);
    const addlJson = JSON.stringify(transitAddExpenses);

    runSql(
      `INSERT INTO transit_purchases (id, supplier_name, store_id, payment_account, payment_method, base_total, additional_expenses_total, grand_landed_total, status, items_json, additional_expenses_json, notes, created_at)
       VALUES ('${poId}', '${transitSupplierName.replace(/'/g, "''") || 'Supplier Outflow'}', '${transitStoreId}', '${transitPaymentAcc}', '${transitPaymentMethod}', ${baseTotal}, ${addlTotal}, ${grandLandedTotal}, 'IN_TRANSIT', '${itemsJson.replace(/'/g, "''")}', '${addlJson.replace(/'/g, "''")}', '${transitNotes.replace(/'/g, "''")}', '${new Date().toISOString()}')`,
      'Create Purchase Order'
    );

    logEmployeeAudit('PROCUREMENT', 'Created Purchase Order', `PO #${poId} created for ${transitSupplierName} - Landed Total K${grandLandedTotal.toFixed(2)}`, grandLandedTotal, transitStoreId, 'Finance Admin');
    persistTablesToStorage();

    setShowNewTransitModal(false);
    setTransitSupplierName('');
    setTransitNotes('');
    setTransitItems([]);
    loadFinanceData();
    alert(`✓ Purchase Order #${poId} logged in Goods in Transit successfully!`);
  };

  // Receive PO Inventory
  const handleReceiveTransitOrder = (po: any) => {
    if (!confirm(`Confirm receipt and stock intake for PO #${po.id}? Stock quantities will be updated in store stock.`)) return;

    try {
      const items = JSON.parse(po.items_json || '[]');
      items.forEach((itm: any) => {
        if (itm.productId && !String(itm.productId).startsWith('CUSTOM-')) {
          runSql(
            `UPDATE products SET stock = stock + ${Number(itm.quantity)} WHERE id = '${itm.productId}'`,
            `Intake PO stock ${itm.productName}`
          );
        }
      });
    } catch (err) {
      console.error(err);
    }

    runSql(
      `UPDATE transit_purchases SET status = 'RECEIVED' WHERE id = '${po.id}'`,
      'Mark PO Received'
    );

    logEmployeeAudit('PROCUREMENT', 'Received Purchase Order Stock', `Received stock for PO #${po.id}`, po.grand_landed_total, po.store_id, 'Finance Admin');
    persistTablesToStorage();
    loadFinanceData();
    alert(`✓ PO #${po.id} stock received and added to active inventory!`);
  };

  // Add Asset & Equity
  const handleAddAsset = (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(newAssetValue);
    if (isNaN(val) || val <= 0 || !newAssetName.trim()) {
      alert('Please enter a valid asset name and positive monetary value.');
      return;
    }

    const astId = 'AST-' + Math.floor(1000 + Math.random() * 9000);
    const eqId = 'EQ-' + Math.floor(1000 + Math.random() * 9000);

    runSql(
      `INSERT INTO assets (id, name, category, type, purchase_date, value, depreciation_method, depreciation_rate, status, notes, linked_equity_id)
       VALUES ('${astId}', '${newAssetName.replace(/'/g, "''")}', '${newAssetCategory}', '${newAssetType}', '${newAssetPurchaseDate}', ${val}, '${newAssetDepreciationMethod}', ${newAssetDepreciationRate}, 'Active', '${newAssetNotes.replace(/'/g, "''")}', '${autoLinkToEquity ? eqId : ''}')`,
      'Add Asset Record'
    );

    if (autoLinkToEquity) {
      runSql(
        `INSERT INTO equity (id, name, value, linked_asset_id)
         VALUES ('${eqId}', 'Owner Equity (${newAssetName.replace(/'/g, "''")})', ${val}, '${astId}')`,
        'Add Linked Capital Equity'
      );
    }

    logEmployeeAudit('FINANCE', 'Added Asset & Capital Equity', `Asset ${newAssetName} value K${val.toFixed(2)} recorded`, val, activeStore, 'Finance Admin');
    persistTablesToStorage();

    setNewAssetName('');
    setNewAssetValue('');
    setNewAssetNotes('');
    setShowAddAssetForm(false);
    loadFinanceData();
    alert(`✓ Asset #${astId} recorded in Balance Sheet registry!`);
  };

  const handleAddEquity = (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(newEquityValue);
    if (isNaN(val) || val <= 0 || !newEquityName.trim()) {
      alert('Please enter a valid capital equity name and amount.');
      return;
    }

    const eqId = 'EQ-' + Math.floor(1000 + Math.random() * 9000);
    runSql(
      `INSERT INTO equity (id, name, value, linked_asset_id)
       VALUES ('${eqId}', '${newEquityName.replace(/'/g, "''")}', ${val}, '')`,
      'Add Capital Equity Record'
    );

    persistTablesToStorage();
    setNewEquityName('');
    setNewEquityValue('');
    loadFinanceData();
    alert(`✓ Capital Equity #${eqId} added!`);
  };

  // --- FINANCIAL CALCULATIONS (P&L & BALANCE SHEET) ---
  const calculateFinancials = () => {
    // 1. Gross Revenue & Sales
    const totalRevenue = statementOrders.reduce((sum, ord) => sum + Number(ord.total || ord.total_amount || 0), 0);

    // 2. Cost of Goods Sold (COGS)
    let totalCogs = 0;
    statementItems.forEach(itm => {
      const qty = Number(itm.quantity || 1);
      const unitCost = Number(itm.cost || itm.buy_price || (itm.unitPrice ? itm.unitPrice * 0.7 : (itm.unit_price ? itm.unit_price * 0.7 : 0)));
      totalCogs += qty * unitCost;
    });

    const grossProfit = totalRevenue - totalCogs;

    // 3. Operating Expenses
    const totalOperatingExpenses = expensesList.reduce((sum, exp) => sum + Number(exp.amount || 0), 0);

    // 4. Payroll Expenses
    const totalPayroll = statementAttendance.reduce((sum, att) => sum + Number(att.gross_payment || 0), 0);

    // 5. Total Expenses
    const totalExpenses = totalOperatingExpenses + totalPayroll;

    // 6. Net Profit / Income
    const netProfit = grossProfit - totalExpenses;

    // 7. Assets & Equity
    const totalAssetVal = assets.reduce((sum, ast) => sum + Number(ast.value || 0), 0);
    const totalEquityVal = equity.reduce((sum, eq) => sum + Number(eq.value || 0), 0);

    return {
      totalRevenue,
      totalCogs,
      grossProfit,
      totalOperatingExpenses,
      totalPayroll,
      totalExpenses,
      netProfit,
      totalAssetVal,
      totalEquityVal
    };
  };

  const financials = calculateFinancials();

  // Export Financial Statements PDF
  const handleExportPDF = () => {
    try {
      const doc = new jsPDF();
      doc.setFontSize(18);
      doc.text(settings.storeName || 'POS Merchant', 14, 20);
      doc.setFontSize(14);
      doc.text('Profit & Loss Statement (Income Statement)', 14, 30);
      doc.setFontSize(10);
      doc.text(`Generated Date: ${new Date().toLocaleDateString()}`, 14, 38);

      let y = 50;
      doc.setFontSize(12);
      doc.text('1. Revenue', 14, y); y += 8;
      doc.setFontSize(10);
      doc.text(`Gross Sales Revenue: ${settings.currency}${financials.totalRevenue.toFixed(2)}`, 20, y); y += 12;

      doc.setFontSize(12);
      doc.text('2. Cost of Goods Sold (COGS)', 14, y); y += 8;
      doc.setFontSize(10);
      doc.text(`Cost of Inventory Sold: ${settings.currency}${financials.totalCogs.toFixed(2)}`, 20, y); y += 12;

      doc.setFontSize(12);
      doc.text(`GROSS PROFIT: ${settings.currency}${financials.grossProfit.toFixed(2)}`, 14, y); y += 14;

      doc.setFontSize(12);
      doc.text('3. Operating Expenses & Outflows', 14, y); y += 8;
      doc.setFontSize(10);
      doc.text(`Operating & Administrative Expenses: ${settings.currency}${financials.totalOperatingExpenses.toFixed(2)}`, 20, y); y += 6;
      doc.text(`Staff Payroll & Wages: ${settings.currency}${financials.totalPayroll.toFixed(2)}`, 20, y); y += 12;

      doc.setFontSize(14);
      doc.text(`NET INCOME / PROFIT: ${settings.currency}${financials.netProfit.toFixed(2)}`, 14, y);

      doc.save(`Financial_Statement_${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (e) {
      alert('Error exporting PDF statement: ' + String(e));
    }
  };

  return (
    <div className="flex-1 flex overflow-hidden flex-col bg-slate-50 text-slate-800 p-4 md:p-6 select-text">
      
      {/* SUB-TAB SELECTOR */}
      <div className="flex border-b border-slate-200 mb-5 gap-1.5 select-none pb-0.5 shrink-0 overflow-x-auto scrollbar-none">
        <button
          onClick={() => setSubTab('statements')}
          className={`px-3.5 py-2 text-xs font-black uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
            subTab === 'statements'
              ? 'border-indigo-600 text-indigo-700 font-extrabold bg-indigo-50/50 rounded-t-lg'
              : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-t-lg'
          }`}
        >
          <FileText size={14} />
          <span>Profit & Loss / P&L Statements</span>
        </button>

        <button
          onClick={() => { setSubTab('expenses'); setExpenseSubView('all'); }}
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
          onClick={() => setSubTab('procurement')}
          className={`px-3.5 py-2 text-xs font-black uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
            subTab === 'procurement'
              ? 'border-indigo-600 text-indigo-700 font-extrabold bg-indigo-50/50 rounded-t-lg'
              : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-t-lg'
          }`}
        >
          <Truck size={14} />
          <span>Goods in Transit & POs</span>
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
          <span>Accounts & Cash Transfers</span>
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
        {/* FINANCIAL STATEMENTS / P&L TAB */}
        {subTab === 'statements' && (
          <motion.div
            key="statements-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-6 pr-1"
          >
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
              <div>
                <h2 className="text-lg font-black tracking-tight text-slate-900 uppercase flex items-center gap-2">
                  <FileText className="text-indigo-600" size={22} />
                  <span>Profit & Loss Income Statement</span>
                </h2>
                <p className="text-xs text-slate-500 font-medium">
                  Real-time financial statement calculating gross sales revenue, COGS, operating expenses, and net profit.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={selectedPeriod}
                  onChange={(e) => setSelectedPeriod(e.target.value as any)}
                  className="bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold text-slate-800 focus:outline-hidden"
                >
                  <option value="all_time">All Time To Date</option>
                  <option value="this_month">This Month</option>
                  <option value="this_quarter">This Quarter</option>
                  <option value="this_year">This Year</option>
                </select>

                <button
                  onClick={handleExportPDF}
                  className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-extrabold uppercase tracking-wider flex items-center gap-1.5 transition-all shadow-xs cursor-pointer"
                >
                  <Download size={14} />
                  <span>Export Statement PDF</span>
                </button>
              </div>
            </div>

            {/* Overview Metric Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white p-4.5 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">Gross Revenue</span>
                  <span className="text-xl font-black text-slate-900 block mt-0.5">
                    {settings.currency}{financials.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="p-3 bg-emerald-50 text-emerald-600 rounded-xl">
                  <TrendingUp size={22} />
                </div>
              </div>

              <div className="bg-white p-4.5 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">Gross Profit (COGS Deducted)</span>
                  <span className="text-xl font-black text-emerald-700 block mt-0.5">
                    {settings.currency}{financials.grossProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="p-3 bg-emerald-100 text-emerald-700 rounded-xl">
                  <DollarSign size={22} />
                </div>
              </div>

              <div className="bg-white p-4.5 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">Total Operating Expenses</span>
                  <span className="text-xl font-black text-rose-600 block mt-0.5">
                    {settings.currency}{financials.totalExpenses.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="p-3 bg-rose-50 text-rose-600 rounded-xl">
                  <Receipt size={22} />
                </div>
              </div>

              <div className={`p-4.5 rounded-2xl border shadow-xs flex items-center justify-between ${
                financials.netProfit >= 0 ? 'bg-emerald-950 text-white border-emerald-800' : 'bg-rose-950 text-white border-rose-800'
              }`}>
                <div>
                  <span className="text-[10px] font-extrabold text-emerald-300 uppercase tracking-wider block">Net Income / Profit</span>
                  <span className="text-2xl font-black block mt-0.5">
                    {settings.currency}{financials.netProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="p-3 bg-emerald-800/60 text-emerald-200 rounded-xl">
                  <Wallet size={22} />
                </div>
              </div>
            </div>

            {/* Detailed Statement Ledger */}
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-4">
              <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest border-b border-slate-100 pb-3">
                FINANCIAL STATEMENT BREAKDOWN LEDGER
              </h3>

              <div className="space-y-3 font-mono text-xs">
                <div className="flex justify-between py-2 border-b border-slate-100">
                  <span className="font-sans font-bold text-slate-700">1. Gross Revenue from POS Sales</span>
                  <span className="font-extrabold text-slate-900">+{settings.currency}{financials.totalRevenue.toFixed(2)}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-slate-100 text-rose-600 pl-4">
                  <span className="font-sans font-medium">(-) Cost of Goods Sold (Inventory Purchase Value)</span>
                  <span className="font-extrabold">-{settings.currency}{financials.totalCogs.toFixed(2)}</span>
                </div>
                <div className="flex justify-between py-2.5 bg-slate-50 px-3 rounded-lg font-bold text-slate-900">
                  <span className="font-sans font-black">GROSS PROFIT MARGIN</span>
                  <span className="font-black text-emerald-700">{settings.currency}{financials.grossProfit.toFixed(2)}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-slate-100 text-rose-600 pl-4">
                  <span className="font-sans font-medium">(-) Operating Expenses & Bills</span>
                  <span className="font-extrabold">-{settings.currency}{financials.totalOperatingExpenses.toFixed(2)}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-slate-100 text-rose-600 pl-4">
                  <span className="font-sans font-medium">(-) Staff Payroll & Wages Paid</span>
                  <span className="font-extrabold">-{settings.currency}{financials.totalPayroll.toFixed(2)}</span>
                </div>
                <div className={`flex justify-between py-3 px-4 rounded-xl font-black text-sm ${
                  financials.netProfit >= 0 ? 'bg-emerald-100 text-emerald-950 border border-emerald-300' : 'bg-rose-100 text-rose-950 border border-rose-300'
                }`}>
                  <span className="font-sans uppercase">NET PROFIT / OPERATING SURPLUS</span>
                  <span>{settings.currency}{financials.netProfit.toFixed(2)}</span>
                </div>
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
                    <option value="acc_cash">💵 Cash Drawer Account</option>
                    <option value="acc_momo">📱 Mobile Money Wallet</option>
                    <option value="acc_bank">🏦 Bank Account</option>
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

        {/* GOODS IN TRANSIT & POs TAB */}
        {subTab === 'procurement' && (
          <motion.div
            key="procurement-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-6 pr-1"
          >
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex justify-between items-center">
              <div>
                <h2 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
                  <Truck className="text-indigo-600" size={22} />
                  <span>Goods in Transit & Purchase Orders</span>
                </h2>
                <p className="text-xs text-slate-500 font-medium">
                  Track supplier procurement orders, freight costs, and intake stock into inventory when received.
                </p>
              </div>

              <button
                onClick={() => setShowNewTransitModal(true)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl uppercase tracking-wider flex items-center gap-1.5 cursor-pointer shadow-xs"
              >
                <Plus size={16} />
                <span>New Purchase Order</span>
              </button>
            </div>

            {/* PO LIST TABLE */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-100 text-slate-600 uppercase font-black border-b border-slate-200">
                    <th className="p-3">PO Number</th>
                    <th className="p-3">Supplier Name</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Items Count</th>
                    <th className="p-3">Landed Total</th>
                    <th className="p-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {transitPurchasesList.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-slate-400 font-medium italic">
                        No purchase orders recorded in transit.
                      </td>
                    </tr>
                  ) : (
                    transitPurchasesList.map(po => {
                      let count = 0;
                      try { count = JSON.parse(po.items_json || '[]').length; } catch(e){}
                      return (
                        <tr key={po.id} className="hover:bg-slate-50 transition-colors">
                          <td className="p-3 font-mono font-bold text-slate-800">{po.id}</td>
                          <td className="p-3 font-bold text-slate-900">{po.supplier_name}</td>
                          <td className="p-3">
                            {po.status === 'RECEIVED' ? (
                              <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 border border-emerald-300 font-extrabold rounded-full text-[10px] uppercase">
                                RECEIVED
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 bg-amber-100 text-amber-800 border border-amber-300 font-extrabold rounded-full text-[10px] uppercase animate-pulse">
                                IN TRANSIT
                              </span>
                            )}
                          </td>
                          <td className="p-3 font-semibold text-slate-600">{count} item(s)</td>
                          <td className="p-3 font-black text-slate-900">
                            {settings.currency}{Number(po.grand_landed_total || 0).toFixed(2)}
                          </td>
                          <td className="p-3 text-right">
                            {po.status !== 'RECEIVED' && (
                              <button
                                onClick={() => handleReceiveTransitOrder(po)}
                                className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-[10.5px] rounded-lg uppercase tracking-wider cursor-pointer"
                              >
                                Intake Stock
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
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

              <form onSubmit={handleExecuteTransfer} className="grid grid-cols-1 md:grid-cols-5 gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200">
                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Source Account</label>
                  <select
                    value={transferSourceAcc}
                    onChange={(e) => setTransferSourceAcc(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                  >
                    <option value="acc_bank">🏦 Bank Account</option>
                    <option value="acc_cash">💵 Cash Drawer Account</option>
                    <option value="acc_momo">📱 Mobile Money Wallet</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Destination Account</label>
                  <select
                    value={transferDestAcc}
                    onChange={(e) => setTransferDestAcc(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                  >
                    <option value="acc_cash">💵 Cash Drawer Account</option>
                    <option value="acc_momo">📱 Mobile Money Wallet</option>
                    <option value="acc_bank">🏦 Bank Account</option>
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

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Reference / Note</label>
                  <input
                    type="text"
                    placeholder="e.g. Bank Cash Deposit"
                    value={transferRef}
                    onChange={(e) => setTransferRef(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
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
                    <th className="p-3">Ref</th>
                    <th className="p-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {transfersList.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-slate-400 font-medium italic">
                        No internal account transfers recorded.
                      </td>
                    </tr>
                  ) : (
                    transfersList.map(tr => (
                      <tr key={tr.id} className="hover:bg-slate-50 transition-colors">
                        <td className="p-3 font-mono font-bold text-slate-800">{tr.id}</td>
                        <td className="p-3 font-bold text-slate-700">{tr.source_account}</td>
                        <td className="p-3 font-bold text-slate-700">{tr.dest_account}</td>
                        <td className="p-3 font-mono text-slate-500">{tr.transfer_date}</td>
                        <td className="p-3 text-slate-500">{tr.reference_no || '—'}</td>
                        <td className="p-3 text-right font-black text-indigo-700">
                          {settings.currency}{Number(tr.amount).toFixed(2)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </motion.div>
        )}

        {/* ASSET & EQUITY REGISTRY TAB */}
        {subTab === 'assets_equity' && (
          <motion.div
            key="assets-tab"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex-1 flex flex-col overflow-y-auto space-y-6 pr-1"
          >
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex justify-between items-center">
              <div>
                <h2 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
                  <Layers className="text-indigo-600" size={22} />
                  <span>Assets & Capital Equity Registry</span>
                </h2>
                <p className="text-xs text-slate-500 font-medium">
                  Register fixed equipment, property assets, and track owner capital equity accounts.
                </p>
              </div>

              <button
                onClick={() => setShowAddAssetForm(!showAddAssetForm)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl uppercase tracking-wider cursor-pointer shadow-xs"
              >
                {showAddAssetForm ? 'Cancel' : '+ Add Asset / Equipment'}
              </button>
            </div>

            {/* ADD ASSET FORM */}
            {showAddAssetForm && (
              <form onSubmit={handleAddAsset} className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-4">
                <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-2">
                  REGISTER NEW FIXED / CURRENT ASSET
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Asset Name</label>
                    <input
                      type="text"
                      placeholder="e.g. Commercial Freezer / Generator"
                      value={newAssetName}
                      onChange={(e) => setNewAssetName(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Asset Category</label>
                    <select
                      value={newAssetCategory}
                      onChange={(e) => setNewAssetCategory(e.target.value as any)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    >
                      <option value="Fixed">Fixed Asset</option>
                      <option value="Current">Current Asset</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Purchase Cost ({settings.currency})</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      value={newAssetValue}
                      onChange={(e) => setNewAssetValue(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                      required
                    />
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-xl uppercase tracking-wider cursor-pointer shadow-xs"
                  >
                    Save Asset Record
                  </button>
                </div>
              </form>
            )}

            {/* ASSETS TABLE */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-100 text-slate-600 uppercase font-black border-b border-slate-200">
                    <th className="p-3">Asset ID</th>
                    <th className="p-3">Asset Name</th>
                    <th className="p-3">Category</th>
                    <th className="p-3">Purchase Date</th>
                    <th className="p-3 text-right">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {assets.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-slate-400 font-medium italic">
                        No fixed or current assets registered on balance sheet.
                      </td>
                    </tr>
                  ) : (
                    assets.map(ast => (
                      <tr key={ast.id} className="hover:bg-slate-50 transition-colors">
                        <td className="p-3 font-mono font-bold text-slate-800">{ast.id}</td>
                        <td className="p-3 font-bold text-slate-900">{ast.name}</td>
                        <td className="p-3 font-semibold text-slate-600">{ast.category}</td>
                        <td className="p-3 font-mono text-slate-500">{ast.purchaseDate}</td>
                        <td className="p-3 text-right font-black text-emerald-700">
                          {settings.currency}{ast.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* NEW PO MODAL OVERLAY */}
      <AnimatePresence>
        {showNewTransitModal && (
          <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl border border-slate-200 shadow-2xl p-6 max-w-2xl w-full space-y-4 my-auto"
            >
              <div className="flex justify-between items-center border-b border-slate-100 pb-3">
                <h3 className="text-sm font-black text-slate-900 uppercase tracking-wide flex items-center gap-2">
                  <Truck className="text-indigo-600" size={18} />
                  <span>Create Purchase Order (Goods in Transit)</span>
                </h3>
                <button
                  onClick={() => setShowNewTransitModal(false)}
                  className="p-1 rounded-full text-slate-400 hover:text-slate-600 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Supplier Name</label>
                  <input
                    type="text"
                    placeholder="e.g. Trade Kings Distributors"
                    value={transitSupplierName}
                    onChange={(e) => setTransitSupplierName(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Payment Method</label>
                  <select
                    value={transitPaymentMethod}
                    onChange={(e) => setTransitPaymentMethod(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                  >
                    <option value="BANK_TRANSFER">Bank Electronic Transfer</option>
                    <option value="CASH">Cash Drawer Payment</option>
                    <option value="MOBILE_MONEY">Mobile Money Transfer</option>
                  </select>
                </div>
              </div>

              {/* ITEM ADD SECTION */}
              <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 space-y-2">
                <span className="text-[10px] font-black uppercase text-slate-500 block">Add Product Line Item</span>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                  <div className="md:col-span-2">
                    <select
                      value={selectedTransitProduct}
                      onChange={(e) => setSelectedTransitProduct(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    >
                      <option value="">Select Existing Inventory Item...</option>
                      {productList.map(p => (
                        <option key={p.id} value={p.id}>{p.name} (Stock: {p.stock})</option>
                      ))}
                      <option value="custom">+ Custom Goods Item</option>
                    </select>

                    {selectedTransitProduct === 'custom' && (
                      <input
                        type="text"
                        placeholder="Enter item name"
                        value={customTransitProductName}
                        onChange={(e) => setCustomTransitProductName(e.target.value)}
                        className="w-full mt-1.5 bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                      />
                    )}
                  </div>

                  <div>
                    <input
                      type="number"
                      placeholder="Qty"
                      value={transitItemQty}
                      onChange={(e) => setTransitItemQty(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    />
                  </div>

                  <div>
                    <input
                      type="number"
                      placeholder="Cost / Unit"
                      value={transitItemUnitPrice}
                      onChange={(e) => setTransitItemUnitPrice(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleAddTransitItem}
                  className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-lg uppercase cursor-pointer"
                >
                  + Add Line Item
                </button>
              </div>

              {/* LIST OF ADDED ITEMS */}
              <div className="max-h-36 overflow-y-auto space-y-1.5 border-t border-b border-slate-100 py-2">
                {transitItems.map((itm, idx) => (
                  <div key={idx} className="flex justify-between items-center text-xs bg-slate-50 p-2 rounded-lg">
                    <span className="font-bold text-slate-800">{itm.productName} (x{itm.quantity})</span>
                    <span className="font-black text-slate-900">{settings.currency}{(itm.quantity * itm.baseUnitPrice).toFixed(2)}</span>
                  </div>
                ))}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setShowNewTransitModal(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-extrabold text-xs rounded-xl uppercase cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveTransitOrder}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl uppercase cursor-pointer shadow-xs"
                >
                  Create PO Order
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
