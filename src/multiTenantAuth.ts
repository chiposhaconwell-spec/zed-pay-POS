import type { StoreSettings } from './types';

// Pure-JS synchronous SHA-256 (works identically in browser, WebView, and Node.js server)
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256HexSync(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((n) => n.toString(16).padStart(8, '0'))
    .join('');
}

export function normalizeAuthEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

export function computeCredentialHashSync(email: string, password: string): string {
  const cleanEmail = normalizeAuthEmail(email);
  const rawPass = String(password || '');
  if (!cleanEmail || !rawPass) return '';
  return sha256HexSync(`mtpos_v1::${cleanEmail}::${rawPass}`);
}

export function deriveFirebaseCredentialIdentity(email: string, password: string) {
  const cleanEmail = normalizeAuthEmail(email);
  const credHash = computeCredentialHashSync(cleanEmail, password);
  // Keep local part <= 64 chars (`cred_` (5) + 56 = 61 chars)
  const credId = credHash.slice(0, 56);
  const authEmail = credId ? `cred_${credId}@mt-pos.auth` : cleanEmail;
  const authSecret = credHash ? `MT_${credHash.slice(20, 56)}_Pos!9` : '';
  return {
    cleanEmail,
    credHash,
    credId,
    authEmail,
    authSecret,
  };
}

export function deriveUserId(email: string): string {
  const cleanEmail = normalizeAuthEmail(email);
  if (!cleanEmail) return '';
  return `usr_${sha256HexSync(`user::${cleanEmail}`).slice(0, 20)}`;
}

export function deriveMembershipId(businessId: string, userId: string, role?: string): string {
  const cleanBiz = String(businessId || '').trim();
  const cleanUser = String(userId || '').trim();
  const cleanRole = String(role || 'sales').trim().toLowerCase();
  return `mem_${sha256HexSync(`mem::${cleanBiz}::${cleanUser}::${cleanRole}`).slice(0, 20)}`;
}

export interface UnlockedWorkspaceSession {
  businessId: string;
  businessName: string;
  membershipId: string;
  userId: string;
  email: string;
  fullName: string;
  role: 'owner' | 'manager' | 'sales';
  credentialHash: string;
  accessibleBranches: string[];
  permissionsJson: string;
  storeId: string;
  unlockedAt: string;
}

const UNLOCKED_WORKSPACES_KEY = 'pos_unlocked_workspaces_v1';

export function getUnlockedWorkspaces(): UnlockedWorkspaceSession[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(UNLOCKED_WORKSPACES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((w) => w && w.businessId && w.credentialHash) : [];
  } catch {
    return [];
  }
}

export function upsertUnlockedWorkspace(ws: UnlockedWorkspaceSession): UnlockedWorkspaceSession[] {
  const existing = getUnlockedWorkspaces().filter(
    (item) => !(item.businessId === ws.businessId && item.email.toLowerCase() === ws.email.toLowerCase())
  );
  const next = [ws, ...existing];
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(UNLOCKED_WORKSPACES_KEY, JSON.stringify(next));
    } catch {}
  }
  return next;
}

export function removeUnlockedWorkspace(businessId: string): UnlockedWorkspaceSession[] {
  const next = getUnlockedWorkspaces().filter((item) => item.businessId !== businessId);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(UNLOCKED_WORKSPACES_KEY, JSON.stringify(next));
    } catch {}
  }
  return next;
}

export function clearUnlockedWorkspaces(): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(UNLOCKED_WORKSPACES_KEY);
    } catch {}
  }
}

export function getScopedSettingsKey(businessId: string): string {
  const clean = String(businessId || '').trim();
  return clean ? `android_pos_settings_${clean}` : 'android_pos_settings';
}

export function saveScopedBusinessSettings(businessId: string, settingsObj: StoreSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const serialized = JSON.stringify(settingsObj);
    if (businessId && businessId !== 'default_biz') {
      localStorage.setItem(getScopedSettingsKey(businessId), serialized);
    }
    localStorage.setItem('android_pos_settings', serialized);
  } catch {}
}

export function loadScopedBusinessSettings(
  businessId: string,
  baseDefaults: StoreSettings,
  bizRow?: any
): StoreSettings {
  let scopedRaw: string | null = null;
  if (typeof localStorage !== 'undefined' && businessId && businessId !== 'default_biz') {
    scopedRaw = localStorage.getItem(getScopedSettingsKey(businessId));
  }
  let parsedScoped: Partial<StoreSettings> = {};
  if (scopedRaw) {
    try {
      parsedScoped = JSON.parse(scopedRaw) || {};
    } catch {}
  }
  const merged: StoreSettings = {
    ...baseDefaults,
    ...parsedScoped,
    storeName: String(parsedScoped.storeName || bizRow?.name || baseDefaults.storeName || ''),
    currency: String(parsedScoped.currency || bizRow?.currency || baseDefaults.currency || 'K'),
    taxRate:
      parsedScoped.taxRate !== undefined
        ? Number(parsedScoped.taxRate)
        : bizRow?.tax_rate !== undefined && bizRow?.tax_rate !== null
          ? Number(bizRow.tax_rate)
          : baseDefaults.taxRate,
    tpin: String(parsedScoped.tpin ?? bizRow?.tpin ?? baseDefaults.tpin ?? ''),
    billingAddress: String(parsedScoped.billingAddress ?? bizRow?.billing_address ?? baseDefaults.billingAddress ?? ''),
    billingCity: String(parsedScoped.billingCity ?? bizRow?.billing_city ?? baseDefaults.billingCity ?? ''),
    billingCountry: String(parsedScoped.billingCountry ?? bizRow?.billing_country ?? baseDefaults.billingCountry ?? ''),
    billingPhone: String(parsedScoped.billingPhone ?? bizRow?.billing_phone ?? bizRow?.phone ?? baseDefaults.billingPhone ?? ''),
    billingEmail: String(parsedScoped.billingEmail ?? bizRow?.billing_email ?? bizRow?.email ?? baseDefaults.billingEmail ?? ''),
  };
  return merged;
}

export function saveScopedActiveBranch(businessId: string, branchId: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (branchId) {
      localStorage.setItem('active_store_branch', branchId);
      if (businessId && businessId !== 'default_biz') {
        localStorage.setItem(`active_store_branch_${businessId}`, branchId);
      }
    } else {
      localStorage.removeItem('active_store_branch');
    }
  } catch {}
}

export function loadScopedActiveBranch(businessId: string): string {
  if (typeof localStorage === 'undefined') return '';
  if (businessId && businessId !== 'default_biz') {
    return localStorage.getItem(`active_store_branch_${businessId}`) || '';
  }
  return localStorage.getItem('active_store_branch') || '';
}
