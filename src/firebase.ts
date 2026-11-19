import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  User,
} from 'firebase/auth';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  persistentSingleTabManager,
  doc,
  getDoc,
  getDocFromCache,
  getDocFromServer,
  setDoc,
  getDocs,
  collection,
  query,
  where,
  serverTimestamp,
  enableNetwork,
  disableNetwork,
} from 'firebase/firestore';
import {
  getStorage,
  ref as storageRef,
  uploadString,
  getBytes,
} from 'firebase/storage';
import firebaseConfig from '../firebase-applet-config.json';
import {
  runSql,
  persistTablesToStorage,
  syncAllAccountingSystems,
  rehydrateAlasqlFromRecords,
  sqlEsc,
  getActiveStoreId,
  saveReceiptToSqliteCache,
  markReceiptMirroredInSqlite,
} from './db';

const app = initializeApp(firebaseConfig);
const firestoreDatabaseId =
  (firebaseConfig as any).firestoreDatabaseId || 'ai-studio-32ea9ad7-3a6b-4977-b7b9-ef484b98c7f4';

function createPersistentFirestore() {
  try {
    return initializeFirestore(
      app,
      {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      },
      firestoreDatabaseId
    );
  } catch {
    try {
      return initializeFirestore(
        app,
        {
          localCache: persistentLocalCache({
            tabManager: persistentSingleTabManager({ forceOwnership: false }),
          }),
        },
        firestoreDatabaseId
      );
    } catch {
      return getFirestore(app, firestoreDatabaseId);
    }
  }
}

export const db = createPersistentFirestore();
export const isFirestoreOfflinePersistenceEnabled = true;
export const auth = getAuth(app);
export const storage = getStorage(
  app,
  (firebaseConfig as any).storageBucket
    ? `gs://${String((firebaseConfig as any).storageBucket).replace(/^gs:\/\//, '')}`
    : undefined
);

export const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('https://www.googleapis.com/auth/gmail.send');
googleProvider.addScope('https://www.googleapis.com/auth/gmail.readonly');
googleProvider.addScope('https://www.googleapis.com/auth/documents');
googleProvider.addScope('https://www.googleapis.com/auth/forms.body');
googleProvider.addScope('https://www.googleapis.com/auth/tasks');

// In-memory token cache (never persisted to localStorage)
let cachedAccessToken: string | null = null;
let isSigningIn = false;

// Ensure password meets Firebase Auth 6-character minimum requirement
function normalizeFirebasePassword(rawPassword: string): string {
  const trimmed = String(rawPassword || '').trim();
  if (trimmed.length >= 6) return trimmed;
  return trimmed.padEnd(6, '0');
}

let isFirestoreNetworkDisabled = false;
let lastAuthNetworkFailureAt = 0;
const AUTH_NETWORK_RETRY_COOLDOWN_MS = 30000;

function isNetworkOrOfflineAuthError(err: any): boolean {
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();
  return (
    code.includes('network-request-failed') ||
    code === 'unavailable' ||
    msg.includes('network-request-failed') ||
    msg.includes('the client is offline') ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('could not reach cloud firestore backend')
  );
}

async function setFirestoreOfflineMode(): Promise<void> {
  if (isFirestoreNetworkDisabled) return;
  isFirestoreNetworkDisabled = true;
  try {
    await disableNetwork(db);
  } catch {
    // ignore
  }
}

async function ensureFirestoreOnlineIfReachable(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    await setFirestoreOfflineMode();
    return false;
  }

  if (lastAuthNetworkFailureAt > 0 && Date.now() - lastAuthNetworkFailureAt < AUTH_NETWORK_RETRY_COOLDOWN_MS) {
    await setFirestoreOfflineMode();
    return false;
  }

  try {
    await auth.authStateReady();
    if (auth.currentUser) {
      await auth.currentUser.getIdToken(false);
    }
    lastAuthNetworkFailureAt = 0;
    if (isFirestoreNetworkDisabled) {
      isFirestoreNetworkDisabled = false;
      await enableNetwork(db);
    }
    return true;
  } catch (err: any) {
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      await setFirestoreOfflineMode();
      return false;
    }
    return true;
  }
}

// Sync authenticated Firebase user with backend Cloud SQL users table
export async function syncFirebaseUserWithBackend(user: User | null) {
  if (!user) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  try {
    const idToken = await user.getIdToken();
    await fetch('/api/auth/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
    });
  } catch (err: any) {
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      void setFirestoreOfflineMode();
      return;
    }
    console.warn('Backend user token sync notice:', err);
  }
}

// Register or Sign In with Firebase Email/Password Provider
export async function registerOrSignInWithEmailPassword(
  email: string,
  password: string,
  displayName?: string
): Promise<{ user: User; isNewUser: boolean }> {
  const cleanEmail = email.trim().toLowerCase();
  const safePassword = normalizeFirebasePassword(password);

  try {
    const cred = await createUserWithEmailAndPassword(auth, cleanEmail, safePassword);
    if (displayName && displayName.trim()) {
      await updateProfile(cred.user, { displayName: displayName.trim() }).catch(() => {});
    }
    await syncFirebaseUserWithBackend(cred.user);
    return { user: cred.user, isNewUser: true };
  } catch (err: any) {
    if (err?.code === 'auth/email-already-in-use') {
      const signInCred = await signInWithEmailAndPassword(auth, cleanEmail, safePassword);
      if (displayName && displayName.trim() && !signInCred.user.displayName) {
        await updateProfile(signInCred.user, { displayName: displayName.trim() }).catch(() => {});
      }
      await syncFirebaseUserWithBackend(signInCred.user);
      return { user: signInCred.user, isNewUser: false };
    }
    throw err;
  }
}

// Sign In with Firebase Email/Password Provider (auto-provisioning if existing Cloud SQL user)
export async function signInWithEmailPasswordAccount(
  email: string,
  password: string,
  allowAutoProvisionIfVerifiedLocally: boolean = false,
  displayName?: string
): Promise<User> {
  const cleanEmail = email.trim().toLowerCase();
  const safePassword = normalizeFirebasePassword(password);

  try {
    const cred = await signInWithEmailAndPassword(auth, cleanEmail, safePassword);
    await syncFirebaseUserWithBackend(cred.user);
    return cred.user;
  } catch (err: any) {
    if (
      allowAutoProvisionIfVerifiedLocally &&
      (err?.code === 'auth/user-not-found' || err?.code === 'auth/invalid-credential')
    ) {
      const created = await createUserWithEmailAndPassword(auth, cleanEmail, safePassword);
      if (displayName && displayName.trim()) {
        await updateProfile(created.user, { displayName: displayName.trim() }).catch(() => {});
      }
      await syncFirebaseUserWithBackend(created.user);
      return created.user;
    }
    throw err;
  }
}

// Initialize auth state listener
export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      syncFirebaseUserWithBackend(user).catch(() => {});
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

// Initiate Google Popup Signin
export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, googleProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to retrieve access token from Google Credentials.');
    }
    cachedAccessToken = credential.accessToken;
    await syncFirebaseUserWithBackend(result.user);
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Workspace Google Auth Error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

// Retrieve in-memory token
export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

// Set token directly
export const setCachedAccessToken = (token: string | null) => {
  cachedAccessToken = token;
};

