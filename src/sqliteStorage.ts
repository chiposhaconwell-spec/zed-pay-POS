import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { App as CapApp } from '@capacitor/app';

const DB_NAME = 'pos_retail_db';
const CACHE_FILENAME = 'pos_retail_device_cache.json';
const LEGACY_SNAPSHOT_FILENAME = 'pos_retail_db_store.json';
const WEB_RECEIPT_CACHE_KEY = 'pos_sqlite_receipt_cache_v1';

let sqliteConnection: SQLiteConnection | null = null;
let dbConnection: SQLiteDBConnection | null = null;
let isSqliteReady = false;
let isInitInProgress = false;

/**
 * On-device SQLite scope:
 * Strictly restricted to read-through catalog/branch/customer caching and local receipts / offline ZRA fiscal queue.
 * Financial ledgers, double-entry journals, assets, equity, payroll, and centralized reports live in Firestore & Central Cloud SQL.
 */
export const SQLITE_CACHE_TABLES = [
  'businesses',
  'stores',
  'products',
  'store_products',
  'customers',
  'payment_methods',
  'suppliers',
] as const;

export const SQLITE_RECEIPT_TABLES = [
  'orders',
  'order_items',
  'zra_invoices',
  'zra_sync_queue',
  'local_receipts',
] as const;

export const SQLITE_SCOPED_TABLES: string[] = [
  ...SQLITE_CACHE_TABLES,
  ...SQLITE_RECEIPT_TABLES,
];

// Kept for backward-compatible exports; SQLite storage itself only persists SQLITE_SCOPED_TABLES.
export const ALL_TABLE_NAMES: string[] = [...SQLITE_SCOPED_TABLES];

export interface LocalReceiptRecord {
  id: string;
  order_id: string;
  business_id: string;
  store_id: string;
  tx_type: 'SALE' | 'REFUND';
  receipt_number: string;
  customer_name: string;
  payment_method: string;
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  items_json: string;
  receipt_payload_json?: string;
  fiscal_qr_url?: string;
  performed_by: string;
  status: string;
  mirror_status: 'PENDING' | 'MIRRORED';
  created_at: string;
}

/**
 * Table DDL definitions for SQLite on-device cache & receipt store ONLY
 */
const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT,
  owner TEXT,
  email TEXT,
  password TEXT,
  created_at TEXT,
  business_id TEXT,
  store_id TEXT
);

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  business_id TEXT,
  name TEXT,
  location TEXT,
  phone TEXT,
  email TEXT,
  allow_discounts INTEGER,
  allow_refunds INTEGER,
  allow_laybys INTEGER,
  require_manager_discount INTEGER,
  stocktake_frequency TEXT,
  store_id TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT,
  description TEXT,
  sku TEXT,
  category TEXT,
  price REAL,
  cost REAL,
  stock INTEGER,
  imageUrl TEXT,
  business_id TEXT,
  is_service INTEGER DEFAULT 0,
  batch_number TEXT,
  expiry_date TEXT,
  item_cls_cd TEXT,
  tax_ty_cd TEXT,
  store_id TEXT
);

CREATE TABLE IF NOT EXISTS store_products (
  id TEXT PRIMARY KEY,
  product_id INTEGER,
  store_id TEXT,
  stock INTEGER,
  price REAL,
  business_id TEXT
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
  business_id TEXT,
  store_id TEXT
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id TEXT PRIMARY KEY,
  name TEXT,
  category TEXT,
  account_id TEXT,
  is_active INTEGER,
  created_by TEXT,
  created_at TEXT,
  business_id TEXT,
  store_id TEXT
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  tpin TEXT,
  payment_terms TEXT,
  default_payment_method TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT,
  business_id TEXT,
  store_id TEXT
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
  split_cash REAL,
  split_momo REAL,
  status TEXT,
  store_id TEXT,
  performed_by TEXT,
  business_id TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  orderId TEXT,
  productId INTEGER,
  quantity INTEGER,
  unitPrice REAL,
  business_id TEXT,
  store_id TEXT
);

CREATE TABLE IF NOT EXISTS zra_invoices (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  status TEXT,
  tpin TEXT,
  bhf_id TEXT,
  sdc_id TEXT,
  mrc_no TEXT,
  rcpt_no INTEGER,
  cis_invc_no TEXT,
  intrl_data TEXT,
  rcpt_sign TEXT,
  qr_code_url TEXT,
  vsdc_date TEXT,
  payload_json TEXT,
  record_json TEXT,
  created_at TEXT,
  updated_at TEXT,
  business_id TEXT,
  store_id TEXT
);

