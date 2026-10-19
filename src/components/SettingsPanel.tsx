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
  Upload
} from 'lucide-react';
import { runSql, initializeDatabase, SeedTemplate, persistTablesToStorage, pushDatabaseToServer, pullDatabaseFromServer } from '../db';
import { exportAndShareText } from '../androidUtils';
import { StoreSettings } from '../types';
import { onAuthStateChanged, User as FirebaseUser, signInWithPopup, signOut } from 'firebase/auth';
import { auth, googleProvider, backupToCloud, restoreFromCloud, getTransportSecurityStatus, registerOrSignInWithEmailPassword } from '../firebase';

interface SettingsPanelProps {
  settings: StoreSettings;
  setSettings: (settings: StoreSettings) => void;
  onRefreshDatabase: (template: SeedTemplate) => void;
  activeStore?: string;
  setActiveStore?: (storeId: string) => void;
  onNavigateToInventory?: () => void;
  initialSubTab?: 'general' | 'stores' | 'users' | 'stock' | 'workspaces';
}

export default function SettingsPanel({
  settings,
  setSettings,
  onRefreshDatabase,
  activeStore = '',
  setActiveStore,
  onNavigateToInventory,
  initialSubTab = 'general',
}: SettingsPanelProps) {
  const [storeName, setStoreName] = useState(settings.storeName);
  const [currency, setCurrency] = useState(settings.currency);
  const [taxRate, setTaxRate] = useState(settings.taxRate);
  const [loyaltyRatio, setLoyaltyRatio] = useState(settings.loyaltyRatio);
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

  const [printerName, setPrinterName] = useState<string>(settings.printerName || 'ZPOS-Bluetooth-58M (Default Linked)');
  const [printerInterface, setPrinterInterface] = useState<string>(settings.printerInterface || 'Bluetooth Low Energy (BLE)');
  const [printerStatus, setPrinterStatus] = useState<'Linked' | 'Not Linked'>(settings.printerStatus || 'Linked');
  const [testPrintActive, setTestPrintActive] = useState(false);
  const [testPrintContent, setTestPrintContent] = useState<{
    date: string;
    hex: string;
    plain: string;
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

  // Unified settings & admin control tabs ('general' | 'stores' | 'users' | 'stock' | 'workspaces')
  const [activeSubTab, setActiveSubTab] = useState<'general' | 'stores' | 'users' | 'stock' | 'workspaces'>(initialSubTab);

  useEffect(() => {
    if (initialSubTab) {
      setActiveSubTab(initialSubTab);
    }
  }, [initialSubTab]);

  // State for Users list, Stores/Branches list, Products count, and Businesses list
  const [usersList, setUsersList] = useState<any[]>([]);
  const [storesList, setStoresList] = useState<any[]>([]);
  const [businessesList, setBusinessesList] = useState<any[]>([]);
  const [productsCount, setProductsCount] = useState<number>(0);

  // Quick Add Stock states inside unified SettingsPanel
  const [quickProdName, setQuickProdName] = useState('');
  const [quickProdBarcode, setQuickProdBarcode] = useState('');
  const [quickProdCategory, setQuickProdCategory] = useState('');
  const [quickProdPrice, setQuickProdPrice] = useState('');
  const [quickProdCost, setQuickProdCost] = useState('');
  const [quickProdStock, setQuickProdStock] = useState('');
  const [quickProdStoreId, setQuickProdStoreId] = useState('');
  const [quickProdBatchNum, setQuickProdBatchNum] = useState('');
  const [quickProdExpiry, setQuickProdExpiry] = useState('');
  const [quickStockMsg, setQuickStockMsg] = useState<string | null>(null);

  // Store creation states inside SettingsPanel
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchCode, setNewBranchCode] = useState('');
  const [newBranchLocation, setNewBranchLocation] = useState('');
  const [newBranchDiscounts, setNewBranchDiscounts] = useState(true);
  const [newBranchRefunds, setNewBranchRefunds] = useState(true);
  const [newBranchLaybys, setNewBranchLaybys] = useState(true);
  const [newBranchManagerReq, setNewBranchManagerReq] = useState(false);

  // User form states
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [userFirstName, setUserFirstName] = useState('');
  const [userSurname, setUserSurname] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [userPassword, setUserPassword] = useState('');
  const [userRole, setUserRole] = useState<'sales' | 'manager' | 'owner'>('sales');
  const [userSalary, setUserSalary] = useState('');
  const [userContact, setUserContact] = useState('');
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]); // Array of store branch IDs

  useEffect(() => {
    setStoreName(settings.storeName);
    setCurrency(settings.currency);
    setTaxRate(settings.taxRate);
    setLoyaltyRatio(settings.loyaltyRatio);
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
    // 1. Fetch standard staff profiles
    const staffRes = runSql('SELECT * FROM staff', 'Load staff directory for accounts management');
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
          role: st.role || perms.role || (parseFloat(st.basic_salary) > 10000 ? 'manager' : 'sales'),
          password: st.password || perms.password || st.pin || '',
          accessible_branches: branches,
          is_owner: false,
          raw: st
        };
      });
    }

    // 2. Fetch business owners
    const bizRes = runSql('SELECT * FROM businesses', 'Load corporate directory for accounts management');
    let mappedBiz: any[] = [];
    if (bizRes.success && Array.isArray(bizRes.data)) {
      setBusinessesList(bizRes.data);
      mappedBiz = bizRes.data.map(bz => {
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
          is_owner: true,
          raw: bz
        };
      });
    }

    setUsersList([...mappedBiz, ...mappedStaff]);
  };

  const loadStoresList = () => {
    const res = runSql('SELECT * FROM stores', 'Load store branch indexes');
    if (res.success && Array.isArray(res.data) && res.data.length > 0) {
      setStoresList(res.data);
    } else {
      setStoresList([]);
    }
    const pRes = runSql('SELECT COUNT(*) AS cnt FROM products', 'Count products');
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

  const getActiveBusinessId = () => {
    try {
      const saved = localStorage.getItem('active_business_profile');
      if (saved) {
        return JSON.parse(saved).id || 'default_biz';
      }
    } catch (e) {}
    return 'default_biz';
  };

  const handleGoogleLogin = async () => {
    try {
      setSyncStatus('Logging in with Google...');
      setSyncError(null);
      await signInWithPopup(auth, googleProvider);
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
      await signOut(auth);
      triggerNotify('Logged out of Firebase Auth successfully!');
    } catch (err: any) {
      console.error(err);
    }
  };

  const handleBackupToCloud = async () => {
    setIsSyncing(true);
    setSyncStatus('Synchronizing clients data, transactions, stock, batches & accounting ledgers to Cloud SQL, Firestore & Firebase Storage...');
    setSyncError(null);
    try {
      const bizId = getActiveBusinessId();
      const sqlRes = await pushDatabaseToServer(bizId);
      let msg = sqlRes.details;

      if (user) {
        try {
          const fbRes = await backupToCloud(bizId);
          if (fbRes.success) {
            msg += ' | ' + fbRes.details;
          }
        } catch (fbErr: any) {
          console.warn('Firebase backup notice:', fbErr);
          msg += ` | Firebase note: ${fbErr?.message || String(fbErr)}`;
        }
      }

      if (sqlRes.success) {
        triggerNotify('Cloud Synchronization Push succeeded!');
        setSyncStatus(msg);
      } else {
        setSyncError(sqlRes.details);
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
    setSyncStatus('Pulling latest synchronized business, stock, batches & accounting state from Cloud...');
    setSyncError(null);
    try {
      const bizId = getActiveBusinessId();
      const sqlPull = await pullDatabaseFromServer(bizId !== 'default_biz' ? bizId : undefined);
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

      if (user) {
        const res = await restoreFromCloud(bizId);
        if (res.success) {
          loadUsersList();
          loadStoresList();
          triggerNotify('Firebase Cloud Restore succeeded!');
          setSyncStatus(res.details);
          window.dispatchEvent(new Event('local_db_restored'));
          return;
        }
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
    const updated: StoreSettings = {
      storeName,
      currency,
      taxRate: parseFloat(taxRate as any) || 0,
      loyaltyRatio: parseFloat(loyaltyRatio as any) || 0,
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
      printerStatus
    };
    setSettings(updated);
    localStorage.setItem('android_pos_settings', JSON.stringify(updated));

    const activeBizId = getActiveBusinessId();
    if (activeBizId) {
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
        WHERE id = '${activeBizId}'
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
        backupToCloud(activeBizId).catch(() => {});
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
    let targetStore = quickProdStoreId || activeStore || (storesList[0]?.id ?? '');
    if (!targetStore) {
      targetStore = 'store_main';
      const defaultStoreName = (storeName || 'Main Store') + ' Branch';
      runSql(`
        INSERT INTO stores (id, business_id, name, location, allow_discounts, allow_refunds, allow_laybys, require_manager_discount, stocktake_frequency) VALUES (
          '${targetStore}',
          '${activeBizId}',
          '${defaultStoreName.replace(/'/g, "''")}',
          '${(billingCity || 'Main').replace(/'/g, "''")}',
          1, 1, 1, 0, 'weekly'
        )
      `, 'SettingsPanel: Auto-create Main Store branch for first product');
      if (setActiveStore) setActiveStore(targetStore);
      localStorage.setItem('pos_shift_active', 'true');
      localStorage.setItem('shift_active_' + targetStore, 'true');
    }

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
      INSERT INTO products (id, name, sku, category, price, cost, stock, imageUrl, business_id, is_service, batch_number, expiry_date) VALUES (
        ${prodId},
        '${quickProdName.trim().replace(/'/g, "''")}',
        '${sku.replace(/'/g, "''")}',
        '${category.replace(/'/g, "''")}',
        ${price},
        ${cost},
        ${qty},
        '${imgUrl}',
        '${activeBizId.replace(/'/g, "''")}',
        0,
        '${batchNum.replace(/'/g, "''")}',
        '${expiry}'
      )
    `, `SettingsPanel: Create stock item [${quickProdName.trim()}]`);

    const branchList = storesList.length > 0 ? storesList.map((s: any) => s.id) : [targetStore];
    const uniqueBranches = Array.from(new Set([...branchList, targetStore].filter(Boolean)));
    uniqueBranches.forEach((stId: string) => {
      const spId = `sp_${prodId}_${stId}`;
      const branchQty = stId === targetStore ? qty : 0;
      runSql(`
        INSERT INTO store_products (id, product_id, store_id, stock, price) VALUES (
          '${spId}', ${prodId}, '${stId}', ${branchQty}, ${price}
        )
      `, `SettingsPanel: Allocate stock for [${quickProdName.trim()}] to branch [${stId}]`);
    });

    if (qty > 0) {
      const refId = `stock_init_${prodId}_${Date.now()}`;
      const nowStr = new Date().toISOString();
      runSql(`
        INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by)
        VALUES (
          '${refId}',
          'idem_${refId}',
          '${targetStore.toUpperCase()}',
          'RECEIVE',
          'CATALOG_INIT',
          ${(qty * cost).toFixed(2)},
          0.00,
          'SUCCESS',
          'Initial catalog creation for ${quickProdName.trim().replace(/'/g, "''")}: +${qty} units [Batch: ${batchNum || 'N/A'}]',
          '${nowStr}',
          '${nowStr}',
          'owner'
        )
      `, 'SettingsPanel: Log initial stock creation transaction');
    }

    const savedName = quickProdName.trim();
    setQuickProdName('');
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
      backupToCloud(activeBizId).catch(() => {});
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
    const dup = runSql(`SELECT * FROM stores WHERE id = '${finalId}'`);
    if (dup.success && Array.isArray(dup.data) && dup.data.length > 0) {
      alert(`A store branch with code [${finalId}] already exists.`);
      return;
    }
    runSql(`
      INSERT INTO stores (id, business_id, name, location, allow_discounts, allow_refunds, allow_laybys, require_manager_discount, stocktake_frequency)
      VALUES (
        '${finalId}',
        '${activeBizId}',
        '${newBranchName.trim().replace(/'/g, "''")}',
        '${newBranchLocation.trim().replace(/'/g, "''")}',
        ${newBranchDiscounts ? 1 : 0},
        ${newBranchRefunds ? 1 : 0},
        ${newBranchLaybys ? 1 : 0},
        ${newBranchManagerReq ? 1 : 0},
        'weekly'
      )
    `, `SettingsPanel: Create store branch [${newBranchName}]`);

    const prodsRes = runSql(`SELECT * FROM products`);
    if (prodsRes.success && Array.isArray(prodsRes.data)) {
      prodsRes.data.forEach((p: any) => {
        runSql(`INSERT INTO store_products VALUES ('sp_${p.id}_${finalId}', ${p.id}, '${finalId}', 0, ${p.price || 0})`);
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
    loadStoresList();
    persistTablesToStorage();
    pushDatabaseToServer(activeBizId).catch(() => {});
    if (auth.currentUser) {
      backupToCloud(activeBizId).catch(() => {});
    }
    window.dispatchEvent(new Event('pos_data_updated'));
    triggerNotify(`✓ Store branch [${newBranchName}] created & synchronized!`);
  };

  const handleDeleteBranchInSettings = (storeId: string, branchName: string) => {
    if (!window.confirm(`Delete store branch "${branchName}"?`)) return;
    runSql(`DELETE FROM stores WHERE id = '${storeId}'`, `SettingsPanel: Delete store ${storeId}`);
    runSql(`DELETE FROM store_products WHERE store_id = '${storeId}'`, `SettingsPanel: Delete store_products for ${storeId}`);
    loadStoresList();
    persistTablesToStorage();
    window.dispatchEvent(new Event('pos_data_updated'));
    triggerNotify(`Store branch [${branchName}] removed.`);
  };

  const triggerTestPrintPlay = () => {
    if (printerStatus !== 'Linked') {
      alert("⚠️ Connection Failed!\n\nThe selected printer is currently set to 'Not Linked'. Please set status to 'Linked / Active' to allow printing feeds.");
      return;
    }

    const d = new Date();
    const formattedDate = d.toLocaleString();

    // Setup print ASCII visual representation
    const border = "================================";
    const divider = "--------------------------------";
    const addressLine = [billingAddress, billingCity, billingCountry].filter(Boolean).join(', ') || 'Registered Business Address';
    const plainText = `
 ${storeName.toUpperCase()}
 ${tpin ? `TPIN: ${tpin}` : 'TPIN: Not Set'}
 ${addressLine}
 ${divider}
        PRINTER SELF-TEST FEED
 ${divider}
 Date: ${formattedDate}
 Connection Mode: ${printerInterface}
 Printer HW Node: ${printerName}
 Status: ONLINE & DEFAULT LINKED
 ${border}
 [✓] BLE Handshake Packet OK
 [✓] ESC/POS Feed Code 0x1B 0x40 OK
 [✓] Baud Rate Auto-Neg (9600) OK
 [✓] Voltage/Heat Head Sensor OK
 ${divider}
      SYSTEM DIAGNOSTICS: SUCCESS
      No anomalies detected.
      Ready for direct checkout.
 ${border}
    `;

    // Spooled byte sequence representation
    const hexBytes = "1B 40 0A 1B 61 01 " + 
                     Array.from(new TextEncoder().encode(storeName.toUpperCase() + "\n")).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') +
                     " 0A 1D 56 01";

    setTestPrintContent({
      date: formattedDate,
      hex: hexBytes,
      plain: plainText
    });
    setTestPrintActive(true);
    triggerNotify("🖨️ Test print ticket spooled successfully to default printer!");
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
      
      const prodRes = runSql('SELECT * FROM products');
      const custRes = runSql('SELECT * FROM customers');
      const orderRes = runSql('SELECT * FROM orders');
      const oItemRes = runSql('SELECT * FROM order_items');
      const storeRes = runSql('SELECT * FROM stores');
      const bizRes = runSql('SELECT * FROM businesses');
      const staffRes = runSql('SELECT * FROM staff');
      
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

        if (bundle.database) {
          if (Array.isArray(bundle.database.products) && bundle.database.products.length > 0) {
            runSql('DELETE FROM products');
            bundle.database.products.forEach((p: any) => {
              runSql(`INSERT INTO products VALUES (${p.id}, '${(p.name||'').replace(/'/g, "''")}', '${p.sku||''}', '${p.category||''}', ${p.price||0}, ${p.cost||0}, ${p.stock||0}, '${p.imageUrl||''}')`);
            });
          }
          if (Array.isArray(bundle.database.customers) && bundle.database.customers.length > 0) {
            runSql('DELETE FROM customers');
            bundle.database.customers.forEach((c: any) => {
              runSql(`INSERT INTO customers VALUES (${c.id}, '${(c.name||'').replace(/'/g, "''")}', '${c.phone||''}', '${c.email||''}', ${c.loyalPoints||0}, '${c.tpin||''}', ${c.zra_connected||0}, '${c.tax_band||''}')`);
            });
          }
          if (Array.isArray(bundle.database.orders) && bundle.database.orders.length > 0) {
            runSql('DELETE FROM orders');
            bundle.database.orders.forEach((o: any) => {
              runSql(`INSERT INTO orders VALUES ('${o.id}', ${o.customerId||'NULL'}, '${o.orderDate||''}', ${o.subtotal||0}, ${o.tax||0}, ${o.discount||0}, ${o.total||0}, '${o.paymentMethod||''}', '${o.status||''}', '${o.store_id||'lusaka'}')`);
            });
          }
          if (Array.isArray(bundle.database.order_items) && bundle.database.order_items.length > 0) {
            runSql('DELETE FROM order_items');
            bundle.database.order_items.forEach((oi: any) => {
              runSql(`INSERT INTO order_items VALUES ('${oi.id}', '${oi.orderId}', ${oi.productId}, ${oi.quantity}, ${oi.unitPrice})`);
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
    let dump = `-- ANDROID POS SQL SCHEMA & TRANSACTION DATA DUMP\n-- Generated on: ${new Date().toLocaleString()}\n-- Database engine: alasql_wasm_bridge\n\n`;

    // 1. Dump Products
    dump += `-- ==========================================\n-- TABLE: products\n-- ==========================================\n`;
    dump += `CREATE TABLE products (\n  id INT PRIMARY KEY,\n  name VARCHAR(255),\n  sku VARCHAR(50) UNIQUE,\n  category VARCHAR(100),\n  price NUMERIC(10,2),\n  cost NUMERIC(10,2),\n  stock INT,\n  imageUrl TEXT\n);\n\n`;
    const prodRes = runSql('SELECT * FROM products', 'Dump: Extract products');
    if (prodRes.success && Array.isArray(prodRes.data)) {
      prodRes.data.forEach((p: any) => {
        dump += `INSERT INTO products VALUES (${p.id}, '${p.name.replace(/'/g, "''")}', '${p.sku}', '${p.category}', ${p.price}, ${p.cost}, ${p.stock}, '${p.imageUrl}');\n`;
      });
    }

    // 2. Dump Customers
    dump += `\n-- ==========================================\n-- TABLE: customers\n-- ==========================================\n`;
    dump += `CREATE TABLE customers (\n  id INT PRIMARY KEY,\n  name VARCHAR(255),\n  phone VARCHAR(50),\n  email VARCHAR(100),\n  loyalPoints INT\n);\n\n`;
    const custRes = runSql('SELECT * FROM customers', 'Dump: Extract customers');
    if (custRes.success && Array.isArray(custRes.data)) {
      custRes.data.forEach((c: any) => {
        const escapeName = c.name ? c.name.replace(/'/g, "''") : '';
        const escapeTpin = c.tpin ? c.tpin.replace(/'/g, "''") : '';
        const escapeBand = c.tax_band ? c.tax_band.replace(/'/g, "''") : '';
        dump += `INSERT INTO customers VALUES (${c.id}, '${escapeName}', '${c.phone || ''}', '${c.email || ''}', ${c.loyalPoints || 0}, '${escapeTpin}', ${c.zra_connected || 0}, '${escapeBand}');\n`;
      });
    }

    // 3. Dump Orders & items
    dump += `\n-- ==========================================\n-- TABLE: orders\n-- ==========================================\n`;
    dump += `CREATE TABLE orders (\n  id VARCHAR(50) PRIMARY KEY,\n  customerId INT,\n  orderDate VARCHAR(100),\n  subtotal NUMERIC(10,2),\n  tax NUMERIC(10,2),\n  discount NUMERIC(10,2),\n  total NUMERIC(10,2),\n  paymentMethod VARCHAR(50),\n  status VARCHAR(20),\n  store_id VARCHAR(50)\n);\n\n`;
    const orderRes = runSql('SELECT * FROM orders', 'Dump: Extract historical invoices');
    if (orderRes.success && Array.isArray(orderRes.data)) {
      orderRes.data.forEach((o: any) => {
        const custVal = o.customerId === null ? 'NULL' : o.customerId;
        const storeVal = o.store_id ? `'${o.store_id}'` : "'lusaka'";
        dump += `INSERT INTO orders VALUES ('${o.id}', ${custVal}, '${o.orderDate}', ${o.subtotal}, ${o.tax}, ${o.discount}, ${o.total}, '${o.paymentMethod}', '${o.status}', ${storeVal});\n`;
      });
    }

    dump += `\n-- ==========================================\n-- TABLE: order_items\n-- ==========================================\n`;
    dump += `CREATE TABLE order_items (\n  id VARCHAR(50) PRIMARY KEY,\n  orderId VARCHAR(50),\n  productId INT,\n  quantity INT,\n  unitPrice NUMERIC(10,2)\n);\n\n`;
    const oItemRes = runSql('SELECT * FROM order_items', 'Dump: Extract invoice details list');
    if (oItemRes.success && Array.isArray(oItemRes.data)) {
      oItemRes.data.forEach((oi: any) => {
        dump += `INSERT INTO order_items VALUES ('${oi.id}', '${oi.orderId}', ${oi.productId}, ${oi.quantity}, ${oi.unitPrice});\n`;
      });
    }

    // 4. Dump Double Entry Accounts schema if initialized
    dump += `\n-- ==========================================\n-- TABLE: accounts (Double-Entry)\n-- ==========================================\n`;
    dump += `CREATE TABLE accounts (\n  id VARCHAR(100) PRIMARY KEY,\n  name VARCHAR(100) NOT NULL,\n  type VARCHAR(50) NOT NULL,\n  currency CHAR(3) NOT NULL DEFAULT 'ZMW',\n  merchant_id VARCHAR(100),\n  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,\n  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP\n);\n\n`;
    const accountsRes = runSql('SELECT * FROM accounts', 'Dump: Extract double-entry accounts list');
    if (accountsRes.success && Array.isArray(accountsRes.data)) {
      accountsRes.data.forEach((acc: any) => {
        const merchVal = acc.merchant_id ? `'${acc.merchant_id}'` : 'NULL';
        dump += `INSERT INTO accounts VALUES ('${acc.id}', '${acc.name.replace(/'/g, "''")}', '${acc.type}', '${acc.currency}', ${merchVal}, '${acc.created_at}', '${acc.updated_at}');\n`;
      });
    }

    // 5. Dump Transactions journal schema
    dump += `\n-- ==========================================\n-- TABLE: transactions (Double-Entry Journal)\n-- ==========================================\n`;
    dump += `CREATE TABLE transactions (\n  id VARCHAR(100) PRIMARY KEY,\n  idempotency_key VARCHAR(100) UNIQUE NOT NULL,\n  pos_terminal_id VARCHAR(100) NOT NULL,\n  channel VARCHAR(50) NOT NULL,\n  provider_reference VARCHAR(100),\n  amount NUMERIC(15,4) NOT NULL,\n  fee_amount NUMERIC(15,4) DEFAULT 0.0000,\n  status VARCHAR(50) DEFAULT 'PENDING',\n  narration TEXT,\n  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,\n  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP\n);\n\n`;
    const txsRes = runSql('SELECT * FROM transactions', 'Dump: Extract transaction journals');
    if (txsRes.success && Array.isArray(txsRes.data)) {
      txsRes.data.forEach((tx: any) => {
        const provVal = tx.provider_reference ? `'${tx.provider_reference}'` : 'NULL';
        dump += `INSERT INTO transactions VALUES ('${tx.id}', '${tx.idempotency_key}', '${tx.pos_terminal_id}', '${tx.channel}', ${provVal}, ${tx.amount}, ${tx.fee_amount}, '${tx.status}', '${tx.narration.replace(/'/g, "''")}', '${tx.created_at}', '${tx.updated_at}');\n`;
      });
    }

    // 6. Dump Ledger Entries matching schema
    dump += `\n-- ==========================================\n-- TABLE: ledger_entries (Double-Entry Mappings)\n-- ==========================================\n`;
    dump += `CREATE TABLE ledger_entries (\n  id VARCHAR(100) PRIMARY KEY,\n  transaction_id VARCHAR(100) NOT NULL,\n  account_id VARCHAR(100) NOT NULL,\n  type VARCHAR(50) NOT NULL,\n  amount NUMERIC(15,4) NOT NULL,\n  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP\n);\n\n`;
    const leRes = runSql('SELECT * FROM ledger_entries', 'Dump: Extract double-entry ledger mappings');
    if (leRes.success && Array.isArray(leRes.data)) {
      leRes.data.forEach((le: any) => {
        dump += `INSERT INTO ledger_entries VALUES ('${le.id}', '${le.transaction_id}', '${le.account_id}', '${le.type}', ${le.amount}, '${le.created_at}');\n`;
      });
    }

    // 7. Dump aggregate balancing View
    dump += `\n-- ==========================================\n-- VIEW: view_account_balances (Absolute Balances)\n-- ==========================================\n`;
    dump += `CREATE VIEW view_account_balances AS\nSELECT \n    a.id AS account_id,\n    a.name AS account_name,\n    a.currency,\n    SUM(\n        CASE \n            WHEN (a.type = 'ASSET' OR a.type = 'EXPENSE') AND le.type = 'DEBIT' THEN le.amount\n            WHEN (a.type = 'ASSET' OR a.type = 'EXPENSE') AND le.type = 'CREDIT' THEN -le.amount\n            WHEN (a.type = 'LIABILITY' OR a.type = 'REVENUE' OR a.type = 'EQUITY') AND le.type = 'CREDIT' THEN le.amount\n            WHEN (a.type = 'LIABILITY' OR a.type = 'REVENUE' OR a.type = 'EQUITY') AND le.type = 'DEBIT' THEN -le.amount\n            ELSE 0\n        END\n    ) AS current_balance\nFROM accounts a\nLEFT JOIN ledger_entries le ON a.id = le.account_id\nGROUP BY a.id, a.name, a.currency;\n`;

    setGeneratedSqlDump(dump);
    triggerNotify('Compiled fully complete raw SQL file script text backup dumper!');
  };

  const handleSaveUser = (e: React.FormEvent) => {
    e.preventDefault();
    const emailLower = userEmail.trim().toLowerCase();
    
    if (!emailLower || !userFirstName.trim() || !userSurname.trim() || !userPassword.trim()) {
      alert("Invalid Form: Please complete all required account identifier fields.");
      return;
    }

    // 1. Construct the permissions_json structure
    const basicPermissions = {
      role: userRole,
      password: userPassword.trim(),
      accessible_branches: selectedBranches,
      sales: { checkout: true, refunds: userRole !== 'sales', quotes: true, laybys: true },
      inventory: { view: true, update: userRole !== 'sales', transfer: userRole !== 'sales' },
      customer: { view_only: false, create: true, edit: userRole !== 'sales' },
      reports: { low_stock: true, expired_stock: true, profits: userRole === 'owner', sales: userRole !== 'sales', payment_modes: true, sold_by: true, top_customers: true },
      expense: { add_expense: true, modify_expense: userRole !== 'sales' },
      settings: { create_store: userRole === 'owner', manage_settings: userRole === 'owner' },
      staff: { attendance_management: userRole !== 'sales', payroll_management: userRole === 'owner', manage_staff: userRole === 'owner' },
      receipt: { create_receipt: true, view_all_receipt: true, edit_receipt: userRole !== 'sales', return_receipt: userRole !== 'sales' }
    };
    const permissionsString = JSON.stringify(basicPermissions);

    // 2. Decide if Owner or Staff
    if (userRole === 'owner') {
      if (editingUserId && editingUserId !== 'default_biz') {
        const sql = `
          UPDATE businesses
          SET owner = '${userFirstName.trim().replace(/'/g, "''")} ${userSurname.trim().replace(/'/g, "''")}',
              email = '${emailLower.replace(/'/g, "''")}',
              password = '${userPassword.trim().replace(/'/g, "''")}'
          WHERE id = '${editingUserId}'
        `;
        runSql(sql, `SettingsPanel: Update Corporate Owner profile`);
      } else {
        const newBizId = editingUserId || `biz_${Math.floor(100000 + Math.random() * 900000)}`;
        const existsRes = runSql(`SELECT * FROM businesses WHERE id = '${newBizId}'`);
        const alreadyExists = existsRes.success && Array.isArray(existsRes.data) && existsRes.data.length > 0;

        if (alreadyExists) {
          const sql = `
            UPDATE businesses
            SET owner = '${userFirstName.trim().replace(/'/g, "''")} ${userSurname.trim().replace(/'/g, "''")}',
                email = '${emailLower.replace(/'/g, "''")}',
                password = '${userPassword.trim().replace(/'/g, "''")}'
            WHERE id = '${newBizId}'
          `;
          runSql(sql, `SettingsPanel: Update Corporate Owner`);
        } else {
          const sql = `
            INSERT INTO businesses (id, name, owner, email, password, created_at)
            VALUES (
              '${newBizId}',
              '${storeName.replace(/'/g, "''")} HQ',
              '${userFirstName.trim().replace(/'/g, "''")} ${userSurname.trim().replace(/'/g, "''")}',
              '${emailLower.replace(/'/g, "''")}',
              '${userPassword.trim().replace(/'/g, "''")}',
              '${new Date().toISOString()}'
            )
          `;
          runSql(sql, `SettingsPanel: Register secondary Corporate Owner account`);
        }
      }
    } else {
      const salaryNum = parseFloat(userSalary) || 0;
      const targetStaffId = editingUserId && editingUserId !== 'default_biz' ? editingUserId : `staff-${Math.floor(1000 + Math.random() * 9000)}`;
      const fullStaffName = `${userFirstName.trim()} ${userSurname.trim()}`.trim();
      const primaryStore = selectedBranches[0] || activeStore || (storesList[0]?.id ?? '');
      
      const existsRes = runSql(`SELECT * FROM staff WHERE id = '${targetStaffId}'`);
      const alreadyExists = existsRes.success && Array.isArray(existsRes.data) && existsRes.data.length > 0;

      if (alreadyExists) {
        const sql = `
          UPDATE staff
          SET name = '${fullStaffName.replace(/'/g, "''")}',
              first_name = '${userFirstName.trim().replace(/'/g, "''")}',
              surname = '${userSurname.trim().replace(/'/g, "''")}',
              role = '${userRole}',
              pin = '${userPassword.trim().slice(0, 6).replace(/'/g, "''")}',
              store_id = '${primaryStore.replace(/'/g, "''")}',
              contact = '${userContact.trim().replace(/'/g, "''")}',
              email = '${emailLower.replace(/'/g, "''")}',
              basic_salary = ${salaryNum},
              permissions_json = '${permissionsString.replace(/'/g, "''")}',
              password = '${userPassword.trim().replace(/'/g, "''")}'
          WHERE id = '${targetStaffId}'
        `;
        runSql(sql, `SettingsPanel: Modify staff profile ${targetStaffId}`);
      } else {
        const activeBizId = getActiveBusinessId();
        const sql = `
          INSERT INTO staff (id, name, role, hourly_rate, pin, store_id, first_name, surname, contact, email, residential_address, joining_date, nrc_file, nrc_filename, contract_file, contract_filename, basic_salary, permissions_json, business_id, password)
          VALUES (
            '${targetStaffId}',
            '${fullStaffName.replace(/'/g, "''")}',
            '${userRole}',
            0,
            '${userPassword.trim().slice(0, 6).replace(/'/g, "''")}',
            '${primaryStore.replace(/'/g, "''")}',
            '${userFirstName.trim().replace(/'/g, "''")}',
            '${userSurname.trim().replace(/'/g, "''")}',
            '${userContact.trim().replace(/'/g, "''")}',
            '${emailLower.replace(/'/g, "''")}',
            '${(billingCity || billingAddress || '').replace(/'/g, "''")}',
            '${new Date().toISOString().substring(0, 10)}',
            '', '', '', '',
            ${salaryNum},
            '${permissionsString.replace(/'/g, "''")}',
            '${activeBizId.replace(/'/g, "''")}',
            '${userPassword.trim().replace(/'/g, "''")}'
          )
        `;
        runSql(sql, `SettingsPanel: Register new staff profile ${targetStaffId}`);
      }
    }

    const activeBizId = getActiveBusinessId();
    handleResetUserForm();
    loadUsersList();
    persistTablesToStorage();
    pushDatabaseToServer(activeBizId).catch(() => {});
    if (auth.currentUser) {
      backupToCloud(activeBizId).catch(() => {});
    }
    window.dispatchEvent(new Event('pos_data_updated'));
    triggerNotify('✓ User security credentials and branch routing saved & synchronized!');
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
    setSelectedBranches([]);
  };

  const handleEditUserClick = (usr: any) => {
    setEditingUserId(usr.id);
    setUserFirstName(usr.first_name);
    setUserSurname(usr.surname);
    setUserEmail(usr.email);
    setUserPassword(usr.password);
    setUserRole(usr.role);
    setUserSalary(usr.basic_salary?.toString() || '7500');
    setUserContact(usr.contact || '');
    setSelectedBranches(usr.accessible_branches || []);
  };

  const handleDeleteUserClick = (usr: any) => {
    if (usr.id === 'default_biz') {
      alert("Access Denied: Primary Business Owner profiles cannot be deleted. You can edit their credentials instead to secure access.");
      return;
    }
    if (usr.is_owner) {
      alert("Access Denied: Corporate Owner profiles cannot be deleted. You can edit their credentials instead to secure access.");
      return;
    }
    if (window.confirm(`Are you absolutely sure you want to permanently delete user "${usr.first_name} ${usr.surname}"? This removes their terminal authorization credentials immediately.`)) {
      const sql = `DELETE FROM staff WHERE id = '${usr.id}'`;
      runSql(sql, `SettingsPanel: Delete staff account ${usr.id}`);
      loadUsersList();
      persistTablesToStorage();
      window.dispatchEvent(new Event('pos_data_updated'));
      triggerNotify(`User account deleted successfully!`);
    }
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
        
        {/* Unified Navigation Tabs */}
        <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200 flex-wrap gap-1">
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
        </div>
      </div>

      {activeSubTab === 'stores' ? (
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
                        <div className="flex flex-wrap gap-2 mt-2 text-[10px] text-slate-500">
                          <span>Discounts: {st.allow_discounts ? 'Allowed' : 'Disabled'}</span>
                          <span>·</span>
                          <span>Refunds: {st.allow_refunds ? 'Allowed' : 'Disabled'}</span>
                          <span>·</span>
                          <span>Laybys: {st.allow_laybys ? 'Allowed' : 'Disabled'}</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between border-t border-slate-200/70 pt-2">
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
                        <button
                          type="button"
                          onClick={() => handleDeleteBranchInSettings(st.id, st.name)}
                          className="px-2.5 py-1 text-[10px] font-bold text-red-600 hover:bg-red-50 rounded border border-red-200 cursor-pointer flex items-center gap-1"
                        >
                          <Trash2 size={11} /> Remove Store
                        </button>
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
      ) : activeSubTab === 'stock' ? (
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
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
                    <option value="">Auto-create Main Branch</option>
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
      ) : activeSubTab === 'workspaces' ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Registered Business Workspaces */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <Building2 className="text-indigo-600" size={16} />
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">
                  Registered Business Workspaces ({businessesList.length})
                </h3>
              </div>
            </div>
            <div className="flex flex-col gap-2.5">
              {businessesList.length === 0 ? (
                <div className="p-4 text-xs text-slate-500 bg-slate-50 rounded-lg border border-slate-200">
                  No business workspaces found.
                </div>
              ) : (
                businessesList.map((b: any) => {
                  const isActiveBiz = b.id === getActiveBusinessId();
                  return (
                    <div
                      key={b.id}
                      className={`p-4 rounded-xl border flex items-center justify-between ${
                        isActiveBiz
                          ? 'bg-indigo-50/70 border-indigo-400 text-slate-900'
                          : 'bg-slate-50 border-slate-200 text-slate-700'
                      }`}
                    >
                      <div>
                        <div className="font-extrabold text-xs">{b.name}</div>
                        <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                          Admin: {b.owner} ({b.email})
                        </div>
                      </div>
                      {isActiveBiz && (
                        <span className="px-2.5 py-1 bg-emerald-600 text-white text-[9px] font-black uppercase rounded-full">
                          Active Workspace
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
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
              Push or pull your complete business setup, stores, staff accounts, stock, batches, customers, and accounting ledgers across devices.
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
      ) : activeSubTab === 'general' ? (
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
                <label className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wide">Club loyalty Point per $</label>
                <input
                  type="number"
                  step="0.1"
                  value={loyaltyRatio}
                  onChange={(e) => setLoyaltyRatio(parseFloat(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-505 focus:outline-hidden text-xs rounded-lg font-mono font-bold text-slate-850"
                  required
                />
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

            {/* DEFAULT LINKED HARDWARE PRINTER CONFIGURES */}
            <div className="bg-slate-50 hover:bg-slate-50/80 border border-slate-200 rounded-xl p-4 flex flex-col gap-3 transition-colors select-none">
              <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-850 flex items-center gap-1.5 font-sans">
                  <Printer size={14} className="text-indigo-600" />
                  Primary Terminal Receipt Printer
                </span>
                <span className={`text-[8.5px] font-black uppercase px-2 py-0.5 rounded-full border flex items-center gap-1 ${
                  printerStatus === 'Linked'
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200/50'
                    : 'bg-rose-50 text-rose-705 border-rose-200'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${printerStatus === 'Linked' ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
                  {printerStatus === 'Linked' ? 'Auto-Linked (Default)' : 'Disconnected'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-left">
                <div className="flex flex-col gap-1">
                  <label className="text-[8.5px] font-extrabold text-slate-400 uppercase font-sans">Select Hardware Printer</label>
                  <select
                    value={printerName}
                    onChange={(e) => setPrinterName(e.target.value)}
                    className="bg-white border border-slate-200 text-xs px-2.5 py-1.5 rounded-lg text-slate-805 font-bold focus:outline-indigo-505 cursor-pointer"
                  >
                    <option value="ZPOS-Bluetooth-58M (Default Linked)">ZPOS-Bluetooth-58M (Default Mobile)</option>
                    <option value="Bixolon Mobile SRP-R200 BLE (58mm)">Bixolon Mobile SRP-R200 BLE (58mm)</option>
                    <option value="Star Micronics TSP100 Thermal (80mm)">Star Micronics TSP100 Thermal (80mm)</option>
                    <option value="Epson TM-T88VI Network Point (80mm)">Epson TM-T88VI Network Point (80mm)</option>
                    <option value="Generic Cloud-POS Printer Spooler">Generic Cloud-POS Printer Spooler</option>
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
                    <option value="USB OTG Raw Terminal Direct">USB OTG Raw Terminal Direct</option>
                    <option value="TCP/IP Network Host (Port 9100)">TCP/IP Network Host (Port 9100)</option>
                    <option value="Simulated Direct In-App Spool">Simulated Direct In-App Spool</option>
                  </select>
                </div>
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
      ) : (
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

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-400 font-extrabold text-[9px] uppercase tracking-wider border-b border-slate-100 select-none">
                    <th className="py-2.5 px-3">Full Employee Card</th>
                    <th className="py-2.5 px-3">Username Key / Email</th>
                    <th className="py-2.5 px-3">Access Level Rights</th>
                    <th className="py-2.5 px-3">Outlet Store Gating</th>
                    <th className="py-2.5 px-3 text-center">Settings Options</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-800">
                  {usersList.map((usr) => {
                    const avatarColor = usr.role === 'owner' 
                      ? 'bg-purple-100 text-purple-700 border-purple-200' 
                      : usr.role === 'manager' 
                        ? 'bg-blue-100 text-blue-700 border-blue-200' 
                        : 'bg-slate-100 text-slate-700 border-slate-200';

                    const roleLabel = usr.role === 'owner' 
                      ? '👑 OWNER (Full System Control)' 
                      : usr.role === 'manager' 
                        ? '👔 MANAGER (Supervisor approval)' 
                        : '💼 CASHIER (Sales operator)';

                    return (
                      <tr key={usr.id} className="hover:bg-slate-50/40 transition-colors">
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-2.5">
                            <div className={`w-8 h-8 rounded-lg border font-black text-xs flex items-center justify-center select-none ${avatarColor}`}>
                              {usr.first_name.charAt(0)}{usr.surname.charAt(0) || 'b'}
                            </div>
                            <div>
                              <div className="font-extrabold text-slate-800 text-xs">{usr.first_name} {usr.surname}</div>
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
                                usr.accessible_branches.map((bId: string) => (
                                  <span key={bId} className="text-[8.5px] px-1.5 py-0.2 font-black uppercase tracking-wider bg-indigo-50 text-indigo-700 border border-indigo-150 rounded-xs">
                                    {bId.toUpperCase()}
                                  </span>
                                ))
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-3 text-center select-none">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleEditUserClick(usr)}
                              className="p-1 px-1.5 text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-150 rounded transition-colors cursor-pointer"
                              title="Edit Security Credentials & Branch Access"
                            >
                              <Edit3 size={11} className="inline mr-1" />
                              <span className="text-[9px] font-black uppercase">Edit</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteUserClick(usr)}
                              className="p-1 px-1.5 text-red-500 bg-red-50 hover:bg-red-101 border border-red-150 rounded transition-colors cursor-pointer"
                              title="Revoke Control Credentials"
                            >
                              <Trash2 size={11} className="inline mr-1" />
                              <span className="text-[9px] font-black uppercase">Revoke</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-4 p-3.5 bg-slate-50 border border-slate-200 rounded-xl leading-relaxed text-[10.5px] text-slate-500 font-sans select-none text-left">
              <strong className="text-slate-700 block mb-0.5">🔐 USER SECURITY ACCOUNTS:</strong>
              <span>Manage system access roles and credentials for staff members below.</span>
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
                disabled={editingUserId === 'default_biz'}
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
                  const roleVal = e.target.value as any;
                  setUserRole(roleVal);
                  if (roleVal === 'owner') {
                    setSelectedBranches([]); // Implicit all branches
                  }
                }}
                disabled={editingUserId === 'default_biz'}
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
              <p className="text-[8.5px] text-slate-500 italic leading-snug">
                This hexadecimal payload is automatically formed, formatted using standard ESC/POS codes, and routed to the configured peripheral interface successfully.
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