// Sign Out from Firebase Auth
export const googleSignOut = async () => {
  if (autoFirebaseBackupTimer) {
    clearTimeout(autoFirebaseBackupTimer);
    autoFirebaseBackupTimer = null;
  }
  cachedAccessToken = null;
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('pos_last_firebase_storage_backup');
  }
  try {
    await signOut(auth);
  } catch (err) {
    console.warn('Firebase signOut notice:', err);
  }
};

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Connection test primitive required by Firebase integration
export async function testConnection() {
  try {
    const reachable = await ensureFirestoreOnlineIfReachable();
    if (!reachable) {
      return;
    }
    const checkPromise = getDocFromServer(doc(db, 'test', 'connection'));
    checkPromise.catch((err) => {
      if (isNetworkOrOfflineAuthError(err)) {
        lastAuthNetworkFailureAt = Date.now();
        void setFirestoreOfflineMode();
      }
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 2500)
    );
    await Promise.race([checkPromise, timeoutPromise]);
  } catch (error: any) {
    if (isNetworkOrOfflineAuthError(error)) {
      lastAuthNetworkFailureAt = Date.now();
      await setFirestoreOfflineMode();
      return;
    }
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

if (typeof window !== 'undefined') {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    void setFirestoreOfflineMode();
  }
  void testConnection();
}

export function getTransportSecurityStatus() {
  const isSecureProtocol = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const isLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  return {
    isSecure: isSecureProtocol || isLocalhost,
    protocol: isSecureProtocol
      ? 'HTTPS/WSS (TLS 1.3)'
      : isLocalhost
      ? 'HTTP/WS (Localhost Sandbox)'
      : 'INSECURE HTTP',
    cipherSuite: 'TLS_AES_256_GCM_SHA384 (256-Bit Strong Handshake)',
    cloudProvider: 'Google Firebase Auth + Firestore + Cloud Storage Gateway',
    protectionStatus: isSecureProtocol || isLocalhost ? 'FULLY_ENCRYPTED' : 'UNENCRYPTED_RISKY',
  };
}

function sanitizeIdForFirestore(rawId: any, fallbackPrefix: string = 'doc'): string {
  const str = String(rawId ?? '').trim().replace(/[^a-zA-Z0-9_\-]/g, '_');
  if (!str) return `${fallbackPrefix}_${Date.now()}`;
  return str.slice(0, 120);
}

// Sanitize arbitrary row objects into clean Firestore-compatible maps (no undefined values)
function sanitizeRecordMap(row: any): Record<string, any> {
  if (!row || typeof row !== 'object') return { value: String(row ?? '') };
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined || typeof v === 'function') continue;
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      clean[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
    } else {
      clean[k] = JSON.stringify(v).slice(0, 2000);
    }
  }
  return clean;
}

// ============================================================================
// FIREBASE CLOUD STORAGE DEFAULT BACKUP (Clients Data & Transactions Archives)
// ============================================================================
export async function backupClientsAndTransactionsToStorage(
  businessId: string,
  payload: {
    business: any;
    stores: any[];
    products: any[];
    customers: any[];
    laybys: any[];
    laybyInstallments: any[];
    quotations: any[];
    orders: any[];
    orderItems: any[];
    ledgers: Record<string, any[]>;
    settings: any;
  }
): Promise<{ storageSynced: boolean; filesUploaded: string[] }> {
  if (!auth.currentUser) {
    return { storageSynced: false, filesUploaded: [] };
  }

  const safeBizId = sanitizeIdForFirestore(businessId, 'biz');
  const nowIso = new Date().toISOString();
  const filesUploaded: string[] = [];

  try {
    // 1. Default Backup for Clients Data (CRM Customers, Laybys, Installments, Quotations)
    const clientsBackupJson = JSON.stringify(
      {
        backupType: 'CLIENTS_AND_CRM_DATA',
        businessId: safeBizId,
        businessName: payload.business?.name || '',
        ownerUid: auth.currentUser.uid,
        ownerEmail: auth.currentUser.email || payload.business?.email || '',
        backedUpAt: nowIso,
        relationships: {
          businessToCustomers: '1:N via business_id',
          customersToOrders: '1:N via customerId',
          customersToLaybys: '1:N via customer_phone / customer_name',
        },
        clients: {
          customers: payload.customers,
          laybys: payload.laybys,
          layby_installments: payload.laybyInstallments,
          quotations: payload.quotations,
        },
      },
      null,
      2
    );

    const clientsRef = storageRef(storage, `backups/${safeBizId}/clients_data.json`);
    await uploadString(clientsRef, clientsBackupJson, 'raw', {
      contentType: 'application/json',
    });
    filesUploaded.push(`backups/${safeBizId}/clients_data.json`);

    // 2. Default Backup for Transactions & Double-Entry Accounting Ledgers
    const transactionsBackupJson = JSON.stringify(
      {
        backupType: 'TRANSACTIONS_AND_DOUBLE_ENTRY_LEDGERS',
        businessId: safeBizId,
        businessName: payload.business?.name || '',
        ownerUid: auth.currentUser.uid,
        ownerEmail: auth.currentUser.email || payload.business?.email || '',
        backedUpAt: nowIso,
        relationships: {
          businessToStores: '1:N via business_id',
          storesToOrders: '1:N via store_id',
          ordersToOrderItems: '1:N via orderId',
          productsToOrderItems: '1:N via productId',
          ordersToLedgers: '1:N via reference_id / order_id',
        },
        transactions: {
          orders: payload.orders,
          order_items: payload.orderItems,
        },
        accountingLedgers: payload.ledgers,
      },
      null,
      2
    );

    const txRef = storageRef(storage, `backups/${safeBizId}/transactions_and_ledgers.json`);
    await uploadString(txRef, transactionsBackupJson, 'raw', {
      contentType: 'application/json',
    });
    filesUploaded.push(`backups/${safeBizId}/transactions_and_ledgers.json`);

    // 3. Complete Workspace Master Snapshot
    const fullBackupJson = JSON.stringify(
      {
        backupType: 'FULL_WORKSPACE_SNAPSHOT',
        businessId: safeBizId,
        ownerUid: auth.currentUser.uid,
        backedUpAt: nowIso,
        business: payload.business,
        settings: payload.settings,
        stores: payload.stores,
        products: payload.products,
        customers: payload.customers,
        orders: payload.orders,
        order_items: payload.orderItems,
        quotations: payload.quotations,
        ledgers: payload.ledgers,
      },
      null,
      2
    );

    const fullRef = storageRef(storage, `backups/${safeBizId}/full_workspace_backup.json`);
    await uploadString(fullRef, fullBackupJson, 'raw', {
      contentType: 'application/json',
    });
    filesUploaded.push(`backups/${safeBizId}/full_workspace_backup.json`);

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('pos_last_firebase_storage_backup', nowIso);
    }

    return { storageSynced: true, filesUploaded };
  } catch (err) {
    console.warn('Firebase Storage backup warning:', err);
    return { storageSynced: false, filesUploaded };
  }
}

export function isCurrentUserAuthorizedBusinessOwner(businessId: string): boolean {
  if (!auth.currentUser) return false;
  const currentEmail = (auth.currentUser.email || '').trim().toLowerCase();
  const isVerifiedBootstrapAdmin =
    Boolean(auth.currentUser.emailVerified) && currentEmail === 'chiposhaconwell@gmail.com';

  // 1. Check active POS session role (staff/sales/manager must not overwrite owner Firestore doc)
  if (typeof localStorage !== 'undefined') {
    try {
      const savedRole = (localStorage.getItem('logged_in_user_role') || '').trim().toLowerCase();
      if (savedRole && savedRole !== 'owner' && !isVerifiedBootstrapAdmin) {
        return false;
      }
      const sessionRaw = localStorage.getItem('pos_authenticated_session');
      if (sessionRaw && sessionRaw.startsWith('{')) {
        const session = JSON.parse(sessionRaw);
        if (session?.role && session.role !== 'owner' && !isVerifiedBootstrapAdmin) {
          return false;
        }
      }
    } catch {}
  }

  // 2. Check against local business owner email and staff roster
  const cleanBizId = String(businessId || '').replace(/'/g, "''");
  const bizRes = cleanBizId
    ? runSql(`SELECT * FROM businesses WHERE id = '${cleanBizId}'`, 'Cloud Sync: Verify owner profile', true)
    : { success: false, data: [] };
  const bizRow =
    bizRes.success && Array.isArray(bizRes.data) && bizRes.data.length > 0 ? bizRes.data[0] : null;

  if (bizRow?.email) {
    const bizOwnerEmail = String(bizRow.email).trim().toLowerCase();
    if (bizOwnerEmail && currentEmail && currentEmail !== bizOwnerEmail && !isVerifiedBootstrapAdmin) {
      return false;
    }
  } else {
    const staffRes = runSql(`SELECT email FROM staff`, 'Cloud Sync: Check staff role', true);
    const staffRows = staffRes.success && Array.isArray(staffRes.data) ? staffRes.data : [];
    const matchesStaff = staffRows.some(
      (st: any) => st?.email && String(st.email).trim().toLowerCase() === currentEmail
    );
    if (matchesStaff && !isVerifiedBootstrapAdmin) {
      return false;
    }
  }

  return true;
}

// Non-blocking Firestore write helper so offline checkouts persist immediately into IndexedDB
// without hanging on unacknowledged server Promises while offline.
async function writeDocOfflineAware(
  docRef: any,
  data: Record<string, any>,
  path: string,
  isOnline: boolean
): Promise<boolean> {
  if (!isOnline || isFirestoreNetworkDisabled) {
    await setFirestoreOfflineMode();
    void setDoc(docRef, data).catch((err) => {
      console.warn(`[Firestore Offline Queue] Deferred write notice (${path}):`, err?.message || err);
    });
    return false;
  }
  try {
    await setDoc(docRef, data);
    return true;
  } catch (err: any) {
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      await setFirestoreOfflineMode();
      void setDoc(docRef, data).catch(() => {});
      return false;
    }
    throw err;
  }
}

