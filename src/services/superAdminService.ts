import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  auth,
  db,
  ensureFirestoreOnlineIfReachable,
  googleSignOut,
  handleFirestoreError,
  OperationType,
  sanitizeIdForFirestore,
  signInOrCreateCredentialAuth,
} from '../firebase';
import {
  ALL_TABLE_NAMES,
  persistTablesToStorage,
  runSql,
  sqlEsc,
} from '../db';
import {
  computeCredentialHashSync,
  normalizeAuthEmail,
} from '../multiTenantAuth';

export const SUPER_ADMIN_EMAIL = 'cornbtechnologies@gmail.com';
export const SUPER_ADMIN_CRED_HASH =
  '14502f2917bd7baffecafd15a60218ad4c6a666a73d3c9c89f5ed487d9eb1c7f';
export const SUPER_ADMIN_CRED_ID =
  '14502f2917bd7baffecafd15a60218ad4c6a666a73d3c9c89f5ed487';

const SUPER_ADMIN_SESSION_KEY = 'pos_super_admin_session_v1';
const LOCAL_PLATFORM_AUDIT_KEY = 'pos_super_admin_audit_logs_v1';

export type BusinessStatus = 'ACTIVE' | 'SUSPENDED';
export type PlanTier = 'PAID' | 'TRIAL' | 'FREE';
export type SubscriptionStatus = 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';

export type PlatformAuditAction =
  | 'SUSPEND_BUSINESS'
  | 'RESTORE_BUSINESS'
  | 'FLAG_FRAUD'
  | 'CLEAR_FRAUD'
  | 'UPDATE_PLAN'
  | 'HARD_DELETE_BUSINESS';

export interface SuperAdminSession {
  role: 'SUPER_ADMIN';
  email: string;
  fullName: string;
  uid: string;
  credHash: string;
  credId: string;
  authenticatedAt: string;
}

export interface PlatformBusinessRecord {
  id: string;
  name: string;
  owner: string;
  email: string;
  billing_phone: string;
  billing_email: string;
  billing_address: string;
  billing_city: string;
  billing_country: string;
  tpin: string;
  currency: string;
  status: BusinessStatus;
  suspended_reason: string;
  suspended_at: string;
  suspended_by: string;
  flagged_for_fraud: boolean;
  fraud_flag_reason: string;
  flagged_at: string;
  plan_tier: PlanTier;
  subscription_status: SubscriptionStatus;
  created_at: string;
  ownerUid: string;
  source: 'cloud' | 'local' | 'synced';
  // Usage metrics
  gmv: number;
  orderCount: number;
  branchCount: number;
  productCount: number;
  staffCount: number;
  customerCount: number;
  lastActivityAt: string;
}

export interface PlatformKpiSummary {
  totalBusinesses: number;
  activePaidShops: number;
  totalPlatformGmv: number;
  activeCount: number;
  suspendedCount: number;
  flaggedFraudCount: number;
  totalOrders: number;
}

export interface PlatformAuditLogEntry {
  id: string;
  action: PlatformAuditAction;
  target_business_id: string;
  target_business_name: string;
  reason: string;
  performed_by_uid: string;
  performed_by_email: string;
  metadata_json: string;
  timestamp: string;
}

export function isSuperAdminEmail(email: string): boolean {
  return normalizeAuthEmail(email) === SUPER_ADMIN_EMAIL;
}

export function getSavedSuperAdminSession(): SuperAdminSession | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SUPER_ADMIN_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SuperAdminSession;
    if (
      parsed &&
      parsed.role === 'SUPER_ADMIN' &&
      normalizeAuthEmail(parsed.email) === SUPER_ADMIN_EMAIL &&
      parsed.credHash === SUPER_ADMIN_CRED_HASH
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveSuperAdminSession(session: SuperAdminSession | null) {
  if (typeof localStorage === 'undefined') return;
  if (!session) {
    localStorage.removeItem(SUPER_ADMIN_SESSION_KEY);
    return;
  }
  localStorage.setItem(SUPER_ADMIN_SESSION_KEY, JSON.stringify(session));
}

function readLocalAuditCache(): PlatformAuditLogEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LOCAL_PLATFORM_AUDIT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendLocalAuditCache(entry: PlatformAuditLogEntry) {
  if (typeof localStorage === 'undefined') return;
  const list = readLocalAuditCache().filter((item) => item.id !== entry.id);
  list.unshift(entry);
  localStorage.setItem(LOCAL_PLATFORM_AUDIT_KEY, JSON.stringify(list.slice(0, 500)));
}

function formatFirestoreTimestamp(val: any): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val?.toDate === 'function') {
    try {
      return val.toDate().toISOString();
    } catch {
      return '';
    }
  }
  if (typeof val?.seconds === 'number') {
    return new Date(val.seconds * 1000).toISOString();
  }
  return '';
}

