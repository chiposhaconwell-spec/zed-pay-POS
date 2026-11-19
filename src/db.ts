import alasql from 'alasql';
import { Product, Customer, Order, OrderItem, SqlLogEntry, StoreSettings, CustomPaymentMethod } from './types';
import { 
  initSqliteStorage, 
  registerPendingSync, 
  loadTablesFromPersistentStorage, 
  triggerImmediateFlush, 
  SQLITE_SCOPED_TABLES,
  saveReceiptToSqliteCache,
  markReceiptMirroredInSqlite,
  getCachedReceiptsFromSqlite,
  type LocalReceiptRecord,
} from './sqliteStorage';
import {
  computeCredentialHashSync,
  deriveMembershipId,
  deriveUserId,
  normalizeAuthEmail,
} from './multiTenantAuth';

export {
  saveReceiptToSqliteCache,
  markReceiptMirroredInSqlite,
  getCachedReceiptsFromSqlite,
  type LocalReceiptRecord,
};

export const ALL_TABLE_NAMES = [
  'users',
  'business_memberships',
  'businesses',
  'stores',
  'products',
  'customers',
  'orders',
  'order_items',
  'accounts',
  'transactions',
  'ledger_entries',
  'laybys',
  'layby_installments',
  'time_attendance',
  'staff',
  'store_products',
  'stock_transfers',
  'cash_ups',
  'quotations',
  'loans',
  'loan_amortization_schedule',
  'automated_deduction_logs',
  'stock_takes',
  'stock_take_items',
  'expenses',
  'purchases_transit',
  'transit_purchases',
  'suppliers',
  'money_transfers',
  'assets',
  'equity',
  'double_entry_journal',
  'audit_logs',
  'receipt_refund_ledger',
  'cash_flow_ledger',
  'payment_method_ledger',
  'financial_statements_ledger',
  'payment_methods',
  'zra_invoices',
  'zra_sync_queue',
];

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

export function sqlEsc(val: any): string {
  return String(val ?? '').replace(/'/g, "''");
}

export function getActiveBusinessId(explicitBusinessId?: string): string {
  const cleanExplicit = String(explicitBusinessId || '').trim();
  if (cleanExplicit && cleanExplicit !== 'default_biz') {
    return cleanExplicit;
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem('active_business_profile');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.id && String(parsed.id).trim() && parsed.id !== 'default_biz') {
          return String(parsed.id).trim();
        }
      }
    } catch {}
  }
  try {
    const bizData = (alasql as any)?.tables?.businesses?.data as any[] | undefined;
    if (Array.isArray(bizData) && bizData.length > 0) {
      const valid = bizData.find((b: any) => b?.id && b.id !== 'default_biz') || bizData[0];
      if (valid?.id && valid.id !== 'default_biz') return String(valid.id).trim();
    }
  } catch {}
  return '';
}

export function getActiveStoreId(explicitStoreId?: string, explicitBusinessId?: string): string {
  const cleanExplicit = String(explicitStoreId || '').trim();
  if (cleanExplicit) return cleanExplicit;
  if (typeof localStorage !== 'undefined') {
    const active = localStorage.getItem('active_store_branch') || localStorage.getItem('pos_active_store');
    if (active && active.trim() && active.trim().toLowerCase() !== 'all') {
      return active.trim();
    }
  }
  const bizId = getActiveBusinessId(explicitBusinessId);
  try {
    const rawStores = (alasql as any)?.tables?.stores?.data as any[] | undefined;
    if (Array.isArray(rawStores) && rawStores.length > 0) {
      const match = bizId ? rawStores.find((s: any) => s?.business_id === bizId && s?.id) : rawStores.find((s: any) => s?.id);
      if (match?.id) return String(match.id).trim();
    }
  } catch {}
  return 'main';
}

export function filterRowsByBusiness<T extends Record<string, any>>(rows: T[], explicitBusinessId?: string): T[] {
  if (!Array.isArray(rows)) return [];
  const bizId = getActiveBusinessId(explicitBusinessId);
  if (!bizId) {
    return rows.filter((r: any) => !r?.business_id || r.business_id !== 'default_biz');
  }
  return rows.filter((r: any) => {
    const rBiz = String(r?.business_id || '').trim();
    const rId = String(r?.id || '').trim();
    if (rBiz) return rBiz === bizId;
    if (rId && rId === bizId) return true;
    return false;
  });
}

function stampTenantColumnsOnTables(tableNames?: string[], explicitBizId?: string, explicitStoreId?: string) {
  if (!alasql?.tables) return;
  const bizId = getActiveBusinessId(explicitBizId);
  const storeId = getActiveStoreId(explicitStoreId, bizId);
  const targets = tableNames && tableNames.length > 0 ? tableNames : ALL_TABLE_NAMES;
  for (const tbl of targets) {
    const tblObj = alasql.tables[tbl] as any;
    if (!tblObj || !Array.isArray(tblObj.data)) continue;
    for (const row of tblObj.data) {
      if (!row || typeof row !== 'object') continue;
      if (tbl === 'businesses') {
        if (!row.business_id && row.id) row.business_id = String(row.id);
        if (!row.store_id) row.store_id = storeId || 'main';
      } else if (tbl === 'stores') {
        if (!row.business_id && bizId) row.business_id = bizId;
        if (!row.store_id && row.id) row.store_id = String(row.id);
      } else if (tbl === 'accounts') {
        if (!row.business_id && bizId) row.business_id = bizId;
        if (!row.store_id) row.store_id = 'all';
      } else {
        if (!row.business_id && bizId) row.business_id = bizId;
        if (!row.store_id && storeId) row.store_id = storeId;
      }
    }
  }
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

  // Escape AlaSQL reserved keywords used as column/alias identifiers (outside string literals/backticks)
  const reservedIdentifiers = new Set(['total', 'value']);
  let escaped = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      escaped += ch;
      continue;
    }
    if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      escaped += ch;
      continue;
    }
    if (ch === '`' && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      escaped += ch;
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick && /[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < cleaned.length && /[A-Za-z0-9_]/.test(cleaned[j])) {
        j++;
      }
      const word = cleaned.slice(i, j);
      if (reservedIdentifiers.has(word.toLowerCase())) {
        escaped += '`' + word + '`';
      } else {
        escaped += word;
      }
      i = j - 1;
      continue;
    }
    escaped += ch;
  }

  return escaped.trim();
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
      if (upperSql.includes('INSERT') || upperSql.includes('UPDATE')) {
        stampTenantColumnsOnTables();
      }
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

export function triggerLoanSweep(orderId: string, orderTotal: number, explicitBusinessId?: string): { deducted: number; status: string; loanId?: string } {
  // 1. Fetch any active loans strictly scoped to the current business
  const activeBizId = getActiveBusinessId(explicitBusinessId);
  const loanWhere = activeBizId
    ? `WHERE status = 'ACTIVE' AND business_id = '${sqlEsc(activeBizId)}'`
    : `WHERE status = 'ACTIVE'`;
  const loansRes = runSql(`SELECT * FROM loans ${loanWhere}`, 'Sweep: Query active loan agreement');
  if (!loansRes.success || !Array.isArray(loansRes.data) || loansRes.data.length === 0) {
    return { deducted: 0, status: 'NO_ACTIVE_LOANS' };
  }

  const activeLoan = loansRes.data[0];
  const loanBizId = String(activeLoan.business_id || activeBizId || '').trim();
  const loanStoreId = getActiveStoreId(activeLoan.store_id, loanBizId);

  // 2. Query sum of previous successful deductions
  const deductionsRes = runSql("SELECT SUM(amount_deducted) AS total_paid FROM automated_deduction_logs WHERE loan_id = '" + sqlEsc(activeLoan.id) + "' AND status = 'SUCCESS'", 'Sweep: Compute repaid capital');
  const totalPaid = (deductionsRes.success && deductionsRes.data[0] && deductionsRes.data[0].total_paid)
    ? Number(deductionsRes.data[0].total_paid)
    : 0;

  const remainingDebt = Number(activeLoan.total_repayable) - totalPaid;
  if (remainingDebt <= 0) {
    // Already fully paid, transition loan to PAID_OFF to prevent redundant sweeps
    runSql("UPDATE loans SET status = 'PAID_OFF', updated_at = '" + new Date().toISOString() + "' WHERE id = '" + sqlEsc(activeLoan.id) + "'", 'Sweep: Mark loan paid off');
    return { deducted: 0, status: 'LOAN_ALREADY_PAID_OFF' };
  }

  // 3. Compute the percentage slice (dynamic sweep)
  const theoreticalDeduct = orderTotal * (Number(activeLoan.daily_deduction_percentage) / 100);
  const actualDeduct = Math.min(theoreticalDeduct, remainingDebt);

  if (actualDeduct <= 0) {
    return { deducted: 0, status: 'ZERO_DEDUCTION_COMPUTED' };
  }

  // 4. Log the deduction with explicit columns & business_id / store_id
  const deductionId = 'DED-' + Math.floor(100000 + Math.random() * 900000);
  const insertLogSql = `INSERT INTO automated_deduction_logs (id, loan_id, source_transaction_id, amount_deducted, status, failure_reason, created_at, business_id, store_id) VALUES ('${deductionId}', '${sqlEsc(activeLoan.id)}', '${sqlEsc(orderId)}', ${actualDeduct.toFixed(2)}, 'SUCCESS', NULL, '${new Date().toISOString()}', '${sqlEsc(loanBizId)}', '${sqlEsc(loanStoreId)}')`;
  runSql(insertLogSql, "Sweep Trigger: Slice " + activeLoan.daily_deduction_percentage + "% from total " + orderTotal);

  // 5. Progressively update amortization schedule milestones
  const schedRes = runSql("SELECT * FROM loan_amortization_schedule WHERE loan_id = '" + sqlEsc(activeLoan.id) + "' AND is_settled = 0 ORDER BY installment_number ASC", 'Sweep: Grab active amortization milestones');
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
        const settleSql = "UPDATE loan_amortization_schedule SET amount_paid = " + milestoneDue.toFixed(2) + ", is_settled = 1, settled_at = '" + new Date().toISOString() + "' WHERE id = '" + sqlEsc(milestone.id) + "'";
        runSql(settleSql, "Sweep Allocation: Fully settled milestone #" + milestone.installment_number);
      } else {
        // Partially paid milestone
        const newPaid = milestonePaid + unallocatedFunds;
        unallocatedFunds = 0;
        const partialSql = "UPDATE loan_amortization_schedule SET amount_paid = " + newPaid.toFixed(2) + " WHERE id = '" + sqlEsc(milestone.id) + "'";
        runSql(partialSql, "Sweep Allocation: Credited partial amount to milestone #" + milestone.installment_number);
      }
    }
  }

  // 6. Check if loan is now fully paid off
  if (totalPaid + actualDeduct >= Number(activeLoan.total_repayable)) {
    runSql("UPDATE loans SET status = 'PAID_OFF', updated_at = '" + new Date().toISOString() + "' WHERE id = '" + sqlEsc(activeLoan.id) + "'", 'Sweep: Complete auto repayment lifecycle');
  }

  persistTablesToStorage();
  return { deducted: actualDeduct, status: 'SUCCESS', loanId: activeLoan.id };
}

// Persistent configuration tables
const LOCAL_STORAGE_KEY_PREFIX = 'android_pos_db_';
const CLEAN_SLATE_MIGRATION_KEY = 'pos_clean_slate_v5';

let cloudPushTimeout: any = null;

export function extractAllTablesSnapshot(explicitBusinessId?: string): Record<string, any[]> {
  const allTablesData: Record<string, any[]> = {};
  const targetBizId =
    explicitBusinessId && explicitBusinessId !== '__global__' && explicitBusinessId !== 'default_biz'
      ? explicitBusinessId.trim()
      : '';
  const defaultStoreId = getActiveStoreId(undefined, targetBizId);

  if (alasql && alasql.tables) {
    for (const tableName of ALL_TABLE_NAMES) {
      if (alasql.tables[tableName]) {
        try {
          const rows = alasql(`SELECT * FROM ${tableName}`) as any[];
          if (Array.isArray(rows)) {
            if (!targetBizId) {
              allTablesData[tableName] = rows;
            } else if (tableName === 'users') {
              const memberships = Array.isArray((alasql.tables as any)?.business_memberships?.data)
                ? ((alasql.tables as any).business_memberships.data as any[])
                : [];
              const allowedUserIds = new Set(
                memberships
                  .filter((m: any) => String(m?.business_id || '').trim() === targetBizId)
                  .map((m: any) => String(m?.user_id || '').trim())
                  .filter(Boolean)
              );
              allTablesData[tableName] = rows
                .filter((u: any) => allowedUserIds.has(String(u?.id || '').trim()) || String(u?.business_id || '').trim() === targetBizId)
                .map((u: any) => ({ ...u, business_id: u.business_id || targetBizId, store_id: u.store_id || defaultStoreId }));
            } else if (tableName === 'businesses') {
              allTablesData[tableName] = rows
                .filter((r: any) => String(r?.id || '') === targetBizId || String(r?.business_id || '') === targetBizId)
                .map((r: any) => ({ ...r, business_id: r.business_id || r.id || targetBizId, store_id: r.store_id || defaultStoreId }));
            } else if (tableName === 'accounts') {
              allTablesData[tableName] = rows.map((r: any) => ({
                ...r,
                business_id: r.business_id || targetBizId,
                store_id: r.store_id || 'all',
              }));
            } else {
              allTablesData[tableName] = rows
                .filter((r: any) => String(r?.business_id || '').trim() === targetBizId)
                .map((r: any) => ({
                  ...r,
                  business_id: targetBizId,
                  store_id: r.store_id || defaultStoreId,
                }));
            }
          }
        } catch {
          allTablesData[tableName] = [];
        }
      }
    }
  }
  return allTablesData;
}

