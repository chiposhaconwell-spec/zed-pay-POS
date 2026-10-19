import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { App as CapApp } from '@capacitor/app';

const DB_NAME = 'pos_retail_db';
const SNAPSHOT_FILENAME = 'pos_retail_db_store.json';

let sqliteConnection: SQLiteConnection | null = null;
let dbConnection: SQLiteDBConnection | null = null;
let isSqliteReady = false;
let isInitInProgress = false;

// List of all tables managed by the POS system
export const ALL_TABLE_NAMES = [
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
  'money_transfers',
  'assets',
  'equity',
  'double_entry_journal',
  'audit_logs',
  'receipt_refund_ledger',
  'cash_flow_ledger',
  'payment_method_ledger',
  'financial_statements_ledger'
];

/**
 * Table DDL definitions for SQLite compatibility
 */
const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT,
  owner TEXT,
  email TEXT,
  password TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  business_id TEXT,
  name TEXT,
  location TEXT,
  allow_discounts INTEGER,
  allow_refunds INTEGER,
  allow_laybys INTEGER,
  require_manager_discount INTEGER,
  stocktake_frequency TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT,
  sku TEXT,
  category TEXT,
  price REAL,
  cost REAL,
  stock INTEGER,
  imageUrl TEXT,
  business_id TEXT,
  is_service INTEGER DEFAULT 0,
  batch_number TEXT,
  expiry_date TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT,
  phone TEXT,
  email TEXT,
  loyalPoints INTEGER,
  tpin TEXT,
  zra_connected INTEGER,
  tax_band TEXT,
  business_id TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customerId INTEGER,
  orderDate TEXT,
  subtotal REAL,
  tax REAL,
  discount REAL,
  total REAL,
  paymentMethod TEXT,
  status TEXT,
  store_id TEXT,
  performed_by TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  orderId TEXT,
  productId INTEGER,
  quantity INTEGER,
  unitPrice REAL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT,
  type TEXT,
  currency TEXT DEFAULT 'ZMW',
  merchant_id TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT,
  pos_terminal_id TEXT,
  channel TEXT,
  provider_reference TEXT,
  amount REAL,
  fee_amount REAL,
  status TEXT,
  narration TEXT,
  created_at TEXT,
  updated_at TEXT,
  performed_by TEXT
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  transaction_id TEXT,
  account_id TEXT,
  type TEXT,
  amount REAL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS laybys (
  id TEXT PRIMARY KEY,
  customer_id INTEGER,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  total_amount REAL,
  deposit_amount REAL,
  amount_paid REAL,
  balance_due REAL,
  status TEXT,
  items_json TEXT,
  created_at TEXT,
  store_id TEXT
);

CREATE TABLE IF NOT EXISTS layby_installments (
  id TEXT PRIMARY KEY,
  layby_id TEXT,
  amount REAL,
  payment_method TEXT,
  received_by TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS time_attendance (
  id TEXT PRIMARY KEY,
  employee_name TEXT,
  employee_role TEXT,
  date TEXT,
  clock_in TEXT,
  clock_out TEXT,
  hours_worked REAL,
  hourly_rate REAL,
  gross_payment REAL,
  status TEXT
);

CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  first_name TEXT,
  surname TEXT,
  contact TEXT,
  email TEXT,
  residential_address TEXT,
  joining_date TEXT,
  nrc_file TEXT,
  nrc_filename TEXT,
  contract_file TEXT,
  contract_filename TEXT,
  basic_salary REAL,
  permissions_json TEXT,
  business_id TEXT,
  password TEXT
);

CREATE TABLE IF NOT EXISTS store_products (
  id TEXT PRIMARY KEY,
  product_id INTEGER,
  store_id TEXT,
  stock INTEGER,
  price REAL
);

CREATE TABLE IF NOT EXISTS stock_transfers (
  id TEXT PRIMARY KEY,
  product_id INTEGER,
  from_store TEXT,
  to_store TEXT,
  quantity INTEGER,
  status TEXT,
  created_at TEXT,
  rejection_reason TEXT
);

