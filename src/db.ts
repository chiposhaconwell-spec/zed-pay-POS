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
const CLEAN_SLATE_MIGRATION_KEY = 'pos_clean_slate_v5';

let cloudPushTimeout: any = null;

export function extractAllTablesSnapshot(): Record<string, any[]> {
  const allTablesData: Record<string, any[]> = {};
  if (alasql && alasql.tables) {
    for (const tableName of ALL_TABLE_NAMES) {
      if (alasql.tables[tableName]) {
        try {
          const rows = alasql(`SELECT * FROM ${tableName}`) as any[];
          if (Array.isArray(rows)) {
            allTablesData[tableName] = rows;
          }
        } catch {
          allTablesData[tableName] = [];
        }
      }
    }
  }
  return allTablesData;
}

export function persistTablesToStorage(skipCloudSync: boolean = false) {
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

    // Automatically schedule background Cloud SQL synchronization if a business account is set up
    if (!skipCloudSync && !isDbInitializing && typeof window !== 'undefined') {
      const bizList = allTablesData['businesses'] || [];
      if (bizList.length > 0) {
        if (cloudPushTimeout) clearTimeout(cloudPushTimeout);
        cloudPushTimeout = setTimeout(() => {
          pushDatabaseToServer().catch(() => {
            // background sync failure ignored (offline-safe)
          });
        }, 1200);
      }
    }
  } catch (e) {
    console.error('Failed to save state to storage:', e);
  }
}


// Seed Store Data Types
export type SeedTemplate = 'blank' | 'cafe' | 'boutique' | 'grocer' | 'ledger';

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
    if (!Array.isArray(rows)) continue;
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

function isLegacyPreseededSnapshot(recovered: Record<string, any[]>): boolean {
  const biz = recovered['businesses'] || [];
  const prods = recovered['products'] || [];
  const stores = recovered['stores'] || [];
  const staff = recovered['staff'] || [];
  const hasDefaultBiz = biz.some((b: any) => b?.id === 'default_biz' || b?.email === 'owner@pos.zm');
  const hasOnlyDefaultBiz =
    biz.length === 1 &&
    (biz[0]?.id === 'default_biz' || biz[0]?.email === 'owner@pos.zm' || biz[0]?.owner === 'Chiposha Conwell');
  const hasLegacySeedSkus = prods.some((p: any) =>
    ['COF-001', 'COF-002', 'APP-01', 'GRO-01'].includes(String(p?.sku || ''))
  );
  const hasOnlyLegacyStores =
    stores.length > 0 &&
    stores.every((s: any) => ['lusaka', 'kitwe', 'ndola'].includes(String(s?.id || '').toLowerCase()));
  const hasLegacyStaff = staff.some((st: any) => st?.id === 'staff-101' || st?.email === 'alice@pos.zm');
  return hasOnlyDefaultBiz || (hasDefaultBiz && (hasLegacySeedSkus || hasOnlyLegacyStores || hasLegacyStaff)) || (biz.length === 0 && (hasLegacySeedSkus || hasOnlyLegacyStores || hasLegacyStaff));
}

function scrubLegacyPreseededRows(recovered: Record<string, any[]>): Record<string, any[]> {
  const cleaned: Record<string, any[]> = { ...recovered };
  if (Array.isArray(cleaned['businesses'])) {
    cleaned['businesses'] = cleaned['businesses'].filter(
      (b: any) => b?.id !== 'default_biz' && b?.email !== 'owner@pos.zm'
    );
  }
  if (Array.isArray(cleaned['stores'])) {
    cleaned['stores'] = cleaned['stores'].filter(
      (s: any) => s?.business_id !== 'default_biz' && !(['lusaka', 'kitwe', 'ndola'].includes(String(s?.id || '')) && !s?.business_id)
    );
  }
  if (Array.isArray(cleaned['products'])) {
    const legacySkus = new Set(['COF-001', 'COF-002', 'COF-003', 'COF-004', 'FOD-101', 'FOD-102', 'FOD-103', 'FOD-104', 'APP-01', 'APP-02', 'APP-03', 'ACC-01', 'ACC-02', 'SHO-01', 'GRO-01', 'GRO-02', 'GRO-03', 'GRO-04', 'GRO-05', 'GRO-06']);
    cleaned['products'] = cleaned['products'].filter(
      (p: any) => p?.business_id !== 'default_biz' && !legacySkus.has(String(p?.sku || ''))
    );
  }
  if (Array.isArray(cleaned['customers'])) {
    cleaned['customers'] = cleaned['customers'].filter(
      (c: any) => c?.business_id !== 'default_biz' && ![101, 102, 103, 104].includes(Number(c?.id))
    );
  }
  if (Array.isArray(cleaned['staff'])) {
    cleaned['staff'] = cleaned['staff'].filter(
      (st: any) => st?.business_id !== 'default_biz' && !['staff-101', 'staff-102', 'staff-103'].includes(String(st?.id || ''))
    );
  }
  return cleaned;
}

function hasAnyUserCreatedData(recovered: Record<string, any[]>): boolean {
  const userTables = ['businesses', 'stores', 'products', 'customers', 'orders', 'staff', 'expenses', 'laybys', 'quotations', 'loans'];
  return userTables.some(t => Array.isArray(recovered[t]) && recovered[t].length > 0);
}

let isDbSchemaCreated = false;