CREATE TABLE IF NOT EXISTS zra_sync_queue (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  endpoint TEXT,
  payload_json TEXT,
  sale_json TEXT,
  retry_count INTEGER,
  last_error TEXT,
  created_at TEXT,
  business_id TEXT,
  store_id TEXT
);

CREATE TABLE IF NOT EXISTS local_receipts (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  business_id TEXT,
  store_id TEXT,
  tx_type TEXT,
  receipt_number TEXT,
  customer_name TEXT,
  payment_method TEXT,
  subtotal REAL,
  tax REAL,
  discount REAL,
  total REAL,
  items_json TEXT,
  receipt_payload_json TEXT,
  fiscal_qr_url TEXT,
  performed_by TEXT,
  status TEXT,
  mirror_status TEXT DEFAULT 'PENDING',
  created_at TEXT
);
`;

function filterToSqliteScope(rawTables: Record<string, any[]>): Record<string, any[]> {
  const scoped: Record<string, any[]> = {};
  for (const tbl of SQLITE_SCOPED_TABLES) {
    if (Array.isArray(rawTables[tbl])) {
      scoped[tbl] = rawTables[tbl];
    }
  }
  return scoped;
}

/**
 * Initializes the on-device SQLite cache & receipts database on Android devices
 */
export async function initSqliteStorage(): Promise<boolean> {
  if (isSqliteReady) return true;
  if (isInitInProgress) return false;
  isInitInProgress = true;

  try {
    const isNative = Capacitor.isNativePlatform();

    if (isNative) {
      sqliteConnection = new SQLiteConnection(CapacitorSQLite);

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
      await dbConnection.execute(SQLITE_SCHEMA);

      try { await dbConnection.execute('ALTER TABLE products ADD COLUMN item_cls_cd TEXT;'); } catch {}
      try { await dbConnection.execute('ALTER TABLE products ADD COLUMN tax_ty_cd TEXT;'); } catch {}
      try { await dbConnection.execute('ALTER TABLE products ADD COLUMN description TEXT;'); } catch {}
      try { await dbConnection.execute('ALTER TABLE stores ADD COLUMN phone TEXT;'); } catch {}
      try { await dbConnection.execute('ALTER TABLE stores ADD COLUMN email TEXT;'); } catch {}
      for (const tbl of SQLITE_SCOPED_TABLES) {
        try { await dbConnection.execute(`ALTER TABLE ${tbl} ADD COLUMN business_id TEXT;`); } catch {}
        try { await dbConnection.execute(`ALTER TABLE ${tbl} ADD COLUMN store_id TEXT;`); } catch {}
      }
      isSqliteReady = true;
    }

    setupLifecycleListeners();
    return true;
  } catch (err) {
    console.warn('[SqliteStorage] Native SQLite cache fallback:', err);
    return false;
  } finally {
    isInitInProgress = false;
  }
}

let isListenerSet = false;
function setupLifecycleListeners() {
  if (isListenerSet) return;
  isListenerSet = true;

  if (Capacitor.isNativePlatform()) {
    try {
      Promise.resolve(
        CapApp.addListener('appStateChange', (state) => {
          if (!state.isActive) {
            triggerImmediateFlush();
          }
        })
      ).catch(() => {});
    } catch {}
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
  pendingFlushData = filterToSqliteScope(tablesData || {});
  if (flushTimeout) clearTimeout(flushTimeout);
  flushTimeout = setTimeout(() => {
    void executePersistentFlush();
  }, 350);
}

export function triggerImmediateFlush() {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }
  void executePersistentFlush();
}

/**
 * Asynchronously flushes ONLY the on-device cache & receipt tables to SQLite + local device cache file.
 */
async function executePersistentFlush() {
  if (!pendingFlushData) return;
  const data = pendingFlushData;
  pendingFlushData = null;

  // 1. Filesystem on-device cache file (Android Directory.Data)
  try {
    const jsonString = JSON.stringify(data);
    await Filesystem.writeFile({
      path: CACHE_FILENAME,
      data: jsonString,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
  } catch {
    // Expected in standard web preview
  }

  // 2. Preferences last-cached timestamp
  try {
    await Preferences.set({
      key: 'pos_retail_last_cache_timestamp',
      value: new Date().toISOString(),
    });
  } catch {}

  // 3. Native SQLite on-device cache & receipt tables
  if (isSqliteReady && dbConnection) {
    try {
      const isOpened = await dbConnection.isDBOpen();
      if (!isOpened.result) {
        await dbConnection.open();
      }

      await dbConnection.beginTransaction();

      for (const [table, rows] of Object.entries(data)) {
        if (!Array.isArray(rows) || !SQLITE_SCOPED_TABLES.includes(table) || table === 'local_receipts') {
          continue;
        }

        await dbConnection.run(`DELETE FROM ${table};`, []);

        if (rows.length > 0) {
          for (const row of rows) {
            const keys = Object.keys(row);
            if (keys.length === 0) continue;
            const placeholders = keys.map(() => '?').join(', ');
            const values = keys.map((k) => {
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
    } catch (sqlErr) {
      console.error('[SqliteStorage] Error updating local SQLite cache:', sqlErr);
      try {
        await dbConnection.rollbackTransaction();
      } catch {}
    }
  }
}

/**
 * Recovers on-device cached catalog & receipts from SQLite / Filesystem cache.
 */
export async function loadTablesFromPersistentStorage(): Promise<Record<string, any[]> | null> {
  const result: Record<string, any[]> = {};
  let foundAny = false;

  if (isSqliteReady && dbConnection) {
    try {
      const isOpened = await dbConnection.isDBOpen();
      if (!isOpened.result) await dbConnection.open();

      for (const table of SQLITE_SCOPED_TABLES) {
        try {
          const res = await dbConnection.query(`SELECT * FROM ${table};`);
          if (res && res.values && res.values.length > 0) {
            result[table] = res.values;
            foundAny = true;
          }
        } catch {}
      }

      if (
        foundAny &&
        ((result['businesses'] && result['businesses'].length > 0) ||
          (result['products'] && result['products'].length > 0) ||
          (result['orders'] && result['orders'].length > 0))
      ) {
        return filterToSqliteScope(result);
      }
    } catch (err) {
      console.warn('[SqliteStorage] Failed to query SQLite cache, trying filesystem cache:', err);
    }
  }

  for (const filename of [CACHE_FILENAME, LEGACY_SNAPSHOT_FILENAME]) {
    try {
      const file = await Filesystem.readFile({
        path: filename,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      if (file && typeof file.data === 'string') {
        const parsed = JSON.parse(file.data);
        if (parsed && typeof parsed === 'object') {
          return filterToSqliteScope(parsed);
        }
      }
    } catch {}
  }

  return null;
}

// ============================================================================
// ON-DEVICE RECEIPT CACHE HELPERS (SQLite on Native + Local Cache Fallback)
// ============================================================================

function readWebReceiptCache(): LocalReceiptRecord[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(WEB_RECEIPT_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeWebReceiptCache(rows: LocalReceiptRecord[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    // Cap at 300 most recent local receipts to respect localStorage quota while keeping SQLite unlimited
    localStorage.setItem(WEB_RECEIPT_CACHE_KEY, JSON.stringify(rows.slice(0, 300)));
  } catch {}
}

export async function saveReceiptToSqliteCache(receipt: LocalReceiptRecord): Promise<void> {
  if (!receipt || !receipt.order_id || !receipt.business_id) return;

  const clean: LocalReceiptRecord = {
    ...receipt,
    id: receipt.id || `${receipt.tx_type || 'SALE'}_${receipt.order_id}`,
    mirror_status: receipt.mirror_status || 'PENDING',
    created_at: receipt.created_at || new Date().toISOString(),
  };

  // Update web receipt cache immediately (for offline lookup & web preview)
  const existing = readWebReceiptCache().filter((r) => r.id !== clean.id);
  writeWebReceiptCache([clean, ...existing]);

  // Write to native SQLite local_receipts table when on Capacitor Android
  if (isSqliteReady && dbConnection) {
    try {
      const isOpened = await dbConnection.isDBOpen();
      if (!isOpened.result) await dbConnection.open();
      await dbConnection.run(
        `INSERT OR REPLACE INTO local_receipts (
          id, order_id, business_id, store_id, tx_type, receipt_number,
          customer_name, payment_method, subtotal, tax, discount, total,
          items_json, receipt_payload_json, fiscal_qr_url, performed_by,
          status, mirror_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          clean.id,
          clean.order_id,
          clean.business_id,
          clean.store_id,
          clean.tx_type,
          clean.receipt_number,
          clean.customer_name,
          clean.payment_method,
          Number(clean.subtotal || 0),
          Number(clean.tax || 0),
          Number(clean.discount || 0),
          Number(clean.total || 0),
          clean.items_json || '[]',
          clean.receipt_payload_json || '',
          clean.fiscal_qr_url || '',
          clean.performed_by || 'owner',
          clean.status || 'Completed',
          clean.mirror_status,
          clean.created_at,
        ]
      );
    } catch (err) {
      console.warn('[SqliteStorage] local_receipts write notice:', err);
    }
  }
}

