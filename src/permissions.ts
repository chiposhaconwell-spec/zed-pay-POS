import { ActiveTab } from './types';

export type StaffRole = 'owner' | 'manager' | 'sales';

export type SettingsPermissionKey =
  | 'general'
  | 'stores'
  | 'users'
  | 'stock'
  | 'workspaces'
  | 'payments'
  | 'zra';

export type ModulePermissionKey =
  | 'billing'
  | 'inventory'
  | 'laybys'
  | 'workspace'
  | 'quotes'
  | 'loans'
  | 'attendance'
  | 'audit'
  | 'finance'
  | 'analytics';

export interface UserPermissions {
  role: StaffRole;
  password?: string;
  accessible_branches: string[];
  allowed_settings: SettingsPermissionKey[];
  allowed_modules: ModulePermissionKey[];
  sales?: { checkout: boolean; refunds: boolean; quotes: boolean; laybys: boolean };
  inventory?: { view: boolean; update: boolean; transfer: boolean };
  customer?: { view_only: boolean; create: boolean; edit: boolean };
  reports?: {
    low_stock: boolean;
    expired_stock: boolean;
    profits: boolean;
    sales: boolean;
    payment_modes: boolean;
    sold_by: boolean;
    top_customers: boolean;
  };
  expense?: { add_expense: boolean; modify_expense: boolean };
  settings?: { create_store: boolean; manage_settings: boolean };
  staff?: { attendance_management: boolean; payroll_management: boolean; manage_staff: boolean };
  receipt?: { create_receipt: boolean; view_all_receipt: boolean; edit_receipt: boolean; return_receipt: boolean };
}

export const ALL_SETTINGS_KEYS: SettingsPermissionKey[] = [
  'general',
  'stores',
  'users',
  'stock',
  'workspaces',
  'payments',
  'zra',
];

export const ALL_MODULE_KEYS: ModulePermissionKey[] = [
  'billing',
  'inventory',
  'laybys',
  'workspace',
  'quotes',
  'loans',
  'attendance',
  'audit',
  'finance',
  'analytics',
];

export const SETTINGS_PERMISSION_OPTIONS: Array<{
  key: SettingsPermissionKey;
  label: string;
  description: string;
}> = [
  { key: 'general', label: '1. Business & Billing', description: 'Store profile, VAT, TPIN, logo & printer' },
  { key: 'stores', label: '2. Stores & Branches', description: 'Create/edit store branches & rules' },
  { key: 'users', label: '3. Users & Staff', description: 'Create staff accounts & assign access' },
  { key: 'stock', label: '4. Quick Add Stock', description: 'Add stock items & batch quantities' },
  { key: 'workspaces', label: '5. Cloud Sync & Workspaces', description: 'Cloud SQL/Firebase sync & DB backup' },
  { key: 'payments', label: '6. Payment Methods', description: 'Manage custom payment channels' },
  { key: 'zra', label: '7. ZRA Smart Invoice', description: 'VSDC fiscal config & offline queue' },
];

export const MODULE_PERMISSION_OPTIONS: Array<{
  key: ModulePermissionKey;
  label: string;
}> = [
  { key: 'billing', label: 'POS Sale Register' },
  { key: 'inventory', label: 'Inventory Manager' },
  { key: 'laybys', label: 'Layby Functions' },
  { key: 'workspace', label: 'Tasks & Operations' },
  { key: 'quotes', label: 'Quotes, Invoices & Delivery' },
  { key: 'loans', label: 'Purchase Orders & Loans' },
  { key: 'attendance', label: 'Staff & Payroll' },
  { key: 'audit', label: 'Employee Audit Trail' },
  { key: 'finance', label: 'Finance & P&L' },
  { key: 'analytics', label: 'Analytics Dashboard' },
];

export function normalizeRole(role?: string | null): StaffRole {
  if (role === 'owner' || role === 'admin') return 'owner';
  if (role === 'manager') return 'manager';
  return 'sales';
}

export function getDefaultSettingsForRole(role: string): SettingsPermissionKey[] {
  const norm = normalizeRole(role);
  if (norm === 'owner') {
    return [...ALL_SETTINGS_KEYS];
  }
  if (norm === 'manager') {
    return ['general', 'stores', 'stock', 'workspaces'];
  }
  return [];
}