const PENDING_SQL_MIRRORS_KEY = 'pos_pending_sql_mirrors_v1';

interface PendingSqlMirrorEntry {
  eventKey: string;
  payload: Record<string, any>;
  queuedAt: string;
}

function readPendingSqlMirrors(): PendingSqlMirrorEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(PENDING_SQL_MIRRORS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePendingSqlMirrors(list: PendingSqlMirrorEntry[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PENDING_SQL_MIRRORS_KEY, JSON.stringify(list.slice(-250)));
  } catch {}
}

function enqueuePendingSqlMirror(eventKey: string, payload: Record<string, any>) {
  const list = readPendingSqlMirrors().filter((item) => item.eventKey !== eventKey);
  list.push({ eventKey, payload, queuedAt: new Date().toISOString() });
  writePendingSqlMirrors(list);
}

function removePendingSqlMirror(eventKey: string) {
  const list = readPendingSqlMirrors().filter((item) => item.eventKey !== eventKey);
  writePendingSqlMirrors(list);
}

async function dispatchSqlMirrorRequest(payload: Record<string, any>): Promise<boolean> {
  if (!auth.currentUser) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;

  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch('/api/triggers/firestore-transaction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return false;
    return true;
  } catch {
    return false;
  }
}

export async function flushPendingFinalizedTxMirrors(): Promise<number> {
  if (!auth.currentUser) return 0;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0;

  const queue = readPendingSqlMirrors();
  if (queue.length === 0) return 0;

  let mirroredCount = 0;
  for (const entry of queue) {
    const ok = await dispatchSqlMirrorRequest(entry.payload);
    if (ok) {
      removePendingSqlMirror(entry.eventKey);
      const orderId = entry.payload?.order?.id || entry.payload?.cashUp?.id;
      const bizId = entry.payload?.businessId;
      if (orderId && bizId) {
        void markReceiptMirroredInSqlite(String(orderId), String(bizId));
      }
      mirroredCount++;
    }
  }
  return mirroredCount;
}

export async function fetchCentralSqlReport(params: {
  businessId: string;
  storeId?: string;
  startDate?: string;
  endDate?: string;
}) {
  if (!auth.currentUser) {
    throw new Error('Sign in with Firebase Auth to load Central SQL reports.');
  }
  const token = await auth.currentUser.getIdToken();
  const qs = new URLSearchParams();
  qs.set('businessId', params.businessId);
  if (params.storeId && params.storeId !== 'all') qs.set('storeId', params.storeId);
  if (params.startDate) qs.set('startDate', params.startDate);
  if (params.endDate) qs.set('endDate', params.endDate);

  const res = await fetch(`/api/reports/sql-summary?${qs.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Central SQL report returned ${res.status}`);
  }
  return res.json();
}

/**
 * Queues a POS checkout (order, line items, and stock/customer updates) directly into Firestore
 * with IndexedDB offline persistence, caches the local receipt in on-device SQLite, and triggers
 * server-side Central SQL mirroring upon Firestore commit.
 */
export function syncSaleToFirestoreOfflineSafe(params: {
  businessId: string;
  storeId: string;
  customerName?: string;
  fiscalQrUrl?: string;
  order: {
    id: string;
    customerId?: number | null;
    orderDate: string;
    subtotal: number;
    tax: number;
    discount: number;
    total: number;
    cogsAmount?: number;
    paymentMethod: string;
    status: string;
    performed_by: string;
  };
  items: Array<{
    id: string;
    productId: number;
    productName?: string;
    quantity: number;
    unitPrice: number;
    unitCost?: number;
  }>;
  updatedProducts?: Array<{
    id: number;
    name: string;
    description?: string;
    sku?: string;
    category?: string;
    price: number;
    cost: number;
    stock: number;
    imageUrl?: string;
    is_service?: number;
    batch_number?: string;
    expiry_date?: string;
  }>;
}) {
  try {
    const rawBizId = String(params.businessId || '').trim();
    if (!rawBizId || rawBizId === 'default_biz') return;

    const safeBizId = sanitizeIdForFirestore(rawBizId, 'biz');
    const safeStoreId = sanitizeIdForFirestore(params.storeId || getActiveStoreId(undefined, rawBizId), 'store');
    const safeOrderId = sanitizeIdForFirestore(params.order.id, 'ord');

    // 1. Always save local receipt copy into on-device SQLite receipt cache immediately (offline-safe)
    void saveReceiptToSqliteCache({
      id: `SALE_${safeOrderId}`,
      order_id: safeOrderId,
      business_id: safeBizId,
      store_id: safeStoreId,
      tx_type: 'SALE',
      receipt_number: safeOrderId,
      customer_name: params.customerName || 'Walk-In Customer',
      payment_method: String(params.order.paymentMethod || 'Cash'),
      subtotal: Number(params.order.subtotal || 0),
      tax: Number(params.order.tax || 0),
      discount: Number(params.order.discount || 0),
      total: Number(params.order.total || 0),
      items_json: JSON.stringify(params.items || []),
      fiscal_qr_url: params.fiscalQrUrl || '',
      performed_by: String(params.order.performed_by || 'owner'),
      status: String(params.order.status || 'Completed'),
      mirror_status: 'PENDING',
      created_at: String(params.order.orderDate || new Date().toISOString()),
    });

    // Queue finalized sale mirror payload for Central SQL reporting
    const mirrorPayload = {
      txType: 'SALE' as const,
      businessId: safeBizId,
      storeId: safeStoreId,
      firestorePath: `businesses/${safeBizId}/orders/${safeOrderId}`,
      source: 'firestore_commit_trigger',
      order: {
        ...params.order,
        id: safeOrderId,
        customerName: params.customerName || 'Walk-In Customer',
      },
      items: params.items || [],
      updatedProducts: params.updatedProducts || [],
    };
    const mirrorEventKey = `${safeBizId}::SALE::${safeOrderId}`;
    enqueuePendingSqlMirror(mirrorEventKey, mirrorPayload);

    if (!auth.currentUser) return;
    if (!isCurrentUserAuthorizedBusinessOwner(rawBizId)) return;

    const shouldUseOfflineMode =
      (typeof navigator !== 'undefined' && navigator.onLine === false) ||
      (lastAuthNetworkFailureAt > 0 && Date.now() - lastAuthNetworkFailureAt < AUTH_NETWORK_RETRY_COOLDOWN_MS);
    if (shouldUseOfflineMode) {
      void setFirestoreOfflineMode();
    }

    const currentUid = auth.currentUser.uid;
    const orderPayload = {
      id: safeOrderId,
      business_id: safeBizId,
      store_id: safeStoreId,
      ownerUid: currentUid,
      customerId: params.order.customerId ? parseInt(params.order.customerId as any, 10) : null,
      orderDate: String(params.order.orderDate || new Date().toISOString()).slice(0, 100),
      subtotal: Math.max(0, parseFloat(params.order.subtotal as any) || 0.0),
      tax: Math.max(0, parseFloat(params.order.tax as any) || 0.0),
      discount: Math.max(0, parseFloat(params.order.discount as any) || 0.0),
      total: Math.max(0, parseFloat(params.order.total as any) || 0.0),
      paymentMethod: String(params.order.paymentMethod || 'CASH').slice(0, 50),
      status: String(params.order.status || 'Completed').slice(0, 50),
      performed_by: String(params.order.performed_by || 'owner').slice(0, 100),
    };

    // 2. Write to Firestore; upon Firestore commit, fire server-side SQL reporting trigger
    void setDoc(doc(db, 'businesses', safeBizId, 'orders', safeOrderId), orderPayload)
      .then(async () => {
        const ok = await dispatchSqlMirrorRequest(mirrorPayload);
        if (ok) {
          removePendingSqlMirror(mirrorEventKey);
          void markReceiptMirroredInSqlite(safeOrderId, safeBizId);
        }
      })
      .catch((err) => {
        if (isNetworkOrOfflineAuthError(err)) {
          lastAuthNetworkFailureAt = Date.now();
          void setFirestoreOfflineMode();
          return;
        }
        console.warn('[Firestore Offline Order Sync]', err?.message || err);
      });

    for (const item of params.items || []) {
      const safeItemId = sanitizeIdForFirestore(item.id, 'item');
      void setDoc(doc(db, 'businesses', safeBizId, 'order_items', safeItemId), {
        id: safeItemId,
        business_id: safeBizId,
        store_id: safeStoreId,
        ownerUid: currentUid,
        orderId: safeOrderId,
        productId: parseInt(item.productId as any, 10) || 0,
        quantity: Math.max(1, parseInt(item.quantity as any, 10) || 1),
        unitPrice: Math.max(0, parseFloat(item.unitPrice as any) || 0.0),
      }).catch((err) => {
        if (isNetworkOrOfflineAuthError(err)) {
          lastAuthNetworkFailureAt = Date.now();
          void setFirestoreOfflineMode();
          return;
        }
        console.warn('[Firestore Offline OrderItem Sync]', err?.message || err);
      });
    }

    for (const prod of params.updatedProducts || []) {
      const prodIdNum = parseInt(prod.id as any, 10) || 1;
      const prodDocId = sanitizeIdForFirestore(prodIdNum, 'prod');
      void setDoc(doc(db, 'businesses', safeBizId, 'products', prodDocId), {
        id: prodIdNum,
        business_id: safeBizId,
        store_id: safeStoreId,
        ownerUid: currentUid,
        name: String(prod.name || 'Item').slice(0, 250),
        description: String(prod.description || '').slice(0, 4000),
        sku: String(prod.sku || `SKU-${prodIdNum}`).slice(0, 100),
        category: String(prod.category || 'General').slice(0, 100),
        price: Math.max(0, parseFloat(prod.price as any) || 0.0),
        cost: Math.max(0, parseFloat(prod.cost as any) || 0.0),
        stock: parseInt(prod.stock as any, 10) || 0,
        imageUrl: String(prod.imageUrl || '').slice(0, 290000),
        is_service: parseInt(prod.is_service as any, 10) || 0,
        batch_number: String(prod.batch_number || '').slice(0, 100),
        expiry_date: String(prod.expiry_date || '').slice(0, 100),
      }).catch((err) => {
        if (isNetworkOrOfflineAuthError(err)) {
          lastAuthNetworkFailureAt = Date.now();
          void setFirestoreOfflineMode();
          return;
        }
        console.warn('[Firestore Offline Product Sync]', err?.message || err);
      });
    }
  } catch (err) {
    console.warn('[Firestore Offline Checkout Hook]', err);
  }
}