export async function markReceiptMirroredInSqlite(orderId: string, businessId: string): Promise<void> {
  if (!orderId || !businessId) return;

  const list = readWebReceiptCache().map((r) =>
    r.order_id === orderId && r.business_id === businessId
      ? { ...r, mirror_status: 'MIRRORED' as const }
      : r
  );
  writeWebReceiptCache(list);

  if (isSqliteReady && dbConnection) {
    try {
      const isOpened = await dbConnection.isDBOpen();
      if (!isOpened.result) await dbConnection.open();
      await dbConnection.run(
        `UPDATE local_receipts SET mirror_status = 'MIRRORED' WHERE order_id = ? AND business_id = ?;`,
        [orderId, businessId]
      );
    } catch {}
  }
}

export async function getCachedReceiptsFromSqlite(
  businessId: string,
  storeId?: string,
  limit: number = 100
): Promise<LocalReceiptRecord[]> {
  if (!businessId) return [];

  if (isSqliteReady && dbConnection) {
    try {
      const isOpened = await dbConnection.isDBOpen();
      if (!isOpened.result) await dbConnection.open();
      const hasStore = storeId && storeId !== 'all';
      const query = hasStore
        ? `SELECT * FROM local_receipts WHERE business_id = ? AND store_id = ? ORDER BY created_at DESC LIMIT ?;`
        : `SELECT * FROM local_receipts WHERE business_id = ? ORDER BY created_at DESC LIMIT ?;`;
      const params = hasStore ? [businessId, storeId, limit] : [businessId, limit];
      const res = await dbConnection.query(query, params);
      if (res && Array.isArray(res.values)) {
        return res.values as LocalReceiptRecord[];
      }
    } catch {}
  }

  return readWebReceiptCache()
    .filter((r) => {
      if (r.business_id !== businessId) return false;
      if (storeId && storeId !== 'all' && r.store_id !== storeId) return false;
      return true;
    })
    .slice(0, limit);
}

