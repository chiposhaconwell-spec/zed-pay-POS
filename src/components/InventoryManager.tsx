import React, { useState, useEffect, useMemo } from 'react';
import { jsPDF } from 'jspdf';
import { 
  Package, 
  Plus, 
  Trash2, 
  Search, 
  Edit2, 
  Check, 
  X, 
  ShieldAlert, 
  ArrowUpDown, 
  RefreshCw, 
  Layers, 
  ArrowRightLeft, 
  Activity, 
  Printer,
  History,
  TrendingDown,
  TrendingUp,
  ShoppingCart,
  ArrowDownRight,
  ArrowUpRight,
  SlidersHorizontal,
  Filter,
  FileText,
  Tag
} from 'lucide-react';
import { runSql, persistTablesToStorage, logEmployeeAudit } from '../db';
import { Product, StoreSettings } from '../types';
import { motion, AnimatePresence, useDragControls } from 'motion/react';

interface InventoryManagerProps {
  settings: StoreSettings;
  userRole: string; // 'owner' | 'manager' | 'sales'
  activeStore: string; // 'lusaka' | 'kitwe' | 'ndola'
  onNavigateToSale?: () => void;
}

interface StockTransfer {
  id: string;
  product_id: number;
  product_name?: string;
  from_store: string;
  to_store: string;
  quantity: number;
  status: string;
  created_at: string;
}

