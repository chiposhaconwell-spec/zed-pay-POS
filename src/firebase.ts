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
  deleteDoc,
  getDocs,
  collection,
  query,
  where,
  serverTimestamp,
  enableNetwork,
  disableNetwork,
  updateDoc,
} from 'firebase/firestore';
import {
  getStorage,
  ref as storageRef,
  uploadString,
  getBytes,
} from 'firebase/storage';
import firebaseConfig from '../firebase-applet-config.json';
import {
  ALL_TABLE_NAMES,
  runSql,
  persistTablesToStorage,
  syncAllAccountingSystems,
  rehydrateAlasqlFromRecords,
  sqlEsc,
  getActiveStoreId,
  getCustomPaymentMethods,
  saveReceiptToSqliteCache,
  markReceiptMirroredInSqlite,
  upsertUserAndMembership,
  syncUsersAndMembershipsFromLegacyTables,
} from './db';
import { getZraConfig, saveZraConfig, switchZraConfigForBusiness } from './zra/zraConfig';
import {
  computeCredentialHashSync,
  deriveFirebaseCredentialIdentity,
  deriveUserId,
  deriveMembershipId,
  normalizeAuthEmail,
  saveScopedBusinessSettings,
  getScopedSettingsKey,
} from './multiTenantAuth';

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

