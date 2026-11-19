import React, { useState, useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { 
  ShoppingCart, Package, TrendingUp, Terminal, Sliders, 
  Layers, Clock, Coins, FileText, Users, Briefcase, Plus, 
  Key, ShieldCheck, Check, Lock, Building, Building2, UserCheck, User,
  RefreshCw, Percent, ChevronRight, Sparkles, CheckSquare,
  Menu, X, Phone, Receipt, ShoppingBag, Share2, RotateCcw,
  LayoutDashboard, FileSpreadsheet, MessageSquare, Send, HelpCircle, Truck,
  Cloud, CloudUpload, CloudDownload, LogOut, UserPlus, MapPin, AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Database & Firebase Cloud API
import {
  initializeDatabase,
  SeedTemplate,
  runSql,
  getCentralBranches,
  upsertCustomerSync,
  logEmployeeAudit,
  persistTablesToStorage,
  pushDatabaseToServer,
  pullDatabaseFromServer,
  getAllSelectableAccounts,
  syncAllAccountingSystems,
  seedChartOfAccountsOnly,
  getActiveBusinessId,
  getActiveStoreId,
  sqlEsc,
  resolveMembershipsByCredential,
  upsertUserAndMembership,
} from './db';
import {
  auth,
  registerOrSignInWithEmailPassword,
  signInWithEmailPasswordAccount,
  signInOrCreateCredentialAuth,
  signInWithCredentialHash,
  claimCredentialInviteAndRestore,
  publishCredentialMembershipToCloud,
  hasVerifiedFirestoreAccessToBusiness,
  tryMigrateLegacyOwnerToCredentialAuth,
  backupToCloud,
  restoreFromCloud,
  googleSignOut,
} from './firebase';
import { StoreSettings, ActiveTab } from './types';
import {
  UserPermissions,
  StaffRole,
  AUTH_ROLE_STORAGE_KEY,
  buildUserPermissions,
  parseStaffPermissions,
  isUserSuspended,
  getPermittedSettingsTabs,
  canAccessSettingTab,
  canAccessModule,
  loadSessionPermissionsFromStorage,
  saveSessionPermissionsToStorage,
  clearSessionPermissionsFromStorage,
  normalizeRole,
} from './permissions';
import {
  UnlockedWorkspaceSession,
  computeCredentialHashSync,
  deriveUserId,
  deriveMembershipId,
  normalizeAuthEmail,
  getUnlockedWorkspaces,
  upsertUnlockedWorkspace,
  clearUnlockedWorkspaces,
  saveScopedBusinessSettings,
  loadScopedBusinessSettings,
  saveScopedActiveBranch,
  loadScopedActiveBranch,
} from './multiTenantAuth';
import { FiscalService } from './zra/fiscalService';
import { getZraConfig, saveZraConfig, switchZraConfigForBusiness } from './zra/zraConfig';

// Custom sub-components
import AndroidShell from './components/AndroidShell';
import BillingTerminal from './components/BillingTerminal';
import InventoryManager from './components/InventoryManager';
import SmeDashboard from './components/SmeDashboard';
import SettingsPanel from './components/SettingsPanel';
import LaybysBoard from './components/LaybysBoard';
import AttendancePayroll from './components/AttendancePayroll';
import QuotationsCreator from './components/QuotationsCreator';
import LoanDashboard from './components/LoanDashboard';
import FinanceDashboard from './components/FinanceDashboard';
import WorkspaceCoordinator from './components/WorkspaceCoordinator';
import EmployeeAuditTrail from './components/EmployeeAuditTrail';
import ShareAppApkModal from './components/ShareAppApkModal';
import { PWAInstallButton } from './components/PWAInstallButton';
import { OfflineIndicator } from './components/OfflineIndicator';

export const DEFAULT_COMPANY_LOGO = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'><rect width='120' height='120' rx='28' fill='%233730A3'/><path d='M60 22 L92 38 L92 70 C92 86 60 96 60 96 C60 96 28 88 28 72 L28 38 Z' fill='none' stroke='white' stroke-width='6' stroke-linejoin='round'/><path d='M44 58 L56 70 L78 48' fill='none' stroke='white' stroke-linecap='round' stroke-linejoin='round'/></svg>";

const DEFAULT_SETTINGS: StoreSettings = {
  storeName: '',
  currency: '',
  taxRate: 0,
  loyaltyRatio: 0,
  receiptHeader: '',
  receiptFooter: '',
  paperWidth: '58mm',
  logoUrl: '',
  tpin: '',
  billingAddress: '',
  billingCity: '',
  billingCountry: '',
  billingPhone: '',
  billingEmail: '',
  termsAndConditions: '',
  printerName: '',
  printerInterface: '',
  printerStatus: 'Not Linked',
};

export default function App() {
  const [activeTab, setActiveTab2] = useState<ActiveTab>('billing');
  const [showSqlSplit, setShowSqlSplit] = useState(false); // Split-Window split-screen SQL Monitor disabled
  const [settings, setSettings] = useState<StoreSettings>(DEFAULT_SETTINGS);
  const [sqlSeedTrigger, setSqlSeedTrigger] = useState(0);
  const [billingCounterAction, setBillingCounterAction] = useState<'camera' | 'cashup' | 'refunds' | 'history' | null>(null);

  // SME global states: Permission levels & Branch store locations
  const [userRole, setUserRole] = useState<string>(() => localStorage.getItem('logged_in_user_role') || 'owner'); // 'owner' | 'manager' | 'sales'
  const [authenticatedRole, setAuthenticatedRole] = useState<StaffRole>(() =>
    normalizeRole(localStorage.getItem(AUTH_ROLE_STORAGE_KEY) || localStorage.getItem('logged_in_user_role') || 'owner')
  );
  const [userPermissions, setUserPermissions] = useState<UserPermissions>(() =>
    loadSessionPermissionsFromStorage(localStorage.getItem('logged_in_user_role'))
  );
  const [activeStore, setActiveStore] = useState<string>('');

  // Navigation Drawer state (3-lines hamburger)
  const [showNavDrawer, setShowNavDrawer] = useState(false);
  const [showShareAppModal, setShowShareAppModal] = useState(false);

  // Dynamic Enterprise & Multi-Business Gating State (100% Blank on default — no pre-seeded details, branches, or stock)
  const [isAuthenticatedSession, setIsAuthenticatedSession] = useState<boolean>(() => {
    return (
      localStorage.getItem('pos_authenticated_session') === 'true' &&
      Boolean(localStorage.getItem('active_business_profile'))
    );
  });
  const [authScreenMode, setAuthScreenMode] = useState<'login' | 'register'>('login');
  const [activeBusiness, setActiveBusiness] = useState<{ id: string; name: string; owner: string; email: string }>({
    id: '',
    name: '',
    owner: '',
    email: ''
  });
  const [businesses, setBusinesses] = useState<any[]>([]);
  const [stores, setStores] = useState<any[]>([]);
  const [staffMembers, setStaffMembers] = useState<any[]>([]);
  const [unlockedWorkspaces, setUnlockedWorkspaces] = useState<UnlockedWorkspaceSession[]>(() => getUnlockedWorkspaces());
  const [showWorkspaceDropdown, setShowWorkspaceDropdown] = useState(false);
  const [showUnlockWorkspaceModal, setShowUnlockWorkspaceModal] = useState(false);
  const [isCreatingNewWorkspace, setIsCreatingNewWorkspace] = useState(false);
  const [unlockEmail, setUnlockEmail] = useState('');
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockFeedback, setUnlockFeedback] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [isUnlockingWorkspace, setIsUnlockingWorkspace] = useState(false);
  const [settingsInitialSubTab, setSettingsInitialSubTab] = useState<'general' | 'stores' | 'users' | 'stock' | 'payments' | 'zra' | 'printer' | 'database' | 'workspaces'>('general');
  const [newBizName, setNewBizName] = useState('');
  const [newBizOwner, setNewBizOwner] = useState('');
  const [newBizEmail, setNewBizEmail] = useState('');
  const [newBizPassword, setNewBizPassword] = useState('');
  const [newBizFirstStore, setNewBizFirstStore] = useState('');
  const [newBizLocation, setNewBizLocation] = useState('');
  const [newBizCurrency, setNewBizCurrency] = useState('');
  const [newBizTaxRate, setNewBizTaxRate] = useState('');
  const [newBizTpin, setNewBizTpin] = useState('');
  const [newBizOpeningCash, setNewBizOpeningCash] = useState('');
  const [newBizBillingAddress, setNewBizBillingAddress] = useState('');
  const [newBizBillingCity, setNewBizBillingCity] = useState('');
  const [newBizBillingCountry, setNewBizBillingCountry] = useState('');
  const [newBizBillingPhone, setNewBizBillingPhone] = useState('');
  const [newBizBillingEmail, setNewBizBillingEmail] = useState('');

  // Existing Business / Staff Sign-In / Sync states
  const [syncLoginEmail, setSyncLoginEmail] = useState('');
  const [syncLoginPassword, setSyncLoginPassword] = useState('');
  const [syncLoginBranch, setSyncLoginBranch] = useState('');
  const [accessibleStoreIds, setAccessibleStoreIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('logged_in_accessible_branches');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [showBranchChoiceGate, setShowBranchChoiceGate] = useState(false);
  const [gateOpeningCash, setGateOpeningCash] = useState('');
  const [isHeaderSyncing, setIsHeaderSyncing] = useState(false);
  const [lastHeaderSyncMsg, setLastHeaderSyncMsg] = useState<string | null>(null);
  const [authFeedback, setAuthFeedback] = useState<{ type: 'error' | 'warning' | 'success'; text: string } | null>(null);

  const permittedSettingsTabs = getPermittedSettingsTabs(userRole, userPermissions);
  const hasAnySettingsAccess = permittedSettingsTabs.length > 0;
  const canViewModule = (tab: ActiveTab | string) => canAccessModule(tab, userRole, userPermissions);

  const navigateToTab = (tab: ActiveTab) => {
    if (!canAccessModule(tab, userRole, userPermissions)) {
      return;
    }
    setActiveTab2(tab);
  };

  const openUnifiedSettings = (subTab: 'general' | 'stores' | 'users' | 'stock' | 'payments' | 'zra' | 'printer' | 'database' | 'workspaces' = 'general') => {
    if (permittedSettingsTabs.length === 0) {
      return;
    }
    loadBusinessData();
    const mapped = subTab === 'database' ? 'workspaces' : subTab;
    const targetSubTab = canAccessSettingTab(mapped, userRole, userPermissions)
      ? mapped
      : permittedSettingsTabs[0];
    setSettingsInitialSubTab(targetSubTab as any);
    setShowNavDrawer(false);
    setActiveTab2('settings');
  };

  // Drawer Modals & Counts (Blank on default)
  const [badgeCounts, setBadgeCounts] = useState({ products: 0, customers: 0, staff: 0 });
  
  // Expense Modal state
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseCategory, setExpenseCategory] = useState('Store Operations');
  const [expenseAccountId, setExpenseAccountId] = useState('acc_cash');
  const [expenseNotes, setExpenseNotes] = useState('');
  const [expenseStoreId, setExpenseStoreId] = useState('');

  // Help Chat Modal state
  const [showHelpChatModal, setShowHelpChatModal] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ sender: 'user' | 'support'; text: string }>>([
    { sender: 'support', text: 'Hello! Welcome to POS Support Chat. How can we help with your store operations today?' }
  ]);
  const [chatInput, setChatInput] = useState('');

  // Customers Management Modal state
  const [showCustomersModal, setShowCustomersModal] = useState(false);
  const [customersList, setCustomersList] = useState<any[]>([]);
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');
  const [newCustName, setNewCustName] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [custAddMsg, setCustAddMsg] = useState<string | null>(null);

  const navigationBackStateRef = useRef({
    showNavDrawer,
    showHelpChatModal,
    showCustomersModal,
    showExpenseModal,
    billingCounterAction,
    activeTab
  });
  navigationBackStateRef.current = {
    showNavDrawer,
    showHelpChatModal,
    showCustomersModal,
    showExpenseModal,
    billingCounterAction,
    activeTab
  };

  const fetchCustomersList = () => {
    try {
      const bizId = getActiveBusinessId(activeBusiness?.id);
      const bizWhere = bizId ? ` WHERE business_id = '${sqlEsc(bizId)}'` : '';
      const cRes = runSql(`SELECT * FROM customers${bizWhere} ORDER BY name ASC`, 'CRM: Query central customers database');
      if (cRes.success && Array.isArray(cRes.data)) {
        setCustomersList(cRes.data);
      }
      updateBadgeCounts();
    } catch (err) {
      console.warn('Failed querying customers list', err);
    }
  };

  // Update badge counts from DB (scoped strictly to activeBusiness & activeStore)
  const updateBadgeCounts = () => {
    try {
      const bizId = getActiveBusinessId(activeBusiness?.id);
      const bizFilter = bizId ? `business_id = '${sqlEsc(bizId)}'` : '';
      const pRes = activeStore
        ? runSql(`SELECT COUNT(*) as cnt FROM store_products WHERE store_id = '${sqlEsc(activeStore)}' AND stock > 0${bizFilter ? ` AND ${bizFilter}` : ''}`, 'Query branch product count')
        : runSql(`SELECT COUNT(*) as cnt FROM products${bizFilter ? ` WHERE ${bizFilter}` : ''}`, 'Query product count');
      const prodCnt = (pRes.success && pRes.data?.[0]?.cnt !== undefined) ? pRes.data[0].cnt : 0;

      const cRes = runSql(`SELECT COUNT(*) as cnt FROM customers${bizFilter ? ` WHERE ${bizFilter}` : ''}`, 'Query customer count');
      const custCnt = (cRes.success && cRes.data?.[0]?.cnt !== undefined) ? cRes.data[0].cnt : 0;

      const sRes = activeStore
        ? runSql(`SELECT COUNT(*) as cnt FROM staff WHERE (store_id = '${sqlEsc(activeStore)}' OR store_id = '' OR store_id IS NULL)${bizFilter ? ` AND ${bizFilter}` : ''}`, 'Query branch staff count')
        : runSql(`SELECT COUNT(*) as cnt FROM staff${bizFilter ? ` WHERE ${bizFilter}` : ''}`, 'Query staff count');
      const staffCnt = (sRes.success && sRes.data?.[0]?.cnt !== undefined) ? sRes.data[0].cnt : 0;

      setBadgeCounts({
        products: prodCnt,
        customers: custCnt,
        staff: staffCnt
      });
    } catch (err) {
      console.warn('Failed querying badge counts', err);
    }
  };

  // Load custom configurations on startup
  useEffect(() => {
    // 1. Provision memory SQL tables in blank mode (no preseeded stock, batches, or login accounts)
    initializeDatabase('blank');

    // 2. Recover merchant preference details & sync ZRA config ONLY if authenticated session exists
    const isSavedAuth =
      localStorage.getItem('pos_authenticated_session') === 'true' &&
      Boolean(localStorage.getItem('active_business_profile'));
    const localConf = isSavedAuth ? localStorage.getItem('android_pos_settings') : null;
    if (localConf) {
      try {
        const parsedConf = JSON.parse(localConf);
        if (parsedConf?.zraConfig) {
          saveZraConfig(parsedConf.zraConfig);
        } else {
          parsedConf.zraConfig = getZraConfig();
        }
        setSettings(parsedConf);
      } catch (err) {
        console.warn('Failed restoring settings, falling back to default config details.', err);
      }
    }

    // Start ZRA VSDC background offline queue auto-sync
    FiscalService.startAutoSync();

    // 3. Load initial CRM customers
    fetchCustomersList();

    // 4. Load logged-in business session from localStorage ONLY if explicitly authenticated
    const bRes = runSql(`SELECT * FROM businesses`, 'Startup: Check registered business accounts');
    const existingBusinesses = (bRes.success && Array.isArray(bRes.data)) ? bRes.data : [];

    const savedBiz = localStorage.getItem('active_business_profile');
    const isSessionAuth = localStorage.getItem('pos_authenticated_session') === 'true';

    const checkActiveStaffAccessStatus = (bizCandidate?: any): { valid: boolean; reason?: string } => {
      const loggedEmail = normalizeAuthEmail(localStorage.getItem('logged_in_user_email') || '');
      if (!loggedEmail) return { valid: true };
      const bizEmail = normalizeAuthEmail(bizCandidate?.email || '');
      const savedAuthRole = normalizeRole(localStorage.getItem(AUTH_ROLE_STORAGE_KEY) || localStorage.getItem('logged_in_user_role'));
      const bizIdFilter = bizCandidate?.id ? ` WHERE business_id = '${sqlEsc(bizCandidate.id)}'` : '';

      // Check decoupled business_memberships first
      if (bizCandidate?.id) {
        const memRes = runSql(
          `SELECT * FROM business_memberships WHERE business_id = '${sqlEsc(bizCandidate.id)}' AND LOWER(email) = '${sqlEsc(loggedEmail)}'`,
          'Session check: Verify membership status'
        );
        const memRows = (memRes.success && Array.isArray(memRes.data)) ? memRes.data : [];
        const matchedMem = memRows.find((m: any) => normalizeRole(m.role) === savedAuthRole) || memRows[0];
        if (matchedMem) {
          if (String(matchedMem.status || 'ACTIVE').toUpperCase() === 'SUSPENDED') {
            return {
              valid: false,
              reason: 'Account Suspended: Your access has been suspended by an Administrator. Please contact your Business Owner.',
            };
          }
          if (normalizeRole(matchedMem.role) === 'owner') {
            return { valid: true };
          }
        }
      }

      // Corporate owner session is not gated by staff deletion/suspension
      if (bizEmail && loggedEmail === bizEmail && savedAuthRole === 'owner') {
        return { valid: true };
      }

      const stCheckRes = runSql(`SELECT * FROM staff${bizIdFilter}`, 'Session check: Verify staff status');
      const stRows = (stCheckRes.success && Array.isArray(stCheckRes.data)) ? stCheckRes.data : [];
      const matchedStaffRow = stRows.find(
        (u: any) =>
          (u.email && normalizeAuthEmail(u.email) === loggedEmail) ||
          (u.name && String(u.name).trim().toLowerCase() === loggedEmail)
      );
      if (matchedStaffRow) {
        if (isUserSuspended(matchedStaffRow.permissions_json)) {
          return {
            valid: false,
            reason: 'Account Suspended: Your access has been suspended by an Administrator. Please contact your Business Owner.',
          };
        }
        return { valid: true };
      }
      if (savedAuthRole !== 'owner') {
        return {
          valid: false,
          reason: 'Access Revoked: Your staff account has been removed by an Administrator.',
        };
      }
      return { valid: true };
    };

    if (isSessionAuth && savedBiz && existingBusinesses.length > 0) {
      try {
        const parsed = JSON.parse(savedBiz);
        const match = existingBusinesses.find((b: any) => b.id === parsed.id);
        const accessCheck = match ? checkActiveStaffAccessStatus(match) : { valid: false };
        if (match && accessCheck.valid) {
          setActiveBusiness(match);
          const savedRole = localStorage.getItem('logged_in_user_role') || 'owner';
          const savedAuthRole = normalizeRole(localStorage.getItem(AUTH_ROLE_STORAGE_KEY) || savedRole);
          const savedPerms = loadSessionPermissionsFromStorage(savedRole);
          setUserRole(savedRole);
          setAuthenticatedRole(savedAuthRole);
          setUserPermissions(savedPerms);

          const scopedSettings = loadScopedBusinessSettings(match.id, DEFAULT_SETTINGS, match);
          const bizZra = switchZraConfigForBusiness(match.id, scopedSettings.zraConfig);
          scopedSettings.zraConfig = bizZra;
          setSettings(scopedSettings);

          const savedStore = loadScopedActiveBranch(match.id) || localStorage.getItem('active_store_branch') || '';
          if (savedStore) {
            setActiveStore(savedStore);
          }

          // Ensure active session appears in unlockedWorkspaces if credential_hash exists
          const loggedEmail = normalizeAuthEmail(localStorage.getItem('logged_in_user_email') || match.email || '');
          const currentUnlocked = getUnlockedWorkspaces();
          if (currentUnlocked.length === 0 && loggedEmail) {
            const mRes = runSql(
              `SELECT * FROM business_memberships WHERE business_id = '${sqlEsc(match.id)}' AND LOWER(email) = '${sqlEsc(loggedEmail)}'`,
              'Startup: Load active membership'
            );
            const mRow = (mRes.success && Array.isArray(mRes.data))
              ? mRes.data.find((r: any) => normalizeRole(r.role) === savedAuthRole) || mRes.data[0]
              : null;
            if (mRow?.credential_hash) {
              const seededWs = upsertUnlockedWorkspace({
                businessId: match.id,
                businessName: match.name,
                membershipId: String(mRow.id || deriveMembershipId(match.id, deriveUserId(loggedEmail), savedAuthRole)),
                userId: String(mRow.user_id || deriveUserId(loggedEmail)),
                email: loggedEmail,
                fullName: String(mRow.full_name || localStorage.getItem('logged_in_user_name') || match.owner || 'User'),
                role: savedAuthRole,
                credentialHash: String(mRow.credential_hash),
                accessibleBranches: savedPerms.accessible_branches || [],
                permissionsJson: String(mRow.permissions_json || JSON.stringify(savedPerms)),
                storeId: savedStore || String(mRow.store_id || 'main'),
                unlockedAt: new Date().toISOString(),
              });
              setUnlockedWorkspaces(seededWs);
            }
          } else {
            setUnlockedWorkspaces(currentUnlocked);
          }

          setIsAuthenticatedSession(true);
        } else {
          localStorage.removeItem('active_business_profile');
          localStorage.removeItem('pos_authenticated_session');
          localStorage.removeItem('android_pos_settings');
          clearSessionPermissionsFromStorage();
          clearUnlockedWorkspaces();
          switchZraConfigForBusiness('');
          setUnlockedWorkspaces([]);
          setSettings(DEFAULT_SETTINGS);
          setActiveBusiness({ id: '', name: '', owner: '', email: '' });
          setIsAuthenticatedSession(false);
          void googleSignOut();
          if (accessCheck.reason) {
            setAuthFeedback({ type: 'error', text: accessCheck.reason });
          }
        }
      } catch (e) {
        localStorage.removeItem('active_business_profile');
        localStorage.removeItem('pos_authenticated_session');
        localStorage.removeItem('android_pos_settings');
        clearSessionPermissionsFromStorage();
        clearUnlockedWorkspaces();
        switchZraConfigForBusiness('');
        setUnlockedWorkspaces([]);
        setSettings(DEFAULT_SETTINGS);
        setActiveBusiness({ id: '', name: '', owner: '', email: '' });
        setIsAuthenticatedSession(false);
        void googleSignOut();
      }
    } else {
      // No authenticated session: start on Log In / Create Account screen (blank state)
      localStorage.removeItem('active_business_profile');
      localStorage.removeItem('pos_authenticated_session');
      localStorage.removeItem('android_pos_settings');
      clearSessionPermissionsFromStorage();
      clearUnlockedWorkspaces();
      switchZraConfigForBusiness('');
      setUnlockedWorkspaces([]);
      setSettings(DEFAULT_SETTINGS);
      setActiveBusiness({ id: '', name: '', owner: '', email: '' });
      setIsAuthenticatedSession(false);
      void googleSignOut();
      setAuthScreenMode(existingBusinesses.length === 0 ? 'register' : 'login');
    }

    updateBadgeCounts();

    const handleSaleOrDataUpdate = () => {
      setSqlSeedTrigger(prev => prev + 1);
      updateBadgeCounts();
      fetchCustomersList();
      if (localStorage.getItem('pos_authenticated_session') === 'true') {
        let savedBizObj: any = null;
        try {
          const rawBiz = localStorage.getItem('active_business_profile');
          if (rawBiz) savedBizObj = JSON.parse(rawBiz);
        } catch {}
        const statusCheck = checkActiveStaffAccessStatus(savedBizObj);
        if (!statusCheck.valid) {
          localStorage.removeItem('pos_authenticated_session');
          localStorage.removeItem('active_business_profile');
          localStorage.removeItem('pos_shift_active');
          localStorage.removeItem('logged_in_accessible_branches');
          localStorage.removeItem('logged_in_user_role');
          localStorage.removeItem('logged_in_user_email');
          localStorage.removeItem('logged_in_user_name');
          localStorage.removeItem('quick_salesperson_name');
          localStorage.removeItem('android_pos_settings');
          clearSessionPermissionsFromStorage();
          clearUnlockedWorkspaces();
          switchZraConfigForBusiness('');
          setUnlockedWorkspaces([]);
          void googleSignOut();
          setSettings(DEFAULT_SETTINGS);
          setActiveBusiness({ id: '', name: '', owner: '', email: '' });
          setUserRole('owner');
          setAuthenticatedRole('owner');
          setUserPermissions(buildUserPermissions({ role: 'owner' }));
          setIsAuthenticatedSession(false);
          setShowBranchChoiceGate(false);
          setShowNavDrawer(false);
          setAuthScreenMode('login');
          if (statusCheck.reason) {
            setAuthFeedback({ type: 'error', text: statusCheck.reason });
          }
          return;
        }
      }
      const latestRole = localStorage.getItem('logged_in_user_role');
      if (latestRole) {
        setUserRole(latestRole);
        setUserPermissions(loadSessionPermissionsFromStorage(latestRole));
      }
      const latestAuthRole = localStorage.getItem(AUTH_ROLE_STORAGE_KEY);
      if (latestAuthRole) {
        setAuthenticatedRole(normalizeRole(latestAuthRole));
      }
    };

    window.addEventListener('pos_sale_completed', handleSaleOrDataUpdate);
    window.addEventListener('pos_data_updated', handleSaleOrDataUpdate);
    window.addEventListener('database-rehydrated', handleSaleOrDataUpdate);
    window.addEventListener('storage', handleSaleOrDataUpdate);

    // Handle native Android hardware back button
    let backListenerHandle: any = null;
    if (Capacitor.isNativePlatform()) {
      try {
        CapApp.addListener('backButton', () => {
        const state = navigationBackStateRef.current;
        if (state.showNavDrawer) {
          setShowNavDrawer(false);
          return;
        }
        if (state.showHelpChatModal) {
          setShowHelpChatModal(false);
          return;
        }
        if (state.showCustomersModal) {
          setShowCustomersModal(false);
          return;
        }
        if (state.showExpenseModal) {
          setShowExpenseModal(false);
          return;
        }
        if (state.billingCounterAction) {
          setBillingCounterAction(null);
          return;
        }
        if (state.activeTab !== 'billing') {
          setActiveTab2('billing');
          return;
        }
        try {
          CapApp.exitApp();
        } catch (e) {
          // ignore
        }
        }).then(handle => {
          backListenerHandle = handle;
        }).catch(() => {
          // web fallback
        });
      } catch (e) {
        // not in capacitor
      }
    }

    return () => {
      if (backListenerHandle && backListenerHandle.remove) {
        backListenerHandle.remove();
      }
      window.removeEventListener('pos_sale_completed', handleSaleOrDataUpdate);
      window.removeEventListener('pos_data_updated', handleSaleOrDataUpdate);
      window.removeEventListener('database-rehydrated', handleSaleOrDataUpdate);
      window.removeEventListener('storage', handleSaleOrDataUpdate);
    };
  }, []);

  const loadBusinessData = () => {
    // 1. Fetch businesses which exist in DB (no preseeded fallback)
    const bResult = runSql(`SELECT * FROM businesses`, 'App: Query registered corporate business accounts');
    const bizRows = (bResult.success && Array.isArray(bResult.data)) ? bResult.data : [];
    setBusinesses(bizRows);

    // Scope staff members strictly to active business
    const targetBizId = getActiveBusinessId(activeBusiness?.id);
    const staffRes = targetBizId
      ? runSql(`SELECT * FROM staff WHERE business_id = '${sqlEsc(targetBizId)}' ORDER BY id ASC`, 'App: Query staff accounts')
      : { success: true, data: [] };
    if (staffRes.success && Array.isArray(staffRes.data)) {
      setStaffMembers(staffRes.data);
    } else {
      setStaffMembers([]);
    }

    let currentBiz = activeBusiness;
    if (bizRows.length > 0 && isAuthenticatedSession && activeBusiness.id) {
      const matched = bizRows.find((b: any) => b.id === activeBusiness.id);
      if (matched) {
        currentBiz = matched;
      }
    } else if (bizRows.length === 0 && activeBusiness.id) {
      currentBiz = { id: '', name: '', owner: '', email: '' };
      setActiveBusiness(currentBiz);
      setIsAuthenticatedSession(false);
    }

    // 2. Fetch stores from the single central branches database (strictly scoped to currentBiz.id)
    const allStores = currentBiz?.id ? getCentralBranches(currentBiz.id) : [];
    setStores(allStores);
    if (currentBiz && currentBiz.id && allStores.length > 0) {
      const permittedStores = (userRole !== 'owner' && accessibleStoreIds.length > 0)
        ? allStores.filter((s: any) => accessibleStoreIds.includes(s.id))
        : allStores;
      const listToUse = permittedStores.length > 0 ? permittedStores : allStores;
      const exists = listToUse.find((s: any) => s.id === activeStore);
      if (!exists) {
        const nextStore = listToUse[0].id;
        setActiveStore(nextStore);
        saveScopedActiveBranch(currentBiz.id, nextStore);
      }
    } else {
      setActiveStore('');
    }
  };

  useEffect(() => {
    loadBusinessData();

    const handleDbRestored = () => {
      try {
        const rawBiz = localStorage.getItem('active_business_profile');
        if (rawBiz && localStorage.getItem('pos_authenticated_session') === 'true') {
          const parsedBiz = JSON.parse(rawBiz);
          if (parsedBiz?.id) {
            setActiveBusiness(parsedBiz);
            const scoped = loadScopedBusinessSettings(parsedBiz.id, DEFAULT_SETTINGS, parsedBiz);
            setSettings(scoped);
            switchZraConfigForBusiness(parsedBiz.id, scoped.zraConfig);
          }
        }
      } catch {}
      setSqlSeedTrigger(prev => prev + 1);
      loadBusinessData();
      updateBadgeCounts();
    };
    window.addEventListener('local_db_restored', handleDbRestored);
    return () => {
      window.removeEventListener('local_db_restored', handleDbRestored);
    };
  }, [sqlSeedTrigger, activeBusiness.id]);

  // Enforce role & ticked module access whenever permissions or active tab changes
  useEffect(() => {
    if (!isAuthenticatedSession) return;
    if (!canAccessModule(activeTab, userRole, userPermissions)) {
      setActiveTab2('billing');
    }
  }, [activeTab, userRole, userPermissions, isAuthenticatedSession]);

  const handleRefreshDatabase = (template: SeedTemplate) => {
    initializeDatabase(template, true);
    setSqlSeedTrigger(prev => prev + 1);
  };

  const handleSetTerminalCode = (code: string) => {};

  const handleQuickCloudSync = async () => {
    setIsHeaderSyncing(true);
    setLastHeaderSyncMsg('Syncing...');
    try {
      const targetBizId = activeBusiness?.id || undefined;
      if (targetBizId) {
        let fbSuccess = false;
        if (auth.currentUser) {
          try {
            const fbRes = await backupToCloud(targetBizId, { silentIfNotOwner: true });
            fbSuccess = fbRes.success;
          } catch (fbErr) {
            console.warn('Header Firebase backup notice:', fbErr);
          }
        }
        const pushRes = await pushDatabaseToServer(targetBizId).catch(() => ({ success: false }));
        if (fbSuccess || pushRes.success) {
          setLastHeaderSyncMsg('Synced');
        } else {
          setLastHeaderSyncMsg('Sync Retry');
        }
      } else {
        let restored = false;
        if (auth.currentUser) {
          try {
            const fbPull = await restoreFromCloud(undefined, { silentIfUnlinked: true });
            restored = fbPull.success;
          } catch {}
        }
        if (!restored) {
          const activeWs = unlockedWorkspaces.find((w) => w.businessId === activeBusiness?.id);
          const sessionEmail = normalizeAuthEmail(
            activeWs?.email || localStorage.getItem('logged_in_user_email') || auth.currentUser?.email || ''
          );
          if (sessionEmail && activeWs?.credentialHash) {
            const pullRes = await pullDatabaseFromServer(undefined, sessionEmail, activeWs.credentialHash);
            restored = pullRes.success && pullRes.found;
          }
        }
        if (restored) {
          try {
            const rawSettings = localStorage.getItem('android_pos_settings');
            if (rawSettings) {
              setSettings(prev => ({ ...prev, ...JSON.parse(rawSettings) }));
            }
          } catch {}
          loadBusinessData();
          updateBadgeCounts();
          setSqlSeedTrigger(prev => prev + 1);
          setLastHeaderSyncMsg('Pulled');
        } else {
          setLastHeaderSyncMsg('No Cloud Data');
        }
      }
    } catch (e) {
      setLastHeaderSyncMsg('Offline');
    } finally {
      setIsHeaderSyncing(false);
      setTimeout(() => setLastHeaderSyncMsg(null), 3500);
    }
  };

  // Register New Business Account (100% Isolated Workspace + Strict Credential Auth)
  const handleRegisterBusiness = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthFeedback(null);
    if (!newBizName.trim() || !newBizOwner.trim() || !newBizEmail.trim() || !newBizPassword) {
      setAuthFeedback({ type: 'error', text: 'Please fill out Business Name, Admin/Owner Full Name, Admin Email, and Password.' });
      return;
    }
    if (newBizPassword.trim().length < 6) {
      setAuthFeedback({ type: 'error', text: 'Please enter a password of at least 6 characters for Authentication.' });
      return;
    }

    const cleanEmail = normalizeAuthEmail(newBizEmail.trim());
    const rawPass = newBizPassword.trim();
    const credHash = computeCredentialHashSync(cleanEmail, rawPass);
    const bizId = 'biz_' + Math.floor(1000 + Math.random() * 9000);
    const hasInitialStore = Boolean(newBizFirstStore.trim());
    const storeId = hasInitialStore ? ('store_' + Math.floor(1000 + Math.random() * 9000)) : '';
    const rawStoreName = newBizFirstStore.trim();
    const rawLocation = newBizLocation.trim();
    const resolvedCurrency = newBizCurrency.trim() || 'K';
    const resolvedTaxRate = !isNaN(parseFloat(newBizTaxRate)) ? parseFloat(newBizTaxRate) : 0;
    const nowStr = new Date().toISOString();

    // 1. Register / Authenticate Admin using strict (email + password) credential identity
    try {
      await signInOrCreateCredentialAuth(cleanEmail, rawPass, {
        allowCreate: true,
        displayName: newBizOwner.trim(),
      });
    } catch (fbAuthErr: any) {
      console.warn('Firebase Credential Auth registration notice:', fbAuthErr);
    }

    // 2. Insert registration record into BUSINESSES
    runSql(`
      INSERT INTO businesses (
        id, name, owner, email, password, billing_address, billing_city, billing_country,
        billing_phone, billing_email, tpin, currency, tax_rate, admin_role, created_at, business_id, store_id
      ) VALUES (
        '${bizId}',
        '${sqlEsc(newBizName.trim())}',
        '${sqlEsc(newBizOwner.trim())}',
        '${sqlEsc(cleanEmail)}',
        '${sqlEsc(rawPass)}',
        '${sqlEsc(newBizBillingAddress.trim())}',
        '${sqlEsc(newBizBillingCity.trim())}',
        '${sqlEsc(newBizBillingCountry.trim())}',
        '${sqlEsc(newBizBillingPhone.trim())}',
        '${sqlEsc(newBizBillingEmail.trim() || cleanEmail)}',
        '${sqlEsc(newBizTpin.trim())}',
        '${sqlEsc(resolvedCurrency)}',
        ${resolvedTaxRate},
        'admin',
        '${nowStr}',
        '${bizId}',
        '${storeId || 'main'}'
      )
    `, `Registration: Create isolated enterprise workspace [${newBizName}] with Owner privileges`);

    // Provision isolated chart of accounts for this business
    seedChartOfAccountsOnly(bizId);

    // 3. Provision primary store outlet if specified
    if (hasInitialStore && storeId) {
      runSql(`
        INSERT INTO stores (id, business_id, name, location, phone, email, allow_discounts, allow_refunds, allow_laybys, require_manager_discount, store_id) VALUES (
          '${storeId}',
          '${bizId}',
          '${sqlEsc(rawStoreName)}',
          '${sqlEsc(rawLocation)}',
          '${sqlEsc(newBizBillingPhone.trim())}',
          '${sqlEsc(newBizBillingEmail.trim() || cleanEmail)}',
          1, 1, 1, 0, '${storeId}'
        )
      `, `Registration: Provision initial store outlet [${rawStoreName}]`);
    }

    // 4. Register Owner in STAFF & decoupled USERS + BUSINESS_MEMBERSHIPS
    const nextStaffId = Date.now() % 1000000;
    runSql(`
      INSERT INTO staff (id, name, role, hourly_rate, pin, email, password, store_id, business_id) VALUES (
        '${nextStaffId}',
        '${sqlEsc(newBizOwner.trim())}',
        'owner',
        0,
        '0000',
        '${sqlEsc(cleanEmail)}',
        '${sqlEsc(rawPass)}',
        '${storeId}',
        '${bizId}'
      )
    `, `Registration: Provision first account [${newBizOwner.trim()}] as Owner`);

    const ownerPerms = buildUserPermissions({ role: 'owner' });
    const ownerMem = upsertUserAndMembership({
      businessId: bizId,
      email: cleanEmail,
      fullName: newBizOwner.trim(),
      password: rawPass,
      credentialHash: credHash,
      role: 'owner',
      storeId: storeId || 'main',
      accessibleBranches: [],
      permissionsJson: JSON.stringify(ownerPerms),
      status: 'ACTIVE',
    });

    // 5. Update isolated StoreSettings & ZRA config strictly for this business
    const bizZra = switchZraConfigForBusiness(bizId);
    const updatedSettings: StoreSettings = {
      ...DEFAULT_SETTINGS,
      storeName: newBizName.trim(),
      currency: resolvedCurrency,
      taxRate: resolvedTaxRate,
      tpin: newBizTpin.trim(),
      billingAddress: newBizBillingAddress.trim(),
      billingCity: newBizBillingCity.trim(),
      billingCountry: newBizBillingCountry.trim(),
      billingPhone: newBizBillingPhone.trim(),
      billingEmail: newBizBillingEmail.trim() || cleanEmail,
      receiptHeader: 'Official Tax Invoice & Sales Receipt',
      receiptFooter: 'Thank you for your business!',
      zraConfig: bizZra,
    };
    setSettings(updatedSettings);
    saveScopedBusinessSettings(bizId, updatedSettings);

    const newlyRegisteredBusiness = {
      id: bizId,
      name: newBizName.trim(),
      owner: newBizOwner.trim(),
      email: cleanEmail,
    };

    // 6. Save authenticated Admin session & register into Unlocked Workspaces
    const openCashNum = Math.max(0, parseFloat(newBizOpeningCash || '0') || 0);
    localStorage.setItem('active_business_profile', JSON.stringify(newlyRegisteredBusiness));
    localStorage.setItem('pos_authenticated_session', 'true');
    localStorage.setItem('pos_shift_active', 'true');
    if (storeId) {
      saveScopedActiveBranch(bizId, storeId);
      localStorage.setItem('shift_active_' + storeId, 'true');
      localStorage.setItem('shift_opening_cash_' + storeId, openCashNum.toFixed(2));
    } else {
      saveScopedActiveBranch(bizId, '');
    }
    localStorage.setItem('shift_opening_cash_global', openCashNum.toFixed(2));
    localStorage.setItem('logged_in_user_email', cleanEmail);
    localStorage.setItem('logged_in_user_name', newBizOwner.trim());
    localStorage.setItem('quick_salesperson_name', newBizOwner.trim());
    localStorage.setItem('logged_in_user_role', 'owner');
    localStorage.setItem('logged_in_accessible_branches', JSON.stringify([]));
    saveSessionPermissionsToStorage(ownerPerms, 'owner');

    const nextUnlocked = upsertUnlockedWorkspace({
      businessId: bizId,
      businessName: newBizName.trim(),
      membershipId: String(ownerMem?.id || deriveMembershipId(bizId, deriveUserId(cleanEmail), 'owner')),
      userId: String(ownerMem?.user_id || deriveUserId(cleanEmail)),
      email: cleanEmail,
      fullName: newBizOwner.trim(),
      role: 'owner',
      credentialHash: credHash,
      accessibleBranches: [],
      permissionsJson: JSON.stringify(ownerPerms),
      storeId: storeId || 'main',
      unlockedAt: nowStr,
    });
    setUnlockedWorkspaces(nextUnlocked);

    setActiveBusiness(newlyRegisteredBusiness);
    setAccessibleStoreIds([]);
    setActiveStore(storeId);
    setUserRole('owner');
    setAuthenticatedRole('owner');
    setUserPermissions(ownerPerms);
    setIsAuthenticatedSession(true);
    setIsCreatingNewWorkspace(false);
    persistTablesToStorage();
    setSqlSeedTrigger(prev => prev + 1);

    // 7. Synchronize new business & store immediately to Cloud SQL + Firebase Firestore & Credential Directory
    pushDatabaseToServer(bizId).catch(err => console.warn('Initial Cloud SQL push warning:', err));
    if (auth.currentUser) {
      backupToCloud(bizId).catch(err => console.warn('Initial Firebase backup warning:', err));
    }

    // Reset form fields
    setNewBizName('');
    setNewBizOwner('');
    setNewBizEmail('');
    setNewBizPassword('');
    setNewBizFirstStore('');
    setNewBizLocation('');
    setNewBizCurrency('');
    setNewBizTaxRate('');
    setNewBizTpin('');
    setNewBizOpeningCash('');
    setNewBizBillingAddress('');
    setNewBizBillingCity('');
    setNewBizBillingCountry('');
    setNewBizBillingPhone('');
    setNewBizBillingEmail('');

    if (!storeId) {
      openUnifiedSettings('stores');
    } else {
      setActiveTab2('billing');
    }

    window.dispatchEvent(new Event('pos_data_updated'));
  };

  // Switch cleanly to an already-unlocked business workspace session
  const activateUnlockedWorkspaceSession = async (
    ws: UnlockedWorkspaceSession,
    options?: { explicitBranch?: string; promptBranchGate?: boolean; skipFirebaseReauth?: boolean }
  ) => {
    const bRes = runSql(`SELECT * FROM businesses WHERE id = '${sqlEsc(ws.businessId)}'`, 'Workspace Switch: Load business profile');
    const bizRow = (bRes.success && Array.isArray(bRes.data) && bRes.data.length > 0)
      ? bRes.data[0]
      : { id: ws.businessId, name: ws.businessName, owner: ws.fullName, email: ws.email };

    const normRole = normalizeRole(ws.role);
    const resolvedPerms: UserPermissions =
      normRole === 'owner'
        ? buildUserPermissions({ role: 'owner' })
        : parseStaffPermissions(ws.permissionsJson, normRole);

    let allowedBranches: string[] = [];
    if (normRole !== 'owner') {
      allowedBranches = Array.isArray(ws.accessibleBranches) && ws.accessibleBranches.length > 0
        ? ws.accessibleBranches
        : (resolvedPerms.accessible_branches || []);
      if (allowedBranches.length === 0 && ws.storeId && ws.storeId !== 'main') {
        allowedBranches = [ws.storeId];
      }
    }

    const activeBizObj = {
      id: bizRow.id,
      name: bizRow.name || ws.businessName,
      owner: bizRow.owner || ws.fullName,
      email: bizRow.email || ws.email,
    };

    const allStores = getCentralBranches(bizRow.id);
    const permittedStores = (normRole !== 'owner' && allowedBranches.length > 0)
      ? allStores.filter((s: any) => allowedBranches.includes(s.id))
      : allStores;
    const availableStores = permittedStores.length > 0 ? permittedStores : allStores;

    let chosenBranch = '';
    if (availableStores.length > 0) {
      const savedScopedBranch = loadScopedActiveBranch(bizRow.id);
      if (options?.explicitBranch && availableStores.some((s: any) => s.id === options.explicitBranch)) {
        chosenBranch = options.explicitBranch;
      } else if (savedScopedBranch && availableStores.some((s: any) => s.id === savedScopedBranch)) {
        chosenBranch = savedScopedBranch;
      } else if (ws.storeId && availableStores.some((s: any) => s.id === ws.storeId)) {
        chosenBranch = ws.storeId;
      } else {
        chosenBranch = availableStores[0].id;
      }
    }

    // Isolate settings & ZRA config strictly to this businessId
    const scopedSettings = loadScopedBusinessSettings(bizRow.id, DEFAULT_SETTINGS, bizRow);
    const scopedZra = switchZraConfigForBusiness(bizRow.id, scopedSettings.zraConfig);
    scopedSettings.zraConfig = scopedZra;

    saveScopedBusinessSettings(bizRow.id, scopedSettings);
    saveScopedActiveBranch(bizRow.id, chosenBranch);

    localStorage.setItem('active_business_profile', JSON.stringify(activeBizObj));
    localStorage.setItem('pos_authenticated_session', 'true');
    localStorage.setItem('logged_in_accessible_branches', JSON.stringify(allowedBranches));
    localStorage.setItem('logged_in_user_role', normRole);
    localStorage.setItem('logged_in_user_email', ws.email);
    localStorage.setItem('logged_in_user_name', ws.fullName);
    localStorage.setItem('quick_salesperson_name', ws.fullName);
    saveSessionPermissionsToStorage(resolvedPerms, normRole);

    if (chosenBranch) {
      localStorage.setItem('pos_shift_active', 'true');
      localStorage.setItem('shift_active_' + chosenBranch, 'true');
    }

    setSettings(scopedSettings);
    setActiveBusiness(activeBizObj);
    setAccessibleStoreIds(allowedBranches);
    setStores(allStores);
    setActiveStore(chosenBranch);
    setUserRole(normRole);
    setAuthenticatedRole(normRole);
    setUserPermissions(resolvedPerms);
    setIsAuthenticatedSession(true);
    setIsCreatingNewWorkspace(false);
    setShowWorkspaceDropdown(false);
    setActiveTab2('billing');

    if (options?.promptBranchGate && !options?.explicitBranch && availableStores.length > 0) {
      setShowBranchChoiceGate(true);
    }

    if (!options?.skipFirebaseReauth && ws.credentialHash) {
      void signInWithCredentialHash(ws.credentialHash, ws.fullName);
    }

    setSqlSeedTrigger(prev => prev + 1);
    window.dispatchEvent(new Event('pos_data_updated'));
  };

  // Strict (email + password) authentication resolver used for both Log In & Unlock Another Workspace
  const authenticateAndResolveWorkspace = async (
    targetEmailRaw: string,
    targetPassRaw: string,
    options?: { targetBranch?: string; preserveExistingUnlocked?: boolean }
  ): Promise<{ success: boolean; error?: string; workspace?: UnlockedWorkspaceSession }> => {
    const cleanEmail = normalizeAuthEmail(targetEmailRaw);
    const rawPass = String(targetPassRaw || '').trim();
    if (!cleanEmail || !rawPass) {
      return { success: false, error: 'Please enter both Email and Password.' };
    }

    const credHash = computeCredentialHashSync(cleanEmail, rawPass);
    const previousActiveWs = unlockedWorkspaces.find((w) => w.businessId === activeBusiness?.id);
    const restorePreviousAuthIfNeeded = async () => {
      if (options?.preserveExistingUnlocked && previousActiveWs?.credentialHash) {
        await signInWithCredentialHash(previousActiveWs.credentialHash, previousActiveWs.fullName);
      } else if (!options?.preserveExistingUnlocked) {
        await googleSignOut();
      }
    };

    try {
      // 1. Pull strictly matching (email, credentialHash) records from Cloud SQL
      await pullDatabaseFromServer(undefined, cleanEmail, credHash).catch(() => ({ success: false, found: false }));

      // 2. Query local decoupled memberships strictly by (email, password)
      let credMatches = resolveMembershipsByCredential(cleanEmail, rawPass);

      // 3. Authenticate with strict credential-scoped Firebase Auth
      let fbAuthRes: Awaited<ReturnType<typeof signInOrCreateCredentialAuth>> | null = null;
      try {
        fbAuthRes = await signInOrCreateCredentialAuth(cleanEmail, rawPass, {
          allowCreate: credMatches.length > 0,
          displayName: credMatches[0]?.fullName,
          allowLegacyFallback: credMatches.length === 0,
        });
      } catch (fbErr: any) {
        if (credMatches.length === 0) {
          await restorePreviousAuthIfNeeded();
          return { success: false, error: fbErr?.message || 'Authentication failed for these credentials.' };
        }
      }

      // 4. Discover & claim invited staff / multi-tenant owner memberships from Cloud Firestore (/credential_directory/{credId})
      if (auth.currentUser) {
        try {
          const claimRes = await claimCredentialInviteAndRestore(cleanEmail, rawPass);
          if (claimRes.found && claimRes.suspended) {
            await restorePreviousAuthIfNeeded();
            return {
              success: false,
              error: 'Account Suspended: Your access has been suspended by an Administrator. Please contact your Business Owner.',
            };
          }
          if (claimRes.found && claimRes.businessId) {
            credMatches = resolveMembershipsByCredential(cleanEmail, rawPass);
          } else if (fbAuthRes?.isLegacyAuth && credMatches.length === 0) {
            await restoreFromCloud(undefined, { silentIfUnlinked: true }).catch(() => {});
            const bRes = runSql(`SELECT * FROM businesses`, 'Cloud Login: Check legacy owned business');
            const bizList = (bRes.success && Array.isArray(bRes.data)) ? bRes.data : [];
            const ownedLegacyBiz = bizList.find((b: any) => normalizeAuthEmail(b?.email || '') === cleanEmail);
            if (ownedLegacyBiz) {
              upsertUserAndMembership({
                businessId: String(ownedLegacyBiz.id),
                email: cleanEmail,
                fullName: String(ownedLegacyBiz.owner || 'Owner'),
                password: rawPass,
                credentialHash: credHash,
                role: 'owner',
                storeId: String(ownedLegacyBiz.store_id || 'main'),
                status: 'ACTIVE',
              });
              credMatches = resolveMembershipsByCredential(cleanEmail, rawPass);
            }
          } else if (credMatches.length > 0 && navigator.onLine !== false) {
            const primaryMatch = credMatches[0];
            const primaryBizId = String(primaryMatch.business.id);
            let fsAccess = await hasVerifiedFirestoreAccessToBusiness(primaryBizId);
            if (!fsAccess.hasAccess && primaryMatch.role === 'owner') {
              const migrated = await tryMigrateLegacyOwnerToCredentialAuth({
                email: cleanEmail,
                password: rawPass,
                businessId: primaryBizId,
                businessName: String(primaryMatch.business.name || primaryBizId),
                fullName: primaryMatch.fullName,
                storeId: String(primaryMatch.business?.store_id || 'main'),
                permissionsJson: primaryMatch.permissionsJson,
              });
              if (migrated) {
                fsAccess = await hasVerifiedFirestoreAccessToBusiness(primaryBizId);
              }
            }
            if (fsAccess.hasAccess) {
              await restoreFromCloud(primaryBizId, { silentIfUnlinked: true }).catch(() => {});
            }
            upsertUserAndMembership({
              id: primaryMatch.membership?.id,
              businessId: primaryBizId,
              email: cleanEmail,
              fullName: primaryMatch.fullName,
              password: rawPass,
              credentialHash: credHash,
              role: primaryMatch.role,
              storeId: String(primaryMatch.staffRow?.store_id || primaryMatch.business?.store_id || 'main'),
              accessibleBranches: primaryMatch.accessibleBranches,
              permissionsJson: primaryMatch.permissionsJson,
              status: primaryMatch.isSuspended ? 'SUSPENDED' : 'ACTIVE',
            });
            credMatches = resolveMembershipsByCredential(cleanEmail, rawPass);
          }
        } catch (cloudErr) {
          console.warn('Credential directory restore notice:', cloudErr);
        }
      }

      if (credMatches.length === 0) {
        await restorePreviousAuthIfNeeded();
        return {
          success: false,
          error: `No registered business or staff membership matched [${cleanEmail}] with that password. Check your password or create a new business account.`,
        };
      }

      const activeMatches = credMatches.filter(
        (m) => !m.isSuspended && !(m.role !== 'owner' && isUserSuspended(m.permissionsJson))
      );
      if (activeMatches.length === 0) {
        await restorePreviousAuthIfNeeded();
        return {
          success: false,
          error: 'Account Suspended: Your access has been suspended by an Administrator. Please contact your Business Owner.',
        };
      }

      const chosen = activeMatches[0];
      const chosenPerms: UserPermissions =
        chosen.role === 'owner' && !chosen.staffRow
          ? buildUserPermissions({ role: 'owner' })
          : parseStaffPermissions(chosen.permissionsJson, chosen.role);

      let userAllowedBranches: string[] = [];
      if (chosen.role !== 'owner') {
        userAllowedBranches = chosen.accessibleBranches.length > 0
          ? chosen.accessibleBranches
          : (chosenPerms.accessible_branches || []);
        if (userAllowedBranches.length === 0 && chosen.staffRow?.store_id) {
          userAllowedBranches = [String(chosen.staffRow.store_id)];
        }
      }

      if (options?.targetBranch && userAllowedBranches.length > 0 && !userAllowedBranches.includes(options.targetBranch)) {
        await restorePreviousAuthIfNeeded();
        return {
          success: false,
          error: `Access Denied: Account [${cleanEmail}] does not have permission to access branch [${options.targetBranch.toUpperCase()}].`,
        };
      }

      if (!options?.preserveExistingUnlocked) {
        clearUnlockedWorkspaces();
      }

      let updatedList = getUnlockedWorkspaces();
      let activatedWs: UnlockedWorkspaceSession | null = null;
      const nowIso = new Date().toISOString();

      for (const m of activeMatches) {
        const mPerms: UserPermissions =
          m.role === 'owner' && !m.staffRow
            ? buildUserPermissions({ role: 'owner' })
            : parseStaffPermissions(m.permissionsJson, m.role);
        const wsEntry: UnlockedWorkspaceSession = {
          businessId: String(m.business.id),
          businessName: String(m.business.name || m.business.id),
          membershipId: String(m.membership?.id || deriveMembershipId(String(m.business.id), deriveUserId(cleanEmail), m.role)),
          userId: String(m.membership?.user_id || deriveUserId(cleanEmail)),
          email: cleanEmail,
          fullName: m.fullName,
          role: m.role,
          credentialHash: credHash,
          accessibleBranches: m.role === 'owner' ? [] : (m.accessibleBranches.length > 0 ? m.accessibleBranches : (mPerms.accessible_branches || [])),
          permissionsJson: m.permissionsJson,
          storeId: String(m.staffRow?.store_id || m.business?.store_id || 'main'),
          unlockedAt: nowIso,
        };
        updatedList = upsertUnlockedWorkspace(wsEntry);
        if (!activatedWs) activatedWs = wsEntry;
      }

      setUnlockedWorkspaces(updatedList);

      if (activatedWs) {
        await activateUnlockedWorkspaceSession(activatedWs, {
          explicitBranch: options?.targetBranch,
          promptBranchGate: !options?.preserveExistingUnlocked,
          skipFirebaseReauth: true,
        });

        // Ensure owner credentials & backup are published when Firestore access is active
        if (auth.currentUser && activatedWs.role === 'owner') {
          void hasVerifiedFirestoreAccessToBusiness(activatedWs.businessId).then((fsAccess) => {
            if (!fsAccess.hasAccess) return;
            publishCredentialMembershipToCloud({
              businessId: activatedWs.businessId,
              businessName: activatedWs.businessName,
              membershipId: activatedWs.membershipId,
              userId: activatedWs.userId,
              email: activatedWs.email,
              fullName: activatedWs.fullName,
              role: 'owner',
              password: rawPass,
              credentialHash: credHash,
              storeId: activatedWs.storeId,
              accessibleBranches: [],
              permissionsJson: activatedWs.permissionsJson,
              status: 'ACTIVE',
            }).catch(() => {});
            backupToCloud(activatedWs.businessId, { silentIfNotOwner: true }).catch(() => {});
          });
        }
      }

      return { success: true, workspace: activatedWs || undefined };
    } catch (err: any) {
      await restorePreviousAuthIfNeeded();
      return { success: false, error: err?.message || String(err) };
    }
  };

  // Sign In & Pull Existing Business or Staff Account from Firebase Auth + Cloud SQL / Firestore
  const handleSyncExistingAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthFeedback(null);
    const targetEmail = syncLoginEmail.trim();
    const targetPass = syncLoginPassword.trim();
    if (!targetEmail || !targetPass) {
      setAuthFeedback({ type: 'error', text: 'Please enter your Email and Password.' });
      return;
    }

    setIsHeaderSyncing(true);
    try {
      const res = await authenticateAndResolveWorkspace(targetEmail, targetPass, {
        targetBranch: syncLoginBranch || undefined,
        preserveExistingUnlocked: false,
      });
      if (!res.success) {
        setAuthFeedback({ type: 'error', text: res.error || 'Invalid credentials.' });
        return;
      }
      setSyncLoginEmail('');
      setSyncLoginPassword('');
      setSyncLoginBranch('');
    } catch (err: any) {
      setAuthFeedback({ type: 'error', text: `Sign-In Error: ${err?.message || String(err)}` });
    } finally {
      setIsHeaderSyncing(false);
    }
  };

  // Unlock and add an additional Business Workspace strictly by (email, password) while staying signed in
  const handleUnlockAnotherWorkspace = async (
    emailInput: string,
    passwordInput: string
  ): Promise<{ success: boolean; error?: string }> => {
    setIsUnlockingWorkspace(true);
    try {
      const res = await authenticateAndResolveWorkspace(emailInput, passwordInput, {
        preserveExistingUnlocked: true,
      });
      if (!res.success) {
        return { success: false, error: res.error || 'Could not unlock workspace with these credentials.' };
      }
      return { success: true };
    } finally {
      setIsUnlockingWorkspace(false);
    }
  };

  const handleLogoutAccount = async () => {
    const logoutBizId = activeBusiness?.id;
    if (
      logoutBizId &&
      logoutBizId !== 'default_biz' &&
      auth.currentUser &&
      (typeof navigator === 'undefined' || navigator.onLine !== false)
    ) {
      try {
        await Promise.race([
          backupToCloud(logoutBizId, { silentIfNotOwner: true }),
          new Promise((resolve) => setTimeout(resolve, 2500)),
        ]);
      } catch {}
    }

    localStorage.removeItem('pos_authenticated_session');
    localStorage.removeItem('active_business_profile');
    localStorage.removeItem('active_store_branch');
    localStorage.removeItem('pos_shift_active');
    localStorage.removeItem('logged_in_accessible_branches');
    localStorage.removeItem('logged_in_user_role');
    localStorage.removeItem('logged_in_user_email');
    localStorage.removeItem('logged_in_user_name');
    localStorage.removeItem('quick_salesperson_name');
    localStorage.removeItem('android_pos_settings');
    clearSessionPermissionsFromStorage();
    clearUnlockedWorkspaces();
    switchZraConfigForBusiness('');

    setUnlockedWorkspaces([]);
    setShowWorkspaceDropdown(false);
    setShowUnlockWorkspaceModal(false);
    setIsCreatingNewWorkspace(false);
    setSettings(DEFAULT_SETTINGS);
    setActiveBusiness({ id: '', name: '', owner: '', email: '' });
    setActiveStore('');
    setStores([]);
    setAccessibleStoreIds([]);
    setCustomersList([]);
    setStaffMembers([]);
    setSyncLoginEmail('');
    setSyncLoginPassword('');
    setSyncLoginBranch('');
    setUserRole('owner');
    setAuthenticatedRole('owner');
    setUserPermissions(buildUserPermissions({ role: 'owner' }));
    setIsAuthenticatedSession(false);
    setShowBranchChoiceGate(false);
    setShowNavDrawer(false);
    setActiveTab2('billing');
    setAuthScreenMode('login');

    await googleSignOut();
  };

  // Switch workspace immediately and isolate branch/tenant data
  const handleSelectBusinessWorkspace = async (target: any) => {
    // Prefer strict UnlockedWorkspaceSession entry
    if (target?.businessId && target?.credentialHash) {
      await activateUnlockedWorkspaceSession(target as UnlockedWorkspaceSession);
      return;
    }
    const matchingWs = unlockedWorkspaces.find((w) => w.businessId === target?.id);
    if (matchingWs) {
      await activateUnlockedWorkspaceSession(matchingWs);
      return;
    }
    // Never switch to an unverified business without credentials
    setUnlockEmail(activeBusiness?.email || '');
    setUnlockPassword('');
    setUnlockFeedback({
      type: 'error',
      text: `Enter the password for [${target?.name || 'this business'}] to verify and switch workspaces.`,
    });
    setShowUnlockWorkspaceModal(true);
  };

  // Compute branches accessible to the currently logged-in account
  const accessibleStores = (userRole !== 'owner' && accessibleStoreIds.length > 0)
    ? stores.filter(s => accessibleStoreIds.includes(s.id))
    : stores;

  const handleSwitchBranch = (branchId: string) => {
    setActiveStore(branchId);
    saveScopedActiveBranch(activeBusiness?.id || '', branchId);
    localStorage.setItem('pos_shift_active', 'true');
    localStorage.setItem('shift_active_' + branchId, 'true');
    setSqlSeedTrigger(prev => prev + 1);
    updateBadgeCounts();
    window.dispatchEvent(new Event('pos_data_updated'));
  };

  // Get active store authorization rules
  const activeOutletConfiguration = stores.find(s => s.id === activeStore) || {
    allow_discounts: 1,
    allow_refunds: 1,
    allow_laybys: 1,
    require_manager_discount: 0
  };

  return (
    <AndroidShell
      activeTab={activeTab}
      setActiveTab={setActiveTab2}
      showSqlSplit={showSqlSplit}
      setShowSqlSplit={setShowSqlSplit}
      storeName={isAuthenticatedSession && activeBusiness.id ? (settings.storeName || activeBusiness.name || '') : ''}
    >
      {!isAuthenticatedSession || !activeBusiness.id || isCreatingNewWorkspace ? (
        /* FULL-SCREEN LOG IN OR CREATE ACCOUNT ONBOARDING GATE (NO PRE-SEEDED DETAILS, BRANCHES, OR STOCK) */
        <div className="flex-1 flex flex-col items-center justify-center bg-slate-950 text-slate-100 p-4 sm:p-6 overflow-y-auto select-none">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col my-auto"
          >
            {/* Onboarding Banner Header */}
            <div className="bg-gradient-to-r from-indigo-950 via-slate-900 to-slate-900 border-b border-slate-800 p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-xl bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400 shrink-0 shadow-inner">
                  <ShieldCheck size={24} />
                </div>
                <div>
                  <h1 className="text-base sm:text-lg font-black tracking-tight text-white uppercase font-sans">
                    Enterprise POS & Cloud Accounting
                  </h1>
                </div>
              </div>

              {/* Switch between Log In & Create Account (or return to active workspace) */}
              <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
                {isCreatingNewWorkspace && isAuthenticatedSession && activeBusiness.id && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreatingNewWorkspace(false);
                      setAuthFeedback(null);
                    }}
                    className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-extrabold uppercase tracking-wider cursor-pointer"
                  >
                    ← Back to {activeBusiness.name}
                  </button>
                )}
                <PWAInstallButton variant="header" />
                {!isCreatingNewWorkspace && (
                  <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setAuthFeedback(null);
                      setAuthScreenMode('login');
                    }}
                    className={`px-3.5 py-2 rounded-lg text-xs font-extrabold uppercase tracking-wider transition-all cursor-pointer ${
                      authScreenMode === 'login'
                        ? 'bg-emerald-600 text-white shadow-md'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Log In
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthFeedback(null);
                      setAuthScreenMode('register');
                    }}
                    className={`px-3.5 py-2 rounded-lg text-xs font-extrabold uppercase tracking-wider transition-all cursor-pointer ${
                      authScreenMode === 'register'
                        ? 'bg-indigo-600 text-white shadow-md'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Create Account
                  </button>
                  </div>
                )}
              </div>
            </div>

            {/* Form Body */}
            <div className="p-5 sm:p-6 overflow-y-auto max-h-[76vh]">
              {authFeedback && (
                <div
                  className={`mb-4 px-3.5 py-2.5 rounded-xl border text-xs font-bold flex items-center justify-between gap-2 ${
                    authFeedback.type === 'error'
                      ? 'bg-rose-950/70 border-rose-500/50 text-rose-200'
                      : authFeedback.type === 'warning'
                        ? 'bg-amber-950/70 border-amber-500/50 text-amber-200'
                        : 'bg-emerald-950/70 border-emerald-500/50 text-emerald-200'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <AlertCircle size={15} className="shrink-0" />
                    <span>{authFeedback.text}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAuthFeedback(null)}
                    className="text-[10px] font-black uppercase px-2 py-0.5 rounded bg-black/20 hover:bg-black/40 cursor-pointer shrink-0"
                  >
                    Dismiss
                  </button>
                </div>
              )}
              {authScreenMode === 'login' ? (
                <div className="flex flex-col gap-5">
                  <form onSubmit={handleSyncExistingAccount} className="flex flex-col gap-4">
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                        Email Address (Admin or Staff User) *
                      </label>
                      <input
                        type="email"
                        value={syncLoginEmail}
                        onChange={(e) => setSyncLoginEmail(e.target.value)}
                        placeholder="Enter your registered email address"
                        required
                        className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 font-mono text-xs focus:border-emerald-500 focus:outline-hidden"
                      />
                    </div>

                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                        Password / Staff PIN *
                      </label>
                      <input
                        type="password"
                        value={syncLoginPassword}
                        onChange={(e) => setSyncLoginPassword(e.target.value)}
                        placeholder="Enter your account password"
                        required
                        className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 font-mono text-xs focus:border-emerald-500 focus:outline-hidden"
                      />
                    </div>

                    {stores.length > 0 && (
                      <div>
                        <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                          Select Branch
                        </label>
                        <select
                          value={syncLoginBranch}
                          onChange={(e) => setSyncLoginBranch(e.target.value)}
                          className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 font-bold text-xs focus:border-emerald-500 focus:outline-hidden cursor-pointer uppercase"
                        >
                          <option value="">— Select Branch ({stores.length} Available) —</option>
                          {stores.map((st: any) => (
                            <option key={st.id} value={st.id}>
                              📍 {st.name} {st.location ? `(${st.location})` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={isHeaderSyncing}
                      className="mt-1 py-3 px-5 bg-emerald-600 hover:bg-emerald-500 text-white font-black uppercase rounded-xl text-xs tracking-wider cursor-pointer shadow-lg flex items-center justify-center gap-2 transition-all"
                    >
                      <RefreshCw size={15} className={isHeaderSyncing ? 'animate-spin' : ''} />
                      <span>{isHeaderSyncing ? 'Authenticating...' : 'Log In'}</span>
                    </button>
                  </form>
                </div>
              ) : (
                <form onSubmit={handleRegisterBusiness} className="flex flex-col gap-4">

                  {/* Section 1: Admin Account Credentials */}
                  <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800/90 flex flex-col gap-3">
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-indigo-400 font-mono flex items-center gap-1.5">
                      <UserCheck size={13} /> 1. Admin Account Credentials (First Account = Admin)
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="text-[9.5px] text-slate-400 font-bold uppercase block mb-1">Admin Full Name *</label>
                        <input
                          type="text"
                          value={newBizOwner}
                          onChange={(e) => setNewBizOwner(e.target.value)}
                          placeholder="Enter Admin / Owner full name"
                          required
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 text-xs font-bold focus:border-indigo-500 focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="text-[9.5px] text-slate-400 font-bold uppercase block mb-1">Admin Login Email *</label>
                        <input
                          type="email"
                          value={newBizEmail}
                          onChange={(e) => setNewBizEmail(e.target.value)}
                          placeholder="Enter Admin email address"
                          required
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:border-indigo-500 focus:outline-hidden"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[9.5px] text-slate-400 font-bold uppercase block mb-1">Admin Password (Min 6 Characters) *</label>
                      <input
                        type="password"
                        value={newBizPassword}
                        onChange={(e) => setNewBizPassword(e.target.value)}
                        placeholder="Create a strong password"
                        required
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:border-indigo-500 focus:outline-hidden"
                      />
                    </div>
                  </div>

                  {/* Section 2: Business Setup & Billing Address */}
                  <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800/90 flex flex-col gap-3">
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-emerald-400 font-mono flex items-center gap-1.5">
                      <Building2 size={13} /> 2. Business Setup & Billing Address
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="text-[9.5px] text-slate-400 font-bold uppercase block mb-1">Business / Company Name *</label>
                        <input
                          type="text"
                          value={newBizName}
                          onChange={(e) => setNewBizName(e.target.value)}
                          placeholder="Enter registered business name"
                          required
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 text-xs font-bold focus:border-indigo-500 focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="text-[9.5px] text-slate-400 font-bold uppercase block mb-1">Tax ID / TPIN</label>
                        <input
                          type="text"
                          value={newBizTpin}
                          onChange={(e) => setNewBizTpin(e.target.value)}
                          placeholder="Optional Tax ID / TPIN"
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:border-indigo-500 focus:outline-hidden"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2">
                        <label className="text-[9.5px] text-slate-400 font-bold uppercase block mb-1">Billing Street Address</label>
                        <input
                          type="text"
                          value={newBizBillingAddress}
                          onChange={(e) => setNewBizBillingAddress(e.target.value)}
                          placeholder="Street address, plot number, building"
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 text-xs focus:border-indigo-500 focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="text-[9.5px] text-slate-400 font-bold uppercase block mb-1">Billing City</label>
                        <input
                          type="text"
                          value={newBizBillingCity}
                          onChange={(e) => setNewBizBillingCity(e.target.value)}
                          placeholder="City / Town"
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 text-xs focus:border-indigo-500 focus:outline-hidden"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="text-[9.5px] text-slate-400 font-bold uppercase block mb-1">Billing Country</label>
                        <input
                          type="text"
                          value={newBizBillingCountry}
                          onChange={(e) => setNewBizBillingCountry(e.target.value)}
                          placeholder="Country"
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 text-xs focus:border-indigo-500 focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="text-[9.5px] text-slate-400 font-bold uppercase block mb-1">Billing Phone</label>
                        <input
                          type="text"
                          value={newBizBillingPhone}
                          onChange={(e) => setNewBizBillingPhone(e.target.value)}
                          placeholder="Business phone"
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:border-indigo-500 focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="text-[9.5px] text-slate-400 font-bold uppercase block mb-1">Currency & VAT %</label>
                        <div className="grid grid-cols-2 gap-1.5">
                          <input
                            type="text"
                            value={newBizCurrency}
                            onChange={(e) => setNewBizCurrency(e.target.value)}
                            placeholder="Curr (K/$)"
                            className="w-full px-2 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:border-indigo-500 focus:outline-hidden"
                          />
                          <input
                            type="number"
                            step="0.1"
                            value={newBizTaxRate}
                            onChange={(e) => setNewBizTaxRate(e.target.value)}
                            placeholder="VAT %"
                            className="w-full px-2 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:border-indigo-500 focus:outline-hidden"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Section 3: First Store / Branch Setup (Optional at signup or create inside Admin Setup) */}
                  <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800/90 flex flex-col gap-3">
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-amber-400 font-mono flex items-center gap-1.5">
                      <MapPin size={13} /> 3. Initial Store / Branch Setup (Optional — Or Create Later in Admin Setup)
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="text-[9.5px] text-slate-400 font-bold uppercase block mb-1">Store / Branch Name</label>
                        <input
                          type="text"
                          value={newBizFirstStore}
                          onChange={(e) => setNewBizFirstStore(e.target.value)}
                          placeholder="Leave blank or enter store name"
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 text-xs focus:border-indigo-500 focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="text-[9.5px] text-slate-400 font-bold uppercase block mb-1">Store Location</label>
                        <input
                          type="text"
                          value={newBizLocation}
                          onChange={(e) => setNewBizLocation(e.target.value)}
                          placeholder="Branch address / city"
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 text-xs focus:border-indigo-500 focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="text-[9.5px] text-slate-400 font-bold uppercase block mb-1">Opening Cash Float</label>
                        <input
                          type="number"
                          step="0.01"
                          value={newBizOpeningCash}
                          onChange={(e) => setNewBizOpeningCash(e.target.value)}
                          placeholder="0.00"
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:border-indigo-500 focus:outline-hidden"
                        />
                      </div>
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="py-3 px-5 bg-indigo-600 hover:bg-indigo-500 text-white font-black uppercase rounded-xl text-xs tracking-wider cursor-pointer shadow-lg flex items-center justify-center gap-2 transition-all"
                  >
                    <Plus size={16} />
                    <span>Create Admin Account & Complete Business Setup</span>
                  </button>
                </form>
              )}
            </div>
          </motion.div>
        </div>
      ) : (
      /* Main Container without congested permanent sidebar dock */
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative h-full">
        
        {/* Top Header Bar with 3-Lines Hamburger Menu Button on Upper Corner */}
        <div className="bg-slate-900 border-b border-slate-800 px-2 py-1.5 sm:px-3 sm:py-2 flex flex-wrap items-center justify-between gap-1.5 sm:gap-2 text-slate-300 shadow-md z-20 shrink-0">
          
          <div className="flex items-center gap-1.5 sm:gap-2.5 flex-wrap">
            {/* Upper Corner 3-Lines Hamburger Menu Button */}
            <button
              id="hamburger-main-menu"
              onClick={() => {
                updateBadgeCounts();
                setShowNavDrawer(true);
              }}
              className="p-1.5 sm:p-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-lg transition-all cursor-pointer flex items-center justify-center shrink-0 shadow-md font-bold group"
              title="Open Hidden Functions Drawer"
            >
              <Menu size={18} className="group-hover:scale-110 transition-transform" />
            </button>

            {/* Multi-Tenant Workspace Switcher Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowWorkspaceDropdown((prev) => !prev)}
                className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-lg text-xs font-extrabold transition-all shadow-sm font-sans border cursor-pointer ${
                  showWorkspaceDropdown
                    ? 'bg-indigo-600 text-white border-indigo-400'
                    : 'bg-indigo-950/80 text-indigo-200 border-indigo-800/80 hover:bg-indigo-900 hover:text-white'
                }`}
                title="Switch Business Workspace or Unlock Another Shop"
              >
                <Building2 size={13} className="text-emerald-400 shrink-0" />
                <span className="truncate max-w-[90px] sm:max-w-[150px]">{activeBusiness.name || 'Workspace'}</span>
                <span className="px-1.5 py-0.2 bg-slate-950/70 text-emerald-300 border border-indigo-500/40 rounded text-[9px] font-black uppercase">
                  {authenticatedRole === 'owner' ? 'Owner' : authenticatedRole === 'manager' ? 'Mgr' : 'Cashier'}
                </span>
                <ChevronRight size={12} className={`transition-transform ${showWorkspaceDropdown ? 'rotate-90' : ''}`} />
              </button>

              {showWorkspaceDropdown && (
                <div className="fixed inset-0 z-40" onClick={() => setShowWorkspaceDropdown(false)} />
              )}

              {showWorkspaceDropdown && (
                <div className="absolute left-0 mt-1.5 w-72 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-2 z-50 flex flex-col gap-1.5">
                  <div className="px-2 py-1 border-b border-slate-800 flex items-center justify-between">
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                      Unlocked Workspaces ({unlockedWorkspaces.length})
                    </span>
                    {hasAnySettingsAccess && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowWorkspaceDropdown(false);
                          openUnifiedSettings(permittedSettingsTabs[0] || 'general');
                        }}
                        className="text-[10px] font-bold text-indigo-400 hover:text-indigo-300 cursor-pointer"
                      >
                        Settings
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col gap-1 max-h-56 overflow-y-auto">
                    {unlockedWorkspaces.map((ws) => {
                      const isCurrentWs = ws.businessId === activeBusiness.id;
                      const roleBadge = ws.role === 'owner' ? 'Owner' : ws.role === 'manager' ? 'Manager' : 'Cashier';
                      return (
                        <button
                          key={`${ws.businessId}_${ws.membershipId}`}
                          type="button"
                          onClick={() => {
                            setShowWorkspaceDropdown(false);
                            if (!isCurrentWs) {
                              void activateUnlockedWorkspaceSession(ws);
                            }
                          }}
                          className={`w-full text-left px-2.5 py-2 rounded-lg border flex items-center justify-between gap-2 transition-all cursor-pointer ${
                            isCurrentWs
                              ? 'bg-indigo-950/90 border-indigo-500 text-white'
                              : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800'
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-extrabold truncate">{ws.businessName}</div>
                            <div className="text-[9.5px] font-mono text-slate-400 truncate">{ws.email}</div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase ${
                              ws.role === 'owner'
                                ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40'
                                : ws.role === 'manager'
                                  ? 'bg-amber-600/20 text-amber-300 border border-amber-500/40'
                                  : 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/40'
                            }`}>
                              {roleBadge}
                            </span>
                            {isCurrentWs && <Check size={13} className="text-emerald-400" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <div className="pt-1 border-t border-slate-800 flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setShowWorkspaceDropdown(false);
                        setUnlockEmail(localStorage.getItem('logged_in_user_email') || activeBusiness.email || '');
                        setUnlockPassword('');
                        setUnlockFeedback(null);
                        setShowUnlockWorkspaceModal(true);
                      }}
                      className="w-full py-2 px-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Key size={13} />
                      <span>Unlock / Switch Business</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowWorkspaceDropdown(false);
                        setAuthFeedback(null);
                        setAuthScreenMode('register');
                        setIsCreatingNewWorkspace(true);
                      }}
                      className="w-full py-1.5 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10.5px] font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Plus size={12} />
                      <span>Create New Business Workspace</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Direct Sale Register Navigation Button */}
            <button
              id="btn_nav_pos_sale"
              onClick={() => {
                setBillingCounterAction(null);
                setActiveTab2('billing');
              }}
              className={`flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 rounded-lg text-xs font-black tracking-wider uppercase transition-all cursor-pointer border shadow-sm font-sans ${
                activeTab === 'billing'
                  ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-emerald-500/20'
                  : 'bg-emerald-950/80 hover:bg-emerald-900 text-emerald-300 border-emerald-800 hover:text-white'
              }`}
              title="Return to Point of Sale Billing Register"
            >
              <ShoppingCart size={13} className="stroke-[2.5] shrink-0" />
              <span className="hidden sm:inline">POS SALE REGISTER</span>
              <span className="sm:hidden">SALE</span>
            </button>

            <div className="flex items-center gap-1 bg-slate-800/90 border border-slate-700 rounded-lg px-2 py-0.5">
              <MapPin size={12} className="text-emerald-400 shrink-0" />
              <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider font-mono hidden md:inline">Branch:</span>
              <select
                value={activeStore}
                disabled={accessibleStores.length === 0}
                onChange={(e) => handleSwitchBranch(e.target.value)}
                title="Switch active branch (Only branches your account has access to are shown)"
                className="bg-transparent text-emerald-300 text-[11px] sm:text-xs font-black pr-1 py-0.5 focus:outline-hidden cursor-pointer uppercase font-sans"
              >
                {accessibleStores.length === 0 ? (
                  <option value="" className="bg-slate-900 text-slate-300">No Branch Setup</option>
                ) : (
                  accessibleStores.map(st => (
                    <option key={st.id} value={st.id} className="bg-slate-900 text-slate-100">{st.name}</option>
                  ))
                )}
              </select>
            </div>
          </div>

          {/* Cloud Sync, Settings & Log Out Badge */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            <PWAInstallButton variant="header" />
            {hasAnySettingsAccess && (
              <button
                onClick={() => openUnifiedSettings(permittedSettingsTabs[0] || 'general')}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] sm:text-[11px] font-extrabold cursor-pointer transition-all shadow-xs ${
                  activeTab === 'settings'
                    ? 'bg-indigo-500 text-white ring-2 ring-indigo-300'
                    : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                }`}
                title="Settings: Permitted Business & System Controls"
              >
                <Sliders size={12} />
                <span className="hidden md:inline">Settings</span>
              </button>
            )}

            <button
              onClick={handleQuickCloudSync}
              disabled={isHeaderSyncing}
              title="Synchronize business data with Cloud SQL & Firebase"
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-sky-950/90 hover:bg-sky-900 text-sky-300 border border-sky-800/80 text-[10px] sm:text-[11px] font-bold cursor-pointer transition-all"
            >
              <RefreshCw size={12} className={isHeaderSyncing ? 'animate-spin text-sky-400' : 'text-sky-400'} />
              <span className="hidden sm:inline">{lastHeaderSyncMsg || 'Sync'}</span>
            </button>

            {authenticatedRole === 'owner' ? (
              <select
                value={userRole}
                onChange={(e) => {
                  const nextRole = normalizeRole(e.target.value);
                  setUserRole(nextRole);
                  setUserPermissions(buildUserPermissions({ role: nextRole }));
                  setSqlSeedTrigger(prev => prev + 1);
                }}
                title="Owner Role Preview Switcher"
                className="bg-slate-800 text-slate-100 text-[11px] sm:text-xs font-bold px-1.5 sm:px-2 py-1 rounded-md border border-slate-700 focus:outline-hidden cursor-pointer font-sans"
              >
                <option value="owner">Admin (Owner)</option>
                <option value="manager">Manager</option>
                <option value="sales">Sales</option>
              </select>
            ) : (
              <span
                title="Role-based access locked by Administrator"
                className="flex items-center gap-1 bg-slate-800 text-slate-200 text-[10px] sm:text-[11px] font-extrabold uppercase px-2 py-1 rounded-md border border-slate-700 font-sans select-none"
              >
                <Lock size={10} className="text-amber-400" />
                <span>{userRole === 'manager' ? 'Manager' : 'Cashier'}</span>
              </span>
            )}

            <button
              onClick={handleLogoutAccount}
              title="Log Out or Switch Account / Branch"
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-rose-600 hover:bg-rose-500 text-white border border-rose-500 text-[10px] sm:text-[11px] font-extrabold uppercase tracking-wider cursor-pointer transition-all shadow-xs"
            >
              <LogOut size={12} />
              <span>Log Out</span>
            </button>
          </div>
        </div>

        {/* Dynamic Display Area (Defaults to clean Sale Register view) */}
        <div className="flex-1 min-h-0 flex overflow-hidden relative min-w-0 w-full">
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-slate-50 relative z-0 min-w-0 w-full">
              <AnimatePresence mode="wait">
                {activeTab === 'billing' && (
                  <motion.div
                    key={`billing_${activeStore}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 min-h-0 flex flex-col overflow-hidden min-w-0 w-full"
                  >
                    <BillingTerminal
                      settings={settings}
                      activeStore={activeStore}
                      userRole={userRole}
                      accessibleStores={accessibleStores}
                      onLogout={handleLogoutAccount}
                      initialAction={billingCounterAction}
                      onClearInitialAction={() => setBillingCounterAction(null)}
                      onCartCheckedOut={() => setSqlSeedTrigger(prev => prev + 1)}
                      onStoreChange={handleSwitchBranch}
                      onUserRoleChange={(newRole) => {
                        const norm = normalizeRole(newRole);
                        setUserRole(norm);
                        setAuthenticatedRole(norm);
                        setUserPermissions(loadSessionPermissionsFromStorage(norm));
                      }}
                    />
                  </motion.div>
                )}

                {activeTab === 'laybys' && canViewModule('laybys') && (
                  <motion.div
                    key={`laybys_${sqlSeedTrigger}_${activeStore}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 flex flex-col overflow-hidden min-w-0 w-full"
                  >
                    <LaybysBoard 
                      settings={settings}
                      activeStore={activeStore}
                      onTriggerSalesCounterAction={(action) => {
                        setBillingCounterAction(action);
                        setActiveTab2('billing');
                      }}
                    />
                  </motion.div>
                )}

                {activeTab === 'inventory' && canViewModule('inventory') && (
                  <motion.div
                    key={`inventory_${sqlSeedTrigger}_${activeStore}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 min-h-0 flex flex-col overflow-hidden min-w-0 w-full"
                  >
                    <InventoryManager 
                      settings={settings} 
                      userRole={userRole} 
                      activeStore={activeStore}
                      accessibleStores={accessibleStores}
                      onNavigateToSale={() => {
                        setBillingCounterAction(null);
                        setActiveTab2('billing');
                      }}
                    />
                  </motion.div>
                )}

                {activeTab === 'attendance' && canViewModule('attendance') && (
                  <motion.div
                    key={`attendance_${sqlSeedTrigger}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 flex flex-col overflow-hidden"
                  >
                    <AttendancePayroll settings={settings} userRole={userRole} />
                  </motion.div>
                )}

                {activeTab === 'quotes' && canViewModule('quotes') && (
                  <motion.div
                    key={`quotes_${sqlSeedTrigger}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 min-h-0 flex flex-col overflow-hidden min-w-0 w-full"
                  >
                    <QuotationsCreator settings={settings} activeStore={activeStore} />
                  </motion.div>
                )}
                {activeTab === 'purchase_orders' && canViewModule('purchase_orders') && (
                  <motion.div
                    key={`purchase_orders_${sqlSeedTrigger}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 min-h-0 flex flex-col overflow-hidden"
                  >
                    <LoanDashboard settings={settings} userRole={userRole} activeStore={activeStore} mode="procurement" />
                  </motion.div>
                )}
                {activeTab === 'loans' && canViewModule('loans') && (
                  <motion.div
                    key={`loans_${sqlSeedTrigger}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 min-h-0 flex flex-col overflow-hidden"
                  >
                    <LoanDashboard settings={settings} userRole={userRole} activeStore={activeStore} mode="credit_risk" />
                  </motion.div>
                )}
                {activeTab === 'finance' && canViewModule('finance') && (
                  <motion.div
                    key={`finance_${sqlSeedTrigger}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 flex flex-col overflow-hidden"
                  >
                    <FinanceDashboard settings={settings} userRole={userRole} activeStore={activeStore} />
                  </motion.div>
                )}
                {activeTab === 'dummy_gap_closer' && (
                  <motion.div>
                    <div />
                  </motion.div>
                )}

                {activeTab === 'analytics' && canViewModule('analytics') && (
                  <motion.div
                    key={`analytics_${sqlSeedTrigger}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 flex flex-col overflow-hidden"
                  >
                    <SmeDashboard
                      settings={settings}
                      setActiveTab={setActiveTab2}
                      setTerminalCode={handleSetTerminalCode}
                      userRole={userRole}
                      activeStore={activeStore}
                    />
                  </motion.div>
                )}

                {activeTab === 'workspace' && canViewModule('workspace') && (
                  <motion.div
                    key={`workspace_${sqlSeedTrigger}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 flex flex-col overflow-hidden"
                  >
                    <WorkspaceCoordinator 
                      userRole={userRole} 
                      activeStore={activeStore} 
                    />
                  </motion.div>
                )}

                {activeTab === 'audit' && canViewModule('audit') && (
                  <motion.div
                    key={`audit_${sqlSeedTrigger}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 flex flex-col overflow-hidden"
                  >
                    <EmployeeAuditTrail 
                      settings={settings} 
                      activeStore={activeStore} 
                      userRole={userRole} 
                    />
                  </motion.div>
                )}



                {activeTab === 'settings' && hasAnySettingsAccess && (
                  <motion.div
                    key="settings"
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 flex flex-col overflow-hidden"
                  >
                    <SettingsPanel
                      settings={settings}
                      setSettings={setSettings}
                      onRefreshDatabase={handleRefreshDatabase}
                      activeStore={activeStore}
                      setActiveStore={setActiveStore}
                      userRole={userRole}
                      userPermissions={userPermissions}
                      activeBusiness={activeBusiness}
                      setActiveBusiness={setActiveBusiness}
                      businesses={businesses}
                      unlockedWorkspaces={unlockedWorkspaces}
                      onSwitchUnlockedWorkspace={(ws) => activateUnlockedWorkspaceSession(ws)}
                      onUnlockWorkspace={handleUnlockAnotherWorkspace}
                      onCreateNewWorkspace={() => {
                        setAuthFeedback(null);
                        setAuthScreenMode('register');
                        setIsCreatingNewWorkspace(true);
                      }}
                      onSelectBusinessWorkspace={handleSelectBusinessWorkspace}
                      onSyncExistingAccount={handleSyncExistingAccount}
                      syncLoginEmail={syncLoginEmail}
                      setSyncLoginEmail={setSyncLoginEmail}
                      syncLoginPassword={syncLoginPassword}
                      setSyncLoginPassword={setSyncLoginPassword}
                      isHeaderSyncing={isHeaderSyncing}
                      onNavigateToTab={(tab) => navigateToTab(tab as ActiveTab)}
                      initialSubTab={settingsInitialSubTab}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

        {/* MOBILE ADAPTIVE BOTTOM NAVIGATION BAR */}
        <div className="md:hidden flex items-center justify-around bg-slate-900 border-t border-slate-800 px-1 py-1 shrink-0 z-20 select-none shadow-lg text-slate-400">
          {canViewModule('billing') && (
            <button
              id="mobile_nav_sale"
              type="button"
              onClick={() => {
                setBillingCounterAction(null);
                setActiveTab2('billing');
              }}
              className={`flex-1 flex flex-col items-center justify-center py-1.5 rounded-lg min-h-[46px] cursor-pointer active:scale-95 transition-all text-[9.5px] font-bold ${
                activeTab === 'billing'
                  ? 'bg-emerald-500/15 text-emerald-400 font-extrabold'
                  : 'hover:text-slate-200'
              }`}
            >
              <ShoppingCart size={17} className={activeTab === 'billing' ? 'text-emerald-400 stroke-[2.5]' : ''} />
              <span className="mt-0.5 tracking-tight">Sale POS</span>
            </button>
          )}

          {canViewModule('inventory') && (
            <button
              id="mobile_nav_inventory"
              type="button"
              onClick={() => navigateToTab('inventory')}
              className={`flex-1 flex flex-col items-center justify-center py-1.5 rounded-lg min-h-[46px] cursor-pointer active:scale-95 transition-all text-[9.5px] font-bold relative ${
                activeTab === 'inventory'
                  ? 'bg-blue-500/15 text-blue-400 font-extrabold'
                  : 'hover:text-slate-200'
              }`}
            >
              <Package size={17} className={activeTab === 'inventory' ? 'text-blue-400 stroke-[2.5]' : ''} />
              <span className="mt-0.5 tracking-tight">Stock</span>
            </button>
          )}

          {canViewModule('laybys') && (
            <button
              id="mobile_nav_laybys"
              type="button"
              onClick={() => navigateToTab('laybys')}
              className={`flex-1 flex flex-col items-center justify-center py-1.5 rounded-lg min-h-[46px] cursor-pointer active:scale-95 transition-all text-[9.5px] font-bold ${
                activeTab === 'laybys'
                  ? 'bg-amber-500/15 text-amber-400 font-extrabold'
                  : 'hover:text-slate-200'
              }`}
            >
              <Layers size={17} className={activeTab === 'laybys' ? 'text-amber-400 stroke-[2.5]' : ''} />
              <span className="mt-0.5 tracking-tight">Laybys</span>
            </button>
          )}

          {canViewModule('finance') && (
            <button
              id="mobile_nav_finance"
              type="button"
              onClick={() => navigateToTab('finance')}
              className={`flex-1 flex flex-col items-center justify-center py-1.5 rounded-lg min-h-[46px] cursor-pointer active:scale-95 transition-all text-[9.5px] font-bold ${
                activeTab === 'finance'
                  ? 'bg-purple-500/15 text-purple-400 font-extrabold'
                  : 'hover:text-slate-200'
              }`}
            >
              <FileText size={17} className={activeTab === 'finance' ? 'text-purple-400 stroke-[2.5]' : ''} />
              <span className="mt-0.5 tracking-tight">Finance</span>
            </button>
          )}

          <button
            id="mobile_nav_menu"
            type="button"
            onClick={() => {
              updateBadgeCounts();
              setShowNavDrawer(true);
            }}
            className="flex-1 flex flex-col items-center justify-center py-1.5 rounded-lg min-h-[46px] cursor-pointer active:scale-95 transition-all text-[9.5px] font-bold hover:text-slate-200"
          >
            <Menu size={17} />
            <span className="mt-0.5 tracking-tight">Menu</span>
          </button>
        </div>
      </div>
      )}

      {/* SLIDE-OUT NAVIGATION DRAWER (3-LINES HAMBURGER MENU) */}
      <AnimatePresence>
        {showNavDrawer && (
          <div className="fixed inset-0 z-50 flex select-none">
            {/* Backdrop Overlay */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowNavDrawer(false)}
              className="fixed inset-0 bg-slate-950/65 backdrop-blur-xs"
            />

            {/* Slide-in Menu Drawer */}
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 26, stiffness: 260 }}
              className="relative z-10 w-80 max-w-[85vw] h-full bg-white text-slate-900 shadow-2xl flex flex-col overflow-y-auto font-sans"
            >
              {/* Drawer Top Header Area */}
              <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-slate-800 font-extrabold text-xs">
                    <User size={16} className="text-indigo-600 shrink-0" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate max-w-[180px] font-bold text-slate-800">
                        {localStorage.getItem('logged_in_user_name') || activeBusiness.owner || 'Admin'}
                      </span>
                      <span className="truncate max-w-[180px] font-mono text-[10px] text-slate-500">
                        {localStorage.getItem('logged_in_user_email') || activeBusiness.email}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={handleLogoutAccount}
                      className="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[10px] font-extrabold uppercase tracking-wider flex items-center gap-1 cursor-pointer shadow-2xs"
                      title="Log Out of Account"
                    >
                      <LogOut size={12} />
                      <span>Log Out</span>
                    </button>
                    <button
                      onClick={() => setShowNavDrawer(false)}
                      className="text-slate-400 hover:text-slate-700 p-1 rounded-md transition-colors cursor-pointer"
                    >
                      <X size={18} />
                    </button>
                  </div>
                </div>

                {/* Active Business Workspace Switcher inside Drawer */}
                <div className="bg-white p-2.5 rounded-xl border border-indigo-200 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[10px] font-extrabold uppercase text-slate-500">
                    <span className="flex items-center gap-1">
                      <Building2 size={12} className="text-indigo-600" /> Workspace ({authenticatedRole === 'owner' ? 'Owner' : authenticatedRole === 'manager' ? 'Manager' : 'Cashier'})
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setShowNavDrawer(false);
                        setUnlockEmail(localStorage.getItem('logged_in_user_email') || activeBusiness.email || '');
                        setUnlockPassword('');
                        setUnlockFeedback(null);
                        setShowUnlockWorkspaceModal(true);
                      }}
                      className="text-indigo-600 hover:text-indigo-800 font-black cursor-pointer"
                    >
                      + Unlock Shop
                    </button>
                  </div>
                  {unlockedWorkspaces.length > 1 ? (
                    <select
                      value={activeBusiness.id}
                      onChange={(e) => {
                        const target = unlockedWorkspaces.find((w) => w.businessId === e.target.value);
                        if (target) {
                          setShowNavDrawer(false);
                          void activateUnlockedWorkspaceSession(target);
                        }
                      }}
                      className="w-full px-2.5 py-1.5 bg-indigo-50 border border-indigo-300 rounded-lg text-xs font-extrabold text-indigo-950 uppercase cursor-pointer focus:outline-hidden focus:border-indigo-500"
                    >
                      {unlockedWorkspaces.map((ws) => (
                        <option key={`${ws.businessId}_${ws.membershipId}`} value={ws.businessId}>
                          {ws.businessName} ({ws.role === 'owner' ? 'Owner' : ws.role === 'manager' ? 'Manager' : 'Cashier'})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="text-xs font-extrabold text-slate-900 truncate px-1">
                      {activeBusiness.name}
                    </div>
                  )}
                </div>

                {/* Active Branch Switcher inside Drawer */}
                <div className="bg-white p-2.5 rounded-xl border border-slate-200 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[10px] font-extrabold uppercase text-slate-500">
                    <span className="flex items-center gap-1">
                      <MapPin size={12} className="text-emerald-600" /> Active Branch Logged In:
                    </span>
                    <span className="text-emerald-700 font-mono">{accessibleStores.length} Accessible</span>
                  </div>
                  <select
                    value={activeStore}
                    onChange={(e) => handleSwitchBranch(e.target.value)}
                    disabled={accessibleStores.length === 0}
                    className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-lg text-xs font-extrabold text-slate-900 uppercase cursor-pointer focus:outline-hidden focus:border-indigo-500"
                  >
                    {accessibleStores.length === 0 ? (
                      <option value="">No Branch Configured</option>
                    ) : (
                      accessibleStores.map((st: any) => (
                        <option key={st.id} value={st.id}>
                          {st.name} {st.location ? `— ${st.location}` : ''}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                {/* Unified Settings & Workspace Shortcuts (Role & Ticked Permissions) */}
                {(hasAnySettingsAccess || canAccessSettingTab('workspaces', userRole, userPermissions)) && (
                  <div className="grid grid-cols-2 gap-2">
                    {hasAnySettingsAccess && (
                      <button
                        onClick={() => openUnifiedSettings(permittedSettingsTabs[0] || 'general')}
                        className="py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[10.5px] font-extrabold uppercase tracking-wider text-center shadow-xs transition-all cursor-pointer font-sans flex items-center justify-center gap-1"
                      >
                        <Sliders size={14} />
                        <span>SETTINGS</span>
                      </button>
                    )}
                    {canAccessSettingTab('workspaces', userRole, userPermissions) && (
                      <button
                        onClick={() => openUnifiedSettings('workspaces')}
                        className="py-2 px-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[10.5px] font-extrabold uppercase tracking-wider text-center shadow-xs transition-all cursor-pointer font-sans flex items-center justify-center gap-1"
                      >
                        <Building2 size={14} />
                        <span>WORKSPACES</span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* SECTION: Management */}
              <div className="p-3 flex flex-col gap-1.5 border-b border-slate-150">
                <span className="text-[11px] font-extrabold text-slate-400 uppercase tracking-wider px-2 py-0.5 font-mono">
                  Management ({normalizeRole(userRole).toUpperCase()})
                </span>

                {/* Point of Sale Register - Placed directly on top of Inventory */}
                {canViewModule('billing') && (
                  <button
                    id="drawer_pos_sale_btn"
                    onClick={() => {
                      setShowNavDrawer(false);
                      setBillingCounterAction(null);
                      navigateToTab('billing');
                    }}
                    className={`flex items-center justify-between p-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer group ${
                      activeTab === 'billing'
                        ? 'bg-emerald-600 text-white shadow-md'
                        : 'hover:bg-slate-100 text-slate-800 bg-emerald-50/60 border border-emerald-200/80'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className={`p-1.5 rounded-lg shadow-xs group-hover:scale-105 transition-transform ${
                        activeTab === 'billing' ? 'bg-white text-emerald-700' : 'bg-emerald-600 text-white'
                      }`}>
                        <ShoppingCart size={16} />
                      </div>
                      <div className="flex flex-col text-left">
                        <span className="font-extrabold text-xs">Point of Sale (POS Terminal)</span>
                        <span className="text-[9.5px] opacity-80 font-mono">New Sale Register & Express Checkout</span>
                      </div>
                    </div>
                    <span className="px-2 py-0.5 bg-emerald-500 text-white text-[10px] font-black rounded-full font-mono shadow-xs">
                      SALE
                    </span>
                  </button>
                )}

                {/* Inventory Management */}
                {canViewModule('inventory') && (
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      navigateToTab('inventory');
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-blue-600 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <Package size={16} />
                      </div>
                      <span>Inventory Management</span>
                    </div>
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-800 border border-blue-200 text-[10px] font-extrabold rounded-full font-mono">
                      {badgeCounts.products}
                    </span>
                  </button>
                )}

                {/* Layby Functions & Credit Sales */}
                {canViewModule('laybys') && (
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      navigateToTab('laybys');
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-amber-500 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <Layers size={16} />
                      </div>
                      <span>Layby Functions & Deposits</span>
                    </div>
                    <span className="px-2 py-0.5 bg-amber-100 text-amber-800 border border-amber-300 text-[10px] font-extrabold rounded-full font-mono">
                      LAYBY
                    </span>
                  </button>
                )}

                {/* Tasks & Operations */}
                {canViewModule('workspace') && (
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      navigateToTab('workspace');
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-indigo-600 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <CheckSquare size={16} />
                      </div>
                      <span>Tasks & Operations</span>
                    </div>
                    <span className="px-1.5 py-0.5 bg-indigo-100 text-indigo-800 border border-indigo-200 text-[9px] font-extrabold rounded uppercase tracking-wider font-mono">
                      TASKS
                    </span>
                  </button>
                )}

                {/* Quote, Invoice & Delivery Note */}
                {canViewModule('quotes') && (
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      navigateToTab('quotes');
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-purple-600 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <FileText size={16} />
                      </div>
                      <span>Quote, Invoice &amp; Delivery Note</span>
                    </div>
                  </button>
                )}

                {/* Add Expense */}
                {(normalizeRole(userRole) !== 'sales' || canViewModule('finance') || canViewModule('purchase_orders')) && (
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      setShowExpenseModal(true);
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-rose-500 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <Receipt size={16} />
                      </div>
                      <span>Add Operating Expense</span>
                    </div>
                  </button>
                )}

                {/* Supply Management */}
                {canViewModule('purchase_orders') && (
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      navigateToTab('purchase_orders');
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-indigo-600 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <Truck size={16} />
                      </div>
                      <span>Supply Management</span>
                    </div>
                    <span className="px-2 py-0.5 bg-indigo-100 text-indigo-800 border border-indigo-200 text-[10px] font-extrabold rounded-full font-mono">
                      Tab
                    </span>
                  </button>
                )}

                {/* Customers Management */}
                {(canViewModule('billing') || canViewModule('quotes')) && (
                  <button
                    onClick={() => {
                      fetchCustomersList();
                      setShowNavDrawer(false);
                      setShowCustomersModal(true);
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-emerald-600 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <Users size={16} />
                      </div>
                      <span>Customers Management</span>
                    </div>
                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 border border-emerald-200 text-[10px] font-extrabold rounded-full font-mono">
                      {badgeCounts.customers}
                    </span>
                  </button>
                )}

                {/* Staff Management */}
                {canViewModule('attendance') && (
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      navigateToTab('attendance');
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-sky-500 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <UserCheck size={16} />
                      </div>
                      <span>Staff Management</span>
                    </div>
                    <span className="px-2 py-0.5 bg-sky-100 text-sky-800 border border-sky-200 text-[10px] font-extrabold rounded-full font-mono">
                      {badgeCounts.staff}
                    </span>
                  </button>
                )}

                {/* Employee Audit Trail */}
                {canViewModule('audit') && (
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      navigateToTab('audit');
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-indigo-50 bg-indigo-50/50 text-slate-800 text-xs font-bold transition-all cursor-pointer border border-indigo-200/60 group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-indigo-600 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <ShieldCheck size={16} />
                      </div>
                      <span>Employee Audit Trail</span>
                    </div>
                    <span className="px-2 py-0.5 bg-indigo-600 text-white text-[10px] font-extrabold rounded-full font-mono font-sans">
                      AUDIT
                    </span>
                  </button>
                )}
              </div>

              {/* SECTION: Finance & Accounting */}
              {canViewModule('finance') && (
                <div className="p-3 flex flex-col gap-1.5 border-b border-slate-150 bg-emerald-50/40">
                  <span className="text-[11px] font-extrabold text-emerald-800 uppercase tracking-wider px-2 py-0.5 font-mono">
                    Finance & Accounting
                  </span>

                  {/* Financial Statements & P&L */}
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      navigateToTab('finance');
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-emerald-100/70 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-emerald-700 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <FileText size={16} />
                      </div>
                      <span>Profit & Loss Statements</span>
                    </div>
                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 border border-emerald-300 text-[9px] font-extrabold rounded-full font-mono">
                      P&L
                    </span>
                  </button>

                  {/* Operating Expenses */}
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      navigateToTab('finance');
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-emerald-100/70 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-emerald-700 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <Receipt size={16} />
                      </div>
                      <span>Operating Expenses & Ledger</span>
                    </div>
                  </button>

                  {/* Supply Management */}
                  {canViewModule('purchase_orders') && (
                    <button
                      onClick={() => {
                        setShowNavDrawer(false);
                        navigateToTab('purchase_orders');
                      }}
                      className="flex items-center justify-between p-2 rounded-xl hover:bg-emerald-100/70 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="p-1.5 rounded-lg bg-emerald-700 text-white shadow-xs group-hover:scale-105 transition-transform">
                          <Truck size={16} />
                        </div>
                        <span>Supply Management</span>
                      </div>
                    </button>
                  )}
                </div>
              )}

              {/* SECTION: Loans & Merchant Financing */}
              {canViewModule('loans') && (
                <div className="p-3 flex flex-col gap-1.5 border-b border-slate-150 bg-blue-50/40">
                  <span className="text-[11px] font-extrabold text-blue-800 uppercase tracking-wider px-2 py-0.5 font-mono">
                    Loans & Merchant Credit
                  </span>

                  {/* Loan Advances */}
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      navigateToTab('loans');
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-blue-100/70 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-blue-700 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <Briefcase size={16} />
                      </div>
                      <span>Merchant Loan Advances</span>
                    </div>
                  </button>

                  {/* Credit Risk & Swept Capital */}
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      navigateToTab('loans');
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-blue-100/70 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-blue-700 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <TrendingUp size={16} />
                      </div>
                      <span>Credit Risk & Swept Capital</span>
                    </div>
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-800 border border-blue-200 text-[10px] font-extrabold rounded-full font-mono">
                      Tab
                    </span>
                  </button>

                  {/* Borrower Statements */}
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      navigateToTab('loans');
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-blue-100/70 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-blue-700 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <FileSpreadsheet size={16} />
                      </div>
                      <span>Borrower Amortization Statements</span>
                    </div>
                  </button>
                </div>
              )}

              {/* SECTION: Additional Tools */}
              <div className="p-3 flex flex-col gap-1.5">
                {/* Analytics Dashboard shortcut if enabled */}
                {canViewModule('analytics') && (
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      navigateToTab('analytics');
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-indigo-600 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <LayoutDashboard size={16} />
                      </div>
                      <span>Analytics Dashboard</span>
                    </div>
                  </button>
                )}

                {/* Install as Standalone PWA */}
                <PWAInstallButton variant="drawer" onActionComplete={() => setShowNavDrawer(false)} />

                {/* Share the App (Direct APK via Bluetooth, WhatsApp, Quick Share) */}
                <button
                  type="button"
                  onClick={() => {
                    setShowNavDrawer(false);
                    setShowShareAppModal(true);
                  }}
                  className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="p-1.5 rounded-lg bg-teal-600 text-white shadow-xs group-hover:scale-105 transition-transform">
                      <Share2 size={16} />
                    </div>
                    <div className="flex flex-col text-left">
                      <span>Share the App (APK)</span>
                      <span className="text-[9.5px] text-slate-500 font-medium">Bluetooth, WhatsApp &amp; Quick Share</span>
                    </div>
                  </div>
                  <span className="px-2 py-0.5 bg-teal-100 text-teal-800 border border-teal-200 text-[9px] font-extrabold rounded-full font-mono">
                    APK
                  </span>
                </button>

                {/* Receipts & Refunds Ledger */}
                {(normalizeRole(userRole) !== 'sales' || userPermissions?.sales?.refunds) && (
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      setBillingCounterAction('refunds');
                      navigateToTab('billing');
                    }}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-red-600 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <RotateCcw size={16} />
                      </div>
                      <span>Receipt & Refund Ledger</span>
                    </div>
                  </button>
                )}

                {/* Settings (Unified SME Configuration & Admin Business Control Panel) */}
                {hasAnySettingsAccess && (
                  <button
                    onClick={() => openUnifiedSettings(permittedSettingsTabs[0] || 'general')}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-slate-700 text-white shadow-xs group-hover:scale-105 transition-transform">
                        <Sliders size={16} />
                      </div>
                      <span>Settings ({permittedSettingsTabs.length} Permitted)</span>
                    </div>
                  </button>
                )}
              </div>

              {/* SECTION: Help Chat & WhatsApp Support (Placed at the bottom) */}
              <div className="p-3 border-t border-slate-200 bg-emerald-50/60 mt-auto">
                <span className="text-[10px] font-extrabold text-emerald-800 uppercase tracking-wider px-1 font-mono block mb-1.5">
                  Live Help & Support
                </span>
                <button
                  id="drawer_help_chat_bottom_btn"
                  onClick={() => {
                    setShowNavDrawer(false);
                    window.open('https://wa.me/260963398933?text=Hello%20POS%20Support%2C%20I%20need%20assistance%20with%20my%20store', '_blank');
                    setShowHelpChatModal(true);
                  }}
                  className="w-full flex items-center justify-between p-2.5 rounded-xl hover:bg-emerald-600 hover:text-white bg-emerald-500 text-white text-xs font-bold transition-all cursor-pointer shadow-xs border border-emerald-400 group"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="p-1.5 rounded-lg bg-white text-emerald-700 shadow-xs group-hover:scale-105 transition-transform">
                      <MessageSquare size={16} />
                    </div>
                    <div className="flex flex-col text-left">
                      <span className="font-extrabold text-xs">Help Chat (WhatsApp)</span>
                      <span className="text-[9.5px] opacity-90 font-mono">Instant Support & Chat Desk</span>
                    </div>
                  </div>
                  <span className="px-2 py-0.5 bg-emerald-700 text-white text-[10px] font-black rounded-full font-mono shadow-2xs">
                    +260963398933
                  </span>
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* CHOOSE BRANCH ON LOGIN GATE MODAL */}
      {showBranchChoiceGate && isAuthenticatedSession && accessibleStores.length > 0 && (
        <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-xs flex items-center justify-center p-4 z-50 select-none">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-md bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl p-5 flex flex-col gap-4 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-emerald-600/20 border border-emerald-500/40 text-emerald-400">
                  <MapPin size={20} />
                </div>
                <div>
                  <h3 className="text-sm font-black uppercase tracking-wider text-white">
                    Choose Your Branch Location
                  </h3>
                  <p className="text-[10.5px] text-slate-400">
                    Welcome {localStorage.getItem('logged_in_user_name') || 'Admin'} — Select the branch you are operating today
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleLogoutAccount}
                className="px-2.5 py-1 bg-rose-950/80 hover:bg-rose-900 text-rose-200 border border-rose-800 rounded-lg text-[10px] font-bold uppercase cursor-pointer flex items-center gap-1"
              >
                <LogOut size={11} /> Log Out
              </button>
            </div>

            <div className="flex flex-col gap-2 max-h-60 overflow-y-auto">
              {accessibleStores.map((st: any) => {
                const isSelected = activeStore === st.id;
                return (
                  <button
                    key={st.id}
                    type="button"
                    onClick={() => handleSwitchBranch(st.id)}
                    className={`p-3.5 rounded-xl border text-left flex items-center justify-between transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-emerald-950/60 border-emerald-500 text-white shadow-md'
                        : 'bg-slate-950/70 border-slate-800 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    <div>
                      <div className="font-black text-xs uppercase flex items-center gap-2">
                        <span>{st.name}</span>
                        <span className="text-[10px] font-mono text-slate-400">({st.id})</span>
                      </div>
                      <div className="text-[10.5px] text-slate-400 mt-0.5">
                        Location: {st.location || 'Main Branch'}
                      </div>
                    </div>
                    <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase ${
                      isSelected ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {isSelected ? '✓ Selected' : 'Select'}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 flex flex-col gap-1.5">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Opening Drawer Cash Float for Selected Branch ({settings.currency || 'K'})
              </label>
              <input
                type="number"
                step="0.01"
                value={gateOpeningCash}
                onChange={(e) => setGateOpeningCash(e.target.value)}
                placeholder={localStorage.getItem('shift_opening_cash_' + activeStore) || '0.00'}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs font-mono font-bold text-emerald-300 focus:outline-hidden focus:border-emerald-500"
              />
              <span className="text-[9.5px] text-slate-500">
                All stock, sales, expenses, and End-of-Day (EOD) totals are isolated to this branch.
              </span>
            </div>

            <button
              type="button"
              onClick={() => {
                if (gateOpeningCash.trim() !== '' && activeStore) {
                  const cashVal = Math.max(0, parseFloat(gateOpeningCash) || 0).toFixed(2);
                  localStorage.setItem('shift_opening_cash_' + activeStore, cashVal);
                }
                setGateOpeningCash('');
                setShowBranchChoiceGate(false);
                setSqlSeedTrigger(prev => prev + 1);
                window.dispatchEvent(new Event('pos_data_updated'));
              }}
              className="py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-black uppercase tracking-wider text-xs rounded-xl cursor-pointer shadow-lg flex items-center justify-center gap-2"
            >
              <Check size={15} />
              <span>Enter {(accessibleStores.find(s => s.id === activeStore)?.name || activeStore || 'Branch').toUpperCase()} Workspace</span>
            </button>
          </motion.div>
        </div>
      )}

      {/* ADD EXPENSE MODAL */}
      {showExpenseModal && (
        <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4 z-50 select-none">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-md bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl p-5 flex flex-col gap-4 shadow-2xl"
          >
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-indigo-400">
                <Receipt size={20} />
                <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-100 font-sans">Record Branch Operating Expense</h3>
              </div>
              <button
                onClick={() => setShowExpenseModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg bg-slate-800 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!expenseAmount || isNaN(Number(expenseAmount))) {
                  alert('Please enter a valid numeric expense amount');
                  return;
                }
                const amt = Number(expenseAmount);
                const targetBranch = expenseStoreId || activeStore || (accessibleStores[0]?.id ?? '');
                const nowIso = new Date().toISOString();
                const expId = `EXP-${Date.now()}`;
                const allAccounts = getAllSelectableAccounts();
                const matchedAcc = allAccounts.find(a => a.accountId === expenseAccountId);
                const chosenMethodLabel = matchedAcc?.label || 'Cash';

                const activeBizId = getActiveBusinessId(activeBusiness?.id);
                const resolvedTargetBranch = getActiveStoreId(targetBranch, activeBizId);
                runSql(`
                  INSERT INTO expenses (id, category, payment_method, account_id, amount, description, ref_number, expense_date, store_id, performed_by, created_by, created_at, business_id)
                  VALUES (
                    '${expId}',
                    '${expenseCategory.replace(/'/g, "''")}',
                    '${chosenMethodLabel.replace(/'/g, "''")}',
                    '${expenseAccountId}',
                    ${amt},
                    '${(expenseNotes || 'Store Expense').replace(/'/g, "''")}',
                    '${expId}',
                    '${nowIso.split('T')[0]}',
                    '${sqlEsc(resolvedTargetBranch)}',
                    '${(localStorage.getItem('logged_in_user_name') || userRole).replace(/'/g, "''")}',
                    '${userRole}',
                    '${nowIso}',
                    '${sqlEsc(activeBizId)}'
                  )
                `, 'Record branch operating expense');

                runSql(`
                  INSERT INTO double_entry_journal (id, date, reference, description, account_debit, account_credit, amount, currency, business_id, store_id) VALUES (
                    'exp_${Date.now()}',
                    '${nowIso}',
                    '${expId}',
                    '[Branch: ${sqlEsc(resolvedTargetBranch)}] ${(expenseNotes || 'Store Expense').replace(/'/g, "''")}',
                    'Operating Expenses',
                    '${chosenMethodLabel.replace(/'/g, "''")}',
                    ${amt},
                    '${settings.currency}',
                    '${sqlEsc(activeBizId)}',
                    '${sqlEsc(resolvedTargetBranch)}'
                  )
                `, 'Record expense journal entry');

                logEmployeeAudit('EXPENSES', 'Added Operating Expense', `Category: ${expenseCategory}, Account: ${chosenMethodLabel}, Notes: ${expenseNotes || 'Store Expense'}`, amt, targetBranch, userRole);
                syncAllAccountingSystems(`Expense #${expId}`);
                persistTablesToStorage();

                alert(`Operating expense of ${settings.currency}${amt.toFixed(2)} recorded for branch [${targetBranch.toUpperCase()}] from ${chosenMethodLabel} and synced with EOD & Double-Entry Ledgers!`);
                setExpenseAmount('');
                setExpenseNotes('');
                setShowExpenseModal(false);
                window.dispatchEvent(new Event('pos_data_updated'));
              }}
              className="flex flex-col gap-3 text-xs"
            >
              <div>
                <label className="text-[10px] uppercase font-bold text-slate-400 block pb-1">Branch Associated with Expense *</label>
                <select
                  value={expenseStoreId || activeStore}
                  onChange={(e) => setExpenseStoreId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-emerald-300 font-extrabold uppercase focus:outline-hidden"
                >
                  {accessibleStores.map((st: any) => (
                    <option key={st.id} value={st.id}>{st.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[10px] uppercase font-bold text-slate-400 block pb-1">Expense Category</label>
                <select
                  value={expenseCategory}
                  onChange={(e) => setExpenseCategory(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-bold focus:outline-hidden"
                >
                  <option value="Store Operations">Store Operations & Supplies</option>
                  <option value="Utility / Electricity">Utility & Electricity (ZESCO)</option>
                  <option value="Transport & Logistics">Transport & Logistics</option>
                  <option value="Rent & Property">Rent & Property Fees</option>
                  <option value="Staff Refreshments">Staff Refreshments & Meals</option>
                  <option value="Miscellaneous">Miscellaneous Expense</option>
                </select>
              </div>

              <div>
                <label className="text-[10px] uppercase font-bold text-slate-400 block pb-1">Payment Account</label>
                <select
                  value={expenseAccountId}
                  onChange={(e) => setExpenseAccountId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-bold focus:outline-hidden"
                >
                  {getAllSelectableAccounts().map(acc => (
                    <option key={acc.accountId} value={acc.accountId}>{acc.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[10px] uppercase font-bold text-slate-400 block pb-1">Amount ({settings.currency})</label>
                <input
                  type="number"
                  step="0.01"
                  value={expenseAmount}
                  onChange={(e) => setExpenseAmount(e.target.value)}
                  placeholder="0.00"
                  required
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-slate-100 font-mono text-sm font-extrabold focus:outline-hidden"
                />
              </div>

              <div>
                <label className="text-[10px] uppercase font-bold text-slate-400 block pb-1">Notes / Description</label>
                <input
                  type="text"
                  value={expenseNotes}
                  onChange={(e) => setExpenseNotes(e.target.value)}
                  placeholder="e.g. Purchased cash drawer thermal receipt rolls"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 focus:outline-hidden"
                />
              </div>

              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setShowExpenseModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 font-bold rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-550 text-white font-extrabold uppercase rounded-lg shadow-md cursor-pointer"
                >
                  Save Expense
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}

      {/* HELP CHAT MODAL */}
      {showHelpChatModal && (
        <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4 z-50 select-none">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-lg bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl p-5 flex flex-col gap-3 shadow-2xl h-[80vh]"
          >
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-emerald-400">
                <MessageSquare size={20} />
                <div>
                  <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-100 font-sans">Merchant Help & Support Chat</h3>
                  <p className="text-[10px] text-emerald-400 font-mono font-bold">WhatsApp Direct Support: +260 96 3398933</p>
                </div>
              </div>
              <button
                onClick={() => setShowHelpChatModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg bg-slate-800 cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Direct WhatsApp Callout Banner */}
            <a
              href="https://wa.me/260963398933?text=Hello%20POS%20Support%2C%20I%20need%20assistance%20with%20my%20store"
              target="_blank"
              rel="noopener noreferrer"
              className="p-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl flex items-center justify-between transition-all cursor-pointer shadow-md font-bold text-xs"
            >
              <div className="flex items-center gap-2.5">
                <MessageSquare size={18} />
                <span>Chat Directly on WhatsApp (+260 96 3398933)</span>
              </div>
              <span className="bg-white/20 px-2 py-0.5 rounded text-[10px] uppercase font-extrabold tracking-wider">Fast Response</span>
            </a>

            {/* Chat Message Stream */}
            <div className="flex-1 overflow-y-auto flex flex-col gap-2.5 p-2 bg-slate-950 rounded-xl border border-slate-850">
              {chatMessages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] p-3 rounded-xl text-xs ${
                      msg.sender === 'user'
                        ? 'bg-blue-600 text-white font-medium rounded-tr-none'
                        : 'bg-slate-800 text-slate-200 border border-slate-700 rounded-tl-none'
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              ))}
            </div>

            {/* Chat Input Bar */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!chatInput.trim()) return;
                const txt = chatInput;
                setChatMessages(prev => [...prev, { sender: 'user', text: txt }]);
                setChatInput('');
                window.open(`https://wa.me/260963398933?text=${encodeURIComponent(txt)}`, '_blank');
              }}
              className="flex gap-2 pt-1"
            >
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask support or type query for WhatsApp..."
                className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-hidden"
              />
              <button
                type="submit"
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-md"
              >
                <Send size={14} /> Send WhatsApp
              </button>
            </form>
          </motion.div>
        </div>
      )}

      {/* CUSTOMERS MANAGEMENT MODAL */}
      {showCustomersModal && (
        <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4 z-50 select-none">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-xl bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl p-5 flex flex-col gap-4 shadow-2xl max-h-[85vh]"
          >
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-blue-400">
                <Users size={20} />
                <div>
                  <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-100 font-sans">Central CRM Customer Registry</h3>
                  <p className="text-[10px] text-slate-400 font-mono">Synchronized shopper profiles & loyalty accounts across cash & layby sales</p>
                </div>
              </div>
              <button
                onClick={() => setShowCustomersModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg bg-slate-800 cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Quick Add Customer */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!newCustName.trim()) return;
                upsertCustomerSync({
                  name: newCustName.trim(),
                  phone: newCustPhone.trim(),
                  loyalPointsDelta: 0
                });
                setCustAddMsg(`✓ [${newCustName.trim()}] added to CRM. Loyalty points will accrue on checkout per Settings (${settings.loyaltyRatio || 0} pts/${settings.currency || '$'}1).`);
                setTimeout(() => setCustAddMsg(null), 4000);
                setNewCustName('');
                setNewCustPhone('');
                fetchCustomersList();
                window.dispatchEvent(new Event('pos_data_updated'));
              }}
              className="flex flex-col gap-2 bg-slate-950 p-2.5 rounded-xl border border-slate-850"
            >
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newCustName}
                  onChange={(e) => setNewCustName(e.target.value)}
                  placeholder="Customer Full Name"
                  required
                  className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 font-bold focus:outline-hidden"
                />
                <input
                  type="text"
                  value={newCustPhone}
                  onChange={(e) => setNewCustPhone(e.target.value)}
                  placeholder="Phone (e.g. 097...)"
                  className="w-36 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:outline-hidden"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold uppercase tracking-wider cursor-pointer shadow-sm"
                >
                  + Add
                </button>
              </div>
              {custAddMsg && (
                <p className="text-[10.5px] font-bold text-emerald-400 px-1">
                  {custAddMsg}
                </p>
              )}
            </form>

            {/* Search CRM database */}
            <div className="relative">
              <input
                type="text"
                value={customerSearchQuery}
                onChange={(e) => setCustomerSearchQuery(e.target.value)}
                placeholder="Search CRM customers by name, phone, email, or TPIN..."
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 font-semibold focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div className="flex-1 overflow-y-auto p-2 bg-slate-950 rounded-xl border border-slate-850 flex flex-col gap-2 max-h-[320px]">
              {customersList
                .filter((c: any) => {
                  if (!customerSearchQuery.trim()) return true;
                  const q = customerSearchQuery.toLowerCase();
                  return (
                    (c.name && c.name.toLowerCase().includes(q)) ||
                    (c.phone && c.phone.toLowerCase().includes(q)) ||
                    (c.email && c.email.toLowerCase().includes(q)) ||
                    (c.tpin && c.tpin.toLowerCase().includes(q))
                  );
                })
                .map((c: any) => (
                  <div key={c.id} className="p-3 bg-slate-900 rounded-lg border border-slate-800 flex items-center justify-between">
                    <div>
                      <h4 className="text-xs font-bold text-slate-100">{c.name}</h4>
                      <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                        <span>📱 {c.phone || 'N/A'}</span>
                        {c.email && c.email !== 'N/A' && <span>✉️ {c.email}</span>}
                        {c.tpin && <span>🏛️ TPIN: {c.tpin}</span>}
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-xs font-bold text-blue-400 font-mono">{c.loyalPoints || 0} pts</span>
                      <p className="text-[9px] text-slate-500 font-mono">ID: #{c.id}</p>
                    </div>
                  </div>
                ))}
              {customersList.length === 0 && (
                <div className="p-4 text-center text-xs text-slate-500 font-medium">
                  No customers found in database.
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
      {/* UNLOCK & SWITCH BUSINESS WORKSPACE MODAL (Strict Email + Password Identity) */}
      {showUnlockWorkspaceModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 select-none">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-md bg-slate-900 border border-slate-700 text-slate-100 rounded-2xl p-5 flex flex-col gap-4 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-indigo-600/20 border border-indigo-500/40 text-indigo-400">
                  <Key size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-black uppercase tracking-wider text-white">
                    Unlock &amp; Switch Business Workspace
                  </h3>
                  <p className="text-[10px] text-slate-400">
                    Each business uses strict (Email + Password) verification with 100% isolated data.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowUnlockWorkspaceModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg bg-slate-800 cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            {unlockFeedback && (
              <div className={`px-3 py-2 rounded-xl border text-xs font-bold flex items-center gap-2 ${
                unlockFeedback.type === 'error'
                  ? 'bg-rose-950/70 border-rose-500/50 text-rose-200'
                  : 'bg-emerald-950/70 border-emerald-500/50 text-emerald-200'
              }`}>
                <AlertCircle size={14} className="shrink-0" />
                <span>{unlockFeedback.text}</span>
              </div>
            )}

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setUnlockFeedback(null);
                const res = await handleUnlockAnotherWorkspace(unlockEmail, unlockPassword);
                if (res.success) {
                  setUnlockPassword('');
                  setShowUnlockWorkspaceModal(false);
                } else {
                  setUnlockFeedback({ type: 'error', text: res.error || 'Invalid credentials.' });
                }
              }}
              className="flex flex-col gap-3"
            >
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                  Account Email Address *
                </label>
                <input
                  type="email"
                  value={unlockEmail}
                  onChange={(e) => setUnlockEmail(e.target.value)}
                  placeholder="Enter your email address"
                  required
                  className="w-full px-3 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 font-mono text-xs focus:border-indigo-500 focus:outline-hidden"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                  Workspace Password / Staff PIN *
                </label>
                <input
                  type="password"
                  value={unlockPassword}
                  onChange={(e) => setUnlockPassword(e.target.value)}
                  placeholder="Enter the password for the shop you want to open"
                  required
                  className="w-full px-3 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 font-mono text-xs focus:border-indigo-500 focus:outline-hidden"
                />
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowUnlockWorkspaceModal(false)}
                  className="flex-1 py-2.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUnlockingWorkspace}
                  className="flex-1 py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-black uppercase rounded-xl text-xs tracking-wider cursor-pointer flex items-center justify-center gap-1.5"
                >
                  <RefreshCw size={14} className={isUnlockingWorkspace ? 'animate-spin' : ''} />
                  <span>{isUnlockingWorkspace ? 'Unlocking...' : 'Unlock & Switch'}</span>
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}

      <ShareAppApkModal
        isOpen={showShareAppModal}
        onClose={() => setShowShareAppModal(false)}
        storeName={settings.storeName || activeBusiness.name}
      />
      <OfflineIndicator />
    </AndroidShell>
  );
}