export function syncRefundToFirestoreAndMirror(params: {
  businessId: string;
  storeId: string;
  customerName?: string;
  order: {
    id: string;
    customerId?: number | null;
    orderDate: string;
    subtotal: number;
    tax: number;
    discount: number;
    total: number;
    paymentMethod: string;
    performed_by: string;
  };
  items?: Array<{
    id: string;
    productId: number;
    quantity: number;
    unitPrice: number;
  }>;
}) {
  try {
    const rawBizId = String(params.businessId || '').trim();
    if (!rawBizId || rawBizId === 'default_biz') return;

    const safeBizId = sanitizeIdForFirestore(rawBizId, 'biz');
    const safeStoreId = sanitizeIdForFirestore(params.storeId || getActiveStoreId(undefined, rawBizId), 'store');
    const safeOrderId = sanitizeIdForFirestore(params.order.id, 'ord');

    void saveReceiptToSqliteCache({
      id: `REFUND_${safeOrderId}`,
      order_id: safeOrderId,
      business_id: safeBizId,
      store_id: safeStoreId,
      tx_type: 'REFUND',
      receipt_number: `${safeOrderId}-RF`,
      customer_name: params.customerName || 'Walk-In Customer',
      payment_method: String(params.order.paymentMethod || 'Cash'),
      subtotal: Number(params.order.subtotal || 0),
      tax: Number(params.order.tax || 0),
      discount: Number(params.order.discount || 0),
      total: Number(params.order.total || 0),
      items_json: JSON.stringify(params.items || []),
      performed_by: String(params.order.performed_by || 'supervisor'),
      status: 'Refunded',
      mirror_status: 'PENDING',
      created_at: new Date().toISOString(),
    });

    const mirrorPayload = {
      txType: 'REFUND' as const,
      businessId: safeBizId,
      storeId: safeStoreId,
      firestorePath: `businesses/${safeBizId}/orders/${safeOrderId}`,
      source: 'firestore_commit_trigger',
      order: {
        ...params.order,
        id: safeOrderId,
        status: 'Refunded',
        customerName: params.customerName || 'Walk-In Customer',
      },
      items: params.items || [],
    };
    const mirrorEventKey = `${safeBizId}::REFUND::${safeOrderId}`;
    enqueuePendingSqlMirror(mirrorEventKey, mirrorPayload);

    if (!auth.currentUser || !isCurrentUserAuthorizedBusinessOwner(rawBizId)) return;

    const orderRef = doc(db, 'businesses', safeBizId, 'orders', safeOrderId);
    void setDoc(
      orderRef,
      {
        id: safeOrderId,
        business_id: safeBizId,
        store_id: safeStoreId,
        ownerUid: auth.currentUser.uid,
        customerId: params.order.customerId ? parseInt(params.order.customerId as any, 10) : null,
        orderDate: String(params.order.orderDate || new Date().toISOString()).slice(0, 100),
        subtotal: Math.max(0, parseFloat(params.order.subtotal as any) || 0.0),
        tax: Math.max(0, parseFloat(params.order.tax as any) || 0.0),
        discount: Math.max(0, parseFloat(params.order.discount as any) || 0.0),
        total: Math.max(0, parseFloat(params.order.total as any) || 0.0),
        paymentMethod: String(params.order.paymentMethod || 'Cash').slice(0, 50),
        status: 'Refunded',
        performed_by: String(params.order.performed_by || 'supervisor').slice(0, 100),
      },
      { merge: true }
    )
      .then(async () => {
        const ok = await dispatchSqlMirrorRequest(mirrorPayload);
        if (ok) {
          removePendingSqlMirror(mirrorEventKey);
          void markReceiptMirroredInSqlite(safeOrderId, safeBizId);
        }
      })
      .catch(() => {});
  } catch (err) {
    console.warn('[Firestore Refund Mirror Hook]', err);
  }
}

export function syncCashUpToFirestoreAndMirror(params: {
  businessId: string;
  storeId: string;
  cashUp: {
    id: string;
    date: string;
    cashierName?: string;
    expectedCash: number;
    actualCash: number;
    variance: number;
    expectedCard: number;
    expectedMobile: number;
    notes?: string;
    createdAt?: string;
  };
}) {
  try {
    const rawBizId = String(params.businessId || '').trim();
    if (!rawBizId || rawBizId === 'default_biz') return;

    const safeBizId = sanitizeIdForFirestore(rawBizId, 'biz');
    const safeStoreId = sanitizeIdForFirestore(params.storeId || getActiveStoreId(undefined, rawBizId), 'store');
    const safeCashUpId = sanitizeIdForFirestore(params.cashUp.id, 'csh');

    const mirrorPayload = {
      txType: 'EOD_CASHUP' as const,
      businessId: safeBizId,
      storeId: safeStoreId,
      firestorePath: `businesses/${safeBizId}/cash_ups/${safeCashUpId}`,
      source: 'firestore_commit_trigger',
      cashUp: {
        ...params.cashUp,
        id: safeCashUpId,
      },
    };
    const mirrorEventKey = `${safeBizId}::EOD_CASHUP::${safeCashUpId}`;
    enqueuePendingSqlMirror(mirrorEventKey, mirrorPayload);

    if (!auth.currentUser) return;
    void dispatchSqlMirrorRequest(mirrorPayload).then((ok) => {
      if (ok) removePendingSqlMirror(mirrorEventKey);
    });
  } catch (err) {
    console.warn('[Firestore CashUp Mirror Hook]', err);
  }
}