// Sign In with deterministic credential-hash session (used when switching already-unlocked workspaces)
export async function signInWithCredentialHash(
  credentialHash: string,
  displayName?: string
): Promise<User | null> {
  const cleanHash = String(credentialHash || '').trim();
  const credId = cleanHash.slice(0, 56);
  if (!credId) return null;
  const authEmail = `cred_${credId}@mt-pos.auth`;
  const authSecret = `MT_${cleanHash.slice(20, 56)}_Pos!9`;

  if (auth.currentUser && (auth.currentUser.email || '').toLowerCase() === authEmail.toLowerCase()) {
    return auth.currentUser;
  }

  try {
    const res = await signInWithEmailAndPassword(auth, authEmail, authSecret);
    await syncFirebaseUserWithBackend(res.user);
    return res.user;
  } catch (err: any) {
    if (err?.code === 'auth/user-not-found' || err?.code === 'auth/invalid-credential') {
      try {
        const created = await createUserWithEmailAndPassword(auth, authEmail, authSecret);
        if (displayName && displayName.trim()) {
          await updateProfile(created.user, { displayName: displayName.trim() }).catch(() => {});
        }
        await syncFirebaseUserWithBackend(created.user);
        return created.user;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Strict (email + password) Firebase Auth: never collides when same email belongs to multiple shops with different passwords
export async function signInOrCreateCredentialAuth(
  email: string,
  password: string,
  options?: { allowCreate?: boolean; displayName?: string; allowLegacyFallback?: boolean }
): Promise<{
  user: User;
  credId: string;
  credHash: string;
  authEmail: string;
  isLegacyAuth: boolean;
}> {
  const { cleanEmail, credHash, credId, authEmail, authSecret } = deriveFirebaseCredentialIdentity(email, password);
  const displayName = options?.displayName?.trim();

  if (options?.allowCreate) {
    try {
      const created = await createUserWithEmailAndPassword(auth, authEmail, authSecret);
      if (displayName) {
        await updateProfile(created.user, { displayName }).catch(() => {});
      }
      await syncFirebaseUserWithBackend(created.user);
      return { user: created.user, credId, credHash, authEmail, isLegacyAuth: false };
    } catch (err: any) {
      if (err?.code === 'auth/email-already-in-use') {
        const signed = await signInWithEmailAndPassword(auth, authEmail, authSecret);
        await syncFirebaseUserWithBackend(signed.user);
        return { user: signed.user, credId, credHash, authEmail, isLegacyAuth: false };
      }
      throw err;
    }
  }

  try {
    const signed = await signInWithEmailAndPassword(auth, authEmail, authSecret);
    await syncFirebaseUserWithBackend(signed.user);
    return { user: signed.user, credId, credHash, authEmail, isLegacyAuth: false };
  } catch (err: any) {
    if (err?.code === 'auth/user-not-found' || err?.code === 'auth/invalid-credential') {
      if (options?.allowLegacyFallback) {
        try {
          const legacySigned = await signInWithEmailAndPassword(auth, cleanEmail, normalizeFirebasePassword(password));
          await syncFirebaseUserWithBackend(legacySigned.user);
          return { user: legacySigned.user, credId, credHash, authEmail: cleanEmail, isLegacyAuth: true };
        } catch {
          // Proceed to credential-scoped provisioning so remote /credential_directory/{credId} invites can be read
        }
      }
      const created = await createUserWithEmailAndPassword(auth, authEmail, authSecret);
      if (displayName) {
        await updateProfile(created.user, { displayName }).catch(() => {});
      }
      await syncFirebaseUserWithBackend(created.user);
      return { user: created.user, credId, credHash, authEmail, isLegacyAuth: false };
    }
    throw err;
  }
}

// Register or Sign In with Firebase Email/Password Provider (legacy signature preserved)
export async function registerOrSignInWithEmailPassword(
  email: string,
  password: string,
  displayName?: string
): Promise<{ user: User; isNewUser: boolean }> {
  const { user } = await signInOrCreateCredentialAuth(email, password, {
    allowCreate: true,
    displayName,
  });
  return { user, isNewUser: true };
}

// Sign In with Firebase Email/Password Provider
export async function signInWithEmailPasswordAccount(
  email: string,
  password: string,
  allowAutoProvisionIfVerifiedLocally: boolean = false,
  displayName?: string
): Promise<User> {
  const { user } = await signInOrCreateCredentialAuth(email, password, {
    allowCreate: allowAutoProvisionIfVerifiedLocally,
    displayName,
    allowLegacyFallback: true,
  });
  return user;
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
  const isCredentialScopedAuth = currentEmail.startsWith('cred_') && currentEmail.endsWith('@mt-pos.auth');

  let loggedEmail = '';
  if (typeof localStorage !== 'undefined') {
    try {
      loggedEmail = (localStorage.getItem('logged_in_user_email') || '').trim().toLowerCase();
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

  const cleanBizId = sqlEsc(businessId || '');
  const bizRes = cleanBizId
    ? runSql(`SELECT * FROM businesses WHERE id = '${cleanBizId}'`, 'Cloud Sync: Verify owner profile', true)
    : { success: false, data: [] };
  const bizRow =
    bizRes.success && Array.isArray(bizRes.data) && bizRes.data.length > 0 ? bizRes.data[0] : null;

  if (isCredentialScopedAuth) {
    const authCredId = currentEmail.replace(/^cred_/, '').replace(/@mt-pos\.auth$/, '');
    if (cleanBizId && loggedEmail) {
      const memRes = runSql(
        `SELECT * FROM business_memberships WHERE business_id = '${cleanBizId}' AND LOWER(email) = '${sqlEsc(loggedEmail)}'`,
        'Cloud Sync: Verify owner membership',
        true
      );
      if (memRes.success && Array.isArray(memRes.data) && memRes.data.length > 0) {
        const ownerMem = memRes.data.find(
          (m: any) =>
            String(m.role || '').toLowerCase() === 'owner' &&
            String(m.status || 'ACTIVE').toUpperCase() !== 'SUSPENDED' &&
            (!m.credential_hash || String(m.credential_hash).startsWith(authCredId))
        );
        if (ownerMem) return true;
      }
    }
    if (bizRow?.email && loggedEmail && String(bizRow.email).trim().toLowerCase() === loggedEmail) {
      return true;
    }
    if (bizRow?.email && bizRow?.password && bizRow.password !== 'cloud_recovered') {
      const expectedCredId = computeCredentialHashSync(bizRow.email, bizRow.password).slice(0, 56);
      if (expectedCredId && expectedCredId === authCredId) return true;
    }
    return Boolean(!bizRow?.email || isVerifiedBootstrapAdmin);
  }

  if (bizRow?.email) {
    const bizOwnerEmail = String(bizRow.email).trim().toLowerCase();
    if (bizOwnerEmail && currentEmail && currentEmail !== bizOwnerEmail && !isVerifiedBootstrapAdmin) {
      return false;
    }
  }

  return true;
}

export function isCurrentUserBusinessMember(businessId: string): boolean {
  if (!auth.currentUser || !businessId || businessId === 'default_biz') return false;
  if (isCurrentUserAuthorizedBusinessOwner(businessId)) return true;
  if (typeof localStorage === 'undefined') return false;
  try {
    if (localStorage.getItem('pos_authenticated_session') !== 'true') return false;
    const rawBiz = localStorage.getItem('active_business_profile');
    if (!rawBiz) return false;
    const parsedBiz = JSON.parse(rawBiz);
    return Boolean(parsedBiz?.id && String(parsedBiz.id) === String(businessId));
  } catch {
    return false;
  }
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
    cashierId?: string;
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
    if (!isCurrentUserBusinessMember(rawBizId)) return;
    const isOwner = isCurrentUserAuthorizedBusinessOwner(rawBizId);

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
      const prodRef = doc(db, 'businesses', safeBizId, 'products', prodDocId);
      const nextStock = parseInt(prod.stock as any, 10) || 0;

      if (isOwner) {
        void setDoc(prodRef, {
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
          stock: nextStock,
          imageUrl: String(prod.imageUrl || '').slice(0, 290000),
          is_service: parseInt(prod.is_service as any, 10) || 0,
          batch_number: String(prod.batch_number || '').slice(0, 100),
          expiry_date: String(prod.expiry_date || '').slice(0, 100),
        }).catch((err) => {
          if (isNetworkOrOfflineAuthError(err)) {
            lastAuthNetworkFailureAt = Date.now();
            void setFirestoreOfflineMode();
          }
        });
      } else {
        // Tier 2 Member Update: only touch stock count while keeping ownerUid untouched
        void updateDoc(prodRef, { stock: nextStock }).catch(() => {});
      }

      const spDocId = sanitizeIdForFirestore(`sp_${prodIdNum}_${safeStoreId}`, 'sp');
      const localSp = runSql(
        `SELECT * FROM store_products WHERE product_id = ${prodIdNum} AND store_id = '${sqlEsc(safeStoreId)}' AND business_id = '${sqlEsc(rawBizId)}'`,
        'Firestore Sale Sync: Read branch stock',
        true
      );
      const spRow = localSp.success && Array.isArray(localSp.data) && localSp.data.length > 0 ? localSp.data[0] : null;
      const spStock = spRow ? parseInt(spRow.stock as any, 10) || 0 : nextStock;
      const spPrice = spRow
        ? Math.max(0, parseFloat(spRow.price as any) || 0.0)
        : Math.max(0, parseFloat(prod.price as any) || 0.0);

      const spRef = doc(db, 'businesses', safeBizId, 'store_products', spDocId);
      if (isOwner) {
        void setDoc(spRef, {
          id: spDocId,
          product_id: prodIdNum,
          business_id: safeBizId,
          store_id: safeStoreId,
          ownerUid: currentUid,
          stock: spStock,
          price: spPrice,
          updatedAt: serverTimestamp(),
        }).catch((err) => {
          if (isNetworkOrOfflineAuthError(err)) {
            lastAuthNetworkFailureAt = Date.now();
            void setFirestoreOfflineMode();
          }
        });
      } else {
        void updateDoc(spRef, {
          stock: spStock,
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      }
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
    cashierId?: string;
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

    if (!auth.currentUser || !isCurrentUserBusinessMember(rawBizId)) return;

    const orderRef = doc(db, 'businesses', safeBizId, 'orders', safeOrderId);
    const writePromise = updateDoc(orderRef, {
      status: 'Refunded',
      performed_by: String(params.order.performed_by || 'supervisor').slice(0, 100),
    });

    void writePromise
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
// MULTI-TENANT CREDENTIAL DIRECTORY & MEMBERSHIPS (CLOUD FIRESTORE SYNC)
// ============================================================================
const UNLINKED_CLOUD_BIZ_PREFIX = 'pos_unlinked_cloud_biz_';

export function isBusinessCloudMarkedUnlinked(businessId: string): boolean {
  if (!businessId || typeof localStorage === 'undefined') return false;
  const safeBizId = sanitizeIdForFirestore(businessId, 'biz');
  return localStorage.getItem(`${UNLINKED_CLOUD_BIZ_PREFIX}${safeBizId}`) === 'true';
}

export function setBusinessCloudUnlinkedFlag(businessId: string, unlinked: boolean) {
  if (!businessId || typeof localStorage === 'undefined') return;
  const safeBizId = sanitizeIdForFirestore(businessId, 'biz');
  if (unlinked) {
    localStorage.setItem(`${UNLINKED_CLOUD_BIZ_PREFIX}${safeBizId}`, 'true');
  } else {
    localStorage.removeItem(`${UNLINKED_CLOUD_BIZ_PREFIX}${safeBizId}`);
  }
}

/**
 * Safely checks whether auth.currentUser already owns or holds an ACTIVE membership
 * on businesses/{businessId} WITHOUT issuing an unauthorized getDoc(businesses/{businessId}).
 */
export async function hasVerifiedFirestoreAccessToBusiness(businessId: string): Promise<{
  hasAccess: boolean;
  via: 'ownerUid' | 'membership' | 'admin' | 'none';
  ownerUid?: string;
  role?: string;
}> {
  if (!auth.currentUser || !businessId || businessId === 'default_biz') {
    return { hasAccess: false, via: 'none' };
  }
  const safeBizId = sanitizeIdForFirestore(businessId, 'biz');
  const currentUid = auth.currentUser.uid;
  const currentEmail = (auth.currentUser.email || '').trim().toLowerCase();
  if (Boolean(auth.currentUser.emailVerified) && currentEmail === 'chiposhaconwell@gmail.com') {
    return { hasAccess: true, via: 'admin', role: 'owner' };
  }

  // 1. Check /businesses/{safeBizId}/memberships/{currentUid} (always permitted for currentUid)
  try {
    const memRef = doc(db, 'businesses', safeBizId, 'memberships', currentUid);
    const memSnap = await getDoc(memRef).catch(() => getDocFromCache(memRef).catch(() => null));
    if (memSnap && memSnap.exists()) {
      const m = memSnap.data();
      if (String(m.status || 'ACTIVE').toUpperCase() === 'ACTIVE' && String(m.memberUid || '') === currentUid) {
        setBusinessCloudUnlinkedFlag(safeBizId, false);
        return {
          hasAccess: true,
          via: 'membership',
          ownerUid: String(m.ownerUid || ''),
          role: String(m.role || ''),
        };
      }
    }
  } catch {}

  // 2. Check businesses owned directly by currentUid (always permitted by list rule)
  try {
    const ownedSnap = await getDocs(
      query(collection(db, 'businesses'), where('ownerUid', '==', currentUid))
    ).catch(() => null);
    if (ownedSnap && !ownedSnap.empty) {
      const match = ownedSnap.docs.find((d) => d.id === safeBizId);
      if (match) {
        setBusinessCloudUnlinkedFlag(safeBizId, false);
        return {
          hasAccess: true,
          via: 'ownerUid',
          ownerUid: currentUid,
          role: 'owner',
        };
      }
    }
  } catch {}

  return { hasAccess: false, via: 'none' };
}

/**
 * Automatically migrates a legacy Firebase Email/Password business owner to their new
 * credential-scoped identity (cred_<56hex>@mt-pos.auth) by creating a verified owner
 * membership + credential_directory entry under the legacy UID.
 */
export async function tryMigrateLegacyOwnerToCredentialAuth(params: {
  email: string;
  password: string;
  businessId: string;
  businessName?: string;
  fullName?: string;
  storeId?: string;
  userId?: string;
  permissionsJson?: string;
}): Promise<boolean> {
  const cleanEmail = normalizeAuthEmail(params.email);
  const rawPass = String(params.password || '').trim();
  const safeBizId = sanitizeIdForFirestore(params.businessId, 'biz');
  if (!cleanEmail || !rawPass || !safeBizId || safeBizId === 'default_biz') return false;

  const { credId, credHash, authEmail } = deriveFirebaseCredentialIdentity(cleanEmail, rawPass);
  const credUser =
    auth.currentUser && (auth.currentUser.email || '').toLowerCase() === authEmail.toLowerCase()
      ? auth.currentUser
      : await signInWithCredentialHash(credHash, params.fullName);
  const credUid = credUser?.uid || '';
  if (!credUid) return false;

  try {
    const legacyRes = await signInWithEmailAndPassword(
      auth,
      cleanEmail,
      normalizeFirebasePassword(rawPass)
    );
    const legacyUid = legacyRes.user.uid;
    const ownedSnap = await getDocs(
      query(collection(db, 'businesses'), where('ownerUid', '==', legacyUid))
    ).catch(() => null);
    const ownedDoc = ownedSnap?.docs?.find((d) => d.id === safeBizId);

    if (ownedDoc) {
      const bData = ownedDoc.data();
      const safeStoreId = sanitizeIdForFirestore(params.storeId || bData.store_id || 'main', 'store');
      const resolvedUserId = params.userId || deriveUserId(cleanEmail);
      const resolvedName = String(params.fullName || bData.owner || cleanEmail).slice(0, 200);
      const bizName = String(params.businessName || bData.name || safeBizId).slice(0, 200);

      await setDoc(doc(db, 'businesses', safeBizId, 'memberships', credUid), {
        id: credUid,
        business_id: safeBizId,
        store_id: safeStoreId,
        user_id: String(resolvedUserId).slice(0, 128),
        memberUid: credUid,
        ownerUid: legacyUid,
        cred_id: credId,
        email: cleanEmail.slice(0, 200),
        full_name: resolvedName,
        role: 'owner',
        accessible_branches: [],
        permissions_json: String(params.permissionsJson || '{}').slice(0, 8000),
        status: 'ACTIVE',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await setDoc(doc(db, 'credential_directory', credId), {
        id: credId,
        cred_id: credId,
        auth_email: authEmail.slice(0, 150),
        business_id: safeBizId,
        business_name: bizName,
        membership_id: credUid,
        user_id: String(resolvedUserId).slice(0, 128),
        ownerUid: legacyUid,
        memberUid: credUid,
        email: cleanEmail.slice(0, 200),
        full_name: resolvedName,
        role: 'owner',
        store_id: safeStoreId,
        accessible_branches: [],
        permissions_json: String(params.permissionsJson || '{}').slice(0, 8000),
        status: 'ACTIVE',
        updatedAt: serverTimestamp(),
      });

      setBusinessCloudUnlinkedFlag(safeBizId, false);
      await signInWithCredentialHash(credHash, resolvedName);
      return true;
    }
  } catch {
    // Legacy Firebase email/password account not found or does not match
  }

  await signInWithCredentialHash(credHash, params.fullName).catch(() => null);
  return false;
}

/**
 * Links currently unlocked owner workspaces to an authenticated Google / Admin Firebase account
 * by publishing /credential_directory/{credId}, then claims membership on the credential token.
 */
export async function linkOwnerWorkspacesWithCurrentFirebaseAdmin(
  workspaces: Array<{
    businessId: string;
    businessName: string;
    membershipId: string;
    userId: string;
    email: string;
    fullName: string;
    role: string;
    credentialHash: string;
    storeId: string;
    permissionsJson: string;
  }>
): Promise<{ linkedBusinesses: string[] }> {
  if (!auth.currentUser) return { linkedBusinesses: [] };
  const adminUid = auth.currentUser.uid;
  const linkedBusinesses: string[] = [];

  for (const ws of workspaces) {
    if (ws.role !== 'owner' || !ws.credentialHash || !ws.businessId) continue;
    const safeBizId = sanitizeIdForFirestore(ws.businessId, 'biz');
    const access = await hasVerifiedFirestoreAccessToBusiness(safeBizId);
    if (!access.hasAccess) continue;

    let parentOwnerUid = access.ownerUid || adminUid;
    try {
      const bizSnap = await getDoc(doc(db, 'businesses', safeBizId));
      if (bizSnap.exists()) {
        parentOwnerUid = String(bizSnap.data()?.ownerUid || parentOwnerUid);
      }
    } catch {}

    const credId = String(ws.credentialHash).slice(0, 56);
    if (!credId) continue;
    const authEmail = `cred_${credId}@mt-pos.auth`;
    const safeStoreId = sanitizeIdForFirestore(ws.storeId || 'main', 'store');

    try {
      const existingCredSnap = await getDoc(doc(db, 'credential_directory', credId)).catch(() => null);
      const resolvedCredOwnerUid = existingCredSnap?.exists()
        ? String(existingCredSnap.data()?.ownerUid || parentOwnerUid)
        : parentOwnerUid;

      await setDoc(doc(db, 'credential_directory', credId), {
        id: credId,
        cred_id: credId,
        auth_email: authEmail.slice(0, 150),
        business_id: safeBizId,
        business_name: String(ws.businessName || safeBizId).slice(0, 200),
        membership_id: sanitizeIdForFirestore(ws.membershipId || credId, 'mem'),
        user_id: String(ws.userId || deriveUserId(ws.email)).slice(0, 128),
        ownerUid: resolvedCredOwnerUid,
        memberUid: existingCredSnap?.exists() ? String(existingCredSnap.data()?.memberUid || '') : '',
        email: normalizeAuthEmail(ws.email).slice(0, 200),
        full_name: String(ws.fullName || ws.email).slice(0, 200),
        role: 'owner',
        store_id: safeStoreId,
        accessible_branches: [],
        permissions_json: String(ws.permissionsJson || '{}').slice(0, 8000),
        status: 'ACTIVE',
        updatedAt: serverTimestamp(),
      });
      setBusinessCloudUnlinkedFlag(safeBizId, false);
      linkedBusinesses.push(safeBizId);
    } catch (err) {
      console.warn(`Link workspace [${safeBizId}] notice:`, err);
    }
  }

  return { linkedBusinesses };
}

export async function publishCredentialMembershipToCloud(params: {
  businessId: string;
  businessName: string;
  membershipId: string;
  userId?: string;
  email: string;
  fullName: string;
  role: 'owner' | 'manager' | 'sales';
  password?: string;
  credentialHash?: string;
  storeId?: string;
  accessibleBranches?: string[];
  permissionsJson?: string;
  status?: 'ACTIVE' | 'SUSPENDED';
}): Promise<{ published: boolean; credId: string }> {
  if (!auth.currentUser) return { published: false, credId: '' };
  if (!isCurrentUserAuthorizedBusinessOwner(params.businessId)) {
    return { published: false, credId: '' };
  }

  const cleanEmail = normalizeAuthEmail(params.email);
  const resolvedCredHash =
    params.credentialHash ||
    (cleanEmail && params.password ? computeCredentialHashSync(cleanEmail, params.password) : '');
  const credId = resolvedCredHash.slice(0, 56);
  if (!cleanEmail || !credId) return { published: false, credId: '' };

  const safeBizId = sanitizeIdForFirestore(params.businessId, 'biz');
  const safeMemId = sanitizeIdForFirestore(params.membershipId || credId, 'mem');
  const resolvedUserId = params.userId || deriveUserId(cleanEmail);
  const safeStoreId = sanitizeIdForFirestore(params.storeId || getActiveStoreId(undefined, params.businessId) || 'main', 'store');
  const currentUid = auth.currentUser.uid;
  const safeBranches = (Array.isArray(params.accessibleBranches) ? params.accessibleBranches : [])
    .map((b) => String(b || '').trim().slice(0, 128))
    .filter(Boolean)
    .slice(0, 50);
  const safeStatus = params.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE';
  const safeRole = params.role === 'owner' || params.role === 'manager' ? params.role : 'sales';
  const authEmail = `cred_${credId}@mt-pos.auth`;
  const isOnline = await ensureFirestoreOnlineIfReachable();

  // Verify Firestore ownership/membership before writing so unlinked credentials don't throw permission errors
  const access = await hasVerifiedFirestoreAccessToBusiness(safeBizId);
  if (!access.hasAccess) {
    return { published: false, credId };
  }

  let parentOwnerUid = access.ownerUid || currentUid;
  try {
    const bizSnap = await getDoc(doc(db, 'businesses', safeBizId)).catch(() => null);
    if (bizSnap && bizSnap.exists()) {
      parentOwnerUid = String(bizSnap.data()?.ownerUid || parentOwnerUid);
    }
  } catch {}

  let existingMemberUid = '';
  let existingMemCreatedAt: any = null;
  let existingMemOwnerUid = parentOwnerUid;
  try {
    const existingMemSnap = await getDoc(doc(db, 'businesses', safeBizId, 'memberships', safeMemId));
    if (existingMemSnap.exists()) {
      const mData = existingMemSnap.data();
      existingMemberUid = String(mData.memberUid || '');
      existingMemCreatedAt = mData.createdAt || null;
      existingMemOwnerUid = String(mData.ownerUid || parentOwnerUid);
    }
  } catch {}

  let existingCredOwnerUid = parentOwnerUid;
  try {
    const existingCredSnap = await getDoc(doc(db, 'credential_directory', credId));
    if (existingCredSnap.exists()) {
      const cData = existingCredSnap.data();
      if (!existingMemberUid) existingMemberUid = String(cData.memberUid || '');
      existingCredOwnerUid = String(cData.ownerUid || parentOwnerUid);
    }
  } catch {}

  if (safeRole === 'owner' && cleanEmail === normalizeAuthEmail(localStorage.getItem('logged_in_user_email') || '') && authEmail === (auth.currentUser.email || '').toLowerCase() && !existingMemberUid) {
    existingMemberUid = currentUid;
  }

  const membershipPayload = {
    id: safeMemId,
    business_id: safeBizId,
    store_id: safeStoreId,
    user_id: String(resolvedUserId).slice(0, 128),
    memberUid: existingMemberUid.slice(0, 128),
    ownerUid: existingMemOwnerUid,
    cred_id: credId,
    email: cleanEmail.slice(0, 200),
    full_name: String(params.fullName || cleanEmail).slice(0, 200),
    role: safeRole,
    accessible_branches: safeBranches,
    permissions_json: String(params.permissionsJson || '{}').slice(0, 8000),
    status: safeStatus,
    createdAt: existingMemCreatedAt || serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await writeDocOfflineAware(
      doc(db, 'businesses', safeBizId, 'memberships', safeMemId),
      membershipPayload,
      `businesses/${safeBizId}/memberships/${safeMemId}`,
      isOnline
    );

    if (existingMemberUid && existingMemberUid !== safeMemId) {
      try {
        const claimedSnap = await getDoc(doc(db, 'businesses', safeBizId, 'memberships', existingMemberUid));
        if (claimedSnap.exists()) {
          await writeDocOfflineAware(
            doc(db, 'businesses', safeBizId, 'memberships', existingMemberUid),
            {
              ...membershipPayload,
              id: existingMemberUid,
              memberUid: existingMemberUid,
              ownerUid: String(claimedSnap.data()?.ownerUid || parentOwnerUid),
              createdAt: claimedSnap.data().createdAt || serverTimestamp(),
            },
            `businesses/${safeBizId}/memberships/${existingMemberUid}`,
            isOnline
          );
        }
      } catch {}
    }

    await writeDocOfflineAware(
      doc(db, 'credential_directory', credId),
      {
        id: credId,
        cred_id: credId,
        auth_email: authEmail.slice(0, 150),
        business_id: safeBizId,
        business_name: String(params.businessName || safeBizId).slice(0, 200),
        membership_id: safeMemId,
        user_id: String(resolvedUserId).slice(0, 128),
        ownerUid: existingCredOwnerUid,
        memberUid: existingMemberUid.slice(0, 128),
        email: cleanEmail.slice(0, 200),
        full_name: String(params.fullName || cleanEmail).slice(0, 200),
        role: safeRole,
        store_id: safeStoreId,
        accessible_branches: safeBranches,
        permissions_json: String(params.permissionsJson || '{}').slice(0, 8000),
        status: safeStatus,
        updatedAt: serverTimestamp(),
      },
      `credential_directory/${credId}`,
      isOnline
    );

    return { published: true, credId };
  } catch (err) {
    console.warn('Credential directory publish notice:', err);
    return { published: false, credId };
  }
}

export async function revokeCredentialMembershipInCloud(params: {
  businessId: string;
  membershipId?: string;
  email?: string;
  password?: string;
  credentialHash?: string;
}): Promise<void> {
  if (!auth.currentUser || !isCurrentUserAuthorizedBusinessOwner(params.businessId)) return;
  const safeBizId = sanitizeIdForFirestore(params.businessId, 'biz');
  const cleanEmail = normalizeAuthEmail(params.email || '');
  const credHash =
    params.credentialHash ||
    (cleanEmail && params.password ? computeCredentialHashSync(cleanEmail, params.password) : '');
  const credId = credHash.slice(0, 56);

  try {
    if (credId) {
      const credSnap = await getDoc(doc(db, 'credential_directory', credId)).catch(() => null);
      if (credSnap?.exists()) {
        const mUid = String(credSnap.data()?.memberUid || '').trim();
        if (mUid) {
          await deleteDoc(doc(db, 'businesses', safeBizId, 'memberships', mUid)).catch(() => {});
        }
      }
      await deleteDoc(doc(db, 'credential_directory', credId)).catch(() => {});
    }
    if (params.membershipId) {
      const safeMemId = sanitizeIdForFirestore(params.membershipId, 'mem');
      await deleteDoc(doc(db, 'businesses', safeBizId, 'memberships', safeMemId)).catch(() => {});
    }
  } catch (err) {
    console.warn('Revoke cloud membership notice:', err);
  }
}

export async function claimCredentialInviteAndRestore(
  email: string,
  password: string
): Promise<{
  found: boolean;
  suspended?: boolean;
  businessId?: string;
  businessName?: string;
  role?: 'owner' | 'manager' | 'sales';
  membershipId?: string;
  userId?: string;
  fullName?: string;
  storeId?: string;
  accessibleBranches?: string[];
  permissionsJson?: string;
}> {
  if (!auth.currentUser) return { found: false };
  const cleanEmail = normalizeAuthEmail(email);
  const credHash = computeCredentialHashSync(cleanEmail, password);
  const credId = credHash.slice(0, 56);
  const currentUid = auth.currentUser.uid;
  if (!credId) return { found: false };

  try {
    await ensureFirestoreOnlineIfReachable();
    const credRef = doc(db, 'credential_directory', credId);
    let credSnap: any = null;
    try {
      credSnap = await getDoc(credRef);
    } catch {
      credSnap = await getDocFromCache(credRef).catch(() => null);
    }

    if (credSnap && credSnap.exists()) {
      const inv = credSnap.data();
      const targetBizId = String(inv.business_id || '');
      const status = String(inv.status || 'ACTIVE').toUpperCase();
      if (status === 'SUSPENDED') {
        return {
          found: true,
          suspended: true,
          businessId: targetBizId,
          businessName: String(inv.business_name || ''),
        };
      }

      const role: 'owner' | 'manager' | 'sales' =
        inv.role === 'owner' || inv.role === 'manager' ? inv.role : 'sales';
      const safeBizId = sanitizeIdForFirestore(targetBizId, 'biz');
      const memDocRef = doc(db, 'businesses', safeBizId, 'memberships', currentUid);

      try {
        const existingClaimed = await getDoc(memDocRef).catch(() => null);
        const existingClaimData = existingClaimed?.exists() ? existingClaimed.data() : null;
        await setDoc(memDocRef, {
          id: currentUid,
          business_id: safeBizId,
          store_id: String(inv.store_id || 'main').slice(0, 128),
          user_id: String(existingClaimData?.user_id || inv.user_id || deriveUserId(cleanEmail)).slice(0, 128),
          memberUid: currentUid,
          ownerUid: String(existingClaimData?.ownerUid || inv.ownerUid || currentUid).slice(0, 128),
          cred_id: String(existingClaimData?.cred_id || credId),
          email: cleanEmail.slice(0, 200),
          full_name: String(inv.full_name || cleanEmail).slice(0, 200),
          role,
          accessible_branches: Array.isArray(inv.accessible_branches) ? inv.accessible_branches.slice(0, 50) : [],
          permissions_json: String(inv.permissions_json || '{}').slice(0, 8000),
          status: 'ACTIVE',
          createdAt: existingClaimData?.createdAt ? existingClaimData.createdAt : serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        await updateDoc(credRef, {
          memberUid: currentUid,
          updatedAt: serverTimestamp(),
        }).catch(() => {});
        setBusinessCloudUnlinkedFlag(safeBizId, false);
      } catch (claimErr) {
        console.warn('Firestore membership self-claim notice:', claimErr);
      }

      upsertUserAndMembership({
        businessId: safeBizId,
        email: cleanEmail,
        fullName: String(inv.full_name || cleanEmail),
        password,
        role,
        storeId: String(inv.store_id || 'main'),
        accessibleBranches: Array.isArray(inv.accessible_branches) ? inv.accessible_branches : [],
        permissionsJson: String(inv.permissions_json || '{}'),
        status: 'ACTIVE',
      });

      const accessCheck = await hasVerifiedFirestoreAccessToBusiness(safeBizId);
      if (accessCheck.hasAccess) {
        await restoreFromCloud(safeBizId, { silentIfUnlinked: true }).catch((e) =>
          console.warn('Cloud restore after invite claim notice:', e)
        );
      }

      return {
        found: true,
        suspended: false,
        businessId: safeBizId,
        businessName: String(inv.business_name || safeBizId),
        role,
        membershipId: String(inv.membership_id || deriveMembershipId(safeBizId, String(inv.user_id || deriveUserId(cleanEmail)), role)),
        userId: String(inv.user_id || deriveUserId(cleanEmail)),
        fullName: String(inv.full_name || cleanEmail),
        storeId: String(inv.store_id || 'main'),
        accessibleBranches: Array.isArray(inv.accessible_branches) ? inv.accessible_branches : [],
        permissionsJson: String(inv.permissions_json || '{}'),
      };
    }

    // Fallback: Check if user owns any Business directly under this credential-scoped UID
    const ownedSnap = await getDocs(query(collection(db, 'businesses'), where('ownerUid', '==', currentUid)));
    if (!ownedSnap.empty) {
      const bizDoc = ownedSnap.docs[0];
      const bizData = bizDoc.data();
      const targetBizId = bizDoc.id;
      await restoreFromCloud(targetBizId).catch(() => {});
      upsertUserAndMembership({
        businessId: targetBizId,
        email: cleanEmail,
        fullName: String(bizData.owner || 'Owner'),
        password,
        role: 'owner',
        storeId: String(bizData.store_id || 'main'),
        status: 'ACTIVE',
      });
      return {
        found: true,
        suspended: false,
        businessId: targetBizId,
        businessName: String(bizData.name || targetBizId),
        role: 'owner',
        userId: deriveUserId(cleanEmail),
        fullName: String(bizData.owner || 'Owner'),
        storeId: String(bizData.store_id || 'main'),
        accessibleBranches: [],
        permissionsJson: '{}',
      };
    }

    return { found: false };
  } catch (err) {
    console.warn('Credential invite lookup notice:', err);
    return { found: false };
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

  // Ensure all double-entry accounting ledgers & memberships are up to date before backing up
  syncAllAccountingSystems('Firebase Cloud Backup');
  syncUsersAndMembershipsFromLegacyTables(businessId);

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

  let settingsObj: any = null;
  try {
    const rawS =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(getScopedSettingsKey(businessId)) || localStorage.getItem('android_pos_settings')
        : null;
    if (rawS) settingsObj = JSON.parse(rawS);
  } catch {}

  const cleanName = String(biz.name || settingsObj?.storeName || 'POS Business').slice(0, 200);
  const cleanOwner = String(biz.owner || auth.currentUser.displayName || 'Owner').slice(0, 200);
  const cleanEmail = String(biz.email || (typeof localStorage !== 'undefined' ? localStorage.getItem('logged_in_user_email') : '') || auth.currentUser.email || 'owner@pos.app').slice(0, 200);
  const bizStoreId = sanitizeIdForFirestore(biz.store_id || primaryStoreId, 'store');

  const fullBizFields = {
    id: safeBizId,
    business_id: safeBizId,
    store_id: bizStoreId,
    name: cleanName,
    owner: cleanOwner,
    email: cleanEmail,
    currency: String(biz.currency || settingsObj?.currency || 'K').slice(0, 20),
    tax_rate: Math.max(0, parseFloat((biz.tax_rate ?? settingsObj?.taxRate) as any) || 0.0),
    tpin: String(biz.tpin || settingsObj?.tpin || '').slice(0, 100),
    billing_address: String(biz.billing_address || settingsObj?.billingAddress || '').slice(0, 500),
    billing_city: String(biz.billing_city || settingsObj?.billingCity || '').slice(0, 200),
    billing_country: String(biz.billing_country || settingsObj?.billingCountry || '').slice(0, 200),
    billing_phone: String(biz.billing_phone || biz.phone || settingsObj?.billingPhone || '').slice(0, 100),
    billing_email: String(biz.billing_email || settingsObj?.billingEmail || cleanEmail).slice(0, 200),
    admin_role: String(biz.admin_role || 'admin').slice(0, 50),
  };

  // Upsert primary Business document (preserving createdAt and parent ownerUid if already created; offline-safe via cache)
  const bizPath = `businesses/${safeBizId}`;
  const preAccess = isOnline ? await hasVerifiedFirestoreAccessToBusiness(safeBizId) : { hasAccess: false, via: 'none' as const };
  if (options?.silentIfNotOwner && !preAccess.hasAccess && isBusinessCloudMarkedUnlinked(safeBizId)) {
    return {
      success: false,
      details: 'Cloud Firestore workspace is owned by an earlier sign-in account. Link that owner account in Settings -> Cloud Sync to resume Firestore sync (data synced locally & Cloud SQL).',
    };
  }

  let resolvedParentOwnerUid = preAccess.ownerUid || currentUid;
  try {
    const bizRef = doc(db, 'businesses', safeBizId);
    let existingSnap: any = null;
    if (isOnline) {
      try {
        existingSnap = await getDoc(bizRef);
      } catch (readErr: any) {
        if (readErr?.code === 'permission-denied' || String(readErr?.message || '').toLowerCase().includes('insufficient permissions')) {
          setBusinessCloudUnlinkedFlag(safeBizId, true);
          if (options?.silentIfNotOwner) {
            return {
              success: false,
              details: 'Cloud Firestore workspace is owned by an earlier sign-in account (Google or legacy password). Link that owner account in Settings -> Cloud Sync to resume Firestore backup.',
            };
          }
          handleFirestoreError(readErr, OperationType.GET, bizPath);
        }
        existingSnap = await getDocFromCache(bizRef).catch(() => null);
      }
    } else {
      existingSnap = await getDocFromCache(bizRef).catch(() => null);
    }

    if (existingSnap && existingSnap.exists()) {
      const existingData = existingSnap.data();
      resolvedParentOwnerUid = String(existingData.ownerUid || resolvedParentOwnerUid);
      setBusinessCloudUnlinkedFlag(safeBizId, false);
      isOnline = await writeDocOfflineAware(
        bizRef,
        {
          ...fullBizFields,
          ownerUid: resolvedParentOwnerUid,
          createdAt: existingData.createdAt || serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        bizPath,
        isOnline
      );
    } else {
      resolvedParentOwnerUid = currentUid;
      isOnline = await writeDocOfflineAware(
        bizRef,
        {
          ...fullBizFields,
          ownerUid: currentUid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        bizPath,
        isOnline
      );
      setBusinessCloudUnlinkedFlag(safeBizId, false);
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

  // 1B. Backup complete Business Settings (receipt layout, logo, billing info, printer, custom payments, ZRA VSDC)
  let settingsSynced = false;
  const settingsDocPath = `businesses/${safeBizId}/settings/default`;
  let settingsOwnerUid = resolvedParentOwnerUid;
  if (isOnline && !isFirestoreNetworkDisabled) {
    try {
      const existingSettingsSnap = await getDoc(doc(db, 'businesses', safeBizId, 'settings', 'default')).catch(() => null);
      if (existingSettingsSnap && existingSettingsSnap.exists()) {
        settingsOwnerUid = String(existingSettingsSnap.data()?.ownerUid || resolvedParentOwnerUid);
      }
    } catch {}
  }
  const rawMethods =
    Array.isArray(settingsObj?.customPaymentMethods) && settingsObj.customPaymentMethods.length > 0
      ? settingsObj.customPaymentMethods
      : getCustomPaymentMethods(true);
  const safeCustomPaymentMethods = (Array.isArray(rawMethods) ? rawMethods : []).slice(0, 50).map(sanitizeRecordMap);
  const rawZraConfig =
    settingsObj?.zraConfig && typeof settingsObj.zraConfig === 'object' ? settingsObj.zraConfig : getZraConfig();
  const safeZraConfig = sanitizeRecordMap(rawZraConfig);

  const normalizedSettingsPayload = {
    id: 'default',
    business_id: safeBizId,
    store_id: primaryStoreId,
    ownerUid: settingsOwnerUid,
    storeName: String(settingsObj?.storeName || cleanName).slice(0, 200),
    currency: String(settingsObj?.currency || fullBizFields.currency || 'K').slice(0, 20),
    taxRate: Math.max(0, parseFloat((settingsObj?.taxRate ?? fullBizFields.tax_rate) as any) || 0.0),
    loyaltyRatio: Math.max(0, parseFloat(settingsObj?.loyaltyRatio as any) || 0.0),
    receiptHeader: String(settingsObj?.receiptHeader || '').slice(0, 1000),
    receiptFooter: String(settingsObj?.receiptFooter || '').slice(0, 1000),
    paperWidth: String(settingsObj?.paperWidth || '58mm').slice(0, 20),
    logoUrl: String(settingsObj?.logoUrl || '').slice(0, 290000),
    tpin: String(settingsObj?.tpin || fullBizFields.tpin || '').slice(0, 100),
    billingAddress: String(settingsObj?.billingAddress || fullBizFields.billing_address || '').slice(0, 500),
    billingCity: String(settingsObj?.billingCity || fullBizFields.billing_city || '').slice(0, 200),
    billingCountry: String(settingsObj?.billingCountry || fullBizFields.billing_country || '').slice(0, 200),
    billingPhone: String(settingsObj?.billingPhone || fullBizFields.billing_phone || '').slice(0, 100),
    billingEmail: String(settingsObj?.billingEmail || fullBizFields.billing_email || cleanEmail).slice(0, 200),
    termsAndConditions: String(settingsObj?.termsAndConditions || '').slice(0, 4000),
    printerName: String(settingsObj?.printerName || '').slice(0, 200),
    printerInterface: String(settingsObj?.printerInterface || '').slice(0, 100),
    printerStatus: String(settingsObj?.printerStatus || 'Not Linked').slice(0, 100),
    customPaymentMethods: safeCustomPaymentMethods,
    zraConfig: safeZraConfig,
    updatedAt: serverTimestamp(),
  };

  try {
    isOnline = await writeDocOfflineAware(
      doc(db, 'businesses', safeBizId, 'settings', 'default'),
      normalizedSettingsPayload,
      settingsDocPath,
      isOnline
    );
    settingsSynced = true;
  } catch (err: any) {
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      await setFirestoreOfflineMode();
      isOnline = false;
    } else if (isOnline) {
      handleFirestoreError(err, OperationType.WRITE, settingsDocPath);
    }
  }

  // 1C. Publish decoupled memberships & zero-plaintext credential directory entries for this business
  const memRowsRes = runSql(
    `SELECT * FROM business_memberships WHERE business_id = '${cleanBizId}'`,
    'Cloud Sync: Read business_memberships',
    true
  );
  const memRows = memRowsRes.success && Array.isArray(memRowsRes.data) ? memRowsRes.data : [];
  for (const mem of memRows) {
    let parsedBranches: string[] = [];
    try {
      const bParsed = typeof mem.accessible_branches === 'string'
        ? JSON.parse(mem.accessible_branches)
        : mem.accessible_branches;
      if (Array.isArray(bParsed)) parsedBranches = bParsed;
    } catch {}
    await publishCredentialMembershipToCloud({
      businessId: safeBizId,
      businessName: cleanName,
      membershipId: String(mem.id || ''),
      userId: String(mem.user_id || ''),
      email: String(mem.email || ''),
      fullName: String(mem.full_name || mem.email || 'Member'),
      role: (mem.role === 'owner' || mem.role === 'manager' ? mem.role : 'sales'),
      password: String(mem.password || ''),
      credentialHash: String(mem.credential_hash || ''),
      storeId: String(mem.store_id || primaryStoreId),
      accessibleBranches: parsedBranches,
      permissionsJson: String(mem.permissions_json || '{}'),
      status: String(mem.status || 'ACTIVE').toUpperCase() === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
    });
  }

  // Preload existing remote subcollection ownerUid maps so co-owners / migrated owners preserve immutable ownerUid on updates
  const fetchExistingOwnerMap = async (subcol: string): Promise<Map<string, { ref: any; ownerUid: string }>> => {
    const map = new Map<string, { ref: any; ownerUid: string }>();
    if (!isOnline || isFirestoreNetworkDisabled) return map;
    try {
      const snap = await getDocs(
        query(collection(db, 'businesses', safeBizId, subcol), where('business_id', '==', safeBizId))
      );
      snap.docs.forEach((d) => {
        map.set(d.id, { ref: d.ref, ownerUid: String(d.data()?.ownerUid || resolvedParentOwnerUid) });
      });
    } catch {}
    return map;
  };

  let totalStoresSynced = 0;
  let totalProductsSynced = 0;
  let totalStoreProductsSynced = 0;
  let totalCustomersSynced = 0;
  let totalOrdersSynced = 0;
  let totalOrderItemsSynced = 0;
  let totalLedgersSynced = 0;

  // 2. Fetch and backup Store outlets strictly scoped to this business_id
  const existingStoresMap = await fetchExistingOwnerMap('stores');
  const storesRes = runSql(
    `SELECT * FROM stores WHERE business_id = '${cleanBizId}'`,
    'Cloud Sync: Fetch local stores',
    true
  );
  const storeRows = storesRes.success && Array.isArray(storesRes.data) ? storesRes.data : [];
  const activeStoreDocIds = new Set<string>();
  for (const store of storeRows) {
    const safeStoreId = sanitizeIdForFirestore(store.id, 'store');
    activeStoreDocIds.add(safeStoreId);
    const storePath = `businesses/${safeBizId}/stores/${safeStoreId}`;
    const storeOwnerUid = existingStoresMap.get(safeStoreId)?.ownerUid || resolvedParentOwnerUid;
    try {
      isOnline = await writeDocOfflineAware(
        doc(db, 'businesses', safeBizId, 'stores', safeStoreId),
        {
          id: safeStoreId,
          business_id: safeBizId,
          store_id: safeStoreId,
          ownerUid: storeOwnerUid,
          name: String(store.name || safeStoreId).slice(0, 200),
          location: String(store.location || 'Main').slice(0, 200),
          phone: String(store.phone || '').slice(0, 100),
          email: String(store.email || '').slice(0, 200),
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
  if (isOnline && !isFirestoreNetworkDisabled) {
    for (const [remoteId, entry] of existingStoresMap.entries()) {
      if (!activeStoreDocIds.has(remoteId)) {
        await deleteDoc(entry.ref).catch(() => {});
      }
    }
  }

  // 3. Fetch and backup Products strictly scoped to this business_id
  const existingProductsMap = await fetchExistingOwnerMap('products');
  const productsRes = runSql(
    `SELECT * FROM products WHERE business_id = '${cleanBizId}'`,
    'Cloud Sync: Fetch local products',
    true
  );
  const productRows = productsRes.success && Array.isArray(productsRes.data) ? productsRes.data : [];
  const activeProductDocIds = new Set<string>();
  for (const prod of productRows) {
    const prodIdNum = parseInt(prod.id as any, 10) || 1;
    const prodDocId = sanitizeIdForFirestore(prodIdNum, 'prod');
    activeProductDocIds.add(prodDocId);
    const prodPath = `businesses/${safeBizId}/products/${prodDocId}`;
    const prodStoreId = sanitizeIdForFirestore(prod.store_id || storeRows[0]?.id || primaryStoreId, 'store');
    const prodOwnerUid = existingProductsMap.get(prodDocId)?.ownerUid || resolvedParentOwnerUid;
    try {
      isOnline = await writeDocOfflineAware(
        doc(db, 'businesses', safeBizId, 'products', prodDocId),
        {
          id: prodIdNum,
          business_id: safeBizId,
          store_id: prodStoreId,
          ownerUid: prodOwnerUid,
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
          item_cls_cd: String(prod.item_cls_cd || '').slice(0, 100),
          tax_ty_cd: String(prod.tax_ty_cd || 'A').slice(0, 50),
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
  if (isOnline && !isFirestoreNetworkDisabled) {
    for (const [remoteId, entry] of existingProductsMap.entries()) {
      if (!activeProductDocIds.has(remoteId)) {
        await deleteDoc(entry.ref).catch(() => {});
      }
    }
  }

  // 3B. Fetch and backup all Per-Branch Stocks (store_products) strictly scoped to this business_id
  const existingSpMap = await fetchExistingOwnerMap('store_products');
  const storeProductsRes = runSql(
    `SELECT * FROM store_products WHERE business_id = '${cleanBizId}'`,
    'Cloud Sync: Fetch local branch stocks',
    true
  );
  const storeProductRows =
    storeProductsRes.success && Array.isArray(storeProductsRes.data) ? storeProductsRes.data : [];
  const activeSpDocIds = new Set<string>();
  for (const sp of storeProductRows) {
    const prodIdNum = parseInt(sp.product_id as any, 10) || 0;
    const spStoreId = sanitizeIdForFirestore(sp.store_id || storeRows[0]?.id || primaryStoreId, 'store');
    const spDocId = sanitizeIdForFirestore(sp.id || `sp_${prodIdNum}_${spStoreId}`, 'sp');
    activeSpDocIds.add(spDocId);
    const spPath = `businesses/${safeBizId}/store_products/${spDocId}`;
    const spOwnerUid = existingSpMap.get(spDocId)?.ownerUid || currentUid;
    try {
      isOnline = await writeDocOfflineAware(
        doc(db, 'businesses', safeBizId, 'store_products', spDocId),
        {
          id: spDocId,
          product_id: prodIdNum,
          business_id: safeBizId,
          store_id: spStoreId,
          ownerUid: spOwnerUid,
          stock: parseInt(sp.stock as any, 10) || 0,
          price: Math.max(0, parseFloat(sp.price as any) || 0.0),
          updatedAt: serverTimestamp(),
        },
        spPath,
        isOnline
      );
      totalStoreProductsSynced++;
    } catch (err: any) {
      if (isNetworkOrOfflineAuthError(err)) {
        lastAuthNetworkFailureAt = Date.now();
        await setFirestoreOfflineMode();
        isOnline = false;
      } else if (isOnline) {
        handleFirestoreError(err, OperationType.WRITE, spPath);
      }
    }
  }
  if (isOnline && !isFirestoreNetworkDisabled) {
    for (const [remoteId, entry] of existingSpMap.entries()) {
      if (!activeSpDocIds.has(remoteId)) {
        await deleteDoc(entry.ref).catch(() => {});
      }
    }
  }

  // 4. Fetch and backup Clients strictly scoped to this business_id
  const existingCustMap = await fetchExistingOwnerMap('customers');
  const customersRes = runSql(
    `SELECT * FROM customers WHERE business_id = '${cleanBizId}'`,
    'Cloud Sync: Fetch local customers',
    true
  );
  const customerRows = customersRes.success && Array.isArray(customersRes.data) ? customersRes.data : [];
  const activeCustomerDocIds = new Set<string>();
  for (const cust of customerRows) {
    const custIdNum = parseInt(cust.id as any, 10) || 1;
    const custDocId = sanitizeIdForFirestore(custIdNum, 'cust');
    activeCustomerDocIds.add(custDocId);
    const custPath = `businesses/${safeBizId}/customers/${custDocId}`;
    const custStoreId = sanitizeIdForFirestore(cust.store_id || storeRows[0]?.id || primaryStoreId, 'store');
    const custOwnerUid = existingCustMap.get(custDocId)?.ownerUid || currentUid;
    try {
      isOnline = await writeDocOfflineAware(
        doc(db, 'businesses', safeBizId, 'customers', custDocId),
        {
          id: custIdNum,
          business_id: safeBizId,
          store_id: custStoreId,
          ownerUid: custOwnerUid,
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
  if (isOnline && !isFirestoreNetworkDisabled) {
    for (const [remoteId, entry] of existingCustMap.entries()) {
      if (!activeCustomerDocIds.has(remoteId)) {
        await deleteDoc(entry.ref).catch(() => {});
      }
    }
  }

  // 5. Fetch and backup Orders strictly scoped to this business_id
  const existingOrdersMap = await fetchExistingOwnerMap('orders');
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
    const orderOwnerUid = existingOrdersMap.get(safeOrderId)?.ownerUid || currentUid;
    try {
      isOnline = await writeDocOfflineAware(
        doc(db, 'businesses', safeBizId, 'orders', safeOrderId),
        {
          id: safeOrderId,
          business_id: safeBizId,
          store_id: orderStoreId,
          ownerUid: orderOwnerUid,
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
  const existingItemsMap = await fetchExistingOwnerMap('order_items');
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
    const itemOwnerUid = existingItemsMap.get(safeItemId)?.ownerUid || currentUid;
    try {
      isOnline = await writeDocOfflineAware(
        doc(db, 'businesses', safeBizId, 'order_items', safeItemId),
        {
          id: safeItemId,
          business_id: safeBizId,
          store_id: itemStoreId,
          ownerUid: itemOwnerUid,
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

  // 7. Fetch and backup ALL remaining operational, inventory, HR & double-entry ledgers strictly scoped to business_id
  const existingLedgersMap = await fetchExistingOwnerMap('ledgers');
  const dedicatedTables = new Set([
    'businesses',
    'stores',
    'products',
    'customers',
    'orders',
    'order_items',
  ]);
  const ledgerTablesToSync = ALL_TABLE_NAMES.filter((t) => !dedicatedTables.has(t));

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

    const boundedRecords = rawRows.slice(-500).map(sanitizeRecordMap);
    const ledgerDocId = sanitizeIdForFirestore(tableName, 'ledger');
    const ledgerPath = `businesses/${safeBizId}/ledgers/${ledgerDocId}`;
    const ledgerOwnerUid = existingLedgersMap.get(ledgerDocId)?.ownerUid || resolvedParentOwnerUid;

    try {
      isOnline = await writeDocOfflineAware(
        doc(db, 'businesses', safeBizId, 'ledgers', ledgerDocId),
        {
          id: ledgerDocId,
          business_id: safeBizId,
          store_id: primaryStoreId,
          ownerUid: ledgerOwnerUid,
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

  // 8. When online, also upload default archive backups to Firebase Cloud Storage
  const storageResult =
    isOnline && !isFirestoreNetworkDisabled
      ? await backupClientsAndTransactionsToStorage(safeBizId, {
          business: { ...biz, ...fullBizFields },
          stores: storeRows,
          products: productRows,
          customers: customerRows,
          laybys: ledgerMapForStorage['laybys'] || [],
          laybyInstallments: ledgerMapForStorage['layby_installments'] || [],
          quotations: ledgerMapForStorage['quotations'] || [],
          orders: orderRows,
          orderItems: orderItemRows,
          ledgers: ledgerMapForStorage,
          settings: settingsObj || normalizedSettingsPayload,
        })
      : { storageSynced: false, filesUploaded: [] };

  const storageNote = storageResult.storageSynced
    ? ` + Firebase Storage (${storageResult.filesUploaded.length} archive files)`
    : !isOnline || isFirestoreNetworkDisabled
    ? ' (queued offline in Firestore IndexedDB — will auto-sync on reconnect)'
    : '';

  return {
    success: true,
    details: `Backed up to Cloud Firestore${storageNote}: ${settingsSynced ? 'settings & profile, ' : ''}${totalStoresSynced} branches, ${totalProductsSynced} catalog items (${totalStoreProductsSynced} branch stock records), ${totalCustomersSynced} clients, ${totalOrdersSynced} transactions (${totalOrderItemsSynced} line items), and ${totalLedgersSynced} operational ledgers.`,
  };
}

// ============================================================================
// CLOUD RESTORE (Firestore -> AlaSQL Local, with Firebase Storage archive supplement)
// ============================================================================
export async function restoreFromCloud(
  businessId?: string,
  options?: { silentIfUnlinked?: boolean }
): Promise<{ success: boolean; details: string }> {
  if (!auth.currentUser) {
    throw new Error('You must be signed in (Email/Password or Google) to restore from Firebase Cloud.');
  }

  const isOnline = await ensureFirestoreOnlineIfReachable();
  const currentUid = auth.currentUser.uid;
  let targetBizId = businessId && businessId !== 'default_biz' ? sanitizeIdForFirestore(businessId, 'biz') : '';
  let bizData: any = null;

  // 1. Verify permission via memberships/{uid} or ownerUid query BEFORE calling getDoc(businesses/{targetBizId})
  if (targetBizId) {
    const access = await hasVerifiedFirestoreAccessToBusiness(targetBizId);
    if (access.hasAccess) {
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
    } else if (options?.silentIfUnlinked) {
      return {
        success: false,
        details: 'No Cloud Firestore membership or ownership linked to this credential yet.',
      };
    }
  }

  if (!bizData) {
    const bizListPath = 'businesses';
    try {
      const q = query(collection(db, 'businesses'), where('ownerUid', '==', currentUid));
      const qSnap = await getDocs(q);
      if (!qSnap.empty) {
        const matchedDoc = targetBizId ? qSnap.docs.find((d) => d.id === targetBizId) : qSnap.docs[0];
        if (matchedDoc) {
          targetBizId = matchedDoc.id;
          bizData = matchedDoc.data();
        }
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
    const msg = !isOnline
      ? 'No offline cached business backup found while offline.'
      : 'No business backup found in Cloud Firestore linked to this sign-in credential yet.';
    if (options?.silentIfUnlinked) {
      return { success: false, details: msg };
    }
    throw new Error(msg);
  }

  // Preserve any existing local password on this device so password checks don't get overwritten unnecessarily
  const existingLocalBizRes = runSql(
    `SELECT password FROM businesses WHERE id = '${sqlEsc(targetBizId)}'`,
    'Restore: Check local business password',
    true
  );
  const existingPassword =
    existingLocalBizRes.success &&
    Array.isArray(existingLocalBizRes.data) &&
    existingLocalBizRes.data[0]?.password &&
    existingLocalBizRes.data[0].password !== 'cloud_recovered'
      ? String(existingLocalBizRes.data[0].password)
      : 'cloud_recovered';

  // Save/Restore full local Business Profile
  runSql(`DELETE FROM businesses WHERE id = '${sqlEsc(targetBizId)}'`, 'Restore: Clean old business row', true);
  const restoredPrimaryStoreId = sanitizeIdForFirestore(bizData.store_id || 'main', 'store');
  runSql(
    `INSERT INTO businesses (
      id, name, owner, email, password,
      billing_address, billing_city, billing_country, billing_phone, billing_email,
      tpin, currency, tax_rate, admin_role, created_at, business_id, store_id
    ) VALUES (
      '${sqlEsc(targetBizId)}',
      '${sqlEsc(bizData.name || 'Business')}',
      '${sqlEsc(bizData.owner || 'Owner')}',
      '${sqlEsc(bizData.email || auth.currentUser.email || '')}',
      '${sqlEsc(existingPassword)}',
      '${sqlEsc(bizData.billing_address || '')}',
      '${sqlEsc(bizData.billing_city || '')}',
      '${sqlEsc(bizData.billing_country || '')}',
      '${sqlEsc(bizData.billing_phone || '')}',
      '${sqlEsc(bizData.billing_email || bizData.email || '')}',
      '${sqlEsc(bizData.tpin || '')}',
      '${sqlEsc(bizData.currency || 'K')}',
      ${Number.isFinite(Number(bizData.tax_rate)) ? Number(bizData.tax_rate) : 0},
      '${sqlEsc(bizData.admin_role || 'admin')}',
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

  let settingsRestoredFromFirestore = false;
  let totalStoresRestored = 0;
  let totalProductsRestored = 0;
  let totalStoreProductsRestored = 0;
  let totalCustomersRestored = 0;
  let totalOrdersRestored = 0;
  let totalOrderItemsRestored = 0;
  let totalLedgersRestored = 0;

  // 1B. Restore Business Settings from Firestore subcollection
  const settingsPath = `businesses/${targetBizId}/settings/default`;
  try {
    let settingsSnap: any = null;
    try {
      settingsSnap = await getDoc(doc(db, 'businesses', targetBizId, 'settings', 'default'));
    } catch (err: any) {
      if (isNetworkOrOfflineAuthError(err)) {
        lastAuthNetworkFailureAt = Date.now();
        await setFirestoreOfflineMode();
        settingsSnap = await getDocFromCache(doc(db, 'businesses', targetBizId, 'settings', 'default')).catch(() => null);
      } else {
        handleFirestoreError(err, OperationType.GET, settingsPath);
      }
    }

    if (settingsSnap && settingsSnap.exists()) {
      const s = settingsSnap.data();
      let restoredZra: any = undefined;
      if (s.zraConfig && typeof s.zraConfig === 'object') {
        restoredZra = switchZraConfigForBusiness(targetBizId, s.zraConfig);
      }
      const restoredCustomMethods = Array.isArray(s.customPaymentMethods) ? s.customPaymentMethods : undefined;
      const restoredSettingsObj = {
        storeName: String(s.storeName || bizData.name || ''),
        currency: String(s.currency || bizData.currency || 'K'),
        taxRate: Number.isFinite(Number(s.taxRate)) ? Number(s.taxRate) : Number(bizData.tax_rate || 0),
        loyaltyRatio: Number.isFinite(Number(s.loyaltyRatio)) ? Number(s.loyaltyRatio) : 0,
        receiptHeader: String(s.receiptHeader || ''),
        receiptFooter: String(s.receiptFooter || ''),
        paperWidth: (s.paperWidth === '80mm' ? '80mm' : '58mm') as '58mm' | '80mm',
        logoUrl: String(s.logoUrl || ''),
        tpin: String(s.tpin || bizData.tpin || ''),
        billingAddress: String(s.billingAddress || bizData.billing_address || ''),
        billingCity: String(s.billingCity || bizData.billing_city || ''),
        billingCountry: String(s.billingCountry || bizData.billing_country || ''),
        billingPhone: String(s.billingPhone || bizData.billing_phone || ''),
        billingEmail: String(s.billingEmail || bizData.billing_email || bizData.email || ''),
        termsAndConditions: String(s.termsAndConditions || ''),
        printerName: String(s.printerName || ''),
        printerInterface: String(s.printerInterface || ''),
        printerStatus: (s.printerStatus === 'Linked' ? 'Linked' : 'Not Linked') as 'Linked' | 'Not Linked',
        customPaymentMethods: restoredCustomMethods,
        zraConfig: restoredZra,
      };
      saveScopedBusinessSettings(targetBizId, restoredSettingsObj);
      if (restoredCustomMethods && restoredCustomMethods.length > 0) {
        rehydrateAlasqlFromRecords(
          { payment_methods: restoredCustomMethods },
          { businessId: targetBizId, storeId: restoredPrimaryStoreId, preserveOtherBusinesses: true }
        );
      }
      settingsRestoredFromFirestore = true;
    }
  } catch (err: any) {
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      await setFirestoreOfflineMode();
    } else {
      handleFirestoreError(err, OperationType.GET, settingsPath);
    }
  }

  // 2. Pull Store outlets (member-authorized business_id filter for strict tenant isolation)
  const storesPath = `businesses/${targetBizId}/stores`;
  try {
    const sSnap = await getDocs(
      query(
        collection(db, 'businesses', targetBizId, 'stores'),
        where('business_id', '==', targetBizId)
      )
    );
    if (!sSnap.empty) {
      runSql(`DELETE FROM stores WHERE business_id = '${sqlEsc(targetBizId)}'`, 'Restore: Clean old stores', true);
      sSnap.forEach((docSnap) => {
        const d = docSnap.data();
        runSql(
          `INSERT INTO stores (id, business_id, name, location, phone, email, allow_discounts, allow_refunds, allow_laybys, require_manager_discount, store_id) VALUES (
            '${sqlEsc(docSnap.id)}',
            '${sqlEsc(targetBizId)}',
            '${sqlEsc(d.name || docSnap.id)}',
            '${sqlEsc(d.location || 'Main')}',
            '${sqlEsc(d.phone || '')}',
            '${sqlEsc(d.email || '')}',
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
        const cleanClsCd = d.item_cls_cd ? sqlEsc(d.item_cls_cd) : '';
        const cleanTaxTyCd = d.tax_ty_cd ? sqlEsc(d.tax_ty_cd) : 'A';
        const cleanStore = sqlEsc(d.store_id || restoredPrimaryStoreId);
        runSql(
          `INSERT INTO products (id, name, description, sku, category, price, cost, stock, imageUrl, business_id, is_service, batch_number, expiry_date, store_id, item_cls_cd, tax_ty_cd) VALUES (
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
            '${cleanStore}',
            '${cleanClsCd}',
            '${cleanTaxTyCd}'
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

  // 3B. Pull Per-Branch Store Stock Levels (store_products subcollection)
  const storeProductsPath = `businesses/${targetBizId}/store_products`;
  try {
    const spSnap = await getDocs(
      query(
        collection(db, 'businesses', targetBizId, 'store_products'),
        where('business_id', '==', targetBizId)
      )
    );
    if (!spSnap.empty) {
      runSql(
        `DELETE FROM store_products WHERE business_id = '${sqlEsc(targetBizId)}'`,
        'Restore: Clean old branch stocks',
        true
      );
      spSnap.forEach((docSnap) => {
        const d = docSnap.data();
        const prodIdNum = parseInt(d.product_id as any, 10) || 0;
        const spStoreId = sqlEsc(d.store_id || restoredPrimaryStoreId);
        const spId = sqlEsc(d.id || docSnap.id || `sp_${prodIdNum}_${spStoreId}`);
        runSql(
          `INSERT INTO store_products (id, product_id, store_id, stock, price, business_id) VALUES (
            '${spId}',
            ${prodIdNum},
            '${spStoreId}',
            ${parseInt(d.stock as any, 10) || 0},
            ${parseFloat(d.price as any) || 0.0},
            '${sqlEsc(targetBizId)}'
          )`,
          'Restore: Sink per-branch stock quantities',
          true
        );
        totalStoreProductsRestored++;
      });
    }
  } catch (err: any) {
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      await setFirestoreOfflineMode();
    } else {
      handleFirestoreError(err, OperationType.LIST, storeProductsPath);
    }
  }

  // 4. Pull Client CRM list
  const customersPath = `businesses/${targetBizId}/customers`;
  try {
    const cSnap = await getDocs(
      query(
        collection(db, 'businesses', targetBizId, 'customers'),
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

  // 7. Pull Operational & Accounting Ledgers (including quotations, stock_transfers, stock_takes, expenses, staff)
  const ledgersPath = `businesses/${targetBizId}/ledgers`;
  try {
    const lSnap = await getDocs(
      query(
        collection(db, 'businesses', targetBizId, 'ledgers'),
        where('business_id', '==', targetBizId)
      )
    );
    if (!lSnap.empty) {
      const restoredLedgers: Record<string, any[]> = {};
      lSnap.forEach((docSnap) => {
        const d = docSnap.data();
        const tableName = String(d.ledger_type || docSnap.id);
        if (tableName === 'store_products' && totalStoreProductsRestored > 0) {
          return;
        }
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

  // 8. When online, also check Firebase Cloud Storage archive for full untruncated quotations & fallback settings
  if (isOnline && !isFirestoreNetworkDisabled) {
    try {
      const clientsRef = storageRef(storage, `backups/${targetBizId}/clients_data.json`);
      const cBytes = await getBytes(clientsRef);
      const cText = new TextDecoder().decode(cBytes);
      const cParsed = JSON.parse(cText);
      if (cParsed?.clients && Array.isArray(cParsed.clients.quotations) && cParsed.clients.quotations.length > 0) {
        rehydrateAlasqlFromRecords(
          { quotations: cParsed.clients.quotations },
          { businessId: targetBizId, storeId: restoredPrimaryStoreId, preserveOtherBusinesses: true }
        );
      }
    } catch {
      // Clients archive optional
    }

    try {
      const fullRef = storageRef(storage, `backups/${targetBizId}/full_workspace_backup.json`);
      const bytes = await getBytes(fullRef);
      const text = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(text);
      if (!settingsRestoredFromFirestore && parsed && parsed.settings) {
        saveScopedBusinessSettings(targetBizId, parsed.settings);
        if (parsed.settings.zraConfig) {
          switchZraConfigForBusiness(targetBizId, parsed.settings.zraConfig);
        }
      }
      if (Array.isArray(parsed?.quotations) && parsed.quotations.length > 0) {
        rehydrateAlasqlFromRecords(
          { quotations: parsed.quotations },
          { businessId: targetBizId, storeId: restoredPrimaryStoreId, preserveOtherBusinesses: true }
        );
      }
    } catch {
      // Storage archive optional on restore if Firestore succeeded
    }
  }

  syncUsersAndMembershipsFromLegacyTables(targetBizId);
  syncAllAccountingSystems('Firebase Cloud Restore');
  persistTablesToStorage(true);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('local_db_restored'));
    window.dispatchEvent(new Event('pos_data_updated'));
  }

  return {
    success: true,
    details: `Restored from Cloud Firestore [${bizData.name}]: ${settingsRestoredFromFirestore ? 'settings & profile, ' : ''}${totalStoresRestored} branches, ${totalProductsRestored} catalog items (${totalStoreProductsRestored} branch stock records), ${totalCustomersRestored} clients, ${totalOrdersRestored} transactions (${totalOrderItemsRestored} line items), and ${totalLedgersRestored} operational ledgers.`,
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
      if (
        targetBizId &&
        targetBizId !== 'default_biz' &&
        isCurrentUserAuthorizedBusinessOwner(targetBizId) &&
        !isBusinessCloudMarkedUnlinked(targetBizId)
      ) {
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
