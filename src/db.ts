import alasql from 'alasql';
import { Product, Customer, Order, OrderItem, SqlLogEntry, StoreSettings } from './types';
import { 
  initSqliteStorage, 
  registerPendingSync, 
  loadTablesFromPersistentStorage, 
  triggerImmediateFlush, 
  ALL_TABLE_NAMES 
} from './sqliteStorage';

// In-memory SQL Logs state (we will also notify listeners when it changes)
let sqlLogs: SqlLogEntry[] = [];
let logListeners: (() => void)[] = [];
let isDbInitializing = false;

export function subscribeToSqlLogs(listener: () => void) {
  logListeners.push(listener);
  return () => {
    logListeners = logListeners.filter(l => l !== listener);
  };
}

function notifySqlLogsUpdated() {
  logListeners.forEach(listener => listener());
}

// Generate a random ID for logs
function generateLogId(): string {
  return 'log_' + Math.random().toString(36).substr(2, 9);
}

// Custom SQL statement splitter that is single-quote, double-quote, and dollar-quote state aware
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inDollarQuote = false;
  
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const prev = i > 0 ? sql[i - 1] : '';
    const next = i < sql.length - 1 ? sql[i + 1] : '';
    
    // Handle inline comments
    if (char === '-' && next === '-' && !inSingleQuote && !inDoubleQuote && !inDollarQuote) {
      while (i < sql.length && sql[i] !== '\n') {
        i++;
      }
      continue;
    }
    
    // Handle block comments
    if (char === '/' && next === '*' && !inSingleQuote && !inDoubleQuote && !inDollarQuote) {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i+1] === '/')) {
        i++;
      }
      i++; // eat the slash
      continue;
    }
    
    // Single quote boundary
    if (char === "'" && !inDoubleQuote && !inDollarQuote) {
      inSingleQuote = !inSingleQuote;
    }
    
    // Double quote boundary
    if (char === '"' && !inSingleQuote && !inDollarQuote) {
      inDoubleQuote = !inDoubleQuote;
    }
    
    // Dollar quote $$ boundary (commonly used in postgres function declarations)
    if (char === '$' && next === '$' && !inSingleQuote && !inDoubleQuote) {
      inDollarQuote = !inDollarQuote;
      current += '$$';
      i++;
      continue;
    }
    
    // Semicolon separator
    if (char === ';' && !inSingleQuote && !inDoubleQuote && !inDollarQuote) {
      statements.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  if (current.trim()) {
    statements.push(current.trim());
  }
  
  return statements;
}

// Translate complex PostgreSQL words/blocks to standard AlaSQL compatibility
function translatePostgresToAlaSql(stmt: string): string {
  let cleaned = stmt.trim();
  const upper = cleaned.toUpperCase();
  
  // 1. Skip non-native PostgreSQL declarations
  if (upper.startsWith('CREATE EXTENSION')) {
    return '--- EXTENSION SIGNED ---';
  }
  if (upper.startsWith('CREATE TYPE')) {
    return '--- TYPE SIGNED ---';
  }
  if (upper.startsWith('CREATE OR REPLACE FUNCTION') || upper.startsWith('CREATE FUNCTION')) {
    return '--- FUNCTION DECLARATION IGNORED ---';
  }
  if (upper.startsWith('CREATE OR REPLACE TRIGGER') || upper.startsWith('CREATE TRIGGER')) {
    return '--- TRIGGER DECLARATION IGNORED ---';
  }
  if (cleaned === 'BEGIN;' || cleaned === 'BEGIN' || cleaned === 'COMMIT;' || cleaned === 'COMMIT' || cleaned === 'ROLLBACK;' || cleaned === 'ROLLBACK') {
    return '--- TX BOUNDARY ---';
  }
  if (upper.includes('verify_transaction_balance') && upper.includes('LANGUAGE PLPGSQL')) {
    return '--- PLPGSQL TRIGGER BODY IGNORED ---';
  }
  
  // 2. Syntactical translations
  // Strip unique primary key checks that can cause crash anomalies on missing ids
  cleaned = cleaned.replace(/PRIMARY\s+KEY/gi, '');
  
  // Replace DEFAULT uuid_generate_v4() with NULL so we can generate it in JS/alasql.fn
  cleaned = cleaned.replace(/DEFAULT\s+uuid_generate_v4\s*\(\s*\)/gi, 'DEFAULT NULL');
  
  // Remove reference constraints
  cleaned = cleaned.replace(/REFERENCES\s+\w+\s*\(\s*\w+\s*\)(?:\s+ON\s+DELETE\s+\w+)?/gi, '');
  
  // Remove PostgreSQL RETURNING clauses
  cleaned = cleaned.replace(/RETURNING\s+\w+/gi, '');
  
  // Clean up timestamp types
  cleaned = cleaned.replace(/TIMESTAMP\s+WITH\s+TIME\s+ZONE/gi, 'TIMESTAMP');
  cleaned = cleaned.replace(/TIMESTAMP\s+WITHOUT\s+TIME\s+ZONE/gi, 'TIMESTAMP');
  
  // Clean numeric sizing
  cleaned = cleaned.replace(/NUMERIC\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\)/gi, 'NUMERIC');
  cleaned = cleaned.replace(/DECIMAL\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\)/gi, 'NUMERIC');
  cleaned = cleaned.replace(/CHAR\s*\(\s*\d+\s*\)/gi, 'STRING');
  cleaned = cleaned.replace(/VARCHAR\s*\(\s*\d+\s*\)/gi, 'STRING');
  
  // Remove trailing commas left by stripped columns
  cleaned = cleaned.replace(/,\s*\)/g, ')');
  cleaned = cleaned.replace(/\(\s*,/g, '(');
  
  return cleaned.trim();
}

// Custom SQL Query Runner with logging and PostgreSQL emulation
export function runSql(sql: string, description: string = 'General Database Query', silent: boolean = false): { success: boolean; data: any; error?: string; affectedRows?: number } {
  // Setup custom functions inside AlaSQL context
  if (!alasql.fn.uuid_generate_v4) {
    alasql.fn.uuid_generate_v4 = () => {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    };
  }
  
  if (!alasql.fn.coalesce) {
    alasql.fn.coalesce = (...args: any[]) => {
      for (const arg of args) {
        if (arg !== null && arg !== undefined) return arg;
      }
      return null;
    };
  }

  const startTime = performance.now();
  const statements = splitSqlStatements(sql);
  
  let lastResult: any = null;
  let totalAffected = 0;
  
  try {
    for (const rawStmt of statements) {
      const stmt = translatePostgresToAlaSql(rawStmt);
      if (!stmt || stmt.startsWith('---')) {
        continue; // skip mock placeholders
      }
      
      const res = alasql(stmt);
      if (Array.isArray(res)) {
        lastResult = res;
        totalAffected += res.length;
      } else if (typeof res === 'number') {
        totalAffected += res;
      } else {
        lastResult = res;
      }
    }
    
    const endTime = performance.now();
    const executionTimeMs = parseFloat((endTime - startTime).toFixed(2));
    
    const newLog: SqlLogEntry = {
      id: generateLogId(),
      sql: sql.trim(),
      timestamp: new Date().toLocaleTimeString(),
      description,
      affectedRows: totalAffected,
      isError: false,
      executionTimeMs,
    };
    
    if (!silent) {
      sqlLogs = [newLog, ...sqlLogs].slice(0, 100);
      notifySqlLogsUpdated();
    }
    
    // Automatically persist tables on state modifications
    const upperSql = sql.toUpperCase();
    if (!isDbInitializing && (upperSql.includes('INSERT') || upperSql.includes('UPDATE') || upperSql.includes('DELETE') || upperSql.includes('CREATE') || upperSql.includes('DROP'))) {
      persistTablesToStorage();
    }
    
    return { success: true, data: lastResult, affectedRows: totalAffected };
    
  } catch (error: any) {
    const endTime = performance.now();
    const executionTimeMs = parseFloat((endTime - startTime).toFixed(2));
    const errorMessage = error?.message || String(error);
    
    const errorLog: SqlLogEntry = {
      id: generateLogId(),
      sql: sql.trim(),
      timestamp: new Date().toLocaleTimeString(),
      description,
      isError: true,
      errorMessage,
      executionTimeMs,
    };
    
    if (!silent) {
      sqlLogs = [errorLog, ...sqlLogs].slice(0, 100);
      notifySqlLogsUpdated();
    }
    
    return { success: false, data: null, error: errorMessage };
  }
}