export function persistTablesToStorage(_skipCloudSync: boolean = false) {
  try {
    const allTablesData: Record<string, any[]> = {};
    const sqliteCacheData: Record<string, any[]> = {};
    const sqliteScopeSet = new Set(SQLITE_SCOPED_TABLES);

    if (alasql && alasql.tables) {
      for (const tableName of ALL_TABLE_NAMES) {
        if (alasql.tables[tableName]) {
          try {
            const rows = alasql(`SELECT * FROM ${tableName}`) as any[];
            if (Array.isArray(rows)) {
              allTablesData[tableName] = rows;
              if (sqliteScopeSet.has(tableName)) {
                sqliteCacheData[tableName] = rows;
              }
            }
            // Store in localStorage for instant in-browser session fallback
            try {
              localStorage.setItem(`${LOCAL_STORAGE_KEY_PREFIX}${tableName}`, JSON.stringify(rows));
            } catch {
              // quota exceeded or restricted in WebView
            }
          } catch {
            // ignore table query errors
          }
        }
      }
    }
    // Asynchronously flush ONLY on-device cache & receipt tables to native SQLite / cache file
    registerPendingSync(sqliteCacheData);
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

  const activeBizId = getActiveBusinessId() || 'default_biz';
  historicalOrders.forEach((o, idx) => {
    const custVal = o.custId === null ? 'NULL' : o.custId;
    const store_id = getActiveStoreId(undefined, activeBizId);
    runSql(
      `INSERT INTO orders (id, customerId, orderDate, subtotal, tax, discount, total, paymentMethod, split_cash, split_momo, status, store_id, performed_by, business_id) VALUES ('${o.id}', ${custVal}, '${o.date}', ${o.sub}, ${o.tax}, ${o.dis}, ${o.tot}, '${o.pay}', 0, 0, 'Completed', '${sqlEsc(store_id)}', 'owner', '${sqlEsc(activeBizId)}')`,
      `Seed Data: Record historical invoice ${o.id}`
    );

    o.items.forEach((item, itemIdx) => {
      const detailsId = `${o.id}_${itemIdx}`;
      runSql(
        `INSERT INTO order_items (id, orderId, productId, quantity, unitPrice, business_id, store_id) VALUES ('${detailsId}', '${o.id}', ${item.prodId}, ${item.qty}, ${item.price}, '${sqlEsc(activeBizId)}', '${sqlEsc(store_id)}')`,
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
      clearingAcc = idx % 2 === 0 ? 'mtn-clearing-account-uuid' : 'airtel-clearing-account-uuid';
      channelName = clearingAcc === 'mtn-clearing-account-uuid' ? 'MTN_MOMO' : 'AIRTEL_MONEY';
    } else if (o.pay === 'Credit Card') {
      clearingAcc = 'airtel-clearing-account-uuid';
      channelName = 'CARD_VISA';
    }

    runSql(
      `INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by, business_id, store_id) VALUES ('${txId}', 'idemp-${txId}', 'POS-LUSAKA-MAIN', '${channelName}', 'PROVISION-REF', ${o.tot}, ${feeAmt}, 'SUCCESS', 'Simulated legacy historical POS order ${o.id}', '${dateStr}', '${dateStr}', 'owner', '${sqlEsc(activeBizId)}', '${sqlEsc(store_id)}')`,
      `Seed Ledger: Record journal historical ledger txn for order ${o.id}`
    );
    runSql(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at, business_id, store_id) VALUES ('le-${txId}-deb', '${txId}', '${clearingAcc}', 'DEBIT', ${o.tot}, '${dateStr}', '${sqlEsc(activeBizId)}', '${sqlEsc(store_id)}')`,
      `Seed Ledger: Debit Clearing Account`
    );
    runSql(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at, business_id, store_id) VALUES ('le-${txId}-cre-merch', '${txId}', 'merchant-wallet-account-uuid', 'CREDIT', ${settleAmt}, '${dateStr}', '${sqlEsc(activeBizId)}', '${sqlEsc(store_id)}')`,
      `Seed Ledger: Credit Merchant Wallet Liability`
    );
    runSql(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at, business_id, store_id) VALUES ('le-${txId}-cre-fees', '${txId}', 'platform-revenue-account-uuid', 'CREDIT', ${feeAmt}, '${dateStr}', '${sqlEsc(activeBizId)}', '${sqlEsc(store_id)}')`,
      `Seed Ledger: Credit Processing Revenues Accounts`
    );
  });
  persistTablesToStorage();
}

export function toLocalDateKey(rawDate?: any): string {
  if (rawDate === null || rawDate === undefined || rawDate === '') {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  const str = String(rawDate).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const d = new Date(typeof rawDate === 'number' ? rawDate : str);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

export function rehydrateAlasqlFromRecords(
  tablesData: Record<string, any[]>,
  options?: { businessId?: string; storeId?: string; preserveOtherBusinesses?: boolean }
) {
  if (!tablesData || typeof tablesData !== 'object') return;
  const dedupeTables = new Set([
    'users',
    'business_memberships',
    'businesses',
    'stores',
    'staff',
    'products',
    'store_products',
    'stock_transfers',
    'stock_takes',
    'stock_take_items',
    'customers',
    'orders',
    'order_items',
    'laybys',
    'layby_installments',
    'cash_ups',
    'accounts',
    'transactions',
    'ledger_entries',
    'time_attendance',
    'loans',
    'loan_amortization_schedule',
    'automated_deduction_logs',
    'expenses',
    'assets',
    'equity',
    'money_transfers',
    'double_entry_journal',
    'receipt_refund_ledger',
    'cash_flow_ledger',
    'payment_method_ledger',
    'financial_statements_ledger',
    'payment_methods',
    'audit_logs',
    'quotations',
    'suppliers',
    'purchases_transit',
    'transit_purchases',
    'zra_invoices',
    'zra_sync_queue',
  ]);
  const bizRows = Array.isArray(tablesData['businesses']) ? tablesData['businesses'] : [];
  const inferredBizId =
    options?.businessId ||
    (bizRows.find((b: any) => b?.id && b.id !== 'default_biz')?.id ? String(bizRows.find((b: any) => b?.id && b.id !== 'default_biz').id) : '') ||
    getActiveBusinessId();
  const storeRows = Array.isArray(tablesData['stores']) ? tablesData['stores'] : [];
  const inferredStoreId =
    options?.storeId ||
    (storeRows.find((s: any) => s?.id)?.id ? String(storeRows.find((s: any) => s?.id).id) : '') ||
    getActiveStoreId(undefined, inferredBizId);

  for (const [table, rows] of Object.entries(tablesData)) {
    if (!Array.isArray(rows)) continue;
    try {
      if (!alasql.tables || !alasql.tables[table]) continue;
      const tableObj = alasql.tables[table] as any;
      const tableCols: any[] = Array.isArray(tableObj.columns) ? tableObj.columns : [];
      const validColSet = tableCols.length > 0 ? new Set(tableCols.map((c: any) => c.columnid)) : null;
      const stampedRows = rows
        .filter((r: any) => r && typeof r === 'object')
        .map((r: any) => {
          const copy = { ...r };
          if (table === 'businesses') {
            if (!copy.business_id && copy.id) copy.business_id = String(copy.id);
            if (!copy.store_id) copy.store_id = inferredStoreId || 'main';
          } else if (table === 'stores') {
            if (!copy.business_id && inferredBizId) copy.business_id = inferredBizId;
            if (!copy.store_id && copy.id) copy.store_id = String(copy.id);
          } else {
            if (!copy.business_id && inferredBizId) copy.business_id = inferredBizId;
            if (!copy.store_id && inferredStoreId) copy.store_id = inferredStoreId;
          }
          return copy;
        });

      let mergedRows = stampedRows;
      if (options?.preserveOtherBusinesses && inferredBizId && table !== 'accounts') {
        const currentRows = Array.isArray(tableObj.data) ? tableObj.data : [];
        const otherBizRows = currentRows.filter((r: any) => {
          const rBiz = String(r?.business_id || r?.id || '').trim();
          return rBiz && rBiz !== inferredBizId;
        });
        mergedRows = [...otherBizRows, ...stampedRows];
      }

      let cleanRows = mergedRows;
      if (dedupeTables.has(table)) {
        const seen = new Set<string>();
        cleanRows = mergedRows.filter((r: any) => {
          if (!r || typeof r !== 'object') return false;
          if (r.id === undefined || r.id === null || r.id === '') return true;
          const k = String(r.id);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      alasql(`DELETE FROM ${table}`);
      for (const row of cleanRows) {
        if (!row || typeof row !== 'object') continue;
        const keys = Object.keys(row).filter(k => !validColSet || validColSet.has(k));
        if (keys.length === 0) continue;
        const placeholders = keys.map(() => '?').join(', ');
        const quotedKeys = keys.map(k => '`' + k + '`').join(', ');
        const values = keys.map(k => row[k]);
        alasql(`INSERT INTO ${table} (${quotedKeys}) VALUES (${placeholders})`, values);
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
  const legacyStoreIds = new Set(['lusaka', 'kitwe', 'ndola', 'store_main']);
  const legacyLaybyIds = new Set(['layby-1004', 'LBY-8082']);
  const legacyInstallmentIds = new Set(['inst-001', 'inst-002', 'inst-54859']);
  const legacyTxIds = new Set([
    'tx-999', 'tx-1000',
    'ledger_TXN-8801', 'ledger_TXN-8802', 'ledger_TXN-8803',
    'ledger_TXN-8798', 'ledger_TXN-8799', 'ledger_TXN-8800',
    'ledger_TXN-8795', 'ledger_TXN-8796', 'ledger_TXN-8797',
    'TX_AUDIT_1792321282567_rn0mx'
  ]);
  const legacyOrderIds = new Set([
    'TXN-8801', 'TXN-8802', 'TXN-8803', 'TXN-8798', 'TXN-8799', 'TXN-8800', 'TXN-8795', 'TXN-8796', 'TXN-8797'
  ]);
  const legacyLoanIds = new Set(['LOAN-001', 'LOAN-002']);

  if (Array.isArray(cleaned['businesses'])) {
    cleaned['businesses'] = cleaned['businesses'].filter(
      (b: any) => b?.id !== 'default_biz' && b?.email !== 'owner@pos.zm'
    );
  }
  if (Array.isArray(cleaned['stores'])) {
    cleaned['stores'] = cleaned['stores'].filter(
      (s: any) =>
        s?.business_id !== 'default_biz' &&
        !legacyStoreIds.has(String(s?.id || '').toLowerCase())
    );
  }
  const activeOrderIds = new Set(
    (Array.isArray(cleaned['orders']) ? cleaned['orders'] : [])
      .filter((o: any) => !legacyOrderIds.has(String(o?.id || '')))
      .map((o: any) => String(o?.id || ''))
  );
  if (Array.isArray(cleaned['store_products'])) {
    cleaned['store_products'] = cleaned['store_products'].filter(
      (sp: any) => !legacyStoreIds.has(String(sp?.store_id || '').toLowerCase())
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
  if (Array.isArray(cleaned['orders'])) {
    cleaned['orders'] = cleaned['orders'].filter(
      (o: any) => !legacyOrderIds.has(String(o?.id || ''))
    );
  }
  if (Array.isArray(cleaned['order_items'])) {
    cleaned['order_items'] = cleaned['order_items'].filter(
      (oi: any) => !legacyOrderIds.has(String(oi?.orderId || ''))
    );
  }
  if (Array.isArray(cleaned['laybys'])) {
    cleaned['laybys'] = cleaned['laybys'].filter(
      (l: any) =>
        !legacyLaybyIds.has(String(l?.id || '')) &&
        !['Jane Carter', 'Marcus Brody'].includes(String(l?.customer_name || ''))
    );
  }
  if (Array.isArray(cleaned['layby_installments'])) {
    cleaned['layby_installments'] = cleaned['layby_installments'].filter(
      (inst: any) =>
        !legacyLaybyIds.has(String(inst?.layby_id || '')) &&
        !legacyInstallmentIds.has(String(inst?.id || '')) &&
        String(inst?.received_by || '') !== 'Alice Mwansa'
    );
  }
  if (Array.isArray(cleaned['loans'])) {
    cleaned['loans'] = cleaned['loans'].filter(
      (l: any) => !legacyLoanIds.has(String(l?.id || '')) && String(l?.merchant_id || '') !== 'default_biz'
    );
  }
  if (Array.isArray(cleaned['loan_amortization_schedule'])) {
    cleaned['loan_amortization_schedule'] = cleaned['loan_amortization_schedule'].filter(
      (a: any) => !legacyLoanIds.has(String(a?.loan_id || '')) && !String(a?.id || '').startsWith('AMORT-1-')
    );
  }
  if (Array.isArray(cleaned['automated_deduction_logs'])) {
    cleaned['automated_deduction_logs'] = cleaned['automated_deduction_logs'].filter(
      (d: any) => !legacyLoanIds.has(String(d?.loan_id || '')) && !['DED-001', 'DED-002'].includes(String(d?.id || ''))
    );
  }
  if (Array.isArray(cleaned['quotations'])) {
    cleaned['quotations'] = cleaned['quotations'].filter(
      (q: any) => String(q?.id || '') !== 'QT-1025'
    );
  }
  if (Array.isArray(cleaned['double_entry_journal'])) {
    cleaned['double_entry_journal'] = cleaned['double_entry_journal'].filter(
      (j: any) =>
        !legacyLaybyIds.has(String(j?.reference || '')) &&
        !legacyOrderIds.has(String(j?.reference || '')) &&
        String(j?.reference || '') !== 'OPEN-INV-01' &&
        String(j?.id || '') !== 'JRN_LBY_INST_inst-54859' &&
        String(j?.id || '') !== 'JRN_OPENING_INVENTORY_CAPITAL'
    );
  }
  if (Array.isArray(cleaned['ledger_entries'])) {
    cleaned['ledger_entries'] = cleaned['ledger_entries'].filter(
      (le: any) =>
        !['le-1', 'le-2', 'le-3', 'le-4', 'le-5', 'le-6'].includes(String(le?.id || '')) &&
        !legacyTxIds.has(String(le?.transaction_id || '')) &&
        !String(le?.id || '').includes('OPENING_INVENTORY_CAPITAL') &&
        !String(le?.id || '').includes('inst-54859')
    );
  }
  if (Array.isArray(cleaned['receipt_refund_ledger'])) {
    cleaned['receipt_refund_ledger'] = cleaned['receipt_refund_ledger'].filter(
      (r: any) =>
        !legacyLaybyIds.has(String(r?.order_id || '')) &&
        !legacyOrderIds.has(String(r?.order_id || '')) &&
        !legacyStoreIds.has(String(r?.store_id || '').toLowerCase()) &&
        String(r?.id || '') !== 'RCPT_LBY_inst-54859'
    );
  }
  if (Array.isArray(cleaned['cash_flow_ledger'])) {
    cleaned['cash_flow_ledger'] = cleaned['cash_flow_ledger'].filter(
      (c: any) =>
        !legacyLaybyIds.has(String(c?.reference_id || '')) &&
        !legacyOrderIds.has(String(c?.reference_id || '')) &&
        !legacyStoreIds.has(String(c?.store_id || '').toLowerCase()) &&
        String(c?.id || '') !== 'CF_LBY_inst-54859'
    );
  }
  if (Array.isArray(cleaned['payment_method_ledger'])) {
    cleaned['payment_method_ledger'] = cleaned['payment_method_ledger'].filter(
      (p: any) => !legacyStoreIds.has(String(p?.store_id || '').toLowerCase())
    );
  }
  if (Array.isArray(cleaned['financial_statements_ledger'])) {
    cleaned['financial_statements_ledger'] = cleaned['financial_statements_ledger'].filter(
      (f: any) => !legacyStoreIds.has(String(f?.store_id || '').toLowerCase())
    );
  }
  if (Array.isArray(cleaned['cash_ups'])) {
    cleaned['cash_ups'] = cleaned['cash_ups'].filter(
      (c: any) => !legacyStoreIds.has(String(c?.store_id || '').toLowerCase())
    );
  }
  const legacyOperators = new Set([
    'alice mwansa',
    'brian banda',
    'alice@pos.zm',
    'brian@pos.zm',
    'chiposha conwell',
    'owner@pos.zm',
    'jane carter',
    'marcus brody',
  ]);
  if (Array.isArray(cleaned['audit_logs'])) {
    cleaned['audit_logs'] = cleaned['audit_logs'].filter(
      (a: any) =>
        String(a?.id || '') !== 'AUDIT_1792321282567_rn0mx' &&
        !String(a?.details || '').includes('LBY-8082') &&
        !legacyStoreIds.has(String(a?.store_id || '').toLowerCase()) &&
        !legacyOperators.has(String(a?.performed_by || '').trim().toLowerCase())
    );
  }
  if (Array.isArray(cleaned['transactions'])) {
    cleaned['transactions'] = cleaned['transactions'].filter((tx: any) => {
      const id = String(tx?.id || '');
      const provRef = String(tx?.provider_reference || '');
      const terminal = String(tx?.pos_terminal_id || '').toLowerCase();
      const perf = String(tx?.performed_by || '').trim().toLowerCase();
      if (legacyTxIds.has(id)) return false;
      if (legacyOperators.has(perf)) return false;
      if (String(tx?.narration || '').includes('LBY-8082')) return false;
      if (terminal.includes('pos-lusaka') || terminal.includes('pos-ndola') || terminal.includes('pos-kitwe')) {
        return false;
      }
      if (id.startsWith('tx_txn-') && provRef && !activeOrderIds.has(provRef)) {
        return false;
      }
      return true;
    });
  }
  return cleaned;
}

function hasAnyUserCreatedData(recovered: Record<string, any[]>): boolean {
  const userTables = ['businesses', 'stores', 'products', 'customers', 'orders', 'staff', 'expenses', 'laybys', 'quotations', 'loans', 'suppliers', 'purchases_transit'];
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

    // Multi-tenant decoupled users, memberships, businesses & Dynamic store parameters
    runSql('DROP TABLE IF EXISTS users', 'Clean database: Drops old users identity table');
    runSql('DROP TABLE IF EXISTS business_memberships', 'Clean database: Drops old business memberships table');
    runSql('DROP TABLE IF EXISTS businesses', 'Clean database: Drops old business accounts');
    runSql('DROP TABLE IF EXISTS stores', 'Clean database: Drops old stores');
    runSql('DROP TABLE IF EXISTS stock_takes', 'Clean database: Drops old stock takes');
    runSql('DROP TABLE IF EXISTS stock_take_items', 'Clean database: Drops old stock take items');
    runSql('DROP TABLE IF EXISTS expenses', 'Clean database: Drops old expenses');
    runSql('DROP TABLE IF EXISTS purchases_transit', 'Clean database: Drops old purchases transit');
    runSql('DROP TABLE IF EXISTS transit_purchases', 'Clean database: Drops old transit purchases');
    runSql('DROP TABLE IF EXISTS suppliers', 'Clean database: Drops old suppliers');
    runSql('DROP TABLE IF EXISTS money_transfers', 'Clean database: Drops old money transfers');
    runSql('DROP TABLE IF EXISTS assets', 'Clean database: Drops old assets');
    runSql('DROP TABLE IF EXISTS equity', 'Clean database: Drops old equity');
    runSql('DROP TABLE IF EXISTS double_entry_journal', 'Clean database: Drops old double entry journal');
    runSql('DROP TABLE IF EXISTS audit_logs', 'Clean database: Drops old audit logs');
    runSql('DROP TABLE IF EXISTS receipt_refund_ledger', 'Clean database: Drops old receipt_refund_ledger');
    runSql('DROP TABLE IF EXISTS cash_flow_ledger', 'Clean database: Drops old cash_flow_ledger');
    runSql('DROP TABLE IF EXISTS payment_method_ledger', 'Clean database: Drops old payment_method_ledger');
    runSql('DROP TABLE IF EXISTS financial_statements_ledger', 'Clean database: Drops old financial_statements_ledger');
    runSql('DROP TABLE IF EXISTS payment_methods', 'Clean database: Drops old payment_methods');

    // Decoupled global User Identity table (email + full_name only; credentials live per membership)
    runSql(`
      CREATE TABLE users (
        id STRING PRIMARY KEY,
        email STRING,
        full_name STRING,
        created_at STRING,
        updated_at STRING,
        business_id STRING,
        store_id STRING
      )
    `, 'Multi-Tenant Identity Schema: Create USERS table');

    // Many-to-Many Business Membership table with isolated per-business password/credential_hash and role
    runSql(`
      CREATE TABLE business_memberships (
        id STRING PRIMARY KEY,
        user_id STRING,
        business_id STRING,
        email STRING,
        full_name STRING,
        credential_hash STRING,
        password STRING,
        role STRING,
        store_id STRING,
        accessible_branches STRING,
        permissions_json STRING,
        status STRING,
        created_at STRING,
        updated_at STRING
      )
    `, 'Multi-Tenant Membership Schema: Create BUSINESS_MEMBERSHIPS table');

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
        billing_phone STRING,
        billing_email STRING,
        tpin STRING,
        currency STRING,
        tax_rate NUMERIC,
        role STRING,
        admin_role STRING,
        business_id STRING,
        store_id STRING
      )
    `, 'Multi-Business Schema: Create BUSINESSES table');

    // Create Store dynamic configuration container
    runSql(`
      CREATE TABLE stores (
        id STRING PRIMARY KEY,
        business_id STRING,
        name STRING,
        location STRING,
        phone STRING,
        email STRING,
        allow_discounts INT,
        allow_refunds INT,
        allow_laybys INT,
        require_manager_discount INT,
        stocktake_frequency STRING,
        store_id STRING
      )
    `, 'Multi-Business Schema: Create STORES table');

    // Create Stock Take tracking sheet containers
    runSql(`
      CREATE TABLE stock_takes (
        id STRING PRIMARY KEY,
        store_id STRING,
        taken_at STRING,
        performed_by STRING,
        status STRING,
        business_id STRING
      )
    `, 'Stocktake Schema: Create STOCK_TAKES table');

    runSql(`
      CREATE TABLE stock_take_items (
        id STRING PRIMARY KEY,
        stock_take_id STRING,
        product_id INT,
        recorded_stock INT,
        counted_stock INT,
        variance INT,
        business_id STRING,
        store_id STRING
      )
    `, 'Stocktake Schema: Create STOCK_TAKE_ITEMS mapping table');

    // Create core POS tables
    runSql(`
      CREATE TABLE products (
        id INT PRIMARY KEY,
        name STRING,
        description STRING,
        sku STRING UNIQUE,
        category STRING,
        price NUMERIC,
        cost NUMERIC,
        stock INT,
        imageUrl STRING,
        business_id STRING,
        is_service INT DEFAULT 0,
        batch_number STRING,
        expiry_date STRING,
        item_cls_cd STRING,
        tax_ty_cd STRING,
        store_id STRING
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
        business_id STRING,
        store_id STRING
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
        split_cash NUMERIC,
        split_momo NUMERIC,
        status STRING,
        store_id STRING,
        performed_by STRING,
        business_id STRING
      )
    `, 'Durable Schema: Create ORDERS table');

    runSql(`
      CREATE TABLE order_items (
        id STRING PRIMARY KEY,
        orderId STRING,
        productId INT,
        quantity INT,
        unitPrice NUMERIC,
        business_id STRING,
        store_id STRING
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
        updated_at STRING,
        business_id STRING,
        store_id STRING
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
        performed_by STRING,
        business_id STRING,
        store_id STRING
      )
    `, 'Durable Schema: Create TRANSACTIONS journal table');

    runSql(`
      CREATE TABLE ledger_entries (
        id STRING PRIMARY KEY,
        transaction_id STRING,
        account_id STRING,
        type STRING,
        amount NUMERIC,
        created_at STRING,
        business_id STRING,
        store_id STRING
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
      store_id STRING,
      business_id STRING
    )
  `, 'Durable Schema: Create LAYBYS layaway tracking table');

  runSql(`
    CREATE TABLE layby_installments (
      id STRING PRIMARY KEY,
      layby_id STRING,
      amount NUMERIC,
      payment_method STRING,
      received_by STRING,
      created_at STRING,
      business_id STRING,
      store_id STRING
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
      status STRING,
      business_id STRING,
      store_id STRING
    )
  `, 'Durable Schema: Create TIME_ATTENDANCE payroll sync table');

  runSql(`
    CREATE TABLE staff (
      id STRING PRIMARY KEY,
      name STRING,
      role STRING,
      hourly_rate NUMERIC,
      pin STRING,
      store_id STRING,
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
      price NUMERIC,
      business_id STRING
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
      rejection_reason STRING,
      business_id STRING,
      store_id STRING
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
      created_at STRING,
      business_id STRING
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
      created_at STRING,
      updated_at STRING,
      extra_json STRING,
      business_id STRING,
      store_id STRING
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
      updated_at STRING,
      business_id STRING,
      store_id STRING
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
      settled_at STRING,
      business_id STRING,
      store_id STRING
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
      created_at STRING,
      business_id STRING,
      store_id STRING
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
      created_at STRING,
      business_id STRING
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
      created_at STRING,
      business_id STRING
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
      received_by STRING,
      business_id STRING
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
      received_by STRING,
      business_id STRING
    )
  `, 'Durable Schema: Create TRANSIT_PURCHASES procurement table');

  runSql(`
    CREATE TABLE suppliers (
      id STRING PRIMARY KEY,
      name STRING,
      contact_person STRING,
      phone STRING,
      email STRING,
      address STRING,
      tpin STRING,
      payment_terms STRING,
      default_payment_method STRING,
      notes STRING,
      created_at STRING,
      updated_at STRING,
      business_id STRING,
      store_id STRING
    )
  `, 'Durable Schema: Create SUPPLIERS directory table');

  runSql(`
    CREATE TABLE money_transfers (
      id STRING PRIMARY KEY,
      source_account STRING,
      dest_account STRING,
      amount NUMERIC,
      reference_no STRING,
      transfer_date STRING,
      performed_by STRING,
      notes STRING,
      business_id STRING,
      store_id STRING
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
      linked_equity_id STRING,
      business_id STRING,
      store_id STRING,
      asset_tag STRING,
      serial_number STRING,
      useful_life_years NUMERIC,
      salvage_value NUMERIC,
      funding_source STRING,
      disposal_date STRING,
      disposal_proceeds NUMERIC,
      updated_at STRING
    )
  `, 'Durable Schema: Create ASSETS balance sheet table');

  runSql(`
    CREATE TABLE equity (
      id STRING PRIMARY KEY,
      name STRING,
      value NUMERIC,
      linked_asset_id STRING,
      business_id STRING,
      store_id STRING,
      equity_type STRING,
      shareholder_name STRING,
      contribution_date STRING,
      account_id STRING,
      reference_no STRING,
      notes STRING,
      status STRING,
      created_at STRING
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
      currency STRING,
      business_id STRING,
      store_id STRING
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
      created_at STRING,
      business_id STRING
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
      created_at STRING,
      business_id STRING
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
      updated_at STRING,
      business_id STRING
    )
  `, 'Durable Schema: Create PAYMENT_METHOD_LEDGER table');

  runSql(`
    CREATE TABLE payment_methods (
      id STRING PRIMARY KEY,
      name STRING,
      category STRING,
      account_id STRING,
      is_active INT,
      created_by STRING,
      created_at STRING,
      business_id STRING,
      store_id STRING
    )
  `, 'Durable Schema: Create PAYMENT_METHODS custom payment channels table');

  runSql(`
    CREATE TABLE zra_invoices (
      id STRING PRIMARY KEY,
      order_id STRING,
      status STRING,
      tpin STRING,
      bhf_id STRING,
      sdc_id STRING,
      mrc_no STRING,
      rcpt_no INT,
      cis_invc_no STRING,
      intrl_data STRING,
      rcpt_sign STRING,
      qr_code_url STRING,
      vsdc_date STRING,
      payload_json STRING,
      record_json STRING,
      created_at STRING,
      updated_at STRING,
      business_id STRING,
      store_id STRING
    )
  `, 'Durable Schema: Create ZRA_INVOICES fiscal audit table');

  runSql(`
    CREATE TABLE zra_sync_queue (
      id STRING PRIMARY KEY,
      order_id STRING,
      endpoint STRING,
      payload_json STRING,
      sale_json STRING,
      retry_count INT,
      last_error STRING,
      created_at STRING,
      business_id STRING,
      store_id STRING
    )
  `, 'Durable Schema: Create ZRA_SYNC_QUEUE offline retry table');

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
      updated_at STRING,
      business_id STRING
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

  // Trigger background SQLite on-device cache & receipt store initialization
  initSqliteStorage().then(async (ready) => {
    if (ready && !forceReset && !hasRecoveredData) {
      try {
        const rawPersistentData = await loadTablesFromPersistentStorage();
        const persistentData = rawPersistentData ? scrubLegacyPreseededRows(rawPersistentData) : null;
        if (persistentData && !isLegacyPreseededSnapshot(rawPersistentData || {}) && hasAnyUserCreatedData(persistentData)) {
          console.log('[DB] Hydrated on-device catalog & receipt cache from SQLite');
          rehydrateAlasqlFromRecords(persistentData);
          syncAllAccountingSystems('SQLite Cache Rehydration');
          notifySqlLogsUpdated();
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('database-rehydrated'));
            window.dispatchEvent(new Event('pos_data_updated'));
          }
        }
      } catch (sqErr) {
        console.warn('[DB] SQLite cache background rehydrate error:', sqErr);
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
    syncUsersAndMembershipsFromLegacyTables();
    syncAllAccountingSystems('Database Initialization');
    persistTablesToStorage(true);
  }
}

export function seedChartOfAccountsOnly(explicitBusinessId?: string) {
  const accountsToSeed = [
    { id: 'acc_cash', name: 'Cash Account (Counter Drawer)', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_airtel', name: 'Airtel Money Account', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_mtn', name: 'MTN Mobile Money Account', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_momo', name: 'Mobile Wallet Account (General)', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_bank', name: 'Commercial Bank & Card Settlement Account', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_transit', name: 'Goods in Transit Asset', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_inventory', name: 'Store Merchandise Inventory Asset', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_fixed_assets', name: 'Fixed Equipment & Property Assets', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_vat_payable', name: 'VAT / Tax Output Payable (ZRA)', type: 'LIABILITY', cur: 'ZMW' },
    { id: 'acc_layby_deposits', name: 'Customer Layby Unearned Deposits', type: 'LIABILITY', cur: 'ZMW' },
    { id: 'acc_loans_payable', name: 'Working Capital Loans Payable', type: 'LIABILITY', cur: 'ZMW' },
    { id: 'acc_sales_revenue', name: 'Gross Sales Revenue', type: 'REVENUE', cur: 'ZMW' },
    { id: 'acc_sales_returns', name: 'Sales Returns, Refunds & Allowances', type: 'EXPENSE', cur: 'ZMW' },
    { id: 'acc_sales_discounts', name: 'Sales Discounts Allowed', type: 'EXPENSE', cur: 'ZMW' },
    { id: 'acc_retained_earnings', name: 'Owner Equity & Retained Earnings', type: 'EQUITY', cur: 'ZMW' },
    { id: 'acc_owner_capital', name: 'Owner Paid-In Capital Equity', type: 'EQUITY', cur: 'ZMW' },
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
  const activeBizId = getActiveBusinessId(explicitBusinessId);
  const existingIds = new Set(
    ((alasql?.tables?.accounts?.data || []) as any[]).map((a: any) => String(a.id || ''))
  );
  accountsToSeed.forEach(acc => {
    if (existingIds.has(acc.id)) return;
    runSql(
      `INSERT INTO accounts (id, name, type, currency, merchant_id, created_at, updated_at, business_id, store_id) VALUES ('${acc.id}', '${sqlEsc(acc.name)}', '${acc.type}', '${acc.cur}', '${sqlEsc(activeBizId)}', '${nowIso}', '${nowIso}', '${sqlEsc(activeBizId)}', 'all')`,
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
    INSERT INTO businesses (id, name, owner, email, password, created_at, business_id, store_id) VALUES (
      'default_biz',
      'Zambia Retail POS',
      'Chiposha Conwell',
      'owner@pos.zm',
      'admin123',
      '2026-06-07T14:00:00Z',
      'default_biz',
      'main'
    )
  `, 'Seed Data: Insert default business profile');

  // Do not create any branch in advance; branches are only created by the user in the central stores table

  customersToInsert.forEach(c => {
    runSql(
      `INSERT INTO customers (id, name, phone, email, loyalPoints, tpin, zra_connected, tax_band, business_id, store_id) VALUES (${c.id}, '${c.name.replace(/'/g, "''")}', '${c.phone}', '${c.email}', ${c.loyalPoints}, '${c.tpin}', ${c.zra_connected}, '${c.tax_band}', 'default_biz', 'main')`,
      `Seed Data: Insert customer ${c.name} with compliant ZRA TPIN`
    );
  });

  productsToInsert.forEach(p => {
    runSql(
      `INSERT INTO products (id, name, sku, category, price, cost, stock, imageUrl, business_id, is_service, batch_number, expiry_date, store_id) VALUES (${p.id}, '${p.name.replace(/'/g, "''")}', '${p.sku}', '${p.category}', ${p.price}, ${p.cost}, ${p.stock}, '${p.imageUrl}', 'default_biz', ${p.is_service || 0}, '${p.batch_number || ''}', '${p.expiry_date || ''}', 'main')`,
      `Seed Data: Insert product ${p.name}`
    );
  });

  // Seed double entry accounts in both ledger sandbox mode and as empty shells in standard shop layouts
  const accountsToSeed = [
    { id: 'acc_cash', name: 'Cash Account (Counter Drawer)', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_airtel', name: 'Airtel Money Account', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_mtn', name: 'MTN Mobile Money Account', type: 'ASSET', cur: 'ZMW' },
    { id: 'acc_momo', name: 'Mobile Wallet Account (General)', type: 'ASSET', cur: 'ZMW' },
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
      `INSERT INTO accounts (id, name, type, currency, merchant_id, created_at, updated_at, business_id, store_id) VALUES ('${acc.id}', '${sqlEsc(acc.name)}', '${acc.type}', '${acc.cur}', 'default_biz', '2026-06-07T12:00:00Z', '2026-06-07T12:00:00Z', 'default_biz', 'all')`,
      `Seed Double Entry: Register Ledger Account [${acc.name}]`
    );
  });

  // Double-entry journal, ledger_entries, transactions, loans, schedules, and staff accounts always start empty (no preseeded staff profiles).
}

// ==========================================
// CENTRALIZED CUSTOMER CRM SYNCHRONIZATION
// ==========================================
export interface CustomerSyncData {
  id?: number;
  name: string;
  phone?: string;
  email?: string;
  tpin?: string;
  loyalPointsDelta?: number;
  zra_connected?: number;
  tax_band?: string;
}

export function isWalkInCustomerName(name?: string | null): boolean {
  if (!name) return true;
  const normalized = String(name).trim().toLowerCase();
  return (
    !normalized ||
    normalized === 'general walk-in client' ||
    normalized === 'walk-in client' ||
    normalized === 'walk-in customer' ||
    normalized === 'guest' ||
    normalized === 'anonymous'
  );
}

export function getConfiguredLoyaltyRatio(overrideRatio?: number | string | null): number {
  if (overrideRatio !== undefined && overrideRatio !== null && overrideRatio !== '') {
    const parsed = Number(overrideRatio);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem('android_pos_settings');
      if (saved) {
        const parsedSettings = JSON.parse(saved);
        const ratio = Number(parsedSettings?.loyaltyRatio);
        if (Number.isFinite(ratio)) {
          return Math.max(0, ratio);
        }
      }
    } catch {}
  }
  return 0;
}

export function calculateLoyaltyPoints(amount: number, overrideRatio?: number | string | null): number {
  const numericAmount = Number(amount);
  const ratio = getConfiguredLoyaltyRatio(overrideRatio);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0 || ratio <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(Number((numericAmount * ratio).toFixed(6))));
}