export function initializeDatabase(template: SeedTemplate = 'blank', forceReset: boolean = false) {
  if (!forceReset && isDbSchemaCreated && alasql.tables && alasql.tables.businesses && alasql.tables.accounts) {
    return;
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
    runSql('DROP TABLE IF EXISTS receipt_refund_ledger', 'Clean database: Drops old receipt_refund_ledger');
    runSql('DROP TABLE IF EXISTS cash_flow_ledger', 'Clean database: Drops old cash_flow_ledger');
    runSql('DROP TABLE IF EXISTS payment_method_ledger', 'Clean database: Drops old payment_method_ledger');
    runSql('DROP TABLE IF EXISTS financial_statements_ledger', 'Clean database: Drops old financial_statements_ledger');

    // Create Business Identity container (with billing address, tax & admin role metadata)
    runSql(`
      CREATE TABLE businesses (
        id STRING PRIMARY KEY,
        name STRING,
        owner STRING,
        email STRING,
        password STRING,
        created_at STRING,
        billing_address STRING,
        billing_city STRING,
        billing_country STRING,
        phone STRING,
        tpin STRING,
        currency STRING,
        tax_rate NUMERIC,
        role STRING
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

  runSql(`
    CREATE TABLE receipt_refund_ledger (
      id STRING PRIMARY KEY,
      order_id STRING,
      entry_type STRING,
      date STRING,
      store_id STRING,
      customer_name STRING,
      payment_method STRING,
      subtotal NUMERIC,
      tax NUMERIC,
      discount NUMERIC,
      total_amount NUMERIC,
      cogs_amount NUMERIC,
      net_revenue_impact NUMERIC,
      cash_impact NUMERIC,
      performed_by STRING,
      journal_ref STRING,
      status STRING,
      created_at STRING
    )
  `, 'Durable Schema: Create RECEIPT_REFUND_LEDGER table');

  runSql(`
    CREATE TABLE cash_flow_ledger (
      id STRING PRIMARY KEY,
      date STRING,
      store_id STRING,
      activity_type STRING,
      category STRING,
      direction STRING,
      payment_method STRING,
      account_id STRING,
      inflow_amount NUMERIC,
      outflow_amount NUMERIC,
      net_cash_change NUMERIC,
      reference_id STRING,
      description STRING,
      performed_by STRING,
      created_at STRING
    )
  `, 'Durable Schema: Create CASH_FLOW_LEDGER table');

  runSql(`
    CREATE TABLE payment_method_ledger (
      id STRING PRIMARY KEY,
      payment_method STRING,
      store_id STRING,
      account_id STRING,
      gross_receipts NUMERIC,
      layby_receipts NUMERIC,
      refunds_out NUMERIC,
      expenses_out NUMERIC,
      transfers_in NUMERIC,
      transfers_out NUMERIC,
      net_balance NUMERIC,
      transaction_count INT,
      updated_at STRING
    )
  `, 'Durable Schema: Create PAYMENT_METHOD_LEDGER table');

  runSql(`
    CREATE TABLE financial_statements_ledger (
      id STRING PRIMARY KEY,
      store_id STRING,
      period_date STRING,
      gross_sales_revenue NUMERIC,
      sales_returns_refunds NUMERIC,
      discounts_allowed NUMERIC,
      vat_tax_collected NUMERIC,
      net_sales_revenue NUMERIC,
      cost_of_goods_sold NUMERIC,
      gross_profit NUMERIC,
      operating_expenses NUMERIC,
      payroll_expenses NUMERIC,
      net_operating_income NUMERIC,
      cash_and_equivalents NUMERIC,
      cash_drawer_balance NUMERIC,
      mobile_money_balance NUMERIC,
      bank_card_balance NUMERIC,
      inventory_asset_value NUMERIC,
      goods_in_transit_value NUMERIC,
      fixed_assets_value NUMERIC,
      total_assets NUMERIC,
      vat_payable_liability NUMERIC,
      layby_deposits_liability NUMERIC,
      loans_payable_liability NUMERIC,
      total_liabilities NUMERIC,
      owner_capital_equity NUMERIC,
      retained_earnings NUMERIC,
      total_equity NUMERIC,
      operating_cash_flow NUMERIC,
      investing_cash_flow NUMERIC,
      financing_cash_flow NUMERIC,
      net_cash_flow NUMERIC,
      updated_at STRING
    )
  `, 'Durable Schema: Create FINANCIAL_STATEMENTS_LEDGER table');

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

      // Clean slate check: if localStorage only has old preseeded demo data ('default_biz' / 'COF-001' / 'lusaka'), wipe it so the app starts genuinely blank
      const migratedClean = localStorage.getItem(CLEAN_SLATE_MIGRATION_KEY);
      if (!migratedClean) {
        localStorage.setItem(CLEAN_SLATE_MIGRATION_KEY, '1');
        if (isLegacyPreseededSnapshot(recovered)) {
          for (const table of ALL_TABLE_NAMES) {
            localStorage.removeItem(`${LOCAL_STORAGE_KEY_PREFIX}${table}`);
          }
          localStorage.removeItem('active_business_profile');
          localStorage.removeItem('pos_authenticated_session');
          localStorage.removeItem('pos_shift_active');
          for (const k of Object.keys(recovered)) {
            delete recovered[k];
          }
        }
      }

      const scrubbed = scrubLegacyPreseededRows(recovered);
      if (hasAnyUserCreatedData(scrubbed)) {
        rehydrateAlasqlFromRecords(scrubbed);
        hasRecoveredData = true;
        runSql('SELECT COUNT(*) AS biz_count FROM businesses', 'Persistent DB Recovery: Recovered user business data from LocalStorage');
      }
    } catch (err) {
      console.warn('LocalStorage recovery notice:', err);
    }
  } else {
    // On explicit forceReset to blank, also clear cached localStorage tables
    if (template === 'blank') {
      try {
        for (const table of ALL_TABLE_NAMES) {
          localStorage.removeItem(`${LOCAL_STORAGE_KEY_PREFIX}${table}`);
        }
        localStorage.removeItem('active_business_profile');
      } catch {}
    }
  }

  // Trigger background SQLite and persistent Android filesystem initialization
  initSqliteStorage().then(async (ready) => {
    if (ready && !forceReset) {
      try {
        const rawPersistentData = await loadTablesFromPersistentStorage();
        const persistentData = rawPersistentData ? scrubLegacyPreseededRows(rawPersistentData) : null;
        if (persistentData && !isLegacyPreseededSnapshot(rawPersistentData || {}) && hasAnyUserCreatedData(persistentData)) {
          console.log('[DB] Recovered tables from persistent SQLite / Filesystem storage layer');
          rehydrateAlasqlFromRecords(persistentData);
          syncAllAccountingSystems('SQLite Rehydration');
          notifySqlLogsUpdated();
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('database-rehydrated'));
            window.dispatchEvent(new Event('pos_data_updated'));
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
    // Fresh install or reset requested: Seed template-based data (defaults to 'blank' with zero stock/batches/accounts)
    seedTemplateData(template);
  }
  } finally {
    isDbInitializing = false;
    isDbSchemaCreated = true;
    syncAllAccountingSystems('Database Initialization');
    persistTablesToStorage(true);
  }
}

function seedChartOfAccountsOnly() {
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
    { id: 'mtn-clearing-account-uuid', name: 'MTN Mobile Money Clearing', type: 'ASSET', cur: 'ZMW' },
    { id: 'airtel-clearing-account-uuid', name: 'Airtel Money Clearing Asset', type: 'ASSET', cur: 'ZMW' },
    { id: 'merchant-wallet-account-uuid', name: 'Merchant Settlement Wallet', type: 'LIABILITY', cur: 'ZMW' },
    { id: 'platform-revenue-account-uuid', name: 'Mobile Money Processor Fees', type: 'REVENUE', cur: 'ZMW' },
    { id: 'cash-clearing-account-uuid', name: 'Counter Cash Tender Registry', type: 'ASSET', cur: 'ZMW' }
  ];

  const nowIso = new Date().toISOString();
  accountsToSeed.forEach(acc => {
    runSql(
      `INSERT INTO accounts VALUES ('${acc.id}', '${acc.name}', '${acc.type}', '${acc.cur}', '', '${nowIso}', '${nowIso}')`,
      `Chart of Accounts: Initialize [${acc.name}]`,
      true
    );
  });
}

function seedTemplateData(template: SeedTemplate) {
  if (template === 'blank') {
    // Blank mode: No preseeded stock, batches, customers, orders, or login accounts!
    seedChartOfAccountsOnly();
    return;
  }

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

// ============================================================================
// REAL-TIME DOUBLE-ENTRY ACCOUNTING & LEDGER SYNCHRONIZATION ENGINE
// Updates:
// 1. Chart of Accounts (`accounts`) & Account Balances (`ledger_entries`, `view_account_balances`)
// 2. General Double-Entry Journal (`double_entry_journal`)
// 3. Receipt & Refund Ledger (`receipt_refund_ledger`)
// 4. Cash Based on Payment Method (`payment_method_ledger`)
// 5. Cash Flow Statement Ledger (`cash_flow_ledger`)
// 6. Profit & Loss (P&L) & Balance Sheet Snapshot (`financial_statements_ledger`)
// 7. End-of-Day (EOD) Live Register Summary (`cash_ups`)
// ============================================================================
let isAccountingSyncRunning = false;

export function resolvePaymentMethodBucket(rawMethod: any): {
  bucket: 'Cash' | 'MTN Mobile Money' | 'Airtel Money' | 'Zamtel Kwacha' | 'Mobile Wallet' | 'Credit Card / Bank' | 'Split';
  accountId: string;
  clearingAccountId: string;
} {
  const m = String(rawMethod || 'Cash').trim().toLowerCase();
  if (m === 'split' || m.includes('split')) {
    return { bucket: 'Split', accountId: 'acc_cash', clearingAccountId: 'cash-clearing-account-uuid' };
  }
  if (m.includes('mtn')) {
    return { bucket: 'MTN Mobile Money', accountId: 'acc_momo', clearingAccountId: 'mtn-clearing-account-uuid' };
  }
  if (m.includes('airtel')) {
    return { bucket: 'Airtel Money', accountId: 'acc_momo', clearingAccountId: 'airtel-clearing-account-uuid' };
  }
  if (m.includes('zamtel')) {
    return { bucket: 'Zamtel Kwacha', accountId: 'acc_momo', clearingAccountId: 'mtn-clearing-account-uuid' };
  }
  if (m.includes('mobile') || m.includes('momo') || m.includes('wallet')) {
    return { bucket: 'Mobile Wallet', accountId: 'acc_momo', clearingAccountId: 'mtn-clearing-account-uuid' };
  }
  if (m.includes('card') || m.includes('credit') || m.includes('visa') || m.includes('bank') || m.includes('pos') || m.includes('transfer') || m.includes('cheque')) {
    return { bucket: 'Credit Card / Bank', accountId: 'acc_bank', clearingAccountId: 'airtel-clearing-account-uuid' };
  }
  return { bucket: 'Cash', accountId: 'acc_cash', clearingAccountId: 'cash-clearing-account-uuid' };
}

export function syncAllAccountingSystems(triggerReason: string = 'Immediate POS Sale Accounting Sync') {
  if (isAccountingSyncRunning || isDbInitializing) return;
  isAccountingSyncRunning = true;

  try {
    const nowIso = new Date().toISOString();
    const todayDate = nowIso.split('T')[0];

    // 0. Ensure all required tables exist (in case recovered from older schema)
    const ensureTables = [
      `CREATE TABLE IF NOT EXISTS receipt_refund_ledger (
        id STRING PRIMARY KEY, order_id STRING, entry_type STRING, date STRING, store_id STRING,
        customer_name STRING, payment_method STRING, subtotal NUMERIC, tax NUMERIC, discount NUMERIC,
        total_amount NUMERIC, cogs_amount NUMERIC, net_revenue_impact NUMERIC, cash_impact NUMERIC,
        performed_by STRING, journal_ref STRING, status STRING, created_at STRING
      )`,
      `CREATE TABLE IF NOT EXISTS cash_flow_ledger (
        id STRING PRIMARY KEY, date STRING, store_id STRING, activity_type STRING, category STRING,
        direction STRING, payment_method STRING, account_id STRING, inflow_amount NUMERIC,
        outflow_amount NUMERIC, net_cash_change NUMERIC, reference_id STRING, description STRING,
        performed_by STRING, created_at STRING
      )`,
      `CREATE TABLE IF NOT EXISTS payment_method_ledger (
        id STRING PRIMARY KEY, payment_method STRING, store_id STRING, account_id STRING,
        gross_receipts NUMERIC, layby_receipts NUMERIC, refunds_out NUMERIC, expenses_out NUMERIC,
        transfers_in NUMERIC, transfers_out NUMERIC, net_balance NUMERIC, transaction_count INT, updated_at STRING
      )`,
      `CREATE TABLE IF NOT EXISTS financial_statements_ledger (
        id STRING PRIMARY KEY, store_id STRING, period_date STRING, gross_sales_revenue NUMERIC,
        sales_returns_refunds NUMERIC, discounts_allowed NUMERIC, vat_tax_collected NUMERIC,
        net_sales_revenue NUMERIC, cost_of_goods_sold NUMERIC, gross_profit NUMERIC,
        operating_expenses NUMERIC, payroll_expenses NUMERIC, net_operating_income NUMERIC,
        cash_and_equivalents NUMERIC, cash_drawer_balance NUMERIC, mobile_money_balance NUMERIC,
        bank_card_balance NUMERIC, inventory_asset_value NUMERIC, goods_in_transit_value NUMERIC,
        fixed_assets_value NUMERIC, total_assets NUMERIC, vat_payable_liability NUMERIC,
        layby_deposits_liability NUMERIC, loans_payable_liability NUMERIC, total_liabilities NUMERIC,
        owner_capital_equity NUMERIC, retained_earnings NUMERIC, total_equity NUMERIC,
        operating_cash_flow NUMERIC, investing_cash_flow NUMERIC, financing_cash_flow NUMERIC,
        net_cash_flow NUMERIC, updated_at STRING
      )`,
      `CREATE TABLE IF NOT EXISTS double_entry_journal (
        id STRING PRIMARY KEY, date STRING, reference STRING, description STRING,
        account_debit STRING, account_credit STRING, amount NUMERIC, currency STRING
      )`
    ];
    for (const ddl of ensureTables) {
      runSql(ddl, 'Ensure accounting table', true);
    }

    // 1. Ensure Complete Chart of Accounts in `accounts`
    const requiredAccounts = [
      { id: 'acc_cash', name: 'Cash Account (Counter Drawer)', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_momo', name: 'Mobile Wallet Account (MTN/Airtel/Zamtel)', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_mtn', name: 'MTN Mobile Money Account', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_airtel', name: 'Airtel Money Account', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_zamtel', name: 'Zamtel Kwacha Account', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_bank', name: 'Commercial Bank & Card Settlement Account', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_inventory', name: 'Store Merchandise Inventory Asset', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_transit', name: 'Goods in Transit Asset', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_fixed_assets', name: 'Fixed Equipment & Property Assets', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_vat_payable', name: 'VAT / Tax Output Payable (ZRA)', type: 'LIABILITY', cur: 'ZMW' },
      { id: 'acc_layby_deposits', name: 'Customer Layby Unearned Deposits', type: 'LIABILITY', cur: 'ZMW' },
      { id: 'acc_loans_payable', name: 'Working Capital Loans Payable', type: 'LIABILITY', cur: 'ZMW' },
      { id: 'acc_sales_revenue', name: 'Gross Sales Revenue', type: 'REVENUE', cur: 'ZMW' },
      { id: 'acc_sales_returns', name: 'Sales Returns, Refunds & Allowances', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_sales_discounts', name: 'Sales Discounts Allowed', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_cost_of_goods', name: 'Cost of Goods Sold (COGS)', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_retained_earnings', name: 'Owner Equity & Retained Earnings', type: 'EQUITY', cur: 'ZMW' },
      { id: 'acc_owner_capital', name: 'Owner Paid-In Capital Equity', type: 'EQUITY', cur: 'ZMW' },
      { id: 'acc_exp_rent', name: 'Rent & Premises Expense', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_exp_utilities', name: 'Utilities Expense (Power/Water/Internet)', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_exp_wages', name: 'Wages & Payroll Expense', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_exp_transport', name: 'Freight, Transport & Shipping Expense', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_exp_handling', name: 'Port, Handling & Customs Expense', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_exp_marketing', name: 'Marketing & Promotion Expense', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_exp_supplies', name: 'Office & Operational Supplies Expense', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_exp_maintenance', name: 'Repairs & Maintenance Expense', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_exp_taxes_licensing', name: 'Licenses, Taxes & Permits Expense', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_exp_misc', name: 'Miscellaneous Operating Expenses', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'mtn-clearing-account-uuid', name: 'MTN Mobile Money Clearing', type: 'ASSET', cur: 'ZMW' },
      { id: 'airtel-clearing-account-uuid', name: 'Airtel Money Clearing Asset', type: 'ASSET', cur: 'ZMW' },
      { id: 'merchant-wallet-account-uuid', name: 'Merchant Settlement Wallet', type: 'LIABILITY', cur: 'ZMW' },
      { id: 'platform-revenue-account-uuid', name: 'Mobile Money Processor Fees', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'cash-clearing-account-uuid', name: 'Counter Cash Tender Registry', type: 'ASSET', cur: 'ZMW' }
    ];

    const existingAccRes = runSql('SELECT id FROM accounts', 'Accounting Sync: Check accounts', true);
    const existingAccIds = new Set(
      existingAccRes.success && Array.isArray(existingAccRes.data)
        ? existingAccRes.data.map((a: any) => a.id)
        : []
    );

    for (const acc of requiredAccounts) {
      if (!existingAccIds.has(acc.id)) {
        runSql(
          `INSERT INTO accounts VALUES ('${acc.id}', '${acc.name.replace(/'/g, "''")}', '${acc.type}', '${acc.cur}', 'default_biz', '${nowIso}', '${nowIso}')`,
          `Accounting Sync: Ensure account ${acc.id}`,
          true
        );
      }
    }

    // 2. Fetch all source records from the database
    const productsRes = runSql('SELECT * FROM products', 'Accounting Sync: Products', true);
    const storeProductsRes = runSql('SELECT * FROM store_products', 'Accounting Sync: Store Products', true);
    const customersRes = runSql('SELECT * FROM customers', 'Accounting Sync: Customers', true);
    const ordersRes = runSql('SELECT * FROM orders ORDER BY orderDate ASC', 'Accounting Sync: Orders', true);
    const orderItemsRes = runSql('SELECT * FROM order_items', 'Accounting Sync: Order Items', true);
    const laybysRes = runSql('SELECT * FROM laybys ORDER BY created_at ASC', 'Accounting Sync: Laybys', true);
    const laybyInstRes = runSql('SELECT * FROM layby_installments ORDER BY created_at ASC', 'Accounting Sync: Layby Installments', true);
    const expensesRes = runSql('SELECT * FROM expenses ORDER BY expense_date ASC', 'Accounting Sync: Expenses', true);
    const attendanceRes = runSql("SELECT * FROM time_attendance WHERE status = 'PAID'", 'Accounting Sync: Paid Payroll', true);
    const transfersRes = runSql('SELECT * FROM money_transfers ORDER BY transfer_date ASC', 'Accounting Sync: Transfers', true);
    const transitRes = runSql('SELECT * FROM transit_purchases ORDER BY created_at ASC', 'Accounting Sync: Transit POs', true);
    const assetsRes = runSql('SELECT * FROM assets', 'Accounting Sync: Assets', true);
    const equityRes = runSql('SELECT * FROM equity', 'Accounting Sync: Equity', true);
    const loansRes = runSql("SELECT * FROM loans WHERE status = 'ACTIVE'", 'Accounting Sync: Active Loans', true);
    const loanDedRes = runSql("SELECT * FROM automated_deduction_logs WHERE status = 'SUCCESS'", 'Accounting Sync: Loan Sweeps', true);
    const ledgerEntriesRes = runSql('SELECT * FROM ledger_entries', 'Accounting Sync: Existing Ledger Entries', true);
    const transactionsRes = runSql('SELECT * FROM transactions', 'Accounting Sync: Existing Transactions', true);

    const products: any[] = (productsRes.success && Array.isArray(productsRes.data)) ? productsRes.data : [];
    const storeProducts: any[] = (storeProductsRes.success && Array.isArray(storeProductsRes.data)) ? storeProductsRes.data : [];
    const customers: any[] = (customersRes.success && Array.isArray(customersRes.data)) ? customersRes.data : [];
    const orders: any[] = (ordersRes.success && Array.isArray(ordersRes.data)) ? ordersRes.data : [];
    const orderItems: any[] = (orderItemsRes.success && Array.isArray(orderItemsRes.data)) ? orderItemsRes.data : [];
    const laybys: any[] = (laybysRes.success && Array.isArray(laybysRes.data)) ? laybysRes.data : [];
    const laybyInstallments: any[] = (laybyInstRes.success && Array.isArray(laybyInstRes.data)) ? laybyInstRes.data : [];
    const expenses: any[] = (expensesRes.success && Array.isArray(expensesRes.data)) ? expensesRes.data : [];
    const paidAttendance: any[] = (attendanceRes.success && Array.isArray(attendanceRes.data)) ? attendanceRes.data : [];
    const transfers: any[] = (transfersRes.success && Array.isArray(transfersRes.data)) ? transfersRes.data : [];
    const transitPos: any[] = (transitRes.success && Array.isArray(transitRes.data)) ? transitRes.data : [];
    const assetsList: any[] = (assetsRes.success && Array.isArray(assetsRes.data)) ? assetsRes.data : [];
    const equityList: any[] = (equityRes.success && Array.isArray(equityRes.data)) ? equityRes.data : [];
    const activeLoans: any[] = (loansRes.success && Array.isArray(loansRes.data)) ? loansRes.data : [];
    const loanSweeps: any[] = (loanDedRes.success && Array.isArray(loanDedRes.data)) ? loanDedRes.data : [];
    const existingLedgerEntries: any[] = (ledgerEntriesRes.success && Array.isArray(ledgerEntriesRes.data)) ? ledgerEntriesRes.data : [];
    const existingTransactions: any[] = (transactionsRes.success && Array.isArray(transactionsRes.data)) ? transactionsRes.data : [];

    // Build lookup maps
    const productMap = new Map<number, any>();
    products.forEach(p => productMap.set(Number(p.id), p));

    const customerMap = new Map<string, string>();
    customers.forEach(c => customerMap.set(String(c.id), c.name));

    const itemsByOrder = new Map<string, any[]>();
    orderItems.forEach(oi => {
      const oId = String(oi.orderId);
      if (!itemsByOrder.has(oId)) itemsByOrder.set(oId, []);
      itemsByOrder.get(oId)!.push(oi);
    });

    const laybyMap = new Map<string, any>();
    laybys.forEach(l => laybyMap.set(String(l.id), l));

    // Helper to resolve split payment breakdown for an order from ledger_entries if available
    const getSplitAmountsForOrder = (ordId: string, totalAmt: number): { cashPart: number; momoPart: number } => {
      const matchingTx = existingTransactions.find(t => String(t.provider_reference || '').includes(ordId));
      if (matchingTx) {
        const entries = existingLedgerEntries.filter(le => le.transaction_id === matchingTx.id && le.type === 'DEBIT');
        let cashPart = 0;
        let momoPart = 0;
        entries.forEach(le => {
          if (le.account_id === 'acc_cash') cashPart += Number(le.amount || 0);
          if (le.account_id === 'acc_momo') momoPart += Number(le.amount || 0);
        });
        if (cashPart + momoPart > 0) {
          return { cashPart, momoPart };
        }
      }
      return { cashPart: parseFloat((totalAmt / 2).toFixed(2)), momoPart: parseFloat((totalAmt - parseFloat((totalAmt / 2).toFixed(2))).toFixed(2)) };
    };

    // 3. Rebuild authoritative accounting ledgers:
    // - double_entry_journal
    // - receipt_refund_ledger
    // - cash_flow_ledger
    // - payment_method_ledger
    // - financial_statements_ledger
    // - ledger_entries (ensuring view_account_balances is 100% accurate)
    runSql('DELETE FROM double_entry_journal', 'Accounting Sync: Reset double_entry_journal', true);
    runSql('DELETE FROM receipt_refund_ledger', 'Accounting Sync: Reset receipt_refund_ledger', true);
    runSql('DELETE FROM cash_flow_ledger', 'Accounting Sync: Reset cash_flow_ledger', true);
    runSql('DELETE FROM payment_method_ledger', 'Accounting Sync: Reset payment_method_ledger', true);
    runSql('DELETE FROM financial_statements_ledger', 'Accounting Sync: Reset financial_statements_ledger', true);
    runSql('DELETE FROM ledger_entries', 'Accounting Sync: Rebuild balanced ledger_entries', true);

    const journalRows: any[] = [];
    const receiptRefundRows: any[] = [];
    const cashFlowRows: any[] = [];
    const rebuiltLedgerEntries: any[] = [];

    const addJournalPair = (
      idSuffix: string,
      date: string,
      reference: string,
      description: string,
      debitAcc: string,
      creditAcc: string,
      amount: number,
      txIdForLedger?: string
    ) => {
      const cleanAmt = parseFloat(Number(amount || 0).toFixed(4));
      if (cleanAmt <= 0) return;
      const jId = `JRN_${idSuffix}`;
      journalRows.push({
        id: jId,
        date,
        reference,
        description,
        account_debit: debitAcc,
        account_credit: creditAcc,
        amount: cleanAmt,
        currency: 'ZMW'
      });
      const txRef = txIdForLedger || `tx_${idSuffix}`;
      rebuiltLedgerEntries.push({
        id: `le_${idSuffix}_dr`,
        transaction_id: txRef,
        account_id: debitAcc,
        type: 'DEBIT',
        amount: cleanAmt,
        created_at: date
      });
      rebuiltLedgerEntries.push({
        id: `le_${idSuffix}_cr`,
        transaction_id: txRef,
        account_id: creditAcc,
        type: 'CREDIT',
        amount: cleanAmt,
        created_at: date
      });
    };

    // Dynamically collect all store IDs from stores table and active records
    const dbStoresRes = runSql('SELECT id FROM stores', 'Accounting Sync: Stores', true);
    const dynamicStoreSet = new Set<string>();
    if (dbStoresRes.success && Array.isArray(dbStoresRes.data)) {
      dbStoresRes.data.forEach((s: any) => {
        if (s.id) dynamicStoreSet.add(String(s.id).toLowerCase().trim());
      });
    }
    orders.forEach(o => { if (o.store_id) dynamicStoreSet.add(String(o.store_id).toLowerCase().trim()); });
    expenses.forEach(e => { if (e.store_id) dynamicStoreSet.add(String(e.store_id).toLowerCase().trim()); });
    laybys.forEach(l => { if (l.store_id) dynamicStoreSet.add(String(l.store_id).toLowerCase().trim()); });
    storeProducts.forEach(sp => { if (sp.store_id) dynamicStoreSet.add(String(sp.store_id).toLowerCase().trim()); });

    const individualStores = Array.from(dynamicStoreSet);
    const storesList = [...individualStores, 'all'];
    const defaultFallbackStore = individualStores[0] || 'main';
    const methodNames = [
      'Cash',
      'MTN Mobile Money',
      'Airtel Money',
      'Zamtel Kwacha',
      'Mobile Wallet',
      'Credit Card / Bank',
      'Split'
    ];

    interface MethodStat {
      payment_method: string;
      store_id: string;
      account_id: string;
      gross_receipts: number;
      layby_receipts: number;
      refunds_out: number;
      expenses_out: number;
      transfers_in: number;
      transfers_out: number;
      transaction_count: number;
    }

    const methodStats = new Map<string, MethodStat>();
    for (const st of storesList) {
      for (const mName of methodNames) {
        const resolved = resolvePaymentMethodBucket(mName);
        const key = `${st}__${mName}`;
        methodStats.set(key, {
          payment_method: mName,
          store_id: st,
          account_id: resolved.accountId,
          gross_receipts: 0,
          layby_receipts: 0,
          refunds_out: 0,
          expenses_out: 0,
          transfers_in: 0,
          transfers_out: 0,
          transaction_count: 0
        });
      }
    }

    const addMethodStat = (storeId: string, methodBucket: string, field: keyof MethodStat, delta: number, incTx: boolean = false) => {
      const normStore = (storeId || defaultFallbackStore).toLowerCase().trim();
      if (!methodStats.has(`${normStore}__${methodBucket}`)) {
        for (const mName of methodNames) {
          const resolved = resolvePaymentMethodBucket(mName);
          methodStats.set(`${normStore}__${mName}`, {
            payment_method: mName,
            store_id: normStore,
            account_id: resolved.accountId,
            gross_receipts: 0,
            layby_receipts: 0,
            refunds_out: 0,
            expenses_out: 0,
            transfers_in: 0,
            transfers_out: 0,
            transaction_count: 0
          });
        }
      }
      const targets = [normStore, 'all'];
      for (const tStore of targets) {
        const key = `${tStore}__${methodBucket}`;
        const stat = methodStats.get(key);
        if (stat) {
          (stat[field] as number) += delta;
          if (incTx) stat.transaction_count += 1;
        }
      }
    };

    // A. Process all Orders (Sales Receipts AND Refunded Orders)
    orders.forEach((ord, idx) => {
      const ordId = String(ord.id || `ORD-${idx}`);
      const dateStr = ord.orderDate || nowIso;
      const storeId = (ord.store_id || 'lusaka').toLowerCase().trim();
      const statusLower = String(ord.status || 'Completed').toLowerCase().trim();
      const isRefunded = statusLower === 'refunded';
      const isCancelled = statusLower === 'cancelled' || statusLower === 'voided' || statusLower === 'deleted';
      if (isCancelled) return;

      const subtotal = Number(ord.subtotal || ord.total || 0);
      const tax = Number(ord.tax || 0);
      const discount = Number(ord.discount || 0);
      const total = Number(ord.total || 0);
      const netSalesExTax = Math.max(0, total - tax);
      const rawPayMethod = String(ord.paymentMethod || 'Cash').trim();
      const isLaybyCompletionOrder = rawPayMethod.toLowerCase().includes('layby');
      const custName = ord.customerId && customerMap.has(String(ord.customerId))
        ? customerMap.get(String(ord.customerId))!
        : 'Walk-In Customer';
      const cashier = ord.performed_by || 'Cashier';

      // Compute COGS from order_items
      const oItems = itemsByOrder.get(ordId) || [];
      let orderCogs = 0;
      oItems.forEach(it => {
        const prod = productMap.get(Number(it.productId));
        const unitCost = prod ? Number(prod.cost || Number(it.unitPrice || 0) * 0.7) : Number(it.unitPrice || 0) * 0.7;
        orderCogs += unitCost * Number(it.quantity || 1);
      });
      orderCogs = parseFloat(orderCogs.toFixed(2));

      const resolved = resolvePaymentMethodBucket(rawPayMethod);

      // 1. Record Original Sale Receipt in receipt_refund_ledger, double_entry_journal, cash_flow_ledger, payment_method_ledger
      const receiptId = `RCPT_${ordId}`;
      receiptRefundRows.push({
        id: receiptId,
        order_id: ordId,
        entry_type: 'RECEIPT',
        date: dateStr,
        store_id: storeId,
        customer_name: custName,
        payment_method: rawPayMethod,
        subtotal,
        tax,
        discount,
        total_amount: total,
        cogs_amount: orderCogs,
        net_revenue_impact: total,
        cash_impact: isLaybyCompletionOrder ? 0 : total,
        performed_by: cashier,
        journal_ref: `JRN_SALE_${ordId}`,
        status: isRefunded ? 'REFUNDED' : 'COMPLETED',
        created_at: dateStr
      });

      if (isLaybyCompletionOrder) {
        // Layby completion converts unearned layby deposits liability into recognized sales revenue
        addJournalPair(
          `SALE_LBY_${ordId}`,
          dateStr,
          ordId,
          `Layby Completed Revenue Recognition #${ordId} (${custName})`,
          'acc_layby_deposits',
          'acc_sales_revenue',
          total
        );
      } else if (resolved.bucket === 'Split') {
        const { cashPart, momoPart } = getSplitAmountsForOrder(ordId, total);
        if (cashPart > 0) {
          addJournalPair(
            `SALE_SPLITCASH_${ordId}`,
            dateStr,
            ordId,
            `POS Split Sale (Cash Portion) #${ordId} (${custName})`,
            'acc_cash',
            'acc_sales_revenue',
            cashPart
          );
          rebuiltLedgerEntries.push({
            id: `le_clr_cash_${ordId}`,
            transaction_id: `tx_${ordId}`,
            account_id: 'cash-clearing-account-uuid',
            type: 'DEBIT',
            amount: cashPart,
            created_at: dateStr
          });
          addMethodStat(storeId, 'Cash', 'gross_receipts', cashPart, true);
        }
        if (momoPart > 0) {
          addJournalPair(
            `SALE_SPLITMOMO_${ordId}`,
            dateStr,
            ordId,
            `POS Split Sale (Mobile Money Portion) #${ordId} (${custName})`,
            'acc_momo',
            'acc_sales_revenue',
            momoPart
          );
          rebuiltLedgerEntries.push({
            id: `le_clr_momo_${ordId}`,
            transaction_id: `tx_${ordId}`,
            account_id: 'mtn-clearing-account-uuid',
            type: 'DEBIT',
            amount: momoPart,
            created_at: dateStr
          });
          addMethodStat(storeId, 'Mobile Wallet', 'gross_receipts', momoPart, true);
        }
        addMethodStat(storeId, 'Split', 'gross_receipts', total, true);
      } else {
        // Standard or Quick Sale via Cash, Mobile Wallet, MTN, Airtel, Zamtel, or Bank/Card
        if (netSalesExTax > 0) {
          addJournalPair(
            `SALE_REV_${ordId}`,
            dateStr,
            ordId,
            `POS Sale Revenue #${ordId} via ${rawPayMethod} (${custName})`,
            resolved.accountId,
            'acc_sales_revenue',
            netSalesExTax
          );
        }
        if (tax > 0) {
          addJournalPair(
            `SALE_VAT_${ordId}`,
            dateStr,
            ordId,
            `POS Output VAT Collected #${ordId} (${custName})`,
            resolved.accountId,
            'acc_vat_payable',
            tax
          );
        }
        // Specific sub-ledger account & clearing account tracking
        rebuiltLedgerEntries.push({
          id: `le_clr_${ordId}`,
          transaction_id: `tx_${ordId}`,
          account_id: resolved.clearingAccountId,
          type: 'DEBIT',
          amount: total,
          created_at: dateStr
        });
        rebuiltLedgerEntries.push({
          id: `le_merch_${ordId}`,
          transaction_id: `tx_${ordId}`,
          account_id: 'merchant-wallet-account-uuid',
          type: 'CREDIT',
          amount: total,
          created_at: dateStr
        });

        addMethodStat(storeId, resolved.bucket, 'gross_receipts', total, true);
      }

      // Record COGS & Inventory Asset Reduction for the sale
      if (orderCogs > 0) {
        addJournalPair(
          `SALE_COGS_${ordId}`,
          dateStr,
          ordId,
          `Cost of Goods Sold (COGS) for Invoice #${ordId}`,
          'acc_cost_of_goods',
          'acc_inventory',
          orderCogs
        );
      }

      // Record Operating Cash Inflow in cash_flow_ledger (unless Layby completion which already collected cash via installments)
      if (!isLaybyCompletionOrder) {
        cashFlowRows.push({
          id: `CF_SALE_${ordId}`,
          date: dateStr,
          store_id: storeId,
          activity_type: 'OPERATING',
          category: 'POS Sales Receipt',
          direction: 'INFLOW',
          payment_method: rawPayMethod,
          account_id: resolved.accountId,
          inflow_amount: total,
          outflow_amount: 0,
          net_cash_change: total,
          reference_id: ordId,
          description: `POS Sale Receipt #${ordId} (${custName}) via ${rawPayMethod}`,
          performed_by: cashier,
          created_at: dateStr
        });
      }

      // 2. If the Order is REFUNDED, record the complete reversing Double-Entry, Refund Ledger, Cash Outflow, and Payment Method deduction!
      if (isRefunded) {
        const refundId = `RFND_${ordId}`;
        receiptRefundRows.push({
          id: refundId,
          order_id: ordId,
          entry_type: 'REFUND',
          date: dateStr,
          store_id: storeId,
          customer_name: custName,
          payment_method: rawPayMethod,
          subtotal: -subtotal,
          tax: -tax,
          discount: -discount,
          total_amount: total,
          cogs_amount: -orderCogs,
          net_revenue_impact: -total,
          cash_impact: -total,
          performed_by: cashier,
          journal_ref: `JRN_RFND_${ordId}`,
          status: 'REFUNDED',
          created_at: dateStr
        });

        if (resolved.bucket === 'Split') {
          const { cashPart, momoPart } = getSplitAmountsForOrder(ordId, total);
          if (cashPart > 0) {
            addJournalPair(
              `RFND_SPLITCASH_${ordId}`,
              dateStr,
              ordId,
              `Refund Reversal (Cash Portion) for Order #${ordId}`,
              'acc_sales_returns',
              'acc_cash',
              cashPart
            );
            rebuiltLedgerEntries.push({
              id: `le_rfnd_clr_cash_${ordId}`,
              transaction_id: `tx_rfnd_${ordId}`,
              account_id: 'cash-clearing-account-uuid',
              type: 'CREDIT',
              amount: cashPart,
              created_at: dateStr
            });
            addMethodStat(storeId, 'Cash', 'refunds_out', cashPart, false);
          }
          if (momoPart > 0) {
            addJournalPair(
              `RFND_SPLITMOMO_${ordId}`,
              dateStr,
              ordId,
              `Refund Reversal (Mobile Portion) for Order #${ordId}`,
              'acc_sales_returns',
              'acc_momo',
              momoPart
            );
            rebuiltLedgerEntries.push({
              id: `le_rfnd_clr_momo_${ordId}`,
              transaction_id: `tx_rfnd_${ordId}`,
              account_id: 'mtn-clearing-account-uuid',
              type: 'CREDIT',
              amount: momoPart,
              created_at: dateStr
            });
            addMethodStat(storeId, 'Mobile Wallet', 'refunds_out', momoPart, false);
          }
          addMethodStat(storeId, 'Split', 'refunds_out', total, false);
        } else {
          if (netSalesExTax > 0) {
            addJournalPair(
              `RFND_REV_${ordId}`,
              dateStr,
              ordId,
              `Sales Return & Refund Credit Note #${ordId} (${custName})`,
              'acc_sales_returns',
              resolved.accountId,
              netSalesExTax
            );
          }
          if (tax > 0) {
            addJournalPair(
              `RFND_VAT_${ordId}`,
              dateStr,
              ordId,
              `VAT Output Reversal on Refund #${ordId}`,
              'acc_vat_payable',
              resolved.accountId,
              tax
            );
          }
          rebuiltLedgerEntries.push({
            id: `le_rfnd_clr_${ordId}`,
            transaction_id: `tx_rfnd_${ordId}`,
            account_id: resolved.clearingAccountId,
            type: 'CREDIT',
            amount: total,
            created_at: dateStr
          });
          rebuiltLedgerEntries.push({
            id: `le_rfnd_merch_${ordId}`,
            transaction_id: `tx_rfnd_${ordId}`,
            account_id: 'merchant-wallet-account-uuid',
            type: 'DEBIT',
            amount: total,
            created_at: dateStr
          });
          addMethodStat(storeId, resolved.bucket, 'refunds_out', total, false);
        }

        // Reverse COGS & restore Inventory Asset valuation on Refund
        if (orderCogs > 0) {
          addJournalPair(
            `RFND_COGS_${ordId}`,
            dateStr,
            ordId,
            `Inventory Restock & COGS Reversal on Refund #${ordId}`,
            'acc_inventory',
            'acc_cost_of_goods',
            orderCogs
          );
        }

        // Record Operating Cash Outflow for Refund
        cashFlowRows.push({
          id: `CF_RFND_${ordId}`,
          date: dateStr,
          store_id: storeId,
          activity_type: 'OPERATING',
          category: 'Customer Sales Refund',
          direction: 'OUTFLOW',
          payment_method: rawPayMethod,
          account_id: resolved.accountId,
          inflow_amount: 0,
          outflow_amount: total,
          net_cash_change: -total,
          reference_id: ordId,
          description: `Refund Credit Note Paid Out for Order #${ordId} (${custName})`,
          performed_by: cashier,
          created_at: dateStr
        });
      }
    });

    // B. Process all Layby Installments (Deposits & Partial Payments)
    laybyInstallments.forEach((inst, idx) => {
      const instId = String(inst.id || `INST-${idx}`);
      const laybyId = String(inst.layby_id || '');
      const parentLayby = laybyMap.get(laybyId);
      const storeId = (parentLayby?.store_id || 'lusaka').toLowerCase().trim();
      const custName = parentLayby?.customer_name || 'Layby Customer';
      const amt = Number(inst.amount || 0);
      if (amt <= 0) return;

      const payMethod = String(inst.payment_method || 'Cash').trim();
      const resolved = resolvePaymentMethodBucket(payMethod);
      const dateStr = inst.created_at || nowIso;
      const cashier = inst.received_by || 'Cashier';

      // 1. Double-Entry: Debit Cash/Mobile/Bank Asset, Credit Customer Layby Deposits Liability
      addJournalPair(
        `LBY_INST_${instId}`,
        dateStr,
        laybyId || instId,
        `Layby Installment Receipt #${instId} for ${custName} (${laybyId})`,
        resolved.accountId,
        'acc_layby_deposits',
        amt
      );

      rebuiltLedgerEntries.push({
        id: `le_clr_lby_${instId}`,
        transaction_id: `tx_lby_${instId}`,
        account_id: resolved.clearingAccountId,
        type: 'DEBIT',
        amount: amt,
        created_at: dateStr
      });

      // 2. Receipt & Refund Ledger entry
      receiptRefundRows.push({
        id: `RCPT_LBY_${instId}`,
        order_id: laybyId || instId,
        entry_type: 'LAYBY_RECEIPT',
        date: dateStr,
        store_id: storeId,
        customer_name: custName,
        payment_method: payMethod,
        subtotal: amt,
        tax: 0,
        discount: 0,
        total_amount: amt,
        cogs_amount: 0,
        net_revenue_impact: 0,
        cash_impact: amt,
        performed_by: cashier,
        journal_ref: `JRN_LBY_INST_${instId}`,
        status: 'LAYBY_DEPOSIT',
        created_at: dateStr
      });

      // 3. Payment Method Ledger
      addMethodStat(storeId, resolved.bucket, 'layby_receipts', amt, true);

      // 4. Cash Flow Ledger
      cashFlowRows.push({
        id: `CF_LBY_${instId}`,
        date: dateStr,
        store_id: storeId,
        activity_type: 'OPERATING',
        category: 'Layby Deposit / Installment',
        direction: 'INFLOW',
        payment_method: payMethod,
        account_id: resolved.accountId,
        inflow_amount: amt,
        outflow_amount: 0,
        net_cash_change: amt,
        reference_id: laybyId || instId,
        description: `Layby Installment #${instId} from ${custName} via ${payMethod}`,
        performed_by: cashier,
        created_at: dateStr
      });
    });

    // C. Process Operating Expenses
    expenses.forEach((exp, idx) => {
      const expId = String(exp.id || `EXP-${idx}`);
      const amt = Number(exp.amount || 0);
      if (amt <= 0) return;
      const storeId = (exp.store_id || 'lusaka').toLowerCase().trim();
      const dateStr = exp.expense_date || exp.created_at || nowIso;
      const accId = exp.account_id || 'acc_cash';
      const cat = String(exp.category || 'Miscellaneous Overhead');
      const desc = exp.description || cat;
      const perfBy = exp.performed_by || 'Finance Admin';

      let expDebitAcc = 'acc_exp_misc';
      const catLower = cat.toLowerCase();
      if (catLower.includes('rent')) expDebitAcc = 'acc_exp_rent';
      else if (catLower.includes('util') || catLower.includes('electric') || catLower.includes('internet')) expDebitAcc = 'acc_exp_utilities';
      else if (catLower.includes('wage') || catLower.includes('staff') || catLower.includes('payroll')) expDebitAcc = 'acc_exp_wages';
      else if (catLower.includes('transport') || catLower.includes('freight') || catLower.includes('fuel')) expDebitAcc = 'acc_exp_transport';
      else if (catLower.includes('market')) expDebitAcc = 'acc_exp_marketing';
      else if (catLower.includes('maint') || catLower.includes('repair')) expDebitAcc = 'acc_exp_maintenance';

      addJournalPair(
        `EXP_${expId}`,
        dateStr,
        expId,
        `Operating Expense: ${cat} - ${desc}`,
        expDebitAcc,
        accId,
        amt
      );

      const methodBucket = accId === 'acc_momo' ? 'Mobile Wallet' : accId === 'acc_bank' ? 'Credit Card / Bank' : 'Cash';
      addMethodStat(storeId, methodBucket, 'expenses_out', amt, false);

      cashFlowRows.push({
        id: `CF_EXP_${expId}`,
        date: dateStr,
        store_id: storeId,
        activity_type: 'OPERATING',
        category: `Expense: ${cat}`,
        direction: 'OUTFLOW',
        payment_method: methodBucket,
        account_id: accId,
        inflow_amount: 0,
        outflow_amount: amt,
        net_cash_change: -amt,
        reference_id: expId,
        description: `Operating Expense #${expId}: ${desc}`,
        performed_by: perfBy,
        created_at: dateStr
      });
    });

    // D. Process Paid Staff Payroll (time_attendance WHERE status = 'PAID')
    paidAttendance.forEach((att, idx) => {
      const attId = String(att.id || `PAY-${idx}`);
      const amt = Number(att.gross_payment || 0);
      if (amt <= 0) return;
      const dateStr = att.date || nowIso;

      addJournalPair(
        `PAYROLL_${attId}`,
        dateStr,
        attId,
        `Staff Payroll Paid: ${att.employee_name} (${att.hours_worked} hrs)`,
        'acc_exp_wages',
        'acc_cash',
        amt
      );

      addMethodStat('lusaka', 'Cash', 'expenses_out', amt, false);

      cashFlowRows.push({
        id: `CF_PAY_${attId}`,
        date: dateStr,
        store_id: 'lusaka',
        activity_type: 'OPERATING',
        category: 'Staff Payroll & Wages',
        direction: 'OUTFLOW',
        payment_method: 'Cash',
        account_id: 'acc_cash',
        inflow_amount: 0,
        outflow_amount: amt,
        net_cash_change: -amt,
        reference_id: attId,
        description: `Payroll Disbursement to ${att.employee_name}`,
        performed_by: 'Payroll Admin',
        created_at: dateStr
      });
    });

    // E. Process Inter-Account Money Transfers
    transfers.forEach((tr, idx) => {
      const trId = String(tr.id || `TRF-${idx}`);
      const amt = Number(tr.amount || 0);
      if (amt <= 0) return;
      const srcAcc = tr.source_account || 'acc_bank';
      const dstAcc = tr.dest_account || 'acc_cash';
      const dateStr = tr.transfer_date || nowIso;

      addJournalPair(
        `TRF_${trId}`,
        dateStr,
        trId,
        `Internal Liquidity Transfer #${trId} (${srcAcc} -> ${dstAcc})`,
        dstAcc,
        srcAcc,
        amt
      );

      const srcBucket = srcAcc === 'acc_momo' ? 'Mobile Wallet' : srcAcc === 'acc_bank' ? 'Credit Card / Bank' : 'Cash';
      const dstBucket = dstAcc === 'acc_momo' ? 'Mobile Wallet' : dstAcc === 'acc_bank' ? 'Credit Card / Bank' : 'Cash';
      addMethodStat('lusaka', srcBucket, 'transfers_out', amt, false);
      addMethodStat('lusaka', dstBucket, 'transfers_in', amt, false);
    });

    // F. Process Goods in Transit & Purchase Orders (Procurement)
    transitPos.forEach((po, idx) => {
      const poId = String(po.id || `PO-${idx}`);
      const amt = Number(po.grand_landed_total || 0);
      if (amt <= 0) return;
      const storeId = (po.store_id || 'lusaka').toLowerCase().trim();
      const dateStr = po.created_at || nowIso;
      const payMethod = String(po.payment_method || 'BANK_TRANSFER');
      const payAcc = payMethod === 'CASH' ? 'acc_cash' : payMethod === 'MOBILE_MONEY' ? 'acc_momo' : 'acc_bank';
      const methodBucket = payAcc === 'acc_cash' ? 'Cash' : payAcc === 'acc_momo' ? 'Mobile Wallet' : 'Credit Card / Bank';

      const targetAssetAcc = po.status === 'RECEIVED' ? 'acc_inventory' : 'acc_transit';
      addJournalPair(
        `PO_${poId}`,
        dateStr,
        poId,
        `Supplier Purchase Order #${poId} (${po.supplier_name}) - ${po.status}`,
        targetAssetAcc,
        payAcc,
        amt
      );

      addMethodStat(storeId, methodBucket, 'expenses_out', amt, false);

      cashFlowRows.push({
        id: `CF_PO_${poId}`,
        date: dateStr,
        store_id: storeId,
        activity_type: 'OPERATING',
        category: 'Supplier Inventory Procurement',
        direction: 'OUTFLOW',
        payment_method: methodBucket,
        account_id: payAcc,
        inflow_amount: 0,
        outflow_amount: amt,
        net_cash_change: -amt,
        reference_id: poId,
        description: `Purchase Order #${poId} to ${po.supplier_name} (${po.status})`,
        performed_by: 'Procurement',
        created_at: dateStr
      });
    });

    // G. Process Fixed Assets & Owner Capital Equity
    assetsList.forEach((ast, idx) => {
      const astId = String(ast.id || `AST-${idx}`);
      const val = Number(ast.value || 0);
      if (val <= 0) return;
      const dateStr = ast.purchase_date || nowIso;
      addJournalPair(
        `ASSET_${astId}`,
        dateStr,
        astId,
        `Fixed/Current Asset Registration: ${ast.name}`,
        'acc_fixed_assets',
        'acc_owner_capital',
        val
      );
    });

    equityList.forEach((eq, idx) => {
      if (eq.linked_asset_id) return; // already paired above
      const eqId = String(eq.id || `EQ-${idx}`);
      const val = Number(eq.value || 0);
      if (val <= 0) return;
      addJournalPair(
        `EQUITY_${eqId}`,
        nowIso,
        eqId,
        `Owner Capital Equity Contribution: ${eq.name}`,
        'acc_bank',
        'acc_owner_capital',
        val
      );
      cashFlowRows.push({
        id: `CF_EQ_${eqId}`,
        date: nowIso,
        store_id: 'lusaka',
        activity_type: 'FINANCING',
        category: 'Owner Capital Injection',
        direction: 'INFLOW',
        payment_method: 'Credit Card / Bank',
        account_id: 'acc_bank',
        inflow_amount: val,
        outflow_amount: 0,
        net_cash_change: val,
        reference_id: eqId,
        description: `Owner Capital Equity: ${eq.name}`,
        performed_by: 'Owner',
        created_at: nowIso
      });
    });

    // H. Process Inventory Stock Valuation & Retained Earnings Alignment
    let totalPhysicalInventoryValue = 0;
    const invValueByStore: Record<string, number> = { lusaka: 0, kitwe: 0, ndola: 0 };
    if (storeProducts.length > 0) {
      storeProducts.forEach(sp => {
        const prod = productMap.get(Number(sp.product_id));
        if (prod && prod.is_service !== 1) {
          const unitCost = Number(prod.cost || Number(sp.price || prod.price || 0) * 0.7);
          const stockQty = Math.max(0, Number(sp.stock || 0));
          const val = unitCost * stockQty;
          const st = String(sp.store_id || 'lusaka').toLowerCase();
          invValueByStore[st] = (invValueByStore[st] || 0) + val;
          totalPhysicalInventoryValue += val;
        }
      });
    } else {
      products.forEach(p => {
        if (p.is_service !== 1) {
          const val = Number(p.cost || Number(p.price || 0) * 0.7) * Math.max(0, Number(p.stock || 0));
          invValueByStore['lusaka'] += val;
          totalPhysicalInventoryValue += val;
        }
      });
    }

    // Post Opening Inventory Stock Capitalization so `acc_inventory` in `view_account_balances` matches current physical warehouse cost valuation
    const currentInvLedgerNet = rebuiltLedgerEntries
      .filter(le => le.account_id === 'acc_inventory')
      .reduce((acc, le) => acc + (le.type === 'DEBIT' ? le.amount : -le.amount), 0);
    const neededInitialInventory = totalPhysicalInventoryValue - currentInvLedgerNet;
    if (neededInitialInventory > 0) {
      addJournalPair(
        'OPENING_INVENTORY_CAPITAL',
        '2026-01-01T00:00:00Z',
        'OPEN-INV-01',
        'Opening Warehouse Merchandise Inventory Valuation Capitalization',
        'acc_inventory',
        'acc_retained_earnings',
        neededInitialInventory
      );
    }

    // 4. Bulk insert rebuilt rows into AlaSQL tables
    if (alasql.tables.double_entry_journal) {
      alasql.tables.double_entry_journal.data = journalRows;
    }
    if (alasql.tables.receipt_refund_ledger) {
      // Sort newest first
      receiptRefundRows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      alasql.tables.receipt_refund_ledger.data = receiptRefundRows;
    }
    if (alasql.tables.cash_flow_ledger) {
      cashFlowRows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      alasql.tables.cash_flow_ledger.data = cashFlowRows;
    }
    if (alasql.tables.ledger_entries) {
      alasql.tables.ledger_entries.data = rebuiltLedgerEntries;
    }

    // 5. Populate `payment_method_ledger`
    const paymentMethodRows: any[] = [];
    methodStats.forEach((stat, key) => {
      const netBal = parseFloat(
        (
          stat.gross_receipts +
          stat.layby_receipts -
          stat.refunds_out -
          stat.expenses_out +
          stat.transfers_in -
          stat.transfers_out
        ).toFixed(2)
      );
      paymentMethodRows.push({
        id: `PML_${key.replace(/[^a-zA-Z0-9_]/g, '_')}`,
        payment_method: stat.payment_method,
        store_id: stat.store_id,
        account_id: stat.account_id,
        gross_receipts: parseFloat(stat.gross_receipts.toFixed(2)),
        layby_receipts: parseFloat(stat.layby_receipts.toFixed(2)),
        refunds_out: parseFloat(stat.refunds_out.toFixed(2)),
        expenses_out: parseFloat(stat.expenses_out.toFixed(2)),
        transfers_in: parseFloat(stat.transfers_in.toFixed(2)),
        transfers_out: parseFloat(stat.transfers_out.toFixed(2)),
        net_balance: netBal,
        transaction_count: stat.transaction_count,
        updated_at: nowIso
      });
    });
    if (alasql.tables.payment_method_ledger) {
      alasql.tables.payment_method_ledger.data = paymentMethodRows;
    }

    // 6. Compute and populate `financial_statements_ledger` for each store and 'all'
    const statementRows: any[] = [];
    const totalFixedAssetsVal = assetsList
      .filter(a => a.status !== 'Disposed' && a.status !== 'Written Off')
      .reduce((s, a) => s + Number(a.value || 0), 0);
    const totalOwnerCapitalVal = equityList.reduce((s, e) => s + Number(e.value || 0), 0);
    const totalLoansRepayable = activeLoans.reduce((s, l) => s + Number(l.total_repayable || 0), 0);
    const totalLoansSwept = loanSweeps.reduce((s, d) => s + Number(d.amount_deducted || 0), 0);
    const netLoansPayable = Math.max(0, totalLoansRepayable - totalLoansSwept);

    for (const st of storesList) {
      const matchStore = (rowStore: any) => st === 'all' || String(rowStore || 'lusaka').toLowerCase().trim() === st;

      // Orders for this store
      const stOrders = orders.filter(o => {
        const sLower = String(o.status || 'Completed').toLowerCase().trim();
        return matchStore(o.store_id) && !['cancelled', 'voided', 'deleted'].includes(sLower);
      });

      let grossSales = 0;
      let salesRefunds = 0;
      let discountsAllowed = 0;
      let vatCollected = 0;
      let netCogs = 0;

      stOrders.forEach(o => {
        const sLower = String(o.status || 'Completed').toLowerCase().trim();
        const isRef = sLower === 'refunded';
        const tot = Number(o.total || 0);
        const disc = Number(o.discount || 0);
        const tx = Number(o.tax || 0);

        grossSales += tot + disc;
        discountsAllowed += disc;
        if (isRef) {
          salesRefunds += tot;
        } else {
          vatCollected += tx;
          const oItems = itemsByOrder.get(String(o.id)) || [];
          oItems.forEach(it => {
            const prod = productMap.get(Number(it.productId));
            const uCost = prod ? Number(prod.cost || Number(it.unitPrice || 0) * 0.7) : Number(it.unitPrice || 0) * 0.7;
            netCogs += uCost * Number(it.quantity || 1);
          });
        }
      });

      const netSalesRevenue = Math.max(0, grossSales - discountsAllowed - salesRefunds - vatCollected);
      const grossProfit = netSalesRevenue - netCogs;

      const stExpenses = expenses
        .filter(e => matchStore(e.store_id))
        .reduce((s, e) => s + Number(e.amount || 0), 0);
      const stPayroll = (st === 'all' || st === 'lusaka')
        ? paidAttendance.reduce((s, a) => s + Number(a.gross_payment || 0), 0)
        : 0;

      const netOperatingIncome = grossProfit - stExpenses - stPayroll;

      // Cash balances by payment channel for this store
      const getMethodNet = (mName: string) => {
        const found = paymentMethodRows.find(r => r.store_id === st && r.payment_method === mName);
        return found ? Number(found.net_balance || 0) : 0;
      };

      const cashDrawerBal = getMethodNet('Cash');
      const momoBal =
        getMethodNet('MTN Mobile Money') +
        getMethodNet('Airtel Money') +
        getMethodNet('Zamtel Kwacha') +
        getMethodNet('Mobile Wallet');
      const bankCardBal = getMethodNet('Credit Card / Bank');
      const totalCashEquiv = cashDrawerBal + momoBal + bankCardBal;

      const stInvVal = st === 'all' ? totalPhysicalInventoryValue : (invValueByStore[st] || 0);
      const stTransitVal = transitPos
        .filter(p => matchStore(p.store_id) && p.status !== 'RECEIVED')
        .reduce((s, p) => s + Number(p.grand_landed_total || 0), 0);
      const stFixedAssets = st === 'all' || st === 'lusaka' ? totalFixedAssetsVal : 0;
      const totalAssets = totalCashEquiv + stInvVal + stTransitVal + stFixedAssets;

      // Liabilities
      const stLaybyLiability = laybys
        .filter(l => matchStore(l.store_id) && l.status !== 'COMPLETED')
        .reduce((s, l) => s + Number(l.amount_paid || 0), 0);
      const stLoansLiability = st === 'all' || st === 'lusaka' ? netLoansPayable : 0;
      const totalLiabilities = vatCollected + stLaybyLiability + stLoansLiability;

      // Equity (Assets - Liabilities = Total Equity, decomposed into Owner Capital + Retained Earnings)
      const stOwnerCapital = st === 'all' || st === 'lusaka' ? totalOwnerCapitalVal : 0;
      const totalEquity = totalAssets - totalLiabilities;
      const retainedEarnings = totalEquity - stOwnerCapital;

      // Cash Flows for this store
      const stCashFlows = cashFlowRows.filter(cf => matchStore(cf.store_id));
      const opCf = stCashFlows
        .filter(cf => cf.activity_type === 'OPERATING')
        .reduce((s, cf) => s + Number(cf.net_cash_change || 0), 0);
      const invCf = stCashFlows
        .filter(cf => cf.activity_type === 'INVESTING')
        .reduce((s, cf) => s + Number(cf.net_cash_change || 0), 0);
      const finCf = stCashFlows
        .filter(cf => cf.activity_type === 'FINANCING')
        .reduce((s, cf) => s + Number(cf.net_cash_change || 0), 0);
      const netCf = opCf + invCf + finCf;

      statementRows.push({
        id: `STMT_${st.toUpperCase()}`,
        store_id: st,
        period_date: todayDate,
        gross_sales_revenue: parseFloat(grossSales.toFixed(2)),
        sales_returns_refunds: parseFloat(salesRefunds.toFixed(2)),
        discounts_allowed: parseFloat(discountsAllowed.toFixed(2)),
        vat_tax_collected: parseFloat(vatCollected.toFixed(2)),
        net_sales_revenue: parseFloat(netSalesRevenue.toFixed(2)),
        cost_of_goods_sold: parseFloat(netCogs.toFixed(2)),
        gross_profit: parseFloat(grossProfit.toFixed(2)),
        operating_expenses: parseFloat(stExpenses.toFixed(2)),
        payroll_expenses: parseFloat(stPayroll.toFixed(2)),
        net_operating_income: parseFloat(netOperatingIncome.toFixed(2)),
        cash_and_equivalents: parseFloat(totalCashEquiv.toFixed(2)),
        cash_drawer_balance: parseFloat(cashDrawerBal.toFixed(2)),
        mobile_money_balance: parseFloat(momoBal.toFixed(2)),
        bank_card_balance: parseFloat(bankCardBal.toFixed(2)),
        inventory_asset_value: parseFloat(stInvVal.toFixed(2)),
        goods_in_transit_value: parseFloat(stTransitVal.toFixed(2)),
        fixed_assets_value: parseFloat(stFixedAssets.toFixed(2)),
        total_assets: parseFloat(totalAssets.toFixed(2)),
        vat_payable_liability: parseFloat(vatCollected.toFixed(2)),
        layby_deposits_liability: parseFloat(stLaybyLiability.toFixed(2)),
        loans_payable_liability: parseFloat(stLoansLiability.toFixed(2)),
        total_liabilities: parseFloat(totalLiabilities.toFixed(2)),
        owner_capital_equity: parseFloat(stOwnerCapital.toFixed(2)),
        retained_earnings: parseFloat(retainedEarnings.toFixed(2)),
        total_equity: parseFloat(totalEquity.toFixed(2)),
        operating_cash_flow: parseFloat(opCf.toFixed(2)),
        investing_cash_flow: parseFloat(invCf.toFixed(2)),
        financing_cash_flow: parseFloat(finCf.toFixed(2)),
        net_cash_flow: parseFloat(netCf.toFixed(2)),
        updated_at: nowIso
      });
    }

    if (alasql.tables.financial_statements_ledger) {
      alasql.tables.financial_statements_ledger.data = statementRows;
    }

    // 7. Immediately update/upsert Today's Live EOD Cash-Up Register (`cash_ups`) in the database
    if (individualStores.length > 0 || orders.length > 0 || expenses.length > 0) {
      for (const st of storesList) {
        const matchStore = (rowStore: any) => st === 'all' || String(rowStore || defaultFallbackStore).toLowerCase().trim() === st;
        const isToday = (dVal: any) => String(dVal || '').includes(todayDate);

        let eodCashSales = 0;
        let eodCardSales = 0;
        let eodMomoSales = 0;
        let eodRefundsCash = 0;
        let eodRefundsCard = 0;
        let eodRefundsMomo = 0;

        orders.forEach(o => {
          if (!isToday(o.orderDate) || !matchStore(o.store_id)) return;
          const sLower = String(o.status || 'Completed').toLowerCase().trim();
          if (['cancelled', 'voided', 'deleted'].includes(sLower)) return;
          const isRef = sLower === 'refunded';
          const rawPay = String(o.paymentMethod || 'Cash');
          if (rawPay.toLowerCase().includes('layby')) return;
          const tot = Number(o.total || 0);
          const resolved = resolvePaymentMethodBucket(rawPay);

          if (resolved.bucket === 'Split') {
            const { cashPart, momoPart } = getSplitAmountsForOrder(String(o.id), tot);
            if (isRef) {
              eodRefundsCash += cashPart;
              eodRefundsMomo += momoPart;
            } else {
              eodCashSales += cashPart;
              eodMomoSales += momoPart;
            }
          } else if (resolved.bucket === 'Cash') {
            if (isRef) eodRefundsCash += tot;
            else eodCashSales += tot;
          } else if (resolved.bucket === 'Credit Card / Bank') {
            if (isRef) eodRefundsCard += tot;
            else eodCardSales += tot;
          } else {
            if (isRef) eodRefundsMomo += tot;
            else eodMomoSales += tot;
          }
        });

        laybyInstallments.forEach(inst => {
          if (!isToday(inst.created_at)) return;
          const pLayby = laybyMap.get(String(inst.layby_id || ''));
          if (!matchStore(pLayby?.store_id)) return;
          const amt = Number(inst.amount || 0);
          const resolved = resolvePaymentMethodBucket(inst.payment_method);
          if (resolved.bucket === 'Cash') eodCashSales += amt;
          else if (resolved.bucket === 'Credit Card / Bank') eodCardSales += amt;
          else eodMomoSales += amt;
        });

        let eodCashExpenses = 0;
        expenses.forEach(ex => {
          if (!isToday(ex.expense_date || ex.created_at) || !matchStore(ex.store_id)) return;
          if (String(ex.account_id || 'acc_cash').toLowerCase() === 'acc_cash') {
            eodCashExpenses += Number(ex.amount || 0);
          }
        });

        const openingFloat = typeof localStorage !== 'undefined'
          ? parseFloat(localStorage.getItem('shift_opening_cash_' + (st === 'all' ? defaultFallbackStore : st)) || localStorage.getItem('shift_opening_cash_global') || '0') || 0
          : 0;

        const netExpectedCash = parseFloat((openingFloat + eodCashSales - eodRefundsCash - eodCashExpenses).toFixed(2));
        const netExpectedCard = parseFloat((eodCardSales - eodRefundsCard).toFixed(2));
        const netExpectedMomo = parseFloat((eodMomoSales - eodRefundsMomo).toFixed(2));

        const liveEodId = `EOD-LIVE-${todayDate}-${st.toUpperCase()}`;
        runSql(`DELETE FROM cash_ups WHERE id = '${liveEodId}'`, 'EOD Sync: Refresh live EOD row', true);
        runSql(
          `INSERT INTO cash_ups VALUES (
            '${liveEodId}',
            '${todayDate}',
            '${st}',
            'LIVE AUTO-LEDGER (${triggerReason.replace(/'/g, '')})',
            ${netExpectedCash},
            ${netExpectedCash},
            ${netExpectedCard},
            ${netExpectedCard},
            ${netExpectedMomo},
            ${netExpectedMomo},
            0.00,
            'Auto-synced EOD | Cash Sales: ${eodCashSales.toFixed(2)} | Refunds: ${(eodRefundsCash + eodRefundsCard + eodRefundsMomo).toFixed(2)} | Cash Out: ${eodCashExpenses.toFixed(2)}',
            '${nowIso}'
          )`,
          `EOD Sync: Auto-update live EOD cash-up for ${st}`,
          true
        );
      }
    }

  } catch (err) {
    console.warn('[AccountingEngine] syncAllAccountingSystems error:', err);
  } finally {
    isAccountingSyncRunning = false;
  }
}

