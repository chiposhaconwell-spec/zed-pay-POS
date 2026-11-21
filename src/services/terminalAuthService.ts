import {
  collection,
  deleteDoc,
  doc,
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
  handleFirestoreError,
  OperationType,
  restoreFromCloud,
  signInWithEmailPasswordAccount,
} from '../firebase';
import { persistTablesToStorage, pullDatabaseFromServer, runSql, sqlEsc } from '../db';

// ============================================================================
// TWO-TIER POS TERMINAL AUTHENTICATION DATA STRUCTURES
// ============================================================================

export interface BusinessSession {
  businessId: string;
  businessName: string;
  ownerEmail: string;
  isDeviceAuthorized: boolean;
}

export interface StaffMember {
  id: string;
  businessId: string;
  name: string;
  role: 'manager' | 'cashier';
  pin: string; // Strictly 4-digit numeric string, unique within businessId
  isActive: boolean;
  // Constraint: Cashiers must NOT have an email field.
}

export interface ActiveShift {
  cashierId: string;
  cashierName: string;
  role: 'manager' | 'cashier';
  startedAt: string;
}

export const BUSINESS_SESSION_STORAGE_KEY = 'pos_business_session';
export const ACTIVE_SHIFT_STORAGE_KEY = 'pos_active_shift';
const STAFF_ROSTER_CACHE_PREFIX = 'pos_staff_pin_roster_';

function isOfflineOrNetworkError(err: any): boolean {
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();
  return (
    code.includes('network-request-failed') ||
    code === 'unavailable' ||
    msg.includes('network-request-failed') ||
    msg.includes('the client is offline') ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('could not reach cloud firestore')
  );
}

function sanitizeId(raw: string, prefix = 'staff'): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_\-]/g, '_');
  return cleaned ? cleaned.slice(0, 120) : `${prefix}_${Date.now()}`;
}

export function isValidFourDigitPin(pin: string): boolean {
  return /^\d{4}$/.test(String(pin || '').trim());
}

// ============================================================================
// BUSINESS SESSION PERSISTENCE (Tier 1 Device Authorization)
// ============================================================================

export function getBusinessSession(): BusinessSession | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(BUSINESS_SESSION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.businessId && parsed?.isDeviceAuthorized) {
        return {
          businessId: String(parsed.businessId),
          businessName: String(parsed.businessName || ''),
          ownerEmail: String(parsed.ownerEmail || ''),
          isDeviceAuthorized: Boolean(parsed.isDeviceAuthorized),
        };
      }
    }
    // Seamless backward compatibility if pos_authenticated_session already exists
    if (localStorage.getItem('pos_authenticated_session') === 'true') {
      const bizRaw = localStorage.getItem('active_business_profile');
      if (bizRaw) {
        const biz = JSON.parse(bizRaw);
        if (biz?.id) {
          return {
            businessId: String(biz.id),
            businessName: String(biz.name || ''),
            ownerEmail: String(biz.email || localStorage.getItem('logged_in_user_email') || ''),
            isDeviceAuthorized: true,
          };
        }
      }
    }
  } catch {}
  return null;
}

export function saveBusinessSession(session: BusinessSession): BusinessSession {
  const cleanSession: BusinessSession = {
    businessId: String(session.businessId || '').trim(),
    businessName: String(session.businessName || '').trim(),
    ownerEmail: String(session.ownerEmail || '').trim().toLowerCase(),
    isDeviceAuthorized: Boolean(session.isDeviceAuthorized),
  };
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(BUSINESS_SESSION_STORAGE_KEY, JSON.stringify(cleanSession));
  }
  return cleanSession;
}

export function clearBusinessSession(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(BUSINESS_SESSION_STORAGE_KEY);
  localStorage.removeItem(ACTIVE_SHIFT_STORAGE_KEY);
}

export function clearActiveShiftStorage(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(ACTIVE_SHIFT_STORAGE_KEY);
}

// ============================================================================
// LOCAL CACHE & SQL ROSTER SYNC HELPERS (OFFLINE-FIRST READY)
// ============================================================================

function saveStaffRosterToLocalCache(businessId: string, roster: StaffMember[]) {
  if (!businessId) return;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(`${STAFF_ROSTER_CACHE_PREFIX}${businessId}`, JSON.stringify(roster));
    } catch {}
  }
}