export function upsertCustomerSync(data: CustomerSyncData): any {
  if (!data || !data.name || !data.name.trim() || isWalkInCustomerName(data.name)) return null;
  const cleanName = data.name.trim();
  const cleanPhone = (data.phone || '').trim();
  const cleanEmail = (data.email || '').trim();
  const cleanTpin = (data.tpin || '').trim();
  const activeBizId = getActiveBusinessId();
  const activeStoreId = getActiveStoreId(undefined, activeBizId);

  // Search for existing customer strictly inside the current business
  let existing: any = null;
  const custQuery = activeBizId
    ? `SELECT * FROM customers WHERE business_id = '${sqlEsc(activeBizId)}'`
    : 'SELECT * FROM customers';
  const allCustsRes = runSql(custQuery, 'CRM Sync: Fetch customers for lookup');
  if (allCustsRes.success && Array.isArray(allCustsRes.data)) {
    if (data.id !== undefined && data.id !== null) {
      existing = allCustsRes.data.find((c: any) => Number(c.id) === Number(data.id));
    }
    if (!existing && cleanPhone && cleanPhone !== 'N/A' && cleanPhone.length >= 6) {
      const normalizedInputPhone = cleanPhone.replace(/[\s\-\+\(\)]/g, '');
      existing = allCustsRes.data.find((c: any) => c.phone && c.phone.replace(/[\s\-\+\(\)]/g, '') === normalizedInputPhone);
    }
    if (!existing) {
      existing = allCustsRes.data.find((c: any) => c.name && c.name.toLowerCase() === cleanName.toLowerCase());
    }
  }

  const pointsToAdd = Math.max(0, Math.round(data.loyalPointsDelta || 0));

  if (existing) {
    const custId = existing.id;
    const newPhone = cleanPhone && cleanPhone !== 'N/A' ? cleanPhone : (existing.phone || '');
    const newEmail = cleanEmail && cleanEmail !== 'N/A' ? cleanEmail : (existing.email || '');
    const newTpin = cleanTpin ? cleanTpin : (existing.tpin || '');
    const newPoints = Math.max(0, Number(existing.loyalPoints || 0) + pointsToAdd);

    const updateSql = `
      UPDATE customers 
      SET name = '${sqlEsc(cleanName)}',
          phone = '${sqlEsc(newPhone)}',
          email = '${sqlEsc(newEmail)}',
          tpin = '${sqlEsc(newTpin)}',
          loyalPoints = ${newPoints},
          business_id = '${sqlEsc(activeBizId || existing.business_id || '')}',
          store_id = '${sqlEsc(existing.store_id || activeStoreId)}'
      WHERE id = ${custId}
    `;
    runSql(updateSql, `CRM Sync: Update customer #${custId} [${cleanName}]`);
    persistTablesToStorage();
    return {
      ...existing,
      id: custId,
      name: cleanName,
      phone: newPhone,
      email: newEmail,
      tpin: newTpin,
      loyalPoints: newPoints,
      business_id: activeBizId || existing.business_id || '',
      store_id: existing.store_id || activeStoreId,
    };
  } else {
    // Insert new customer starting strictly at 0 + earned delta from checkout
    const newCustId = 500 + Math.floor(Math.random() * 950000);
    const initialPoints = pointsToAdd;
    const insertSql = `
      INSERT INTO customers (id, name, phone, email, loyalPoints, tpin, zra_connected, tax_band, business_id, store_id)
      VALUES (
        ${newCustId},
        '${sqlEsc(cleanName)}',
        '${sqlEsc(cleanPhone || 'N/A')}',
        '${sqlEsc(cleanEmail || 'N/A')}',
        ${initialPoints},
        '${sqlEsc(cleanTpin)}',
        ${data.zra_connected || 0},
        '${sqlEsc(data.tax_band || 'A - Standard Rate (16%)')}',
        '${sqlEsc(activeBizId)}',
        '${sqlEsc(activeStoreId)}'
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
      business_id: activeBizId,
      store_id: activeStoreId
    };
  }
}

// ==========================================
// CENTRAL BRANCHES DATABASE ACCESSOR (SINGLE SOURCE OF TRUTH)
// ==========================================
export function getCentralBranches(businessId?: string): Array<{
  id: string;
  business_id?: string;
  store_id?: string;
  name: string;
  location?: string;
  phone?: string;
  email?: string;
  allow_discounts?: number;
  allow_refunds?: number;
  allow_laybys?: number;
  require_manager_discount?: number;
  stocktake_frequency?: string;
}> {
  try {
    const targetBizId = getActiveBusinessId(businessId);
    const sql = targetBizId
      ? `SELECT * FROM stores WHERE business_id = '${sqlEsc(targetBizId)}'`
      : 'SELECT * FROM stores';
    const allRes = runSql(sql, 'Central Branches DB: Fetch business branches', true);
    const rawStores = (allRes.success && Array.isArray(allRes.data)) ? allRes.data : [];
    const seenStoreIds = new Set<string>();
    const filteredStores = rawStores.filter((s: any) => {
      const id = String(s?.id || '');
      if (!id || seenStoreIds.has(id)) return false;
      if (targetBizId && String(s?.business_id || '') !== targetBizId) return false;
      seenStoreIds.add(id);
      return true;
    });
    return filteredStores;
  } catch {
    return [];
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
    const activeBizId = getActiveBusinessId();
    const sessionUser =
      (typeof localStorage !== 'undefined' &&
        (localStorage.getItem('logged_in_user_name') || localStorage.getItem('logged_in_user_email'))) ||
      '';
    const genericRoles = new Set(['owner', 'manager', 'sales', 'finance admin', 'staff operator', 'admin', 'system']);
    const rawPerformed = (performedBy || '').trim();
    const user =
      !rawPerformed || genericRoles.has(rawPerformed.toLowerCase())
        ? sessionUser || rawPerformed || 'Staff Operator'
        : rawPerformed;
    const store = getActiveStoreId(storeId, activeBizId);
    const cleanAction = sqlEsc(action);
    const cleanDetails = sqlEsc(details);
    const cleanUser = sqlEsc(user);

    runSql(`
      INSERT INTO audit_logs (id, module, action, details, amount, store_id, performed_by, created_at, business_id)
      VALUES ('${id}', '${module}', '${cleanAction}', '${cleanDetails}', ${amount}, '${sqlEsc(store)}', '${cleanUser}', '${nowStr}', '${sqlEsc(activeBizId)}')
    `, `Audit Trail: [${module}] ${action} by ${user}`);

    // Also mirror into transactions journal for financial ledger traceability
    const txId = `TX_${id}`;
    runSql(`
      INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by, business_id, store_id)
      VALUES ('${txId}', 'idem_${txId}', 'AUDIT_TRAIL', '${module}', '${id}', ${amount}, 0.00, 'SUCCESS', '[${module}] ${cleanAction} - ${cleanDetails}', '${nowStr}', '${nowStr}', '${cleanUser}', '${sqlEsc(activeBizId)}', '${sqlEsc(store)}')
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

function readSettingsCustomPaymentMethods(): CustomPaymentMethod[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem('android_pos_settings');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.customPaymentMethods) ? parsed.customPaymentMethods : [];
  } catch {
    return [];
  }
}