export default function InventoryManager({ settings, userRole, activeStore, onNavigateToSale }: InventoryManagerProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [transfers, setTransfers] = useState<StockTransfer[]>([]);
  const [searchText, setSearchText] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [expiryFilter, setExpiryFilter] = useState<'all' | 'within30' | 'expired'>('all');
  const [sortBy, setSortBy] = useState<'stock' | 'price' | 'name'>('name');
  const [orderAsc, setOrderAsc] = useState(true);

  // Sub-tabs switcher
  const [activeSubTab, setActiveSubTab] = useState<'catalog' | 'global_matrix' | 'stock_take' | 'inventory_history' | 'transfers_ledger'>('catalog');
  
  // Comprehensive Inventory Transaction History state
  const [historyLogs, setHistoryLogs] = useState<any[]>([]);
  const [historyTypeFilter, setHistoryTypeFilter] = useState<string>('all');
  const [historyStoreFilter, setHistoryStoreFilter] = useState<string>('all');
  const [historySearchText, setHistorySearchText] = useState<string>('');
  
  // Independent search handles for Pivot Matrix & Stock Take counts
  const [pivotSearchText, setPivotSearchText] = useState('');
  const [stocktakeSearchText, setStocktakeSearchText] = useState('');
  const [matrixData, setMatrixData] = useState<any[]>([]);

  // Stocktake counts state
  const [countedStocks, setCountedStocks] = useState<Record<number, string>>({});
  const [stocktakeNotes, setStocktakeNotes] = useState('');
  const [stocktakePersonnel, setStocktakePersonnel] = useState('');
  const [stocktakeFreq, setStocktakeFreq] = useState<'weekly' | 'monthly' | 'quarterly'>('weekly');

  // Inter-Store Stock Transfer Form State
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferSearchQuery, setTransferSearchQuery] = useState('');
  const [transferProductId, setTransferProductId] = useState<string>('');
  const [transferFromStore, setTransferFromStore] = useState('lusaka');
  const [transferToStore, setTransferToStore] = useState('kitwe');
  const [transferQty, setTransferQty] = useState('5');
  const [transferCart, setTransferCart] = useState<any[]>([]);

  // Drag controls for Inter-Store Transfer panel
  const transferDragControls = useDragControls();

  const [transferStoreStocks, setTransferStoreStocks] = useState<Record<number, number>>({});

  // Filter products for the transfer catalog based on search query
  const filteredTransferProducts = useMemo(() => {
    return products
      .filter(p => p.is_service !== 1)
      .filter(p => {
        if (!transferSearchQuery) return true;
        const query = transferSearchQuery.toLowerCase();
        return p.name.toLowerCase().includes(query) || (p.sku && p.sku.toLowerCase().includes(query));
      });
  }, [products, transferSearchQuery]);

  // Load stock levels dynamically for transferFromStore when modal is open
  useEffect(() => {
    if (showTransferModal) {
      const res = runSql(`
        SELECT p.id, COALESCE(sp.stock, p.stock) AS stock 
        FROM products p
        LEFT JOIN store_products sp ON p.id = sp.product_id AND sp.store_id = '${transferFromStore}'
      `, 'Transfer: Load stock levels for source branch');
      if (res.success && Array.isArray(res.data)) {
        const stocks: Record<number, number> = {};
        res.data.forEach((row: any) => {
          stocks[row.id] = Number(row.stock || 0);
        });
        setTransferStoreStocks(stocks);
      }
    }
  }, [transferFromStore, showTransferModal, products]);

  // Handle auto-updating the selected transferProductId when search query updates
  useEffect(() => {
    if (showTransferModal && filteredTransferProducts.length > 0) {
      if (!filteredTransferProducts.some(p => p.id.toString() === transferProductId)) {
        setTransferProductId(filteredTransferProducts[0].id.toString());
      }
    }
  }, [filteredTransferProducts, showTransferModal, transferProductId]);

  // Editing state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editPrice, setEditPrice] = useState<number>(0);
  const [editCost, setEditCost] = useState<number>(0);
  const [editStock, setEditStock] = useState<number>(0);
  const [editCategory, setEditCategory] = useState<string>('');
  const [editBatchNumber, setEditBatchNumber] = useState('');
  const [editExpiryDate, setEditExpiryDate] = useState('');

  // Category management modal state
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [modalNewCatName, setModalNewCatName] = useState('');
  const [editingCatOldName, setEditingCatOldName] = useState<string | null>(null);
  const [editingCatNewName, setEditingCatNewName] = useState('');
  const [customCategories, setCustomCategories] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('pos_custom_categories');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const saveCustomCategories = (cats: string[]) => {
    setCustomCategories(cats);
    try {
      localStorage.setItem('pos_custom_categories', JSON.stringify(cats));
    } catch (e) {
      console.error(e);
    }
  };

  const allCategoriesList = useMemo(() => {
    const set = new Set<string>();
    products.forEach(p => {
      if (p.category && p.category.trim()) {
        set.add(p.category.trim());
      }
    });
    customCategories.forEach(c => {
      if (c && c.trim()) {
        set.add(c.trim());
      }
    });
    if (set.size === 0) {
      set.add('General');
    }
    return Array.from(set).sort();
  }, [products, customCategories]);

  // Adding product state
  const [showAddModal, setShowAddModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSku, setNewSku] = useState('');
  const [newCat, setNewCat] = useState('');
  const [newPrice, setNewPrice] = useState('0.00');
  const [newCost, setNewCost] = useState('0.00');
  const [newStock, setNewStock] = useState('10');
  const [newImg, setNewImg] = useState('');
  const [newIsService, setNewIsService] = useState(false);
  const [newBatchNumber, setNewBatchNumber] = useState('');
  const [newExpiryDate, setNewExpiryDate] = useState('');

  // Quick Add / Receive stock modal state
  const [showReceiveModal, setShowReceiveModal] = useState(false);
  const [receiveProduct, setReceiveProduct] = useState<Product | null>(null);
  const [receiveQty, setReceiveQty] = useState('10');
  const [receiveBatch, setReceiveBatch] = useState('');
  const [receiveExpiry, setReceiveExpiry] = useState('');

  const getStoresList = () => [
    { id: 'lusaka', name: 'Lusaka Main' },
    { id: 'kitwe', name: 'Kitwe Outlet' },
    { id: 'ndola', name: 'Ndola Depot' }
  ];

  const loadMatrixData = () => {
    // 1. Get all products from products table
    const prodRes = runSql('SELECT * FROM products ORDER BY name ASC', 'Matrix: Get all goods', true);
    if (!prodRes.success || !Array.isArray(prodRes.data)) return [];

    const rawProds = prodRes.data;

    // 2. Get all store overrides from store_products table to map them by product_id
    const spRes = runSql('SELECT * FROM store_products', 'Matrix: Get all overrides', true);
    const spList = (spRes.success && Array.isArray(spRes.data)) ? spRes.data : [];

    // Map override rows by product_id
    const spMap: Record<number, Record<string, { stock: number; price: number }>> = {};
    spList.forEach((sp: any) => {
      if (!spMap[sp.product_id]) {
        spMap[sp.product_id] = {};
      }
      spMap[sp.product_id][sp.store_id] = {
        stock: sp.stock,
        price: sp.price
      };
    });

    // 3. Construct matrix rows
    return rawProds.map((p: any) => {
      const stores: Record<string, { stock: number; price: number }> = {};
      let totalStock = 0;

      ['lusaka', 'kitwe', 'ndola'].forEach(storeId => {
        const override = spMap[p.id]?.[storeId];
        const stockVal = override ? override.stock : 0;
        const priceVal = override ? override.price : p.price;
        stores[storeId] = { stock: stockVal, price: priceVal };
        totalStock += stockVal;
      });

      return {
        id: p.id,
        name: p.name,
        sku: p.sku || `SKU-00${p.id}`,
        category: p.category || 'General',
        is_service: p.is_service,
        stores,
        totalStock
      };
    });
  };

  const isReadOnly = userRole === 'sales';

  const getExpirationStatus = (expiryDateStr: string | undefined | null) => {
    if (!expiryDateStr) return { status: 'none', daysLeft: 0, label: '' };
    
    const expiryDate = new Date(expiryDateStr);
    if (isNaN(expiryDate.getTime())) return { status: 'none', daysLeft: 0, label: '' };
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    expiryDate.setHours(0, 0, 0, 0);
    
    const diffTime = expiryDate.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays < 0) {
      return { status: 'expired', daysLeft: diffDays, label: `Expired by ${Math.abs(diffDays)}d` };
    } else if (diffDays === 0) {
      return { status: 'today', daysLeft: 0, label: 'Expires TODAY' };
    } else if (diffDays <= 30) {
      return { status: 'nearing', daysLeft: diffDays, label: `Expires in ${diffDays}d` };
    } else {
      return { status: 'safe', daysLeft: diffDays, label: `Expires in ${diffDays}d` };
    }
  };

  const loadInventoryHistory = () => {
    const historyList: any[] = [];

    // 1. Load Sales Order Line Items (POS Checkout Movements)
    const salesRes = runSql(`
      SELECT 
        oi.id AS item_id,
        o.id AS ref_id,
        o.orderDate AS created_at,
        o.store_id AS store_id,
        o.performed_by AS performed_by,
        o.paymentMethod AS payment_method,
        p.name AS product_name,
        p.sku AS product_sku,
        oi.quantity AS quantity,
        oi.unitPrice AS unit_price,
        c.name AS customer_name
      FROM order_items oi
      JOIN orders o ON oi.orderId = o.id
      LEFT JOIN products p ON oi.productId = p.id
      LEFT JOIN customers c ON o.customerId = c.id
      ORDER BY o.orderDate DESC
    `, 'Inventory History: Load sales order items', true);

    if (salesRes.success && Array.isArray(salesRes.data)) {
      salesRes.data.forEach((s: any) => {
        const qty = Number(s.quantity || 0);
        const price = Number(s.unit_price || 0);
        historyList.push({
          id: `sale_${s.item_id}_${s.ref_id}`,
          ref_id: s.ref_id,
          created_at: s.created_at,
          store_id: s.store_id || activeStore,
          performed_by: s.performed_by || 'Cashier',
          product_name: s.product_name || 'POS Checkout Item',
          product_sku: s.product_sku || '',
          movement_type: 'POS_SALE',
          change_qty: -Math.abs(qty),
          unit_price: price,
          total_value: qty * price,
          narration: `POS Sale: -${qty} units (${s.payment_method || 'Cash'})${s.customer_name ? ` to ${s.customer_name}` : ''}`
        });
      });
    }

    // 2. Load Transactions table records (Stock Receives, Adjustments, Manual Edits)
    const txRes = runSql(`
      SELECT * FROM transactions 
      ORDER BY created_at DESC
    `, 'Inventory History: Load transaction logs', true);

    if (txRes.success && Array.isArray(txRes.data)) {
      txRes.data.forEach((tx: any) => {
        const ch = String(tx.channel || '').toUpperCase();
        const posId = String(tx.pos_terminal_id || '').toLowerCase();
        const storeCode = posId.includes('kitwe') ? 'kitwe' : posId.includes('ndola') ? 'ndola' : posId.includes('lusaka') ? 'lusaka' : activeStore;

        if (ch === 'RECEIVE' || tx.provider_reference === 'BATCH-ADD' || tx.provider_reference === 'CATALOG_INIT') {
          historyList.push({
            id: tx.id,
            ref_id: tx.provider_reference || tx.id,
            created_at: tx.created_at,
            store_id: storeCode,
            performed_by: tx.performed_by || 'Warehouse Manager',
            product_name: 'Stock Batch Arrival',
            product_sku: '',
            movement_type: 'STOCK_RECEIVE',
            change_qty: 0,
            unit_price: 0,
            total_value: Number(tx.amount || 0),
            narration: tx.narration || 'Stock Received'
          });
        } else if (ch === 'MANUAL_EDIT' || tx.provider_reference === 'CATALOG_EDIT') {
          historyList.push({
            id: tx.id,
            ref_id: tx.id,
            created_at: tx.created_at,
            store_id: storeCode,
            performed_by: tx.performed_by || 'Inventory Admin',
            product_name: 'Manual Catalog Edit',
            product_sku: '',
            movement_type: 'MANUAL_EDIT',
            change_qty: 0,
            unit_price: 0,
            total_value: Number(tx.amount || 0),
            narration: tx.narration || 'Manual Catalog Stock Edit'
          });
        } else if (ch === 'ADJUSTMENT') {
          historyList.push({
            id: tx.id,
            ref_id: tx.id,
            created_at: tx.created_at,
            store_id: storeCode,
            performed_by: tx.performed_by || 'Auditor',
            product_name: 'Reconciliation Variance',
            product_sku: '',
            movement_type: 'STOCK_AUDIT',
            change_qty: 0,
            unit_price: 0,
            total_value: Number(tx.amount || 0),
            narration: tx.narration || 'Reconciliation Variance Journal'
          });
        }
      });
    }

    // 3. Load Stock Takes & Items
    const stockTakeRes = runSql(`
      SELECT 
        sti.id AS item_id,
        st.id AS stock_take_id,
        st.created_at AS created_at,
        st.store_id AS store_id,
        st.performed_by AS performed_by,
        p.name AS product_name,
        p.sku AS product_sku,
        sti.recorded_qty AS recorded_qty,
        sti.counted_qty AS counted_qty,
        sti.variance AS variance
      FROM stock_take_items sti
      JOIN stock_takes st ON sti.stock_take_id = st.id
      LEFT JOIN products p ON sti.product_id = p.id
      ORDER BY st.created_at DESC
    `, 'Inventory History: Load stock take items', true);

    if (stockTakeRes.success && Array.isArray(stockTakeRes.data)) {
      stockTakeRes.data.forEach((st: any) => {
        const varVal = Number(st.variance || 0);
        historyList.push({
          id: `audit_${st.item_id}`,
          ref_id: st.stock_take_id,
          created_at: st.created_at,
          store_id: st.store_id || activeStore,
          performed_by: st.performed_by || 'Auditor',
          product_name: st.product_name || 'Audited Product',
          product_sku: st.product_sku || '',
          movement_type: 'STOCK_AUDIT',
          change_qty: varVal,
          unit_price: 0,
          total_value: 0,
          narration: `Audit Sheet: Recorded ${st.recorded_qty}, Counted ${st.counted_qty} (${varVal >= 0 ? '+' : ''}${varVal} variance)`
        });
      });
    }

    // 4. Load Stock Transfers
    const transferRes = runSql(`
      SELECT st.*, p.name AS product_name, p.sku AS product_sku
      FROM stock_transfers st
      LEFT JOIN products p ON st.product_id = p.id
      ORDER BY st.created_at DESC
    `, 'Inventory History: Load transfers', true);

    if (transferRes.success && Array.isArray(transferRes.data)) {
      transferRes.data.forEach((tr: any) => {
        historyList.push({
          id: `tr_${tr.id}`,
          ref_id: tr.id,
          created_at: tr.created_at,
          store_id: `${tr.from_store} -> ${tr.to_store}`,
          performed_by: 'Logistics Officer',
          product_name: tr.product_name || 'Transferred Product',
          product_sku: tr.product_sku || '',
          movement_type: 'BRANCH_TRANSFER',
          change_qty: Number(tr.quantity || 0),
          unit_price: 0,
          total_value: 0,
          status: tr.status,
          narration: `Branch Transfer [${tr.status}]: ${tr.quantity} units (${tr.from_store.toUpperCase()} ➔ ${tr.to_store.toUpperCase()})`
        });
      });
    }

    // Sort descending by date
    historyList.sort((a, b) => {
      const timeA = new Date(a.created_at).getTime() || 0;
      const timeB = new Date(b.created_at).getTime() || 0;
      return timeB - timeA;
    });

    setHistoryLogs(historyList);
  };

  const loadRawData = () => {
    // Left Join with store_products to load branch-specific price and stock override targets!
    const query = `
      SELECT 
        p.id, 
        p.name, 
        p.sku, 
        p.category, 
        p.cost, 
        p.imageUrl,
        p.is_service,
        p.batch_number,
        p.expiry_date,
        COALESCE(sp.price, p.price) AS price, 
        COALESCE(sp.stock, p.stock) AS stock 
      FROM products p 
      LEFT JOIN store_products sp ON p.id = sp.product_id AND sp.store_id = '${activeStore}'
    `;
    const result = runSql(query, `Inventory: Fetch stock overrides for branch [${activeStore.toUpperCase()}]`);
    if (result.success && Array.isArray(result.data)) {
      setProducts(result.data);
    }

    // Load Stock Transfers log joined with product names
    const transfersRes = runSql(`
      SELECT st.*, p.name AS product_name 
      FROM stock_transfers st
      LEFT JOIN products p ON st.product_id = p.id
      ORDER BY st.created_at DESC
    `, 'Inventory: Fetch stock transfers ledger');
    if (transfersRes.success && Array.isArray(transfersRes.data)) {
      setTransfers(transfersRes.data);
    }

    // Load active store's assigned stocktake interval
    const storeRes = runSql(`SELECT stocktake_frequency FROM stores WHERE id = '${activeStore}'`, 'Load store frequency');
    if (storeRes.success && Array.isArray(storeRes.data) && storeRes.data.length > 0) {
      setStocktakeFreq(storeRes.data[0].stocktake_frequency || 'weekly');
    }

    // Refresh global pivot matrix data dynamically when raw data reloads to prevent rendering side-effects
    const freshMatrix = loadMatrixData();
    setMatrixData(freshMatrix);

    // Load comprehensive inventory history ledger logs
    loadInventoryHistory();
  };

  useEffect(() => {
    loadRawData();
  }, [activeStore]);

  const handleStartEdit = (prod: Product) => {
    if (isReadOnly) {
      alert(`Access Denied: Logged in role [Sales Person] is not authorized to edit stock pricing.`);
      return;
    }
    setEditingId(prod.id);
    setEditPrice(prod.price);
    setEditCost(prod.cost);
    setEditStock(prod.stock);
    setEditCategory(prod.category || 'General');
    setEditBatchNumber(prod.batch_number || '');
    setEditExpiryDate(prod.expiry_date || '');
  };

  const handleSaveEdit = (id: number) => {
    if (isReadOnly) return;
    
    const targetProd = products.find(p => p.id === id);
    const oldStock = targetProd ? targetProd.stock : editStock;
    const stockDiff = editStock - oldStock;
    const catToSave = (editCategory || 'General').trim();

    // 1. Update the default primary products table
    const updateGlobalSql = `UPDATE products SET category = '${catToSave.replace(/'/g, "''")}', price = ${editPrice}, cost = ${editCost}, stock = ${editStock}, batch_number = '${editBatchNumber.replace(/'/g, "''")}', expiry_date = '${editExpiryDate}' WHERE id = ${id}`;
    runSql(updateGlobalSql, `Inventory: Sync baseline pricing and category for Product ID #${id}`);

    // 2. Update or insert the store_products row for active branch store!
    const selectCheck = runSql(`SELECT * FROM store_products WHERE product_id = ${id} AND store_id = '${activeStore}'`, 'Override Guard');
    
    if (selectCheck.success && Array.isArray(selectCheck.data) && selectCheck.data.length > 0) {
      const updateBranchSql = `
        UPDATE store_products 
        SET price = ${editPrice}, stock = ${editStock} 
        WHERE product_id = ${id} AND store_id = '${activeStore}'
      `;
      runSql(updateBranchSql, `Inventory: Alter specific override price to ${editPrice} on branch ${activeStore}`);
    } else {
      const spId = `sp_${id}_${activeStore}`;
      const insertBranchSql = `
        INSERT INTO store_products (id, product_id, store_id, stock, price)
        VALUES ('${spId}', ${id}, '${activeStore}', ${editStock}, ${editPrice})
      `;
      runSql(insertBranchSql, `Inventory: Create specific override price for product in branch ${activeStore}`);
    }

    // 3. Log transaction if stock level changed
    if (targetProd && stockDiff !== 0) {
      const refId = `stock_edit_${id}_${Date.now()}`;
      const nowStr = new Date().toISOString();
      const valueImpact = Math.abs(stockDiff * editCost);
      runSql(`
        INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by)
        VALUES (
          '${refId}',
          'idem_${refId}',
          '${activeStore.toUpperCase()}',
          'MANUAL_EDIT',
          'CATALOG_EDIT',
          ${valueImpact.toFixed(2)},
          0.00,
          'SUCCESS',
          'Manual stock edit for ${targetProd.name.replace(/'/g, "''")}: ${stockDiff > 0 ? '+' : ''}${stockDiff} units (New level: ${editStock})',
          '${nowStr}',
          '${nowStr}',
          '${userRole}'
        )
      `, 'Log manual stock edit transaction');
    }

    logEmployeeAudit('STOCK', 'Adjusted Product Stock/Price', `Updated ${targetProd ? targetProd.name : 'Product #' + id}: New Price = K${editPrice}, New Stock = ${editStock} (${stockDiff >= 0 ? '+' : ''}${stockDiff})`, Math.abs(stockDiff * editCost), activeStore);

    setEditingId(null);
    loadRawData();
    persistTablesToStorage();
    alert('Changes applied successfully inside local SQL database.');
  };

  const handleDeleteProduct = (id: number, name: string) => {
    if (userRole !== 'owner') {
      alert('Access Denied: Only Business Owners can delete core catalog entries to prevent warehouse mismatches.');
      return;
    }

    if (!window.confirm(`Are you sure you want to delete [${name}] globally? This will clear all multi-store records.`)) {
      return;
    }

    runSql(`DELETE FROM order_items WHERE productId = ${id}`, `Cascade Delete: Detaching orders`);
    runSql(`DELETE FROM store_products WHERE product_id = ${id}`, `Cascade Delete: Detaching branch stocks`);
    runSql(`DELETE FROM products WHERE id = ${id}`, `Inventory: Deleting product ${name}`);

    logEmployeeAudit('STOCK', 'Deleted Product', `Deleted Product #${id} (${name}) and detached store records`, 0, activeStore);

    loadRawData();
    persistTablesToStorage();
  };

  const handleAddProduct = (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) {
      alert('Access Denied!');
      return;
    }

    if (!newName || !newSku || !newCat) {
      alert('Fill out all fields!');
      return;
    }

    const priceNum = parseFloat(newPrice) || 0;
    const costNum = parseFloat(newCost) || 0;
    const stockNum = parseInt(newStock) || 0;
    const imgUrl = newImg || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=150';

    const nextId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 101;

    // Insert baseline primary with column specifiers to support optional/default is_service
    runSql(`
      INSERT INTO products (id, name, sku, category, price, cost, stock, imageUrl, business_id, is_service, batch_number, expiry_date) VALUES (
        ${nextId}, 
        '${newName.replace(/'/g, "''")}', 
        '${newSku.replace(/'/g, "''")}', 
        '${newCat.replace(/'/g, "''")}', 
        ${priceNum}, 
        ${costNum}, 
        ${stockNum}, 
        '${imgUrl}',
        'default_biz',
        ${newIsService ? 1 : 0},
        '${newBatchNumber.replace(/'/g, "''")}',
        '${newExpiryDate}'
      )
    `, `Catalog: Add global model ${newName}`);

    // Add store override values for ALL branches so pricing maps instantly
    const storeCodes = ['lusaka', 'kitwe', 'ndola'];
    storeCodes.forEach(code => {
      runSql(`
        INSERT INTO store_products VALUES (
          'sp_${nextId}_${code}',
          ${nextId},
          '${code}',
          ${stockNum},
          ${priceNum}
        )
      `, `Catalog: Seed overrides in ${code}`);
    });

    if (stockNum > 0) {
      const refId = `stock_init_${nextId}_${Date.now()}`;
      const nowStr = new Date().toISOString();
      runSql(`
        INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by)
        VALUES (
          '${refId}',
          'idem_${refId}',
          'ALL-STORES',
          'RECEIVE',
          'CATALOG_INIT',
          ${(stockNum * costNum).toFixed(2)},
          0.00,
          'SUCCESS',
          'Initial catalog creation for ${newName.replace(/'/g, "''")}: +${stockNum} units [Batch: ${newBatchNumber || 'N/A'}]',
          '${nowStr}',
          '${nowStr}',
          '${userRole}'
        )
      `, 'Log initial stock creation transaction');
    }

    logEmployeeAudit('STOCK', 'Added New Product', `Product: ${newName} (SKU: ${newSku}, Category: ${newCat}), Price: K${priceNum}, Stock: ${stockNum}`, priceNum * stockNum, activeStore);

    setShowAddModal(false);
    setNewName('');
    setNewSku('');
    setNewCat('');
    setNewPrice('0.00');
    setNewCost('0.00');
    setNewStock('10');
    setNewImg('');
    setNewIsService(false);
    setNewBatchNumber('');
    setNewExpiryDate('');
    loadRawData();
    persistTablesToStorage();
  };

  const handleReceiveStockSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!receiveProduct) return;
    
    const parsedAdd = parseInt(receiveQty);
    if (isNaN(parsedAdd) || parsedAdd <= 0) {
      alert('Please enter a valid positive integer count.');
      return;
    }
    
    const newStockLevel = receiveProduct.stock + parsedAdd;
    
    // Update products table with quantity, batch, and expiry
    const updatePrimary = `
      UPDATE products 
      SET stock = stock + ${parsedAdd},
          batch_number = '${receiveBatch.replace(/'/g, "''")}',
          expiry_date = '${receiveExpiry}'
      WHERE id = ${receiveProduct.id}
    `;
    runSql(updatePrimary, `Inventory Receive: Increase stock, set batch '${receiveBatch}', expiry '${receiveExpiry}' for Product ID #${receiveProduct.id}`);
    
    // Update store override
    const selectCheck = runSql(`SELECT * FROM store_products WHERE product_id = ${receiveProduct.id} AND store_id = '${activeStore}'`, 'Override Guard');
    if (selectCheck.success && Array.isArray(selectCheck.data) && selectCheck.data.length > 0) {
      runSql(`
        UPDATE store_products 
        SET stock = stock + ${parsedAdd} 
        WHERE product_id = ${receiveProduct.id} AND store_id = '${activeStore}'
      `, `Inventory Receive: Increase override stock`);
    } else {
      runSql(`
        INSERT INTO store_products (id, product_id, store_id, stock, price)
        VALUES ('sp_${receiveProduct.id}_${activeStore}', ${receiveProduct.id}, '${activeStore}', ${newStockLevel}, ${receiveProduct.price})
      `, `Inventory Receive: Seed override stock`);
    }
    
    // Record a log for inventory increase inside transactions database
    const refId = `stock_receive_${receiveProduct.id}_${Date.now()}`;
    const nowStr = new Date().toISOString();
    const valueImpact = parsedAdd * receiveProduct.cost;
    runSql(`
      INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by)
      VALUES ('${refId}', 'idem_${refId}', 'INVENTORY', 'RECEIVE', 'BATCH-ADD', ${valueImpact}, 0.00, 'SUCCESS', 'Received +${parsedAdd} units of ${receiveProduct.name.replace(/'/g, "''")} [Batch: ${receiveBatch || 'N/A'}]', '${nowStr}', '${nowStr}', '${userRole}')
    `, `Log quick stock receive transaction`);

    logEmployeeAudit('STOCK', 'Received Stock Batch', `Received +${parsedAdd} units of ${receiveProduct.name} [Batch: ${receiveBatch || 'N/A'}]`, valueImpact, activeStore);
    
    setShowReceiveModal(false);
    setReceiveProduct(null);
    setReceiveQty('10');
    setReceiveBatch('');
    setReceiveExpiry('');
    loadRawData();
    persistTablesToStorage();
    alert(`✓ Successfully received +${parsedAdd} units of ${receiveProduct.name}!`);
  };

  // EXECUTE STOCK ROUTING TRANSFER BETWEEN STORE SHIFT HOOKS
  const handleAddToTransferCart = () => {
    const qty = parseInt(transferQty);
    const pId = parseInt(transferProductId);

    if (isNaN(qty) || qty <= 0 || isNaN(pId)) {
      alert('Please select a valid product and positive quantity!');
      return;
    }

    if (transferFromStore === transferToStore) {
      alert('Source and destination branches must represent distinct stores!');
      return;
    }

    // Check if product already exists in the transfer cart
    if (transferCart.some(item => item.productId === pId)) {
      alert('This product is already in the transfer cart! Edit or remove it from the list below.');
      return;
    }

    // Check source store stock
    const sourceRes = runSql(`
      SELECT stock FROM store_products 
      WHERE product_id = ${pId} AND store_id = '${transferFromStore}'
    `, 'Stock Transfer Cart Check: Query Source balance');

    if (!sourceRes.success || !Array.isArray(sourceRes.data) || sourceRes.data.length === 0) {
      alert('Error: This product is not available/stocked in the source branch!');
      return;
    }

    const sourceStock = sourceRes.data[0].stock;
    if (sourceStock < qty) {
      alert(`Insufficient stock! ${transferFromStore.toUpperCase()} branch only has ${sourceStock} units of this product.`);
      return;
    }

    const selectedProduct = products.find(p => p.id === pId);
    if (!selectedProduct) return;

    setTransferCart([
      ...transferCart,
      {
        productId: pId,
        productName: selectedProduct.name,
        sku: selectedProduct.sku,
        quantity: qty,
        availableStock: sourceStock
      }
    ]);

    // Reset default quantity
    setTransferQty('5');
  };

  const handleRemoveFromTransferCart = (productId: number) => {
    setTransferCart(transferCart.filter(item => item.productId !== productId));
  };

  const handleTransferStock = (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) {
      alert('Access Denied: Salespersons are not authorized to route branch stock.');
      return;
    }

    if (transferCart.length === 0) {
      alert('Your transfer cart is empty! Please add at least one item with its quantity to the transfer note first.');
      return;
    }

    if (transferFromStore === transferToStore) {
      alert('Source and destination branches must represent distinct stores!');
      return;
    }

    // Verify all items in transferCart still have enough stock in source store
    for (const item of transferCart) {
      const sourceRes = runSql(`
        SELECT stock FROM store_products 
        WHERE product_id = ${item.productId} AND store_id = '${transferFromStore}'
      `, 'Stock Transfer: Query Source balance');

      if (!sourceRes.success || !Array.isArray(sourceRes.data) || sourceRes.data.length === 0) {
        alert(`Error fetching source product stock level for ${item.productName}.`);
        return;
      }

      const currentStock = sourceRes.data[0].stock;
      if (currentStock < item.quantity) {
        alert(`Insufficient stock! ${transferFromStore.toUpperCase()} branch only has ${currentStock} units of ${item.productName}, but you are trying to transfer ${item.quantity}.`);
        return;
      }
    }

    // All checks pass! Now proceed to update store_products and insert stock_transfers
    const transferBaseId = 'TRSF-' + Math.floor(1000 + Math.random() * 9000);
    const dateStr = new Date().toISOString();
    let successCount = 0;
    let failedItems: string[] = [];

    transferCart.forEach((item, index) => {
      // 1. Decrement sender branch stock immediately.
      const decSql = `UPDATE store_products SET stock = stock - ${item.quantity} WHERE product_id = ${item.productId} AND store_id = '${transferFromStore}'`;
      const decRes = runSql(decSql, `Transfer: Debit -${item.quantity} units of ${item.productName} from ${transferFromStore.toUpperCase()} branch`);

      if (decRes.success) {
        // Record inside stock_transfers log table with 'PENDING' status
        const transferId = `${transferBaseId}-${index + 1}`;
        const insertRes = runSql(`
          INSERT INTO stock_transfers (id, product_id, from_store, to_store, quantity, status, created_at, rejection_reason)
          VALUES ('${transferId}', ${item.productId}, '${transferFromStore}', '${transferToStore}', ${item.quantity}, 'PENDING', '${dateStr}', '')
        `, `Transfer Journal: Log pending transfer note ${transferId}`);

        if (insertRes.success) {
          successCount++;
        } else {
          // If insert failed, attempt to revert the stock debit
          runSql(`UPDATE store_products SET stock = stock + ${item.quantity} WHERE product_id = ${item.productId} AND store_id = '${transferFromStore}'`, `Transfer Revert Debit`);
          failedItems.push(item.productName);
        }
      } else {
        failedItems.push(item.productName);
      }
    });

    if (successCount > 0) {
      logEmployeeAudit('STOCK', 'Initiated Stock Transfer', `Transferred ${transferCart.length} item line(s) from ${transferFromStore.toUpperCase()} to ${transferToStore.toUpperCase()}`, 0, transferFromStore);

      setTransferCart([]);
      setTransferQty('5');
      setShowTransferModal(false);
      loadRawData();
      persistTablesToStorage();
      
      let message = `✓ Stock transfer process completed successfully!\n\n${successCount} items have been processed and initiated under shipment reference group ${transferBaseId}. Current status: 'PENDING'. Stock deducted from ${transferFromStore.toUpperCase()}. Waiting for ${transferToStore.toUpperCase()} to approve.`;
      if (failedItems.length > 0) {
        message += `\n\n⚠️ The following items failed to transfer: ${failedItems.join(', ')}`;
      }
      alert(message);
    } else {
      alert('Error committing changes. No items were transferred.');
    }
  };

  const handleApproveTransfer = (st: StockTransfer) => {
    if (st.to_store !== activeStore) {
      alert(`Inter-Store Safety Gate: You can only approve incoming transfers to your active store [${activeStore.toUpperCase()}]. Active transfer is destined to branch [${st.to_store.toUpperCase()}].`);
      return;
    }

    // 1. Credit recipient store stock
    const checkSp = runSql(`SELECT * FROM store_products WHERE product_id = ${st.product_id} AND store_id = '${st.to_store}'`, 'Check target override');
    let incRes;
    if (checkSp.success && Array.isArray(checkSp.data) && checkSp.data.length > 0) {
      incRes = runSql(`UPDATE store_products SET stock = stock + ${st.quantity} WHERE product_id = ${st.product_id} AND store_id = '${st.to_store}'`, `Approved Credit: +${st.quantity} units to ${st.to_store.toUpperCase()}`);
    } else {
      const spId = `sp_${st.product_id}_${st.to_store}`;
      const getPrice = runSql(`SELECT price FROM products WHERE id = ${st.product_id}`, 'Fetch product pricing');
      const baselinePrice = (getPrice.success && getPrice.data.length > 0) ? getPrice.data[0].price : 0;
      incRes = runSql(`INSERT INTO store_products VALUES ('${spId}', ${st.product_id}, '${st.to_store}', ${st.quantity}, ${baselinePrice})`, `Approved Seed Credit`);
    }

    if (incRes.success) {
      // 2. Change status in DB
      runSql(`UPDATE stock_transfers SET status = 'APPROVED' WHERE id = '${st.id}'`, `Approved transfer ${st.id}`);
      
      // Log transaction
      const refId = `tr_appr_${st.id}_${Date.now()}`;
      const nowStr = new Date().toISOString();
      runSql(`
        INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by)
        VALUES (
          '${refId}',
          'idem_${refId}',
          '${st.to_store.toUpperCase()}',
          'TRANSFER',
          '${st.id}',
          0.00,
          0.00,
          'SUCCESS',
          'Branch transfer approved: +${st.quantity} units of ${st.product_name || 'Item'} received at ${st.to_store.toUpperCase()} from ${st.from_store.toUpperCase()}',
          '${nowStr}',
          '${nowStr}',
          '${userRole}'
        )
      `, 'Log transfer approval transaction');
      
      // 3. Print PDF
      try {
        const doc = new jsPDF({ format: 'a5', orientation: 'landscape' }); // Horizontal landscape design
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.text(settings.storeName.toUpperCase(), 10, 15);
        doc.setFontSize(9);
        doc.text('INTER-STORE INVENTORY TRANSFER NOTE (APPROVED & COMPLETED)', 10, 20);
        
        doc.setLineWidth(0.2);
        doc.line(10, 23, 195, 23);
        
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.text(`TRANSFER REFERENCE: ${st.id}`, 10, 30);
        doc.text(`CREATED AT: ${new Date(st.created_at).toLocaleString()}`, 10, 35);
        doc.text(`APPROVED AT: ${new Date().toLocaleString()}`, 10, 40);
        doc.text(`SOURCE BRANCH: ${st.from_store.toUpperCase()}`, 10, 45);
        doc.text(`DESTINATION BRANCH: ${st.to_store.toUpperCase()}`, 10, 50);
        
        doc.setFont('helvetica', 'bold');
        doc.text('TRANSFER STATUS: APPROVED & CO-SIGNED', 10, 58);
        doc.line(10, 60, 195, 60);
        
        // Item detail tabular preview
        doc.text('PRODUCT IDENTIFICATION / DETAILS', 10, 66);
        doc.text('QTY CODE', 150, 66, { align: 'right' });
        doc.text('AUDIT STATE', 195, 66, { align: 'right' });
        
        doc.setFont('helvetica', 'normal');
        doc.text(`${st.product_name || 'Generic Product Item'} (Catalog ID: ${st.product_id})`, 10, 72);
        doc.text(`${st.quantity} UNITS`, 150, 72, { align: 'right' });
        doc.text('[VERIFIED & RECEIVED]', 195, 72, { align: 'right' });
        
        doc.line(10, 76, 195, 76);
        
        // Signatures setup for audit audit trail
        doc.setFontSize(8);
        doc.text('____________________________', 10, 95);
        doc.text('Dispatch Officer Signature', 10, 99);
        
        doc.text('____________________________', 120, 95);
        doc.text('Receiving Store Approver Signature', 120, 99);
        
        doc.setFontSize(7);
        doc.text('Double-entry ledger status has changed to APPROVED in the SQL database. Retain this co-signed slip for multi-branch audits.', 10, 115);
        
        doc.save(`APPROVED_STOCK_TRANSFER_${st.id}.pdf`);
      } catch (pdfErr) {
        console.error('Failed to generate approval PDF:', pdfErr);
      }

      alert(`✓ Stock Transfer ${st.id} APPROVED successfully!\nAll branch stock layers have been updated and verified receipt PDF has been downloaded.`);
      loadRawData();
      persistTablesToStorage();
    } else {
      alert('Error updating destination stock: ' + incRes.error);
    }
  };

  const handleRejectTransfer = (st: StockTransfer) => {
    if (st.to_store !== activeStore) {
      alert(`Inter-Store Safety Gate: You can only reject incoming transfers destined to your active store [${activeStore.toUpperCase()}].`);
      return;
    }

    const reason = window.prompt(`Provide mismatch/rejection reason for rejecting transfer [${st.id}]:`);
    if (reason === null) return; // cancel clicked
    if (!reason.trim()) {
      alert('Access Gating: You must enter a reason to reject this stock transfer to explain mismatches.');
      return;
    }

    // 1. Credit sending store stock back
    const checkSp = runSql(`SELECT * FROM store_products WHERE product_id = ${st.product_id} AND store_id = '${st.from_store}'`, 'Check source override');
    let restoreRes;
    if (checkSp.success && Array.isArray(checkSp.data) && checkSp.data.length > 0) {
      restoreRes = runSql(`UPDATE store_products SET stock = stock + ${st.quantity} WHERE product_id = ${st.product_id} AND store_id = '${st.from_store}'`, `Rejected Refund: Restore +${st.quantity} units to ${st.from_store.toUpperCase()}`);
    } else {
      const spId = `sp_${st.product_id}_${st.from_store}`;
      const getPrice = runSql(`SELECT price FROM products WHERE id = ${st.product_id}`, 'Fetch product pricing');
      const baselinePrice = (getPrice.success && getPrice.data.length > 0) ? getPrice.data[0].price : 0;
      restoreRes = runSql(`INSERT INTO store_products VALUES ('${spId}', ${st.product_id}, '${st.from_store}', ${st.quantity}, ${baselinePrice})`, `Restore back overrides`);
    }

    if (restoreRes.success) {
      // 2. Set Status in DB with rejection reason
      const reasonEscaped = reason.replace(/'/g, "''");
      runSql(`UPDATE stock_transfers SET status = 'REJECTED', rejection_reason = '${reasonEscaped}' WHERE id = '${st.id}'`, `Rejected transfer ${st.id}`);
      
      const refId = `tr_rej_${st.id}_${Date.now()}`;
      const nowStr = new Date().toISOString();
      runSql(`
        INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by)
        VALUES (
          '${refId}',
          'idem_${refId}',
          '${st.from_store.toUpperCase()}',
          'TRANSFER',
          '${st.id}',
          0.00,
          0.00,
          'REJECTED',
          'Branch transfer rejected (${reasonEscaped}): ${st.quantity} units returned to ${st.from_store.toUpperCase()}',
          '${nowStr}',
          '${nowStr}',
          '${userRole}'
        )
      `, 'Log transfer rejection transaction');

      alert(`✗ Stock Transfer ${st.id} REJECTED!\n\nReason recorded: "${reason}"\nStock has been safely returned to branch [${st.from_store.toUpperCase()}].`);
      loadRawData();
      persistTablesToStorage();
    } else {
      alert('Error returning stock on reject: ' + restoreRes.error);
    }
  };

  // Execute and commit physical counts sheet and auto-align differences!
  const handleSubmitStockTakeReconciliation = (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) {
      alert('Access Denied: Salespersons are not authorized to reconcile physical inventory differences.');
      return;
    }

    const performer = stocktakePersonnel.trim() || (userRole === 'owner' ? 'Chiposha Conwell (Owner)' : 'Store Manager');
    const notesStr = stocktakeNotes.trim() || 'Regular Physical Inventory Audit Reconciliation';

    // 1. Initiate parent stocktake sheet
    const stocktakeId = 'ST-' + Math.floor(1000 + Math.random() * 9000);
    const nowStr = new Date().toISOString();

    runSql(`
      INSERT INTO stock_takes (id, store_id, taken_at, performed_by, notes)
      VALUES ('${stocktakeId}', '${activeStore}', '${nowStr}', '${performer.replace(/'/g, "''")}', '${notesStr.replace(/'/g, "''")}')
    `, `Audit Logging: Initialize Stocktake Sheet ${stocktakeId} for ${activeStore.toUpperCase()}`);

    // Track total variations to report in summary
    let surplusCount = 0;
    let shortageCount = 0;

    // 2. Align counts and write individual details
    products.forEach((prod) => {
      if (prod.is_service === 1) return; // Skip audit on corporate services
      const liveVirtualStock = prod.stock;
      const rawInpt = countedStocks[prod.id];
      const parsedInput = rawInpt !== undefined && rawInpt.trim() !== '' ? parseInt(rawInpt) : liveVirtualStock;
      const physicalCount = isNaN(parsedInput) ? liveVirtualStock : parsedInput;
      const variance = physicalCount - liveVirtualStock;

      const itemId = 'sti_' + Math.floor(10000 + Math.random() * 90000);

      // Save record item
      runSql(`
        INSERT INTO stock_take_items (id, stock_take_id, product_id, recorded_qty, counted_qty, variance)
        VALUES ('${itemId}', '${stocktakeId}', ${prod.id}, ${liveVirtualStock}, ${physicalCount}, ${variance})
      `, `Audit: Logging item count discrepancy`);

      if (variance !== 0) {
        if (variance > 0) surplusCount++;
        else shortageCount++;

        // Correct virtual inventory stock in SQL store_products override
        runSql(`
          UPDATE store_products 
          SET stock = ${physicalCount}
          WHERE product_id = ${prod.id} AND store_id = '${activeStore}'
        `, `Reconciliation: Adjusting stock level on active store`);

        // Insert double-entry journal entry to track capital variance of inventory shrinkage/surplus!
        const valueImpact = Math.abs(variance * prod.cost);
        const refId = `acc_adj_${stocktakeId}_${prod.id}`;
        const narration = `${prod.name} (SKU: ${prod.sku}) variance is ${variance}`;
        const chan = 'ADJUSTMENT';

        // Insert transaction record
        runSql(`
          INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by)
          VALUES (
            '${refId}', 
            'idem_${refId}', 
            'POS-SYSTEM', 
            '${chan}', 
            '${stocktakeId}', 
            ${valueImpact}, 
            0.00, 
            'SUCCESS', 
            '${narration.replace(/'/g, "''")}', 
            '${nowStr}', 
            '${nowStr}',
            '${performer.replace(/'/g, "''")}'
          )
        `, `Audit: Logging financial variance on transaction ledger`);

        // Post entries: Debit/Credit adjustment accounts
        const debitAct = variance > 0 ? 'gains_inventory' : 'losses_shrinkage';
        const creditAct = 'asset_inventory';
        
        runSql(`INSERT INTO ledger_entries VALUES ('le_${refId}_dr', '${refId}', '${debitAct}', 'DEBIT', ${valueImpact}, '${nowStr}')`, 'Double-entry post debit');
        runSql(`INSERT INTO ledger_entries VALUES ('le_${refId}_cr', '${refId}', '${creditAct}', 'CREDIT', ${valueImpact}, '${nowStr}')`, 'Double-entry post credit');
      }
    });

    logEmployeeAudit('STOCK', 'Submitted Stocktake Audit Sheet', `Stocktake #${stocktakeId} for store ${activeStore.toUpperCase()} completed by ${performer}. Reconciled ${surplusCount} surpluses, ${shortageCount} shortages.`, 0, activeStore, performer);

    alert(`✓ Stock audit reconciled successfully!\nSheet identifier: ${stocktakeId}\nDiscrepancies aligned: ${surplusCount} Surpluses, ${shortageCount} Shortages.\nAll books have been balanced.`);
    
    // Reset states
    setCountedStocks({});
    setStocktakeNotes('');
    loadRawData();
    persistTablesToStorage();
    setActiveSubTab('catalog');
  };

  const categories = ['All', ...allCategoriesList];

  const filteredAndSorted = products
    .filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(searchText.toLowerCase()) || p.sku.toLowerCase().includes(searchText.toLowerCase());
      const matchesCat = selectedCategory === 'All' || p.category === selectedCategory;
      
      let matchesExpiry = true;
      if (expiryFilter === 'within30') {
        if (!p.expiry_date) {
          matchesExpiry = false;
        } else {
          const expStatus = getExpirationStatus(p.expiry_date);
          matchesExpiry = expStatus.status !== 'none' && expStatus.daysLeft <= 30;
        }
      } else if (expiryFilter === 'expired') {
        if (!p.expiry_date) {
          matchesExpiry = false;
        } else {
          const expStatus = getExpirationStatus(p.expiry_date);
          matchesExpiry = expStatus.status === 'expired';
        }
      }

      return matchesSearch && matchesCat && matchesExpiry;
    })
    .sort((a, b) => {
      let comparison = 0;
      if (sortBy === 'name') {
        comparison = a.name.localeCompare(b.name);
      } else if (sortBy === 'price') {
        comparison = a.price - b.price;
      } else if (sortBy === 'stock') {
        comparison = a.stock - b.stock;
      }
      return orderAsc ? comparison : -comparison;
    });

  const toggleSort = (field: 'stock' | 'price' | 'name') => {
    if (sortBy === field) {
      setOrderAsc(!orderAsc);
    } else {
      setSortBy(field);
      setOrderAsc(true);
    }
  };

  const filteredHistoryLogs = useMemo(() => {
    return historyLogs.filter(item => {
      // 1. Movement type filter
      if (historyTypeFilter !== 'all') {
        if (historyTypeFilter === 'sales' && item.movement_type !== 'POS_SALE') return false;
        if (historyTypeFilter === 'receives' && item.movement_type !== 'STOCK_RECEIVE') return false;
        if (historyTypeFilter === 'audits' && item.movement_type !== 'STOCK_AUDIT') return false;
        if (historyTypeFilter === 'transfers' && item.movement_type !== 'BRANCH_TRANSFER') return false;
        if (historyTypeFilter === 'edits' && item.movement_type !== 'MANUAL_EDIT') return false;
      }

      // 2. Store/branch filter
      if (historyStoreFilter !== 'all') {
        const storeStr = String(item.store_id || '').toLowerCase();
        if (!storeStr.includes(historyStoreFilter.toLowerCase())) return false;
      }

      // 3. Search text
      if (historySearchText.trim()) {
        const q = historySearchText.toLowerCase().trim();
        const matchName = String(item.product_name || '').toLowerCase().includes(q);
        const matchSku = String(item.product_sku || '').toLowerCase().includes(q);
        const matchRef = String(item.ref_id || '').toLowerCase().includes(q);
        const matchNarration = String(item.narration || '').toLowerCase().includes(q);
        const matchUser = String(item.performed_by || '').toLowerCase().includes(q);
        if (!matchName && !matchSku && !matchRef && !matchNarration && !matchUser) return false;
      }

      return true;
    });
  }, [historyLogs, historyTypeFilter, historyStoreFilter, historySearchText]);

  const historySummaryStats = useMemo(() => {
    let unitsSold = 0;
    let unitsReceived = 0;
    let totalValue = 0;

    filteredHistoryLogs.forEach(item => {
      if (item.movement_type === 'POS_SALE') {
        unitsSold += Math.abs(item.change_qty || 0);
        totalValue += Number(item.total_value || 0);
      } else if (item.movement_type === 'STOCK_RECEIVE') {
        totalValue += Number(item.total_value || 0);
      } else if (item.movement_type === 'STOCK_AUDIT') {
        if (item.change_qty > 0) unitsReceived += item.change_qty;
        else if (item.change_qty < 0) unitsSold += Math.abs(item.change_qty);
      }
    });

    return {
      totalCount: filteredHistoryLogs.length,
      unitsSold,
      unitsReceived,
      totalValue
    };
  }, [filteredHistoryLogs]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50 relative select-text text-left">
      
      {/* Search and multi-store settings controls */}
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col gap-3 shrink-0">
        
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Main heading highlighting active store */}
          <div>
            <span className="text-[10px] text-indigo-600 font-extrabold tracking-widest uppercase font-mono">Store Inventory Hub</span>
            <h2 className="text-sm font-black text-slate-900 uppercase tracking-tight flex items-center gap-1">
              <Package size={16} className="text-slate-700" />
              {activeStore.toUpperCase()} BRANCH STOCK
            </h2>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {onNavigateToSale && (
              <button
                id="btn_inventory_top_sale"
                onClick={onNavigateToSale}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white rounded-lg text-xs font-black tracking-wider uppercase transition-all cursor-pointer shadow-xs border border-emerald-500"
                title="Jump to Point of Sale (POS Terminal) Register"
              >
                <ShoppingCart size={14} className="stroke-[2.5]" />
                <span>SALE REGISTER</span>
              </button>
            )}

            {/* Tab switcher buttons */}
            <div className="bg-slate-100 p-0.5 rounded-lg border border-slate-200 flex gap-0.5">
              <button
                onClick={() => setActiveSubTab('catalog')}
                className={`px-3 py-1.5 text-[10px] uppercase font-bold rounded-md tracking-wider transition-all cursor-pointer ${
                  activeSubTab === 'catalog'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                📦 Catalog List
              </button>

              {userRole === 'owner' && (
                <button
                  onClick={() => setActiveSubTab('global_matrix')}
                  className={`px-3 py-1.5 text-[10px] uppercase font-bold rounded-md tracking-wider transition-all cursor-pointer ${
                    activeSubTab === 'global_matrix'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  📊 Comparative Grid (All Stores)
                </button>
              )}

              <button
                onClick={() => {
                  // Pre-fill default values for countedStocks
                  const preCount: Record<number, string> = {};
                  products.forEach(p => {
                    preCount[p.id] = p.stock.toString();
                  });
                  setCountedStocks(preCount);
                  setActiveSubTab('stock_take');
                }}
                className={`px-3 py-1.5 text-[10px] uppercase font-bold rounded-md tracking-wider transition-all cursor-pointer ${
                  activeSubTab === 'stock_take'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                📝 Physical Stock-Take
              </button>

              <button
                onClick={() => setActiveSubTab('inventory_history')}
                className={`px-3 py-1.5 text-[10px] uppercase font-bold rounded-md tracking-wider transition-all cursor-pointer ${
                  activeSubTab === 'inventory_history'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                📜 Inventory History
              </button>

              <button
                onClick={() => setActiveSubTab('transfers_ledger')}
                className={`px-3 py-1.5 text-[10px] uppercase font-bold rounded-md tracking-wider transition-all cursor-pointer ${
                  activeSubTab === 'transfers_ledger'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                🔄 Transfers Log
              </button>
            </div>
          </div>
        </div>

        {activeSubTab === 'catalog' && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 animate-fadeIn">
            {/* Left Search Filter */}
            <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
              <div className="relative flex-1 min-w-[200px] max-w-xs">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 bg-slate-100 border border-slate-200 rounded-lg text-xs font-semibold focus:outline-hidden text-slate-800"
                  placeholder="Search by product name, SKU..."
                />
              </div>

              <div className="flex items-center gap-1.5">
                <select
                  value={selectedCategory}
                  onChange={(e) => {
                    if (e.target.value === '__MANAGE__') {
                      setShowCategoryModal(true);
                    } else {
                      setSelectedCategory(e.target.value);
                    }
                  }}
                  className="text-xs font-bold border border-slate-250 bg-white rounded-lg p-1.5 cursor-pointer text-slate-700"
                >
                  {categories.map(c => (
                    <option key={c} value={c}>{c === 'All' ? 'All Categories' : c}</option>
                  ))}
                  <option value="__MANAGE__">⚙️ Manage / Edit Categories...</option>
                </select>

                {!isReadOnly && (
                  <button
                    onClick={() => setShowCategoryModal(true)}
                    className="px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-xs font-extrabold flex items-center gap-1.5 cursor-pointer transition-all shadow-3xs"
                    title="Create or edit item categories"
                  >
                    <Tag size={13} />
                    <span>Categories</span>
                  </button>
                )}
              </div>

              <select
                id="expiry-filter-select"
                value={expiryFilter}
                onChange={(e) => setExpiryFilter(e.target.value as any)}
                className={`text-xs font-bold border rounded-lg p-1.5 cursor-pointer transition-colors ${
                  expiryFilter !== 'all' 
                    ? 'bg-amber-50 text-amber-900 border-amber-300 focus:ring-1 focus:ring-amber-400' 
                    : 'bg-white text-slate-700 border-slate-250'
                }`}
              >
                <option value="all">🗓️ All Expiries</option>
                <option value="within30">⏳ Expiring within 30 days</option>
                <option value="expired">🚨 Already Expired</option>
              </select>
            </div>

            {/* Action button rails */}
            <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
              <button
                onClick={() => {
                  if (isReadOnly) {
                    alert('Access Denied: Salespersons cannot initiate inter-store stock shipments.');
                    return;
                  }
                  setTransferSearchQuery('');
                  setTransferCart([]);
                  setTransferFromStore(activeStore);
                  setTransferToStore(activeStore === 'lusaka' ? 'kitwe' : 'lusaka');
                  setTransferProductId(products.length > 0 ? products[0].id.toString() : '');
                  setShowTransferModal(true);
                }}
                className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-bold tracking-wider cursor-pointer shadow-3xs"
              >
                <ArrowRightLeft size={13} />
                INTER-STORE TRANSFER
              </button>

              {!isReadOnly && (
                <button
                  onClick={() => setShowAddModal(true)}
                  className="flex items-center gap-1 px-3.5 py-2 bg-indigo-600 active:bg-indigo-700 text-white rounded-lg text-xs font-extrabold cursor-pointer h-full"
                >
                  <Plus size={14} />
                  NEW ITEM
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {isReadOnly && (
        <div className="mx-4 mt-3 p-3 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-800 font-bold flex items-center gap-2.5 shadow-3xs shrink-0 select-none">
          <ShieldAlert size={15} />
          <span>READ-ONLY SALES ACCESS LEVEL ACTIVE: PORT-LOCK PREVENTS YOU FROM ALTERING SYSTEM CATALOG METADATA OR MANUALLY EDITING MULTI-STORE OVERRIDES.</span>
        </div>
      )}

      {/* Primary Grid Workspace */}
      <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">

        {activeSubTab === 'catalog' && (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-xs animate-fadeIn">
            <table className="w-full text-left font-sans text-xs border-collapse">
              <thead>
                <tr className="bg-slate-900 text-slate-200 border-b border-slate-850 font-semibold uppercase text-[9.5px] select-none">
                  <th className="px-4 py-3">Product Name</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-800" onClick={() => toggleSort('price')}>Price ({activeStore.toUpperCase()})</th>
                  <th className="px-4 py-3">Global Cost</th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-800" onClick={() => toggleSort('stock')}>Active Stock ({activeStore.toUpperCase()})</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                {filteredAndSorted.map(prod => {
                  const isEditing = editingId === prod.id;
                  const isService = prod.is_service === 1;
                  const lowStock = !isService && prod.stock <= 5;
                  const outOfStock = !isService && prod.stock === 0;

                  return (
                    <tr key={prod.id} className={`${outOfStock ? 'bg-red-50/15' : lowStock ? 'bg-amber-50/15' : ''}`}>
                      <td className="px-4 py-2.5">
                        <div className="flex items-start gap-3">
                          <img src={prod.imageUrl} alt={prod.name} className="w-9 h-9 rounded-lg object-cover border mt-0.5" referrerPolicy="no-referrer" />
                          <div className="flex-1 min-w-0 text-left">
                            <p className="font-extrabold text-slate-800 text-xs">{prod.name}</p>
                            <p className="text-[10px] font-mono font-semibold text-slate-400">SKU: {prod.sku}</p>
                            {isEditing ? (
                              <div className="mt-2 grid grid-cols-1 gap-1.5 bg-slate-50 p-2 rounded border border-slate-200">
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-[8px] text-slate-400 font-bold uppercase">Batch / Lot Number</span>
                                  <input
                                    type="text"
                                    value={editBatchNumber}
                                    onChange={(e) => setEditBatchNumber(e.target.value)}
                                    className="px-1.5 py-0.5 text-[10px] border rounded bg-white font-mono text-slate-800 font-semibold"
                                    placeholder="Batch Number"
                                  />
                                </div>
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-[8px] text-slate-400 font-bold uppercase">Expiry Date</span>
                                  <input
                                    type="date"
                                    value={editExpiryDate}
                                    onChange={(e) => setEditExpiryDate(e.target.value)}
                                    className="px-1.5 py-0.5 text-[10px] border rounded bg-white text-slate-800 font-semibold"
                                  />
                                </div>
                              </div>
                            ) : (
                              <>
                                {prod.batch_number && (
                                  <p className="text-[10px] font-mono font-semibold text-indigo-650 mt-0.5">
                                    Batch: <span className="font-extrabold">{prod.batch_number}</span>
                                  </p>
                                )}
                                {prod.expiry_date && (() => {
                                  const exp = getExpirationStatus(prod.expiry_date);
                                  if (exp.status === 'none') return null;
                                  return (
                                    <div className="mt-1 flex items-center gap-1.5 select-none">
                                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider ${
                                        exp.status === 'expired' 
                                          ? 'bg-red-100 text-red-700 animate-pulse border border-red-200' 
                                          : exp.status === 'today'
                                            ? 'bg-amber-100 text-red-800 border border-red-300 font-black animate-pulse'
                                            : exp.status === 'nearing'
                                              ? 'bg-amber-100 text-amber-800 border border-amber-250 font-bold'
                                              : 'bg-slate-100 text-slate-650 border border-slate-200'
                                      }`}>
                                        ⚠️ {exp.label} ({prod.expiry_date})
                                      </span>
                                    </div>
                                  );
                                })()}
                              </>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-[10px] h-full font-bold text-slate-600">
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <select
                              value={editCategory}
                              onChange={(e) => {
                                if (e.target.value === '__NEW__') {
                                  const custom = window.prompt("Enter new category name:");
                                  if (custom && custom.trim()) {
                                    const trimmed = custom.trim();
                                    if (!customCategories.includes(trimmed)) {
                                      saveCustomCategories([...customCategories, trimmed]);
                                    }
                                    setEditCategory(trimmed);
                                  }
                                } else {
                                  setEditCategory(e.target.value);
                                }
                              }}
                              className="px-1.5 py-1 text-xs font-bold border rounded border-indigo-400 bg-white text-slate-800 focus:outline-hidden"
                            >
                              {allCategoriesList.map(cat => (
                                <option key={cat} value={cat}>{cat}</option>
                              ))}
                              {!allCategoriesList.includes(editCategory) && editCategory && (
                                <option value={editCategory}>{editCategory}</option>
                              )}
                              <option value="__NEW__">+ Create New Category...</option>
                            </select>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 group">
                            <span className="text-[10px] font-extrabold text-slate-600 uppercase bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-md">
                              {prod.category || 'General'}
                            </span>
                            {!isReadOnly && (
                              <button
                                onClick={() => {
                                  const custom = window.prompt(
                                    `Change category for "${prod.name}":\n(Choose existing: ${allCategoriesList.join(', ')} or type a new name)`,
                                    prod.category || 'General'
                                  );
                                  if (custom !== null && custom.trim() !== '') {
                                    const cleanCat = custom.trim();
                                    runSql(`UPDATE products SET category = '${cleanCat.replace(/'/g, "''")}' WHERE id = ${prod.id}`, 'Quick edit product category');
                                    if (!allCategoriesList.includes(cleanCat)) {
                                      saveCustomCategories([...customCategories, cleanCat]);
                                    }
                                    loadRawData();
                                    persistTablesToStorage();
                                  }
                                }}
                                className="text-slate-400 hover:text-indigo-600 p-1 rounded-md hover:bg-slate-100 cursor-pointer transition-all"
                                title="Click to edit or change category for this item"
                              >
                                <Edit2 size={12} />
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      
                      {/* Price */}
                      <td className="px-4 py-2.5">
                        {isEditing ? (
                          <input
                            type="number"
                            step="0.01"
                            value={editPrice}
                            onChange={(e) => setEditPrice(parseFloat(e.target.value) || 0)}
                            className="w-16 px-1 py-0.5 border rounded border-indigo-400 text-xs font-bold font-mono"
                          />
                        ) : (
                          <span className="text-indigo-700 font-mono font-bold">{settings.currency}{prod.price.toFixed(2)}</span>
                        )}
                      </td>

                      {/* Cost */}
                      <td className="px-4 py-2.5">
                        {isEditing ? (
                          <input
                            type="number"
                            step="0.01"
                            value={editCost}
                            onChange={(e) => setEditCost(parseFloat(e.target.value) || 0)}
                            className="w-16 px-1 py-0.5 border rounded border-indigo-400 text-xs font-bold font-mono"
                          />
                        ) : (
                          <span className="font-mono text-slate-500">{settings.currency}{prod.cost.toFixed(2)}</span>
                        )}
                      </td>

                      {/* Stock override level */}
                      <td className="px-4 py-2.5">
                        {isEditing ? (
                          isService ? (
                            <span className="text-xs text-slate-400 italic">No Stock Needed</span>
                          ) : (
                            <input
                              type="number"
                              value={editStock}
                              onChange={(e) => setEditStock(parseInt(e.target.value) || 0)}
                              className="w-16 px-1 py-0.5 border rounded border-indigo-400 text-xs font-bold font-mono"
                            />
                          )
                        ) : (
                          <div className="flex items-center gap-2">
                            {isService ? (
                              <span className="px-2 py-0.5 rounded-md font-sans text-xs font-extrabold bg-indigo-50 text-indigo-700">
                                Service (Unlimited)
                              </span>
                            ) : (
                              <span className={`px-2 py-0.5 rounded-md font-mono text-xs font-bold ${
                                outOfStock 
                                  ? 'bg-red-100 text-red-800' 
                                  : lowStock 
                                    ? 'bg-amber-100 text-amber-800' 
                                    : 'bg-emerald-50 text-emerald-800'
                              }`}>
                                {prod.stock} units
                              </span>
                            )}
                            {!isReadOnly && !isService && (
                              <button
                                onClick={() => {
                                  setReceiveProduct(prod);
                                  setReceiveQty('10');
                                  setReceiveBatch(prod.batch_number || '');
                                  setReceiveExpiry(prod.expiry_date || '');
                                  setShowReceiveModal(true);
                                }}
                                className="px-2 py-0.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 hover:text-indigo-800 rounded-md border border-indigo-100 cursor-pointer text-[10px] font-black transition-all"
                                title="Receive / Quick Add Stock"
                              >
                                + Add Stock
                              </button>
                            )}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-2.5 text-right">
                        {isEditing ? (
                          <div className="flex justify-end gap-1.5">
                            <button onClick={() => handleSaveEdit(prod.id)} className="p-1 px-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[11px] font-bold">✓ Save</button>
                            <button onClick={() => setEditingId(null)} className="p-1 px-2.5 bg-slate-200 text-slate-600 rounded text-[11px] font-bold">✕ Cancel</button>
                          </div>
                        ) : (
                          <div className="flex justify-end gap-2 shrink-0 select-none">
                            <button onClick={() => handleStartEdit(prod)} className="text-indigo-600 hover:bg-indigo-50 border border-indigo-150 py-1 px-2 rounded-md text-[11px] font-bold cursor-pointer">
                              Edit Override
                            </button>
                            {userRole === 'owner' && (
                              <button onClick={() => handleDeleteProduct(prod.id, prod.name)} className="text-rose-500 hover:bg-rose-50 border border-rose-100 py-1 px-1.5 rounded-md text-[11px] font-bold cursor-pointer">
                                Delete
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* COMPARATIVE OWNER OVERVIEW PIVOT MATRIX */}
        {activeSubTab === 'global_matrix' && userRole === 'owner' && (
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs flex flex-col gap-4 animate-fadeIn">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <div>
                <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest font-mono">Multi-Store Consolidated Comparative Inventory Pivot</h3>
                <p className="text-[10.5px] text-slate-400 font-medium">Real-time side-by-side branch comparisons with global cumulative balances</p>
              </div>

              {/* Real-time search UI for consolidated comparative pivot */}
              <div className="relative w-full sm:w-64 shrink-0">
                <Search size={14} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={pivotSearchText}
                  onChange={(e) => setPivotSearchText(e.target.value)}
                  placeholder="Filter pivot by name, SKU or category..."
                  className="w-full bg-slate-50 border border-slate-200 pl-9 pr-4 py-1.5 rounded-lg text-xs font-semibold text-slate-800 placeholder-slate-400 focus:outline-indigo-500 focus:bg-white"
                />
                {pivotSearchText && (
                  <button 
                    onClick={() => setPivotSearchText('')} 
                    className="absolute right-2.5 top-1/2 transform -translate-y-1/2 text-[10px] bg-slate-200 hover:bg-slate-300 rounded px-1 text-slate-600 font-bold"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            <div className="overflow-x-auto border border-slate-150 rounded-lg">
              <table className="w-full text-left font-sans text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-900 text-slate-200 border-b border-slate-850 font-semibold uppercase text-[9px] select-none">
                    <th className="px-4 py-3 min-w-[180px]">Product SKU & Name</th>
                    {getStoresList().map((st: any) => (
                      <th key={st.id} className="px-4 py-3 text-center border-l border-slate-800">
                        {st.name.toUpperCase()} (STK / PRICE)
                      </th>
                    ))}
                    <th className="px-4 py-3 text-right bg-indigo-950 text-indigo-200 border-l border-indigo-900">
                      CUMULATIVE OVERALL
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                  {matrixData.filter((m: any) => {
                    if (!pivotSearchText.trim()) return true;
                    const query = pivotSearchText.toLowerCase();
                    return (
                      m.name.toLowerCase().includes(query) ||
                      m.sku.toLowerCase().includes(query) ||
                      m.category.toLowerCase().includes(query)
                    );
                  }).map((m: any) => {
                    const isService = m.is_service === 1;
                    const isCumulativeLow = !isService && m.totalStock <= 15;
                    const isOutOfStock = !isService && m.totalStock === 0;

                    return (
                      <tr key={m.id} className="hover:bg-slate-50/50">
                        <td className="px-4 py-3">
                          <p className="font-extrabold text-slate-800 text-xs">{m.name}</p>
                          <span className="text-[9.5px] font-mono font-bold text-slate-400">SKU: {m.sku} | Cat: {m.category}</span>
                        </td>
                        {getStoresList().map((st: any) => {
                          const val = m.stores[st.id] || { stock: m.stock, price: m.price };
                          const out = val.stock === 0;
                          return (
                            <td key={st.id} className="px-4 py-3 text-center border-l bg-slate-50/30">
                              {isService ? (
                                <span className="text-xs font-sans font-extrabold text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded">
                                  Service
                                </span>
                              ) : (
                                <span className={`text-xs font-mono font-bold ${out ? 'text-red-600 bg-red-100/60' : 'text-slate-800 bg-slate-100'} px-1.5 py-0.5 rounded`}>
                                  {val.stock} u
                                </span>
                              )}
                              <span className="text-[10px] text-indigo-700 font-mono font-extrabold ml-1.5">
                                {settings.currency}{val.price.toFixed(1)}
                              </span>
                            </td>
                          );
                        })}
                        <td className="px-4 py-3 text-right bg-indigo-50/30 border-l border-indigo-100 font-mono">
                          {isService ? (
                            <span className="px-2 py-1 rounded font-bold bg-indigo-100 text-indigo-800 text-[10px]">
                              UNLIMITED
                            </span>
                          ) : (
                            <span className={`px-2 py-1 rounded font-bold ${
                              isOutOfStock 
                                ? 'bg-rose-100 text-rose-800' 
                                : isCumulativeLow 
                                  ? 'bg-amber-100 text-amber-800 font-extrabold' 
                                  : 'bg-indigo-600 text-white font-extrabold shadow-3xs'
                            }`}>
                              {m.totalStock} units
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* RECONSTRUCTED STOCK-TAKE PHYSICAL COUNT AUDIT SHEET */}
        {activeSubTab === 'stock_take' && (
          <form onSubmit={handleSubmitStockTakeReconciliation} className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs flex flex-col gap-5 animate-fadeIn">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b border-slate-100 pb-3">
              <div>
                <span className="text-[8.5px] bg-indigo-600 text-white font-black py-0.5 px-2 rounded-full uppercase tracking-widest font-mono select-none">RECONCILER ACTIVE</span>
                <h3 className="text-sm font-black text-slate-900 uppercase tracking-tight mt-1">
                  Physical Stocktake Count Sheet — {activeStore.toUpperCase()} Branch
                </h3>
                <p className="text-[10px] text-slate-400 font-medium font-sans">
                  Type physical counted units below. Variance compares calculated database stock side-by-side with actual physical count.
                </p>
              </div>

              <div className="flex flex-wrap gap-3.5 text-xs w-full sm:w-auto">
                {/* Admin Stocktake Scheduling Frequency Option */}
                {userRole !== 'sales' ? (
                  <div className="flex flex-col gap-1">
                    <label className="text-[9px] uppercase font-black text-slate-450 font-mono tracking-wider">Assign Schedule (Admin Only)</label>
                    <select
                      value={stocktakeFreq}
                      onChange={(e) => {
                        const newFreq = e.target.value as any;
                        setStocktakeFreq(newFreq);
                        runSql(`UPDATE stores SET stocktake_frequency = '${newFreq}' WHERE id = '${activeStore}'`, `Update stocktake frequency to ${newFreq}`);
                        alert(`✓ Admin Configuration Saved:\n\nSet stocktake balancing schedules for store branch [${activeStore.toUpperCase()}] to a [${newFreq.toUpperCase()}] compliance interval.`);
                        persistTablesToStorage();
                      }}
                      className="px-3 py-1.5 bg-indigo-50 border border-indigo-200 focus:bg-white text-xs rounded-lg font-black text-indigo-850 cursor-pointer"
                    >
                      <option value="weekly">🗓️ Weekly Interval Balance</option>
                      <option value="monthly">📅 Monthly Interval Balance</option>
                      <option value="quarterly">⏳ Quarterly Interval Balance</option>
                    </select>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <label className="text-[9px] uppercase font-black text-slate-450 font-mono tracking-wider">Audit Frequency</label>
                    <span className="px-3 py-1.5 bg-slate-100 border border-slate-200 text-xs rounded-lg font-mono font-bold text-slate-705 block whitespace-nowrap">
                      Schedules: <strong className="text-indigo-800 uppercase font-extrabold">{stocktakeFreq}</strong>
                    </span>
                  </div>
                )}

                <div className="flex flex-col gap-1 min-w-[200px]">
                  <label className="text-[9px] uppercase font-bold text-slate-400 font-mono">Performing Auditor Name</label>
                  <input
                    type="text"
                    required
                    value={stocktakePersonnel}
                    onChange={(e) => setStocktakePersonnel(e.target.value)}
                    placeholder="e.g. Chiposha Conwell (Owner)"
                    className="px-3 py-1.5 bg-slate-50 border border-slate-200 focus:bg-white text-xs rounded-lg font-bold text-slate-800"
                  />
                </div>
              </div>
            </div>

            {/* Custom stocktake inventory search filter bar */}
            <div className="flex border-t border-b border-slate-100 py-3 items-center justify-between gap-3">
              <span className="text-[10px] text-indigo-800 font-black uppercase tracking-wider flex items-center gap-1">
                🔎 Stocktake List Filtering
              </span>
              <div className="relative w-full sm:w-80">
                <Search size={14} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={stocktakeSearchText}
                  onChange={(e) => setStocktakeSearchText(e.target.value)}
                  placeholder="Quick search products by name, category or SKU..."
                  className="w-full bg-slate-50 border border-slate-200 pl-9 pr-4 py-1.5 rounded-lg text-xs font-semibold text-slate-800 placeholder-slate-400 focus:outline-indigo-500 focus:bg-white"
                />
                {stocktakeSearchText && (
                  <button 
                    type="button" 
                    onClick={() => setStocktakeSearchText('')} 
                    className="absolute right-2.5 top-1/2 transform -translate-y-1/2 text-[10px] bg-slate-200 hover:bg-slate-300 rounded px-1 text-slate-600 font-bold"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Table counting items */}
            <div className="overflow-x-auto border border-slate-150 rounded-lg">
              <table className="w-full text-left font-sans text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-900 text-slate-200 border-b border-slate-850 font-semibold uppercase text-[9.5px] select-none">
                    <th className="px-4 py-3">Product Name & SKU</th>
                    <th className="px-4 py-3 text-center">Calculated (Recorded) Stock</th>
                    <th className="px-4 py-3 text-center w-[160px]">Physical (Counted) Stock</th>
                    <th className="px-4 py-3 text-right">Variance Impact</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                  {products.filter(p => {
                    if (p.is_service === 1) return false;
                    if (!stocktakeSearchText.trim()) return true;
                    const query = stocktakeSearchText.toLowerCase();
                    return (
                      p.name.toLowerCase().includes(query) ||
                      (p.sku && p.sku.toLowerCase().includes(query)) ||
                      (p.category && p.category.toLowerCase().includes(query))
                    );
                  }).map(p => {
                    const recordedVal = p.stock;
                    const cVal = countedStocks[p.id] !== undefined ? countedStocks[p.id] : '';
                    const countedVal = cVal === '' ? recordedVal : parseInt(cVal) || 0;
                    const variance = countedVal - recordedVal;

                    return (
                      <tr key={p.id} className="hover:bg-slate-50/50">
                        <td className="px-4 py-2.5">
                          <p className="font-extrabold text-slate-850 text-xs">{p.name}</p>
                          <span className="font-mono text-[9px] text-slate-400">SKU: {p.sku}</span>
                        </td>
                        <td className="px-4 py-2.5 text-center font-mono text-slate-500 font-bold">
                          {recordedVal} units
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <input
                            type="number"
                            min="0"
                            placeholder={recordedVal.toString()}
                            value={cVal}
                            onChange={(e) => {
                              const v = e.target.value;
                              setCountedStocks(prev => ({
                                ...prev,
                                [p.id]: v
                              }));
                            }}
                            className="w-24 px-2 py-1 bg-slate-50 border border-slate-250 focus:bg-white rounded font-mono font-bold text-slate-850 text-center text-xs"
                          />
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs">
                          {variance === 0 ? (
                            <span className="text-slate-400 font-bold">In-Sync (0)</span>
                          ) : variance > 0 ? (
                            <span className="text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded font-extrabold">
                              +{variance} Surplus
                            </span>
                          ) : (
                            <span className="text-rose-600 bg-rose-50 px-2 py-0.5 rounded font-extrabold">
                              {variance} Shortage
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end bg-slate-50 p-4 border border-slate-150 rounded-xl select-none">
              <div className="flex flex-col gap-1.5 text-xs">
                <label className="text-[9px] uppercase font-bold text-slate-400 font-mono">Stocktake Reconcile Narrative Notes</label>
                <textarea
                  value={stocktakeNotes}
                  onChange={(e) => setStocktakeNotes(e.target.value)}
                  placeholder="Regular inventory tally & physical stock auditing checklist notes..."
                  className="w-full p-2.5 bg-white border border-slate-200 focus:border-indigo-500 focus:outline-hidden text-xs rounded-lg text-slate-800"
                  rows={2}
                />
              </div>

              <div className="flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setCountedStocks({});
                    setActiveSubTab('catalog');
                  }}
                  className="px-4 py-2 bg-slate-205 border border-slate-300 hover:bg-slate-300 rounded-lg text-xs font-bold text-slate-700 cursor-pointer"
                >
                  ABORT SHEET
                </button>
                <button
                  type="submit"
                  disabled={isReadOnly}
                  className={`px-5 py-2 text-white font-extrabold uppercase rounded-lg text-xs tracking-wider shadow-md cursor-pointer ${
                    isReadOnly 
                      ? 'bg-slate-400 cursor-not-allowed' 
                      : 'bg-indigo-600 hover:bg-indigo-700'
                  }`}
                >
                  ✓ Reconcile & Align stock levels
                </button>
              </div>
            </div>
          </form>
        )}

        {/* INVENTORY HISTORY & MOVEMENT LEDGER TAB LAYOUT */}
        {activeSubTab === 'inventory_history' && (
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs animate-fadeIn flex flex-col gap-4">
            
            {/* Header & Metric Cards */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                  <History size={16} className="text-indigo-600" />
                  Inventory Movement & Transaction History
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Complete chronological audit trail of all sales, stock receives, physical audits, branch transfers, and manual adjustments.
                </p>
              </div>

              <button
                onClick={() => loadInventoryHistory()}
                className="px-2.5 py-1.5 text-[11px] bg-slate-100 hover:bg-slate-200 border border-slate-200 font-bold text-slate-700 rounded-lg flex items-center gap-1.5 transition-colors self-start sm:self-auto cursor-pointer"
              >
                <RefreshCw size={12} />
                Refresh Ledger
              </button>
            </div>

            {/* Metric Overview Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <div className="flex items-center justify-between text-slate-500 mb-1">
                  <span className="text-[10px] font-extrabold uppercase tracking-wider">Total History Logs</span>
                  <FileText size={14} className="text-indigo-600" />
                </div>
                <div className="text-base font-black text-slate-900 font-mono">
                  {historySummaryStats.totalCount} <span className="text-[10px] text-slate-500 font-sans font-normal">Records</span>
                </div>
              </div>

              <div className="bg-emerald-50/60 border border-emerald-200/80 rounded-lg p-3">
                <div className="flex items-center justify-between text-emerald-700 mb-1">
                  <span className="text-[10px] font-extrabold uppercase tracking-wider">Stock Sales (Outflow)</span>
                  <TrendingDown size={14} className="text-emerald-600" />
                </div>
                <div className="text-base font-black text-emerald-900 font-mono">
                  {historySummaryStats.unitsSold} <span className="text-[10px] text-emerald-700 font-sans font-normal">Units</span>
                </div>
              </div>

              <div className="bg-blue-50/60 border border-blue-200/80 rounded-lg p-3">
                <div className="flex items-center justify-between text-blue-700 mb-1">
                  <span className="text-[10px] font-extrabold uppercase tracking-wider">Receives & Audits (Inflow)</span>
                  <TrendingUp size={14} className="text-blue-600" />
                </div>
                <div className="text-base font-black text-blue-900 font-mono">
                  {historySummaryStats.unitsReceived > 0 ? `+${historySummaryStats.unitsReceived}` : historySummaryStats.unitsReceived} <span className="text-[10px] text-blue-700 font-sans font-normal">Units</span>
                </div>
              </div>

              <div className="bg-indigo-50/60 border border-indigo-200/80 rounded-lg p-3">
                <div className="flex items-center justify-between text-indigo-700 mb-1">
                  <span className="text-[10px] font-extrabold uppercase tracking-wider">Total Value Impact</span>
                  <Activity size={14} className="text-indigo-600" />
                </div>
                <div className="text-base font-black text-indigo-900 font-mono">
                  {settings.currency} {historySummaryStats.totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
            </div>

            {/* Filter and Search Control Bar */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
              
              {/* Search Box */}
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={historySearchText}
                  onChange={(e) => setHistorySearchText(e.target.value)}
                  placeholder="Search by product name, SKU, invoice #, or cashier..."
                  className="w-full pl-9 pr-8 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-indigo-500 font-medium placeholder:text-slate-400"
                />
                {historySearchText && (
                  <button
                    onClick={() => setHistorySearchText('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {/* Movement Type & Branch Dropdowns */}
              <div className="flex items-center gap-2 shrink-0 overflow-x-auto pb-1 sm:pb-0">
                <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider flex items-center gap-1 shrink-0">
                  <Filter size={11} /> Filter:
                </span>
                <select
                  value={historyTypeFilter}
                  onChange={(e) => setHistoryTypeFilter(e.target.value)}
                  className="text-xs bg-white border border-slate-200 rounded-md px-2 py-1.5 font-bold text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
                >
                  <option value="all">All Movement Types</option>
                  <option value="sales">🛒 POS Sales</option>
                  <option value="receives">📥 Stock Receives</option>
                  <option value="audits">📝 Physical Audits</option>
                  <option value="transfers">🔄 Branch Transfers</option>
                  <option value="edits">✏️ Manual Edits</option>
                </select>

                <select
                  value={historyStoreFilter}
                  onChange={(e) => setHistoryStoreFilter(e.target.value)}
                  className="text-xs bg-white border border-slate-200 rounded-md px-2 py-1.5 font-bold text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
                >
                  <option value="all">All Store Branches</option>
                  <option value="lusaka">Lusaka Main</option>
                  <option value="kitwe">Kitwe Outlet</option>
                  <option value="ndola">Ndola Depot</option>
                </select>
              </div>
            </div>

            {/* Transactions & Inventory Log Table */}
            <div className="overflow-x-auto max-h-[500px] overflow-y-auto border border-slate-200 rounded-lg">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="sticky top-0 bg-slate-100 z-10">
                  <tr className="text-slate-500 font-extrabold uppercase text-[9px] tracking-wider select-none border-b border-slate-200">
                    <th className="py-2.5 px-3">Date & Time</th>
                    <th className="py-2.5 px-3">Type</th>
                    <th className="py-2.5 px-3">Branch</th>
                    <th className="py-2.5 px-3">Product Name & SKU</th>
                    <th className="py-2.5 px-3 text-center">Qty Change</th>
                    <th className="py-2.5 px-3 text-right">Value Impact</th>
                    <th className="py-2.5 px-3">Ref / Invoice</th>
                    <th className="py-2.5 px-3">Performed By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white font-medium">
                  {filteredHistoryLogs.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-12 text-center text-slate-400">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <History size={32} className="text-slate-300" />
                          <p className="font-bold text-xs">No inventory history logs match your selected search or filter.</p>
                          <button
                            onClick={() => {
                              setHistorySearchText('');
                              setHistoryTypeFilter('all');
                              setHistoryStoreFilter('all');
                            }}
                            className="text-[11px] text-indigo-600 font-bold hover:underline cursor-pointer"
                          >
                            Reset filters
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredHistoryLogs.map((item) => {
                      const isSale = item.movement_type === 'POS_SALE';
                      const isReceive = item.movement_type === 'STOCK_RECEIVE';
                      const isAudit = item.movement_type === 'STOCK_AUDIT';
                      const isTransfer = item.movement_type === 'BRANCH_TRANSFER';
                      const isEdit = item.movement_type === 'MANUAL_EDIT';

                      return (
                        <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                          {/* Date & Time */}
                          <td className="py-2.5 px-3 text-slate-500 text-[11px] font-mono whitespace-nowrap">
                            {item.created_at ? new Date(item.created_at).toLocaleString() : 'N/A'}
                          </td>

                          {/* Movement Type Badge */}
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            {isSale && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-rose-50 text-rose-700 border border-rose-200">
                                <ShoppingCart size={10} /> POS Sale
                              </span>
                            )}
                            {isReceive && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-50 text-emerald-700 border border-emerald-200">
                                <ArrowDownRight size={10} /> Receive
                              </span>
                            )}
                            {isAudit && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-amber-50 text-amber-700 border border-amber-200">
                                <FileText size={10} /> Audit
                              </span>
                            )}
                            {isTransfer && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-purple-50 text-purple-700 border border-purple-200">
                                <ArrowRightLeft size={10} /> Transfer
                              </span>
                            )}
                            {isEdit && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-slate-100 text-slate-700 border border-slate-300">
                                <Edit2 size={10} /> Manual
                              </span>
                            )}
                          </td>

                          {/* Store / Branch */}
                          <td className="py-2.5 px-3 uppercase font-extrabold text-[10px] tracking-wider text-slate-600 font-mono whitespace-nowrap">
                            {item.store_id || 'N/A'}
                          </td>

                          {/* Product Name & SKU */}
                          <td className="py-2.5 px-3">
                            <div className="font-bold text-slate-900 text-xs">{item.product_name}</div>
                            {item.narration && (
                              <div className="text-[10px] text-slate-500 font-normal truncate max-w-xs">{item.narration}</div>
                            )}
                            {item.product_sku && (
                              <div className="text-[9px] text-slate-400 font-mono">{item.product_sku}</div>
                            )}
                          </td>

                          {/* Quantity Change */}
                          <td className="py-2.5 px-3 text-center whitespace-nowrap">
                            {item.change_qty !== 0 ? (
                              <span className={`font-mono font-black text-xs px-2 py-0.5 rounded ${
                                item.change_qty < 0 ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-600'
                              }`}>
                                {item.change_qty > 0 ? `+${item.change_qty}` : item.change_qty} units
                              </span>
                            ) : (
                              <span className="text-slate-400 text-[11px] font-mono">—</span>
                            )}
                          </td>

                          {/* Total Value */}
                          <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-800 whitespace-nowrap">
                            {item.total_value > 0 ? (
                              `${settings.currency} ${Number(item.total_value).toFixed(2)}`
                            ) : (
                              <span className="text-slate-400 font-normal">—</span>
                            )}
                          </td>

                          {/* Ref ID */}
                          <td className="py-2.5 px-3 font-mono text-[10px] text-slate-500 whitespace-nowrap">
                            <span className="bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                              {item.ref_id || 'N/A'}
                            </span>
                          </td>

                          {/* Performed By */}
                          <td className="py-2.5 px-3 text-slate-600 text-[11px] font-medium whitespace-nowrap">
                            {item.performed_by || 'Staff'}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

          </div>
        )}

        {/* TRANSFERS history log Tab layout */}
        {activeSubTab === 'transfers_ledger' && (
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-3xs animate-fadeIn">
            <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider mb-2.5 flex items-center gap-1.5 border-b border-slate-100 pb-2">
              <Activity size={14} className="text-indigo-600" />
              Inter-Branch Stock Transfer Ledger History
            </h3>

            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-55 text-slate-400 font-extrabold uppercase text-[9px] select-none">
                    <th className="py-2 px-3">Transfer ID</th>
                    <th className="py-2 px-3 justify-left">Product</th>
                    <th className="py-2 px-3 text-center">From Store</th>
                    <th className="py-2 px-3 text-center">To Store</th>
                    <th className="py-2 px-3 text-center">Quantity</th>
                    <th className="py-2 px-3 text-center">Status</th>
                    <th className="py-2 px-3 text-center">Date Executed</th>
                    <th className="py-2 px-3 text-right">Verification Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-150 font-semibold text-slate-700">
                  {transfers.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-5 text-center text-slate-400 font-medium italic">
                        No stock transfer reports registered in double-entry history databases yet.
                      </td>
                    </tr>
                  ) : (
                    transfers.map(tr => (
                      <tr key={tr.id} className="hover:bg-slate-50/50">
                        <td className="py-2 px-3 font-mono text-[10px] text-slate-500">{tr.id}</td>
                        <td className="py-2 px-3 font-bold text-slate-805">{tr.product_name || 'Legacy Stock Item'}</td>
                        <td className="py-2 px-3 text-center font-mono opacity-80 uppercase text-[10px]">{tr.from_store}</td>
                        <td className="py-2 px-3 text-center font-mono opacity-80 uppercase text-[10px]">{tr.to_store}</td>
                        <td className="py-2 px-3 text-center text-indigo-700 font-extrabold">{tr.quantity} items</td>
                        <td className="py-2 px-3 text-center">
                          {tr.status === 'PENDING' ? (
                            <span className="text-[8px] font-extrabold text-amber-800 bg-amber-100 border border-amber-300 py-0.5 px-2 rounded-full uppercase tracking-wider animate-pulse">
                              {tr.status}
                            </span>
                          ) : tr.status === 'APPROVED' ? (
                            <span className="text-[8px] font-extrabold text-emerald-800 bg-emerald-100 border border-emerald-300 py-0.5 px-2 rounded-full uppercase tracking-wider">
                              Approved
                            </span>
                          ) : (
                            <div className="flex flex-col items-center">
                              <span className="text-[8px] font-extrabold text-rose-800 bg-rose-100 border border-rose-300 py-0.5 px-2 rounded-full uppercase tracking-wider">
                                Rejected
                              </span>
                              {tr.rejection_reason && (
                                <span className="text-[9px] text-rose-650 max-w-[120px] font-bold line-clamp-1 block mt-0.5 italic" title={tr.rejection_reason}>
                                  {tr.rejection_reason}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center font-mono text-slate-400 text-[10px]">
                          {new Date(tr.created_at).toLocaleString()}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {tr.status === 'PENDING' ? (
                            tr.to_store === activeStore ? (
                              <div className="flex justify-end gap-1.5">
                                <button
                                  onClick={() => handleApproveTransfer(tr)}
                                  className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded text-[9px] font-extrabold flex items-center gap-1 cursor-pointer shadow-3xs hover:scale-[1.03] transition-transform"
                                  title="Approve inventory arrival and print double-sign receipt PDF"
                                >
                                  <Check size={10} />
                                  <span>APPROVE & PRINT</span>
                                </button>
                                <button
                                  onClick={() => handleRejectTransfer(tr)}
                                  className="px-2 py-1 bg-rose-605 hover:bg-rose-700 active:bg-rose-800 text-white rounded text-[9px] font-extrabold flex items-center gap-1 cursor-pointer shadow-3xs hover:scale-[1.03] transition-transform"
                                  title="Reject transfer and restore stock back to origin store with written mismatch reasons"
                                >
                                  <X size={10} />
                                  <span>REJECT</span>
                                </button>
                              </div>
                            ) : (
                              <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider block text-center" title="Awaiting destination branch officer's approval signatures and physical count confirmation before completing ledger changes">
                                🚚 IN TRANSIT TO {tr.to_store.toUpperCase()}
                              </span>
                            )
                          ) : tr.status === 'APPROVED' ? (
                            <button
                              onClick={() => {
                                try {
                                  const doc = new jsPDF({ format: 'a5', orientation: 'landscape' });
                                  doc.setFont('helvetica', 'bold');
                                  doc.setFontSize(14);
                                  doc.text(settings.storeName.toUpperCase(), 10, 15);
                                  doc.setFontSize(9);
                                  doc.text('INTER-STORE INVENTORY TRANSFER NOTE (APPROVED & COMPLETED)', 10, 20);
                                  
                                  doc.setLineWidth(0.2);
                                  doc.line(10, 23, 195, 23);
                                  
                                  doc.setFont('helvetica', 'normal');
                                  doc.setFontSize(8.5);
                                  doc.text(`TRANSFER REFERENCE: ${tr.id}`, 10, 30);
                                  doc.text(`CREATED AT: ${new Date(tr.created_at).toLocaleString()}`, 10, 35);
                                  doc.text(`REPRINTED AT: ${new Date().toLocaleString()}`, 10, 40);
                                  doc.text(`SOURCE BRANCH: ${tr.from_store.toUpperCase()}`, 10, 45);
                                  doc.text(`DESTINATION BRANCH: ${tr.to_store.toUpperCase()}`, 10, 50);
                                  
                                  doc.setFont('helvetica', 'bold');
                                  doc.text('TRANSFER STATUS: APPROVED & CO-SIGNED (REPRINT)', 10, 58);
                                  doc.line(10, 60, 195, 60);
                                  
                                  doc.text('PRODUCT IDENTIFICATION / DETAILS', 10, 66);
                                  doc.text('QTY CODE', 150, 66, { align: 'right' });
                                  doc.text('AUDIT STATE', 195, 66, { align: 'right' });
                                  
                                  doc.setFont('helvetica', 'normal');
                                  doc.text(`${tr.product_name || 'Generic Product Item'} (Catalog ID: ${tr.product_id})`, 10, 72);
                                  doc.text(`${tr.quantity} UNITS`, 150, 72, { align: 'right' });
                                  doc.text('[VERIFIED & RECEIVED]', 195, 72, { align: 'right' });
                                  
                                  doc.line(10, 76, 195, 76);
                                  
                                  doc.setFontSize(8);
                                  doc.text('____________________________', 10, 95);
                                  doc.text('Dispatch Officer Signature', 10, 99);
                                  
                                  doc.text('____________________________', 120, 95);
                                  doc.text('Receiving Store Approver Signature', 120, 99);
                                  
                                  doc.setFontSize(7);
                                  doc.text('Double-entry ledger status has changed to APPROVED in the SQL database. Retain this co-signed slip for multi-branch audits.', 10, 115);
                                  
                                  doc.save(`APPROVED_STOCK_TRANSFER_${tr.id}.pdf`);
                                } catch(err) {
                                  console.error(err);
                                }
                              }}
                              className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-[9px] font-extrabold inline-flex items-center gap-1 cursor-pointer hover:scale-[1.03] transition-transform shadow-3xs"
                              title="Reprint the co-signed Inter-Store Transfer Note PDF"
                            >
                              <Printer size={10} />
                              <span>REPRINT PDF</span>
                            </button>
                          ) : (
                            <div className="text-right">
                              <span className="text-[9px] text-rose-600 font-extrabold uppercase bg-rose-50 border border-rose-200 py-0.5 px-2 rounded-lg">RESTORED / DEFECT REJECT</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>

      {/* WIDGET: INTER-STORE STOCK TRANSFER DIALOG MODAL */}
      <AnimatePresence>
        {showTransferModal && (
          <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <motion.div
              initial={{ scale: 0.96, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.96, opacity: 0, y: 10 }}
              className="bg-white rounded-2xl border border-slate-300 shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col cursor-default"
            >
              <div 
                className="p-4 bg-slate-900 text-white font-bold text-xs tracking-wider flex justify-between items-center shrink-0 uppercase text-left select-none border-b border-slate-800"
              >
                <span className="flex items-center gap-1.5 font-black">
                  🔄 INTER-BRANCH TRANSFER
                </span>
                <button onClick={() => setShowTransferModal(false)} className="hover:text-amber-400 font-extrabold cursor-pointer">✕</button>
              </div>

              <div className="p-5 flex flex-col md:flex-row gap-5 text-left overflow-y-auto max-h-[80vh] overflow-x-auto">
                
                {/* LEFT PANEL: CONFIGURATION & ADD ITEM */}
                <div className="flex-1 flex flex-col gap-4">
                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 flex flex-col gap-3">
                    <h4 className="text-[10px] text-slate-500 font-extrabold uppercase tracking-wider">Branch Routing Config</h4>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-[9px] text-slate-400 font-bold uppercase">From Store (Source)</label>
                        <select
                          disabled={transferCart.length > 0}
                          value={transferFromStore}
                          onChange={(e) => setTransferFromStore(e.target.value)}
                          className="px-2.5 py-1.5 text-xs bg-white border border-slate-250 rounded-lg text-slate-700 focus:outline-hidden cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed font-bold"
                        >
                          {getStoresList().map(st => (
                            <option key={st.id} value={st.id}>{st.name}</option>
                          ))}
                        </select>
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-[9px] text-slate-400 font-bold uppercase">To Store (Dest)</label>
                        <select
                          disabled={transferCart.length > 0}
                          value={transferToStore}
                          onChange={(e) => setTransferToStore(e.target.value)}
                          className="px-2.5 py-1.5 text-xs bg-white border border-slate-250 rounded-lg text-slate-700 focus:outline-hidden cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed font-bold"
                        >
                          {getStoresList().map(st => (
                            <option key={st.id} value={st.id}>{st.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {transferCart.length > 0 && (
                      <span className="text-[9px] text-indigo-650 font-extrabold">
                        🔒 Store selections locked. Clear cart to change branches.
                      </span>
                    )}
                  </div>

                  <div className="border border-slate-200 p-3.5 rounded-xl flex flex-col gap-3 bg-white">
                    <h4 className="text-[10px] text-slate-500 font-extrabold uppercase tracking-wider">Select Item to Add</h4>
                    
                    {/* Item Search Input */}
                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] text-slate-400 font-bold uppercase">Search / Filter Products</label>
                      <div className="relative">
                        <input
                          type="text"
                          placeholder="Search product name or SKU..."
                          value={transferSearchQuery}
                          onChange={(e) => setTransferSearchQuery(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs bg-slate-100 border border-slate-250 rounded-lg text-slate-800 placeholder-slate-400 focus:bg-white focus:outline-hidden font-bold"
                        />
                        {transferSearchQuery && (
                          <button
                            type="button"
                            onClick={() => setTransferSearchQuery('')}
                            className="absolute right-2 top-2 text-slate-400 hover:text-slate-600 text-xs font-black cursor-pointer"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] text-slate-400 font-bold uppercase">Product Catalog ({filteredTransferProducts.length} items)</label>
                      <select
                        value={transferProductId}
                        onChange={(e) => setTransferProductId(e.target.value)}
                        className="w-full px-2.5 py-2 text-xs bg-slate-100 rounded-lg text-slate-800 font-bold focus:outline-hidden cursor-pointer border border-slate-250"
                      >
                        {filteredTransferProducts.length === 0 ? (
                          <option value="">No items match search filter</option>
                        ) : (
                          filteredTransferProducts.map(p => {
                            const stockVal = transferStoreStocks[p.id] !== undefined ? transferStoreStocks[p.id] : (p.stock || 0);
                            return (
                              <option key={p.id} value={p.id}>
                                {p.name} ({p.sku || 'No SKU'}) — [Stock: {stockVal}]
                              </option>
                            );
                          })
                        )}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] text-slate-400 font-bold uppercase">Quantity to transfer</label>
                      <input
                        type="number"
                        min="1"
                        value={transferQty}
                        onChange={(e) => setTransferQty(e.target.value)}
                        className="px-2.5 py-2 text-xs font-bold bg-slate-100 border border-transparent rounded-lg text-slate-850 focus:border-slate-300"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={handleAddToTransferCart}
                      className="mt-1 w-full py-2 bg-slate-800 hover:bg-slate-900 active:scale-98 text-white rounded-lg text-[10.5px] font-extrabold tracking-wider transition-all uppercase flex items-center justify-center gap-1 cursor-pointer"
                    >
                      <Plus size={12} />
                      <span>Add to Transfer Note</span>
                    </button>
                  </div>
                </div>

                {/* RIGHT PANEL: ITEMS CART / SUMMARY */}
                <div className="flex-1 flex flex-col border border-slate-200/80 rounded-xl p-4 bg-slate-50/40 min-h-[280px]">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-2 mb-2.5">
                    <h4 className="text-[10px] text-slate-500 font-extrabold uppercase tracking-wider">Shipment Cart ({transferCart.length} items)</h4>
                    {transferCart.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setTransferCart([])}
                        className="text-[9px] text-rose-605 hover:underline font-extrabold"
                      >
                        Clear All
                      </button>
                    )}
                  </div>

                  <div className="flex-1 overflow-y-auto max-h-[220px] flex flex-col gap-2">
                    {transferCart.length === 0 ? (
                      <div className="flex-1 flex flex-col items-center justify-center text-center p-6 border-2 border-dashed border-slate-200 rounded-lg bg-white/50">
                        <span className="text-xl">📦</span>
                        <p className="text-[10px] text-slate-400 font-medium mt-1">No items added to shipment yet.</p>
                        <p className="text-[9px] text-slate-350 mt-0.5">Select a product on the left to start building your transfer note.</p>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {transferCart.map((item) => (
                          <div
                            key={item.productId}
                            className="bg-white border border-slate-200 rounded-lg p-2 flex items-center justify-between text-xs"
                          >
                            <div className="flex flex-col text-left gap-0.5">
                              <span className="font-bold text-slate-800 max-w-[180px] truncate">{item.productName}</span>
                              <span className="text-[9px] text-slate-400 font-mono">SKU: {item.sku} | Bal: {item.availableStock}</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="font-extrabold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded text-[11px]">
                                {item.quantity} Qty
                              </span>
                              <button
                                type="button"
                                onClick={() => handleRemoveFromTransferCart(item.productId)}
                                className="text-slate-400 hover:text-rose-600 font-bold p-1 hover:bg-slate-50 rounded"
                                title="Remove item"
                              >
                                <X size={13} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-200 flex justify-end gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setShowTransferModal(false)}
                      className="px-4 py-2 bg-slate-105 rounded-lg text-xs font-bold text-slate-650 hover:bg-slate-200 cursor-pointer"
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      onClick={handleTransferStock}
                      disabled={transferCart.length === 0}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:hover:bg-indigo-600 text-white rounded-lg text-xs font-bold shadow-xs cursor-pointer tracking-wider"
                    >
                      APPLY SHIPMENT (SQL UPDATE)
                    </button>
                  </div>
                </div>

              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* NEW ITEM CREATION DIALOG MODAL */}
      <AnimatePresence>
        {showAddModal && (
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto select-none">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden flex flex-col"
            >
              <div className="p-4 bg-slate-905 text-white font-bold text-xs tracking-wider flex justify-between items-center shrink-0 uppercase text-left">
                <span>ADD NEW WAREHOUSE RETAIL ITEM</span>
                <button onClick={() => setShowAddModal(false)} className="hover:text-amber-400 font-extrabold cursor-pointer">✕</button>
              </div>

              <form onSubmit={handleAddProduct} className="p-5 overflow-y-auto flex flex-col gap-4 text-left">
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-slate-50 p-3 rounded-lg border border-slate-100">
                  <div className="flex flex-col gap-1 col-span-2">
                    <label className="text-[10px] text-slate-400 font-bold uppercase">Product Display Name</label>
                    <input
                      type="text"
                      required
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="Artisan Dark Roast Espresso"
                      className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md text-slate-800"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-400 font-bold uppercase">SKU Barcode</label>
                    <input
                      type="text"
                      required
                      value={newSku}
                      onChange={(e) => setNewSku(e.target.value)}
                      placeholder="BARCODE-99412"
                      className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md text-slate-800 font-mono"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <div className="flex justify-between items-center">
                      <label className="text-[10px] text-slate-400 font-bold uppercase">Item Category</label>
                      <button
                        type="button"
                        onClick={() => {
                          const catName = window.prompt("Enter and register custom category name:");
                          if (catName && catName.trim()) {
                            setNewCat(catName.trim());
                            alert(`Category "${catName.trim()}" successfully registered active!`);
                          }
                        }}
                        className="text-[10px] text-indigo-650 hover:text-indigo-800 font-extrabold flex items-center gap-1 cursor-pointer bg-indigo-50 px-2 py-0.5 rounded-md"
                        title="Add Custom Category Type"
                      >
                        <Plus size={10} className="stroke-indigo-600" />
                        + Custom Cat
                      </button>
                    </div>
                    <div className="flex gap-1.5 mt-0.5">
                      <select
                        value={newCat}
                        onChange={(e) => setNewCat(e.target.value)}
                        className="flex-1 px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-md text-slate-850 focus:outline-hidden"
                      >
                        <option value="">-- Select/Existing --</option>
                        {Array.from(new Set(products.map(p => p.category).filter(Boolean))).map(cat => (
                          <option key={cat} value={cat}>{cat}</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        required
                        value={newCat}
                        onChange={(e) => setNewCat(e.target.value)}
                        placeholder="Or customize"
                        className="w-1/3 px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-md text-slate-800 font-mono font-bold"
                        title="Assigned Category Name"
                      />
                    </div>
                  </div>
                </div>

                <div className="bg-slate-50 p-3 rounded-lg border border-slate-100 flex flex-col gap-2">
                  <label className="text-[10px] text-slate-400 font-bold uppercase">Item Log Type</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setNewIsService(false);
                        setNewStock('10');
                      }}
                      className={`py-1.5 px-3 rounded-lg text-xs font-bold border flex flex-col items-center justify-center cursor-pointer transition-all ${
                        !newIsService
                          ? 'bg-white border-indigo-600 text-indigo-700 shadow-xs'
                          : 'bg-slate-50 border-slate-200 text-slate-400 hover:bg-slate-100 hover:text-slate-600'
                      }`}
                    >
                      <span className="text-[10px] uppercase font-mono font-black">📦 Standard Good</span>
                      <span className="text-[8px] font-medium leading-tight text-slate-400 mt-0.5">Tracks stock &amp; quantity</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNewIsService(true);
                        setNewStock('0');
                      }}
                      className={`py-1.5 px-3 rounded-lg text-xs font-bold border flex flex-col items-center justify-center cursor-pointer transition-all ${
                        newIsService
                          ? 'bg-white border-indigo-600 text-indigo-700 shadow-xs'
                          : 'bg-slate-50 border-slate-200 text-slate-400 hover:bg-slate-100 hover:text-slate-600'
                      }`}
                    >
                      <span className="text-[10px] uppercase font-mono font-black">💼 Company Service</span>
                      <span className="text-[8px] font-medium leading-tight text-slate-400 mt-0.5">No quantity limits</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 bg-slate-50 p-3 rounded-lg border border-slate-100">
                  <div className="flex flex-col gap-1">
                    <label className="text-[9px] text-slate-400 font-bold uppercase">Price ({settings.currency})</label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={newPrice}
                      onChange={(e) => setNewPrice(e.target.value)}
                      className="px-2 py-1 bg-white border border-slate-200 rounded-md font-bold text-indigo-700 font-mono text-center text-xs"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[9px] text-slate-400 font-bold uppercase">Cost ({settings.currency})</label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={newCost}
                      onChange={(e) => setNewCost(e.target.value)}
                      className="px-2 py-1 bg-white border border-slate-200 rounded-md font-mono text-center text-xs text-slate-800"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[9px] text-slate-400 font-bold uppercase">{newIsService ? 'Service Stock' : 'Initial Stock'}</label>
                    <input
                      type="text"
                      disabled={newIsService}
                      required
                      value={newIsService ? 'N/A' : newStock}
                      onChange={(e) => !newIsService && setNewStock(e.target.value)}
                      className="px-2 py-1 bg-white border border-slate-200 rounded-md font-bold font-mono text-center text-xs text-slate-850 disabled:bg-slate-100/70 disabled:text-slate-400"
                    />
                  </div>
                </div>

                {!newIsService && (
                  <div className="grid grid-cols-2 gap-2 bg-indigo-50/40 p-3 rounded-lg border border-indigo-100/50">
                    <div className="col-span-2">
                      <h4 className="text-[10px] text-indigo-850 font-black uppercase tracking-wider mb-1 flex items-center gap-1.5">
                        <span>🏷️ BATCH &amp; EXPIRATION TRACKING</span>
                      </h4>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] text-slate-400 font-bold uppercase">Batch / Lot Number</label>
                      <input
                        type="text"
                        value={newBatchNumber}
                        onChange={(e) => setNewBatchNumber(e.target.value)}
                        placeholder="e.g. BATCH-2026A"
                        className="px-2.5 py-1 text-xs bg-white border border-slate-200 rounded-md text-slate-850 font-mono font-bold"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] text-slate-400 font-bold uppercase">Expiration Date</label>
                      <input
                        type="date"
                        value={newExpiryDate}
                        onChange={(e) => setNewExpiryDate(e.target.value)}
                        className="px-2.5 py-1 text-xs bg-white border border-slate-200 rounded-md text-slate-850 font-bold"
                      />
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-1.5 border border-slate-150 rounded-xl p-3 bg-slate-50">
                  <label className="text-[10px] text-indigo-805 font-extrabold uppercase tracking-wide flex items-center gap-1.5">
                    Product Picture (Upload Image or Paste URL)
                  </label>
                  
                  <div className="flex items-center gap-3">
                    {newImg ? (
                      <div className="relative w-14 h-14 bg-white border border-slate-250 rounded-lg overflow-hidden flex items-center justify-center group shrink-0 shadow-sm">
                        <img src={newImg} alt="Thumbnail preview" className="max-w-full max-h-full object-cover" referrerPolicy="no-referrer" />
                        <button
                          type="button"
                          onClick={() => setNewImg('')}
                          className="absolute inset-x-0 bottom-0 bg-red-600/90 text-white py-0.5 text-center cursor-pointer text-[8px] font-black uppercase border-0"
                          title="Clear Image"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <div className="w-14 h-14 bg-slate-200/80 border border-dashed border-slate-300 rounded-lg flex flex-col items-center justify-center text-slate-400 text-[8px] font-bold shrink-0">
                        <span>No Photo</span>
                      </div>
                    )}
                    
                    <div className="flex-1 flex flex-col gap-1">
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          
                          if (file.size > 500 * 1024) {
                            alert("Please upload a picture smaller than 500KB to ensure quick processing.");
                            return;
                          }

                          const reader = new FileReader();
                          reader.onload = () => {
                            if (typeof reader.result === 'string') {
                              setNewImg(reader.result);
                            }
                          };
                          reader.onerror = () => {
                             alert("Failed to read image file.");
                          };
                          reader.readAsDataURL(file);
                        }}
                        className="text-[10px] text-slate-500 file:mr-2 file:py-1 file:px-2.5 file:rounded-lg file:border-0 file:text-[10px] file:font-black file:bg-indigo-50 file:text-indigo-750 hover:file:bg-indigo-100 cursor-pointer"
                      />
                      <span className="text-[8px] text-slate-400 font-medium">Accepts custom photos, PNG, JPEG, WebP.</span>
                    </div>
                  </div>

                  <div className="mt-1">
                    <span className="text-[8px] text-slate-400 block font-bold uppercase tracking-wider mb-0.5">Or paste standard web image URL :</span>
                    <input
                      type="url"
                      value={newImg.startsWith('data:') ? '' : newImg}
                      onChange={(e) => setNewImg(e.target.value)}
                      placeholder="https://images.unsplash.com/photo-..."
                      className="w-full px-2.5 py-1 text-[10px] bg-white border border-slate-200 focus:outline/none text-slate-800 rounded font-mono"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 shrink-0">
                  <button
                    type="button"
                    onClick={() => setShowAddModal(false)}
                    className="px-4 py-2 bg-slate-100 rounded-lg text-xs font-bold text-slate-600 hover:bg-slate-200 cursor-pointer"
                  >
                    CANCEL
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold shadow-xs cursor-pointer tracking-wider"
                  >
                     SAVE ITEM IN DATABASES
                  </button>
                </div>

              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* QUICK RECEIVE / ADD STOCK BATCH MODAL */}
      <AnimatePresence>
        {showReceiveModal && receiveProduct && (
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto select-none">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden flex flex-col"
            >
              <div className="p-4 bg-indigo-900 text-white font-bold text-xs tracking-wider flex justify-between items-center shrink-0 uppercase text-left">
                <span>RECEIVE PHYSICAL STOCK: {receiveProduct.name}</span>
                <button 
                  type="button"
                  onClick={() => {
                    setShowReceiveModal(false);
                    setReceiveProduct(null);
                  }} 
                  className="hover:text-amber-400 font-extrabold cursor-pointer"
                >
                  ✕
                </button>
              </div>

              <form onSubmit={handleReceiveStockSubmit} className="p-5 overflow-y-auto flex flex-col gap-4 text-left">
                
                <div className="flex items-center gap-3 bg-slate-50 p-3 rounded-lg border border-slate-100">
                  <img src={receiveProduct.imageUrl} alt={receiveProduct.name} className="w-12 h-12 rounded-lg object-cover border" referrerPolicy="no-referrer" />
                  <div>
                    <h3 className="font-extrabold text-slate-800 text-xs">{receiveProduct.name}</h3>
                    <p className="text-[10px] font-mono font-bold text-slate-400">SKU: {receiveProduct.sku}</p>
                    <p className="text-[10px] text-indigo-700 font-bold mt-0.5">
                      Current Stock: <span className="font-extrabold font-mono">{receiveProduct.stock} units</span>
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-1 bg-slate-50 p-3 rounded-lg border border-slate-100">
                  <label className="text-[10px] text-slate-400 font-bold uppercase">Quantity to Receive / Add</label>
                  <input
                    type="number"
                    required
                    min="1"
                    value={receiveQty}
                    onChange={(e) => setReceiveQty(e.target.value)}
                    placeholder="10"
                    className="px-3 py-2 text-xs font-extrabold bg-white border border-slate-200 rounded-md text-slate-800 font-mono"
                  />
                  <p className="text-[9px] text-slate-400 font-medium">This will increase the stock count by the entered quantity.</p>
                </div>

                <div className="grid grid-cols-2 gap-2 bg-indigo-50/40 p-3 rounded-lg border border-indigo-100/50">
                  <div className="col-span-2">
                    <h4 className="text-[10px] text-indigo-850 font-black uppercase tracking-wider mb-1">
                      🏷️ Batch &amp; Expiration Tracking
                    </h4>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[9px] text-slate-400 font-bold uppercase">Batch / Lot Number</label>
                    <input
                      type="text"
                      value={receiveBatch}
                      onChange={(e) => setReceiveBatch(e.target.value)}
                      placeholder="e.g. BATCH-2026A"
                      className="px-2.5 py-1 text-xs bg-white border border-slate-200 rounded-md text-slate-800 font-mono font-semibold"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[9px] text-slate-400 font-bold uppercase">Expiration Date</label>
                    <input
                      type="date"
                      value={receiveExpiry}
                      onChange={(e) => setReceiveExpiry(e.target.value)}
                      className="px-2.5 py-1 text-xs bg-white border border-slate-200 rounded-md text-slate-800 font-semibold"
                    />
                  </div>

                  {receiveExpiry && (
                    <div className="col-span-2 mt-1">
                      {(() => {
                        const status = getExpirationStatus(receiveExpiry);
                        return (
                          <div className={`p-2 rounded text-[10px] font-bold border flex items-center gap-1.5 ${
                            status.status === 'expired'
                              ? 'bg-red-50 text-red-750 border-red-200'
                              : status.status === 'today' || status.status === 'nearing'
                                ? 'bg-amber-50 text-amber-855 border-amber-200'
                                : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                          }`}>
                            <span>⚠️ Expiration status:</span>
                            <span className="font-extrabold">{status.label}</span>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setShowReceiveModal(false);
                      setReceiveProduct(null);
                    }}
                    className="px-4 py-2 bg-slate-100 rounded-lg text-xs font-bold text-slate-600 hover:bg-slate-200 cursor-pointer"
                  >
                    CANCEL
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold shadow-xs cursor-pointer tracking-wider"
                  >
                    RECEIVE STOCK UNITS
                  </button>
                </div>

              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MANAGE / EDIT CATEGORIES MODAL */}
      <AnimatePresence>
        {showCategoryModal && (
          <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4 z-50 select-none">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-md bg-white border border-slate-200 text-slate-900 rounded-2xl p-5 flex flex-col gap-4 shadow-2xl max-h-[85vh] overflow-hidden"
            >
              <div className="flex justify-between items-center border-b border-slate-150 pb-3">
                <div className="flex items-center gap-2 text-indigo-600">
                  <Tag size={20} />
                  <div>
                    <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-900 font-sans">Category Manager</h3>
                    <p className="text-[10px] text-slate-500 font-mono">Create, rename, and manage inventory item categories</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowCategoryModal(false)}
                  className="text-slate-400 hover:text-slate-700 p-1 rounded-lg bg-slate-100 cursor-pointer"
                >
                  ✕
                </button>
              </div>

              {/* Form: Create New Category */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!modalNewCatName.trim()) return;
                  const newCat = modalNewCatName.trim();
                  if (!customCategories.includes(newCat)) {
                    saveCustomCategories([...customCategories, newCat]);
                  }
                  alert(`Category "${newCat}" created and registered! You can now assign items to it.`);
                  setModalNewCatName('');
                }}
                className="flex gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl"
              >
                <input
                  type="text"
                  value={modalNewCatName}
                  onChange={(e) => setModalNewCatName(e.target.value)}
                  placeholder="New Category Name (e.g. Electrical)"
                  className="flex-1 bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs text-slate-900 font-bold focus:outline-hidden"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold rounded-lg text-xs uppercase tracking-wider flex items-center gap-1 cursor-pointer shadow-xs"
                >
                  <Plus size={14} /> Add
                </button>
              </form>

              {/* List of Existing Categories */}
              <div className="flex-1 overflow-y-auto flex flex-col gap-2 p-2 bg-slate-50 rounded-xl border border-slate-200 max-h-[320px]">
                <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider px-1 font-mono">
                  Active Categories ({allCategoriesList.length})
                </span>

                {allCategoriesList.map((catName) => {
                  const count = products.filter(p => p.category === catName).length;
                  const isEditingThisCat = editingCatOldName === catName;

                  return (
                    <div
                      key={catName}
                      className="p-2.5 bg-white border border-slate-200 rounded-xl flex items-center justify-between gap-2 shadow-2xs"
                    >
                      {isEditingThisCat ? (
                        <div className="flex items-center gap-2 flex-1">
                          <input
                            type="text"
                            value={editingCatNewName}
                            onChange={(e) => setEditingCatNewName(e.target.value)}
                            className="flex-1 bg-slate-50 border border-indigo-400 rounded-lg px-2 py-1 text-xs font-bold text-slate-900 focus:outline-hidden"
                            autoFocus
                          />
                          <button
                            onClick={() => {
                              const newCat = editingCatNewName.trim();
                              if (newCat && newCat !== catName) {
                                runSql(
                                  `UPDATE products SET category = '${newCat.replace(/'/g, "''")}' WHERE category = '${catName.replace(/'/g, "''")}'`,
                                  'Rename Category'
                                );
                                const updated = customCategories.map(c => c === catName ? newCat : c);
                                saveCustomCategories(updated);
                                loadRawData();
                                persistTablesToStorage();
                                if (selectedCategory === catName) {
                                  setSelectedCategory(newCat);
                                }
                                alert(`Category renamed from "${catName}" to "${newCat}" across ${count} items!`);
                              }
                              setEditingCatOldName(null);
                            }}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-extrabold cursor-pointer"
                          >
                            ✓ Save
                          </button>
                          <button
                            onClick={() => setEditingCatOldName(null)}
                            className="px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-xs font-bold cursor-pointer"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-slate-800">{catName}</span>
                            <span className="px-2 py-0.5 bg-slate-100 border border-slate-200 text-slate-500 text-[10px] font-mono font-bold rounded-full">
                              {count} {count === 1 ? 'item' : 'items'}
                            </span>
                          </div>

                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => {
                                setEditingCatOldName(catName);
                                setEditingCatNewName(catName);
                              }}
                              className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg cursor-pointer transition-colors"
                              title="Rename Category"
                            >
                              <Edit2 size={14} />
                            </button>

                            {catName !== 'General' && (
                              <button
                                onClick={() => {
                                  if (window.confirm(`Reassign all ${count} items in "${catName}" to "General"?`)) {
                                    runSql(
                                      `UPDATE products SET category = 'General' WHERE category = '${catName.replace(/'/g, "''")}'`,
                                      'Reassign deleted category'
                                    );
                                    saveCustomCategories(customCategories.filter(c => c !== catName));
                                    loadRawData();
                                    persistTablesToStorage();
                                    if (selectedCategory === catName) {
                                      setSelectedCategory('All');
                                    }
                                  }
                                }}
                                className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg cursor-pointer transition-colors"
                                title="Delete Category & Reassign Items"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
