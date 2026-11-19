import React, { useState, useEffect } from 'react';
import { 
  Sliders, 
  RefreshCw, 
  Save, 
  CheckCircle, 
  Database, 
  Download, 
  FileText, 
  Settings, 
  Key, 
  ShieldCheck, 
  LogIn,
  Users,
  UserPlus,
  Edit3,
  Trash2,
  Lock,
  Check,
  Building2,
  Printer,
  Package,
  Upload,
  CreditCard,
  Plus,
  QrCode,
  Wifi,
  WifiOff,
  AlertCircle,
  Ban,
  UserCheck,
  Bluetooth,
  Smartphone,
  ExternalLink
} from 'lucide-react';
import {
  runSql,
  getCentralBranches,
  initializeDatabase,
  SeedTemplate,
  persistTablesToStorage,
  pushDatabaseToServer,
  pullDatabaseFromServer,
  getCustomPaymentMethods,
  saveCustomPaymentMethod,
  toggleCustomPaymentMethod,
  deleteCustomPaymentMethod,
  calculateLoyaltyPoints,
  getActiveBusinessId,
  getActiveStoreId,
  sqlEsc,
  upsertUserAndMembership,
} from '../db';
import { exportAndShareText } from '../androidUtils';
import { StoreSettings, CustomPaymentMethod } from '../types';
import { onAuthStateChanged, User as FirebaseUser, signInWithPopup } from 'firebase/auth';
import {
  listPairedBluetoothDevicesOnGadget,
  pairOrPickBluetoothDeviceOnGadget,
  openGadgetBluetoothSettings,
  formatHardwarePrinterValue,
  saveSelectedPrinterMetadata,
  getSelectedPrinterMetadata,
  sendEscPosToHardwarePrinter,
  removeSavedWebBluetoothDevice,
  PairedBluetoothPrinter,
} from '../services/bluetoothPrinterService';
import {
  auth,
  googleProvider,
  googleSignOut,
  backupToCloud,
  restoreFromCloud,
  getTransportSecurityStatus,
  registerOrSignInWithEmailPassword,
  publishCredentialMembershipToCloud,
  revokeCredentialMembershipInCloud,
  linkOwnerWorkspacesWithCurrentFirebaseAdmin,
} from '../firebase';
import { getZraConfig, saveZraConfig, subscribeZraConfig, switchZraConfigForBusiness, ZraConfig, ZraTaxTypeCode, ZRA_TAX_TYPES, ZRA_PACKAGING_UNITS, ZRA_QTY_UNITS } from '../zra/zraConfig';
import { FiscalService, ZraOfflineQueueItem } from '../zra/fiscalService';
import {
  UnlockedWorkspaceSession,
  getUnlockedWorkspaces,
  saveScopedBusinessSettings,
  computeCredentialHashSync,
  deriveUserId,
  deriveMembershipId,
  normalizeAuthEmail,
} from '../multiTenantAuth';
import {
  UserPermissions,
  SettingsPermissionKey,
  ModulePermissionKey,
  SETTINGS_PERMISSION_OPTIONS,
  MODULE_PERMISSION_OPTIONS,
  ALL_SETTINGS_KEYS,
  ALL_MODULE_KEYS,
  getDefaultSettingsForRole,
  getDefaultModulesForRole,
  buildUserPermissions,
  parseStaffPermissions,
  isUserSuspended,
  getPermittedSettingsTabs,
  canAccessSettingTab,
  mapSubTabToPermissionKey,
  loadSessionPermissionsFromStorage,
  saveSessionPermissionsToStorage,
  normalizeRole,
} from '../permissions';

interface SettingsPanelProps {
  settings: StoreSettings;
  setSettings: (settings: StoreSettings) => void;
  onRefreshDatabase: (template: SeedTemplate) => void;
  activeStore?: string;
  setActiveStore?: (storeId: string) => void;
  userRole?: string;
  userPermissions?: UserPermissions;
  activeBusiness?: any;
  setActiveBusiness?: (biz: any) => void;
  businesses?: any[];
  unlockedWorkspaces?: UnlockedWorkspaceSession[];
  onSwitchUnlockedWorkspace?: (ws: UnlockedWorkspaceSession) => void | Promise<void>;
  onUnlockWorkspace?: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  onCreateNewWorkspace?: () => void;
  onSelectBusinessWorkspace?: (biz: any) => void;
  onSyncExistingAccount?: (e: React.FormEvent) => void;
  syncLoginEmail?: string;
  setSyncLoginEmail?: (val: string) => void;
  syncLoginPassword?: string;
  setSyncLoginPassword?: (val: string) => void;
  isHeaderSyncing?: boolean;
  onNavigateToTab?: (tab: string) => void;
  onNavigateToInventory?: () => void;
  initialSubTab?: 'general' | 'stores' | 'users' | 'stock' | 'payments' | 'zra' | 'workspaces' | 'printer' | 'database';
}