function isSoftOfflineOrPermissionReadNotice(err: any): boolean {
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();
  return (
    code === 'unavailable' ||
    code === 'failed-precondition' ||
    msg.includes('network') ||
    msg.includes('offline') ||
    msg.includes('client is offline')
  );
}

export async function ensureSuperAdminCloudDoc(session: SuperAdminSession): Promise<string> {
  if (!auth.currentUser) {
    throw new Error('Firebase authentication session is not active.');
  }
  const uid = auth.currentUser.uid;
  const isOnline = await ensureFirestoreOnlineIfReachable();
  if (!isOnline) return uid;

  const docPath = `super_admins/${uid}`;
  try {
    const adminRef = doc(db, 'super_admins', uid);
    const existing = await getDoc(adminRef);
    if (!existing.exists()) {
      await setDoc(adminRef, {
        id: uid,
        uid,
        cred_id: SUPER_ADMIN_CRED_ID,
        email: SUPER_ADMIN_EMAIL,
        full_name: session.fullName || 'Platform Super Admin',
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    return uid;
  } catch (err: any) {
    if (isSoftOfflineOrPermissionReadNotice(err)) return uid;
    handleFirestoreError(err, OperationType.WRITE, docPath);
    return uid;
  }
}

export async function authenticateSuperAdmin(
  emailRaw: string,
  passwordRaw: string
): Promise<{ success: boolean; session?: SuperAdminSession; error?: string }> {
  const cleanEmail = normalizeAuthEmail(emailRaw);
  const rawPass = String(passwordRaw || '').trim();

  if (cleanEmail !== SUPER_ADMIN_EMAIL) {
    return { success: false, error: 'Not a Super Admin account.' };
  }

  const credHash = computeCredentialHashSync(cleanEmail, rawPass);
  if (credHash !== SUPER_ADMIN_CRED_HASH) {
    return {
      success: false,
      error: 'Invalid Super Admin password. Platform access denied.',
    };
  }

  let uid = `super_admin_${SUPER_ADMIN_CRED_ID.slice(0, 20)}`;
  try {
    const authRes = await signInOrCreateCredentialAuth(cleanEmail, rawPass, {
      allowCreate: true,
      displayName: 'Platform Super Admin',
      allowLegacyFallback: false,
    });
    uid = authRes.user.uid;
  } catch (err: any) {
    if (typeof navigator !== 'undefined' && navigator.onLine !== false) {
      console.warn('Super Admin Firebase Auth notice:', err?.message || err);
    }
  }

  const session: SuperAdminSession = {
    role: 'SUPER_ADMIN',
    email: SUPER_ADMIN_EMAIL,
    fullName: 'Platform Super Admin',
    uid,
    credHash,
    credId: SUPER_ADMIN_CRED_ID,
    authenticatedAt: new Date().toISOString(),
  };

  if (auth.currentUser) {
    await ensureSuperAdminCloudDoc(session).catch(() => {});
  }

  saveSuperAdminSession(session);
  return { success: true, session };
}

export async function logoutSuperAdmin(): Promise<void> {
  saveSuperAdminSession(null);
  await googleSignOut().catch(() => {});
}

async function ensureActiveSuperAdminFirebaseSession(session: SuperAdminSession): Promise<boolean> {
  if (!auth.currentUser) {
    return false;
  }
  await ensureSuperAdminCloudDoc(session);
  return true;
}

function readLocalBusinessesSnapshot(): Map<string, PlatformBusinessRecord> {
  const map = new Map<string, PlatformBusinessRecord>();
  const bizRes = runSql(
    `SELECT * FROM businesses`,
    'Super Admin: Read local registered businesses',
    true
  );
  const bizRows = bizRes.success && Array.isArray(bizRes.data) ? bizRes.data : [];

  const ordersRes = runSql(`SELECT business_id, total, status, orderDate FROM orders`, 'Super Admin: Read local orders', true);
  const orderRows = ordersRes.success && Array.isArray(ordersRes.data) ? ordersRes.data : [];

  const storesRes = runSql(`SELECT id, business_id FROM stores`, 'Super Admin: Read local stores', true);
  const storeRows = storesRes.success && Array.isArray(storesRes.data) ? storesRes.data : [];

  const prodRes = runSql(`SELECT id, business_id FROM products`, 'Super Admin: Read local products', true);
  const prodRows = prodRes.success && Array.isArray(prodRes.data) ? prodRes.data : [];

  const staffRes = runSql(`SELECT id, business_id FROM staff`, 'Super Admin: Read local staff', true);
  const staffRows = staffRes.success && Array.isArray(staffRes.data) ? staffRes.data : [];

  const memRes = runSql(`SELECT id, business_id FROM business_memberships`, 'Super Admin: Read local memberships', true);
  const memRows = memRes.success && Array.isArray(memRes.data) ? memRes.data : [];

  const custRes = runSql(`SELECT id, business_id FROM customers`, 'Super Admin: Read local customers', true);
  const custRows = custRes.success && Array.isArray(custRes.data) ? custRes.data : [];

  for (const b of bizRows) {
    const id = String(b?.id || '').trim();
    if (!id || id === 'default_biz') continue;

    const bizOrders = orderRows.filter((o: any) => String(o?.business_id || '') === id);
    const gmv = bizOrders.reduce((acc: number, o: any) => {
      const st = String(o?.status || '').toLowerCase();
      if (st === 'refunded' || st === 'reversed') return acc;
      return acc + (Number(o?.total) || 0);
    }, 0);

    const lastOrderAt = bizOrders.reduce((latest: string, o: any) => {
      const dt = String(o?.orderDate || '');
      return dt > latest ? dt : latest;
    }, '');

    const localStaffCount = Math.max(
      staffRows.filter((s: any) => String(s?.business_id || '') === id).length,
      memRows.filter((m: any) => String(m?.business_id || '') === id).length
    );

    map.set(id, {
      id,
      name: String(b.name || id),
      owner: String(b.owner || 'Owner'),
      email: String(b.email || ''),
      billing_phone: String(b.billing_phone || b.phone || ''),
      billing_email: String(b.billing_email || b.email || ''),
      billing_address: String(b.billing_address || ''),
      billing_city: String(b.billing_city || ''),
      billing_country: String(b.billing_country || ''),
      tpin: String(b.tpin || ''),
      currency: String(b.currency || 'K'),
      status: String(b.status || 'ACTIVE').toUpperCase() === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
      suspended_reason: String(b.suspended_reason || ''),
      suspended_at: String(b.suspended_at || ''),
      suspended_by: String(b.suspended_by || ''),
      flagged_for_fraud: Boolean(Number(b.flagged_for_fraud) === 1 || b.flagged_for_fraud === true),
      fraud_flag_reason: String(b.fraud_flag_reason || ''),
      flagged_at: String(b.flagged_at || ''),
      plan_tier:
        String(b.plan_tier || 'PAID').toUpperCase() === 'TRIAL'
          ? 'TRIAL'
          : String(b.plan_tier || 'PAID').toUpperCase() === 'FREE'
            ? 'FREE'
            : 'PAID',
      subscription_status:
        String(b.subscription_status || 'ACTIVE').toUpperCase() === 'PAST_DUE'
          ? 'PAST_DUE'
          : String(b.subscription_status || 'ACTIVE').toUpperCase() === 'CANCELLED'
            ? 'CANCELLED'
            : 'ACTIVE',
      created_at: String(b.created_at || ''),
      ownerUid: String(b.ownerUid || ''),
      source: 'local',
      gmv,
      orderCount: bizOrders.length,
      branchCount: storeRows.filter((s: any) => String(s?.business_id || '') === id).length,
      productCount: prodRows.filter((p: any) => String(p?.business_id || '') === id).length,
      staffCount: localStaffCount,
      customerCount: custRows.filter((c: any) => String(c?.business_id || '') === id).length,
      lastActivityAt: lastOrderAt || String(b.created_at || ''),
    });
  }

  return map;
}

export async function fetchPlatformBusinesses(
  session: SuperAdminSession
): Promise<{
  businesses: PlatformBusinessRecord[];
  kpis: PlatformKpiSummary;
  cloudSynced: boolean;
}> {
  const merged = readLocalBusinessesSnapshot();
  let cloudSynced = false;

  const isOnline = await ensureFirestoreOnlineIfReachable();
  if (isOnline && auth.currentUser) {
    await ensureActiveSuperAdminFirebaseSession(session);
    const listPath = 'businesses';
    try {
      const bizSnap = await getDocs(collection(db, 'businesses'));
      cloudSynced = true;

      const cloudEntries = await Promise.all(
        bizSnap.docs.map(async (bizDoc) => {
          const id = bizDoc.id;
          const d = bizDoc.data();

          const [ordersSnap, storesSnap, productsSnap, membershipsSnap, customersSnap] = await Promise.all([
            getDocs(collection(db, 'businesses', id, 'orders')).catch(() => null),
            getDocs(collection(db, 'businesses', id, 'stores')).catch(() => null),
            getDocs(collection(db, 'businesses', id, 'products')).catch(() => null),
            getDocs(collection(db, 'businesses', id, 'memberships')).catch(() => null),
            getDocs(collection(db, 'businesses', id, 'customers')).catch(() => null),
          ]);

          let gmv = 0;
          let orderCount = 0;
          let lastOrderAt = '';
          if (ordersSnap) {
            orderCount = ordersSnap.size;
            for (const oDoc of ordersSnap.docs) {
              const o = oDoc.data();
              const st = String(o?.status || '').toLowerCase();
              if (st !== 'refunded' && st !== 'reversed') {
                gmv += Number(o?.total) || 0;
              }
              const dt = String(o?.orderDate || '');
              if (dt > lastOrderAt) lastOrderAt = dt;
            }
          }

          const localFallback = merged.get(id);
          const createdIso = formatFirestoreTimestamp(d.createdAt) || localFallback?.created_at || '';

          const record: PlatformBusinessRecord = {
            id,
            name: String(d.name || localFallback?.name || id),
            owner: String(d.owner || localFallback?.owner || 'Owner'),
            email: String(d.email || localFallback?.email || ''),
            billing_phone: String(d.billing_phone || localFallback?.billing_phone || ''),
            billing_email: String(d.billing_email || d.email || localFallback?.billing_email || ''),
            billing_address: String(d.billing_address || localFallback?.billing_address || ''),
            billing_city: String(d.billing_city || localFallback?.billing_city || ''),
            billing_country: String(d.billing_country || localFallback?.billing_country || ''),
            tpin: String(d.tpin || localFallback?.tpin || ''),
            currency: String(d.currency || localFallback?.currency || 'K'),
            status: String(d.status || 'ACTIVE').toUpperCase() === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
            suspended_reason: String(d.suspended_reason || ''),
            suspended_at: String(d.suspended_at || ''),
            suspended_by: String(d.suspended_by || ''),
            flagged_for_fraud: Boolean(d.flagged_for_fraud === true),
            fraud_flag_reason: String(d.fraud_flag_reason || ''),
            flagged_at: String(d.flagged_at || ''),
            plan_tier:
              String(d.plan_tier || 'PAID').toUpperCase() === 'TRIAL'
                ? 'TRIAL'
                : String(d.plan_tier || 'PAID').toUpperCase() === 'FREE'
                  ? 'FREE'
                  : 'PAID',
            subscription_status:
              String(d.subscription_status || 'ACTIVE').toUpperCase() === 'PAST_DUE'
                ? 'PAST_DUE'
                : String(d.subscription_status || 'ACTIVE').toUpperCase() === 'CANCELLED'
                  ? 'CANCELLED'
                  : 'ACTIVE',
            created_at: createdIso,
            ownerUid: String(d.ownerUid || ''),
            source: localFallback ? 'synced' : 'cloud',
            gmv: ordersSnap ? Math.max(gmv, localFallback?.gmv || 0) : (localFallback?.gmv || 0),
            orderCount: ordersSnap ? Math.max(orderCount, localFallback?.orderCount || 0) : (localFallback?.orderCount || 0),
            branchCount: storesSnap ? Math.max(storesSnap.size, localFallback?.branchCount || 0) : (localFallback?.branchCount || 0),
            productCount: productsSnap ? Math.max(productsSnap.size, localFallback?.productCount || 0) : (localFallback?.productCount || 0),
            staffCount: membershipsSnap ? Math.max(membershipsSnap.size, localFallback?.staffCount || 0) : (localFallback?.staffCount || 0),
            customerCount: customersSnap ? Math.max(customersSnap.size, localFallback?.customerCount || 0) : (localFallback?.customerCount || 0),
            lastActivityAt: lastOrderAt || formatFirestoreTimestamp(d.updatedAt) || createdIso,
          };

          return record;
        })
      );

      for (const entry of cloudEntries) {
        merged.set(entry.id, entry);
      }
    } catch (err: any) {
      if (!isSoftOfflineOrPermissionReadNotice(err)) {
        handleFirestoreError(err, OperationType.LIST, listPath);
      }
    }
  }

  const list = Array.from(merged.values()).sort((a, b) => {
    const tA = a.created_at || '';
    const tB = b.created_at || '';
    return tB.localeCompare(tA);
  });

  const kpis: PlatformKpiSummary = {
    totalBusinesses: list.length,
    activePaidShops: list.filter((b) => b.status === 'ACTIVE' && b.plan_tier === 'PAID').length,
    totalPlatformGmv: list.reduce((sum, b) => sum + (Number(b.gmv) || 0), 0),
    activeCount: list.filter((b) => b.status === 'ACTIVE').length,
    suspendedCount: list.filter((b) => b.status === 'SUSPENDED').length,
    flaggedFraudCount: list.filter((b) => b.flagged_for_fraud).length,
    totalOrders: list.reduce((sum, b) => sum + (Number(b.orderCount) || 0), 0),
  };

  return { businesses: list, kpis, cloudSynced };
}

async function recordPlatformAuditLog(params: {
  action: PlatformAuditAction;
  businessId: string;
  businessName: string;
  reason: string;
  session: SuperAdminSession;
  metadata?: Record<string, any>;
}): Promise<PlatformAuditLogEntry> {
  const nowIso = new Date().toISOString();
  const safeBizId = sanitizeIdForFirestore(params.businessId, 'biz');
  const logId = sanitizeIdForFirestore(
    `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    'audit'
  );
  const uid = auth.currentUser?.uid || params.session.uid;

  const entry: PlatformAuditLogEntry = {
    id: logId,
    action: params.action,
    target_business_id: safeBizId,
    target_business_name: String(params.businessName || safeBizId).slice(0, 200),
    reason: String(params.reason || 'Administrative moderation action').slice(0, 1000),
    performed_by_uid: String(uid).slice(0, 128),
    performed_by_email: String(params.session.email || SUPER_ADMIN_EMAIL).slice(0, 200),
    metadata_json: JSON.stringify(params.metadata || {}).slice(0, 4000),
    timestamp: nowIso,
  };

  appendLocalAuditCache(entry);

  const isOnline = await ensureFirestoreOnlineIfReachable();
  if (isOnline && auth.currentUser) {
    await ensureActiveSuperAdminFirebaseSession(params.session);
    const logPath = `platform_audit_logs/${logId}`;
    try {
      await setDoc(doc(db, 'platform_audit_logs', logId), {
        ...entry,
        performed_by_uid: auth.currentUser.uid,
        createdAt: serverTimestamp(),
      });
    } catch (err: any) {
      if (!isSoftOfflineOrPermissionReadNotice(err)) {
        handleFirestoreError(err, OperationType.CREATE, logPath);
      }
    }
  }

  return entry;
}

export async function fetchPlatformAuditLogs(
  session: SuperAdminSession
): Promise<PlatformAuditLogEntry[]> {
  const byId = new Map<string, PlatformAuditLogEntry>();
  for (const localEntry of readLocalAuditCache()) {
    if (localEntry?.id) byId.set(localEntry.id, localEntry);
  }

  const isOnline = await ensureFirestoreOnlineIfReachable();
  if (isOnline && auth.currentUser) {
    await ensureActiveSuperAdminFirebaseSession(session);
    const logsPath = 'platform_audit_logs';
    try {
      const snap = await getDocs(collection(db, 'platform_audit_logs'));
      for (const d of snap.docs) {
        const data = d.data();
        byId.set(d.id, {
          id: d.id,
          action: data.action as PlatformAuditAction,
          target_business_id: String(data.target_business_id || ''),
          target_business_name: String(data.target_business_name || ''),
          reason: String(data.reason || ''),
          performed_by_uid: String(data.performed_by_uid || ''),
          performed_by_email: String(data.performed_by_email || SUPER_ADMIN_EMAIL),
          metadata_json: String(data.metadata_json || '{}'),
          timestamp: String(data.timestamp || formatFirestoreTimestamp(data.createdAt) || ''),
        });
      }
    } catch (err: any) {
      if (!isSoftOfflineOrPermissionReadNotice(err)) {
        handleFirestoreError(err, OperationType.LIST, logsPath);
      }
    }
  }

  return Array.from(byId.values()).sort((a, b) =>
    String(b.timestamp || '').localeCompare(String(a.timestamp || ''))
  );
}

function updateLocalBusinessModerationFields(
  businessId: string,
  updates: Record<string, string | number>
) {
  const setClauses = Object.entries(updates)
    .map(([col, val]) =>
      typeof val === 'number' ? `${col} = ${val}` : `${col} = '${sqlEsc(String(val))}'`
    )
    .join(', ');
  if (!setClauses) return;
  runSql(
    `UPDATE businesses SET ${setClauses} WHERE id = '${sqlEsc(businessId)}'`,
    'Super Admin: Update local business moderation fields',
    true
  );
  persistTablesToStorage(true);
}

export async function suspendBusinessAccount(
  business: PlatformBusinessRecord,
  reason: string,
  session: SuperAdminSession
): Promise<void> {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    throw new Error('A suspension reason is required.');
  }

  const nowIso = new Date().toISOString();
  const safeBizId = sanitizeIdForFirestore(business.id, 'biz');

  const isOnline = await ensureFirestoreOnlineIfReachable();
  if (isOnline && auth.currentUser) {
    await ensureActiveSuperAdminFirebaseSession(session);
    const bizPath = `businesses/${safeBizId}`;
    try {
      const bizRef = doc(db, 'businesses', safeBizId);
      const snap = await getDoc(bizRef);
      if (snap.exists()) {
        await updateDoc(bizRef, {
          status: 'SUSPENDED',
          suspended_reason: cleanReason.slice(0, 1000),
          suspended_at: nowIso,
          suspended_by: session.email.slice(0, 200),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err: any) {
      if (!isSoftOfflineOrPermissionReadNotice(err)) {
        handleFirestoreError(err, OperationType.UPDATE, bizPath);
      }
    }
  }

  updateLocalBusinessModerationFields(business.id, {
    status: 'SUSPENDED',
    suspended_reason: cleanReason,
    suspended_at: nowIso,
    suspended_by: session.email,
  });

  await recordPlatformAuditLog({
    action: 'SUSPEND_BUSINESS',
    businessId: business.id,
    businessName: business.name,
    reason: cleanReason,
    session,
    metadata: { previousStatus: business.status, ownerEmail: business.email },
  });
}

export async function restoreBusinessAccount(
  business: PlatformBusinessRecord,
  reason: string,
  session: SuperAdminSession
): Promise<void> {
  const cleanReason = String(reason || 'Account reviewed and restored by Super Admin').trim();
  const safeBizId = sanitizeIdForFirestore(business.id, 'biz');

  const isOnline = await ensureFirestoreOnlineIfReachable();
  if (isOnline && auth.currentUser) {
    await ensureActiveSuperAdminFirebaseSession(session);
    const bizPath = `businesses/${safeBizId}`;
    try {
      const bizRef = doc(db, 'businesses', safeBizId);
      const snap = await getDoc(bizRef);
      if (snap.exists()) {
        await updateDoc(bizRef, {
          status: 'ACTIVE',
          suspended_reason: '',
          suspended_at: '',
          suspended_by: '',
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err: any) {
      if (!isSoftOfflineOrPermissionReadNotice(err)) {
        handleFirestoreError(err, OperationType.UPDATE, bizPath);
      }
    }
  }

  updateLocalBusinessModerationFields(business.id, {
    status: 'ACTIVE',
    suspended_reason: '',
    suspended_at: '',
    suspended_by: '',
  });

  await recordPlatformAuditLog({
    action: 'RESTORE_BUSINESS',
    businessId: business.id,
    businessName: business.name,
    reason: cleanReason,
    session,
    metadata: { previousStatus: business.status, previousReason: business.suspended_reason },
  });
}

export async function setBusinessFraudFlag(
  business: PlatformBusinessRecord,
  flagged: boolean,
  reason: string,
  session: SuperAdminSession
): Promise<void> {
  const cleanReason = String(reason || '').trim();
  if (flagged && !cleanReason) {
    throw new Error('Please specify a fraud investigation reason.');
  }
  const finalReason = cleanReason || (flagged ? 'Flagged for fraud review' : 'Fraud flag cleared after review');
  const nowIso = new Date().toISOString();
  const safeBizId = sanitizeIdForFirestore(business.id, 'biz');

  const isOnline = await ensureFirestoreOnlineIfReachable();
  if (isOnline && auth.currentUser) {
    await ensureActiveSuperAdminFirebaseSession(session);
    const bizPath = `businesses/${safeBizId}`;
    try {
      const bizRef = doc(db, 'businesses', safeBizId);
      const snap = await getDoc(bizRef);
      if (snap.exists()) {
        await updateDoc(bizRef, {
          flagged_for_fraud: flagged,
          fraud_flag_reason: flagged ? finalReason.slice(0, 1000) : '',
          flagged_at: flagged ? nowIso : '',
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err: any) {
      if (!isSoftOfflineOrPermissionReadNotice(err)) {
        handleFirestoreError(err, OperationType.UPDATE, bizPath);
      }
    }
  }

  updateLocalBusinessModerationFields(business.id, {
    flagged_for_fraud: flagged ? 1 : 0,
    fraud_flag_reason: flagged ? finalReason : '',
    flagged_at: flagged ? nowIso : '',
  });

  await recordPlatformAuditLog({
    action: flagged ? 'FLAG_FRAUD' : 'CLEAR_FRAUD',
    businessId: business.id,
    businessName: business.name,
    reason: finalReason,
    session,
    metadata: { flagged },
  });
}

export async function updateBusinessPlanTier(
  business: PlatformBusinessRecord,
  planTier: PlanTier,
  session: SuperAdminSession
): Promise<void> {
  const safeBizId = sanitizeIdForFirestore(business.id, 'biz');
  const reason = `Subscription plan updated from ${business.plan_tier} to ${planTier}`;

  const isOnline = await ensureFirestoreOnlineIfReachable();
  if (isOnline && auth.currentUser) {
    await ensureActiveSuperAdminFirebaseSession(session);
    const bizPath = `businesses/${safeBizId}`;
    try {
      const bizRef = doc(db, 'businesses', safeBizId);
      const snap = await getDoc(bizRef);
      if (snap.exists()) {
        await updateDoc(bizRef, {
          plan_tier: planTier,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err: any) {
      if (!isSoftOfflineOrPermissionReadNotice(err)) {
        handleFirestoreError(err, OperationType.UPDATE, bizPath);
      }
    }
  }

  updateLocalBusinessModerationFields(business.id, {
    plan_tier: planTier,
  });

  await recordPlatformAuditLog({
    action: 'UPDATE_PLAN',
    businessId: business.id,
    businessName: business.name,
    reason,
    session,
    metadata: { previousPlan: business.plan_tier, newPlan: planTier },
  });
}

export async function hardDeleteBusinessAccount(
  business: PlatformBusinessRecord,
  typedBusinessName: string,
  reason: string,
  session: SuperAdminSession
): Promise<void> {
  if (business.status !== 'SUSPENDED' && !business.flagged_for_fraud) {
    throw new Error('Permanent deletion is restricted to Suspended or Fraud-Flagged businesses only.');
  }

  if (typedBusinessName.trim() !== business.name.trim()) {
    throw new Error(`Confirmation mismatch: please type "${business.name}" verbatim.`);
  }

  const finalReason =
    String(reason || '').trim() ||
    `Permanently hard-deleted (${business.status === 'SUSPENDED' ? 'Suspended' : 'Flagged for Fraud'})`;
  const safeBizId = sanitizeIdForFirestore(business.id, 'biz');

  // 1. Write immutable audit log FIRST so record survives deletion of business documents
  await recordPlatformAuditLog({
    action: 'HARD_DELETE_BUSINESS',
    businessId: business.id,
    businessName: business.name,
    reason: finalReason,
    session,
    metadata: {
      ownerEmail: business.email,
      gmvAtDeletion: business.gmv,
      ordersAtDeletion: business.orderCount,
      wasSuspended: business.status === 'SUSPENDED',
      wasFraudFlagged: business.flagged_for_fraud,
    },
  });

  // 2. Cascade-delete Firestore subcollections, credential_directory links, and parent business doc
  const isOnline = await ensureFirestoreOnlineIfReachable();
  if (isOnline && auth.currentUser) {
    await ensureActiveSuperAdminFirebaseSession(session);
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

    for (const sub of subcollections) {
      const subPath = `businesses/${safeBizId}/${sub}`;
      try {
        const subSnap = await getDocs(collection(db, 'businesses', safeBizId, sub));
        await Promise.all(
          subSnap.docs.map((d) =>
            deleteDoc(doc(db, 'businesses', safeBizId, sub, d.id)).catch((err) => {
              if (!isSoftOfflineOrPermissionReadNotice(err)) {
                handleFirestoreError(err, OperationType.DELETE, `${subPath}/${d.id}`);
              }
            })
          )
        );
      } catch (err: any) {
        if (!isSoftOfflineOrPermissionReadNotice(err)) {
          handleFirestoreError(err, OperationType.LIST, subPath);
        }
      }
    }

    // Delete credential_directory entries pointing to this business
    try {
      const credSnap = await getDocs(
        query(collection(db, 'credential_directory'), where('business_id', '==', safeBizId))
      );
      await Promise.all(
        credSnap.docs.map((d) =>
          deleteDoc(doc(db, 'credential_directory', d.id)).catch(() => {})
        )
      );
    } catch {}

    // Delete parent business document
    const bizPath = `businesses/${safeBizId}`;
    try {
      const bizSnap = await getDoc(doc(db, 'businesses', safeBizId));
      if (bizSnap.exists()) {
        await deleteDoc(doc(db, 'businesses', safeBizId));
      }
    } catch (err: any) {
      if (!isSoftOfflineOrPermissionReadNotice(err)) {
        handleFirestoreError(err, OperationType.DELETE, bizPath);
      }
    }
  }

  // 3. Purge tenant rows from local SQL storage cleanly without touching other tenants
  for (const tbl of ALL_TABLE_NAMES) {
    if (tbl === 'businesses') {
      runSql(`DELETE FROM businesses WHERE id = '${sqlEsc(business.id)}'`, 'Hard Delete: Purge local business row', true);
    } else if (tbl !== 'accounts') {
      runSql(
        `DELETE FROM ${tbl} WHERE business_id = '${sqlEsc(business.id)}'`,
        `Hard Delete: Purge local ${tbl} rows`,
        true
      );
    }
  }
  persistTablesToStorage(true);
}