function writeSettingsCustomPaymentMethods(methods: CustomPaymentMethod[]) {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem('android_pos_settings');
    const parsed = raw ? JSON.parse(raw) : {};
    parsed.customPaymentMethods = methods;
    localStorage.setItem('android_pos_settings', JSON.stringify(parsed));
  } catch {}
}

export function getCustomPaymentMethods(includeInactive: boolean = false): CustomPaymentMethod[] {
  const mergedMap = new Map<string, CustomPaymentMethod>();
  const activeBizId = getActiveBusinessId();
  if (alasql?.tables?.payment_methods) {
    try {
      const pmSql = activeBizId
        ? `SELECT * FROM payment_methods WHERE business_id = '${sqlEsc(activeBizId)}'`
        : 'SELECT * FROM payment_methods';
      const rows = alasql(pmSql) as any[];
      if (Array.isArray(rows)) {
        rows.forEach((r: any) => {
          if (!r || !r.name) return;
          const id = String(r.id || `pm_${String(r.name).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`);
          mergedMap.set(id, {
            id,
            name: String(r.name),
            category: (r.category || 'Other') as CustomPaymentMethod['category'],
            accountId: String(r.account_id || `acc_pm_${String(r.name).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`),
            isActive: Number(r.is_active ?? 1) === 1,
            createdAt: String(r.created_at || ''),
            createdBy: r.created_by ? String(r.created_by) : undefined,
          });
        });
      }
    } catch {}
  }

  for (const sm of readSettingsCustomPaymentMethods()) {
    if (!sm || !sm.name) continue;
    if (!mergedMap.has(sm.id)) {
      mergedMap.set(sm.id, sm);
    }
  }

  const all = Array.from(mergedMap.values());
  return includeInactive ? all : all.filter(m => m.isActive);
}

export function saveCustomPaymentMethod(
  name: string,
  category: CustomPaymentMethod['category'],
  createdBy: string = 'Admin'
): { success: boolean; method?: CustomPaymentMethod; error?: string } {
  const cleanName = name.trim();
  if (!cleanName) {
    return { success: false, error: 'Payment method name is required.' };
  }

  const builtInLower = new Set([
    'cash',
    'airtel',
    'airtel money',
    'mtn',
    'mtn money',
    'mtn mobile money',
    'credit card',
    'credit card / bank',
    'bank / card',
    'split',
    'mobile wallet',
  ]);
  if (builtInLower.has(cleanName.toLowerCase())) {
    return { success: false, error: `"${cleanName}" is already a built-in payment channel.` };
  }

  const existing = getCustomPaymentMethods(true);
  if (existing.some(m => m.name.toLowerCase() === cleanName.toLowerCase())) {
    return { success: false, error: `Payment method "${cleanName}" already exists.` };
  }

  const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'custom';
  let accountId = `acc_pm_${slug}`;
  if (existing.some(m => m.accountId === accountId)) {
    accountId = `acc_pm_${slug}_${Date.now().toString().slice(-4)}`;
  }
  const id = `pm_${slug}_${Math.floor(100 + Math.random() * 900)}`;
  const nowIso = new Date().toISOString();
  const activeBizId = getActiveBusinessId();
  const activeStoreId = getActiveStoreId(undefined, activeBizId);

  const newMethod: CustomPaymentMethod = {
    id,
    name: cleanName,
    category,
    accountId,
    isActive: true,
    createdAt: nowIso,
    createdBy,
  };

  runSql(
    `CREATE TABLE IF NOT EXISTS payment_methods (
      id STRING PRIMARY KEY, name STRING, category STRING, account_id STRING,
      is_active INT, created_by STRING, created_at STRING, business_id STRING, store_id STRING
    )`,
    'Ensure payment_methods table',
    true
  );

  runSql(
    `INSERT INTO payment_methods (id, name, category, account_id, is_active, created_by, created_at, business_id, store_id)
     VALUES ('${id}', '${sqlEsc(cleanName)}', '${sqlEsc(category)}', '${accountId}', 1, '${sqlEsc(createdBy)}', '${nowIso}', '${sqlEsc(activeBizId)}', '${sqlEsc(activeStoreId)}')`,
    `Admin: Create custom payment method [${cleanName}]`
  );

  const accRes = runSql(`SELECT id FROM accounts WHERE id = '${accountId}'`, 'Check custom payment account', true);
  if (!accRes.success || !Array.isArray(accRes.data) || accRes.data.length === 0) {
    runSql(
      `INSERT INTO accounts (id, name, type, currency, merchant_id, created_at, updated_at, business_id, store_id) VALUES ('${accountId}', '${sqlEsc(cleanName)} (${category})', 'ASSET', 'ZMW', '${sqlEsc(activeBizId)}', '${nowIso}', '${nowIso}', '${sqlEsc(activeBizId)}', 'all')`,
      `Chart of Accounts: Register [${cleanName}]`,
      true
    );
  }

  writeSettingsCustomPaymentMethods([...existing, newMethod]);
  syncAllAccountingSystems(`Created Payment Method: ${cleanName}`);
  persistTablesToStorage();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('pos_data_updated'));
  }
  return { success: true, method: newMethod };
}

export function toggleCustomPaymentMethod(id: string, isActive: boolean): CustomPaymentMethod[] {
  runSql(
    `UPDATE payment_methods SET is_active = ${isActive ? 1 : 0} WHERE id = '${id.replace(/'/g, "''")}'`,
    `Admin: Toggle custom payment method ${id}`
  );
  const updated = getCustomPaymentMethods(true).map(m => (m.id === id ? { ...m, isActive } : m));
  writeSettingsCustomPaymentMethods(updated);
  syncAllAccountingSystems('Payment Method Toggled');
  persistTablesToStorage();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('pos_data_updated'));
  }
  return updated;
}

export function deleteCustomPaymentMethod(id: string): CustomPaymentMethod[] {
  runSql(
    `DELETE FROM payment_methods WHERE id = '${id.replace(/'/g, "''")}'`,
    `Admin: Remove custom payment method ${id}`
  );
  const updated = getCustomPaymentMethods(true).filter(m => m.id !== id);
  writeSettingsCustomPaymentMethods(updated);
  syncAllAccountingSystems('Payment Method Removed');
  persistTablesToStorage();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('pos_data_updated'));
  }
  return updated;
}

