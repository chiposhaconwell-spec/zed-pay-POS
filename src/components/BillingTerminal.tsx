import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { 
  Search, 
  ShoppingCart, 
  User, 
  Tag, 
  Trash2, 
  Printer, 
  CheckCircle, 
  RefreshCcw, 
  Coffee, 
  Shield, 
  Coins, 
  CreditCard, 
  DollarSign, 
  Camera, 
  Send, 
  Share2, 
  Smartphone, 
  Activity,
  Layers,
  Lock,
  Unlock,
  Building2,
  Key,
  X,
  Copy,
  Download,
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
  History,
  Move,
  GripHorizontal,
  Receipt,
  Clock,
  UserCheck,
  UserX,
  AlertTriangle,
  Zap
} from 'lucide-react';
import { runSql, persistTablesToStorage, triggerLoanSweep, upsertCustomerSync, logEmployeeAudit } from '../db';
import { Product, Customer, StoreSettings } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { Html5Qrcode } from 'html5-qrcode';
import { jsPDF } from 'jspdf';
import { exportAndSharePdf, safeSystemPrint } from '../androidUtils';
import { getTransportSecurityStatus } from '../firebase';

const DEFAULT_COMPANY_LOGO = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'><rect width='120' height='120' rx='28' fill='%233730A3'/><path d='M60 22 L92 38 L92 70 C92 86 60 96 60 96 C60 96 28 88 28 72 L28 38 Z' fill='none' stroke='white' stroke-width='6' stroke-linejoin='round'/><path d='M44 58 L56 70 L78 48' fill='none' stroke='white' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/></svg>";

interface BillingTerminalProps {
  settings: StoreSettings;
  activeStore: string; // 'lusaka' | 'kitwe' | 'ndola'
  userRole: string; // 'owner' | 'manager' | 'sales'
  onCartCheckedOut: () => void;
  initialAction?: 'camera' | 'cashup' | 'refunds' | 'history' | null;
  onClearInitialAction?: () => void;
  onStoreChange?: (storeId: string) => void;
  onUserRoleChange?: (role: string) => void;
}

interface CartItem {
  product: Product;
  quantity: number;
}

interface OfflineOrder {
  orderId: string;
  customerId: string | null;
  items: CartItem[];
  dateStr: string;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  paymentMethod: string;
  activeStore: string;
  salesperson?: string;
  type: 'standard' | 'quicksale';
}

