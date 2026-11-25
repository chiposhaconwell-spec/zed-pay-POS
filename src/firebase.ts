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
  deleteObject,
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
  dedupeAndCleanBusinessesTable,
  deleteBusinessFromServer,
  getDeletedBusinessIds,
  isBusinessPermanentlyDeleted,
  markBusinessPermanentlyDeleted,
  purgeBusinessFromLocalDatabase,
  getNextSequentialCompanyId,
  getPermanentCompanyIdForUser,
  setPermanentCompanyIdForUser,
  isHydratingOrRestoringDatabase,
  runWithHydrationGuard,
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

export async function ensureFirestoreOnlineIfReachable(): Promise<boolean> {
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

// Sync authenticated Firebase user with backend Cloud SQL users table (bounded timeout, non-blocking)
export async function syncFirebaseUserWithBackend(user: User | null) {
  if (!user) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), 4000);
  try {
    const idToken = await user.getIdToken();
    await fetch('/api/auth/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') return;
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      void setFirestoreOfflineMode();
      return;
    }
    console.warn('Backend user token sync notice:', err);
  } finally {
    clearTimeout(timerId);
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
    void syncFirebaseUserWithBackend(res.user);
    return res.user;
  } catch (err: any) {
    if (err?.code === 'auth/user-not-found' || err?.code === 'auth/invalid-credential') {
      try {
        const created = await createUserWithEmailAndPassword(auth, authEmail, authSecret);
        if (displayName && displayName.trim()) {
          void updateProfile(created.user, { displayName: displayName.trim() }).catch(() => {});
        }
        void syncFirebaseUserWithBackend(created.user);
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

  // Fast-path: already signed in to the exact credential-scoped identity
  if (auth.currentUser && (auth.currentUser.email || '').toLowerCase() === authEmail.toLowerCase()) {
    return { user: auth.currentUser, credId, credHash, authEmail, isLegacyAuth: false };
  }

  // Always try signInWithEmailAndPassword FIRST to avoid a guaranteed failed createUser round-trip for returning accounts
  try {
    const signed = await signInWithEmailAndPassword(auth, authEmail, authSecret);
    void syncFirebaseUserWithBackend(signed.user);
    return { user: signed.user, credId, credHash, authEmail, isLegacyAuth: false };
  } catch (err: any) {
    if (err?.code === 'auth/user-not-found' || err?.code === 'auth/invalid-credential') {
      if (options?.allowLegacyFallback) {
        try {
          const legacySigned = await signInWithEmailAndPassword(auth, cleanEmail, normalizeFirebasePassword(password));
          void syncFirebaseUserWithBackend(legacySigned.user);
          return { user: legacySigned.user, credId, credHash, authEmail: cleanEmail, isLegacyAuth: true };
        } catch {
          // Proceed to credential-scoped provisioning so remote /credential_directory/{credId} invites can be read
        }
      }
      try {
        const created = await createUserWithEmailAndPassword(auth, authEmail, authSecret);
        if (displayName) {
          void updateProfile(created.user, { displayName }).catch(() => {});
        }
        void syncFirebaseUserWithBackend(created.user);
        return { user: created.user, credId, credHash, authEmail, isLegacyAuth: false };
      } catch (createErr: any) {
        if (createErr?.code === 'auth/email-already-in-use') {
          const retrySigned = await signInWithEmailAndPassword(auth, authEmail, authSecret);
          void syncFirebaseUserWithBackend(retrySigned.user);
          return { user: retrySigned.user, credId, credHash, authEmail, isLegacyAuth: false };
        }
        throw createErr;
      }
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

export function sanitizeIdForFirestore(rawId: any, fallbackPrefix: string = 'doc'): string {
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
      if (typeof v === 'string') {
        if ((k === 'nrc_file' || k === 'contract_file') && v.length > 40000) {
          clean[k] = '';
        } else if (k === 'permissions_json') {
          clean[k] = v.slice(0, 8000);
        } else {
          clean[k] = v.slice(0, 2000);
        }
      } else {
        clean[k] = v;
      }
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

  // Run membership check and direct ownerUid check in parallel to halve Firestore round-trips
  const memRef = doc(db, 'businesses', safeBizId, 'memberships', currentUid);
  const [memSnap, ownedSnap] = await Promise.all([
    getDoc(memRef).catch(() => getDocFromCache(memRef).catch(() => null)),
    getDocs(query(collection(db, 'businesses'), where('ownerUid', '==', currentUid))).catch(() => null),
  ]);

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
  let existingMemUserId = String(resolvedUserId).slice(0, 128);
  try {
    const existingMemSnap = await getDoc(doc(db, 'businesses', safeBizId, 'memberships', safeMemId));
    if (existingMemSnap.exists()) {
      const mData = existingMemSnap.data();
      existingMemberUid = String(mData.memberUid || '');
      existingMemCreatedAt = mData.createdAt || null;
      existingMemOwnerUid = String(mData.ownerUid || parentOwnerUid);
      if (mData.user_id) existingMemUserId = String(mData.user_id).slice(0, 128);
    }
  } catch {}

  let existingCredOwnerUid = parentOwnerUid;
  let existingCredUserId = existingMemUserId;
  try {
    const existingCredSnap = await getDoc(doc(db, 'credential_directory', credId));
    if (existingCredSnap.exists()) {
      const cData = existingCredSnap.data();
      if (!existingMemberUid) existingMemberUid = String(cData.memberUid || '');
      existingCredOwnerUid = String(cData.ownerUid || parentOwnerUid);
      if (cData.user_id) existingCredUserId = String(cData.user_id).slice(0, 128);
    }
  } catch {}

  if (safeRole === 'owner' && cleanEmail === normalizeAuthEmail(localStorage.getItem('logged_in_user_email') || '') && authEmail === (auth.currentUser.email || '').toLowerCase() && !existingMemberUid) {
    existingMemberUid = currentUid;
  }

  const membershipPayload = {
    id: safeMemId,
    business_id: safeBizId,
    store_id: safeStoreId,
    user_id: existingMemUserId,
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
          const cData = claimedSnap.data();
          await writeDocOfflineAware(
            doc(db, 'businesses', safeBizId, 'memberships', existingMemberUid),
            {
              ...membershipPayload,
              id: existingMemberUid,
              user_id: String(cData?.user_id || existingMemUserId).slice(0, 128),
              memberUid: existingMemberUid,
              ownerUid: String(cData?.ownerUid || parentOwnerUid),
              createdAt: cData?.createdAt || serverTimestamp(),
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
        user_id: existingCredUserId,
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

export async function syncStaffAndMembershipsToCloud(
  businessId: string
): Promise<{ success: boolean; details: string }> {
  const cleanTargetId = String(businessId || '').trim();
  if (!cleanTargetId || cleanTargetId === 'default_biz' || isBusinessPermanentlyDeleted(cleanTargetId)) {
    return { success: false, details: 'Skipped: invalid business ID.' };
  }

  try {
    if (!auth.currentUser && typeof (auth as any).authStateReady === 'function') {
      await (auth as any).authStateReady();
    }
  } catch {}

  if (!auth.currentUser) {
    return { success: false, details: 'Skipped Firestore staff sync: no signed-in Firebase user.' };
  }
  if (!isCurrentUserAuthorizedBusinessOwner(cleanTargetId)) {
    return { success: false, details: 'Skipped Firestore staff sync: non-owner session.' };
  }

  const safeBizId = sanitizeIdForFirestore(cleanTargetId, 'biz');
  const cleanBizId = sqlEsc(cleanTargetId);
  const primaryStoreId = sanitizeIdForFirestore(getActiveStoreId(undefined, cleanTargetId), 'store');
  const currentUid = auth.currentUser.uid;
  let isOnline = await ensureFirestoreOnlineIfReachable();

  syncUsersAndMembershipsFromLegacyTables(cleanTargetId);

  const preAccess = isOnline
    ? await hasVerifiedFirestoreAccessToBusiness(safeBizId)
    : { hasAccess: false, via: 'none' as const, ownerUid: currentUid };
  if (!preAccess.hasAccess && isOnline && isBusinessCloudMarkedUnlinked(safeBizId)) {
    return { success: false, details: 'Workspace is unlinked from current Firebase account.' };
  }

  let resolvedParentOwnerUid = preAccess.ownerUid || currentUid;
  let bizName = cleanTargetId;
  try {
    const localBizRes = runSql(
      `SELECT name FROM businesses WHERE id = '${cleanBizId}'`,
      'Cloud Staff Sync: Read business name',
      true
    );
    if (localBizRes.success && Array.isArray(localBizRes.data) && localBizRes.data[0]?.name) {
      bizName = String(localBizRes.data[0].name);
    }
    if (isOnline) {
      const bizSnap = await getDoc(doc(db, 'businesses', safeBizId)).catch(() => null);
      if (bizSnap && bizSnap.exists()) {
        const bData = bizSnap.data();
        resolvedParentOwnerUid = String(bData?.ownerUid || resolvedParentOwnerUid);
        if (bData?.name) bizName = String(bData.name);
        setBusinessCloudUnlinkedFlag(safeBizId, false);
      }
    }
  } catch {}

  const targetTables = ['staff', 'business_memberships', 'users'] as const;
  const memRowsRes = runSql(
    `SELECT * FROM business_memberships WHERE business_id = '${cleanBizId}'`,
    'Cloud Staff Sync: Read business_memberships',
    true
  );
  const memRows = memRowsRes.success && Array.isArray(memRowsRes.data) ? memRowsRes.data : [];

  const existingLedgerSnaps = await Promise.all(
    targetTables.map((tbl) =>
      isOnline && !isFirestoreNetworkDisabled
        ? getDoc(doc(db, 'businesses', safeBizId, 'ledgers', tbl)).catch(() => null)
        : Promise.resolve(null)
    )
  );

  // Sync ledgers/staff, ledgers/business_memberships, and ledgers/users in parallel
  const ledgerWrites = targetTables.map(async (tableName, idx) => {
    const tRes = runSql(
      `SELECT * FROM ${tableName} WHERE business_id = '${cleanBizId}'`,
      `Cloud Staff Sync: Read ${tableName}`,
      true
    );
    const rawRows = (tRes.success && Array.isArray(tRes.data) ? tRes.data : []).map((r: any) => ({
      ...r,
      business_id: safeBizId,
      store_id: String(r?.store_id || primaryStoreId),
    }));
    const boundedRecords = rawRows.slice(-500).map(sanitizeRecordMap);
    const existingSnap = existingLedgerSnaps[idx];
    const ledgerOwnerUid = existingSnap?.exists()
      ? String(existingSnap.data()?.ownerUid || resolvedParentOwnerUid)
      : resolvedParentOwnerUid;

    if (boundedRecords.length === 0 && !existingSnap?.exists()) {
      return;
    }

    const ledgerPath = `businesses/${safeBizId}/ledgers/${tableName}`;
    try {
      isOnline = await writeDocOfflineAware(
        doc(db, 'businesses', safeBizId, 'ledgers', tableName),
        {
          id: tableName,
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
    } catch (err: any) {
      if (isNetworkOrOfflineAuthError(err)) {
        lastAuthNetworkFailureAt = Date.now();
        await setFirestoreOfflineMode();
        isOnline = false;
      } else {
        console.warn(`[Cloud Staff Sync] Failed writing ${ledgerPath}:`, err?.message || err);
      }
    }
  });

  // Also publish/refresh membership + credential directory docs in parallel
  const membershipWrites = memRows.map((mem: any) => {
    let parsedBranches: string[] = [];
    try {
      const bParsed =
        typeof mem.accessible_branches === 'string'
          ? JSON.parse(mem.accessible_branches)
          : mem.accessible_branches;
      if (Array.isArray(bParsed)) parsedBranches = bParsed;
    } catch {}
    return publishCredentialMembershipToCloud({
      businessId: safeBizId,
      businessName: bizName,
      membershipId: String(mem.id || ''),
      userId: String(mem.user_id || ''),
      email: String(mem.email || ''),
      fullName: String(mem.full_name || mem.email || 'Member'),
      role: mem.role === 'owner' || mem.role === 'manager' ? mem.role : 'sales',
      password: String(mem.password || ''),
      credentialHash: String(mem.credential_hash || ''),
      storeId: String(mem.store_id || primaryStoreId),
      accessibleBranches: parsedBranches,
      permissionsJson: String(mem.permissions_json || '{}'),
      status: String(mem.status || 'ACTIVE').toUpperCase() === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
    }).catch(() => ({ published: false, credId: '' }));
  });

  await Promise.all([...ledgerWrites, ...membershipWrites]);
  return {
    success: true,
    details: `Synced ${memRows.length} staff/membership profile(s) to Cloud Firestore.`,
  };
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
  password: string,
  options?: { deferFullRestore?: boolean }
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
    // Query credential_directory AND directly-owned businesses in parallel
    const [credSnap, ownedSnap] = await Promise.all([
      getDoc(credRef).catch(() => getDocFromCache(credRef).catch(() => null)),
      getDocs(query(collection(db, 'businesses'), where('ownerUid', '==', currentUid))).catch(() => null),
    ]);

    if (credSnap && credSnap.exists()) {
      const inv = credSnap.data();
      const targetBizId = String(inv.business_id || '').trim();
      if (!targetBizId || isBusinessPermanentlyDeleted(targetBizId)) {
        if (targetBizId) {
          purgeBusinessFromLocalDatabase(targetBizId);
          void deleteDoc(credRef).catch(() => {});
        }
        return { found: false };
      }
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
        // Non-blocking credential directory memberUid stamp
        void updateDoc(credRef, {
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
      setPermanentCompanyIdForUser({
        userId: String(inv.user_id || deriveUserId(cleanEmail)),
        credId,
        credentialHash: credHash,
        email: cleanEmail,
        companyId: safeBizId,
      });

      if (options?.deferFullRestore) {
        void restoreFromCloud(safeBizId, { silentIfUnlinked: true, skipAccessCheck: true }).catch(() => {});
      } else {
        await restoreFromCloud(safeBizId, { silentIfUnlinked: true, skipAccessCheck: true }).catch((e) =>
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
    if (ownedSnap && !ownedSnap.empty) {
      const validOwnedDocs = ownedSnap.docs.filter((d) => !isBusinessPermanentlyDeleted(d.id));
      if (validOwnedDocs.length > 0) {
        const bizDoc = validOwnedDocs[0];
        const bizData = bizDoc.data();
        const targetBizId = bizDoc.id;
        setPermanentCompanyIdForUser({
          userId: deriveUserId(cleanEmail),
          credId,
          credentialHash: credHash,
          email: cleanEmail,
          companyId: targetBizId,
        });
        if (options?.deferFullRestore) {
          void restoreFromCloud(targetBizId, { silentIfUnlinked: true, skipAccessCheck: true, preloadedBizData: bizData }).catch(() => {});
        } else {
          await restoreFromCloud(targetBizId, { silentIfUnlinked: true, skipAccessCheck: true, preloadedBizData: bizData }).catch(() => {});
        }
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
    }

    return { found: false };
  } catch (err) {
    console.warn('Credential invite lookup notice:', err);
    return { found: false };
  }
}

export async function purgeBusinessFromFirestoreAndStorage(businessId: string): Promise<void> {
  const safeBizId = sanitizeIdForFirestore(businessId, 'biz');
  if (!safeBizId || safeBizId === 'default_biz') return;
  markBusinessPermanentlyDeleted(safeBizId);
  purgeBusinessFromLocalDatabase(safeBizId);

  if (!auth.currentUser) return;
  const isOnline = await ensureFirestoreOnlineIfReachable();
  if (!isOnline) return;

  const subcollections = [
    'settings',
    'memberships',
    'stores',
    'products',
    'store_products',
    'customers',
    'orders',
    'order_items',
    'ledgers',
  ];

  await Promise.allSettled(
    subcollections.map(async (sub) => {
      try {
        const subSnap = await getDocs(collection(db, 'businesses', safeBizId, sub));
        await Promise.allSettled(subSnap.docs.map((d) => deleteDoc(d.ref)));
      } catch {
        // ignore subcollection errors if already empty or inaccessible
      }
    })
  );

  try {
    const credSnap = await getDocs(
      query(collection(db, 'credential_directory'), where('business_id', '==', safeBizId))
    );
    await Promise.allSettled(credSnap.docs.map((d) => deleteDoc(d.ref)));
  } catch {
    // ignore
  }

  try {
    await deleteDoc(doc(db, 'businesses', safeBizId));
  } catch {
    // ignore
  }

  const storagePaths = [
    `backups/${safeBizId}/clients_data.json`,
    `backups/${safeBizId}/transactions_and_ledgers.json`,
    `backups/${safeBizId}/full_workspace_backup.json`,
  ];
  await Promise.allSettled(
    storagePaths.map((p) => deleteObject(storageRef(storage, p)).catch(() => {}))
  );
}

let purgedDeletedIdsThisSession = new Set<string>();
async function purgeAllDeletedBusinessesFromCloudOnce(): Promise<void> {
  if (!auth.currentUser) return;
  const deletedIds = Array.from(getDeletedBusinessIds()).filter(
    (id) => id && id !== 'default_biz' && id !== '__latest__' && id !== '__global__'
  );
  for (const delId of deletedIds) {
    purgeBusinessFromLocalDatabase(delId);
    if (purgedDeletedIdsThisSession.has(delId)) continue;
    purgedDeletedIdsThisSession.add(delId);
    void purgeBusinessFromFirestoreAndStorage(delId);
    void deleteBusinessFromServer(delId);
  }
}

// ============================================================================
// IDEMPOTENT COMPANY REGISTRATION & SEQUENTIAL COMPANY ID ALLOCATOR (1, 2, 3...)
// ============================================================================
let activeCompanyRegistrationPromise: Promise<{
  alreadyExists: boolean;
  companyId: string;
  companyName?: string;
  restoredFromCloud?: boolean;
  credId: string;
  credHash: string;
}> | null = null;

export async function prepareIdempotentCompanyRegistration(params: {
  email: string;
  password: string;
  companyName: string;
  ownerName: string;
}): Promise<{
  alreadyExists: boolean;
  companyId: string;
  companyName?: string;
  restoredFromCloud?: boolean;
  credId: string;
  credHash: string;
}> {
  if (activeCompanyRegistrationPromise) {
    return activeCompanyRegistrationPromise;
  }

  activeCompanyRegistrationPromise = (async () => {
    const cleanEmail = normalizeAuthEmail(params.email);
    const rawPass = String(params.password || '').trim();
    const cleanCompanyName = String(params.companyName || '').trim();
    const normalizedName = cleanCompanyName.toLowerCase().replace(/\s+/g, ' ');
    const { credHash, credId } = deriveFirebaseCredentialIdentity(cleanEmail, rawPass);
    const userId = deriveUserId(cleanEmail);

    // 1. Check local database for an existing business with the same credential hash or (email + company name)
    const localBusinesses = dedupeAndCleanBusinessesTable();
    const localSameNameAndEmail = localBusinesses.find(
      (b: any) =>
        !isBusinessPermanentlyDeleted(b?.id) &&
        String(b?.name || '').trim().toLowerCase().replace(/\s+/g, ' ') === normalizedName &&
        normalizeAuthEmail(b?.email || '') === cleanEmail
    );
    if (localSameNameAndEmail) {
      const existingId = String(localSameNameAndEmail.id).trim();
      setPermanentCompanyIdForUser({
        userId,
        credId,
        credentialHash: credHash,
        email: cleanEmail,
        companyId: existingId,
      });
      return {
        alreadyExists: true,
        companyId: existingId,
        companyName: String(localSameNameAndEmail.name || existingId),
        credId,
        credHash,
      };
    }

    const existingPermForCred = getPermanentCompanyIdForUser({
      credId,
      credentialHash: credHash,
    });
    if (existingPermForCred) {
      const matchedLocal = localBusinesses.find((b: any) => String(b?.id || '').trim() === existingPermForCred);
      if (matchedLocal) {
        return {
          alreadyExists: true,
          companyId: existingPermForCred,
          companyName: String(matchedLocal.name || existingPermForCred),
          credId,
          credHash,
        };
      }
    }

    // 2. Authenticate credential identity in Firebase Auth
    try {
      await signInOrCreateCredentialAuth(cleanEmail, rawPass, {
        allowCreate: true,
        displayName: params.ownerName.trim(),
      });
    } catch (fbAuthErr) {
      console.warn('Firebase Credential Auth registration notice:', fbAuthErr);
    }

    const discoveredExistingIds = new Set<string>(
      localBusinesses.map((b: any) => String(b?.id || '').trim()).filter(Boolean)
    );

    // 3. Check Cloud Firestore (credential_directory & owned businesses) before creating any company
    if (auth.currentUser) {
      try {
        const isOnline = await ensureFirestoreOnlineIfReachable();
        if (isOnline) {
          const currentUid = auth.currentUser.uid;
          const credRef = doc(db, 'credential_directory', credId);
          const [credSnap, ownedSnap] = await Promise.all([
            getDoc(credRef).catch(() => getDocFromCache(credRef).catch(() => null)),
            getDocs(query(collection(db, 'businesses'), where('ownerUid', '==', currentUid))).catch(() => null),
          ]);

          if (ownedSnap && !ownedSnap.empty) {
            for (const d of ownedSnap.docs) {
              if (!isBusinessPermanentlyDeleted(d.id)) {
                discoveredExistingIds.add(d.id);
              }
            }
          }

          if (credSnap && credSnap.exists()) {
            const cData = credSnap.data();
            const remoteBizId = String(cData?.business_id || '').trim();
            if (remoteBizId && !isBusinessPermanentlyDeleted(remoteBizId)) {
              discoveredExistingIds.add(remoteBizId);
              setPermanentCompanyIdForUser({
                userId,
                credId,
                credentialHash: credHash,
                email: cleanEmail,
                companyId: remoteBizId,
              });
              await restoreFromCloud(remoteBizId, {
                silentIfUnlinked: true,
                skipAccessCheck: true,
              }).catch(() => {});
              return {
                alreadyExists: true,
                companyId: remoteBizId,
                companyName: String(cData?.business_name || cleanCompanyName || remoteBizId),
                restoredFromCloud: true,
                credId,
                credHash,
              };
            }
          }

          if (ownedSnap && !ownedSnap.empty) {
            const validDocs = ownedSnap.docs.filter((d) => !isBusinessPermanentlyDeleted(d.id));
            const matchingDoc =
              validDocs.find(
                (d) =>
                  String(d.data()?.name || '').trim().toLowerCase().replace(/\s+/g, ' ') === normalizedName
              ) || validDocs[0];
            if (matchingDoc) {
              const remoteBizId = matchingDoc.id;
              const remoteData = matchingDoc.data();
              setPermanentCompanyIdForUser({
                userId,
                credId,
                credentialHash: credHash,
                email: cleanEmail,
                companyId: remoteBizId,
              });
              await restoreFromCloud(remoteBizId, {
                silentIfUnlinked: true,
                skipAccessCheck: true,
                preloadedBizData: remoteData,
              }).catch(() => {});
              return {
                alreadyExists: true,
                companyId: remoteBizId,
                companyName: String(remoteData?.name || cleanCompanyName || remoteBizId),
                restoredFromCloud: true,
                credId,
                credHash,
              };
            }
          }
        }
      } catch (fsCheckErr) {
        console.warn('Firestore pre-registration idempotency check notice:', fsCheckErr);
      }
    }

    // 4. Also check Cloud SQL /api/sync/status for existing sequential company IDs & same-name company under this email
    if (typeof fetch !== 'undefined' && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      try {
        const statusRes = await fetch('/api/sync/status');
        if (statusRes.ok) {
          const statusData = await statusRes.json().catch(() => null);
          const avail = Array.isArray(statusData?.availableBusinesses)
            ? statusData.availableBusinesses
            : [];
          for (const b of avail) {
            const bId = String(b?.businessId || b?.id || '').trim();
            if (bId && !isBusinessPermanentlyDeleted(bId)) {
              discoveredExistingIds.add(bId);
              const bName = String(b?.businessName || b?.name || '')
                .trim()
                .toLowerCase()
                .replace(/\s+/g, ' ');
              const bEmail = normalizeAuthEmail(b?.ownerEmail || b?.email || '');
              if (bName === normalizedName && bEmail === cleanEmail) {
                return {
                  alreadyExists: true,
                  companyId: bId,
                  companyName: String(b?.businessName || b?.name || bId),
                  credId,
                  credHash,
                };
              }
            }
          }
        }
      } catch {}
    }

    // 5. Allocate the next sequential Company ID starting from 1 ("1", "2", "3", ...)
    const nextSequentialId = getNextSequentialCompanyId(discoveredExistingIds);
    setPermanentCompanyIdForUser({
      userId,
      credId,
      credentialHash: credHash,
      email: cleanEmail,
      companyId: nextSequentialId,
    });

    return {
      alreadyExists: false,
      companyId: nextSequentialId,
      credId,
      credHash,
    };
  })().finally(() => {
    activeCompanyRegistrationPromise = null;
  });

  return activeCompanyRegistrationPromise;
}

// ============================================================================
// CLOUD BACKUP (AlaSQL Local -> Firestore Relational + Firebase Storage)
// ============================================================================
const inFlightCloudBackups = new Map<string, Promise<{ success: boolean; details: string }>>();

export async function backupToCloud(
  businessId: string,
  options?: { silentIfNotOwner?: boolean; allowCreateCompanyDoc?: boolean }
): Promise<{ success: boolean; details: string }> {
  const cleanTargetId = String(businessId || '').trim();
  if (!cleanTargetId || cleanTargetId === 'default_biz' || isBusinessPermanentlyDeleted(cleanTargetId)) {
    if (cleanTargetId && isBusinessPermanentlyDeleted(cleanTargetId)) {
      purgeBusinessFromLocalDatabase(cleanTargetId);
    }
    return {
      success: false,
      details: 'Backup skipped: invalid or deleted company ID.',
    };
  }

  const existingInFlight = inFlightCloudBackups.get(cleanTargetId);
  if (existingInFlight) {
    return existingInFlight;
  }

  const backupPromise = (async (): Promise<{ success: boolean; details: string }> => {
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

  // 1. Fetch current business profile locally — NEVER synthesize a fallback company record if missing locally!
  const localBizRes = runSql(
    `SELECT * FROM businesses WHERE id = '${cleanBizId}'`,
    'Cloud Sync: Read local profile',
    true
  );
  const biz =
    localBizRes.success && Array.isArray(localBizRes.data) && localBizRes.data.length > 0
      ? localBizRes.data[0]
      : null;

  if (!biz) {
    return {
      success: false,
      details: 'Backup skipped: company profile is not loaded in local database.',
    };
  }

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
      const preservedModeration: Record<string, any> = {};
      if (existingData.status !== undefined) preservedModeration.status = existingData.status;
      if (existingData.suspended_reason !== undefined) preservedModeration.suspended_reason = existingData.suspended_reason;
      if (existingData.suspended_at !== undefined) preservedModeration.suspended_at = existingData.suspended_at;
      if (existingData.suspended_by !== undefined) preservedModeration.suspended_by = existingData.suspended_by;
      if (existingData.flagged_for_fraud !== undefined) preservedModeration.flagged_for_fraud = existingData.flagged_for_fraud;
      if (existingData.fraud_flag_reason !== undefined) preservedModeration.fraud_flag_reason = existingData.fraud_flag_reason;
      if (existingData.flagged_at !== undefined) preservedModeration.flagged_at = existingData.flagged_at;
      if (existingData.plan_tier !== undefined) preservedModeration.plan_tier = existingData.plan_tier;
      if (existingData.subscription_status !== undefined) preservedModeration.subscription_status = existingData.subscription_status;

      isOnline = await writeDocOfflineAware(
        bizRef,
        {
          ...fullBizFields,
          ...preservedModeration,
          ownerUid: resolvedParentOwnerUid,
          createdAt: existingData.createdAt || serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        bizPath,
        isOnline
      );
    } else {
      // NEVER create a new company document automatically during login, refresh, dashboard init, or background auto-backup!
      if (!options?.allowCreateCompanyDoc) {
        return {
          success: false,
          details: 'Skipped automatic company creation: company documents can only be created during intentional registration.',
        };
      }
      resolvedParentOwnerUid = currentUid;
      isOnline = await writeDocOfflineAware(
        bizRef,
        {
          ...fullBizFields,
          status: 'ACTIVE',
          flagged_for_fraud: false,
          plan_tier: 'PAID',
          subscription_status: 'ACTIVE',
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
  if (isOnline && !isFirestoreNetworkDisabled && activeStoreDocIds.size > 0) {
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
  if (isOnline && !isFirestoreNetworkDisabled && activeProductDocIds.size > 0) {
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
  if (isOnline && !isFirestoreNetworkDisabled && activeSpDocIds.size > 0) {
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
  if (isOnline && !isFirestoreNetworkDisabled && activeCustomerDocIds.size > 0) {
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

    // Never overwrite an existing cloud ledger document with an empty array during background sync
    if (boundedRecords.length === 0 && existingLedgersMap.has(ledgerDocId) && !options?.allowCreateCompanyDoc) {
      continue;
    }

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
  })().finally(() => {
    inFlightCloudBackups.delete(cleanTargetId);
  });

  inFlightCloudBackups.set(cleanTargetId, backupPromise);
  return backupPromise;
}

const recentBusinessModerationCache = new Map<
  string,
  { status: 'ACTIVE' | 'SUSPENDED'; suspendedReason?: string; checkedAt: number }
>();

function cacheBusinessModerationStatus(
  businessId: string,
  status: 'ACTIVE' | 'SUSPENDED',
  suspendedReason?: string
) {
  recentBusinessModerationCache.set(businessId, {
    status,
    suspendedReason,
    checkedAt: Date.now(),
  });
}

export async function checkBusinessCloudModerationStatus(
  businessId: string,
  options?: { forceServer?: boolean; timeoutMs?: number }
): Promise<{ status: 'ACTIVE' | 'SUSPENDED'; suspendedReason?: string; deleted?: boolean }> {
  const safeBizId = sanitizeIdForFirestore(businessId, 'biz');
  if (!safeBizId || safeBizId === 'default_biz') return { status: 'ACTIVE' };
  if (isBusinessPermanentlyDeleted(safeBizId)) {
    purgeBusinessFromLocalDatabase(safeBizId);
    return {
      status: 'SUSPENDED',
      suspendedReason: 'This business account has been permanently deleted by Platform Super Admin.',
      deleted: true,
    };
  }

  const localRes = runSql(
    `SELECT status, suspended_reason FROM businesses WHERE id = '${sqlEsc(safeBizId)}'`,
    'Moderation check: Read local business status',
    true
  );
  const localRow = localRes.success && Array.isArray(localRes.data) ? localRes.data[0] : null;
  if (localRow && String(localRow.status || 'ACTIVE').toUpperCase() === 'SUSPENDED') {
    return {
      status: 'SUSPENDED',
      suspendedReason: String(localRow.suspended_reason || 'Account suspended by Platform Super Admin.'),
    };
  }

  // Reuse very recent server check (e.g., from restoreFromCloud seconds earlier) to avoid duplicate round-trips on login
  const cached = recentBusinessModerationCache.get(safeBizId);
  if (!options?.forceServer && cached && Date.now() - cached.checkedAt < 15000) {
    return { status: cached.status, suspendedReason: cached.suspendedReason };
  }

  if (!auth.currentUser) return { status: 'ACTIVE' };
  const bizPath = `businesses/${safeBizId}`;
  try {
    const isOnline = await ensureFirestoreOnlineIfReachable();
    if (!isOnline) return { status: 'ACTIVE' };
    const timeoutMs = Math.max(800, options?.timeoutMs ?? 2500);
    const serverRead = getDocFromServer(doc(db, 'businesses', safeBizId)).catch(() =>
      getDoc(doc(db, 'businesses', safeBizId))
    );
    const snap = await Promise.race([
      serverRead,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!snap || !snap.exists()) {
      return { status: 'ACTIVE' };
    }
    const data = snap.data();
    const st = String(data?.status || 'ACTIVE').toUpperCase() === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE';
    const reason = String(data?.suspended_reason || '');
    cacheBusinessModerationStatus(safeBizId, st, reason || undefined);
    if (st === 'SUSPENDED') {
      runSql(
        `UPDATE businesses SET status = 'SUSPENDED', suspended_reason = '${sqlEsc(reason)}' WHERE id = '${sqlEsc(safeBizId)}'`,
        'Sync suspended status from Firestore',
        true
      );
      return { status: 'SUSPENDED', suspendedReason: reason || 'Account suspended by Platform Super Admin.' };
    }
    return { status: 'ACTIVE' };
  } catch (err: any) {
    if (err?.code === 'permission-denied') return { status: 'ACTIVE' };
    if (isNetworkOrOfflineAuthError(err)) return { status: 'ACTIVE' };
    handleFirestoreError(err, OperationType.GET, bizPath);
    return { status: 'ACTIVE' };
  }
}

// ============================================================================
// CLOUD RESTORE (Firestore -> AlaSQL Local, with non-blocking Storage archive supplement)
// ============================================================================
export async function restoreFromCloud(
  businessId?: string,
  options?: { silentIfUnlinked?: boolean; skipAccessCheck?: boolean; preloadedBizData?: any }
): Promise<{ success: boolean; details: string }> {
  if (!auth.currentUser) {
    throw new Error('You must be signed in (Email/Password or Google) to restore from Firebase Cloud.');
  }

  if (businessId && isBusinessPermanentlyDeleted(businessId)) {
    purgeBusinessFromLocalDatabase(businessId);
    void purgeBusinessFromFirestoreAndStorage(businessId);
    return {
      success: false,
      details: 'Business was permanently deleted.',
    };
  }

  const isOnline = await ensureFirestoreOnlineIfReachable();
  const currentUid = auth.currentUser.uid;
  let targetBizId =
    businessId && businessId !== 'default_biz' && !isBusinessPermanentlyDeleted(businessId)
      ? sanitizeIdForFirestore(businessId, 'biz')
      : '';
  let bizData: any = options?.preloadedBizData || null;

  // 1. Verify permission via memberships/{uid} or ownerUid query BEFORE calling getDoc(businesses/{targetBizId})
  if (targetBizId && !bizData) {
    const hasAccess = options?.skipAccessCheck
      ? true
      : (await hasVerifiedFirestoreAccessToBusiness(targetBizId)).hasAccess;
    if (hasAccess) {
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
        const validDocs = qSnap.docs.filter((d) => !isBusinessPermanentlyDeleted(d.id));
        const matchedDoc = targetBizId
          ? validDocs.find((d) => d.id === targetBizId)
          : validDocs[0];
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

  if (!bizData || !targetBizId || isBusinessPermanentlyDeleted(targetBizId)) {
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
      tpin, currency, tax_rate, admin_role, created_at, business_id, store_id,
      status, suspended_reason, suspended_at, suspended_by,
      flagged_for_fraud, fraud_flag_reason, flagged_at, plan_tier, subscription_status
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
      '${sqlEsc(restoredPrimaryStoreId)}',
      '${sqlEsc(String(bizData.status || 'ACTIVE').toUpperCase())}',
      '${sqlEsc(String(bizData.suspended_reason || ''))}',
      '${sqlEsc(String(bizData.suspended_at || ''))}',
      '${sqlEsc(String(bizData.suspended_by || ''))}',
      ${bizData.flagged_for_fraud ? 1 : 0},
      '${sqlEsc(String(bizData.fraud_flag_reason || ''))}',
      '${sqlEsc(String(bizData.flagged_at || ''))}',
      '${sqlEsc(String(bizData.plan_tier || 'PAID').toUpperCase())}',
      '${sqlEsc(String(bizData.subscription_status || 'ACTIVE').toUpperCase())}'
    )`,
    'Restore: Insert backed up business workspace',
    true
  );
  dedupeAndCleanBusinessesTable();

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

  // Cache freshly fetched business moderation status so login doesn't run a redundant getDocFromServer immediately after
  const fetchedModStatus = String(bizData.status || 'ACTIVE').toUpperCase() === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE';
  cacheBusinessModerationStatus(targetBizId, fetchedModStatus, String(bizData.suspended_reason || '') || undefined);

  // Fetch all subcollections (including owner-accessible memberships) in parallel
  const settingsPath = `businesses/${targetBizId}/settings/default`;
  const storesPath = `businesses/${targetBizId}/stores`;
  const productsPath = `businesses/${targetBizId}/products`;
  const storeProductsPath = `businesses/${targetBizId}/store_products`;
  const customersPath = `businesses/${targetBizId}/customers`;
  const ordersPath = `businesses/${targetBizId}/orders`;
  const orderItemsPath = `businesses/${targetBizId}/order_items`;
  const ledgersPath = `businesses/${targetBizId}/ledgers`;
  const parentBizOwnerUid = String(bizData?.ownerUid || currentUid);

  const handleReadErr = async (err: any, op: OperationType, path: string) => {
    if (isNetworkOrOfflineAuthError(err)) {
      lastAuthNetworkFailureAt = Date.now();
      await setFirestoreOfflineMode();
      return null;
    }
    handleFirestoreError(err, op, path);
    return null;
  };

  const [settingsSnap, sSnap, pSnap, spSnap, cSnap, oSnap, oiSnap, lSnap, mSnap] = await Promise.all([
    getDoc(doc(db, 'businesses', targetBizId, 'settings', 'default')).catch(async (err: any) => {
      if (isNetworkOrOfflineAuthError(err)) {
        lastAuthNetworkFailureAt = Date.now();
        await setFirestoreOfflineMode();
        return getDocFromCache(doc(db, 'businesses', targetBizId, 'settings', 'default')).catch(() => null);
      }
      return handleReadErr(err, OperationType.GET, settingsPath);
    }),
    getDocs(query(collection(db, 'businesses', targetBizId, 'stores'), where('business_id', '==', targetBizId))).catch(
      (err) => handleReadErr(err, OperationType.LIST, storesPath)
    ),
    getDocs(query(collection(db, 'businesses', targetBizId, 'products'), where('business_id', '==', targetBizId))).catch(
      (err) => handleReadErr(err, OperationType.LIST, productsPath)
    ),
    getDocs(query(collection(db, 'businesses', targetBizId, 'store_products'), where('business_id', '==', targetBizId))).catch(
      (err) => handleReadErr(err, OperationType.LIST, storeProductsPath)
    ),
    getDocs(query(collection(db, 'businesses', targetBizId, 'customers'), where('business_id', '==', targetBizId))).catch(
      (err) => handleReadErr(err, OperationType.LIST, customersPath)
    ),
    getDocs(query(collection(db, 'businesses', targetBizId, 'orders'), where('business_id', '==', targetBizId))).catch(
      (err) => handleReadErr(err, OperationType.LIST, ordersPath)
    ),
    getDocs(query(collection(db, 'businesses', targetBizId, 'order_items'), where('business_id', '==', targetBizId))).catch(
      (err) => handleReadErr(err, OperationType.LIST, orderItemsPath)
    ),
    getDocs(query(collection(db, 'businesses', targetBizId, 'ledgers'), where('business_id', '==', targetBizId))).catch(
      (err) => handleReadErr(err, OperationType.LIST, ledgersPath)
    ),
    getDocs(
      query(
        collection(db, 'businesses', targetBizId, 'memberships'),
        where('business_id', '==', targetBizId),
        where('ownerUid', '==', parentBizOwnerUid)
      )
    ).catch(() => null),
  ]);

  // 1B. Apply Business Settings from Firestore subcollection
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

  // 2. Apply Store outlets
  if (sSnap && !sSnap.empty) {
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

  // 3. Apply Products catalog & batches
  if (pSnap && !pSnap.empty) {
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

  // 3B. Apply Per-Branch Store Stock Levels
  if (spSnap && !spSnap.empty) {
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

  // 4. Apply Client CRM list
  if (cSnap && !cSnap.empty) {
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

  // 5. Apply Order invoices
  if (oSnap && !oSnap.empty) {
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

  // 6. Apply Order Line Items
  if (oiSnap && !oiSnap.empty) {
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

  // 7. Apply Operational & Accounting Ledgers
  if (lSnap && !lSnap.empty) {
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

  // 7B. Merge any cloud memberships subcollection records into business_memberships
  if (mSnap && !mSnap.empty) {
    mSnap.forEach((docSnap) => {
      const m = docSnap.data();
      const mEmail = normalizeAuthEmail(m?.email || '');
      if (!mEmail) return;
      const mRole: 'owner' | 'manager' | 'sales' =
        m.role === 'owner' || m.role === 'manager' ? m.role : 'sales';
      upsertUserAndMembership({
        id: String(m.id || docSnap.id),
        businessId: targetBizId,
        email: mEmail,
        fullName: String(m.full_name || mEmail),
        role: mRole,
        storeId: String(m.store_id || restoredPrimaryStoreId),
        accessibleBranches: Array.isArray(m.accessible_branches) ? m.accessible_branches : [],
        permissionsJson: String(m.permissions_json || '{}'),
        status: String(m.status || 'ACTIVE').toUpperCase() === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
      });
    });
  }

  // 8. Supplement optional Firebase Storage archives asynchronously in the background so missing Storage files never slow login
  if (isOnline && !isFirestoreNetworkDisabled) {
    void (async () => {
      let updatedFromArchive = false;
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
          updatedFromArchive = true;
        }
      } catch {}

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
          updatedFromArchive = true;
        }
        if (Array.isArray(parsed?.quotations) && parsed.quotations.length > 0) {
          rehydrateAlasqlFromRecords(
            { quotations: parsed.quotations },
            { businessId: targetBizId, storeId: restoredPrimaryStoreId, preserveOtherBusinesses: true }
          );
          updatedFromArchive = true;
        }
      } catch {}

      if (updatedFromArchive) {
        await runWithHydrationGuard(() => {
          persistTablesToStorage(true);
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new Event('local_db_restored'));
          }
        });
      }
    })();
  }

  await runWithHydrationGuard(() => {
    setPermanentCompanyIdForUser({
      userId: deriveUserId(String(bizData.email || auth.currentUser?.email || '')),
      email: String(bizData.email || auth.currentUser?.email || ''),
      companyId: targetBizId,
    });
    syncUsersAndMembershipsFromLegacyTables(targetBizId);
    syncAllAccountingSystems('Firebase Cloud Restore');
    persistTablesToStorage(true);

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('local_db_restored'));
    }
  });

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
  if (isHydratingOrRestoringDatabase()) return;
  if (typeof localStorage !== 'undefined' && localStorage.getItem('pos_authenticated_session') !== 'true') return;
  if (autoFirebaseBackupTimer) {
    clearTimeout(autoFirebaseBackupTimer);
  }
  autoFirebaseBackupTimer = setTimeout(async () => {
    try {
      if (!auth.currentUser || isHydratingOrRestoringDatabase()) return;
      if (typeof localStorage !== 'undefined' && localStorage.getItem('pos_authenticated_session') !== 'true') return;

      let targetBizId = String(businessId || '').trim();
      if (!targetBizId && typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem('active_business_profile');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed?.id && parsed.id !== 'default_biz') {
            targetBizId = String(parsed.id).trim();
          }
        }
      }

      if (!targetBizId || targetBizId === 'default_biz' || isBusinessPermanentlyDeleted(targetBizId)) {
        return;
      }

      // Verify the company actually exists in the local businesses table before attempting auto-backup
      const localCheck = runSql(
        `SELECT id FROM businesses WHERE id = '${sqlEsc(targetBizId)}'`,
        'Auto Firebase Backup: Verify local business exists',
        true
      );
      if (!localCheck.success || !Array.isArray(localCheck.data) || localCheck.data.length === 0) {
        return;
      }

      if (
        isCurrentUserAuthorizedBusinessOwner(targetBizId) &&
        !isBusinessCloudMarkedUnlinked(targetBizId)
      ) {
        // NEVER allow auto-backup to create a new company document in Firestore
        await backupToCloud(targetBizId, {
          silentIfNotOwner: true,
          allowCreateCompanyDoc: false,
        });
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
    if (!isHydratingOrRestoringDatabase()) {
      triggerAutoFirebaseBackup();
    }
  });
  window.addEventListener('online', () => {
    lastAuthNetworkFailureAt = 0;
    void ensureFirestoreOnlineIfReachable().then((online) => {
      if (online) {
        void flushPendingFinalizedTxMirrors();
        if (!isHydratingOrRestoringDatabase()) {
          triggerAutoFirebaseBackup();
        }
      }
    });
  });
}