export function getSqlLogs(): SqlLogEntry[] {
  return sqlLogs;
}

export function clearSqlLogs() {
  sqlLogs = [];
  notifySqlLogsUpdated();
}

export function triggerLoanSweep(orderId: string, orderTotal: number): { deducted: number; status: string; loanId?: string } {
  // 1. Fetch any active loans
  const loansRes = runSql("SELECT * FROM loans WHERE status = 'ACTIVE'", 'Sweep: Query active loan agreement');
  if (!loansRes.success || !Array.isArray(loansRes.data) || loansRes.data.length === 0) {
    return { deducted: 0, status: 'NO_ACTIVE_LOANS' };
  }

  const activeLoan = loansRes.data[0];
  
  // 2. Query sum of previous successful deductions
  const deductionsRes = runSql("SELECT SUM(amount_deducted) AS total_paid FROM automated_deduction_logs WHERE loan_id = '" + activeLoan.id + "' AND status = 'SUCCESS'", 'Sweep: Compute repaid capital');
  const totalPaid = (deductionsRes.success && deductionsRes.data[0] && deductionsRes.data[0].total_paid) 
    ? Number(deductionsRes.data[0].total_paid) 
    : 0;

  const remainingDebt = Number(activeLoan.total_repayable) - totalPaid;
  if (remainingDebt <= 0) {
    // Already fully paid, transition loan to PAID_OFF to prevent redundant sweeps
    runSql("UPDATE loans SET status = 'PAID_OFF', updated_at = '" + new Date().toISOString() + "' WHERE id = '" + activeLoan.id + "'", 'Sweep: Mark loan paid off');
    return { deducted: 0, status: 'LOAN_ALREADY_PAID_OFF' };
  }

  // 3. Compute the percentage slice (dynamic sweep)
  const theoreticalDeduct = orderTotal * (Number(activeLoan.daily_deduction_percentage) / 100);
  const actualDeduct = Math.min(theoreticalDeduct, remainingDebt);

  if (actualDeduct <= 0) {
    return { deducted: 0, status: 'ZERO_DEDUCTION_COMPUTED' };
  }

  // 4. Log the deduction
  const deductionId = 'DED-' + Math.floor(100000 + Math.random() * 900000);
  const insertLogSql = "INSERT INTO automated_deduction_logs VALUES ('" + deductionId + "', '" + activeLoan.id + "', '" + orderId + "', " + actualDeduct.toFixed(2) + ", 'SUCCESS', NULL, '" + new Date().toISOString() + "')";
  runSql(insertLogSql, "Sweep Trigger: Slice " + activeLoan.daily_deduction_percentage + "% from total " + orderTotal);

  // 5. Progressively update amortization schedule milestones
  const schedRes = runSql("SELECT * FROM loan_amortization_schedule WHERE loan_id = '" + activeLoan.id + "' AND is_settled = 0 ORDER BY installment_number ASC", 'Sweep: Grab active amortization milestones');
  if (schedRes.success && Array.isArray(schedRes.data) && schedRes.data.length > 0) {
    let unallocatedFunds = actualDeduct;
    for (let i = 0; i < schedRes.data.length; i++) {
      if (unallocatedFunds <= 0) break;
      const milestone = schedRes.data[i];
      const milestoneDue = Number(milestone.total_due);
      const milestonePaid = Number(milestone.amount_paid);
      const milestoneOutstanding = milestoneDue - milestonePaid;

      if (unallocatedFunds >= milestoneOutstanding) {
        // This milestone is now fully settled
        unallocatedFunds -= milestoneOutstanding;
        const settleSql = "UPDATE loan_amortization_schedule SET amount_paid = " + milestoneDue.toFixed(2) + ", is_settled = 1, settled_at = '" + new Date().toISOString() + "' WHERE id = '" + milestone.id + "'";
        runSql(settleSql, "Sweep Allocation: Fully settled milestone #" + milestone.installment_number);
      } else {
        // Partially paid milestone
        const newPaid = milestonePaid + unallocatedFunds;
        unallocatedFunds = 0;
        const partialSql = "UPDATE loan_amortization_schedule SET amount_paid = " + newPaid.toFixed(2) + " WHERE id = '" + milestone.id + "'";
        runSql(partialSql, "Sweep Allocation: Credited partial amount to milestone #" + milestone.installment_number);
      }
    }
  }

  // 6. Check if loan is now fully paid off
  if (totalPaid + actualDeduct >= Number(activeLoan.total_repayable)) {
    runSql("UPDATE loans SET status = 'PAID_OFF', updated_at = '" + new Date().toISOString() + "' WHERE id = '" + activeLoan.id + "'", 'Sweep: Complete auto repayment lifecycle');
  }

  persistTablesToStorage();
  return { deducted: actualDeduct, status: 'SUCCESS', loanId: activeLoan.id };
}

// Persistent configuration tables
const LOCAL_STORAGE_KEY_PREFIX = 'android_pos_db_';

export function persistTablesToStorage() {
  try {
    const allTablesData: Record<string, any[]> = {};
    if (alasql && alasql.tables) {
      for (const tableName of ALL_TABLE_NAMES) {
        if (alasql.tables[tableName]) {
          try {
            const rows = alasql(`SELECT * FROM ${tableName}`) as any[];
            if (Array.isArray(rows)) {
              allTablesData[tableName] = rows;
            }
            // Also store in localStorage with prefix for instant web fallback
            try {
              localStorage.setItem(`${LOCAL_STORAGE_KEY_PREFIX}${tableName}`, JSON.stringify(rows));
            } catch (lsErr) {
              // quota exceeded or restricted in WebView
            }
          } catch (tErr) {
            // ignore table query errors
          }
        }
      }
    }
    // Asynchronously flush to native SQLite database on Android filesystem & JSON snapshot
    registerPendingSync(allTablesData);
  } catch (e) {
    console.error('Failed to save state to storage:', e);
  }
}


// Seed Store Data Types
export type SeedTemplate = 'cafe' | 'boutique' | 'grocer' | 'ledger';

