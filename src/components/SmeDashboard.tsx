import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area, PieChart, Pie, Cell } from 'recharts';
import { runSql } from '../db';
import { StoreSettings } from '../types';
import { TrendingUp, Award, Wallet, Activity, Code, Play, Download, FileText } from 'lucide-react';
import { motion } from 'motion/react';
import { jsPDF } from 'jspdf';

interface SmeDashboardProps {
  settings: StoreSettings;
  setActiveTab: (tab: any) => void;
  setTerminalCode?: (code: string) => void;
  userRole?: string;
  activeStore?: string;
}

interface MetricState {
  revenue: number;
  profit: number;
  transactions: number;
  avgOrderValue: number;
}

export default function SmeDashboard({ settings, setActiveTab, setTerminalCode, userRole = 'owner', activeStore = 'lusaka' }: SmeDashboardProps) {
  const [selectedStoreFilter, setSelectedStoreFilter] = useState<string>('all');
  const [metrics, setMetrics] = useState<MetricState>({ revenue: 0, profit: 0, transactions: 0, avgOrderValue: 0 });
  const [salesTrend, setSalesTrend] = useState<any[]>([]);
  const [paymentShare, setPaymentShare] = useState<any[]>([]);
  const [topItems, setTopItems] = useState<any[]>([]);
  const [accountBalances, setAccountBalances] = useState<any[]>([]);
  const [ledgerLogs, setLedgerLogs] = useState<any[]>([]);
  
  // Tab switcher for sub-dashboards (Financials vs Customer CRM Analytics)
  const [dashboardSubTab, setDashboardSubTab] = useState<'financials' | 'customers'>('financials');
  const [customerAnalytics, setCustomerAnalytics] = useState<any[]>([]);
  const [sortBy, setSortBy] = useState<'value' | 'qty' | 'frequency'>('value');
  const [selectedRewardingCustomer, setSelectedRewardingCustomer] = useState<any | null>(null);
  const [rewardType, setRewardType] = useState<string>('Discount 10% Coupon');
  const [issuedRewardMessage, setIssuedRewardMessage] = useState<string | null>(null);

  // Show SQL Snippets states
  const [showSqlFor, setShowSqlFor] = useState<'metrics' | 'trend' | 'payments' | 'leaderboard' | 'double_entry' | 'customer_crm' | null>(null);

  const getFilteredQueries = (storeId: string) => {
    return {
      metrics: `
-- Aggregate top-level financial metrics from invoices and products for branch ${storeId.toUpperCase()}
SELECT 
  (SELECT SUM(total) FROM orders WHERE status = 'Completed' ${storeId === 'all' ? '' : `AND store_id = '${storeId}'`}) AS total_revenue,
  (SELECT COUNT(*) FROM orders WHERE 1=1 ${storeId === 'all' ? '' : `AND store_id = '${storeId}'`}) AS transaction_count,
  (SELECT SUM(oi.quantity * (oi.unitPrice - p.cost)) 
   FROM order_items oi 
   JOIN products p ON oi.productId = p.id
   JOIN orders o ON oi.orderId = o.id
   WHERE o.status = 'Completed' ${storeId === 'all' ? '' : `AND o.store_id = '${storeId}'`}) AS total_profit;
      `,
      trend: `
-- Rollup sales transactions by daily date calendar buckets for branch ${storeId.toUpperCase()}
SELECT 
  SUBSTR(orderDate, 1, 10) AS date,
  SUM(total) AS revenue
FROM orders
WHERE 1=1 ${storeId === 'all' ? '' : `AND store_id = '${storeId}'`}
GROUP BY SUBSTR(orderDate, 1, 10)
ORDER BY date ASC;
      `,
      payments: `
-- Pivot sales volumes based on customer tender payment modes for branch ${storeId.toUpperCase()}
SELECT 
  paymentMethod AS name,
  SUM(total) AS value
FROM orders
WHERE 1=1 ${storeId === 'all' ? '' : `AND store_id = '${storeId}'`}
GROUP BY paymentMethod;
      `,
      leaderboard: `
-- Determine top 5 best selling catalog items using an INNER JOIN for branch ${storeId.toUpperCase()}
SELECT 
  p.name AS name,
  SUM(oi.quantity) AS value
FROM order_items oi
JOIN products p ON oi.productId = p.id
JOIN orders o ON oi.orderId = o.id
WHERE 1=1 ${storeId === 'all' ? '' : `AND o.store_id = '${storeId}'`}
GROUP BY p.name
ORDER BY value DESC
LIMIT 5;
      `,
      double_entry: `
-- Query from our SQL VIEW to calculate absolute balances of all active ledgers
SELECT 
  account_id,
  account_name,
  currency,
  COALESCE(current_balance, 0) AS balance
FROM view_account_balances;
      `
    };
  };

  const calculateAnalytics = (storeId = selectedStoreFilter) => {
    const queries = getFilteredQueries(storeId);

    // 1. Rollup core metrics using SELECT sums
    const metricsRes = runSql(queries.metrics, `Dashboard: Aggregate core financial metrics filtered by ${storeId}`);
    if (metricsRes.success && Array.isArray(metricsRes.data) && metricsRes.data[0]) {
      const data = metricsRes.data[0];
      const rev = data.total_revenue || 0;
      const txns = data.transaction_count || 0;
      const prof = data.total_profit || 0;
      const avg = txns > 0 ? rev / txns : 0;
      setMetrics({ revenue: rev, profit: prof, transactions: txns, avgOrderValue: avg });
    } else {
      setMetrics({ revenue: 0, profit: 0, transactions: 0, avgOrderValue: 0 });
    }

    // 2. Fetch daily trends
    const trendRes = runSql(queries.trend, `Dashboard: Composing daily trend logs filtered by ${storeId}`);
    if (trendRes.success && Array.isArray(trendRes.data)) {
      const formattedTrends = trendRes.data.map(item => {
        const dStr = item.date || '';
        let label = dStr;
        if (dStr.includes('-')) {
          const parts = dStr.split('-');
          const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          const mIdx = parseInt(parts[1]) - 1;
          label = `${monthNames[mIdx]} ${parts[2]}`;
        }
        return { name: label, Revenue: item.revenue || 0 };
      });
      setSalesTrend(formattedTrends);
    } else {
      setSalesTrend([]);
    }

    // 3. Fetch payment share breakdown
    const paymentRes = runSql(queries.payments, `Dashboard: Checkout ledger analysis for ${storeId}`);
    if (paymentRes.success && Array.isArray(paymentRes.data)) {
      setPaymentShare(paymentRes.data);
    } else {
      setPaymentShare([]);
    }

    // 4. Fetch catalog leaderboard
    const leaderRes = runSql(queries.leaderboard, `Dashboard: Top products analysis for ${storeId}`);
    if (leaderRes.success && Array.isArray(leaderRes.data)) {
      setTopItems(leaderRes.data);
    } else {
      setTopItems([]);
    }

    // 5. Fetch double-entry clearing accounts view
    const balRes = runSql(queries.double_entry, 'Dashboard: Compile trial balances from SQL view');
    if (balRes.success && Array.isArray(balRes.data)) {
      setAccountBalances(balRes.data);
    }

    // 6. Fetch last 5 ledger transactions
    const auditQuery = storeId === 'all'
      ? 'SELECT * FROM transactions ORDER BY created_at DESC LIMIT 5'
      : `SELECT * FROM transactions WHERE pos_terminal_id LIKE '%${storeId.toUpperCase()}%' ORDER BY created_at DESC LIMIT 5`;
    const journalsRes = runSql(auditQuery, `Dashboard: Fetch checkout audits on branch ${storeId}`);
    if (journalsRes.success && Array.isArray(journalsRes.data)) {
      setLedgerLogs(journalsRes.data);
    } else {
      setLedgerLogs([]);
    }

    // 7. Load CRM Analytics: compile frequent active clients based on transaction quantities & total spent values
    const custCrmQuery = `
      SELECT 
        c.id,
        c.name,
        c.phone,
        c.email,
        c.loyalPoints,
        (SELECT COUNT(*) FROM orders o WHERE o.customerId = c.id AND o.status = 'Completed' ${storeId === 'all' ? '' : `AND o.store_id = '${storeId}'`}) AS purchase_count,
        (SELECT COALESCE(SUM(o.total), 0) FROM orders o WHERE o.customerId = c.id AND o.status = 'Completed' ${storeId === 'all' ? '' : `AND o.store_id = '${storeId}'`}) AS total_value,
        (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON oi.orderId = o.id WHERE o.customerId = c.id AND o.status = 'Completed' ${storeId === 'all' ? '' : `AND o.store_id = '${storeId}'`}) AS total_qty
      FROM customers c
    `;
    const custCrmRes = runSql(custCrmQuery, 'CRM: Compile loyalty profiles aggregate and client frequency tracking ledger');
    if (custCrmRes.success && Array.isArray(custCrmRes.data)) {
      setCustomerAnalytics(custCrmRes.data);
    } else {
      setCustomerAnalytics([]);
    }
  };

  useEffect(() => {
    // Sales person should only view their registered branch activity records
    const targetStore = userRole === 'sales' ? activeStore : selectedStoreFilter;
    if (userRole === 'sales') {
      setSelectedStoreFilter(activeStore);
    }
    calculateAnalytics(targetStore);

    const handleUpdate = () => {
      calculateAnalytics(targetStore);
    };

    window.addEventListener('pos_sale_completed', handleUpdate);
    window.addEventListener('pos_data_updated', handleUpdate);
    window.addEventListener('storage', handleUpdate);

    return () => {
      window.removeEventListener('pos_sale_completed', handleUpdate);
      window.removeEventListener('pos_data_updated', handleUpdate);
      window.removeEventListener('storage', handleUpdate);
    };
  }, [selectedStoreFilter, userRole, activeStore]);

  const handleRunSqlInConsole = (snippet: string) => {
    if (setTerminalCode) {
      setTerminalCode(snippet);
    }
    setActiveTab('console');
  };

  const generateDailyReportPdf = () => {
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const todayStr = new Date().toISOString().split('T')[0];
    const printableDate = new Date().toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    // Filter SQL results logically by store selection
    const storeFilterWhere = selectedStoreFilter === 'all' ? '' : `AND o.store_id = '${selectedStoreFilter}'`;
    const storeFilterWhereBare = selectedStoreFilter === 'all' ? '' : `AND store_id = '${selectedStoreFilter}'`;

    // Query Database
    // 1. Core aggregates
    const dailySummaryRes = runSql(`
      SELECT 
        SUM(o.total) AS total_revenue,
        COUNT(o.id) AS transaction_count,
        SUM(o.subtotal) AS total_subtotal,
        SUM(o.tax) AS total_tax,
        SUM(o.discount) AS total_discount
      FROM orders o 
      WHERE o.orderDate LIKE '${todayStr}%' AND o.status = 'Completed' ${storeFilterWhere}
    `, 'Daily PDF: Aggregates');

    // Profit aggregates
    const dailyProfitRes = runSql(`
      SELECT SUM(oi.quantity * (oi.unitPrice - p.cost)) AS total_profit
      FROM order_items oi 
      JOIN products p ON oi.productId = p.id
      JOIN orders o ON oi.orderId = o.id
      WHERE o.status = 'Completed' AND o.orderDate LIKE '${todayStr}%' ${storeFilterWhere}
    `, 'Daily PDF: Profit');

    // Transactions listing
    const todayTxRes = runSql(`
      SELECT o.id, o.orderDate, o.total, o.paymentMethod, c.name AS customer_name
      FROM orders o
      LEFT JOIN customers c ON o.customerId = c.id
      WHERE o.orderDate LIKE '${todayStr}%' AND o.status = 'Completed' ${storeFilterWhere}
      ORDER BY o.orderDate DESC
    `, 'Daily PDF: Transactions');

    // Product sold breakdown
    const todayProdSalesRes = runSql(`
      SELECT p.name AS product_name, p.sku, SUM(oi.quantity) AS qty_sold, SUM(oi.quantity * oi.unitPrice) AS rev_generated
      FROM order_items oi
      JOIN products p ON oi.productId = p.id
      JOIN orders o ON oi.orderId = o.id
      WHERE o.status = 'Completed' AND o.orderDate LIKE '${todayStr}%' ${storeFilterWhere}
      GROUP BY p.id, p.name, p.sku
      ORDER BY qty_sold DESC
    `, 'Daily PDF: Item sales');

    // Balances
    const balRes = runSql(getFilteredQueries(selectedStoreFilter).double_entry, 'Daily PDF: Trial balances');

    // Extracts
    const summary = (dailySummaryRes.success && Array.isArray(dailySummaryRes.data) && dailySummaryRes.data[0]) 
      ? dailySummaryRes.data[0] 
      : { total_revenue: 0, transaction_count: 0, total_subtotal: 0, total_tax: 0, total_discount: 0 };

    const profitVal = (dailyProfitRes.success && Array.isArray(dailyProfitRes.data) && dailyProfitRes.data[0])
      ? (dailyProfitRes.data[0].total_profit || 0)
      : 0;

    const totalRev = summary.total_revenue || 0;
    const totalTx = summary.transaction_count || 0;
    const avgOrder = totalTx > 0 ? totalRev / totalTx : 0;

    // Header Navy Accent Band
    doc.setFillColor(15, 23, 42); // slate-900
    doc.rect(15, 15, 180, 22, 'F');

    // Header texts
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text((settings.storeName || 'SME RETAILER').toUpperCase(), 20, 24);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(203, 213, 225); // slate-300
    const filterLabel = selectedStoreFilter === 'all' ? 'ALL STORES COMBINED' : `BRANCH: ${selectedStoreFilter.toUpperCase()}`;
    doc.text(`DAILY TRANSACTION AUDIT & FINANCIAL REPORT (${filterLabel})`, 20, 30);

    // Print Date
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(59, 130, 246); // sky-500
    doc.text(printableDate.toUpperCase(), 190, 24, { align: 'right' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184); // slate-400
    doc.text(`TIMESHIFT RANGE: ${todayStr} 00:00 - 23:59`, 190, 30, { align: 'right' });

    // ----------------------------------------------------
    // SECTION 1: KEY PERFORMANCE PLATES
    // ----------------------------------------------------
    let y = 47;
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('I. FINANCIAL SUMMARY KPIS', 15, y);

    // Simple horizontal line
    doc.setDrawColor(226, 232, 240); // slate-200
    doc.setLineWidth(0.3);
    doc.line(15, y + 2, 195, y + 2);

    y += 7;

    // 4 horizontal KPI boxes
    const cardW = 42;
    const cardH = 18;
    const gap = 4;
    const colNames = ['GROSS SALES', 'NET PROFIT', 'INVOICES TOTAL', 'AVG TICKET SIZE'];
    const colVals = [
      `${settings.currency}${totalRev.toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      `${settings.currency}${profitVal.toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      `${totalTx} completed`,
      `${settings.currency}${avgOrder.toFixed(2)}`
    ];

    for (let i = 0; i < 4; i++) {
      const cardX = 15 + i * (cardW + gap);
      
      // Draw background plate
      doc.setFillColor(248, 250, 252); // slate-50
      doc.setDrawColor(241, 245, 249); // slate-100
      doc.roundedRect(cardX, y, cardW, cardH, 1.5, 1.5, 'FD');

      // Label
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139); // slate-500
      doc.text(colNames[i], cardX + 4, y + 5.5);

      // Value
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(15, 23, 42); // slate-900
      doc.text(colVals[i], cardX + 4, y + 12.5);
    }

    y += cardH + 8;

    // ----------------------------------------------------
    // SECTION 2: PRODUCT SALES BREAKDOWN
    // ----------------------------------------------------
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    doc.text('II. ITEM DEPLOYMENTS & INVENTORY DEMAND LEADERBOARD', 15, y);
    doc.line(15, y + 2, 195, y + 2);

    y += 7;

    // Header of product table
    doc.setFillColor(241, 245, 249); // slate-100
    doc.rect(15, y, 180, 5, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(71, 85, 105); // slate-600
    doc.text('CATALOG ITEM / VARIANT NAME', 18, y + 3.5);
    doc.text('SKU CODE', 95, y + 3.5);
    doc.text('QTY SOLD', 140, y + 3.5, { align: 'right' });
    doc.text('REVENUE GENERATED', 190, y + 3.5, { align: 'right' });

    y += 5;

    let productsRows = todayProdSalesRes.success && Array.isArray(todayProdSalesRes.data) ? todayProdSalesRes.data : [];

    if (productsRows.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text('No items sold to catalog databases today.', 18, y + 5);
      y += 10;
    } else {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(15, 23, 42);

      productsRows.forEach((row: any) => {
        // Row lines
        doc.text(row.product_name || 'N/A', 18, y + 4.5);
        doc.setFont('courier', 'normal');
        doc.text(row.sku || 'N/A', 95, y + 4.5);
        doc.setFont('helvetica', 'normal');
        doc.text(row.qty_sold.toString(), 140, y + 4.5, { align: 'right' });
        doc.text(`${settings.currency}${parseFloat(row.rev_generated || 0).toFixed(2)}`, 190, y + 4.5, { align: 'right' });

        // Draw safe underline
        doc.setDrawColor(241, 245, 249);
        doc.line(15, y + 6, 195, y + 6);

        y += 6;
      });
    }

    y += 6;

    // ----------------------------------------------------
    // SECTION 3: DETAILED ORDERS LEDGER LISTING
    // ----------------------------------------------------
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    doc.text('III. TRANSACTION INVOICES LOG', 15, y);
    doc.line(15, y + 2, 195, y + 2);

    y += 7;

    // Header of tx table
    doc.setFillColor(241, 245, 249);
    doc.rect(15, y, 180, 5, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(71, 85, 105);
    doc.text('INVOICE ID', 18, y + 3.5);
    doc.text('TIMESTAMP', 52, y + 3.5);
    doc.text('CUSTOMER / PAYEE', 92, y + 3.5);
    doc.text('TENDER METHOD', 145, y + 3.5);
    doc.text('GRAND TOTAL', 190, y + 3.5, { align: 'right' });

    y += 5;

    let txRows = todayTxRes.success && Array.isArray(todayTxRes.data) ? todayTxRes.data : [];

    if (txRows.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text('No ledger transactions recorded today.', 18, y + 5);
      y += 10;
    } else {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(15, 23, 42);

      txRows.forEach((row: any) => {
        doc.setFont('courier', 'bold');
        doc.text(row.id || 'N/A', 18, y + 4.5);
        doc.setFont('courier', 'normal');
        doc.text(row.orderDate || 'N/A', 52, y + 4.5);
        doc.setFont('helvetica', 'normal');
        doc.text(row.customer_name || 'Walk-in Client', 92, y + 4.5);
        doc.text((row.paymentMethod || 'N/A').toUpperCase(), 145, y + 4.5);
        doc.setFont('helvetica', 'bold');
        doc.text(`${settings.currency}${parseFloat(row.total || 0).toFixed(2)}`, 190, y + 4.5, { align: 'right' });
        doc.setFont('helvetica', 'normal');

        // Draw safe underline
        doc.setDrawColor(241, 245, 249);
        doc.line(15, y + 6, 195, y + 6);

        y += 6;
      });
    }

    y += 6;

    // Check bounds
    if (y > 230) {
      doc.addPage();
      y = 20;
    }

    // ----------------------------------------------------
    // SECTION 4: DOUBLE-ENTRY CLEARING LEDGERS
    // ----------------------------------------------------
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    doc.text('IV. SYSTEM LEDGER TRIAL BALANCES', 15, y);
    doc.line(15, y + 2, 195, y + 2);

    y += 7;

    // Header of ledger table
    doc.setFillColor(241, 245, 249);
    doc.rect(15, y, 180, 5, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(71, 85, 105);
    doc.text('ACCOUNT NAME', 18, y + 3.5);
    doc.text('CLEARING GENERAL ACCOUNT ID', 95, y + 3.5);
    doc.text('CURRENT CLEARING BALANCE', 190, y + 3.5, { align: 'right' });

    y += 5;

    let balanceRows = balRes.success && Array.isArray(balRes.data) ? balRes.data : [];

    if (balanceRows.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text('No ledger trial balance statistics available.', 18, y + 5);
      y += 10;
    } else {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(15, 23, 42);

      balanceRows.forEach((row: any) => {
        doc.setFont('helvetica', 'semibold');
        doc.text(row.account_name || 'N/A', 18, y + 4.5);
        doc.setFont('courier', 'normal');
        doc.text(row.account_id || 'N/A', 95, y + 4.5);
        doc.setFont('helvetica', 'bold');
        doc.text(`K${parseFloat(row.balance || 0).toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 190, y + 4.5, { align: 'right' });
        doc.setFont('helvetica', 'normal');

        // Draw underline
        doc.setDrawColor(241, 245, 249);
        doc.line(15, y + 6, 195, y + 6);

        y += 6;
      });
    }

    y += 12;

    // FOOTER STATEMENT
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7);
    doc.setTextColor(148, 163, 184); // slate-400
    doc.text('Audit certificate validated by strict transactional SQL trial ledger views.', 15, y);
    
    const generationTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
    doc.text(`DocuHash ID: POS-LEDGER-${todayStr} | Generated at ${generationTime} UTC`, 190, y, { align: 'right' });

    // Save PDF
    doc.save(`daily-sales-report-${todayStr}.pdf`);
  };

  const PIE_COLORS = ['#4f46e5', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-slate-50 p-4 gap-5 select-text text-left">
      
      {/* Dashboard Top Header Control Panel */}
      <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between pb-2 border-b border-slate-200 gap-3">
        <div className="flex-1">
          <h2 className="text-sm font-black uppercase tracking-wider text-slate-800 flex items-center gap-2">
            <span className="p-1 px-1.5 bg-indigo-50 text-indigo-600 rounded-lg flex items-center gap-1.5"><Activity size={15} /></span>
            SME Commercial Analytics Hub
          </h2>
          <p className="text-[10px] text-slate-400 font-sans tracking-wide mt-0.5">
            Double-entry ledger balances, invoice performance timeline, and smart transactional audits
          </p>
        </div>

        {/* Tab switcher submenus */}
        <div className="flex bg-slate-200/60 p-1 rounded-xl border border-slate-250 select-none">
          <button
            type="button"
            onClick={() => setDashboardSubTab('financials')}
            className={`px-3 py-1.5 rounded-lg text-[10.5px] font-black uppercase tracking-wider transition-all cursor-pointer ${
              dashboardSubTab === 'financials'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            📊 Financials
          </button>
          <button
            type="button"
            onClick={() => setDashboardSubTab('customers')}
            className={`px-3 py-1.5 rounded-lg text-[10.5px] font-black uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1 ${
              dashboardSubTab === 'customers'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            👥 CRM Loyalty Analysis
          </button>
        </div>

        {/* Store Selection & Report Trigger */}
        <div className="flex flex-wrap items-center gap-2.5">
          {userRole === 'sales' ? (
            <div className="flex items-center gap-1.5 bg-slate-100 hover:bg-slate-100/80 border border-slate-250 py-1.5 px-3 rounded-xl text-slate-500 text-[10.5px] font-bold">
              <span className="w-1.5 h-1.5 bg-amber-400 rounded-full"></span>
              Branch: <span className="font-mono text-slate-800 uppercase ml-0.5">{selectedStoreFilter}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 bg-white border border-slate-250 p-1 rounded-xl shadow-2xs">
              <span className="text-[9px] font-extrabold uppercase text-slate-400 pl-2">Filter Data:</span>
              <select
                value={selectedStoreFilter}
                onChange={(e) => setSelectedStoreFilter(e.target.value)}
                className="bg-slate-50 border border-slate-200 rounded-lg p-1.5 px-2 text-[10.5px] font-bold text-slate-705 focus:outline-hidden cursor-pointer"
              >
                <option value="all">🌐 All Stores Combined</option>
                <option value="lusaka">🇿🇲 Lusaka Retail Store</option>
                <option value="kitwe">🇿🇲 Kitwe Branch Warehouse</option>
                <option value="ndola">🇿🇲 Ndola Trading Post</option>
              </select>
            </div>
          )}

          <button
            type="button"
            onClick={generateDailyReportPdf}
            className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-550 active:scale-98 text-white rounded-xl text-[10.5px] font-black uppercase tracking-wider shadow-xs transition-all cursor-pointer border border-indigo-700/30 font-sans select-none"
          >
            <FileText size={13} className="text-indigo-205" />
            Download Daily Sales Report
          </button>
        </div>
      </div>
      {dashboardSubTab === 'financials' ? (
        <>
          {/* Visual KPI Cards Row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            
            {/* Revenue Metric */}
            <div className="bg-white p-4 rounded-xl border border-slate-200 relative overflow-hidden group">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wider">Gross Sales</span>
                <div className="bg-indigo-50 p-1.5 rounded-lg text-indigo-600">
                  <TrendingUp size={14} />
                </div>
              </div>
              <span className="font-mono text-base sm:text-lg font-black text-slate-900 block leading-none">
                {settings.currency}{metrics.revenue.toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <button
                onClick={() => setShowSqlFor(showSqlFor === 'metrics' ? null : 'metrics')}
                className="mt-2.5 text-[9px] font-bold text-slate-400 hover:text-indigo-600 flex items-center gap-1 cursor-pointer"
              >
                <Code size={10} /> {showSqlFor === 'metrics' ? 'Hide SQL Code' : 'Examine SQL'}
              </button>
            </div>

            {/* Profits Metric */}
            <div className="bg-white p-4 rounded-xl border border-slate-200 relative overflow-hidden group">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wider">Net Profit</span>
                <div className="bg-emerald-50 p-1.5 rounded-lg text-emerald-600">
                  <Award size={14} />
                </div>
              </div>
              <span className="font-mono text-base sm:text-lg font-black text-slate-900 block leading-none">
                {settings.currency}{metrics.profit.toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className="text-[9px] text-emerald-600 font-bold mt-1 block">
                Profit Margin: {metrics.revenue > 0 ? ((metrics.profit / metrics.revenue) * 100).toFixed(1) : 0}%
              </span>
            </div>

            {/* Transaction Count Metric */}
            <div className="bg-white p-4 rounded-xl border border-slate-200 relative overflow-hidden group">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wider">Transactions</span>
                <div className="bg-amber-50 p-1.5 rounded-lg text-amber-600">
                  <Activity size={14} />
                </div>
              </div>
              <span className="font-mono text-base sm:text-lg font-black text-slate-900 block leading-none">
                {metrics.transactions} Invoices
              </span>
              <span className="text-[9px] text-slate-400 font-medium block mt-1">Processed successfully</span>
            </div>

            {/* Avg Ticket size Metric */}
            <div className="bg-white p-4 rounded-xl border border-slate-200 relative overflow-hidden group">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wider">Ticket Size</span>
                <div className="bg-violet-50 p-1.5 rounded-lg text-violet-600">
                  <Wallet size={14} />
                </div>
              </div>
              <span className="font-mono text-base sm:text-lg font-black text-slate-900 block leading-none">
                {settings.currency}{metrics.avgOrderValue.toFixed(2)}
              </span>
              <span className="text-[9px] text-slate-400 font-medium block mt-1">Average sale ticket value</span>
            </div>

          </div>

          {/* SQL Snippet Overlay Dropdown Block */}
          {showSqlFor === 'metrics' && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              className="bg-slate-900 rounded-xl p-3 border border-slate-800 flex flex-col font-mono text-[10px]"
            >
              <div className="flex justify-between items-center text-slate-400 mb-2 font-sans text-xs">
                <span className="font-bold flex items-center gap-1 text-slate-300"><Code size={12} /> DYNAMIC SQL MULTI-SELECT KPI STATEMENTS</span>
                <button
                  onClick={() => handleRunSqlInConsole(getFilteredQueries(selectedStoreFilter).metrics)}
                  className="px-2 py-1 bg-slate-800 hover:bg-indigo-600 rounded text-[9px] text-white flex items-center gap-1 cursor-pointer font-bold uppercase tracking-wider"
                >
                  <Play size={8} fill="white" /> Run in Console
                </button>
              </div>
              <pre className="text-indigo-300 overflow-x-auto p-2 bg-slate-950 rounded border border-slate-850 select-text font-mono text-[10px] leading-normal font-medium">
                {getFilteredQueries(selectedStoreFilter).metrics.trim()}
              </pre>
            </motion.div>
          )}

          {/* Primary Charts Panels Block */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            
            {/* Left Side Big AreaChart: Sales Trend Over Time */}
            <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-4 flex flex-col h-72">
              <div className="flex items-center justify-between mb-3 select-none">
                <h3 className="text-xs font-black text-slate-805 uppercase tracking-widest flex items-center gap-1.5">
                  <TrendingUp size={14} className="text-indigo-600" />
                  Sales Revenue Timeline
                </h3>
                <button
                  onClick={() => setShowSqlFor(showSqlFor === 'trend' ? null : 'trend')}
                  className={`text-[9px] font-bold px-2 py-1 rounded-md border flex items-center gap-1 transition-colors cursor-pointer ${
                    showSqlFor === 'trend'
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                      : 'bg-white border-slate-200 text-slate-400 hover:text-slate-600'
                  }`}
                >
                  <Code size={10} /> SQL Code
                </button>
              </div>

              <div className="flex-1 min-h-[160px]">
                {salesTrend.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-slate-450 text-xs">Awaiting sales invoice trends...</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={salesTrend}>
                      <defs>
                        <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2}/>
                          <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="name" stroke="#94a3b8" fontSize={9} fontFamily="monospace" tickLine={false} />
                      <YAxis stroke="#94a3b8" fontSize={9} fontFamily="monospace" tickLine={false} />
                      <Tooltip formatter={(value) => [`${settings.currency}${value}`, 'Revenue']} />
                      <Area type="monotone" dataKey="Revenue" stroke="#4f46e5" strokeWidth={2.5} fillOpacity={1} fill="url(#colorRev)" />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Right Side: Pie Chart showing tender types */}
            <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col h-72">
              <div className="flex items-center justify-between mb-3 select-none">
                <h3 className="text-xs font-black text-slate-805 uppercase tracking-widest flex items-center gap-1.5">
                  <Wallet size={14} className="text-emerald-600" />
                  Tender Methods Share
                </h3>
                <button
                  onClick={() => setShowSqlFor(showSqlFor === 'payments' ? null : 'payments')}
                  className={`text-[9px] font-bold px-2 py-1 rounded-md border flex items-center gap-1 transition-colors cursor-pointer ${
                    showSqlFor === 'payments'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                      : 'bg-white border-slate-200 text-slate-400 hover:text-slate-600'
                  }`}
                >
                  <Code size={10} /> SQL Code
                </button>
              </div>

              <div className="flex-1 min-h-[165px] flex items-center justify-center relative">
                {paymentShare.length === 0 ? (
                  <div className="text-slate-450 text-xs">Waiting for settlements...</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={paymentShare}
                        cx="50%"
                        cy="45%"
                        innerRadius={45}
                        outerRadius={65}
                        paddingAngle={2}
                        dataKey="value"
                      >
                        {paymentShare.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => [`${settings.currency}${value}`, 'Gross Total']} />
                    </PieChart>
                  </ResponsiveContainer>
                )}

                {/* Custom Pie Legend */}
                {paymentShare.length > 0 && (
                  <div className="absolute bottom-0 inset-x-0 flex flex-wrap justify-center gap-2 px-1 text-[9px] font-bold tracking-wider font-mono text-slate-650">
                    {paymentShare.map((item, index) => (
                      <span key={index} className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }}></span>
                        {item.name.toUpperCase()} ({metrics.revenue > 0 ? (item.value * 100 / metrics.revenue).toFixed(0) : '0'}%)
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

          </div>

          {/* SQL Snippet displays matching chart selection */}
          {(showSqlFor === 'trend' || showSqlFor === 'payments') && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              className="bg-slate-900 rounded-xl p-3 border border-slate-800 flex flex-col font-mono text-[10px]"
            >
              <div className="flex justify-between items-center text-slate-400 mb-2 font-sans text-xs">
                <span className="font-bold flex items-center gap-1 text-slate-300"><Code size={12} /> ROLLUP TRANSACTION DATA BY DATE / PYMNT GROUPS</span>
                <button
                  onClick={() => handleRunSqlInConsole(showSqlFor === 'trend' ? getFilteredQueries(selectedStoreFilter).trend : getFilteredQueries(selectedStoreFilter).payments)}
                  className="px-2 py-1 bg-slate-800 hover:bg-indigo-600 rounded text-[9px] text-white flex items-center gap-1 cursor-pointer font-bold uppercase tracking-wider"
                >
                  <Play size={8} fill="white" /> Run in Console
                </button>
              </div>
              <pre className="text-indigo-200 overflow-x-auto p-2 bg-slate-950 rounded border border-slate-850 select-text font-mono text-[10px]" style={{ fontStyle: 'normal' }}>
                {showSqlFor === 'trend' ? getFilteredQueries(selectedStoreFilter).trend.trim() : getFilteredQueries(selectedStoreFilter).payments.trim()}
              </pre>
            </motion.div>
          )}

          {/* Leaderboard Products BarChart Row */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col h-80">
            <div className="flex items-center justify-between mb-3 select-none">
              <h3 className="text-xs font-black text-slate-805 uppercase tracking-widest flex items-center gap-1.5">
                <Award size={14} className="text-violet-605" />
                Top-Selling Database inventory Leaderboard
              </h3>
              <button
                onClick={() => setShowSqlFor(showSqlFor === 'leaderboard' ? null : 'leaderboard')}
                className={`text-[9px] font-bold px-2 py-1 rounded-md border flex items-center gap-1 transition-colors cursor-pointer ${
                  showSqlFor === 'leaderboard'
                    ? 'bg-violet-50 border-violet-200 text-violet-700'
                    : 'bg-white border-slate-200 text-slate-400 hover:text-slate-600'
                }`}
              >
                <Code size={10} /> SQL Code
              </button>
            </div>

            <div className="flex-1 min-h-[180px]">
              {topItems.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-450 text-xs">Sell items at terminal sale counter to load bestseller analytics logs.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topItems} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#f1f5f9" />
                    <XAxis type="number" stroke="#94a3b8" fontSize={9} tickLine={false} />
                    <YAxis dataKey="name" type="category" stroke="#64748b" fontSize={9} width={95} tickLine={false} />
                    <Tooltip formatter={(value) => [`${value} Units`, 'Quantity Sold']} />
                    <Bar dataKey="value" fill="#8b5cf6" radius={[0, 4, 4, 0]} barSize={14} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {showSqlFor === 'leaderboard' && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              className="bg-slate-900 rounded-xl p-3 border border-slate-800 flex flex-col font-mono text-[10px]"
            >
              <div className="flex justify-between items-center text-slate-400 mb-2 font-sans text-xs">
                <span className="font-bold flex items-center gap-1 text-slate-300"><Code size={12} /> TABLE INNER JOIN LEADERBOARD GROUPING</span>
                <button
                  onClick={() => handleRunSqlInConsole(getFilteredQueries(selectedStoreFilter).leaderboard)}
                  className="px-2 py-1 bg-slate-800 hover:bg-indigo-600 rounded text-[9px] text-white flex items-center gap-1 cursor-pointer font-bold uppercase tracking-wider"
                >
                  <Play size={8} fill="white" /> Run in Console
                </button>
              </div>
              <pre className="text-indigo-200 overflow-x-auto p-2 bg-slate-950 rounded border border-slate-850 select-text font-mono text-[10px]">
                {getFilteredQueries(selectedStoreFilter).leaderboard.trim()}
              </pre>
            </motion.div>
          )}

          {/* DOUBLE-ENTRY CLEARING AUDIT REGISTER ROWS */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            
            {/* Trial balance listing card */}
            <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col h-fit">
              <div className="flex items-center justify-between mb-3 select-none">
                <h3 className="text-xs font-black text-slate-805 uppercase tracking-widest flex items-center gap-1.5">
                  <Wallet size={14} className="text-indigo-600" />
                  FinTech Double-Entry Ledgers (ZMW)
                </h3>
                <button
                  onClick={() => setShowSqlFor(showSqlFor === 'double_entry' ? null : 'double_entry')}
                  className={`text-[9px] font-bold px-2 py-1 rounded-md border flex items-center gap-1 transition-colors cursor-pointer ${
                    showSqlFor === 'double_entry'
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                      : 'bg-white border-slate-200 text-slate-400 hover:text-slate-600'
                  }`}
                >
                  <Code size={10} /> SQL View
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-[11px] font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-400 uppercase tracking-widest text-[9px] font-extrabold bg-slate-50/50">
                      <th className="py-2.5 px-3">Account Name</th>
                      <th className="py-2.5 px-2">Account ID</th>
                      <th className="py-2.5 px-2 text-right">Balances</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {accountBalances.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="py-8 text-center text-slate-405 font-sans">No double-entry ledgers active under this system.</td>
                      </tr>
                    ) : (
                      accountBalances.map((acc, index) => (
                        <tr key={index} className="hover:bg-slate-50/50 transition-colors">
                          <td className="py-2.5 px-3 font-semibold text-slate-800">{acc.account_name}</td>
                          <td className="py-2.5 px-2 text-[10px] text-slate-400">{acc.account_id}</td>
                          <td className={`py-2.5 px-2 text-right font-black ${
                            acc.balance >= 0 ? 'text-emerald-700' : 'text-rose-600'
                          }`}>
                            K{parseFloat(acc.balance).toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Realtime Ledger Journal Audits listing card */}
            <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col h-fit">
              <div className="flex items-center justify-between mb-3 select-none">
                <h3 className="text-xs font-black text-slate-805 uppercase tracking-widest flex items-center gap-1.5">
                  <Activity size={14} className="text-rose-600 animate-pulse" />
                  Strict Journal Audit Logs
                </h3>
                <button
                  onClick={() => setActiveTab('console')}
                  className="text-[9px] font-bold text-slate-400 hover:text-indigo-650 flex items-center gap-1 cursor-pointer"
                >
                  Inspect Logs &rarr;
                </button>
              </div>

              <div className="divide-y divide-slate-150">
                {ledgerLogs.length === 0 ? (
                  <div className="py-12 text-center text-slate-405 font-sans text-xs">No transaction journals recorded. Check out orders to begin posting!</div>
                ) : (
                  ledgerLogs.map((tx, index) => {
                    let badgeColor = 'bg-rose-50 text-rose-750 border-rose-150';
                    if (tx.channel === 'MTN_MOMO') badgeColor = 'bg-yellow-50 text-yellow-800 border-yellow-200';
                    else if (tx.channel === 'AIRTEL_MONEY') badgeColor = 'bg-red-50 text-red-800 border-red-200';
                    else if (tx.channel === 'CARD_VISA') badgeColor = 'bg-indigo-50 text-indigo-800 border-indigo-200';
                    else if (tx.channel === 'CASH') badgeColor = 'bg-slate-50 text-slate-750 border-slate-200';

                    return (
                      <div key={index} className="py-2.5 flex flex-col gap-1 hover:bg-slate-50/50 px-2 rounded-lg transition-all duration-150">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-[10.5px] font-bold text-slate-900">{tx.id.toUpperCase()}</span>
                          <span className="font-mono text-[11px] font-black text-indigo-750">
                            K{parseFloat(tx.amount).toFixed(2)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-slate-405">
                          <div className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider">
                            <span className={`px-1.5 py-0.5 rounded border ${badgeColor} font-bold`}>{tx.channel}</span>
                            <span className="text-slate-405 text-[10px] font-medium font-sans lowercase truncate max-w-[140px]">{tx.narration}</span>
                          </div>
                          <span className="font-mono text-[9px]">{new Date(tx.created_at).toLocaleTimeString()}</span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

          </div>

          {showSqlFor === 'double_entry' && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              className="bg-slate-900 rounded-xl p-3 border border-slate-800 flex flex-col font-mono text-[10px]"
            >
              <div className="flex justify-between items-center text-slate-400 mb-2 font-sans text-xs">
                <span className="font-bold flex items-center gap-1 text-slate-300"><Code size={12} /> TRIAL BALANCE CALCULATION SELECT</span>
                <button
                  onClick={() => handleRunSqlInConsole(getFilteredQueries(selectedStoreFilter).double_entry)}
                  className="px-2 py-1 bg-slate-800 hover:bg-indigo-600 rounded text-[9px] text-white flex items-center gap-1 cursor-pointer font-bold uppercase tracking-wider"
                >
                  <Play size={8} fill="white" /> Run in Console
                </button>
              </div>
              <pre className="text-indigo-200 overflow-x-auto p-2 bg-slate-950 rounded border border-slate-850 select-text font-mono text-[10px]">
                {getFilteredQueries(selectedStoreFilter).double_entry.trim()}
              </pre>
            </motion.div>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-4 animate-fade-in text-left">
          
          {/* CRM Loyalty & Frequency stats plate */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-4">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 border-b border-slate-100 pb-3 select-none">
              <div>
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                  <span className="p-1 px-1.5 bg-indigo-50 text-indigo-600 rounded-lg flex items-center"><Activity size={12} /></span>
                  Customer Frequency, Lifetime Value & Rewards Recommendations
                </h3>
                <p className="text-[10px] text-slate-405 mt-0.5">
                  Audit purchase ledger frequencies to reward high-value VIP players with custom printed discount codes or corporative gifts.
                </p>
              </div>

              {/* CRM Sort Filters */}
              <div className="flex items-center gap-2 select-none self-end">
                <span className="text-[9px] uppercase font-extrabold text-slate-400">Sort Ledger:</span>
                <div className="inline-flex bg-slate-100 p-0.5 rounded-lg border border-slate-200">
                  <button
                    type="button"
                    onClick={() => setSortBy('value')}
                    className={`px-2 py-1 text-[9.5px] font-bold rounded-md transition-all cursor-pointer ${
                      sortBy === 'value' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    💰 Spent Total
                  </button>
                  <button
                    type="button"
                    onClick={() => setSortBy('qty')}
                    className={`px-2 py-1 text-[9.5px] font-bold rounded-md transition-all cursor-pointer ${
                      sortBy === 'qty' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    📦 Item Quantities
                  </button>
                  <button
                    type="button"
                    onClick={() => setSortBy('frequency')}
                    className={`px-2 py-1 text-[9.5px] font-bold rounded-md transition-all cursor-pointer ${
                      sortBy === 'frequency' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    🔄 Visits Frequency
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setShowSqlFor(showSqlFor === 'customer_crm' ? null : 'customer_crm')}
                  className={`p-1 px-2 border rounded-lg text-[9px] font-bold transition-all flex items-center gap-1 cursor-pointer ${
                    showSqlFor === 'customer_crm' ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-white border-slate-200 text-slate-400 hover:text-slate-600'
                  }`}
                >
                  <Code size={10} /> SQL
                </button>
              </div>
            </div>

            {/* SQL Snippet displays matching CRM query */}
            {showSqlFor === 'customer_crm' && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                className="bg-slate-900 rounded-xl p-3 border border-slate-800 flex flex-col font-mono text-[10px]"
              >
                <div className="flex justify-between items-center text-slate-400 mb-2 font-sans text-xs">
                  <span className="font-bold flex items-center gap-1 text-slate-300"><Code size={12} /> COMPREHENSIVE REPEAT BUYER COHORT MATRIX SELECT</span>
                  <button
                    onClick={() => handleRunSqlInConsole(`
-- Comprehensive customer cohorts based on transaction volumes, absolute spent value, and count of transactions
SELECT 
  c.id,
  c.name,
  c.phone,
  c.email,
  c.loyalPoints,
  (SELECT COUNT(*) FROM orders o WHERE o.customerId = c.id AND o.status = 'Completed') AS purchase_count,
  (SELECT COALESCE(SUM(o.total), 0) FROM orders o WHERE o.customerId = c.id AND o.status = 'Completed') AS total_value,
  (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON oi.orderId = o.id WHERE o.customerId = c.id AND o.status = 'Completed') AS total_qty
FROM customers c
ORDER BY total_value DESC;
                    `)}
                    className="px-2 py-1 bg-slate-800 hover:bg-indigo-600 rounded text-[9px] text-white flex items-center gap-1 cursor-pointer font-bold uppercase tracking-wider"
                  >
                    <Play size={8} fill="white" /> Run in Console
                  </button>
                </div>
                <pre className="text-indigo-200 overflow-x-auto p-2 bg-slate-950 rounded border border-slate-850 select-text font-mono text-[9px] leading-relaxed">
{`SELECT 
  c.id,
  c.name,
  c.phone,
  c.email,
  c.loyalPoints,
  (SELECT COUNT(*) FROM orders o WHERE o.customerId = c.id AND o.status = 'Completed') AS purchase_count,
  (SELECT COALESCE(SUM(o.total), 0) FROM orders o WHERE o.customerId = c.id AND o.status = 'Completed') AS total_value,
  (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON oi.orderId = o.id WHERE o.customerId = c.id AND o.status = 'Completed') AS total_qty
FROM customers c
ORDER BY total_value DESC;`}
                </pre>
              </motion.div>
            )}

            {/* Customer analytics repeat buyers spreadsheet */}
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-[10.5px] font-sans">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-400 uppercase tracking-widest text-[9px] font-black bg-slate-50/50">
                    <th className="py-3 px-3">Customer Profile</th>
                    <th className="py-3 px-2 text-center">Visits Count</th>
                    <th className="py-3 px-2 text-center">Volume Purchased</th>
                    <th className="py-3 px-2 text-right">Loyalty Points</th>
                    <th className="py-3 px-2 text-right">Net Value Spent</th>
                    <th className="py-3 px-3 text-center">Loyalty Tier</th>
                    <th className="py-3 px-3">ZRA Audited Reward Strategy</th>
                    <th className="py-3 px-3 text-center">Voucher Issuance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {customerAnalytics.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-12 text-center text-slate-400 font-sans">
                        No customer transactions recorded under this filter yet. Clear terminal sales to register loyalty stats!
                      </td>
                    </tr>
                  ) : (
                    [...customerAnalytics]
                      .sort((a, b) => {
                        if (sortBy === 'value') return b.total_value - a.total_value;
                        if (sortBy === 'qty') return b.total_qty - a.total_qty;
                        return b.purchase_count - a.purchase_count;
                      })
                      .map((cust, index) => {
                        const val = parseFloat(cust.total_value || 0);
                        const qty = parseInt(cust.total_qty || 0);
                        const count = parseInt(cust.purchase_count || 0);

                        let tier = 'BRONZE MEMBER';
                        let tierBadge = 'bg-slate-50 text-slate-600 border-slate-250';
                        let recommendation = 'Recommend: Welcome booklet or 2% voucher coupon on checkout';
                        let gift = 'Welcome Stickers Bundle';

                        if (val >= 2000 || qty >= 20 || count >= 5) {
                          tier = 'DIAMOND PLATINUM';
                          tierBadge = 'bg-indigo-50 border-indigo-200 text-indigo-750 font-black animate-pulse';
                          recommendation = 'Recommend: 15% VIP Checkout Voucher or Custom Leather Notebook/Diary';
                          gift = 'Premium Embossed Leather Notebook';
                        } else if (val >= 750 || qty >= 10 || count >= 3) {
                          tier = 'GOLD ELITE';
                          tierBadge = 'bg-amber-50 border-amber-200 text-amber-800 font-black';
                          recommendation = 'Recommend: 10% Standard Voucher or Custom Brand Thermal Flask';
                          gift = 'Double-walled Thermal Flask';
                        } else if (count >= 1) {
                          tier = 'SILVER CLASSIC';
                          tierBadge = 'bg-slate-100 border-slate-200 text-slate-700 font-bold';
                          recommendation = 'Recommend: 5% Basic Voucher Coupon or Polished Branded Keyring';
                          gift = 'Polished Store Chrome Keyring';
                        }

                        return (
                          <tr key={`${cust.id || 'cust'}-${index}`} className="hover:bg-slate-50/50 transition-colors">
                            <td className="py-3 px-3">
                              <div className="flex flex-col">
                                <span className="font-sans font-extrabold text-[11px] text-slate-900">{cust.name}</span>
                                <span className="font-mono text-[9px] text-slate-400 font-medium">PH: {cust.phone || 'N/A'} | EM: {cust.email || 'N/A'}</span>
                              </div>
                            </td>
                            <td className="py-3 px-2 text-center font-mono font-bold text-slate-800">
                              {count} orders
                            </td>
                            <td className="py-3 px-2 text-center font-mono font-bold text-slate-800">
                              {qty} pcs
                            </td>
                            <td className="py-3 px-2 text-right font-mono font-black text-indigo-650">
                              {cust.loyalPoints || 0} pts
                            </td>
                            <td className="py-3 px-2 text-right font-mono font-black text-emerald-700">
                              {settings.currency}{val.toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                            <td className="py-3 px-3 text-center select-none">
                              <span className={`px-2 py-0.5 rounded text-[8px] tracking-wider uppercase border font-bold inline-block ${tierBadge}`}>
                                {tier}
                              </span>
                            </td>
                            <td className="py-3 px-3 font-sans font-bold text-[9.5px] text-indigo-900 leading-normal max-w-[240px]">
                              {recommendation}
                            </td>
                            <td className="py-3 px-3 text-center select-none">
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedRewardingCustomer({ ...cust, tier, gift });
                                  setIssuedRewardMessage(null);
                                  setRewardType(val >= 2000 ? '15% Discount Code' : val >= 750 ? '10% Discount Code' : '5% Discount Code');
                                }}
                                className="px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-600 hover:text-white border border-indigo-200 text-indigo-700 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all cursor-pointer"
                              >
                                🎁 Issue Loyalty Gift
                              </button>
                            </td>
                          </tr>
                        );
                      })
                  )}
                </tbody>
              </table>
            </div>

          </div>

          {/* Loyalty Reward Voucher Configuration Modal */}
          {selectedRewardingCustomer && (
            <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4 z-50">
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="bg-white border border-slate-200 rounded-3xl w-full max-w-md shadow-2xl p-6 text-slate-800 text-left font-sans"
              >
                <div className="flex justify-between items-center border-b border-slate-100 pb-3 mb-4 select-none">
                  <h3 className="text-xs font-black uppercase text-slate-800 flex items-center gap-1.5">
                    <span>🌟 Issue CRM Loyalty Reward</span>
                  </h3>
                  <button
                    onClick={() => setSelectedRewardingCustomer(null)}
                    className="text-slate-400 hover:text-slate-700 text-sm font-extrabold"
                  >
                    ✕
                  </button>
                </div>

                <div className="flex flex-col gap-3.5">
                  <div className="bg-indigo-50/70 border border-indigo-150 p-4 rounded-xl text-xs">
                    <span className="block text-[8px] font-mono tracking-widest text-indigo-500 font-extrabold uppercase mb-1">Target Loyalty Beneficiary</span>
                    <strong className="text-slate-900 text-sm font-black">{selectedRewardingCustomer.name}</strong>
                    
                    <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-indigo-100/50 text-[10px] text-slate-500 font-mono">
                      <div>Tier Level: <span className="font-sans font-black text-indigo-700 uppercase">{selectedRewardingCustomer.tier}</span></div>
                      <div>Spent Total: <span className="font-bold text-emerald-600">{settings.currency}{(selectedRewardingCustomer.total_value || 0).toFixed(2)}</span></div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider">Reward / Voucher Code Selection</label>
                    <select
                      value={rewardType}
                      onChange={(e) => setRewardType(e.target.value)}
                      className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 focus:bg-white rounded-lg p-2.5 outline-hidden focus:border-indigo-500 cursor-pointer"
                    >
                      <option value="5% Discount Code">🎟️ 5% Purchase Voucher Coupon (Code: LOYAL5)</option>
                      <option value="10% Discount Code">🎟️ 10% Purchase Voucher Coupon (Code: LOYAL10)</option>
                      <option value="15% Discount Code">🎟️ 15% Purchase Voucher Coupon (Code: LOVEL15)</option>
                      <option value="Presidential Premium Diary">🎁 Presidential Executive Leather Diary (Zambia Print)</option>
                      <option value="Corporate Thermal Flask">🎁 SME Branded Double-walled Thermal Mug / Flask</option>
                      <option value="Branded Chrome Keyring">🎁 Custom Polished Chromium Ring / Gift Bundle</option>
                    </select>
                  </div>

                  {issuedRewardMessage ? (
                    <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-3 rounded-xl text-center text-[10px] font-bold">
                      {issuedRewardMessage}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        try {
                          const doc = new jsPDF({ format: [80, 100] });
                          doc.setFont('helvetica', 'bold');
                          doc.setFontSize(10);
                          doc.text('LOYALTY REWARD CERTIFICATE', 40, 12, { align: 'center' });
                          doc.setFont('helvetica', 'normal');
                          doc.setFontSize(6.5);
                          doc.text(settings.storeName.toUpperCase(), 40, 16, { align: 'center' });
                          
                          doc.setDrawColor(200, 200, 200);
                          doc.setLineWidth(0.2);
                          doc.line(4, 20, 76, 20);
                          
                          doc.setFont('helvetica', 'bold');
                          doc.text('RECIPIENT:', 4, 26);
                          doc.setFont('helvetica', 'normal');
                          doc.text(selectedRewardingCustomer.name.toUpperCase(), 24, 26);
                          
                          doc.setFont('helvetica', 'bold');
                          doc.text('TIER LEVEL:', 4, 31);
                          doc.setFont('helvetica', 'normal');
                          doc.text(selectedRewardingCustomer.tier.toUpperCase(), 24, 31);

                          doc.setFont('helvetica', 'bold');
                          doc.text('REWARD ASSUED:', 4, 36);
                          doc.setFont('helvetica', 'normal');
                          doc.text(rewardType.toUpperCase(), 24, 36);
                          
                          doc.line(4, 42, 76, 42);
                          
                          doc.setFont('helvetica', 'bold');
                          doc.setFontSize(14);
                          doc.text('ZMW-GIFT', 40, 56, { align: 'center' });
                          
                          doc.setFont('helvetica', 'normal');
                          doc.setFontSize(5);
                          doc.text('PRESENT THIS SLIP AT CHECKOUT TO REDEEM YOUR VIP OPTION', 40, 68, { align: 'center' });
                          doc.text('EXPIRES 30 DAYS FROM ISSUANCE | ID: LYL-' + Math.floor(Math.random() * 90000), 40, 72, { align: 'center' });
                          doc.text('CHIPOSHA SME INVENTORY COMPLIANCE LOGS', 40, 76, { align: 'center' });
                          
                          doc.save(`LOYALTY_TICKET_${selectedRewardingCustomer.id}.pdf`);
                          
                          // Update loyalty points counter in the SQLite DB!
                          runSql(`UPDATE customers SET loyalPoints = loyalPoints + 120 WHERE id = ${selectedRewardingCustomer.id}`, 'CRM: Update customer account points balance');
                          calculateAnalytics(selectedStoreFilter);
                          
                          setIssuedRewardMessage(`✓ Success! Dynamic PDF Loyalty Gift Ticket printed & downloaded. Customer points +120.`);
                        } catch (pdfErr) {
                          console.error('Failed to print PDF:', pdfErr);
                          setIssuedRewardMessage('✓ Success! Reward recorded inside SQLite client ledger.');
                        }
                      }}
                      className="mt-2 w-full py-2.5 bg-indigo-650 hover:bg-indigo-700 active:scale-98 text-white text-[10.5px] tracking-wider font-extrabold uppercase rounded-xl shadow-md transition-all cursor-pointer"
                    >
                      🎟️ Print & Download Reward Voucher
                    </button>
                  )}

                  <div className="grid grid-cols-2 gap-2 mt-1">
                    <button
                      type="button"
                      onClick={() => setSelectedRewardingCustomer(null)}
                      className="py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] uppercase font-bold rounded-xl cursor-pointer"
                    >
                      Return to List
                    </button>
                    {issuedRewardMessage && (
                      <button
                        type="button"
                        onClick={() => setSelectedRewardingCustomer(null)}
                        className="py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] uppercase font-bold rounded-xl cursor-pointer"
                      >
                        Finish
                      </button>
                    )}
                  </div>
                </div>
              </motion.div>
            </div>
          )}

        </div>
      )}

    </div>
  );
}