export function getDefaultModulesForRole(role: string): ModulePermissionKey[] {
  const norm = normalizeRole(role);
  if (norm === 'owner') {
    return [...ALL_MODULE_KEYS];
  }
  if (norm === 'manager') {
    return ['billing', 'inventory', 'laybys', 'workspace', 'quotes', 'loans', 'attendance', 'audit', 'finance', 'analytics'];
  }
  return ['billing', 'laybys', 'workspace', 'quotes'];
}

export function buildUserPermissions(params: {
  role: StaffRole;
  password?: string;
  accessibleBranches?: string[];
  allowedSettings?: SettingsPermissionKey[];
  allowedModules?: ModulePermissionKey[];
}): UserPermissions {
  const role = normalizeRole(params.role);
  const allowedSettings =
    role === 'owner'
      ? [...ALL_SETTINGS_KEYS]
      : Array.isArray(params.allowedSettings)
        ? params.allowedSettings.filter((k): k is SettingsPermissionKey => ALL_SETTINGS_KEYS.includes(k))
        : getDefaultSettingsForRole(role);

  const allowedModules =
    role === 'owner'
      ? [...ALL_MODULE_KEYS]
      : Array.isArray(params.allowedModules)
        ? params.allowedModules.filter((k): k is ModulePermissionKey => ALL_MODULE_KEYS.includes(k))
        : getDefaultModulesForRole(role);

  // Ensure POS billing is always present if no modules were picked? Actually allow exact admin control, or keep billing by default.
  const canManageUsers = role === 'owner' || allowedSettings.includes('users');
  const canManageStores = role === 'owner' || allowedSettings.includes('stores');
  const canManageSettings = role === 'owner' || allowedSettings.length > 0;
  const isSupervisor = role !== 'sales';

  return {
    role,
    password: params.password || '',
    accessible_branches: role === 'owner' ? [] : (params.accessibleBranches || []),
    allowed_settings: allowedSettings,
    allowed_modules: allowedModules,
    sales: {
      checkout: allowedModules.includes('billing'),
      refunds: isSupervisor,
      quotes: allowedModules.includes('quotes'),
      laybys: allowedModules.includes('laybys'),
    },
    inventory: {
      view: allowedModules.includes('inventory'),
      update: isSupervisor || allowedSettings.includes('stock'),
      transfer: isSupervisor,
    },
    customer: { view_only: false, create: true, edit: isSupervisor },
    reports: {
      low_stock: true,
      expired_stock: true,
      profits: role === 'owner' || allowedModules.includes('finance'),
      sales: isSupervisor || allowedModules.includes('analytics'),
      payment_modes: true,
      sold_by: true,
      top_customers: true,
    },
    expense: {
      add_expense: isSupervisor || allowedModules.includes('finance') || allowedModules.includes('loans'),
      modify_expense: isSupervisor,
    },
    settings: {
      create_store: canManageStores,
      manage_settings: canManageSettings,
    },
    staff: {
      attendance_management: isSupervisor || allowedModules.includes('attendance'),
      payroll_management: role === 'owner' || allowedModules.includes('attendance'),
      manage_staff: canManageUsers,
    },
    receipt: {
      create_receipt: true,
      view_all_receipt: true,
      edit_receipt: isSupervisor,
      return_receipt: isSupervisor,
    },
  };
}

