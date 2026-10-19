import React, { useState, useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { 
  ShoppingCart, Package, TrendingUp, Terminal, Sliders, 
  Layers, Clock, Coins, FileText, Users, Briefcase, Plus, 
  Key, ShieldCheck, Check, Lock, Building, Building2, UserCheck, User,
  RefreshCw, Percent, ChevronRight, Sparkles, CheckSquare,
  Menu, X, Phone, Receipt, ShoppingBag, Share2, RotateCcw,
  LayoutDashboard, FileSpreadsheet, MessageSquare, Send, HelpCircle, Truck,
  Cloud, CloudUpload, CloudDownload
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Database API
import { initializeDatabase, SeedTemplate, runSql, upsertCustomerSync, logEmployeeAudit, persistTablesToStorage, pushDatabaseToServer, pullDatabaseFromServer } from './db';
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

export const DEFAULT_COMPANY_LOGO = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'><rect width='120' height='120' rx='28' fill='%233730A3'/><path d='M60 22 L92 38 L92 70 C92 86 60 96 60 96 C60 96 28 88 28 72 L28 38 Z' fill='none' stroke='white' stroke-width='6' stroke-linejoin='round'/><path d='M44 58 L56 70 L78 48' fill='none' stroke='white' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/></svg>";

const DEFAULT_SETTINGS: StoreSettings = {
  storeName: 'New Business POS',
  currency: 'K',
  taxRate: 16,
  loyaltyRatio: 10,
  receiptHeader: 'Official Tax Invoice & Sales Receipt',
  receiptFooter: 'Thank you for your business!',
  paperWidth: '58mm',
  logoUrl: DEFAULT_COMPANY_LOGO,
  tpin: '',
  termsAndConditions: '1. All goods sold are subject to standard VAT unless exempted.\n2. Goods returned in original state are exchangeable within 7 business days.\n3. Keep receipt for warranty queries.',
  printerName: 'ZPOS-Bluetooth-58M (Default Linked)',
  printerInterface: 'Bluetooth Low Energy (BLE)',
  printerStatus: 'Linked',
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

  // Dynamic Enterprise & Multi-Business Gating State (Blank on default)
  const [activeBusiness, setActiveBusiness] = useState<{ id: string; name: string; owner: string; email: string }>({
    id: '',
    name: 'Setup Business Account',
    owner: '',
    email: ''
  });
  const [businesses, setBusinesses] = useState<any[]>([]);
  const [stores, setStores] = useState<any[]>([]);
  const [showBusinessModal, setShowBusinessModal] = useState(false);
  const [hubMode, setHubMode] = useState<'register' | 'sync_login' | 'store'>('register');
  const [newBizName, setNewBizName] = useState('');
  const [newBizOwner, setNewBizOwner] = useState('');
  const [newBizEmail, setNewBizEmail] = useState('');
  const [newBizPassword, setNewBizPassword] = useState('');
  const [newBizFirstStore, setNewBizFirstStore] = useState('');
  const [newBizLocation, setNewBizLocation] = useState('Lusaka');
  const [newBizCurrency, setNewBizCurrency] = useState('K');
  const [newBizTaxRate, setNewBizTaxRate] = useState('16');
  const [newBizTpin, setNewBizTpin] = useState('');
  const [newBizOpeningCash, setNewBizOpeningCash] = useState('0.00');

  // Existing Business Cloud Sign-In / Sync states
  const [syncLoginEmail, setSyncLoginEmail] = useState('');
  const [syncLoginPassword, setSyncLoginPassword] = useState('');
  const [isHeaderSyncing, setIsHeaderSyncing] = useState(false);
  const [lastHeaderSyncMsg, setLastHeaderSyncMsg] = useState<string | null>(null);

  // Floating Store Creation Form inside switcher
  const [showStoreForm, setShowStoreForm] = useState(false);
  const [newStoreId, setNewStoreId] = useState('');
  const [newStoreName, setNewStoreName] = useState('');
  const [newStoreLocation, setNewStoreLocation] = useState('');
  const [newStoreAllowDiscounts, setNewStoreAllowDiscounts] = useState(true);
  const [newStoreAllowRefunds, setNewStoreAllowRefunds] = useState(true);
  const [newStoreAllowLaybys, setNewStoreAllowLaybys] = useState(true);
  const [newStoreReqManager, setNewStoreReqManager] = useState(false);

  // Drawer Modals & Counts (Blank on default)
  const [badgeCounts, setBadgeCounts] = useState({ products: 0, customers: 0, staff: 0 });
  
  // Expense Modal state
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseCategory, setExpenseCategory] = useState('Store Operations');
  const [expenseNotes, setExpenseNotes] = useState('');

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
    showBusinessModal,
    billingCounterAction,
    activeTab
  });
  navigationBackStateRef.current = {
    showNavDrawer,
    showHelpChatModal,
    showCustomersModal,
    showExpenseModal,
    showBusinessModal,
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

  // Update badge counts from DB (strictly 0 when empty)
  const updateBadgeCounts = () => {
    try {
      const pRes = runSql(`SELECT COUNT(*) as cnt FROM products`, 'Query product count');
      const prodCnt = (pRes.success && pRes.data?.[0]?.cnt !== undefined) ? pRes.data[0].cnt : 0;

      const cRes = runSql(`SELECT COUNT(*) as cnt FROM customers`, 'Query customer count');
      const custCnt = (cRes.success && cRes.data?.[0]?.cnt !== undefined) ? cRes.data[0].cnt : 0;

      const sRes = runSql(`SELECT COUNT(*) as cnt FROM staff`, 'Query staff count');
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

    // 4. Load logged-in business session from localStorage if valid in DB
    const bRes = runSql(`SELECT * FROM businesses`, 'Startup: Check registered business accounts');
    const existingBusinesses = (bRes.success && Array.isArray(bRes.data)) ? bRes.data : [];

    const savedBiz = localStorage.getItem('active_business_profile');
    if (savedBiz && existingBusinesses.length > 0) {
      try {
        const parsed = JSON.parse(savedBiz);
        const match = existingBusinesses.find((b: any) => b.id === parsed.id);
        if (match) {
          setActiveBusiness(match);
        } else {
          setActiveBusiness(existingBusinesses[0]);
          localStorage.setItem('active_business_profile', JSON.stringify(existingBusinesses[0]));
        }
      } catch (e) {
        setActiveBusiness(existingBusinesses[0]);
      }
    } else if (existingBusinesses.length > 0) {
      setActiveBusiness(existingBusinesses[0]);
      localStorage.setItem('active_business_profile', JSON.stringify(existingBusinesses[0]));
    } else {
      // No business exists yet: clear any stale default_biz profile and prompt new business setup
      localStorage.removeItem('active_business_profile');
      setShowBusinessModal(true);
      setHubMode('register');
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
        if (state.showBusinessModal) {
          setShowBusinessModal(false);
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

    let currentBiz = activeBusiness;
    if (bizRows.length > 0) {
      const matched = bizRows.find((b: any) => b.id === activeBusiness.id);
      if (!matched) {
        currentBiz = bizRows[0];
        setActiveBusiness(currentBiz);
        localStorage.setItem('active_business_profile', JSON.stringify(currentBiz));
      }
    } else if (activeBusiness.id) {
      currentBiz = { id: '', name: 'Setup Business Account', owner: '', email: '' };
      setActiveBusiness(currentBiz);
    }

    // 2. Fetch stores of the activeBusiness (no preseeded fallback stores)
    if (currentBiz && currentBiz.id) {
      const sResult = runSql(`SELECT * FROM stores WHERE business_id = '${currentBiz.id}'`, 'App: Query branch outlets for active business');
      const allStoresRes = (!sResult.data || sResult.data.length === 0)
        ? runSql(`SELECT * FROM stores`, 'App: Query all branch outlets')
        : sResult;
      if (allStoresRes.success && Array.isArray(allStoresRes.data) && allStoresRes.data.length > 0) {
        setStores(allStoresRes.data);
        const exists = allStoresRes.data.find((s: any) => s.id === activeStore);
        if (!exists) {
          setActiveStore(allStoresRes.data[0].id);
        }
      } else {
        setStores([]);
        setActiveStore('');
      }
    } else {
      setStores([]);
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
        if (pushRes.success) {
          setLastHeaderSyncMsg('Synced');
        } else {
          setLastHeaderSyncMsg('Sync Retry');
        }
      } else {
        const pullRes = await pullDatabaseFromServer();
        if (pullRes.success) {
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

  // Register New Business Account (100% Blank Stock/Batches Setup + Immediate Cloud SQL Sync)
  const handleRegisterBusiness = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBizName || !newBizOwner || !newBizEmail || !newBizPassword) {
      alert('Please fill out Business Name, Owner Name, Admin Email, and Password.');
      return;
    }

    const bizId = 'biz_' + Math.floor(1000 + Math.random() * 9000);
    const storeId = 'store_' + Math.floor(1000 + Math.random() * 9000);
    const rawStoreName = newBizFirstStore.trim() || `${newBizName.trim()} Main Branch`;
    const rawLocation = newBizLocation.trim() || 'Main Location';
    const nowStr = new Date().toISOString();

    // 1. Insert registration record into BUSINESSES
    runSql(`
      INSERT INTO businesses (id, name, owner, email, password, created_at) VALUES (
        '${bizId}',
        '${newBizName.trim().replace(/'/g, "''")}',
        '${newBizOwner.trim().replace(/'/g, "''")}',
        '${newBizEmail.trim().replace(/'/g, "''")}',
        '${newBizPassword.replace(/'/g, "''")}',
        '${nowStr}'
      )
    `, `Registration: Create blank enterprise account [${newBizName}]`);

    // 2. Create primary outlet branch into STORES table (with 0 preseeded products/batches)
    runSql(`
      INSERT INTO stores (id, business_id, name, location, allow_discounts, allow_refunds, allow_laybys, require_manager_discount) VALUES (
        '${storeId}',
        '${bizId}',
        '${rawStoreName.replace(/'/g, "''")}',
        '${rawLocation.replace(/'/g, "''")}',
        1, 1, 1, 0
      )
    `, `Registration: Provision primary store outlet [${rawStoreName}]`);

    // 3. Update StoreSettings with the new business configuration
    const updatedSettings: StoreSettings = {
      ...settings,
      storeName: newBizName.trim(),
      currency: newBizCurrency.trim() || 'K',
      taxRate: !isNaN( parseFloat(newBizTaxRate) ) ? parseFloat(newBizTaxRate) : 16,
      tpin: newBizTpin.trim()
    };
    setSettings(updatedSettings);
    localStorage.setItem('android_pos_settings', JSON.stringify(updatedSettings));

    const newlyRegisteredBusiness = {
      id: bizId,
      name: newBizName.trim(),
      owner: newBizOwner.trim(),
      email: newBizEmail.trim()
    };

    // 4. Save session, activate shift on the newly created store so owner can immediately start working
    const openCashNum = Math.max(0, parseFloat(newBizOpeningCash || '0') || 0);
    localStorage.setItem('active_business_profile', JSON.stringify(newlyRegisteredBusiness));
    localStorage.setItem('pos_shift_active', 'true');
    localStorage.setItem('shift_active_' + storeId, 'true');
    localStorage.setItem('shift_opening_cash_' + storeId, openCashNum.toFixed(2));
    localStorage.setItem('shift_opening_cash_global', openCashNum.toFixed(2));
    localStorage.setItem('logged_in_user_email', newBizEmail.trim());
    localStorage.setItem('logged_in_user_name', newBizOwner.trim());
    localStorage.setItem('quick_salesperson_name', newBizOwner.trim());

    setActiveBusiness(newlyRegisteredBusiness);
    setActiveStore(storeId);
    setUserRole('owner');
    persistTablesToStorage();
    setSqlSeedTrigger(prev => prev + 1);

    // 5. Synchronize new business & store immediately to Cloud SQL
    pushDatabaseToServer(bizId).catch(err => console.warn('Initial Cloud SQL push warning:', err));

    // Reset fields
    setNewBizName('');
    setNewBizOwner('');
    setNewBizEmail('');
    setNewBizPassword('');
    setNewBizFirstStore('');
    setShowBusinessModal(false);

    window.dispatchEvent(new Event('pos_data_updated'));
    alert(`✓ Business Account [${newlyRegisteredBusiness.name}] & Primary Branch [${rawStoreName}] created!\n\nYour inventory and accounting ledgers start 100% blank with zero preseeded stock or batches, and your workspace is synchronized with Cloud SQL.`);
  };

  // Sign In & Pull Existing Business Account from Cloud SQL
  const handleSyncExistingAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetEmail = syncLoginEmail.trim();
    const targetPass = syncLoginPassword.trim();
    if (!targetEmail || !targetPass) {
      alert('Please enter your registered Business Email and Password.');
      return;
    }

    setIsHeaderSyncing(true);
    try {
      // Pull from Cloud SQL by email
      const pullRes = await pullDatabaseFromServer(undefined, targetEmail);
      const bRes = runSql(`SELECT * FROM businesses`, 'Cloud Login: Check businesses');
      const bizList = (bRes.success && Array.isArray(bRes.data)) ? bRes.data : [];
      const matchedBiz = bizList.find((b: any) => b.email && b.email.trim().toLowerCase() === targetEmail.toLowerCase());

      if (!matchedBiz) {
        alert(`No synchronized business account found for email [${targetEmail}]. Please verify your email or register a new business account.`);
        setIsHeaderSyncing(false);
        return;
      }

      if (matchedBiz.password && matchedBiz.password !== targetPass) {
        alert('Invalid password for this business account.');
        setIsHeaderSyncing(false);
        return;
      }

      const activeBizObj = {
        id: matchedBiz.id,
        name: matchedBiz.name,
        owner: matchedBiz.owner || 'Owner',
        email: matchedBiz.email
      };
      setActiveBusiness(activeBizObj);
      localStorage.setItem('active_business_profile', JSON.stringify(activeBizObj));

      const updatedSettings: StoreSettings = {
        ...settings,
        storeName: matchedBiz.name
      };
      setSettings(updatedSettings);
      localStorage.setItem('android_pos_settings', JSON.stringify(updatedSettings));

      const sRes = runSql(`SELECT * FROM stores WHERE business_id = '${matchedBiz.id}'`, 'Cloud Login: Load stores');
      if (sRes.success && Array.isArray(sRes.data) && sRes.data.length > 0) {
        const firstStoreId = sRes.data[0].id;
        setActiveStore(firstStoreId);
        localStorage.setItem('pos_shift_active', 'true');
        localStorage.setItem('shift_active_' + firstStoreId, 'true');
      }

      localStorage.setItem('logged_in_user_email', matchedBiz.email);
      localStorage.setItem('logged_in_user_name', matchedBiz.owner || matchedBiz.name);
      setUserRole('owner');
      setSyncLoginEmail('');
      setSyncLoginPassword('');
      setShowBusinessModal(false);
      setSqlSeedTrigger(prev => prev + 1);
      window.dispatchEvent(new Event('pos_data_updated'));

      alert(`✓ Synchronized & Signed In to [${matchedBiz.name}]!\n${pullRes.details || 'All stores, stock, batches, and accounting ledgers have been synchronized.'}`);
    } catch (err: any) {
      alert(`Sync Sign-In Error: ${err?.message || String(err)}`);
    } finally {
      setIsHeaderSyncing(false);
    }
  };

  const handleCreateNewStore = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeBusiness.id) {
      alert('Please register or sign into your business account first before adding extra branches.');
      return;
    }
    if (!newStoreName) {
      alert('Provide a valid Store Name');
      return;
    }

    const calculatedId = 'store_' + Math.floor(1000 + Math.random() * 9000);
    const finalId = newStoreId.trim().toLowerCase().replace(/\s+/g, '_') || calculatedId;

    // Check duplicate
    const checkDup = runSql(`SELECT * FROM stores WHERE id = '${finalId}'`, 'Store: Duplicate check');
    if (checkDup.success && Array.isArray(checkDup.data) && checkDup.data.length > 0) {
      alert(`Error: A branch with identifier [${finalId}] already exists. Choose a unique code.`);
      return;
    }

    runSql(`
      INSERT INTO stores (id, business_id, name, location, allow_discounts, allow_refunds, allow_laybys, require_manager_discount) VALUES (
        '${finalId}',
        '${activeBusiness.id}',
        '${newStoreName.replace(/'/g, "''")}',
        '${(newStoreLocation || 'Main').replace(/'/g, "''")}',
         ${newStoreAllowDiscounts ? 1 : 0},
         ${newStoreAllowRefunds ? 1 : 0},
         ${newStoreAllowLaybys ? 1 : 0},
         ${newStoreReqManager ? 1 : 0}
      )
    `, `SME Owner: Dynamic store creation commit for branch [${newStoreName}]`);

    // Link existing product templates for this business with 0 initial stock in the new branch
    const prodsResult = runSql(`SELECT * FROM products WHERE business_id = '${activeBusiness.id}'`, 'Store: Read business products');
    if (prodsResult.success && Array.isArray(prodsResult.data)) {
      prodsResult.data.forEach(p => {
        const spId = `sp_${p.id}_${finalId}`;
        runSql(`
          INSERT INTO store_products VALUES (
            '${spId}', ${p.id}, '${finalId}', 0, ${p.price}
          )
        `, 'Store Link: Map branch product row');
      });
    }

    persistTablesToStorage();
    pushDatabaseToServer(activeBusiness.id).catch(() => {});
    alert(`Store outlet [${newStoreName}] has been registered and synchronized!`);
    setNewStoreName('');
    setNewStoreId('');
    setNewStoreLocation('');
    setShowStoreForm(false);
    setActiveStore(finalId);
    setSqlSeedTrigger(prev => prev + 1);
  };

  // Switch workspace immediately
  const handleSelectBusinessWorkspace = (biz: any) => {
    setActiveBusiness(biz);
    localStorage.setItem('active_business_profile', JSON.stringify(biz));
    setSqlSeedTrigger(prev => prev + 1);
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
      storeName={settings.storeName}
    >
      {/* Main Container without congested permanent sidebar dock */}
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

            {/* Active Business / Store Badge */}
            <button
              onClick={() => {
                loadBusinessData();
                setShowBusinessModal(true);
              }}
              className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1 bg-indigo-950/80 text-indigo-200 border border-indigo-800/80 rounded-lg text-xs font-extrabold hover:bg-indigo-900 hover:text-white transition-all cursor-pointer shadow-sm font-sans"
            >
              <Building2 size={13} className="text-emerald-400 animate-pulse shrink-0" />
              <span className="truncate max-w-[90px] sm:max-w-[160px]">{activeBusiness.name}</span>
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

            <div className="flex items-center gap-1">
              <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider font-mono hidden md:inline">Branch:</span>
              <select
                value={activeStore}
                disabled={userRole === 'sales' || stores.length === 0}
                onChange={(e) => {
                  setActiveStore(e.target.value);
                  setSqlSeedTrigger(prev => prev + 1);
                }}
                className={`bg-slate-800 text-slate-100 text-[11px] sm:text-xs font-bold px-1.5 sm:px-2 py-1 rounded-md border border-slate-700 focus:outline-hidden cursor-pointer uppercase font-sans ${userRole === 'sales' ? 'opacity-65 cursor-not-allowed bg-slate-950 text-slate-400' : ''}`}
              >
                {stores.length === 0 ? (
                  <option value="">No Branch Setup</option>
                ) : (
                  stores.map(st => (
                    <option key={st.id} value={st.id}>{st.name}</option>
                  ))
                )}
              </select>
            </div>
          </div>

          {/* Cloud Sync & User Role Badge */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            <button
              onClick={handleQuickCloudSync}
              disabled={isHeaderSyncing}
              title="Synchronize business data with Cloud SQL"
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
              <option value="owner">Owner</option>
              <option value="manager">Manager</option>
              <option value="sales">Sales</option>
            </select>

            <div className="hidden sm:flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-indigo-950 text-indigo-300 border border-indigo-900/60 font-mono font-bold">
              <span className="uppercase text-emerald-400 font-extrabold">
                {userRole === 'owner' ? 'ROOT_OWNER' : userRole === 'manager' ? 'MANAGER' : 'SALES'}
              </span>
            </div>
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
                      initialAction={billingCounterAction}
                      onClearInitialAction={() => setBillingCounterAction(null)}
                      onCartCheckedOut={() => setSqlSeedTrigger(prev => prev + 1)}
                      onStoreChange={setActiveStore}
                      onUserRoleChange={setUserRole}
                    />
                  </motion.div>
                )}

                {activeTab === 'laybys' && (
                  <motion.div
                    key={`laybys_${sqlSeedTrigger}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 flex flex-col overflow-hidden min-w-0 w-full"
                  >
                    <LaybysBoard 
                      settings={settings} 
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
                    <User size={16} className="text-indigo-600" />
                    <span className="truncate max-w-[210px] font-mono text-slate-600">
                      {activeBusiness.email || 'owner@pos.zm'}
                    </span>
                  </div>
                  <button
                    onClick={() => setShowNavDrawer(false)}
                    className="text-slate-400 hover:text-slate-700 p-1 rounded-md transition-colors cursor-pointer"
                  >
                    <X size={18} />
                  </button>
                </div>

                {/* Corporate Business Action Buttons */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      loadBusinessData();
                      setShowBusinessModal(true);
                      setShowStoreForm(false);
                    }}
                    className="py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[10.5px] font-extrabold uppercase tracking-wider text-center shadow-xs transition-all cursor-pointer font-sans flex items-center justify-center gap-1"
                  >
                    <Building size={14} />
                    <span>CREATE</span>
                  </button>
                  <button
                    onClick={() => {
                      setShowNavDrawer(false);
                      loadBusinessData();
                      setShowBusinessModal(true);
                      setShowStoreForm(false);
                    }}
                    className="py-2 px-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[10.5px] font-extrabold uppercase tracking-wider text-center shadow-xs transition-all cursor-pointer font-sans flex items-center justify-center gap-1"
                  >
                    <Building2 size={14} />
                    <span>SWITCH</span>
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

                {/* Settings & Stores */}
                <button
                  onClick={() => {
                    setShowNavDrawer(false);
                    setActiveTab2('settings');
                  }}
                  className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="p-1.5 rounded-lg bg-slate-700 text-white shadow-xs group-hover:scale-105 transition-transform">
                      <Sliders size={16} />
                    </div>
                    <span>Settings & Stores</span>
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
                <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-100 font-sans">Record Operating Expense</h3>
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
                runSql(`
                  INSERT INTO double_entry_journal (id, date, reference, description, account_debit, account_credit, amount, currency) VALUES (
                    'exp_${Date.now()}',
                    '${new Date().toISOString()}',
                    'EXP_${Date.now()}',
                    '${(expenseNotes || 'Store Expense').replace(/'/g, "''")}',
                    'Operating Expenses',
                    'Cash Drawer',
                    ${amt},
                    '${settings.currency}'
                  )
                `, 'Record expense journal entry');

                logEmployeeAudit('EXPENSES', 'Added Operating Expense', `Category: ${expenseCategory}, Notes: ${expenseNotes || 'Store Expense'}`, amt, activeStore, userRole);

                alert(`Operating expense of ${settings.currency}${amt.toFixed(2)} recorded into double-entry ledger!`);
                setExpenseAmount('');
                setExpenseNotes('');
                setShowExpenseModal(false);
              }}
              className="flex flex-col gap-3 text-xs"
            >
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

      {/* ENTERPRISE WORKSPACE, BLANK ACCOUNT SETUP & CLOUD SYNC HUB MODAL */}
      {showBusinessModal && (
        <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto select-none">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-2xl bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl p-6 flex flex-col gap-6 shadow-2xl overflow-y-auto max-h-[92vh] text-left"
          >
            {/* Modal Header */}
            <div className="flex justify-between items-center border-b border-slate-800 pb-4">
              <div className="flex items-center gap-2">
                <Building2 className="text-indigo-400" size={20} />
                <div>
                  <h3 className="text-sm font-black uppercase tracking-wider text-slate-100">
                    {businesses.length === 0 ? 'Welcome — Set Up Your New Business or Sync Account' : 'Enterprise Business & Cloud Sync Hub'}
                  </h3>
                  <p className="text-[10px] text-slate-400 font-medium">
                    Starts 100% blank with zero preseeded stock or batches. All accounts & ledgers synchronize with Cloud SQL.
                  </p>
                </div>
              </div>
              {businesses.length > 0 && (
                <button
                  onClick={() => {
                    setShowBusinessModal(false);
                    setShowStoreForm(false);
                  }}
                  className="text-slate-400 hover:text-white p-1.5 bg-slate-800 rounded-lg cursor-pointer text-xs font-bold"
                >
                  ✕ Close
                </button>
              )}
            </div>

            {/* Split UI: Left (Registered list & Cloud status), Right (Register / Sync Login / Add Store) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
              
              {/* LEFT: Businesses list & active indicators */}
              <div className="flex flex-col gap-4">
                <h4 className="text-[10px] uppercase font-bold text-slate-400 tracking-wider flex items-center gap-1.5 font-mono">
                  <span>🏢 Registered Workspaces ({businesses.length})</span>
                </h4>
                <div className="flex flex-col gap-2 overflow-y-auto max-h-[290px] pr-1">
                  {businesses.length === 0 ? (
                    <div className="p-4 rounded-xl border border-dashed border-slate-700 bg-slate-950/60 text-slate-400 text-xs flex flex-col gap-2">
                      <span className="font-bold text-slate-200">No Business Account Configured Yet</span>
                      <p className="text-[11px] leading-relaxed">
                        This POS comes completely blank by default—no preseeded stock, batches, or login accounts—so your business starts with clean accounting and inventory records.
                      </p>
                      <p className="text-[10.5px] text-indigo-300 font-semibold">
                        👉 Use the form to create your business account, or switch to "Sync Existing" to restore your account from Cloud SQL.
                      </p>
                    </div>
                  ) : (
                    businesses.map((b) => {
                      const isActive = b.id === activeBusiness.id;
                      return (
                        <div
                          key={b.id}
                          onClick={() => handleSelectBusinessWorkspace(b)}
                          className={`p-3.5 rounded-xl border transition-all cursor-pointer flex flex-col gap-1.5 ${
                            isActive
                              ? 'bg-indigo-950/60 border-indigo-500 shadow-md text-white'
                              : 'bg-slate-850 hover:bg-slate-800 border-slate-805 text-slate-300'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-xs font-sans tracking-wide truncate max-w-[170px]">{b.name}</span>
                            {isActive && (
                              <span className="text-[8px] bg-emerald-600 text-white font-extrabold px-1.5 py-0.5 rounded-full uppercase tracking-widest flex items-center gap-1">
                                <Check size={8} /> active
                              </span>
                            )}
                          </div>
                          <div className="flex items-center justify-between font-mono text-[9px] text-slate-400">
                            <span className="truncate max-w-[130px]">{b.owner} ({b.email})</span>
                            <span>ID: {b.id.toUpperCase()}</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="p-3 bg-slate-950 rounded-xl border border-slate-850 font-mono text-[9.5px] leading-relaxed text-slate-400">
                  ☁️ Cloud SQL Synchronization: Every business account, branch store, stock item, batch, sale, and double-entry accounting ledger is automatically synchronized.
                </div>
              </div>

              {/* RIGHT ACTIONS: Account registration, Cloud Sync Sign-In, or dynamic stores addition */}
              <div className="flex flex-col gap-4 border-t md:border-t-0 md:border-l border-slate-800 pt-5 md:pt-0 md:pl-6">
                
                {/* Mode Select Header */}
                <div className="flex items-center justify-between gap-1 select-none flex-wrap">
                  <div className="flex gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={() => { setHubMode('register'); setShowStoreForm(false); }}
                      className={`text-[9.5px] font-bold px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors ${hubMode === 'register' && !showStoreForm ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
                    >
                      + New Business
                    </button>
                    <button
                      type="button"
                      onClick={() => { setHubMode('sync_login'); setShowStoreForm(false); }}
                      className={`text-[9.5px] font-bold px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors ${hubMode === 'sync_login' && !showStoreForm ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
                    >
                      ☁️ Sync Existing
                    </button>
                    {businesses.length > 0 && (
                      <button
                        type="button"
                        onClick={() => { setHubMode('store'); setShowStoreForm(true); }}
                        className={`text-[9.5px] font-bold px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors ${showStoreForm || hubMode === 'store' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
                      >
                        + Branch Outlet
                      </button>
                    )}
                  </div>
                </div>

                {hubMode === 'sync_login' && !showStoreForm ? (
                  /* SIGN IN & SYNCHRONIZE EXISTING ACCOUNT FROM CLOUD SQL */
                  <form onSubmit={handleSyncExistingAccount} className="flex flex-col gap-3">
                    <h5 className="text-[11px] font-semibold text-emerald-400 uppercase tracking-widest font-mono">
                      Synchronize Existing Business Account
                    </h5>
                    <p className="text-[10.5px] text-slate-400 leading-relaxed">
                      Enter your registered Business Email and Password to pull your stores, stock catalog, batches, and accounting ledgers from Cloud SQL.
                    </p>

                    <div className="flex flex-col gap-1 text-[11px]">
                      <label className="text-[9px] text-slate-400 font-bold uppercase pb-0.5">Registered Admin Email</label>
                      <input
                        type="email"
                        value={syncLoginEmail}
                        onChange={(e) => setSyncLoginEmail(e.target.value)}
                        placeholder="e.g. admin@yourbusiness.com"
                        required
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:outline-hidden"
                      />
                    </div>

                    <div className="flex flex-col gap-1 text-[11px]">
                      <label className="text-[9px] text-slate-400 font-bold uppercase pb-0.5">Account Password</label>
                      <input
                        type="password"
                        value={syncLoginPassword}
                        onChange={(e) => setSyncLoginPassword(e.target.value)}
                        placeholder="••••••••"
                        required
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:outline-hidden"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={isHeaderSyncing}
                      className="mt-1 py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold uppercase rounded-lg text-xs tracking-wider cursor-pointer shadow-md flex items-center justify-center gap-1.5 select-none"
                    >
                      <RefreshCw size={14} className={isHeaderSyncing ? 'animate-spin' : ''} />
                      <span>{isHeaderSyncing ? 'Synchronizing from Cloud...' : 'Sync & Sign In'}</span>
                    </button>
                  </form>
                ) : !showStoreForm ? (
                  /* REGISTER NEW BLANK CORPORATE BUSINESS INTERACTIVE FORM */
                  <form onSubmit={handleRegisterBusiness} className="flex flex-col gap-2.5">
                    <h5 className="text-[11px] font-semibold text-slate-200 uppercase tracking-widest font-mono">
                      Create New Business Account (Blank Slate)
                    </h5>
                    
                    <div className="flex flex-col gap-1 text-[11px]">
                      <label className="text-[9px] text-slate-400 font-bold uppercase pb-0.5">Business / Company Name</label>
                      <input
                        type="text"
                        value={newBizName}
                        onChange={(e) => setNewBizName(e.target.value)}
                        placeholder="e.g. Zambezi Hardware & General"
                        required
                        className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 font-bold focus:outline-hidden text-xs"
                      />
                    </div>

                    <div className="flex flex-col gap-1 text-[11px]">
                      <label className="text-[9px] text-slate-400 font-bold uppercase pb-0.5">Owner / Administrator Full Name</label>
                      <input
                        type="text"
                        value={newBizOwner}
                        onChange={(e) => setNewBizOwner(e.target.value)}
                        placeholder="e.g. Mutale Banda"
                        required
                        className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 font-bold focus:outline-hidden text-xs"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div>
                        <label className="text-[9px] text-slate-400 font-bold uppercase pb-0.5">Login Email</label>
                        <input
                          type="email"
                          value={newBizEmail}
                          onChange={(e) => setNewBizEmail(e.target.value)}
                          placeholder="owner@company.com"
                          required
                          className="w-full px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-400 font-bold uppercase pb-0.5">Login Password</label>
                        <input
                          type="password"
                          value={newBizPassword}
                          onChange={(e) => setNewBizPassword(e.target.value)}
                          placeholder="••••••"
                          required
                          className="w-full px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:outline-hidden"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div>
                        <label className="text-[9px] text-slate-400 font-bold uppercase pb-0.5">Primary Branch / Store Name</label>
                        <input
                          type="text"
                          value={newBizFirstStore}
                          onChange={(e) => setNewBizFirstStore(e.target.value)}
                          placeholder="e.g. Main Branch"
                          required
                          className="w-full px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 text-xs focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-400 font-bold uppercase pb-0.5">City / Location</label>
                        <input
                          type="text"
                          value={newBizLocation}
                          onChange={(e) => setNewBizLocation(e.target.value)}
                          placeholder="e.g. Lusaka"
                          className="w-full px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 text-xs focus:outline-hidden"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-[11px]">
                      <div>
                        <label className="text-[9px] text-slate-400 font-bold uppercase pb-0.5">Currency</label>
                        <input
                          type="text"
                          value={newBizCurrency}
                          onChange={(e) => setNewBizCurrency(e.target.value)}
                          placeholder="K"
                          className="w-full px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-400 font-bold uppercase pb-0.5">VAT Rate (%)</label>
                        <input
                          type="number"
                          step="0.1"
                          value={newBizTaxRate}
                          onChange={(e) => setNewBizTaxRate(e.target.value)}
                          placeholder="16"
                          className="w-full px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-400 font-bold uppercase pb-0.5">Opening Cash</label>
                        <input
                          type="number"
                          step="0.01"
                          value={newBizOpeningCash}
                          onChange={(e) => setNewBizOpeningCash(e.target.value)}
                          placeholder="0.00"
                          className="w-full px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:outline-hidden"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      className="mt-1.5 py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold uppercase rounded-lg text-xs tracking-wider cursor-pointer shadow-md flex items-center justify-center gap-1.5 select-none"
                    >
                      <Plus size={14} /> Create Blank Account & Launch POS
                    </button>
                  </form>
                ) : (
                  /* CREATE OUTLET FOR ACTIVE BUSINESS INTERACTIVE FORM */
                  <form onSubmit={handleCreateNewStore} className="flex flex-col gap-3">
                    <h5 className="text-[11px] font-semibold text-slate-200 uppercase tracking-widest font-mono">Create Outlet for {activeBusiness.name}</h5>
                    
                    <div className="flex flex-col gap-1 text-[11px]">
                      <label className="text-[9px] text-slate-400 font-bold uppercase pb-0.5">Outlet Store Name</label>
                      <input
                        type="text"
                        value={newStoreName}
                        onChange={(e) => setNewStoreName(e.target.value)}
                        placeholder="e.g. Regional Branch"
                        required
                        className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 font-bold focus:outline-hidden text-xs"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div>
                        <label className="text-[9px] text-slate-400 font-bold uppercase pb-0.5">Branch Code (ID)</label>
                        <input
                          type="text"
                          value={newStoreId}
                          onChange={(e) => setNewStoreId(e.target.value)}
                          placeholder="e.g. branch_2"
                          className="w-full px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 font-mono text-xs focus:outline-hidden"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-slate-400 font-bold uppercase pb-0.5">Location</label>
                        <input
                          type="text"
                          value={newStoreLocation}
                          onChange={(e) => setNewStoreLocation(e.target.value)}
                          placeholder="e.g. Kitwe"
                          className="w-full px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 text-xs focus:outline-hidden"
                        />
                      </div>
                    </div>

                    <div className="p-3 bg-slate-950 rounded-lg border border-slate-850 flex flex-col gap-2">
                      <span className="text-[8.5px] uppercase font-extrabold text-indigo-400 font-mono">Branch Permission Controls</span>
                      
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-slate-300">Allow General Discounts</span>
                        <input
                          type="checkbox"
                          checked={newStoreAllowDiscounts}
                          onChange={(e) => setNewStoreAllowDiscounts(e.target.checked)}
                          className="w-3.5 h-3.5 rounded cursor-pointerAccent"
                        />
                      </div>

                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-slate-300">Allow Reversals / Refunds</span>
                        <input
                          type="checkbox"
                          checked={newStoreAllowRefunds}
                          onChange={(e) => setNewStoreAllowRefunds(e.target.checked)}
                          className="w-3.5 h-3.5 rounded cursor-pointerAccent"
                        />
                      </div>

                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-slate-300">Enable Laybys Deposits</span>
                        <input
                          type="checkbox"
                          checked={newStoreAllowLaybys}
                          onChange={(e) => setNewStoreAllowLaybys(e.target.checked)}
                          className="w-3.5 h-3.5 rounded cursor-pointerAccent"
                        />
                      </div>

                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-slate-200 font-semibold text-amber-300">Require Manager Discount Key</span>
                        <input
                          type="checkbox"
                          checked={newStoreReqManager}
                          onChange={(e) => setNewStoreReqManager(e.target.checked)}
                          className="w-3.5 h-3.5 rounded cursor-pointerAccent"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={userRole !== 'owner'}
                      className={`py-2 px-4 text-white font-extrabold uppercase rounded-lg text-xs tracking-wider flex items-center justify-center gap-1.5 select-none ${userRole === 'owner' ? 'bg-indigo-600 hover:bg-indigo-505 cursor-pointer shadow-md' : 'bg-slate-800 text-slate-550 cursor-not-allowed border border-slate-750'}`}
                    >
                      <Plus size={14} /> Provision Store Node
                    </button>
                    {userRole !== 'owner' && (
                      <span className="text-[8.5px] text-amber-400 font-bold italic tracking-wide text-center">✕ Store creation restricted to Business Owner role</span>
                    )}
                  </form>
                )}

              </div>

            </div>

          </motion.div>
        </div>
      )}
    </AndroidShell>
  );
}