export default function BillingTerminal({ 
  settings, 
  activeStore, 
  userRole, 
  onCartCheckedOut,
  initialAction,
  onClearInitialAction,
  onStoreChange,
  onUserRoleChange
}: BillingTerminalProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [searchText, setSearchText] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);

  // Customer Management states
  const [autoSaveCustomer, setAutoSaveCustomer] = useState(true);
  const [customerRegistrySearchText, setCustomerRegistrySearchText] = useState('');

  // Manual Customer Collection States (when items are added)
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerTpin, setCustomerTpin] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');

  const [discountType, setDiscountType] = useState<'percent' | 'fixed'>('percent');
  const [discountValue, setDiscountValue] = useState<number>(0);
  
  // Checkout & Payment Modals
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [checkoutStep, setCheckoutStep] = useState<'customer' | 'payment' | 'success'>('customer');
  const [paymentMethod, setPaymentMethod] = useState<'Cash' | 'Credit Card' | 'Mobile Wallet' | 'Split'>('Cash');
  const [receivedCash, setReceivedCash] = useState<string>('');
  const [splitCashAmount, setSplitCashAmount] = useState<string>('');
  const [splitMobileAmount, setSplitMobileAmount] = useState<string>('');
  const [activeReceipt, setActiveReceipt] = useState<any>(null);
  const [showReceiptHtmlPreview, setShowReceiptHtmlPreview] = useState(false);
  const [pendingPrintMode, setPendingPrintMode] = useState<'bluetooth' | 'system' | null>(null);
  const [previewPaperSize, setPreviewPaperSize] = useState<'58mm' | '80mm' | 'A4'>('58mm');
  const [activeMobileTab, setActiveMobileTab] = useState<'catalog' | 'basket'>('catalog');

  // Salesperson Quick Sale states
  const [showQuickSaleModal, setShowQuickSaleModal] = useState(false);
  const [quickSalespersonName, setQuickSalespersonName] = useState(() => localStorage.getItem('quick_salesperson_name') || '');
  const [quickSearchQuery, setQuickSearchQuery] = useState('');
  const [quickSelectedProduct, setQuickSelectedProduct] = useState<Product | null>(null);
  const [quickSaleQty, setQuickSaleQty] = useState<string>('1');
  const [quickPaymentMethod, setQuickPaymentMethod] = useState<'Cash' | 'Credit Card' | 'Mobile Wallet'>('Cash');

  // Invoice History and Refund state management
  const [showInvoiceHistoryModal, setShowInvoiceHistoryModal] = useState(false);
  const [invoiceSearchQuery, setInvoiceSearchQuery] = useState('');
  const [historyStoreFilter, setHistoryStoreFilter] = useState<string>('all');
  const [selectedInvoice, setSelectedInvoice] = useState<any>(null);
  const [selectedInvoiceItems, setSelectedInvoiceItems] = useState<any[]>([]);
  const [invoiceList, setInvoiceList] = useState<any[]>([]);
  const [showRefundAuth, setShowRefundAuth] = useState(false);
  const [refundSupervisorName, setRefundSupervisorName] = useState('');
  const [refundSupervisorPassword, setRefundSupervisorPassword] = useState('');

  // QR Camera scanner state management
  const [isCamerActive, setIsCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [availableCameras, setAvailableCameras] = useState<any[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [lastScanCode, setLastScanCode] = useState('');
  const [lastScanTime, setLastScanTime] = useState(0);
  const [scanningMessage, setScanningMessage] = useState<string | null>(null);

  // Network simulation and local offline queue
  const [isDeviceOnline, setIsDeviceOnline] = useState<boolean>(() => {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  });
  const [offlineQueue, setOfflineQueue] = useState<OfflineOrder[]>(() => {
    try {
      const saved = localStorage.getItem('pos_offline_queue');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  // Synchronize queued transactions
  const syncOfflineQueue = async () => {
    let currentQueue: OfflineOrder[] = [];
    try {
      const saved = localStorage.getItem('pos_offline_queue');
      currentQueue = saved ? JSON.parse(saved) : [];
    } catch {
      currentQueue = [];
    }

    if (currentQueue.length === 0) return;
    setIsSyncing(true);

    let successCount = 0;
    const itemsToSync = [...currentQueue];

    for (const trx of itemsToSync) {
      try {
        if (trx.type === 'quicksale') {
          // Sync quicksale
          const qpName = trx.salesperson || 'Default Cashier';
          const orderInsertSql = `
            INSERT INTO orders (id, customerId, orderDate, subtotal, tax, discount, total, paymentMethod, status, store_id, performed_by) VALUES (
              '${trx.orderId}', 
              NULL, 
              '${trx.dateStr}', 
              ${trx.subtotal.toFixed(2)}, 
              ${trx.taxAmount.toFixed(2)}, 
              0.00, 
              ${trx.totalAmount.toFixed(2)}, 
              '${trx.paymentMethod}', 
              'Completed',
              '${trx.activeStore}',
              '${qpName.replace(/'/g, "''")}'
            )
          `;
          const resOrder = runSql(orderInsertSql, `Sync: Post quick order ${trx.orderId}`);
          
          if (resOrder.success) {
            // Post line items
            trx.items.forEach((item, index) => {
              const itemInsertSql = `
                INSERT INTO order_items VALUES (
                  '${trx.orderId}_item_${index + 1}', 
                  '${trx.orderId}', 
                  ${item.product.id}, 
                  ${item.quantity}, 
                  ${item.product.price}
                )
              `;
              runSql(itemInsertSql, `Sync: Post quick sales transaction lines`);

              // Decrement branch specific stock if not a service
              if (item.product.is_service !== 1) {
                runSql(`
                  UPDATE store_products 
                  SET stock = stock - ${item.quantity} 
                  WHERE product_id = ${item.product.id} AND store_id = '${trx.activeStore}'
                `, `Sync: Decrement quicksale stock unit from ${trx.activeStore.toUpperCase()}`);
              }
            });

            // Automated credit sweep
            try {
              triggerLoanSweep(trx.orderId, trx.totalAmount);
            } catch (err) {
              console.error('Offline sweep failed:', err);
            }

            successCount++;
          }
        } else {
          // Sync standard checkout
          const customerIdVal = trx.customerId ? trx.customerId : 'NULL';
          const orderInsertSql = `
            INSERT INTO orders (id, customerId, orderDate, subtotal, tax, discount, total, paymentMethod, status, store_id, performed_by) VALUES (
              '${trx.orderId}', 
              ${customerIdVal}, 
              '${trx.dateStr}', 
              ${trx.subtotal.toFixed(2)}, 
              ${trx.taxAmount.toFixed(2)}, 
              ${trx.discountAmount.toFixed(2)}, 
              ${trx.totalAmount.toFixed(2)}, 
              '${trx.paymentMethod}', 
              'Completed',
              '${trx.activeStore}',
              '${(trx.salesperson || 'Default Cashier').replace(/'/g, "''")}'
            )
          `;
          const resOrder = runSql(orderInsertSql, `Sync: Post standard order ${trx.orderId}`);

          if (resOrder.success) {
            // Insert items and decrement branch specific stock layers
            trx.items.forEach((item, index) => {
              const orderItemId = `${trx.orderId}_${index + 1}`;
              const itemInsertSql = `
                INSERT INTO order_items VALUES (
                  '${orderItemId}', 
                  '${trx.orderId}', 
                  ${item.product.id}, 
                  ${item.quantity}, 
                  ${item.product.price}
                )
              `;
              runSql(itemInsertSql, `Sync: Post sales transaction lines`);

              // Decrement store_products and baseline products if not a service
              if (item.product.is_service !== 1) {
                const checkOverride = runSql(`SELECT * FROM store_products WHERE product_id = ${item.product.id} AND store_id = '${trx.activeStore}'`, 'Verify location state');
                if (checkOverride.success && Array.isArray(checkOverride.data) && checkOverride.data.length > 0) {
                  runSql(`
                    UPDATE store_products 
                    SET stock = stock - ${item.quantity} 
                    WHERE product_id = ${item.product.id} AND store_id = '${trx.activeStore}'
                  `, `Sync: Demobilize -${item.quantity} units from branch ${trx.activeStore}`);
                } else {
                  const spId = `sp_${item.product.id}_${trx.activeStore}`;
                  runSql(`
                    INSERT INTO store_products VALUES (
                      '${spId}',
                      ${item.product.id},
                      '${trx.activeStore}',
                      ${item.product.stock - item.quantity},
                      ${item.product.price}
                    )
                  `, `Sync: Provision missing branch rows`);
                }

                // Decrement baseline stock
                runSql(`UPDATE products SET stock = stock - ${item.quantity} WHERE id = ${item.product.id}`, 'Sync: baseline totals');
              }
            });

            // Double entry clearing entry
            const txId = `tx_${trx.orderId.toLowerCase()}_${Math.floor(100 + Math.random() * 900)}`;
            const idempotencyKey = `idemp_${txId}`;
            const calculatedFeeRate = trx.paymentMethod === 'Cash' ? 0.0 : 0.015;
            const feeAmount = parseFloat((trx.totalAmount * calculatedFeeRate).toFixed(4));
            const netSettlement = trx.totalAmount - feeAmount;

            let clearingAccountId = 'cash-clearing-account-uuid';
            let channel = 'CASH';

            if (trx.paymentMethod === 'Mobile Wallet') {
              clearingAccountId = Math.random() > 0.5 ? 'mtn-clearing-account-uuid' : 'airtel-clearing-account-uuid';
              channel = clearingAccountId === 'mtn-clearing-account-uuid' ? 'MTN_MOMO' : 'AIRTEL_MONEY';
            } else if (trx.paymentMethod === 'Credit Card') {
              clearingAccountId = 'airtel-clearing-account-uuid';
              channel = 'CARD_VISA';
            }

            runSql(`
              INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at)
              VALUES ('${txId}', '${idempotencyKey}', 'POS-${trx.activeStore.toUpperCase()}-01', '${channel}', 'POS-REF-${trx.orderId}', ${trx.totalAmount.toFixed(4)}, ${feeAmount.toFixed(4)}, 'SUCCESS', 'POS Branch ${trx.activeStore.toUpperCase()} order Checkout #${trx.orderId}', '${trx.dateStr}', '${trx.dateStr}')
            `, 'Double Entry: Journal base transaction entry');

            runSql(`
              INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
              VALUES ('le_${txId}_deb', '${txId}', '${clearingAccountId}', 'DEBIT', ${trx.totalAmount.toFixed(4)}, '${trx.dateStr}')
            `, 'Double Entry: Debit Clearing Asset account');

            runSql(`
              INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
              VALUES ('le_${txId}_cre_merch', '${txId}', 'merchant-wallet-account-uuid', 'CREDIT', ${netSettlement.toFixed(4)}, '${trx.dateStr}')
            `, 'Double Entry: Credit Merchant Wallet');

            if (trx.customerId) {
              const awardPts = Math.floor(trx.totalAmount * settings.loyaltyRatio);
              if (awardPts > 0) {
                runSql(`UPDATE customers SET loyalPoints = loyalPoints + ${awardPts} WHERE id = ${trx.customerId}`, 'Loyalty: Accrue pts');
              }
            }

            // Automated credit sweep
            try {
              const sweepRes = triggerLoanSweep(trx.orderId, trx.totalAmount);
              if (sweepRes.status === 'SUCCESS' && sweepRes.deducted > 0) {
                const sweepTxId = `tx_sweep_${trx.orderId.toLowerCase()}_${Math.floor(100 + Math.random() * 900)}`;
                const sweepIdemp = `idemp_${sweepTxId}`;
                runSql(`
                  INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at)
                  VALUES ('${sweepTxId}', '${sweepIdemp}', 'POS-${trx.activeStore.toUpperCase()}-01', 'SWEEP_DEDUCTION', 'SWEEP-REF-${trx.orderId}', ${sweepRes.deducted.toFixed(4)}, 0.0000, 'SUCCESS', 'Automated revenue deduction for active capital advance repayment #${trx.orderId}', '${trx.dateStr}', '${trx.dateStr}')
                `, 'Double Entry: Sweep deduction capital advance ticket log');
                
                runSql(`
                  INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
                  VALUES ('le_${sweepTxId}_deb', '${sweepTxId}', 'merchant-wallet-account-uuid', 'DEBIT', ${sweepRes.deducted.toFixed(4)}, '${trx.dateStr}')
                `, 'Double Entry: Debit Merchant Wallet (Outward Sweep)');
                
                runSql(`
                  INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
                  VALUES ('le_${sweepTxId}_cre', '${sweepTxId}', 'loan-clearing-account-uuid', 'CREDIT', ${sweepRes.deducted.toFixed(4)}, '${trx.dateStr}')
                `, 'Double Entry: Credit Loan Asset Account (Repayment settled)');
              }
            } catch (sweepErr) {
              console.error('Offline credit sweep failed:', sweepErr);
            }

            successCount++;
          }
        }
      } catch (err) {
        console.error('Error syncing transaction:', trx.orderId, err);
      }
    }

    const remainingQueue = currentQueue.slice(successCount);
    setOfflineQueue(remainingQueue);
    localStorage.setItem('pos_offline_queue', JSON.stringify(remainingQueue));
    setIsSyncing(false);

    alert(`⚡ Reconnect Synchronization Success!\n\nSuccessfully uploaded ${successCount} queued offline POS checkout invoices. Main ledger journals, stock valuations, and co-signed credit sweeps are now fully updated!`);
    
    onCartCheckedOut();
    refreshDbData();
    try {
      window.dispatchEvent(new Event('pos_data_updated'));
      window.dispatchEvent(new Event('storage'));
    } catch (evErr) {
      console.warn('Event dispatch failed:', evErr);
    }
    persistTablesToStorage();
  };

  // Toggle Network Online / Offline State
  const toggleNetworkStatus = () => {
    const nextOnline = !isDeviceOnline;
    setIsDeviceOnline(nextOnline);
    if (nextOnline) {
      setTimeout(() => {
        syncOfflineQueue().catch(console.error);
      }, 300);
    }
  };

  // Browser level listener for network changes
  useEffect(() => {
    const handleOnline = () => {
      setIsDeviceOnline(true);
      setTimeout(() => {
        syncOfflineQueue().catch(console.error);
      }, 300);
    };
    const handleOffline = () => {
      setIsDeviceOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const productsRef = React.useRef<Product[]>([]);
  useEffect(() => {
    productsRef.current = products;
  }, [products]);

  const playBeep = () => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext || (window as any).WebkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      oscillator.type = 'sine';
      oscillator.frequency.value = 880; // short checkout beep
      gainNode.gain.setValueAtTime(0.08, audioCtx.currentTime);
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.12);
    } catch (e) {
      console.warn('AudioContext beep failed:', e);
    }
  };

  const handleOnScanSuccess = (decodedText: string) => {
    const now = Date.now();
    // 1.5s rate-limiting cooldown per code to avoid spam/double-trigger on the same scanner sweep
    if (decodedText === lastScanCode && now - lastScanTime < 1500) {
      return;
    }
    setLastScanCode(decodedText);
    setLastScanTime(now);

    const match = productsRef.current.find(p => 
      p.sku.toLowerCase() === decodedText.toLowerCase() || 
      p.id.toString() === decodedText.toLowerCase()
    );

    if (match) {
      if (match.stock <= 0) {
        setScanningMessage(`🛑 Out of Stock: Cannot add "${match.name}"`);
        setTimeout(() => setScanningMessage(null), 3000);
        return;
      }
      playBeep();
      addToCart(match);
      setScanningMessage(`✅ [SCANNED] Added "${match.name}" (SKU: ${match.sku}) to basket!`);
      setTimeout(() => setScanningMessage(null), 3000);
    } else {
      setScanningMessage(`❓ Unrecognized Code: "${decodedText}"`);
      setTimeout(() => setScanningMessage(null), 3000);
    }
  };

  // Bluetooth print simulation and hardware connection states
  const [isBtPrinting, setIsBtPrinting] = useState(false);
  const [btSuccess, setBtSuccess] = useState(false);
  const [pairedBluetoothDevice, setPairedBluetoothDevice] = useState<any>(null);
  const [pairedBluetoothChar, setPairedBluetoothChar] = useState<any>(null);
  const [bluetoothStatus, setBluetoothStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [bluetoothErrorMessage, setBluetoothErrorMessage] = useState<string>('');
  const [showBluetoothPanel, setShowBluetoothPanel] = useState<boolean>(false);
  const [btEscPosHex, setBtEscPosHex] = useState<string>('');
  const [btEscPosText, setBtEscPosText] = useState<string>('');

  // WhatsApp share state
  const [whatsappPhone, setWhatsappPhone] = useState('');
  const [whatsappSuccess, setWhatsappSuccess] = useState(false);

  // Cash-up report state
  const [showCashUpModal, setShowCashUpModal] = useState(false);
  const [cashUpSummary, setCashUpSummary] = useState<any>(null);

  // Shift & Handover active states
  const [isShiftActive, setIsShiftActive] = useState<boolean>(() => {
    return localStorage.getItem('pos_shift_active') === 'true' || localStorage.getItem('shift_active_' + activeStore) === 'true';
  });
  const [openingCash, setOpeningCash] = useState<string>(() => {
    return localStorage.getItem('shift_opening_cash_' + activeStore) || localStorage.getItem('shift_opening_cash_global') || '0.00';
  });
  const [inputOpeningCash, setInputOpeningCash] = useState<string>('');

  // Pre-shift login credentials and active branch selection
  const [loginEmail, setLoginEmail] = useState<string>('');
  const [loginPassword, setLoginPassword] = useState<string>('');
  const [selectedLoginStore, setSelectedLoginStore] = useState<string>(activeStore);
  const [loginStores, setLoginStores] = useState<any[]>([]);

  useEffect(() => {
    const res = runSql("SELECT * FROM stores", 'Fetch stores for login selection');
    if (res.success && Array.isArray(res.data) && res.data.length > 0) {
      setLoginStores(res.data);
    } else {
      setLoginStores([
        { id: 'lusaka', name: 'Lusaka Main Office' },
        { id: 'kitwe', name: 'Kitwe Regional Yard' },
        { id: 'ndola', name: 'Ndola Branch Station' }
      ]);
    }
  }, []);

  useEffect(() => {
    setSelectedLoginStore(activeStore);
  }, [activeStore]);

  // End of Day Cash Up Filters
  const [cashUpDate, setCashUpDate] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [cashUpStore, setCashUpStore] = useState<string>('all');
  const [cashUpCashier, setCashUpCashier] = useState<string>('all');

  // Daily expected aggregates split by channels
  const [salesCashSum, setSalesCashSum] = useState<number>(0);
  const [salesAirtelSum, setSalesAirtelSum] = useState<number>(0);
  const [salesMtnSum, setSalesMtnSum] = useState<number>(0);
  const [salesZamtelSum, setSalesZamtelSum] = useState<number>(0);
  const [salesOtherMomoSum, setSalesOtherMomoSum] = useState<number>(0);
  const [salesCardSum, setSalesCardSum] = useState<number>(0);
  const [salesOtherSum, setSalesOtherSum] = useState<number>(0);

  const [laybyCashSum, setLaybyCashSum] = useState<number>(0);
  const [laybyMomoSum, setLaybyMomoSum] = useState<number>(0);
  const [laybyCardSum, setLaybyCardSum] = useState<number>(0);
  const [cashExpensesSum, setCashExpensesSum] = useState<number>(0);

  // Supervisor verification
  const [isSupervisorApproved, setIsSupervisorApproved] = useState<boolean>(false);
  const [supervisorNameInput, setSupervisorNameInput] = useState<string>('');
  const [supervisorPasswordInput, setSupervisorPasswordInput] = useState<string>('');
  const [supervisors, setSupervisors] = useState<any[]>([]);

  const [cashCounted, setCashCounted] = useState<string>('');
  const [cardCounted, setCardCounted] = useState<string>('');
  const [momoCounted, setMomoCounted] = useState<string>('');
  const [cashUpNotes, setCashUpNotes] = useState<string>('');
  const [isCashUpPosted, setIsCashUpPosted] = useState<boolean>(false);
  const [reconciliationHistory, setReconciliationHistory] = useState<any[]>([]);
  const [cashUpActiveTab, setCashUpActiveTab] = useState<'reconcile' | 'history'>('reconcile');
  const [showDenomHelper, setShowDenomHelper] = useState<boolean>(false);
  const [denominations, setDenominations] = useState<{ [key: string]: number }>({
    '100': 0,
    '50': 0,
    '20': 0,
    '10': 0,
    '5': 0,
    '2': 0,
    '1': 0,
    '0.50': 0,
    '0.10': 0,
  });

  // Fetch previous EOD reconciliation logs from the SQLite table cash_ups
  const loadReconciliationHistory = () => {
    const res = runSql(`SELECT * FROM cash_ups ORDER BY created_at DESC`, 'Retrieve reconciliation ledger history');
    if (res.success && Array.isArray(res.data)) {
      setReconciliationHistory(res.data);
    }
  };

  // Helper functions to fetch expected balances by payment channel
  const getExpectedByMethod = (method: string) => {
    if (!cashUpSummary) return 0;
    if (Array.isArray(cashUpSummary)) {
      const found = cashUpSummary.find((x: any) => x.paymentMethod === method);
      return found ? parseFloat(found.sum_tot || 0) : 0;
    }
    if (method === 'Cash') return (cashUpSummary.salesCash || 0) + (cashUpSummary.laybyCash || 0);
    if (method === 'Mobile Wallet') return (cashUpSummary.salesMomo || 0) + (cashUpSummary.laybyMomo || 0);
    if (method === 'Credit Card') return (cashUpSummary.salesCard || 0) + (cashUpSummary.laybyCard || 0);
    return 0;
  };

  const getTxCountByMethod = (method: string) => {
    if (!cashUpSummary) return 0;
    if (Array.isArray(cashUpSummary)) {
      const found = cashUpSummary.find((x: any) => x.paymentMethod === method);
      return found ? parseInt(found.count_tx || 0) : 0;
    }
    if (cashUpSummary.todayTxList && Array.isArray(cashUpSummary.todayTxList)) {
      return cashUpSummary.todayTxList.filter((tx: any) => tx.method.includes(method)).length;
    }
    return 0;
  };

  // Sync state with SQL database
  const refreshDbData = () => {
    // Read products using SELECT query WITH store_products branch-specific JOIN!
    const query = `
      SELECT 
        p.id, 
        p.name, 
        p.sku, 
        p.category, 
        COALESCE(sp.price, p.price) AS price, 
        p.cost, 
        COALESCE(sp.stock, p.stock) AS stock, 
        p.imageUrl,
        p.is_service
      FROM products p 
      LEFT JOIN store_products sp ON p.id = sp.product_id AND sp.store_id = '${activeStore}'
    `;
    const prodResult = runSql(query, `Register: Retrieve product listings for store [${activeStore.toUpperCase()}]`);
    if (prodResult.success && Array.isArray(prodResult.data)) {
      setProducts(prodResult.data);
    }

    // Read customers using SELECT query
    const custResult = runSql('SELECT * FROM customers', 'Register: Retrieve customer profiles database');
    if (custResult.success && Array.isArray(custResult.data)) {
      setCustomers(custResult.data);
    }

    // Keep invoice history list in sync automatically on all refreshes
    loadInvoices();
  };

  const loadInvoices = (overrideStoreFilter?: string) => {
    // Select orders for the chosen store filter (or all stores if 'all')
    const filterToUse = overrideStoreFilter !== undefined ? overrideStoreFilter : historyStoreFilter;
    let whereClause = '';
    if (filterToUse && filterToUse !== 'all') {
      whereClause = `WHERE (LOWER(store_id) = '${filterToUse.toLowerCase()}' OR store_id IS NULL OR store_id = '')`;
    }

    // Query orders directly without fragile LEFT JOIN on NULL customerId in AlaSQL
    const res = runSql(`
      SELECT * FROM orders 
      ${whereClause}
      ORDER BY orderDate DESC
    `, 'Invoice History: Load all sales orders');

    let combinedList: any[] = [];

    // Create customer name lookup map from customers table
    const custRes = runSql('SELECT id, name FROM customers');
    const custMap = new Map();
    if (custRes.success && Array.isArray(custRes.data)) {
      custRes.data.forEach((c: any) => {
        if (c && c.id) custMap.set(String(c.id), c.name);
      });
    }

    if (res.success && Array.isArray(res.data)) {
      combinedList = res.data.map((o: any) => ({
        ...o,
        customer_name: o.customerId && custMap.has(String(o.customerId))
          ? custMap.get(String(o.customerId))
          : 'Walk-In Customer',
        subtotal: Number(o.subtotal || 0),
        tax: Number(o.tax || 0),
        discount: Number(o.discount || 0),
        total: Number(o.total || 0),
        paymentMethod: o.paymentMethod || 'Cash',
        status: o.status || 'Completed',
        isLayby: false
      }));
    }

    // Load Layby transactions (both active credit deposits and finished/completed laybys)
    let laybyWhere = '';
    if (filterToUse && filterToUse !== 'all') {
      laybyWhere = `WHERE (LOWER(store_id) = '${filterToUse.toLowerCase()}' OR store_id IS NULL OR store_id = '')`;
    }
    const laybyRes = runSql(`SELECT * FROM laybys ${laybyWhere} ORDER BY created_at DESC`, 'Invoice History: Load Layby transactions');
    if (laybyRes.success && Array.isArray(laybyRes.data)) {
      laybyRes.data.forEach((l: any) => {
        const isFinished = l.status === 'COMPLETED' || Number(l.balance_due || 0) <= 0;
        const existsInOrders = combinedList.some((o: any) => o.id === l.id);

        if (!existsInOrders) {
          combinedList.push({
            id: l.id,
            customerId: l.customer_id,
            customer_name: l.customer_name || 'Layby Client',
            orderDate: l.created_at,
            subtotal: Number(l.total_amount || 0),
            tax: 0,
            discount: 0,
            total: Number(l.total_amount || 0),
            paymentMethod: isFinished
              ? `Layby (Finished - Paid K${Number(l.total_amount || 0).toFixed(2)})`
              : `Layby (Active - Paid K${Number(l.amount_paid || 0).toFixed(2)}, K${Number(l.balance_due || 0).toFixed(2)} Due)`,
            status: isFinished ? 'Completed' : 'Layby (Credit)',
            store_id: l.store_id || 'lusaka',
            performed_by: 'Cashier / Layby',
            isLayby: true,
            laybyPaid: Number(l.amount_paid || 0),
            laybyDue: Number(l.balance_due || 0)
          });
        }
      });
    }

    // Sort all transactions by orderDate descending
    combinedList.sort((a, b) => new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime());
    setInvoiceList(combinedList);
  };

  const loadInvoiceDetails = (invoice: any) => {
    setSelectedInvoice(invoice);
    setShowRefundAuth(false);
    const res = runSql(`
      SELECT oi.*, p.name AS product_name, p.sku AS product_sku, p.is_service
      FROM order_items oi
      LEFT JOIN products p ON oi.productId = p.id
      WHERE oi.orderId = '${invoice.id}'
    `, 'Invoice History: Load order items');

    if (res.success && Array.isArray(res.data) && res.data.length > 0) {
      setSelectedInvoiceItems(res.data);
    } else {
      // Check layby contract items_json fallback
      const laybyCheck = runSql(`SELECT items_json FROM laybys WHERE id = '${invoice.id}'`);
      if (laybyCheck.success && Array.isArray(laybyCheck.data) && laybyCheck.data.length > 0 && laybyCheck.data[0].items_json) {
        try {
          const parsed = JSON.parse(laybyCheck.data[0].items_json);
          const mapped = parsed.map((it: any, idx: number) => ({
            id: `${invoice.id}_layby_${idx}`,
            orderId: invoice.id,
            productId: it.id,
            quantity: it.quantity,
            unitPrice: it.unitPrice || it.price,
            product_name: it.name,
            product_sku: it.sku || `LBY-${it.id}`,
            is_service: 0
          }));
          setSelectedInvoiceItems(mapped);
          return;
        } catch (e) {}
      }
      setSelectedInvoiceItems([]);
    }
  };

  const handleReprintReceipt = (inv: any, paperSize: '58mm' | '80mm') => {
    // Load fresh items for the invoice
    const itemRes = runSql(`
      SELECT oi.*, p.name AS product_name, p.sku AS product_sku, p.is_service
      FROM order_items oi
      LEFT JOIN products p ON oi.productId = p.id
      WHERE oi.orderId = '${inv.id}'
    `, 'Invoice History: Load order items');
    const items = (itemRes.success && Array.isArray(itemRes.data)) ? itemRes.data : [];

    // Construct customer object
    const custName = inv.customer_name || 'Walk-In Customer';
    const customerObj = {
      id: inv.customerId || '',
      name: custName,
      phone: 'N/A',
      tpin: 'N/A',
      address: 'N/A'
    };

    const receiptToPrint = {
      id: inv.id,
      date: new Date(inv.orderDate).toLocaleString(),
      paymentMethod: inv.paymentMethod,
      subtotal: Number(inv.subtotal || 0),
      tax: Number(inv.tax || 0),
      taxRate: settings.taxRate,
      discount: Number(inv.discount || 0),
      total: Number(inv.total || 0),
      cashReceived: Number(inv.total || 0),
      change: 0,
      splitBreakdown: null,
      customer: customerObj,
      items: items.map((it: any) => ({
        product: {
          id: it.productId,
          name: it.product_name || 'Unknown Product',
          price: Number(it.unitPrice || 0),
          is_service: it.is_service || 0
        },
        quantity: it.quantity
      })),
      performed_by: inv.performed_by || 'Unknown Cashier',
      zra: null
    };

    setActiveReceipt(receiptToPrint);
    generatePdfReceipt(receiptToPrint, paperSize);
  };

  const executeRefund = (inv: any, supervisorName: string) => {
    // 1. Mark order as Refunded
    const updateRes = runSql(`
      UPDATE orders 
      SET status = 'Refunded' 
      WHERE id = '${inv.id}'
    `, `Refund: Update order status to Refunded`);

    if (!updateRes.success) {
      alert('Error updating order status in database.');
      return;
    }

    // 2. Load order items to restore stock
    const itemRes = runSql(`
      SELECT oi.*, p.name AS product_name, p.is_service
      FROM order_items oi
      LEFT JOIN products p ON oi.productId = p.id
      WHERE oi.orderId = '${inv.id}'
    `, 'Refund: Fetch order lines for stock restore');

    if (itemRes.success && Array.isArray(itemRes.data)) {
      itemRes.data.forEach((item: any) => {
        if (item.is_service !== 1) {
          // Increment store specific stock
          runSql(`
            UPDATE store_products 
            SET stock = stock + ${item.quantity} 
            WHERE product_id = ${item.productId} AND store_id = '${activeStore}'
          `, `Refund: Restore ${item.quantity} units to branch ${activeStore}`);

          // Increment global stock fallback
          runSql(`
            UPDATE products 
            SET stock = stock + ${item.quantity} 
            WHERE id = ${item.productId}
          `, `Refund: Restore ${item.quantity} units to global product database`);
        }
      });
    }

    // 3. Log a refund audit event
    logEmployeeAudit('SALES', 'Processed Refund', `Refunded Order #${inv.id}, Supervisor Approved: ${supervisorName}`, Number(inv.total || 0), activeStore);

    alert(`✓ Refund Processed Successfully!\n\nOrder Ref: ${inv.id}\nValue: ${settings.currency}${Number(inv.total || 0).toFixed(2)}\nSupervisor Approved: ${supervisorName}\n\nInventory levels have been successfully restored!`);

    // 4. Reload data
    loadInvoices();
    // Reselect invoice to refresh UI
    const updatedInv = { ...inv, status: 'Refunded' };
    setSelectedInvoice(updatedInv);
    refreshDbData();
    setShowRefundAuth(false);
    setRefundSupervisorName('');
    setRefundSupervisorPassword('');
  };

  useEffect(() => {
    refreshDbData();
  }, [activeReceipt, activeStore]); // reload catalog on changes

  useEffect(() => {
    if (showInvoiceHistoryModal) {
      loadInvoices();
    }
  }, [showInvoiceHistoryModal, activeStore, historyStoreFilter]);

  useEffect(() => {
    const hasActiveShift = localStorage.getItem('pos_shift_active') === 'true' || localStorage.getItem('shift_active_' + activeStore) === 'true';
    setIsShiftActive(hasActiveShift);
    setOpeningCash(localStorage.getItem('shift_opening_cash_' + activeStore) || localStorage.getItem('shift_opening_cash_global') || '0.00');
    setIsSupervisorApproved(false);
    setSupervisorNameInput('');
  }, [activeStore]);

  // Trigger real QR Code scanner using html5-qrcode
  useEffect(() => {
    let qrScanner: Html5Qrcode | null = null;
    let isActive = true;

    if (isCamerActive) {
      setCameraError(null);
      setScanningMessage(null);

      const initializeAndStart = async () => {
        try {
          const cameras = await Html5Qrcode.getCameras();
          if (!isActive) return;
          if (cameras && cameras.length > 0) {
            setAvailableCameras(cameras);
            
            let targetCamId = selectedCameraId;
            if (!targetCamId || !cameras.some(c => c.id === targetCamId)) {
              // Prefer back-facing camera if it's there
              const backCam = cameras.find(c => c.label.toLowerCase().includes('back')) || cameras[0];
              targetCamId = backCam.id;
              setSelectedCameraId(targetCamId);
            }

            qrScanner = new Html5Qrcode("qr-reader");
            await qrScanner.start(
              targetCamId,
              {
                fps: 10,
                qrbox: (width, height) => {
                  const size = Math.min(width, height) * 0.7;
                  return { width: size, height: size };
                },
                aspectRatio: 1.0
              },
              (decodedText) => {
                handleOnScanSuccess(decodedText);
              },
              () => {} // silent frame scan diagnostics
            );
          } else {
            setCameraError("No camera devices found. Please authorize workspace camera permission.");
          }
        } catch (err: any) {
          if (!isActive) return;
          console.error("html5-qrcode setup failed", err);
          setCameraError(`Camera initialization failed: ${err.message || err}. You can still use the Quick-Scan SKU cheat keys below to simulate barcode scans!`);
        }
      };

      initializeAndStart();
    }

    return () => {
      isActive = false;
      if (qrScanner) {
        if (qrScanner.isScanning) {
          qrScanner.stop().then(() => {
            qrScanner?.clear();
          }).catch(err => console.error("Scanner stop error:", err));
        }
      }
    };
  }, [isCamerActive, selectedCameraId]);

  const handleTriggerQRScanner = () => {
    setIsCameraActive(prev => !prev);
  };

  // Generate high-integrity ESC/POS commands formatting binary payloads
  const generateEscPosData = (receipt: any) => {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    let textPreview = "";

    const addText = (text: string, tags: string[] = []) => {
      parts.push(encoder.encode(text));
      let lineFormatted = text;
      if (tags.includes('bold')) lineFormatted = `[BOLD] ${lineFormatted}`;
      if (tags.includes('center')) lineFormatted = `[CENTER] ${lineFormatted}`;
      if (tags.includes('double')) lineFormatted = `[DOUBLESIZE] ${lineFormatted}`;
      textPreview += lineFormatted + '\n';
    };

    const addBytes = (bytes: number[], label: string = '') => {
      parts.push(new Uint8Array(bytes));
      textPreview += `[HEX: ${bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}] ${label}\n`;
    };

    // Initialize: ESC @
    addBytes([0x1B, 0x40], 'Initialize Printer');

    // Store Name: Center, Bold, Double Size
    addBytes([0x1B, 0x61, 0x01], 'Align Center');
    addBytes([0x1B, 0x45, 0x01], 'Bold ON');
    addBytes([0x1D, 0x21, 0x11], 'Double Width & Height ON');
    addText(settings.storeName.toUpperCase());
    
    // Reset sizes
    addBytes([0x1D, 0x21, 0x00], 'Double Size OFF');
    addBytes([0x1B, 0x45, 0x00], 'Bold OFF');

    if (settings.receiptHeader) {
      addText(settings.receiptHeader, ['center']);
    }
    addText(`DATE: ${receipt.date}`, ['center']);
    addText(`TICKET ID: ${receipt.id}`, ['center']);
    addText('-'.repeat(32));

    // Items
    addBytes([0x1B, 0x61, 0x00], 'Align Left');
    receipt.items.forEach((item: any) => {
      const pName = item.product.name.slice(0, 18);
      const qtyPrice = `${item.quantity}x${settings.currency}${item.product.price.toFixed(2)}`;
      const lineTotal = `${settings.currency}${(item.product.price * item.quantity).toFixed(2)}`;
      
      const paddedRow = pName.padEnd(16, ' ') + qtyPrice.padStart(7, ' ') + lineTotal.padStart(9, ' ');
      addText(paddedRow);
    });

    addBytes([0x1B, 0x61, 0x01], 'Align Center');
    addText('-'.repeat(32));

    // Summary Calculations
    addBytes([0x1B, 0x61, 0x00], 'Align Left');
    const addSumRow = (label: string, val: string) => {
      addText(label.padEnd(20, ' ') + val.padStart(12, ' '));
    };

    addSumRow('Subtotal:', `${settings.currency}${receipt.subtotal.toFixed(2)}`);
    if (receipt.discount > 0) {
      addSumRow('Discount:', `-${settings.currency}${receipt.discount.toFixed(2)}`);
    }
    addSumRow(`Tax (${settings.taxRate}%):`, `${settings.currency}${receipt.tax.toFixed(2)}`);
    
    // Total (Bold)
    addBytes([0x1B, 0x45, 0x01], 'Bold ON');
    addSumRow('GRAND TOTAL:', `${settings.currency}${receipt.total.toFixed(2)}`);
    addBytes([0x1B, 0x45, 0x00], 'Bold OFF');

    addText('-'.repeat(32));
    addText(`Payment Method: ${receipt.paymentMethod.toUpperCase()}`);
    if (receipt.paymentMethod === 'Cash') {
      addText(`Cash Tended:    ${settings.currency}${receipt.cashReceived.toFixed(2)}`);
      addText(`Return Change:  ${settings.currency}${receipt.change.toFixed(2)}`);
    }
    if (receipt.customer) {
      addText(`Customer:       ${receipt.customer.name}`);
      addText(`Points Gained:  +${Math.floor(receipt.total * settings.loyaltyRatio)} PTS`);
    }

    addBytes([0x1B, 0x61, 0x01], 'Align Center');
    addText('-'.repeat(32));
    if (settings.receiptFooter) {
      addText(settings.receiptFooter, ['center']);
    }
    addText('Thank you for shopping!', ['center']);
    addText('\n\n\n'); // spacing
    addBytes([0x1D, 0x56, 0x01], 'Feed & Cut Paper');

    // Combine Uint8Arrays
    let totalLen = parts.reduce((acc, curr) => acc + curr.length, 0);
    let bytes = new Uint8Array(totalLen);
    let offset = 0;
    for (let part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }

    return { bytes, textPreview };
  };

  const connectBluetoothPrinter = async () => {
    setBluetoothErrorMessage('');
    setBluetoothStatus('connecting');
    try {
      const nav = navigator as any;
      if (!nav.bluetooth) {
        throw new Error("Web Bluetooth API is not supported in this frame or browser. To connect a real thermal printer, please open this sandbox app in a new browser tab.");
      }

      const device = await nav.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [
          '000018f0-0000-1000-8000-00805f9b34fb', // standard BLE Printer service ID
          '0000e7e1-0000-1000-8000-00805f9b34fb', // custom printers IDs
          '49535343-fe7d-4ae5-8fa9-9fafd205e455'  // ISSC custom service
        ]
      });

      const server = await device.gatt?.connect();
      if (!server) {
        throw new Error("Target GATT Server pairing handshake failed.");
      }

      const services = await server.getPrimaryServices();
      let foundCharacteristics: any[] = [];
      for (const service of services) {
        try {
          const chars = await service.getCharacteristics();
          foundCharacteristics = [...foundCharacteristics, ...chars];
        } catch (e) {
          // ignore service-specific discovery exceptions
        }
      }

      // Find any writable characteristic
      const writeChar = foundCharacteristics.find(c => c.properties.write || c.properties.writeWithoutResponse);
      if (!writeChar) {
        throw new Error("Identified device but no ESC/POS raw write characteristics were found.");
      }

      setPairedBluetoothDevice(device);
      setPairedBluetoothChar(writeChar);
      setBluetoothStatus('connected');

      device.addEventListener('gattserverdisconnected', () => {
        setPairedBluetoothDevice(null);
        setPairedBluetoothChar(null);
        setBluetoothStatus('disconnected');
      });
    } catch (err: any) {
      console.error(err);
      setBluetoothStatus('error');
      setBluetoothErrorMessage(err.message || String(err));
    }
  };

  const disconnectBluetoothPrinter = () => {
    if (pairedBluetoothDevice && pairedBluetoothDevice.gatt?.connected) {
      pairedBluetoothDevice.gatt.disconnect();
    }
    setPairedBluetoothDevice(null);
    setPairedBluetoothChar(null);
    setBluetoothStatus('disconnected');
  };

  const handleBluetoothPrint = async () => {
    if (!activeReceipt) return;

    setIsBtPrinting(true);
    setBtSuccess(false);

    const { bytes, textPreview } = generateEscPosData(activeReceipt);
    setBtEscPosText(textPreview);
    
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
    setBtEscPosHex(hex);

    try {
      if (pairedBluetoothChar) {
        // Chunk bytes to fit BLE MTU payload windows (20 byte safe standard writes)
        const chunkSize = 20;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.slice(i, i + chunkSize);
          await pairedBluetoothChar.writeValue(chunk);
        }
        setBtSuccess(true);
      } else {
        // If no paired accessory, we pop the custom simulated printer helper panel
        setShowBluetoothPanel(true);
        setTimeout(() => {
          setBtSuccess(true);
        }, 1000);
      }
    } catch (err: any) {
      console.error("BLE printing failed", err);
      setBluetoothErrorMessage(`Real peripheral print failed: ${err.message || err}. Visualized ticket code streams generated successfully below!`);
      setBluetoothStatus('error');
      setShowBluetoothPanel(true);
    } finally {
      setIsBtPrinting(false);
    }
  };

  const handleConfirmAndPrint = () => {
    setShowReceiptHtmlPreview(false);
    if (pendingPrintMode === 'bluetooth') {
      handleBluetoothPrint();
    } else if (pendingPrintMode === 'system') {
      safeSystemPrint();
    } else {
      safeSystemPrint();
    }
  };

  // Generate highly styled real PDF receipt for download
  const generatePdfReceipt = (receipt: any, selectedSize: '58mm' | '80mm' = '58mm') => {
    try {
      const is58 = selectedSize === '58mm';
      const pageWidth = is58 ? 58 : 80;

      // Calculate exact text layout metrics in advance to prevent clipping
      const dummyDoc = new jsPDF();
      
      let nameLinesTotalHeight = 0;
      receipt.items.forEach((item: any) => {
        const itemWidth = is58 ? 24 : 35;
        const nameLines = dummyDoc.splitTextToSize(item.product.name, itemWidth);
        nameLinesTotalHeight += (nameLines.length * 3.5) + 1.5;
      });

      let termsHeight = 0;
      if (settings.termsAndConditions) {
        const termsWidth = is58 ? 52 : 72;
        const termsLines = dummyDoc.splitTextToSize(settings.termsAndConditions, termsWidth);
        termsHeight = (termsLines.length * 3.0) + 6;
      }

      // Dynamic ticket height computation
      let ticketHeight = 75; // starting baseline
      if (settings.logoUrl) ticketHeight += 18;
      if (settings.receiptHeader) ticketHeight += 6;
      if (settings.tpin) ticketHeight += 5;
      if (receipt.customer) ticketHeight += 5;
      
      ticketHeight += nameLinesTotalHeight;
      ticketHeight += 22; // Subtotal, tax, and totals
      if (receipt.discount > 0) ticketHeight += 4;
      
      ticketHeight += 12; // Payment details
      if (receipt.paymentMethod === 'Cash' || receipt.paymentMethod === 'Split') {
        ticketHeight += 10;
      }
      
      if (receipt.zra) ticketHeight += 55;
      ticketHeight += termsHeight;
      if (settings.receiptFooter) ticketHeight += 5;
      ticketHeight += 22; // Barcode graphic height
      ticketHeight += 25; // bottom margin for printer tear-off feed

      const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: [pageWidth, ticketHeight]
      });

      // Pure black and white styling for high contrast thermal printing
      doc.setTextColor(0, 0, 0);
      doc.setDrawColor(0, 0, 0);
      doc.setLineWidth(0.15);

      // Use Times New Roman font for receipts
      doc.setFont('times', 'normal');

      let headingOffset = 8;
      const leftMargin = is58 ? 3 : 4;
      const rightMargin = is58 ? 55 : 76;
      const midPoint = is58 ? 29 : 40;

      // Draw Company Logo picture if provided or default
      const logoToUse = settings.logoUrl || DEFAULT_COMPANY_LOGO;
      if (logoToUse) {
        try {
          const logoSize = 15;
          const logoX = midPoint - (logoSize / 2);
          doc.addImage(logoToUse, 'PNG', logoX, headingOffset, logoSize, logoSize);
          headingOffset += 18;
        } catch (err) {
          console.warn("Error rendering logo in PDF, skipping:", err);
          headingOffset += 2;
        }
      }

      // Title (Store name)
      doc.setFont('times', 'bold');
      doc.setFontSize(is58 ? 10.5 : 12.5);
      doc.text(settings.storeName.toUpperCase(), midPoint, headingOffset, { align: 'center' });
      headingOffset += 4.5;

      // Subtitle Badge
      doc.setFont('times', 'bold');
      doc.setFontSize(is58 ? 6.5 : 7.5);
      doc.text('*** TAX INVOICE & RECEIPT ***', midPoint, headingOffset, { align: 'center' });
      headingOffset += 4.5;

      doc.setFont('times', 'normal');
      doc.setFontSize(is58 ? 7.5 : 8.5);
      if (settings.receiptHeader) {
        doc.text(settings.receiptHeader, midPoint, headingOffset, { align: 'center' });
        headingOffset += 4.5;
      }

      // TPIN Number
      if (settings.tpin) {
        doc.setFont('times', 'bold');
        doc.setFontSize(is58 ? 7 : 8);
        doc.text(`TPIN: ${settings.tpin}`, midPoint, headingOffset, { align: 'center' });
        doc.setFont('times', 'normal');
        headingOffset += 4.5;
      }

      // Top Double Divider Line
      doc.setLineWidth(0.3);
      doc.line(leftMargin, headingOffset, rightMargin, headingOffset);
      doc.setLineWidth(0.1);
      doc.line(leftMargin, headingOffset + 0.6, rightMargin, headingOffset + 0.6);
      headingOffset += 4.5;

      // Metadata Block
      doc.setFontSize(is58 ? 7 : 8);
      doc.setFont('times', 'bold');
      doc.text('INVOICE NO:', leftMargin, headingOffset);
      doc.setFont('times', 'normal');
      doc.text(`${receipt.id}`, rightMargin, headingOffset, { align: 'right' });
      headingOffset += 4;

      doc.setFont('times', 'bold');
      doc.text('DATE / TIME:', leftMargin, headingOffset);
      doc.setFont('times', 'normal');
      doc.text(`${receipt.date}`, rightMargin, headingOffset, { align: 'right' });
      headingOffset += 4;

      doc.setFont('times', 'bold');
      doc.text('BRANCH HUB:', leftMargin, headingOffset);
      doc.setFont('times', 'normal');
      doc.text(`${activeStore.toUpperCase()}`, rightMargin, headingOffset, { align: 'right' });
      headingOffset += 4;

      const repName = receipt.performed_by || localStorage.getItem('logged_in_user_name') || 'Default Cashier';
      doc.setFont('times', 'bold');
      doc.text('CASHIER:', leftMargin, headingOffset);
      doc.setFont('times', 'normal');
      doc.text(`${repName.toUpperCase()}`, rightMargin, headingOffset, { align: 'right' });
      headingOffset += 4;

      if (receipt.customer) {
        doc.setFont('times', 'bold');
        doc.text('CUSTOMER:', leftMargin, headingOffset);
        doc.setFont('times', 'normal');
        doc.text(`${receipt.customer.name}`, rightMargin, headingOffset, { align: 'right' });
        headingOffset += 4;
      }

      // Divider Line
      doc.setLineWidth(0.2);
      doc.line(leftMargin, headingOffset, rightMargin, headingOffset);
      headingOffset += 4;

      // Table Header
      doc.setFont('times', 'bold');
      doc.setFontSize(is58 ? 7 : 8);
      const qtyCol = is58 ? 31 : 44;
      const priceCol = is58 ? 43 : 58;
      const totalCol = is58 ? 55 : 76;

      doc.text('ITEM', leftMargin, headingOffset);
      doc.text('QTY', qtyCol, headingOffset, { align: 'center' });
      doc.text('PRICE', priceCol, headingOffset, { align: 'right' });
      doc.text('TOTAL', totalCol, headingOffset, { align: 'right' });
      headingOffset += 3.5;
      doc.setLineWidth(0.15);
      doc.line(leftMargin, headingOffset, rightMargin, headingOffset);
      headingOffset += 4;
      doc.setFont('times', 'normal');

      receipt.items.forEach((item: any) => {
        const itemY = headingOffset;
        const itemWidth = is58 ? 24 : 35;
        const nameLines = doc.splitTextToSize(item.product.name, itemWidth);
        doc.text(nameLines, leftMargin, itemY);
        doc.text(item.quantity.toString(), qtyCol, itemY, { align: 'center' });
        doc.text(`${settings.currency}${item.product.price.toFixed(2)}`, priceCol, itemY, { align: 'right' });
        doc.text(`${settings.currency}${(item.product.price * item.quantity).toFixed(2)}`, totalCol, itemY, { align: 'right' });
        headingOffset += (nameLines.length * 3.5) + 1.5;
      });

      // Divider
      doc.line(leftMargin, headingOffset, rightMargin, headingOffset);
      headingOffset += 4;

      // Summary lines
      const summaryLabelCol = is58 ? 35 : 46;
      doc.text('Subtotal:', summaryLabelCol, headingOffset, { align: 'right' });
      doc.text(`${settings.currency}${receipt.subtotal.toFixed(2)}`, totalCol, headingOffset, { align: 'right' });
      headingOffset += 4;

      if (receipt.discount > 0) {
        doc.text('Discount:', summaryLabelCol, headingOffset, { align: 'right' });
        doc.text(`-${settings.currency}${receipt.discount.toFixed(2)}`, totalCol, headingOffset, { align: 'right' });
        headingOffset += 4;
      }

      const taxRateVal = receipt.taxRate !== undefined ? receipt.taxRate : settings.taxRate;
      doc.text(`VAT (${taxRateVal}%):`, summaryLabelCol, headingOffset, { align: 'right' });
      doc.text(`${settings.currency}${receipt.tax.toFixed(2)}`, totalCol, headingOffset, { align: 'right' });
      headingOffset += 5;

      // Grand Total Framed Box
      doc.setLineWidth(0.4);
      doc.rect(leftMargin, headingOffset - 3, rightMargin - leftMargin, 8);
      doc.setFont('times', 'bold');
      doc.setFontSize(is58 ? 8.5 : 10);
      doc.text('GRAND TOTAL:', leftMargin + 2, headingOffset + 2.5);
      doc.text(`${settings.currency}${receipt.total.toFixed(2)}`, rightMargin - 2, headingOffset + 2.5, { align: 'right' });
      headingOffset += 10;

      doc.setFont('times', 'normal');
      doc.setFontSize(is58 ? 7 : 8);
      doc.text(`Payment Method: ${receipt.paymentMethod.toUpperCase()}`, leftMargin, headingOffset);
      headingOffset += 4;

      if (receipt.paymentMethod === 'Cash') {
        doc.text(`Cash Tendered: ${settings.currency}${receipt.cashReceived.toFixed(2)}`, leftMargin, headingOffset);
        headingOffset += 4;
        doc.text(`Return Change: ${settings.currency}${receipt.change.toFixed(2)}`, leftMargin, headingOffset);
        headingOffset += 5;
      } else if (receipt.paymentMethod === 'Split' && receipt.splitBreakdown) {
        doc.text(`Cash Portion: ${settings.currency}${receipt.splitBreakdown.cash.toFixed(2)}`, leftMargin, headingOffset);
        headingOffset += 4;
        doc.text(`Mobile Portion: ${settings.currency}${receipt.splitBreakdown.mobile.toFixed(2)}`, leftMargin, headingOffset);
        headingOffset += 4;
        doc.text(`Return Change: ${settings.currency}${receipt.change.toFixed(2)}`, leftMargin, headingOffset);
        headingOffset += 5;
      }

      // Add ZRA Smart Invoice Fiscal Stamps & Verifiers if active
      if (receipt.zra) {
        doc.setLineWidth(0.15);
        doc.line(leftMargin, headingOffset, rightMargin, headingOffset);
        headingOffset += 4;
        
        doc.setFont('times', 'bold');
        doc.setFontSize(is58 ? 6.5 : 7.5);
        doc.text('--- ZRA FISCAL SMART INVOICE ---', midPoint, headingOffset, { align: 'center' });
        headingOffset += 4.5;
        
        doc.setFont('times', 'normal');
        doc.setFontSize(is58 ? 6 : 7);
        doc.text(`SME TPIN: ${settings.tpin || '1001234567'}`, leftMargin, headingOffset);
        doc.text(`CUSTOMER TPIN: ${receipt.zra.tpin}`, midPoint, headingOffset);
        headingOffset += 3.5;
        
        doc.text(`TAX CLASSIFICATION: ${receipt.zra.taxBand}`, leftMargin, headingOffset);
        headingOffset += 3.5;
        
        doc.setFont('times', 'bold');
        doc.text(`ZRA FISCAL FSD CODE:`, leftMargin, headingOffset);
        headingOffset += 3.5;
        doc.setFont('times', 'normal');
        doc.setFontSize(is58 ? 5.5 : 6.5);
        doc.text(`${receipt.zra.fiscalCode}`, leftMargin, headingOffset);
        headingOffset += 4.5;

        // Custom ASCII-style Mock QR / barcode for receipt authentication scans
        const qrSizeX = is58 ? 20 : 28;
        const qrSizeY = 12;
        const qrX = midPoint - (qrSizeX / 2);
        doc.rect(qrX, headingOffset, qrSizeX, qrSizeY);
        doc.setFont('times', 'bold');
        doc.setFontSize(is58 ? 5 : 6);
        doc.text('[ ZRA VERIFIED SECURE ]', midPoint, headingOffset + 4, { align: 'center' });
        doc.setFont('times', 'normal');
        doc.setFontSize(is58 ? 4 : 5);
        doc.text('MOCK QR SCAN PREVIEW', midPoint, headingOffset + 8, { align: 'center' });
        headingOffset += 16;
      }

      // Render Divider for Footer info
      doc.setLineWidth(0.15);
      doc.line(leftMargin, headingOffset, rightMargin, headingOffset);
      headingOffset += 4.5;

      // Support Terms and Conditions
      if (settings.termsAndConditions) {
        doc.setFont('times', 'bold');
        doc.setFontSize(is58 ? 5.5 : 6.5);
        doc.text('TERMS & CONDITIONS:', leftMargin, headingOffset);
        headingOffset += 3.2;
        doc.setFont('times', 'normal');
        doc.setFontSize(is58 ? 5 : 6);
        
        const termsWidth = is58 ? 52 : 72;
        const lines = doc.splitTextToSize(settings.termsAndConditions, termsWidth);
        lines.forEach((l: string) => {
          doc.text(l, leftMargin, headingOffset);
          headingOffset += 3.0;
        });
        headingOffset += 2;
      }

      if (settings.receiptFooter) {
        doc.setFont('times', 'normal');
        doc.setFontSize(is58 ? 6.5 : 7.5);
        doc.text(settings.receiptFooter, midPoint, headingOffset, { align: 'center' });
        headingOffset += 4.5;
      }
      doc.setFont('times', 'italic');
      doc.setFontSize(is58 ? 6.5 : 7.5);
      doc.text('Thank you for shopping with us!', midPoint, headingOffset, { align: 'center' });
      headingOffset += 6;

      // Draw thermal receipt barcode pattern at bottom
      const bcWidth = is58 ? 38 : 50;
      const bcX = midPoint - (bcWidth / 2);
      const barHeights = 8;
      doc.setFillColor(0, 0, 0);
      let currX = bcX;
      const pattern = [2, 1, 3, 1, 2, 2, 1, 3, 1, 1, 2, 3, 1, 2, 1, 3, 2, 1, 2, 1, 3, 1, 2];
      pattern.forEach((w, idx) => {
        if (idx % 2 === 0) {
          doc.rect(currX, headingOffset, w * 0.4, barHeights, 'F');
        }
        currX += w * 0.5;
      });
      headingOffset += barHeights + 3;
      doc.setFont('times', 'normal');
      doc.setFontSize(is58 ? 5.5 : 6.5);
      doc.text(`*${receipt.id}*`, midPoint, headingOffset, { align: 'center' });

      // Trigger automatic receipt PDF file generation and device share/download
      exportAndSharePdf(`receipt-${selectedSize}-${receipt.id}.pdf`, doc);
    } catch (err) {
      console.error('jsPDF generation error:', err);
    }
  };

  // Direct action button: Manually register customer to loyalty database on-the-spot
  const saveCustomerToRegistry = () => {
    let nameToRegister = customerName.trim();
    if (!nameToRegister && customerRegistrySearchText.trim()) {
      nameToRegister = customerRegistrySearchText.trim();
      setCustomerName(nameToRegister);
    }

    if (!nameToRegister) {
      alert('⚠️ Unable to Onboard:\n\nPlease input the Customer Name before attempting to register.');
      return;
    }
    const cleanName = nameToRegister;
    const existing = customers.find(c => c.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) {
      const confirmSelection = window.confirm(`"${cleanName}" is already in the database registry.\n\nWould you like to auto-select them instead?`);
      if (confirmSelection) {
        setSelectedCustomer(existing);
        setCustomerName(existing.name || '');
        setCustomerPhone(existing.phone || '');
        setCustomerTpin(existing.tpin || '');
        setCustomerAddress(existing.email || ''); // map fallback
      }
      return;
    }

    const newCustId = 400 + Math.floor(Math.random() * 9000);
    const checkedPhone = customerPhone.trim() || 'N/A';
    const checkedTpin = customerTpin.trim() || '';
    const checkedEmail = customerAddress.trim() || 'N/A';

    const insertSql = `
      INSERT INTO customers (id, name, phone, email, loyalPoints, tpin, zra_connected, tax_band, business_id)
      VALUES (${newCustId}, '${cleanName.replace(/'/g, "''")}', '${checkedPhone.replace(/'/g, "''")}', '${checkedEmail.replace(/'/g, "''")}', 10, '${checkedTpin}', 0, 'A - Standard Rate (16%)', 'default_biz')
    `;

    const res = runSql(insertSql, `Registry Checkout Action: Directly save client [${cleanName}]`);
    if (res.success) {
      alert(`✓ Customer "${cleanName}" is successfully registered in your Database!\n\nThis client has been added to the master Loyal Members Registry and allocated 10 reward points for future purchases.`);
      
      // Refresh list
      const custResult = runSql('SELECT * FROM customers', 'Register: Refresh customer profiles database action');
      if (custResult.success && Array.isArray(custResult.data)) {
        setCustomers(custResult.data);
        const newlyCreated = custResult.data.find(x => x.id === newCustId);
        if (newlyCreated) {
          setSelectedCustomer(newlyCreated);
        }
      }
    } else {
      alert(`Onboarding Error: ${res.error}`);
    }
  };

  // Safe and super intuitive checkout routing helper (to progress to payment/cash up)
  const handleContinueToPayment = (forceGuest: boolean = false) => {
    let finalName = customerName.trim();

    if (forceGuest) {
      setSelectedCustomer(null);
      setCustomerName('General Walk-in Client');
      setCustomerPhone('');
      setCustomerTpin('');
      setCustomerAddress('');
      setCheckoutStep('payment');
      return;
    }

    // Extremely smart query fallback if they entered search keywords but missed selecting him
    if (!finalName && customerRegistrySearchText.trim()) {
      const query = customerRegistrySearchText.trim().toLowerCase();
      const filtered = customers.filter(c => 
        (c.name && c.name.toLowerCase().includes(query)) ||
        (c.phone && c.phone.toLowerCase().includes(query)) ||
        (c.tpin && c.tpin.toLowerCase().includes(query))
      );
      if (filtered.length > 0) {
        const bestMatch = filtered[0];
        setSelectedCustomer(bestMatch);
        finalName = bestMatch.name || '';
        setCustomerName(bestMatch.name || '');
        setCustomerPhone(bestMatch.phone || '');
        setCustomerTpin(bestMatch.tpin || '');
        setCustomerAddress(bestMatch.email || '');
      } else {
        finalName = customerRegistrySearchText.trim();
        setCustomerName(finalName);
      }
    }

    // Never block the merchant: seamlessly fall back to Walk-in Client so they can immediately "cash up"
    if (!finalName) {
      finalName = 'General Walk-in Client';
      setCustomerName('General Walk-in Client');
    }

    // Automatically save customer details to SQLite database if not yet registered
    const cleanName = finalName.trim();
    if (cleanName && cleanName.toLowerCase() !== 'general walk-in client' && cleanName.toLowerCase() !== 'walk-in client') {
      const existing = customers.find(c => c.name.toLowerCase() === cleanName.toLowerCase());
      if (!existing) {
        const newCustId = 400 + Math.floor(Math.random() * 9000);
        const checkedPhone = customerPhone.trim() || 'N/A';
        const checkedTpin = customerTpin.trim() || '';
        const checkedEmail = customerAddress.trim() || 'N/A';

        const insertSql = `
          INSERT INTO customers (id, name, phone, email, loyalPoints, tpin, zra_connected, tax_band, business_id)
          VALUES (${newCustId}, '${cleanName.replace(/'/g, "''")}', '${checkedPhone.replace(/'/g, "''")}', '${checkedEmail.replace(/'/g, "''")}', 10, '${checkedTpin}', 0, 'A - Standard Rate (16%)', 'default_biz')
        `;

        const res = runSql(insertSql, `Auto-Registry On: Automatically save client [${cleanName}]`);
        if (res.success) {
          // Refresh list
          const custResult = runSql('SELECT * FROM customers', 'Register: Refresh customer profiles database action');
          if (custResult.success && Array.isArray(custResult.data)) {
            setCustomers(custResult.data);
            const newlyCreated = custResult.data.find(x => x.id === newCustId);
            if (newlyCreated) {
              setSelectedCustomer(newlyCreated);
            }
          }
        }
      } else {
        // Auto select existing
        setSelectedCustomer(existing);
      }
    }

    setCheckoutStep('payment');
  };

  // Universal fallback plaintext copy receipt for physical Bluetooth thermal printing helper apps
  const handleCopyPlaintextReceipt = () => {
    if (!activeReceipt) {
      alert('Error: No active print job receipt found.');
      return;
    }
    
    let text = `===============================\n`;
    text += `   ${settings.storeName.toUpperCase()}\n`;
    if (settings.receiptHeader) text += `   ${settings.receiptHeader}\n`;
    if (settings.tpin) text += `   TPIN: ${settings.tpin}\n`;
    text += `===============================\n`;
    text += `TICKET REF: ${activeReceipt.id}\n`;
    text += `DATE: ${activeReceipt.date}\n`;
    text += `BRANCH: ${activeStore.toUpperCase()}\n`;
    if (activeReceipt.customer) {
      text += `CUSTOMER: ${activeReceipt.customer.name}\n`;
    }
    text += `-------------------------------\n`;
    text += `ITEM         QTY  PRICE   TOTAL\n`;
    activeReceipt.items.forEach((item: any) => {
      const name = (item.product.name || 'Goods').substring(0, 12).padEnd(12, ' ');
      const qty = item.quantity.toString().padStart(3, ' ');
      const price = item.product.price.toFixed(1).padStart(6, ' ');
      const total = (item.product.price * item.quantity).toFixed(1).padStart(7, ' ');
      text += `${name} ${qty} ${price} ${total}\n`;
    });
    text += `-------------------------------\n`;
    text += `Subtotal: ${settings.currency}${activeReceipt.subtotal.toFixed(2).padStart(8)}\n`;
    if (activeReceipt.discount > 0) {
      text += `Discount: -${settings.currency}${activeReceipt.discount.toFixed(2).padStart(8)}\n`;
    }
    text += `Tax (${activeReceipt.taxRate || settings.taxRate}%): ${settings.currency}${activeReceipt.tax.toFixed(2).padStart(8)}\n`;
    text += `GRAND TOTAL: ${settings.currency}${activeReceipt.total.toFixed(2).padStart(8)}\n`;
    text += `===============================\n`;
    text += `Payment Mode: ${activeReceipt.paymentMethod.toUpperCase()}\n`;
    if (activeReceipt.paymentMethod === 'Cash') {
      text += `Cash Tendered: ${settings.currency}${activeReceipt.cashReceived.toFixed(2)}\n`;
      text += `Return Change: ${settings.currency}${activeReceipt.change.toFixed(2)}\n`;
    }
    text += `===============================\n`;
    if (settings.receiptFooter) text += `${settings.receiptFooter}\n`;
    text += `Thank you for shopping!\n`;
    
    navigator.clipboard.writeText(text).then(() => {
      alert(`✓ Plaintext Receipt Copied to Clipboard!\n\nYou can now paste this clean pre-formatted text into any standard Bluetooth ESC/POS print helper apps or send it via SMS/WhatsApp.`);
    }).catch(err => {
      console.error(err);
      alert(`Failed to auto-copy to clipboard. Please copy text layout manually.`);
    });
  };

  // Perform WhatsApp Receipt PDF dispatch sharing
  const handleWhatsAppSend = (e?: React.FormEvent | React.MouseEvent) => {
    if (e && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    if (!whatsappPhone) {
      alert('Please fill in a valid WhatsApp mobile number!');
      return;
    }
    if (!activeReceipt) {
      alert('No active ticket available to share.');
      return;
    }

    // Step 1: Automatically generate and download the high-quality PDF Receipt
    generatePdfReceipt(activeReceipt);

    // Step 2: Build beautifully formatted WhatsApp text representation mirroring the PDF
    const cleanPhone = whatsappPhone.replace(/[^\d+]/g, ''); // keep only numbers & optional '+'
    const headerDecor = '━━━━━━━━━━━━━━━━━━━━━━━━━';
    
    let msg = `🧾 *RECEIPT FROM ${settings.storeName.toUpperCase()}* 🧾\n`;
    msg += `_${settings.receiptHeader || 'Official Purchase Invoice'}_\n`;
    msg += `${headerDecor}\n`;
    msg += `*Ticket ID:* ${activeReceipt.id}\n`;
    msg += `*Date:* ${activeReceipt.date}\n`;
    msg += `*Store:* ${activeStore.toUpperCase()} branch\n`;
    if (activeReceipt.customer) {
      msg += `*Customer:* ${activeReceipt.customer.name}\n`;
    }
    msg += `${headerDecor}\n\n`;

    msg += `🛒 *PURCHASED ITEMS:*\n`;
    activeReceipt.items.forEach((item: any) => {
      msg += `• *${item.product.name}* (x${item.quantity})\n`;
      msg += `  ${settings.currency}${item.product.price.toFixed(2)} ea ➔ *${settings.currency}${(item.product.price * item.quantity).toFixed(2)}*\n`;
    });
    msg += `\n${headerDecor}\n`;
    msg += `*Subtotal:* ${settings.currency}${activeReceipt.subtotal.toFixed(2)}\n`;
    if (activeReceipt.discount > 0) {
      msg += `*Discount Applied:* -${settings.currency}${activeReceipt.discount.toFixed(2)}\n`;
    }
    msg += `*Tax (${settings.taxRate}%):* ${settings.currency}${activeReceipt.tax.toFixed(2)}\n`;
    msg += `*GRAND TOTAL: ${settings.currency}${activeReceipt.total.toFixed(2)}*\n`;
    msg += `${headerDecor}\n`;
    msg += `*Payment Mode:* ${activeReceipt.paymentMethod.toUpperCase()}\n`;
    if (activeReceipt.paymentMethod === 'Cash') {
      msg += `*Tendered:* ${settings.currency}${activeReceipt.cashReceived.toFixed(2)}\n`;
      msg += `*Change Back:* ${settings.currency}${activeReceipt.change.toFixed(2)}\n`;
    } else if (activeReceipt.paymentMethod === 'Split' && activeReceipt.splitBreakdown) {
      msg += `*Cash Portion Tended:* ${settings.currency}${activeReceipt.splitBreakdown.cash.toFixed(2)}\n`;
      msg += `*Mobile Money Paid:* ${settings.currency}${activeReceipt.splitBreakdown.mobile.toFixed(2)}\n`;
      if (activeReceipt.change > 0) {
        msg += `*Cash Change Returned:* ${settings.currency}${activeReceipt.change.toFixed(2)}\n`;
      }
    }
    msg += `${headerDecor}\n`;
    if (settings.receiptFooter) {
      msg += `_${settings.receiptFooter}_\n`;
    }
    msg += `*Thank you for your business!*\n\n`;
    msg += `📁 _Your official high-resolution PDF copy has been successfully compiled and downloaded to your downloads folder._`;

    // Step 3: Trigger external link smoothly
    const url = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(msg)}`;
    
    // We update state for success visual feedback
    setWhatsappSuccess(true);
    
    // Attempt window.open with a standard fallback link alert to guarantee user has a clickable action sheet if browser pop-up is strict!
    const newWindow = window.open(url, '_blank');
    if (!newWindow || newWindow.closed || typeof newWindow.closed === 'undefined') {
      // Return a quick alert with double action fallback trigger
      const confirmOpen = window.confirm(`PDF receipt generated & downloaded! \n\nPop-up block warning: Please click 'OK' to redirect to WhatsApp Chat for ${cleanPhone} directly.`);
      if (confirmOpen) {
        window.location.href = url;
      }
    }
  };

  // Compute EOD Cash up balancing query from existing SQLite sales database for selected Date, Store, and Cashier
  const handleTriggerCashUp = (
    overrideDate?: string,
    overrideStore?: string,
    overrideCashier?: string,
    shouldOpenModal: boolean = false
  ) => {
    const targetDate = overrideDate !== undefined ? overrideDate : cashUpDate;
    const targetStore = overrideStore !== undefined ? overrideStore : cashUpStore;
    const targetCashier = overrideCashier !== undefined ? overrideCashier : cashUpCashier;

    // Helper to check if a date string/timestamp matches the target YYYY-MM-DD
    const isTargetDate = (rawDate: any) => {
      if (!rawDate) return false;
      const dateStr = String(rawDate).trim();
      if (!dateStr) return false;

      // Direct match if string contains target date YYYY-MM-DD
      if (dateStr.includes(targetDate)) return true;

      // Parse timestamp or ISO string
      const d = new Date(typeof rawDate === 'number' ? rawDate : dateStr);
      if (!isNaN(d.getTime())) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}` === targetDate;
      }
      return false;
    };

    // Helper for store matching
    const isTargetStore = (storeId: any) => {
      if (targetStore === 'all' || !targetStore) return true;
      const tStoreLower = targetStore.toLowerCase().trim();
      const ordStoreLower = String(storeId || '').toLowerCase().trim();
      if (!ordStoreLower) return true;
      return ordStoreLower === tStoreLower;
    };

    // Helper for cashier matching
    const isTargetCashier = (perfBy: any) => {
      if (targetCashier === 'all' || !targetCashier) return true;
      const tCashierLower = targetCashier.toLowerCase().trim();
      const perfLower = String(perfBy || '').toLowerCase().trim();
      if (!perfLower) return true;
      return perfLower.includes(tCashierLower) || tCashierLower.includes(perfLower);
    };

    // 1. Fetch completed orders from SQLite database
    const ordersRes = runSql(`
      SELECT o.*, c.name AS customer_name 
      FROM orders o
      LEFT JOIN customers c ON o.customerId = c.id
      WHERE LOWER(TRIM(o.status)) NOT IN ('cancelled', 'voided', 'refunded', 'deleted')
      AND (
        LOWER(TRIM(o.status)) IN ('completed', 'success', 'paid', 'active', 'quicksale')
        OR o.status IS NULL 
        OR o.status = ''
      )
      ORDER BY o.orderDate DESC
    `, 'EOD Cash Up: Query database completed sales');

    // 2. Fetch layby installments
    const laybyPaymentsRes = runSql(`
      SELECT li.*, l.customer_name
      FROM layby_installments li
      LEFT JOIN laybys l ON li.layby_id = l.id
      ORDER BY li.created_at DESC
    `, 'EOD Cash Up: Query layby payments');

    // 3. Fetch recorded cash expenses / cash out
    const expensesRes = runSql(`
      SELECT * FROM expenses 
      WHERE (LOWER(account_id) = 'acc_cash' OR LOWER(source_account_id) = 'acc_cash')
      ORDER BY created_at DESC
    `, 'EOD Cash Up: Query cash out expenses');

    let sCash = 0;
    let sAirtel = 0;
    let sMtn = 0;
    let sZamtel = 0;
    let sOtherMomo = 0;
    let sCard = 0;
    let sOther = 0;

    const txList: any[] = [];
    const processedTxIds = new Set<string>();

    // Process orders from SQLite database
    if (ordersRes.success && Array.isArray(ordersRes.data)) {
      ordersRes.data.forEach((ord: any) => {
        if (!isTargetDate(ord.orderDate)) return;
        if (!isTargetStore(ord.store_id)) return;
        if (!isTargetCashier(ord.performed_by)) return;

        const ordId = String(ord.id || '');
        if (ordId) processedTxIds.add(ordId);

        const method = String(ord.paymentMethod || 'Cash').trim();
        const methodLower = method.toLowerCase();
        const tot = parseFloat(ord.total || 0);

        if (methodLower === 'cash') {
          sCash += tot;
          txList.push({ id: ord.id, type: 'Completed Sale', method: 'Cash', amount: tot, time: ord.orderDate, customer: ord.customer_name || 'Walk-in Customer', cashier: ord.performed_by || 'Cashier' });
        } else if (methodLower.includes('airtel')) {
          sAirtel += tot;
          txList.push({ id: ord.id, type: 'Completed Sale', method: 'Airtel Money', amount: tot, time: ord.orderDate, customer: ord.customer_name || 'Walk-in Customer', cashier: ord.performed_by || 'Cashier' });
        } else if (methodLower.includes('mtn')) {
          sMtn += tot;
          txList.push({ id: ord.id, type: 'Completed Sale', method: 'MTN Money', amount: tot, time: ord.orderDate, customer: ord.customer_name || 'Walk-in Customer', cashier: ord.performed_by || 'Cashier' });
        } else if (methodLower.includes('zamtel')) {
          sZamtel += tot;
          txList.push({ id: ord.id, type: 'Completed Sale', method: 'Zamtel Money', amount: tot, time: ord.orderDate, customer: ord.customer_name || 'Walk-in Customer', cashier: ord.performed_by || 'Cashier' });
        } else if (methodLower.includes('mobile') || methodLower.includes('momo') || methodLower.includes('wallet')) {
          sOtherMomo += tot;
          txList.push({ id: ord.id, type: 'Completed Sale', method: 'Mobile Wallet', amount: tot, time: ord.orderDate, customer: ord.customer_name || 'Walk-in Customer', cashier: ord.performed_by || 'Cashier' });
        } else if (methodLower.includes('card') || methodLower.includes('credit') || methodLower.includes('bank') || methodLower.includes('pos') || methodLower.includes('transfer')) {
          sCard += tot;
          txList.push({ id: ord.id, type: 'Completed Sale', method: 'Bank / Card', amount: tot, time: ord.orderDate, customer: ord.customer_name || 'Walk-in Customer', cashier: ord.performed_by || 'Cashier' });
        } else if (methodLower === 'split') {
          const legRes = runSql(`
            SELECT le.account_id, le.amount 
            FROM ledger_entries le
            JOIN transactions t ON le.transaction_id = t.id
            WHERE t.provider_reference = 'POS-REF-${ord.id}' AND le.type = 'DEBIT'
          `, 'EOD Split: Fetch split ledger entries');

          let splitCash = 0;
          let splitMomo = 0;
          if (legRes.success && Array.isArray(legRes.data) && legRes.data.length > 0) {
            legRes.data.forEach((le: any) => {
              if (le.account_id === 'cash-clearing-account-uuid') {
                splitCash += parseFloat(le.amount || 0);
              } else {
                splitMomo += parseFloat(le.amount || 0);
              }
            });
          } else {
            splitCash = tot / 2;
            splitMomo = tot / 2;
          }
          sCash += splitCash;
          sOtherMomo += splitMomo;
          txList.push({ 
            id: ord.id, 
            type: 'Completed Sale (Split)', 
            method: `Split (Cash: ${splitCash.toFixed(2)}, Mobile: ${splitMomo.toFixed(2)})`, 
            amount: tot, 
            time: ord.orderDate, 
            customer: ord.customer_name || 'Walk-in Customer',
            cashier: ord.performed_by || 'Cashier'
          });
        } else {
          sOther += tot;
          txList.push({ id: ord.id, type: 'Completed Sale', method: method, amount: tot, time: ord.orderDate, customer: ord.customer_name || 'Walk-in Customer', cashier: ord.performed_by || 'Cashier' });
        }
      });
    }

    // 4. Also include unsynced offline queue sales for that target date & store & cashier
    let savedQueue: OfflineOrder[] = [];
    try {
      const qData = localStorage.getItem('pos_offline_queue');
      savedQueue = qData ? JSON.parse(qData) : offlineQueue;
    } catch {
      savedQueue = offlineQueue || [];
    }

    if (Array.isArray(savedQueue)) {
      savedQueue.forEach((offOrd: OfflineOrder) => {
        if (processedTxIds.has(offOrd.orderId)) return;
        if (!isTargetDate(offOrd.dateStr)) return;
        if (!isTargetStore(offOrd.activeStore)) return;

        processedTxIds.add(offOrd.orderId);
        const method = String(offOrd.paymentMethod || 'Cash').trim();
        const methodLower = method.toLowerCase();
        const tot = parseFloat(offOrd.totalAmount as any || 0);

        if (methodLower === 'cash') {
          sCash += tot;
          txList.push({ id: offOrd.orderId, type: 'Completed Sale (Offline)', method: 'Cash', amount: tot, time: offOrd.dateStr, customer: 'Walk-in Customer', cashier: 'Cashier' });
        } else if (methodLower.includes('airtel')) {
          sAirtel += tot;
          txList.push({ id: offOrd.orderId, type: 'Completed Sale (Offline)', method: 'Airtel Money', amount: tot, time: offOrd.dateStr, customer: 'Walk-in Customer', cashier: 'Cashier' });
        } else if (methodLower.includes('mtn')) {
          sMtn += tot;
          txList.push({ id: offOrd.orderId, type: 'Completed Sale (Offline)', method: 'MTN Money', amount: tot, time: offOrd.dateStr, customer: 'Walk-in Customer', cashier: 'Cashier' });
        } else if (methodLower.includes('zamtel')) {
          sZamtel += tot;
          txList.push({ id: offOrd.orderId, type: 'Completed Sale (Offline)', method: 'Zamtel Money', amount: tot, time: offOrd.dateStr, customer: 'Walk-in Customer', cashier: 'Cashier' });
        } else if (methodLower.includes('mobile') || methodLower.includes('momo') || methodLower.includes('wallet')) {
          sOtherMomo += tot;
          txList.push({ id: offOrd.orderId, type: 'Completed Sale (Offline)', method: 'Mobile Wallet', amount: tot, time: offOrd.dateStr, customer: 'Walk-in Customer', cashier: 'Cashier' });
        } else if (methodLower.includes('card') || methodLower.includes('credit') || methodLower.includes('bank') || methodLower.includes('pos') || methodLower.includes('transfer')) {
          sCard += tot;
          txList.push({ id: offOrd.orderId, type: 'Completed Sale (Offline)', method: 'Bank / Card', amount: tot, time: offOrd.dateStr, customer: 'Walk-in Customer', cashier: 'Cashier' });
        } else {
          sOther += tot;
          txList.push({ id: offOrd.orderId, type: 'Completed Sale (Offline)', method: method, amount: tot, time: offOrd.dateStr, customer: 'Walk-in Customer', cashier: 'Cashier' });
        }
      });
    }

    // 5. Layby cash payments
    let lCash = 0;
    let lMomo = 0;
    let lCard = 0;

    if (laybyPaymentsRes.success && Array.isArray(laybyPaymentsRes.data)) {
      laybyPaymentsRes.data.forEach((inst: any) => {
        if (!isTargetDate(inst.created_at)) return;
        if (!isTargetCashier(inst.received_by)) return;

        const m = String(inst.payment_method || 'Cash').trim();
        const mLower = m.toLowerCase();
        const amt = parseFloat(inst.amount || 0);

        if (mLower === 'cash') {
          lCash += amt;
          txList.push({ id: inst.id, type: 'Layby Cash Payment', method: 'Cash', amount: amt, time: inst.created_at, customer: inst.customer_name || 'Layby Customer', cashier: inst.received_by || 'Cashier' });
        } else if (mLower.includes('mobile') || mLower.includes('momo') || mLower.includes('wallet') || mLower.includes('airtel') || mLower.includes('zamtel')) {
          lMomo += amt;
          txList.push({ id: inst.id, type: 'Layby Mobile Payment', method: 'Mobile Wallet', amount: amt, time: inst.created_at, customer: inst.customer_name || 'Layby Customer', cashier: inst.received_by || 'Cashier' });
        } else {
          lCard += amt;
          txList.push({ id: inst.id, type: 'Layby Bank/Card Payment', method: 'Bank / Card', amount: amt, time: inst.created_at, customer: inst.customer_name || 'Layby Customer', cashier: inst.received_by || 'Cashier' });
        }
      });
    }

    // 6. Cash out / Expenses
    let cExp = 0;
    if (expensesRes.success && Array.isArray(expensesRes.data)) {
      expensesRes.data.forEach((ex: any) => {
        if (!isTargetDate(ex.expense_date || ex.created_at)) return;
        if (!isTargetStore(ex.store_id)) return;
        if (!isTargetCashier(ex.performed_by)) return;

        cExp += parseFloat(ex.amount || 0);
      });
    }

    setSalesCashSum(sCash);
    setSalesAirtelSum(sAirtel);
    setSalesMtnSum(sMtn);
    setSalesZamtelSum(sZamtel);
    setSalesOtherMomoSum(sOtherMomo);
    setSalesCardSum(sCard);
    setSalesOtherSum(sOther);

    setLaybyCashSum(lCash);
    setLaybyMomoSum(lMomo);
    setLaybyCardSum(lCard);
    setCashExpensesSum(cExp);

    const totalSales = sCash + sAirtel + sMtn + sZamtel + sOtherMomo + sCard + sOther;
    const openFloat = parseFloat(openingCash) || 0;
    const expectedCashInDrawer = openFloat + sCash + lCash - cExp;

    setCashUpSummary({
      date: targetDate,
      store: targetStore,
      cashier: targetCashier,
      totalSales: totalSales,
      totalTxCount: txList.length,
      salesCash: sCash,
      salesAirtel: sAirtel,
      salesMtn: sMtn,
      salesZamtel: sZamtel,
      salesOtherMomo: sOtherMomo,
      salesCard: sCard,
      salesOther: sOther,
      laybyCash: lCash,
      laybyMomo: lMomo,
      laybyCard: lCard,
      cashExpenses: cExp,
      openingCash: openFloat,
      expectedCash: expectedCashInDrawer,
      todayTxList: txList,
    });

    // Reset inputs
    setCashCounted('');
    setCardCounted('');
    setMomoCounted('');
    setCashUpNotes('');
    setIsCashUpPosted(false);
    setIsSupervisorApproved(false);
    setSupervisorNameInput('');
    setSupervisorPasswordInput('');

    // Fetch registered supervisors/staff from database
    const staffRes = runSql('SELECT * FROM staff', 'EOD Cashup: Load supervisors list');
    if (staffRes.success && Array.isArray(staffRes.data)) {
      setSupervisors(staffRes.data);
      if (staffRes.data.length > 0) {
        setSupervisorNameInput(`${staffRes.data[0].first_name} ${staffRes.data[0].surname}`);
      }
    } else {
      setSupervisors([]);
    }

    setCashUpActiveTab('reconcile');
    setShowDenomHelper(false);
    setDenominations({
      '100': 0,
      '50': 0,
      '20': 0,
      '10': 0,
      '5': 0,
      '2': 0,
      '1': 0,
      '0.50': 0,
      '0.10': 0,
    });

    loadReconciliationHistory();
    if (shouldOpenModal) {
      setShowCashUpModal(true);
    }
  };

  // Listen for initial sales counter action routing from LaybysBoard or other parts
  useEffect(() => {
    if (initialAction) {
      if (initialAction === 'camera') {
        setIsCameraActive(true);
      } else if (initialAction === 'cashup') {
        handleTriggerCashUp(undefined, undefined, undefined, true);
      } else if (initialAction === 'refunds' || initialAction === 'history') {
        loadInvoices();
        setShowInvoiceHistoryModal(true);
      }
      onClearInitialAction?.();
    }
  }, [initialAction]);

  // Process and save reconciliation report to SQLite durable cash_ups database table
  const handlePostCashUp = () => {
    if (!isSupervisorApproved) {
      alert('🔒 Supervisor Gating: Shift closing reconciliation MUST be approved & signed-off by an authorized supervisor before closing the shift!');
      return;
    }

    const expectedCash = cashUpSummary ? cashUpSummary.expectedCash : ((parseFloat(openingCash) || 0) + salesCashSum + laybyCashSum - cashExpensesSum);
    const actualCash = parseFloat(cashCounted) || 0;
    const cashDiff = actualCash - expectedCash;

    const cashUpId = 'CSH-' + Math.random().toString(36).substr(2, 9).toUpperCase();
    const timestamp = new Date().toISOString();
    const fullNotes = `Date: ${cashUpDate} | Store: ${cashUpStore} | Cashier: ${cashUpCashier} | Approved by Supervisor: ${supervisorNameInput.trim()} | Notes: ${cashUpNotes}`;

    const insertSql = `
      INSERT INTO cash_ups VALUES (
        '${cashUpId}',
        '${cashUpDate}',
        '${cashUpStore}',
        'Cashier: ${cashUpCashier} (Approved: ${supervisorNameInput.trim().replace(/'/g, "''")})',
        ${expectedCash},
        ${actualCash},
        ${salesCardSum + laybyCardSum},
        ${parseFloat(cardCounted) || 0},
        ${salesAirtelSum + salesMtnSum + salesZamtelSum + salesOtherMomoSum + laybyMomoSum},
        ${parseFloat(momoCounted) || 0},
        ${cashDiff},
        '${fullNotes.replace(/'/g, "''")}',
        '${timestamp}'
      )
    `;

    const res = runSql(insertSql, `Reconciliation: Post completed end-of-day cash balance audit`);
    if (res.success) {
      setIsCashUpPosted(true);
      loadReconciliationHistory();
      setIsSupervisorApproved(false);
      setSupervisorNameInput('');
      setSupervisorPasswordInput('');
      alert(`✓ Daily Cash-Up Reconciled & Logged!\n\nID: ${cashUpId}\nDate: ${cashUpDate}\nExpected Cash: ${settings.currency}${expectedCash.toFixed(2)}\nActual Cash: ${settings.currency}${actualCash.toFixed(2)}\nDifference: ${settings.currency}${cashDiff.toFixed(2)}\nStatus: ${Math.abs(cashDiff) < 0.01 ? 'EXACT' : cashDiff < 0 ? 'SHORT' : 'OVER'}`);
      setShowCashUpModal(false);
    } else {
      alert(`Error posting cash-up report: ${res.error}`);
    }
  };

  const categories = ['All', ...Array.from(new Set(products.map(p => p.category)))];

  const filteredProducts = products.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(searchText.toLowerCase()) || p.sku.toLowerCase().includes(searchText.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || p.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const addToCart = (product: Product) => {
    if (!isShiftActive) {
      alert('🔒 Gated Action: Please open your active shift first by declaring the opening register drawer cash balance!');
      return;
    }
    const isService = product.is_service === 1;
    if (!isService && product.stock <= 0) {
      alert('Cannot add out-of-stock item!');
      return;
    }

    setCart(prevCart => {
      const existingIdx = prevCart.findIndex(item => item.product.id === product.id);
      if (existingIdx > -1) {
        const currentQty = prevCart[existingIdx].quantity;
        if (!isService && currentQty >= product.stock) {
          alert(`Maximum available branch stock is ${product.stock} units.`);
          return prevCart;
        }
        const updatedCart = [...prevCart];
        updatedCart[existingIdx].quantity += 1;
        return updatedCart;
      } else {
        return [...prevCart, { product, quantity: 1 }];
      }
    });
  };

  const updateQuantity = (productId: number, delta: number) => {
    const existingIdx = cart.findIndex(item => item.product.id === productId);
    if (existingIdx > -1) {
      const item = cart[existingIdx];
      const newQty = item.quantity + delta;
      const isService = item.product.is_service === 1;
      
      if (newQty <= 0) {
        setCart(cart.filter(i => i.product.id !== productId));
      } else {
        if (!isService && newQty > item.product.stock) {
          alert(`Insufficient branch stock. Maximum units available is ${item.product.stock}.`);
          return;
        }
        const updatedCart = [...cart];
        updatedCart[existingIdx].quantity = newQty;
        setCart(updatedCart);
      }
    }
  };

  const handleUpdateZraDetails = (tpin: string, connected: boolean, band: string) => {
    if (!selectedCustomer) return;
    const connectedInt = connected ? 1 : 0;
    const updateSql = `
      UPDATE customers 
      SET tpin = '${tpin.replace(/'/g, "''")}', 
          zra_connected = ${connectedInt}, 
          tax_band = '${band.replace(/'/g, "''")}' 
      WHERE id = ${selectedCustomer.id}
    `;
    const res = runSql(updateSql, `ZRA: Configure Smart Invoice settings for customer #${selectedCustomer.id}`);
    
    if (res.success) {
      // Re-fetch profiles
      const refreshedCustRes = runSql('SELECT * FROM customers', 'ZRA: Re-fetch customer listings');
      if (refreshedCustRes.success && Array.isArray(refreshedCustRes.data)) {
        setCustomers(refreshedCustRes.data);
        const updated = refreshedCustRes.data.find((c: any) => c.id === selectedCustomer.id);
        if (updated) {
          setSelectedCustomer(updated);
        }
      }
    }
  };

  const clearCart = () => {
    setCart([]);
    setSelectedCustomer(null);
    setDiscountValue(0);
  };

  // Calculations with dynamic ZRA tax band compliance
  const subtotal = cart.reduce((sum, item) => sum + (item.product.price * item.quantity), 0);
  const discountAmount = discountType === 'percent'
    ? subtotal * (discountValue / 100)
    : Math.min(discountValue, subtotal);
  const discountPercent = subtotal > 0 ? (discountAmount / subtotal) * 100 : 0;
  const preTax = subtotal - discountAmount;

  // Determine active tax rate based on ZRA connection status
  // Automated ZRA connection whenever customerTpin is completed (10 digits) or selected loyalist has it
  const isZraConnected = (selectedCustomer && selectedCustomer.zra_connected === 1) || (customerTpin && customerTpin.trim().length === 10);
  const currentTaxBandName = selectedCustomer?.tax_band || 'A - Standard Rate (16%)';
  let activeTaxRatePercentage = settings.taxRate; // fallback to general setting (15% etc)

  if (isZraConnected) {
    if (currentTaxBandName.includes('Zero-Rated') || currentTaxBandName.includes('Exempt') || currentTaxBandName.includes('Export')) {
      activeTaxRatePercentage = 0;
    } else {
      activeTaxRatePercentage = 16; // Standard ZRA Smart Invoice tax rate in Zambia
    }
  }

  const taxAmount = preTax * (activeTaxRatePercentage / 100);
  const totalAmount = preTax + taxAmount;

  const handleCheckoutInit = () => {
    if (!isShiftActive) {
      alert('🔒 Gated Action: Please open your active shift first by declaring the opening register drawer cash balance!');
      return;
    }
    if (cart.length === 0) return;

    setCheckoutStep('customer');
    setReceivedCash('');
    setShowPaymentModal(true);
  };

  const handleExecuteQuickSale = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isShiftActive) {
      alert('🔒 Gated Action: Please open your active shift first by declaring the opening register drawer cash balance!');
      return;
    }
    if (!quickSalespersonName.trim()) {
      alert('Accountability Gating: Please provide your name to log the transaction performer.');
      return;
    }
    if (!quickSelectedProduct) {
      alert('Selection Gating: No active product loaded. Search by name or scan barcode SKU.');
      return;
    }
    const qty = parseInt(quickSaleQty);
    if (isNaN(qty) || qty <= 0) {
      alert('Precision Gating: Positive integer quantity required.');
      return;
    }
    if (quickSelectedProduct.stock < qty) {
      alert(`Stock Gating Error: Mismatch on available warehouse levels.\nRequested: ${qty} units | Available in ${activeStore.toUpperCase()} branch: ${quickSelectedProduct.stock} units.`);
      return;
    }

    // Save salesperson name in cache
    localStorage.setItem('quick_salesperson_name', quickSalespersonName.trim());

    const orderId = 'TXN-QS-' + Math.floor(100000 + Math.random() * 900000);
    const dateStr = new Date().toISOString();
    const salesperson = quickSalespersonName.trim();

    const subtotalAmt = quickSelectedProduct.price * qty;
    const activeTaxRate = settings.taxRate;
    const taxAmountQS = subtotalAmt * (activeTaxRate / 100);
    const totalAmountQS = subtotalAmt + taxAmountQS;

    // If offline, store standard parameters in offlineQueue
    if (!isDeviceOnline) {
      const newOfflineQS: OfflineOrder = {
        orderId,
        customerId: null,
        items: [{ product: quickSelectedProduct, quantity: qty }],
        dateStr,
        subtotal: subtotalAmt,
        taxAmount: taxAmountQS,
        discountAmount: 0,
        totalAmount: totalAmountQS,
        paymentMethod: quickPaymentMethod,
        activeStore,
        salesperson,
        type: 'quicksale'
      };

      const updatedQueue = [...offlineQueue, newOfflineQS];
      setOfflineQueue(updatedQueue);
      localStorage.setItem('pos_offline_queue', JSON.stringify(updatedQueue));

      // Generate & Download POS Thermal receipt in offline mode
      try {
        const doc = new jsPDF({ format: [80, 150] });
        
        doc.setFont('times', 'bold');
        doc.setFontSize(10);
        doc.text(settings.storeName.toUpperCase(), 40, 10, { align: 'center' });
        doc.setFont('times', 'normal');
        doc.setFontSize(6);
        doc.text('LUSAKA / KITWE / NDOLA ENTERPRISE RETAIL HUB', 40, 14, { align: 'center' });
        
        doc.setLineWidth(0.1);
        doc.line(4, 16, 76, 16);
        
        doc.setFont('times', 'bold');
        doc.setFontSize(7);
        doc.text('SALESPERSON QUICK RECEIPT (OFFLINE)', 40, 20, { align: 'center' });
        
        doc.setFont('times', 'normal');
        doc.setFontSize(6);
        doc.text(`TICKET NO: ${orderId}`, 4, 25);
        doc.text(`BRANCH: ${activeStore.toUpperCase()}`, 4, 29);
        doc.text(`DATE/TIME: ${new Date(dateStr).toLocaleString()}`, 4, 33);
        doc.text(`SALESPERSON: ${salesperson.toUpperCase()}`, 4, 37);
        doc.text(`PAYMENT: ${quickPaymentMethod}`, 4, 41);
        
        doc.line(4, 43, 76, 43);
        
        doc.setFont('helvetica', 'bold');
        doc.text('ITEM DESCRIPTION', 4, 48);
        doc.text('QTY', 52, 48, { align: 'right' });
        doc.text('TOTAL', 76, 48, { align: 'right' });
        
        doc.setFont('helvetica', 'normal');
        const itemName = quickSelectedProduct.name.length > 25 ? quickSelectedProduct.name.substring(0, 22) + '...' : quickSelectedProduct.name;
        doc.text(`${itemName} (${quickSelectedProduct.sku})`, 4, 53);
        doc.text(`${qty}x ${settings.currency}${quickSelectedProduct.price.toFixed(2)}`, 4, 57);
        doc.text(`${qty}`, 52, 57, { align: 'right' });
        doc.text(`${settings.currency}${subtotalAmt.toFixed(2)}`, 76, 57, { align: 'right' });
        
        doc.line(4, 61, 76, 61);
        
        doc.text('Subtotal:', 52, 66, { align: 'right' });
        doc.text(`${settings.currency}${subtotalAmt.toFixed(2)}`, 76, 66, { align: 'right' });
        
        doc.text(`Zambia Standard VAT (${activeTaxRate}%):`, 52, 70, { align: 'right' });
        doc.text(`${settings.currency}${taxAmountQS.toFixed(2)}`, 76, 70, { align: 'right' });
        
        doc.setFont('helvetica', 'bold');
        doc.text('GRAND TOTAL AMOUNT:', 52, 75, { align: 'right' });
        doc.text(`${settings.currency}${totalAmountQS.toFixed(2)}`, 76, 75, { align: 'right' });
        
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(5);
        doc.text('⚠️ ISSUED IN HIGH-AVAILABILITY OFFLINE RESERVE', 40, 83, { align: 'center' });
        doc.text(settings.receiptFooter, 40, 86, { align: 'center' });
        
        exportAndSharePdf(`CHIPOSHA_QUICK_SALE_OFFLINE_${orderId}.pdf`, doc);
      } catch (pdfErr) {
        console.error('Failed generating quick sale offline PDF:', pdfErr);
      }

      alert(`✓ Quick Sale Offline Queued!\n\nTicket Ref: ${orderId}\nInvoice value: ${settings.currency}${totalAmountQS.toFixed(2)}\nSalesperson: ${salesperson}\n\nPDF Receipt has been generated & downloaded! It has been successfully saved to your local offline queue.`);

      setQuickSearchQuery('');
      setQuickSelectedProduct(null);
      setQuickSaleQty('1');
      setShowQuickSaleModal(false);
      persistTablesToStorage();
      return;
    }

    // 1. Post to Orders SQL with all 11 columns
    const orderInsertSql = `
      INSERT INTO orders (id, customerId, orderDate, subtotal, tax, discount, total, paymentMethod, status, store_id, performed_by) VALUES (
        '${orderId}', 
        NULL, 
        '${dateStr}', 
        ${subtotalAmt.toFixed(2)}, 
        ${taxAmountQS.toFixed(2)}, 
        0.00, 
        ${totalAmountQS.toFixed(2)}, 
        '${quickPaymentMethod}', 
        'Completed',
        '${activeStore}',
        '${salesperson.replace(/'/g, "''")}'
      )
    `;
    const resOrder = runSql(orderInsertSql, `Quick Sale: Logging cashier order header metadata`);
    loadInvoices();

    logEmployeeAudit('SALES', 'Completed Quick Sale', `Invoice #${orderId}, Item: ${quickSelectedProduct.name} x${qty}, Payment: ${quickPaymentMethod}`, totalAmountQS, activeStore, salesperson);

    if (resOrder.success) {
      // 2. Post line item
      const itemInsertSql = `
        INSERT INTO order_items VALUES (
          '${orderId}_item_1', 
          '${orderId}', 
          ${quickSelectedProduct.id}, 
          ${qty}, 
          ${quickSelectedProduct.price}
        )
      `;
      runSql(itemInsertSql, `Quick Sale: Logging cashier order items mapped metadata`);

      // 3. Decrease branch specific and catalog stock level
      runSql(`
        UPDATE store_products 
        SET stock = stock - ${qty} 
        WHERE product_id = ${quickSelectedProduct.id} AND store_id = '${activeStore}'
      `, `Quick Sale: Decrement stock units from ${activeStore.toUpperCase()}`);

      runSql(`
        UPDATE products
        SET stock = stock - ${qty}
        WHERE id = ${quickSelectedProduct.id}
      `, `Quick Sale: Decrement catalog stock`);

      // 4. Post Double-Entry Clearing and Asset Ledger records
      const txId = `tx_qs_${orderId.toLowerCase()}_${Math.floor(100 + Math.random() * 900)}`;
      const idempotencyKey = `idemp_${txId}`;
      const feeRate = quickPaymentMethod === 'Cash' ? 0.0 : 0.015;
      const feeAmount = parseFloat((totalAmountQS * feeRate).toFixed(4));
      const netSettlement = totalAmountQS - feeAmount;

      let clearingAccountId = 'cash-clearing-account-uuid';
      let targetAccountId = 'acc_cash';
      let channel = 'CASH';

      if (quickPaymentMethod === 'Mobile Wallet') {
        clearingAccountId = 'mtn-clearing-account-uuid';
        channel = 'MTN_MOMO';
        targetAccountId = 'acc_momo';
      } else if (quickPaymentMethod === 'Credit Card') {
        clearingAccountId = 'airtel-clearing-account-uuid';
        channel = 'CARD_VISA';
        targetAccountId = 'acc_bank';
      }

      runSql(`
        INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by)
        VALUES ('${txId}', '${idempotencyKey}', 'POS-${activeStore.toUpperCase()}-01', '${channel}', 'POS-REF-${orderId}', ${totalAmountQS.toFixed(4)}, ${feeAmount.toFixed(4)}, 'SUCCESS', 'Quick Sale #${orderId} - ${quickSelectedProduct.name.replace(/'/g, "''")} x${qty}', '${dateStr}', '${dateStr}', '${salesperson.replace(/'/g, "''")}')
      `, 'Quick Sale: Journal base transaction entry');

      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_deb', '${txId}', '${clearingAccountId}', 'DEBIT', ${totalAmountQS.toFixed(4)}, '${dateStr}')
      `, 'Quick Sale: Debit Clearing Asset account');

      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_asset', '${txId}', '${targetAccountId}', 'DEBIT', ${totalAmountQS.toFixed(4)}, '${dateStr}')
      `, `Quick Sale: Debit ${targetAccountId} Account`);

      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_cre_merch', '${txId}', 'merchant-wallet-account-uuid', 'CREDIT', ${netSettlement.toFixed(4)}, '${dateStr}')
      `, 'Quick Sale: Credit Merchant Wallet');

      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_rev', '${txId}', 'acc_sales_revenue', 'CREDIT', ${totalAmountQS.toFixed(4)}, '${dateStr}')
      `, 'Quick Sale: Credit Gross Sales Revenue');

      // Post COGS & Inventory decrement in ledger
      const unitCost = Number(quickSelectedProduct.cost || quickSelectedProduct.price * 0.7);
      const totalCogs = unitCost * qty;
      if (totalCogs > 0) {
        runSql(`
          INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
          VALUES ('le_${txId}_cogs', '${txId}', 'acc_cost_of_goods', 'DEBIT', ${totalCogs.toFixed(4)}, '${dateStr}')
        `, 'Quick Sale: Debit Cost of Goods Sold');

        runSql(`
          INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
          VALUES ('le_${txId}_inv', '${txId}', 'acc_inventory', 'CREDIT', ${totalCogs.toFixed(4)}, '${dateStr}')
        `, 'Quick Sale: Credit Inventory Asset Valuation');
      }

      // 5. Generate & Download PDF instantly
      try {
        const doc = new jsPDF({ format: [80, 150] }); // 80mm roll size format for point-of-sale thermal receipts
        
        doc.setFont('times', 'bold');
        doc.setFontSize(10);
        doc.text(settings.storeName.toUpperCase(), 40, 10, { align: 'center' });
        doc.setFont('times', 'normal');
        doc.setFontSize(6);
        doc.text('LUSAKA / KITWE / NDOLA ENTERPRISE RETAIL HUB', 40, 14, { align: 'center' });
        
        doc.setLineWidth(0.1);
        doc.line(4, 16, 76, 16);
        
        doc.setFont('times', 'bold');
        doc.setFontSize(7);
        doc.text('SALESPERSON QUICK RECEIPT', 40, 20, { align: 'center' });
        
        // Metadata fields
        doc.setFont('times', 'normal');
        doc.setFontSize(6);
        doc.text(`TICKET NO: ${orderId}`, 4, 25);
        doc.text(`BRANCH: ${activeStore.toUpperCase()}`, 4, 29);
        doc.text(`DATE/TIME: ${new Date(dateStr).toLocaleString()}`, 4, 33);
        doc.text(`SALESPERSON: ${salesperson.toUpperCase()}`, 4, 37);
        doc.text(`PAYMENT: ${quickPaymentMethod}`, 4, 41);
        
        doc.line(4, 43, 76, 43);
        
        // Item detail layout
        doc.setFont('helvetica', 'bold');
        doc.text('ITEM DESCRIPTION', 4, 48);
        doc.text('QTY', 52, 48, { align: 'right' });
        doc.text('TOTAL', 76, 48, { align: 'right' });
        
        doc.setFont('helvetica', 'normal');
        // Let's wrap name
        const itemName = quickSelectedProduct.name.length > 25 ? quickSelectedProduct.name.substring(0, 22) + '...' : quickSelectedProduct.name;
        doc.text(`${itemName} (${quickSelectedProduct.sku})`, 4, 53);
        doc.text(`${qty}x ${settings.currency}${quickSelectedProduct.price.toFixed(2)}`, 4, 57);
        doc.text(`${qty}`, 52, 57, { align: 'right' });
        doc.text(`${settings.currency}${subtotalAmt.toFixed(2)}`, 76, 57, { align: 'right' });
        
        doc.line(4, 61, 76, 61);
        
        // Math blocks
        doc.text('Subtotal:', 52, 66, { align: 'right' });
        doc.text(`${settings.currency}${subtotalAmt.toFixed(2)}`, 76, 66, { align: 'right' });
        
        doc.text(`Zambia Standard VAT (${activeTaxRate}%):`, 52, 70, { align: 'right' });
        doc.text(`${settings.currency}${taxAmountQS.toFixed(2)}`, 76, 70, { align: 'right' });
        
        doc.setFont('helvetica', 'bold');
        doc.text('GRAND TOTAL AMOUNT:', 52, 75, { align: 'right' });
        doc.text(`${settings.currency}${totalAmountQS.toFixed(2)}`, 76, 75, { align: 'right' });
        
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(5);
        doc.text('Double-Entry Pos System Checked', 40, 83, { align: 'center' });
        doc.text(settings.receiptFooter, 40, 86, { align: 'center' });
        
        exportAndSharePdf(`CHIPOSHA_QUICK_SALE_${orderId}.pdf`, doc);
      } catch (pdfErr) {
        console.error('Failed generating quick sale PDF:', pdfErr);
      }

      // Try to run automated credit sweep
      let sweepMessage = '';
      try {
        const sweepRes = triggerLoanSweep(orderId, totalAmountQS);
        if (sweepRes.status === 'SUCCESS' && sweepRes.deducted > 0) {
          sweepMessage = `\n\n⚡ Automated Loan Sweep:\nDeduced ${settings.currency}${sweepRes.deducted.toFixed(2)} (${settings.currency}${totalAmountQS.toFixed(2)} * percentage) automatically applied towards Loan ${sweepRes.loanId}.`;
        }
      } catch (sweepErr) {
        console.error('Sweep processing failed:', sweepErr);
      }

      // 5. Notify inside local session
      alert(`✓ Quick Sale Confirmed Successfully!\n\nTicket Ref: ${orderId}\nInvoice value: ${settings.currency}${totalAmountQS.toFixed(2)}\nSalesperson: ${salesperson}\n\nPDF Receipt has been generated & downloaded!${sweepMessage}`);

      // 6. Reset states and refresh
      setQuickSearchQuery('');
      setQuickSelectedProduct(null);
      setQuickSaleQty('1');
      setShowQuickSaleModal(false);
      onCartCheckedOut();
      refreshDbData();
      loadInvoices();
      handleTriggerCashUp();
      try {
        window.dispatchEvent(new CustomEvent('pos_sale_completed', {
          detail: { orderId, totalAmount: totalAmountQS, paymentMethod: quickPaymentMethod, store_id: activeStore }
        }));
        window.dispatchEvent(new Event('pos_data_updated'));
        window.dispatchEvent(new Event('storage'));
      } catch (evErr) {
        console.warn('Event dispatch failed:', evErr);
      }
      persistTablesToStorage();
    } else {
      alert('Committing Error: Failed to write database entries for active ticket.');
    }
  };

  const handleCompletePayment = () => {
    const orderId = 'TXN-' + Math.floor(1000 + Math.random() * 9000);
    const dateStr = new Date().toISOString();

    // Resolve dynamic customer auto-save & central CRM synchronization on checkout!
    let activeCustomerId: number | 'NULL' = 'NULL';
    let localSavedCustomer = selectedCustomer;

    const currentCustomerName = selectedCustomer ? selectedCustomer.name : customerName.trim();
    if (currentCustomerName) {
      const awardPts = Math.floor(totalAmount * settings.loyaltyRatio);
      const synced = upsertCustomerSync({
        name: currentCustomerName,
        phone: selectedCustomer ? selectedCustomer.phone : customerPhone.trim(),
        email: selectedCustomer ? selectedCustomer.email : customerAddress.trim(),
        tpin: selectedCustomer ? selectedCustomer.tpin : customerTpin.trim(),
        loyalPointsDelta: awardPts
      });
      if (synced) {
        activeCustomerId = synced.id;
        localSavedCustomer = synced;
        // Refresh customer list in state
        const custResult = runSql('SELECT * FROM customers ORDER BY name ASC', 'Register: Refresh customer list during checkout');
        if (custResult.success && Array.isArray(custResult.data)) {
          setCustomers(custResult.data);
        }
      }
    }

    const customerIdVal = activeCustomerId;
    
    const receiptCustomer = {
      name: customerName.trim() || 'General Walk-in Client',
      phone: customerPhone.trim() || 'N/A',
      tpin: customerTpin.trim() || 'N/A',
      address: customerAddress.trim() || 'N/A',
    };

    // If offline, store standard parameters in offlineQueue
    if (!isDeviceOnline) {
      const newOfflineStd: OfflineOrder = {
        orderId,
        customerId: selectedCustomer ? selectedCustomer.id : null,
        items: [...cart],
        dateStr,
        subtotal,
        taxAmount,
        discountAmount,
        totalAmount,
        paymentMethod,
        activeStore,
        salesperson: localStorage.getItem('logged_in_user_name') || 'Default Cashier',
        type: 'standard'
      };

      const updatedQueue = [...offlineQueue, newOfflineStd];
      setOfflineQueue(updatedQueue);
      localStorage.setItem('pos_offline_queue', JSON.stringify(updatedQueue));

      setActiveReceipt({
        id: orderId,
        date: new Date(dateStr).toLocaleString(),
        paymentMethod,
        subtotal,
        tax: taxAmount,
        taxRate: settings.taxRate,
        discount: discountAmount,
        total: totalAmount,
        cashReceived: paymentMethod === 'Cash' 
          ? (parseFloat(receivedCash) || 0) 
          : (paymentMethod === 'Split' ? (parseFloat(splitCashAmount) || 0) : totalAmount),
        change: paymentMethod === 'Cash' 
          ? Math.max(0, (parseFloat(receivedCash) || 0) - totalAmount) 
          : (paymentMethod === 'Split'
            ? Math.max(0, ((parseFloat(splitCashAmount) || 0) + (parseFloat(splitMobileAmount) || 0)) - totalAmount)
            : 0),
        splitBreakdown: paymentMethod === 'Split' ? {
          cash: parseFloat(splitCashAmount) || 0,
          mobile: parseFloat(splitMobileAmount) || 0
        } : null,
        customer: receiptCustomer,
        items: [...cart],
        offlinePending: true
      });

      alert(`✓ [OFFLINE SAVED] Standard Order ${orderId} Saved Offline!\n\nThis transaction has been successfully queued due to a connectivity drop. Once connection is restored, we will synchronize the ledger entries, update central inventory, and co-sign loan sweeps.`);

      setCart([]);
      setSelectedCustomer(null);
      setCustomerName('');
      setCustomerPhone('');
      setCustomerTpin('');
      setCustomerAddress('');
      setDiscountValue(0);
      setShowPaymentModal(false);
      onCartCheckedOut();
      refreshDbData();
      loadInvoices();
      handleTriggerCashUp();
      persistTablesToStorage();
      return;
    }

    // 1. Insert order details to Orders SQL Database with store identifier
    const orderInsertSql = `
      INSERT INTO orders (id, customerId, orderDate, subtotal, tax, discount, total, paymentMethod, status, store_id, performed_by) VALUES (
        '${orderId}', 
        ${customerIdVal}, 
        '${dateStr}', 
        ${subtotal.toFixed(2)}, 
        ${taxAmount.toFixed(2)}, 
        ${discountAmount.toFixed(2)}, 
        ${totalAmount.toFixed(2)}, 
        '${paymentMethod}', 
        'Completed',
        '${activeStore}',
        '${(localStorage.getItem('logged_in_user_name') || 'Default Cashier').replace(/'/g, "''")}'
      )
    `;
    runSql(orderInsertSql, `Billing: Post order ticket details to SQLite for store ${activeStore.toUpperCase()}`);
    loadInvoices();

    logEmployeeAudit('SALES', 'Completed POS Cart Sale', `Invoice #${orderId}, Items: ${cart.length}, Customer: ${selectedCustomer ? selectedCustomer.name : 'Walk-in'}, Payment: ${paymentMethod}`, totalAmount, activeStore);

    // 2. Insert items and decrement branch specific stock layers!
    cart.forEach((item, index) => {
      const orderItemId = `${orderId}_${index + 1}`;
      const itemInsertSql = `
        INSERT INTO order_items VALUES (
          '${orderItemId}', 
          '${orderId}', 
          ${item.product.id}, 
          ${item.quantity}, 
          ${item.product.price}
        )
      `;
      runSql(itemInsertSql, `Billing: Post sales transaction lines`);

      // Decrement the physical stock specifically inside that branch's store_products ledger if not a service!
      if (item.product.is_service !== 1) {
        const checkOverride = runSql(`SELECT * FROM store_products WHERE product_id = ${item.product.id} AND store_id = '${activeStore}'`, 'Verify location state');
        
        if (checkOverride.success && Array.isArray(checkOverride.data) && checkOverride.data.length > 0) {
          runSql(`
            UPDATE store_products 
            SET stock = stock - ${item.quantity} 
            WHERE product_id = ${item.product.id} AND store_id = '${activeStore}'
          `, `Inventory: Demobilize -${item.quantity} units from branch ${activeStore}`);
        } else {
          // Fallback or create row
          const spId = `sp_${item.product.id}_${activeStore}`;
          runSql(`
            INSERT INTO store_products VALUES (
              '${spId}',
              ${item.product.id},
              '${activeStore}',
              ${item.product.stock - item.quantity},
              ${item.product.price}
            )
          `, `Inventory: Provision missing branch rows`);
        }

        // Decrement the global products baseline catalog stock to maintain parity
        runSql(`UPDATE products SET stock = stock - ${item.quantity} WHERE id = ${item.product.id}`, 'Inventory: Sync fallback totals');
      }
    });

    // 3. SECURE DOUBLE-ENTRY CLEARING ENTRY & ASSET POSTINGS
    const txId = `tx_${orderId.toLowerCase()}_${Math.floor(100 + Math.random() * 900)}`;
    const idempotencyKey = `idemp_${txId}`;

    if (paymentMethod === 'Split') {
      const splitCashVal = parseFloat(splitCashAmount) || 0;
      const splitMobileVal = parseFloat(splitMobileAmount) || 0;
      const totalSplitPaid = splitCashVal + splitMobileVal;
      const changeAmt = Math.max(0, totalSplitPaid - totalAmount);
      const actualCashKept = Math.max(0, splitCashVal - changeAmt);
      const calculatedMobileFee = parseFloat((splitMobileVal * 0.015).toFixed(4));
      const netSettlement = totalAmount - calculatedMobileFee;

      runSql(`
        INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by)
        VALUES ('${txId}', '${idempotencyKey}', 'POS-${activeStore.toUpperCase()}-01', 'SPLIT_CASH_MOBILE', 'POS-REF-${orderId}', ${totalAmount.toFixed(4)}, ${calculatedMobileFee.toFixed(4)}, 'SUCCESS', 'POS Branch ${activeStore.toUpperCase()} order Split Checkout #${orderId}', '${dateStr}', '${dateStr}', '${(localStorage.getItem('logged_in_user_name') || 'Default Cashier').replace(/'/g, "''")}')
      `, 'Double Entry: Journal base transaction entry for split');

      if (actualCashKept > 0) {
        runSql(`
          INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
          VALUES ('le_${txId}_deb_cash', '${txId}', 'cash-clearing-account-uuid', 'DEBIT', ${actualCashKept.toFixed(4)}, '${dateStr}')
        `, 'Double Entry: Debit Cash Clearing Asset account (Split)');

        runSql(`
          INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
          VALUES ('le_${txId}_cash_asset', '${txId}', 'acc_cash', 'DEBIT', ${actualCashKept.toFixed(4)}, '${dateStr}')
        `, 'Double Entry: Debit Counter Cash Drawer (Split)');
      }

      if (splitMobileVal > 0) {
        const clearingAccountId = Math.random() > 0.5 ? 'mtn-clearing-account-uuid' : 'airtel-clearing-account-uuid';
        runSql(`
          INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
          VALUES ('le_${txId}_deb_momo', '${txId}', '${clearingAccountId}', 'DEBIT', ${splitMobileVal.toFixed(4)}, '${dateStr}')
        `, 'Double Entry: Debit Mobile Money Clearing Asset account (Split)');

        runSql(`
          INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
          VALUES ('le_${txId}_momo_asset', '${txId}', 'acc_momo', 'DEBIT', ${splitMobileVal.toFixed(4)}, '${dateStr}')
        `, 'Double Entry: Debit Mobile Wallet Account (Split)');
      }

      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_cre_merch', '${txId}', 'merchant-wallet-account-uuid', 'CREDIT', ${netSettlement.toFixed(4)}, '${dateStr}')
      `, 'Double Entry: Credit Merchant Wallet (Split Combined)');

      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_rev', '${txId}', 'acc_sales_revenue', 'CREDIT', ${totalAmount.toFixed(4)}, '${dateStr}')
      `, 'Double Entry: Credit Gross Sales Revenue');

    } else {
      const calculatedFeeRate = paymentMethod === 'Cash' ? 0.0 : 0.015;
      const feeAmount = parseFloat((totalAmount * calculatedFeeRate).toFixed(4));
      const netSettlement = totalAmount - feeAmount;

      let clearingAccountId = 'cash-clearing-account-uuid';
      let targetAccountId = 'acc_cash';
      let channel = 'CASH';

      if (paymentMethod === 'Mobile Wallet') {
        clearingAccountId = Math.random() > 0.5 ? 'mtn-clearing-account-uuid' : 'airtel-clearing-account-uuid';
        channel = clearingAccountId === 'mtn-clearing-account-uuid' ? 'MTN_MOMO' : 'AIRTEL_MONEY';
        targetAccountId = 'acc_momo';
      } else if (paymentMethod === 'Credit Card') {
        clearingAccountId = 'airtel-clearing-account-uuid';
        channel = 'CARD_VISA';
        targetAccountId = 'acc_bank';
      }

      runSql(`
        INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, performed_by)
        VALUES ('${txId}', '${idempotencyKey}', 'POS-${activeStore.toUpperCase()}-01', '${channel}', 'POS-REF-${orderId}', ${totalAmount.toFixed(4)}, ${feeAmount.toFixed(4)}, 'SUCCESS', 'POS Branch ${activeStore.toUpperCase()} order Checkout #${orderId}', '${dateStr}', '${dateStr}', '${(localStorage.getItem('logged_in_user_name') || 'Default Cashier').replace(/'/g, "''")}')
      `, 'Double Entry: Journal base transaction entry');

      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_deb', '${txId}', '${clearingAccountId}', 'DEBIT', ${totalAmount.toFixed(4)}, '${dateStr}')
      `, 'Double Entry: Debit Clearing Asset account');

      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_asset', '${txId}', '${targetAccountId}', 'DEBIT', ${totalAmount.toFixed(4)}, '${dateStr}')
      `, `Double Entry: Debit ${targetAccountId} Account`);

      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_cre_merch', '${txId}', 'merchant-wallet-account-uuid', 'CREDIT', ${netSettlement.toFixed(4)}, '${dateStr}')
      `, 'Double Entry: Credit Merchant Wallet');

      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_rev', '${txId}', 'acc_sales_revenue', 'CREDIT', ${totalAmount.toFixed(4)}, '${dateStr}')
      `, 'Double Entry: Credit Gross Sales Revenue');
    }

    // Post COGS and adjust Inventory Asset balance
    const totalCogs = cart.reduce((sum, item) => {
      const unitCost = Number(item.product.cost || item.product.price * 0.7);
      return sum + (unitCost * item.quantity);
    }, 0);

    if (totalCogs > 0) {
      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_cogs', '${txId}', 'acc_cost_of_goods', 'DEBIT', ${totalCogs.toFixed(4)}, '${dateStr}')
      `, 'Double Entry: Debit Cost of Goods Sold');

      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_inv', '${txId}', 'acc_inventory', 'CREDIT', ${totalCogs.toFixed(4)}, '${dateStr}')
      `, 'Double Entry: Credit Inventory Asset Valuation');
    }

    if (selectedCustomer) {
      const awardPts = Math.floor(totalAmount * settings.loyaltyRatio);
      if (awardPts > 0) {
        runSql(`UPDATE customers SET loyalPoints = loyalPoints + ${awardPts} WHERE id = ${selectedCustomer.id}`, 'Loyalty: Accrue pts');
      }
    }

    // Try to run automated credit sweep
    let sweepMessage = '';
    try {
      const sweepRes = triggerLoanSweep(orderId, totalAmount);
      if (sweepRes.status === 'SUCCESS' && sweepRes.deducted > 0) {
        sweepMessage = `\n\n⚡ Automated Loan Sweep:\nDeduced ${settings.currency}${sweepRes.deducted.toFixed(2)} (${settings.currency}${totalAmount.toFixed(2)} * percentage) automatically applied towards Loan ${sweepRes.loanId}.`;
        
        // Post double-entry ledger entry for financing payment
        const sweepTxId = `tx_sweep_${orderId.toLowerCase()}_${Math.floor(100 + Math.random() * 900)}`;
        const sweepIdemp = `idemp_${sweepTxId}`;
        runSql(`
          INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at)
          VALUES ('${sweepTxId}', '${sweepIdemp}', 'POS-${activeStore.toUpperCase()}-01', 'SWEEP_DEDUCTION', 'SWEEP-REF-${orderId}', ${sweepRes.deducted.toFixed(4)}, 0.0000, 'SUCCESS', 'Automated revenue deduction for active capital advance repayment #${orderId}', '${dateStr}', '${dateStr}')
        `, 'Double Entry: Sweep deduction capital advance ticket log');
        
        runSql(`
          INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
          VALUES ('le_${sweepTxId}_deb', '${sweepTxId}', 'merchant-wallet-account-uuid', 'DEBIT', ${sweepRes.deducted.toFixed(4)}, '${dateStr}')
        `, 'Double Entry: Debit Merchant Wallet (Outward Sweep)');
        
        runSql(`
          INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
          VALUES ('le_${sweepTxId}_cre', '${sweepTxId}', 'loan-clearing-account-uuid', 'CREDIT', ${sweepRes.deducted.toFixed(4)}, '${dateStr}')
        `, 'Double Entry: Credit Loan Asset Account (Repayment settled)');
      }
    } catch (sweepErr) {
      console.error('Sweep processing failed:', sweepErr);
    }

    if (sweepMessage) {
      alert(`✓ Order ${orderId} Checkout Successful!${sweepMessage}`);
    }

    // Capture receipt details with ZRA Fiscal parameters
    setActiveReceipt({
      id: orderId,
      date: new Date(dateStr).toLocaleString(),
      paymentMethod,
      subtotal,
      tax: taxAmount,
      taxRate: isZraConnected ? activeTaxRatePercentage : settings.taxRate,
      discount: discountAmount,
      total: totalAmount,
      cashReceived: paymentMethod === 'Cash' 
        ? (parseFloat(receivedCash) || 0) 
        : (paymentMethod === 'Split' ? (parseFloat(splitCashAmount) || 0) : totalAmount),
      change: paymentMethod === 'Cash' 
        ? Math.max(0, (parseFloat(receivedCash) || 0) - totalAmount) 
        : (paymentMethod === 'Split'
          ? Math.max(0, ((parseFloat(splitCashAmount) || 0) + (parseFloat(splitMobileAmount) || 0)) - totalAmount)
          : 0),
      splitBreakdown: paymentMethod === 'Split' ? {
        cash: parseFloat(splitCashAmount) || 0,
        mobile: parseFloat(splitMobileAmount) || 0
      } : null,
      customer: receiptCustomer,
      items: [...cart],
      zra: isZraConnected ? {
        tpin: customerTpin || '1001122334',
        taxBand: currentTaxBandName,
        fiscalCode: 'ESD-' + Math.floor(10000000 + Math.random() * 90000000) + '-' + Math.floor(1000 + Math.random() * 9000),
        qrUrl: `https://www.zra.org.zm/verify?invoice=${orderId}&tpin=${customerTpin}&amount=${totalAmount.toFixed(2)}`
      } : null
    });

    if (receiptCustomer.phone && receiptCustomer.phone !== 'N/A') {
      setWhatsappPhone(receiptCustomer.phone);
    } else {
      setWhatsappPhone('');
    }

    setCart([]);
    setSelectedCustomer(null);
    setCustomerName('');
    setCustomerPhone('');
    setCustomerTpin('');
    setCustomerAddress('');
    setDiscountValue(0);
    setReceivedCash('');
    setSplitCashAmount('');
    setSplitMobileAmount('');
    setCheckoutStep('success');
    onCartCheckedOut();
    refreshDbData();
    loadInvoices();
    handleTriggerCashUp();
    const activeCashier = localStorage.getItem('logged_in_user_name') || 'Default Cashier';
    try {
      window.dispatchEvent(new CustomEvent('pos_sale_completed', {
        detail: { orderId, totalAmount, paymentMethod, store_id: activeStore, performed_by: activeCashier }
      }));
      window.dispatchEvent(new Event('pos_data_updated'));
      window.dispatchEvent(new Event('storage'));
    } catch (evErr) {
      console.warn('Event dispatch failed:', evErr);
    }
    persistTablesToStorage();
  };

  return (
    <div className="flex-1 flex overflow-hidden flex-col bg-slate-50 relative min-w-0 h-full">
      {/* MOBILE NAV TABS */}
      {isShiftActive && (
        <div className="md:hidden flex bg-white border-b border-slate-200 p-2 gap-1.5 shrink-0 select-none">
          <button
            type="button"
            onClick={() => setActiveMobileTab('catalog')}
            className={`flex-1 min-h-[48px] text-xs font-black rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer ${
              activeMobileTab === 'catalog'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>🛍️</span>
            <span>CATALOG GRID</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveMobileTab('basket')}
            className={`flex-1 min-h-[48px] text-xs font-black rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer relative ${
              activeMobileTab === 'basket'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>🛒</span>
            <span>BASKET</span>
            <span className="bg-indigo-600 text-white font-mono font-bold text-[9px] px-1.5 py-0.5 rounded-full ml-1">
              {cart.reduce((sum, item) => sum + item.quantity, 0)}
            </span>
          </button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden flex-col md:flex-row relative min-w-0">
        
        {/* LEFT COLUMN: ACTIVE SALE SHEET */}
        <div className={`w-full flex-col overflow-hidden border-b md:border-b-0 md:border-r border-slate-200 ${
          !isShiftActive 
            ? 'flex-1 h-auto flex' 
            : activeMobileTab === 'catalog' 
              ? 'flex-1 h-full md:w-[60%] md:flex bg-slate-50' 
              : 'hidden md:w-[60%] md:flex md:h-auto bg-slate-50'
        }`}>
        
        {/* Connectivity & Offline Sync Status Ribbon */}
        <div id="offline-network-banner" className={`px-4 py-2 border-b flex flex-wrap items-center justify-between gap-2 text-xs font-bold leading-none transition-all duration-300 select-none ${
          isDeviceOnline 
            ? 'bg-emerald-50 text-emerald-800 border-emerald-100' 
            : 'bg-amber-50 text-amber-900 border-amber-200'
        }`}>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isDeviceOnline ? 'bg-emerald-400' : 'bg-amber-500'}`}></span>
              <span className={`relative inline-flex rounded-full h-2 w-2 ${isDeviceOnline ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
            </span>
            <span className="uppercase tracking-wider font-extrabold text-[10px]">
              POS Mode: {isDeviceOnline ? 'Cloud Synced (Online)' : 'High-Availability Offline Reserve (Disconnected)'}
            </span>
            {isDeviceOnline ? (
              <span className="hidden sm:flex items-center gap-1 text-[8.5px] bg-emerald-150 border border-emerald-300 text-emerald-950 font-mono font-black px-1.5 py-0.5 rounded-full select-none" title="All cloud sync operations are strictly protected by standard TLS 1.3/SSL encryption over public networks">
                <ShieldCheck size={10} className="text-emerald-700 shrink-0" />
                TLS v1.3 SECURED
              </span>
            ) : (
              <span className="hidden sm:flex items-center gap-1 text-[8.5px] bg-amber-100 border border-amber-300 text-amber-900 font-mono font-black px-1.5 py-0.5 rounded-full select-none" title="All operations run inside your safe in-memory SQL sandbox. Upon reconnect, synced data will stream over secure SSL/TLS.">
                🔒 LOCAL SANDBOX
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {offlineQueue.length > 0 && (
              <span className="bg-amber-200 border border-amber-300 text-amber-950 font-mono text-[9px] px-2 py-0.5 rounded-full select-none">
                {offlineQueue.length} PENDING SYNC
              </span>
            )}
          </div>
        </div>

        {!isShiftActive ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 bg-slate-50 text-center select-none font-sans min-h-[450px]">
            <div className="bg-white border p-8 rounded-3xl shadow-sm w-full max-w-sm flex flex-col gap-4 text-slate-800">
              <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center mx-auto shadow-xs">
                <Lock size={22} className="animate-pulse text-indigo-600" />
              </div>
              
              <div>
                <h3 className="text-sm font-extrabold text-slate-900 uppercase tracking-wide">Pre-Shift Login & Activation</h3>
                <p className="text-[11px] text-slate-500 mt-1">
                  Security authorization required. Sign into your terminal account, select your assigned branch, and declare starting cash to open shift.
                </p>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const targetEmail = loginEmail.trim();
                  const targetPassword = loginPassword.trim();
                  const amt = parseFloat(inputOpeningCash.trim());

                  if (!targetEmail || !targetPassword) {
                    alert('Please enter your login username (email) and password.');
                    return;
                  }

                  if (isNaN(amt) || amt < 0) {
                    alert('Invalid Balance: Please input a correct positive opening register cash value.');
                    return;
                  }

                  // 1. Authenticate user
                  let authenticatedUser = null;
                  let userRoleFound = 'sales';
                  let userFullName = 'Default Cashier';

                  // Search businesses (owners) via robust JavaScript search
                  const bizRes = runSql('SELECT * FROM businesses', 'Auth: Retrieve businesses');
                  if (bizRes.success && Array.isArray(bizRes.data)) {
                    const matchBiz = bizRes.data.find(b => b.email && b.email.trim().toLowerCase() === targetEmail.toLowerCase());
                    if (matchBiz && matchBiz.password === targetPassword) {
                      authenticatedUser = matchBiz;
                      userRoleFound = 'owner';
                      userFullName = matchBiz.owner || 'Business Owner';
                    }
                  }

                  // Search staff members via robust JavaScript search
                  if (!authenticatedUser) {
                    const staffRes = runSql('SELECT * FROM staff', 'Auth: Retrieve staff');
                    if (staffRes.success && Array.isArray(staffRes.data)) {
                      const matchStaff = staffRes.data.find(s => s.email && s.email.trim().toLowerCase() === targetEmail.toLowerCase());
                      if (matchStaff) {
                        let parsedPerms: any = {};
                        try {
                          if (matchStaff.permissions_json) {
                            parsedPerms = JSON.parse(matchStaff.permissions_json);
                          }
                        } catch (e) {
                          console.error('Error parsing permissions json', e);
                        }

                        // Determine valid password: check custom password inside perms, or falls back to 'staff123' or surname
                        const customPass = parsedPerms.password;
                        const isPasswordValid = customPass 
                          ? targetPassword === customPass
                          : (targetPassword === 'staff123' || targetPassword.toLowerCase() === matchStaff.surname.toLowerCase());

                        if (isPasswordValid) {
                          // Validate accessible branches restrictions!
                          const branches = parsedPerms.accessible_branches;
                          if (Array.isArray(branches) && branches.length > 0) {
                            if (!branches.includes(selectedLoginStore)) {
                              // Retrieve human-friendly store names for visual alert
                              const storeNamesStr = branches.join(', ').toUpperCase();
                              alert(`Access Denied: Your staff account is not authorized to access this branch (${selectedLoginStore.toUpperCase()}).\n\nAuthorized Branch Access: [${storeNamesStr}]`);
                              return;
                            }
                          }

                          authenticatedUser = matchStaff;
                          userFullName = `${matchStaff.first_name} ${matchStaff.surname}`;
                          
                          // Set userRole: check permission-based role override, else falls back to salary logic
                          if (parsedPerms.role) {
                            userRoleFound = parsedPerms.role;
                          } else if (matchStaff.email.toLowerCase().includes('chintu') || parseFloat(matchStaff.basic_salary) > 10000) {
                            userRoleFound = 'manager';
                          } else {
                            userRoleFound = 'sales';
                          }
                        }
                      }
                    }
                  }

                  if (!authenticatedUser) {
                    alert('Authentication Failed: Invalid Email or Password. Please try again.');
                    return;
                  }

                  // 2. Clear previous active shift and open the selected store's shift
                  localStorage.setItem('pos_shift_active', 'true');
                  localStorage.setItem('shift_active_' + selectedLoginStore, 'true');
                  localStorage.setItem('shift_active_' + activeStore, 'true');
                  if (Array.isArray(loginStores)) {
                    loginStores.forEach(st => {
                      if (st && st.id) {
                        localStorage.setItem('shift_active_' + st.id, 'true');
                        localStorage.setItem('shift_opening_cash_' + st.id, amt.toFixed(2));
                      }
                    });
                  }
                  localStorage.setItem('shift_opening_cash_' + selectedLoginStore, amt.toFixed(2));
                  localStorage.setItem('shift_opening_cash_' + activeStore, amt.toFixed(2));
                  localStorage.setItem('shift_opening_cash_global', amt.toFixed(2));
                  localStorage.setItem('quick_salesperson_name', userFullName);
                  localStorage.setItem('logged_in_user_email', targetEmail);
                  localStorage.setItem('logged_in_user_name', userFullName);

                  // 3. Callback props to update main App state dynamically!
                  onStoreChange?.(selectedLoginStore);
                  onUserRoleChange?.(userRoleFound);

                  // 4. Update local states
                  setIsShiftActive(true);
                  setOpeningCash(amt.toFixed(2));
                  setQuickSalespersonName(userFullName);
                  setLoginEmail('');
                  setLoginPassword('');
                  setInputOpeningCash('');

                  alert(`✓ Access Granted! Welcome ${userFullName}.\n\nYour shift has been successfully started for branch: ${selectedLoginStore.toUpperCase()}.`);
                }}
                className="flex flex-col gap-3 text-left"
              >
                {/* Email / Username field */}
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider font-mono">Username / Email Address</label>
                  <div className="relative">
                    <User size={13} className="absolute left-3 top-2.5 text-slate-400" />
                    <input
                      required
                      type="email"
                      placeholder="e.g. lombe@pos.zm"
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-xs font-semibold outline-hidden transition-all text-slate-800"
                    />
                  </div>
                </div>

                {/* Password field */}
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider font-mono">Security Password</label>
                  <div className="relative">
                    <Key size={13} className="absolute left-3 top-2.5 text-slate-400" />
                    <input
                      required
                      type="password"
                      placeholder="••••••••"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-xs font-mono outline-hidden transition-all text-slate-800"
                    />
                  </div>
                </div>

                {/* Store selection dropdown */}
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider font-mono">Location Store Branch</label>
                  <div className="relative">
                    <Building2 size={13} className="absolute left-3 top-2.5 text-slate-400" />
                    <select
                      value={selectedLoginStore}
                      onChange={(e) => setSelectedLoginStore(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-xs font-bold outline-hidden transition-all text-slate-800 select-none cursor-pointer uppercase tracking-wider font-mono"
                    >
                      {loginStores.map(store => (
                        <option key={store.id} value={store.id}>{store.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Opening cash balance field */}
                <div className="flex flex-col gap-1 border-t border-slate-100 pt-3">
                  <label className="text-[10px] font-black text-rose-500 uppercase tracking-wider font-sans flex items-center gap-1">
                    <Coins size={11} />
                    <span>Opening Cash Balance (ZMW)</span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-2.5 text-xs text-slate-400 font-mono font-bold">K</span>
                    <input
                      required
                      type="number"
                      step="0.01"
                      placeholder="Opening drawer cash, e.g. 500.00"
                      value={inputOpeningCash}
                      onChange={(e) => setInputOpeningCash(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 bg-rose-50/30 border border-rose-200/50 focus:bg-white focus:border-rose-500 rounded-lg text-xs font-mono font-bold outline-hidden transition-all text-slate-850"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full mt-1.5 py-2.5 bg-indigo-600 hover:bg-indigo-700 active:scale-98 text-white font-extrabold uppercase tracking-wider text-[10px] rounded-lg transition-all cursor-pointer shadow-xs flex items-center justify-center gap-2"
                >
                  <Unlock size={11} />
                  <span>🚀 Authorize & Open Shift Register</span>
                </button>
              </form>

              {/* Help & guide credentials widget to guarantee flawless out-of-the-box usage */}
              <div className="mt-1 bg-slate-50 border border-slate-150 p-3 rounded-2xl text-[10px] text-slate-500 font-sans text-left">
                <strong className="text-slate-700 text-[10px] block mb-1">💡 SEEDED CREDENTIALS PREVIEWS:</strong>
                <ul className="list-disc pl-3.5 space-y-1">
                  <li><strong>Business Owner:</strong> <span className="font-mono text-slate-700 select-all">owner@pos.zm</span> / <span className="font-mono text-slate-700 select-all">admin123</span> (Full Access)</li>
                  <li><strong>Store Manager:</strong> <span className="font-mono text-slate-700 select-all">chintu@pos.zm</span> / <span className="font-mono text-slate-700 select-all">staff123</span> (or <span className="font-mono text-slate-700 select-all">Mulenga</span>)</li>
                  <li><strong>Sales Operator:</strong> <span className="font-mono text-slate-700 select-all">lombe@pos.zm</span> / <span className="font-mono text-slate-700 select-all">staff123</span> (or <span className="font-mono text-slate-700 select-all">Kapambwe</span>)</li>
                </ul>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Search, categories, and scanners */}
            <div className="p-3.5 bg-white border-b border-slate-200 flex flex-col gap-3 shrink-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 bg-slate-100 border border-slate-200 rounded-lg text-xs font-semibold focus:outline-hidden text-slate-800"
                placeholder="Search catalog or barcode..."
              />
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">

              <button
                onClick={handleTriggerQRScanner}
                className="flex items-center gap-1 px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-xs font-bold cursor-pointer transition-all border border-indigo-150 shadow-3xs"
                title="Simulate smartphone physical QR/Barcode camera scan permissions"
              >
                <Camera size={13} />
                <span>CAMERA CAM SCAN</span>
              </button>

              <button
                onClick={() => handleTriggerCashUp(undefined, undefined, undefined, true)}
                className="flex items-center gap-1 px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-lg text-xs font-bold cursor-pointer transition-all border border-emerald-150"
              >
                <Activity size={13} />
                <span>EOD CASH UP</span>
              </button>

            </div>
          </div>

          <div className="flex items-center gap-1 overflow-x-auto py-0.5 no-scrollbar">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-1 rounded-md text-[11px] font-extrabold whitespace-nowrap cursor-pointer transition-colors ${
                  selectedCategory === cat
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

        </div>

        {/* Dynamic products catalog viewport */}
        <div className="flex-1 overflow-y-auto p-4">
          
          {/* CAMERA FEED SCREEN OVERLAY */}
          {isCamerActive && (
            <div className="bg-slate-900 border border-slate-800 text-white p-4 rounded-2xl mb-4 shadow-xl flex flex-col gap-3 relative overflow-hidden select-none">
              <div className="flex items-center justify-between border-b border-slate-850 pb-2">
                <div className="flex items-center gap-1.5">
                  <Camera size={15} className="text-emerald-400 animate-pulse" />
                  <span className="text-[11px] font-mono font-bold tracking-widest text-emerald-400 uppercase">Hardware Barcode Scanner Lens</span>
                </div>
                <button 
                  onClick={() => setIsCameraActive(false)}
                  className="px-2 py-0.5 text-[9px] uppercase font-bold text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md cursor-pointer transition-colors"
                >
                  Close
                </button>
              </div>

              {cameraError && (
                <div className="bg-rose-950/40 border border-rose-900 text-rose-200 text-[10px] p-2.5 rounded-lg flex flex-col gap-1 leading-snug font-medium">
                  <p className="font-bold text-rose-400">⚠️ Camera warning:</p>
                  <p className="opacity-95">{cameraError}</p>
                </div>
              )}

              {/* The element html5-qrcode binds to */}
              <div className="relative bg-black rounded-lg overflow-hidden border border-slate-800 flex flex-col items-center justify-center">
                <div id="qr-reader" className="w-full bg-black shrink-0 font-sans" style={{ minHeight: '180px' }}></div>
                
                {/* Visual Scanning Reticle Frame overlay */}
                <div className="absolute inset-0 border-[2px] border-emerald-500/10 pointer-events-none flex items-center justify-center">
                  <div className="w-36 h-36 border-2 border-emerald-500/30 rounded-xl relative">
                    <div className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-emerald-400"></div>
                    <div className="absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2 border-emerald-400"></div>
                    <div className="absolute bottom-0 left-0 w-3 h-3 border-b-2 border-l-2 border-emerald-400"></div>
                    <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-emerald-400"></div>
                    {/* Pulsing Scan Laser Line */}
                    <div className="absolute left-0 right-0 h-0.5 bg-emerald-400 shadow-sm shadow-emerald-400/50 top-1/2 -translate-y-1/2 animate-bounce"></div>
                  </div>
                </div>
              </div>

              {/* Controls & Helpers */}
              <div className="flex flex-col gap-2 bg-slate-950/40 p-2.5 rounded-xl border border-slate-850">
                {/* Camera Selector */}
                {availableCameras.length > 1 && (
                  <div className="flex items-center justify-between gap-1.5 text-[11px] border-b border-slate-850/60 pb-2">
                    <span className="text-[10px] text-slate-400 font-mono font-bold shrink-0">Lenses:</span>
                    <select
                      value={selectedCameraId}
                      onChange={(e) => setSelectedCameraId(e.target.value)}
                      className="bg-slate-900 text-[10.5px] px-2 py-0.5 rounded border border-slate-750 text-slate-200 focus:outline-hidden max-w-[200px]"
                    >
                      {availableCameras.map(cam => (
                        <option key={cam.id} value={cam.id}>{cam.label || `Camera ${cam.id.slice(0, 5)}`}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Instant Scan Simulator Buttons (extremely helpful for clients testing on browser with no camera) */}
                <div className="flex flex-col gap-1">
                  <span className="text-[9px] font-mono text-slate-400 font-bold uppercase tracking-wider block">Sandbox Barcode Simulator keys (Click to scan):</span>
                  <div className="flex flex-wrap gap-1">
                    {products.slice(0, 6).map(p => (
                      <button
                        key={p.id}
                        onClick={() => {
                          handleOnScanSuccess(p.sku);
                        }}
                        className="px-2 py-1 bg-slate-800 hover:bg-emerald-950 border border-slate-755 hover:border-emerald-800 rounded text-[9px] font-mono text-slate-300 hover:text-emerald-300 cursor-pointer active:scale-95 transition-all"
                      >
                        {p.sku} ({p.name.split(' ')[0]})
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Scan Toast Success/Failure Message Bar */}
              {scanningMessage && (
                <div className="bg-emerald-950/90 border border-emerald-800 rounded-lg p-2.5 text-center text-[11px] text-emerald-200 font-bold animate-pulse shadow-md">
                  {scanningMessage}
                </div>
              )}
            </div>
          )}

          {filteredProducts.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-slate-400 h-64 gap-2">
              <Coffee size={32} className="stroke-1 animate-bounce" />
              <p className="text-sm font-semibold">No stock items found in branch {activeStore.toUpperCase()}.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {filteredProducts.map(prod => {
                const isService = prod.is_service === 1;
                const lowStock = !isService && prod.stock <= 5;
                const outOfStock = !isService && prod.stock === 0;

                return (
                  <div
                    key={prod.id}
                    onClick={() => !outOfStock && addToCart(prod)}
                    className={`bg-white rounded-xl border border-slate-200 p-3 sm:p-2 relative flex flex-row sm:flex-col gap-3 sm:gap-1.5 transition-all ${
                      outOfStock
                        ? 'opacity-60 cursor-not-allowed border-dashed bg-slate-50'
                        : 'cursor-pointer hover:border-indigo-500 hover:shadow-xs active:scale-[0.98]'
                    }`}
                  >
                    <span className="absolute top-1.5 left-1.5 bg-slate-900/80 backdrop-blur-xs text-white text-[8px] font-extrabold tracking-wider uppercase px-1 rounded z-10 font-mono">
                      {prod.category}
                    </span>

                    {outOfStock ? (
                      <span className="absolute top-1.5 right-1.5 bg-red-600 text-white text-[8px] font-extrabold uppercase px-1 rounded z-10">
                        OUT
                      </span>
                    ) : lowStock ? (
                      <span className="absolute top-1.5 right-1.5 bg-amber-500 text-white text-[8px] font-extrabold uppercase px-1 rounded z-10 animate-pulse">
                        STK: {prod.stock}
                      </span>
                    ) : isService ? (
                      <span className="absolute top-1.5 right-1.5 bg-indigo-600 text-white text-[8px] font-extrabold uppercase px-1 rounded z-10">
                        SRV
                      </span>
                    ) : null}

                    <div className="w-20 h-20 sm:w-full sm:aspect-square rounded-lg bg-slate-100 overflow-hidden relative border shrink-0">
                      <img src={prod.imageUrl} alt={prod.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    </div>

                    <div className="flex-1 flex flex-col justify-between select-text min-w-0">
                      <div>
                        <h4 className="text-xs sm:text-[11px] font-extrabold text-slate-800 line-clamp-2 sm:line-clamp-1 leading-snug">{prod.name}</h4>
                        <span className="font-mono text-[9px] font-semibold text-slate-400">SKU: {prod.sku}</span>
                      </div>

                      <div className="flex items-center justify-between border-t border-slate-100 sm:border-t-0 pt-1.5 sm:pt-0 mt-1 sm:mt-0 text-[11px]">
                        <span className="font-mono font-bold text-indigo-700 text-sm sm:text-xs">{settings.currency}{prod.price.toFixed(2)}</span>
                        {isService ? (
                          <span className="text-[9px] text-indigo-700 bg-indigo-50 font-extrabold px-1.5 py-0.5 rounded uppercase">Service</span>
                        ) : !outOfStock && (
                          <span className="text-[10px] text-slate-500 font-bold">Qty: <strong className="text-slate-800">{prod.stock}</strong></span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

        </div>

        {/* Mobile floating "Go to Basket" button */}
        {isShiftActive && cart.length > 0 && (
          <div className="md:hidden p-3 bg-white border-t border-slate-200 shrink-0">
            <button
              type="button"
              onClick={() => setActiveMobileTab('basket')}
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 active:scale-98 text-white font-extrabold uppercase tracking-widest text-[10.5px] rounded-xl transition-all cursor-pointer shadow-md flex items-center justify-center gap-2"
            >
              <ShoppingCart size={14} />
              <span>Checkout Basket ({cart.reduce((sum, item) => sum + item.quantity, 0)} Items)</span>
              <ArrowRight size={13} className="animate-pulse" />
            </button>
          </div>
        )}
          </>
        )}
      </div>

      {/* RIGHT COLUMN: REVENUE & CALCULATIONS SHEET */}
      {isShiftActive && (
        <div className={`border-t md:border-t-0 md:border-l border-slate-200 p-4 flex-col overflow-hidden md:h-auto md:max-h-screen md:w-[40%] shrink-0 ${
          activeMobileTab === 'basket' 
            ? 'flex-1 w-full h-full flex bg-white' 
            : 'hidden md:flex bg-white'
        }`}>
        
        <div className="flex items-center justify-between mb-3 shrink-0 uppercase select-none flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveMobileTab('catalog')}
              className="md:hidden flex items-center gap-1 px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold cursor-pointer"
              title="Return to Product Catalog Grid"
            >
              <ArrowLeft size={13} />
              <span>Catalog</span>
            </button>
            <ShoppingCart size={15} className="text-slate-800" />
            <h3 className="text-xs font-extrabold text-slate-900 tracking-wider">Client Basket</h3>
            <span className="bg-slate-800 text-white font-mono font-bold text-[10px] px-1.5 py-0.5 rounded">
              {cart.reduce((sum, item) => sum + item.quantity, 0)} Items
            </span>
          </div>
          {cart.length > 0 && (
            <button 
              onClick={clearCart} 
              className="py-2 px-3 text-[10px] font-bold text-rose-500 hover:bg-rose-50 border border-rose-100 rounded-md cursor-pointer transition-colors"
            >
              ✕ Dump
            </button>
          )}
        </div>



        {/* Basket Cart list */}
        <div className="flex-1 bg-slate-50/50 border rounded-xl overflow-y-auto mb-3 p-2">
          {cart.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center p-8 text-center text-slate-400 gap-2">
              <ShoppingCart size={22} className="stroke-1 animate-bounce" />
              <span className="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider">BASKET EMPTY</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {cart.map(item => (
                <div key={item.product.id} className="bg-white border p-2.5 rounded-lg flex items-center justify-between gap-2 shadow-3xs">
                  <div className="flex-1 overflow-hidden">
                    <p className="text-xs font-bold text-slate-800 line-clamp-1">{item.product.name}</p>
                    <p className="text-[10px] font-mono text-slate-400">{settings.currency}{item.product.price.toFixed(2)} ea</p>
                  </div>
                  
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button 
                      onClick={() => updateQuantity(item.product.id, -1)} 
                      className="w-12 h-12 bg-slate-100 border border-slate-250 text-base font-extrabold rounded-lg flex items-center justify-center active:bg-slate-200 cursor-pointer select-none"
                      title="Decrease item count"
                    >
                      -
                    </button>
                    <span className="w-5 text-center font-mono text-xs font-black text-slate-800">{item.quantity}</span>
                    <button 
                      onClick={() => updateQuantity(item.product.id, 1)} 
                      className="w-12 h-12 bg-slate-100 border border-slate-250 text-base font-extrabold rounded-lg flex items-center justify-center active:bg-slate-200 cursor-pointer select-none"
                      title="Increase item count"
                    >
                      +
                    </button>
                  </div>

                  <span className="w-14 text-right font-mono text-xs font-extrabold text-slate-900">{settings.currency}{(item.product.price * item.quantity).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Coupons discounts and totals calculation panel */}
        {cart.length > 0 && (
          <div className="bg-white border rounded-xl p-3 flex flex-col gap-2 shrink-0 select-text">
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-slate-400 font-extrabold uppercase">Apply Discount</span>
                <div className="flex bg-slate-105 p-0.5 rounded-lg border border-slate-200">
                  <button
                    type="button"
                    onClick={() => {
                      setDiscountType('percent');
                      setDiscountValue(0);
                    }}
                    className={`px-2 py-0.5 text-[9px] font-black rounded-md cursor-pointer transition-all ${
                      discountType === 'percent' ? 'bg-white text-indigo-700 shadow-3xs' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    % Percent
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDiscountType('fixed');
                      setDiscountValue(0);
                    }}
                    className={`px-2 py-0.5 text-[9px] font-black rounded-md cursor-pointer transition-all ${
                      discountType === 'fixed' ? 'bg-white text-indigo-700 shadow-3xs' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    Fixed ({settings.currency})
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-1.5 mt-1">
                <div className="flex-1">
                  <input
                    type="number"
                    min="0"
                    step="any"
                    max={discountType === 'percent' ? 100 : subtotal}
                    placeholder={discountType === 'percent' ? "Enter percentage" : "Enter amount"}
                    value={discountValue === 0 ? '' : discountValue}
                    onChange={(e) => {
                      const maxLimit = discountType === 'percent' ? 100 : subtotal;
                      const val = Math.min(maxLimit, Math.max(0, parseFloat(e.target.value) || 0));
                      if (userRole === 'sales' && val > 0) {
                        alert('Access Denied: Manager privilege override required to apply custom invoice discounts.');
                        return;
                      }
                      setDiscountValue(val);
                    }}
                    className="w-full text-left border border-slate-200 focus:border-indigo-500 rounded-md px-2 py-1 text-[10px] bg-slate-50 font-bold font-mono focus:outline-hidden"
                  />
                </div>
                {discountValue > 0 && (
                  <button
                    type="button"
                    onClick={() => setDiscountValue(0)}
                    className="px-2 py-1 bg-rose-50 text-rose-600 border border-rose-200 rounded-md text-[9px] font-bold hover:bg-rose-100 cursor-pointer transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            <hr className="border-slate-100" />

            <div className="flex flex-col gap-1 text-[11px] font-sans">
              <div className="flex justify-between text-slate-500">
                <span>Basket Subtotal:</span>
                <span className="font-mono">{settings.currency}{subtotal.toFixed(2)}</span>
              </div>
              {discountAmount > 0 && (
                <div className="flex justify-between text-rose-600 font-bold">
                  <span>Discount:</span>
                  <span className="font-mono">-{settings.currency}{discountAmount.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-slate-500">
                <span>Tax (VAT {settings.taxRate}%):</span>
                <span className="font-mono">{settings.currency}{taxAmount.toFixed(2)}</span>
              </div>
              
              <div className="flex justify-between items-center bg-slate-900 text-white p-2.5 rounded-lg font-black mt-2">
                <span className="text-[10px] uppercase font-bold tracking-widest text-slate-450">TOTAL AMOUNT</span>
                <span className="font-mono text-lg text-emerald-400 font-extrabold">{settings.currency}{totalAmount.toFixed(2)}</span>
              </div>
            </div>

            <button
              id="btn_trigger_payment"
              onClick={handleCheckoutInit}
              className="py-3 bg-emerald-600 active:bg-emerald-700 hover:bg-emerald-500 text-white font-extrabold text-xs tracking-widest uppercase rounded-xl shadow-xs cursor-pointer text-center flex items-center justify-center gap-1.5"
            >
              <ShoppingCart size={15} />
              <span>PROCEED CHECKOUT BILLING</span>
            </button>
          </div>
        )}

      </div>
      )}
      </div>

      {/* MODAL 1: CHECKOUT DIALOG OVERLAY */}
      <AnimatePresence>
        {showPaymentModal && (
          <div className="absolute inset-0 bg-slate-950/75 backdrop-blur-xs flex justify-center items-start md:items-center overflow-x-auto overflow-y-auto p-2 sm:p-4 z-50">
            <motion.div
              initial={{ scale: 0.96, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.96, opacity: 0, y: 10 }}
              className={`bg-white rounded-3xl border border-slate-200 shadow-2xl p-4 sm:p-6 flex flex-col gap-4 text-left my-4 md:my-auto w-full overflow-y-auto scrollbar-thin ${
                checkoutStep === 'success'
                  ? 'max-w-[96vw] md:max-w-4xl max-h-[92vh]'
                  : 'max-w-[95vw] md:max-w-lg max-h-[90vh]'
              }`}
            >
              <div className="flex items-center justify-between border-b border-slate-200/80 pb-3 -mx-4 -mt-4 sm:-mx-6 sm:-mt-6 p-4 sm:p-5 bg-slate-50 rounded-t-3xl select-none shrink-0">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={18} className="text-indigo-600" />
                  <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest flex items-center gap-1.5">
                    {checkoutStep === 'success' ? (
                      <span className="text-emerald-650 flex items-center gap-1.5">
                        <ShieldCheck size={14} className="text-emerald-600" />
                        TRANSACTION COMPLETED
                      </span>
                    ) : (
                      <>
                        <Shield size={14} className="text-indigo-600" />
                        SECURE TRANSACTION CLEARING PANEL
                      </>
                    )}
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-mono font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-150 shrink-0">
                    {checkoutStep === 'customer' ? 'STEP 1 OF 2' : checkoutStep === 'payment' ? 'STEP 2 OF 2' : 'SUCCESS'}
                  </span>
                </div>
              </div>

              {checkoutStep === 'customer' ? (
                /* STEP 1: CUSTOMER DETAILS COLLECTION */
                <div className="flex flex-col gap-3.5 animate-fadeIn">
                  {/* QUICK BYPASS FOR GUEST WALK-IN SHIFTS */}
                  <div className="bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200/60 p-3 rounded-2xl flex flex-col gap-1.5 shadow-3xs">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-emerald-850 font-black uppercase tracking-wider flex items-center gap-1">
                        ⚡ Quick Checkout Bypass
                      </span>
                      <span className="text-[8px] font-bold text-emerald-600 bg-emerald-100/60 px-1.5 py-0.2 rounded uppercase">
                        Instant Mode
                      </span>
                    </div>
                    <p className="text-[9px] text-slate-500 leading-normal">
                      Skip logging client details to proceed instantly to cash up.
                    </p>
                    <button
                      type="button"
                      onClick={() => handleContinueToPayment(true)}
                      className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-[10px] font-black rounded-lg uppercase tracking-wider flex items-center justify-center gap-1.5 cursor-pointer shadow-3xs transition-all"
                    >
                      ⚡ Skip & Proceed as Guest Walk-in client
                    </button>
                  </div>

                  <div className="bg-slate-50 border border-slate-200 p-3.5 rounded-2xl flex flex-col gap-3 text-slate-700">
                    <div className="flex justify-between items-center border-b border-slate-200 pb-1.5 select-none font-sans">
                      <span className="text-[10px] text-indigo-800 font-black uppercase tracking-wider flex items-center gap-1">
                        👤 Customer Details Registry
                      </span>
                      <span className="text-[8px] font-mono text-indigo-600 bg-indigo-50 border border-indigo-150 px-1 py-0.2 rounded font-bold uppercase">
                        Compliance Registry
                      </span>
                    </div>

                    {/* Live search input filter */}
                    <div className="flex flex-col gap-1 text-left">
                      <label className="text-[8.5px] font-extrabold text-slate-400 uppercase font-sans">Search Loyal Member Registry</label>
                      <div className="relative">
                        <Search size={12} className="absolute left-2.5 top-1/2 transform -translate-y-1/2 text-slate-400" />
                        <input
                          type="text"
                          value={customerRegistrySearchText}
                          onChange={(e) => setCustomerRegistrySearchText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleContinueToPayment();
                            }
                          }}
                          placeholder="Search saved customers by name, phone or TPIN..."
                          className="w-full bg-white text-xs border border-slate-250 pl-8 pr-2 py-1 rounded-lg focus:outline-indigo-500 text-slate-800 font-semibold"
                        />
                        {customerRegistrySearchText && (
                          <button
                            type="button"
                            onClick={() => setCustomerRegistrySearchText('')}
                            className="absolute right-2 top-1/2 transform -translate-y-1/2 text-[9px] bg-slate-200 text-slate-600 hover:bg-slate-300 rounded px-1 font-bold"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Loyalty dropdown selector of matching items */}
                    <div className="flex flex-col gap-1 text-left">
                      <label className="text-[8.5px] font-extrabold text-slate-400 uppercase font-sans">Select Registered Client</label>
                      <select
                        value={selectedCustomer ? selectedCustomer.id : ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === '') {
                            setSelectedCustomer(null);
                            setCustomerName('');
                            setCustomerPhone('');
                            setCustomerTpin('');
                            setCustomerAddress('');
                          } else {
                            const c = customers.find(x => x.id === parseInt(val));
                            if (c) {
                              setSelectedCustomer(c);
                              setCustomerName(c.name || '');
                              setCustomerPhone(c.phone || '');
                              setCustomerTpin(c.tpin || '');
                              setCustomerAddress(c.email || ''); // map fallback
                            }
                          }
                        }}
                        className="w-full bg-white text-xs border border-slate-250 px-2 py-1.5 rounded-lg focus:outline-hidden text-slate-800 font-bold cursor-pointer"
                      >
                        <option value="">-- [Optional] Add as guest client or Select --</option>
                        {customers.filter(c => {
                          if (!customerRegistrySearchText.trim()) return true;
                          const q = customerRegistrySearchText.toLowerCase();
                          return (
                            (c.name && c.name.toLowerCase().includes(q)) ||
                            (c.phone && c.phone.toLowerCase().includes(q)) ||
                            (c.tpin && c.tpin.toLowerCase().includes(q))
                          );
                        }).map((c, idx) => (
                          <option key={`${c.id}-${idx}`} value={c.id}>{c.name} ({c.phone} | {c.loyalPoints} pts)</option>
                        ))}
                      </select>
                    </div>

                    <div className="border-t border-slate-200/55 my-1" />

                    {/* Input registry fields */}
                    <div className="grid grid-cols-2 gap-2 text-left">
                      <div className="flex flex-col gap-1 col-span-2">
                        <label className="text-[8.5px] font-extrabold text-slate-400 uppercase font-sans">Customer Full Name *</label>
                        <input
                          type="text"
                          required
                          value={customerName}
                          onChange={(e) => setCustomerName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleContinueToPayment();
                            }
                          }}
                          placeholder="Enter full client name..."
                          className="bg-white border text-xs px-2.5 py-1.5 rounded-lg text-slate-800 font-semibold focus:outline-indigo-500"
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-[8.5px] font-extrabold text-slate-400 uppercase font-sans font-mono tracking-wide">Phone Number (Optional)</label>
                        <input
                          type="tel"
                          value={customerPhone}
                          onChange={(e) => setCustomerPhone(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleContinueToPayment();
                            }
                          }}
                          placeholder="+260 97XXXXX"
                          className="bg-white border text-xs px-2.5 py-1.5 rounded-lg text-slate-800 font-semibold focus:outline-indigo-500 font-mono"
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-[8.5px] font-extrabold text-slate-400 uppercase font-sans font-mono tracking-wide">ZM TPIN (10 Digits - Optional)</label>
                        <input
                          type="text"
                          maxLength={10}
                          value={customerTpin}
                          onChange={(e) => {
                            const t = e.target.value.replace(/\D/g, '');
                            setCustomerTpin(t);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleContinueToPayment();
                            }
                          }}
                          placeholder="1003456789"
                          className="bg-white border text-xs px-2.5 py-1.5 rounded-lg text-slate-800 font-bold font-mono tracking-wider focus:outline-indigo-500"
                        />
                      </div>

                      <div className="flex flex-col gap-1 col-span-2">
                        <label className="text-[8.5px] font-extrabold text-slate-400 uppercase font-sans">Physical / Delivery Address (Optional)</label>
                        <input
                          type="text"
                          value={customerAddress}
                          onChange={(e) => setCustomerAddress(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleContinueToPayment();
                            }
                          }}
                          placeholder="e.g. Plot 41, Lusaka West"
                          className="bg-white border text-xs px-2.5 py-1.5 rounded-lg text-slate-800 font-semibold focus:outline-indigo-500"
                        />
                      </div>
                    </div>

                    <div className="border-t border-slate-200/55 my-1" />

                    {/* Direct save profile option */}
                    <div className="flex flex-col gap-1.5">
                      <button
                        type="button"
                        onClick={saveCustomerToRegistry}
                        className="w-full py-1.5 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 text-indigo-850 text-[10px] font-extrabold rounded-lg uppercase tracking-wider flex items-center justify-center gap-1 cursor-pointer transition-colors"
                      >
                        💾 Register Client profile now
                      </button>

                      <label className="flex items-center gap-2 mt-1 px-1 py-0.5 select-none cursor-pointer">
                        <input
                          type="checkbox"
                          checked={autoSaveCustomer}
                          onChange={(e) => setAutoSaveCustomer(e.target.checked)}
                          className="h-3.5 w-3.5 text-indigo-600 border-slate-350 rounded-sm focus:ring-indigo-500"
                        />
                        <span className="text-[9.5px] text-slate-500 font-semibold">
                          💾 Auto-save to database registry on checkout
                        </span>
                      </label>
                    </div>

                    {customerTpin.length === 10 && (
                      <div className="mt-1 flex items-center justify-between text-[9px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1.5 rounded-md">
                        <span className="font-extrabold flex items-center gap-1.5 font-sans">
                          <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-ping"></span>
                          ZM SMART INVOICE SYNC ACTIVE
                        </span>
                        <span className="font-mono font-bold">{customerTpin}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setShowPaymentModal(false)}
                      className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-[10px] font-extrabold tracking-wider text-center cursor-pointer transition-colors font-sans"
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      onClick={() => handleContinueToPayment()}
                      className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-[10px] font-black tracking-wider text-center cursor-pointer shadow-3xs transition-all uppercase font-sans"
                    >
                      CONTINUE TO PAYMENT →
                    </button>
                  </div>
                </div>
              ) : checkoutStep === 'payment' ? (
                /* STEP 2: PAYMENT METHOD & TENDERED AMOUNT */
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <span className="text-[10px] text-slate-400 font-extrabold uppercase">Payment Ledger Method</span>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: 'CASH', val: 'Cash', icon: <DollarSign size={12} className="text-indigo-600" /> },
                        { label: 'CARD', val: 'Credit Card', icon: <CreditCard size={12} className="text-emerald-600" /> },
                        { label: 'MOBILE MON.', val: 'Mobile Wallet', icon: <Coins size={12} className="text-amber-600" /> },
                        { label: 'SPLIT (CASH+MOBILE)', val: 'Split', icon: <Layers size={12} className="text-pink-650 animate-bounce" /> },
                      ].map(x => (
                        <button
                          key={x.val}
                          type="button"
                          onClick={() => {
                            setPaymentMethod(x.val as any);
                            if (x.val === 'Split') {
                              setSplitCashAmount('');
                              setSplitMobileAmount('');
                            }
                          }}
                          className={`py-2 px-1.5 rounded-lg border font-black text-[10px] flex flex-col items-center justify-center gap-1 cursor-pointer transition-colors ${
                            paymentMethod === x.val ? 'bg-indigo-50 text-indigo-700 border-indigo-500 shadow-3xs' : 'bg-slate-50 border-slate-200 text-slate-500'
                          }`}
                        >
                          {x.icon}
                          {x.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {paymentMethod === 'Cash' && (
                    <div className="bg-slate-900 text-white p-4 rounded-xl border border-slate-855 flex flex-col gap-3.5 shadow-inner">
                      <div className="flex justify-between items-center text-xs text-slate-400 font-bold border-b border-slate-800 pb-2">
                        <span>Invoice Amount Due:</span>
                        <span className="font-mono text-sm text-amber-400 font-extrabold">{settings.currency}{totalAmount.toFixed(2)}</span>
                      </div>
                      
                      <div className="flex flex-col gap-1.5 text-left">
                        <label className="text-[10px] text-slate-300 font-extrabold uppercase tracking-widest block font-sans">
                          💵 Money Tendered ({settings.currency})
                        </label>
                        <div className="relative">
                          <span className="absolute left-4 top-1/2 -translate-y-1/2 font-mono text-xl text-slate-400 font-extrabold select-none">
                            {settings.currency}
                          </span>
                          <input
                            id="cash_tendered_large_box"
                            type="number"
                            step="0.01"
                            value={receivedCash}
                            onChange={(e) => setReceivedCash(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                if ((parseFloat(receivedCash) || 0) >= totalAmount) {
                                  handleCompletePayment();
                                }
                              }
                            }}
                            placeholder="0.00"
                            className="w-full pl-10 pr-4 py-3 bg-slate-955 border border-slate-800 text-teal-400 font-mono text-3xl font-black text-right rounded-xl focus:outline-hidden focus:ring-2 focus:ring-indigo-500 shadow-lg select-text animate-pulse"
                            autoFocus
                          />
                        </div>
                      </div>

                      <div className="flex justify-between items-center text-xs font-bold pt-1">
                        <span className="text-slate-400 uppercase text-[10px]">Change Back:</span>
                        <span className={`font-mono text-base font-extrabold ${(parseFloat(receivedCash) || 0) < totalAmount ? 'text-rose-450 animate-pulse' : 'text-emerald-400'}`}>
                          {(parseFloat(receivedCash) || 0) < totalAmount ? 'Incomplete Tender' : `${settings.currency}${(parseFloat(receivedCash || '0') - totalAmount).toFixed(2)}`}
                        </span>
                      </div>
                    </div>
                  )}

                  {paymentMethod === 'Split' && (
                    <div className="bg-slate-900 text-white p-4 rounded-xl border border-slate-855 flex flex-col gap-3.5 shadow-inner">
                      <div className="flex justify-between items-center text-xs text-slate-405 font-bold border-b border-slate-800 pb-2">
                        <span>Invoice Amount Due:</span>
                        <span className="font-mono text-sm text-amber-400 font-extrabold">{settings.currency}{totalAmount.toFixed(2)}</span>
                      </div>
                      
                      <p className="text-[9px] text-slate-400 leading-normal font-medium tracking-wide">
                        * Input mobile money and cash tendered amounts manually. Cash can exceed the total to calculate returned change.
                      </p>
                      
                      <div className="grid grid-cols-2 gap-3 text-left">
                        <div className="flex flex-col gap-1">
                          <label className="text-[9px] text-slate-300 font-extrabold uppercase tracking-widest block font-sans">
                            💵 Cash Portion ({settings.currency})
                          </label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={splitCashAmount}
                            onChange={(e) => {
                              setSplitCashAmount(e.target.value);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                if (((parseFloat(splitCashAmount) || 0) + (parseFloat(splitMobileAmount) || 0) + 0.005) >= totalAmount) {
                                  handleCompletePayment();
                                }
                              }
                            }}
                            placeholder="0.00"
                            className="bg-slate-955 border border-slate-800 text-teal-400 font-mono text-base font-black px-2 py-1.5 rounded-lg text-right focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>

                        <div className="flex flex-col gap-1">
                          <label className="text-[9px] text-slate-300 font-extrabold uppercase tracking-widest block font-sans">
                            📱 Mobile Portion ({settings.currency})
                          </label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={splitMobileAmount}
                            onChange={(e) => {
                              setSplitMobileAmount(e.target.value);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                if (((parseFloat(splitCashAmount) || 0) + (parseFloat(splitMobileAmount) || 0) + 0.005) >= totalAmount) {
                                  handleCompletePayment();
                                }
                              }
                            }}
                            placeholder="0.00"
                            className="bg-slate-955 border border-slate-800 text-purple-450 font-mono text-base font-black px-2 py-1.5 rounded-lg text-right focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5 border-t border-slate-800 pt-2 text-xs">
                        {(() => {
                          const cashNum = parseFloat(splitCashAmount) || 0;
                          const mobNum = parseFloat(splitMobileAmount) || 0;
                          const sum = cashNum + mobNum;
                          const isCovered = sum >= (totalAmount - 0.005);
                          const changeAmt = Math.max(0, sum - totalAmount);

                          return (
                            <>
                              <div className="flex justify-between items-center text-slate-400 text-[10px] uppercase font-bold">
                                <span>Total Split Received:</span>
                                <span className={`font-mono text-xs font-black ${isCovered ? 'text-emerald-400' : 'text-amber-500'}`}>
                                  {settings.currency}{sum.toFixed(2)}
                                </span>
                              </div>
                              
                              {!isCovered ? (
                                <div className="flex justify-between items-center text-rose-400 font-bold text-[10px] uppercase animate-pulse">
                                  <span>Gap to cover:</span>
                                  <span className="font-mono text-xs font-black">
                                    {settings.currency}{(totalAmount - sum).toFixed(2)}
                                  </span>
                                </div>
                              ) : (
                                <>
                                  <div className="flex justify-between items-center text-emerald-400 font-bold text-[10px] uppercase">
                                    <span>Status:</span>
                                    <span className="font-sans text-[9px] font-black tracking-wider bg-emerald-950 text-emerald-300 px-1.5 py-0.5 rounded-sm">
                                      FULLY COVERED
                                    </span>
                                  </div>
                                  
                                  {changeAmt > 0 && (
                                    <div className="flex justify-between items-center text-amber-300 font-black text-xs uppercase bg-amber-950/30 p-1.5 rounded-md border border-dashed border-amber-800/40 mt-1">
                                      <span>Returned Cash Change:</span>
                                      <span className="font-mono text-sm font-extrabold text-amber-400">
                                        {settings.currency}{changeAmt.toFixed(2)}
                                      </span>
                                    </div>
                                  )}
                                </>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setCheckoutStep('customer')}
                      className="flex-1 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-[10px] font-extrabold text-slate-600 cursor-pointer text-center tracking-wider uppercase transition-colors"
                    >
                      ← BACK
                    </button>
                    <button
                      id="final_checkout_complete"
                      type="button"
                      onClick={handleCompletePayment}
                      disabled={
                        (paymentMethod === 'Cash' && (parseFloat(receivedCash) || 0) < totalAmount) ||
                        (paymentMethod === 'Split' && ((parseFloat(splitCashAmount) || 0) + (parseFloat(splitMobileAmount) || 0) + 0.005) < totalAmount)
                      }
                      className={`flex-1 py-2 rounded-lg text-[10px] font-black text-white text-center cursor-pointer tracking-wider ${
                        (paymentMethod === 'Cash' && (parseFloat(receivedCash) || 0) < totalAmount) ||
                        (paymentMethod === 'Split' && ((parseFloat(splitCashAmount) || 0) + (parseFloat(splitMobileAmount) || 0) + 0.005) < totalAmount)
                          ? 'bg-slate-200 text-slate-450 cursor-not-allowed'
                          : 'bg-emerald-600 active:bg-emerald-700 hover:bg-emerald-500'
                      }`}
                    >
                      ACCEPT PAYMENT
                    </button>
                  </div>
                </div>
              ) : (
                /* STEP 3: SUCCESS & RECEIPT ACTIONS */
                <div className="flex flex-col md:flex-row gap-6 animate-fadeIn w-full">
                  {/* LEFT COLUMN: SUCCESS OVERVIEW AND ACTIONS */}
                  <div className="flex-1 flex flex-col gap-4 min-w-0 md:min-w-[280px]">
                    <div className="flex flex-col items-center justify-center text-center py-4 bg-emerald-50 border border-emerald-200/60 rounded-2xl p-4 gap-1.5 shadow-3xs animate-pulse select-none">
                      <div className="h-10 w-10 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-650">
                        <CheckCircle size={22} className="text-emerald-650" />
                      </div>
                      <span className="text-xs font-black text-emerald-850 uppercase tracking-widest block font-sans">
                        Payment Approved & Accepted!
                      </span>
                      {activeReceipt && (
                        <p className="text-[10px] text-slate-500 font-bold font-mono">
                          REF ID: {activeReceipt.id}
                        </p>
                      )}
                    </div>

                    {activeReceipt && (
                      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex flex-col gap-2.5">
                        <div className="flex justify-between items-center text-xs font-bold font-sans text-slate-500 border-b border-slate-200/60 pb-2">
                          <span>Ledger Channel:</span>
                          <span className="text-slate-800 uppercase font-black">{activeReceipt.paymentMethod}</span>
                        </div>
                        
                        <div className="flex justify-between items-center text-xs font-bold font-sans text-slate-500 border-b border-slate-200/60 pb-2">
                          <span>Total Paid:</span>
                          <span className="text-indigo-950 font-black">{settings.currency}{activeReceipt.total.toFixed(2)}</span>
                        </div>

                        {activeReceipt.paymentMethod === 'Cash' && (
                          <div className="flex justify-between items-center text-xs font-bold font-sans text-emerald-850 bg-emerald-100/40 p-2 rounded-lg border border-dashed border-emerald-200">
                            <span className="uppercase text-[9px] tracking-wider font-extrabold">Change Returned:</span>
                            <span className="font-mono text-base font-black text-emerald-700">
                              {settings.currency}{activeReceipt.change.toFixed(2)}
                            </span>
                          </div>
                        )}

                        {activeReceipt.paymentMethod === 'Split' && activeReceipt.splitBreakdown && (
                          <div className="flex flex-col gap-1.5 text-[10px] font-mono text-slate-600 bg-slate-100/50 p-2.5 rounded-lg border border-slate-200">
                            <div className="flex justify-between">
                              <span>Cash Portion:</span>
                              <strong>{settings.currency}{activeReceipt.splitBreakdown.cash.toFixed(2)}</strong>
                            </div>
                            <div className="flex justify-between">
                              <span>Mobile Portion:</span>
                              <strong>{settings.currency}{activeReceipt.splitBreakdown.mobile.toFixed(2)}</strong>
                            </div>
                            {activeReceipt.change > 0 && (
                              <div className="flex justify-between text-emerald-700 font-bold border-t border-slate-200 pt-1 mt-1">
                                <span>Cash Change:</span>
                                <strong>{settings.currency}{activeReceipt.change.toFixed(2)}</strong>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* WhatsApp send input */}
                    {activeReceipt && (
                      <div className="bg-emerald-50/50 border border-emerald-200/50 rounded-2xl p-4 flex flex-col gap-2">
                        <label className="text-[10px] text-emerald-850 font-black uppercase tracking-wider flex items-center gap-1.5 font-sans">
                          📱 SEND WHATSAPP RECEIPT
                        </label>
                        <p className="text-[8.5px] text-slate-500 leading-snug font-medium">
                          Enter the customer's WhatsApp-registered mobile number to dispatch a PDF copy instantly.
                        </p>
                        
                        <div className="flex gap-1.5 mt-1">
                          <input
                            type="tel"
                            value={whatsappPhone}
                            onChange={(e) => setWhatsappPhone(e.target.value)}
                            placeholder="+260 97 XXXXXX"
                            className="flex-1 text-xs px-3 py-1.5 bg-white border border-slate-350 text-slate-800 font-mono font-extrabold rounded-lg focus:outline-hidden focus:border-emerald-500 placeholder-slate-400"
                          />
                          <button
                            type="button"
                            onClick={() => handleWhatsAppSend()}
                            className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[10.5px] rounded-lg font-black tracking-wider uppercase flex items-center justify-center gap-1 cursor-pointer transition-all active:scale-98"
                          >
                            <Send size={11} />
                            SEND
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Prominent Finish Triggers */}
                    <div className="flex flex-col gap-2 mt-auto">
                      <button
                        type="button"
                        onClick={() => {
                          setActiveReceipt(null);
                          setCheckoutStep('customer');
                          setShowPaymentModal(false);
                          loadInvoices();
                          handleTriggerCashUp();
                          refreshDbData();
                          persistTablesToStorage();
                        }}
                        className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs uppercase rounded-xl text-center cursor-pointer tracking-widest shadow-md transition-all active:scale-98 font-sans min-h-[44px]"
                      >
                        ✓ FINISH & NEXT SALE
                      </button>
                    </div>
                  </div>

                  {/* RIGHT COLUMN: SIMULATED PRINT TICKET PREVIEW */}
                  {activeReceipt && (
                    <div className="flex-1 flex flex-col gap-3.5 border-t md:border-t-0 md:border-l border-slate-100 pt-4 md:pt-0 md:pl-6 min-w-[280px]">
                      <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest block font-sans">
                        📄 Receipt Ticket Preview
                      </span>
                      
                      {/* Ticket Scroll Container */}
                      <div className="flex justify-center bg-slate-200/70 rounded-2xl p-4 border border-slate-300 max-h-[350px] overflow-auto scrollbar-thin print:p-0 print:border-none print:max-h-none print:overflow-visible">
                        <div 
                          className="bg-[#FCFCFA] border border-slate-300 shadow-xl p-5 w-[260px] text-left text-slate-900 flex flex-col receipt-times-font text-[9.5px] leading-relaxed rounded-xs shrink-0 select-text document-print-section relative"
                          style={{ fontFamily: '"Times New Roman", Times, serif' }}
                        >
                          {/* Top receipt decorative border accent */}
                          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-600 rounded-t-xs" />

                          {/* Header */}
                          <div className="text-center border-b-2 border-double border-slate-800 pb-2.5 mb-2.5 flex flex-col gap-0.5 text-slate-800">
                            {(settings.logoUrl || DEFAULT_COMPANY_LOGO) && (
                              <div className="flex justify-center mb-1">
                                <img src={settings.logoUrl || DEFAULT_COMPANY_LOGO} alt="Company Logo" className="max-h-10 max-w-[90px] object-contain rounded-xs" referrerPolicy="no-referrer" />
                              </div>
                            )}
                            <span className="font-extrabold text-slate-900 text-xs tracking-wider uppercase block">{settings.storeName}</span>
                            <span className="font-bold text-[8px] text-slate-700 uppercase tracking-widest block">*** TAX INVOICE & RECEIPT ***</span>
                            {settings.tpin && (
                              <span className="text-[8.5px] font-bold text-slate-700 tracking-wider block">TPIN: {settings.tpin}</span>
                            )}
                            <span className="text-[8.5px] font-semibold text-slate-600">{settings.receiptHeader}</span>
                          </div>

                          {/* Metadata Card */}
                          <div className="flex flex-col gap-0.5 border-b border-dashed border-slate-400 pb-2 mb-2 text-[8.5px]">
                            <div className="flex justify-between">
                              <span className="font-bold text-slate-700">INVOICE NO:</span>
                              <span className="font-bold text-indigo-950">{activeReceipt.id}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="font-bold text-slate-700">DATE / TIME:</span>
                              <span>{activeReceipt.date}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="font-bold text-slate-700">BRANCH:</span>
                              <span>{activeStore.toUpperCase()}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="font-bold text-slate-700">CASHIER:</span>
                              <span>{(activeReceipt.performed_by || localStorage.getItem('logged_in_user_name') || 'Cashier').toUpperCase()}</span>
                            </div>
                            {activeReceipt.customer && (
                              <div className="flex justify-between">
                                <span className="font-bold text-slate-700">CUSTOMER:</span>
                                <span>{activeReceipt.customer.name}</span>
                              </div>
                            )}
                          </div>

                          {activeReceipt.offlinePending && (
                            <div className="bg-amber-50 rounded-xs border border-amber-300 p-1.5 text-[8px] text-amber-800 text-center uppercase font-sans font-bold tracking-wider mb-2 leading-tight animate-pulse">
                              ⚠️ Offline Receipt
                            </div>
                          )}

                          {/* Items Table Header */}
                          <div className="grid grid-cols-12 gap-1 border-b border-slate-800 pb-1 mb-1 font-bold text-[8.5px] text-slate-900 uppercase">
                            <span className="col-span-6">ITEM</span>
                            <span className="col-span-2 text-center">QTY</span>
                            <span className="col-span-4 text-right">TOTAL</span>
                          </div>

                          {/* Items list */}
                          <div className="flex flex-col gap-1 border-b border-dashed border-slate-400 pb-2 mb-2 text-[8.5px]">
                            {activeReceipt.items.map((x: any, i: number) => (
                              <div key={i} className="flex flex-col gap-0.5">
                                <div className="flex justify-between items-start text-slate-900">
                                  <span className="font-bold flex-1 pr-1">{x.product.name}</span>
                                  <span className="font-bold shrink-0">{settings.currency}{(x.product.price * x.quantity).toFixed(2)}</span>
                                </div>
                                <div className="flex justify-between text-[7.5px] text-slate-500 pl-1">
                                  <span>{x.quantity} x {settings.currency}{x.product.price.toFixed(2)}</span>
                                </div>
                              </div>
                            ))}
                          </div>

                          {/* Calculation */}
                          <div className="flex flex-col gap-0.5 border-b border-dashed border-slate-400 pb-2 mb-2 text-[8.5px]">
                            <div className="flex justify-between text-slate-600">
                              <span>Subtotal:</span>
                              <span>{settings.currency}{activeReceipt.subtotal.toFixed(2)}</span>
                            </div>
                            {activeReceipt.discount > 0 && (
                              <div className="flex justify-between text-rose-700 font-bold">
                                <span>Discount:</span>
                                <span>-{settings.currency}{activeReceipt.discount.toFixed(2)}</span>
                              </div>
                            )}
                            <div className="flex justify-between text-slate-600">
                              <span>VAT ({settings.taxRate}%):</span>
                              <span>{settings.currency}{activeReceipt.tax.toFixed(2)}</span>
                            </div>
                          </div>

                          {/* Grand Total Highlight Box */}
                          <div className="border-2 border-slate-900 bg-slate-50 p-1.5 my-1 rounded-xs flex justify-between items-center text-slate-900">
                            <span className="font-black text-[9px] uppercase">GRAND TOTAL:</span>
                            <span className="font-black text-[11px] text-indigo-950">{settings.currency}{activeReceipt.total.toFixed(2)}</span>
                          </div>

                          {/* Payment Mode */}
                          <div className="flex flex-col gap-0.5 border-b border-dashed border-slate-400 pb-2 my-2 text-[8px]">
                            <div className="flex justify-between">
                              <span className="font-bold text-slate-700">Payment Method:</span>
                              <span className="font-bold uppercase text-slate-900">{activeReceipt.paymentMethod}</span>
                            </div>
                            {activeReceipt.paymentMethod === 'Cash' && (
                              <>
                                <div className="flex justify-between text-slate-600">
                                  <span>Tendered Cash:</span>
                                  <span>{settings.currency}{activeReceipt.cashReceived.toFixed(2)}</span>
                                </div>
                                <div className="flex justify-between font-bold text-emerald-800">
                                  <span>Returned Change:</span>
                                  <span>{settings.currency}{activeReceipt.change.toFixed(2)}</span>
                                </div>
                              </>
                            )}
                          </div>

                          {/* ZRA parameters */}
                          {activeReceipt.zra && (
                            <div className="border border-slate-300 bg-slate-50/80 p-1.5 rounded-xs pb-2 mb-2 text-[7.5px] text-slate-700 flex flex-col gap-0.5">
                              <span className="font-extrabold uppercase text-slate-900 text-[8px] text-center border-b border-slate-200 pb-0.5 mb-1">✓ ZRA Fiscal Smart Invoice</span>
                              <p className="flex justify-between"><span>SME TPIN:</span> <span className="font-mono font-bold">{activeReceipt.zra.tpin}</span></p>
                              <p className="flex justify-between"><span>Classification:</span> <span className="font-mono font-bold">{activeReceipt.zra.taxBand}</span></p>
                              <p className="font-mono text-[6.5px] text-slate-500 truncate mt-0.5">FSD: {activeReceipt.zra.fiscalCode}</p>
                            </div>
                          )}

                          {/* Terms */}
                          {settings.termsAndConditions && (
                            <div className="border-b border-dashed border-slate-400 pb-2 mb-2 text-[7.5px] text-slate-600 leading-normal whitespace-pre-line truncate max-h-[45px] overflow-hidden">
                              <span className="font-bold block text-[7px] text-slate-700 uppercase">Terms & Conditions</span>
                              {settings.termsAndConditions}
                            </div>
                          )}

                          <div className="text-center text-[8px] text-slate-500 font-semibold mb-2">
                            <span>{settings.receiptFooter}</span>
                            <span className="block italic text-[7.5px] mt-0.5 text-slate-600">Thank you for shopping with us!</span>
                          </div>

                          {/* Thermal Barcode Lines */}
                          <div className="flex flex-col items-center justify-center pt-1 border-t border-dashed border-slate-300">
                            <div className="flex items-center gap-0.5 h-6 opacity-85 my-0.5">
                              <div className="w-0.5 h-full bg-slate-900" />
                              <div className="w-1 h-full bg-slate-900" />
                              <div className="w-0.5 h-full bg-slate-900" />
                              <div className="w-1.5 h-full bg-slate-900" />
                              <div className="w-0.5 h-full bg-slate-900" />
                              <div className="w-1 h-full bg-slate-900" />
                              <div className="w-2 h-full bg-slate-900" />
                              <div className="w-0.5 h-full bg-slate-900" />
                              <div className="w-1 h-full bg-slate-900" />
                              <div className="w-1.5 h-full bg-slate-900" />
                              <div className="w-0.5 h-full bg-slate-900" />
                              <div className="w-1 h-full bg-slate-900" />
                              <div className="w-2 h-full bg-slate-900" />
                              <div className="w-0.5 h-full bg-slate-900" />
                              <div className="w-1 h-full bg-slate-900" />
                              <div className="w-0.5 h-full bg-slate-900" />
                            </div>
                            <span className="text-[7px] tracking-widest font-mono text-slate-600 font-bold">*{activeReceipt.id}*</span>
                          </div>
                        </div>
                      </div>

                      {/* Print and PDF Triggers */}
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => safeSystemPrint()}
                          className="py-2.5 bg-indigo-650 hover:bg-indigo-700 text-white text-[10px] font-black rounded-xl cursor-pointer flex items-center justify-center gap-1.5 shadow-3xs transition-all uppercase tracking-wider font-sans"
                        >
                          <Printer size={12} />
                          PRINT RECEIPT
                        </button>
                        <button
                          type="button"
                          onClick={() => generatePdfReceipt(activeReceipt, '58mm')}
                          className="py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-extrabold rounded-xl cursor-pointer flex items-center justify-center gap-1.5 transition-all uppercase tracking-wider font-sans border border-slate-250"
                        >
                          <Download size={12} />
                          DOWNLOAD PDF
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* RECEIPT VIEW PAPER POPPER DIALOG OVERLAY */}
      <AnimatePresence>
        {activeReceipt && !showPaymentModal && (
          <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
            <motion.div
              initial={{ y: -40, opacity: 0, scale: 0.95 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 45, opacity: 0, scale: 0.95 }}
              className="flex flex-col md:flex-row items-center md:items-start justify-center gap-6 max-h-[92vh] w-full max-w-2xl overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-indigo-950/40"
            >
              {/* PRINTABLE SIMULATED PAPER TICKET */}
              <div className="flex flex-col items-center shrink-0">
                <div
                  id="thermal-receipt-printable-segment"
                  className="bg-[#FCFCFA] border border-slate-350 shadow-2xl p-6 w-[290px] text-left text-slate-900 flex flex-col receipt-times-font rounded-xs document-print-section shrink-0 relative"
                  style={{ fontFamily: '"Times New Roman", Times, serif' }}
                >
                {/* Top receipt decorative border accent */}
                <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-600 rounded-t-xs print:hidden" />

                {/* Header */}
                <div className="text-center border-b-2 border-double border-slate-800 pb-3 mb-3 flex flex-col gap-0.5 select-none text-slate-800">
                  {(settings.logoUrl || DEFAULT_COMPANY_LOGO) && (
                    <div className="flex justify-center mb-1.5">
                      <img src={settings.logoUrl || DEFAULT_COMPANY_LOGO} alt="Company Logo" className="max-h-12 max-w-[100px] object-contain rounded-xs" referrerPolicy="no-referrer" />
                    </div>
                  )}
                  <span className="font-extrabold text-slate-900 text-sm tracking-wider uppercase block">{settings.storeName}</span>
                  <span className="font-bold text-[8.5px] text-slate-700 uppercase tracking-widest block">*** OFFICIAL TAX INVOICE & RECEIPT ***</span>
                  {settings.tpin && (
                    <span className="text-[9px] font-bold text-slate-700 tracking-wider block">TPIN: {settings.tpin}</span>
                  )}
                  <span className="text-[9.5px] font-semibold text-slate-600">{settings.receiptHeader}</span>
                </div>

                {/* Metadata Card */}
                <div className="flex flex-col gap-1 border-b border-dashed border-slate-400 pb-2.5 mb-2.5 text-[9px]">
                  <div className="flex justify-between">
                    <span className="font-bold text-slate-700">INVOICE NO:</span>
                    <span className="font-bold text-indigo-950 font-mono">{activeReceipt.id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-bold text-slate-700">DATE / TIME:</span>
                    <span>{activeReceipt.date}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-bold text-slate-700">BRANCH HUB:</span>
                    <span>{activeStore.toUpperCase()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-bold text-slate-700">CASHIER / REP:</span>
                    <span>{(activeReceipt.performed_by || localStorage.getItem('logged_in_user_name') || 'Cashier').toUpperCase()}</span>
                  </div>
                  {activeReceipt.customer && (
                    <div className="flex justify-between">
                      <span className="font-bold text-slate-700">CUSTOMER:</span>
                      <span>{activeReceipt.customer.name}</span>
                    </div>
                  )}
                </div>

                {activeReceipt.offlinePending && (
                  <div className="bg-amber-50 rounded-xs border border-amber-300 p-2 text-[9px] text-amber-800 text-center uppercase font-sans font-bold tracking-wider mb-3 leading-snug animate-pulse select-none">
                    ⚠️ Offline Receipt (Pending Sync)
                  </div>
                )}

                {/* Items Table Header */}
                <div className="grid grid-cols-12 gap-1 border-b border-slate-800 pb-1 mb-1 font-bold text-[9px] text-slate-900 uppercase">
                  <span className="col-span-6">ITEM DESCRIPTION</span>
                  <span className="col-span-2 text-center">QTY</span>
                  <span className="col-span-4 text-right">TOTAL</span>
                </div>

                {/* Items */}
                <div className="flex flex-col gap-1.5 border-b border-dashed border-slate-400 pb-2.5 mb-2.5 text-[9.5px]">
                  {activeReceipt.items.map((x: any, i: number) => (
                    <div key={i} className="flex flex-col gap-0.5">
                      <div className="flex justify-between items-start text-slate-900">
                        <span className="font-bold flex-1 pr-2">{x.product.name}</span>
                        <span className="font-bold shrink-0">{settings.currency}{(x.product.price * x.quantity).toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-[8px] text-slate-500 pl-1">
                        <span>{x.quantity} x {settings.currency}{x.product.price.toFixed(2)}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Calculations Summary */}
                <div className="flex flex-col gap-1 border-b border-dashed border-slate-400 pb-2.5 mb-2.5 text-[9.5px]">
                  <div className="flex justify-between text-slate-600">
                    <span>Subtotal:</span>
                    <span>{settings.currency}{activeReceipt.subtotal.toFixed(2)}</span>
                  </div>
                  {activeReceipt.discount > 0 && (
                    <div className="flex justify-between text-rose-700 font-bold">
                      <span>Discount:</span>
                      <span>-{settings.currency}{activeReceipt.discount.toFixed(2)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-slate-600">
                    <span>VAT ({settings.taxRate}%):</span>
                    <span>{settings.currency}{activeReceipt.tax.toFixed(2)}</span>
                  </div>
                </div>

                {/* Grand Total Highlight Box */}
                <div className="border-2 border-slate-900 bg-slate-50 p-2 my-1 rounded-xs flex justify-between items-center text-slate-900">
                  <span className="font-black text-xs uppercase">GRAND TOTAL:</span>
                  <span className="font-black text-sm text-indigo-950">{settings.currency}{activeReceipt.total.toFixed(2)}</span>
                </div>

                {/* Payment Details */}
                <div className="flex flex-col gap-1 text-[9px] text-slate-800 mb-3 my-1">
                  <div className="flex justify-between">
                    <span className="font-bold text-slate-700">Payment Channel:</span>
                    <strong className="text-slate-900 uppercase">{activeReceipt.paymentMethod}</strong>
                  </div>
                  {activeReceipt.paymentMethod === 'Cash' && (
                    <>
                      <div className="flex justify-between text-slate-600">
                        <span>Cash Tendered:</span>
                        <strong>{settings.currency}{activeReceipt.cashReceived.toFixed(2)}</strong>
                      </div>
                      <div className="flex justify-between text-emerald-800 font-bold bg-emerald-50 px-1 py-0.5 rounded-xs border border-dashed border-emerald-200">
                        <span>Returned Change:</span>
                        <strong>{settings.currency}{activeReceipt.change.toFixed(2)}</strong>
                      </div>
                    </>
                  )}
                  {activeReceipt.paymentMethod === 'Split' && activeReceipt.splitBreakdown && (
                    <div className="flex flex-col gap-1 mt-1">
                      <div className="flex justify-between bg-teal-50 text-teal-800 px-1 py-0.5 rounded-xs border border-dashed border-teal-200 text-[8.5px]">
                        <span>✓ Cash Portion:</span>
                        <strong>{settings.currency}{activeReceipt.splitBreakdown.cash.toFixed(2)}</strong>
                      </div>
                      <div className="flex justify-between bg-purple-50 text-purple-800 px-1 py-0.5 rounded-xs border border-dashed border-purple-200 text-[8.5px]">
                        <span>✓ Mobile Money:</span>
                        <strong>{settings.currency}{activeReceipt.splitBreakdown.mobile.toFixed(2)}</strong>
                      </div>
                      {activeReceipt.change > 0 && (
                        <div className="flex justify-between bg-emerald-50 text-emerald-800 px-1 py-0.5 rounded-xs border border-dashed border-emerald-200 text-[8.5px] font-bold">
                          <span>✓ Returned Cash Change:</span>
                          <strong>{settings.currency}{activeReceipt.change.toFixed(2)}</strong>
                        </div>
                      )}
                    </div>
                  )}
                  {activeReceipt.customer && (
                    <div className="p-1.5 mt-2 bg-indigo-50/60 border border-indigo-150 text-[8.5px] rounded-md font-sans">
                      <p className="font-bold text-indigo-900 flex justify-between"><span>Account Profile:</span> <span>{activeReceipt.customer.name}</span></p>
                      <p className="text-indigo-700 mt-0.5 flex justify-between"><span>Accrued Loyalty Points:</span> <span>+{Math.floor(activeReceipt.total * settings.loyaltyRatio)} PTS</span></p>
                    </div>
                  )}
                </div>

                {/* ZRA Fiscal parameters */}
                {activeReceipt.zra && (
                  <div className="border border-slate-300 bg-slate-50/80 p-2 rounded-xs pb-2 mb-2.5 text-[8px] text-slate-700 flex flex-col gap-1">
                    <span className="font-extrabold uppercase text-slate-900 text-[8.5px] text-center border-b border-slate-200 pb-1 mb-0.5">✓ ZRA Fiscal Smart Invoice</span>
                    <p className="flex justify-between"><span>SME TPIN:</span> <span className="font-mono font-bold text-slate-900">{activeReceipt.zra.tpin}</span></p>
                    <p className="flex justify-between"><span>Classification:</span> <span className="font-mono font-bold text-slate-900">{activeReceipt.zra.taxBand}</span></p>
                    <p className="font-mono text-[7px] text-slate-500 truncate mt-0.5">FSD CODE: {activeReceipt.zra.fiscalCode}</p>
                  </div>
                )}

                {/* Terms & Conditions */}
                {settings.termsAndConditions && (
                  <div className="border-t border-dashed border-slate-400 pt-2 pb-2 text-[8px] text-slate-600 leading-relaxed">
                    <span className="font-extrabold uppercase text-slate-800 block tracking-wider">Terms & Conditions</span>
                    <div className="whitespace-pre-line font-mono text-slate-500 mt-0.5">{settings.termsAndConditions}</div>
                  </div>
                )}

                {/* Thermal feedback */}
                <div className="text-center text-[9px] text-slate-500 font-semibold pb-2">
                  <span>{settings.receiptFooter}</span>
                  <span className="block italic text-[8px] mt-0.5 text-slate-600">Thank you for shopping with us!</span>
                </div>

                {/* Thermal Barcode Lines */}
                <div className="flex flex-col items-center justify-center pt-2 border-t border-dashed border-slate-300">
                  <div className="flex items-center gap-0.5 h-7 opacity-90 my-0.5">
                    <div className="w-0.5 h-full bg-slate-900" />
                    <div className="w-1 h-full bg-slate-900" />
                    <div className="w-0.5 h-full bg-slate-900" />
                    <div className="w-1.5 h-full bg-slate-900" />
                    <div className="w-0.5 h-full bg-slate-900" />
                    <div className="w-1 h-full bg-slate-900" />
                    <div className="w-2 h-full bg-slate-900" />
                    <div className="w-0.5 h-full bg-slate-900" />
                    <div className="w-1 h-full bg-slate-900" />
                    <div className="w-1.5 h-full bg-slate-900" />
                    <div className="w-0.5 h-full bg-slate-900" />
                    <div className="w-1 h-full bg-slate-900" />
                    <div className="w-2 h-full bg-slate-900" />
                    <div className="w-0.5 h-full bg-slate-900" />
                    <div className="w-1 h-full bg-slate-900" />
                    <div className="w-0.5 h-full bg-slate-900" />
                  </div>
                  <span className="text-[7.5px] tracking-widest font-mono text-slate-600 font-bold">*{activeReceipt.id}*</span>
                </div>
              </div>

                {/* INTEGRATED DIRECT DIAL WHATSAPP PREVIEW RIG (ALWAYS VISIBLE ABOVE-THE-FOLD, HIDDEN ON PAPER PRINT) */}
                <div className="mt-4 pt-4 border-t border-dashed border-slate-300 print:hidden font-sans flex flex-col gap-2 bg-slate-50/80 p-3 rounded-lg border border-slate-200 text-left">
                  <div className="flex items-center gap-1.5 text-emerald-600 font-extrabold text-[10px] uppercase tracking-wider">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    WhatsApp dispatch
                  </div>
                  <p className="text-[8.5px] text-slate-500 leading-snug">
                    Provide the customer's WhatsApp mobile number below to compile and transmit the PDF digital invoice.
                  </p>
                  
                  <div className="flex flex-col gap-1.5 mt-1">
                    <input
                      type="tel"
                      value={whatsappPhone}
                      onChange={(e) => setWhatsappPhone(e.target.value)}
                      placeholder="+260 97 XXXXXX"
                      className="w-full text-xs px-2.5 py-1.5 bg-white border border-slate-300 text-slate-800 font-mono font-extrabold rounded focus:outline-hidden focus:border-indigo-500"
                    />
                    <button
                      type="button"
                      onClick={() => handleWhatsAppSend()}
                      className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] rounded font-black tracking-wider uppercase flex items-center justify-center gap-1 cursor-pointer transition-all active:scale-98"
                    >
                      <Send size={11} />
                      Send WhatsApp Dispatch
                    </button>
                  </div>
                </div>
              </div>

              {/* ACTION OPERATIONS CONSOLE PANEL (HIDDEN IN ACTUAL PAPER PRINT) */}
              <div
                className="w-[290px] bg-slate-900 border border-slate-800 text-white rounded-xl p-5 flex flex-col gap-4 shadow-2xl select-none print:hidden shrink-0 font-sans"
              >
                <div className="border-b border-slate-800 pb-3 flex flex-col gap-0.5 text-left">
                  <div className="flex items-center gap-1.5 text-emerald-400 font-extrabold text-xs uppercase tracking-wider">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    Transaction Complete
                  </div>
                  <span className="text-[10px] text-slate-400 font-mono font-bold">INVOICE: {activeReceipt.id}</span>
                </div>

                {/* WhatsApp Dispatcher Section */}
                <form
                  onSubmit={handleWhatsAppSend}
                  className="bg-slate-950/80 border border-slate-800 p-3 rounded-lg flex flex-col gap-2 shadow-inner text-left"
                >
                  <label className="text-[10px] text-slate-300 font-black uppercase tracking-wider flex items-center gap-1.5">
                    📱 SHARE VIA WHATSAPP
                  </label>
                  <p className="text-[8.5px] text-slate-450 leading-snug">
                    Provide the customer's WhatsApp-registered number below to trigger auto-dispatch.
                  </p>
                  
                  <div className="flex flex-col gap-1.5 mt-1">
                    <input
                      type="tel"
                      value={whatsappPhone}
                      onChange={(e) => setWhatsappPhone(e.target.value)}
                      placeholder="+260 97 XXXXXX"
                      className="w-full text-xs px-2.5 py-1.5 bg-slate-900 border border-slate-700 text-teal-300 font-mono font-extrabold rounded focus:outline-hidden focus:border-teal-500 text-left placeholder-slate-600"
                    />
                    <button
                      type="submit"
                      className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-[10.5px] rounded font-black tracking-wider uppercase flex items-center justify-center gap-1.5 cursor-pointer shadow-md transition-all active:scale-98"
                    >
                      <Send size={11} />
                      Send WhatsApp
                    </button>
                  </div>
                </form>

                {/* Print Triggers Section */}
                <div className="flex flex-col gap-2 bg-slate-950/40 p-3 border border-slate-850 rounded-lg text-left">
                  <label className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wide">
                    🖨️ Terminal Port Outputs & Fallbacks
                  </label>
                  
                  <div className="grid grid-cols-1 gap-1.5 mt-1">
                    <div className="flex flex-col gap-1.5 bg-slate-950/60 p-2.5 rounded-lg border border-slate-850">
                      <label className="text-[9px] text-slate-300 font-extrabold uppercase tracking-wide">
                        📐 THERMAL ROLL PAPER WIDTH
                      </label>
                      <div className="grid grid-cols-2 gap-1 bg-slate-900 p-1 rounded-md border border-slate-800">
                        <button
                          type="button"
                          onClick={() => setPreviewPaperSize('58mm')}
                          className={`py-1 text-[9.5px] font-bold rounded-xs cursor-pointer transition-colors text-center ${
                            previewPaperSize === '58mm'
                              ? 'bg-indigo-600 text-white font-extrabold shadow-sm'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          58mm (Compact)
                        </button>
                        <button
                          type="button"
                          onClick={() => setPreviewPaperSize('80mm')}
                          className={`py-1 text-[9.5px] font-bold rounded-xs cursor-pointer transition-colors text-center ${
                            previewPaperSize === '80mm'
                              ? 'bg-indigo-600 text-white font-extrabold shadow-sm'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          80mm (Standard)
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => generatePdfReceipt(activeReceipt, previewPaperSize === '80mm' ? '80mm' : '58mm')}
                        className="w-full mt-1 py-2 bg-teal-600 hover:bg-teal-700 text-white text-[10px] font-black rounded-lg cursor-pointer flex items-center justify-center gap-1.5 shadow-xs transition-colors uppercase tracking-wider"
                      >
                        <Download size={11} />
                        Download {previewPaperSize === '80mm' ? '80mm' : '58mm'} Thermal PDF
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={handleCopyPlaintextReceipt}
                      className="w-full py-2 bg-slate-850 hover:bg-slate-805 text-amber-300 text-[10px] font-black rounded-lg cursor-pointer flex items-center justify-center gap-1.5 border border-slate-750 shadow-xs transition-colors"
                    >
                      <Copy size={11} />
                      COPY TEXT TICKET FOR BT PRINTERS
                    </button>

                    <div className="border-t border-slate-850 my-1" />

                    <button
                      type="button"
                      onClick={() => {
                        setPendingPrintMode('bluetooth');
                        setShowReceiptHtmlPreview(true);
                      }}
                      disabled={isBtPrinting}
                      className="w-full py-2 bg-indigo-650 hover:bg-indigo-700 disabled:bg-slate-800 disabled:text-slate-500 text-white text-[10px] font-black rounded-lg cursor-pointer flex items-center justify-center gap-1.5 border border-indigo-600 shadow-sm transition-colors"
                    >
                      <Smartphone size={11} className={isBtPrinting ? 'animate-spin text-amber-300' : ''} />
                      {isBtPrinting ? 'TRANSMITTING...' : 'BLUETOOTH PRINT PREVIEW'}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setPendingPrintMode('system');
                        setShowReceiptHtmlPreview(true);
                      }}
                      className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-extrabold rounded-lg cursor-pointer flex items-center justify-center gap-1.5 border border-slate-750 shadow-3xs transition-colors"
                    >
                      <Printer size={11} />
                      SYSTEM PRINT PREVIEW
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setPendingPrintMode(null);
                        setShowReceiptHtmlPreview(true);
                      }}
                      className="w-full py-2 bg-emerald-600 hover:bg-emerald-750 text-white text-[10px] font-black rounded-lg cursor-pointer flex items-center justify-center gap-1.5 shadow-xs transition-colors"
                    >
                      <Printer size={11} />
                      HTML RECEIPT PREVIEW
                    </button>
                  </div>
                </div>

                {/* Tear Off / New Sale Action */}
                <button
                  type="button"
                  onClick={() => {
                    setActiveReceipt(null);
                    setCheckoutStep('customer');
                    setShowPaymentModal(false);
                    loadInvoices();
                    handleTriggerCashUp();
                    refreshDbData();
                    persistTablesToStorage();
                  }}
                  className="w-full mt-2 py-3 bg-white hover:bg-slate-100 text-slate-950 font-black text-xs uppercase rounded-lg text-center cursor-pointer tracking-wider border border-slate-200 shadow-lg active:scale-95 transition-all"
                >
                  TEAR OFF / NEW SALE
                </button>
              </div>

            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MODAL: BLUETOOTH THERMAL PRINTER MANAGER */}
      <AnimatePresence>
        {showBluetoothPanel && (
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-slate-900 border border-slate-800 text-white rounded-2xl shadow-2xl w-full max-w-md p-5 flex flex-col gap-4 text-left select-none"
            >
              {/* Header */}
              <div className="flex justify-between items-center border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <Smartphone className="text-indigo-400 animate-pulse" size={18} />
                  <div>
                    <h3 className="text-xs font-black uppercase tracking-wider text-slate-100">Bluetooth Printer Center</h3>
                    <p className="text-[9px] text-indigo-400 font-mono font-bold mt-0.5">ESC/POS 58MM TICKET REGISTRY</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowBluetoothPanel(false)} 
                  className="text-slate-400 hover:text-white font-extrabold cursor-pointer text-sm"
                >
                  ✕
                </button>
              </div>

              {/* Connected accessory state / pairing banner */}
              <div className="bg-slate-950/60 border border-slate-850 p-4 rounded-xl flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Device Status:</span>
                  <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${
                      pairedBluetoothDevice ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
                    }`}></span>
                    <span className="text-[11px] font-mono font-black uppercase">
                      {pairedBluetoothDevice ? 'Connected / Paired' : 'Hardware Disconnected'}
                    </span>
                  </div>
                </div>

                {pairedBluetoothDevice ? (
                  <div className="flex items-center justify-between bg-slate-900/60 p-2.5 rounded-lg border border-slate-800">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs font-bold text-indigo-300">{pairedBluetoothDevice.name || 'Unnamed BLE Printer'}</span>
                      <span className="text-[9px] font-mono text-slate-500">ID: {pairedBluetoothDevice.id.slice(0, 16)}...</span>
                    </div>
                    <button
                      onClick={disconnectBluetoothPrinter}
                      className="px-2.5 py-1 bg-rose-950/60 hover:bg-rose-900/80 border border-rose-900 rounded-md text-[10px] font-bold text-rose-300 cursor-pointer transition-colors"
                    >
                      Disconnect
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <p className="text-[10.5px] text-slate-400 leading-relaxed font-medium">
                      Pair with any portable BLE thermal receipt printer to directly trigger physical paper ticket feeds from your terminal checkout sales!
                    </p>
                    <button
                      onClick={connectBluetoothPrinter}
                      disabled={bluetoothStatus === 'connecting'}
                      className="w-full py-2 bg-indigo-600 hover:bg-indigo-505 text-white text-[11px] font-extrabold rounded-lg cursor-pointer transition-all flex items-center justify-center gap-1.5 shadow-sm shadow-indigo-600/30 active:scale-98"
                    >
                      <Smartphone size={12} className={bluetoothStatus === 'connecting' ? 'animate-spin' : ''} />
                      {bluetoothStatus === 'connecting' ? 'PAIRING CHANNELS...' : 'SEARCH & PAIR BLE PRINTER'}
                    </button>
                  </div>
                )}

                {/* Error Box */}
                {bluetoothErrorMessage && (
                  <div className="bg-rose-950/40 border border-rose-900/60 text-rose-200 text-[10px] p-2.5 rounded-lg flex flex-col gap-1 leading-snug font-medium mt-1">
                    <span className="font-bold text-rose-400 uppercase tracking-widest text-[9px] font-mono">⚠️ System Notice:</span>
                    <span>{bluetoothErrorMessage}</span>
                  </div>
                )}
              </div>

              {/* Simulated Feed Monitor and ESC/POS HEX dump */}
              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Active Sale Ticket Payload Trace:</span>
                
                {/* Visual Tabs and Code streams */}
                <div className="grid grid-cols-2 gap-2 text-[10px] bg-slate-950/40 p-1.5 rounded-lg border border-slate-850">
                  <div className="flex flex-col gap-1">
                    <span className="font-bold text-slate-500 font-mono text-[9px] uppercase tracking-wider">ESC/POS Text Layout</span>
                    <pre className="p-2 bg-black/80 rounded-md border border-slate-850 h-32 overflow-y-auto text-[8.5px] font-mono leading-tight text-indigo-200 whitespace-pre scrollbar-thin">
                      {btEscPosText || '// Trigger "BLUETOOTH PRINT" to build ESC/POS characters'}
                    </pre>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="font-bold text-slate-500 font-mono text-[9px] uppercase tracking-wider">Raw ESC/POS Hex Bytes</span>
                    <pre className="p-2 bg-black/80 rounded-md border border-slate-850 h-32 overflow-y-auto text-[8px] font-mono leading-relaxed text-emerald-400 break-all whitespace-pre-wrap select-all scrollbar-thin">
                      {btEscPosHex || '// Hexadecimal bytes stream formatted for printer'}
                    </pre>
                  </div>
                </div>

                <div className="flex items-center justify-between text-[9px] text-slate-500 font-mono mt-1 border-t border-slate-850 pt-2">
                  <span>Formatting: ESC/POS (58mm 32-col)</span>
                  <span>Baud Rate: 9600 bps over BLE</span>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-2 mt-2">
                {/* Simulated print button to bypass browser sandboxing if Bluetooth is blocked */}
                <button
                  type="button"
                  onClick={() => {
                    setIsBtPrinting(true);
                    setTimeout(() => {
                      setIsBtPrinting(false);
                      setBtSuccess(true);
                      alert('✓ Print Simulation Complete! Payload stream dispatched to local terminal mock memory buffers.');
                    }, 800);
                  }}
                  className="py-2.5 bg-slate-800 hover:bg-slate-750 text-[11px] font-extrabold uppercase rounded-lg border border-slate-700 text-slate-300 cursor-pointer active:scale-98 transition-all"
                >
                  Test Print Simulation
                </button>
                <button
                  type="button"
                  onClick={() => setShowBluetoothPanel(false)}
                  className="py-2.5 bg-indigo-600 hover:bg-indigo-550 text-[11px] font-extrabold uppercase rounded-lg text-white cursor-pointer active:scale-98 transition-all"
                >
                  Confirm & Back
                </button>
              </div>

            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MODAL 3: EOD BALANCING CASH UP VIEW */}
      <AnimatePresence>
        {showCashUpModal && cashUpSummary && (
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-slate-900 border border-slate-800 text-white rounded-2xl shadow-2xl w-full max-w-2xl p-5 flex flex-col gap-4 text-left select-none max-h-[90vh] overflow-y-auto scrollbar-thin"
            >
              {/* Header */}
              <div className="flex justify-between items-center border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <Activity className="text-emerald-400 animate-pulse" size={18} />
                  <div>
                    <h3 className="text-xs font-black uppercase tracking-wider text-slate-100">Daily Cash-Up Reconciliation</h3>
                    <p className="text-[9px] text-emerald-400 font-mono font-bold mt-0.5">EOD DRAWER AUDIT & RECONCILIATION LEDGER</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowCashUpModal(false)}
                  className="text-slate-400 hover:text-white font-extrabold cursor-pointer text-sm"
                >
                  ✕
                </button>
              </div>

              {/* Tabs */}
              <div className="grid grid-cols-2 gap-2 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs text-center font-bold">
                <button
                  type="button"
                  onClick={() => setCashUpActiveTab('reconcile')}
                  className={`py-1.5 rounded-md cursor-pointer transition-all ${
                    cashUpActiveTab === 'reconcile'
                      ? 'bg-emerald-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  ⚖️ Reconcile Active Session
                </button>
                <button
                  type="button"
                  onClick={() => {
                    loadReconciliationHistory();
                    setCashUpActiveTab('history');
                  }}
                  className={`py-1.5 rounded-md cursor-pointer transition-all ${
                    cashUpActiveTab === 'history'
                      ? 'bg-emerald-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  📜 Audit History ({reconciliationHistory.length})
                </button>
              </div>

              {cashUpActiveTab === 'reconcile' ? (
                <>
                  {/* Filter Controls Bar */}
                  <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 flex flex-wrap items-center gap-3">
                    {/* Business Date */}
                    <div className="flex flex-col gap-1 flex-1 min-w-[130px]">
                      <label className="text-[9px] text-slate-400 font-extrabold uppercase tracking-wider">Business Date</label>
                      <input
                        type="date"
                        value={cashUpDate}
                        onChange={(e) => {
                          const d = e.target.value;
                          setCashUpDate(d);
                          handleTriggerCashUp(d, cashUpStore, cashUpCashier);
                        }}
                        className="px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono font-bold text-slate-200 focus:outline-none focus:border-emerald-500 cursor-pointer"
                      />
                    </div>

                    {/* Store / Branch Selector */}
                    <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
                      <label className="text-[9px] text-slate-400 font-extrabold uppercase tracking-wider">Store / Branch</label>
                      <select
                        value={cashUpStore}
                        onChange={(e) => {
                          const s = e.target.value;
                          setCashUpStore(s);
                          handleTriggerCashUp(cashUpDate, s, cashUpCashier);
                        }}
                        className="px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs font-semibold text-slate-200 focus:outline-none focus:border-emerald-500 cursor-pointer uppercase"
                      >
                        <option value="all">🏢 All Branches</option>
                        {loginStores.map((st: any) => (
                          <option key={st.id} value={st.id}>{st.name || st.id}</option>
                        ))}
                      </select>
                    </div>

                    {/* Cashier / Staff Selector */}
                    <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
                      <label className="text-[9px] text-slate-400 font-extrabold uppercase tracking-wider">Cashier / Staff</label>
                      <select
                        value={cashUpCashier}
                        onChange={(e) => {
                          const c = e.target.value;
                          setCashUpCashier(c);
                          handleTriggerCashUp(cashUpDate, cashUpStore, c);
                        }}
                        className="px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs font-semibold text-slate-200 focus:outline-none focus:border-emerald-500 cursor-pointer"
                      >
                        <option value="all">👤 All Cashiers</option>
                        {supervisors.map((sp: any) => {
                          const name = `${sp.first_name} ${sp.surname}`;
                          return <option key={sp.id} value={name}>{name}</option>;
                        })}
                      </select>
                    </div>
                  </div>

                  {/* Daily Sales Overview Summary Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    {/* Total Sales */}
                    <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800 flex flex-col gap-0.5">
                      <span className="text-[8.5px] font-extrabold uppercase text-slate-400 tracking-wider">Total Sales</span>
                      <span className="text-sm font-black font-mono text-emerald-400">{settings.currency}{(cashUpSummary ? cashUpSummary.totalSales : 0).toFixed(2)}</span>
                      <span className="text-[8px] text-slate-500 font-mono font-bold">{cashUpSummary ? cashUpSummary.totalTxCount : 0} Completed Sales</span>
                    </div>

                    {/* Expected Cash */}
                    <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800 flex flex-col gap-0.5">
                      <span className="text-[8.5px] font-extrabold uppercase text-slate-400 tracking-wider">Expected Cash</span>
                      <span className="text-sm font-black font-mono text-amber-400">{settings.currency}{(cashUpSummary ? cashUpSummary.expectedCash : 0).toFixed(2)}</span>
                      <span className="text-[8px] text-slate-500 font-mono font-bold">Float + Cash Sales - Exp</span>
                    </div>

                    {/* Actual Counted */}
                    <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800 flex flex-col gap-0.5">
                      <span className="text-[8.5px] font-extrabold uppercase text-slate-400 tracking-wider">Actual Cash</span>
                      <span className="text-sm font-black font-mono text-indigo-300">{settings.currency}{(parseFloat(cashCounted) || 0).toFixed(2)}</span>
                      <span className="text-[8px] text-slate-500 font-mono font-bold">Physical Count</span>
                    </div>

                    {/* Cash Difference */}
                    {(() => {
                      const exp = cashUpSummary ? cashUpSummary.expectedCash : 0;
                      const act = parseFloat(cashCounted) || 0;
                      const diff = act - exp;
                      const isExact = Math.abs(diff) < 0.01;
                      const isShort = diff < -0.01;
                      return (
                        <div className={`p-2.5 rounded-xl border flex flex-col gap-0.5 ${
                          isExact ? 'bg-emerald-950/40 border-emerald-800/80' :
                          isShort ? 'bg-rose-950/40 border-rose-800/80' :
                          'bg-blue-950/40 border-blue-800/80'
                        }`}>
                          <span className="text-[8.5px] font-extrabold uppercase text-slate-300 tracking-wider">Cash Difference</span>
                          <span className={`text-sm font-black font-mono ${
                            isExact ? 'text-emerald-400' : isShort ? 'text-rose-400' : 'text-blue-400'
                          }`}>
                            {isExact ? `${settings.currency}0.00` : `${diff > 0 ? '+' : ''}${settings.currency}${diff.toFixed(2)}`}
                          </span>
                          <span className={`text-[8.5px] font-black uppercase font-mono tracking-wider ${
                            isExact ? 'text-emerald-300' : isShort ? 'text-rose-300' : 'text-blue-300'
                          }`}>
                            {isExact ? '✓ EXACT' : isShort ? `SHORT ${settings.currency}${Math.abs(diff).toFixed(2)}` : `OVER ${settings.currency}${diff.toFixed(2)}`}
                          </span>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Payment Method Breakdown Box */}
                  <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800 flex flex-col gap-2">
                    <span className="text-[10px] text-slate-300 font-black uppercase tracking-wider font-sans border-b border-slate-850 pb-1">
                      Payment Method Breakdown
                    </span>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-[10px]">
                      <div className="bg-slate-900/80 p-2 rounded-lg border border-slate-800 flex justify-between items-center">
                        <span className="text-slate-400 font-sans font-bold">💵 Cash Sales</span>
                        <span className="font-bold text-amber-300">{settings.currency}{salesCashSum.toFixed(2)}</span>
                      </div>
                      <div className="bg-slate-900/80 p-2 rounded-lg border border-slate-800 flex justify-between items-center">
                        <span className="text-slate-400 font-sans font-bold">📱 Airtel Money</span>
                        <span className="font-bold text-rose-300">{settings.currency}{salesAirtelSum.toFixed(2)}</span>
                      </div>
                      <div className="bg-slate-900/80 p-2 rounded-lg border border-slate-800 flex justify-between items-center">
                        <span className="text-slate-400 font-sans font-bold">📱 MTN Money</span>
                        <span className="font-bold text-amber-400">{settings.currency}{salesMtnSum.toFixed(2)}</span>
                      </div>
                      <div className="bg-slate-900/80 p-2 rounded-lg border border-slate-800 flex justify-between items-center">
                        <span className="text-slate-400 font-sans font-bold">📱 Zamtel Money</span>
                        <span className="font-bold text-emerald-300">{settings.currency}{salesZamtelSum.toFixed(2)}</span>
                      </div>
                      <div className="bg-slate-900/80 p-2 rounded-lg border border-slate-800 flex justify-between items-center">
                        <span className="text-slate-400 font-sans font-bold">💳 Bank / Card</span>
                        <span className="font-bold text-indigo-300">{settings.currency}{salesCardSum.toFixed(2)}</span>
                      </div>
                      <div className="bg-slate-900/80 p-2 rounded-lg border border-slate-800 flex justify-between items-center">
                        <span className="text-slate-400 font-sans font-bold">🔄 Other / Split</span>
                        <span className="font-bold text-slate-200">{settings.currency}{(salesOtherMomoSum + salesOtherSum).toFixed(2)}</span>
                      </div>
                      {laybyCashSum > 0 && (
                        <div className="bg-slate-900/80 p-2 rounded-lg border border-slate-800 flex justify-between items-center col-span-2 sm:col-span-1">
                          <span className="text-slate-400 font-sans font-bold">📑 Layby Cash</span>
                          <span className="font-bold text-emerald-400">+{settings.currency}{laybyCashSum.toFixed(2)}</span>
                        </div>
                      )}
                      {cashExpensesSum > 0 && (
                        <div className="bg-slate-900/80 p-2 rounded-lg border border-slate-800 flex justify-between items-center col-span-2 sm:col-span-1">
                          <span className="text-slate-400 font-sans font-bold">💸 Cash Out / Exp</span>
                          <span className="font-bold text-rose-400">-{settings.currency}{cashExpensesSum.toFixed(2)}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Body Content: Counted Drawer Inputs */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Column 1: Counted Drawer Inputs */}
                    <div className="flex flex-col gap-3 bg-slate-950/40 p-3 rounded-xl border border-slate-850">
                      <span className="text-[10px] text-slate-300 font-black uppercase tracking-wider block border-b border-slate-850 pb-1 font-sans">Enter Physical Drawer Counts</span>
                      
                      {/* Cash Input */}
                      <div className="flex flex-col gap-1">
                        <div className="flex justify-between items-center text-[10px] font-bold text-slate-400">
                          <label className="flex items-center gap-1 font-sans">
                            <Coins size={11} className="text-amber-500" />
                            <span>1. CASH DRAWER COUNTED</span>
                          </label>
                          <button
                            type="button"
                            onClick={() => setShowDenomHelper(!showDenomHelper)}
                            className="text-[10px] text-amber-500 hover:text-amber-400 underline font-black cursor-pointer transition-colors"
                          >
                            {showDenomHelper ? 'Close tally' : '🧮 Denom helper'}
                          </button>
                        </div>
                        <div className="relative">
                          <span className="absolute left-3 top-2.5 text-xs text-slate-500 font-mono font-bold">{settings.currency}</span>
                          <input
                            type="number"
                            placeholder="0.00"
                            value={cashCounted}
                            onChange={(e) => setCashCounted(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                              }
                            }}
                            className="w-full pl-9 pr-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono font-bold focus:outline-hidden focus:border-amber-500 text-amber-300 placeholder-slate-600"
                          />
                        </div>
                      </div>

                      {/* Denomination Counter Accordion */}
                      <AnimatePresence>
                        {showDenomHelper && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            className="bg-slate-900 border border-slate-800 p-2.5 rounded-lg flex flex-col gap-2 overflow-hidden"
                          >
                            <span className="text-[9px] font-mono font-bold text-amber-400 uppercase tracking-widest block border-b border-slate-800 pb-1">Physical Bill & Coin Tally Counter</span>
                            <div className="grid grid-cols-2 gap-2 text-[10px]">
                              {Object.keys(denominations).map((denom) => (
                                <div key={denom} className="flex items-center justify-between gap-1 bg-slate-950/65 p-1.5 rounded border border-slate-850">
                                  <span className="font-mono font-bold text-slate-400">{settings.currency}{denom}</span>
                                  <input
                                    type="number"
                                    min="0"
                                    placeholder="0"
                                    value={denominations[denom] || ''}
                                    onChange={(e) => {
                                      const qty = parseInt(e.target.value) || 0;
                                      const updatedDenoms = { ...denominations, [denom]: qty };
                                      setDenominations(updatedDenoms);
                                      
                                      // Auto sum denominations
                                      const totalCounted = Object.entries(updatedDenoms).reduce((sum, [d, q]) => {
                                        return sum + (parseFloat(d) * (q as number));
                                      }, 0);
                                      setCashCounted(totalCounted > 0 ? totalCounted.toFixed(2) : '');
                                    }}
                                    className="w-12 text-center bg-slate-900 border border-slate-800 text-[10px] font-mono text-white rounded font-bold"
                                  />
                                </div>
                              ))}
                            </div>
                            <div className="bg-amber-950/20 border border-amber-900/40 p-1.5 rounded-md flex justify-between items-center text-[10px] font-mono">
                              <span className="text-amber-400 font-bold">CALCULATED SUM:</span>
                              <span className="text-amber-300 font-black">
                                {settings.currency}
                                {Object.entries(denominations).reduce((sum, [d, q]) => sum + (parseFloat(d) * (q as number)), 0).toFixed(2)}
                              </span>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      {/* Card Input */}
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-slate-400 flex items-center gap-1 font-sans">
                          <CreditCard size={11} className="text-indigo-400" />
                          <span>2. CREDIT CARD BATCH COUNTED</span>
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-2.5 text-xs text-slate-500 font-mono font-bold">{settings.currency}</span>
                          <input
                            type="number"
                            placeholder="0.00"
                            value={cardCounted}
                            onChange={(e) => setCardCounted(e.target.value)}
                            className="w-full pl-9 pr-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono font-bold focus:outline-hidden focus:border-indigo-505 text-indigo-300 placeholder-slate-600"
                          />
                        </div>
                      </div>

                      {/* Mobile Money Input */}
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-slate-400 flex items-center gap-1 font-sans">
                          <Smartphone size={11} className="text-emerald-400" />
                          <span>3. MOBILE MONEY COUNTED</span>
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-2.5 text-xs text-slate-500 font-mono font-bold">{settings.currency}</span>
                          <input
                            type="number"
                            placeholder="0.00"
                            value={momoCounted}
                            onChange={(e) => setMomoCounted(e.target.value)}
                            className="w-full pl-9 pr-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono font-bold focus:outline-hidden focus:border-emerald-505 text-emerald-300 placeholder-slate-600"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Column 2: Reconciliation Discrepancy & Balances Table */}
                    <div className="flex flex-col gap-3 bg-slate-950/40 p-3 rounded-xl border border-slate-850 text-xs">
                      <span className="text-[10px] text-slate-300 font-black uppercase tracking-wider block border-b border-slate-850 pb-1 font-sans">Real-time Balance Variance Audit</span>

                      <div className="flex flex-col gap-2">
                        {/* 1. Cash Formula Comparison */}
                        <div className="bg-slate-900/60 p-2 text-xs rounded-lg border border-slate-800 flex flex-col gap-1">
                          <div className="flex justify-between items-center text-[10px] font-black text-amber-400 uppercase tracking-widest leading-none">
                            <span>EXPECTED CASH FORMULA</span>
                            <span>{settings.currency}{(cashUpSummary ? cashUpSummary.expectedCash : 0).toFixed(2)}</span>
                          </div>
                          <div className="pl-1.5 border-l border-slate-800 flex flex-col gap-0.5 text-slate-400 font-mono text-[9px] my-1">
                            <div className="flex justify-between">
                              <span>+ Opening Cash Float:</span>
                              <span>{settings.currency}{(parseFloat(openingCash) || 0).toFixed(2)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>+ Cash Completed Sales:</span>
                              <span>{settings.currency}{salesCashSum.toFixed(2)}</span>
                            </div>
                            {laybyCashSum > 0 && (
                              <div className="flex justify-between text-emerald-400">
                                <span>+ Layby Cash Collected:</span>
                                <span>{settings.currency}{laybyCashSum.toFixed(2)}</span>
                              </div>
                            )}
                            {cashExpensesSum > 0 && (
                              <div className="flex justify-between text-rose-400">
                                <span>- Cash Expenses / Out:</span>
                                <span>-{settings.currency}{cashExpensesSum.toFixed(2)}</span>
                              </div>
                            )}
                          </div>
                          <div className="flex justify-between items-center font-mono font-bold pt-1 border-t border-slate-850/60">
                            <span className="text-slate-400">Physical Cash Counted:</span>
                            <span className="text-amber-300">{settings.currency}{(parseFloat(cashCounted) || 0).toFixed(2)}</span>
                          </div>
                        </div>

                        {/* Summary Variance Box */}
                        <div className="bg-slate-900/80 border border-slate-800 p-2.5 rounded-lg flex flex-col gap-1 text-xs leading-normal font-mono">
                          <div className="flex justify-between items-center text-slate-400 text-[10px]">
                            <span>EXPECTED DRAWER CASH:</span>
                            <span>{settings.currency}{(cashUpSummary ? cashUpSummary.expectedCash : 0).toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between items-center text-slate-300 text-[10px]">
                            <span>ACTUAL COUNTED CASH:</span>
                            <span>{settings.currency}{(parseFloat(cashCounted) || 0).toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between items-center border-t border-slate-800 pt-1.5">
                            <span className="font-extrabold text-slate-100 uppercase text-[9px] tracking-wider font-sans">CASH DIFFERENCE:</span>
                            {(() => {
                              const exp = cashUpSummary ? cashUpSummary.expectedCash : 0;
                              const act = parseFloat(cashCounted) || 0;
                              const diff = act - exp;
                              const isExact = Math.abs(diff) < 0.01;
                              const isShort = diff < -0.01;
                              return (
                                <span className={`font-black text-xs ${
                                  isExact ? 'text-emerald-400' : isShort ? 'text-rose-400' : 'text-blue-400'
                                }`}>
                                  {isExact ? '0.00 (EXACT)' : `${diff > 0 ? '+' : ''}${settings.currency}${diff.toFixed(2)}`}
                                </span>
                              );
                            })()}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Itemized Audit Log of Today's Performed Transactions */}
                  {cashUpSummary && cashUpSummary.todayTxList && cashUpSummary.todayTxList.length > 0 && (
                    <div className="bg-slate-950/60 border border-slate-850 p-3 rounded-xl flex flex-col gap-2">
                      <div className="flex justify-between items-center border-b border-slate-850 pb-1.5">
                        <span className="text-[10px] text-slate-300 font-black uppercase tracking-wider font-sans flex items-center gap-1.5">
                          <span>🧾</span>
                          <span>Today's Transactions Performed ({cashUpSummary.todayTxList.length})</span>
                        </span>
                        <span className="text-[9px] font-mono text-emerald-400 font-bold">
                          ✓ Verified with EOD Cash-Up Formula
                        </span>
                      </div>
                      <div className="max-h-40 overflow-y-auto pr-1">
                        <table className="w-full text-[9.5px] font-mono text-left text-slate-300 border-collapse">
                          <thead>
                            <tr className="text-slate-500 border-b border-slate-850 text-[8.5px] uppercase font-sans">
                              <th className="py-1 px-1">Ref / ID</th>
                              <th className="py-1 px-1">Type</th>
                              <th className="py-1 px-1">Customer</th>
                              <th className="py-1 px-1">Payment Method</th>
                              <th className="py-1 px-1 text-right">Amount</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-850/50">
                            {cashUpSummary.todayTxList.map((tx: any, idx: number) => (
                              <tr key={idx} className="hover:bg-slate-900/50 transition-colors">
                                <td className="py-1 px-1 text-slate-400 font-mono text-[8.5px]">{tx.id}</td>
                                <td className="py-1 px-1 text-indigo-300 font-bold">{tx.type}</td>
                                <td className="py-1 px-1 text-slate-300 truncate max-w-[120px]">{tx.customer}</td>
                                <td className="py-1 px-1">
                                  <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${
                                    tx.method.includes('Cash') ? 'bg-amber-950/60 text-amber-300 border border-amber-900/40' :
                                    tx.method.includes('Mobile') ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-900/40' :
                                    'bg-indigo-950/60 text-indigo-300 border border-indigo-900/40'
                                  }`}>
                                    {tx.method}
                                  </span>
                                </td>
                                <td className="py-1 px-1 text-right font-black text-slate-100">
                                  {settings.currency}{parseFloat(tx.amount || 0).toFixed(2)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Supervisor Approval Block Checklist */}
                  <div className="p-3 bg-slate-950/60 border border-slate-850 rounded-xl flex flex-col gap-2.5 font-sans">
                    <div className="flex items-center gap-2 text-slate-200 select-none">
                      <span className="text-sm">🔑</span>
                      <div>
                        <h4 className="text-[10px] font-black uppercase tracking-wider text-slate-100 font-sans">Supervisor Sign-Off Gating</h4>
                        <p className="text-[8.5px] text-slate-500 font-sans leading-none mt-0.5">A supervisor must check the variance reports and sign off before closures.</p>
                      </div>
                    </div>

                    {!isSupervisorApproved ? (
                      <div className="flex flex-col gap-2 bg-slate-900/40 p-2.5 rounded-lg border border-slate-800/80">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          <div className="flex flex-col gap-1 text-left">
                            <label className="text-[9px] text-slate-400 font-extrabold uppercase font-sans">Select Supervisor Name</label>
                            {supervisors.length > 0 ? (
                              <select
                                value={supervisorNameInput}
                                onChange={(e) => setSupervisorNameInput(e.target.value)}
                                className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-indigo-500 rounded-md text-xs font-semibold text-slate-200 outline-hidden transition-all cursor-pointer"
                              >
                                {supervisors.map(s => {
                                  const fullName = `${s.first_name} ${s.surname}`;
                                  const role = s.basic_salary > 10000 ? 'Store Manager' : 'Sales Person';
                                  return (
                                    <option key={s.id} value={fullName}>
                                      {fullName} ({role})
                                    </option>
                                  );
                                })}
                              </select>
                            ) : (
                              <input
                                type="text"
                                placeholder="Enter Supervisor name..."
                                value={supervisorNameInput}
                                onChange={(e) => setSupervisorNameInput(e.target.value)}
                                className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-indigo-500 rounded-md text-xs font-semibold text-slate-200 outline-hidden transition-all"
                              />
                            )}
                          </div>

                          <div className="flex flex-col gap-1 text-left">
                            <label className="text-[9px] text-slate-400 font-extrabold uppercase font-sans">Supervisor Password</label>
                            <input
                              type="password"
                              placeholder="••••"
                              value={supervisorPasswordInput}
                              onChange={(e) => setSupervisorPasswordInput(e.target.value)}
                              className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 focus:border-indigo-500 rounded-md text-xs font-semibold text-slate-200 outline-hidden transition-all font-mono tracking-widest"
                            />
                          </div>
                        </div>

                        <div className="flex justify-end mt-1">
                          <button
                            type="button"
                            onClick={() => {
                              if (!supervisorNameInput.trim()) {
                                alert('Verification Error: Please select or enter a supervisor name.');
                                return;
                              }
                              
                              // Locate this supervisor in the list to check password
                              const matched = supervisors.find(s => {
                                const fullName = `${s.first_name} ${s.surname}`;
                                return fullName.trim().toLowerCase() === supervisorNameInput.trim().toLowerCase();
                              });

                              if (matched) {
                                // Default password for seed is '1234' or matched.password
                                const expectedPassword = matched.password || '1234';
                                if (supervisorPasswordInput !== expectedPassword) {
                                  alert('❌ Access Denied: Incorrect supervisor password. Please try again.');
                                  return;
                                }
                              } else {
                                // If not found in the list, fallback check
                                if (supervisorPasswordInput !== '1234') {
                                  alert('❌ Access Denied: Incorrect supervisor credentials.');
                                  return;
                                }
                              }

                              setIsSupervisorApproved(true);
                              alert(`✓ Verification Successful: Approved by ${supervisorNameInput}`);
                            }}
                            className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 active:scale-97 text-white font-black text-[9.5px] uppercase rounded-md tracking-wider transition-all cursor-pointer select-none"
                          >
                            Verify & Approve Sign-Off
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="p-2 bg-emerald-950/30 border border-emerald-900/40 rounded-lg flex items-center justify-between">
                        <div className="flex items-center gap-1.5 select-none text-[10.5px]">
                          <span className="text-emerald-400 font-extrabold">✓</span>
                          <span className="font-extrabold text-slate-300">
                            Reconciliation approved by supervisor: <strong className="text-emerald-400 font-bold">{supervisorNameInput}</strong>
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setIsSupervisorApproved(false);
                            setSupervisorNameInput('');
                          }}
                          className="text-[9px] text-rose-450 hover:underline cursor-pointer font-bold uppercase tracking-wider font-mono shrink-0"
                        >
                          Revoke
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Notes Comment Box */}
                  <div className="flex flex-col gap-1">
                    <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest font-sans">Auditor Reconciliation Remarks / Commentary</label>
                    <textarea
                      placeholder="Add matching context (e.g. cash drawer checks, card transaction settlement fee overrides, shift handovers)..."
                      value={cashUpNotes}
                      onChange={(e) => setCashUpNotes(e.target.value)}
                      className="w-full h-12 p-2 bg-slate-900 border border-slate-800 rounded-lg text-xs leading-snug font-medium text-white focus:outline-hidden focus:border-emerald-500 placeholder-slate-650 resize-none font-sans"
                    />
                  </div>

                  {/* Complete controls */}
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    <button
                      type="button"
                      onClick={() => setShowCashUpModal(false)}
                      className="py-2.5 bg-slate-800 hover:bg-slate-755 text-[11px] font-extrabold uppercase rounded-lg border border-slate-700 text-slate-300 cursor-pointer active:scale-98 transition-all font-sans"
                    >
                      Cancel & Dismiss
                    </button>
                    <button
                      type="button"
                      onClick={handlePostCashUp}
                      className="py-2.5 bg-emerald-600 hover:bg-emerald-555 text-[11px] font-extrabold uppercase rounded-lg text-white cursor-pointer active:scale-98 transition-all shadow-sm shadow-emerald-600/30 font-sans"
                    >
                      POST RECONCILIATION REPORT
                    </button>
                  </div>
                </>
              ) : (
                /* History Tab: Scrollable details compiled directly from SQLite database */
                <div className="flex flex-col gap-3 min-h-[350px]">
                  <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest block border-b border-slate-800 pb-1 font-sans">Historical Audit ledger entries</span>
                  
                  {reconciliationHistory.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-slate-400 bg-slate-950/40 border border-slate-850 rounded-xl">
                      <span className="text-xl">📊</span>
                      <p className="text-[11px] leading-relaxed font-bold font-sans">No historical reconciliations posted inside SQLite ledger today.</p>
                      <p className="text-[9px] text-slate-500 font-sans">Post records in the active form to archive secure EOD balances.</p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto pr-1">
                      {reconciliationHistory.map((report) => {
                        const totalExpected = parseFloat(report.sum_cash_expected || 0) + parseFloat(report.sum_card_expected || 0) + parseFloat(report.sum_momo_expected || 0);
                        const totalActual = parseFloat(report.sum_cash_actual || 0) + parseFloat(report.sum_card_actual || 0) + parseFloat(report.sum_momo_actual || 0);
                        const reportVar = parseFloat(report.variance || 0);

                        return (
                          <div key={report.id} className="bg-slate-950/50 border border-slate-850 p-3 rounded-lg flex flex-col gap-2 text-xs">
                            <div className="flex items-center justify-between border-b border-slate-850 pb-1 text-[10px]">
                              <span className="font-mono font-bold text-emerald-400">{report.id}</span>
                              <span className="font-mono text-slate-500">{new Date(report.created_at).toLocaleString()}</span>
                            </div>

                            <div className="grid grid-cols-2 gap-2 text-[10.5px]">
                              <div>
                                <p className="text-slate-500 font-sans">Branch: <strong className="text-slate-300 uppercase font-sans">{report.store_id}</strong></p>
                                <p className="text-slate-500 font-sans">Operator: <strong className="text-slate-300 font-sans">{report.cashier_name}</strong></p>
                              </div>
                              <div className="text-right font-mono text-[10.5px] font-bold">
                                <p className="text-slate-500 font-sans">Expected: {settings.currency}{totalExpected.toFixed(2)}</p>
                                <p className="text-slate-300 font-sans">Counted: {settings.currency}{totalActual.toFixed(2)}</p>
                              </div>
                            </div>

                            <div className="flex items-center justify-between bg-slate-900/60 p-1.5 rounded border border-slate-850">
                              <span className="font-bold text-[9px] text-slate-400 uppercase font-sans">Ledger Discrepancy Status:</span>
                              <span className={`font-mono font-bold text-[11px] ${
                                reportVar === 0 ? 'text-emerald-400' : reportVar > 0 ? 'text-blue-400' : 'text-rose-400'
                              }`}>
                                {reportVar === 0 ? 'Balanced (0.00)' : `${reportVar > 0 ? 'Surplus +' : 'Shortage -'}${settings.currency}${Math.abs(reportVar).toFixed(2)}`}
                              </span>
                            </div>

                            {report.notes && (
                              <div className="bg-slate-950/70 p-2 rounded text-[10px] leading-snug text-slate-400 font-medium italic border border-slate-850/60 font-sans">
                                "{report.notes}"
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2 mt-auto">
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('Are you sure you want to completely Purge reconciliation reports? This will reset EOD sales records.')) {
                          runSql('DELETE FROM cash_ups', 'Administration: Empty cash reconciliations');
                          loadReconciliationHistory();
                        }
                      }}
                      className="py-2 bg-rose-950/50 hover:bg-rose-900/50 text-[10px] font-extrabold uppercase rounded-lg border border-rose-900 text-rose-300 cursor-pointer transition-colors font-sans"
                    >
                      Reset SQLite Logs
                    </button>
                    <button
                      type="button"
                      onClick={() => setCashUpActiveTab('reconcile')}
                      className="py-2 bg-slate-800 hover:bg-slate-750 text-[10px] font-extrabold uppercase rounded-lg text-white border border-slate-705 cursor-pointer transition-all font-sans"
                    >
                      Back To Desk
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MODAL: INVOICE HISTORY & REFUNDS */}
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {showInvoiceHistoryModal && (
            <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4 z-50">
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-5xl h-[90vh] md:h-[85vh] max-h-[95vh] overflow-hidden flex flex-col text-left select-text"
              >
              {/* Header */}
              <div className="flex justify-between items-center border-b border-slate-100 p-5 shrink-0 bg-slate-50">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
                    <ShoppingCart size={18} />
                  </div>
                  <div>
                    <h3 className="text-sm font-extrabold text-slate-900 uppercase tracking-wide">
                      Invoice History & Auditing Ledger
                    </h3>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      Review sales representative logs, download/reprint thermal copies, and process authorized refunds.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowInvoiceHistoryModal(false);
                    setSelectedInvoice(null);
                    setSelectedInvoiceItems([]);
                    setShowRefundAuth(false);
                  }}
                  className="p-1.5 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-150 cursor-pointer transition-all"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Grid content */}
              <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
                  {/* Left side: Invoice list & Search */}
                  <div className="w-full md:w-1/2 border-b md:border-b-0 md:border-r border-slate-100 flex flex-col min-h-0 h-2/5 md:h-full">
                  {/* Search Bar & Branch Store Selector */}
                  <div className="p-3.5 border-b border-slate-100 bg-slate-50/50 flex flex-col sm:flex-row gap-2">
                    <div className="relative flex-1">
                      <Search size={14} className="absolute left-3 top-3 text-slate-400" />
                      <input
                        type="text"
                        value={invoiceSearchQuery}
                        onChange={(e) => setInvoiceSearchQuery(e.target.value)}
                        placeholder="Search by Ref, Rep, Customer, Payment..."
                        className="w-full pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold focus:outline-hidden text-slate-800 focus:border-indigo-500 shadow-3xs"
                      />
                    </div>
                    <select
                      value={historyStoreFilter}
                      onChange={(e) => {
                        setHistoryStoreFilter(e.target.value);
                        loadInvoices(e.target.value);
                      }}
                      className="px-3 py-2 bg-white border border-slate-200 text-slate-800 font-extrabold text-xs rounded-xl focus:outline-hidden focus:border-indigo-500 shadow-3xs cursor-pointer font-mono shrink-0"
                    >
                      <option value="all">🌐 All Branches</option>
                      <option value="lusaka">📍 Lusaka Hub</option>
                      <option value="kitwe">📍 Kitwe Hub</option>
                      <option value="ndola">📍 Ndola Hub</option>
                    </select>
                  </div>

                  {/* List container */}
                  <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-slate-50/30">
                    {(() => {
                      const filteredInvoices = invoiceList.filter((inv) => {
                        const searchLower = invoiceSearchQuery.toLowerCase();
                        const idMatch = inv.id && inv.id.toLowerCase().includes(searchLower);
                        const custName = inv.customer_name || 'walk-in customer';
                        const customerMatch = custName.toLowerCase().includes(searchLower);
                        const repMatch = inv.performed_by && inv.performed_by.toLowerCase().includes(searchLower);
                        const methodMatch = inv.paymentMethod && inv.paymentMethod.toLowerCase().includes(searchLower);
                        const statusMatch = inv.status && inv.status.toLowerCase().includes(searchLower);
                        const totalMatch = inv.total && inv.total.toString().includes(searchLower);
                        const storeMatch = inv.store_id && inv.store_id.toLowerCase().includes(searchLower);
                        return idMatch || customerMatch || repMatch || methodMatch || statusMatch || totalMatch || storeMatch;
                      });

                      if (filteredInvoices.length === 0) {
                        return (
                          <div className="flex flex-col items-center justify-center p-8 text-center text-slate-400">
                            <ShoppingCart size={32} className="text-slate-300 stroke-1 mb-2" />
                            <p className="text-xs font-semibold">No invoices found</p>
                            <p className="text-[10px] mt-1">Try a different search query or select another store filter.</p>
                          </div>
                        );
                      }

                      return filteredInvoices.map((inv) => {
                        const isSelected = selectedInvoice?.id === inv.id;
                        const dateFormatted = new Date(inv.orderDate).toLocaleString();
                        const totalNum = Number(inv.total || 0);
                        const isRefunded = inv.status === 'Refunded';

                        return (
                          <button
                            key={inv.id}
                            onClick={() => loadInvoiceDetails(inv)}
                            className={`w-full p-3 rounded-2xl text-left border transition-all flex justify-between items-start gap-4 cursor-pointer select-none ${
                              isSelected
                                ? 'bg-indigo-50 border-indigo-200 shadow-sm'
                                : 'bg-white hover:bg-slate-50 border-slate-100 hover:border-slate-200'
                            }`}
                          >
                            <div className="space-y-1 min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-mono text-[10px] font-extrabold text-slate-800 uppercase tracking-tight select-all">
                                  #{inv.id}
                                </span>
                                {isRefunded ? (
                                  <span className="text-[8.5px] bg-rose-50 border border-rose-200 text-rose-700 font-extrabold px-1.5 py-0.5 rounded-full uppercase font-mono">
                                    Refunded
                                  </span>
                                ) : inv.status === 'Layby (Credit)' ? (
                                  <span className="text-[8.5px] bg-amber-50 border border-amber-200 text-amber-700 font-extrabold px-1.5 py-0.5 rounded-full uppercase font-mono">
                                    Layby Active
                                  </span>
                                ) : (
                                  <span className="text-[8.5px] bg-emerald-50 border border-emerald-200 text-emerald-700 font-extrabold px-1.5 py-0.5 rounded-full uppercase font-mono">
                                    {inv.paymentMethod?.includes('Layby') ? 'Completed (Layby Paid)' : 'Completed Sale'}
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] font-bold text-slate-600 truncate">
                                Customer: {inv.customer_name || 'Walk-In Customer'}
                              </p>
                              <div className="flex items-center gap-1.5 text-[9px] text-slate-400 font-medium">
                                <span>{dateFormatted}</span>
                                <span>•</span>
                                <span className="font-semibold text-slate-500">Rep: {inv.performed_by || 'Default Cashier'}</span>
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <span className="text-xs font-extrabold text-slate-900 font-mono">
                                {settings.currency}{totalNum.toFixed(2)}
                              </span>
                              <span className="block text-[8px] text-slate-400 font-mono mt-0.5 uppercase">
                                {inv.paymentMethod}
                              </span>
                            </div>
                          </button>
                        );
                      });
                    })()}
                  </div>
                </div>

                {/* Right side: Invoice Details & Actions */}
                <div className="w-full md:w-1/2 flex flex-col min-h-0 bg-slate-50/20 h-3/5 md:h-full">
                  {selectedInvoice ? (
                    <div className="flex-1 flex flex-col min-h-0">
                      {/* Top metadata panel */}
                      <div className="p-5 border-b border-slate-100 bg-white space-y-3 shrink-0">
                        <div className="flex justify-between items-start gap-4">
                          <div>
                            <span className="text-[8px] font-bold text-indigo-600 uppercase tracking-widest font-mono">
                              ACTIVE TRANSACTION INVOICE
                            </span>
                            <h4 className="text-sm font-black text-slate-800 font-mono select-all">
                              #{selectedInvoice.id}
                            </h4>
                          </div>
                          <div className="text-right">
                            <span className="text-lg font-black text-slate-900 font-mono">
                              {settings.currency}{Number(selectedInvoice.total || 0).toFixed(2)}
                            </span>
                            <span className="block text-[9px] text-slate-400 font-semibold uppercase">
                              Payment: {selectedInvoice.paymentMethod}
                            </span>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3 pt-3 border-t border-slate-100 text-[10.5px]">
                          <div>
                            <span className="text-slate-400 font-bold block text-[8px] uppercase font-mono">
                              Sales Representative
                            </span>
                            <strong className="text-slate-700 font-semibold block">
                              {selectedInvoice.performed_by || 'Default Cashier'}
                            </strong>
                          </div>
                          <div>
                            <span className="text-slate-400 font-bold block text-[8px] uppercase font-mono">
                              Date & Time Logged
                            </span>
                            <strong className="text-slate-700 font-semibold block text-[9.5px]">
                              {new Date(selectedInvoice.orderDate).toLocaleString()}
                            </strong>
                          </div>
                          <div>
                            <span className="text-slate-400 font-bold block text-[8px] uppercase font-mono">
                              Customer Profile
                            </span>
                            <strong className="text-slate-700 font-semibold block">
                              {selectedInvoice.customer_name || 'Walk-In Customer'}
                            </strong>
                          </div>
                          <div>
                            <span className="text-slate-400 font-bold block text-[8px] uppercase font-mono">
                              Branch Store location
                            </span>
                            <strong className="text-slate-700 font-semibold block uppercase">
                              {selectedInvoice.store_id}
                            </strong>
                          </div>
                        </div>
                      </div>

                      {/* Items table */}
                      <div className="flex-1 overflow-y-auto p-5">
                        <h5 className="text-[9px] font-black uppercase text-slate-400 tracking-wider mb-2 font-mono">
                          LINE ITEMS SOLD
                        </h5>
                        <div className="bg-white border border-slate-150 rounded-2xl overflow-hidden shadow-3xs">
                          <table className="w-full text-left text-[11px] font-sans">
                            <thead className="bg-slate-50 text-[9px] font-black uppercase text-slate-500 border-b border-slate-150">
                              <tr>
                                <th className="p-3">Product Item</th>
                                <th className="p-3 text-center">Qty</th>
                                <th className="p-3 text-right">Unit Price</th>
                                <th className="p-3 text-right">Total</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {selectedInvoiceItems.map((it: any, index: number) => {
                                const qty = Number(it.quantity || 0);
                                const price = Number(it.unitPrice || 0);
                                return (
                                  <tr key={index} className="text-slate-700">
                                    <td className="p-3">
                                      <div className="font-semibold text-slate-800">{it.product_name || 'Unknown Item'}</div>
                                      <div className="text-[9px] font-mono text-slate-400 uppercase">SKU: {it.product_sku || 'N/A'}</div>
                                    </td>
                                    <td className="p-3 text-center font-mono font-bold text-slate-600">
                                      {qty}
                                    </td>
                                    <td className="p-3 text-right font-mono font-medium">
                                      {settings.currency}{price.toFixed(2)}
                                    </td>
                                    <td className="p-3 text-right font-mono font-bold text-slate-800">
                                      {settings.currency}{(qty * price).toFixed(2)}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>

                        {/* Financial Summaries */}
                        <div className="mt-4 p-4 bg-white border border-slate-150 rounded-2xl shadow-3xs space-y-1.5 text-[11px]">
                          <div className="flex justify-between text-slate-500 font-medium">
                            <span>Subtotal:</span>
                            <span className="font-mono">{settings.currency}{Number(selectedInvoice.subtotal || 0).toFixed(2)}</span>
                          </div>
                          {Number(selectedInvoice.discount || 0) > 0 && (
                            <div className="flex justify-between text-rose-600 font-semibold">
                              <span>Discount:</span>
                              <span className="font-mono">-{settings.currency}{Number(selectedInvoice.discount || 0).toFixed(2)}</span>
                            </div>
                          )}
                          <div className="flex justify-between text-slate-500 font-medium">
                            <span>Tax ({settings.taxRate}%):</span>
                            <span className="font-mono">{settings.currency}{Number(selectedInvoice.tax || 0).toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between text-slate-900 font-black text-xs pt-2 border-t border-slate-100">
                            <span>Grand Total Amount:</span>
                            <span className="font-mono text-indigo-600">{settings.currency}{Number(selectedInvoice.total || 0).toFixed(2)}</span>
                          </div>
                        </div>

                        {/* Supervisor Refund block if triggered */}
                        {showRefundAuth && (
                          <div className="mt-4 p-4 bg-rose-50 border border-rose-200 rounded-2xl shadow-3xs space-y-3">
                            <div>
                              <h4 className="text-[10px] font-black text-rose-800 uppercase tracking-widest flex items-center gap-1 font-mono">
                                🔐 Supervisor Gated Verification
                              </h4>
                              <p className="text-[9px] text-rose-600 font-semibold mt-0.5">
                                This action is highly restricted. An authorized supervisor password is required to process order refunds.
                              </p>
                            </div>

                            <div className="space-y-3 font-sans">
                              <div>
                                <label className="text-[8.5px] text-slate-500 font-extrabold uppercase block mb-1">
                                  Select / Enter Supervisor Name
                                </label>
                                <input
                                  type="text"
                                  placeholder="e.g. Supervisor Name"
                                  value={refundSupervisorName}
                                  onChange={(e) => setRefundSupervisorName(e.target.value)}
                                  className="w-full px-3 py-1.5 bg-white border border-rose-200 focus:border-rose-400 rounded-lg text-xs font-semibold outline-hidden text-slate-800"
                                />
                              </div>

                              <div>
                                <label className="text-[8.5px] text-slate-500 font-extrabold uppercase block mb-1">
                                  Supervisor Password
                                </label>
                                <input
                                  type="password"
                                  placeholder="••••"
                                  value={refundSupervisorPassword}
                                  onChange={(e) => setRefundSupervisorPassword(e.target.value)}
                                  className="w-full px-3 py-1.5 bg-white border border-rose-200 focus:border-rose-400 rounded-lg text-xs font-semibold font-mono tracking-widest outline-hidden text-slate-800"
                                />
                              </div>

                              <div className="flex justify-end gap-2 pt-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setShowRefundAuth(false);
                                    setRefundSupervisorName('');
                                    setRefundSupervisorPassword('');
                                  }}
                                  className="px-3 py-1.5 bg-slate-200 hover:bg-slate-250 text-slate-700 font-extrabold text-[9px] uppercase rounded-md tracking-wider transition-all cursor-pointer"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (!refundSupervisorName.trim()) {
                                      alert('Please enter supervisor name.');
                                      return;
                                    }

                                    // Let's query staff or do fallback
                                    const staffRes = runSql('SELECT * FROM staff', 'Refund: Auth supervisors list');
                                    let isApproved = false;

                                    if (staffRes.success && Array.isArray(staffRes.data) && staffRes.data.length > 0) {
                                      const matched = staffRes.data.find((s: any) => {
                                        const fullName = `${s.first_name} ${s.surname}`;
                                        return fullName.trim().toLowerCase() === refundSupervisorName.trim().toLowerCase();
                                      });

                                      if (matched) {
                                        const expectedPassword = matched.password || '1234';
                                        if (refundSupervisorPassword === expectedPassword) {
                                          isApproved = true;
                                        } else {
                                          alert('❌ Incorrect password for ' + refundSupervisorName);
                                          return;
                                        }
                                      } else {
                                        // Fallback default supervisor check
                                        if (refundSupervisorPassword === '1234') {
                                          isApproved = true;
                                        } else {
                                          alert('❌ Incorrect password fallback. Please try again.');
                                          return;
                                        }
                                      }
                                    } else {
                                      // Fallback checking default passcode 1234
                                      if (refundSupervisorPassword === '1234') {
                                        isApproved = true;
                                      } else {
                                        alert('❌ Access Denied: Incorrect supervisor credentials.');
                                        return;
                                      }
                                    }

                                    if (isApproved) {
                                      executeRefund(selectedInvoice, refundSupervisorName);
                                    }
                                  }}
                                  className="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-black text-[9px] uppercase rounded-md tracking-wider transition-all cursor-pointer"
                                >
                                  Authorize Refund
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Footer Actions Panel */}
                      {!showRefundAuth && (
                        <div className="p-4 border-t border-slate-100 bg-white flex justify-between items-center gap-3 shrink-0">
                          {selectedInvoice.status !== 'Refunded' ? (
                            <button
                              type="button"
                              onClick={() => {
                                // Load supervisor candidates from staff if any, and prefill
                                const staffRes = runSql("SELECT * FROM staff WHERE role = 'supervisor' OR role = 'manager'", 'Load managers');
                                if (staffRes.success && Array.isArray(staffRes.data) && staffRes.data.length > 0) {
                                  setRefundSupervisorName(`${staffRes.data[0].first_name} ${staffRes.data[0].surname}`);
                                }
                                setShowRefundAuth(true);
                              }}
                              className="px-4 py-2 bg-rose-50 border border-rose-200 hover:bg-rose-100 text-rose-700 font-extrabold text-[10px] uppercase rounded-xl tracking-wider transition-all cursor-pointer flex items-center gap-1.5"
                            >
                              🔄 Process Refund
                            </button>
                          ) : (
                            <span className="text-[10px] text-rose-500 font-extrabold uppercase font-mono px-3 py-1 bg-rose-50 border border-rose-150 rounded-lg">
                              Refund Processed & Closed
                            </span>
                          )}

                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleReprintReceipt(selectedInvoice, '58mm')}
                              className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 font-extrabold text-[10px] uppercase rounded-xl tracking-wider transition-all cursor-pointer flex items-center gap-1.5 border border-slate-200"
                            >
                              🖨️ Reprint 58mm
                            </button>
                            <button
                              type="button"
                              onClick={() => handleReprintReceipt(selectedInvoice, '80mm')}
                              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-[10px] uppercase rounded-xl tracking-wider transition-all cursor-pointer flex items-center gap-1.5 shadow-3xs"
                            >
                              🖨️ Reprint 80mm
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-400">
                      <ShoppingCart size={40} className="text-slate-300 stroke-1 mb-2" />
                      <p className="text-xs font-semibold">No Invoice Selected</p>
                      <p className="text-[10px] mt-1">Please pick an invoice from the left sales ledger panel to review audits, reprint or refund.</p>
                    </div>
                  )}
                </div>
              </div>
          </motion.div>
          </div>
        )}
      </AnimatePresence>,
      document.body
    )}

      {/* MODAL 3: SALESPERSON QUICK SALE OVERLAY */}
      <AnimatePresence>
        {showQuickSaleModal && (
          <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-lg p-6 overflow-hidden flex flex-col gap-4 text-left select-text max-h-[90vh] overflow-y-auto"
            >
              <div className="flex justify-between items-center border-b border-slate-100 pb-3">
                <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest flex items-center gap-1.5">
                  <span className="p-1 px-1.5 bg-amber-500 rounded text-white font-extrabold text-[10px]">⚡ POS</span>
                  SALESPERSON QUICK SALE TERMINAL
                </h3>
                <button
                  type="button"
                  onClick={() => setShowQuickSaleModal(false)}
                  className="p-1 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-50 cursor-pointer"
                >
                  <X size={16} />
                </button>
              </div>

              <form onSubmit={handleExecuteQuickSale} className="flex flex-col gap-4">
                {/* Salesperson field */}
                <div>
                  <label className="text-[10px] text-slate-400 font-extrabold uppercase block mb-1">Salesperson Name <span className="text-rose-500">*</span></label>
                  <input
                    type="text"
                    required
                    value={quickSalespersonName}
                    onChange={(e) => setQuickSalespersonName(e.target.value)}
                    placeholder="Enter your name (e.g., Naomi Katongo)"
                    className="w-full pl-3 pr-3 py-2 bg-slate-55 border border-slate-200 rounded-lg text-xs font-semibold focus:outline-hidden text-slate-800 focus:border-indigo-500"
                  />
                  <span className="text-[9px] text-slate-400 mt-0.5 block font-medium">Logged for double-entry cashier compliance and sales commission metrics.</span>
                </div>

                {/* Search field */}
                <div>
                  <label className="text-[10px] text-slate-400 font-extrabold uppercase block mb-1">Select or Scan Product <span className="text-rose-500">*</span></label>
                  <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      value={quickSearchQuery}
                      onChange={(e) => {
                        const val = e.target.value;
                        setQuickSearchQuery(val);
                        const exactMatch = products.find(p => p.sku.toLowerCase() === val.trim().toLowerCase());
                        if (exactMatch) {
                          setQuickSelectedProduct(exactMatch);
                          playBeep();
                        }
                      }}
                      placeholder="Type name / part description or scan SKU barcode..."
                      className="w-full pl-8 pr-3 py-2 bg-slate-55 border border-slate-200 rounded-lg text-xs font-semibold focus:outline-hidden text-slate-800 focus:border-indigo-500"
                    />
                  </div>

                  {/* Suggestions list */}
                  {quickSearchQuery.trim() !== '' && (
                    <div className="mt-1.5 border border-slate-100 rounded-lg bg-slate-50 overflow-hidden flex flex-col max-h-36 overflow-y-auto">
                      {products
                        .filter(p => p.name.toLowerCase().includes(quickSearchQuery.toLowerCase()) || p.sku.toLowerCase().includes(quickSearchQuery.toLowerCase()))
                        .slice(0, 5)
                        .map(p => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              setQuickSelectedProduct(p);
                              setQuickSearchQuery('');
                              playBeep();
                            }}
                            className="w-full text-left px-3 py-2 hover:bg-indigo-50 border-b border-slate-100 last:border-0 text-xs font-semibold text-slate-700 flex justify-between items-center transition-colors"
                          >
                            <span>{p.name} <span className="text-[9px] text-slate-400">({p.sku})</span></span>
                            <span className="font-mono text-indigo-700">{settings.currency}{p.price.toFixed(2)}</span>
                          </button>
                        ))}
                      {products.filter(p => p.name.toLowerCase().includes(quickSearchQuery.toLowerCase()) || p.sku.toLowerCase().includes(quickSearchQuery.toLowerCase())).length === 0 && (
                        <div className="p-3 text-center text-[10px] text-slate-400 font-bold uppercase">No matching products found</div>
                      )}
                    </div>
                  )}
                </div>

                {/* Selected product preview with stock counts */}
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <span className="text-[9px] text-slate-400 font-extrabold uppercase block mb-2">Live Warehouse Stock Preview (Branch: {activeStore.toUpperCase()})</span>
                  {quickSelectedProduct ? (
                    <div className="flex items-center gap-3">
                      <img
                        src={quickSelectedProduct.imageUrl}
                        alt={quickSelectedProduct.name}
                        referrerPolicy="no-referrer"
                        className="w-12 h-12 rounded-lg object-cover border bg-white shrink-0"
                      />
                      <div className="flex-1 overflow-hidden">
                        <h4 className="text-xs font-bold text-slate-800 line-clamp-1">{quickSelectedProduct.name}</h4>
                        <p className="text-[9px] font-mono text-slate-400 uppercase">SKU: {quickSelectedProduct.sku} • {quickSelectedProduct.category}</p>
                        <p className="text-xs font-black text-indigo-950 mt-0.5">{settings.currency}{quickSelectedProduct.price.toFixed(2)}</p>
                      </div>
                      <div className="text-right shrink-0">
                        {quickSelectedProduct.stock > 10 ? (
                          <span className="px-2 py-1 bg-emerald-100 text-emerald-800 border border-emerald-250 text-[10px] font-black rounded-lg uppercase">
                            {quickSelectedProduct.stock} Left (IN STOCK)
                          </span>
                        ) : quickSelectedProduct.stock > 0 ? (
                          <span className="px-2 py-1 bg-amber-100 text-amber-800 border border-amber-250 text-[10px] font-black rounded-lg uppercase">
                            {quickSelectedProduct.stock} Left (LOW STOCK)
                          </span>
                        ) : (
                          <span className="px-2 py-1 bg-rose-105 text-rose-800 border border-rose-250 text-[10px] font-black rounded-lg uppercase">
                            {quickSelectedProduct.stock} Left (OUT OF STOCK)
                          </span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-4 text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                      Please type or scan barcode to load a product preview
                    </div>
                  )}
                </div>

                {/* Quantity and Payment side-by-side */}
                {quickSelectedProduct && (
                  <div className="grid grid-cols-2 gap-3.5">
                    <div>
                      <label className="text-[10px] text-slate-400 font-extrabold uppercase block mb-1">Sell Quantity *</label>
                      <input
                        type="number"
                        min="1"
                        max={quickSelectedProduct.stock}
                        value={quickSaleQty}
                        onChange={(e) => setQuickSaleQty(e.target.value)}
                        className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-extrabold text-slate-800 font-mono"
                      />
                      {parseInt(quickSaleQty || '0') > quickSelectedProduct.stock && (
                        <span className="text-[9px] text-rose-600 font-bold mt-0.5 block">Exceeds available stock!</span>
                      )}
                    </div>

                    <div>
                      <label className="text-[10px] text-slate-400 font-extrabold uppercase block mb-1">Payment Method</label>
                      <select
                        value={quickPaymentMethod}
                        onChange={(e: any) => setQuickPaymentMethod(e.target.value)}
                        className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-800"
                      >
                        <option value="Cash">Cash Sale</option>
                        <option value="Credit Card">Credit Card</option>
                        <option value="Mobile Wallet">Mobile Wallet / MoMo</option>
                      </select>
                    </div>
                  </div>
                )}

                {/* Calculations Summary Panel */}
                {quickSelectedProduct && (
                  <div className="bg-slate-900 text-slate-100 p-3 rounded-xl flex flex-col gap-1 text-xs">
                    <div className="flex justify-between font-mono text-[10.5px]">
                      <span className="text-slate-400">Net Sale Total:</span>
                      <span>{settings.currency}{(quickSelectedProduct.price * parseInt(quickSaleQty || '1')).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between font-mono text-[10.5px]">
                      <span className="text-slate-400">VAT Tax Amount ({settings.taxRate}%):</span>
                      <span>{settings.currency}{(quickSelectedProduct.price * parseInt(quickSaleQty || '1') * settings.taxRate / 100).toFixed(2)}</span>
                    </div>
                    <div className="border-t border-slate-800 my-1"></div>
                    <div className="flex justify-between text-xs font-extrabold text-amber-400">
                      <span>CHARGE GRAND TOTAL VALUE:</span>
                      <span className="font-mono">{settings.currency}{(quickSelectedProduct.price * parseInt(quickSaleQty || '1') * (1 + settings.taxRate / 100)).toFixed(2)}</span>
                    </div>
                  </div>
                )}

                {/* Submit and Cancel buttons */}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowQuickSaleModal(false)}
                    className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-[10px] font-extrabold text-slate-600 cursor-pointer text-center tracking-wider"
                  >
                    CLOSE WINDOW
                  </button>
                  <button
                    type="submit"
                    disabled={!quickSelectedProduct || parseInt(quickSaleQty || '0') <= 0 || parseInt(quickSaleQty || '0') > (quickSelectedProduct?.stock || 0)}
                    className={`flex-1 py-2.5 rounded-lg text-[10px] font-extrabold text-white text-center cursor-pointer tracking-wider transition-colors ${
                      !quickSelectedProduct || parseInt(quickSaleQty || '0') <= 0 || parseInt(quickSaleQty || '0') > (quickSelectedProduct?.stock || 0)
                        ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                        : 'bg-amber-500 hover:bg-amber-600 active:bg-amber-700'
                    }`}
                  >
                    POST AND DOWNLOAD PDF
                  </button>
                </div>
              </form>

            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