export function seedHistoricalOrders() {
  const todayStr = new Date().toISOString().split('T')[0];
  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const twoDaysAgoStr = new Date(Date.now() - 172800000).toISOString().split('T')[0];

  const historicalOrders = [
    { id: 'TXN-8801', custId: 101, date: `${todayStr}T09:42:00Z`, sub: 12.00, tax: 1.80, dis: 0.00, tot: 13.80, pay: 'Credit Card', items: [{ prodId: 1, qty: 1, price: 3.50 }, { prodId: 2, qty: 1, price: 4.50 }, { prodId: 5, qty: 1, price: 4.00 }] },
    { id: 'TXN-8802', custId: 103, date: `${todayStr}T11:15:00Z`, sub: 24.00, tax: 3.60, dis: 2.00, tot: 25.60, pay: 'Mobile Wallet', items: [{ prodId: 4, qty: 2, price: 12.00 }] },
    { id: 'TXN-8803', custId: null, date: `${todayStr}T12:02:00Z`, sub: 8.50, tax: 1.28, dis: 0.00, tot: 9.78, pay: 'Cash', items: [{ prodId: 2, qty: 1, price: 4.50 }, { prodId: 5, qty: 1, price: 4.00 }] },
    { id: 'TXN-8798', custId: 102, date: `${yesterdayStr}T10:10:00Z`, sub: 16.50, tax: 2.48, dis: 0.00, tot: 18.98, pay: 'Credit Card', items: [{ prodId: 4, qty: 1, price: 12.00 }, { prodId: 2, qty: 1, price: 4.50 }] },
    { id: 'TXN-8799', custId: null, date: `${yesterdayStr}T14:30:00Z`, sub: 28.50, tax: 4.28, dis: 3.00, tot: 29.78, pay: 'Mobile Wallet', items: [{ prodId: 3, qty: 2, price: 5.25 }, { prodId: 8, qty: 1, price: 10.50 }, { prodId: 6, qty: 1, price: 4.75 }] },
    { id: 'TXN-8800', custId: 103, date: `${yesterdayStr}T16:45:00Z`, sub: 14.00, tax: 2.10, dis: 1.00, tot: 15.10, pay: 'Cash', items: [{ prodId: 7, qty: 3, price: 3.00 }, { prodId: 5, qty: 1, price: 4.00 }] },
    { id: 'TXN-8795', custId: null, date: `${twoDaysAgoStr}T08:15:00Z`, sub: 7.00, tax: 1.05, dis: 0.00, tot: 8.05, pay: 'Cash', items: [{ prodId: 1, qty: 2, price: 3.50 }] },
    { id: 'TXN-8796', custId: 101, date: `${twoDaysAgoStr}T11:20:00Z`, sub: 19.50, tax: 2.93, dis: 1.50, tot: 20.93, pay: 'Credit Card', items: [{ prodId: 2, qty: 2, price: 4.50 }, { prodId: 8, qty: 1, price: 10.50 }] },
    { id: 'TXN-8797', custId: 104, date: `${twoDaysAgoStr}T15:10:00Z`, sub: 4.75, tax: 0.71, dis: 0.00, tot: 5.46, pay: 'Mobile Wallet', items: [{ prodId: 6, qty: 1, price: 4.75 }] },
  ];

  historicalOrders.forEach((o, idx) => {
    const custVal = o.custId === null ? 'NULL' : o.custId;
    const store_id = idx % 3 === 0 ? 'lusaka' : idx % 3 === 1 ? 'kitwe' : 'ndola';
    runSql(
      `INSERT INTO orders VALUES ('${o.id}', ${custVal}, '${o.date}', ${o.sub}, ${o.tax}, ${o.dis}, ${o.tot}, '${o.pay}', 'Completed', '${store_id}', 'owner')`,
      `Seed Data: Record historical invoice ${o.id} for branch ${store_id.toUpperCase()}`
    );

    o.items.forEach((item, itemIdx) => {
      const detailsId = `${o.id}_${itemIdx}`;
      runSql(
        `INSERT INTO order_items VALUES ('${detailsId}', '${o.id}', ${item.prodId}, ${item.qty}, ${item.price})`,
        `Seed Data: Allocate ${item.qty} units of Product #${item.prodId} to Order ${o.id}`
      );
    });

    const txId = 'ledger_' + o.id;
    const dateStr = o.date;
    const feeAmt = parseFloat((o.tot * 0.01).toFixed(4));
    const settleAmt = o.tot - feeAmt;
    let clearingAcc = 'cash-clearing-account-uuid';
    let channelName = 'CASH';

    if (o.pay === 'Mobile Wallet') {
      clearingAcc = Math.random() > 0.5 ? 'mtn-clearing-account-uuid' : 'airtel-clearing-account-uuid';
      channelName = clearingAcc === 'mtn-clearing-account-uuid' ? 'MTN_MOMO' : 'AIRTEL_MONEY';
    } else if (o.pay === 'Credit Card') {
      clearingAcc = 'airtel-clearing-account-uuid';
      channelName = 'CARD_VISA';
    }

    runSql(
      `INSERT INTO transactions VALUES ('${txId}', 'idemp-${txId}', 'POS-LUSAKA-MAIN', '${channelName}', 'PROVISION-REF', ${o.tot}, ${feeAmt}, 'SUCCESS', 'Simulated legacy historical POS order ${o.id}', '${dateStr}', '${dateStr}')`,
      `Seed Ledger: Record journal historical ledger txn for order ${o.id}`
    );
    runSql(
      `INSERT INTO ledger_entries VALUES ('le-${txId}-deb', '${txId}', '${clearingAcc}', 'DEBIT', ${o.tot})`,
      `Seed Ledger: Debit Clearing Account`
    );
    runSql(
      `INSERT INTO ledger_entries VALUES ('le-${txId}-cre-merch', '${txId}', 'merchant-wallet-account-uuid', 'CREDIT', ${settleAmt})`,
      `Seed Ledger: Credit Merchant Wallet Liability`
    );
    runSql(
      `INSERT INTO ledger_entries VALUES ('le-${txId}-cre-fees', '${txId}', 'platform-revenue-account-uuid', 'CREDIT', ${feeAmt})`,
      `Seed Ledger: Credit Processing Revenues Accounts`
    );
  });
  persistTablesToStorage();
}