CREATE TABLE IF NOT EXISTS cash_ups (
  id TEXT PRIMARY KEY,
  date TEXT,
  store_id TEXT,
  cashier_name TEXT,
  sum_cash_expected REAL,
  sum_cash_actual REAL,
  sum_card_expected REAL,
  sum_card_actual REAL,
  sum_momo_expected REAL,
  sum_momo_actual REAL,
  variance REAL,
  notes TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS quotations (
  id TEXT PRIMARY KEY,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  items_json TEXT,
  subtotal REAL,
  tax REAL,
  discount REAL,
  total REAL,
  bank_name TEXT,
  bank_account TEXT,
  bank_branch TEXT,
  status TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  merchant_id TEXT,
  loan_account_id TEXT,
  principal_amount REAL,
  interest_amount REAL,
  total_repayable REAL,
  daily_deduction_percentage REAL,
  status TEXT,
  disbursed_at TEXT,
  due_date TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS loan_amortization_schedule (
  id TEXT PRIMARY KEY,
  loan_id TEXT,
  installment_number INTEGER,
  principal_due REAL,
  interest_due REAL,
  total_due REAL,
  amount_paid REAL,
  is_settled INTEGER,
  due_date TEXT,
  settled_at TEXT
);

CREATE TABLE IF NOT EXISTS automated_deduction_logs (
  id TEXT PRIMARY KEY,
  loan_id TEXT,
  source_transaction_id TEXT,
  amount_deducted REAL,
  status TEXT,
  failure_reason TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS stock_takes (
  id TEXT PRIMARY KEY,
  store_id TEXT,
  taken_at TEXT,
  performed_by TEXT,
  status TEXT
);

CREATE TABLE IF NOT EXISTS stock_take_items (
  id TEXT PRIMARY KEY,
  stock_take_id TEXT,
  product_id INTEGER,
  recorded_stock INTEGER,
  counted_stock INTEGER,
  variance INTEGER
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  category TEXT,
  payment_method TEXT,
  account_id TEXT,
  amount REAL,
  description TEXT,
  ref_number TEXT,
  reference_no TEXT,
  expense_date TEXT,
  store_id TEXT,
  performed_by TEXT,
  created_by TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS purchases_transit (
  id TEXT PRIMARY KEY,
  supplier_name TEXT,
  store_id TEXT,
  payment_account_id TEXT,
  payment_method TEXT,
  items_json TEXT,
  additional_expenses_json TEXT,
  total_base_amount REAL,
  total_additional_expenses REAL,
  total_landed_cost REAL,
  stage TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT,
  received_at TEXT,
  received_by TEXT
);

CREATE TABLE IF NOT EXISTS transit_purchases (
  id TEXT PRIMARY KEY,
  supplier_name TEXT,
  store_id TEXT,
  payment_account TEXT,
  payment_method TEXT,
  base_total REAL,
  additional_expenses_total REAL,
  grand_landed_total REAL,
  status TEXT,
  items_json TEXT,
  additional_expenses_json TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT,
  received_at TEXT,
  received_by TEXT
);

CREATE TABLE IF NOT EXISTS money_transfers (
  id TEXT PRIMARY KEY,
  source_account TEXT,
  dest_account TEXT,
  amount REAL,
  reference_no TEXT,
  transfer_date TEXT,
  performed_by TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  name TEXT,
  category TEXT,
  type TEXT,
  purchase_date TEXT,
  value REAL,
  depreciation_method TEXT,
  depreciation_rate REAL,
  status TEXT,
  notes TEXT,
  linked_equity_id TEXT
);

CREATE TABLE IF NOT EXISTS equity (
  id TEXT PRIMARY KEY,
  name TEXT,
  value REAL,
  linked_asset_id TEXT
);

CREATE TABLE IF NOT EXISTS double_entry_journal (
  id TEXT PRIMARY KEY,
  date TEXT,
  reference TEXT,
  description TEXT,
  account_debit TEXT,
  account_credit TEXT,
  amount REAL,
  currency TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  module TEXT,
  action TEXT,
  details TEXT,
  amount REAL,
  store_id TEXT,
  performed_by TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS receipt_refund_ledger (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  entry_type TEXT,
  date TEXT,
  store_id TEXT,
  customer_name TEXT,
  payment_method TEXT,
  subtotal REAL,
  tax REAL,
  discount REAL,
  total_amount REAL,
  cogs_amount REAL,
  net_revenue_impact REAL,
  cash_impact REAL,
  performed_by TEXT,
  journal_ref TEXT,
  status TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS cash_flow_ledger (
  id TEXT PRIMARY KEY,
  date TEXT,
  store_id TEXT,
  activity_type TEXT,
  category TEXT,
  direction TEXT,
  payment_method TEXT,
  account_id TEXT,
  inflow_amount REAL,
  outflow_amount REAL,
  net_cash_change REAL,
  reference_id TEXT,
  description TEXT,
  performed_by TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS payment_method_ledger (
  id TEXT PRIMARY KEY,
  payment_method TEXT,
  store_id TEXT,
  account_id TEXT,
  gross_receipts REAL,
  layby_receipts REAL,
  refunds_out REAL,
  expenses_out REAL,
  transfers_in REAL,
  transfers_out REAL,
  net_balance REAL,
  transaction_count INTEGER,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS financial_statements_ledger (
  id TEXT PRIMARY KEY,
  store_id TEXT,
  period_date TEXT,
  gross_sales_revenue REAL,
  sales_returns_refunds REAL,
  discounts_allowed REAL,
  vat_tax_collected REAL,
  net_sales_revenue REAL,
  cost_of_goods_sold REAL,
  gross_profit REAL,
  operating_expenses REAL,
  payroll_expenses REAL,
  net_operating_income REAL,
  cash_and_equivalents REAL,
  cash_drawer_balance REAL,
  mobile_money_balance REAL,
  bank_card_balance REAL,
  inventory_asset_value REAL,
  goods_in_transit_value REAL,
  fixed_assets_value REAL,
  total_assets REAL,
  vat_payable_liability REAL,
  layby_deposits_liability REAL,
  loans_payable_liability REAL,
  total_liabilities REAL,
  owner_capital_equity REAL,
  retained_earnings REAL,
  total_equity REAL,
  operating_cash_flow REAL,
  investing_cash_flow REAL,
  financing_cash_flow REAL,
  net_cash_flow REAL,
  updated_at TEXT
);
`;

/**
 * Initializes the SQLite Connection on Android devices
 */
export async function initSqliteStorage(): Promise<boolean> {
  if (isSqliteReady) return true;
  if (isInitInProgress) return false;
  isInitInProgress = true;

  try {
    const isNative = Capacitor.isNativePlatform();
    console.log(`[SqliteStorage] Initializing storage, isNative: ${isNative}, platform: ${Capacitor.getPlatform()}`);

    if (isNative) {
      sqliteConnection = new SQLiteConnection(CapacitorSQLite);

      // Check if connection already exists
      const isConn = await sqliteConnection.isConnection(DB_NAME, false);
      if (isConn.result) {
        dbConnection = await sqliteConnection.retrieveConnection(DB_NAME, false);
      } else {
        dbConnection = await sqliteConnection.createConnection(
          DB_NAME,
          false,
          'no-encryption',
          1,
          false
        );
      }

      await dbConnection.open();
      console.log('[SqliteStorage] SQLite database opened on Android filesystem');

      // Create schema
      await dbConnection.execute(SQLITE_SCHEMA);
      console.log('[SqliteStorage] SQLite schema verified');
      isSqliteReady = true;
    }

    // Set up app lifecycle event listeners to guarantee flush before closing
    setupLifecycleListeners();

    return true;
  } catch (err) {
    console.warn('[SqliteStorage] Native SQLite initialization fallback to Filesystem & Preferences:', err);
    return false;
  } finally {
    isInitInProgress = false;
  }
}

/**
 * Listen for Android app pause, backgrounding, or tab close to flush database
 */
let isListenerSet = false;
function setupLifecycleListeners() {
  if (isListenerSet) return;
  isListenerSet = true;

  try {
    CapApp.addListener('appStateChange', (state) => {
      if (!state.isActive) {
        console.log('[SqliteStorage] App went to background, triggering immediate flush');
        triggerImmediateFlush();
      }
    });
  } catch (e) {
    // web fallback
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        triggerImmediateFlush();
      }
    });
    window.addEventListener('pagehide', () => {
      triggerImmediateFlush();
    });
  }
}

let pendingFlushData: Record<string, any[]> | null = null;
let flushTimeout: any = null;

export function registerPendingSync(tablesData: Record<string, any[]>) {
  pendingFlushData = tablesData;
  if (flushTimeout) clearTimeout(flushTimeout);
  flushTimeout = setTimeout(() => {
    executePersistentFlush();
  }, 350);
}

export function triggerImmediateFlush() {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }
  executePersistentFlush();
}

/**
 * Asynchronously flushes in-memory data to:
 * 1. Persistent SQLite database (on Android)
 * 2. Persistent Filesystem JSON file in Directory.Data
 * 3. Capacitor Preferences
 */
async function executePersistentFlush() {
  if (!pendingFlushData) return;
  const data = pendingFlushData;
  pendingFlushData = null;

  // 1. Filesystem snapshot (Android path: /data/user/0/com.pos.retail.app/files/pos_retail_db_store.json)
  try {
    const jsonString = JSON.stringify(data);
    await Filesystem.writeFile({
      path: SNAPSHOT_FILENAME,
      data: jsonString,
      directory: Directory.Data,
      encoding: Encoding.UTF8
    });
  } catch (fsErr) {
    console.warn('[SqliteStorage] Filesystem write notice (expected in web preview):', fsErr);
  }

  // 2. Preferences sync (Android SharedPreferences)
  try {
    await Preferences.set({
      key: 'pos_retail_last_sync_timestamp',
      value: new Date().toISOString()
    });
  } catch (prefErr) {
    // ignore
  }

  // 3. Native SQLite database sync
  if (isSqliteReady && dbConnection) {
    try {
      const isOpened = await dbConnection.isDBOpen();
      if (!isOpened.result) {
        await dbConnection.open();
      }

      await dbConnection.beginTransaction();

      for (const [table, rows] of Object.entries(data)) {
        if (!Array.isArray(rows) || !ALL_TABLE_NAMES.includes(table)) continue;

        // Clear existing table and re-insert rows
        await dbConnection.run(`DELETE FROM ${table};`, []);

        if (rows.length > 0) {
          for (const row of rows) {
            const keys = Object.keys(row);
            if (keys.length === 0) continue;
            const placeholders = keys.map(() => '?').join(', ');
            const values = keys.map(k => {
              const v = row[k];
              if (v === null || v === undefined) return null;
              if (typeof v === 'object') return JSON.stringify(v);
              if (typeof v === 'boolean') return v ? 1 : 0;
              return v;
            });
            const insertSql = `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${placeholders});`;
            await dbConnection.run(insertSql, values);
          }
        }
      }

      await dbConnection.commitTransaction();
      console.log('[SqliteStorage] Flushed tables to native SQLite successfully');
    } catch (sqlErr) {
      console.error('[SqliteStorage] Error saving to SQLite:', sqlErr);
      try {
        await dbConnection.rollbackTransaction();
      } catch (rbErr) {
        // ignore
      }
    }
  }
}

/**
 * Recovers all tables from persistent storage (SQLite or Filesystem snapshot)
 */
export async function loadTablesFromPersistentStorage(): Promise<Record<string, any[]> | null> {
  const result: Record<string, any[]> = {};
  let foundAny = false;

  // 1. Try native SQLite if ready
  if (isSqliteReady && dbConnection) {
    try {
      const isOpened = await dbConnection.isDBOpen();
      if (!isOpened.result) await dbConnection.open();

      for (const table of ALL_TABLE_NAMES) {
        try {
          const res = await dbConnection.query(`SELECT * FROM ${table};`);
          if (res && res.values && res.values.length > 0) {
            result[table] = res.values;
            foundAny = true;
          }
        } catch (tableErr) {
          // Table might be empty or not yet seeded
        }
      }

      if (foundAny && result['products'] && result['products'].length > 0) {
        console.log('[SqliteStorage] Successfully recovered data from native SQLite database');
        return result;
      }
    } catch (err) {
      console.warn('[SqliteStorage] Failed to query SQLite, trying filesystem backup:', err);
    }
  }

  // 2. Try Filesystem persistent snapshot
  try {
    const file = await Filesystem.readFile({
      path: SNAPSHOT_FILENAME,
      directory: Directory.Data,
      encoding: Encoding.UTF8
    });
    if (file && typeof file.data === 'string') {
      const parsed = JSON.parse(file.data);
      if (parsed && typeof parsed === 'object') {
        console.log('[SqliteStorage] Successfully recovered data from Android Filesystem snapshot');
        return parsed;
      }
    }
  } catch (fsErr) {
    // File not found or not yet created
  }

  return null;
}
