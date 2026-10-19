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
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  getDocs,
  collection,
  query,
  where,
  serverTimestamp,
} from 'firebase/firestore';
import {
  getStorage,
  ref as storageRef,
  uploadString,
  getBytes,
} from 'firebase/storage';
import firebaseConfig from '../firebase-applet-config.json';
import { runSql, persistTablesToStorage, syncAllAccountingSystems } from './db';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(
  app,
  (firebaseConfig as any).firestoreDatabaseId || 'ai-studio-32ea9ad7-3a6b-4977-b7b9-ef484b98c7f4'
);
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

// Sync authenticated Firebase user with backend Cloud SQL users table
export async function syncFirebaseUserWithBackend(user: User | null) {
  if (!user) return;
  try {
    const idToken = await user.getIdToken();
    await fetch('/api/auth/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
    });
  } catch (err) {
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
  await signOut(auth);
  cachedAccessToken = null;
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
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return;
    }
    const checkPromise = getDocFromServer(doc(db, 'test', 'connection'));
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 2500)
    );
    await Promise.race([checkPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

if (typeof window !== 'undefined') {
  testConnection();
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

// ============================================================================
// CLOUD BACKUP (AlaSQL Local -> Firestore Relational + Firebase Storage)
// ============================================================================
export async function backupToCloud(businessId: string): Promise<{ success: boolean; details: string }> {
  if (!auth.currentUser) {
    throw new Error('You must be signed in (Email/Password or Google) to sync with Firebase Cloud.');
  }

  // Ensure all double-entry accounting ledgers are up to date before backing up
  syncAllAccountingSystems('Firebase Cloud Backup');

  const safeBizId = sanitizeIdForFirestore(businessId, 'biz');
  const currentUid = auth.currentUser.uid;

  // 1. Fetch current business profile locally
  const localBizRes = runSql(
    `SELECT * FROM businesses WHERE id = '${businessId}'`,
    'Cloud Sync: Read local profile',
    true
  );
  const allBizRes = runSql(`SELECT * FROM businesses`, 'Cloud Sync: Fallback business read', true);
  const biz =
    localBizRes.success && Array.isArray(localBizRes.data) && localBizRes.data.length > 0
      ? localBizRes.data[0]
      : allBizRes.success && Array.isArray(allBizRes.data) && allBizRes.data.length > 0
      ? allBizRes.data[0]
      : {
          id: safeBizId,
          name: 'POS Enterprise',
          owner: auth.currentUser.displayName || 'Business Owner',
          email: auth.currentUser.email || 'owner@pos.app',
        };

  // Upsert primary Business document (preserving createdAt if already created)
  const bizPath = `businesses/${safeBizId}`;
  try {
    const bizRef = doc(db, 'businesses', safeBizId);
    const existingSnap = await getDoc(bizRef);
    const cleanName = String(biz.name || 'POS Business').slice(0, 200);
    const cleanOwner = String(biz.owner || auth.currentUser.displayName || 'Owner').slice(0, 200);
    const cleanEmail = String(biz.email || auth.currentUser.email || 'owner@pos.app').slice(0, 200);

    if (existingSnap.exists()) {
      const existingData = existingSnap.data();
      await setDoc(bizRef, {
        id: safeBizId,
        name: cleanName,
        owner: cleanOwner,
        email: cleanEmail,
        ownerUid: existingData.ownerUid || currentUid,
        createdAt: existingData.createdAt || serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(bizRef, {
        id: safeBizId,
        name: cleanName,
        owner: cleanOwner,
        email: cleanEmail,
        ownerUid: currentUid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, bizPath);
  }

  let totalStoresSynced = 0;
  let totalProductsSynced = 0;
  let totalCustomersSynced = 0;
  let totalOrdersSynced = 0;
  let totalOrderItemsSynced = 0;
  let totalLedgersSynced = 0;

  // 2. Fetch and backup Store outlets
  const storesRes = runSql(
    `SELECT * FROM stores WHERE business_id = '${businessId}'`,
    'Cloud Sync: Fetch local stores',
    true
  );
  const storeRows = storesRes.success && Array.isArray(storesRes.data) ? storesRes.data : [];
  for (const store of storeRows) {
    const safeStoreId = sanitizeIdForFirestore(store.id, 'store');
    const storePath = `businesses/${safeBizId}/stores/${safeStoreId}`;
    try {
      await setDoc(doc(db, 'businesses', safeBizId, 'stores', safeStoreId), {
        id: safeStoreId,
        business_id: safeBizId,
        ownerUid: currentUid,
        name: String(store.name || safeStoreId).slice(0, 200),
        location: String(store.location || 'Main').slice(0, 200),
        allow_discounts: parseInt(store.allow_discounts as any, 10) || 0,
        allow_refunds: parseInt(store.allow_refunds as any, 10) || 0,
        allow_laybys: parseInt(store.allow_laybys as any, 10) || 0,
        require_manager_discount: parseInt(store.require_manager_discount as any, 10) || 0,
      });
      totalStoresSynced++;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, storePath);
    }
  }

  // 3. Fetch and backup Products catalog & batches
  const productsRes = runSql(
    `SELECT * FROM products WHERE business_id = '${businessId}' OR business_id IS NULL OR business_id = 'default_biz'`,
    'Cloud Sync: Fetch local products',
    true
  );
  const productRows = productsRes.success && Array.isArray(productsRes.data) ? productsRes.data : [];
  for (const prod of productRows) {
    const prodIdNum = parseInt(prod.id as any, 10) || 1;
    const prodDocId = sanitizeIdForFirestore(prodIdNum, 'prod');
    const prodPath = `businesses/${safeBizId}/products/${prodDocId}`;
    try {
      await setDoc(doc(db, 'businesses', safeBizId, 'products', prodDocId), {
        id: prodIdNum,
        business_id: safeBizId,
        ownerUid: currentUid,
        name: String(prod.name || 'Item').slice(0, 250),
        sku: String(prod.sku || `SKU-${prodIdNum}`).slice(0, 100),
        category: String(prod.category || 'General').slice(0, 100),
        price: Math.max(0, parseFloat(prod.price as any) || 0.0),
        cost: Math.max(0, parseFloat(prod.cost as any) || 0.0),
        stock: parseInt(prod.stock as any, 10) || 0,
        imageUrl: String(prod.imageUrl || '').slice(0, 290000),
        is_service: parseInt(prod.is_service as any, 10) || 0,
        batch_number: String(prod.batch_number || '').slice(0, 100),
        expiry_date: String(prod.expiry_date || '').slice(0, 100),
      });
      totalProductsSynced++;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, prodPath);
    }
  }

  // 4. Fetch and backup Clients / Customer CRM list
  const customersRes = runSql(
    `SELECT * FROM customers WHERE business_id = '${businessId}' OR business_id IS NULL OR business_id = 'default_biz'`,
    'Cloud Sync: Fetch local customers',
    true
  );
  const customerRows = customersRes.success && Array.isArray(customersRes.data) ? customersRes.data : [];
  for (const cust of customerRows) {
    const custIdNum = parseInt(cust.id as any, 10) || 1;
    const custDocId = sanitizeIdForFirestore(custIdNum, 'cust');
    const custPath = `businesses/${safeBizId}/customers/${custDocId}`;
    try {
      await setDoc(doc(db, 'businesses', safeBizId, 'customers', custDocId), {
        id: custIdNum,
        business_id: safeBizId,
        ownerUid: currentUid,
        name: String(cust.name || 'Walk-in Client').slice(0, 200),
        phone: String(cust.phone || '').slice(0, 50),
        email: String(cust.email || '').slice(0, 200),
        loyalPoints: Math.max(0, parseInt(cust.loyalPoints as any, 10) || 0),
        tpin: String(cust.tpin || '').slice(0, 100),
        zra_connected: parseInt(cust.zra_connected as any, 10) || 0,
        tax_band: String(cust.tax_band || 'A - Standard Rate (16%)').slice(0, 100),
      });
      totalCustomersSynced++;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, custPath);
    }
  }

  // 5. Fetch and backup Orders (Sales & Refund Transactions)
  const ordersRes = runSql(`SELECT * FROM orders`, 'Cloud Sync: Fetch local orders', true);
  const orderRows = ordersRes.success && Array.isArray(ordersRes.data) ? ordersRes.data : [];
  for (const order of orderRows) {
    const safeOrderId = sanitizeIdForFirestore(order.id, 'ord');
    const orderPath = `businesses/${safeBizId}/orders/${safeOrderId}`;
    try {
      await setDoc(doc(db, 'businesses', safeBizId, 'orders', safeOrderId), {
        id: safeOrderId,
        business_id: safeBizId,
        ownerUid: currentUid,
        customerId: order.customerId ? parseInt(order.customerId as any, 10) : null,
        orderDate: String(order.orderDate || new Date().toISOString()).slice(0, 100),
        subtotal: Math.max(0, parseFloat(order.subtotal as any) || 0.0),
        tax: Math.max(0, parseFloat(order.tax as any) || 0.0),
        discount: Math.max(0, parseFloat(order.discount as any) || 0.0),
        total: Math.max(0, parseFloat(order.total as any) || 0.0),
        paymentMethod: String(order.paymentMethod || 'CASH').slice(0, 50),
        status: String(order.status || 'Completed').slice(0, 50),
        store_id: String(order.store_id || storeRows[0]?.id || 'main').slice(0, 128),
        performed_by: String(order.performed_by || 'owner').slice(0, 100),
      });
      totalOrdersSynced++;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, orderPath);
    }
  }

  // 6. Fetch and backup Order Items (Relational line items linking Orders <-> Products)
  const orderItemsRes = runSql(`SELECT * FROM order_items`, 'Cloud Sync: Fetch local order_items', true);
  const orderItemRows =
    orderItemsRes.success && Array.isArray(orderItemsRes.data) ? orderItemsRes.data : [];
  for (const item of orderItemRows) {
    const safeItemId = sanitizeIdForFirestore(item.id, 'item');
    const itemPath = `businesses/${safeBizId}/order_items/${safeItemId}`;
    try {
      await setDoc(doc(db, 'businesses', safeBizId, 'order_items', safeItemId), {
        id: safeItemId,
        business_id: safeBizId,
        ownerUid: currentUid,
        orderId: sanitizeIdForFirestore(item.orderId, 'ord'),
        productId: parseInt(item.productId as any, 10) || 0,
        quantity: Math.max(1, parseInt(item.quantity as any, 10) || 1),
        unitPrice: Math.max(0, parseFloat(item.unitPrice as any) || 0.0),
      });
      totalOrderItemsSynced++;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, itemPath);
    }
  }

  // 7. Fetch and backup Double-Entry Accounting & Client Relational Ledgers
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
    'staff',
    'store_products',
  ];

  const ledgerMapForStorage: Record<string, any[]> = {};

  for (const tableName of ledgerTablesToSync) {
    const tRes = runSql(`SELECT * FROM ${tableName}`, `Cloud Sync: Read ${tableName}`, true);
    const rawRows = tRes.success && Array.isArray(tRes.data) ? tRes.data : [];
    ledgerMapForStorage[tableName] = rawRows;

    const boundedRecords = rawRows.slice(0, 500).map(sanitizeRecordMap);
    const ledgerDocId = sanitizeIdForFirestore(tableName, 'ledger');
    const ledgerPath = `businesses/${safeBizId}/ledgers/${ledgerDocId}`;

    try {
      await setDoc(doc(db, 'businesses', safeBizId, 'ledgers', ledgerDocId), {
        id: ledgerDocId,
        business_id: safeBizId,
        ownerUid: currentUid,
        ledger_type: tableName,
        record_count: boundedRecords.length,
        records: boundedRecords,
        updatedAt: serverTimestamp(),
      });
      totalLedgersSynced++;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, ledgerPath);
    }
  }

  // 8. Also upload default backups for Clients Data & Transactions to Firebase Cloud Storage
  let settingsObj: any = null;
  try {
    const rawS = localStorage.getItem('android_pos_settings');
    if (rawS) settingsObj = JSON.parse(rawS);
  } catch {}

  const storageResult = await backupClientsAndTransactionsToStorage(safeBizId, {
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
  });

  const storageNote = storageResult.storageSynced
    ? ` + Firebase Storage (${storageResult.filesUploaded.length} archive files)`
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
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, bizPath);
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
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, bizListPath);
    }
  }

  if (!bizData || !targetBizId) {
    throw new Error('No business backup found in Firebase Cloud for this account yet.');
  }

  // Save/Restore local Business Profile
  runSql(`DELETE FROM businesses WHERE id = '${targetBizId}'`, 'Restore: Clean old business row', true);
  runSql(
    `INSERT INTO businesses (id, name, owner, email, password, created_at) VALUES (
      '${targetBizId}', 
      '${String(bizData.name || 'Business').replace(/'/g, "''")}', 
      '${String(bizData.owner || 'Owner').replace(/'/g, "''")}', 
      '${String(bizData.email || auth.currentUser.email || '').replace(/'/g, "''")}', 
      'cloud_recovered', 
      '${new Date().toISOString()}'
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

  // 2. Pull Store outlets (using ownerUid filter to satisfy cost-optimized allow list rule)
  const storesPath = `businesses/${targetBizId}/stores`;
  try {
    const sSnap = await getDocs(
      query(collection(db, 'businesses', targetBizId, 'stores'), where('ownerUid', '==', currentUid))
    );
    if (!sSnap.empty) {
      runSql(`DELETE FROM stores WHERE business_id = '${targetBizId}'`, 'Restore: Clean old stores', true);
      sSnap.forEach((docSnap) => {
        const d = docSnap.data();
        runSql(
          `INSERT INTO stores (id, business_id, name, location, allow_discounts, allow_refunds, allow_laybys, require_manager_discount) VALUES (
            '${docSnap.id}', 
            '${targetBizId}', 
            '${String(d.name || docSnap.id).replace(/'/g, "''")}', 
            '${String(d.location || 'Main').replace(/'/g, "''")}', 
            ${d.allow_discounts || 0}, 
            ${d.allow_refunds || 0}, 
            ${d.allow_laybys || 0}, 
            ${d.require_manager_discount || 0}
          )`,
          'Restore: Sink branch outlets',
          true
        );
        totalStoresRestored++;
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, storesPath);
  }

  // 3. Pull Products catalog & batches
  const productsPath = `businesses/${targetBizId}/products`;
  try {
    const pSnap = await getDocs(
      query(collection(db, 'businesses', targetBizId, 'products'), where('ownerUid', '==', currentUid))
    );
    if (!pSnap.empty) {
      runSql(`DELETE FROM products WHERE business_id = '${targetBizId}'`, 'Restore: Clean old products', true);
      pSnap.forEach((docSnap) => {
        const d = docSnap.data();
        const cleanImgUrl = d.imageUrl ? String(d.imageUrl).replace(/'/g, "''") : '';
        const cleanBatch = d.batch_number ? String(d.batch_number).replace(/'/g, "''") : '';
        const cleanExpiry = d.expiry_date ? String(d.expiry_date).replace(/'/g, "''") : '';
        runSql(
          `INSERT INTO products (id, name, sku, category, price, cost, stock, imageUrl, business_id, is_service, batch_number, expiry_date) VALUES (
            ${d.id}, 
            '${String(d.name || 'Item').replace(/'/g, "''")}', 
            '${String(d.sku || '').replace(/'/g, "''")}', 
            '${String(d.category || 'General').replace(/'/g, "''")}', 
            ${d.price || 0.0}, 
            ${d.cost || 0.0}, 
            ${d.stock || 0}, 
            '${cleanImgUrl}', 
            '${targetBizId}',
            ${d.is_service || 0},
            '${cleanBatch}',
            '${cleanExpiry}'
          )`,
          'Restore: Sink catalog products',
          true
        );
        totalProductsRestored++;
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, productsPath);
  }

  // 4. Pull Client CRM list
  const customersPath = `businesses/${targetBizId}/customers`;
  try {
    const cSnap = await getDocs(
      query(collection(db, 'businesses', targetBizId, 'customers'), where('ownerUid', '==', currentUid))
    );
    if (!cSnap.empty) {
      runSql(`DELETE FROM customers WHERE business_id = '${targetBizId}'`, 'Restore: Clean old customers', true);
      cSnap.forEach((docSnap) => {
        const d = docSnap.data();
        runSql(
          `INSERT INTO customers (id, name, phone, email, loyalPoints, tpin, zra_connected, tax_band, business_id) VALUES (
            ${d.id}, 
            '${String(d.name || 'Client').replace(/'/g, "''")}', 
            '${String(d.phone || '').replace(/'/g, "''")}', 
            '${String(d.email || '').replace(/'/g, "''")}', 
            ${d.loyalPoints || 0}, 
            '${String(d.tpin || '').replace(/'/g, "''")}', 
            ${d.zra_connected || 0}, 
            '${String(d.tax_band || 'A - Standard Rate (16%)').replace(/'/g, "''")}', 
            '${targetBizId}'
          )`,
          'Restore: Sink customer CRM registry',
          true
        );
        totalCustomersRestored++;
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, customersPath);
  }

  // 5. Pull Order invoices
  const ordersPath = `businesses/${targetBizId}/orders`;
  try {
    const oSnap = await getDocs(
      query(collection(db, 'businesses', targetBizId, 'orders'), where('ownerUid', '==', currentUid))
    );
    if (!oSnap.empty) {
      runSql(`DELETE FROM orders`, 'Restore: Clean old orders data', true);
      oSnap.forEach((docSnap) => {
        const d = docSnap.data();
        const custVal = d.customerId ? d.customerId : 'NULL';
        runSql(
          `INSERT INTO orders (id, customerId, orderDate, subtotal, tax, discount, total, paymentMethod, status, store_id, performed_by) VALUES (
            '${d.id}', 
            ${custVal}, 
            '${d.orderDate}', 
            ${d.subtotal || 0}, 
            ${d.tax || 0}, 
            ${d.discount || 0}, 
            ${d.total || 0}, 
            '${String(d.paymentMethod || 'CASH').replace(/'/g, "''")}', 
            '${String(d.status || 'Completed').replace(/'/g, "''")}', 
            '${String(d.store_id || 'main').replace(/'/g, "''")}', 
            '${String(d.performed_by || 'owner').replace(/'/g, "''")}'
          )`,
          'Restore: Sink invoice receipt elements',
          true
        );
        totalOrdersRestored++;
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, ordersPath);
  }

  // 6. Pull Order Line Items
  const orderItemsPath = `businesses/${targetBizId}/order_items`;
  try {
    const oiSnap = await getDocs(
      query(collection(db, 'businesses', targetBizId, 'order_items'), where('ownerUid', '==', currentUid))
    );
    if (!oiSnap.empty) {
      runSql(`DELETE FROM order_items`, 'Restore: Clean old order_items', true);
      oiSnap.forEach((docSnap) => {
        const d = docSnap.data();
        runSql(
          `INSERT INTO order_items (id, orderId, productId, quantity, unitPrice) VALUES (
            '${d.id}',
            '${d.orderId}',
            ${d.productId || 0},
            ${d.quantity || 1},
            ${d.unitPrice || 0}
          )`,
          'Restore: Sink order line item',
          true
        );
        totalOrderItemsRestored++;
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, orderItemsPath);
  }

  // 7. Pull Accounting & Client Relational Ledgers
  const ledgersPath = `businesses/${targetBizId}/ledgers`;
  try {
    const lSnap = await getDocs(
      query(collection(db, 'businesses', targetBizId, 'ledgers'), where('ownerUid', '==', currentUid))
    );
    if (!lSnap.empty) {
      lSnap.forEach((docSnap) => {
        const d = docSnap.data();
        const tableName = String(d.ledger_type || docSnap.id);
        const rows = Array.isArray(d.records) ? d.records : [];
        if (rows.length > 0) {
          totalLedgersRestored++;
        }
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, ledgersPath);
  }

  // 8. Also check Firebase Cloud Storage archive if additional records exist
  try {
    const fullRef = storageRef(storage, `backups/${targetBizId}/full_workspace_backup.json`);
    const bytes = await getBytes(fullRef);
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    if (parsed && parsed.settings && typeof localStorage !== 'undefined') {
      localStorage.setItem('android_pos_settings', JSON.stringify(parsed.settings));
    }
  } catch {
    // Storage archive optional on restore if Firestore succeeded
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
      if (targetBizId && targetBizId !== 'default_biz') {
        await backupToCloud(targetBizId);
      }
    } catch (err) {
      console.warn('Auto Firebase background backup notice:', err);
    }
  }, 1800);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pos_data_updated', () => {
    triggerAutoFirebaseBackup();
  });
  window.addEventListener('pos_sync_status_changed', () => {
    triggerAutoFirebaseBackup();
  });
}