export function rehydrateAlasqlFromRecords(tablesData: Record<string, any[]>) {
  if (!tablesData || typeof tablesData !== 'object') return;
  for (const [table, rows] of Object.entries(tablesData)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    try {
      if (!alasql.tables || !alasql.tables[table]) continue;
      alasql(`DELETE FROM ${table}`);
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const keys = Object.keys(row);
        if (keys.length === 0) continue;
        const placeholders = keys.map(() => '?').join(', ');
        const values = keys.map(k => row[k]);
        alasql(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`, values);
      }
    } catch (err) {
      console.warn(`Failed rehydrating table ${table}:`, err);
    }
  }
}

export function initializeDatabase(template: SeedTemplate = 'cafe', forceReset: boolean = false) {
  if (!forceReset && alasql.tables && alasql.tables.products) {
    try {
      const res = alasql('SELECT COUNT(*) AS cnt FROM products');
      if (res && res[0] && res[0].cnt > 0) {
        return;
      }
    } catch (e) {
      // Table doesn't exist yet, proceed
    }
  }
  if (isDbInitializing) return;
  isDbInitializing = true;
  try {
    // Clear any existing tables
    runSql('DROP TABLE IF EXISTS ledger_entries', 'Clean database: Drops old ledger entries');
    runSql('DROP TABLE IF EXISTS transactions', 'Clean database: Drops old transactions');
    runSql('DROP TABLE IF EXISTS accounts', 'Clean database: Drops old accounts');
    runSql('DROP TABLE IF EXISTS order_items', 'Clean database: Drops old order items');
    runSql('DROP TABLE IF EXISTS orders', 'Clean database: Drops old orders');
    runSql('DROP TABLE IF EXISTS products', 'Clean database: Drops old products');
    runSql('DROP TABLE IF EXISTS customers', 'Clean database: Drops old customers');
    runSql('DROP VIEW IF EXISTS view_account_balances', 'Clean database: Drops old view_account_balances');
    
    // Clear custom extra tables
    runSql('DROP TABLE IF EXISTS laybys', 'Clean database: Drops old laybys');
    runSql('DROP TABLE IF EXISTS layby_installments', 'Clean database: Drops old layby installments');
    runSql('DROP TABLE IF EXISTS time_attendance', 'Clean database: Drops old attendance logs');
    runSql('DROP TABLE IF EXISTS staff', 'Clean database: Drops old staff directory');
    runSql('DROP TABLE IF EXISTS store_products', 'Clean database: Drops old branch stock levels');
    runSql('DROP TABLE IF EXISTS stock_transfers', 'Clean database: Drops old stock transfer notes');
    runSql('DROP TABLE IF EXISTS cash_ups', 'Clean database: Drops old cashier records');
    runSql('DROP TABLE IF EXISTS quotations', 'Clean database: Drops old invoices/quotes');
    runSql('DROP TABLE IF EXISTS loans', 'Clean database: Drops old loans contract table');
    runSql('DROP TABLE IF EXISTS loan_amortization_schedule', 'Clean database: Drops old loan amortization schedules');
    runSql('DROP TABLE IF EXISTS automated_deduction_logs', 'Clean database: Drops old automated deduction logs');

    // Multi-tenant businesses & Dynamic store parameters
    runSql('DROP TABLE IF EXISTS businesses', 'Clean database: Drops old business accounts');
    runSql('DROP TABLE IF EXISTS stores', 'Clean database: Drops old stores');
    runSql('DROP TABLE IF EXISTS stock_takes', 'Clean database: Drops old stock takes');
    runSql('DROP TABLE IF EXISTS stock_take_items', 'Clean database: Drops old stock take items');
    runSql('DROP TABLE IF EXISTS expenses', 'Clean database: Drops old expenses');
    runSql('DROP TABLE IF EXISTS purchases_transit', 'Clean database: Drops old purchases transit');
    runSql('DROP TABLE IF EXISTS transit_purchases', 'Clean database: Drops old transit purchases');
    runSql('DROP TABLE IF EXISTS money_transfers', 'Clean database: Drops old money transfers');
    runSql('DROP TABLE IF EXISTS assets', 'Clean database: Drops old assets');
    runSql('DROP TABLE IF EXISTS equity', 'Clean database: Drops old equity');
    runSql('DROP TABLE IF EXISTS double_entry_journal', 'Clean database: Drops old double entry journal');
    runSql('DROP TABLE IF EXISTS audit_logs', 'Clean database: Drops old audit logs');

    // Create Business Identity container
    runSql(`
      CREATE TABLE businesses (
        id STRING PRIMARY KEY,
        name STRING,
        owner STRING,
        email STRING,
        password STRING,
        created_at STRING
      )
    `, 'Multi-Business Schema: Create BUSINESSES table');

    // Create Store dynamic configuration container
    runSql(`
      CREATE TABLE stores (
        id STRING PRIMARY KEY,
        business_id STRING,
        name STRING,
        location STRING,
        allow_discounts INT,
        allow_refunds INT,
        allow_laybys INT,
        require_manager_discount INT,
        stocktake_frequency STRING
      )
    `, 'Multi-Business Schema: Create STORES table');

    // Create Stock Take tracking sheet containers
    runSql(`
      CREATE TABLE stock_takes (
        id STRING PRIMARY KEY,
        store_id STRING,
        taken_at STRING,
        performed_by STRING,
        status STRING
      )
    `, 'Stocktake Schema: Create STOCK_TAKES table');

    runSql(`
      CREATE TABLE stock_take_items (
        id STRING PRIMARY KEY,
        stock_take_id STRING,
        product_id INT,
        recorded_stock INT,
        counted_stock INT,
        variance INT
      )
    `, 'Stocktake Schema: Create STOCK_TAKE_ITEMS mapping table');

    // Create core POS tables
    runSql(`
      CREATE TABLE products (
        id INT PRIMARY KEY,
        name STRING,
        sku STRING UNIQUE,
        category STRING,
        price NUMERIC,
        cost NUMERIC,
        stock INT,
        imageUrl STRING,
        business_id STRING,
        is_service INT DEFAULT 0,
        batch_number STRING,
        expiry_date STRING
      )
    `, 'Durable Schema: Create PRODUCTS table');

    runSql(`
      CREATE TABLE customers (
        id INT PRIMARY KEY,
        name STRING,
        phone STRING,
        email STRING,
        loyalPoints INT,
        tpin STRING,
        zra_connected INT,
        tax_band STRING,
        business_id STRING
      )
    `, 'Durable Schema: Create CUSTOMERS table');

    runSql(`
      CREATE TABLE orders (
        id STRING PRIMARY KEY,
        customerId INT,
        orderDate STRING,
        subtotal NUMERIC,
        tax NUMERIC,
        discount NUMERIC,
        total NUMERIC,
        paymentMethod STRING,
        status STRING,
        store_id STRING,
        performed_by STRING
      )
    `, 'Durable Schema: Create ORDERS table');

    runSql(`
      CREATE TABLE order_items (
        id STRING PRIMARY KEY,
        orderId STRING,
        productId INT,
        quantity INT,
        unitPrice NUMERIC
      )
    `, 'Durable Schema: Create ORDER_ITEMS mapping table');

    // Create double-entry ledger sandbox tables
    runSql(`
      CREATE TABLE accounts (
        id STRING PRIMARY KEY,
        name STRING,
        type STRING,
        currency STRING DEFAULT 'ZMW',
        merchant_id STRING,
        created_at STRING,
        updated_at STRING
      )
    `, 'Durable Schema: Create ACCOUNTS ledger table');

    runSql(`
      CREATE TABLE transactions (
        id STRING PRIMARY KEY,
        idempotency_key STRING UNIQUE,
        pos_terminal_id STRING,
        channel STRING,
        provider_reference STRING,
        amount NUMERIC,
        fee_amount NUMERIC,
        status STRING,
        narration STRING,
        created_at STRING,
        updated_at STRING,
        performed_by STRING
      )
    `, 'Durable Schema: Create TRANSACTIONS journal table');

    runSql(`
      CREATE TABLE ledger_entries (
        id STRING PRIMARY KEY,
        transaction_id STRING,
        account_id STRING,
        type STRING,
        amount NUMERIC,
        created_at STRING
      )
    `, 'Durable Schema: Create LEDGER_ENTRIES ledger mappings');

  // Create custom new SME tables
  runSql(`
    CREATE TABLE laybys (
      id STRING PRIMARY KEY,
      customer_id INT,
      customer_name STRING,
      customer_phone STRING,
      customer_email STRING,
      total_amount NUMERIC,
      deposit_amount NUMERIC,
      amount_paid NUMERIC,
      balance_due NUMERIC,
      status STRING,
      items_json STRING,
      created_at STRING,
      store_id STRING
    )
  `, 'Durable Schema: Create LAYBYS layaway tracking table');

  runSql(`
    CREATE TABLE layby_installments (
      id STRING PRIMARY KEY,
      layby_id STRING,
      amount NUMERIC,
      payment_method STRING,
      received_by STRING,
      created_at STRING
    )
  `, 'Durable Schema: Create LAYBY_INSTALLMENTS payments table');

  runSql(`
    CREATE TABLE time_attendance (
      id STRING PRIMARY KEY,
      employee_name STRING,
      employee_role STRING,
      date STRING,
      clock_in STRING,
      clock_out STRING,
      hours_worked NUMERIC,
      hourly_rate NUMERIC,
      gross_payment NUMERIC,
      status STRING
    )
  `, 'Durable Schema: Create TIME_ATTENDANCE payroll sync table');

  runSql(`
    CREATE TABLE staff (
      id STRING PRIMARY KEY,
      first_name STRING,
      surname STRING,
      contact STRING,
      email STRING,
      residential_address STRING,
      joining_date STRING,
      nrc_file STRING,
      nrc_filename STRING,
      contract_file STRING,
      contract_filename STRING,
      basic_salary NUMERIC,
      permissions_json STRING,
      business_id STRING,
      password STRING
    )
  `, 'Durable Schema: Create STAFF profiles table');

  runSql(`
    CREATE TABLE store_products (
      id STRING PRIMARY KEY,
      product_id INT,
      store_id STRING,
      stock INT,
      price NUMERIC
    )
  `, 'Durable Schema: Create STORE_PRODUCTS pricing table');

  runSql(`
    CREATE TABLE stock_transfers (
      id STRING PRIMARY KEY,
      product_id INT,
      from_store STRING,
      to_store STRING,
      quantity INT,
      status STRING,
      created_at STRING,
      rejection_reason STRING
    )
  `, 'Durable Schema: Create STOCK_TRANSFERS ledger notes');

  runSql(`
    CREATE TABLE cash_ups (
      id STRING PRIMARY KEY,
      date STRING,
      store_id STRING,
      cashier_name STRING,
      sum_cash_expected NUMERIC,
      sum_cash_actual NUMERIC,
      sum_card_expected NUMERIC,
      sum_card_actual NUMERIC,
      sum_momo_expected NUMERIC,
      sum_momo_actual NUMERIC,
      variance NUMERIC,
      notes STRING,
      created_at STRING
    )
  `, 'Durable Schema: Create CASH_UPS end-of-day control table');

  runSql(`
    CREATE TABLE quotations (
      id STRING PRIMARY KEY,
      customer_name STRING,
      customer_phone STRING,
      customer_email STRING,
      items_json STRING,
      subtotal NUMERIC,
      tax NUMERIC,
      discount NUMERIC,
      total NUMERIC,
      bank_name STRING,
      bank_account STRING,
      bank_branch STRING,
      status STRING,
      created_at STRING
    )
  `, 'Durable Schema: Create QUOTATIONS template table');

  runSql(`
    CREATE TABLE loans (
      id STRING PRIMARY KEY,
      merchant_id STRING,
      loan_account_id STRING,
      principal_amount NUMERIC,
      interest_amount NUMERIC,
      total_repayable NUMERIC,
      daily_deduction_percentage NUMERIC,
      status STRING,
      disbursed_at STRING,
      due_date STRING,
      created_at STRING,
      updated_at STRING
    )
  `, 'Durable Schema: Create LOANS financing agreement table');

  runSql(`
    CREATE TABLE loan_amortization_schedule (
      id STRING PRIMARY KEY,
      loan_id STRING,
      installment_number INT,
      principal_due NUMERIC,
      interest_due NUMERIC,
      total_due NUMERIC,
      amount_paid NUMERIC,
      is_settled INT,
      due_date STRING,
      settled_at STRING
    )
  `, 'Durable Schema: Create LOAN_AMORTIZATION_SCHEDULE repayment milestones table');

  runSql(`
    CREATE TABLE automated_deduction_logs (
      id STRING PRIMARY KEY,
      loan_id STRING,
      source_transaction_id STRING,
      amount_deducted NUMERIC,
      status STRING,
      failure_reason STRING,
      created_at STRING
    )
  `, 'Durable Schema: Create AUTOMATED_DEDUCTION_LOGS revenue sweep history table');

  runSql(`
    CREATE TABLE audit_logs (
      id STRING PRIMARY KEY,
      module STRING,
      action STRING,
      details STRING,
      amount NUMERIC,
      store_id STRING,
      performed_by STRING,
      created_at STRING
    )
  `, 'Durable Schema: Create AUDIT_LOGS employee audit trail table');

  runSql(`
    CREATE TABLE expenses (
      id STRING PRIMARY KEY,
      category STRING,
      payment_method STRING,
      account_id STRING,
      amount NUMERIC,
      description STRING,
      ref_number STRING,
      reference_no STRING,
      expense_date STRING,
      store_id STRING,
      performed_by STRING,
      created_by STRING,
      created_at STRING
    )
  `, 'Durable Schema: Create EXPENSES ledger table');

  runSql(`
    CREATE TABLE purchases_transit (
      id STRING PRIMARY KEY,
      supplier_name STRING,
      store_id STRING,
      payment_account_id STRING,
      payment_method STRING,
      items_json STRING,
      additional_expenses_json STRING,
      total_base_amount NUMERIC,
      total_additional_expenses NUMERIC,
      total_landed_cost NUMERIC,
      stage STRING,
      notes STRING,
      created_at STRING,
      updated_at STRING,
      received_at STRING,
      received_by STRING
    )
  `, 'Durable Schema: Create PURCHASES_TRANSIT goods-in-transit procurement table');

  runSql(`
    CREATE TABLE transit_purchases (
      id STRING PRIMARY KEY,
      supplier_name STRING,
      store_id STRING,
      payment_account STRING,
      payment_method STRING,
      base_total NUMERIC,
      additional_expenses_total NUMERIC,
      grand_landed_total NUMERIC,
      status STRING,
      items_json STRING,
      additional_expenses_json STRING,
      notes STRING,
      created_at STRING,
      updated_at STRING,
      received_at STRING,
      received_by STRING
    )
  `, 'Durable Schema: Create TRANSIT_PURCHASES procurement table');

  runSql(`
    CREATE TABLE money_transfers (
      id STRING PRIMARY KEY,
      source_account STRING,
      dest_account STRING,
      amount NUMERIC,
      reference_no STRING,
      transfer_date STRING,
      performed_by STRING,
      notes STRING
    )
  `, 'Durable Schema: Create MONEY_TRANSFERS liquidity balancing table');

  runSql(`
    CREATE TABLE assets (
      id STRING PRIMARY KEY,
      name STRING,
      category STRING,
      type STRING,
      purchase_date STRING,
      value NUMERIC,
      depreciation_method STRING,
      depreciation_rate NUMERIC,
      status STRING,
      notes STRING,
      linked_equity_id STRING
    )
  `, 'Durable Schema: Create ASSETS balance sheet table');

  runSql(`
    CREATE TABLE equity (
      id STRING PRIMARY KEY,
      name STRING,
      value NUMERIC,
      linked_asset_id STRING
    )
  `, 'Durable Schema: Create EQUITY capital accounts table');

  runSql(`
    CREATE TABLE double_entry_journal (
      id STRING PRIMARY KEY,
      date STRING,
      reference STRING,
      description STRING,
      account_debit STRING,
      account_credit STRING,
      amount NUMERIC,
      currency STRING
    )
  `, 'Durable Schema: Create DOUBLE_ENTRY_JOURNAL accounting records');

  // Create account balance formula view
  runSql(`
    CREATE VIEW view_account_balances AS
    SELECT 
        a.id AS account_id,
        a.name AS account_name,
        a.currency,
        SUM(
            CASE 
                WHEN (a.type = 'ASSET' OR a.type = 'EXPENSE') AND le.type = 'DEBIT' THEN le.amount
                WHEN (a.type = 'ASSET' OR a.type = 'EXPENSE') AND le.type = 'CREDIT' THEN -le.amount
                WHEN (a.type = 'LIABILITY' OR a.type = 'REVENUE' OR a.type = 'EQUITY') AND le.type = 'CREDIT' THEN le.amount
                WHEN (a.type = 'LIABILITY' OR a.type = 'REVENUE' OR a.type = 'EQUITY') AND le.type = 'DEBIT' THEN -le.amount
                ELSE 0
            END
        ) AS current_balance
    FROM accounts a
    LEFT JOIN ledger_entries le ON a.id = le.account_id
    GROUP BY a.id, a.name, a.currency
  `, 'Durable Schema: Complete VIEW_ACCOUNT_BALANCES view aggregation');

  // Check if we can recover data from localStorage synchronously, unless a forceReset is requested
  let hasRecoveredData = false;
  if (!forceReset) {
    try {
      const recovered: Record<string, any[]> = {};
      for (const table of ALL_TABLE_NAMES) {
        const raw = localStorage.getItem(`${LOCAL_STORAGE_KEY_PREFIX}${table}`);
        if (raw) {
          try {
            const rows = JSON.parse(raw);
            if (Array.isArray(rows) && rows.length > 0) {
              recovered[table] = rows;
            }
          } catch (e) {
            // ignore
          }
        }
      }
      if (recovered['products'] && recovered['products'].length > 0) {
        rehydrateAlasqlFromRecords(recovered);
        hasRecoveredData = true;
        runSql('SELECT COUNT(*) AS prod_count FROM products', 'Persistent DB Recovery: Recovered data from LocalStorage');
      }
    } catch (err) {
      console.warn('LocalStorage recovery notice:', err);
    }
  }

  // Trigger background SQLite and persistent Android filesystem initialization
  initSqliteStorage().then(async (ready) => {
    if (ready && !forceReset) {
      try {
        const persistentData = await loadTablesFromPersistentStorage();
        if (persistentData && persistentData['products'] && persistentData['products'].length > 0) {
          console.log('[DB] Recovered tables from persistent SQLite / Filesystem storage layer');
          rehydrateAlasqlFromRecords(persistentData);
          notifySqlLogsUpdated();
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('database-rehydrated'));
          }
        }
      } catch (sqErr) {
        console.warn('[DB] Persistent storage background rehydrate error:', sqErr);
      }
    }
  }).catch((err) => {
    console.warn('[DB] initSqliteStorage error:', err);
  });

  if (!hasRecoveredData) {
    // Fresh install or reset requested: Seed template-based data
    seedTemplateData(template);
  }
  } finally {
    isDbInitializing = false;
    persistTablesToStorage();
  }
}

function seedTemplateData(template: SeedTemplate) {
  let productsToInsert: Product[] = [];
  let customersToInsert: Customer[] = [];

  // Seed standard POS structures
  if (template === 'cafe' || template === 'ledger') {
    productsToInsert = [
      { id: 1, name: 'Double Espresso Shot', sku: 'COF-001', category: 'Beverages', price: 3.50, cost: 0.50, stock: 15, imageUrl: 'https://images.unsplash.com/photo-1510705315444-837e66e4cbc0?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 2, name: 'Classic Cappuccino', sku: 'COF-002', category: 'Beverages', price: 4.50, cost: 0.80, stock: 120, imageUrl: 'https://images.unsplash.com/photo-1572442388796-11668a67e53a?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 3, name: 'Iced Matcha Latte', sku: 'COF-003', category: 'Beverages', price: 5.25, cost: 1.10, stock: 85, imageUrl: 'https://images.unsplash.com/photo-1536256263959-770b48d82b0a?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 4, name: 'Avocado Sourdough Toast', sku: 'FOD-101', category: 'Food', price: 12.00, cost: 3.20, stock: 40, imageUrl: 'https://images.unsplash.com/photo-1541532713592-79a0317b6b77?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 5, name: 'Fudge Choco Brownie', sku: 'FOD-102', category: 'Desserts', price: 4.00, cost: 1.00, stock: 4, imageUrl: 'https://images.unsplash.com/photo-1564355808539-22fda35bed7e?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 6, name: 'Almond Butter Croissant', sku: 'FOD-103', category: 'Desserts', price: 4.75, cost: 1.25, stock: 22, imageUrl: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 7, name: 'Organic Breakfast Tea', sku: 'COF-004', category: 'Beverages', price: 3.00, cost: 0.40, stock: 95, imageUrl: 'https://images.unsplash.com/photo-1597481499750-3e6b22637e12?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 8, name: 'Gourmet Club Sandwich', sku: 'FOD-104', category: 'Food', price: 10.50, cost: 2.90, stock: 18, imageUrl: 'https://images.unsplash.com/photo-1567234669003-dce7a7a88821?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
    ];
  } else if (template === 'boutique') {
    productsToInsert = [
      { id: 1, name: 'Heavyweight Cotton Hoodie', sku: 'APP-01', category: 'Apparel', price: 65.00, cost: 18.00, stock: 25, imageUrl: 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 2, name: 'Premium Denim Jacket', sku: 'APP-02', category: 'Apparel', price: 85.00, cost: 25.00, stock: 15, imageUrl: 'https://images.unsplash.com/photo-1576995853123-5a10305d93c0?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 3, name: 'Linen Summer Shirt', sku: 'APP-03', category: 'Apparel', price: 45.00, cost: 12.00, stock: 30, imageUrl: 'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 4, name: 'Minimalist Leather Tassel Tote', sku: 'ACC-01', category: 'Accessories', price: 120.00, cost: 42.00, stock: 8, imageUrl: 'https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 5, name: 'Polarized Aviator Shades', sku: 'ACC-02', category: 'Accessories', price: 38.00, cost: 10.00, stock: 50, imageUrl: 'https://images.unsplash.com/photo-1511499767150-a48a237f0083?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 6, name: 'Suede Chelsea Boots', sku: 'SHO-01', category: 'Footwear', price: 145.00, cost: 52.00, stock: 12, imageUrl: 'https://images.unsplash.com/photo-1638247025967-b4e38f787b76?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
    ];
  } else { // grocer
    productsToInsert = [
      { id: 1, name: 'Organic Haas Avocados', sku: 'GRO-01', category: 'Produce', price: 4.99, cost: 1.50, stock: 60, imageUrl: 'https://images.unsplash.com/photo-1523049673857-eb18f1d7b578?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 2, name: 'Fresh Strawberries (1lb)', sku: 'GRO-02', category: 'Produce', price: 3.49, cost: 1.00, stock: 45, imageUrl: 'https://images.unsplash.com/photo-1464965911861-746a04b4bca6?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 3, name: 'A2 Grass-Fed Whole Milk', sku: 'GRO-03', category: 'Dairy', price: 5.99, cost: 2.20, stock: 18, imageUrl: 'https://images.unsplash.com/photo-1563636619-e9143da7973b?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 4, name: 'Gluten-Free Seed Bread', sku: 'GRO-04', category: 'Bakery', price: 6.50, cost: 2.10, stock: 3, imageUrl: 'https://images.unsplash.com/photo-1549931319-a545dcf3bc73?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 5, name: 'Extra Virgin Olive Oil (1L)', sku: 'GRO-05', category: 'Pantry', price: 16.99, cost: 7.50, stock: 24, imageUrl: 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
      { id: 6, name: 'Artisan Sea Salt Crackers', sku: 'GRO-06', category: 'Snacks', price: 4.25, cost: 1.30, stock: 32, imageUrl: 'https://images.unsplash.com/photo-1590080875515-8a3a8dc5735e?w=150&auto=format&fit=crop&q=60&referrerPolicy=no-referrer' },
    ];
  }

  customersToInsert = [
    { id: 101, name: 'Jane Carter', phone: '+260 971 123456', email: 'jane.carter@outlook.com', loyalPoints: 120, tpin: '1004567891', zra_connected: 1, tax_band: 'A - Standard Rate (16%)' },
    { id: 102, name: 'David Chen', phone: '+260 962 187733', email: 'daven.chen@gmail.com', loyalPoints: 45, tpin: '', zra_connected: 0, tax_band: 'B - Zero-Rated (0%)' },
    { id: 103, name: 'Maya Sterling', phone: '+260 955 999222', email: 'maya.sterling@hey.com', loyalPoints: 340, tpin: '1009876543', zra_connected: 1, tax_band: 'A - Standard Rate (16%)' },
    { id: 104, name: 'Marcus Brody', phone: '+260 978 155115', email: 'mbrody@academic.edu', loyalPoints: 15, tpin: '', zra_connected: 0, tax_band: 'C - Exempt (0%)' },
  ];

  // Seed default multi-tenant business and outlet branches
  runSql(`
    INSERT INTO businesses VALUES (
      'default_biz',
      'Zambia Retail POS',
      'Chiposha Conwell',
      'owner@pos.zm',
      'admin123',
      '2026-06-07T14:00:00Z'
    )
  `, 'Seed Data: Insert default business profile');

  runSql(`
    INSERT INTO stores VALUES ('lusaka', 'default_biz', 'Lusaka Main Office', 'Lusaka', 1, 1, 1, 0, 'weekly')
  `, 'Seed Data: Insert store Lusaka');
  runSql(`
    INSERT INTO stores VALUES ('kitwe', 'default_biz', 'Kitwe Regional Yard', 'Kitwe', 1, 1, 1, 0, 'monthly')
  `, 'Seed Data: Insert store Kitwe');
  runSql(`
    INSERT INTO stores VALUES ('ndola', 'default_biz', 'Ndola Branch Station', 'Ndola', 0, 0, 1, 1, 'quarterly')
  `, 'Seed Data: Insert store Ndola');

  customersToInsert.forEach(c => {
    runSql(
      `INSERT INTO customers VALUES (${c.id}, '${c.name.replace(/'/g, "''")}', '${c.phone}', '${c.email}', ${c.loyalPoints}, '${c.tpin}', ${c.zra_connected}, '${c.tax_band}', 'default_biz')`,
      `Seed Data: Insert customer ${c.name} with compliant ZRA TPIN`
    );
  });

  productsToInsert.forEach(p => {
    runSql(
      `INSERT INTO products (id, name, sku, category, price, cost, stock, imageUrl, business_id, is_service, batch_number, expiry_date) VALUES (${p.id}, '${p.name.replace(/'/g, "''")}', '${p.sku}', '${p.category}', ${p.price}, ${p.cost}, ${p.stock}, '${p.imageUrl}', 'default_biz', ${p.is_service || 0}, '${p.batch_number || ''}', '${p.expiry_date || ''}')`,
      `Seed Data: Insert product ${p.name}`
    );
  });

  // Seed double entry accounts in both ledger sandbox mode and as empty shells in standard shop layouts
  const accountsToSeed = [
    { id: 'acc_cash', name: 'Cash Account (Counter Drawer)', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_momo', name: 'Mobile Wallet Account (MTN/Airtel/Zamtel)', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_bank', name: 'Commercial Bank Account', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_transit', name: 'Goods in Transit Asset', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_inventory', name: 'Store Merchandise Inventory', type: 'ASSET', cur: 'ZMW' },
    
    { id: 'acc_sales_revenue', name: 'Gross Sales Revenue', type: 'REVENUE', cur: 'ZMW' },
    { id: 'acc_retained_earnings', name: 'Owner Equity & Retained Earnings', type: 'EQUITY', cur: 'ZMW' },
    { id: 'acc_cost_of_goods', name: 'Cost of Goods Sold (COGS)', type: 'EXPENSE', cur: 'ZMW' },

    { id: 'acc_exp_rent', name: 'Rent & Premises Expense', type: 'EXPENSE', cur: 'ZMW' },
    { id: 'acc_exp_utilities', name: 'Utilities Expense (Power/Water/Internet)', type: 'EXPENSE', cur: 'ZMW' },
    { id: 'acc_exp_wages', name: 'Wages & Payroll Expense', type: 'EXPENSE', cur: 'ZMW' },
    { id: 'acc_exp_transport', name: 'Freight, Transport & Shipping Expense', type: 'EXPENSE', cur: 'ZMW' },
    { id: 'acc_exp_handling', name: 'Port, Handling & Customs Expense', type: 'EXPENSE', cur: 'ZMW' },
    { id: 'acc_exp_marketing', name: 'Marketing & Promotion Expense', type: 'EXPENSE', cur: 'ZMW' },
    { id: 'acc_exp_supplies', name: 'Office & Operational Supplies Expense', type: 'EXPENSE', cur: 'ZMW' },
    { id: 'acc_exp_maintenance', name: 'Repairs & Maintenance Expense', type: 'EXPENSE', cur: 'ZMW' },
    { id: 'acc_exp_taxes_licensing', name: 'Licenses, Taxes & Permits Expense', type: 'EXPENSE', cur: 'ZMW' },
    { id: 'acc_exp_misc', name: 'Miscellaneous Expenses', type: 'EXPENSE', cur: 'ZMW' },

    // Legacy compatibility aliases
    { id: 'mtn-clearing-account-uuid', name: 'MTN Mobile Money Clearing', type: 'ASSET', cur: 'ZMW' },
    { id: 'airtel-clearing-account-uuid', name: 'Airtel Money Clearing Asset', type: 'ASSET', cur: 'ZMW' },
    { id: 'merchant-wallet-account-uuid', name: 'Cozy Beans Settlement Wallet', type: 'LIABILITY', cur: 'ZMW' },
    { id: 'platform-revenue-account-uuid', name: 'Zambian MoMo Processor Fees', type: 'REVENUE', cur: 'ZMW' },
    { id: 'cash-clearing-account-uuid', name: 'Counter Cash Tender Registry', type: 'ASSET', cur: 'ZMW' }
  ];

  accountsToSeed.forEach(acc => {
    runSql(
      `INSERT INTO accounts VALUES ('${acc.id}', '${acc.name}', '${acc.type}', '${acc.cur}', 'merchant-merchant-id', '2026-06-07T12:00:00Z', '2026-06-07T12:00:00Z')`,
      `Seed Double Entry: Register Ledger Account [${acc.name}]`
    );
  });

  // Seed sample initial transactions if in full ledger database template mode
  if (template === 'ledger') {
    // Inject initial transaction balancing ledger
    runSql(
      `INSERT INTO transactions VALUES ('tx-999', 'unique-uuid-from-pos-12345', 'POS-LUSAKA-01', 'MTN_MOMO', 'MTN-REF-88771', 1000.0000, 10.0000, 'SUCCESS', 'Payment via MTN MoMo at Counter 1', '2026-06-07T11:30:00Z', '2026-06-07T11:30:00Z', 'owner')`,
      `Seed Double Entry: Initial MTN MoMo Transaction`
    );
    runSql(
      `INSERT INTO ledger_entries VALUES ('le-1', 'tx-999', 'mtn-clearing-account-uuid', 'DEBIT', 1000.0000)`,
      `Seed Ledger: Debit MTN Cash Asset Account`
    );
    runSql(
      `INSERT INTO ledger_entries VALUES ('le-2', 'tx-999', 'merchant-wallet-account-uuid', 'CREDIT', 990.0000)`,
      `Seed Ledger: Credit Merchant Settled Wallets`
    );
    runSql(
      `INSERT INTO ledger_entries VALUES ('le-3', 'tx-999', 'platform-revenue-account-uuid', 'CREDIT', 10.0000)`,
      `Seed Ledger: Credit Platform Fees Revenues`
    );

    // Another sample entry for Airtel Kwacha MoMo check
    runSql(
      `INSERT INTO transactions VALUES ('tx-1000', 'unique-uuid-from-pos-zambia-airtel', 'POS-LUSAKA-02', 'AIRTEL_MONEY', 'AIRTEL-REF-33422', 450.0000, 4.5000, 'SUCCESS', 'Airtel MoMo checkout ticket', '2026-06-07T12:15:00Z', '2026-06-07T12:15:00Z', 'owner')`,
      `Seed Double Entry: Airtel MoMo transaction`
    );
    runSql(
      `INSERT INTO ledger_entries VALUES ('le-4', 'tx-1000', 'airtel-clearing-account-uuid', 'DEBIT', 450.00) `,
      `Seed Ledger: Debit Airtel Money`
    );
    runSql(
      `INSERT INTO ledger_entries VALUES ('le-5', 'tx-1000', 'merchant-wallet-account-uuid', 'CREDIT', 445.50) `,
      `Seed Ledger: Credit Merchant Wallet`
    );
    runSql(
      `INSERT INTO ledger_entries VALUES ('le-6', 'tx-1000', 'platform-revenue-account-uuid', 'CREDIT', 4.50) `,
      `Seed Ledger: Credit Processing Fee Account`
    );
  }

  // Seed general POS invoice orders
  seedHistoricalOrders();

  // ==========================================
  // SEED EXTRA SME RETAIL TABLES
  // ==========================================
  
  // Seed store_products for multiple branches: 'lusaka', 'kitwe', 'ndola'
  const branches = ['lusaka', 'kitwe', 'ndola'];
  productsToInsert.forEach((p) => {
    branches.forEach((bCode) => {
      const multiplierPrice = bCode === 'lusaka' ? 1.0 : bCode === 'kitwe' ? 0.95 : 1.08;
      const baseStock = bCode === 'lusaka' ? 80 : bCode === 'kitwe' ? 45 : 30;
      const targetPrice = parseFloat((p.price * multiplierPrice).toFixed(2));
      const targetStock = Math.round(baseStock + (p.id * 5));
      runSql(
        `INSERT INTO store_products VALUES ('sp_${p.id}_${bCode}', ${p.id}, '${bCode}', ${targetStock}, ${targetPrice})`,
        `Seed Stock: Product #${p.id} stock/price in branch ${bCode}`
      );
    });
  });

  // Seed default layby contract and initial payments
  runSql(`
    INSERT INTO laybys VALUES (
      'layby-1004',
      101,
      'Jane Carter',
      '+1 (555) 012-4466',
      'jane.carter@outlook.com',
      300.00,
      100.00,
      150.00,
      150.00,
      'PENDING',
      '[{"id":6,"name":"Almond Butter Croissant","quantity":10,"unitPrice":4.75},{"id":8,"name":"Gourmet Club Sandwich","quantity":24,"unitPrice":10.50}]',
      '2026-06-05T09:00:00Z',
      'lusaka'
    )
  `, 'Seed Laybys: Jane Carter item contract');

  runSql(`
    INSERT INTO layby_installments VALUES (
      'inst-001',
      'layby-1004',
      100.00,
      'Cash',
      'Alice Mwansa',
      '2026-06-05T09:05:00Z'
    )
  `, 'Seed Installments: Record first downpayment');

  runSql(`
    INSERT INTO layby_installments VALUES (
      'inst-002',
      'layby-1004',
      50.00,
      'Airtel Money',
      'Alice Mwansa',
      '2026-06-06T14:30:00Z'
    )
  `, 'Seed Installments: Record installment payment #2');

  // Seed sample ready quotations
  runSql(`
    INSERT INTO quotations VALUES (
      'QT-1025',
      'Daka Construction Ltd',
      '+260 977 123456',
      'info@dakaconstruct.zm',
      '[{"name":"Double Espresso Shot","quantity":100,"unitPrice":3.50},{"name":"Classic Cappuccino","quantity":150,"unitPrice":4.50},{"name":"Gourmet Club Sandwich","quantity":50,"unitPrice":10.50}]',
      1550.00,
      232.50,
      82.50,
      1700.00,
      'Zambia National Commercial Bank (Zanaco)',
      '1020088991102',
      'Lusaka Commercial Branch',
      'QUOTATION',
      '2026-06-07T08:50:00Z'
    )
  `, 'Seed Quotes: Daka corporate coffee catering');

  // Seed Loans, schedules and simulated background logs
  runSql(`
    INSERT INTO loans VALUES (
      'LOAN-001',
      'default_biz',
      'acc_operating',
      10000.00,
      1200.00,
      11200.00,
      10.00,
      'ACTIVE',
      '2026-06-01T10:00:00Z',
      '2026-09-01T10:00:00Z',
      '2026-06-01T10:00:00Z',
      '2026-06-01T10:00:00Z'
    )
  `, 'Seed: Active loan for SME financing');

  runSql(`
    INSERT INTO loans VALUES (
      'LOAN-002',
      'default_biz',
      'acc_operating',
      25000.00,
      3000.00,
      28000.00,
      15.00,
      'PENDING_REVIEW',
      NULL,
      '2026-12-07T12:00:00Z',
      '2026-06-07T14:00:00Z',
      '2026-06-07T14:00:00Z'
    )
  `, 'Seed: Pending loan extension file');

  runSql(`
    INSERT INTO loan_amortization_schedule VALUES (
      'AMORT-1-1',
      'LOAN-001',
      1,
      3333.33,
      400.00,
      3733.33,
      3733.33,
      1,
      '2026-07-01T10:00:00Z',
      '2026-06-05T15:30:00Z'
    )
  `, 'Seed Milestone 1: Settled');

  runSql(`
    INSERT INTO loan_amortization_schedule VALUES (
      'AMORT-1-2',
      'LOAN-001',
      2,
      3333.33,
      400.00,
      3733.33,
      1200.00,
      0,
      '2026-08-01T10:00:00Z',
      NULL
    )
  `, 'Seed Milestone 2: Partially Paid');

  runSql(`
    INSERT INTO loan_amortization_schedule VALUES (
      'AMORT-1-3',
      'LOAN-001',
      3,
      3333.34,
      400.00,
      3733.34,
      0.00,
      0,
      '2026-09-01T10:00:00Z',
      NULL
    )
  `, 'Seed Milestone 3: Unpaid');

  runSql(`
    INSERT INTO automated_deduction_logs VALUES (
      'DED-001',
      'LOAN-001',
      'TXN-QS-774122',
      150.00,
      'SUCCESS',
      NULL,
      '2026-06-02T16:45:00Z'
    )
  `, 'Seed Sweep: Recorded $150 repayment slice');

  runSql(`
    INSERT INTO automated_deduction_logs VALUES (
      'DED-002',
      'LOAN-001',
      'TXN-QS-903120',
      210.00,
      'SUCCESS',
      NULL,
      '2026-06-04T11:15:00Z'
    )
  `, 'Seed Sweep: Recorded $210 split deduction on order checkout');

  // Seed staff members so user accounts and staff management are ready out of the box
  runSql(`
    INSERT INTO staff VALUES (
      'staff-101',
      'Alice',
      'Mwansa',
      '+260 971 123456',
      'alice@pos.zm',
      'Plot 41 Rhodes Park, Lusaka',
      '2026-01-15',
      '', '', '', '',
      6500.00,
      '{"sales":{"create_sale":true,"apply_discounts":true,"issue_refunds":true,"void_transactions":false},"inventory":{"view_stock":true,"edit_stock":false,"adjust_pricing":false},"customer":{"create_customer":true,"edit_customer":true},"reports":{"view_daily_sales":true,"export_reports":false},"expense":{"record_expense":false},"settings":{"configure_system":false},"staff":{"attendance_management":true,"payroll_management":false,"manage_staff":false},"receipt":{"reprint_receipt":true}}',
      'default_biz',
      '1234'
    )
  `, 'Seed Staff: Alice Mwansa Cashier Profile');

  runSql(`
    INSERT INTO staff VALUES (
      'staff-102',
      'Brian',
      'Banda',
      '+260 962 654321',
      'brian@pos.zm',
      'Woodlands, Lusaka',
      '2026-02-01',
      '', '', '', '',
      8500.00,
      '{"sales":{"create_sale":true,"apply_discounts":true,"issue_refunds":true,"void_transactions":true},"inventory":{"view_stock":true,"edit_stock":true,"adjust_pricing":true},"customer":{"create_customer":true,"edit_customer":true},"reports":{"view_daily_sales":true,"export_reports":true},"expense":{"record_expense":true},"settings":{"configure_system":true},"staff":{"attendance_management":true,"payroll_management":true,"manage_staff":true},"receipt":{"reprint_receipt":true}}',
      'default_biz',
      'admin123'
    )
  `, 'Seed Staff: Brian Banda Store Manager Profile');
}