export function getMobileMoneyOptions(): Array<{
  name: string;
  accountId: string;
  clearingAccountId: string;
  channel: string;
  isCustom: boolean;
}> {
  const builtIn = [
    {
      name: 'Airtel Money',
      accountId: 'acc_airtel',
      clearingAccountId: 'airtel-clearing-account-uuid',
      channel: 'AIRTEL_MONEY',
      isCustom: false,
    },
    {
      name: 'MTN Mobile Money',
      accountId: 'acc_mtn',
      clearingAccountId: 'mtn-clearing-account-uuid',
      channel: 'MTN_MOMO',
      isCustom: false,
    },
  ];
  const customMomo = getCustomPaymentMethods(false)
    .filter(m => m.category === 'Mobile Money')
    .map(m => ({
      name: m.name,
      accountId: m.accountId,
      clearingAccountId: 'mtn-clearing-account-uuid',
      channel: `CUSTOM_${m.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
      isCustom: true,
    }));
  return [...builtIn, ...customMomo];
}

export function getAllSelectableAccounts(): Array<{
  accountId: string;
  label: string;
  category: string;
  isCustom: boolean;
}> {
  const base = [
    { accountId: 'acc_cash', label: 'Cash Drawer Account', category: 'Cash', isCustom: false },
    { accountId: 'acc_airtel', label: 'Airtel Money Account', category: 'Mobile Money', isCustom: false },
    { accountId: 'acc_mtn', label: 'MTN Mobile Money Account', category: 'Mobile Money', isCustom: false },
    { accountId: 'acc_bank', label: 'Commercial Bank Account', category: 'Bank / Card', isCustom: false },
  ];
  const custom = getCustomPaymentMethods(false).map(m => ({
    accountId: m.accountId,
    label: `${m.name} (${m.category})`,
    category: m.category,
    isCustom: true,
  }));
  return [...base, ...custom];
}

export function resolvePaymentMethodBucket(rawMethod: any): {
  bucket: string;
  accountId: string;
  clearingAccountId: string;
  category: 'Cash' | 'Mobile Money' | 'Bank / Card' | 'Split' | 'Other';
} {
  const raw = String(rawMethod || 'Cash').trim();
  const m = raw.toLowerCase();

  if (m === 'split' || m.includes('split')) {
    return { bucket: 'Split', accountId: 'acc_cash', clearingAccountId: 'cash-clearing-account-uuid', category: 'Split' };
  }

  // Match Admin-created custom payment methods first (active or historical)
  const customMethods = getCustomPaymentMethods(true);
  const customMatch = customMethods.find(
    cm => cm.name.toLowerCase() === m || cm.accountId.toLowerCase() === m
  );
  if (customMatch) {
    const clr =
      customMatch.category === 'Cash'
        ? 'cash-clearing-account-uuid'
        : customMatch.category === 'Bank / Card'
          ? 'airtel-clearing-account-uuid'
          : 'mtn-clearing-account-uuid';
    return {
      bucket: customMatch.name,
      accountId: customMatch.accountId,
      clearingAccountId: clr,
      category: customMatch.category,
    };
  }

  if (m.includes('mtn') || m === 'acc_mtn') {
    return { bucket: 'MTN Mobile Money', accountId: 'acc_mtn', clearingAccountId: 'mtn-clearing-account-uuid', category: 'Mobile Money' };
  }
  if (m.includes('airtel') || m === 'acc_airtel') {
    return { bucket: 'Airtel Money', accountId: 'acc_airtel', clearingAccountId: 'airtel-clearing-account-uuid', category: 'Mobile Money' };
  }
  if (m.includes('mobile') || m.includes('momo') || m.includes('wallet') || m === 'acc_momo') {
    return { bucket: 'Mobile Wallet', accountId: 'acc_momo', clearingAccountId: 'mtn-clearing-account-uuid', category: 'Mobile Money' };
  }
  if (m.includes('card') || m.includes('credit') || m.includes('visa') || m.includes('bank') || m.includes('pos') || m.includes('transfer') || m.includes('cheque') || m === 'acc_bank') {
    return { bucket: 'Credit Card / Bank', accountId: 'acc_bank', clearingAccountId: 'airtel-clearing-account-uuid', category: 'Bank / Card' };
  }
  if (m === 'cash' || m === 'acc_cash' || !m) {
    return { bucket: 'Cash', accountId: 'acc_cash', clearingAccountId: 'cash-clearing-account-uuid', category: 'Cash' };
  }

  // Preserve custom string from historical/adhoc method names
  return { bucket: raw, accountId: 'acc_bank', clearingAccountId: 'airtel-clearing-account-uuid', category: 'Other' };
}

export function resolveSplitMobileProvider(
  rawMethod: any,
  txEntries?: Array<{ account_id?: string; type?: string }>
): {
  bucket: string;
  accountId: string;
  clearingAccountId: string;
} {
  const raw = String(rawMethod || '');
  const plusIdx = raw.indexOf('+');
  if (plusIdx !== -1) {
    const providerRaw = raw.slice(plusIdx + 1).replace(/\)+$/, '').trim();
    if (providerRaw && !providerRaw.toLowerCase().includes('split')) {
      const resolved = resolvePaymentMethodBucket(providerRaw);
      if (resolved.bucket !== 'Cash' && resolved.bucket !== 'Split') {
        return {
          bucket: resolved.bucket,
          accountId: resolved.accountId,
          clearingAccountId: resolved.clearingAccountId,
        };
      }
    }
  }

  const m = raw.toLowerCase();
  if (m.includes('airtel')) {
    return { bucket: 'Airtel Money', accountId: 'acc_airtel', clearingAccountId: 'airtel-clearing-account-uuid' };
  }
  if (m.includes('mtn')) {
    return { bucket: 'MTN Mobile Money', accountId: 'acc_mtn', clearingAccountId: 'mtn-clearing-account-uuid' };
  }

  if (Array.isArray(txEntries)) {
    const debits = txEntries.filter(le => le.type === 'DEBIT');
    for (const le of debits) {
      if (le.account_id === 'acc_airtel' || le.account_id === 'airtel-clearing-account-uuid') {
        return { bucket: 'Airtel Money', accountId: 'acc_airtel', clearingAccountId: 'airtel-clearing-account-uuid' };
      }
      if (le.account_id === 'acc_mtn' || le.account_id === 'mtn-clearing-account-uuid') {
        return { bucket: 'MTN Mobile Money', accountId: 'acc_mtn', clearingAccountId: 'mtn-clearing-account-uuid' };
      }
      if (String(le.account_id || '').startsWith('acc_pm_')) {
        const cm = getCustomPaymentMethods(true).find(c => c.accountId === le.account_id);
        if (cm) {
          return { bucket: cm.name, accountId: cm.accountId, clearingAccountId: 'mtn-clearing-account-uuid' };
        }
      }
    }
  }

  return { bucket: 'Airtel Money', accountId: 'acc_airtel', clearingAccountId: 'airtel-clearing-account-uuid' };
}

export function calculateAssetValuation(ast: any, asOfDate: Date = new Date()): {
  cost: number;
  salvageValue: number;
  annualDepreciation: number;
  accumulatedDepreciation: number;
  netBookValue: number;
  yearsElapsed: number;
} {
  const cost = Math.max(0, Number(ast?.value || 0));
  const salvageValue = Math.min(cost, Math.max(0, Number(ast?.salvage_value ?? ast?.salvageValue ?? 0)));
  const depreciableBase = Math.max(0, cost - salvageValue);
  const status = String(ast?.status || 'Active').trim();
  const category = String(ast?.category || 'Fixed').trim();
  const method = String(ast?.depreciation_method ?? ast?.depreciationMethod ?? 'Straight Line').trim();
  const rate = Math.max(0, Number(ast?.depreciation_rate ?? ast?.depreciationRate ?? 0));
  const usefulLifeYears = Math.max(1, Number(ast?.useful_life_years ?? ast?.usefulLifeYears ?? (rate > 0 ? 100 / rate : 5)));

  if (status === 'Disposed' || status === 'Written Off') {
    return {
      cost: parseFloat(cost.toFixed(2)),
      salvageValue: parseFloat(salvageValue.toFixed(2)),
      annualDepreciation: 0,
      accumulatedDepreciation: parseFloat(cost.toFixed(2)),
      netBookValue: 0,
      yearsElapsed: 0,
    };
  }

  if (method === 'None' || category === 'Current' || (rate <= 0 && !ast?.useful_life_years && !ast?.usefulLifeYears)) {
    return {
      cost: parseFloat(cost.toFixed(2)),
      salvageValue: parseFloat(salvageValue.toFixed(2)),
      annualDepreciation: 0,
      accumulatedDepreciation: 0,
      netBookValue: parseFloat(cost.toFixed(2)),
      yearsElapsed: 0,
    };
  }

  const rawPurchaseDate = ast?.purchase_date ?? ast?.purchaseDate ?? '';
  const purchaseMs = Date.parse(String(rawPurchaseDate || ''));
  const yearsElapsed = Number.isFinite(purchaseMs)
    ? Math.max(0, (asOfDate.getTime() - purchaseMs) / (365.25 * 86400000))
    : 0;

  if (method === 'Reducing Balance') {
    const effectiveRate = rate > 0 ? Math.min(100, rate) : Math.min(100, 100 / usefulLifeYears);
    const nbvRaw = cost * Math.pow(Math.max(0, 1 - effectiveRate / 100), yearsElapsed);
    const netBookValue = parseFloat(Math.max(salvageValue, Math.min(cost, nbvRaw)).toFixed(2));
    const accumulatedDepreciation = parseFloat(Math.max(0, cost - netBookValue).toFixed(2));
    const annualDepreciation = parseFloat(Math.max(0, netBookValue * (effectiveRate / 100)).toFixed(2));
    return {
      cost: parseFloat(cost.toFixed(2)),
      salvageValue: parseFloat(salvageValue.toFixed(2)),
      annualDepreciation,
      accumulatedDepreciation,
      netBookValue,
      yearsElapsed: parseFloat(yearsElapsed.toFixed(2)),
    };
  }

  // Straight Line
  const annualDep = rate > 0 ? depreciableBase * (rate / 100) : depreciableBase / usefulLifeYears;
  const accumDep = Math.min(depreciableBase, annualDep * yearsElapsed);
  const accumulatedDepreciation = parseFloat(Math.max(0, accumDep).toFixed(2));
  const netBookValue = parseFloat(Math.max(salvageValue, cost - accumulatedDepreciation).toFixed(2));
  return {
    cost: parseFloat(cost.toFixed(2)),
    salvageValue: parseFloat(salvageValue.toFixed(2)),
    annualDepreciation: parseFloat(Math.max(0, annualDep).toFixed(2)),
    accumulatedDepreciation,
    netBookValue,
    yearsElapsed: parseFloat(yearsElapsed.toFixed(2)),
  };
}

export function syncAllAccountingSystems(triggerReason: string = 'Immediate POS Sale Accounting Sync') {
  if (isAccountingSyncRunning || isDbInitializing) return;
  isAccountingSyncRunning = true;

  try {
    const nowIso = new Date().toISOString();
    const todayDate = toLocalDateKey();
    const activeBizId = getActiveBusinessId();
    const activeBizSlug = activeBizId
      ? activeBizId.replace(/[^a-zA-Z0-9_]/g, '').slice(-10)
      : 'tenant';

    // 0. Ensure all required tables exist (in case recovered from older schema)
    const ensureTables = [
      `CREATE TABLE IF NOT EXISTS receipt_refund_ledger (
        id STRING PRIMARY KEY, order_id STRING, entry_type STRING, date STRING, store_id STRING,
        customer_name STRING, payment_method STRING, subtotal NUMERIC, tax NUMERIC, discount NUMERIC,
        total_amount NUMERIC, cogs_amount NUMERIC, net_revenue_impact NUMERIC, cash_impact NUMERIC,
        performed_by STRING, journal_ref STRING, status STRING, created_at STRING, business_id STRING
      )`,
      `CREATE TABLE IF NOT EXISTS cash_flow_ledger (
        id STRING PRIMARY KEY, date STRING, store_id STRING, activity_type STRING, category STRING,
        direction STRING, payment_method STRING, account_id STRING, inflow_amount NUMERIC,
        outflow_amount NUMERIC, net_cash_change NUMERIC, reference_id STRING, description STRING,
        performed_by STRING, created_at STRING, business_id STRING
      )`,
      `CREATE TABLE IF NOT EXISTS payment_method_ledger (
        id STRING PRIMARY KEY, payment_method STRING, store_id STRING, account_id STRING,
        gross_receipts NUMERIC, layby_receipts NUMERIC, refunds_out NUMERIC, expenses_out NUMERIC,
        transfers_in NUMERIC, transfers_out NUMERIC, net_balance NUMERIC, transaction_count INT, updated_at STRING, business_id STRING
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
        net_cash_flow NUMERIC, updated_at STRING, business_id STRING
      )`,
      `CREATE TABLE IF NOT EXISTS double_entry_journal (
        id STRING PRIMARY KEY, date STRING, reference STRING, description STRING,
        account_debit STRING, account_credit STRING, amount NUMERIC, currency STRING, business_id STRING, store_id STRING
      )`,
      `CREATE TABLE IF NOT EXISTS payment_methods (
        id STRING PRIMARY KEY, name STRING, category STRING, account_id STRING,
        is_active INT, created_by STRING, created_at STRING, business_id STRING, store_id STRING
      )`
    ];
    for (const ddl of ensureTables) {
      runSql(ddl, 'Ensure accounting table', true);
    }

    // Sync any custom payment methods from settings into payment_methods table
    const settingsCustom = readSettingsCustomPaymentMethods();
    const existingPmSql = activeBizId
      ? `SELECT id FROM payment_methods WHERE business_id = '${sqlEsc(activeBizId)}'`
      : 'SELECT id FROM payment_methods';
    const existingPmRes = runSql(existingPmSql, 'Check payment_methods', true);
    const existingPmIds = new Set(
      existingPmRes.success && Array.isArray(existingPmRes.data)
        ? existingPmRes.data.map((r: any) => String(r.id))
        : []
    );
    const activeDefaultStoreId = getActiveStoreId(undefined, activeBizId);
    for (const cm of settingsCustom) {
      if (cm && cm.id && !existingPmIds.has(cm.id)) {
        runSql(
          `INSERT INTO payment_methods (id, name, category, account_id, is_active, created_by, created_at, business_id, store_id)
           VALUES ('${sqlEsc(cm.id)}', '${sqlEsc(cm.name)}', '${sqlEsc(cm.category)}', '${sqlEsc(cm.accountId)}', ${cm.isActive ? 1 : 0}, '${sqlEsc(cm.createdBy || 'Admin')}', '${cm.createdAt || nowIso}', '${sqlEsc(activeBizId)}', '${sqlEsc(activeDefaultStoreId)}')`,
          `Sync custom payment method [${cm.name}]`,
          true
        );
      }
    }

    const allCustomMethods = getCustomPaymentMethods(true);

    // 1. Ensure Complete Chart of Accounts in `accounts`
    const requiredAccounts = [
      { id: 'acc_cash', name: 'Cash Account (Counter Drawer)', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_airtel', name: 'Airtel Money Account', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_mtn', name: 'MTN Mobile Money Account', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_momo', name: 'Mobile Wallet Account (General)', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_bank', name: 'Commercial Bank & Card Settlement Account', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_inventory', name: 'Store Merchandise Inventory Asset', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_transit', name: 'Goods in Transit Asset', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_fixed_assets', name: 'Fixed Equipment & Property Assets', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_accum_depreciation', name: 'Accumulated Depreciation (Contra-Asset)', type: 'ASSET', cur: 'ZMW' },
      { id: 'acc_vat_payable', name: 'VAT / Tax Output Payable (ZRA)', type: 'LIABILITY', cur: 'ZMW' },
      { id: 'acc_layby_deposits', name: 'Customer Layby Unearned Deposits', type: 'LIABILITY', cur: 'ZMW' },
      { id: 'acc_loans_payable', name: 'Working Capital Loans Payable', type: 'LIABILITY', cur: 'ZMW' },
      { id: 'acc_sales_revenue', name: 'Gross Sales Revenue', type: 'REVENUE', cur: 'ZMW' },
      { id: 'acc_sales_returns', name: 'Sales Returns, Refunds & Allowances', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_sales_discounts', name: 'Sales Discounts Allowed', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_cost_of_goods', name: 'Cost of Goods Sold (COGS)', type: 'EXPENSE', cur: 'ZMW' },
      { id: 'acc_retained_earnings', name: 'Owner Equity & Retained Earnings', type: 'EQUITY', cur: 'ZMW' },
      { id: 'acc_owner_capital', name: 'Owner Paid-In Capital Equity', type: 'EQUITY', cur: 'ZMW' },
      { id: 'acc_depreciation_exp', name: 'Asset Depreciation Expense', type: 'EXPENSE', cur: 'ZMW' },
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
      { id: 'cash-clearing-account-uuid', name: 'Counter Cash Tender Registry', type: 'ASSET', cur: 'ZMW' },
      ...allCustomMethods.map(cm => ({
        id: cm.accountId,
        name: `${cm.name} (${cm.category})`,
        type: 'ASSET',
        cur: 'ZMW',
      })),
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
          `INSERT INTO accounts (id, name, type, currency, merchant_id, created_at, updated_at, business_id, store_id) VALUES ('${acc.id}', '${sqlEsc(acc.name)}', '${acc.type}', '${acc.cur}', '${sqlEsc(activeBizId)}', '${nowIso}', '${nowIso}', '${sqlEsc(activeBizId)}', 'all')`,
          `Accounting Sync: Ensure account ${acc.id}`,
          true
        );
        existingAccIds.add(acc.id);
      }
    }

    // 2. Fetch all source records strictly isolated by active business_id
    const bizFilter = (alias?: string) => {
      if (!activeBizId) return '';
      const col = alias ? `${alias}.business_id` : 'business_id';
      return `${col} = '${sqlEsc(activeBizId)}'`;
    };
    const whereBiz = activeBizId ? `WHERE ${bizFilter()}` : '';
    const andBiz = activeBizId ? `AND ${bizFilter()}` : '';

    const productsRes = runSql(`SELECT * FROM products ${whereBiz}`, 'Accounting Sync: Products', true);
    const storeProductsRes = runSql(`SELECT * FROM store_products ${whereBiz}`, 'Accounting Sync: Store Products', true);
    const customersRes = runSql(`SELECT * FROM customers ${whereBiz}`, 'Accounting Sync: Customers', true);
    const ordersRes = runSql(`SELECT * FROM orders ${whereBiz} ORDER BY orderDate ASC`, 'Accounting Sync: Orders', true);
    const orderItemsRes = runSql(`SELECT * FROM order_items ${whereBiz}`, 'Accounting Sync: Order Items', true);
    const laybysRes = runSql(`SELECT * FROM laybys ${whereBiz} ORDER BY created_at ASC`, 'Accounting Sync: Laybys', true);
    const laybyInstRes = runSql(`SELECT * FROM layby_installments ${whereBiz} ORDER BY created_at ASC`, 'Accounting Sync: Layby Installments', true);
    const expensesRes = runSql(`SELECT * FROM expenses ${whereBiz} ORDER BY expense_date ASC`, 'Accounting Sync: Expenses', true);
    const attendanceRes = runSql(`SELECT * FROM time_attendance WHERE status = 'PAID' ${andBiz}`, 'Accounting Sync: Paid Payroll', true);
    const transfersRes = runSql(`SELECT * FROM money_transfers ${whereBiz} ORDER BY transfer_date ASC`, 'Accounting Sync: Transfers', true);
    const transitRes = runSql(`SELECT * FROM transit_purchases ${whereBiz} ORDER BY created_at ASC`, 'Accounting Sync: Transit POs', true);
    const purchasesTransitRes = runSql(`SELECT * FROM purchases_transit ${whereBiz} ORDER BY created_at ASC`, 'Accounting Sync: Supply Management POs', true);
    const assetsRes = runSql(`SELECT * FROM assets ${whereBiz}`, 'Accounting Sync: Assets', true);
    const equityRes = runSql(`SELECT * FROM equity ${whereBiz}`, 'Accounting Sync: Equity', true);
    const loansRes = runSql(`SELECT * FROM loans WHERE status = 'ACTIVE' ${andBiz}`, 'Accounting Sync: Active Loans', true);
    const loanDedRes = runSql(`SELECT * FROM automated_deduction_logs WHERE status = 'SUCCESS' ${andBiz}`, 'Accounting Sync: Loan Sweeps', true);
    const ledgerEntriesRes = runSql(`SELECT * FROM ledger_entries ${whereBiz}`, 'Accounting Sync: Existing Ledger Entries', true);
    const transactionsRes = runSql(`SELECT * FROM transactions ${whereBiz}`, 'Accounting Sync: Existing Transactions', true);

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
    const supplyPos: any[] = (purchasesTransitRes.success && Array.isArray(purchasesTransitRes.data)) ? purchasesTransitRes.data : [];
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

    // Helper to resolve split payment breakdown for an order (persisted columns first, then ledger_entries, then 50/50 fallback)
    const getSplitAmountsForOrder = (
      ord: any,
      totalAmt: number
    ): {
      cashPart: number;
      momoPart: number;
      txId?: string;
      momoBucket: string;
      momoAccountId: string;
      momoClearingId: string;
    } => {
      const ordId = String(ord?.id || '');
      const matchingTx = existingTransactions.find(t => String(t.provider_reference || '').includes(ordId));
      const txEntries = matchingTx
        ? existingLedgerEntries.filter(le => le.transaction_id === matchingTx.id)
        : [];
      const splitProvider = resolveSplitMobileProvider(ord?.paymentMethod, txEntries);

      const storedCash = Number(ord?.split_cash);
      const storedMomo = Number(ord?.split_momo);
      if (ord && (ord.split_cash !== null && ord.split_cash !== undefined || ord.split_momo !== null && ord.split_momo !== undefined)) {
        const c = isNaN(storedCash) ? 0 : storedCash;
        const m = isNaN(storedMomo) ? 0 : storedMomo;
        if (c + m > 0) {
          return {
            cashPart: c,
            momoPart: m,
            txId: matchingTx?.id,
            momoBucket: splitProvider.bucket,
            momoAccountId: splitProvider.accountId,
            momoClearingId: splitProvider.clearingAccountId,
          };
        }
      }
      if (matchingTx) {
        const entries = txEntries.filter(le => le.type === 'DEBIT');
        let cashPart = 0;
        let momoPart = 0;
        entries.forEach(le => {
          if (le.account_id === 'acc_cash' || le.account_id === 'cash-clearing-account-uuid') cashPart += Number(le.amount || 0);
          if (
            le.account_id === 'acc_momo' ||
            le.account_id === 'acc_mtn' ||
            le.account_id === 'acc_airtel' ||
            String(le.account_id || '').startsWith('acc_pm_') ||
            le.account_id === 'mtn-clearing-account-uuid' ||
            le.account_id === 'airtel-clearing-account-uuid'
          ) {
            momoPart += Number(le.amount || 0);
          }
        });
        const accCash = entries.filter(le => le.account_id === 'acc_cash').reduce((s, le) => s + Number(le.amount || 0), 0);
        const accMomo = entries
          .filter(
            le =>
              le.account_id === 'acc_momo' ||
              le.account_id === 'acc_mtn' ||
              le.account_id === 'acc_airtel' ||
              String(le.account_id || '').startsWith('acc_pm_')
          )
          .reduce((s, le) => s + Number(le.amount || 0), 0);
        if (accCash + accMomo > 0) {
          return {
            cashPart: accCash,
            momoPart: accMomo,
            txId: matchingTx.id,
            momoBucket: splitProvider.bucket,
            momoAccountId: splitProvider.accountId,
            momoClearingId: splitProvider.clearingAccountId,
          };
        }
        if (cashPart + momoPart > 0) {
          return {
            cashPart,
            momoPart,
            txId: matchingTx.id,
            momoBucket: splitProvider.bucket,
            momoAccountId: splitProvider.accountId,
            momoClearingId: splitProvider.clearingAccountId,
          };
        }
      }
      const half = parseFloat((totalAmt / 2).toFixed(2));
      return {
        cashPart: half,
        momoPart: parseFloat((totalAmt - half).toFixed(2)),
        txId: matchingTx?.id,
        momoBucket: splitProvider.bucket,
        momoAccountId: splitProvider.accountId,
        momoClearingId: splitProvider.clearingAccountId,
      };
    };

    // 3. Preserve rows from OTHER businesses while resetting current business's accounting ledgers
    const preserveOtherRows = (tableName: string) => {
      if (!activeBizId || !alasql.tables?.[tableName]?.data) return [] as any[];
      return alasql.tables[tableName].data.filter(
        (r: any) => r?.business_id && String(r.business_id) !== activeBizId
      );
    };
    const otherJournalRows = preserveOtherRows('double_entry_journal');
    const otherReceiptRefundRows = preserveOtherRows('receipt_refund_ledger');
    const otherCashFlowRows = preserveOtherRows('cash_flow_ledger');
    const otherPaymentMethodRows = preserveOtherRows('payment_method_ledger');
    const otherStatementRows = preserveOtherRows('financial_statements_ledger');
    const otherLedgerEntries = preserveOtherRows('ledger_entries');

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
      txIdForLedger?: string,
      rowStoreId?: string
    ) => {
      const cleanAmt = parseFloat(Number(amount || 0).toFixed(4));
      if (cleanAmt <= 0) return;
      const jId = `JRN_${idSuffix}`;
      const rowStore = rowStoreId || activeDefaultStoreId || 'main';
      journalRows.push({
        id: jId,
        date,
        reference,
        description,
        account_debit: debitAcc,
        account_credit: creditAcc,
        amount: cleanAmt,
        currency: 'ZMW',
        business_id: activeBizId,
        store_id: rowStore
      });
      const txRef = txIdForLedger || `tx_${idSuffix}`;
      rebuiltLedgerEntries.push({
        id: `le_${idSuffix}_dr`,
        transaction_id: txRef,
        account_id: debitAcc,
        type: 'DEBIT',
        amount: cleanAmt,
        created_at: date,
        business_id: activeBizId,
        store_id: rowStore
      });
      rebuiltLedgerEntries.push({
        id: `le_${idSuffix}_cr`,
        transaction_id: txRef,
        account_id: creditAcc,
        type: 'CREDIT',
        amount: cleanAmt,
        created_at: date,
        business_id: activeBizId,
        store_id: rowStore
      });
    };

    // Dynamically collect store IDs belonging strictly to the active business
    const legacyIgnoredStores = new Set(['lusaka', 'kitwe', 'ndola', 'store_main']);
    const dbStoresSql = activeBizId
      ? `SELECT id FROM stores WHERE business_id = '${sqlEsc(activeBizId)}'`
      : 'SELECT id FROM stores';
    const dbStoresRes = runSql(dbStoresSql, 'Accounting Sync: Stores', true);
    const dynamicStoreSet = new Set<string>();
    if (dbStoresRes.success && Array.isArray(dbStoresRes.data)) {
      dbStoresRes.data.forEach((s: any) => {
        const sId = String(s.id || '').toLowerCase().trim();
        if (sId && !legacyIgnoredStores.has(sId)) dynamicStoreSet.add(sId);
      });
    }
    const addIfActiveStore = (rawStore: any) => {
      const sId = String(rawStore || '').toLowerCase().trim();
      if (sId && !legacyIgnoredStores.has(sId)) dynamicStoreSet.add(sId);
    };
    orders.forEach(o => addIfActiveStore(o.store_id));
    expenses.forEach(e => addIfActiveStore(e.store_id));
    laybys.forEach(l => addIfActiveStore(l.store_id));
    storeProducts.forEach(sp => addIfActiveStore(sp.store_id));
    assetsList.forEach(a => addIfActiveStore(a.store_id));
    equityList.forEach(eq => addIfActiveStore(eq.store_id));

    const individualStores = Array.from(dynamicStoreSet);
    const storesList = [...individualStores, 'all'];
    const defaultFallbackStore = individualStores[0] || activeDefaultStoreId || 'main';
    const customMethodNames = allCustomMethods.map(cm => cm.name);
    const methodNamesSet = new Set<string>([
      'Cash',
      'Airtel Money',
      'MTN Mobile Money',
      'Credit Card / Bank',
      'Split',
      ...customMethodNames,
    ]);
    // Include legacy 'Mobile Wallet' bucket only if historical transactions exist for it
    const hasLegacyMobileWallet = orders.some(o => resolvePaymentMethodBucket(o.paymentMethod).bucket === 'Mobile Wallet') ||
      laybyInstallments.some(i => resolvePaymentMethodBucket(i.payment_method).bucket === 'Mobile Wallet');
    if (hasLegacyMobileWallet) {
      methodNamesSet.add('Mobile Wallet');
    }
    const methodNames = Array.from(methodNamesSet);

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
      const storeId = (ord.store_id || defaultFallbackStore).toLowerCase().trim();
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
        created_at: dateStr,
        business_id: activeBizId
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
        const { cashPart, momoPart, txId, momoBucket, momoAccountId, momoClearingId } = getSplitAmountsForOrder(ord, total);
        const splitSum = cashPart + momoPart;
        const cashShareRatio = splitSum > 0 ? cashPart / splitSum : 0.5;
        const cashVat = parseFloat((tax * cashShareRatio).toFixed(2));
        const momoVat = parseFloat((tax - cashVat).toFixed(2));
        const cashNetRev = Math.max(0, cashPart - cashVat);
        const momoNetRev = Math.max(0, momoPart - momoVat);
        if (cashPart > 0) {
          if (cashNetRev > 0) {
            addJournalPair(
              `SALE_SPLITCASH_${ordId}`,
              dateStr,
              ordId,
              `POS Split Sale (Cash Portion) #${ordId} (${custName})`,
              'acc_cash',
              'acc_sales_revenue',
              cashNetRev,
              txId
            );
          }
          if (cashVat > 0) {
            addJournalPair(
              `SALE_SPLITCASH_VAT_${ordId}`,
              dateStr,
              ordId,
              `POS Split VAT (Cash Portion) #${ordId} (${custName})`,
              'acc_cash',
              'acc_vat_payable',
              cashVat,
              txId
            );
          }
          rebuiltLedgerEntries.push({
            id: `le_clr_cash_${ordId}`,
            transaction_id: txId || `tx_${ordId}`,
            account_id: 'cash-clearing-account-uuid',
            type: 'DEBIT',
            amount: cashPart,
            created_at: dateStr
          });
          rebuiltLedgerEntries.push({
            id: `le_merch_cash_${ordId}`,
            transaction_id: txId || `tx_${ordId}`,
            account_id: 'merchant-wallet-account-uuid',
            type: 'CREDIT',
            amount: cashPart,
            created_at: dateStr
          });
          addMethodStat(storeId, 'Cash', 'gross_receipts', cashPart, true);
        }
        if (momoPart > 0) {
          if (momoNetRev > 0) {
            addJournalPair(
              `SALE_SPLITMOMO_${ordId}`,
              dateStr,
              ordId,
              `POS Split Sale (${momoBucket} Portion) #${ordId} (${custName})`,
              momoAccountId,
              'acc_sales_revenue',
              momoNetRev,
              txId
            );
          }
          if (momoVat > 0) {
            addJournalPair(
              `SALE_SPLITMOMO_VAT_${ordId}`,
              dateStr,
              ordId,
              `POS Split VAT (${momoBucket} Portion) #${ordId} (${custName})`,
              momoAccountId,
              'acc_vat_payable',
              momoVat,
              txId
            );
          }
          rebuiltLedgerEntries.push({
            id: `le_clr_momo_${ordId}`,
            transaction_id: txId || `tx_${ordId}`,
            account_id: momoClearingId,
            type: 'DEBIT',
            amount: momoPart,
            created_at: dateStr
          });
          rebuiltLedgerEntries.push({
            id: `le_merch_momo_${ordId}`,
            transaction_id: txId || `tx_${ordId}`,
            account_id: 'merchant-wallet-account-uuid',
            type: 'CREDIT',
            amount: momoPart,
            created_at: dateStr
          });
          addMethodStat(storeId, momoBucket, 'gross_receipts', momoPart, true);
        }
        addMethodStat(storeId, 'Split', 'gross_receipts', total, true);
      } else {
        // Standard or Quick Sale via Cash, Airtel Money, MTN Mobile Money, Custom Method, or Bank/Card
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
          created_at: dateStr,
          business_id: activeBizId
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
          const { cashPart, momoPart, momoBucket, momoAccountId, momoClearingId } = getSplitAmountsForOrder(ord, total);
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
            rebuiltLedgerEntries.push({
              id: `le_rfnd_merch_cash_${ordId}`,
              transaction_id: `tx_rfnd_${ordId}`,
              account_id: 'merchant-wallet-account-uuid',
              type: 'DEBIT',
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
              `Refund Reversal (${momoBucket} Portion) for Order #${ordId}`,
              'acc_sales_returns',
              momoAccountId,
              momoPart
            );
            rebuiltLedgerEntries.push({
              id: `le_rfnd_clr_momo_${ordId}`,
              transaction_id: `tx_rfnd_${ordId}`,
              account_id: momoClearingId,
              type: 'CREDIT',
              amount: momoPart,
              created_at: dateStr
            });
            rebuiltLedgerEntries.push({
              id: `le_rfnd_merch_momo_${ordId}`,
              transaction_id: `tx_rfnd_${ordId}`,
              account_id: 'merchant-wallet-account-uuid',
              type: 'DEBIT',
              amount: momoPart,
              created_at: dateStr
            });
            addMethodStat(storeId, momoBucket, 'refunds_out', momoPart, false);
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
      const storeId = (parentLayby?.store_id || defaultFallbackStore).toLowerCase().trim();
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
      rebuiltLedgerEntries.push({
        id: `le_merch_lby_${instId}`,
        transaction_id: `tx_lby_${instId}`,
        account_id: 'merchant-wallet-account-uuid',
        type: 'CREDIT',
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
      const storeId = (exp.store_id || defaultFallbackStore).toLowerCase().trim();
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

      const methodBucket = resolvePaymentMethodBucket(accId).bucket;
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

      addMethodStat(defaultFallbackStore, 'Cash', 'expenses_out', amt, false);

      cashFlowRows.push({
        id: `CF_PAY_${attId}`,
        date: dateStr,
        store_id: defaultFallbackStore,
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

      const srcBucket = resolvePaymentMethodBucket(srcAcc).bucket;
      const dstBucket = resolvePaymentMethodBucket(dstAcc).bucket;
      addMethodStat(defaultFallbackStore, srcBucket, 'transfers_out', amt, false);
      addMethodStat(defaultFallbackStore, dstBucket, 'transfers_in', amt, false);
    });

    // F. Process Goods in Transit & Purchase Orders (Procurement)
    transitPos.forEach((po, idx) => {
      const poId = String(po.id || `PO-${idx}`);
      const amt = Number(po.grand_landed_total || 0);
      if (amt <= 0) return;
      const storeId = (po.store_id || defaultFallbackStore).toLowerCase().trim();
      const dateStr = po.created_at || nowIso;
      const payMethod = String(po.payment_method || 'BANK_TRANSFER');
      const resolvedPo = po.payment_account
        ? resolvePaymentMethodBucket(po.payment_account)
        : payMethod === 'CASH'
          ? resolvePaymentMethodBucket('Cash')
          : payMethod === 'MOBILE_MONEY'
            ? resolvePaymentMethodBucket('Mobile Wallet')
            : resolvePaymentMethodBucket(payMethod);
      const payAcc = resolvedPo.accountId;
      const methodBucket = resolvedPo.bucket;

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

    // G. Process Fixed/Current Assets & Owner Capital Equity (Standardized + Branch-Scoped)
    assetsList.forEach((ast, idx) => {
      const astId = String(ast.id || `AST-${idx}`);
      const val = Number(ast.value || 0);
      if (val <= 0) return;
      const astStore = String(ast.store_id || defaultFallbackStore).toLowerCase().trim();
      const dateStr = ast.purchase_date || nowIso;
      const status = String(ast.status || 'Active');
      const funding = String(ast.funding_source || (ast.linked_equity_id ? 'owner_equity' : 'acc_owner_capital')).trim();
      const isFundedByCashOrBank = funding.startsWith('acc_') && funding !== 'acc_owner_capital';
      const creditAccount = isFundedByCashOrBank ? funding : 'acc_owner_capital';

      addJournalPair(
        `ASSET_${astId}`,
        dateStr,
        astId,
        `Asset Registration (${ast.category || 'Fixed'} - ${ast.type || 'Equipment'}): ${ast.name}`,
        'acc_fixed_assets',
        creditAccount,
        val,
        undefined,
        astStore
      );

      if (isFundedByCashOrBank) {
        const payMeta = resolvePaymentMethodBucket(creditAccount);
        addMethodStat(astStore, payMeta.bucket, 'expenses_out', val, false);
        cashFlowRows.push({
          id: `CF_ASSET_${astId}`,
          date: dateStr,
          store_id: astStore,
          activity_type: 'INVESTING',
          category: 'Fixed & Capital Asset Purchase',
          direction: 'OUTFLOW',
          payment_method: payMeta.bucket,
          account_id: creditAccount,
          inflow_amount: 0,
          outflow_amount: val,
          net_cash_change: -val,
          reference_id: astId,
          description: `Capital Asset Acquisition: ${ast.name}`,
          performed_by: 'Finance Admin',
          created_at: dateStr
        });
      }

      if (status === 'Active') {
        const valuation = calculateAssetValuation(ast);
        if (valuation.accumulatedDepreciation > 0) {
          addJournalPair(
            `DEP_${astId}`,
            nowIso,
            astId,
            `Accumulated Depreciation (${ast.depreciation_method || 'Straight Line'}): ${ast.name}`,
            'acc_depreciation_exp',
            'acc_accum_depreciation',
            valuation.accumulatedDepreciation,
            undefined,
            astStore
          );
        }
      } else if (status === 'Disposed' && Number(ast.disposal_proceeds || 0) > 0) {
        const proceeds = Number(ast.disposal_proceeds || 0);
        const dispDate = ast.disposal_date || nowIso;
        addJournalPair(
          `AST_DISP_${astId}`,
          dispDate,
          astId,
          `Asset Disposal Proceeds: ${ast.name}`,
          'acc_bank',
          'acc_fixed_assets',
          proceeds,
          undefined,
          astStore
        );
        addMethodStat(astStore, 'Credit Card / Bank', 'transfers_in', proceeds, false);
        cashFlowRows.push({
          id: `CF_DISP_${astId}`,
          date: dispDate,
          store_id: astStore,
          activity_type: 'INVESTING',
          category: 'Asset Disposal Proceeds',
          direction: 'INFLOW',
          payment_method: 'Credit Card / Bank',
          account_id: 'acc_bank',
          inflow_amount: proceeds,
          outflow_amount: 0,
          net_cash_change: proceeds,
          reference_id: astId,
          description: `Proceeds from Disposal of ${ast.name}`,
          performed_by: 'Finance Admin',
          created_at: dispDate
        });
      }
    });

    equityList.forEach((eq, idx) => {
      if (String(eq.status || 'Active') === 'Reversed') return;
      if (eq.linked_asset_id) return; // already paired via asset contribution above
      const eqId = String(eq.id || `EQ-${idx}`);
      const val = Number(eq.value || 0);
      if (val <= 0) return;
      const eqStore = String(eq.store_id || defaultFallbackStore).toLowerCase().trim();
      const eqType = String(eq.equity_type || 'Owner Capital');
      const isDrawings =
        eqType.toLowerCase().includes('drawing') ||
        eqType.toLowerCase().includes('dividend');
      const payAcc = String(eq.account_id || 'acc_bank').trim() || 'acc_bank';
      const eqDate = eq.contribution_date || eq.created_at || nowIso;
      const payMeta = resolvePaymentMethodBucket(payAcc);

      if (isDrawings) {
        addJournalPair(
          `EQUITY_${eqId}`,
          eqDate,
          eqId,
          `${eqType}: ${eq.name}${eq.shareholder_name ? ` (${eq.shareholder_name})` : ''}`,
          'acc_owner_capital',
          payAcc,
          val,
          undefined,
          eqStore
        );
        addMethodStat(eqStore, payMeta.bucket, 'expenses_out', val, false);
        cashFlowRows.push({
          id: `CF_EQ_${eqId}`,
          date: eqDate,
          store_id: eqStore,
          activity_type: 'FINANCING',
          category: eqType,
          direction: 'OUTFLOW',
          payment_method: payMeta.bucket,
          account_id: payAcc,
          inflow_amount: 0,
          outflow_amount: val,
          net_cash_change: -val,
          reference_id: eqId,
          description: `${eqType}: ${eq.name}`,
          performed_by: eq.shareholder_name || 'Owner',
          created_at: eqDate
        });
      } else {
        addJournalPair(
          `EQUITY_${eqId}`,
          eqDate,
          eqId,
          `${eqType}: ${eq.name}${eq.shareholder_name ? ` (${eq.shareholder_name})` : ''}`,
          payAcc,
          'acc_owner_capital',
          val,
          undefined,
          eqStore
        );
        addMethodStat(eqStore, payMeta.bucket, 'transfers_in', val, false);
        cashFlowRows.push({
          id: `CF_EQ_${eqId}`,
          date: eqDate,
          store_id: eqStore,
          activity_type: 'FINANCING',
          category: eqType,
          direction: 'INFLOW',
          payment_method: payMeta.bucket,
          account_id: payAcc,
          inflow_amount: val,
          outflow_amount: 0,
          net_cash_change: val,
          reference_id: eqId,
          description: `${eqType}: ${eq.name}`,
          performed_by: eq.shareholder_name || 'Owner',
          created_at: eqDate
        });
      }
    });

    // H. Process Inventory Stock Valuation & Retained Earnings Alignment
    let totalPhysicalInventoryValue = 0;
    const invValueByStore: Record<string, number> = {};
    if (storeProducts.length > 0) {
      storeProducts.forEach(sp => {
        const prod = productMap.get(Number(sp.product_id));
        if (prod && prod.is_service !== 1) {
          const unitCost = Number(prod.cost || Number(sp.price || prod.price || 0) * 0.7);
          const stockQty = Math.max(0, Number(sp.stock || 0));
          const val = unitCost * stockQty;
          const st = String(sp.store_id || defaultFallbackStore).toLowerCase();
          invValueByStore[st] = (invValueByStore[st] || 0) + val;
          totalPhysicalInventoryValue += val;
        }
      });
    } else {
      products.forEach(p => {
        if (p.is_service !== 1) {
          const val = Number(p.cost || Number(p.price || 0) * 0.7) * Math.max(0, Number(p.stock || 0));
          invValueByStore[defaultFallbackStore] = (invValueByStore[defaultFallbackStore] || 0) + val;
          totalPhysicalInventoryValue += val;
        }
      });
    }

    // No synthetic opening inventory capitalization journal entry is posted; double-entry journal strictly reflects real recorded transactions.

    // 4. Merge rebuilt rows for active business with preserved rows for other businesses
    const stampRowBiz = (arr: any[]) =>
      arr.map(r => ({
        ...r,
        business_id: r.business_id || activeBizId,
        store_id: r.store_id || defaultFallbackStore,
      }));

    if (alasql.tables.double_entry_journal) {
      alasql.tables.double_entry_journal.data = [...otherJournalRows, ...stampRowBiz(journalRows)];
    }
    if (alasql.tables.receipt_refund_ledger) {
      receiptRefundRows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      alasql.tables.receipt_refund_ledger.data = [...otherReceiptRefundRows, ...stampRowBiz(receiptRefundRows)];
    }
    if (alasql.tables.cash_flow_ledger) {
      cashFlowRows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      alasql.tables.cash_flow_ledger.data = [...otherCashFlowRows, ...stampRowBiz(cashFlowRows)];
    }
    if (alasql.tables.ledger_entries) {
      alasql.tables.ledger_entries.data = [...otherLedgerEntries, ...stampRowBiz(rebuiltLedgerEntries)];
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
        id: `PML_${activeBizSlug}_${key.replace(/[^a-zA-Z0-9_]/g, '_')}`,
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
        updated_at: nowIso,
        business_id: activeBizId
      });
    });
    if (alasql.tables.payment_method_ledger) {
      alasql.tables.payment_method_ledger.data = [...otherPaymentMethodRows, ...paymentMethodRows];
    }

    // 6. Compute and populate `financial_statements_ledger` for each store and 'all'
    const statementRows: any[] = [];
    const totalLoansRepayable = activeLoans.reduce((s, l) => s + Number(l.total_repayable || 0), 0);
    const totalLoansSwept = loanSweeps.reduce((s, d) => s + Number(d.amount_deducted || 0), 0);
    const netLoansPayable = Math.max(0, totalLoansRepayable - totalLoansSwept);

    for (const st of storesList) {
      const matchStore = (rowStore: any) => st === 'all' || String(rowStore || defaultFallbackStore).toLowerCase().trim() === st;

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
      const stPayroll = (st === 'all' || st === defaultFallbackStore)
        ? paidAttendance.reduce((s, a) => s + Number(a.gross_payment || 0), 0)
        : 0;

      const netOperatingIncome = grossProfit - stExpenses - stPayroll;

      // Cash balances by payment channel for this store
      const getMethodNet = (mName: string) => {
        const found = paymentMethodRows.find(r => r.store_id === st && r.payment_method === mName);
        return found ? Number(found.net_balance || 0) : 0;
      };

      const customCashBal = allCustomMethods
        .filter(cm => cm.category === 'Cash')
        .reduce((sum, cm) => sum + getMethodNet(cm.name), 0);
      const customMomoBal = allCustomMethods
        .filter(cm => cm.category === 'Mobile Money')
        .reduce((sum, cm) => sum + getMethodNet(cm.name), 0);
      const customBankOtherBal = allCustomMethods
        .filter(cm => cm.category === 'Bank / Card' || cm.category === 'Other')
        .reduce((sum, cm) => sum + getMethodNet(cm.name), 0);

      const cashDrawerBal = getMethodNet('Cash') + customCashBal;
      const momoBal =
        getMethodNet('MTN Mobile Money') +
        getMethodNet('Airtel Money') +
        getMethodNet('Mobile Wallet') +
        customMomoBal;
      const bankCardBal = getMethodNet('Credit Card / Bank') + customBankOtherBal;
      const totalCashEquiv = cashDrawerBal + momoBal + bankCardBal;

      const stInvVal = st === 'all' ? totalPhysicalInventoryValue : (invValueByStore[st] || 0);
      const stTransitVal =
        transitPos
          .filter(p => matchStore(p.store_id) && p.status !== 'RECEIVED')
          .reduce((s, p) => s + Number(p.grand_landed_total || 0), 0) +
        supplyPos
          .filter(p => matchStore(p.store_id) && p.stage !== 'LANDED_AT_STORE')
          .reduce((s, p) => s + Number(p.total_landed_cost || 0), 0);
      const stFixedAssets = assetsList
        .filter(a => matchStore(a.store_id) && a.status !== 'Disposed' && a.status !== 'Written Off')
        .reduce((s, a) => s + calculateAssetValuation(a).netBookValue, 0);
      const totalAssets = totalCashEquiv + stInvVal + stTransitVal + stFixedAssets;

      // Liabilities
      const stLaybyLiability = laybys
        .filter(l => matchStore(l.store_id) && l.status !== 'COMPLETED')
        .reduce((s, l) => s + Number(l.amount_paid || 0), 0);
      const stLoansLiability = st === 'all' || st === defaultFallbackStore ? netLoansPayable : 0;
      const totalLiabilities = vatCollected + stLaybyLiability + stLoansLiability;

      // Equity (Assets - Liabilities = Total Equity, decomposed into Owner Capital + Retained Earnings)
      const stOwnerCapital = equityList
        .filter(eq => matchStore(eq.store_id) && String(eq.status || 'Active') !== 'Reversed')
        .reduce((s, eq) => {
          const t = String(eq.equity_type || '').toLowerCase();
          const isDraw = t.includes('drawing') || t.includes('dividend');
          return s + (isDraw ? -Number(eq.value || 0) : Number(eq.value || 0));
        }, 0);
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
        id: `STMT_${activeBizSlug}_${st.toUpperCase()}`,
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
        updated_at: nowIso,
        business_id: activeBizId
      });
    }

    if (alasql.tables.financial_statements_ledger) {
      alasql.tables.financial_statements_ledger.data = [...otherStatementRows, ...statementRows];
    }

    // 7. Immediately update/upsert Today's Live EOD Cash-Up Register (`cash_ups`) in the database
    if (individualStores.length > 0 || orders.length > 0 || expenses.length > 0) {
      for (const st of storesList) {
        const matchStore = (rowStore: any) => st === 'all' || String(rowStore || defaultFallbackStore).toLowerCase().trim() === st;
        const isToday = (dVal: any) => toLocalDateKey(dVal) === todayDate;

        let eodCashSales = 0;
        let eodCardSales = 0;
        let eodMomoSales = 0;
        let eodAirtelSales = 0;
        let eodMtnSales = 0;
        let eodCustomMomoSales = 0;
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
            const { cashPart, momoPart, momoBucket } = getSplitAmountsForOrder(o, tot);
            eodCashSales += cashPart;
            eodMomoSales += momoPart;
            const sign = isRef ? -1 : 1;
            if (momoBucket === 'Airtel Money') eodAirtelSales += sign * momoPart;
            else if (momoBucket === 'MTN Mobile Money') eodMtnSales += sign * momoPart;
            else eodCustomMomoSales += sign * momoPart;
            if (isRef) {
              eodRefundsCash += cashPart;
              eodRefundsMomo += momoPart;
            }
          } else if (resolved.category === 'Cash') {
            eodCashSales += tot;
            if (isRef) eodRefundsCash += tot;
          } else if (resolved.category === 'Bank / Card' || resolved.category === 'Other') {
            eodCardSales += tot;
            if (isRef) eodRefundsCard += tot;
          } else {
            eodMomoSales += tot;
            const sign = isRef ? -1 : 1;
            if (resolved.bucket === 'Airtel Money') eodAirtelSales += sign * tot;
            else if (resolved.bucket === 'MTN Mobile Money') eodMtnSales += sign * tot;
            else eodCustomMomoSales += sign * tot;
            if (isRef) eodRefundsMomo += tot;
          }
        });

        laybyInstallments.forEach(inst => {
          if (!isToday(inst.created_at)) return;
          const pLayby = laybyMap.get(String(inst.layby_id || ''));
          if (!matchStore(pLayby?.store_id)) return;
          const amt = Number(inst.amount || 0);
          const resolved = resolvePaymentMethodBucket(inst.payment_method);
          if (resolved.category === 'Cash') eodCashSales += amt;
          else if (resolved.category === 'Bank / Card' || resolved.category === 'Other') eodCardSales += amt;
          else {
            eodMomoSales += amt;
            if (resolved.bucket === 'Airtel Money') eodAirtelSales += amt;
            else if (resolved.bucket === 'MTN Mobile Money') eodMtnSales += amt;
            else eodCustomMomoSales += amt;
          }
        });

        let eodCashExpenses = 0;
        expenses.forEach(ex => {
          if (!isToday(ex.expense_date || ex.created_at) || !matchStore(ex.store_id)) return;
          if (String(ex.account_id || 'acc_cash').toLowerCase() === 'acc_cash') {
            eodCashExpenses += Number(ex.amount || 0);
          }
        });

        let openingFloat = 0;
        if (typeof localStorage !== 'undefined') {
          if (st === 'all') {
            const sumAllBranches = individualStores.reduce((sum, bId) => {
              const val = parseFloat(localStorage.getItem('shift_opening_cash_' + bId) || '0');
              return sum + (isNaN(val) ? 0 : val);
            }, 0);
            openingFloat = individualStores.length > 0 && sumAllBranches > 0
              ? sumAllBranches
              : (parseFloat(localStorage.getItem('shift_opening_cash_global') || '0') || 0);
          } else {
            openingFloat = parseFloat(localStorage.getItem('shift_opening_cash_' + st) || localStorage.getItem('shift_opening_cash_global') || '0') || 0;
          }
        }

        const netExpectedCash = parseFloat((openingFloat + eodCashSales - eodRefundsCash - eodCashExpenses).toFixed(2));
        const netExpectedCard = parseFloat((eodCardSales - eodRefundsCard).toFixed(2));
        const netExpectedMomo = parseFloat((eodMomoSales - eodRefundsMomo).toFixed(2));

        const liveEodId = `EOD-LIVE-${activeBizSlug}-${todayDate}-${st.toUpperCase()}`;
        runSql(`DELETE FROM cash_ups WHERE id = '${sqlEsc(liveEodId)}'`, 'EOD Sync: Refresh live EOD row', true);
        runSql(
          `INSERT INTO cash_ups (id, date, store_id, cashier_name, sum_cash_expected, sum_cash_actual, sum_card_expected, sum_card_actual, sum_momo_expected, sum_momo_actual, variance, notes, created_at, business_id) VALUES (
            '${sqlEsc(liveEodId)}',
            '${todayDate}',
            '${sqlEsc(st)}',
            'LIVE AUTO-LEDGER (${sqlEsc(triggerReason)})',
            ${netExpectedCash},
            ${netExpectedCash},
            ${netExpectedCard},
            ${netExpectedCard},
            ${netExpectedMomo},
            ${netExpectedMomo},
            0.00,
            'Auto-synced EOD | Cash Sales: ${eodCashSales.toFixed(2)} | Airtel: ${eodAirtelSales.toFixed(2)} | MTN: ${eodMtnSales.toFixed(2)}${eodCustomMomoSales > 0 ? ` | Custom MoMo: ${eodCustomMomoSales.toFixed(2)}` : ''} | Refunds: ${(eodRefundsCash + eodRefundsCard + eodRefundsMomo).toFixed(2)} | Cash Out: ${eodCashExpenses.toFixed(2)}',
            '${nowIso}',
            '${sqlEsc(activeBizId)}'
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
let activeCloudPushPromise: Promise<{
  success: boolean;
  businessId?: string;
  updatedAt?: string;
  details: string;
}> | null = null;

export async function pushDatabaseToServer(explicitBusinessId?: string): Promise<{
  success: boolean;
  businessId?: string;
  updatedAt?: string;
  details: string;
}> {
  if (activeCloudPushPromise) {
    return activeCloudPushPromise;
  }

  activeCloudPushPromise = (async () => {
  try {
    syncAllAccountingSystems('Pre-Cloud Push Sync');
    const resolvedBizId = getActiveBusinessId(explicitBusinessId);
    const allSnapshot = extractAllTablesSnapshot();
    const bizRows = allSnapshot['businesses'] || [];
    let bizId = resolvedBizId || '';
    let bizName = '';
    let ownerEmail = '';

    if (typeof localStorage !== 'undefined') {
      try {
        const cached = JSON.parse(localStorage.getItem('active_business_profile') || '{}');
        if (cached && cached.id && cached.id !== 'default_biz') {
          if (!bizId) bizId = cached.id;
          if (!bizId || cached.id === bizId) {
            bizName = cached.name || '';
            ownerEmail = cached.email || '';
          }
        }
      } catch {}
    }

    if (bizId) {
      const matchedBiz = bizRows.find((b: any) => b.id === bizId);
      if (matchedBiz) {
        bizName = bizName || matchedBiz.name || '';
        ownerEmail = ownerEmail || matchedBiz.email || '';
      }
    } else if (bizRows.length > 0) {
      bizId = bizRows[0].id;
      bizName = bizRows[0].name || '';
      ownerEmail = bizRows[0].email || '';
    }

    if (!bizId) {
      bizId = '__global__';
    }

    const tables = extractAllTablesSnapshot(bizId !== '__global__' ? bizId : undefined);

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
  } finally {
    activeCloudPushPromise = null;
  }
  })();

  return activeCloudPushPromise;
}

export async function pullDatabaseFromServer(
  businessId?: string,
  email?: string,
  credentialHash?: string
): Promise<{
  success: boolean;
  found: boolean;
  business?: any;
  settings?: any;
  availableBusinesses?: any[];
  matchedBusinessIds?: string[];
  updatedAt?: string;
  details: string;
}> {
  try {
    const params = new URLSearchParams();
    if (businessId && businessId.trim()) params.set('businessId', businessId.trim());
    if (email && email.trim()) params.set('email', email.trim());
    if (credentialHash && credentialHash.trim()) params.set('credentialHash', credentialHash.trim());

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
        matchedBusinessIds: data.matchedBusinessIds || [],
        details: 'No synchronized business data found on Cloud SQL server yet.',
      };
    }

    const cleanedTables = scrubLegacyPreseededRows(data.tables);
    const bizRows = Array.isArray(cleanedTables.businesses) ? cleanedTables.businesses : [];
    const targetBiz =
      bizRows.find((b: any) => b.id === data.businessId) ||
      (email ? bizRows.find((b: any) => String(b.email || '').toLowerCase() === email.toLowerCase()) : null) ||
      bizRows[0] ||
      null;

    if (targetBiz && typeof localStorage !== 'undefined') {
      localStorage.setItem('active_business_profile', JSON.stringify(targetBiz));
    }

    rehydrateAlasqlFromRecords(cleanedTables, {
      businessId: targetBiz?.id || data.businessId,
      preserveOtherBusinesses: true,
    });
    syncUsersAndMembershipsFromLegacyTables(targetBiz?.id || data.businessId);
    syncAllAccountingSystems('Cloud SQL Pull Rehydration');
    persistTablesToStorage(true);

    if (data.settings && typeof localStorage !== 'undefined') {
      const targetBizId = String(targetBiz?.id || data.businessId || '').trim();
      const serialized = JSON.stringify(data.settings);
      if (targetBizId && targetBizId !== 'default_biz') {
        localStorage.setItem(`android_pos_settings_${targetBizId}`, serialized);
      }
      localStorage.setItem('android_pos_settings', serialized);
    }

    if (data.updatedAt && typeof localStorage !== 'undefined') {
      localStorage.setItem('pos_last_cloud_sync', data.updatedAt);
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('local_db_restored'));
      window.dispatchEvent(new Event('pos_data_updated'));
      window.dispatchEvent(new CustomEvent('pos_sync_status_changed', { detail: { syncedAt: data.updatedAt, status: 'synced' } }));
    }

    const prodCount = (cleanedTables.products || []).length;
    const storeCount = (cleanedTables.stores || []).length;
    const orderCount = (cleanedTables.orders || []).length;

    return {
      success: true,
      found: true,
      business: targetBiz,
      settings: data.settings || null,
      availableBusinesses: data.availableBusinesses || [],
      matchedBusinessIds: data.matchedBusinessIds || [],
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

export function getTenantAccountBalances(explicitBusinessId?: string): Array<{
  account_id: string;
  account_name: string;
  currency: string;
  current_balance: number;
}> {
  const bizId = getActiveBusinessId(explicitBusinessId);
  const rawAccounts = (alasql?.tables?.accounts?.data || []) as any[];
  const acctMap = new Map<string, any>();
  rawAccounts.forEach((a: any) => {
    if (!a?.id) return;
    if (!acctMap.has(String(a.id))) {
      acctMap.set(String(a.id), a);
    }
  });

  const entries = filterRowsByBusiness((alasql?.tables?.ledger_entries?.data || []) as any[], bizId);
  const balMap = new Map<string, number>();

  acctMap.forEach((_a, id) => {
    balMap.set(id, 0);
  });

  entries.forEach((le: any) => {
    const accId = String(le.account_id || '');
    const accDef = acctMap.get(accId);
    const accType = String(accDef?.type || 'ASSET').toUpperCase();
    const amt = Number(le.amount || 0);
    const entryType = String(le.type || '').toUpperCase();
    let delta = 0;
    if (accType === 'ASSET' || accType === 'EXPENSE') {
      delta = entryType === 'DEBIT' ? amt : entryType === 'CREDIT' ? -amt : 0;
    } else if (accType === 'LIABILITY' || accType === 'REVENUE' || accType === 'EQUITY') {
      delta = entryType === 'CREDIT' ? amt : entryType === 'DEBIT' ? -amt : 0;
    }
    balMap.set(accId, (balMap.get(accId) || 0) + delta);
  });

  return Array.from(acctMap.entries()).map(([id, a]) => ({
    account_id: id,
    account_name: String(a.name || id),
    currency: String(a.currency || 'ZMW'),
    current_balance: parseFloat((balMap.get(id) || 0).toFixed(2)),
  }));
}

export function upsertUserAndMembership(params: {
  id?: string;
  businessId: string;
  email: string;
  fullName: string;
  password?: string;
  credentialHash?: string;
  role: 'owner' | 'manager' | 'sales';
  storeId?: string;
  accessibleBranches?: string[];
  permissionsJson?: string;
  status?: 'ACTIVE' | 'SUSPENDED';
}) {
  const cleanEmail = normalizeAuthEmail(params.email);
  const cleanBizId = String(params.businessId || '').trim();
  if (!cleanEmail || !cleanBizId || cleanBizId === 'default_biz') return null;

  const userId = deriveUserId(cleanEmail);
  const nowIso = new Date().toISOString();
  const normRole: 'owner' | 'manager' | 'sales' =
    params.role === 'owner' ? 'owner' : params.role === 'manager' ? 'manager' : 'sales';
  const membershipId = params.id ? String(params.id) : deriveMembershipId(cleanBizId, userId, normRole);
  const cleanPass = String(params.password || '').trim();
  const computedHash =
    params.credentialHash ||
    (cleanPass && cleanPass !== 'cloud_recovered' ? computeCredentialHashSync(cleanEmail, cleanPass) : '');
  const branchesJson = JSON.stringify(Array.isArray(params.accessibleBranches) ? params.accessibleBranches : []);
  const statusVal = params.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE';
  const primaryStore = String(params.storeId || (params.accessibleBranches?.[0] || 'main')).trim() || 'main';
  const safeName = String(params.fullName || cleanEmail).trim() || cleanEmail;

  const existingUsers = (alasql?.tables?.users?.data || []) as any[];
  const userIdx = existingUsers.findIndex((u: any) => String(u?.id || '') === userId || normalizeAuthEmail(u?.email) === cleanEmail);
  if (userIdx >= 0) {
    existingUsers[userIdx] = {
      ...existingUsers[userIdx],
      id: userId,
      email: cleanEmail,
      full_name: safeName,
      updated_at: nowIso,
      business_id: existingUsers[userIdx].business_id || cleanBizId,
      store_id: existingUsers[userIdx].store_id || primaryStore,
    };
  } else {
    runSql(
      `INSERT INTO users (id, email, full_name, created_at, updated_at, business_id, store_id) VALUES ('${sqlEsc(userId)}', '${sqlEsc(cleanEmail)}', '${sqlEsc(safeName)}', '${nowIso}', '${nowIso}', '${sqlEsc(cleanBizId)}', '${sqlEsc(primaryStore)}')`,
      'MultiTenant: Upsert decoupled user identity',
      true
    );
  }

  const memberships = (alasql?.tables?.business_memberships?.data || []) as any[];
  const existingMemIdx = memberships.findIndex(
    (m: any) =>
      String(m?.id || '') === membershipId ||
      (String(m?.business_id || '') === cleanBizId &&
        normalizeAuthEmail(m?.email) === cleanEmail &&
        String(m?.role || '') === normRole)
  );
  const rowPayload = {
    id: membershipId,
    user_id: userId,
    business_id: cleanBizId,
    email: cleanEmail,
    full_name: safeName,
    credential_hash: computedHash || (existingMemIdx >= 0 ? memberships[existingMemIdx].credential_hash || '' : ''),
    password: cleanPass || (existingMemIdx >= 0 ? memberships[existingMemIdx].password || '' : ''),
    role: normRole,
    store_id: primaryStore,
    accessible_branches: branchesJson,
    permissions_json: params.permissionsJson || (existingMemIdx >= 0 ? memberships[existingMemIdx].permissions_json || '{}' : '{}'),
    status: statusVal,
    created_at: existingMemIdx >= 0 ? memberships[existingMemIdx].created_at || nowIso : nowIso,
    updated_at: nowIso,
  };

  if (existingMemIdx >= 0) {
    memberships[existingMemIdx] = rowPayload;
  } else {
    runSql(
      `INSERT INTO business_memberships (id, user_id, business_id, email, full_name, credential_hash, password, role, store_id, accessible_branches, permissions_json, status, created_at, updated_at) VALUES (
        '${sqlEsc(rowPayload.id)}',
        '${sqlEsc(rowPayload.user_id)}',
        '${sqlEsc(rowPayload.business_id)}',
        '${sqlEsc(rowPayload.email)}',
        '${sqlEsc(rowPayload.full_name)}',
        '${sqlEsc(rowPayload.credential_hash)}',
        '${sqlEsc(rowPayload.password)}',
        '${sqlEsc(rowPayload.role)}',
        '${sqlEsc(rowPayload.store_id)}',
        '${sqlEsc(rowPayload.accessible_branches)}',
        '${sqlEsc(rowPayload.permissions_json)}',
        '${sqlEsc(rowPayload.status)}',
        '${sqlEsc(rowPayload.created_at)}',
        '${sqlEsc(rowPayload.updated_at)}'
      )`,
      'MultiTenant: Insert decoupled business membership',
      true
    );
  }
  return rowPayload;
}

export function syncUsersAndMembershipsFromLegacyTables(explicitBusinessId?: string) {
  if (!alasql?.tables?.businesses || !alasql?.tables?.business_memberships) return;
  const filterBiz = String(explicitBusinessId || '').trim();
  const bizRows = ((alasql.tables.businesses.data || []) as any[]).filter(
    (b: any) => b?.id && b.id !== 'default_biz' && (!filterBiz || b.id === filterBiz)
  );
  for (const b of bizRows) {
    const ownerEmail = normalizeAuthEmail(b.email || '');
    if (!ownerEmail) continue;
    upsertUserAndMembership({
      businessId: String(b.id),
      email: ownerEmail,
      fullName: String(b.owner || b.name || ownerEmail),
      password: b.password && b.password !== 'cloud_recovered' ? String(b.password) : '',
      role: 'owner',
      storeId: String(b.store_id || 'main'),
      accessibleBranches: [],
      status: 'ACTIVE',
    });
  }

  const staffRows = ((alasql.tables.staff?.data || []) as any[]).filter(
    (s: any) => s?.business_id && s.business_id !== 'default_biz' && (!filterBiz || s.business_id === filterBiz)
  );
  for (const st of staffRows) {
    const staffEmail = normalizeAuthEmail(st.email || '');
    if (!staffEmail) continue;
    let parsedPerms: any = {};
    try {
      if (st.permissions_json) parsedPerms = JSON.parse(st.permissions_json);
    } catch {}
    const staffRole =
      st.role === 'owner' ? 'owner' : st.role === 'manager' ? 'manager' : 'sales';
    const branches = Array.isArray(parsedPerms?.accessible_branches)
      ? parsedPerms.accessible_branches
      : st.store_id
        ? [String(st.store_id)]
        : [];
    const staffPass = String(st.password || parsedPerms?.password || st.pin || '').trim();
    const isSusp = Boolean(parsedPerms?.suspended || parsedPerms?.status === 'SUSPENDED');
    upsertUserAndMembership({
      id: `mem_staff_${String(st.id)}_${String(st.business_id)}`,
      businessId: String(st.business_id),
      email: staffEmail,
      fullName: String(st.name || `${st.first_name || ''} ${st.surname || ''}`.trim() || staffEmail),
      password: staffPass,
      role: staffRole,
      storeId: String(st.store_id || branches[0] || 'main'),
      accessibleBranches: branches,
      permissionsJson: String(st.permissions_json || '{}'),
      status: isSusp ? 'SUSPENDED' : 'ACTIVE',
    });
  }
}

export interface CredentialMembershipMatch {
  business: any;
  membership: any;
  staffRow: any | null;
  role: 'owner' | 'manager' | 'sales';
  fullName: string;
  accessibleBranches: string[];
  permissionsJson: string;
  isSuspended: boolean;
  credentialHash: string;
}

export function resolveMembershipsByCredential(
  email: string,
  password: string
): CredentialMembershipMatch[] {
  syncUsersAndMembershipsFromLegacyTables();
  const cleanEmail = normalizeAuthEmail(email);
  const rawPass = String(password || '').trim();
  if (!cleanEmail || !rawPass) return [];

  const targetHash = computeCredentialHashSync(cleanEmail, rawPass);
  const bizRows = ((alasql?.tables?.businesses?.data || []) as any[]).filter(
    (b: any) => b?.id && b.id !== 'default_biz'
  );
  const bizMap = new Map<string, any>(bizRows.map((b: any) => [String(b.id), b]));

  const staffRows = (alasql?.tables?.staff?.data || []) as any[];
  const memRows = (alasql?.tables?.business_memberships?.data || []) as any[];
  const results = new Map<string, CredentialMembershipMatch>();

  // 1. Strict (email, password/credential_hash) check against business_memberships
  for (const m of memRows) {
    const mEmail = normalizeAuthEmail(m?.email || '');
    const biz = bizMap.get(String(m?.business_id || ''));
    if (!mEmail || !biz) continue;
    if (mEmail !== cleanEmail) continue;

    const storedHash = String(m?.credential_hash || '').trim();
    const storedPass = String(m?.password || '').trim();
    const hashMatched = Boolean(storedHash && storedHash === targetHash);
    const passMatched = Boolean(storedPass && storedPass !== 'cloud_recovered' && storedPass === rawPass);
    if (!hashMatched && !passMatched) continue;

    if (!storedHash && passMatched) {
      m.credential_hash = targetHash;
    }

    const normRole: 'owner' | 'manager' | 'sales' =
      m.role === 'owner' ? 'owner' : m.role === 'manager' ? 'manager' : 'sales';
    let branches: string[] = [];
    try {
      const parsedB = JSON.parse(m.accessible_branches || '[]');
      if (Array.isArray(parsedB)) branches = parsedB;
    } catch {}
    const matchedStaff =
      staffRows.find(
        (s: any) =>
          String(s?.business_id || '') === String(biz.id) &&
          normalizeAuthEmail(s?.email || '') === cleanEmail
      ) || null;
    const key = `${biz.id}::${normRole}`;
    results.set(key, {
      business: biz,
      membership: m,
      staffRow: matchedStaff,
      role: normRole,
      fullName: String(m.full_name || matchedStaff?.name || biz.owner || cleanEmail),
      accessibleBranches: branches,
      permissionsJson: String(m.permissions_json || matchedStaff?.permissions_json || '{}'),
      isSuspended: String(m.status || 'ACTIVE').toUpperCase() === 'SUSPENDED',
      credentialHash: targetHash,
    });
  }

  // 2. Fallback check against businesses & staff directly in case any row wasn't stamped yet
  for (const b of bizRows) {
    const bEmail = normalizeAuthEmail(b?.email || '');
    const bPass = String(b?.password || '').trim();
    if (bEmail === cleanEmail && bPass && bPass !== 'cloud_recovered' && bPass === rawPass) {
      const key = `${b.id}::owner`;
      if (!results.has(key)) {
        const mem = upsertUserAndMembership({
          businessId: String(b.id),
          email: cleanEmail,
          fullName: String(b.owner || b.name || cleanEmail),
          password: rawPass,
          role: 'owner',
          storeId: String(b.store_id || 'main'),
        });
        results.set(key, {
          business: b,
          membership: mem,
          staffRow: null,
          role: 'owner',
          fullName: String(b.owner || b.name || cleanEmail),
          accessibleBranches: [],
          permissionsJson: '{}',
          isSuspended: false,
          credentialHash: targetHash,
        });
      }
    }
  }

  for (const st of staffRows) {
    const biz = bizMap.get(String(st?.business_id || ''));
    if (!biz) continue;
    const sEmail = normalizeAuthEmail(st?.email || '');
    const sPass = String(st?.password || '').trim();
    const sPin = String(st?.pin || '').trim();
    if (sEmail === cleanEmail && ((sPass && sPass === rawPass) || (sPin && sPin === rawPass))) {
      const normRole: 'owner' | 'manager' | 'sales' =
        st.role === 'owner' ? 'owner' : st.role === 'manager' ? 'manager' : 'sales';
      const key = `${biz.id}::${normRole}`;
      if (!results.has(key)) {
        let perms: any = {};
        try {
          if (st.permissions_json) perms = JSON.parse(st.permissions_json);
        } catch {}
        const branches = Array.isArray(perms?.accessible_branches)
          ? perms.accessible_branches
          : st.store_id
            ? [String(st.store_id)]
            : [];
        const isSusp = Boolean(perms?.suspended || perms?.status === 'SUSPENDED');
        const mem = upsertUserAndMembership({
          id: `mem_staff_${String(st.id)}_${String(biz.id)}`,
          businessId: String(biz.id),
          email: cleanEmail,
          fullName: String(st.name || `${st.first_name || ''} ${st.surname || ''}`.trim() || cleanEmail),
          password: rawPass,
          role: normRole,
          storeId: String(st.store_id || branches[0] || 'main'),
          accessibleBranches: branches,
          permissionsJson: String(st.permissions_json || '{}'),
          status: isSusp ? 'SUSPENDED' : 'ACTIVE',
        });
        results.set(key, {
          business: biz,
          membership: mem,
          staffRow: st,
          role: normRole,
          fullName: String(st.name || cleanEmail),
          accessibleBranches: branches,
          permissionsJson: String(st.permissions_json || '{}'),
          isSuspended: isSusp,
          credentialHash: targetHash,
        });
      }
    }
  }

  return Array.from(results.values());
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




