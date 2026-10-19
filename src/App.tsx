import React, { useState, useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { 
  ShoppingCart, Package, TrendingUp, Terminal, Sliders, 
  Layers, Clock, Coins, FileText, Users, Briefcase, Plus, 
  Key, ShieldCheck, Check, Lock, Building, Building2, UserCheck, User,
  RefreshCw, Percent, ChevronRight, Sparkles, CheckSquare,
  Menu, X, Phone, Receipt, ShoppingBag, Share2, RotateCcw,
  LayoutDashboard, FileSpreadsheet, MessageSquare, Send, HelpCircle, Truck,
  Cloud, CloudUpload, CloudDownload, LogOut, UserPlus, MapPin
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Database & Firebase Cloud API
import { initializeDatabase, SeedTemplate, runSql, upsertCustomerSync, logEmployeeAudit, persistTablesToStorage, pushDatabaseToServer, pullDatabaseFromServer } from './db';
import { auth, registerOrSignInWithEmailPassword, signInWithEmailPasswordAccount, backupToCloud, restoreFromCloud } from './firebase';
import { StoreSettings, ActiveTab } from './types';

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
  printerStatus: 'Disconnected',
};

export default function App() {
  const [activeTab, setActiveTab2] = useState<ActiveTab>('billing');
  const [showSqlSplit, setShowSqlSplit] = useState(false); // Split-Window split-screen SQL Monitor disabled
  const [settings, setSettings] = useState<StoreSettings>(DEFAULT_SETTINGS);
  const [sqlSeedTrigger, setSqlSeedTrigger] = useState(0);
  const [billingCounterAction, setBillingCounterAction] = useState<'camera' | 'cashup' | 'refunds' | 'history' | null>(null);

  // SME global states: Permission levels & Branch store locations
  const [userRole, setUserRole] = useState<string>('owner'); // 'owner' | 'manager' | 'sales'
  const [activeStore, setActiveStore] = useState<string>('');

  // Navigation Drawer state (3-lines hamburger)
  const [showNavDrawer, setShowNavDrawer] = useState(false);

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
  const [settingsInitialSubTab, setSettingsInitialSubTab] = useState<'general' | 'stores' | 'users' | 'stock' | 'payments' | 'printer' | 'database'>('general');
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

  const openUnifiedSettings = (subTab: 'general' | 'stores' | 'users' | 'stock' | 'payments' | 'printer' | 'database' = 'general') => {
    loadBusinessData();
    setSettingsInitialSubTab(subTab);
    setShowNavDrawer(false);
    setActiveTab2('settings');
  };

  // Drawer Modals & Counts (Blank on default)
  const [badgeCounts, setBadgeCounts] = useState({ products: 0, customers: 0, staff: 0 });
  
  // Expense Modal state
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseCategory, setExpenseCategory] = useState('Store Operations');
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
      const cRes = runSql('SELECT * FROM customers ORDER BY name ASC', 'CRM: Query central customers database');
      if (cRes.success && Array.isArray(cRes.data)) {
        setCustomersList(cRes.data);
      }
      updateBadgeCounts();
    } catch (err) {
      console.warn('Failed querying customers list', err);
    }
  };

  // Update badge counts from DB (scoped to activeStore when selected, strictly 0 when empty)
  const updateBadgeCounts = () => {
    try {
      const pRes = activeStore
        ? runSql(`SELECT COUNT(*) as cnt FROM store_products WHERE store_id = '${activeStore}' AND stock > 0`, 'Query branch product count')
        : runSql(`SELECT COUNT(*) as cnt FROM products`, 'Query product count');
      const prodCnt = (pRes.success && pRes.data?.[0]?.cnt !== undefined) ? pRes.data[0].cnt : 0;

      const cRes = runSql(`SELECT COUNT(*) as cnt FROM customers`, 'Query customer count');
      const custCnt = (cRes.success && cRes.data?.[0]?.cnt !== undefined) ? cRes.data[0].cnt : 0;

      const sRes = activeStore
        ? runSql(`SELECT COUNT(*) as cnt FROM staff WHERE store_id = '${activeStore}' OR store_id = '' OR store_id IS NULL`, 'Query branch staff count')
        : runSql(`SELECT COUNT(*) as cnt FROM staff`, 'Query staff count');
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

    // 2. Recover merchant preference details
    const localConf = localStorage.getItem('android_pos_settings');
    if (localConf) {
      try {
        setSettings(JSON.parse(localConf));
      } catch (err) {
        console.warn('Failed restoring settings, falling back to default config details.', err);
      }
    }

    // 3. Load initial CRM customers
    fetchCustomersList();

    // 4. Load logged-in business session from localStorage ONLY if explicitly authenticated
    const bRes = runSql(`SELECT * FROM businesses`, 'Startup: Check registered business accounts');
    const existingBusinesses = (bRes.success && Array.isArray(bRes.data)) ? bRes.data : [];

    const savedBiz = localStorage.getItem('active_business_profile');
    const isSessionAuth = localStorage.getItem('pos_authenticated_session') === 'true';

    if (isSessionAuth && savedBiz && existingBusinesses.length > 0) {
      try {
        const parsed = JSON.parse(savedBiz);
        const match = existingBusinesses.find((b: any) => b.id === parsed.id);
        if (match) {
          setActiveBusiness(match);
          const savedRole = localStorage.getItem('logged_in_user_role') || 'owner';
          setUserRole(savedRole);
          const savedStore = localStorage.getItem('active_store_branch') || '';
          if (savedStore) {
            setActiveStore(savedStore);
          }
          setIsAuthenticatedSession(true);
        } else {
          localStorage.removeItem('active_business_profile');
          localStorage.removeItem('pos_authenticated_session');
          setIsAuthenticatedSession(false);
        }
      } catch (e) {
        localStorage.removeItem('active_business_profile');
        localStorage.removeItem('pos_authenticated_session');
        setIsAuthenticatedSession(false);
      }
    } else {
      // No authenticated session: start on Log In / Create Account screen (blank state)
      localStorage.removeItem('active_business_profile');
      localStorage.removeItem('pos_authenticated_session');
      setIsAuthenticatedSession(false);
      setAuthScreenMode(existingBusinesses.length === 0 ? 'register' : 'login');
    }

    updateBadgeCounts();

    const handleSaleOrDataUpdate = () => {
      setSqlSeedTrigger(prev => prev + 1);
      updateBadgeCounts();
      fetchCustomersList();
    };

    window.addEventListener('pos_sale_completed', handleSaleOrDataUpdate);
    window.addEventListener('pos_data_updated', handleSaleOrDataUpdate);
    window.addEventListener('database-rehydrated', handleSaleOrDataUpdate);
    window.addEventListener('storage', handleSaleOrDataUpdate);

    // Handle native Android hardware back button
    let backListenerHandle: any = null;
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

    // Also load staff members for Admin Setup view
    const staffRes = runSql(`SELECT * FROM staff ORDER BY id ASC`, 'App: Query staff accounts');
    if (staffRes.success && Array.isArray(staffRes.data)) {
      setStaffMembers(staffRes.data);
    } else {
      setStaffMembers([]);
    }

    let currentBiz = activeBusiness;
    if (bizRows.length > 0 && isAuthenticatedSession) {
      const matched = bizRows.find((b: any) => b.id === activeBusiness.id);
      if (!matched && activeBusiness.id) {
        currentBiz = bizRows[0];
        setActiveBusiness(currentBiz);
        localStorage.setItem('active_business_profile', JSON.stringify(currentBiz));
      }
    } else if (bizRows.length === 0 && activeBusiness.id) {
      currentBiz = { id: '', name: '', owner: '', email: '' };
      setActiveBusiness(currentBiz);
      setIsAuthenticatedSession(false);
    }

    // 2. Fetch stores of the activeBusiness (strictly 0 preseeded fallback stores)
    if (currentBiz && currentBiz.id) {
      const sResult = runSql(`SELECT * FROM stores WHERE business_id = '${currentBiz.id}'`, 'App: Query branch outlets for active business');
      const allStoresRes = (!sResult.data || sResult.data.length === 0)
        ? runSql(`SELECT * FROM stores`, 'App: Query all branch outlets')
        : sResult;
      if (allStoresRes.success && Array.isArray(allStoresRes.data) && allStoresRes.data.length > 0) {
        const allStores = allStoresRes.data;
        setStores(allStores);
        // Filter by accessibleStoreIds if logged in as non-owner with restricted branches
        const permittedStores = (userRole !== 'owner' && accessibleStoreIds.length > 0)
          ? allStores.filter((s: any) => accessibleStoreIds.includes(s.id))
          : allStores;
        const listToUse = permittedStores.length > 0 ? permittedStores : allStores;
        const exists = listToUse.find((s: any) => s.id === activeStore);
        if (!exists) {
          const nextStore = listToUse[0].id;
          setActiveStore(nextStore);
          localStorage.setItem('active_store_branch', nextStore);
        }
      } else {
        setStores([]);
        setActiveStore('');
      }
    } else {
      const sAll = runSql(`SELECT * FROM stores`, 'App: Query branch outlets for login');
      if (sAll.success && Array.isArray(sAll.data)) {
        setStores(sAll.data);
      } else {
        setStores([]);
      }
      setActiveStore('');
    }
  };

  useEffect(() => {
    loadBusinessData();

    const handleDbRestored = () => {
      setSqlSeedTrigger(prev => prev + 1);
      loadBusinessData();
      updateBadgeCounts();
    };
    window.addEventListener('local_db_restored', handleDbRestored);
    return () => {
      window.removeEventListener('local_db_restored', handleDbRestored);
    };
  }, [sqlSeedTrigger, activeBusiness.id]);

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
        const pushRes = await pushDatabaseToServer(targetBizId);
        let fbSuccess = false;
        if (auth.currentUser) {
          try {
            const fbRes = await backupToCloud(targetBizId);
            fbSuccess = fbRes.success;
          } catch (fbErr) {
            console.warn('Header Firebase backup notice:', fbErr);
          }
        }
        if (pushRes.success || fbSuccess) {
          setLastHeaderSyncMsg('Synced');
        } else {
          setLastHeaderSyncMsg('Sync Retry');
        }
      } else {
        const pullRes = await pullDatabaseFromServer();
        let restored = pullRes.success && pullRes.found;
        if (!restored && auth.currentUser) {
          try {
            const fbPull = await restoreFromCloud();
            restored = fbPull.success;
          } catch {}
        }
        if (restored) {
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

  // Register New Business Account (100% Blank Stock/Batches/Branches Setup + First Account Automatically Becomes Admin)
  const handleRegisterBusiness = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBizName.trim() || !newBizOwner.trim() || !newBizEmail.trim() || !newBizPassword) {
      alert('Please fill out Business Name, Admin/Owner Full Name, Admin Email, and Password.');
      return;
    }
    if (newBizPassword.trim().length < 6) {
      alert('Please enter a password of at least 6 characters for Firebase Email/Password Authentication.');
      return;
    }

    const bizId = 'biz_' + Math.floor(1000 + Math.random() * 9000);
    const hasInitialStore = Boolean(newBizFirstStore.trim());
    const storeId = hasInitialStore ? ('store_' + Math.floor(1000 + Math.random() * 9000)) : '';
    const rawStoreName = newBizFirstStore.trim();
    const rawLocation = newBizLocation.trim();
    const resolvedCurrency = newBizCurrency.trim() || 'K';
    const resolvedTaxRate = !isNaN(parseFloat(newBizTaxRate)) ? parseFloat(newBizTaxRate) : 0;
    const nowStr = new Date().toISOString();

    // 1. Register / Authenticate Admin in Firebase Email/Password Provider
    try {
      await registerOrSignInWithEmailPassword(newBizEmail.trim(), newBizPassword, newBizOwner.trim());
    } catch (fbAuthErr: any) {
      console.warn('Firebase Email/Password registration notice:', fbAuthErr);
    }

    // 2. Insert registration record into BUSINESSES (First account = Admin with full billing details)
    runSql(`
      INSERT INTO businesses (
        id, name, owner, email, password, billing_address, billing_city, billing_country,
        billing_phone, billing_email, tpin, currency, tax_rate, admin_role, created_at
      ) VALUES (
        '${bizId}',
        '${newBizName.trim().replace(/'/g, "''")}',
        '${newBizOwner.trim().replace(/'/g, "''")}',
        '${newBizEmail.trim().replace(/'/g, "''")}',
        '${newBizPassword.replace(/'/g, "''")}',
        '${newBizBillingAddress.trim().replace(/'/g, "''")}',
        '${newBizBillingCity.trim().replace(/'/g, "''")}',
        '${newBizBillingCountry.trim().replace(/'/g, "''")}',
        '${newBizBillingPhone.trim().replace(/'/g, "''")}',
        '${(newBizBillingEmail.trim() || newBizEmail.trim()).replace(/'/g, "''")}',
        '${newBizTpin.trim().replace(/'/g, "''")}',
        '${resolvedCurrency.replace(/'/g, "''")}',
        ${resolvedTaxRate},
        'admin',
        '${nowStr}'
      )
    `, `Registration: Create blank enterprise account [${newBizName}] with Admin privileges`);

    // 3. Provision primary store outlet ONLY if the admin specified a branch name during setup (no pre-seeded branch)
    if (hasInitialStore && storeId) {
      runSql(`
        INSERT INTO stores (id, business_id, name, location, allow_discounts, allow_refunds, allow_laybys, require_manager_discount) VALUES (
          '${storeId}',
          '${bizId}',
          '${rawStoreName.replace(/'/g, "''")}',
          '${rawLocation.replace(/'/g, "''")}',
          1, 1, 1, 0
        )
      `, `Registration: Provision initial store outlet [${rawStoreName}]`);
    }

    // 4. Automatically register the first account as the Admin user in the STAFF table
    const existingStaffRes = runSql(`SELECT * FROM staff WHERE email = '${newBizEmail.trim().replace(/'/g, "''")}'`, 'Registration: Check admin staff entry');
    if (!existingStaffRes.data || existingStaffRes.data.length === 0) {
      const nextStaffId = Date.now() % 1000000;
      runSql(`
        INSERT INTO staff (id, name, role, hourly_rate, pin, email, password, store_id) VALUES (
          ${nextStaffId},
          '${newBizOwner.trim().replace(/'/g, "''")}',
          'owner',
          0,
          '0000',
          '${newBizEmail.trim().replace(/'/g, "''")}',
          '${newBizPassword.replace(/'/g, "''")}',
          '${storeId}'
        )
      `, `Registration: Provision first account [${newBizOwner.trim()}] as Admin (owner)`);
    }

    // 5. Update StoreSettings with the new business configuration & billing address
    const updatedSettings: StoreSettings = {
      ...settings,
      storeName: newBizName.trim(),
      currency: resolvedCurrency,
      taxRate: resolvedTaxRate,
      tpin: newBizTpin.trim(),
      billingAddress: newBizBillingAddress.trim(),
      billingCity: newBizBillingCity.trim(),
      billingCountry: newBizBillingCountry.trim(),
      billingPhone: newBizBillingPhone.trim(),
      billingEmail: newBizBillingEmail.trim() || newBizEmail.trim(),
      receiptHeader: settings.receiptHeader || 'Official Tax Invoice & Sales Receipt',
      receiptFooter: settings.receiptFooter || 'Thank you for your business!'
    };
    setSettings(updatedSettings);
    localStorage.setItem('android_pos_settings', JSON.stringify(updatedSettings));

    const newlyRegisteredBusiness = {
      id: bizId,
      name: newBizName.trim(),
      owner: newBizOwner.trim(),
      email: newBizEmail.trim()
    };

    // 6. Save authenticated Admin session
    const openCashNum = Math.max(0, parseFloat(newBizOpeningCash || '0') || 0);
    localStorage.setItem('active_business_profile', JSON.stringify(newlyRegisteredBusiness));
    localStorage.setItem('pos_authenticated_session', 'true');
    localStorage.setItem('pos_shift_active', 'true');
    if (storeId) {
      localStorage.setItem('shift_active_' + storeId, 'true');
      localStorage.setItem('shift_opening_cash_' + storeId, openCashNum.toFixed(2));
    }
    localStorage.setItem('shift_opening_cash_global', openCashNum.toFixed(2));
    localStorage.setItem('logged_in_user_email', newBizEmail.trim());
    localStorage.setItem('logged_in_user_name', newBizOwner.trim());
    localStorage.setItem('quick_salesperson_name', newBizOwner.trim());

    setActiveBusiness(newlyRegisteredBusiness);
    setActiveStore(storeId);
    setUserRole('owner');
    setIsAuthenticatedSession(true);
    persistTablesToStorage();
    setSqlSeedTrigger(prev => prev + 1);

    // 7. Synchronize new business & store immediately to Cloud SQL + Firebase Firestore & Firebase Storage
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

    // Open unified Settings & Admin Business Control Panel if they haven't created a store yet so they can set up stores, users, stock & billing
    if (!storeId) {
      openUnifiedSettings('stores');
    }

    window.dispatchEvent(new Event('pos_data_updated'));
  };

  // Sign In & Pull Existing Business or Staff Account from Firebase Auth + Cloud SQL / Firestore / Storage
  const handleSyncExistingAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetEmail = syncLoginEmail.trim();
    const targetPass = syncLoginPassword.trim();
    if (!targetEmail || !targetPass) {
      alert('Please enter your Email and Password.');
      return;
    }

    setIsHeaderSyncing(true);
    try {
      // 1. Pull from Cloud SQL by email
      const pullRes = await pullDatabaseFromServer(undefined, targetEmail);
      let bRes = runSql(`SELECT * FROM businesses`, 'Cloud Login: Check businesses');
      let bizList = (bRes.success && Array.isArray(bRes.data)) ? bRes.data : [];
      let matchedBiz = bizList.find((b: any) => b.email && b.email.trim().toLowerCase() === targetEmail.toLowerCase());

      // Also check if logging in as a Staff/User account created by Admin
      let stRes = runSql(`SELECT * FROM staff`, 'Cloud Login: Check staff accounts');
      let staffList = (stRes.success && Array.isArray(stRes.data)) ? stRes.data : [];
      let matchedStaff = staffList.find(
        (u: any) =>
          (u.email && u.email.trim().toLowerCase() === targetEmail.toLowerCase()) ||
          (u.name && u.name.trim().toLowerCase() === targetEmail.toLowerCase())
      );

      // 2. Authenticate with Firebase Email/Password Auth
      const isLocallyVerified = Boolean(
        (matchedBiz && (!matchedBiz.password || matchedBiz.password === targetPass)) ||
        (matchedStaff && (matchedStaff.password === targetPass || matchedStaff.pin === targetPass))
      );
      try {
        await signInWithEmailPasswordAccount(targetEmail, targetPass, isLocallyVerified, matchedBiz?.owner || matchedStaff?.name);
      } catch (fbErr: any) {
        if (!matchedBiz && !matchedStaff) {
          throw new Error(fbErr?.message || 'Invalid email or password.');
        }
      }

      // 3. If not found in Cloud SQL yet, restore from Firebase Firestore & Storage via authenticated UID
      if (!matchedBiz && !matchedStaff && auth.currentUser) {
        try {
          await restoreFromCloud();
          bRes = runSql(`SELECT * FROM businesses`, 'Cloud Login: Check businesses after Firebase restore');
          bizList = (bRes.success && Array.isArray(bRes.data)) ? bRes.data : [];
          matchedBiz =
            bizList.find((b: any) => b.email && b.email.trim().toLowerCase() === targetEmail.toLowerCase()) ||
            bizList[0];

          stRes = runSql(`SELECT * FROM staff`, 'Cloud Login: Check staff after Firebase restore');
          staffList = (stRes.success && Array.isArray(stRes.data)) ? stRes.data : [];
          matchedStaff = staffList.find(
            (u: any) =>
              (u.email && u.email.trim().toLowerCase() === targetEmail.toLowerCase()) ||
              (u.name && u.name.trim().toLowerCase() === targetEmail.toLowerCase())
          );
        } catch (restoreErr) {
          console.warn('Firebase restore lookup notice:', restoreErr);
        }
      }

      // If matched a Staff user and there's a business in DB
      if (!matchedBiz && matchedStaff && bizList.length > 0) {
        if (matchedStaff.password && matchedStaff.password !== targetPass && matchedStaff.pin !== targetPass) {
          alert('Invalid password or PIN for this user account.');
          setIsHeaderSyncing(false);
          return;
        }
        matchedBiz = bizList[0];
      }

      if (!matchedBiz) {
        alert(`No account found for [${targetEmail}]. Please check your credentials or switch to "Create an Account" to set up your business.`);
        setIsHeaderSyncing(false);
        return;
      }

      if (!matchedStaff && matchedBiz.password && matchedBiz.password !== 'cloud_recovered' && matchedBiz.password !== targetPass) {
        alert('Invalid password for this business account.');
        setIsHeaderSyncing(false);
        return;
      }

      const resolvedRole = matchedStaff && matchedBiz.email?.toLowerCase() !== targetEmail.toLowerCase()
        ? (matchedStaff.role || 'sales')
        : 'owner';
      const resolvedUserName = matchedStaff?.name || (matchedStaff?.first_name ? `${matchedStaff.first_name} ${matchedStaff.surname || ''}`.trim() : '') || matchedBiz.owner || 'Admin';

      // Extract accessible branches for this account
      let userAllowedBranches: string[] = [];
      if (resolvedRole !== 'owner' && matchedStaff) {
        try {
          if (matchedStaff.permissions_json) {
            const parsedPerms = JSON.parse(matchedStaff.permissions_json);
            if (Array.isArray(parsedPerms.accessible_branches) && parsedPerms.accessible_branches.length > 0) {
              userAllowedBranches = parsedPerms.accessible_branches;
            }
          }
        } catch {}
        if (userAllowedBranches.length === 0 && matchedStaff.store_id) {
          userAllowedBranches = [matchedStaff.store_id];
        }
      }

      const sRes = runSql(`SELECT * FROM stores WHERE business_id = '${matchedBiz.id}'`, 'Cloud Login: Load stores');
      const allStores = (sRes.success && Array.isArray(sRes.data) && sRes.data.length > 0)
        ? sRes.data
        : (runSql(`SELECT * FROM stores`, 'Cloud Login: Load all stores').data || []);

      // Check branch authorization if user picked a branch on the login form
      if (syncLoginBranch && userAllowedBranches.length > 0 && !userAllowedBranches.includes(syncLoginBranch)) {
        alert(`Access Denied: Account [${targetEmail}] does not have permission to access branch [${syncLoginBranch.toUpperCase()}].\n\nAccessible Branches: ${userAllowedBranches.join(', ').toUpperCase()}`);
        setIsHeaderSyncing(false);
        return;
      }

      setAccessibleStoreIds(userAllowedBranches);
      localStorage.setItem('logged_in_accessible_branches', JSON.stringify(userAllowedBranches));
      localStorage.setItem('logged_in_user_role', resolvedRole);

      const activeBizObj = {
        id: matchedBiz.id,
        name: matchedBiz.name,
        owner: matchedBiz.owner || 'Admin',
        email: matchedBiz.email
      };
      setActiveBusiness(activeBizObj);
      localStorage.setItem('active_business_profile', JSON.stringify(activeBizObj));
      localStorage.setItem('pos_authenticated_session', 'true');
      setIsAuthenticatedSession(true);

      const updatedSettings: StoreSettings = {
        ...settings,
        storeName: matchedBiz.name || settings.storeName,
        currency: matchedBiz.currency || settings.currency || 'K',
        taxRate: matchedBiz.tax_rate !== undefined ? Number(matchedBiz.tax_rate) : settings.taxRate,
        tpin: matchedBiz.tpin || settings.tpin || '',
        billingAddress: matchedBiz.billing_address || settings.billingAddress || '',
        billingCity: matchedBiz.billing_city || settings.billingCity || '',
        billingCountry: matchedBiz.billing_country || settings.billingCountry || '',
        billingPhone: matchedBiz.billing_phone || settings.billingPhone || '',
        billingEmail: matchedBiz.billing_email || matchedBiz.email || settings.billingEmail || ''
      };
      setSettings(updatedSettings);
      localStorage.setItem('android_pos_settings', JSON.stringify(updatedSettings));

      const permittedStores = (resolvedRole !== 'owner' && userAllowedBranches.length > 0)
        ? allStores.filter((s: any) => userAllowedBranches.includes(s.id))
        : allStores;
      const availableStores = permittedStores.length > 0 ? permittedStores : allStores;
      setStores(allStores);

      if (Array.isArray(availableStores) && availableStores.length > 0) {
        const chosenBranch = (syncLoginBranch && availableStores.some((s: any) => s.id === syncLoginBranch))
          ? syncLoginBranch
          : (matchedStaff?.store_id && availableStores.some((s: any) => s.id === matchedStaff.store_id))
            ? matchedStaff.store_id
            : availableStores[0].id;
        setActiveStore(chosenBranch);
        localStorage.setItem('active_store_branch', chosenBranch);
        localStorage.setItem('pos_shift_active', 'true');
        localStorage.setItem('shift_active_' + chosenBranch, 'true');
        // Prompt user to confirm/choose their branch when logging in if they didn't explicitly pick one in the dropdown
        if (!syncLoginBranch) {
          setShowBranchChoiceGate(true);
        }
      } else {
        setActiveStore('');
      }

      // Ensure Firebase Firestore + Storage mirror is up to date after sign-in
      if (auth.currentUser) {
        backupToCloud(matchedBiz.id).catch(() => {});
      }

      localStorage.setItem('logged_in_user_email', targetEmail);
      localStorage.setItem('logged_in_user_name', resolvedUserName);
      localStorage.setItem('quick_salesperson_name', resolvedUserName);
      setUserRole(resolvedRole);
      setSyncLoginEmail('');
      setSyncLoginPassword('');
      setSyncLoginBranch('');
      setSqlSeedTrigger(prev => prev + 1);
      window.dispatchEvent(new Event('pos_data_updated'));
    } catch (err: any) {
      alert(`Sign-In Error: ${err?.message || String(err)}`);
    } finally {
      setIsHeaderSyncing(false);
    }
  };

  const handleLogoutAccount = () => {
    localStorage.removeItem('pos_authenticated_session');
    localStorage.removeItem('active_business_profile');
    localStorage.removeItem('pos_shift_active');
    localStorage.removeItem('logged_in_accessible_branches');
    localStorage.removeItem('logged_in_user_role');
    setIsAuthenticatedSession(false);
    setShowBranchChoiceGate(false);
    setShowNavDrawer(false);
    setAuthScreenMode('login');
  };

  // Switch workspace immediately
  const handleSelectBusinessWorkspace = (biz: any) => {
    setActiveBusiness(biz);
    localStorage.setItem('active_business_profile', JSON.stringify(biz));
    setSqlSeedTrigger(prev => prev + 1);
  };

  // Compute branches accessible to the currently logged-in account
  const accessibleStores = (userRole !== 'owner' && accessibleStoreIds.length > 0)
    ? stores.filter(s => accessibleStoreIds.includes(s.id))
    : stores;

  const handleSwitchBranch = (branchId: string) => {
    setActiveStore(branchId);
    localStorage.setItem('active_store_branch', branchId);
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
      storeName={settings.storeName || activeBusiness.name || 'Enterprise POS'}
    >
      {!isAuthenticatedSession || !activeBusiness.id ? (
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
                  <p className="text-[11px] text-slate-400 font-medium mt-0.5">
                    100% Blank Slate — No pre-seeded details, branches, or stock. First account automatically becomes Admin.
                  </p>
                </div>
              </div>

              {/* Switch between Log In & Create Account */}
              <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 shrink-0 self-start sm:self-auto">
                <button
                  type="button"
                  onClick={() => setAuthScreenMode('login')}
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
                  onClick={() => setAuthScreenMode('register')}
                  className={`px-3.5 py-2 rounded-lg text-xs font-extrabold uppercase tracking-wider transition-all cursor-pointer ${
                    authScreenMode === 'register'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Create Account
                </button>
              </div>
            </div>

            {/* Form Body */}
            <div className="p-5 sm:p-6 overflow-y-auto max-h-[76vh]">
              {authScreenMode === 'login' ? (
                <div className="flex flex-col gap-5">
                  <div className="p-3.5 rounded-xl bg-emerald-950/30 border border-emerald-800/50 flex items-start gap-3">
                    <Lock size={16} className="text-emerald-400 shrink-0 mt-0.5" />
                    <div className="text-xs text-slate-300 leading-relaxed">
                      <span className="font-bold text-emerald-300 uppercase tracking-wide block mb-0.5">
                        Sign In to Your Business or Staff Account
                      </span>
                      Enter your Admin or Staff email and password to authenticate with Firebase & synchronize your business setup, stores, stock, batches, and accounting ledgers from Cloud SQL & Firebase Storage.
                    </div>
                  </div>

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

                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                        Choose Branch to Log Into (Or Select After Sign-In)
                      </label>
                      <select
                        value={syncLoginBranch}
                        onChange={(e) => setSyncLoginBranch(e.target.value)}
                        className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 font-bold text-xs focus:border-emerald-500 focus:outline-hidden cursor-pointer uppercase"
                      >
                        <option value="">— Choose Branch After Verification ({stores.length} Configured) —</option>
                        {stores.map((st: any) => (
                          <option key={st.id} value={st.id}>
                            📍 {st.name} {st.location ? `(${st.location})` : ''}
                          </option>
                        ))}
                      </select>
                      <span className="text-[10px] text-slate-500 block mt-1">
                        Each branch keeps separate stock, sales, laybys, expenses &amp; End-of-Day (EOD) totals.
                      </span>
                    </div>

                    <button
                      type="submit"
                      disabled={isHeaderSyncing}
                      className="mt-1 py-3 px-5 bg-emerald-600 hover:bg-emerald-500 text-white font-black uppercase rounded-xl text-xs tracking-wider cursor-pointer shadow-lg flex items-center justify-center gap-2 transition-all"
                    >
                      <RefreshCw size={15} className={isHeaderSyncing ? 'animate-spin' : ''} />
                      <span>{isHeaderSyncing ? 'Authenticating & Synchronizing...' : 'Log In & Choose Branch'}</span>
                    </button>
                  </form>

                  {/* If local workspaces already exist on this device, allow quick selection after login or switching to Create Account */}
                  <div className="pt-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
                    <span>Setting up a new business for the first time?</span>
                    <button
                      type="button"
                      onClick={() => setAuthScreenMode('register')}
                      className="text-indigo-400 hover:text-indigo-300 font-extrabold uppercase tracking-wider cursor-pointer"
                    >
                      Create Admin Account →
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleRegisterBusiness} className="flex flex-col gap-4">
                  <div className="p-3.5 rounded-xl bg-indigo-950/40 border border-indigo-800/60 flex items-start gap-3">
                    <ShieldCheck size={17} className="text-indigo-400 shrink-0 mt-0.5" />
                    <div className="text-[11px] text-slate-300 leading-relaxed">
                      <span className="font-extrabold text-indigo-300 uppercase tracking-wide block mb-0.5">
                        First Account Automatically Becomes the Admin Account
                      </span>
                      Everything starts blank with zero pre-seeded stock, batches, or branches. As Admin, you can configure your business setup, billing address, create stores/branches, add users, and add stock.
                    </div>
                  </div>

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
      <div className="flex-1 flex flex-col overflow-hidden relative h-full">
        
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

            {/* Active Business / Settings & Admin Control Panel Button */}
            <button
              onClick={() => openUnifiedSettings('general')}
              className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-lg text-xs font-extrabold transition-all cursor-pointer shadow-sm font-sans border ${
                activeTab === 'settings'
                  ? 'bg-indigo-600 text-white border-indigo-400'
                  : 'bg-indigo-950/80 text-indigo-200 border-indigo-800/80 hover:bg-indigo-900 hover:text-white'
              }`}
              title="Open Settings (Merged SME Configuration & Admin Business Control Panel)"
            >
              <Building2 size={13} className="text-emerald-400 animate-pulse shrink-0" />
              <span className="truncate max-w-[90px] sm:max-w-[160px]">{activeBusiness.name || 'Business Settings'}</span>
            </button>

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
            <button
              onClick={() => openUnifiedSettings('general')}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] sm:text-[11px] font-extrabold cursor-pointer transition-all shadow-xs ${
                activeTab === 'settings'
                  ? 'bg-indigo-500 text-white ring-2 ring-indigo-300'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white'
              }`}
              title="Settings: Unified SME Configuration & Admin Business Control Panel"
            >
              <Sliders size={12} />
              <span className="hidden md:inline">Settings</span>
            </button>

            <button
              onClick={handleQuickCloudSync}
              disabled={isHeaderSyncing}
              title="Synchronize business data with Cloud SQL & Firebase"
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-sky-950/90 hover:bg-sky-900 text-sky-300 border border-sky-800/80 text-[10px] sm:text-[11px] font-bold cursor-pointer transition-all"
            >
              <RefreshCw size={12} className={isHeaderSyncing ? 'animate-spin text-sky-400' : 'text-sky-400'} />
              <span className="hidden sm:inline">{lastHeaderSyncMsg || 'Sync'}</span>
            </button>

            <select
              value={userRole}
              onChange={(e) => {
                setUserRole(e.target.value);
                setSqlSeedTrigger(prev => prev + 1);
              }}
              className="bg-slate-800 text-slate-100 text-[11px] sm:text-xs font-bold px-1.5 sm:px-2 py-1 rounded-md border border-slate-700 focus:outline-hidden cursor-pointer font-sans"
            >
              <option value="owner">Admin (Owner)</option>
              <option value="manager">Manager</option>
              <option value="sales">Sales</option>
            </select>

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
        <div className="flex-1 flex overflow-hidden relative min-w-0 w-full">
          <div className="flex-1 flex flex-col overflow-hidden bg-slate-50 relative z-0 min-w-0 w-full">
              <AnimatePresence mode="wait">
                {activeTab === 'billing' && (
                  <motion.div
                    key={`billing_${activeStore}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 flex flex-col overflow-hidden min-w-0 w-full"
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
                      onUserRoleChange={setUserRole}
                    />
                  </motion.div>
                )}

                {activeTab === 'laybys' && (
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

                {activeTab === 'inventory' && (
                  <motion.div
                    key={`inventory_${sqlSeedTrigger}_${activeStore}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 flex flex-col overflow-hidden min-w-0 w-full"
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

                {activeTab === 'attendance' && (
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

                {activeTab === 'quotes' && (
                  <motion.div
                    key={`quotes_${sqlSeedTrigger}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 flex flex-col overflow-hidden"
                  >
                    <QuotationsCreator settings={settings} />
                  </motion.div>
                )}
                {activeTab === 'loans' && (
                  <motion.div
                    key={`loans_${sqlSeedTrigger}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 flex flex-col overflow-hidden"
                  >
                    <LoanDashboard settings={settings} userRole={userRole} activeStore={activeStore} />
                  </motion.div>
                )}
                {activeTab === 'finance' && (
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

                {activeTab === 'analytics' && (
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

                {activeTab === 'workspace' && (
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

                {activeTab === 'audit' && (
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



                {activeTab === 'settings' && (
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
                      activeBusiness={activeBusiness}
                      setActiveBusiness={setActiveBusiness}
                      businesses={businesses}
                      onSelectBusinessWorkspace={handleSelectBusinessWorkspace}
                      onSyncExistingAccount={handleSyncExistingAccount}
                      syncLoginEmail={syncLoginEmail}
                      setSyncLoginEmail={setSyncLoginEmail}
                      syncLoginPassword={syncLoginPassword}
                      setSyncLoginPassword={setSyncLoginPassword}
                      isHeaderSyncing={isHeaderSyncing}
                      onNavigateToTab={(tab) => setActiveTab2(tab as ActiveTab)}
                      initialSubTab={settingsInitialSubTab}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

        {/* MOBILE ADAPTIVE BOTTOM NAVIGATION BAR */}
        <div className="md:hidden flex items-center justify-around bg-slate-900 border-t border-slate-800 px-1 py-1 shrink-0 z-20 select-none shadow-lg text-slate-400">
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

          <button
            id="mobile_nav_inventory"
            type="button"
            onClick={() => setActiveTab2('inventory')}
            className={`flex-1 flex flex-col items-center justify-center py-1.5 rounded-lg min-h-[46px] cursor-pointer active:scale-95 transition-all text-[9.5px] font-bold relative ${
              activeTab === 'inventory'
                ? 'bg-blue-500/15 text-blue-400 font-extrabold'
                : 'hover:text-slate-200'
            }`}
          >
            <Package size={17} className={activeTab === 'inventory' ? 'text-blue-400 stroke-[2.5]' : ''} />
            <span className="mt-0.5 tracking-tight">Stock</span>
          </button>

          <button
            id="mobile_nav_laybys"
            type="button"
            onClick={() => setActiveTab2('laybys')}
            className={`flex-1 flex flex-col items-center justify-center py-1.5 rounded-lg min-h-[46px] cursor-pointer active:scale-95 transition-all text-[9.5px] font-bold ${
              activeTab === 'laybys'
                ? 'bg-amber-500/15 text-amber-400 font-extrabold'
                : 'hover:text-slate-200'
            }`}
          >
            <Layers size={17} className={activeTab === 'laybys' ? 'text-amber-400 stroke-[2.5]' : ''} />
            <span className="mt-0.5 tracking-tight">Laybys</span>
          </button>

          <button
            id="mobile_nav_finance"
            type="button"
            onClick={() => setActiveTab2('finance')}
            className={`flex-1 flex flex-col items-center justify-center py-1.5 rounded-lg min-h-[46px] cursor-pointer active:scale-95 transition-all text-[9.5px] font-bold ${
              activeTab === 'finance'
                ? 'bg-purple-500/15 text-purple-400 font-extrabold'
                : 'hover:text-slate-200'
            }`}
          >
            <FileText size={17} className={activeTab === 'finance' ? 'text-purple-400 stroke-[2.5]' : ''} />
            <span className="mt-0.5 tracking-tight">Finance</span>
          </button>

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

                {/* Unified Settings & Workspace Shortcuts */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => openUnifiedSettings('general')}
                    className="py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[10.5px] font-extrabold uppercase tracking-wider text-center shadow-xs transition-all cursor-pointer font-sans flex items-center justify-center gap-1"
                  >
                    <Sliders size={14} />
                    <span>SETTINGS</span>
                  </button>
                  <button
                    onClick={() => openUnifiedSettings('database')}
                    className="py-2 px-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[10.5px] font-extrabold uppercase tracking-wider text-center shadow-xs transition-all cursor-pointer font-sans flex items-center justify-center gap-1"
                  >
                    <Building2 size={14} />
                    <span>WORKSPACES</span>
                  </button>
                </div>
              </div>

              {/* SECTION: Management */}
              <div className="p-3 flex flex-col gap-1.5 border-b border-slate-150">
                <span className="text-[11px] font-extrabold text-slate-400 uppercase tracking-wider px-2 py-0.5 font-mono">
                  Management
                </span>

                {/* Point of Sale Register - Placed directly on top of Inventory */}
                <button
                  id="drawer_pos_sale_btn"
                  onClick={() => {
                    setShowNavDrawer(false);
                    setBillingCounterAction(null);
                    setActiveTab2('billing');
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

                {/* Inventory Management */}
                <button
                  onClick={() => {
                    setShowNavDrawer(false);
                    setActiveTab2('inventory');
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

                {/* Layby Functions & Credit Sales */}
                <button
                  onClick={() => {
                    setShowNavDrawer(false);
                    setActiveTab2('laybys');
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

                {/* Tasks & Operations */}
                <button
                  onClick={() => {
                    setShowNavDrawer(false);
                    setActiveTab2('workspace');
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

                {/* Documents & Quotes (word 'Receipts' removed as requested) */}
                <button
                  onClick={() => {
                    setShowNavDrawer(false);
                    setActiveTab2('quotes');
                  }}
                  className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="p-1.5 rounded-lg bg-purple-600 text-white shadow-xs group-hover:scale-105 transition-transform">
                      <FileText size={16} />
                    </div>
                    <span>Documents & Invoices</span>
                  </div>
                </button>

                {/* Add Expense */}
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

                {/* Purchase Orders & Outflows */}
                <button
                  onClick={() => {
                    setShowNavDrawer(false);
                    setActiveTab2('loans');
                  }}
                  className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="p-1.5 rounded-lg bg-indigo-600 text-white shadow-xs group-hover:scale-105 transition-transform">
                      <Truck size={16} />
                    </div>
                    <span>Purchase Orders & Expenses</span>
                  </div>
                  <span className="px-2 py-0.5 bg-indigo-100 text-indigo-800 border border-indigo-200 text-[10px] font-extrabold rounded-full font-mono">
                    Tab
                  </span>
                </button>

                {/* Customers Management */}
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

                {/* Staff Management */}
                <button
                  onClick={() => {
                    setShowNavDrawer(false);
                    setActiveTab2('attendance');
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

                {/* Employee Audit Trail */}
                <button
                  onClick={() => {
                    setShowNavDrawer(false);
                    setActiveTab2('audit');
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
              </div>

              {/* SECTION: Finance & Accounting */}
              <div className="p-3 flex flex-col gap-1.5 border-b border-slate-150 bg-emerald-50/40">
                <span className="text-[11px] font-extrabold text-emerald-800 uppercase tracking-wider px-2 py-0.5 font-mono">
                  Finance & Accounting
                </span>

                {/* Financial Statements & P&L */}
                <button
                  onClick={() => {
                    setShowNavDrawer(false);
                    setActiveTab2('finance');
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
                    setActiveTab2('finance');
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

                {/* Goods in Transit & POs */}
                <button
                  onClick={() => {
                    setShowNavDrawer(false);
                    setActiveTab2('finance');
                  }}
                  className="flex items-center justify-between p-2 rounded-xl hover:bg-emerald-100/70 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="p-1.5 rounded-lg bg-emerald-700 text-white shadow-xs group-hover:scale-105 transition-transform">
                      <Truck size={16} />
                    </div>
                    <span>Purchase Orders & Procurement</span>
                  </div>
                </button>
              </div>

              {/* SECTION: Loans & Merchant Financing */}
              <div className="p-3 flex flex-col gap-1.5 border-b border-slate-150 bg-blue-50/40">
                <span className="text-[11px] font-extrabold text-blue-800 uppercase tracking-wider px-2 py-0.5 font-mono">
                  Loans & Merchant Credit
                </span>

                {/* Loan Advances */}
                <button
                  onClick={() => {
                    setShowNavDrawer(false);
                    setActiveTab2('loans');
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
                    setActiveTab2('loans');
                  }}
                  className="flex items-center justify-between p-2 rounded-xl hover:bg-blue-100/70 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="p-1.5 rounded-lg bg-blue-700 text-white shadow-xs group-hover:scale-105 transition-transform">
                      <TrendingUp size={16} />
                    </div>
                    <span>Credit Risk & Swept Capital</span>
                  </div>
                </button>

                {/* Borrower Statements */}
                <button
                  onClick={() => {
                    setShowNavDrawer(false);
                    setActiveTab2('loans');
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

              {/* SECTION: Additional Tools */}
              <div className="p-3 flex flex-col gap-1.5">
                {/* Refer App */}
                <button
                  onClick={() => {
                    setShowNavDrawer(false);
                    alert('Merchant referral link generated and copied to clipboard!');
                  }}
                  className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="p-1.5 rounded-lg bg-teal-600 text-white shadow-xs group-hover:scale-105 transition-transform">
                      <Share2 size={16} />
                    </div>
                    <span>Refer App</span>
                  </div>
                </button>

                {/* Receipts & Refunds Ledger */}
                <button
                  onClick={() => {
                    setShowNavDrawer(false);
                    setBillingCounterAction('refunds');
                    setActiveTab2('billing');
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

                {/* Settings (Unified SME Configuration & Admin Business Control Panel) */}
                <button
                  onClick={() => openUnifiedSettings('general')}
                  className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="p-1.5 rounded-lg bg-slate-700 text-white shadow-xs group-hover:scale-105 transition-transform">
                      <Sliders size={16} />
                    </div>
                    <span>Settings (Admin & Business Control)</span>
                  </div>
                </button>
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

                runSql(`
                  INSERT INTO expenses (id, category, payment_method, account_id, amount, description, ref_number, reference_no, expense_date, store_id, performed_by, created_by, created_at)
                  VALUES (
                    '${expId}',
                    '${expenseCategory.replace(/'/g, "''")}',
                    'Cash',
                    'acc_cash',
                    ${amt},
                    '${(expenseNotes || 'Store Expense').replace(/'/g, "''")}',
                    '${expId}',
                    '${expId}',
                    '${nowIso.split('T')[0]}',
                    '${targetBranch.replace(/'/g, "''")}',
                    '${(localStorage.getItem('logged_in_user_name') || userRole).replace(/'/g, "''")}',
                    '${userRole}',
                    '${nowIso}'
                  )
                `, 'Record branch operating expense');

                runSql(`
                  INSERT INTO double_entry_journal (id, date, reference, description, account_debit, account_credit, amount, currency) VALUES (
                    'exp_${Date.now()}',
                    '${nowIso}',
                    '${expId}',
                    '[Branch: ${targetBranch}] ${(expenseNotes || 'Store Expense').replace(/'/g, "''")}',
                    'Operating Expenses',
                    'Cash Drawer',
                    ${amt},
                    '${settings.currency}'
                  )
                `, 'Record expense journal entry');

                logEmployeeAudit('EXPENSES', 'Added Operating Expense', `Category: ${expenseCategory}, Notes: ${expenseNotes || 'Store Expense'}`, amt, targetBranch, userRole);

                alert(`Operating expense of ${settings.currency}${amt.toFixed(2)} recorded for branch [${targetBranch.toUpperCase()}] and linked to branch EOD totals!`);
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
                if (!newCustName) return;
                upsertCustomerSync({
                  name: newCustName,
                  phone: newCustPhone,
                  loyalPointsDelta: 50
                });
                alert(`Customer [${newCustName}] registered into central CRM database with 50 bonus points!`);
                setNewCustName('');
                setNewCustPhone('');
                fetchCustomersList();
              }}
              className="flex items-center gap-2 bg-slate-950 p-2.5 rounded-xl border border-slate-850"
            >
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
    </AndroidShell>
  );
}