export async function purgeBusinessFromSqliteCache(businessId: string): Promise<void> {
  const cleanBizId = String(businessId || '').trim();
  if (!cleanBizId) return;

  // 1. Purge from web receipt cache
  try {
    const remainingReceipts = readWebReceiptCache().filter(
      (r) => String(r?.business_id || '').trim() !== cleanBizId
    );
    writeWebReceiptCache(remainingReceipts);
  } catch {}

  // 2. Purge from native SQLite database tables if open
  if (isSqliteReady && dbConnection) {
    try {
      const isOpened = await dbConnection.isDBOpen();
      if (!isOpened.result) await dbConnection.open();
      for (const table of SQLITE_SCOPED_TABLES) {
        try {
          if (table === 'businesses') {
            await dbConnection.run(
              `DELETE FROM businesses WHERE id = ? OR business_id = ?;`,
              [cleanBizId, cleanBizId]
            );
          } else {
            await dbConnection.run(`DELETE FROM ${table} WHERE business_id = ?;`, [cleanBizId]);
          }
        } catch {}
      }
    } catch {}
  }

  // 3. Purge from Capacitor Filesystem cache files if present
  for (const filename of [CACHE_FILENAME, LEGACY_SNAPSHOT_FILENAME]) {
    try {
      const file = await Filesystem.readFile({
        path: filename,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      if (file && typeof file.data === 'string') {
        const parsed = JSON.parse(file.data);
        if (parsed && typeof parsed === 'object') {
          let modified = false;
          for (const [tbl, rows] of Object.entries(parsed)) {
            if (!Array.isArray(rows)) continue;
            const filtered = rows.filter(
              (r: any) =>
                String(r?.id || '').trim() !== cleanBizId &&
                String(r?.business_id || '').trim() !== cleanBizId
            );
            if (filtered.length !== rows.length) {
              parsed[tbl] = filtered;
              modified = true;
            }
          }
          if (modified) {
            await Filesystem.writeFile({
              path: filename,
              data: JSON.stringify(parsed),
              directory: Directory.Data,
              encoding: Encoding.UTF8,
            });
          }
        }
      }
    } catch {}
  }
}