// ============================================================================
// CLOUD SQL SERVER SYNCHRONIZATION API CLIENT
// ============================================================================
export async function pushDatabaseToServer(explicitBusinessId?: string): Promise<{
  success: boolean;
  businessId?: string;
  updatedAt?: string;
  details: string;
}> {
  try {
    syncAllAccountingSystems('Pre-Cloud Push Sync');
    const tables = extractAllTablesSnapshot();
    const bizRows = tables['businesses'] || [];
    let bizId = explicitBusinessId || '';
    let bizName = '';
    let ownerEmail = '';

    if (!bizId && typeof localStorage !== 'undefined') {
      try {
        const cached = JSON.parse(localStorage.getItem('active_business_profile') || '{}');
        if (cached && cached.id && cached.id !== 'default_biz') {
          bizId = cached.id;
          bizName = cached.name || '';
          ownerEmail = cached.email || '';
        }
      } catch {}
    }

    if (!bizId && bizRows.length > 0) {
      bizId = bizRows[0].id;
      bizName = bizRows[0].name || '';
      ownerEmail = bizRows[0].email || '';
    }

    if (!bizId) {
      bizId = '__global__';
    }

    let settingsObj: any = null;
    if (typeof localStorage !== 'undefined') {
      try {
        const sRaw = localStorage.getItem('android_pos_settings');
        if (sRaw) settingsObj = JSON.parse(sRaw);
      } catch {}
    }

    const res = await fetch('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessId: bizId,
        businessName: bizName,
        ownerEmail,
        tables,
        settings: settingsObj,
      }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Server returned ${res.status}`);
    }

    const data = await res.json();
    const syncedAt = data.updatedAt || new Date().toISOString();
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('pos_last_cloud_sync', syncedAt);
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('pos_sync_status_changed', { detail: { syncedAt, status: 'synced' } }));
    }

    const prodCount = (tables['products'] || []).length;
    const storeCount = (tables['stores'] || []).length;
    const orderCount = (tables['orders'] || []).length;

    return {
      success: true,
      businessId: data.businessId || bizId,
      updatedAt: syncedAt,
      details: `Synchronized with Cloud SQL (${storeCount} branches, ${prodCount} stock items, ${orderCount} orders) at ${new Date(syncedAt).toLocaleTimeString()}`,
    };
  } catch (err: any) {
    return {
      success: false,
      details: err?.message || 'Failed to push database state to Cloud SQL server.',
    };
  }
}

export async function pullDatabaseFromServer(businessId?: string, email?: string): Promise<{
  success: boolean;
  found: boolean;
  business?: any;
  settings?: any;
  availableBusinesses?: any[];
  updatedAt?: string;
  details: string;
}> {
  try {
    const params = new URLSearchParams();
    if (businessId && businessId.trim()) params.set('businessId', businessId.trim());
    if (email && email.trim()) params.set('email', email.trim());

    const res = await fetch(`/api/sync/pull?${params.toString()}`);
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Server returned ${res.status}`);
    }

    const data = await res.json();
    if (!data.found || !data.tables) {
      return {
        success: true,
        found: false,
        availableBusinesses: data.availableBusinesses || [],
        details: 'No synchronized business data found on Cloud SQL server yet.',
      };
    }

    rehydrateAlasqlFromRecords(data.tables);
    syncAllAccountingSystems('Cloud SQL Pull Rehydration');
    persistTablesToStorage(true);

    if (data.settings && typeof localStorage !== 'undefined') {
      localStorage.setItem('android_pos_settings', JSON.stringify(data.settings));
    }

    const bizRows = Array.isArray(data.tables.businesses) ? data.tables.businesses : [];
    const targetBiz =
      bizRows.find((b: any) => b.id === data.businessId) ||
      (email ? bizRows.find((b: any) => String(b.email || '').toLowerCase() === email.toLowerCase()) : null) ||
      bizRows[0] ||
      null;

    if (targetBiz && typeof localStorage !== 'undefined') {
      localStorage.setItem('active_business_profile', JSON.stringify(targetBiz));
    }

    if (data.updatedAt && typeof localStorage !== 'undefined') {
      localStorage.setItem('pos_last_cloud_sync', data.updatedAt);
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('local_db_restored'));
      window.dispatchEvent(new Event('pos_data_updated'));
      window.dispatchEvent(new CustomEvent('pos_sync_status_changed', { detail: { syncedAt: data.updatedAt, status: 'synced' } }));
    }

    const prodCount = (data.tables.products || []).length;
    const storeCount = (data.tables.stores || []).length;
    const orderCount = (data.tables.orders || []).length;

    return {
      success: true,
      found: true,
      business: targetBiz,
      settings: data.settings || null,
      availableBusinesses: data.availableBusinesses || [],
      updatedAt: data.updatedAt,
      details: `Pulled business [${targetBiz?.name || data.businessName || 'Workspace'}] from Cloud SQL (${storeCount} branches, ${prodCount} stock items, ${orderCount} orders).`,
    };
  } catch (err: any) {
    return {
      success: false,
      found: false,
      details: err?.message || 'Failed to pull database state from Cloud SQL server.',
    };
  }
}

export async function clearAllDatabaseToBlank() {
  initializeDatabase('blank', true);
  if (typeof localStorage !== 'undefined') {
    for (const table of ALL_TABLE_NAMES) {
      localStorage.removeItem(`${LOCAL_STORAGE_KEY_PREFIX}${table}`);
    }
    localStorage.removeItem('active_business_profile');
  }
  persistTablesToStorage(true);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('local_db_restored'));
    window.dispatchEvent(new Event('pos_data_updated'));
  }
}