// ==========================================
// CENTRALIZED CUSTOMER CRM SYNCHRONIZATION
// ==========================================
export interface CustomerSyncData {
  name: string;
  phone?: string;
  email?: string;
  tpin?: string;
  loyalPointsDelta?: number;
  zra_connected?: number;
  tax_band?: string;
}

export function upsertCustomerSync(data: CustomerSyncData): any {
  if (!data || !data.name || !data.name.trim()) return null;
  const cleanName = data.name.trim();
  const cleanPhone = (data.phone || '').trim();
  const cleanEmail = (data.email || '').trim();
  const cleanTpin = (data.tpin || '').trim();
  
  // Search for existing customer by phone (if provided and non-empty) or by name
  let existing: any = null;
  const allCustsRes = runSql('SELECT * FROM customers', 'CRM Sync: Fetch customers for lookup');
  if (allCustsRes.success && Array.isArray(allCustsRes.data)) {
    if (cleanPhone && cleanPhone !== 'N/A' && cleanPhone.length >= 6) {
      const normalizedInputPhone = cleanPhone.replace(/[\s\-\+\(\)]/g, '');
      existing = allCustsRes.data.find((c: any) => c.phone && c.phone.replace(/[\s\-\+\(\)]/g, '') === normalizedInputPhone);
    }
    if (!existing) {
      existing = allCustsRes.data.find((c: any) => c.name && c.name.toLowerCase() === cleanName.toLowerCase());
    }
  }

  if (existing) {
    const custId = existing.id;
    const newPhone = cleanPhone && cleanPhone !== 'N/A' ? cleanPhone : (existing.phone || '');
    const newEmail = cleanEmail && cleanEmail !== 'N/A' ? cleanEmail : (existing.email || '');
    const newTpin = cleanTpin ? cleanTpin : (existing.tpin || '');
    const pointsToAdd = data.loyalPointsDelta || 0;
    const newPoints = (existing.loyalPoints || 0) + pointsToAdd;

    const updateSql = `
      UPDATE customers 
      SET name = '${cleanName.replace(/'/g, "''")}',
          phone = '${newPhone.replace(/'/g, "''")}',
          email = '${newEmail.replace(/'/g, "''")}',
          tpin = '${newTpin.replace(/'/g, "''")}',
          loyalPoints = ${newPoints}
      WHERE id = ${custId}
    `;
    runSql(updateSql, `CRM Sync: Update customer #${custId} [${cleanName}]`);
    persistTablesToStorage();
    return { ...existing, id: custId, name: cleanName, phone: newPhone, email: newEmail, tpin: newTpin, loyalPoints: newPoints };
  } else {
    // Insert new customer
    const newCustId = 500 + Math.floor(Math.random() * 950000);
    const initialPoints = 5 + (data.loyalPointsDelta || 0);
    const insertSql = `
      INSERT INTO customers (id, name, phone, email, loyalPoints, tpin, zra_connected, tax_band, business_id)
      VALUES (
        ${newCustId},
        '${cleanName.replace(/'/g, "''")}',
        '${(cleanPhone || 'N/A').replace(/'/g, "''")}',
        '${(cleanEmail || 'N/A').replace(/'/g, "''")}',
        ${initialPoints},
        '${cleanTpin.replace(/'/g, "''")}',
        ${data.zra_connected || 0},
        '${(data.tax_band || 'A - Standard Rate (16%)').replace(/'/g, "''")}',
        'default_biz'
      )
    `;
    runSql(insertSql, `CRM Sync: Register dynamic customer [${cleanName}]`);
    persistTablesToStorage();
    return {
      id: newCustId,
      name: cleanName,
      phone: cleanPhone || 'N/A',
      email: cleanEmail || 'N/A',
      loyalPoints: initialPoints,
      tpin: cleanTpin,
      zra_connected: data.zra_connected || 0,
      tax_band: data.tax_band || 'A - Standard Rate (16%)',
      business_id: 'default_biz'
    };
  }
}