export default function SettingsPanel({
  settings,
  setSettings,
  onRefreshDatabase,
  activeStore = '',
  setActiveStore,
  userRole: currentUserRole = 'owner',
  userPermissions,
  activeBusiness,
  unlockedWorkspaces = [],
  onSwitchUnlockedWorkspace,
  onUnlockWorkspace,
  onCreateNewWorkspace,
  onNavigateToInventory,
  initialSubTab = 'general',
}: SettingsPanelProps) {
  const [storeName, setStoreName] = useState(settings.storeName);
  const [currency, setCurrency] = useState(settings.currency);
  const [taxRate, setTaxRate] = useState(settings.taxRate);
  const [loyaltyRatio, setLoyaltyRatio] = useState<string>(String(settings.loyaltyRatio ?? 0));
  const [receiptHeader, setReceiptHeader] = useState(settings.receiptHeader);
  const [receiptFooter, setReceiptFooter] = useState(settings.receiptFooter);
  const [paperWidth, setPaperWidth] = useState<'58mm' | '80mm'>(settings.paperWidth);
  const [logoUrl, setLogoUrl] = useState<string>(settings.logoUrl || '');
  const [tpin, setTpin] = useState<string>(settings.tpin || '');
  const [billingAddress, setBillingAddress] = useState<string>(settings.billingAddress || '');
  const [billingCity, setBillingCity] = useState<string>(settings.billingCity || '');
  const [billingCountry, setBillingCountry] = useState<string>(settings.billingCountry || '');
  const [billingPhone, setBillingPhone] = useState<string>(settings.billingPhone || '');
  const [billingEmail, setBillingEmail] = useState<string>(settings.billingEmail || '');
  const [termsAndConditions, setTermsAndConditions] = useState<string>(settings.termsAndConditions || '');

  const [printerName, setPrinterName] = useState<string>(settings.printerName || '');
  const [printerInterface, setPrinterInterface] = useState<string>(settings.printerInterface || 'Bluetooth Low Energy (BLE)');
  const [printerStatus, setPrinterStatus] = useState<'Linked' | 'Not Linked'>(settings.printerStatus || 'Not Linked');
  const [pairedBtDevices, setPairedBtDevices] = useState<PairedBluetoothPrinter[]>([]);
  const [btDiscoveryLoading, setBtDiscoveryLoading] = useState<boolean>(false);
  const [btDiscoveryNotice, setBtDiscoveryNotice] = useState<string>('');
  const [btPlatform, setBtPlatform] = useState<'android' | 'web'>('web');
  const [btAdapterEnabled, setBtAdapterEnabled] = useState<boolean>(true);
  const [selectedBtDeviceId, setSelectedBtDeviceId] = useState<string>(() => {
    const meta = getSelectedPrinterMetadata(activeBusiness?.id || getActiveBusinessId());
    return meta?.id || '';
  });
  const [testPrintActive, setTestPrintActive] = useState(false);
  const [testPrintContent, setTestPrintContent] = useState<{
    date: string;
    hex: string;
    plain: string;
    hardwareDispatched?: boolean;
    hardwareNote?: string;
  } | null>(null);

  const [seedIndustry, setSeedIndustry] = useState<SeedTemplate>('blank');
  const [notification, setNotification] = useState<string | null>(null);
  const [generatedSqlDump, setGeneratedSqlDump] = useState<string>('');

  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [fbAuthEmail, setFbAuthEmail] = useState('');
  const [fbAuthPassword, setFbAuthPassword] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [wsUnlockEmail, setWsUnlockEmail] = useState('');
  const [wsUnlockPass, setWsUnlockPass] = useState('');
  const [wsUnlockLoading, setWsUnlockLoading] = useState(false);
  const [wsUnlockFeedback, setWsUnlockFeedback] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  const effectivePermissions: UserPermissions = React.useMemo(() => {
    if (normalizeRole(currentUserRole) === 'owner') {
      return buildUserPermissions({ role: 'owner' });
    }
    return userPermissions || loadSessionPermissionsFromStorage(currentUserRole);
  }, [currentUserRole, userPermissions]);

  const permittedSubTabs = React.useMemo(
    () => getPermittedSettingsTabs(currentUserRole, effectivePermissions),
    [currentUserRole, effectivePermissions]
  );

  const normalizeSubTab = (tab?: string): SettingsPermissionKey => {
    const mapped = mapSubTabToPermissionKey(tab);
    if (canAccessSettingTab(mapped, currentUserRole, effectivePermissions)) {
      return mapped;
    }
    return permittedSubTabs[0] || 'general';
  };

  // Unified settings & admin control tabs ('general' | 'stores' | 'users' | 'stock' | 'payments' | 'zra' | 'workspaces')
  const [activeSubTab, setActiveSubTab] = useState<SettingsPermissionKey>(() => normalizeSubTab(initialSubTab));

  const [customMethods, setCustomMethods] = useState<CustomPaymentMethod[]>(() => getCustomPaymentMethods(true));
  const [newMethodName, setNewMethodName] = useState('');
  const [newMethodCategory, setNewMethodCategory] = useState<CustomPaymentMethod['category']>('Other');
  const [paymentMethodFeedback, setPaymentMethodFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // ZRA Smart Invoice (VSDC) Admin Configuration states
  const [zraForm, setZraForm] = useState<ZraConfig>(() => getZraConfig());
  const [zraQueue, setZraQueue] = useState<ZraOfflineQueueItem[]>(() => FiscalService.getOfflineQueue());
  const [zraInitLoading, setZraInitLoading] = useState(false);
  const [zraSyncLoading, setZraSyncLoading] = useState(false);
  const [zraFeedback, setZraFeedback] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    const requested = mapSubTabToPermissionKey(initialSubTab);
    if (canAccessSettingTab(requested, currentUserRole, effectivePermissions)) {
      setActiveSubTab(requested);
    } else if (permittedSubTabs.length > 0 && !permittedSubTabs.includes(activeSubTab)) {
      setActiveSubTab(permittedSubTabs[0]);
    }
  }, [initialSubTab, currentUserRole, effectivePermissions, permittedSubTabs]);

  useEffect(() => {
    const refreshCustomMethods = () => {
      setCustomMethods(getCustomPaymentMethods(true));
    };
    const refreshZraQueue = () => {
      setZraQueue(FiscalService.getOfflineQueue());
    };
    const unsubZra = subscribeZraConfig((cfg) => {
      setZraForm(cfg);
    });
    refreshCustomMethods();
    refreshZraQueue();
    window.addEventListener('pos_data_updated', refreshCustomMethods);
    window.addEventListener('local_db_restored', refreshCustomMethods);
    window.addEventListener('zra_queue_updated', refreshZraQueue);
    return () => {
      unsubZra();
      window.removeEventListener('pos_data_updated', refreshCustomMethods);
      window.removeEventListener('local_db_restored', refreshCustomMethods);
      window.removeEventListener('zra_queue_updated', refreshZraQueue);
    };
  }, []);

  const refreshPairedBluetoothDevices = async () => {
    setBtDiscoveryLoading(true);
    try {
      const result = await listPairedBluetoothDevicesOnGadget();
      setBtPlatform(result.platform);
      setBtAdapterEnabled(result.enabled);
      setPairedBtDevices(result.devices);
      setBtDiscoveryNotice(result.notice || '');

      const bizKey = activeBusiness?.id || getActiveBusinessId();
      const savedMeta = getSelectedPrinterMetadata(bizKey);
      if (savedMeta?.id) {
        setSelectedBtDeviceId(savedMeta.id);
      } else if (printerName) {
        const match = result.devices.find(
          (d) =>
            formatHardwarePrinterValue(d) === printerName ||
            d.name === printerName ||
            d.address === printerName
        );
        if (match) setSelectedBtDeviceId(match.id);
      }
    } catch (err: any) {
      setBtDiscoveryNotice(err?.message || 'Unable to scan paired Bluetooth devices on this gadget.');
    } finally {
      setBtDiscoveryLoading(false);
    }
  };

  useEffect(() => {
    refreshPairedBluetoothDevices();
  }, [activeBusiness?.id]);

  useEffect(() => {
    if (settings.printerName !== undefined) setPrinterName(settings.printerName || '');
    if (settings.printerInterface !== undefined && settings.printerInterface) {
      setPrinterInterface(settings.printerInterface);
    }
    if (settings.printerStatus !== undefined) setPrinterStatus(settings.printerStatus);
  }, [settings.printerName, settings.printerInterface, settings.printerStatus]);

  const handleSelectPairedBluetoothPrinter = (device: PairedBluetoothPrinter) => {
    const label = formatHardwarePrinterValue(device);
    const nextInterface =
      device.transport === 'classic'
        ? 'Bluetooth Classic (SPP / RFCOMM)'
        : 'Bluetooth Low Energy (BLE)';
    setPrinterName(label);
    setPrinterInterface(nextInterface);
    setPrinterStatus('Linked');
    setSelectedBtDeviceId(device.id);
    const bizKey = activeBusiness?.id || getActiveBusinessId();
    saveSelectedPrinterMetadata(bizKey, device);
    triggerNotify(`Bluetooth printer "${device.name}" selected (${device.address}). Click Save Changes to persist.`);
  };

  const handleSelectHardwarePrinterDropdown = (value: string) => {
    setPrinterName(value);
    const bizKey = activeBusiness?.id || getActiveBusinessId();
    const matchedBt = pairedBtDevices.find(
      (d) => formatHardwarePrinterValue(d) === value || d.name === value || d.id === value
    );
    if (matchedBt) {
      const nextInterface =
        matchedBt.transport === 'classic'
          ? 'Bluetooth Classic (SPP / RFCOMM)'
          : 'Bluetooth Low Energy (BLE)';
      setPrinterInterface(nextInterface);
      setPrinterStatus('Linked');
      setSelectedBtDeviceId(matchedBt.id);
      saveSelectedPrinterMetadata(bizKey, matchedBt);
    } else if (!value) {
      setPrinterStatus('Not Linked');
      setSelectedBtDeviceId('');
      saveSelectedPrinterMetadata(bizKey, null);
    } else {
      setSelectedBtDeviceId('');
      saveSelectedPrinterMetadata(bizKey, null);
      if (value === 'Generic Cloud-POS Printer Spooler' || value === 'System Print Dialog (OS)') {
        setPrinterInterface('Simulated Direct In-App Spool');
        setPrinterStatus('Linked');
      }
    }
  };

  const handlePairOrPickGadgetBluetooth = async () => {
    setBtDiscoveryLoading(true);
    try {
      const res = await pairOrPickBluetoothDeviceOnGadget();
      if (res.discovery) {
        setBtPlatform(res.discovery.platform);
        setBtAdapterEnabled(res.discovery.enabled);
        setPairedBtDevices(res.discovery.devices);
        setBtDiscoveryNotice(res.discovery.notice || '');
      }
      if (res.printer) {
        handleSelectPairedBluetoothPrinter(res.printer);
      } else if (res.error) {
        setBtDiscoveryNotice(res.error);
      }
    } finally {
      setBtDiscoveryLoading(false);
    }
  };

  const handleOpenAndroidBluetooth = async () => {
    try {
      await openGadgetBluetoothSettings();
      triggerNotify('Opened gadget Bluetooth settings. Pair your printer, then tap Refresh.');
    } catch (err: any) {
      setBtDiscoveryNotice(err?.message || 'Unable to open gadget Bluetooth settings.');
    }
  };

  // State for Users list, Stores/Branches list, Products count, and Businesses list
  const [usersList, setUsersList] = useState<any[]>([]);
  const [storesList, setStoresList] = useState<any[]>([]);
  const [businessesList, setBusinessesList] = useState<any[]>([]);
  const [productsCount, setProductsCount] = useState<number>(0);

  // Quick Add Stock states inside unified SettingsPanel
  const [quickProdName, setQuickProdName] = useState('');
  const [quickProdDescription, setQuickProdDescription] = useState('');
  const [quickProdBarcode, setQuickProdBarcode] = useState('');
  const [quickProdCategory, setQuickProdCategory] = useState('');
  const [quickProdPrice, setQuickProdPrice] = useState('');
  const [quickProdCost, setQuickProdCost] = useState('');
  const [quickProdStock, setQuickProdStock] = useState('');
  const [quickProdStoreId, setQuickProdStoreId] = useState('');
  const [quickProdBatchNum, setQuickProdBatchNum] = useState('');
  const [quickProdExpiry, setQuickProdExpiry] = useState('');
  const [quickStockMsg, setQuickStockMsg] = useState<string | null>(null);

  // Store creation & editing states inside SettingsPanel
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchCode, setNewBranchCode] = useState('');
  const [newBranchLocation, setNewBranchLocation] = useState('');
  const [newBranchPhone, setNewBranchPhone] = useState('');
  const [newBranchEmail, setNewBranchEmail] = useState('');
  const [newBranchDiscounts, setNewBranchDiscounts] = useState(true);
  const [newBranchRefunds, setNewBranchRefunds] = useState(true);
  const [newBranchLaybys, setNewBranchLaybys] = useState(true);
  const [newBranchManagerReq, setNewBranchManagerReq] = useState(false);
  const [editingBranchId, setEditingBranchId] = useState<string | null>(null);
  const [editBranchName, setEditBranchName] = useState('');
  const [editBranchLocation, setEditBranchLocation] = useState('');
  const [editBranchPhone, setEditBranchPhone] = useState('');
  const [editBranchEmail, setEditBranchEmail] = useState('');

  // User form states
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [userFirstName, setUserFirstName] = useState('');
  const [userSurname, setUserSurname] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [userPassword, setUserPassword] = useState('');
  const [userRole, setUserRole] = useState<'sales' | 'manager' | 'owner'>('sales');
  const [userSalary, setUserSalary] = useState('');
  const [userContact, setUserContact] = useState('');
  const [userSuspended, setUserSuspended] = useState(false);
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]); // Array of store branch IDs
  const [allowedSettings, setAllowedSettings] = useState<SettingsPermissionKey[]>(() => getDefaultSettingsForRole('sales'));
  const [allowedModules, setAllowedModules] = useState<ModulePermissionKey[]>(() => getDefaultModulesForRole('sales'));
  const [confirmRevokeUserKey, setConfirmRevokeUserKey] = useState<string | null>(null);
  const [userActionFeedback, setUserActionFeedback] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null);

  useEffect(() => {
    setStoreName(settings.storeName);
    setCurrency(settings.currency);
    setTaxRate(settings.taxRate);
    setLoyaltyRatio(String(settings.loyaltyRatio ?? 0));
    setReceiptHeader(settings.receiptHeader);
    setReceiptFooter(settings.receiptFooter);
    setPaperWidth(settings.paperWidth);
    setLogoUrl(settings.logoUrl || '');
    setTpin(settings.tpin || '');
    setBillingAddress(settings.billingAddress || '');
    setBillingCity(settings.billingCity || '');
    setBillingCountry(settings.billingCountry || '');
    setBillingPhone(settings.billingPhone || '');
    setBillingEmail(settings.billingEmail || '');
    setTermsAndConditions(settings.termsAndConditions || '');
  }, [settings]);

  const loadUsersList = () => {
    const activeBizId = getActiveBusinessId();
    const staffWhere = activeBizId ? ` WHERE business_id = '${sqlEsc(activeBizId)}'` : '';
    // 1. Fetch standard staff profiles
    const staffRes = runSql(`SELECT * FROM staff${staffWhere}`, 'Load staff directory for accounts management');
    let mappedStaff: any[] = [];
    if (staffRes.success && Array.isArray(staffRes.data)) {
      mappedStaff = staffRes.data.map(st => {
        let perms: any = {};
        try {
          if (st.permissions_json) {
            perms = JSON.parse(st.permissions_json);
          }
        } catch (e) {}
        const fullName = st.name || `${st.first_name || ''} ${st.surname || ''}`.trim() || 'Staff User';
        const parts = fullName.split(' ');
        const fName = st.first_name || parts[0] || 'Staff';
        const sName = st.surname || parts.slice(1).join(' ') || '';
        const resolvedRole = st.role || perms.role || (parseFloat(st.basic_salary) > 10000 ? 'manager' : 'sales');
        const parsedPerms = parseStaffPermissions(st.permissions_json, resolvedRole);
        const suspended = isUserSuspended(st.permissions_json);
        const branches = perms.accessible_branches && perms.accessible_branches.length > 0
          ? perms.accessible_branches
          : (st.store_id ? [st.store_id] : []);
        return {
          id: st.id,
          first_name: fName,
          surname: sName,
          email: st.email || '',
          contact: st.contact || '',
          basic_salary: st.basic_salary || 0,
          role: resolvedRole,
          password: st.password || perms.password || st.pin || '',
          accessible_branches: branches,
          allowed_settings: parsedPerms.allowed_settings,
          allowed_modules: parsedPerms.allowed_modules,
          suspended,
          suspended_at: parsedPerms.suspended_at || null,
          is_owner: false,
          raw: st
        };
      });
    }

    // 2. Fetch business owners (deduplicated by id, scoped to active business)
    const bizWhere = activeBizId
      ? ` WHERE id = '${sqlEsc(activeBizId)}' OR business_id = '${sqlEsc(activeBizId)}'`
      : '';
    const bizRes = runSql(`SELECT * FROM businesses${bizWhere}`, 'Load corporate directory for accounts management');
    let mappedBiz: any[] = [];
    if (bizRes.success && Array.isArray(bizRes.data)) {
      const seenBizIds = new Set<string>();
      const uniqueBizRows = bizRes.data.filter((bz: any) => {
        const key = String(bz?.id || '');
        if (!key || seenBizIds.has(key)) return false;
        seenBizIds.add(key);
        return true;
      });
      setBusinessesList(uniqueBizRows);
      mappedBiz = uniqueBizRows.map(bz => {
        const ownerName = bz.owner || 'Business Owner';
        const spaceIdx = ownerName.indexOf(' ');
        const fName = spaceIdx > 0 ? ownerName.substring(0, spaceIdx) : ownerName;
        const sName = spaceIdx > 0 ? ownerName.substring(spaceIdx + 1) : '';
        return {
          id: bz.id,
          first_name: fName,
          surname: sName,
          email: bz.email || '',
          contact: bz.phone || settings.billingPhone || '',
          basic_salary: 0,
          role: 'owner',
          password: bz.password || '',
          accessible_branches: [], // implicit: all branches
          allowed_settings: [...ALL_SETTINGS_KEYS],
          allowed_modules: [...ALL_MODULE_KEYS],
          suspended: false,
          suspended_at: null,
          is_owner: true,
          raw: bz
        };
      });
    }

    setUsersList([...mappedBiz, ...mappedStaff]);
  };

  const loadStoresList = () => {
    const activeBizId = getActiveBusinessId();
    const central = getCentralBranches(activeBizId || undefined);
    setStoresList(central);
    const prodWhere = activeBizId ? ` WHERE business_id = '${sqlEsc(activeBizId)}'` : '';
    const pRes = runSql(`SELECT COUNT(*) AS cnt FROM products${prodWhere}`, 'Count products');
    if (pRes.success && Array.isArray(pRes.data) && pRes.data[0]) {
      setProductsCount(Number(pRes.data[0].cnt || 0));
    }
  };

  useEffect(() => {
    loadUsersList();
    loadStoresList();
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  const handleGoogleLogin = async () => {
    try {
      setSyncStatus('Logging in with Google...');
      setSyncError(null);
      await signInWithPopup(auth, googleProvider);
      const unlockedList = getUnlockedWorkspaces();
      if (unlockedList.length > 0) {
        const linkRes = await linkOwnerWorkspacesWithCurrentFirebaseAdmin(unlockedList).catch(() => ({
          linkedBusinesses: [],
        }));
        if (linkRes.linkedBusinesses.length > 0) {
          triggerNotify(`Logged in with Google and linked ${linkRes.linkedBusinesses.length} cloud workspace(s)!`);
          setSyncStatus(`Google Auth connected & linked workspace(s): ${linkRes.linkedBusinesses.join(', ')}.`);
          return;
        }
      }
      triggerNotify('Logged in with Google via Firebase Auth successfully!');
      setSyncStatus(null);
    } catch (err: any) {
      console.error(err);
      setSyncError(err?.message || 'Login failed');
      setSyncStatus(null);
    }
  };

  const handleFirebaseEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fbAuthEmail.trim() || !fbAuthPassword.trim()) {
      setSyncError('Please enter both Email and Password (min 6 characters).');
      return;
    }
    try {
      setSyncStatus('Authenticating with Firebase Email/Password Provider...');
      setSyncError(null);
      const { user: authedUser, isNewUser } = await registerOrSignInWithEmailPassword(
        fbAuthEmail.trim(),
        fbAuthPassword.trim(),
        storeName
      );
      setFbAuthPassword('');
      triggerNotify(
        isNewUser
          ? `Registered & connected [${authedUser.email}] via Firebase Email/Password Auth!`
          : `Signed in as [${authedUser.email}] via Firebase Email/Password Auth!`
      );
      setSyncStatus(`Connected to Firebase Auth (${authedUser.email}). Ready for Firestore & Firebase Storage backup.`);
    } catch (err: any) {
      console.error(err);
      setSyncError(err?.message || 'Firebase Email/Password authentication failed');
      setSyncStatus(null);
    }
  };

  const handleGoogleLogout = async () => {
    try {
      await googleSignOut();
      triggerNotify('Logged out of Firebase Auth successfully!');
    } catch (err: any) {
      console.error(err);
    }
  };

  const handleBackupToCloud = async () => {
    setIsSyncing(true);
    setSyncStatus('Backing up all business settings, profile, branches, stock, clients & accounting ledgers to Cloud Firestore...');
    setSyncError(null);
    try {
      const bizId = getActiveBusinessId();
      let fbRes: { success: boolean; details: string } | null = null;
      let fbErrMsg: string | null = null;

      if (auth.currentUser) {
        try {
          fbRes = await backupToCloud(bizId, { silentIfNotOwner: true });
        } catch (fbErr: any) {
          console.warn('Firebase backup notice:', fbErr);
          fbErrMsg = fbErr?.message || String(fbErr);
        }
      }

      const sqlRes = await pushDatabaseToServer(bizId).catch((err: any) => ({
        success: false,
        details: err?.message || 'Cloud SQL unavailable',
      }));

      if (fbRes?.success) {
        const extra = sqlRes.success ? ` | ${sqlRes.details}` : '';
        triggerNotify('Cloud Firestore Backup succeeded!');
        setSyncStatus(`${fbRes.details}${extra}`);
      } else if (sqlRes.success) {
        const extra = fbRes?.details ? ` | ${fbRes.details}` : fbErrMsg ? ` | Firestore note: ${fbErrMsg}` : '';
        triggerNotify('Cloud Synchronization Push succeeded!');
        setSyncStatus(`${sqlRes.details}${extra}`);
      } else {
        setSyncError(fbErrMsg || fbRes?.details || sqlRes.details || 'Cloud backup failed. Please sign in to Firebase.');
      }
    } catch (err: any) {
      console.error(err);
      setSyncError(err?.message || 'Backup failed');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleRestoreFromCloud = async () => {
    setIsSyncing(true);
    setSyncStatus('Restoring latest business settings, profile, branches, stocks & ledgers from Cloud Firestore...');
    setSyncError(null);
    try {
      const bizId = getActiveBusinessId();
      if (auth.currentUser) {
        try {
          const res = await restoreFromCloud(bizId || undefined, { silentIfUnlinked: true });
          if (res.success) {
            try {
              const rawS = localStorage.getItem('android_pos_settings');
              if (rawS) {
                setSettings(JSON.parse(rawS));
              }
            } catch {}
            loadUsersList();
            loadStoresList();
            triggerNotify('Cloud Firestore Restore succeeded!');
            setSyncStatus(res.details);
            return;
          }
        } catch (fbErr: any) {
          console.warn('Firestore restore fallback notice:', fbErr);
        }
      }

      const sqlPull = await pullDatabaseFromServer(bizId || undefined);
      if (sqlPull.success && sqlPull.found) {
        if (sqlPull.settings) {
          setSettings(sqlPull.settings);
        }
        loadUsersList();
        loadStoresList();
        triggerNotify('Cloud SQL Restore succeeded!');
        setSyncStatus(sqlPull.details);
        window.dispatchEvent(new Event('local_db_restored'));
        return;
      }

      setSyncError(sqlPull.details || 'No cloud backup found for this business yet.');
      setSyncStatus(null);
    } catch (err: any) {
      console.error(err);
      setSyncError(err?.message || 'Restore failed');
    } finally {
      setIsSyncing(false);
    }
  };

  const triggerNotify = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (file.size > 500 * 1024) {
      alert("Please upload an image smaller than 500KB to ensure smooth local database storage.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setLogoUrl(reader.result);
        triggerNotify("Company Logo loaded successfully!");
      }
    };
    reader.onerror = () => {
      alert("Failed reading selected file.");
    };
    reader.readAsDataURL(file);
  };

  const handleSaveSettings = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const activeBizId = getActiveBusinessId(activeBusiness?.id);
    const currentZra = getZraConfig();
    const updated: StoreSettings = {
      storeName,
      currency,
      taxRate: parseFloat(taxRate as any) || 0,
      loyaltyRatio: Math.max(0, parseFloat(loyaltyRatio) || 0),
      receiptHeader,
      receiptFooter,
      paperWidth,
      logoUrl,
      tpin,
      billingAddress,
      billingCity,
      billingCountry,
      billingPhone,
      billingEmail,
      termsAndConditions,
      printerName,
      printerInterface,
      printerStatus,
      customPaymentMethods: getCustomPaymentMethods(true),
      zraConfig: currentZra,
    };
    setSettings(updated);
    saveScopedBusinessSettings(activeBizId, updated);
    if (activeBizId) {
      switchZraConfigForBusiness(activeBizId, currentZra);
      runSql(`
        UPDATE businesses
        SET name = '${storeName.trim().replace(/'/g, "''")}',
            billing_address = '${billingAddress.trim().replace(/'/g, "''")}',
            billing_city = '${billingCity.trim().replace(/'/g, "''")}',
            billing_country = '${billingCountry.trim().replace(/'/g, "''")}',
            phone = '${billingPhone.trim().replace(/'/g, "''")}',
            billing_phone = '${billingPhone.trim().replace(/'/g, "''")}',
            billing_email = '${billingEmail.trim().replace(/'/g, "''")}',
            tpin = '${tpin.trim().replace(/'/g, "''")}',
            currency = '${currency.trim().replace(/'/g, "''")}',
            tax_rate = ${parseFloat(taxRate as any) || 0}
        WHERE id = '${sqlEsc(activeBizId)}'
      `, 'SettingsPanel: Sync business & billing address details');
      try {
        const saved = localStorage.getItem('active_business_profile');
        if (saved) {
          const parsed = JSON.parse(saved);
          parsed.name = storeName.trim() || parsed.name;
          localStorage.setItem('active_business_profile', JSON.stringify(parsed));
        }
      } catch {}
      persistTablesToStorage();
      pushDatabaseToServer(activeBizId).catch(() => {});
      if (auth.currentUser) {
        backupToCloud(activeBizId, { silentIfNotOwner: true }).catch(() => {});
      }
      window.dispatchEvent(new Event('pos_data_updated'));
    }

    triggerNotify('✓ Business profile, billing address & receipt settings saved and synchronized!');
  };

  const handleQuickAddStockInSettings = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!quickProdName.trim()) {
      setQuickStockMsg('⚠️ Please enter a Product / Stock Name before saving.');
      return;
    }
    const activeBizId = getActiveBusinessId();
    const centralStores = getCentralBranches(activeBizId || undefined);
    const targetStore = quickProdStoreId || activeStore || getActiveStoreId(undefined, activeBizId) || (centralStores[0]?.id ?? 'main');

    const prodId = Math.floor(10000 + Math.random() * 90000);
    const sku = quickProdBarcode.trim() || `SKU-${prodId}`;
    const category = quickProdCategory.trim() || 'General';
    const price = Math.max(0, parseFloat(quickProdPrice || '0') || 0);
    const cost = Math.max(0, parseFloat(quickProdCost || '0') || 0);
    const qty = Math.max(0, parseInt(quickProdStock || '0', 10) || 0);
    const batchNum = quickProdBatchNum.trim() || `BATCH-${new Date().toISOString().slice(0, 10)}`;
    const expiry = quickProdExpiry.trim() || '';
    const imgUrl = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=150';

    runSql(`
      INSERT INTO products (id, name, description, sku, category, price, cost, stock, imageUrl, business_id, store_id, is_service, batch_number, expiry_date) VALUES (
        ${prodId},
        '${sqlEsc(quickProdName.trim())}',
        '${sqlEsc(quickProdDescription.trim())}',
        '${sqlEsc(sku)}',
        '${sqlEsc(category)}',
        ${price},
        ${cost},
        ${qty},
        '${imgUrl}',
        '${sqlEsc(activeBizId)}',
        '${sqlEsc(targetStore)}',
        0,
        '${sqlEsc(batchNum)}',
        '${sqlEsc(expiry)}'
      )
    `, `SettingsPanel: Create stock item [${quickProdName.trim()}]`);

    const branchList = storesList.length > 0 ? storesList.map((s: any) => s.id) : [targetStore];
    const uniqueBranches = Array.from(new Set([...branchList, targetStore].filter(Boolean)));
    uniqueBranches.forEach((stId: string) => {
      const spId = `sp_${prodId}_${stId}`;
      const branchQty = stId === targetStore ? qty : 0;
      runSql(`
        INSERT INTO store_products (id, product_id, store_id, stock, price, business_id) VALUES (
          '${sqlEsc(spId)}', ${prodId}, '${sqlEsc(stId)}', ${branchQty}, ${price}, '${sqlEsc(activeBizId)}'
        )
      `, `SettingsPanel: Allocate stock for [${quickProdName.trim()}] to branch [${stId}]`);
    });

    if (qty > 0) {
      const refId = `stock_init_${prodId}_${Date.now()}`;
      const nowStr = new Date().toISOString();
      runSql(`
        INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by, business_id, store_id)
        VALUES (
          '${refId}',
          'idem_${refId}',
          '${sqlEsc(targetStore.toUpperCase())}',
          'RECEIVE',
          'CATALOG_INIT',
          ${(qty * cost).toFixed(2)},
          0.00,
          'SUCCESS',
          'Initial catalog creation for ${sqlEsc(quickProdName.trim())}: +${qty} units [Batch: ${sqlEsc(batchNum || 'N/A')}]',
          '${nowStr}',
          '${nowStr}',
          'owner',
          '${sqlEsc(activeBizId)}',
          '${sqlEsc(targetStore)}'
        )
      `, 'SettingsPanel: Log initial stock creation transaction');
    }

    const savedName = quickProdName.trim();
    setQuickProdName('');
    setQuickProdDescription('');
    setQuickProdBarcode('');
    setQuickProdCategory('');
    setQuickProdPrice('');
    setQuickProdCost('');
    setQuickProdStock('');
    setQuickProdBatchNum('');
    setQuickProdExpiry('');
    loadStoresList();
    persistTablesToStorage();
    pushDatabaseToServer(activeBizId).catch(() => {});
    if (auth.currentUser) {
      backupToCloud(activeBizId, { silentIfNotOwner: true }).catch(() => {});
    }
    window.dispatchEvent(new Event('pos_data_updated'));
    setQuickStockMsg(`✓ Saved "${savedName}" (SKU: ${sku}, Price: ${currency || 'K'}${price.toFixed(2)}, Stock: ${qty}) to inventory & synchronized!`);
    triggerNotify(`✓ Saved "${savedName}" to stock!`);
  };

  const handleCreateBranchInSettings = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBranchName.trim()) {
      alert('Please enter a Store / Branch Name.');
      return;
    }
    const activeBizId = getActiveBusinessId();
    const finalId = newBranchCode.trim().toLowerCase().replace(/\s+/g, '_') || ('store_' + Math.floor(1000 + Math.random() * 9000));
    const dup = runSql(`SELECT * FROM stores WHERE id = '${sqlEsc(finalId)}'${activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : ''}`);
    if (dup.success && Array.isArray(dup.data) && dup.data.length > 0) {
      alert(`A store branch with code [${finalId}] already exists.`);
      return;
    }
    runSql(`
      INSERT INTO stores (id, business_id, store_id, name, location, phone, email, allow_discounts, allow_refunds, allow_laybys, require_manager_discount, stocktake_frequency)
      VALUES (
        '${sqlEsc(finalId)}',
        '${sqlEsc(activeBizId)}',
        '${sqlEsc(finalId)}',
        '${sqlEsc(newBranchName.trim())}',
        '${sqlEsc(newBranchLocation.trim())}',
        '${sqlEsc(newBranchPhone.trim())}',
        '${sqlEsc(newBranchEmail.trim())}',
        ${newBranchDiscounts ? 1 : 0},
        ${newBranchRefunds ? 1 : 0},
        ${newBranchLaybys ? 1 : 0},
        ${newBranchManagerReq ? 1 : 0},
        'weekly'
      )
    `, `SettingsPanel: Create store branch [${newBranchName}]`);

    const prodQuery = activeBizId ? `SELECT * FROM products WHERE business_id = '${sqlEsc(activeBizId)}'` : `SELECT * FROM products`;
    const prodsRes = runSql(prodQuery);
    if (prodsRes.success && Array.isArray(prodsRes.data)) {
      prodsRes.data.forEach((p: any) => {
        runSql(`INSERT INTO store_products (id, product_id, store_id, stock, price, business_id) VALUES ('sp_${p.id}_${sqlEsc(finalId)}', ${p.id}, '${sqlEsc(finalId)}', 0, ${p.price || 0}, '${sqlEsc(activeBizId)}')`);
      });
    }
    if (!activeStore && setActiveStore) {
      setActiveStore(finalId);
    }
    localStorage.setItem('pos_shift_active', 'true');
    localStorage.setItem('shift_active_' + finalId, 'true');
    setNewBranchName('');
    setNewBranchCode('');
    setNewBranchLocation('');
    setNewBranchPhone('');
    setNewBranchEmail('');
    loadStoresList();
    persistTablesToStorage();
    pushDatabaseToServer(activeBizId).catch(() => {});
    if (auth.currentUser) {
      backupToCloud(activeBizId, { silentIfNotOwner: true }).catch(() => {});
    }
    window.dispatchEvent(new Event('pos_data_updated'));
    triggerNotify(`✓ Store branch [${newBranchName}] created & synchronized!`);
  };

  const handleSaveBranchEdit = (storeId: string) => {
    if (!editBranchName.trim()) {
      alert('Branch Name is required.');
      return;
    }
    const activeBizId = getActiveBusinessId();
    const bizAnd = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
    runSql(`
      UPDATE stores
      SET name = '${sqlEsc(editBranchName.trim())}',
          location = '${sqlEsc(editBranchLocation.trim())}',
          phone = '${sqlEsc(editBranchPhone.trim())}',
          email = '${sqlEsc(editBranchEmail.trim())}'
      WHERE id = '${sqlEsc(storeId)}'${bizAnd}
    `, `SettingsPanel: Update branch [${editBranchName.trim()}] contact details`);
    setEditingBranchId(null);
    loadStoresList();
    persistTablesToStorage();
    pushDatabaseToServer(activeBizId).catch(() => {});
    if (auth.currentUser) {
      backupToCloud(activeBizId, { silentIfNotOwner: true }).catch(() => {});
    }
    window.dispatchEvent(new Event('pos_data_updated'));
    triggerNotify(`✓ Branch [${editBranchName.trim()}] details updated!`);
  };

  const handleDeleteBranchInSettings = (storeId: string, branchName: string) => {
    if (!window.confirm(`Delete store branch "${branchName}"?`)) return;
    const activeBizId = getActiveBusinessId();
    const bizAnd = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
    runSql(`DELETE FROM stores WHERE id = '${sqlEsc(storeId)}'${bizAnd}`, `SettingsPanel: Delete store ${storeId}`);
    runSql(`DELETE FROM store_products WHERE store_id = '${sqlEsc(storeId)}'${bizAnd}`, `SettingsPanel: Delete store_products for ${storeId}`);
    loadStoresList();
    persistTablesToStorage();
    window.dispatchEvent(new Event('pos_data_updated'));
    triggerNotify(`Store branch [${branchName}] removed.`);
  };

  const triggerTestPrintPlay = async () => {
    if (printerStatus !== 'Linked' || !printerName) {
      alert("⚠️ No Hardware Printer Linked!\n\nPlease select a paired Bluetooth printer on your gadget (or set status to 'Linked / Active') before running a test print.");
      return;
    }

    const d = new Date();
    const formattedDate = d.toLocaleString();

    // Setup print ASCII visual representation
    const border = "================================";
    const divider = "--------------------------------";
    const addressLine = [billingAddress, billingCity, billingCountry].filter(Boolean).join(', ') || 'Registered Business Address';
    const plainText = `
 ${(storeName || 'RETAIL POS').toUpperCase()}
 ${tpin ? `TPIN: ${tpin}` : 'TPIN: Not Set'}
 ${addressLine}
 ${divider}
        PRINTER SELF-TEST FEED
 ${divider}
 Date: ${formattedDate}
 Connection Mode: ${printerInterface}
 Printer HW Node: ${printerName}
 Status: ONLINE & LINKED
 ${border}
 [✓] Hardware Printer Selection OK
 [✓] ESC/POS Feed Code 0x1B 0x40 OK
 [✓] Character Width: ${paperWidth}
 ${divider}
      SYSTEM DIAGNOSTICS: READY
 ${border}
\n\n\n`;

    const encoder = new TextEncoder();
    const textBytes = encoder.encode(plainText);
    const escInit = new Uint8Array([0x1B, 0x40, 0x1B, 0x61, 0x00]);
    const escCut = new Uint8Array([0x0A, 0x0A, 0x1D, 0x56, 0x01]);
    const fullBytes = new Uint8Array(escInit.length + textBytes.length + escCut.length);
    fullBytes.set(escInit, 0);
    fullBytes.set(textBytes, escInit.length);
    fullBytes.set(escCut, escInit.length + textBytes.length);

    const hexBytes = Array.from(fullBytes.slice(0, 48))
      .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
      .join(' ') + (fullBytes.length > 48 ? ' ...' : '');

    let hardwareDispatched = false;
    let hardwareNote = 'Preview generated in ESC/POS spool monitor.';

    const matchedBt =
      pairedBtDevices.find((dev) => dev.id === selectedBtDeviceId) ||
      pairedBtDevices.find((dev) => formatHardwarePrinterValue(dev) === printerName || dev.name === printerName);

    if (matchedBt && printerInterface.toLowerCase().includes('bluetooth')) {
      const dispatch = await sendEscPosToHardwarePrinter({
        printer: matchedBt,
        addressOrId: matchedBt.address || matchedBt.id,
        bytes: fullBytes,
      });
      if (dispatch.dispatched) {
        hardwareDispatched = true;
        hardwareNote = `Dispatched ${fullBytes.length} ESC/POS bytes directly to "${matchedBt.name}" (${dispatch.method === 'android_rfcomm' ? 'Android Bluetooth SPP' : 'Web Bluetooth GATT'}).`;
      } else if (dispatch.error) {
        hardwareNote = `Preview ready (${dispatch.error})`;
      }
    }

    setTestPrintContent({
      date: formattedDate,
      hex: hexBytes,
      plain: plainText,
      hardwareDispatched,
      hardwareNote,
    });
    setTestPrintActive(true);
    triggerNotify(
      hardwareDispatched
        ? `🖨️ Test print sent directly to ${matchedBt?.name || printerName}!`
        : "🖨️ Test print ticket spooled successfully!"
    );
  };

  const handleResetDatabaseSelection = () => {
    if (!window.confirm(`Warning: This will drop all tables and seed the database with clean template data for the ${seedIndustry.toUpperCase()} industry! \nAll existing custom, historical, and un-backed up transactions inside this sandbox will be erased.`)) {
      return;
    }
    onRefreshDatabase(seedIndustry);
    triggerNotify(`Database flushed and re-seeded for ${seedIndustry.toUpperCase()} shop layout.`);
  };

  const handleExportPortableAppPackage = async () => {
    try {
      const settingsStr = localStorage.getItem('android_pos_settings') || JSON.stringify(settings);
      const bizProfile = localStorage.getItem('active_business_profile') || '';
      const activeBizId = getActiveBusinessId();
      const bizWhere = activeBizId ? ` WHERE business_id = '${sqlEsc(activeBizId)}'` : '';
      const bizSelfWhere = activeBizId ? ` WHERE id = '${sqlEsc(activeBizId)}' OR business_id = '${sqlEsc(activeBizId)}'` : '';
      
      const prodRes = runSql(`SELECT * FROM products${bizWhere}`);
      const custRes = runSql(`SELECT * FROM customers${bizWhere}`);
      const orderRes = runSql(`SELECT * FROM orders${bizWhere}`);
      const oItemRes = runSql(`SELECT * FROM order_items${bizWhere}`);
      const storeRes = runSql(`SELECT * FROM stores${bizWhere}`);
      const bizRes = runSql(`SELECT * FROM businesses${bizSelfWhere}`);
      const staffRes = runSql(`SELECT * FROM staff${bizWhere}`);
      
      const appBundle = {
        app_version: "2.5.0-portable",
        export_timestamp: new Date().toISOString(),
        store_settings: JSON.parse(settingsStr),
        business_profile: bizProfile ? JSON.parse(bizProfile) : null,
        database: {
          products: prodRes.success ? prodRes.data : [],
          customers: custRes.success ? custRes.data : [],
          orders: orderRes.success ? orderRes.data : [],
          order_items: oItemRes.success ? oItemRes.data : [],
          stores: storeRes.success ? storeRes.data : [],
          businesses: bizRes.success ? bizRes.data : [],
          staff: staffRes.success ? staffRes.data : [],
        }
      };

      const jsonStr = JSON.stringify(appBundle, null, 2);
      const filename = `sme_pos_app_bundle_${new Date().toISOString().slice(0, 10)}.pospack`;
      await exportAndShareText(filename, jsonStr, 'application/json');

      triggerNotify("🎉 Portable POS App Package (.pospack) exported successfully!");
    } catch (e: any) {
      alert("Failed exporting app package: " + e.message);
    }
  };

  const handleImportPortableAppPackage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const content = evt.target?.result as string;
        const bundle = JSON.parse(content);

        if (!bundle || (!bundle.store_settings && !bundle.database)) {
          alert("Invalid POS Package file format.");
          return;
        }

        if (bundle.store_settings) {
          setSettings(bundle.store_settings);
          localStorage.setItem('android_pos_settings', JSON.stringify(bundle.store_settings));
        }

        if (bundle.business_profile) {
          localStorage.setItem('active_business_profile', JSON.stringify(bundle.business_profile));
        }

        const targetBizId = String(bundle.business_profile?.id || getActiveBusinessId() || '').trim();
        const fallbackStoreId = String(activeStore || getActiveStoreId(undefined, targetBizId) || 'main').trim();
        const delWhere = targetBizId ? ` WHERE business_id = '${sqlEsc(targetBizId)}'` : '';

        if (bundle.database) {
          if (Array.isArray(bundle.database.products) && bundle.database.products.length > 0) {
            runSql(`DELETE FROM products${delWhere}`);
            bundle.database.products.forEach((p: any) => {
              const rowBiz = sqlEsc(p.business_id || targetBizId);
              const rowStore = sqlEsc(p.store_id || fallbackStoreId);
              runSql(`INSERT INTO products (id, name, description, sku, category, price, cost, stock, imageUrl, business_id, store_id, is_service, batch_number, expiry_date) VALUES (${p.id}, '${sqlEsc(p.name||'')}', '${sqlEsc(p.description||'')}', '${sqlEsc(p.sku||'')}', '${sqlEsc(p.category||'')}', ${p.price||0}, ${p.cost||0}, ${p.stock||0}, '${sqlEsc(p.imageUrl||'')}', '${rowBiz}', '${rowStore}', ${p.is_service||0}, '${sqlEsc(p.batch_number||'')}', '${sqlEsc(p.expiry_date||'')}')`);
            });
          }
          if (Array.isArray(bundle.database.customers) && bundle.database.customers.length > 0) {
            runSql(`DELETE FROM customers${delWhere}`);
            bundle.database.customers.forEach((c: any) => {
              const rowBiz = sqlEsc(c.business_id || targetBizId);
              const rowStore = sqlEsc(c.store_id || fallbackStoreId);
              runSql(`INSERT INTO customers (id, name, phone, email, loyalPoints, tpin, zra_connected, tax_band, business_id, store_id) VALUES (${c.id}, '${sqlEsc(c.name||'')}', '${sqlEsc(c.phone||'')}', '${sqlEsc(c.email||'')}', ${c.loyalPoints||0}, '${sqlEsc(c.tpin||'')}', ${c.zra_connected||0}, '${sqlEsc(c.tax_band||'')}', '${rowBiz}', '${rowStore}')`);
            });
          }
          if (Array.isArray(bundle.database.orders) && bundle.database.orders.length > 0) {
            runSql(`DELETE FROM orders${delWhere}`);
            bundle.database.orders.forEach((o: any) => {
              const rowBiz = sqlEsc(o.business_id || targetBizId);
              const rowStore = sqlEsc(o.store_id || fallbackStoreId);
              runSql(`INSERT INTO orders (id, customerId, orderDate, subtotal, tax, discount, total, paymentMethod, split_cash, split_momo, status, store_id, performed_by, business_id) VALUES ('${sqlEsc(o.id)}', ${o.customerId||'NULL'}, '${sqlEsc(o.orderDate||'')}', ${o.subtotal||0}, ${o.tax||0}, ${o.discount||0}, ${o.total||0}, '${sqlEsc(o.paymentMethod||'')}', ${o.split_cash||0}, ${o.split_momo||0}, '${sqlEsc(o.status||'')}', '${rowStore}', '${sqlEsc(o.performed_by||'owner')}', '${rowBiz}')`);
            });
          }
          if (Array.isArray(bundle.database.order_items) && bundle.database.order_items.length > 0) {
            runSql(`DELETE FROM order_items${delWhere}`);
            bundle.database.order_items.forEach((oi: any) => {
              const rowBiz = sqlEsc(oi.business_id || targetBizId);
              const rowStore = sqlEsc(oi.store_id || fallbackStoreId);
              runSql(`INSERT INTO order_items (id, orderId, productId, quantity, unitPrice, business_id, store_id) VALUES ('${sqlEsc(oi.id)}', '${sqlEsc(oi.orderId)}', ${oi.productId}, ${oi.quantity}, ${oi.unitPrice}, '${rowBiz}', '${rowStore}')`);
            });
          }
        }

        triggerNotify("✅ Portable App Data Package imported successfully! Reloading view...");
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      } catch (err: any) {
        alert("Error importing POS Package file: " + err.message);
      }
    };
    reader.readAsText(file);
  };

  const handleGenerateSqlDump = () => {
    setGeneratedSqlDump('');
    const activeBizId = getActiveBusinessId();
    const fallbackStore = activeStore || getActiveStoreId(undefined, activeBizId) || 'main';
    const bizWhere = activeBizId ? ` WHERE business_id = '${sqlEsc(activeBizId)}'` : '';
    let dump = `-- ANDROID POS SQL SCHEMA & TRANSACTION DATA DUMP\n-- Generated on: ${new Date().toLocaleString()}\n-- Business Tenant: ${activeBizId || 'ALL'}\n-- Database engine: alasql_wasm_bridge\n\n`;

    // 1. Dump Products
    dump += `-- ==========================================\n-- TABLE: products\n-- ==========================================\n`;
    dump += `CREATE TABLE products (\n  id INT PRIMARY KEY,\n  name VARCHAR(255),\n  description TEXT,\n  sku VARCHAR(50) UNIQUE,\n  category VARCHAR(100),\n  price NUMERIC(10,2),\n  cost NUMERIC(10,2),\n  stock INT,\n  imageUrl TEXT,\n  business_id VARCHAR(100),\n  store_id VARCHAR(100)\n);\n\n`;
    const prodRes = runSql(`SELECT * FROM products${bizWhere}`, 'Dump: Extract products');
    if (prodRes.success && Array.isArray(prodRes.data)) {
      prodRes.data.forEach((p: any) => {
        dump += `INSERT INTO products (id, name, description, sku, category, price, cost, stock, imageUrl, business_id, store_id) VALUES (${p.id}, '${sqlEsc(p.name||'')}', '${sqlEsc(p.description||'')}', '${sqlEsc(p.sku||'')}', '${sqlEsc(p.category||'')}', ${p.price||0}, ${p.cost||0}, ${p.stock||0}, '${sqlEsc(p.imageUrl||'')}', '${sqlEsc(p.business_id||activeBizId)}', '${sqlEsc(p.store_id||fallbackStore)}');\n`;
      });
    }

    // 2. Dump Customers
    dump += `\n-- ==========================================\n-- TABLE: customers\n-- ==========================================\n`;
    dump += `CREATE TABLE customers (\n  id INT PRIMARY KEY,\n  name VARCHAR(255),\n  phone VARCHAR(50),\n  email VARCHAR(100),\n  loyalPoints INT,\n  tpin VARCHAR(50),\n  zra_connected INT,\n  tax_band VARCHAR(100),\n  business_id VARCHAR(100),\n  store_id VARCHAR(100)\n);\n\n`;
    const custRes = runSql(`SELECT * FROM customers${bizWhere}`, 'Dump: Extract customers');
    if (custRes.success && Array.isArray(custRes.data)) {
      custRes.data.forEach((c: any) => {
        dump += `INSERT INTO customers (id, name, phone, email, loyalPoints, tpin, zra_connected, tax_band, business_id, store_id) VALUES (${c.id}, '${sqlEsc(c.name||'')}', '${sqlEsc(c.phone || '')}', '${sqlEsc(c.email || '')}', ${c.loyalPoints || 0}, '${sqlEsc(c.tpin||'')}', ${c.zra_connected || 0}, '${sqlEsc(c.tax_band||'')}', '${sqlEsc(c.business_id||activeBizId)}', '${sqlEsc(c.store_id||fallbackStore)}');\n`;
      });
    }

    // 3. Dump Orders & items
    dump += `\n-- ==========================================\n-- TABLE: orders\n-- ==========================================\n`;
    dump += `CREATE TABLE orders (\n  id VARCHAR(50) PRIMARY KEY,\n  customerId INT,\n  orderDate VARCHAR(100),\n  subtotal NUMERIC(10,2),\n  tax NUMERIC(10,2),\n  discount NUMERIC(10,2),\n  total NUMERIC(10,2),\n  paymentMethod VARCHAR(50),\n  status VARCHAR(20),\n  store_id VARCHAR(50),\n  business_id VARCHAR(100)\n);\n\n`;
    const orderRes = runSql(`SELECT * FROM orders${bizWhere}`, 'Dump: Extract historical invoices');
    if (orderRes.success && Array.isArray(orderRes.data)) {
      orderRes.data.forEach((o: any) => {
        const custVal = o.customerId === null ? 'NULL' : o.customerId;
        const storeVal = `'${sqlEsc(o.store_id || fallbackStore)}'`;
        dump += `INSERT INTO orders (id, customerId, orderDate, subtotal, tax, discount, total, paymentMethod, status, store_id, business_id) VALUES ('${sqlEsc(o.id)}', ${custVal}, '${sqlEsc(o.orderDate)}', ${o.subtotal}, ${o.tax}, ${o.discount}, ${o.total}, '${sqlEsc(o.paymentMethod)}', '${sqlEsc(o.status)}', ${storeVal}, '${sqlEsc(o.business_id||activeBizId)}');\n`;
      });
    }

    dump += `\n-- ==========================================\n-- TABLE: order_items\n-- ==========================================\n`;
    dump += `CREATE TABLE order_items (\n  id VARCHAR(50) PRIMARY KEY,\n  orderId VARCHAR(50),\n  productId INT,\n  quantity INT,\n  unitPrice NUMERIC(10,2),\n  business_id VARCHAR(100),\n  store_id VARCHAR(100)\n);\n\n`;
    const oItemRes = runSql(`SELECT * FROM order_items${bizWhere}`, 'Dump: Extract invoice details list');
    if (oItemRes.success && Array.isArray(oItemRes.data)) {
      oItemRes.data.forEach((oi: any) => {
        dump += `INSERT INTO order_items (id, orderId, productId, quantity, unitPrice, business_id, store_id) VALUES ('${sqlEsc(oi.id)}', '${sqlEsc(oi.orderId)}', ${oi.productId}, ${oi.quantity}, ${oi.unitPrice}, '${sqlEsc(oi.business_id||activeBizId)}', '${sqlEsc(oi.store_id||fallbackStore)}');\n`;
      });
    }

    // 4. Dump Double Entry Accounts schema if initialized
    dump += `\n-- ==========================================\n-- TABLE: accounts (Double-Entry)\n-- ==========================================\n`;
    dump += `CREATE TABLE accounts (\n  id VARCHAR(100) PRIMARY KEY,\n  name VARCHAR(100) NOT NULL,\n  type VARCHAR(50) NOT NULL,\n  currency CHAR(3) NOT NULL DEFAULT 'ZMW',\n  merchant_id VARCHAR(100),\n  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,\n  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP\n);\n\n`;
    const accountsRes = runSql('SELECT * FROM accounts', 'Dump: Extract double-entry accounts list');
    if (accountsRes.success && Array.isArray(accountsRes.data)) {
      accountsRes.data.forEach((acc: any) => {
        const merchVal = `'${sqlEsc(activeBizId || acc.merchant_id || 'ALL')}'`;
        dump += `INSERT INTO accounts (id, name, type, currency, merchant_id, created_at, updated_at) VALUES ('${sqlEsc(acc.id)}', '${sqlEsc(acc.name)}', '${sqlEsc(acc.type)}', '${sqlEsc(acc.currency)}', ${merchVal}, '${sqlEsc(acc.created_at)}', '${sqlEsc(acc.updated_at)}');\n`;
      });
    }

    // 5. Dump Transactions journal schema
    dump += `\n-- ==========================================\n-- TABLE: transactions (Double-Entry Journal)\n-- ==========================================\n`;
    dump += `CREATE TABLE transactions (\n  id VARCHAR(100) PRIMARY KEY,\n  idempotency_key VARCHAR(100) UNIQUE NOT NULL,\n  pos_terminal_id VARCHAR(100) NOT NULL,\n  channel VARCHAR(50) NOT NULL,\n  provider_reference VARCHAR(100),\n  amount NUMERIC(15,4) NOT NULL,\n  fee_amount NUMERIC(15,4) DEFAULT 0.0000,\n  status VARCHAR(50) DEFAULT 'PENDING',\n  narration TEXT,\n  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,\n  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,\n  business_id VARCHAR(100),\n  store_id VARCHAR(100)\n);\n\n`;
    const txsRes = runSql(`SELECT * FROM transactions${bizWhere}`, 'Dump: Extract transaction journals');
    if (txsRes.success && Array.isArray(txsRes.data)) {
      txsRes.data.forEach((tx: any) => {
        const provVal = tx.provider_reference ? `'${sqlEsc(tx.provider_reference)}'` : 'NULL';
        dump += `INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, business_id, store_id) VALUES ('${sqlEsc(tx.id)}', '${sqlEsc(tx.idempotency_key)}', '${sqlEsc(tx.pos_terminal_id)}', '${sqlEsc(tx.channel)}', ${provVal}, ${tx.amount}, ${tx.fee_amount}, '${sqlEsc(tx.status)}', '${sqlEsc(tx.narration||'')}', '${sqlEsc(tx.created_at)}', '${sqlEsc(tx.updated_at)}', '${sqlEsc(tx.business_id||activeBizId)}', '${sqlEsc(tx.store_id||fallbackStore)}');\n`;
      });
    }

    // 6. Dump Ledger Entries matching schema
    dump += `\n-- ==========================================\n-- TABLE: ledger_entries (Double-Entry Mappings)\n-- ==========================================\n`;
    dump += `CREATE TABLE ledger_entries (\n  id VARCHAR(100) PRIMARY KEY,\n  transaction_id VARCHAR(100) NOT NULL,\n  account_id VARCHAR(100) NOT NULL,\n  type VARCHAR(50) NOT NULL,\n  amount NUMERIC(15,4) NOT NULL,\n  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,\n  business_id VARCHAR(100),\n  store_id VARCHAR(100)\n);\n\n`;
    const leRes = runSql(`SELECT * FROM ledger_entries${bizWhere}`, 'Dump: Extract double-entry ledger mappings');
    if (leRes.success && Array.isArray(leRes.data)) {
      leRes.data.forEach((le: any) => {
        dump += `INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at, business_id, store_id) VALUES ('${sqlEsc(le.id)}', '${sqlEsc(le.transaction_id)}', '${sqlEsc(le.account_id)}', '${sqlEsc(le.type)}', ${le.amount}, '${sqlEsc(le.created_at)}', '${sqlEsc(le.business_id||activeBizId)}', '${sqlEsc(le.store_id||fallbackStore)}');\n`;
      });
    }

    // 7. Dump tenant-scoped balance aggregation summary
    dump += `\n-- ==========================================\n-- QUERY: Account Balances (Tenant-Scoped)\n-- ==========================================\n`;
    dump += `SELECT \n    a.id AS account_id,\n    a.name AS account_name,\n    a.currency,\n    SUM(\n        CASE \n            WHEN (a.type = 'ASSET' OR a.type = 'EXPENSE') AND le.type = 'DEBIT' THEN le.amount\n            WHEN (a.type = 'ASSET' OR a.type = 'EXPENSE') AND le.type = 'CREDIT' THEN -le.amount\n            WHEN (a.type = 'LIABILITY' OR a.type = 'REVENUE' OR a.type = 'EQUITY') AND le.type = 'CREDIT' THEN le.amount\n            WHEN (a.type = 'LIABILITY' OR a.type = 'REVENUE' OR a.type = 'EQUITY') AND le.type = 'DEBIT' THEN -le.amount\n            ELSE 0\n        END\n    ) AS current_balance\nFROM accounts a\nLEFT JOIN ledger_entries le ON a.id = le.account_id${activeBizId ? ` AND le.business_id = '${sqlEsc(activeBizId)}'` : ''}\nGROUP BY a.id, a.name, a.currency;\n`;

    setGeneratedSqlDump(dump);
    triggerNotify('Compiled fully complete raw SQL file script text backup dumper!');
  };

  const buildSqlIdWhereClause = (idVal: unknown): string => {
    if (typeof idVal === 'number') {
      return `id = ${idVal}`;
    }
    const rawStr = String(idVal ?? '').trim();
    const safeStr = rawStr.replace(/'/g, "''");
    const asNum = Number(rawStr);
    if (rawStr !== '' && !isNaN(asNum) && String(asNum) === rawStr) {
      return `(id = '${safeStr}' OR id = ${asNum})`;
    }
    return `id = '${safeStr}'`;
  };

  const getProtectedPrimaryOwnerReason = (usr: any, actionLabel: 'revoke' | 'suspend'): string | null => {
    const currentLoggedEmail = (localStorage.getItem('logged_in_user_email') || '').trim().toLowerCase();
    const usrEmailLower = String(usr.email || '').trim().toLowerCase();
    const activeBizId = getActiveBusinessId();
    const activeBizRow = businessesList.find((b: any) => String(b.id) === String(activeBizId)) || businessesList[0];
    const primaryOwnerEmail = String(activeBizRow?.email || '').trim().toLowerCase();

    if (currentLoggedEmail && usrEmailLower && currentLoggedEmail === usrEmailLower) {
      return `You cannot ${actionLabel} your own currently active session.`;
    }
    if (usr.is_owner && (String(usr.id) === String(activeBizId) || businessesList.length <= 1)) {
      return `The active Corporate Owner profile cannot be ${actionLabel === 'revoke' ? 'revoked' : 'suspended'}. Edit credentials instead.`;
    }
    if (actionLabel === 'suspend' && (usr.is_owner || usr.role === 'owner')) {
      return 'Corporate Owner accounts cannot be suspended. Downgrade role or revoke secondary owner access instead.';
    }
    if (primaryOwnerEmail && usrEmailLower === primaryOwnerEmail && usr.role === 'owner') {
      return `Primary Corporate Owner (${usr.email}) cannot be ${actionLabel === 'revoke' ? 'revoked' : 'suspended'}.`;
    }
    return null;
  };

  const handleSaveUser = (e: React.FormEvent) => {
    e.preventDefault();
    const emailLower = normalizeAuthEmail(userEmail);

    if (!emailLower || !userFirstName.trim() || !userSurname.trim() || !userPassword.trim()) {
      setUserActionFeedback({ type: 'error', text: 'Invalid Form: Please complete First Name, Surname, Email, and Password.' });
      return;
    }

    // 1. Construct the permissions_json structure with role-based + ticked Settings & Modules access
    const basicPermissions = buildUserPermissions({
      role: userRole,
      password: userPassword.trim(),
      suspended: userRole === 'owner' ? false : userSuspended,
      accessibleBranches: selectedBranches,
      allowedSettings,
      allowedModules,
    });
    const permissionsString = JSON.stringify(basicPermissions);

    // 2. Scope strictly to the currently active business (never create cross-tenant business rows)
    const activeBizId = getActiveBusinessId(activeBusiness?.id);
    const fallbackStoreId = activeStore || getActiveStoreId(undefined, activeBizId) || (storesList[0]?.id ?? 'main');
    const fullStaffName = `${userFirstName.trim()} ${userSurname.trim()}`.trim();
    const primaryStore = selectedBranches[0] || fallbackStoreId;
    const rawPass = userPassword.trim();
    const isNowSuspended = userRole !== 'owner' && userSuspended;
    const isPrimaryBizOwnerEdit = Boolean(editingUserId && String(editingUserId) === String(activeBizId));

    if (userRole === 'owner' && isPrimaryBizOwnerEdit) {
      const sql = `
        UPDATE businesses
        SET owner = '${sqlEsc(fullStaffName)}',
            email = '${sqlEsc(emailLower)}',
            password = '${sqlEsc(rawPass)}'
        WHERE id = '${sqlEsc(activeBizId)}'
      `;
      runSql(sql, `SettingsPanel: Update Corporate Owner profile`);
    } else {
      const salaryNum = parseFloat(userSalary) || 0;
      const targetStaffId = editingUserId && !isPrimaryBizOwnerEdit
        ? editingUserId
        : `staff-${Math.floor(1000 + Math.random() * 9000)}`;
      const idWhereClause = buildSqlIdWhereClause(targetStaffId);
      const staffBizAnd = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';

      const existsRes = runSql(`SELECT * FROM staff WHERE ${idWhereClause}${staffBizAnd}`);
      const alreadyExists = existsRes.success && Array.isArray(existsRes.data) && existsRes.data.length > 0;

      if (alreadyExists) {
        const sql = `
          UPDATE staff
          SET name = '${sqlEsc(fullStaffName)}',
              first_name = '${sqlEsc(userFirstName.trim())}',
              surname = '${sqlEsc(userSurname.trim())}',
              role = '${sqlEsc(userRole)}',
              pin = '${sqlEsc(rawPass.slice(0, 6))}',
              store_id = '${sqlEsc(primaryStore)}',
              contact = '${sqlEsc(userContact.trim())}',
              email = '${sqlEsc(emailLower)}',
              basic_salary = ${salaryNum},
              permissions_json = '${sqlEsc(permissionsString)}',
              password = '${sqlEsc(rawPass)}'
          WHERE ${idWhereClause}${staffBizAnd}
        `;
        runSql(sql, `SettingsPanel: Modify staff profile ${targetStaffId}`);
      } else {
        const sql = `
          INSERT INTO staff (id, name, role, hourly_rate, pin, store_id, first_name, surname, contact, email, residential_address, joining_date, nrc_file, nrc_filename, contract_file, contract_filename, basic_salary, permissions_json, business_id, password)
          VALUES (
            '${sqlEsc(String(targetStaffId))}',
            '${sqlEsc(fullStaffName)}',
            '${sqlEsc(userRole)}',
            0,
            '${sqlEsc(rawPass.slice(0, 6))}',
            '${sqlEsc(primaryStore)}',
            '${sqlEsc(userFirstName.trim())}',
            '${sqlEsc(userSurname.trim())}',
            '${sqlEsc(userContact.trim())}',
            '${sqlEsc(emailLower)}',
            '${sqlEsc(billingCity || billingAddress || '')}',
            '${new Date().toISOString().substring(0, 10)}',
            '', '', '', '',
            ${salaryNum},
            '${sqlEsc(permissionsString)}',
            '${sqlEsc(activeBizId)}',
            '${sqlEsc(rawPass)}'
          )
        `;
        runSql(sql, `SettingsPanel: Register new staff profile ${targetStaffId}`);
      }
    }

    // 3. Upsert into decoupled business_memberships + publish zero-plaintext invite to Firestore /credential_directory
    const credHash = computeCredentialHashSync(emailLower, rawPass);
    const membershipRec = upsertUserAndMembership({
      businessId: activeBizId,
      email: emailLower,
      fullName: fullStaffName,
      password: rawPass,
      credentialHash: credHash,
      role: userRole,
      storeId: primaryStore,
      accessibleBranches: userRole === 'owner' ? [] : selectedBranches,
      permissionsJson: permissionsString,
      status: isNowSuspended ? 'SUSPENDED' : 'ACTIVE',
    });

    if (auth.currentUser && activeBizId) {
      publishCredentialMembershipToCloud({
        businessId: activeBizId,
        businessName: storeName || activeBusiness?.name || activeBizId,
        membershipId: String(membershipRec?.id || deriveMembershipId(activeBizId, deriveUserId(emailLower), userRole)),
        userId: String(membershipRec?.user_id || deriveUserId(emailLower)),
        email: emailLower,
        fullName: fullStaffName,
        role: userRole,
        password: rawPass,
        credentialHash: credHash,
        storeId: primaryStore,
        accessibleBranches: userRole === 'owner' ? [] : selectedBranches,
        permissionsJson: permissionsString,
        status: isNowSuspended ? 'SUSPENDED' : 'ACTIVE',
      }).catch(() => {});
    }

    // If editing the currently logged-in user's account, apply updated role & ticked permissions immediately
    const currentLoggedEmail = normalizeAuthEmail(localStorage.getItem('logged_in_user_email') || '');
    if (currentLoggedEmail && currentLoggedEmail === emailLower) {
      localStorage.setItem('logged_in_user_role', userRole);
      localStorage.setItem('logged_in_accessible_branches', JSON.stringify(basicPermissions.accessible_branches));
      saveSessionPermissionsToStorage(basicPermissions, normalizeRole(userRole));
    }

    handleResetUserForm();
    loadUsersList();
    persistTablesToStorage();
    pushDatabaseToServer(activeBizId).catch(() => {});
    if (auth.currentUser) {
      backupToCloud(activeBizId, { silentIfNotOwner: true }).catch(() => {});
    }
    window.dispatchEvent(new Event('pos_data_updated'));
    setUserActionFeedback({
      type: isNowSuspended ? 'warning' : 'success',
      text: isNowSuspended
        ? `Saved profile for ${fullStaffName} (account status: SUSPENDED).`
        : `✓ Security credentials, role permissions & settings access saved for ${fullStaffName}.`,
    });
    triggerNotify('✓ User security credentials, role permissions & settings access saved!');
  };

  const handleResetUserForm = () => {
    setEditingUserId(null);
    setUserFirstName('');
    setUserSurname('');
    setUserEmail('');
    setUserPassword('');
    setUserRole('sales');
    setUserSalary('7500');
    setUserContact('');
    setUserSuspended(false);
    setSelectedBranches([]);
    setAllowedSettings(getDefaultSettingsForRole('sales'));
    setAllowedModules(getDefaultModulesForRole('sales'));
  };

  const handleEditUserClick = (usr: any) => {
    setConfirmRevokeUserKey(null);
    setUserActionFeedback(null);
    setEditingUserId(usr.id);
    setUserFirstName(usr.first_name);
    setUserSurname(usr.surname);
    setUserEmail(usr.email);
    setUserPassword(usr.password);
    setUserRole(usr.role);
    setUserSalary(usr.basic_salary?.toString() || '7500');
    setUserContact(usr.contact || '');
    setUserSuspended(Boolean(usr.suspended));
    setSelectedBranches(usr.accessible_branches || []);
    setAllowedSettings(
      Array.isArray(usr.allowed_settings) ? usr.allowed_settings : getDefaultSettingsForRole(usr.role)
    );
    setAllowedModules(
      Array.isArray(usr.allowed_modules) ? usr.allowed_modules : getDefaultModulesForRole(usr.role)
    );
  };

  const handleRequestRevokeUser = (usr: any, rowKey: string) => {
    const blockedReason = getProtectedPrimaryOwnerReason(usr, 'revoke');
    if (blockedReason) {
      setConfirmRevokeUserKey(null);
      setUserActionFeedback({ type: 'error', text: blockedReason });
      return;
    }
    setUserActionFeedback(null);
    setConfirmRevokeUserKey(rowKey);
  };

  const handleConfirmRevokeUser = (usr: any) => {
    const blockedReason = getProtectedPrimaryOwnerReason(usr, 'revoke');
    if (blockedReason) {
      setConfirmRevokeUserKey(null);
      setUserActionFeedback({ type: 'error', text: blockedReason });
      return;
    }

    const activeBizId = getActiveBusinessId(activeBusiness?.id);
    const staffBizAnd = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
    const safeEmail = normalizeAuthEmail(usr.email || '');
    if (usr.is_owner) {
      const safeId = sqlEsc(String(usr.id));
      runSql(`DELETE FROM businesses WHERE id = '${safeId}'`, `SettingsPanel: Revoke secondary owner account ${usr.id}`);
      if (safeEmail) {
        runSql(`DELETE FROM staff WHERE LOWER(email) = '${sqlEsc(safeEmail)}'${staffBizAnd}`, `SettingsPanel: Clean secondary owner staff link`);
      }
    } else {
      const idWhereClause = buildSqlIdWhereClause(usr.id);
      runSql(`DELETE FROM staff WHERE ${idWhereClause}${staffBizAnd}`, `SettingsPanel: Revoke staff account ${usr.id}`);
    }

    if (activeBizId && safeEmail) {
      runSql(
        `DELETE FROM business_memberships WHERE business_id = '${sqlEsc(activeBizId)}' AND LOWER(email) = '${sqlEsc(safeEmail)}'`,
        `SettingsPanel: Revoke membership record`
      );
      if (auth.currentUser) {
        revokeCredentialMembershipInCloud({
          businessId: activeBizId,
          email: safeEmail,
          password: usr.password || undefined,
        }).catch(() => {});
      }
    }

    if (editingUserId !== null && String(editingUserId) === String(usr.id)) {
      handleResetUserForm();
    }

    setConfirmRevokeUserKey(null);
    loadUsersList();
    persistTablesToStorage();
    pushDatabaseToServer(activeBizId).catch(() => {});
    if (auth.currentUser) {
      backupToCloud(activeBizId, { silentIfNotOwner: true }).catch(() => {});
    }
    window.dispatchEvent(new Event('pos_data_updated'));

    const fullName = `${usr.first_name || ''} ${usr.surname || ''}`.trim() || usr.email || 'User';
    setUserActionFeedback({
      type: 'success',
      text: `Access revoked: "${fullName}" has been permanently removed from this workspace.`,
    });
    triggerNotify(`Revoked access for ${fullName}!`);
  };

  const handleToggleSuspendUser = (usr: any) => {
    setConfirmRevokeUserKey(null);
    const blockedReason = getProtectedPrimaryOwnerReason(usr, 'suspend');
    if (blockedReason) {
      setUserActionFeedback({ type: 'error', text: blockedReason });
      return;
    }

    const nextSuspended = !Boolean(usr.suspended);
    const parsedExisting = parseStaffPermissions(usr.raw?.permissions_json, usr.role);
    const updatedPerms = buildUserPermissions({
      role: normalizeRole(usr.role || parsedExisting.role),
      password: usr.password || parsedExisting.password || '',
      accessibleBranches: Array.isArray(usr.accessible_branches) ? usr.accessible_branches : parsedExisting.accessible_branches,
      allowedSettings: Array.isArray(usr.allowed_settings) ? usr.allowed_settings : parsedExisting.allowed_settings,
      allowedModules: Array.isArray(usr.allowed_modules) ? usr.allowed_modules : parsedExisting.allowed_modules,
      suspended: nextSuspended,
      suspendedAt: nextSuspended ? new Date().toISOString() : null,
    });

    const permsJsonStr = JSON.stringify(updatedPerms);
    const permsJsonEscaped = sqlEsc(permsJsonStr);
    const idWhereClause = buildSqlIdWhereClause(usr.id);
    const activeBizId = getActiveBusinessId(activeBusiness?.id);
    const staffBizAnd = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
    const res = runSql(
      `UPDATE staff SET permissions_json = '${permsJsonEscaped}' WHERE ${idWhereClause}${staffBizAnd}`,
      `SettingsPanel: ${nextSuspended ? 'Suspend' : 'Reactivate'} staff account ${usr.id}`
    );

    if (!res.success) {
      setUserActionFeedback({ type: 'error', text: `Failed updating status: ${res.error || 'Database error'}` });
      return;
    }

    const cleanUsrEmail = normalizeAuthEmail(usr.email || '');
    const usrPass = String(usr.password || parsedExisting.password || '').trim();
    const normUsrRole = normalizeRole(usr.role || parsedExisting.role);
    const fullName = `${usr.first_name || ''} ${usr.surname || ''}`.trim() || usr.email || 'User';
    if (activeBizId && cleanUsrEmail) {
      const memRec = upsertUserAndMembership({
        businessId: activeBizId,
        email: cleanUsrEmail,
        fullName,
        password: usrPass,
        credentialHash: usrPass ? computeCredentialHashSync(cleanUsrEmail, usrPass) : '',
        role: normUsrRole,
        storeId: String(usr.raw?.store_id || usr.accessible_branches?.[0] || 'main'),
        accessibleBranches: Array.isArray(usr.accessible_branches) ? usr.accessible_branches : parsedExisting.accessible_branches,
        permissionsJson: permsJsonStr,
        status: nextSuspended ? 'SUSPENDED' : 'ACTIVE',
      });
      if (auth.currentUser && usrPass) {
        publishCredentialMembershipToCloud({
          businessId: activeBizId,
          businessName: storeName || activeBusiness?.name || activeBizId,
          membershipId: String(memRec?.id || deriveMembershipId(activeBizId, deriveUserId(cleanUsrEmail), normUsrRole)),
          userId: String(memRec?.user_id || deriveUserId(cleanUsrEmail)),
          email: cleanUsrEmail,
          fullName,
          role: normUsrRole,
          password: usrPass,
          storeId: String(usr.raw?.store_id || 'main'),
          accessibleBranches: Array.isArray(usr.accessible_branches) ? usr.accessible_branches : [],
          permissionsJson: permsJsonStr,
          status: nextSuspended ? 'SUSPENDED' : 'ACTIVE',
        }).catch(() => {});
      }
    }

    if (editingUserId !== null && String(editingUserId) === String(usr.id)) {
      setUserSuspended(nextSuspended);
    }

    loadUsersList();
    persistTablesToStorage();
    pushDatabaseToServer(activeBizId).catch(() => {});
    if (auth.currentUser) {
      backupToCloud(activeBizId, { silentIfNotOwner: true }).catch(() => {});
    }
    window.dispatchEvent(new Event('pos_data_updated'));

    setUserActionFeedback({
      type: nextSuspended ? 'warning' : 'success',
      text: nextSuspended
        ? `Account Suspended: "${fullName}" can no longer sign into POS or start shifts until reactivated.`
        : `Account Reactivated: "${fullName}" now has active terminal access.`,
    });
    triggerNotify(nextSuspended ? `Suspended ${fullName}` : `Reactivated ${fullName}`);
  };

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-slate-50 p-4 gap-4 select-text text-left">
      
      {/* Unified Sub-navigation bar for Settings & Admin Business Control */}
      <div className="bg-white border border-slate-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 shadow-xs select-none">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-indigo-600 text-white shadow-xs">
            <Settings size={18} />
          </div>
          <div>
            <h2 className="text-sm font-black text-slate-900 tracking-tight uppercase">
              Settings &amp; Admin Business Control Panel
            </h2>
            <p className="text-[10.5px] text-slate-500 font-medium">
              Unified hub for Business Setup, Billing Address, Stores/Branches, User Accounts, Quick Stock &amp; Cloud Synchronization
            </p>
          </div>
        </div>
        
        {/* Unified Navigation Tabs (Role & Tick-Based Access Control) */}
        <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200 flex-wrap gap-1">
          {canAccessSettingTab('general', currentUserRole, effectivePermissions) && (
            <button
              type="button"
              onClick={() => setActiveSubTab('general')}
              className={`px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider rounded-lg cursor-pointer transition-all ${
                activeSubTab === 'general'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
              }`}
            >
              1. Business &amp; Billing
            </button>
          )}
          {canAccessSettingTab('stores', currentUserRole, effectivePermissions) && (
            <button
              type="button"
              onClick={() => {
                setActiveSubTab('stores');
                loadStoresList();
              }}
              className={`px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider rounded-lg cursor-pointer transition-all ${
                activeSubTab === 'stores'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
              }`}
            >
              2. Stores ({storesList.length})
            </button>
          )}
          {canAccessSettingTab('users', currentUserRole, effectivePermissions) && (
            <button
              type="button"
              onClick={() => {
                setActiveSubTab('users');
                loadUsersList();
                loadStoresList();
              }}
              className={`px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider rounded-lg cursor-pointer transition-all ${
                activeSubTab === 'users'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
              }`}
            >
              3. Users &amp; Staff ({usersList.length})
            </button>
          )}
          {canAccessSettingTab('stock', currentUserRole, effectivePermissions) && (
            <button
              type="button"
              onClick={() => {
                setActiveSubTab('stock');
                loadStoresList();
              }}
              className={`px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider rounded-lg cursor-pointer transition-all ${
                activeSubTab === 'stock'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
              }`}
            >
              4. Add Stock ({productsCount})
            </button>
          )}
          {canAccessSettingTab('workspaces', currentUserRole, effectivePermissions) && (
            <button
              type="button"
              onClick={() => {
                setActiveSubTab('workspaces');
                loadUsersList();
              }}
              className={`px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider rounded-lg cursor-pointer transition-all ${
                activeSubTab === 'workspaces'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
              }`}
            >
              5. Cloud Sync &amp; Workspaces
            </button>
          )}
          {canAccessSettingTab('payments', currentUserRole, effectivePermissions) && (
            <button
              type="button"
              onClick={() => {
                setActiveSubTab('payments');
                setCustomMethods(getCustomPaymentMethods(true));
              }}
              className={`px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider rounded-lg cursor-pointer transition-all ${
                activeSubTab === 'payments'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
              }`}
            >
              6. Payment Methods ({customMethods.length})
            </button>
          )}
          {canAccessSettingTab('zra', currentUserRole, effectivePermissions) && (
            <button
              type="button"
              onClick={() => {
                setActiveSubTab('zra');
                setZraForm(getZraConfig());
                setZraQueue(FiscalService.getOfflineQueue());
              }}
              className={`px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider rounded-lg cursor-pointer transition-all flex items-center gap-1.5 ${
                activeSubTab === 'zra'
                  ? 'bg-emerald-600 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
              }`}
            >
              <span>7. ZRA Smart Invoice</span>
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${
                zraForm.enabled
                  ? (activeSubTab === 'zra' ? 'bg-white text-emerald-700' : 'bg-emerald-100 text-emerald-800')
                  : (activeSubTab === 'zra' ? 'bg-emerald-800 text-emerald-100' : 'bg-slate-200 text-slate-600')
              }`}>
                {zraForm.enabled ? 'ON' : 'OFF'}
              </span>
            </button>
          )}
        </div>
      </div>

      {permittedSubTabs.length === 0 ? (
        <div className="bg-white border border-rose-200 rounded-xl p-8 text-center shadow-xs max-w-lg mx-auto my-8">
          <Lock size={32} className="text-rose-500 mx-auto mb-3" />
          <h3 className="text-sm font-black uppercase text-slate-900">Settings Access Restricted</h3>
          <p className="text-xs text-slate-500 mt-1.5">
            Your current role ({normalizeRole(currentUserRole).toUpperCase()}) does not have permission to open any Settings modules. Ask your Administrator (Owner) to tick specific settings access for your staff account.
          </p>
        </div>
      ) : activeSubTab === 'stores' && canAccessSettingTab('stores', currentUserRole, effectivePermissions) ? (
        <div className="flex flex-col lg:flex-row gap-5">
          {/* STORES LIST */}
          <div className="flex-1 bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <Building2 className="text-indigo-600" size={16} />
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">Configured Store Outlets &amp; Branches</h3>
              </div>
              <span className="text-xs font-mono text-slate-500">{storesList.length} Branches</span>
            </div>

            {storesList.length === 0 ? (
              <div className="p-6 text-center bg-slate-50 rounded-xl border border-dashed border-slate-200 text-xs text-slate-500">
                No store branches have been created yet. Use the form on the right to create your first store branch.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {storesList.map((st: any) => {
                  const isCurrentStore = activeStore === st.id;
                  return (
                    <div
                      key={st.id}
                      className={`p-4 rounded-xl border flex flex-col justify-between gap-3 transition-all ${
                        isCurrentStore
                          ? 'border-emerald-500 bg-emerald-50/40 shadow-xs'
                          : 'border-slate-200 bg-slate-50/60'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="font-extrabold text-xs text-slate-900 uppercase">{st.name}</span>
                          <div className="flex items-center gap-1.5">
                            {isCurrentStore && (
                              <span className="px-2 py-0.5 bg-emerald-600 text-white text-[9px] font-black uppercase rounded-full">
                                Active Branch
                              </span>
                            )}
                            <span className="font-mono text-[10px] text-slate-500">ID: {st.id}</span>
                          </div>
                        </div>
                        <p className="text-[11px] text-slate-600 mt-1">
                          Location / Address: <span className="font-semibold text-slate-800">{st.location || 'Not specified'}</span>
                        </p>
                        {(st.phone || st.email) && (
                          <p className="text-[10px] text-slate-500 mt-0.5 font-mono">
                            {[st.phone ? `Tel: ${st.phone}` : '', st.email ? `Email: ${st.email}` : ''].filter(Boolean).join(' · ')}
                          </p>
                        )}
                        {editingBranchId === st.id && (
                          <div className="mt-2.5 p-2.5 bg-white border border-indigo-200 rounded-lg flex flex-col gap-2">
                            <input
                              type="text"
                              value={editBranchName}
                              onChange={(e) => setEditBranchName(e.target.value)}
                              placeholder="Branch Name"
                              className="w-full px-2 py-1 text-xs font-bold border border-slate-200 rounded"
                            />
                            <input
                              type="text"
                              value={editBranchLocation}
                              onChange={(e) => setEditBranchLocation(e.target.value)}
                              placeholder="Branch Physical Address / Location"
                              className="w-full px-2 py-1 text-xs border border-slate-200 rounded"
                            />
                            <div className="grid grid-cols-2 gap-1.5">
                              <input
                                type="tel"
                                value={editBranchPhone}
                                onChange={(e) => setEditBranchPhone(e.target.value)}
                                placeholder="Branch Phone"
                                className="w-full px-2 py-1 text-xs border border-slate-200 rounded"
                              />
                              <input
                                type="email"
                                value={editBranchEmail}
                                onChange={(e) => setEditBranchEmail(e.target.value)}
                                placeholder="Branch Email"
                                className="w-full px-2 py-1 text-xs border border-slate-200 rounded"
                              />
                            </div>
                            <div className="flex justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => setEditingBranchId(null)}
                                className="px-2 py-1 text-[10px] font-bold text-slate-600 bg-slate-100 rounded cursor-pointer"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSaveBranchEdit(st.id)}
                                className="px-2.5 py-1 text-[10px] font-bold text-white bg-indigo-600 rounded cursor-pointer"
                              >
                                Save Changes
                              </button>
                            </div>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-2 mt-2 text-[10px] text-slate-500">
                          <span>Discounts: {st.allow_discounts ? 'Allowed' : 'Disabled'}</span>
                          <span>·</span>
                          <span>Refunds: {st.allow_refunds ? 'Allowed' : 'Disabled'}</span>
                          <span>·</span>
                          <span>Laybys: {st.allow_laybys ? 'Allowed' : 'Disabled'}</span>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-slate-200/70 pt-2">
                        {!isCurrentStore && setActiveStore ? (
                          <button
                            type="button"
                            onClick={() => {
                              setActiveStore(st.id);
                              localStorage.setItem('pos_shift_active', 'true');
                              localStorage.setItem('shift_active_' + st.id, 'true');
                              triggerNotify(`Switched active terminal branch to [${st.name}]`);
                            }}
                            className="px-2.5 py-1 text-[10px] font-extrabold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded border border-indigo-200 cursor-pointer"
                          >
                            Switch to Branch
                          </button>
                        ) : (
                          <span className="text-[10px] font-bold text-emerald-700">✓ Currently Selected</span>
                        )}
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingBranchId(st.id);
                              setEditBranchName(st.name || '');
                              setEditBranchLocation(st.location || '');
                              setEditBranchPhone(st.phone || '');
                              setEditBranchEmail(st.email || '');
                            }}
                            className="px-2.5 py-1 text-[10px] font-bold text-indigo-700 hover:bg-indigo-50 rounded border border-indigo-200 cursor-pointer"
                          >
                            Edit Contact
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteBranchInSettings(st.id, st.name)}
                            className="px-2.5 py-1 text-[10px] font-bold text-red-600 hover:bg-red-50 rounded border border-red-200 cursor-pointer flex items-center gap-1"
                          >
                            <Trash2 size={11} /> Remove Store
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ADD NEW STORE FORM */}
          <form onSubmit={handleCreateBranchInSettings} className="w-full lg:w-[360px] bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-3">
            <div className="border-b border-slate-100 pb-2.5">
              <h3 className="text-xs font-black text-slate-800 uppercase tracking-wide flex items-center gap-1.5">
                <Building2 size={14} className="text-indigo-600" />
                Create Store / Branch
              </h3>
              <p className="text-[10px] text-slate-500 mt-0.5">Add a new physical store or branch location for your business.</p>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-slate-500 font-extrabold uppercase">Store / Branch Name</label>
              <input
                required
                type="text"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                placeholder="Enter store or branch name"
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-xs font-bold text-slate-800 outline-hidden"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-slate-500 font-extrabold uppercase">Branch Code (Optional)</label>
                <input
                  type="text"
                  value={newBranchCode}
                  onChange={(e) => setNewBranchCode(e.target.value)}
                  placeholder="e.g. main_store"
                  className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-xs font-mono text-slate-800 outline-hidden"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-slate-500 font-extrabold uppercase">Physical Location / Address</label>
                <input
                  type="text"
                  value={newBranchLocation}
                  onChange={(e) => setNewBranchLocation(e.target.value)}
                  placeholder="Street / City"
                  className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-xs text-slate-800 outline-hidden"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-slate-500 font-extrabold uppercase">Branch Phone</label>
                <input
                  type="tel"
                  value={newBranchPhone}
                  onChange={(e) => setNewBranchPhone(e.target.value)}
                  placeholder="+260 ..."
                  className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-xs text-slate-800 outline-hidden"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-slate-500 font-extrabold uppercase">Branch Email</label>
                <input
                  type="email"
                  value={newBranchEmail}
                  onChange={(e) => setNewBranchEmail(e.target.value)}
                  placeholder="branch@company.com"
                  className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-xs text-slate-800 outline-hidden"
                />
              </div>
            </div>

            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 flex flex-col gap-2 text-xs">
              <span className="text-[9px] font-extrabold uppercase text-slate-500">Store Authorization Rules</span>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-slate-700 text-[11px]">Allow Discounts</span>
                <input type="checkbox" checked={newBranchDiscounts} onChange={(e) => setNewBranchDiscounts(e.target.checked)} />
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-slate-700 text-[11px]">Allow Refunds &amp; Returns</span>
                <input type="checkbox" checked={newBranchRefunds} onChange={(e) => setNewBranchRefunds(e.target.checked)} />
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-slate-700 text-[11px]">Enable Layby Sales</span>
                <input type="checkbox" checked={newBranchLaybys} onChange={(e) => setNewBranchLaybys(e.target.checked)} />
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-slate-700 text-[11px]">Require Manager Key for Discounts</span>
                <input type="checkbox" checked={newBranchManagerReq} onChange={(e) => setNewBranchManagerReq(e.target.checked)} />
              </label>
            </div>

            <button
              type="submit"
              className="py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold uppercase text-xs rounded-lg cursor-pointer shadow-xs"
            >
              ✓ Save &amp; Create Store Branch
            </button>
          </form>
        </div>
      ) : activeSubTab === 'stock' && canAccessSettingTab('stock', currentUserRole, effectivePermissions) ? (
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <Package className="text-indigo-600" size={18} />
              <div>
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">
                  Quick Add Stock &amp; Batches ({productsCount} Products in Catalog)
                </h3>
                <p className="text-[10px] text-slate-500">
                  Create new products in stock with initial quantities, batch numbers, and expiry dates, or open the full Inventory Manager.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleQuickAddStockInSettings()}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-black uppercase tracking-wider cursor-pointer shadow-sm flex items-center gap-1"
              >
                <Check size={14} /> Save Changes
              </button>
              {onNavigateToInventory && (
                <button
                  type="button"
                  onClick={onNavigateToInventory}
                  className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-extrabold uppercase tracking-wider cursor-pointer shadow-xs"
                >
                  Open Full Inventory Manager →
                </button>
              )}
            </div>
          </div>

          {quickStockMsg && (
            <div className={`p-3 rounded-xl text-xs font-extrabold flex items-center justify-between ${
              quickStockMsg.startsWith('⚠️')
                ? 'bg-amber-50 border border-amber-200 text-amber-800'
                : 'bg-emerald-50 border border-emerald-200 text-emerald-800'
            }`}>
              <span>{quickStockMsg}</span>
              <button type="button" onClick={() => setQuickStockMsg(null)} className="font-black px-2 cursor-pointer">✕</button>
            </div>
          )}

          <form onSubmit={handleQuickAddStockInSettings} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Product / Stock Name *</label>
                <input
                  type="text"
                  value={quickProdName}
                  onChange={(e) => {
                    setQuickProdName(e.target.value);
                    if (quickStockMsg) setQuickStockMsg(null);
                  }}
                  placeholder="Enter product name"
                  required
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white rounded-lg text-slate-900 text-xs font-bold focus:outline-hidden"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Item Description / Full Features</label>
                <textarea
                  rows={3}
                  value={quickProdDescription}
                  onChange={(e) => setQuickProdDescription(e.target.value)}
                  placeholder="Enter full specifications, features, model details, or warranty (also displayed on Quotations & Invoices)..."
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white rounded-lg text-slate-900 text-xs font-medium focus:outline-hidden resize-y"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Barcode / SKU (Auto if blank)</label>
                <input
                  type="text"
                  value={quickProdBarcode}
                  onChange={(e) => setQuickProdBarcode(e.target.value)}
                  placeholder="Auto-generated if blank"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white rounded-lg text-slate-900 font-mono text-xs focus:outline-hidden"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Category</label>
                <input
                  type="text"
                  value={quickProdCategory}
                  onChange={(e) => setQuickProdCategory(e.target.value)}
                  placeholder="e.g. General, Groceries, Hardware"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white rounded-lg text-slate-900 text-xs font-semibold focus:outline-hidden"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Selling Price ({currency || 'K'}) *</label>
                <input
                  type="number"
                  step="0.01"
                  value={quickProdPrice}
                  onChange={(e) => setQuickProdPrice(e.target.value)}
                  placeholder="0.00"
                  required
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white rounded-lg text-slate-900 font-mono text-xs font-bold focus:outline-hidden"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Cost Price ({currency || 'K'})</label>
                <input
                  type="number"
                  step="0.01"
                  value={quickProdCost}
                  onChange={(e) => setQuickProdCost(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white rounded-lg text-slate-900 font-mono text-xs focus:outline-hidden"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Opening Stock Qty *</label>
                <input
                  type="number"
                  value={quickProdStock}
                  onChange={(e) => setQuickProdStock(e.target.value)}
                  placeholder="0"
                  required
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white rounded-lg text-slate-900 font-mono text-xs font-bold focus:outline-hidden"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Target Store Branch</label>
                <select
                  value={quickProdStoreId || activeStore}
                  onChange={(e) => setQuickProdStoreId(e.target.value)}
                  className="w-full px-2.5 py-2 bg-slate-50 border border-slate-200 focus:bg-white rounded-lg text-slate-900 text-xs font-semibold focus:outline-hidden"
                >
                  {storesList.length === 0 ? (
                    <option value="">— No Branch Created Yet (Create in Branches Tab) —</option>
                  ) : (
                    storesList.map((st: any) => (
                      <option key={st.id} value={st.id}>{st.name}</option>
                    ))
                  )}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Batch / Lot Number</label>
                <input
                  type="text"
                  value={quickProdBatchNum}
                  onChange={(e) => setQuickProdBatchNum(e.target.value)}
                  placeholder="Optional batch number"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white rounded-lg text-slate-900 font-mono text-xs focus:outline-hidden"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Batch Expiry Date</label>
                <input
                  type="date"
                  value={quickProdExpiry}
                  onChange={(e) => setQuickProdExpiry(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white rounded-lg text-slate-900 font-mono text-xs focus:outline-hidden"
                />
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-100">
              <button
                type="submit"
                className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-black uppercase rounded-lg text-xs tracking-wider cursor-pointer shadow-md flex items-center gap-1.5"
              >
                <Check size={15} /> Save Changes &amp; Add Product to Stock
              </button>
            </div>
          </form>
        </div>
      ) : activeSubTab === 'workspaces' && canAccessSettingTab('workspaces', currentUserRole, effectivePermissions) ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Verified Unlocked Workspaces & Strict Multi-Tenant Switcher */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <Building2 className="text-indigo-600" size={16} />
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">
                  Unlocked Workspaces ({unlockedWorkspaces.length || 1})
                </h3>
              </div>
              {onCreateNewWorkspace && (
                <button
                  type="button"
                  onClick={onCreateNewWorkspace}
                  className="px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-[10px] font-black uppercase tracking-wider flex items-center gap-1 cursor-pointer"
                >
                  <Plus size={12} /> New Business
                </button>
              )}
            </div>

            <div className="flex flex-col gap-2.5">
              {unlockedWorkspaces.length === 0 ? (
                businessesList
                  .filter((b: any) => String(b.id) === String(getActiveBusinessId(activeBusiness?.id)))
                  .map((b: any, idx: number) => (
                    <div
                      key={`${b.id}-${idx}`}
                      className="p-4 rounded-xl border bg-indigo-50/70 border-indigo-400 text-slate-900 flex items-center justify-between"
                    >
                      <div>
                        <div className="font-extrabold text-xs">{b.name}</div>
                        <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                          Role: {normalizeRole(currentUserRole).toUpperCase()} · {localStorage.getItem('logged_in_user_email') || b.email}
                        </div>
                      </div>
                      <span className="px-2.5 py-1 bg-emerald-600 text-white text-[9px] font-black uppercase rounded-full">
                        Active
                      </span>
                    </div>
                  ))
              ) : (
                unlockedWorkspaces.map((ws) => {
                  const isActiveBiz = ws.businessId === getActiveBusinessId(activeBusiness?.id);
                  const roleLabel = ws.role === 'owner' ? 'Owner' : ws.role === 'manager' ? 'Manager' : 'Cashier';
                  return (
                    <div
                      key={`${ws.businessId}_${ws.membershipId}`}
                      className={`p-4 rounded-xl border flex items-center justify-between gap-3 ${
                        isActiveBiz
                          ? 'bg-indigo-50/70 border-indigo-400 text-slate-900'
                          : 'bg-slate-50 border-slate-200 text-slate-700'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-extrabold text-xs truncate">{ws.businessName}</span>
                          <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${
                            ws.role === 'owner'
                              ? 'bg-indigo-100 text-indigo-800 border border-indigo-200'
                              : ws.role === 'manager'
                                ? 'bg-amber-100 text-amber-800 border border-amber-200'
                                : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                          }`}>
                            {roleLabel}
                          </span>
                        </div>
                        <div className="text-[10px] font-mono text-slate-500 mt-0.5 truncate">
                          {ws.fullName} · {ws.email}
                        </div>
                      </div>
                      {isActiveBiz ? (
                        <span className="px-2.5 py-1 bg-emerald-600 text-white text-[9px] font-black uppercase rounded-full shrink-0">
                          Active
                        </span>
                      ) : (
                        onSwitchUnlockedWorkspace && (
                          <button
                            type="button"
                            onClick={() => void onSwitchUnlockedWorkspace(ws)}
                            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-black uppercase rounded-lg cursor-pointer shrink-0 shadow-xs"
                          >
                            Switch Here
                          </button>
                        )
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {onUnlockWorkspace && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setWsUnlockFeedback(null);
                  setWsUnlockLoading(true);
                  try {
                    const res = await onUnlockWorkspace(wsUnlockEmail, wsUnlockPass);
                    if (res.success) {
                      setWsUnlockPass('');
                      setWsUnlockFeedback({ type: 'success', text: '✓ Workspace unlocked and activated!' });
                    } else {
                      setWsUnlockFeedback({ type: 'error', text: res.error || 'Could not verify credentials.' });
                    }
                  } finally {
                    setWsUnlockLoading(false);
                  }
                }}
                className="mt-2 pt-4 border-t border-slate-100 flex flex-col gap-2.5"
              >
                <div className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-slate-700">
                  <Key size={13} className="text-emerald-600" />
                  <span>Unlock &amp; Add Another Business (Email + Password)</span>
                </div>
                <p className="text-[10.5px] text-slate-500">
                  Same email can belong to multiple shops with different roles and different passwords. Enter the exact email and password for the shop you want to unlock.
                </p>
                {wsUnlockFeedback && (
                  <div className={`px-3 py-2 rounded-lg text-xs font-bold border ${
                    wsUnlockFeedback.type === 'error'
                      ? 'bg-rose-50 border-rose-200 text-rose-700'
                      : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  }`}>
                    {wsUnlockFeedback.text}
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="email"
                    value={wsUnlockEmail}
                    onChange={(e) => setWsUnlockEmail(e.target.value)}
                    placeholder="Account Email"
                    required
                    className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono focus:border-indigo-500 focus:outline-hidden"
                  />
                  <input
                    type="password"
                    value={wsUnlockPass}
                    onChange={(e) => setWsUnlockPass(e.target.value)}
                    placeholder="Shop Password"
                    required
                    className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono focus:border-indigo-500 focus:outline-hidden"
                  />
                </div>
                <button
                  type="submit"
                  disabled={wsUnlockLoading}
                  className="py-2 px-4 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-xs font-black uppercase tracking-wider rounded-lg cursor-pointer self-start"
                >
                  {wsUnlockLoading ? 'Verifying...' : 'Unlock & Switch Workspace'}
                </button>
              </form>
            )}
          </div>

          {/* Cloud Synchronization Controls */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <Database className="text-indigo-600" size={16} />
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">
                  Cloud SQL, Firestore &amp; Storage Synchronization
                </h3>
              </div>
              <span className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold px-2 py-0.5 rounded-full">
                Connected
              </span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Push or pull your complete business setup, stores, staff accounts, stock, batches, customers, and accounting ledgers across devices (strictly isolated to the active workspace).
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={handleBackupToCloud}
                disabled={isSyncing}
                className="py-3 px-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-black text-xs uppercase tracking-wider rounded-xl cursor-pointer shadow-xs"
              >
                🚀 Push Sync to Cloud
              </button>
              <button
                type="button"
                onClick={handleRestoreFromCloud}
                disabled={isSyncing}
                className="py-3 px-3 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-black text-xs uppercase tracking-wider rounded-xl cursor-pointer shadow-xs"
              >
                📥 Pull Sync from Cloud
              </button>
            </div>
            {(syncStatus || syncError) && (
              <div className={`p-3 rounded-lg text-xs font-mono ${
                syncError ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-slate-50 text-slate-700 border border-slate-200'
              }`}>
                {syncError ? `⚠️ ${syncError}` : `✓ ${syncStatus}`}
              </div>
            )}
          </div>
        </div>
      ) : activeSubTab === 'general' && canAccessSettingTab('general', currentUserRole, effectivePermissions) ? (
        <div className="flex flex-col md:flex-row gap-5">
          
          {/* LEFT COLUMN: MERCHANT PREFERENCE & BILLING ADDRESS CONFIGURATION */}
          <form onSubmit={handleSaveSettings} className="flex-1 max-w-xl bg-white rounded-xl border border-slate-200 p-5 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-150 pb-3 select-none">
              <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest flex items-center gap-1.5">
                <Settings size={15} className="text-indigo-600" />
                Business Setup &amp; Billing Address
              </h3>
              <button
                type="submit"
                className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-black text-[10.5px] uppercase tracking-wider rounded-lg cursor-pointer shadow-xs flex items-center gap-1"
              >
                <Check size={13} /> Save Changes
              </button>
            </div>

            {/* Store Name & Currency */}
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wide">Business / Company Name</label>
                <input
                  type="text"
                  value={storeName}
                  onChange={(e) => setStoreName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 focus:outline-hidden text-xs rounded-lg font-bold text-slate-850"
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wide">Currency Symbol</label>
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 focus:outline-hidden text-xs rounded-lg font-semibold text-slate-700"
                  >
                    <option value="K">ZMW (K) - Zambian Kwacha</option>
                    <option value="$">USD ($) - Dollar</option>
                    <option value="£">GBP (£) - Sterling</option>
                    <option value="€">EUR (€) - Euro</option>
                    <option value="¥">JPY/CNY (¥) - Yen</option>
                    <option value="₦">NGN (₦) - Naira</option>
                    <option value="R">ZAR (R) - Rand</option>
                  </select>
              </div>
            </div>

            {/* BILLING ADDRESS SECTION */}
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl flex flex-col gap-3">
              <span className="text-[10px] font-black uppercase tracking-wider text-indigo-800">
                Registered Billing Address & Contact Details
              </span>
              <div className="flex flex-col gap-1">
                <label className="text-[9.5px] text-slate-500 font-bold uppercase">Street / Physical Billing Address</label>
                <input
                  type="text"
                  value={billingAddress}
                  onChange={(e) => setBillingAddress(e.target.value)}
                  placeholder="Enter street address, plot number, or building"
                  className="w-full px-3 py-2 bg-white border border-slate-200 focus:border-indigo-500 focus:outline-hidden text-xs rounded-lg font-semibold text-slate-800"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-[9.5px] text-slate-500 font-bold uppercase">Billing City / Town</label>
                  <input
                    type="text"
                    value={billingCity}
                    onChange={(e) => setBillingCity(e.target.value)}
                    placeholder="City or Town"
                    className="w-full px-3 py-1.5 bg-white border border-slate-200 focus:border-indigo-500 focus:outline-hidden text-xs rounded-lg font-semibold text-slate-800"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[9.5px] text-slate-500 font-bold uppercase">Country / Postal Code</label>
                  <input
                    type="text"
                    value={billingCountry}
                    onChange={(e) => setBillingCountry(e.target.value)}
                    placeholder="Country"
                    className="w-full px-3 py-1.5 bg-white border border-slate-200 focus:border-indigo-500 focus:outline-hidden text-xs rounded-lg font-semibold text-slate-800"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-[9.5px] text-slate-500 font-bold uppercase">Billing Phone Number</label>
                  <input
                    type="text"
                    value={billingPhone}
                    onChange={(e) => setBillingPhone(e.target.value)}
                    placeholder="Business contact phone"
                    className="w-full px-3 py-1.5 bg-white border border-slate-200 focus:border-indigo-500 focus:outline-hidden text-xs rounded-lg font-mono text-slate-800"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[9.5px] text-slate-500 font-bold uppercase">Billing Email</label>
                  <input
                    type="email"
                    value={billingEmail}
                    onChange={(e) => setBillingEmail(e.target.value)}
                    placeholder="Billing / invoice email"
                    className="w-full px-3 py-1.5 bg-white border border-slate-200 focus:border-indigo-500 focus:outline-hidden text-xs rounded-lg font-mono text-slate-800"
                  />
                </div>
              </div>
            </div>

            {/* VAT Tax setting & Loyalty multiplier */}
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wide">Added Sales Tax (%)</label>
                <input
                  type="number"
                  step="0.1"
                  value={taxRate}
                  onChange={(e) => setTaxRate(parseFloat(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-505 focus:outline-hidden text-xs rounded-lg font-mono font-bold text-slate-850"
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wide">
                  Club Royalty Points per {currency || '$'}1 Spent
                </label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={loyaltyRatio}
                  onChange={(e) => setLoyaltyRatio(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-505 focus:outline-hidden text-xs rounded-lg font-mono font-bold text-slate-850"
                  required
                />
                <span className="text-[9.5px] font-mono text-indigo-600 font-semibold">
                  {(parseFloat(loyaltyRatio) || 0) > 0
                    ? `Checkout preview: ${currency || '$'}100.00 = +${calculateLoyaltyPoints(100, parseFloat(loyaltyRatio) || 0)} pts`
                    : 'Set > 0 to award loyalty points on checkout'}
                </span>
              </div>
            </div>

            {/* Simulated Thermal printer details & TPIN */}
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wide">Roll paper width</label>
                <select
                  value={paperWidth}
                  onChange={(e) => setPaperWidth(e.target.value as any)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-505 focus:outline-hidden text-xs rounded-lg font-semibold text-slate-700"
                >
                  <option value="58mm">Standard Mobile Handheld (58mm)</option>
                  <option value="80mm">Heavy Duty Desktop (80mm)</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wide">Company TPIN / Tax Reg No</label>
                <input
                  type="text"
                  value={tpin}
                  onChange={(e) => setTpin(e.target.value)}
                  placeholder="Enter Tax ID / TPIN"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-505 focus:outline-hidden text-xs rounded-lg font-mono font-bold text-slate-850"
                />
              </div>
            </div>

            {/* PAIRED BLUETOOTH & HARDWARE PRINTER CONFIG */}
            <div className="bg-slate-50 hover:bg-slate-50/80 border border-slate-200 rounded-xl p-4 flex flex-col gap-3 transition-colors select-none">
              <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-850 flex items-center gap-1.5 font-sans">
                  <Printer size={14} className="text-indigo-600" />
                  Primary Terminal Receipt Printer
                </span>
                <span className={`text-[8.5px] font-black uppercase px-2 py-0.5 rounded-full border flex items-center gap-1 ${
                  printerStatus === 'Linked' && printerName
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200/50'
                    : 'bg-rose-50 text-rose-705 border-rose-200'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${printerStatus === 'Linked' && printerName ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
                  {printerStatus === 'Linked' && printerName ? 'Linked' : 'Not Linked'}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-left">
                <div className="flex flex-col gap-1">
                  <label className="text-[8.5px] font-extrabold text-slate-400 uppercase font-sans flex items-center justify-between">
                    <span>Select Hardware Printer</span>
                    <span className="text-[8px] font-mono text-indigo-600">
                      {pairedBtDevices.length} paired BT
                    </span>
                  </label>
                  <select
                    value={printerName}
                    onChange={(e) => handleSelectHardwarePrinterDropdown(e.target.value)}
                    className="bg-white border border-slate-200 text-xs px-2.5 py-1.5 rounded-lg text-slate-805 font-bold focus:outline-indigo-505 cursor-pointer"
                  >
                    <option value="">-- Select Paired Bluetooth or Hardware Printer --</option>
                    {pairedBtDevices.length > 0 && (
                      <optgroup label={`Paired Bluetooth on Gadget (${pairedBtDevices.length})`}>
                        {pairedBtDevices.map((dev) => {
                          const optVal = formatHardwarePrinterValue(dev);
                          return (
                            <option key={dev.id} value={optVal}>
                              {dev.name} [{dev.transport.toUpperCase()}] — {dev.address.slice(0, 18)}
                            </option>
                          );
                        })}
                      </optgroup>
                    )}
                    {printerName &&
                      !pairedBtDevices.some((d) => formatHardwarePrinterValue(d) === printerName || d.name === printerName) &&
                      printerName !== 'Generic Cloud-POS Printer Spooler' &&
                      printerName !== 'System Print Dialog (OS)' && (
                        <optgroup label="Saved Hardware Printer">
                          <option value={printerName}>{printerName}</option>
                        </optgroup>
                      )}
                    <optgroup label="Fallback / System Print Modes">
                      <option value="System Print Dialog (OS)">System Print Dialog (OS / USB / Wi-Fi)</option>
                      <option value="Generic Cloud-POS Printer Spooler">Generic Cloud-POS Printer Spooler</option>
                    </optgroup>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[8.5px] font-extrabold text-slate-400 uppercase font-sans">Printer Connection Interface</label>
                  <select
                    value={printerInterface}
                    onChange={(e) => setPrinterInterface(e.target.value)}
                    className="bg-white border border-slate-200 text-xs px-2.5 py-1.5 rounded-lg text-slate-805 font-semibold focus:outline-indigo-505 cursor-pointer"
                  >
                    <option value="Bluetooth Low Energy (BLE)">Bluetooth Low Energy (BLE)</option>
                    <option value="Bluetooth Classic (SPP / RFCOMM)">Bluetooth Classic (SPP / RFCOMM)</option>
                    <option value="USB OTG Raw Terminal Direct">USB OTG Raw Terminal Direct</option>
                    <option value="TCP/IP Network Host (Port 9100)">TCP/IP Network Host (Port 9100)</option>
                    <option value="Simulated Direct In-App Spool">Simulated Direct In-App Spool</option>
                  </select>
                </div>
              </div>

              {/* Paired Bluetooth Devices List on this Gadget */}
              <div className="bg-white border border-slate-200 rounded-lg p-3 flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Bluetooth size={13} className="text-indigo-600" />
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-800">
                      Paired Bluetooth on This Gadget ({pairedBtDevices.length})
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={refreshPairedBluetoothDevices}
                      disabled={btDiscoveryLoading}
                      className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-md text-[9.5px] font-bold text-slate-700 flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-50"
                    >
                      <RefreshCw size={11} className={btDiscoveryLoading ? 'animate-spin' : ''} />
                      {btDiscoveryLoading ? 'Scanning...' : 'Refresh Paired'}
                    </button>
                    <button
                      type="button"
                      onClick={btPlatform === 'android' ? handleOpenAndroidBluetooth : handlePairOrPickGadgetBluetooth}
                      disabled={btDiscoveryLoading}
                      className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md text-[9.5px] font-bold flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-50"
                    >
                      {btPlatform === 'android' ? <ExternalLink size={11} /> : <Smartphone size={11} />}
                      {btPlatform === 'android' ? 'Gadget BT Settings' : 'Show / Pair Gadget Bluetooth'}
                    </button>
                  </div>
                </div>

                {pairedBtDevices.length > 0 ? (
                  <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto pr-0.5">
                    {pairedBtDevices.map((dev) => {
                      const optVal = formatHardwarePrinterValue(dev);
                      const isSelected =
                        selectedBtDeviceId === dev.id ||
                        printerName === optVal ||
                        printerName === dev.name;
                      return (
                        <div
                          key={dev.id}
                          onClick={() => handleSelectPairedBluetoothPrinter(dev)}
                          className={`flex items-center justify-between gap-2 p-2 rounded-lg border cursor-pointer transition-all ${
                            isSelected
                              ? 'bg-indigo-50 border-indigo-400 shadow-3xs'
                              : 'bg-slate-50/70 hover:bg-slate-100 border-slate-200'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                              dev.isLikelyPrinter
                                ? 'bg-indigo-100 text-indigo-700'
                                : 'bg-slate-200 text-slate-600'
                            }`}>
                              {dev.isLikelyPrinter ? <Printer size={13} /> : <Bluetooth size={13} />}
                            </div>
                            <div className="flex flex-col min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-[11px] font-extrabold text-slate-900 truncate">
                                  {dev.name}
                                </span>
                                <span className="text-[8px] font-mono font-bold uppercase px-1.5 py-0.5 rounded bg-slate-200/80 text-slate-700">
                                  {dev.transport.toUpperCase()}
                                </span>
                                {dev.isLikelyPrinter && (
                                  <span className="text-[8px] font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                                    Printer
                                  </span>
                                )}
                              </div>
                              <span className="text-[9px] font-mono text-slate-500 truncate">
                                {dev.deviceClassLabel || 'Bluetooth'} • ID: {dev.address}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {dev.source !== 'android_bonded' && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeSavedWebBluetoothDevice(dev.id);
                                  if (isSelected) handleSelectHardwarePrinterDropdown('');
                                  refreshPairedBluetoothDevices();
                                }}
                                title="Remove from saved list"
                                className="p-1 text-slate-400 hover:text-rose-600 rounded cursor-pointer"
                              >
                                <Trash2 size={11} />
                              </button>
                            )}
                            <span className={`px-2 py-0.5 rounded-md text-[9px] font-black uppercase ${
                              isSelected
                                ? 'bg-indigo-600 text-white'
                                : 'bg-white border border-slate-200 text-slate-700'
                            }`}>
                              {isSelected ? 'Selected' : 'Select'}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-[10px] text-slate-500 bg-slate-50 border border-dashed border-slate-200 rounded-lg p-2.5 leading-relaxed">
                    {btDiscoveryLoading
                      ? 'Scanning paired Bluetooth devices on your gadget...'
                      : btDiscoveryNotice ||
                        (!btAdapterEnabled
                          ? 'Bluetooth is currently turned off on this gadget.'
                          : 'No paired Bluetooth devices detected yet.')}
                  </div>
                )}

                {btDiscoveryNotice && pairedBtDevices.length > 0 && (
                  <p className="text-[9px] text-slate-500 leading-snug">{btDiscoveryNotice}</p>
                )}
              </div>

              <div className="flex gap-2 items-center mt-1">
                <select
                  value={printerStatus}
                  onChange={(e) => setPrinterStatus(e.target.value as any)}
                  className="bg-white border border-slate-200 text-[10px] px-2 py-1.5 rounded-lg text-slate-600 font-extrabold focus:outline-indigo-505 cursor-pointer"
                >
                  <option value="Linked">Linked / Active</option>
                  <option value="Not Linked">Not Linked / Off-line</option>
                </select>
                <button
                  type="button"
                  onClick={triggerTestPrintPlay}
                  className="flex-1 py-1.5 px-3 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 hover:border-indigo-300 text-indigo-750 text-[10px] font-black rounded-lg uppercase tracking-wider flex items-center justify-center gap-1.5 cursor-pointer shadow-3xs transition-all select-none"
                  id="btn-test-print"
                >
                  <Printer size={13} className="text-indigo-600" />
                  Do Test Print Spool
                </button>
              </div>
            </div>

            {/* Company Logo Image upload field */}
            <div className="flex flex-col gap-1 border border-slate-150 rounded-xl p-3 bg-slate-50">
              <label className="text-[10px] text-indigo-800 font-extrabold uppercase tracking-wide flex items-center gap-1.5">
                Logo image (BMP/PNG/JPEG)
              </label>
              <div className="flex items-center gap-3 mt-1">
                {logoUrl ? (
                  <div className="relative w-12 h-12 bg-white border border-slate-250 rounded-lg overflow-hidden flex items-center justify-center group">
                    <img src={logoUrl} alt="Store logo" className="max-w-full max-h-full object-contain" referrerPolicy="no-referrer" />
                    <button
                      type="button"
                      onClick={() => setLogoUrl('')}
                      className="absolute inset-0 bg-red-600/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-[8px] font-black uppercase cursor-pointer border-0"
                      title="Remove Logo"
                    >
                      Delete
                    </button>
                  </div>
                ) : (
                  <div className="w-12 h-12 bg-slate-100 border border-dashed border-slate-300 rounded-lg flex items-center justify-center text-slate-400 text-[9px] font-bold">
                    No Logo
                  </div>
                )}
                <div className="flex-1 flex flex-col gap-1">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleLogoUpload}
                    className="text-[10px] text-slate-500 file:mr-3 file:py-1 file:px-2.5 file:rounded-lg file:border-0 file:text-[10px] file:font-black file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 cursor-pointer"
                  />
                  <p className="text-[8px] text-slate-400">Max size 500KB. Best as a square logo.</p>
                </div>
              </div>
            </div>

            {/* Receipt Header Greeting & Footer greeting lines */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wide">Receipt Header Greeting Line</label>
              <input
                type="text"
                value={receiptHeader}
                onChange={(e) => setReceiptHeader(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-505 focus:outline-hidden text-xs rounded-lg font-semibold text-slate-800"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wide">Receipt Footer Closing Greeting</label>
              <input
                type="text"
                value={receiptFooter}
                onChange={(e) => setReceiptFooter(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-505 focus:outline-hidden text-xs rounded-lg font-semibold text-slate-800"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wide">Receipt Terms & Conditions</label>
              <textarea
                value={termsAndConditions}
                onChange={(e) => setTermsAndConditions(e.target.value)}
                rows={3}
                placeholder="Introduce custom shop regulations, terms of service or warranties..."
                className="w-full px-3 py-2 bg-slate-50 border border-slate-250 focus:bg-white focus:border-indigo-505 focus:outline-hidden text-xs rounded-lg font-medium text-slate-800"
              />
            </div>

            <button
              id="btn-save-merchant-pref"
              type="submit"
              className="mt-2 w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold text-xs tracking-widest uppercase rounded-lg shadow-sm transition-colors cursor-pointer select-none"
            >
              Commit preference configurations
            </button>
          </form>

          {/* RIGHT COLUMN: RE-SEED & RAW SCHEMA SQL BACKUP EXPORTER */}
          <div className="flex-1 flex flex-col gap-5">

            {/* Firebase Cloud Synchronization Card */}
            <div id="firebase-cloud-sync-card" className="bg-white rounded-xl border border-slate-200 p-5 flex flex-col gap-4">
              <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest flex items-center justify-between border-b border-slate-150 pb-3 select-none">
                <span className="flex items-center gap-1.5">
                  <Database className="text-indigo-600 animate-pulse" size={14} />
                  Firebase Cloud Backup & Sync
                </span>
                <span className="text-[10px] bg-indigo-50 text-indigo-700 font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider">
                  Dual-State Sync
                </span>
              </h3>

              {/* TLS/SSL Transport Security Guard Panel */}
              <div className="bg-emerald-50/70 border border-emerald-150 rounded-lg p-3 flex flex-col gap-2 select-none">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <ShieldCheck className="text-emerald-600 animate-pulse" size={15} />
                    <span className="text-[10px] font-black text-emerald-800 uppercase tracking-wider">TLS/SSL Transport Guard</span>
                  </div>
                  <span className="text-[9px] bg-emerald-100 text-emerald-800 font-extrabold px-2 py-0.5 rounded-full font-mono uppercase tracking-widest leading-none">
                    Active
                  </span>
                </div>
                
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-1 border-t border-emerald-100/60 pt-2 text-[9.5px]">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-slate-400 font-bold uppercase tracking-wider text-[8px]">Secure Protocol</span>
                    <span className="font-mono font-bold text-slate-700 uppercase">{getTransportSecurityStatus().protocol}</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-slate-400 font-bold uppercase tracking-wider text-[8px]">Cipher Suite</span>
                    <span className="font-mono font-bold text-slate-700 uppercase">AES-256-GCM</span>
                  </div>
                  <div className="flex flex-col gap-0.5 col-span-2">
                    <span className="text-slate-400 font-bold uppercase tracking-wider text-[8px]">Transit Encryption Standard</span>
                    <span className="font-mono font-bold text-slate-700 uppercase">{getTransportSecurityStatus().cipherSuite}</span>
                  </div>
                  <div className="flex flex-col gap-0.5 col-span-2">
                    <span className="text-slate-400 font-bold uppercase tracking-wider text-[8px]">Remote Security Authority</span>
                    <span className="font-mono font-medium text-slate-600">{getTransportSecurityStatus().cloudProvider}</span>
                  </div>
                </div>

                <p className="text-[9px] leading-relaxed text-emerald-800/85 mt-1 italic">
                  ✓ All SQL backup transactions and CRM customer profile sync logs are strictly protected via modern TLS/SSL encryption. This intercepts and eliminates the risk of packet-sniffing or man-in-the-middle hacks on public Wi-Fi & public internet routing nodes.
                </p>
              </div>

              {/* Cloud SQL + Firebase Sync Actions (Available to all accounts) */}
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <button
                    id="btn-cloud-backup"
                    type="button"
                    onClick={handleBackupToCloud}
                    disabled={isSyncing}
                    className="flex items-center justify-center gap-1.5 py-3 px-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-black text-[10px] tracking-widest uppercase rounded-lg shadow-xs transition-colors cursor-pointer"
                  >
                    🚀 Push Sync to Cloud
                  </button>
                  <button
                    id="btn-cloud-restore"
                    type="button"
                    onClick={handleRestoreFromCloud}
                    disabled={isSyncing}
                    className="flex items-center justify-center gap-1.5 py-3 px-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-black text-[10px] tracking-widest uppercase rounded-lg shadow-xs transition-colors cursor-pointer"
                  >
                    📥 Pull Sync from Cloud
                  </button>
                </div>

                {/* Status Indicator Messages */}
                {(syncStatus || syncError) && (
                  <div className={`p-3 rounded-lg text-[10.5px] leading-relaxed font-mono font-medium ${
                    syncError ? 'bg-red-50 text-red-600 border border-red-150' : 'bg-slate-50 text-slate-600 border border-slate-150'
                  }`}>
                    {syncError ? (
                      <span>⚠️ Error: {syncError}</span>
                    ) : (
                      <span>💡 Sync: {syncStatus}</span>
                    )}
                  </div>
                )}

                {!user ? (
                  <div className="flex flex-col gap-2.5 bg-slate-50 border border-slate-200 rounded-xl p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black uppercase tracking-wider text-indigo-800">
                        Firebase Email/Password Authentication
                      </span>
                      <span className="text-[8.5px] font-mono font-bold bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">
                        Firestore + Storage Backup
                      </span>
                    </div>
                    <form onSubmit={handleFirebaseEmailAuth} className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <input
                        type="email"
                        value={fbAuthEmail}
                        onChange={(e) => setFbAuthEmail(e.target.value)}
                        placeholder="Business Email"
                        required
                        className="px-2.5 py-2 bg-white border border-slate-250 rounded-lg text-xs font-mono text-slate-800 focus:outline-indigo-500"
                      />
                      <input
                        type="password"
                        value={fbAuthPassword}
                        onChange={(e) => setFbAuthPassword(e.target.value)}
                        placeholder="Password (min 6 chars)"
                        minLength={6}
                        required
                        className="px-2.5 py-2 bg-white border border-slate-250 rounded-lg text-xs font-mono text-slate-800 focus:outline-indigo-500"
                      />
                      <button
                        type="submit"
                        className="py-2 px-3 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[10px] uppercase tracking-wider rounded-lg cursor-pointer transition-colors"
                      >
                        Connect Email Auth
                      </button>
                    </form>
                    <button
                      id="btn-google-login"
                      type="button"
                      onClick={handleGoogleLogin}
                      className="flex items-center justify-center gap-2 py-2 px-4 bg-white hover:bg-slate-100 text-slate-700 border border-slate-250 font-extrabold text-[10px] tracking-wider uppercase rounded-lg transition-all cursor-pointer"
                    >
                      <LogIn size={13} /> Or Connect with Google OAuth
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 bg-slate-50 border border-slate-200 p-3 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        {user.photoURL ? (
                          <img src={user.photoURL} alt={user.displayName || 'User'} className="w-8 h-8 rounded-full border border-slate-250" referrerPolicy="no-referrer" />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-bold text-xs">
                            {(user.displayName || user.email || 'U').charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-black text-slate-800 leading-tight">
                              {user.displayName || 'Connected Business Owner'}
                            </span>
                            <span className="text-[8px] font-mono font-extrabold uppercase px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                              {user.providerData?.[0]?.providerId === 'password' ? 'Email/Password' : 'Google Auth'}
                            </span>
                          </div>
                          <span className="text-[9px] font-mono font-medium text-slate-500 leading-none">
                            {user.email} • UID: {user.uid.slice(0, 8)}...
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={handleGoogleLogout}
                        className="p-1 px-2.5 bg-red-50 hover:bg-red-100 text-red-600 rounded text-[9px] font-black uppercase transition-all tracking-wider cursor-pointer border border-red-100"
                      >
                        Disconnect
                      </button>
                    </div>
                    <div className="text-[9px] font-mono text-slate-500 border-t border-slate-200/70 pt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                      <span>✓ Firestore Relational DB: Connected</span>
                      <span>✓ Firebase Storage Backups: clients_data.json & transactions_and_ledgers.json</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Reseed DB Block */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 flex flex-col gap-4">
              <h3 className="text-xs font-black text-slate-805 uppercase tracking-widest flex items-center gap-1.5 border-b border-slate-150 pb-3 select-none">
                <RefreshCw size={14} className="text-amber-500" />
                Wipe DB & Reset / Template Layout
              </h3>

              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wide select-none">Target Database State</span>
                <div className="flex items-center gap-1.5 select-none">
                  <select
                    value={seedIndustry}
                    onChange={(e) => setSeedIndustry(e.target.value as SeedTemplate)}
                    className="flex-1 px-3 py-2 bg-slate-50 border border-slate-250 focus:bg-white text-xs rounded-lg font-bold text-slate-700 cursor-pointer"
                  >
                    <option value="blank">Blank Slate (Zero Stock, Batches & Accounts - Default)</option>
                    <option value="cafe">Demo: Cozy Coffee Shop & Café</option>
                    <option value="boutique">Demo: Minimalist Leather & Apparel Boutique</option>
                    <option value="grocer">Demo: SME Organic Wellness Grocery</option>
                    <option value="ledger">Demo: FinTech Double-Entry Ledger (ZMW)</option>
                  </select>
                  <button
                    id="btn-reseed-db-template"
                    onClick={handleResetDatabaseSelection}
                    className="px-4 py-2 bg-amber-500 hover:bg-amber-600 font-extrabold text-xs tracking-wider uppercase text-white rounded-lg cursor-pointer transition-colors"
                  >
                    Reset DB
                  </button>
                </div>
                <p className="text-[10px] leading-relaxed text-slate-400 font-medium select-text mt-1.5">
                  💡 Choose "Blank Slate" to wipe all preseeded stock, batches, and accounts so a new business starts completely fresh.
                </p>
              </div>
            </div>

            {/* Portable App Data Package (.pospack) Export & Import */}
            <div className="bg-white rounded-xl border border-indigo-200 p-5 flex flex-col gap-3.5 shadow-sm">
              <div className="flex justify-between items-center border-b border-indigo-100 pb-3 select-none">
                <h3 className="text-xs font-black text-indigo-900 uppercase tracking-widest flex items-center gap-1.5">
                  <Package size={15} className="text-indigo-600" />
                  Portable App Data Package (.pospack)
                </h3>
                <span className="text-[9.5px] bg-indigo-100 text-indigo-800 font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider">
                  Move App State
                </span>
              </div>

              <p className="text-[10.5px] text-slate-600 leading-relaxed font-medium">
                📦 Bundle and wrap all functions, store settings, inventory items, orders, quotes, staff profiles, and local database records into a single portable package. Export or import to move your entire app together to any mobile phone or device!
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                <button
                  id="btn-export-app-bundle"
                  type="button"
                  onClick={handleExportPortableAppPackage}
                  className="flex items-center justify-center gap-2 py-2.5 px-3 bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold text-[11px] tracking-wider uppercase rounded-lg shadow-xs transition-all cursor-pointer active-touch"
                >
                  <Download size={14} /> Export App Bundle (.pospack)
                </button>

                <label
                  id="label-import-app-bundle"
                  className="flex items-center justify-center gap-2 py-2.5 px-3 bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-[11px] tracking-wider uppercase rounded-lg shadow-xs transition-all cursor-pointer active-touch text-center"
                >
                  <Upload size={14} /> Import App Bundle
                  <input
                    type="file"
                    accept=".pospack,.json"
                    onChange={handleImportPortableAppPackage}
                    className="hidden"
                  />
                </label>
              </div>
            </div>

            {/* Database Exporter Script */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 flex flex-col gap-4 flex-1">
              <div className="flex justify-between items-center border-b border-slate-150 pb-3 select-none">
                <h3 className="text-xs font-black text-slate-805 uppercase tracking-widest flex items-center gap-1.5">
                  <Database size={14} className="text-indigo-400" />
                  SME Relational database script backup
                </h3>
                <button
                  id="btn-download-sql-dump"
                  onClick={handleGenerateSqlDump}
                  className="flex items-center gap-1 py-1 px-2.5 bg-slate-900 hover:bg-indigo-600 text-white rounded text-[10px] font-bold tracking-wider uppercase cursor-pointer"
                >
                  <Download size={11} /> Generate Dump
                </button>
              </div>

              <p className="text-[10px] text-slate-405 leading-normal select-text -mt-1 font-medium">
                Generate and copy a fully completed standalone ANSI-SQL script with valid statements that can boot, structure, and seed this entire SME POS layout into actual native SQLite or Postgres clients instantly!
              </p>

              <div className="flex-1 bg-slate-950 p-2.5 relative border border-slate-900 rounded-lg overflow-hidden flex flex-col max-h-[220px]">
                <span className="absolute top-1.5 right-2 font-mono text-[9.5px] font-bold text-indigo-500 tracking-widest bg-slate-900/60 py-0.5 px-2 rounded border border-slate-800 uppercase select-none">
                  EXPORT FILE: Backup.sql
                </span>
                <textarea
                  readOnly
                  value={generatedSqlDump}
                  className="flex-1 w-full h-full bg-transparent font-mono text-[9px] text-indigo-200/90 leading-normal tracking-wide focus:outline-hidden z-10 resize-none"
                  placeholder="-- Tap [Generate Dump] to generate full SQL creation and insertion script dumper..."
                />
              </div>
            </div>

          </div>

        </div>
      ) : activeSubTab === 'payments' ? (
        !canAccessSettingTab('payments', currentUserRole, effectivePermissions) ? (
          <div className="bg-white border border-rose-200 rounded-xl p-8 text-center shadow-xs max-w-lg mx-auto my-8">
            <Lock size={32} className="text-rose-500 mx-auto mb-3" />
            <h3 className="text-sm font-black uppercase text-slate-900">Administrator Access Required</h3>
            <p className="text-xs text-slate-500 mt-1">
              You do not have permission to create, enable, or remove custom payment methods.
            </p>
          </div>
        ) : (
          <div className="flex flex-col lg:flex-row gap-5">
            {/* LEFT COLUMN: Built-in Channels & Admin Form */}
            <div className="w-full lg:w-[430px] flex flex-col gap-5 shrink-0">
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <h3 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                    <CreditCard size={15} className="text-indigo-600" />
                    Built-In Payment Channels
                  </h3>
                  <span className="text-[9px] font-black uppercase px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full">
                    System Active
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Built-in Mobile Money strictly supports <strong>Airtel Money</strong> and <strong>MTN Mobile Money</strong>. Both appear in POS checkout, EOD Cash Up, and double-entry account balances.
                </p>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                    <span className="font-black text-slate-800 block">Cash Counter</span>
                    <span className="text-[9.5px] font-mono text-slate-500">acc_cash</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                    <span className="font-black text-slate-800 block">Credit Card / Bank</span>
                    <span className="text-[9.5px] font-mono text-slate-500">acc_bank</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-rose-50/70 border border-rose-200">
                    <span className="font-black text-rose-900 block">Airtel Money</span>
                    <span className="text-[9.5px] font-mono text-rose-700">acc_airtel</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-amber-50/70 border border-amber-200">
                    <span className="font-black text-amber-900 block">MTN Mobile Money</span>
                    <span className="text-[9.5px] font-mono text-amber-700">acc_mtn</span>
                  </div>
                </div>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const adminActor = activeBusiness?.owner || 'Admin';
                  const res = saveCustomPaymentMethod(newMethodName, newMethodCategory, adminActor);
                  if (!res.success) {
                    setPaymentMethodFeedback({ type: 'error', text: res.error || 'Could not create payment method.' });
                    return;
                  }
                  const updatedMethods = getCustomPaymentMethods(true);
                  setCustomMethods(updatedMethods);
                  const nextSettings: StoreSettings = {
                    ...settings,
                    customPaymentMethods: updatedMethods
                  };
                  setSettings(nextSettings);
                  localStorage.setItem('android_pos_settings', JSON.stringify(nextSettings));
                  window.dispatchEvent(new Event('pos_data_updated'));
                  const activeBizId = getActiveBusinessId();
                  if (activeBizId) {
                    pushDatabaseToServer(activeBizId).catch(() => {});
                    if (auth.currentUser) {
                      backupToCloud(activeBizId, { silentIfNotOwner: true }).catch(() => {});
                    }
                  }
                  setNewMethodName('');
                  setPaymentMethodFeedback({
                    type: 'success',
                    text: `Payment method "${res.method?.name}" created and linked to ledger account ${res.method?.accountId}.`
                  });
                  triggerNotify(`✓ Created payment method: ${res.method?.name}`);
                }}
                className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-3.5"
              >
                <div className="border-b border-slate-100 pb-2.5">
                  <h3 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                    <Plus size={15} className="text-indigo-600" />
                    Create Other Payment Method (Admin)
                  </h3>
                  <p className="text-[10.5px] text-slate-500 mt-0.5">
                    New methods immediately appear in POS Checkout, Laybys, Cash Up, Expenses, Transfers, and Double-Entry Balances.
                  </p>
                </div>

                {paymentMethodFeedback && (
                  <div className={`p-2.5 rounded-lg text-[11px] font-bold border ${
                    paymentMethodFeedback.type === 'success'
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      : 'bg-rose-50 text-rose-800 border-rose-200'
                  }`}>
                    {paymentMethodFeedback.text}
                  </div>
                )}

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-slate-500 font-extrabold uppercase tracking-wide">
                    Payment Method Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={newMethodName}
                    onChange={(e) => setNewMethodName(e.target.value)}
                    placeholder="e.g. Zoona Wallet, EFT Bank Transfer, Cheque, Store Voucher"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 focus:outline-hidden text-xs rounded-lg font-bold text-slate-800"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-slate-500 font-extrabold uppercase tracking-wide">
                    Accounting Category
                  </label>
                  <select
                    value={newMethodCategory}
                    onChange={(e) => setNewMethodCategory(e.target.value as CustomPaymentMethod['category'])}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 focus:outline-hidden text-xs rounded-lg font-bold text-slate-800 cursor-pointer"
                  >
                    <option value="Mobile Money">Mobile Money Wallet</option>
                    <option value="Bank / Card">Bank / Card Transfer</option>
                    <option value="Cash">Physical Cash / Till</option>
                    <option value="Other">Other Tender / Voucher</option>
                  </select>
                </div>

                <button
                  type="submit"
                  className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs uppercase tracking-wider rounded-lg shadow-xs cursor-pointer transition-colors flex items-center justify-center gap-1.5"
                >
                  <Plus size={14} />
                  Create Payment Method
                </button>
              </form>
            </div>

            {/* RIGHT COLUMN: Existing Custom Payment Methods Directory */}
            <div className="flex-1 bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div>
                  <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">
                    Admin-Created Custom Payment Methods ({customMethods.length})
                  </h3>
                  <p className="text-[10.5px] text-slate-500 mt-0.5">
                    Toggle availability or remove custom tender channels without affecting historical transactions.
                  </p>
                </div>
              </div>

              {customMethods.length === 0 ? (
                <div className="p-8 text-center bg-slate-50 rounded-xl border border-dashed border-slate-200 text-xs text-slate-500">
                  No custom payment methods created yet. Use the Admin form on the left to add additional payment channels.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-50 text-slate-500 font-extrabold text-[9.5px] uppercase tracking-wider border-b border-slate-200">
                        <th className="py-2.5 px-3">Method Name</th>
                        <th className="py-2.5 px-3">Category</th>
                        <th className="py-2.5 px-3">Ledger Account</th>
                        <th className="py-2.5 px-3 text-center">Status</th>
                        <th className="py-2.5 px-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {customMethods.map((pm) => (
                        <tr key={pm.id} className="hover:bg-slate-50/70 transition-colors">
                          <td className="py-3 px-3 font-extrabold text-slate-800">{pm.name}</td>
                          <td className="py-3 px-3">
                            <span className="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold">
                              {pm.category}
                            </span>
                          </td>
                          <td className="py-3 px-3 font-mono text-[11px] text-slate-500">{pm.accountId}</td>
                          <td className="py-3 px-3 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-[9.5px] font-black uppercase ${
                              pm.isActive
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-slate-200 text-slate-600'
                            }`}>
                              {pm.isActive ? 'Active' : 'Disabled'}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = toggleCustomPaymentMethod(pm.id, !pm.isActive);
                                  setCustomMethods(updated);
                                  const nextSettings = { ...settings, customPaymentMethods: updated };
                                  setSettings(nextSettings);
                                  localStorage.setItem('android_pos_settings', JSON.stringify(nextSettings));
                                  window.dispatchEvent(new Event('pos_data_updated'));
                                  const activeBizId = getActiveBusinessId();
                                  if (activeBizId) {
                                    pushDatabaseToServer(activeBizId).catch(() => {});
                                    if (auth.currentUser) backupToCloud(activeBizId, { silentIfNotOwner: true }).catch(() => {});
                                  }
                                }}
                                className="px-2 py-1 text-[10px] font-bold rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 cursor-pointer"
                              >
                                {pm.isActive ? 'Disable' : 'Enable'}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (!window.confirm(`Remove custom payment method "${pm.name}"?`)) return;
                                  const updated = deleteCustomPaymentMethod(pm.id);
                                  setCustomMethods(updated);
                                  const nextSettings = { ...settings, customPaymentMethods: updated };
                                  setSettings(nextSettings);
                                  localStorage.setItem('android_pos_settings', JSON.stringify(nextSettings));
                                  window.dispatchEvent(new Event('pos_data_updated'));
                                  const activeBizId = getActiveBusinessId();
                                  if (activeBizId) {
                                    pushDatabaseToServer(activeBizId).catch(() => {});
                                    if (auth.currentUser) backupToCloud(activeBizId, { silentIfNotOwner: true }).catch(() => {});
                                  }
                                }}
                                className="p-1.5 text-rose-600 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded cursor-pointer"
                                title="Delete Custom Payment Method"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )
      ) : activeSubTab === 'zra' ? (
        !canAccessSettingTab('zra', currentUserRole, effectivePermissions) ? (
          <div className="bg-white border border-rose-200 rounded-xl p-8 text-center shadow-xs max-w-lg mx-auto my-8">
            <Lock size={32} className="text-rose-500 mx-auto mb-3" />
            <h3 className="text-sm font-black uppercase text-slate-900">Administrator Access Required</h3>
            <p className="text-xs text-slate-500 mt-1">
              You do not have permission to configure ZRA Smart Invoice VSDC credentials and toggle fiscalization.
            </p>
          </div>
        ) : (
          <div className="flex flex-col lg:flex-row gap-5 text-left">
            {/* LEFT COLUMN: ZRA Smart Invoice (VSDC) Configuration Form */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const saved = saveZraConfig(zraForm);
                setZraForm(saved);
                const nextSettings: StoreSettings = {
                  ...settings,
                  tpin: saved.tpin || settings.tpin,
                  zraConfig: saved,
                };
                setSettings(nextSettings);
                localStorage.setItem('android_pos_settings', JSON.stringify(nextSettings));
                const activeBizId = getActiveBusinessId();
                if (activeBizId) {
                  pushDatabaseToServer(activeBizId).catch(() => {});
                  if (auth.currentUser) {
                    backupToCloud(activeBizId, { silentIfNotOwner: true }).catch(() => {});
                  }
                }
                setZraFeedback({
                  type: 'success',
                  text: saved.enabled
                    ? `ZRA Smart Invoice ENABLED (TPIN: ${saved.tpin || 'Not Set'}, Branch: ${saved.bhfId}, Endpoint: ${saved.vsdcApiUrl}).`
                    : 'ZRA Smart Invoice set to OFF. Sales will complete immediately as LOCAL_ONLY.',
                });
                triggerNotify(saved.enabled ? '✓ ZRA Smart Invoice Enabled & Saved' : '✓ ZRA Smart Invoice Saved (LOCAL_ONLY Mode)');
              }}
              className="flex-1 bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <QrCode size={18} className="text-emerald-600" />
                  <div>
                    <h3 className="text-xs font-black uppercase tracking-wider text-slate-900">
                      ZRA Smart Invoice (VSDC) Configuration
                    </h3>
                    <p className="text-[10.5px] text-slate-500">
                      Plug-and-play connection to Zambia Revenue Authority VSDC Fiscal API (`/trnsSales/saveSales`).
                    </p>
                  </div>
                </div>

                {/* Master ON / OFF Switch */}
                <button
                  type="button"
                  id="zra-master-toggle"
                  onClick={() => {
                    const toggled = saveZraConfig({ ...zraForm, enabled: !zraForm.enabled });
                    setZraForm(toggled);
                    const nextSettings: StoreSettings = { ...settings, zraConfig: toggled };
                    setSettings(nextSettings);
                    localStorage.setItem('android_pos_settings', JSON.stringify(nextSettings));
                    window.dispatchEvent(new Event('pos_data_updated'));
                    setZraFeedback({
                      type: toggled.enabled ? 'success' : 'info',
                      text: toggled.enabled
                        ? 'ZRA Smart Invoice toggled ON. Every completed sale will be submitted to VSDC.'
                        : 'ZRA Smart Invoice toggled OFF. Sales will immediately return LOCAL_ONLY without calling VSDC.',
                    });
                  }}
                  className={`px-3.5 py-2 rounded-xl font-black text-xs uppercase tracking-wider flex items-center gap-2 cursor-pointer border transition-all ${
                    zraForm.enabled
                      ? 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-700 shadow-xs'
                      : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
                  }`}
                >
                  <span className={`w-2.5 h-2.5 rounded-full ${zraForm.enabled ? 'bg-white' : 'bg-slate-400'}`} />
                  <span>{zraForm.enabled ? 'ZRA FISCAL: ON' : 'ZRA FISCAL: OFF (LOCAL_ONLY)'}</span>
                </button>
              </div>

              {zraFeedback && (
                <div className={`p-3 rounded-lg text-xs font-bold border flex items-start gap-2 ${
                  zraFeedback.type === 'success'
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                    : zraFeedback.type === 'error'
                      ? 'bg-rose-50 text-rose-800 border-rose-200'
                      : 'bg-indigo-50 text-indigo-800 border-indigo-200'
                }`}>
                  <AlertCircle size={15} className="shrink-0 mt-0.5" />
                  <span>{zraFeedback.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-slate-500 font-extrabold uppercase tracking-wide">
                    Taxpayer TPIN (10 Digits) *
                  </label>
                  <input
                    type="text"
                    maxLength={10}
                    value={zraForm.tpin}
                    onChange={(e) => setZraForm({ ...zraForm, tpin: e.target.value.replace(/\s+/g, '') })}
                    placeholder="e.g. 2000000000"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-emerald-500 focus:outline-hidden text-xs rounded-lg font-mono font-bold text-slate-900"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-slate-500 font-extrabold uppercase tracking-wide">
                    Branch ID (bhfId) *
                  </label>
                  <input
                    type="text"
                    maxLength={3}
                    value={zraForm.bhfId}
                    onChange={(e) => setZraForm({ ...zraForm, bhfId: e.target.value.trim() })}
                    placeholder="000"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-emerald-500 focus:outline-hidden text-xs rounded-lg font-mono font-bold text-slate-900"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-slate-500 font-extrabold uppercase tracking-wide">
                  VSDC API Base URL *
                </label>
                <input
                  type="url"
                  value={zraForm.vsdcApiUrl}
                  onChange={(e) => setZraForm({ ...zraForm, vsdcApiUrl: e.target.value })}
                  placeholder="http://localhost:8080/zrasandboxvsdc"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-emerald-500 focus:outline-hidden text-xs rounded-lg font-mono font-semibold text-slate-900"
                />
                <span className="text-[10px] text-slate-400">
                  Endpoints appended automatically: <code className="font-mono">/initializer/selectInitInfo</code> and <code className="font-mono">/trnsSales/saveSales</code>.
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-slate-500 font-extrabold uppercase tracking-wide">
                    Device Serial Number (dvcSrlNo)
                  </label>
                  <input
                    type="text"
                    value={zraForm.dvcSrlNo}
                    onChange={(e) => setZraForm({ ...zraForm, dvcSrlNo: e.target.value })}
                    placeholder="POS-VSDC-001"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-emerald-500 focus:outline-hidden text-xs rounded-lg font-mono font-bold text-slate-800"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-slate-500 font-extrabold uppercase tracking-wide">
                    CIS Software Code
                  </label>
                  <input
                    type="text"
                    value={zraForm.cisCode}
                    onChange={(e) => setZraForm({ ...zraForm, cisCode: e.target.value })}
                    placeholder="CIS-POS-01"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-emerald-500 focus:outline-hidden text-xs rounded-lg font-mono font-bold text-slate-800"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-slate-500 font-extrabold uppercase tracking-wide">
                    Default UNSPSC Item Class Code (itemClsCd)
                  </label>
                  <input
                    type="text"
                    value={zraForm.defaultItemClsCd}
                    onChange={(e) => setZraForm({ ...zraForm, defaultItemClsCd: e.target.value })}
                    placeholder="50102518"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-emerald-500 focus:outline-hidden text-xs rounded-lg font-mono font-bold text-slate-800"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-slate-500 font-extrabold uppercase tracking-wide">
                    Default ZRA Tax Type (taxTyCd)
                  </label>
                  <select
                    value={zraForm.defaultTaxTyCd}
                    onChange={(e) => setZraForm({ ...zraForm, defaultTaxTyCd: e.target.value as ZraTaxTypeCode })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-emerald-500 focus:outline-hidden text-xs rounded-lg font-bold text-slate-800 cursor-pointer"
                  >
                    {ZRA_TAX_TYPES.map((t) => (
                      <option key={t.code} value={t.code}>{t.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-slate-500 font-extrabold uppercase tracking-wide">
                    Default Packaging Unit (pkgUnitCd)
                  </label>
                  <select
                    value={zraForm.defaultPkgUnitCd}
                    onChange={(e) => setZraForm({ ...zraForm, defaultPkgUnitCd: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-emerald-500 focus:outline-hidden text-xs rounded-lg font-bold text-slate-800 cursor-pointer"
                  >
                    {ZRA_PACKAGING_UNITS.map((u) => (
                      <option key={u.code} value={u.code}>{u.name}</option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-slate-500 font-extrabold uppercase tracking-wide">
                    Default Quantity Unit (qtyUnitCd)
                  </label>
                  <select
                    value={zraForm.defaultQtyUnitCd}
                    onChange={(e) => setZraForm({ ...zraForm, defaultQtyUnitCd: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-emerald-500 focus:outline-hidden text-xs rounded-lg font-bold text-slate-800 cursor-pointer"
                  >
                    {ZRA_QTY_UNITS.map((u) => (
                      <option key={u.code} value={u.code}>{u.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <label className="flex items-center gap-2.5 p-3 rounded-lg bg-slate-50 border border-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={zraForm.useServerProxy}
                  onChange={(e) => setZraForm({ ...zraForm, useServerProxy: e.target.checked })}
                  className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
                />
                <div className="flex flex-col">
                  <span className="text-xs font-bold text-slate-800">Use POS Server Relay Proxy (`/api/zra/forward`)</span>
                  <span className="text-[10px] text-slate-500">Recommended when connecting HTTPS web POS to a local HTTP VSDC instance.</span>
                </div>
              </label>

              <div className="flex flex-wrap gap-3 pt-1">
                <button
                  type="submit"
                  className="flex-1 min-w-[180px] py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs uppercase tracking-wider rounded-lg shadow-xs cursor-pointer flex items-center justify-center gap-1.5"
                >
                  <Save size={14} />
                  <span>Save ZRA Configuration</span>
                </button>
                <button
                  type="button"
                  disabled={zraInitLoading}
                  onClick={async () => {
                    setZraInitLoading(true);
                    setZraFeedback(null);
                    try {
                      const res = await FiscalService.initializeDevice(zraForm);
                      setZraForm(getZraConfig());
                      setZraFeedback({
                        type: res.success ? 'success' : 'error',
                        text: res.message,
                      });
                    } finally {
                      setZraInitLoading(false);
                    }
                  }}
                  className="flex-1 min-w-[200px] py-2.5 px-4 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-black text-xs uppercase tracking-wider rounded-lg shadow-xs cursor-pointer flex items-center justify-center gap-1.5"
                >
                  <RefreshCw size={14} className={zraInitLoading ? 'animate-spin' : ''} />
                  <span>{zraInitLoading ? 'Connecting VSDC...' : 'Initialize / Test VSDC Device'}</span>
                </button>
              </div>
            </form>

            {/* RIGHT COLUMN: Registered Device Info & Offline Sync Queue */}
            <div className="w-full lg:w-[420px] flex flex-col gap-5 shrink-0">
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <h3 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                    <ShieldCheck size={15} className="text-emerald-600" />
                    Registered SDC Device Status
                  </h3>
                  <span className={`px-2 py-0.5 rounded-full text-[9.5px] font-black uppercase ${
                    zraForm.sdcId ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'
                  }`}>
                    {zraForm.sdcId ? 'Device Linked' : 'Not Initialized'}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2.5 text-xs">
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                    <span className="text-[9.5px] font-bold uppercase text-slate-400 block">SDC ID</span>
                    <span className="font-mono font-black text-slate-900">{zraForm.sdcId || '—'}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                    <span className="text-[9.5px] font-bold uppercase text-slate-400 block">MRC No</span>
                    <span className="font-mono font-black text-slate-900">{zraForm.mrcNo || '—'}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                    <span className="text-[9.5px] font-bold uppercase text-slate-400 block">Last Invoice No</span>
                    <span className="font-mono font-black text-slate-900">{zraForm.lastSaleInvcNo || 0}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                    <span className="text-[9.5px] font-bold uppercase text-slate-400 block">Fiscal Mode</span>
                    <span className={`font-mono font-black ${zraForm.enabled ? 'text-emerald-700' : 'text-slate-600'}`}>
                      {zraForm.enabled ? 'VSDC LIVE' : 'LOCAL_ONLY'}
                    </span>
                  </div>
                </div>
                {zraForm.taxprNm && (
                  <div className="text-[11px] bg-emerald-50/70 border border-emerald-200 rounded-lg p-2.5 text-emerald-900 font-semibold">
                    Taxpayer: {zraForm.taxprNm} {zraForm.bhfNm ? `(${zraForm.bhfNm})` : ''}
                  </div>
                )}
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <div className="flex items-center gap-1.5">
                    {zraQueue.length > 0 ? (
                      <WifiOff size={15} className="text-amber-600" />
                    ) : (
                      <Wifi size={15} className="text-emerald-600" />
                    )}
                    <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">
                      Offline Fiscal Sync Queue ({zraQueue.length})
                    </h3>
                  </div>
                  <button
                    type="button"
                    disabled={zraSyncLoading || zraQueue.length === 0}
                    onClick={async () => {
                      setZraSyncLoading(true);
                      try {
                        const res = await FiscalService.processOfflineQueue();
                        setZraQueue(FiscalService.getOfflineQueue());
                        setZraFeedback({
                          type: res.succeeded > 0 ? 'success' : 'error',
                          text: `Queue Sync Complete: ${res.succeeded}/${res.processed} invoices fiscalized. ${res.remaining} remaining.`,
                        });
                      } finally {
                        setZraSyncLoading(false);
                      }
                    }}
                    className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-[10px] font-black uppercase rounded-lg cursor-pointer flex items-center gap-1"
                  >
                    <RefreshCw size={11} className={zraSyncLoading ? 'animate-spin' : ''} />
                    <span>Retry Sync Now</span>
                  </button>
                </div>

                {zraQueue.length === 0 ? (
                  <div className="p-6 text-center bg-slate-50 border border-dashed border-slate-200 rounded-xl text-xs text-slate-500">
                    All fiscal invoices are synchronized. Offline failures while ZRA is ON queue here and auto-retry when back online.
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto">
                    {zraQueue.map((item) => (
                      <div key={item.id} className="p-3 rounded-lg bg-amber-50/70 border border-amber-200 flex flex-col gap-1.5 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-black text-slate-900">{item.orderId}</span>
                          <span className="text-[10px] font-bold text-amber-800">Retries: {item.retryCount}</span>
                        </div>
                        <div className="text-[10.5px] text-slate-600 flex justify-between">
                          <span>Total: {settings.currency}{Number(item.payload?.totAmt || 0).toFixed(2)}</span>
                          <span>{new Date(item.createdAt).toLocaleString()}</span>
                        </div>
                        {item.lastError && (
                          <div className="text-[10px] font-mono text-rose-700 bg-rose-50 px-2 py-1 rounded border border-rose-200 break-words">
                            {item.lastError}
                          </div>
                        )}
                        <div className="flex justify-end gap-2 pt-1">
                          <button
                            type="button"
                            onClick={async () => {
                              const r = await FiscalService.retryQueueItem(item.id);
                              setZraQueue(FiscalService.getOfflineQueue());
                              setZraFeedback({ type: r.synced ? 'success' : 'error', text: r.message });
                            }}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold rounded cursor-pointer"
                          >
                            Retry
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setZraQueue(FiscalService.removeQueueItem(item.id));
                            }}
                            className="px-2.5 py-1 bg-rose-100 hover:bg-rose-200 text-rose-800 text-[10px] font-bold rounded cursor-pointer"
                          >
                            Discard
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      ) : activeSubTab === 'users' && canAccessSettingTab('users', currentUserRole, effectivePermissions) ? (
        <div className="flex flex-col lg:flex-row gap-5">
          {/* USER DIRECTORY TABLE COLUMN */}
          <div className="flex-1 bg-white border border-slate-200 rounded-xl p-5 shadow-xs">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-4 select-none">
              <div className="flex items-center gap-2">
                <Users className="text-indigo-600 animate-pulse" size={16} />
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-840">Terminal Authorization & Account Directory</h3>
              </div>
              <span className="text-[10px] bg-indigo-50 text-indigo-700 font-extrabold px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                {usersList.length} Security Accounts
              </span>
            </div>

            {userActionFeedback && (
              <div
                className={`mb-4 px-3.5 py-2.5 rounded-xl border text-xs font-bold flex items-center justify-between gap-3 ${
                  userActionFeedback.type === 'error'
                    ? 'bg-rose-50 border-rose-200 text-rose-800'
                    : userActionFeedback.type === 'warning'
                      ? 'bg-amber-50 border-amber-200 text-amber-900'
                      : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                }`}
              >
                <div className="flex items-center gap-2">
                  <AlertCircle size={15} className="shrink-0" />
                  <span>{userActionFeedback.text}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setUserActionFeedback(null)}
                  className="text-[10px] font-black uppercase px-2 py-0.5 rounded hover:bg-black/5 cursor-pointer shrink-0"
                >
                  Dismiss
                </button>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-400 font-extrabold text-[9px] uppercase tracking-wider border-b border-slate-100 select-none">
                    <th className="py-2.5 px-3">Full Employee Card</th>
                    <th className="py-2.5 px-3">Username Key / Email</th>
                    <th className="py-2.5 px-3">Access Level &amp; Settings Rights</th>
                    <th className="py-2.5 px-3">Outlet Store Gating</th>
                    <th className="py-2.5 px-3 text-center">Account Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-800">
                  {usersList.map((usr, idx) => {
                    const rowKey = `${usr.is_owner ? 'owner' : 'staff'}-${usr.id}-${idx}`;
                    const isSuspended = Boolean(usr.suspended);
                    const isConfirmingRevoke = confirmRevokeUserKey === rowKey;
                    const avatarColor = isSuspended
                      ? 'bg-rose-100 text-rose-700 border-rose-200'
                      : usr.role === 'owner'
                        ? 'bg-purple-100 text-purple-700 border-purple-200'
                        : usr.role === 'manager'
                          ? 'bg-blue-100 text-blue-700 border-blue-200'
                          : 'bg-slate-100 text-slate-700 border-slate-200';

                    const roleLabel = usr.role === 'owner' 
                      ? '👑 OWNER (Full System Control)' 
                      : usr.role === 'manager' 
                        ? '👔 MANAGER (Supervisor approval)' 
                        : '💼 CASHIER (Sales operator)';

                    const grantedSettings: SettingsPermissionKey[] = usr.role === 'owner'
                      ? ALL_SETTINGS_KEYS
                      : (Array.isArray(usr.allowed_settings) ? usr.allowed_settings : getDefaultSettingsForRole(usr.role));

                    return (
                      <tr
                        key={rowKey}
                        className={`transition-colors ${
                          isSuspended ? 'bg-rose-50/40 hover:bg-rose-50/70' : 'hover:bg-slate-50/40'
                        }`}
                      >
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-2.5">
                            <div className={`w-8 h-8 rounded-lg border font-black text-xs flex items-center justify-center select-none ${avatarColor}`}>
                              {usr.first_name.charAt(0)}{usr.surname.charAt(0) || 'b'}
                            </div>
                            <div>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className={`font-extrabold text-xs ${isSuspended ? 'text-slate-500 line-through' : 'text-slate-800'}`}>
                                  {usr.first_name} {usr.surname}
                                </span>
                                {isSuspended ? (
                                  <span className="text-[8px] font-black uppercase px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200 tracking-wider">
                                    Suspended
                                  </span>
                                ) : (
                                  <span className="text-[8px] font-black uppercase px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 tracking-wider">
                                    Active
                                  </span>
                                )}
                              </div>
                              <div className="text-[9px] font-mono text-slate-400">{usr.contact || '+260 971 112233'}</div>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <span className="font-mono text-slate-650 font-bold select-all block text-[11px]">{usr.email}</span>
                          <span className="text-[9px] font-mono text-slate-400 mt-0.5 block select-none">
                            Default password: <span className="font-extrabold select-all text-slate-600 bg-slate-100 px-1 py-0.2 rounded font-mono">{usr.password}</span>
                          </span>
                        </td>
                        <td className="py-3 px-3">
                          <span className="text-[10px] font-black uppercase tracking-wide text-slate-800">{roleLabel}</span>
                          {usr.basic_salary > 0 && <span className="text-[9px] font-mono text-slate-450 block mt-0.5">Salary: ZMW {usr.basic_salary.toLocaleString()}</span>}
                          <div className="flex flex-wrap gap-1 mt-1.5 max-w-[230px]">
                            {usr.role === 'owner' ? (
                              <span className="text-[8.5px] px-1.5 py-0.5 font-extrabold uppercase bg-purple-50 text-purple-700 border border-purple-200 rounded">
                                All 7 Settings &amp; Modules
                              </span>
                            ) : grantedSettings.length === 0 ? (
                              <span className="text-[8.5px] px-1.5 py-0.5 font-bold uppercase bg-rose-50 text-rose-700 border border-rose-200 rounded">
                                No Settings Access
                              </span>
                            ) : (
                              grantedSettings.map((sKey) => {
                                const meta = SETTINGS_PERMISSION_OPTIONS.find((opt) => opt.key === sKey);
                                return (
                                  <span key={sKey} className="text-[8.5px] px-1.5 py-0.5 font-bold uppercase bg-indigo-50 text-indigo-700 border border-indigo-200 rounded">
                                    {meta ? meta.label.replace(/^\d+\.\s*/, '') : sKey}
                                  </span>
                                );
                              })
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          {usr.role === 'owner' ? (
                            <span className="text-[9.5px] px-1.5 py-0.5 font-extrabold uppercase tracking-wider bg-emerald-50 text-emerald-800 border border-emerald-150 rounded select-none">
                              ⭐ All branches enabled
                            </span>
                          ) : (
                            <div className="flex flex-wrap gap-1 max-w-[170px] select-none">
                              {(!usr.accessible_branches || usr.accessible_branches.length === 0) ? (
                                <span className="text-[9px] px-1.5 py-0.5 font-bold uppercase tracking-wider bg-slate-50 text-slate-500 border border-slate-150 rounded">
                                  All branches
                                </span>
                              ) : (
                                usr.accessible_branches.map((bId: string, bIdx: number) => (
                                  <span key={`${bId}-${bIdx}`} className="text-[8.5px] px-1.5 py-0.2 font-black uppercase tracking-wider bg-indigo-50 text-indigo-700 border border-indigo-150 rounded-xs">
                                    {bId.toUpperCase()}
                                  </span>
                                ))
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-3 text-center select-none">
                          {isConfirmingRevoke ? (
                            <div className="flex flex-col items-center gap-1 bg-rose-50 border border-rose-200 rounded-lg p-1.5">
                              <span className="text-[9px] font-black uppercase text-rose-800">Revoke Permanently?</span>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => handleConfirmRevokeUser(usr)}
                                  className="px-2 py-1 text-[9px] font-black uppercase bg-red-600 hover:bg-red-700 text-white rounded cursor-pointer transition-colors"
                                >
                                  Confirm
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmRevokeUserKey(null)}
                                  className="px-2 py-1 text-[9px] font-bold uppercase bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 rounded cursor-pointer transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center justify-center gap-1.5 flex-wrap">
                              <button
                                type="button"
                                onClick={() => handleEditUserClick(usr)}
                                className="p-1 px-1.5 text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded transition-colors cursor-pointer"
                                title="Edit Security Credentials & Branch Access"
                              >
                                <Edit3 size={11} className="inline mr-1" />
                                <span className="text-[9px] font-black uppercase">Edit</span>
                              </button>
                              {!usr.is_owner && usr.role !== 'owner' && (
                                <button
                                  type="button"
                                  onClick={() => handleToggleSuspendUser(usr)}
                                  className={`p-1 px-1.5 border rounded transition-colors cursor-pointer ${
                                    isSuspended
                                      ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border-emerald-200'
                                      : 'text-amber-700 bg-amber-50 hover:bg-amber-100 border-amber-200'
                                  }`}
                                  title={isSuspended ? 'Reactivate Suspended Account' : 'Suspend Terminal Access'}
                                >
                                  {isSuspended ? (
                                    <UserCheck size={11} className="inline mr-1" />
                                  ) : (
                                    <Ban size={11} className="inline mr-1" />
                                  )}
                                  <span className="text-[9px] font-black uppercase">
                                    {isSuspended ? 'Activate' : 'Suspend'}
                                  </span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleRequestRevokeUser(usr, rowKey)}
                                className="p-1 px-1.5 text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 rounded transition-colors cursor-pointer"
                                title="Revoke Control Credentials"
                              >
                                <Trash2 size={11} className="inline mr-1" />
                                <span className="text-[9px] font-black uppercase">Revoke</span>
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-4 p-3.5 bg-slate-50 border border-slate-200 rounded-xl leading-relaxed text-[10.5px] text-slate-500 font-sans select-none text-left">
              <strong className="text-slate-700 block mb-0.5">🔐 USER SECURITY ACCOUNTS:</strong>
              <span>Manage system access roles, suspend/reactivate accounts, or permanently revoke staff credentials below.</span>
            </div>
          </div>

          {/* ADD / EDIT SECURITY ACCESS FORM COLUMN */}
          <form onSubmit={handleSaveUser} className="w-full lg:w-[360px] bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-3 select-none text-left">
            <div className="border-b border-slate-100 pb-2.5 mb-1 select-none">
              <div className="flex items-center gap-1.5">
                <UserPlus size={14} className="text-indigo-600 animate-pulse" />
                <h3 className="text-xs font-black text-slate-800 uppercase tracking-wide">
                  {editingUserId ? 'Edit Account Authority' : 'Onboard Security Account'}
                </h3>
              </div>
              <p className="text-[9.5px] text-slate-450 mt-1 leading-normal">
                {editingUserId ? 'Modify selected user credentials or outlet gating' : 'Create new security profiles on this SME ledger loop.'}
              </p>
            </div>

            {/* Name */}
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-slate-400 font-extrabold uppercase">First Name</label>
                <input
                  required
                  type="text"
                  value={userFirstName}
                  onChange={(e) => setUserFirstName(e.target.value)}
                  placeholder="e.g. Lombe"
                  className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 focus:outline-hidden text-xs rounded-lg font-bold text-slate-800"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-slate-400 font-extrabold uppercase">Surname</label>
                <input
                  required
                  type="text"
                  value={userSurname}
                  onChange={(e) => setUserSurname(e.target.value)}
                  placeholder="e.g. Kapambwe"
                  className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 focus:outline-hidden text-xs rounded-lg font-bold text-slate-800"
                />
              </div>
            </div>

            {/* Email Address */}
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-slate-400 font-extrabold uppercase">Email / Username address</label>
              <input
                required
                type="email"
                value={userEmail}
                disabled={Boolean(editingUserId && String(editingUserId) === String(getActiveBusinessId()))}
                onChange={(e) => setUserEmail(e.target.value)}
                placeholder="e.g. lkapambwe@pos.zm"
                className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-505 focus:outline-hidden text-xs rounded-lg font-semibold text-slate-800 disabled:opacity-50"
              />
            </div>

            {/* Security password */}
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-slate-450 font-black uppercase tracking-wide flex items-center gap-1 text-rose-500">
                <Key size={10} />
                <span>Security Access Password</span>
              </label>
              <input
                required
                type="text"
                value={userPassword}
                onChange={(e) => setUserPassword(e.target.value)}
                placeholder="Declare login password, e.g. secure123"
                className="w-full px-2.5 py-1.5 bg-rose-50/10 border border-rose-100 focus:bg-white focus:border-rose-500 focus:outline-hidden font-mono font-bold text-xs rounded-lg text-slate-850"
              />
            </div>

            {/* Phone contact */}
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-slate-400 font-extrabold uppercase">Contact Number</label>
              <input
                type="text"
                value={userContact}
                onChange={(e) => setUserContact(e.target.value)}
                placeholder="e.g. +260 971 123456"
                className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-505 focus:outline-hidden text-xs rounded-lg font-bold text-slate-800"
              />
            </div>

            {/* Access Role */}
            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-slate-400 font-extrabold uppercase">Access Role Status Level</label>
              <select
                value={userRole}
                onChange={(e) => {
                  const roleVal = e.target.value as 'sales' | 'manager' | 'owner';
                  setUserRole(roleVal);
                  setAllowedSettings(getDefaultSettingsForRole(roleVal));
                  setAllowedModules(getDefaultModulesForRole(roleVal));
                  if (roleVal === 'owner') {
                    setSelectedBranches([]); // Implicit all branches
                  }
                }}
                disabled={Boolean(editingUserId && String(editingUserId) === String(getActiveBusinessId()))}
                className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 focus:bg-white focus:outline-hidden text-xs font-bold rounded-lg text-slate-700 cursor-pointer disabled:opacity-50"
              >
                <option value="sales">💼 Cashier (Sales terminal only)</option>
                <option value="manager">👔 Manager (Discounts & returns approvals)</option>
                <option value="owner">👑 Owner (General Corporate Admin)</option>
              </select>
            </div>

            {/* Basic salary */}
            {userRole !== 'owner' && (
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-slate-400 font-extrabold uppercase">Basic Monthly Salary (ZMW)</label>
                <input
                  type="number"
                  step="0.01"
                  value={userSalary}
                  onChange={(e) => setUserSalary(e.target.value)}
                  placeholder="e.g. 7500.00"
                  className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-505 focus:outline-hidden text-xs rounded-lg font-mono font-bold text-slate-808"
                />
              </div>
            )}

            {/* Account Status (Active vs Suspended) */}
            {userRole !== 'owner' && (
              <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-slate-50">
                <div className="flex flex-col">
                  <span className="text-[9.5px] font-black uppercase text-slate-700">Account Access Status</span>
                  <span className="text-[8.5px] text-slate-400">
                    {userSuspended ? 'Suspended — login & shifts blocked' : 'Active — authorized to sign in'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setUserSuspended((prev) => !prev)}
                  className={`px-2.5 py-1 rounded-md text-[9px] font-black uppercase border cursor-pointer transition-colors ${
                    userSuspended
                      ? 'bg-rose-100 text-rose-700 border-rose-300 hover:bg-rose-200'
                      : 'bg-emerald-100 text-emerald-700 border-emerald-300 hover:bg-emerald-200'
                  }`}
                >
                  {userSuspended ? 'Suspended' : 'Active'}
                </button>
              </div>
            )}

            {/* Tickable Settings Access Permissions */}
            {userRole !== 'owner' && (
              <div className="flex flex-col gap-1.5 border-t border-slate-100 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[9.5px] text-indigo-700 font-black uppercase flex items-center gap-1 select-none">
                    <Sliders size={11} className="text-indigo-600" />
                    <span>Settings Access Permissions</span>
                  </label>
                  <div className="flex items-center gap-1 text-[8.5px] font-extrabold uppercase">
                    <button
                      type="button"
                      onClick={() => setAllowedSettings([...ALL_SETTINGS_KEYS])}
                      className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 cursor-pointer"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => setAllowedSettings([])}
                      className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 hover:bg-slate-200 cursor-pointer"
                    >
                      None
                    </button>
                    <button
                      type="button"
                      onClick={() => setAllowedSettings(getDefaultSettingsForRole(userRole))}
                      className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 cursor-pointer"
                    >
                      Role Default
                    </button>
                  </div>
                </div>
                <p className="text-[8.5px] text-slate-400 leading-tight">
                  Tick which Settings sections this staff member can open and configure.
                </p>
                <div className="flex flex-col gap-1.5 bg-slate-50 border border-slate-200 p-2.5 rounded-lg">
                  {SETTINGS_PERMISSION_OPTIONS.map((opt) => {
                    const isChecked = allowedSettings.includes(opt.key);
                    return (
                      <label key={opt.key} className="flex items-start gap-2 text-[10.5px] text-slate-700 cursor-pointer py-0.5">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setAllowedSettings((prev) => (prev.includes(opt.key) ? prev : [...prev, opt.key]));
                            } else {
                              setAllowedSettings((prev) => prev.filter((k) => k !== opt.key));
                            }
                          }}
                          className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer h-3.5 w-3.5 shrink-0"
                        />
                        <div className="flex flex-col leading-tight">
                          <span className="font-extrabold text-slate-800 text-[10px]">{opt.label}</span>
                          <span className="text-[8.5px] text-slate-400">{opt.description}</span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Tickable Role-Based App Modules Access */}
            {userRole !== 'owner' && (
              <div className="flex flex-col gap-1.5 border-t border-slate-100 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[9.5px] text-emerald-700 font-black uppercase flex items-center gap-1 select-none">
                    <ShieldCheck size={11} className="text-emerald-600" />
                    <span>App Modules Access ({allowedModules.length}/{MODULE_PERMISSION_OPTIONS.length})</span>
                  </label>
                  <div className="flex items-center gap-1 text-[8.5px] font-extrabold uppercase">
                    <button
                      type="button"
                      onClick={() => setAllowedModules([...ALL_MODULE_KEYS])}
                      className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 cursor-pointer"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => setAllowedModules(getDefaultModulesForRole(userRole))}
                      className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 hover:bg-slate-200 cursor-pointer"
                    >
                      Role Default
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1.5 bg-slate-50 border border-slate-200 p-2.5 rounded-lg">
                  {MODULE_PERMISSION_OPTIONS.map((mod) => {
                    const isChecked = allowedModules.includes(mod.key);
                    return (
                      <label key={mod.key} className="flex items-center gap-1.5 text-[10px] text-slate-700 font-bold cursor-pointer py-0.5">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setAllowedModules((prev) => (prev.includes(mod.key) ? prev : [...prev, mod.key]));
                            } else {
                              setAllowedModules((prev) => prev.filter((k) => k !== mod.key));
                            }
                          }}
                          className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer h-3.5 w-3.5 shrink-0"
                        />
                        <span className="truncate">{mod.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Accessible branches checkboxes */}
            {userRole !== 'owner' && (
              <div className="flex flex-col gap-1.5 border-t border-slate-100 pt-3">
                <label className="text-[9.5px] text-indigo-705 font-black uppercase flex items-center gap-1 select-none">
                  <Building2 size={11} className="text-indigo-600 animate-pulse" />
                  <span>Authorized Outlets Access Gating</span>
                </label>
                <p className="text-[8px] text-slate-400 mb-1 leading-tight">Restrict login to chosen stores. If no branches are checked, they can sign into all outlets by default.</p>
                <div className="flex flex-col gap-1.5 bg-slate-50 border border-slate-150 p-2.5 rounded-lg">
                  {storesList.map(st => {
                    const isChecked = selectedBranches.includes(st.id);
                    return (
                      <label key={st.id} className="flex items-center gap-2 text-[10.5px] text-slate-700 font-semibold cursor-pointer py-0.5">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedBranches([...selectedBranches, st.id]);
                            } else {
                              setSelectedBranches(selectedBranches.filter(bId => bId !== st.id));
                            }
                          }}
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer h-3.5 w-3.5"
                        />
                        <span className="uppercase tracking-wide font-mono text-[10px] text-slate-800">{st.name} <span className="text-[8px] text-slate-400">({st.id.toUpperCase()})</span></span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5 mt-2.5 select-none">
              <button
                type="submit"
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 active:scale-98 text-white font-extrabold text-[10px] uppercase tracking-widest rounded-lg shadow-xs cursor-pointer transition-all flex items-center justify-center gap-1.5"
              >
                <span>{editingUserId ? '✓ Commit Credentials Edit' : '🚀 Save User Authority'}</span>
              </button>
              {editingUserId && (
                <button
                  type="button"
                  onClick={handleResetUserForm}
                  className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-650 font-extrabold text-[9px] uppercase rounded-lg border border-slate-200 cursor-pointer transition-all"
                >
                  Cancel Edit
                </button>
              )}
            </div>
          </form>
        </div>
      ) : (
        <div className="bg-white border border-rose-200 rounded-xl p-8 text-center shadow-xs max-w-lg mx-auto my-8">
          <Lock size={32} className="text-rose-500 mx-auto mb-3" />
          <h3 className="text-sm font-black uppercase text-slate-900">Settings Section Restricted</h3>
          <p className="text-xs text-slate-500 mt-1">
            You do not have permission to view this Settings section. Choose one of your permitted tabs above or contact your Administrator.
          </p>
        </div>
      )}

      {/* Floating Status Notification Toast */}
      {notification && (
        <div className="fixed bottom-14 right-4 bg-emerald-700 text-white font-bold p-3.5 rounded-xl shadow-2xl border border-emerald-600 flex items-center gap-2 z-50 animate-bounce select-none flex-row">
          <ShieldCheck size={16} fill="white" className="text-emerald-700" />
          <span className="text-xs tracking-wider uppercase">{notification}</span>
        </div>
      )}

      {/* TEST PRINT SIMULATOR DRAWER */}
      {testPrintActive && testPrintContent && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-slate-900/65 backdrop-blur-xs p-4 select-none animate-fadeIn">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl w-full max-w-sm overflow-hidden shadow-2xl flex flex-col scale-in relative font-sans">
            
            {/* Top diagnostic panel bar */}
            <div className="p-4 bg-slate-850 border-b border-slate-700 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Printer size={16} className="text-emerald-500 animate-bounce" />
                <div>
                  <h4 className="text-xs font-black uppercase text-slate-100 tracking-wider">Printer Service Spool</h4>
                  <p className="text-[9px] font-mono text-slate-400">{printerName.split(' ')[0]} - {printerInterface}</p>
                </div>
              </div>
              <span className="text-[8px] font-extrabold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-md uppercase tracking-widest leading-none">
                TEST SUCCESS
              </span>
            </div>

            {/* Simulated scroll receipt outlet paper holder */}
            <div className="bg-slate-950 p-2 border-b border-slate-800 flex items-center justify-center relative">
              <div className="absolute left-4 right-4 h-0.5 bg-slate-850 shadow-inner rounded-full"></div>
              <span className="text-[7.5px] font-mono text-slate-505 uppercase tracking-widest z-10 bg-slate-950 px-3 select-none">
                ROLL PAPER TAPE FEED OUTLET
              </span>
            </div>

            {/* The white thermal paper itself with classic serrated tear style at bottom */}
            <div className="flex-1 bg-white p-5 overflow-y-auto max-h-[350px] flex flex-col items-center">
              <div className="w-full text-center text-slate-800 font-mono text-[10px] leading-relaxed whitespace-pre-wrap select-text selection:bg-indigo-100 tracking-tight leading-loose">
                {testPrintContent.plain}
              </div>
            </div>

            {/* Tear serrated effect line */}
            <div className="h-2 bg-radial bg-repeat-x bg-[length:8px_8px] relative" style={{
              backgroundImage: `linear-gradient(135deg, #ffffff 25%, transparent 25%), linear-gradient(225deg, #ffffff 25%, transparent 25%)`,
              backgroundColor: '#0f172a',
              marginTop: '-1px'
            }}></div>

            {/* Diagnostic Hex stream dump */}
            <div className="p-4 bg-slate-900 flex flex-col gap-2">
              <span className="text-[8.5px] text-slate-405 font-extrabold uppercase">ESC/POS Spooled Hex Binary Streams</span>
              <div className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 font-mono text-[9px] text-indigo-400 break-all leading-normal max-h-16 overflow-y-auto select-all">
                {testPrintContent.hex}
              </div>
              <p className="text-[8.5px] text-slate-400 italic leading-snug">
                {testPrintContent.hardwareNote ||
                  'This hexadecimal payload is automatically formed using standard ESC/POS codes and routed to your selected printer interface.'}
              </p>
            </div>

            {/* Action buttons */}
            <div className="p-3 bg-slate-850 border-t border-slate-700 flex gap-2">
              <button
                type="button"
                onClick={() => setTestPrintActive(false)}
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-505 text-white font-black text-[10px] tracking-wider uppercase rounded-xl cursor-pointer shadow-3xs transition-all text-center"
              >
                DISMISS FEED COUPLING
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