export function parseStaffPermissions(
  rawPermissionsJson: unknown,
  fallbackRole?: string | null
): UserPermissions {
  let parsed: any = {};
  if (typeof rawPermissionsJson === 'string' && rawPermissionsJson.trim()) {
    try {
      parsed = JSON.parse(rawPermissionsJson);
    } catch {
      parsed = {};
    }
  } else if (rawPermissionsJson && typeof rawPermissionsJson === 'object') {
    parsed = rawPermissionsJson;
  }

  const role = normalizeRole(fallbackRole || parsed.role);
  if (role === 'owner') {
    return buildUserPermissions({ role: 'owner', password: parsed.password });
  }

  const allowedSettings: SettingsPermissionKey[] = Array.isArray(parsed.allowed_settings)
    ? parsed.allowed_settings.filter((k: any): k is SettingsPermissionKey => ALL_SETTINGS_KEYS.includes(k))
    : getDefaultSettingsForRole(role);

  const allowedModules: ModulePermissionKey[] = Array.isArray(parsed.allowed_modules)
    ? parsed.allowed_modules.filter((k: any): k is ModulePermissionKey => ALL_MODULE_KEYS.includes(k))
    : getDefaultModulesForRole(role);

  const accessibleBranches: string[] = Array.isArray(parsed.accessible_branches)
    ? parsed.accessible_branches.map((b: any) => String(b))
    : [];

  return buildUserPermissions({
    role,
    password: parsed.password,
    accessibleBranches,
    allowedSettings,
    allowedModules,
  });
}

export function mapSubTabToPermissionKey(subTab?: string): SettingsPermissionKey {
  if (subTab === 'stores') return 'stores';
  if (subTab === 'users') return 'users';
  if (subTab === 'stock') return 'stock';
  if (subTab === 'workspaces' || subTab === 'database') return 'workspaces';
  if (subTab === 'payments') return 'payments';
  if (subTab === 'zra') return 'zra';
  return 'general';
}

export function getPermittedSettingsTabs(
  role: string,
  permissions?: UserPermissions | null
): SettingsPermissionKey[] {
  const norm = normalizeRole(role);
  if (norm === 'owner') return [...ALL_SETTINGS_KEYS];
  if (permissions && Array.isArray(permissions.allowed_settings)) {
    return ALL_SETTINGS_KEYS.filter((k) => permissions.allowed_settings.includes(k));
  }
  return getDefaultSettingsForRole(norm);
}

export function canAccessSettingTab(
  tab: SettingsPermissionKey | string,
  role: string,
  permissions?: UserPermissions | null
): boolean {
  const norm = normalizeRole(role);
  if (norm === 'owner') return true;
  const key = mapSubTabToPermissionKey(tab);
  const permitted = getPermittedSettingsTabs(norm, permissions);
  return permitted.includes(key);
}

export function canAccessModule(
  tab: ActiveTab | string,
  role: string,
  permissions?: UserPermissions | null
): boolean {
  const norm = normalizeRole(role);
  if (norm === 'owner') return true;
  if (tab === 'settings') {
    return getPermittedSettingsTabs(norm, permissions).length > 0;
  }
  if (tab === 'console' || tab === 'customers') {
    return norm === 'manager';
  }
  const allowedModules =
    permissions && Array.isArray(permissions.allowed_modules)
      ? permissions.allowed_modules
      : getDefaultModulesForRole(norm);
  return allowedModules.includes(tab as ModulePermissionKey);
}

export const PERMISSIONS_STORAGE_KEY = 'logged_in_user_permissions';
export const AUTH_ROLE_STORAGE_KEY = 'logged_in_auth_role';

export function saveSessionPermissionsToStorage(permissions: UserPermissions | null, authRole?: StaffRole): void {
  if (permissions) {
    localStorage.setItem(PERMISSIONS_STORAGE_KEY, JSON.stringify(permissions));
  } else {
    localStorage.removeItem(PERMISSIONS_STORAGE_KEY);
  }
  if (authRole) {
    localStorage.setItem(AUTH_ROLE_STORAGE_KEY, authRole);
  }
}

export function loadSessionPermissionsFromStorage(roleFallback?: string | null): UserPermissions {
  try {
    const raw = localStorage.getItem(PERMISSIONS_STORAGE_KEY);
    if (raw) {
      return parseStaffPermissions(raw, roleFallback);
    }
  } catch {
    // ignore corrupt storage
  }
  return buildUserPermissions({ role: normalizeRole(roleFallback || localStorage.getItem('logged_in_user_role')) });
}

export function clearSessionPermissionsFromStorage(): void {
  localStorage.removeItem(PERMISSIONS_STORAGE_KEY);
  localStorage.removeItem(AUTH_ROLE_STORAGE_KEY);
}