// ==========================================
// CENTRALIZED EMPLOYEE AUDIT TRAIL LOGGING
// ==========================================
export function logEmployeeAudit(
  module: 'SALES' | 'LAYBY' | 'PURCHASE' | 'EXPENSES' | 'STOCK' | 'FINANCE' | 'TRANSFER' | 'LOAN' | 'PROCUREMENT' | 'EXPENSE',
  action: string,
  details: string,
  amount: number = 0,
  storeId?: string,
  performedBy?: string
) {
  try {
    const id = `AUDIT_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const nowStr = new Date().toISOString();
    const user = performedBy || localStorage.getItem('logged_in_user_name') || localStorage.getItem('logged_in_user_email') || 'Staff Operator';
    const store = storeId || localStorage.getItem('pos_active_store') || 'lusaka';
    const cleanAction = (action || '').replace(/'/g, "''");
    const cleanDetails = (details || '').replace(/'/g, "''");
    const cleanUser = (user || '').replace(/'/g, "''");

    runSql(`
      INSERT INTO audit_logs (id, module, action, details, amount, store_id, performed_by, created_at)
      VALUES ('${id}', '${module}', '${cleanAction}', '${cleanDetails}', ${amount}, '${store}', '${cleanUser}', '${nowStr}')
    `, `Audit Trail: [${module}] ${action} by ${user}`);

    // Also mirror into transactions journal for financial ledger traceability
    const txId = `TX_${id}`;
    runSql(`
      INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by)
      VALUES ('${txId}', 'idem_${txId}', 'AUDIT_TRAIL', '${module}', '${id}', ${amount}, 0.00, 'SUCCESS', '[${module}] ${cleanAction} - ${cleanDetails}', '${nowStr}', '${nowStr}', '${cleanUser}')
    `, `Audit Journal Entry: ${action}`);

    persistTablesToStorage();
  } catch (err) {
    console.warn('Failed writing employee audit log', err);
  }
}