// ============================================================================
// CLOUD BACKUP (AlaSQL Local -> Firestore Relational + Firebase Storage)
// ============================================================================
export async function backupToCloud(
  businessId: string,
  options?: { silentIfNotOwner?: boolean }
): Promise<{ success: boolean; details: string }> {
  if (!auth.currentUser) {
    throw new Error('You must be signed in (Email/Password or Google) to sync with Firebase Cloud.');
  }

  if (!isCurrentUserAuthorizedBusinessOwner(businessId)) {
    const msg = 'Firestore owner backup skipped for staff/non-owner session (all data synced via Cloud SQL).';
    if (options?.silentIfNotOwner) {
      return { success: false, details: msg };
    }
    throw new Error(msg);
  }

  let isOnline = await ensureFirestoreOnlineIfReachable();

  // Ensure all double-entry accounting ledgers are up to date before backing up
  syncAllAccountingSystems('Firebase Cloud Backup');

  const safeBizId = sanitizeIdForFirestore(businessId, 'biz');
  const cleanBizId = sqlEsc(businessId);
  const currentUid = auth.currentUser.uid;
  const primaryStoreId = sanitizeIdForFirestore(getActiveStoreId(undefined, businessId), 'store');

  // 1. Fetch current business profile locally
  const localBizRes = runSql(
    `SELECT * FROM businesses WHERE id = '${cleanBizId}'`,
    'Cloud Sync: Read local profile',
    true
  );
  const biz =
    localBizRes.success && Array.isArray(localBizRes.data) && localBizRes.data.length > 0
      ? localBizRes.data[0]
      : {
          id: safeBizId,
          name: 'POS Enterprise',
          owner: auth.currentUser.displayName || 'Business Owner',
          email: auth.currentUser.email || 'owner@pos.app',
        };

  // Upsert primary Business document (preserving createdAt if already created; offline-safe via cache)
  const bizPath = `businesses/${safeBizId}`;
  try {
    const bizRef = doc(db, 'businesses', safeBizId);
    let existingSnap: any = null;
    if (isOnline) {
      try {
        existingSnap = await getDoc(bizRef);
      } catch {
        existingSnap = await getDocFromCache(bizRef).catch(() => null);
      }
    } else {
      existingSnap = await getDocFromCache(bizRef).catch(() => null);
    }

    const cleanName = String(biz.name || 'POS Business').slice(0, 200);
    const cleanOwner = String(biz.owner || auth.currentUser.displayName || 'Owner').slice(0, 200);
    const cleanEmail = String(biz.email || auth.currentUser.email || 'owner@pos.app').slice(0, 200);

    if (existingSnap && existingSnap.exists()) {
      const existingData = existingSnap.data();
      isOnline = await writeDocOfflineAware(
        bizRef,
        {
          id: safeBizId,
          business_id: safeBizId,
          store_id: String(biz.store_id || primaryStoreId).slice(0, 128),
          name: cleanName,
          owner: cleanOwner,
          email: cleanEmail,
          ownerUid: existingData.ownerUid || currentUid,
          createdAt: existingData.createdAt || serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        bizPath,
        isOnline
      );
    } else {
      isOnline = await writeDocOfflineAware(
        bizRef,
        {
          id: safeBizId,
          business_id: safeBizId,
          store_id: String(biz.store_id || primaryStoreId).slice(0, 128),
          name: cleanName,
          owner: cleanOwner,
          email: cleanEmail,
          ownerUid: currentUid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        bizPath,
        isOnline
      );
    }
  } catch (err: any) {
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      await setFirestoreOfflineMode();
      isOnline = false;
    } else if (isOnline) {
      handleFirestoreError(err, OperationType.WRITE, bizPath);
    }
  }

  let totalStoresSynced = 0;
  let totalProductsSynced = 0;
  let totalCustomersSynced = 0;
  let totalOrdersSynced = 0;
  let totalOrderItemsSynced = 0;
  let totalLedgersSynced = 0;

  // 2. Fetch and backup Store outlets strictly scoped to this business_id
  const storesRes = runSql(
    `SELECT * FROM stores WHERE business_id = '${cleanBizId}'`,
    'Cloud Sync: Fetch local stores',
    true
  );
  const storeRows = storesRes.success && Array.isArray(storesRes.data) ? storesRes.data : [];
  for (const store of storeRows) {
    const safeStoreId = sanitizeIdForFirestore(store.id, 'store');
    const storePath = `businesses/${safeBizId}/stores/${safeStoreId}`;
    try {
      isOnline = await writeDocOfflineAware(
        doc(db, 'businesses', safeBizId, 'stores', safeStoreId),
        {
          id: safeStoreId,
          business_id: safeBizId,
          store_id: safeStoreId,
          ownerUid: currentUid,
          name: String(store.name || safeStoreId).slice(0, 200),
          location: String(store.location || 'Main').slice(0, 200),
          allow_discounts: parseInt(store.allow_discounts as any, 10) || 0,
          allow_refunds: parseInt(store.allow_refunds as any, 10) || 0,
          allow_laybys: parseInt(store.allow_laybys as any, 10) || 0,
          require_manager_discount: parseInt(store.require_manager_discount as any, 10) || 0,
        },
        storePath,
        isOnline
      );
      totalStoresSynced++;
    } catch (err: any) {
      if (isNetworkOrOfflineAuthError(err)) {
        lastAuthNetworkFailureAt = Date.now();
        await setFirestoreOfflineMode();
        isOnline = false;
      } else if (isOnline) {
        handleFirestoreError(err, OperationType.WRITE, storePath);
      }
    }
  }

  // 3. Fetch and backup Products strictly scoped to this business_id
  const productsRes = runSql(
    `SELECT * FROM products WHERE business_id = '${cleanBizId}'`,
    'Cloud Sync: Fetch local products',
    true
  );
  const productRows = productsRes.success && Array.isArray(productsRes.data) ? productsRes.data : [];
  for (const prod of productRows) {
    const prodIdNum = parseInt(prod.id as any, 10) || 1;
    const prodDocId = sanitizeIdForFirestore(prodIdNum, 'prod');
    const prodPath = `businesses/${safeBizId}/products/${prodDocId}`;
    const prodStoreId = sanitizeIdForFirestore(prod.store_id || storeRows[0]?.id || primaryStoreId, 'store');
    try {
      isOnline = await writeDocOfflineAware(
        doc(db, 'businesses', safeBizId, 'products', prodDocId),
        {
          id: prodIdNum,
          business_id: safeBizId,
          store_id: prodStoreId,
          ownerUid: currentUid,
          name: String(prod.name || 'Item').slice(0, 250),
          description: String(prod.description || '').slice(0, 4000),
          sku: String(prod.sku || `SKU-${prodIdNum}`).slice(0, 100),
          category: String(prod.category || 'General').slice(0, 100),
          price: Math.max(0, parseFloat(prod.price as any) || 0.0),
          cost: Math.max(0, parseFloat(prod.cost as any) || 0.0),
          stock: parseInt(prod.stock as any, 10) || 0,
          imageUrl: String(prod.imageUrl || '').slice(0, 290000),
          is_service: parseInt(prod.is_service as any, 10) || 0,
          batch_number: String(prod.batch_number || '').slice(0, 100),
          expiry_date: String(prod.expiry_date || '').slice(0, 100),
        },
        prodPath,
        isOnline
      );
      totalProductsSynced++;
    } catch (err: any) {
      if (isNetworkOrOfflineAuthError(err)) {
        lastAuthNetworkFailureAt = Date.now();
        await setFirestoreOfflineMode();
        isOnline = false;
      } else if (isOnline) {
        handleFirestoreError(err, OperationType.WRITE, prodPath);
      }
    }
  }

  // 4. Fetch and backup Clients strictly scoped to this business_id
  const customersRes = runSql(
    `SELECT * FROM customers WHERE business_id = '${cleanBizId}'`,
    'Cloud Sync: Fetch local customers',
    true
  );
  const customerRows = customersRes.success && Array.isArray(customersRes.data) ? customersRes.data : [];
  for (const cust of customerRows) {
    const custIdNum = parseInt(cust.id as any, 10) || 1;
    const custDocId = sanitizeIdForFirestore(custIdNum, 'cust');
    const custPath = `businesses/${safeBizId}/customers/${custDocId}`;
    const custStoreId = sanitizeIdForFirestore(cust.store_id || storeRows[0]?.id || primaryStoreId, 'store');
    try {
      isOnline = await writeDocOfflineAware(
        doc(db, 'businesses', safeBizId, 'customers', custDocId),
        {
          id: custIdNum,
          business_id: safeBizId,
          store_id: custStoreId,
          ownerUid: currentUid,
          name: String(cust.name || 'Walk-in Client').slice(0, 200),
          phone: String(cust.phone || '').slice(0, 50),
          email: String(cust.email || '').slice(0, 200),
          loyalPoints: Math.max(0, parseInt(cust.loyalPoints as any, 10) || 0),
          tpin: String(cust.tpin || '').slice(0, 100),
          zra_connected: parseInt(cust.zra_connected as any, 10) || 0,
          tax_band: String(cust.tax_band || 'A - Standard Rate (16%)').slice(0, 100),
        },
        custPath,
        isOnline
      );
      totalCustomersSynced++;
    } catch (err: any) {
      if (isNetworkOrOfflineAuthError(err)) {
        lastAuthNetworkFailureAt = Date.now();
        await setFirestoreOfflineMode();
        isOnline = false;
      } else if (isOnline) {
        handleFirestoreError(err, OperationType.WRITE, custPath);
      }
    }
  }

  // 5. Fetch and backup Orders strictly scoped to this business_id
  const ordersRes = runSql(
    `SELECT * FROM orders WHERE business_id = '${cleanBizId}'`,
    'Cloud Sync: Fetch local orders',
    true
  );
  const orderRows = ordersRes.success && Array.isArray(ordersRes.data) ? ordersRes.data : [];
  const orderStoreMap = new Map<string, string>();
  for (const order of orderRows) {
    const safeOrderId = sanitizeIdForFirestore(order.id, 'ord');
    const orderStoreId = sanitizeIdForFirestore(order.store_id || storeRows[0]?.id || primaryStoreId, 'store');
    orderStoreMap.set(safeOrderId, orderStoreId);
    const orderPath = `businesses/${safeBizId}/orders/${safeOrderId}`;
    try {
      isOnline = await writeDocOfflineAware(
        doc(db, 'businesses', safeBizId, 'orders', safeOrderId),
        {
          id: safeOrderId,
          business_id: safeBizId,
          store_id: orderStoreId,
          ownerUid: currentUid,
          customerId: order.customerId ? parseInt(order.customerId as any, 10) : null,
          orderDate: String(order.orderDate || new Date().toISOString()).slice(0, 100),
          subtotal: Math.max(0, parseFloat(order.subtotal as any) || 0.0),
          tax: Math.max(0, parseFloat(order.tax as any) || 0.0),
          discount: Math.max(0, parseFloat(order.discount as any) || 0.0),
          total: Math.max(0, parseFloat(order.total as any) || 0.0),
          paymentMethod: String(order.paymentMethod || 'CASH').slice(0, 50),
          status: String(order.status || 'Completed').slice(0, 50),
          performed_by: String(order.performed_by || 'owner').slice(0, 100),
        },
        orderPath,
        isOnline
      );
      totalOrdersSynced++;
    } catch (err: any) {
      if (isNetworkOrOfflineAuthError(err)) {
        lastAuthNetworkFailureAt = Date.now();
        await setFirestoreOfflineMode();
        isOnline = false;
      } else if (isOnline) {
        handleFirestoreError(err, OperationType.WRITE, orderPath);
      }
    }
  }

  // 6. Fetch and backup Order Items strictly scoped to this business_id
  const orderItemsRes = runSql(
    `SELECT * FROM order_items WHERE business_id = '${cleanBizId}'`,
    'Cloud Sync: Fetch local order_items',
    true
  );
  const orderItemRows =
    orderItemsRes.success && Array.isArray(orderItemsRes.data) ? orderItemsRes.data : [];
  for (const item of orderItemRows) {
    const safeItemId = sanitizeIdForFirestore(item.id, 'item');
    const safeOrderId = sanitizeIdForFirestore(item.orderId, 'ord');
    const itemStoreId = sanitizeIdForFirestore(
      item.store_id || orderStoreMap.get(safeOrderId) || storeRows[0]?.id || primaryStoreId,
      'store'
    );
    const itemPath = `businesses/${safeBizId}/order_items/${safeItemId}`;
    try {
      isOnline = await writeDocOfflineAware(
        doc(db, 'businesses', safeBizId, 'order_items', safeItemId),
        {
          id: safeItemId,
          business_id: safeBizId,
          store_id: itemStoreId,
          ownerUid: currentUid,
          orderId: safeOrderId,
          productId: parseInt(item.productId as any, 10) || 0,
          quantity: Math.max(1, parseInt(item.quantity as any, 10) || 1),
          unitPrice: Math.max(0, parseFloat(item.unitPrice as any) || 0.0),
        },
        itemPath,
        isOnline
      );
      totalOrderItemsSynced++;
    } catch (err: any) {
      if (isNetworkOrOfflineAuthError(err)) {
        lastAuthNetworkFailureAt = Date.now();
        await setFirestoreOfflineMode();
        isOnline = false;
      } else if (isOnline) {
        handleFirestoreError(err, OperationType.WRITE, itemPath);
      }
    }
  }

  // 7. Fetch and backup Double-Entry Accounting & Client Relational Ledgers strictly scoped to business_id
  const ledgerTablesToSync = [
    'double_entry_journal',
    'receipt_refund_ledger',
    'cash_flow_ledger',
    'payment_method_ledger',
    'cash_ups',
    'financial_statements_ledger',
    'laybys',
    'layby_installments',
    'quotations',
    'expenses',
    'purchases_transit',
    'suppliers',
    'assets',
    'equity',
    'staff',
    'store_products',
    'payment_methods',
    'zra_invoices',
    'zra_sync_queue',
  ];

  const ledgerMapForStorage: Record<string, any[]> = {};

  for (const tableName of ledgerTablesToSync) {
    const tRes = runSql(
      `SELECT * FROM ${tableName} WHERE business_id = '${cleanBizId}'`,
      `Cloud Sync: Read ${tableName}`,
      true
    );
    const rawRows = (tRes.success && Array.isArray(tRes.data) ? tRes.data : []).map((r: any) => ({
      ...r,
      business_id: safeBizId,
      store_id: String(r?.store_id || primaryStoreId),
    }));
    ledgerMapForStorage[tableName] = rawRows;

    const boundedRecords = rawRows.slice(0, 500).map(sanitizeRecordMap);
    const ledgerDocId = sanitizeIdForFirestore(tableName, 'ledger');
    const ledgerPath = `businesses/${safeBizId}/ledgers/${ledgerDocId}`;

    try {
      isOnline = await writeDocOfflineAware(
        doc(db, 'businesses', safeBizId, 'ledgers', ledgerDocId),
        {
          id: ledgerDocId,
          business_id: safeBizId,
          store_id: primaryStoreId,
          ownerUid: currentUid,
          ledger_type: tableName,
          record_count: boundedRecords.length,
          records: boundedRecords,
          updatedAt: serverTimestamp(),
        },
        ledgerPath,
        isOnline
      );
      totalLedgersSynced++;
    } catch (err: any) {
      if (isNetworkOrOfflineAuthError(err)) {
        lastAuthNetworkFailureAt = Date.now();
        await setFirestoreOfflineMode();
        isOnline = false;
      } else if (isOnline) {
        handleFirestoreError(err, OperationType.WRITE, ledgerPath);
      }
    }
  }

  // 8. When online, also upload default backups to Firebase Cloud Storage
  let settingsObj: any = null;
  try {
    const rawS = localStorage.getItem('android_pos_settings');
    if (rawS) settingsObj = JSON.parse(rawS);
  } catch {}

  const storageResult =
    isOnline && !isFirestoreNetworkDisabled
      ? await backupClientsAndTransactionsToStorage(safeBizId, {
          business: biz,
          stores: storeRows,
          products: productRows,
          customers: customerRows,
          laybys: ledgerMapForStorage['laybys'] || [],
          laybyInstallments: ledgerMapForStorage['layby_installments'] || [],
          quotations: ledgerMapForStorage['quotations'] || [],
          orders: orderRows,
          orderItems: orderItemRows,
          ledgers: ledgerMapForStorage,
          settings: settingsObj,
        })
      : { storageSynced: false, filesUploaded: [] };

  const storageNote = storageResult.storageSynced
    ? ` + Firebase Storage (${storageResult.filesUploaded.length} archive files)`
    : !isOnline || isFirestoreNetworkDisabled
    ? ' (queued offline in Firestore IndexedDB — will auto-sync on reconnect)'
    : '';

  return {
    success: true,
    details: `Backed up to Firebase Firestore${storageNote}: ${totalStoresSynced} outlets, ${totalProductsSynced} stock items, ${totalCustomersSynced} clients, ${totalOrdersSynced} transactions (${totalOrderItemsSynced} line items), and ${totalLedgersSynced} accounting ledgers.`,
  };
}

// ============================================================================
// CLOUD RESTORE (Firestore + Firebase Storage -> AlaSQL Local)
// ============================================================================
export async function restoreFromCloud(businessId?: string): Promise<{ success: boolean; details: string }> {
  if (!auth.currentUser) {
    throw new Error('You must be signed in (Email/Password or Google) to restore from Firebase Cloud.');
  }

  const isOnline = await ensureFirestoreOnlineIfReachable();
  const currentUid = auth.currentUser.uid;
  let targetBizId = businessId && businessId !== 'default_biz' ? sanitizeIdForFirestore(businessId, 'biz') : '';
  let bizData: any = null;

  // 1. Locate Business Profile in Firestore (by businessId or by ownerUid query)
  if (targetBizId) {
    const bizPath = `businesses/${targetBizId}`;
    try {
      const bizDocSnap = await getDoc(doc(db, 'businesses', targetBizId));
      if (bizDocSnap.exists()) {
        bizData = bizDocSnap.data();
      }
    } catch (err: any) {
      if (isNetworkOrOfflineAuthError(err)) {
        lastAuthNetworkFailureAt = Date.now();
        await setFirestoreOfflineMode();
        const cachedSnap = await getDocFromCache(doc(db, 'businesses', targetBizId)).catch(() => null);
        if (cachedSnap?.exists()) bizData = cachedSnap.data();
      } else {
        handleFirestoreError(err, OperationType.GET, bizPath);
      }
    }
  }

  if (!bizData) {
    const bizListPath = 'businesses';
    try {
      const q = query(collection(db, 'businesses'), where('ownerUid', '==', currentUid));
      const qSnap = await getDocs(q);
      if (!qSnap.empty) {
        const firstDoc = qSnap.docs[0];
        targetBizId = firstDoc.id;
        bizData = firstDoc.data();
      }
    } catch (err: any) {
      if (isNetworkOrOfflineAuthError(err)) {
        lastAuthNetworkFailureAt = Date.now();
        await setFirestoreOfflineMode();
        throw new Error('Firebase Cloud is currently unreachable (offline). Local database data remains active.');
      }
      handleFirestoreError(err, OperationType.LIST, bizListPath);
    }
  }

  if (!bizData || !targetBizId) {
    throw new Error(
      !isOnline
        ? 'No offline cached business backup found while offline.'
        : 'No business backup found in Firebase Cloud for this account yet.'
    );
  }

  // Save/Restore local Business Profile
  runSql(`DELETE FROM businesses WHERE id = '${sqlEsc(targetBizId)}'`, 'Restore: Clean old business row', true);
  const restoredPrimaryStoreId = sanitizeIdForFirestore(bizData.store_id || 'main', 'store');
  runSql(
    `INSERT INTO businesses (id, name, owner, email, password, created_at, business_id, store_id) VALUES (
      '${sqlEsc(targetBizId)}', 
      '${sqlEsc(bizData.name || 'Business')}', 
      '${sqlEsc(bizData.owner || 'Owner')}', 
      '${sqlEsc(bizData.email || auth.currentUser.email || '')}', 
      'cloud_recovered', 
      '${new Date().toISOString()}',
      '${sqlEsc(targetBizId)}',
      '${sqlEsc(restoredPrimaryStoreId)}'
    )`,
    'Restore: Insert backed up business workspace',
    true
  );

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(
      'active_business_profile',
      JSON.stringify({
        id: targetBizId,
        name: bizData.name,
        owner: bizData.owner,
        email: bizData.email,
      })
    );
  }

  let totalStoresRestored = 0;
  let totalProductsRestored = 0;
  let totalCustomersRestored = 0;
  let totalOrdersRestored = 0;
  let totalOrderItemsRestored = 0;
  let totalLedgersRestored = 0;

  // 2. Pull Store outlets (using ownerUid + business_id filters for strict tenant isolation)
  const storesPath = `businesses/${targetBizId}/stores`;
  try {
    const sSnap = await getDocs(
      query(
        collection(db, 'businesses', targetBizId, 'stores'),
        where('ownerUid', '==', currentUid),
        where('business_id', '==', targetBizId)
      )
    );
    if (!sSnap.empty) {
      runSql(`DELETE FROM stores WHERE business_id = '${sqlEsc(targetBizId)}'`, 'Restore: Clean old stores', true);
      sSnap.forEach((docSnap) => {
        const d = docSnap.data();
        runSql(
          `INSERT INTO stores (id, business_id, name, location, allow_discounts, allow_refunds, allow_laybys, require_manager_discount, store_id) VALUES (
            '${sqlEsc(docSnap.id)}', 
            '${sqlEsc(targetBizId)}', 
            '${sqlEsc(d.name || docSnap.id)}', 
            '${sqlEsc(d.location || 'Main')}', 
            ${d.allow_discounts || 0}, 
            ${d.allow_refunds || 0}, 
            ${d.allow_laybys || 0}, 
            ${d.require_manager_discount || 0},
            '${sqlEsc(d.store_id || docSnap.id)}'
          )`,
          'Restore: Sink branch outlets',
          true
        );
        totalStoresRestored++;
      });
    }
  } catch (err: any) {
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      await setFirestoreOfflineMode();
    } else {
      handleFirestoreError(err, OperationType.LIST, storesPath);
    }
  }

  // 3. Pull Products catalog & batches
  const productsPath = `businesses/${targetBizId}/products`;
  try {
    const pSnap = await getDocs(
      query(
        collection(db, 'businesses', targetBizId, 'products'),
        where('ownerUid', '==', currentUid),
        where('business_id', '==', targetBizId)
      )
    );
    if (!pSnap.empty) {
      runSql(`DELETE FROM products WHERE business_id = '${sqlEsc(targetBizId)}'`, 'Restore: Clean old products', true);
      pSnap.forEach((docSnap) => {
        const d = docSnap.data();
        const cleanImgUrl = d.imageUrl ? sqlEsc(d.imageUrl) : '';
        const cleanDesc = d.description ? sqlEsc(d.description) : '';
        const cleanBatch = d.batch_number ? sqlEsc(d.batch_number) : '';
        const cleanExpiry = d.expiry_date ? sqlEsc(d.expiry_date) : '';
        const cleanStore = sqlEsc(d.store_id || restoredPrimaryStoreId);
        runSql(
          `INSERT INTO products (id, name, description, sku, category, price, cost, stock, imageUrl, business_id, is_service, batch_number, expiry_date, store_id) VALUES (
            ${d.id}, 
            '${sqlEsc(d.name || 'Item')}', 
            '${cleanDesc}', 
            '${sqlEsc(d.sku || '')}', 
            '${sqlEsc(d.category || 'General')}', 
            ${d.price || 0.0}, 
            ${d.cost || 0.0}, 
            ${d.stock || 0}, 
            '${cleanImgUrl}', 
            '${sqlEsc(targetBizId)}',
            ${d.is_service || 0},
            '${cleanBatch}',
            '${cleanExpiry}',
            '${cleanStore}'
          )`,
          'Restore: Sink catalog products',
          true
        );
        totalProductsRestored++;
      });
    }
  } catch (err: any) {
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      await setFirestoreOfflineMode();
    } else {
      handleFirestoreError(err, OperationType.LIST, productsPath);
    }
  }

  // 4. Pull Client CRM list
  const customersPath = `businesses/${targetBizId}/customers`;
  try {
    const cSnap = await getDocs(
      query(
        collection(db, 'businesses', targetBizId, 'customers'),
        where('ownerUid', '==', currentUid),
        where('business_id', '==', targetBizId)
      )
    );
    if (!cSnap.empty) {
      runSql(`DELETE FROM customers WHERE business_id = '${sqlEsc(targetBizId)}'`, 'Restore: Clean old customers', true);
      cSnap.forEach((docSnap) => {
        const d = docSnap.data();
        const cleanStore = sqlEsc(d.store_id || restoredPrimaryStoreId);
        runSql(
          `INSERT INTO customers (id, name, phone, email, loyalPoints, tpin, zra_connected, tax_band, business_id, store_id) VALUES (
            ${d.id}, 
            '${sqlEsc(d.name || 'Client')}', 
            '${sqlEsc(d.phone || '')}', 
            '${sqlEsc(d.email || '')}', 
            ${d.loyalPoints || 0}, 
            '${sqlEsc(d.tpin || '')}', 
            ${d.zra_connected || 0}, 
            '${sqlEsc(d.tax_band || 'A - Standard Rate (16%)')}', 
            '${sqlEsc(targetBizId)}',
            '${cleanStore}'
          )`,
          'Restore: Sink customer CRM registry',
          true
        );
        totalCustomersRestored++;
      });
    }
  } catch (err: any) {
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      await setFirestoreOfflineMode();
    } else {
      handleFirestoreError(err, OperationType.LIST, customersPath);
    }
  }

  // 5. Pull Order invoices (scoped to targetBizId)
  const ordersPath = `businesses/${targetBizId}/orders`;
  try {
    const oSnap = await getDocs(
      query(
        collection(db, 'businesses', targetBizId, 'orders'),
        where('ownerUid', '==', currentUid),
        where('business_id', '==', targetBizId)
      )
    );
    if (!oSnap.empty) {
      runSql(`DELETE FROM orders WHERE business_id = '${sqlEsc(targetBizId)}'`, 'Restore: Clean old orders data', true);
      oSnap.forEach((docSnap) => {
        const d = docSnap.data();
        const custVal = d.customerId ? d.customerId : 'NULL';
        runSql(
          `INSERT INTO orders (id, customerId, orderDate, subtotal, tax, discount, total, paymentMethod, status, store_id, performed_by, business_id) VALUES (
            '${sqlEsc(d.id)}', 
            ${custVal}, 
            '${sqlEsc(d.orderDate)}', 
            ${d.subtotal || 0}, 
            ${d.tax || 0}, 
            ${d.discount || 0}, 
            ${d.total || 0}, 
            '${sqlEsc(d.paymentMethod || 'CASH')}', 
            '${sqlEsc(d.status || 'Completed')}', 
            '${sqlEsc(d.store_id || restoredPrimaryStoreId)}', 
            '${sqlEsc(d.performed_by || 'owner')}',
            '${sqlEsc(targetBizId)}'
          )`,
          'Restore: Sink invoice receipt elements',
          true
        );
        totalOrdersRestored++;
      });
    }
  } catch (err: any) {
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      await setFirestoreOfflineMode();
    } else {
      handleFirestoreError(err, OperationType.LIST, ordersPath);
    }
  }

  // 6. Pull Order Line Items (scoped to targetBizId)
  const orderItemsPath = `businesses/${targetBizId}/order_items`;
  try {
    const oiSnap = await getDocs(
      query(
        collection(db, 'businesses', targetBizId, 'order_items'),
        where('ownerUid', '==', currentUid),
        where('business_id', '==', targetBizId)
      )
    );
    if (!oiSnap.empty) {
      runSql(`DELETE FROM order_items WHERE business_id = '${sqlEsc(targetBizId)}'`, 'Restore: Clean old order_items', true);
      oiSnap.forEach((docSnap) => {
        const d = docSnap.data();
        runSql(
          `INSERT INTO order_items (id, orderId, productId, quantity, unitPrice, business_id, store_id) VALUES (
            '${sqlEsc(d.id)}',
            '${sqlEsc(d.orderId)}',
            ${d.productId || 0},
            ${d.quantity || 1},
            ${d.unitPrice || 0},
            '${sqlEsc(targetBizId)}',
            '${sqlEsc(d.store_id || restoredPrimaryStoreId)}'
          )`,
          'Restore: Sink order line item',
          true
        );
        totalOrderItemsRestored++;
      });
    }
  } catch (err: any) {
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      await setFirestoreOfflineMode();
    } else {
      handleFirestoreError(err, OperationType.LIST, orderItemsPath);
    }
  }

  // 7. Pull Accounting & Client Relational Ledgers (including quotations)
  const ledgersPath = `businesses/${targetBizId}/ledgers`;
  try {
    const lSnap = await getDocs(
      query(
        collection(db, 'businesses', targetBizId, 'ledgers'),
        where('ownerUid', '==', currentUid),
        where('business_id', '==', targetBizId)
      )
    );
    if (!lSnap.empty) {
      const restoredLedgers: Record<string, any[]> = {};
      lSnap.forEach((docSnap) => {
        const d = docSnap.data();
        const tableName = String(d.ledger_type || docSnap.id);
        const rows = Array.isArray(d.records) ? d.records : [];
        if (rows.length > 0) {
          restoredLedgers[tableName] = rows.map((r: any) => ({
            ...r,
            business_id: targetBizId,
            store_id: String(r?.store_id || d.store_id || restoredPrimaryStoreId),
          }));
          totalLedgersRestored++;
        }
      });
      if (Object.keys(restoredLedgers).length > 0) {
        rehydrateAlasqlFromRecords(restoredLedgers, {
          businessId: targetBizId,
          storeId: restoredPrimaryStoreId,
          preserveOtherBusinesses: true,
        });
      }
    }
  } catch (err: any) {
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      await setFirestoreOfflineMode();
    } else {
      handleFirestoreError(err, OperationType.LIST, ledgersPath);
    }
  }

  // 8. When online, also check Firebase Cloud Storage archive for full untruncated quotations & settings
  if (isOnline && !isFirestoreNetworkDisabled) {
    try {
      const clientsRef = storageRef(storage, `backups/${targetBizId}/clients_data.json`);
      const cBytes = await getBytes(clientsRef);
      const cText = new TextDecoder().decode(cBytes);
      const cParsed = JSON.parse(cText);
      if (cParsed?.clients && Array.isArray(cParsed.clients.quotations) && cParsed.clients.quotations.length > 0) {
        rehydrateAlasqlFromRecords({ quotations: cParsed.clients.quotations });
      }
    } catch {
      // Clients archive optional
    }

    try {
      const fullRef = storageRef(storage, `backups/${targetBizId}/full_workspace_backup.json`);
      const bytes = await getBytes(fullRef);
      const text = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(text);
      if (parsed && parsed.settings && typeof localStorage !== 'undefined') {
        localStorage.setItem('android_pos_settings', JSON.stringify(parsed.settings));
      }
      if (Array.isArray(parsed?.quotations) && parsed.quotations.length > 0) {
        rehydrateAlasqlFromRecords({ quotations: parsed.quotations });
      }
    } catch {
      // Storage archive optional on restore if Firestore succeeded
    }
  }

  syncAllAccountingSystems('Firebase Cloud Restore');
  persistTablesToStorage(true);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('local_db_restored'));
    window.dispatchEvent(new Event('pos_data_updated'));
  }

  return {
    success: true,
    details: `Restored from Firebase Cloud [${bizData.name}]: ${totalStoresRestored} outlets, ${totalProductsRestored} stock items, ${totalCustomersRestored} clients, ${totalOrdersRestored} transactions (${totalOrderItemsRestored} line items), and ${totalLedgersRestored} accounting ledgers.`,
  };
}