function readStaffRosterFromLocalCache(businessId: string): StaffMember[] {
  if (!businessId || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`${STAFF_ROSTER_CACHE_PREFIX}${businessId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && item.id && isValidFourDigitPin(String(item.pin || '')))
      .map((item) => ({
        id: String(item.id),
        businessId: String(item.businessId || businessId),
        name: String(item.name || 'Cashier').trim(),
        role: item.role === 'manager' ? 'manager' : 'cashier',
        pin: String(item.pin).trim(),
        isActive: item.isActive !== false,
      }));
  } catch {
    return [];
  }
}

function upsertStaffMemberInLocalSql(member: StaffMember) {
  const sqlRole = member.role === 'manager' ? 'manager' : 'sales';
  const activeFlag = member.isActive ? 1 : 0;
  const safeId = sqlEsc(member.id);
  const safeBiz = sqlEsc(member.businessId);
  const safeName = sqlEsc(member.name);
  const safePin = sqlEsc(member.pin);

  const existing = runSql(
    `SELECT id FROM staff WHERE id = '${safeId}' AND business_id = '${safeBiz}' LIMIT 1`,
    'TerminalAuth: Check local staff record',
    true
  );

  if (existing.success && Array.isArray(existing.data) && existing.data.length > 0) {
    runSql(
      `UPDATE staff SET name = '${safeName}', role = '${sqlRole}', pin = '${safePin}', email = '', is_active = ${activeFlag} WHERE id = '${safeId}' AND business_id = '${safeBiz}'`,
      'TerminalAuth: Update PIN staff row',
      true
    );
  } else {
    runSql(
      `INSERT INTO staff (id, name, role, hourly_rate, pin, store_id, email, business_id, password, is_active) VALUES (
        '${safeId}',
        '${safeName}',
        '${sqlRole}',
        0,
        '${safePin}',
        '',
        '',
        '${safeBiz}',
        '',
        ${activeFlag}
      )`,
      'TerminalAuth: Insert PIN staff row',
      true
    );
  }
  persistTablesToStorage(true);
}

export function getLocalStaffMembers(businessId: string): StaffMember[] {
  const cleanBiz = String(businessId || '').trim();
  if (!cleanBiz) return [];

  const mergedMap = new Map<string, StaffMember>();

  // 1. Cached PIN roster
  for (const cached of readStaffRosterFromLocalCache(cleanBiz)) {
    mergedMap.set(cached.id, cached);
  }

  // 2. AlaSQL staff table (include PIN-enabled cashiers & managers without requiring email)
  const sqlRes = runSql(
    `SELECT id, name, role, pin, business_id, is_active, permissions_json FROM staff WHERE business_id = '${sqlEsc(cleanBiz)}'`,
    'TerminalAuth: Read local SQL staff roster',
    true
  );

  if (sqlRes.success && Array.isArray(sqlRes.data)) {
    for (const row of sqlRes.data) {
      const pinStr = String(row.pin || '').trim();
      if (!isValidFourDigitPin(pinStr)) continue;
      const rowRoleRaw = String(row.role || '').toLowerCase();
      if (rowRoleRaw === 'owner') continue;
      let isSuspended = false;
      try {
        if (row.permissions_json) {
          const parsedPerms = JSON.parse(row.permissions_json);
          isSuspended = Boolean(parsedPerms?.suspended);
        }
      } catch {}
      const isRowActive =
        row.is_active === undefined || row.is_active === null
          ? !isSuspended
          : Number(row.is_active) !== 0 && !isSuspended;

      const member: StaffMember = {
        id: String(row.id),
        businessId: cleanBiz,
        name: String(row.name || 'Cashier').trim(),
        role: rowRoleRaw === 'manager' ? 'manager' : 'cashier',
        pin: pinStr,
        isActive: isRowActive,
      };
      mergedMap.set(member.id, member);
    }
  }

  return Array.from(mergedMap.values());
}

// ============================================================================
// MODULAR AUTHENTICATION & POS PIN API SERVICE (Firebase + Local Fallback)
// ============================================================================

/**
 * Tier 1: Owner/Manager Email & Password login to authorize the device for a business.
 */
export async function loginOwner(
  email: string,
  password: string
): Promise<{ session: BusinessSession; business: any }> {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPassword = String(password || '').trim();
  if (!cleanEmail || !cleanPassword) {
    throw new Error('Please provide your Owner/Manager email and password.');
  }

  // 1. Check local SQL businesses first (0ms) so returning devices don't wait on Cloud SQL before signing in
  let bizRes = runSql('SELECT * FROM businesses', 'TerminalAuth: Lookup business', true);
  let bizList: any[] = bizRes.success && Array.isArray(bizRes.data) ? bizRes.data : [];
  let matchedBiz = bizList.find((b) => String(b?.email || '').trim().toLowerCase() === cleanEmail);

  const locallyVerified = Boolean(
    matchedBiz && (!matchedBiz.password || matchedBiz.password === cleanPassword)
  );

  if (locallyVerified) {
    try {
      await Promise.race([
        signInWithEmailPasswordAccount(cleanEmail, cleanPassword, true, matchedBiz?.owner),
        new Promise<void>((resolve) => setTimeout(resolve, 3500)),
      ]);
    } catch {
      // Allow local offline access when locally verified
    }
  } else {
    // Fresh device: run Cloud SQL pull & Firebase Auth in parallel
    const [, authSettled] = await Promise.allSettled([
      pullDatabaseFromServer(undefined, cleanEmail, undefined, { timeoutMs: 3500 }).catch(() => null),
      signInWithEmailPasswordAccount(cleanEmail, cleanPassword, false, matchedBiz?.owner),
    ]);

    bizRes = runSql('SELECT * FROM businesses', 'TerminalAuth: Lookup business after pull', true);
    bizList = bizRes.success && Array.isArray(bizRes.data) ? bizRes.data : [];
    matchedBiz = bizList.find((b) => String(b?.email || '').trim().toLowerCase() === cleanEmail);

    const verifiedAfterPull = Boolean(
      matchedBiz && (!matchedBiz.password || matchedBiz.password === cleanPassword)
    );

    if (authSettled.status === 'rejected' && !verifiedAfterPull) {
      const authErr: any = authSettled.reason;
      throw new Error(authErr?.message || 'Invalid email or password.');
    }

    if (auth.currentUser && !matchedBiz) {
      await restoreFromCloud(undefined, { silentIfUnlinked: true }).catch(() => null);
      bizRes = runSql('SELECT * FROM businesses', 'TerminalAuth: Reload business after restore', true);
      bizList = bizRes.success && Array.isArray(bizRes.data) ? bizRes.data : [];
      matchedBiz =
        bizList.find((b) => String(b?.email || '').trim().toLowerCase() === cleanEmail) || bizList[0];
    }
  }

  if (!matchedBiz) {
    throw new Error(`No registered business found for ${cleanEmail}.`);
  }

  if (
    matchedBiz.password &&
    matchedBiz.password !== 'cloud_recovered' &&
    matchedBiz.password !== cleanPassword
  ) {
    throw new Error('Invalid password for this business account.');
  }

  const session = saveBusinessSession({
    businessId: String(matchedBiz.id),
    businessName: String(matchedBiz.name || 'Retail POS'),
    ownerEmail: String(matchedBiz.email || cleanEmail).toLowerCase(),
    isDeviceAuthorized: true,
  });

  clearActiveShiftStorage();

  // Refresh staff roster & latest cloud data in background so terminal authorizes immediately
  void (async () => {
    try {
      await fetchStaffMembers(session.businessId).catch(() => []);
      if (locallyVerified && navigator.onLine !== false) {
        await pullDatabaseFromServer(undefined, cleanEmail, undefined, { timeoutMs: 5000 }).catch(
          () => null
        );
        if (auth.currentUser) {
          await restoreFromCloud(session.businessId, { silentIfUnlinked: true }).catch(() => null);
        }
      }
    } catch {}
  })();

  return { session, business: matchedBiz };
}

/**
 * Fetch PIN-authenticated cashiers & managers scoped strictly to `businessId`.
 */
export async function fetchStaffMembers(businessId: string): Promise<StaffMember[]> {
  const safeBizId = sanitizeId(businessId, 'biz');
  const localFallback = getLocalStaffMembers(businessId);

  if (!auth.currentUser) {
    return localFallback;
  }

  const staffPath = `businesses/${safeBizId}/staff`;
  try {
    const snap = await getDocs(
      query(
        collection(db, 'businesses', safeBizId, 'staff'),
        where('ownerUid', '==', auth.currentUser.uid),
        where('businessId', '==', safeBizId)
      )
    );

    const remoteList: StaffMember[] = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const pin = String(d.pin || '').trim();
      if (!isValidFourDigitPin(pin)) return;
      const member: StaffMember = {
        id: String(d.id || docSnap.id),
        businessId: String(d.businessId || safeBizId),
        name: String(d.name || 'Cashier').trim(),
        role: d.role === 'manager' ? 'manager' : 'cashier',
        pin,
        isActive: d.isActive !== false,
      };
      remoteList.push(member);
      upsertStaffMemberInLocalSql(member);
    });

    if (remoteList.length > 0 || snap.metadata.fromCache === false) {
      saveStaffRosterToLocalCache(businessId, remoteList);
      return remoteList;
    }
    return localFallback;
  } catch (err: any) {
    if (isOfflineOrNetworkError(err)) {
      return localFallback;
    }
    handleFirestoreError(err, OperationType.LIST, staffPath);
    return localFallback;
  }
}

/**
 * Create a new cashier or manager with a unique 4-digit PIN within `businessId`.
 * Constraint: Cashiers must NOT have an email field.
 */
export async function createCashier(input: {
  businessId: string;
  name: string;
  pin: string;
  role?: 'manager' | 'cashier';
}): Promise<StaffMember> {
  if ('email' in (input as any) && (input as any).email) {
    throw new Error('Security rule violation: Cashiers must not have an email address.');
  }

  const cleanBizId = String(input.businessId || '').trim();
  if (!cleanBizId) {
    throw new Error('Active Business ID is required before adding a cashier.');
  }

  const cleanName = String(input.name || '').trim();
  if (!cleanName) {
    throw new Error('Please enter the staff member name.');
  }

  const cleanPin = String(input.pin || '').trim();
  if (!isValidFourDigitPin(cleanPin)) {
    throw new Error('PIN must be exactly 4 numeric digits (0000–9999).');
  }

  const cleanRole: 'manager' | 'cashier' = input.role === 'manager' ? 'manager' : 'cashier';

  // Ensure uniqueness of 4-digit PIN within the same businessId
  const currentRoster = await fetchStaffMembers(cleanBizId).catch(() => getLocalStaffMembers(cleanBizId));
  const duplicatePin = currentRoster.find((m) => m.pin === cleanPin);
  if (duplicatePin) {
    throw new Error(`PIN ${cleanPin} is already assigned to "${duplicatePin.name}". Every PIN must be unique within this business.`);
  }

  const staffId = sanitizeId(`staff_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`, 'staff');
  const newMember: StaffMember = {
    id: staffId,
    businessId: cleanBizId,
    name: cleanName,
    role: cleanRole,
    pin: cleanPin,
    isActive: true,
  };

  // Persist to Firestore /businesses/{businessId}/staff/{staffId} (strictly NO email field)
  const safeBizId = sanitizeId(cleanBizId, 'biz');
  if (auth.currentUser) {
    const docPath = `businesses/${safeBizId}/staff/${staffId}`;
    const firestorePayload = {
      id: staffId,
      businessId: safeBizId,
      ownerUid: auth.currentUser.uid,
      name: cleanName.slice(0, 200),
      role: cleanRole,
      pin: cleanPin,
      isActive: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    try {
      await setDoc(doc(db, 'businesses', safeBizId, 'staff', staffId), firestorePayload);
    } catch (err: any) {
      if (!isOfflineOrNetworkError(err)) {
        handleFirestoreError(err, OperationType.CREATE, docPath);
      }
    }
  }

  // Persist to local AlaSQL & offline cache
  upsertStaffMemberInLocalSql(newMember);
  const nextRoster = [...currentRoster.filter((m) => m.id !== newMember.id), newMember];
  saveStaffRosterToLocalCache(cleanBizId, nextRoster);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('pos_data_updated'));
  }

  return newMember;
}

/**
 * Toggle cashier/manager active status (`isActive`).
 */
export async function toggleCashierStatus(
  businessId: string,
  staffId: string,
  isActive: boolean
): Promise<StaffMember> {
  const cleanBizId = String(businessId || '').trim();
  const safeBizId = sanitizeId(cleanBizId, 'biz');
  const safeStaffId = sanitizeId(staffId, 'staff');

  const roster = getLocalStaffMembers(cleanBizId);
  const target = roster.find((m) => m.id === staffId || m.id === safeStaffId);
  if (!target) {
    throw new Error('Staff member record not found.');
  }

  const updated: StaffMember = { ...target, isActive: Boolean(isActive) };

  if (auth.currentUser) {
    const docPath = `businesses/${safeBizId}/staff/${safeStaffId}`;
    try {
      await updateDoc(doc(db, 'businesses', safeBizId, 'staff', safeStaffId), {
        isActive: updated.isActive,
        updatedAt: serverTimestamp(),
      });
    } catch (err: any) {
      if (!isOfflineOrNetworkError(err)) {
        handleFirestoreError(err, OperationType.UPDATE, docPath);
      }
    }
  }

  upsertStaffMemberInLocalSql(updated);
  saveStaffRosterToLocalCache(
    cleanBizId,
    roster.map((m) => (m.id === updated.id ? updated : m))
  );

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('pos_data_updated'));
  }

  return updated;
}

/**
 * Reset a cashier or manager's 4-digit PIN (enforcing uniqueness within businessId).
 */
export async function resetCashierPin(
  businessId: string,
  staffId: string,
  newPin: string
): Promise<StaffMember> {
  const cleanBizId = String(businessId || '').trim();
  const cleanPin = String(newPin || '').trim();
  if (!isValidFourDigitPin(cleanPin)) {
    throw new Error('New PIN must be exactly 4 numeric digits.');
  }

  const roster = await fetchStaffMembers(cleanBizId).catch(() => getLocalStaffMembers(cleanBizId));
  const target = roster.find((m) => m.id === staffId);
  if (!target) {
    throw new Error('Staff member record not found.');
  }

  const conflict = roster.find((m) => m.id !== staffId && m.pin === cleanPin);
  if (conflict) {
    throw new Error(`PIN ${cleanPin} is already used by "${conflict.name}". Choose a unique 4-digit PIN.`);
  }

  const updated: StaffMember = { ...target, pin: cleanPin };
  const safeBizId = sanitizeId(cleanBizId, 'biz');
  const safeStaffId = sanitizeId(staffId, 'staff');

  if (auth.currentUser) {
    const docPath = `businesses/${safeBizId}/staff/${safeStaffId}`;
    try {
      await updateDoc(doc(db, 'businesses', safeBizId, 'staff', safeStaffId), {
        pin: cleanPin,
        updatedAt: serverTimestamp(),
      });
    } catch (err: any) {
      if (!isOfflineOrNetworkError(err)) {
        handleFirestoreError(err, OperationType.UPDATE, docPath);
      }
    }
  }

  upsertStaffMemberInLocalSql(updated);
  saveStaffRosterToLocalCache(
    cleanBizId,
    roster.map((m) => (m.id === updated.id ? updated : m))
  );

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('pos_data_updated'));
  }

  return updated;
}

/**
 * Delete a PIN-authenticated cashier or manager.
 */
export async function deleteCashier(businessId: string, staffId: string): Promise<void> {
  const cleanBizId = String(businessId || '').trim();
  const safeBizId = sanitizeId(cleanBizId, 'biz');
  const safeStaffId = sanitizeId(staffId, 'staff');

  if (auth.currentUser) {
    const docPath = `businesses/${safeBizId}/staff/${safeStaffId}`;
    try {
      await deleteDoc(doc(db, 'businesses', safeBizId, 'staff', safeStaffId));
    } catch (err: any) {
      if (!isOfflineOrNetworkError(err)) {
        handleFirestoreError(err, OperationType.DELETE, docPath);
      }
    }
  }

  runSql(
    `DELETE FROM staff WHERE id = '${sqlEsc(staffId)}' AND business_id = '${sqlEsc(cleanBizId)}'`,
    'TerminalAuth: Delete staff member',
    true
  );
  persistTablesToStorage(true);

  const remaining = getLocalStaffMembers(cleanBizId).filter((m) => m.id !== staffId);
  saveStaffRosterToLocalCache(cleanBizId, remaining);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('pos_data_updated'));
  }
}

/**
 * Tier 2: Verify a 4-digit Cashier/Manager PIN and create an ActiveShift.
 */
export async function verifyCashierPin(businessId: string, pin: string): Promise<ActiveShift> {
  const cleanBizId = String(businessId || '').trim();
  const cleanPin = String(pin || '').trim();

  if (!cleanBizId) {
    throw new Error('Device is not authorized for a business.');
  }
  if (!isValidFourDigitPin(cleanPin)) {
    throw new Error('Invalid PIN');
  }

  // Fast offline-first check first, then refresh from Firestore if online & not found locally
  let roster = getLocalStaffMembers(cleanBizId);
  let matched = roster.find((m) => m.pin === cleanPin);

  if (!matched && auth.currentUser && navigator.onLine !== false) {
    roster = await fetchStaffMembers(cleanBizId).catch(() => roster);
    matched = roster.find((m) => m.pin === cleanPin);
  }

  if (!matched || !matched.isActive) {
    throw new Error('Invalid PIN');
  }

  return {
    cashierId: matched.id,
    cashierName: matched.name,
    role: matched.role,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Verify Owner/Manager Email Password OR an active Manager 4-digit PIN before returning to Admin Dashboard.
 */
export async function verifyAdminUnlock(params: {
  businessId: string;
  ownerEmail: string;
  mode: 'password' | 'pin';
  password?: string;
  pin?: string;
}): Promise<{ ok: boolean; verifiedBy: string; role: 'owner' | 'manager'; error?: string }> {
  const cleanBizId = String(params.businessId || '').trim();
  const cleanEmail = String(params.ownerEmail || '').trim().toLowerCase();

  if (params.mode === 'pin') {
    const cleanPin = String(params.pin || '').trim();
    if (!isValidFourDigitPin(cleanPin)) {
      return { ok: false, verifiedBy: '', role: 'manager', error: 'Enter a valid 4-digit Manager PIN.' };
    }
    let roster = getLocalStaffMembers(cleanBizId);
    if (!roster.some((m) => m.role === 'manager' && m.pin === cleanPin) && auth.currentUser && navigator.onLine !== false) {
      roster = await fetchStaffMembers(cleanBizId).catch(() => roster);
    }
    const managerMatch = roster.find(
      (m) => m.role === 'manager' && m.isActive && m.pin === cleanPin
    );
    if (!managerMatch) {
      return {
        ok: false,
        verifiedBy: '',
        role: 'manager',
        error: 'Invalid Manager PIN. Only active managers can unlock Admin Access by PIN.',
      };
    }
    return { ok: true, verifiedBy: managerMatch.name, role: 'manager' };
  }

  // Mode: Owner / Manager Email Password
  const cleanPassword = String(params.password || '').trim();
  if (!cleanPassword) {
    return { ok: false, verifiedBy: '', role: 'owner', error: 'Please enter the Owner/Manager password.' };
  }

  // 1. Verify against local SQL businesses table first (supports offline verification cleanly)
  const bizRes = cleanBizId
    ? runSql(
        `SELECT email, owner, password FROM businesses WHERE id = '${sqlEsc(cleanBizId)}' LIMIT 1`,
        'TerminalAuth: Verify local owner password',
        true
      )
    : { success: false, data: [] };
  const bizRow = bizRes.success && Array.isArray(bizRes.data) ? bizRes.data[0] : null;
  if (bizRow?.password && bizRow.password !== 'cloud_recovered') {
    if (bizRow.password === cleanPassword) {
      return { ok: true, verifiedBy: String(bizRow.owner || cleanEmail || 'Owner'), role: 'owner' };
    }
    if (navigator.onLine === false) {
      return { ok: false, verifiedBy: '', role: 'owner', error: 'Invalid Owner/Manager password.' };
    }
  }

  // 2. Verify with Firebase Auth when online
  const targetEmail = cleanEmail || String(bizRow?.email || auth.currentUser?.email || '').trim().toLowerCase();
  if (!targetEmail) {
    return { ok: false, verifiedBy: '', role: 'owner', error: 'Owner email could not be resolved.' };
  }

  try {
    await signInWithEmailPasswordAccount(targetEmail, cleanPassword, false);
    return {
      ok: true,
      verifiedBy: String(bizRow?.owner || auth.currentUser?.displayName || targetEmail),
      role: 'owner',
    };
  } catch (err: any) {
    if (isOfflineOrNetworkError(err) && bizRow?.password === cleanPassword) {
      return { ok: true, verifiedBy: String(bizRow.owner || 'Owner'), role: 'owner' };
    }
    return {
      ok: false,
      verifiedBy: '',
      role: 'owner',
      error: 'Incorrect Owner/Manager password.',
    };
  }
}