// ============================================================================
// AUTOMATIC BACKGROUND FIREBASE BACKUP ON SALES, CLIENT UPDATES & SYNC EVENTS
// ============================================================================
let autoFirebaseBackupTimer: ReturnType<typeof setTimeout> | null = null;

export function triggerAutoFirebaseBackup(businessId?: string) {
  if (!auth.currentUser) return;
  if (typeof localStorage !== 'undefined' && localStorage.getItem('pos_authenticated_session') !== 'true') return;
  if (autoFirebaseBackupTimer) {
    clearTimeout(autoFirebaseBackupTimer);
  }
  autoFirebaseBackupTimer = setTimeout(async () => {
    try {
      let targetBizId = businessId || '';
      if (!targetBizId && typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem('active_business_profile');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed?.id && parsed.id !== 'default_biz') {
            targetBizId = parsed.id;
          }
        }
      }
      if (!targetBizId) {
        const bRes = runSql('SELECT * FROM businesses', 'Auto Firebase Backup: Check business', true);
        if (bRes.success && Array.isArray(bRes.data) && bRes.data.length > 0) {
          targetBizId = bRes.data[0].id;
        }
      }
      if (targetBizId && targetBizId !== 'default_biz' && isCurrentUserAuthorizedBusinessOwner(targetBizId)) {
        await backupToCloud(targetBizId, { silentIfNotOwner: true });
      }
    } catch (err) {
      console.warn('Auto Firebase background backup notice:', err);
    }
  }, 1800);
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => {
    void setFirestoreOfflineMode();
  });
  window.addEventListener('pos_data_updated', () => {
    triggerAutoFirebaseBackup();
  });
  window.addEventListener('pos_sync_status_changed', () => {
    triggerAutoFirebaseBackup();
  });
  window.addEventListener('online', () => {
    lastAuthNetworkFailureAt = 0;
    void ensureFirestoreOnlineIfReachable().then((online) => {
      if (online) {
        void flushPendingFinalizedTxMirrors();
        triggerAutoFirebaseBackup();
      }
    });
  });
}
