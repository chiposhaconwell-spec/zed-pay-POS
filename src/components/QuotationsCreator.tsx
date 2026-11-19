import React, { useState, useEffect, useRef } from 'react';
import { runSql, persistTablesToStorage, getCentralBranches, getActiveBusinessId, getActiveStoreId, sqlEsc } from '../db';
import { jsPDF } from 'jspdf';
import { exportAndSharePdf, dispatchPdfToWhatsApp, sharePdfFileDirectly, WhatsAppPdfDispatchResult } from '../androidUtils';
import SignaturePad from './SignaturePad';
import { 
  FileText, 
  Search, 
  Trash2, 
  Plus, 
  Printer, 
  CheckCircle, 
  ShoppingBag, 
  Edit3, 
  Building, 
  Send,
  Share2,
  Download,
  AlertCircle,
  X,
  PenTool,
  UserCheck
} from 'lucide-react';
import { StoreSettings } from '../types';

interface QuotationsCreatorProps {
  settings: StoreSettings;
  activeStore?: string;
}

const loadNormalizedPngImage = (src: string): Promise<{ dataUrl: string; width: number; height: number } | null> => {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width || 160;
        const h = img.naturalHeight || img.height || 160;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: canvas.toDataURL('image/png'), width: w, height: h });
      } catch {
        if (src.startsWith('data:image/png') || src.startsWith('data:image/jpeg') || src.startsWith('data:image/jpg')) {
          resolve({ dataUrl: src, width: 160, height: 160 });
        } else {
          resolve(null);
        }
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
};

interface Quotation {
  id: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  items_json: string;
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  bank_name: string;
  bank_account: string;
  bank_branch: string;
  status: 'QUOTATION' | 'INVOICE' | 'DELIVERY_NOTE';
  created_at: string;
  updated_at?: string;
  extra_json?: string;
}

const toDateInputValue = (isoOrDate?: string): string => {
  if (!isoOrDate) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  const str = String(isoOrDate).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const applyDateInputToIso = (dateInput: string, baseIso?: string): string => {
  const match = String(dateInput || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return baseIso || new Date().toISOString();
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const day = parseInt(match[3], 10);
  const base = baseIso ? new Date(baseIso) : new Date();
  const hours = !isNaN(base.getTime()) ? base.getHours() : 12;
  const mins = !isNaN(base.getTime()) ? base.getMinutes() : 0;
  const secs = !isNaN(base.getTime()) ? base.getSeconds() : 0;
  return new Date(year, month, day, hours || 12, mins, secs).toISOString();
};

export default function QuotationsCreator({ settings, activeStore = '' }: QuotationsCreatorProps) {
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [selectedQuote, setSelectedQuote] = useState<Quotation | null>(null);
  
  const resolveActiveBranch = () => {
    const branches = getCentralBranches();
    const targetId = String(
      activeStore ||
      (typeof localStorage !== 'undefined' ? (localStorage.getItem('active_store_branch') || localStorage.getItem('pos_active_store') || '') : '')
    ).trim();
    const matched =
      branches.find((b: any) => String(b.id || '').toLowerCase() === targetId.toLowerCase()) ||
      branches.find((b: any) => String(b.name || '').toLowerCase() === targetId.toLowerCase()) ||
      branches[0] ||
      null;
    return {
      id: matched?.id || targetId || '',
      name: (matched?.name || '').trim(),
      location: (matched?.location || '').trim(),
      phone: (matched?.phone || '').trim(),
      email: (matched?.email || '').trim(),
    };
  };

  // Create Form State (populated from active selected branch + business setup, no pre-seeded demo values)
  const fullBillingAddress = [settings.billingAddress, settings.billingCity, settings.billingCountry].filter(Boolean).join(', ');
  const [branchInfo, setBranchInfo] = useState(() => resolveActiveBranch());
  const [companyName, setCompanyName] = useState(settings.storeName || '');
  const [companyTPIN, setCompanyTPIN] = useState(settings.tpin || '');
  const [companyAddress, setCompanyAddress] = useState(() => resolveActiveBranch().location || fullBillingAddress || '');
  const [logoText, setLogoText] = useState((settings.storeName || 'POS').slice(0, 3).toUpperCase());
  const [draftDocType, setDraftDocType] = useState<'QUOTATION' | 'INVOICE' | 'DELIVERY_NOTE'>('QUOTATION');
  const [draftDate, setDraftDate] = useState<string>(() => toDateInputValue());
  
  // The 5 Core Banking Fields (optional, configured by business)
  const [bankName, setBankName] = useState('');
  const [bankAccountName, setBankAccountName] = useState(settings.storeName || '');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankBranchName, setBankBranchName] = useState('');
  const [bankSortCode, setBankSortCode] = useState('');

  // Client Info & existing customers list
  const [existingCustomers, setExistingCustomers] = useState<any[]>([]);
  const [cName, setCName] = useState('');
  const [cPhone, setCPhone] = useState('');
  const [cEmail, setCEmail] = useState('');

  // Cart Selection
  const [cartItems, setCartItems] = useState<any[]>([]);
  const [discountVal, setDiscountVal] = useState('0.00');
  const [allProducts, setAllProducts] = useState<any[]>([]);
  
  // Custom editing states for the currently selected document
  const [editItems, setEditItems] = useState<any[]>([]);
  const [deliveryDateInput, setDeliveryDateInput] = useState<string>(() => toDateInputValue());

  // Filter & Archive Search state
  const [docFilter, setDocFilter] = useState<'ALL' | 'QUOTATION' | 'INVOICE' | 'DELIVERY_NOTE'>('ALL');
  const [docSearch, setDocSearch] = useState('');

  // Document Editing state (supports QUOTATION, INVOICE, and DELIVERY_NOTE)
  const [isEditingQuote, setIsEditingQuote] = useState(false);
  const [editCName, setEditCName] = useState('');
  const [editCPhone, setEditCPhone] = useState('');
  const [editCEmail, setEditCEmail] = useState('');
  const [editDocDate, setEditDocDate] = useState('');
  const [editDiscountVal, setEditDiscountVal] = useState('0.00');
  const [customItemName, setCustomItemName] = useState('');
  const [customItemDescription, setCustomItemDescription] = useState('');
  const [customItemPrice, setCustomItemPrice] = useState('');
  const [customItemQty, setCustomItemQty] = useState('1');

  // Editing Bank States
  const [editBankName, setEditBankName] = useState('');
  const [editBankAccountName, setEditBankAccountName] = useState('');
  const [editBankAccountNumber, setEditBankAccountNumber] = useState('');
  const [editBankBranchName, setEditBankBranchName] = useState('');
  const [editBankSortCode, setEditBankSortCode] = useState('');
  const [editSelectedTermTexts, setEditSelectedTermTexts] = useState<string[]>([]);
  const [editIssuedBy, setEditIssuedBy] = useState('');
  const [editIssuerSignature, setEditIssuerSignature] = useState('');

  // Issuer Name & Digital Signature states
  const [issuerName, setIssuerName] = useState(
    () => (typeof localStorage !== 'undefined' && localStorage.getItem('logged_in_user_name')) || ''
  );
  const [issuerSignature, setIssuerSignature] = useState(
    () => (typeof localStorage !== 'undefined' && localStorage.getItem('pos_default_issuer_signature')) || ''
  );

  // Delivery Note Receiver Acceptance states
  const [deliveryReceiverName, setDeliveryReceiverName] = useState('');
  const [deliveryReceiverSig, setDeliveryReceiverSig] = useState('');
  const [isEditingReceiverSig, setIsEditingReceiverSig] = useState(false);

  // WhatsApp share PDF state
  const [whatsappSharePhone, setWhatsappSharePhone] = useState('');
  const [waSending, setWaSending] = useState(false);
  const [waError, setWaError] = useState<string | null>(null);
  const [waResult, setWaResult] = useState<WhatsAppPdfDispatchResult | null>(null);
  const [lastCompiledQuotePdf, setLastCompiledQuotePdf] = useState<{ doc: jsPDF; filename: string; caption: string } | null>(null);

  // Inline notices & confirm guards (replaces blocked window.alert/confirm in iframes)
  const [formNotice, setFormNotice] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [confirmDeleteDocId, setConfirmDeleteDocId] = useState<string | null>(null);
  const [confirmDeleteTermId, setConfirmDeleteTermId] = useState<string | null>(null);

  // Form Section tab state
  const [activeFormTab, setActiveFormTab] = useState<'client_bank' | 'items_stock' | 'terms_conditions'>('client_bank');

  // Search & Catalog Add product states
  const [productSearch, setProductSearch] = useState('');
  const [showAddCatalogProduct, setShowAddCatalogProduct] = useState(false);
  const [newCatalogName, setNewCatalogName] = useState('');
  const [newCatalogDescription, setNewCatalogDescription] = useState('');
  const [newCatalogPrice, setNewCatalogPrice] = useState('');
  const [newCatalogStock, setNewCatalogStock] = useState('100');

  // Terms and conditions library
  interface TermCondition {
    id: string;
    title: string;
    text: string;
  }
  const [savedTerms, setSavedTerms] = useState<TermCondition[]>([]);
  const [newTermTitle, setNewTermTitle] = useState('');
  const [newTermText, setNewTermText] = useState('');
  const [selectedTermIds, setSelectedTermIds] = useState<string[]>([]);

  const parseQuoteItems = (rawJson: string | undefined | null): any[] => {
    if (!rawJson) return [];
    try {
      const parsed = JSON.parse(rawJson);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  // Fetch / Retrieve extra quote attributes helper
  interface QuoteExtraData {
    appliedTerms: string[];
    bankAccountName: string;
    bankSortCode: string;
    issuedBy?: string;
    issuerSignature?: string;
    receiverName?: string;
    receiverSignature?: string;
    acceptedAt?: string;
    sourceDocId?: string;
    convertedInvoiceId?: string;
    convertedDeliveryNoteId?: string;
  }

  const getQuoteExtra = (quoteId: string, rawExtraJson?: string): QuoteExtraData => {
    let fromDb: Partial<QuoteExtraData> | null = null;
    if (rawExtraJson) {
      try {
        fromDb = JSON.parse(rawExtraJson);
      } catch {}
    }
    let fromLs: Partial<QuoteExtraData> | null = null;
    const data = localStorage.getItem(`pos_quote_extra_${quoteId}`);
    if (data) {
      try {
        fromLs = JSON.parse(data);
      } catch {}
    }
    const merged = { ...(fromDb || {}), ...(fromLs || {}) };
    return {
      appliedTerms: Array.isArray(merged.appliedTerms) ? merged.appliedTerms : [],
      bankAccountName: merged.bankAccountName || companyName,
      bankSortCode: merged.bankSortCode || '',
      issuedBy: merged.issuedBy || issuerName,
      issuerSignature: merged.issuerSignature || '',
      receiverName: merged.receiverName || '',
      receiverSignature: merged.receiverSignature || '',
      acceptedAt: merged.acceptedAt || '',
      sourceDocId: merged.sourceDocId || '',
      convertedInvoiceId: merged.convertedInvoiceId || '',
      convertedDeliveryNoteId: merged.convertedDeliveryNoteId || ''
    };
  };

  const persistQuoteExtra = (quoteId: string, extra: QuoteExtraData): string => {
    const serialized = JSON.stringify(extra);
    try {
      localStorage.setItem(`pos_quote_extra_${quoteId}`, serialized);
    } catch {}
    return serialized;
  };

  const loadQuotations = () => {
    const activeBizId = getActiveBusinessId();
    const bizCond = activeBizId ? `business_id = '${sqlEsc(activeBizId)}'` : `(business_id IS NULL OR business_id = '')`;
    const currentBranch = resolveActiveBranch();
    setBranchInfo(currentBranch);
    const fallbackBilling = [settings.billingAddress, settings.billingCity, settings.billingCountry].filter(Boolean).join(', ');
    setCompanyAddress(currentBranch.location || fallbackBilling || '');

    const res = runSql(`SELECT * FROM quotations WHERE ${bizCond} ORDER BY created_at DESC`, 'Quotations: Fetch active invoices');
    if (res.success && Array.isArray(res.data)) {
      setQuotations(res.data);
    }

    const spRes = runSql(`SELECT product_id, store_id, stock, price FROM store_products WHERE ${bizCond}`, 'Quotations: Fetch branch stock', true);
    const spRows = (spRes.success && Array.isArray(spRes.data)) ? spRes.data : [];
    const prodRes = runSql(`SELECT * FROM products WHERE ${bizCond}`, 'Quotations: Fetch catalog reference');
    if (prodRes.success && Array.isArray(prodRes.data)) {
      const enriched = prodRes.data.map((p: any) => {
        if (!activeStore) return p;
        const match = spRows.find(
          (sp: any) => String(sp.product_id) === String(p.id) && String(sp.store_id || '').toLowerCase() === activeStore.toLowerCase()
        );
        return match
          ? { ...p, stock: Number(match.stock ?? p.stock ?? 0), price: Number(match.price ?? p.price ?? 0) }
          : p;
      });
      setAllProducts(enriched);
    }

    const custRes = runSql(`SELECT id, name, phone, email FROM customers WHERE ${bizCond} ORDER BY name ASC`, 'Quotations: Fetch customers', true);
    if (custRes.success && Array.isArray(custRes.data)) {
      setExistingCustomers(custRes.data);
    }

    if (selectedQuote) {
      const qRes = runSql(`SELECT * FROM quotations WHERE id = '${sqlEsc(selectedQuote.id)}' AND ${bizCond}`, 'Quotations: Fetch active');
      if (qRes.success && Array.isArray(qRes.data) && qRes.data.length > 0) {
        setSelectedQuote(qRes.data[0]);
      }
    }
  };

  useEffect(() => {
    loadQuotations();
    const handleSync = () => loadQuotations();
    window.addEventListener('pos_data_updated', handleSync);
    window.addEventListener('local_db_restored', handleSync);

    // Load custom terms library
    const loadedTerms = localStorage.getItem('pos_custom_terms');
    if (loadedTerms) {
      try {
        setSavedTerms(JSON.parse(loadedTerms));
      } catch (e) {}
    } else {
      const defaultTerms: TermCondition[] = [
        { id: 'term-1', title: '50% Deposit Payment', text: '50% Down Payment to commence orders, balance of 50% payable strictly upon delivery.' },
        { id: 'term-2', title: '30 Days Validity', text: 'This Quotation is legally valid for exactly 30 calendar days from the date of issuance.' },
        { id: 'term-3', title: 'Non-Refundable Policy', text: 'Customized items or goods once delivered in correct working condition are non-refundable in whole or part.' }
      ];
      setSavedTerms(defaultTerms);
      localStorage.setItem('pos_custom_terms', JSON.stringify(defaultTerms));
    }

    // Load bank presets
    const savedBank = localStorage.getItem('pos_default_bank_details');
    if (savedBank) {
      try {
        const parsed = JSON.parse(savedBank);
        if (parsed.bankName) setBankName(parsed.bankName);
        if (parsed.bankAccountName) setBankAccountName(parsed.bankAccountName);
        if (parsed.bankAccountNumber) setBankAccountNumber(parsed.bankAccountNumber);
        if (parsed.bankBranchName) setBankBranchName(parsed.bankBranchName);
        if (parsed.bankSortCode) setBankSortCode(parsed.bankSortCode);
      } catch (e) {}
    }

    return () => {
      window.removeEventListener('pos_data_updated', handleSync);
      window.removeEventListener('local_db_restored', handleSync);
    };
  }, [activeStore]);

  useEffect(() => {
    setCompanyName(settings.storeName || '');
    setCompanyTPIN(settings.tpin || '');
    const currentBranch = resolveActiveBranch();
    setBranchInfo(currentBranch);
    const addr = currentBranch.location || [settings.billingAddress, settings.billingCity, settings.billingCountry].filter(Boolean).join(', ');
    setCompanyAddress(addr || '');
    setLogoText((settings.storeName || 'POS').slice(0, 3).toUpperCase());
  }, [settings.storeName, settings.tpin, settings.billingAddress, settings.billingCity, settings.billingCountry, activeStore]);

  useEffect(() => {
    setWaError(null);
    setWaResult(null);
    setLastCompiledQuotePdf(null);
    setConfirmDeleteDocId(null);
    if (selectedQuote) {
      const extra = getQuoteExtra(selectedQuote.id, selectedQuote.extra_json);
      setDeliveryReceiverName(extra.receiverName || '');
      setDeliveryReceiverSig(extra.receiverSignature || '');
      setIsEditingReceiverSig(!extra.receiverSignature);
      setDeliveryDateInput(toDateInputValue(selectedQuote.created_at));
      if (selectedQuote.customer_phone) {
        setWhatsappSharePhone(selectedQuote.customer_phone);
      }
    } else {
      setDeliveryReceiverName('');
      setDeliveryReceiverSig('');
      setIsEditingReceiverSig(false);
    }
  }, [selectedQuote?.id, selectedQuote?.status]);

  // Keyboard-safe scrolling & viewport tracking so soft keyboard never covers active inputs
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const blurTimeoutRef = useRef<number | null>(null);
  const scrollTimersRef = useRef<number[]>([]);
  const [isFieldFocused, setIsFieldFocused] = useState(false);

  const clearScheduledScrolls = () => {
    scrollTimersRef.current.forEach((id) => window.clearTimeout(id));
    scrollTimersRef.current = [];
  };

  const applyKeyboardInsetAndScroll = (targetEl?: HTMLElement | null) => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    const vvHeight = vv ? vv.height : window.innerHeight;
    const vvTop = vv ? vv.offsetTop : 0;
    const detectedInset = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
    const isCompactOrTouch =
      window.innerWidth < 1024 ||
      (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);

    const effectiveInset = detectedInset > 60
      ? detectedInset + 64
      : isCompactOrTouch
        ? 320
        : 48;

    document.documentElement.style.setProperty('--keyboard-inset', `${effectiveInset}px`);

    const el = targetEl || (document.activeElement as HTMLElement | null);
    if (!el || !workspaceRef.current || !workspaceRef.current.contains(el)) return;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
    if (el instanceof HTMLInputElement && ['checkbox', 'radio', 'button', 'submit', 'file'].includes(el.type)) return;

    const safeTop = vvTop + 72;
    const safeBottom = detectedInset > 60
      ? vvTop + vvHeight - 24
      : isCompactOrTouch
        ? vvTop + Math.min(vvHeight - 24, Math.round(window.innerHeight * 0.52))
        : vvTop + vvHeight - 32;

    const rect = el.getBoundingClientRect();
    if (rect.bottom > safeBottom || rect.top < safeTop) {
      const desiredTop = safeTop + Math.max(16, (safeBottom - safeTop) * 0.3);
      let remainingDelta = rect.top - desiredTop;
      let node: HTMLElement | null = el.parentElement;

      while (node && node !== document.body && Math.abs(remainingDelta) > 4) {
        const computed = window.getComputedStyle(node);
        const canScrollY =
          (computed.overflowY === 'auto' || computed.overflowY === 'scroll') &&
          node.scrollHeight > node.clientHeight + 4;
        if (canScrollY) {
          const maxDown = node.scrollHeight - node.clientHeight - node.scrollTop;
          const maxUp = -node.scrollTop;
          const step = remainingDelta > 0
            ? Math.min(remainingDelta, maxDown)
            : Math.max(remainingDelta, maxUp);
          if (Math.abs(step) > 2) {
            node.scrollBy({ top: step, behavior: 'smooth' });
            remainingDelta -= step;
          }
        }
        node = node.parentElement;
      }

      if (Math.abs(remainingDelta) > 12) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      }
    }
  };

  useEffect(() => {
    if (!isFieldFocused) {
      document.documentElement.style.setProperty('--keyboard-inset', '0px');
      return;
    }
    const handleViewportUpdate = () => {
      applyKeyboardInsetAndScroll(document.activeElement as HTMLElement | null);
    };
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', handleViewportUpdate);
      vv.addEventListener('scroll', handleViewportUpdate);
    }
    window.addEventListener('resize', handleViewportUpdate);
    return () => {
      if (vv) {
        vv.removeEventListener('resize', handleViewportUpdate);
        vv.removeEventListener('scroll', handleViewportUpdate);
      }
      window.removeEventListener('resize', handleViewportUpdate);
    };
  }, [isFieldFocused]);

  useEffect(() => {
    return () => {
      clearScheduledScrolls();
      if (blurTimeoutRef.current !== null) window.clearTimeout(blurTimeoutRef.current);
      document.documentElement.style.setProperty('--keyboard-inset', '0px');
    };
  }, []);

  const handleWorkspaceFocusCapture = (e: React.FocusEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (!target || !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (target instanceof HTMLInputElement && ['checkbox', 'radio', 'button', 'submit', 'file'].includes(target.type)) {
      return;
    }
    if (blurTimeoutRef.current !== null) {
      window.clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    setIsFieldFocused(true);
    clearScheduledScrolls();
    window.requestAnimationFrame(() => applyKeyboardInsetAndScroll(target));
    scrollTimersRef.current.push(
      window.setTimeout(() => applyKeyboardInsetAndScroll(target), 180),
      window.setTimeout(() => applyKeyboardInsetAndScroll(target), 400)
    );
  };

  const handleWorkspaceBlurCapture = () => {
    if (blurTimeoutRef.current !== null) window.clearTimeout(blurTimeoutRef.current);
    blurTimeoutRef.current = window.setTimeout(() => {
      const active = document.activeElement as HTMLElement | null;
      const stillInField =
        !!active &&
        !!workspaceRef.current?.contains(active) &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) &&
        !(active instanceof HTMLInputElement && ['checkbox', 'radio', 'button', 'submit', 'file'].includes(active.type));
      if (!stillInField) {
        clearScheduledScrolls();
        setIsFieldFocused(false);
        document.documentElement.style.setProperty('--keyboard-inset', '0px');
      }
    }, 120);
  };

  const addToCart = (prod: any) => {
    setFormNotice(null);
    if (selectedQuote) {
      setSelectedQuote(null);
      setIsEditingQuote(false);
    }
    const idx = cartItems.findIndex(x => String(x.id) === String(prod.id));
    if (idx > -1) {
      const updated = [...cartItems];
      updated[idx].quantity += 1;
      setCartItems(updated);
    } else {
      setCartItems([
        ...cartItems,
        {
          id: prod.id,
          name: prod.name,
          description: prod.description || '',
          quantity: 1,
          unitPrice: Number(prod.price || 0)
        }
      ]);
    }
  };

  const removeCartItem = (pId: number | string) => {
    setCartItems(cartItems.filter(x => String(x.id) !== String(pId)));
  };

  const handleUpdateCartQty = (pId: number | string, qtyString: string) => {
    const qty = Math.max(1, parseInt(qtyString, 10) || 1);
    setCartItems(cartItems.map(item => String(item.id) === String(pId) ? { ...item, quantity: qty } : item));
  };

  const handleUpdateCartPrice = (pId: number | string, priceString: string) => {
    const parsed = parseFloat(priceString);
    const price = isNaN(parsed) ? 0 : Math.max(0, parsed);
    setCartItems(cartItems.map(item => String(item.id) === String(pId) ? { ...item, unitPrice: price } : item));
  };

  const handleUpdateCartDescription = (pId: number | string, description: string) => {
    setCartItems(cartItems.map(item => String(item.id) === String(pId) ? { ...item, description } : item));
  };

  const calculateSubtotal = () => {
    return cartItems.reduce((sum, item) => sum + (Number(item.unitPrice || 0) * Number(item.quantity || 0)), 0);
  };

  const generateUniqueDocId = (prefix: 'QT' | 'INV' | 'DN', baseDigits?: string): string => {
    const existingIds = new Set(quotations.map(q => String(q.id)));
    const digits = (baseDigits || String(Math.floor(1000 + Math.random() * 9000))).replace(/[^a-zA-Z0-9]/g, '');
    let candidate = `${prefix}-${digits}`;
    let counter = 2;
    while (existingIds.has(candidate)) {
      candidate = `${prefix}-${digits}-${counter}`;
      counter++;
    }
    return candidate;
  };

  const handleSaveQuotation = (e?: React.FormEvent | React.MouseEvent) => {
    if (e) e.preventDefault();
    setFormNotice(null);

    if (!cName || cName.trim() === '') {
      setFormNotice({ type: 'error', text: 'Please enter the Customer / Corporate Name under "1. Info & Bank" first.' });
      setActiveFormTab('client_bank');
      return;
    }

    if (cartItems.length === 0) {
      setFormNotice({ type: 'error', text: 'Your document basket is empty. Add at least one item under "2. Stock".' });
      setActiveFormTab('items_stock');
      return;
    }

    const sub = calculateSubtotal();
    const discountNum = Math.max(0, parseFloat(discountVal) || 0);
    const taxRate = Number(settings.taxRate || 0);
    const taxNum = Math.max(0, (sub - discountNum) * (taxRate / 100));
    const tot = Math.max(0, sub - discountNum + taxNum);

    const prefix = draftDocType === 'INVOICE' ? 'INV' : draftDocType === 'DELIVERY_NOTE' ? 'DN' : 'QT';
    const qId = generateUniqueDocId(prefix);
    const dateStr = applyDateInputToIso(draftDate);
    const nowIso = new Date().toISOString();
    const itemsJson = JSON.stringify(cartItems);

    const resolvedIssuer = (issuerName || localStorage.getItem('logged_in_user_name') || 'Authorized Staff').trim();
    if (issuerSignature) {
      localStorage.setItem('pos_default_issuer_signature', issuerSignature);
    }
    const extra: QuoteExtraData = {
      appliedTerms: savedTerms.filter(t => selectedTermIds.includes(t.id)).map(t => t.text),
      bankAccountName: (bankAccountName || companyName || '').trim(),
      bankSortCode: (bankSortCode || '').trim(),
      issuedBy: resolvedIssuer,
      issuerSignature: issuerSignature || '',
      receiverName: '',
      receiverSignature: '',
      acceptedAt: ''
    };
    const extraJson = persistQuoteExtra(qId, extra);

    const escapedCName = cName.trim().replace(/'/g, "''");
    const escapedCPhone = (cPhone || '').trim().replace(/'/g, "''");
    const escapedCEmail = (cEmail || '').trim().replace(/'/g, "''");
    const escapedBankName = (bankName || '').trim().replace(/'/g, "''");
    const escapedBankAccountNumber = (bankAccountNumber || '').trim().replace(/'/g, "''");
    const escapedBankBranchName = (bankBranchName || '').trim().replace(/'/g, "''");

    const activeBizId = getActiveBusinessId();
    const activeStoreId = getActiveStoreId(activeStore, activeBizId);
    const bizMatch = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';

    const qry = `
      INSERT INTO quotations (id, customer_name, customer_phone, customer_email, items_json, subtotal, tax, discount, total, bank_name, bank_account, bank_branch, status, created_at, updated_at, extra_json, business_id, store_id)
      VALUES (
        '${qId}',
        '${escapedCName}',
        '${escapedCPhone}',
        '${escapedCEmail}',
        '${itemsJson.replace(/'/g, "''")}',
        ${sub.toFixed(2)},
        ${taxNum.toFixed(2)},
        ${discountNum.toFixed(2)},
        ${tot.toFixed(2)},
        '${escapedBankName}',
        '${escapedBankAccountNumber}',
        '${escapedBankBranchName}',
        '${draftDocType}',
        '${dateStr}',
        '${nowIso}',
        '${extraJson.replace(/'/g, "''")}',
        '${sqlEsc(activeBizId)}',
        '${sqlEsc(activeStoreId)}'
      )
    `;
    const res = runSql(qry, `Docs: File new ${draftDocType} document ${qId}`);
    if (res.success) {
      if (cPhone.trim()) {
        setWhatsappSharePhone(cPhone.trim());
      }

      setCName('');
      setCPhone('');
      setCEmail('');
      setCartItems([]);
      setDiscountVal('0.00');
      setSelectedTermIds([]);
      setDraftDate(toDateInputValue());
      setActiveFormTab('client_bank');

      const qRes = runSql(`SELECT * FROM quotations WHERE id = '${qId}'${bizMatch}`, 'Quotations: Retrieve just created doc');
      if (qRes.success && Array.isArray(qRes.data) && qRes.data.length > 0) {
        setSelectedQuote(qRes.data[0]);
        setEditItems(parseQuoteItems(qRes.data[0].items_json));
        setIsEditingQuote(false);
      }

      const label = draftDocType === 'INVOICE' ? 'Tax Invoice' : draftDocType === 'DELIVERY_NOTE' ? 'Delivery Note' : 'Quotation';
      setFormNotice({ type: 'success', text: `✓ ${label} ${qId} recorded and saved to archive for future reprint & editing.` });
      loadQuotations();
      persistTablesToStorage();
      try {
        window.dispatchEvent(new Event('pos_data_updated'));
      } catch {}
    } else {
      setFormNotice({ type: 'error', text: 'Error recording document: ' + (res.error || 'Unknown SQL error') });
    }
  };

  // Non-destructive Conversion: Keeps Quotation record intact and creates a linked Invoice record
  const handleConvertToInvoice = (quoteId: string) => {
    const activeBizId = getActiveBusinessId();
    const activeStoreId = getActiveStoreId(activeStore, activeBizId);
    const bizMatch = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
    const srcRes = runSql(`SELECT * FROM quotations WHERE id = '${sqlEsc(quoteId)}'${bizMatch}`, `Docs: Load Quotation ${quoteId} for Invoice`);
    const src: Quotation | null = (srcRes.success && Array.isArray(srcRes.data) && srcRes.data[0]) ? srcRes.data[0] : selectedQuote;
    if (!src) return;

    const baseDigits = quoteId.replace(/^(QT|INV|DN)-/, '');
    const invId = generateUniqueDocId('INV', baseDigits);
    const nowIso = new Date().toISOString();
    const srcExtra = getQuoteExtra(quoteId, src.extra_json);
    const invExtra: QuoteExtraData = {
      ...srcExtra,
      sourceDocId: quoteId,
      convertedInvoiceId: undefined,
      convertedDeliveryNoteId: undefined,
    };
    const invExtraJson = persistQuoteExtra(invId, invExtra);

    const updatedSrcExtra: QuoteExtraData = { ...srcExtra, convertedInvoiceId: invId };
    const updatedSrcExtraJson = persistQuoteExtra(quoteId, updatedSrcExtra);

    const insertInvSql = `
      INSERT INTO quotations (id, customer_name, customer_phone, customer_email, items_json, subtotal, tax, discount, total, bank_name, bank_account, bank_branch, status, created_at, updated_at, extra_json, business_id, store_id)
      VALUES (
        '${invId}',
        '${String(src.customer_name || '').replace(/'/g, "''")}',
        '${String(src.customer_phone || '').replace(/'/g, "''")}',
        '${String(src.customer_email || '').replace(/'/g, "''")}',
        '${String(src.items_json || '[]').replace(/'/g, "''")}',
        ${Number(src.subtotal || 0).toFixed(2)},
        ${Number(src.tax || 0).toFixed(2)},
        ${Number(src.discount || 0).toFixed(2)},
        ${Number(src.total || 0).toFixed(2)},
        '${String(src.bank_name || '').replace(/'/g, "''")}',
        '${String(src.bank_account || '').replace(/'/g, "''")}',
        '${String(src.bank_branch || '').replace(/'/g, "''")}',
        'INVOICE',
        '${nowIso}',
        '${nowIso}',
        '${invExtraJson.replace(/'/g, "''")}',
        '${sqlEsc(activeBizId)}',
        '${sqlEsc(activeStoreId)}'
      )
    `;
    const res = runSql(insertInvSql, `Docs: Issue Invoice ${invId} from Quotation ${quoteId}`);
    if (res.success) {
      runSql(
        `UPDATE quotations SET extra_json = '${updatedSrcExtraJson.replace(/'/g, "''")}', updated_at = '${nowIso}' WHERE id = '${sqlEsc(quoteId)}'${bizMatch}`,
        `Docs: Link Quotation ${quoteId} -> ${invId}`,
        true
      );
      const invRes = runSql(`SELECT * FROM quotations WHERE id = '${invId}'${bizMatch}`, 'Docs: Select new Invoice');
      if (invRes.success && Array.isArray(invRes.data) && invRes.data[0]) {
        setSelectedQuote(invRes.data[0]);
        setEditItems(parseQuoteItems(invRes.data[0].items_json));
        setIsEditingQuote(false);
      }
      setFormNotice({ type: 'success', text: `✓ Tax Invoice ${invId} created. Original Quotation ${quoteId} remains saved in the archive.` });
      loadQuotations();
      persistTablesToStorage();
      try { window.dispatchEvent(new Event('pos_data_updated')); } catch {}
    } else {
      setFormNotice({ type: 'error', text: 'Error creating invoice: ' + (res.error || 'Unknown error') });
    }
  };

  // Non-destructive Conversion: Keeps Invoice record intact and creates a linked Delivery Note record
  const handleConvertToDeliveryNote = (invoiceId: string) => {
    const activeBizId = getActiveBusinessId();
    const activeStoreId = getActiveStoreId(activeStore, activeBizId);
    const bizMatch = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
    const srcRes = runSql(`SELECT * FROM quotations WHERE id = '${sqlEsc(invoiceId)}'${bizMatch}`, `Docs: Load Invoice ${invoiceId} for Delivery Note`);
    const src: Quotation | null = (srcRes.success && Array.isArray(srcRes.data) && srcRes.data[0]) ? srcRes.data[0] : selectedQuote;
    if (!src) return;

    const baseDigits = invoiceId.replace(/^(QT|INV|DN)-/, '');
    const dnId = generateUniqueDocId('DN', baseDigits);
    const nowIso = new Date().toISOString();
    const srcExtra = getQuoteExtra(invoiceId, src.extra_json);
    const dnExtra: QuoteExtraData = {
      ...srcExtra,
      sourceDocId: invoiceId,
      convertedInvoiceId: undefined,
      convertedDeliveryNoteId: undefined,
      receiverName: '',
      receiverSignature: '',
      acceptedAt: '',
    };
    const dnExtraJson = persistQuoteExtra(dnId, dnExtra);

    const updatedSrcExtra: QuoteExtraData = { ...srcExtra, convertedDeliveryNoteId: dnId };
    const updatedSrcExtraJson = persistQuoteExtra(invoiceId, updatedSrcExtra);

    const insertDnSql = `
      INSERT INTO quotations (id, customer_name, customer_phone, customer_email, items_json, subtotal, tax, discount, total, bank_name, bank_account, bank_branch, status, created_at, updated_at, extra_json, business_id, store_id)
      VALUES (
        '${dnId}',
        '${String(src.customer_name || '').replace(/'/g, "''")}',
        '${String(src.customer_phone || '').replace(/'/g, "''")}',
        '${String(src.customer_email || '').replace(/'/g, "''")}',
        '${String(src.items_json || '[]').replace(/'/g, "''")}',
        ${Number(src.subtotal || 0).toFixed(2)},
        ${Number(src.tax || 0).toFixed(2)},
        ${Number(src.discount || 0).toFixed(2)},
        ${Number(src.total || 0).toFixed(2)},
        '${String(src.bank_name || '').replace(/'/g, "''")}',
        '${String(src.bank_account || '').replace(/'/g, "''")}',
        '${String(src.bank_branch || '').replace(/'/g, "''")}',
        'DELIVERY_NOTE',
        '${nowIso}',
        '${nowIso}',
        '${dnExtraJson.replace(/'/g, "''")}',
        '${sqlEsc(activeBizId)}',
        '${sqlEsc(activeStoreId)}'
      )
    `;
    const res = runSql(insertDnSql, `Docs: Issue Delivery Note ${dnId} from ${invoiceId}`);
    if (res.success) {
      runSql(
        `UPDATE quotations SET extra_json = '${updatedSrcExtraJson.replace(/'/g, "''")}', updated_at = '${nowIso}' WHERE id = '${sqlEsc(invoiceId)}'${bizMatch}`,
        `Docs: Link Invoice ${invoiceId} -> ${dnId}`,
        true
      );
      const dnRes = runSql(`SELECT * FROM quotations WHERE id = '${dnId}'${bizMatch}`, 'Docs: Select new Delivery Note');
      if (dnRes.success && Array.isArray(dnRes.data) && dnRes.data[0]) {
        setSelectedQuote(dnRes.data[0]);
        setEditItems(parseQuoteItems(dnRes.data[0].items_json));
        setIsEditingQuote(false);
      }
      setFormNotice({ type: 'success', text: `✓ Delivery Note ${dnId} created. Original Invoice ${invoiceId} remains saved in the archive.` });
      loadQuotations();
      persistTablesToStorage();
      try { window.dispatchEvent(new Event('pos_data_updated')); } catch {}
    } else {
      setFormNotice({ type: 'error', text: 'Error creating delivery note: ' + (res.error || 'Unknown error') });
    }
  };

  // EDIT LINE ITEMS & PRICE/DATE IN DELIVERY NOTE QUICK PANEL
  const handleUpdateDeliveryQty = (idx: number, qtyString: string) => {
    const qty = parseInt(qtyString, 10) || 0;
    const updated = [...editItems];
    
    if (qty <= 0) {
      updated.splice(idx, 1);
    } else {
      updated[idx] = { ...updated[idx], quantity: qty };
    }
    
    setEditItems(updated);
  };

  const handleUpdateDeliveryPrice = (idx: number, priceString: string) => {
    const parsed = parseFloat(priceString);
    const price = isNaN(parsed) ? 0 : Math.max(0, parsed);
    const updated = [...editItems];
    updated[idx] = { ...updated[idx], unitPrice: price };
    setEditItems(updated);
  };

  const handleSaveDeliveryEasing = () => {
    if (!selectedQuote) return;
    if (editItems.length === 0) {
      setFormNotice({ type: 'error', text: 'Delivery Note must keep at least one item.' });
      return;
    }

    const sub = editItems.reduce((sum, item) => sum + (Number(item.unitPrice || 0) * Number(item.quantity || 0)), 0);
    const discountNum = Number(selectedQuote.discount || 0);
    const taxNum = Math.max(0, (sub - discountNum) * (Number(settings.taxRate || 0) / 100));
    const tot = Math.max(0, sub - discountNum + taxNum);
    const nextCreatedAt = applyDateInputToIso(deliveryDateInput, selectedQuote.created_at);
    const nowIso = new Date().toISOString();

    const activeBizId = getActiveBusinessId();
    const bizMatch = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
    const itemsJson = JSON.stringify(editItems);
    const qry = `
      UPDATE quotations 
      SET 
        items_json = '${itemsJson.replace(/'/g, "''")}',
        subtotal = ${sub.toFixed(2)},
        tax = ${taxNum.toFixed(2)},
        total = ${tot.toFixed(2)},
        created_at = '${nextCreatedAt}',
        updated_at = '${nowIso}'
      WHERE id = '${sqlEsc(selectedQuote.id)}'${bizMatch}
    `;
    const res = runSql(qry, `Docs: Update quantities/prices/date on Delivery Note ${selectedQuote.id}`);
    if (res.success) {
      setFormNotice({ type: 'success', text: `✓ Delivery Note ${selectedQuote.id} updated and ready for reprint.` });
      loadQuotations();
      persistTablesToStorage();
      try { window.dispatchEvent(new Event('pos_data_updated')); } catch {}
    }
  };

  const handleSaveDeliveryAcceptance = () => {
    if (!selectedQuote) return;
    if (!deliveryReceiverName.trim()) {
      setFormNotice({ type: 'error', text: 'Please enter the Receiver Full Name before confirming delivery acceptance.' });
      return;
    }
    if (!deliveryReceiverSig) {
      setFormNotice({ type: 'error', text: 'Please have the receiver sign inside the signature pad to accept delivery.' });
      return;
    }
    const existingExtra = getQuoteExtra(selectedQuote.id, selectedQuote.extra_json);
    const nowIso = new Date().toISOString();
    const updatedExtra: QuoteExtraData = {
      ...existingExtra,
      receiverName: deliveryReceiverName.trim(),
      receiverSignature: deliveryReceiverSig,
      acceptedAt: nowIso
    };
    const activeBizId = getActiveBusinessId();
    const bizMatch = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
    const extraJson = persistQuoteExtra(selectedQuote.id, updatedExtra);
    runSql(
      `UPDATE quotations SET extra_json = '${extraJson.replace(/'/g, "''")}', updated_at = '${nowIso}' WHERE id = '${sqlEsc(selectedQuote.id)}'${bizMatch}`,
      `Docs: Save receiver signature on ${selectedQuote.id}`,
      true
    );
    setIsEditingReceiverSig(false);
    setFormNotice({ type: 'success', text: `✓ Delivery Note ${selectedQuote.id} accepted & signed by ${deliveryReceiverName.trim()}.` });
    loadQuotations();
    persistTablesToStorage();
    try { window.dispatchEvent(new Event('pos_data_updated')); } catch {}
  };

  // Start Editing Document (Quotation, Invoice, or Delivery Note)
  const startEditingQuotation = (q: Quotation) => {
    setEditCName(q.customer_name);
    setEditCPhone(q.customer_phone || '');
    setEditCEmail(q.customer_email || '');
    setEditDocDate(toDateInputValue(q.created_at));
    setEditDiscountVal(Number(q.discount || 0).toString());
    setEditItems(parseQuoteItems(q.items_json));
    setCustomItemName('');
    setCustomItemPrice('');
    setCustomItemQty('1');

    // Load extra metadata
    const extra = getQuoteExtra(q.id, q.extra_json);
    setEditSelectedTermTexts(extra.appliedTerms || []);
    setEditBankAccountName(extra.bankAccountName || q.customer_name || '');
    setEditBankSortCode(extra.bankSortCode || '');
    setEditIssuedBy(extra.issuedBy || issuerName || '');
    setEditIssuerSignature(extra.issuerSignature || issuerSignature || '');

    // These columns are part of the db row
    setEditBankName(q.bank_name || '');
    setEditBankAccountNumber(q.bank_account || '');
    setEditBankBranchName(q.bank_branch || '');

    setIsEditingQuote(true);
  };

  const addProductToEditItems = (prod: any) => {
    const idx = editItems.findIndex(x => String(x.id) === String(prod.id));
    if (idx > -1) {
      const updated = [...editItems];
      updated[idx] = { ...updated[idx], quantity: Number(updated[idx].quantity || 0) + 1 };
      setEditItems(updated);
    } else {
      setEditItems([
        ...editItems,
        {
          id: prod.id,
          name: prod.name,
          description: prod.description || '',
          quantity: 1,
          unitPrice: Number(prod.price || 0)
        }
      ]);
    }
  };

  const handleAddCustomEditItem = () => {
    if (!customItemName.trim()) {
      setFormNotice({ type: 'error', text: 'Enter an item name before adding.' });
      return;
    }
    const price = Math.max(0, parseFloat(customItemPrice) || 0);
    const qty = Math.max(1, parseInt(customItemQty, 10) || 1);
    setEditItems([
      ...editItems,
      {
        id: 'custom_' + Date.now(),
        name: customItemName.trim(),
        description: customItemDescription.trim(),
        quantity: qty,
        unitPrice: price
      }
    ]);
    setCustomItemName('');
    setCustomItemDescription('');
    setCustomItemPrice('');
    setCustomItemQty('1');
  };

  const removeItemFromEditItems = (idx: number) => {
    const updated = editItems.filter((_, i) => i !== idx);
    setEditItems(updated);
  };

  const handleSaveQuotationEdits = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedQuote) return;
    if (!editCName.trim() || editItems.length === 0) {
      setFormNotice({ type: 'error', text: 'Please fill out Customer Corporate Name and include at least one line item.' });
      return;
    }

    const sub = editItems.reduce((sum, item) => sum + (Number(item.unitPrice || 0) * Number(item.quantity || 0)), 0);
    const discountNum = Math.max(0, parseFloat(editDiscountVal) || 0);
    const taxNum = Math.max(0, (sub - discountNum) * (Number(settings.taxRate || 0) / 100));
    const tot = Math.max(0, sub - discountNum + taxNum);
    const nextCreatedAt = applyDateInputToIso(editDocDate, selectedQuote.created_at);
    const nowIso = new Date().toISOString();

    const itemsJson = JSON.stringify(editItems);
    const existingExtra = getQuoteExtra(selectedQuote.id, selectedQuote.extra_json);
    const extra: QuoteExtraData = {
      ...existingExtra,
      appliedTerms: editSelectedTermTexts,
      bankAccountName: editBankAccountName,
      bankSortCode: editBankSortCode,
      issuedBy: editIssuedBy.trim() || existingExtra.issuedBy || issuerName,
      issuerSignature: editIssuerSignature || existingExtra.issuerSignature || ''
    };
    const activeBizId = getActiveBusinessId();
    const bizMatch = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
    const extraJson = persistQuoteExtra(selectedQuote.id, extra);

    const qry = `
      UPDATE quotations
      SET
        customer_name = '${editCName.trim().replace(/'/g, "''")}',
        customer_phone = '${(editCPhone || '').replace(/'/g, "''")}',
        customer_email = '${(editCEmail || '').replace(/'/g, "''")}',
        items_json = '${itemsJson.replace(/'/g, "''")}',
        subtotal = ${sub.toFixed(2)},
        tax = ${taxNum.toFixed(2)},
        discount = ${discountNum.toFixed(2)},
        total = ${tot.toFixed(2)},
        bank_name = '${(editBankName || '').replace(/'/g, "''")}',
        bank_account = '${(editBankAccountNumber || '').replace(/'/g, "''")}',
        bank_branch = '${(editBankBranchName || '').replace(/'/g, "''")}',
        created_at = '${nextCreatedAt}',
        updated_at = '${nowIso}',
        extra_json = '${extraJson.replace(/'/g, "''")}'
      WHERE id = '${sqlEsc(selectedQuote.id)}'${bizMatch}
    `;

    const res = runSql(qry, `Docs: Update ${selectedQuote.status} ${selectedQuote.id}`);
    if (res.success) {
      setDeliveryDateInput(toDateInputValue(nextCreatedAt));
      setFormNotice({ type: 'success', text: `✓ ${selectedQuote.status.replace('_', ' ')} ${selectedQuote.id} updated and ready for reprint.` });
      setIsEditingQuote(false);
      loadQuotations();
      persistTablesToStorage();
      try { window.dispatchEvent(new Event('pos_data_updated')); } catch {}
    } else {
      setFormNotice({ type: 'error', text: 'Error updating document: ' + (res.error || 'Unknown error') });
    }
  };

  const handleDeleteDocument = (docId: string) => {
    const activeBizId = getActiveBusinessId();
    const bizMatch = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
    const res = runSql(`DELETE FROM quotations WHERE id = '${sqlEsc(docId)}'${bizMatch}`, `Docs: Delete document ${docId}`);
    if (res.success) {
      setFormNotice({ type: 'success', text: `Document ${docId} deleted.` });
      setSelectedQuote(null);
      setIsEditingQuote(false);
      setConfirmDeleteDocId(null);
      loadQuotations();
      persistTablesToStorage();
      try { window.dispatchEvent(new Event('pos_data_updated')); } catch {}
    } else {
      setFormNotice({ type: 'error', text: 'Error deleting document: ' + (res.error || 'Unknown error') });
    }
  };

  const selectedParsedItems = selectedQuote ? parseQuoteItems(selectedQuote.items_json) : [];
  const selectedExtra = selectedQuote ? getQuoteExtra(selectedQuote.id, selectedQuote.extra_json) : null;
  const activeDoc = selectedQuote 
    ? {
        id: selectedQuote.id,
        status: selectedQuote.status,
        created_at: selectedQuote.created_at,
        updated_at: selectedQuote.updated_at || '',
        customer_name: selectedQuote.customer_name,
        customer_phone: selectedQuote.customer_phone,
        customer_email: selectedQuote.customer_email,
        bank_name: selectedQuote.bank_name,
        bank_account: selectedQuote.bank_account,
        bank_branch: selectedQuote.bank_branch,
        items: selectedQuote.status === 'DELIVERY_NOTE' ? editItems : selectedParsedItems,
        subtotal: Number(selectedQuote.status === 'DELIVERY_NOTE' ? editItems.reduce((sum: number, item: any) => sum + (Number(item.unitPrice || 0) * Number(item.quantity || 0)), 0) : (selectedQuote.subtotal || 0)),
        discount: Number(selectedQuote.discount || 0),
        tax: Number(selectedQuote.status === 'DELIVERY_NOTE' ? Math.max(0, (editItems.reduce((sum: number, item: any) => sum + (Number(item.unitPrice || 0) * Number(item.quantity || 0)), 0) - Number(selectedQuote.discount || 0)) * (Number(settings.taxRate || 0) / 100)) : (selectedQuote.tax || 0)),
        total: Number(selectedQuote.status === 'DELIVERY_NOTE' ? Math.max(0, (editItems.reduce((sum: number, item: any) => sum + (Number(item.unitPrice || 0) * Number(item.quantity || 0)), 0) - Number(selectedQuote.discount || 0)) * (1 + Number(settings.taxRate || 0) / 100)) : (selectedQuote.total || 0)),
        appliedTerms: selectedExtra?.appliedTerms || [],
        bankAccountName: selectedExtra?.bankAccountName || companyName,
        bankSortCode: selectedExtra?.bankSortCode || '',
        issuedBy: selectedExtra?.issuedBy || issuerName || localStorage.getItem('logged_in_user_name') || '',
        issuerSignature: selectedExtra?.issuerSignature || '',
        receiverName: selectedExtra?.receiverName || '',
        receiverSignature: selectedExtra?.receiverSignature || '',
        acceptedAt: selectedExtra?.acceptedAt || '',
        sourceDocId: selectedExtra?.sourceDocId || '',
        isDraft: false
      }
    : (cartItems.length > 0 || cName) 
    ? {
        id: draftDocType === 'INVOICE' ? 'INV-DRAFT-PREVIEW' : draftDocType === 'DELIVERY_NOTE' ? 'DN-DRAFT-PREVIEW' : 'QT-DRAFT-PREVIEW',
        status: draftDocType === 'INVOICE' ? 'DRAFT INVOICE' : draftDocType === 'DELIVERY_NOTE' ? 'DRAFT DELIVERY NOTE' : 'DRAFT QUOTATION',
        created_at: applyDateInputToIso(draftDate),
        updated_at: '',
        customer_name: cName || 'Draft Customer Name',
        customer_phone: cPhone || '',
        customer_email: cEmail || '',
        bank_name: bankName,
        bank_account: bankAccountNumber,
        bank_branch: bankBranchName,
        items: cartItems,
        subtotal: calculateSubtotal(),
        discount: parseFloat(discountVal) || 0,
        tax: Math.max(0, (calculateSubtotal() - (parseFloat(discountVal) || 0)) * (Number(settings.taxRate || 0) / 100)),
        total: Math.max(0, (calculateSubtotal() - (parseFloat(discountVal) || 0)) * (1 + Number(settings.taxRate || 0) / 100)),
        appliedTerms: savedTerms.filter(t => selectedTermIds.includes(t.id)).map(t => t.text),
        bankAccountName: bankAccountName || companyName,
        bankSortCode: bankSortCode || '',
        issuedBy: issuerName || localStorage.getItem('logged_in_user_name') || '',
        issuerSignature: issuerSignature || '',
        receiverName: '',
        receiverSignature: '',
        acceptedAt: '',
        sourceDocId: '',
        isDraft: true
      }
    : null;

  const buildQuotePdfDoc = async (docData: any): Promise<{ doc: jsPDF; fileName: string } | null> => {
    if (!docData) return null;
    try {
      const doc = new jsPDF({ format: 'a4', orientation: 'portrait' });
      const margin = 15;
      const contentWidth = 180; // 210 - 2 * 15

      // Embed uploaded Company Logo if configured in Settings
      let textStartX = margin;
      if (settings.logoUrl) {
        const normalizedLogo = await loadNormalizedPngImage(settings.logoUrl);
        if (normalizedLogo) {
          const maxLogoDim = 18;
          const ratio = Math.min(maxLogoDim / normalizedLogo.width, maxLogoDim / normalizedLogo.height);
          const drawW = Math.max(8, normalizedLogo.width * ratio);
          const drawH = Math.max(8, normalizedLogo.height * ratio);
          doc.addImage(normalizedLogo.dataUrl, 'PNG', margin, 16, drawW, drawH);
          textStartX = margin + drawW + 5;
        }
      }

      // Header Section (plain neutral styling; only the logo preserves brand color)
      let leftHeaderY = 23;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.setTextColor(15, 23, 42); // Plain charcoal
      doc.text((companyName || settings.storeName || 'COMPANY').toUpperCase(), textStartX, leftHeaderY);
      leftHeaderY += 6;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(71, 85, 105);
      doc.text(`TPIN: ${companyTPIN || 'N/A'}`, textStartX, leftHeaderY);
      leftHeaderY += 4.5;

      const activeBranch = resolveActiveBranch();
      const activeAddress = activeBranch.location || companyAddress;
      if (activeBranch.name) {
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(51, 65, 85);
        doc.text(`Branch: ${activeBranch.name}`, textStartX, leftHeaderY);
        leftHeaderY += 4.5;
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(71, 85, 105);
      }

      if (activeAddress) {
        const addrLines = doc.splitTextToSize(activeAddress, 75);
        doc.text(addrLines, textStartX, leftHeaderY);
        leftHeaderY += addrLines.length * 4;
      }

      const branchContactLine = [
        activeBranch.phone ? `Tel: ${activeBranch.phone}` : '',
        activeBranch.email ? `Email: ${activeBranch.email}` : '',
      ].filter(Boolean).join(' • ');
      if (branchContactLine) {
        const contactLines = doc.splitTextToSize(branchContactLine, 75);
        doc.text(contactLines, textStartX, leftHeaderY);
        leftHeaderY += contactLines.length * 4;
      }

      // Right-side document type and metadata (plain charcoal/slate)
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(17);
      doc.setTextColor(15, 23, 42);
      const statusLabel = docData.status === 'QUOTATION'
        ? 'QUOTATION'
        : docData.status === 'INVOICE'
          ? 'TAX INVOICE'
          : docData.status === 'DELIVERY_NOTE'
            ? 'DELIVERY NOTE'
            : String(docData.status || 'DOCUMENT');
      doc.text(statusLabel, 210 - margin, 23, { align: 'right' });

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(71, 85, 105);
      doc.text(`Doc ID: ${docData.id}`, 210 - margin, 29, { align: 'right' });
      doc.text(`Date: ${new Date(docData.created_at).toLocaleDateString()}`, 210 - margin, 34, { align: 'right' });
      let rightHeaderY = 36;
      if (docData.issuedBy) {
        doc.text(`Issued By: ${docData.issuedBy}`, 210 - margin, 39, { align: 'right' });
        rightHeaderY = 41;
      }

      // Horizontal Line Divider
      const headerBottomY = Math.max(43, leftHeaderY + 2, rightHeaderY + 2);
      doc.setDrawColor(203, 213, 225); // Slate-300
      doc.setLineWidth(0.5);
      doc.line(margin, headerBottomY, 210 - margin, headerBottomY);

      // Two-column layout: Customer Details & Payment Bank Details
      const colY = headerBottomY + 7;

      // Column 1: Customer Details
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(15, 23, 42);
      doc.text('CLIENT DETAILS', margin, colY);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(30, 41, 59); // Slate-800
      doc.text(docData.customer_name || 'N/A', margin, colY + 6);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(71, 85, 105); // Slate-600
      doc.text(`Phone: ${docData.customer_phone || 'N/A'}`, margin, colY + 11);
      doc.text(`Email: ${docData.customer_email || 'N/A'}`, margin, colY + 16);

      // Column 2: Bank Transfer Details
      const rightColX = 115;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(15, 23, 42);
      doc.text('PAYMENT DETAILS', rightColX, colY);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(71, 85, 105); // Slate-600
      doc.text(`Bank: ${docData.bank_name || 'N/A'}`, rightColX, colY + 6);
      doc.text(`Account Name: ${docData.bankAccountName || companyName || 'N/A'}`, rightColX, colY + 11);
      doc.text(`Account No: ${docData.bank_account || 'N/A'}`, rightColX, colY + 16);
      doc.text(`Branch: ${docData.bank_branch || 'N/A'}`, rightColX, colY + 21);
      doc.text(`Sort Code: ${docData.bankSortCode || 'N/A'}`, rightColX, colY + 26);

      // Line Items Table Header
      const tableY = colY + 35;
      doc.setFillColor(241, 245, 249); // Slate-100
      doc.rect(margin, tableY, contentWidth, 8, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(30, 41, 59); // Slate-800
      doc.text('#', margin + 3, tableY + 5.5);
      doc.text('Item Description', margin + 12, tableY + 5.5);
      doc.text('Qty', margin + 105, tableY + 5.5, { align: 'right' });
      doc.text('Unit Price', margin + 135, tableY + 5.5, { align: 'right' });
      doc.text('Total Amount', margin + 175, tableY + 5.5, { align: 'right' });

      // Table Content Rows
      let currentY = tableY + 8;
      const descColWidth = 78;

      docData.items.forEach((item: any, idx: number) => {
        const uPrice = Number(item.unitPrice || 0);
        const qty = Number(item.quantity || 0);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        const nameLines: string[] = doc.splitTextToSize(String(item.name || ''), descColWidth);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        const rawDesc = String(item.description || '').trim();
        const descLines: string[] = rawDesc ? doc.splitTextToSize(rawDesc, descColWidth) : [];

        const nameHeight = nameLines.length * 4.2;
        const descHeight = descLines.length > 0 ? descLines.length * 3.6 + 1 : 0;
        const rowHeight = Math.max(7.5, 3.5 + nameHeight + descHeight + 2);

        if (currentY + rowHeight > 260) {
          doc.addPage();
          currentY = 20;
        }

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(71, 85, 105);
        doc.text((idx + 1).toString(), margin + 3, currentY + 5);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(30, 41, 59);
        doc.text(nameLines, margin + 12, currentY + 5);

        if (descLines.length > 0) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(100, 116, 139);
          doc.text(descLines, margin + 12, currentY + 5 + nameHeight);
        }

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(71, 85, 105);
        doc.text(qty.toString(), margin + 105, currentY + 5, { align: 'right' });
        doc.text(`${settings.currency}${uPrice.toFixed(2)}`, margin + 135, currentY + 5, { align: 'right' });
        doc.text(`${settings.currency}${(uPrice * qty).toFixed(2)}`, margin + 175, currentY + 5, { align: 'right' });

        doc.setDrawColor(241, 245, 249);
        doc.setLineWidth(0.3);
        doc.line(margin, currentY + rowHeight - 0.5, 210 - margin, currentY + rowHeight - 0.5);

        currentY += rowHeight;
      });

      if (currentY > 235) {
        doc.addPage();
        currentY = 20;
      }

      // Totals Panel
      const totalPanelY = currentY + 5;
      const rightAlignX = 195;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(100, 116, 139);
      doc.text('Subtotal:', 125, totalPanelY);
      doc.text(`${settings.currency}${Number(docData.subtotal || 0).toFixed(2)}`, rightAlignX, totalPanelY, { align: 'right' });

      let nextTotalY = totalPanelY + 5;
      if (Number(docData.discount || 0) > 0) {
        doc.text('Discount:', 125, nextTotalY);
        doc.text(`-${settings.currency}${Number(docData.discount || 0).toFixed(2)}`, rightAlignX, nextTotalY, { align: 'right' });
        nextTotalY += 5;
      }

      doc.text(`VAT (${settings.taxRate}%):`, 125, nextTotalY);
      doc.text(`${settings.currency}${Number(docData.tax || 0).toFixed(2)}`, rightAlignX, nextTotalY, { align: 'right' });

      // Grand Total Box (plain neutral gray + dark slate text)
      const gTotalY = nextTotalY + 5;
      doc.setFillColor(241, 245, 249);
      doc.rect(120, gTotalY, 75, 8, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      doc.text('GRAND TOTAL:', 125, gTotalY + 5.5);
      doc.text(`${settings.currency}${Number(docData.total || 0).toFixed(2)}`, rightAlignX - 2, gTotalY + 5.5, { align: 'right' });

      // Terms & Conditions Block
      let cursorY = gTotalY + 16;
      if (docData.appliedTerms && docData.appliedTerms.length > 0) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9.5);
        doc.setTextColor(30, 41, 59);
        doc.text('TERMS & CONDITIONS', margin, cursorY);
        cursorY += 5;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(100, 116, 139);

        docData.appliedTerms.forEach((term: string, idx: number) => {
          const wrapped = doc.splitTextToSize(`${idx + 1}. ${term}`, contentWidth - 4);
          doc.text(wrapped, margin + 2, cursorY);
          cursorY += wrapped.length * 4 + 1;
        });
      }

      // Authorization & Acceptance Digital Signatures Block
      let sigY = Math.max(cursorY + 6, gTotalY + 20);
      if (sigY > 235) {
        doc.addPage();
        sigY = 22;
      }

      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.4);
      doc.line(margin, sigY, 210 - margin, sigY);
      sigY += 6;

      // Issuer Signature Box (Left)
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(30, 41, 59);
      doc.text('AUTHORIZED SIGNATURE (ISSUED BY)', margin, sigY);

      if (docData.issuerSignature) {
        const normIssuerSig = await loadNormalizedPngImage(docData.issuerSignature);
        if (normIssuerSig) {
          doc.addImage(normIssuerSig.dataUrl, 'PNG', margin, sigY + 2, 42, 15);
        }
      }
      doc.setDrawColor(148, 163, 184);
      doc.setLineWidth(0.3);
      doc.line(margin, sigY + 19, margin + 78, sigY + 19);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(30, 41, 59);
      doc.text(`Issued By: ${docData.issuedBy || 'Authorized Staff'}`, margin, sigY + 24);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text(`Date: ${new Date(docData.created_at).toLocaleDateString()}`, margin, sigY + 28.5);

      // Delivery Receiver Acceptance Signature Box (Right — shown on Delivery Notes or signed documents)
      if (docData.status === 'DELIVERY_NOTE' || docData.receiverSignature || docData.receiverName) {
        const rx = 113;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(30, 41, 59);
        doc.text('RECEIVER ACCEPTANCE SIGNATURE', rx, sigY);

        if (docData.receiverSignature) {
          const normRecvSig = await loadNormalizedPngImage(docData.receiverSignature);
          if (normRecvSig) {
            doc.addImage(normRecvSig.dataUrl, 'PNG', rx, sigY + 2, 42, 15);
          }
        }
        doc.setDrawColor(148, 163, 184);
        doc.setLineWidth(0.3);
        doc.line(rx, sigY + 19, rx + 82, sigY + 19);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(30, 41, 59);
        doc.text(`Received By: ${docData.receiverName || '________________________'}`, rx, sigY + 24);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(100, 116, 139);
        doc.text(
          docData.acceptedAt ? `Accepted: ${new Date(docData.acceptedAt).toLocaleString()}` : 'Status: Pending Receiver Acceptance',
          rx,
          sigY + 28.5
        );
      }

      // Footnote at page bottom
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8.5);
      doc.setTextColor(148, 163, 184);
      doc.text('Thank you for choice of partnership!', 105, 282, { align: 'center' });
      doc.text('This document is dynamically generated via SME Core Corporate POS.', 105, 286, { align: 'center' });

      const fileName = `${docData.status.replace(/\s+/g, '_')}_${docData.id}.pdf`;
      return { doc, fileName };
    } catch (err: any) {
      console.error('PDF Compile Error:', err);
      setFormNotice({ type: 'error', text: 'Error generating PDF: ' + (err?.message || err) });
      return null;
    }
  };

  const handleDownloadPDF = async (docData: any) => {
    const compiled = await buildQuotePdfDoc(docData);
    if (!compiled) return null;
    exportAndSharePdf(compiled.fileName, compiled.doc);
    return compiled.fileName;
  };

  const handlePrintDoc = async () => {
    if (activeDoc) {
      await handleDownloadPDF(activeDoc);
    } else {
      setFormNotice({ type: 'error', text: 'No active document selected to generate a PDF for.' });
    }
  };

  const handleWhatsAppSharePdf = async () => {
    setWaError(null);
    setWaResult(null);
    if (!activeDoc) {
      setWaError('No quotation or invoice selected to send.');
      return;
    }
    if (!whatsappSharePhone.trim()) {
      setWaError('Please enter a customer WhatsApp phone number (e.g. +26097...).');
      return;
    }
    const compiled = await buildQuotePdfDoc(activeDoc);
    if (!compiled) {
      setWaError('Failed to compile PDF quotation.');
      return;
    }
    const caption = `${activeDoc.status} #${activeDoc.id} • Customer: ${activeDoc.customer_name} • Total: ${settings.currency}${Number(activeDoc.total || 0).toFixed(2)}`;
    setLastCompiledQuotePdf({ doc: compiled.doc, filename: compiled.fileName, caption });
    setWaSending(true);
    try {
      const res = await dispatchPdfToWhatsApp({
        phone: whatsappSharePhone,
        filename: compiled.fileName,
        doc: compiled.doc,
        storeName: companyName || settings.storeName,
        caption,
      });
      if (!res.success) {
        setWaError(res.error || 'Could not dispatch PDF to WhatsApp.');
        return;
      }
      setWaResult(res);
    } catch (err: any) {
      setWaError(err?.message || 'Unexpected error preparing PDF quotation for WhatsApp.');
    } finally {
      setWaSending(false);
    }
  };

  return (
    <div
      ref={workspaceRef}
      dir="ltr"
      onFocusCapture={handleWorkspaceFocusCapture}
      onBlurCapture={handleWorkspaceBlurCapture}
      className="flex-1 min-h-0 flex overflow-hidden flex-col bg-slate-50 relative text-left select-text"
    >
      
      {/* Upper header action controls */}
      <div className="px-5 py-3.5 bg-white border-b border-slate-200 flex flex-wrap justify-between items-center gap-3 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
            <FileText size={20} />
          </div>
          <div>
            <h2 className="text-md font-bold text-slate-800">Quote, Invoice &amp; Delivery Note</h2>
            <p className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">Create, Edit, Sign &amp; Reprint Documents</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {selectedQuote && (
            <button
              type="button"
              onClick={() => {
                setSelectedQuote(null);
                setEditItems([]);
                setIsEditingQuote(false);
                setFormNotice(null);
              }}
              className="flex items-center gap-1 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold cursor-pointer uppercase tracking-wider"
            >
              <Plus size={13} />
              New Quotation Draft
            </button>
          )}
          {activeDoc && (
            <button
              type="button"
              onClick={handlePrintDoc}
              className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer transition-all uppercase tracking-wider shadow-sm"
            >
              <Printer size={14} className="text-white" />
              {activeDoc.isDraft ? 'PRINT / DOWNLOAD PDF' : 'REPRINT / DOWNLOAD PDF'}
            </button>
          )}
        </div>
      </div>

      {formNotice && (
        <div className={`mx-4 mt-3 px-3.5 py-2.5 rounded-xl border text-xs font-bold flex items-center justify-between gap-2 shrink-0 ${
          formNotice.type === 'error'
            ? 'bg-rose-50 border-rose-200 text-rose-800'
            : 'bg-emerald-50 border-emerald-200 text-emerald-800'
        }`}>
          <div className="flex items-center gap-2">
            {formNotice.type === 'error' ? <AlertCircle size={14} className="shrink-0" /> : <CheckCircle size={14} className="shrink-0" />}
            <span>{formNotice.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setFormNotice(null)}
            className="p-0.5 rounded hover:bg-black/5 cursor-pointer shrink-0"
            title="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden scroll-y-touch touch-pan-y keyboard-safe-scroll">
        
        {/* LEFTSIDE DOCUMENT SELECTOR & NEW DOC CREATOR */}
        <div className="w-full lg:w-5/12 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col lg:min-h-0 lg:h-full lg:overflow-y-auto p-4 gap-4 shrink-0 keyboard-safe-scroll">
          
          {/* Section: Create New Quote with Tabbed Flow */}
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 shadow-xs flex flex-col gap-3">
            <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-100 pb-2">
              <Building size={14} className="text-indigo-600" />
              1. DOCUMENT WORKSTATION CREATOR
            </h3>

            {/* Step Tabs Selector */}
            <div className="flex border-b border-slate-200 mt-1 font-sans text-[10px] gap-1 pb-1">
              <button
                type="button"
                onClick={() => setActiveFormTab('client_bank')}
                className={`flex-1 py-1.5 px-2 font-bold uppercase rounded-lg text-center transition-all cursor-pointer ${
                  activeFormTab === 'client_bank' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                1. Info &amp; Bank
              </button>
              <button
                type="button"
                onClick={() => setActiveFormTab('items_stock')}
                className={`flex-1 py-1.5 px-2 font-bold uppercase rounded-lg text-center transition-all cursor-pointer ${
                  activeFormTab === 'items_stock' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                2. Stock ({cartItems.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveFormTab('terms_conditions')}
                className={`flex-1 py-1.5 px-2 font-bold uppercase rounded-lg text-center transition-all cursor-pointer ${
                  activeFormTab === 'terms_conditions' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                3. T&amp;C ({selectedTermIds.length})
              </button>
            </div>

            <div className="flex flex-col gap-3">
              
              {/* TAB 1: CLIENT & BANK INFO */}
              {activeFormTab === 'client_bank' && (
                <div className="flex flex-col gap-3 font-sans mt-1">
                  {/* Document Type & Date Controls */}
                  <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-xs grid grid-cols-2 gap-2.5">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] text-slate-500 font-bold uppercase">Document Type</label>
                      <select
                        dir="ltr"
                        value={draftDocType}
                        onChange={(e) => setDraftDocType(e.target.value as 'QUOTATION' | 'INVOICE' | 'DELIVERY_NOTE')}
                        className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 font-bold text-left focus:outline-hidden cursor-pointer"
                      >
                        <option value="QUOTATION">Quotation</option>
                        <option value="INVOICE">Tax Invoice</option>
                        <option value="DELIVERY_NOTE">Delivery Note</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] text-slate-500 font-bold uppercase">Document Date</label>
                      <input
                        type="date"
                        dir="ltr"
                        value={draftDate}
                        onChange={(e) => setDraftDate(e.target.value)}
                        className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 font-bold text-left select-text focus:outline-hidden"
                      />
                    </div>
                  </div>

                  {/* Customer Corporate profile */}
                  <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-xs flex flex-col gap-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-indigo-700 font-extrabold uppercase block tracking-wider">Customer Contact Profile</span>
                      {existingCustomers.length > 0 && (
                        <select
                          dir="ltr"
                          value=""
                          onChange={(e) => {
                            const cust = existingCustomers.find(c => String(c.id) === e.target.value);
                            if (cust) {
                              setCName(cust.name || '');
                              setCPhone(cust.phone || '');
                              setCEmail(cust.email || '');
                              if (selectedQuote) setSelectedQuote(null);
                            }
                          }}
                          className="text-[10px] bg-indigo-50 border border-indigo-200 text-indigo-800 rounded-lg px-2 py-1 font-bold cursor-pointer max-w-[165px] text-left focus:outline-hidden"
                        >
                          <option value="">Load Saved Customer...</option>
                          {existingCustomers.map(c => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] text-slate-500 font-bold uppercase">Customer Corporate Name *</label>
                      <input
                        type="text"
                        dir="ltr"
                        required
                        value={cName}
                        onChange={(e) => {
                          setCName(e.target.value);
                          if (selectedQuote) setSelectedQuote(null);
                          if (formNotice) setFormNotice(null);
                        }}
                        placeholder="Enter customer or company name"
                        className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 font-semibold text-left select-text focus:outline-hidden"
                      />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Phone Number</label>
                        <input
                          type="tel"
                          dir="ltr"
                          value={cPhone}
                          onChange={(e) => setCPhone(e.target.value)}
                          placeholder="+260 977 XXXXXX"
                          className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 font-semibold text-left select-text focus:outline-hidden"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Email Address</label>
                        <input
                          type="email"
                          dir="ltr"
                          value={cEmail}
                          onChange={(e) => setCEmail(e.target.value)}
                          placeholder="client@company.com"
                          className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 font-semibold text-left select-text focus:outline-hidden"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Bank details input fields with headings */}
                  <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-xs flex flex-col gap-2.5">
                    <div className="flex justify-between items-center pb-1.5 border-b border-slate-100">
                      <span className="text-[10px] text-indigo-700 font-extrabold uppercase tracking-wider">Payment Bank Details (Optional)</span>
                      <button
                        type="button"
                        onClick={() => {
                          const details = {
                            bankName,
                            bankAccountName,
                            bankAccountNumber,
                            bankBranchName,
                            bankSortCode
                          };
                          localStorage.setItem('pos_default_bank_details', JSON.stringify(details));
                          setFormNotice({ type: 'success', text: 'Default bank details saved for future quotations.' });
                        }}
                        className="text-[9px] text-indigo-600 hover:text-indigo-800 font-bold uppercase hover:underline cursor-pointer"
                      >
                        Set as Default
                      </button>
                    </div>

                    <div className="flex flex-col gap-2 text-xs">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Bank Name</label>
                        <input
                          type="text"
                          dir="ltr"
                          value={bankName}
                          onChange={(e) => setBankName(e.target.value)}
                          placeholder="Zambia National Commercial Bank"
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 text-xs font-semibold text-left select-text focus:outline-hidden"
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Account Name</label>
                        <input
                          type="text"
                          dir="ltr"
                          value={bankAccountName}
                          onChange={(e) => setBankAccountName(e.target.value)}
                          placeholder="SME Retailers Ltd"
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 text-xs font-semibold text-left select-text focus:outline-hidden"
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Account Number</label>
                        <input
                          type="text"
                          dir="ltr"
                          value={bankAccountNumber}
                          onChange={(e) => setBankAccountNumber(e.target.value)}
                          placeholder="1020088991102"
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 text-xs font-bold font-mono text-left select-text focus:outline-hidden"
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase">Branch Name</label>
                          <input
                            type="text"
                            dir="ltr"
                            value={bankBranchName}
                            onChange={(e) => setBankBranchName(e.target.value)}
                            placeholder="Lusaka Commercial Branch"
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 text-xs font-medium text-left select-text focus:outline-hidden"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase">Sort Code</label>
                          <input
                            type="text"
                            dir="ltr"
                            value={bankSortCode}
                            onChange={(e) => setBankSortCode(e.target.value)}
                            placeholder="01-02-03"
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 text-xs font-bold font-mono text-left select-text focus:outline-hidden"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Issuer Name & Digital Signature */}
                  <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-xs flex flex-col gap-2.5">
                    <div className="flex justify-between items-center pb-1.5 border-b border-slate-100">
                      <span className="text-[10px] text-indigo-700 font-extrabold uppercase tracking-wider flex items-center gap-1">
                        <PenTool size={11} /> Issuer Name &amp; Digital Signature
                      </span>
                      {issuerSignature && (
                        <button
                          type="button"
                          onClick={() => {
                            localStorage.setItem('pos_default_issuer_signature', issuerSignature);
                            setFormNotice({ type: 'success', text: 'Default issuer digital signature saved for all documents.' });
                          }}
                          className="text-[9px] text-indigo-600 hover:text-indigo-800 font-bold uppercase hover:underline cursor-pointer"
                        >
                          Save as Default
                        </button>
                      )}
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] text-slate-500 font-bold uppercase">Issued By (Full Name)</label>
                      <input
                        type="text"
                        dir="ltr"
                        value={issuerName}
                        onChange={(e) => setIssuerName(e.target.value)}
                        placeholder="Name of person issuing document"
                        className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 font-semibold text-left select-text focus:outline-hidden"
                      />
                    </div>

                    <SignaturePad
                      value={issuerSignature}
                      onChange={(sig) => {
                        setIssuerSignature(sig);
                        if (sig) {
                          localStorage.setItem('pos_default_issuer_signature', sig);
                        } else {
                          localStorage.removeItem('pos_default_issuer_signature');
                        }
                      }}
                      label="Authorized Issuer Digital Signature"
                      height={100}
                      placeholder="Sign here (auto-saved for quotations, invoices & delivery notes)"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => setActiveFormTab('items_stock')}
                    className="w-full py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold uppercase rounded-lg text-xs cursor-pointer"
                  >
                    Next: Add Products &amp; Stock &rarr;
                  </button>
                </div>
              )}

              {/* TAB 2: STOCK INDEX & INVENTORY SHELF */}
              {activeFormTab === 'items_stock' && (
                <div className="flex flex-col gap-3 font-sans mt-1">
                  
                  {/* Quick Product Creator directly to Inventory Stock */}
                  <div className="border border-indigo-200 rounded-xl p-3 bg-indigo-50/20">
                    <div className="flex justify-between items-center">
                      <span className="font-extrabold text-[10px] text-indigo-900 uppercase">📦 Want to add a new stock item?</span>
                      <button
                        type="button"
                        onClick={() => setShowAddCatalogProduct(!showAddCatalogProduct)}
                        className="text-[9px] bg-indigo-600 hover:bg-indigo-700 text-white font-black px-2 py-0.5 rounded uppercase cursor-pointer"
                      >
                        {showAddCatalogProduct ? 'CLOSE PANEL' : '+ QUICK CREATE NEW ITEM'}
                      </button>
                    </div>

                    {showAddCatalogProduct && (
                      <div className="flex flex-col gap-2.5 mt-2.5 pt-2.5 border-t border-indigo-100 text-xs">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase">Item Name *</label>
                          <input
                            type="text"
                            dir="ltr"
                            placeholder="Copper spool wire 5mm"
                            value={newCatalogName}
                            onChange={(e) => setNewCatalogName(e.target.value)}
                            className="w-full px-3 py-2 border border-slate-200 focus:border-indigo-500 rounded-lg font-semibold bg-white text-slate-900 text-xs text-left select-text focus:outline-hidden"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase">Item Description / Full Features</label>
                          <textarea
                            rows={3}
                            dir="ltr"
                            placeholder="Enter full specifications, features, dimensions, model or warranty details..."
                            value={newCatalogDescription}
                            onChange={(e) => setNewCatalogDescription(e.target.value)}
                            className="w-full px-3 py-2 border border-slate-200 focus:border-indigo-500 rounded-lg font-medium bg-white text-slate-900 text-xs text-left select-text focus:outline-hidden resize-y"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2.5">
                          <div className="flex flex-col gap-1">
                            <label className="text-[10px] text-slate-500 font-bold uppercase">Selling Price ({settings.currency}) *</label>
                            <input
                              type="number"
                              dir="ltr"
                              step="0.01"
                              placeholder="350.00"
                              value={newCatalogPrice}
                              onChange={(e) => setNewCatalogPrice(e.target.value)}
                              className="w-full px-3 py-2 border border-slate-200 focus:border-indigo-500 rounded-lg font-bold text-slate-900 bg-white text-xs text-left select-text focus:outline-hidden"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-[10px] text-slate-500 font-bold uppercase">Stock Count</label>
                            <input
                              type="number"
                              dir="ltr"
                              placeholder="150"
                              value={newCatalogStock}
                              onChange={(e) => setNewCatalogStock(e.target.value)}
                              className="w-full px-3 py-2 border border-slate-200 focus:border-indigo-500 rounded-lg text-slate-900 bg-white font-medium text-xs text-left select-text focus:outline-hidden"
                            />
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            if (!newCatalogName.trim() || !newCatalogPrice) {
                              setFormNotice({ type: 'error', text: 'Please enter both Item Name and Selling Price.' });
                              return;
                            }
                            const priceVal = parseFloat(newCatalogPrice) || 0;
                            const stockCount = parseInt(newCatalogStock, 10) || 0;
                            const costVal = priceVal * 0.7;
                            const pId = Math.floor(100000 + Math.random() * 900000);
                            const skuVal = `QT-${pId}`;
                            const bizId = getActiveBusinessId();
                            const targetStoreId = getActiveStoreId(activeStore, bizId);
                            const safeName = newCatalogName.trim().replace(/'/g, "''");
                            const cleanDesc = newCatalogDescription.trim();
                            const safeDesc = cleanDesc.replace(/'/g, "''");

                            const qryInsert = `
                              INSERT INTO products (id, name, description, sku, category, stock, cost, price, business_id, store_id, is_service)
                              VALUES (
                                ${pId},
                                '${safeName}',
                                '${safeDesc}',
                                '${skuVal}',
                                'General',
                                ${stockCount},
                                ${costVal.toFixed(2)},
                                ${priceVal.toFixed(2)},
                                '${sqlEsc(bizId)}',
                                '${sqlEsc(targetStoreId)}',
                                0
                              )
                            `;
                            const r = runSql(qryInsert, `Stock Inventory quick registration: ${newCatalogName}`);
                            if (r.success) {
                              if (targetStoreId) {
                                runSql(`INSERT INTO store_products (id, product_id, store_id, stock, price, business_id) VALUES ('sp_${pId}_${sqlEsc(targetStoreId)}', ${pId}, '${sqlEsc(targetStoreId)}', ${stockCount}, ${priceVal.toFixed(2)}, '${sqlEsc(bizId)}')`, 'Register branch stock map', true);
                              }
                              if (selectedQuote) setSelectedQuote(null);
                              setCartItems([
                                ...cartItems,
                                {
                                  id: pId,
                                  name: newCatalogName.trim(),
                                  description: cleanDesc,
                                  quantity: 1,
                                  unitPrice: priceVal
                                }
                              ]);
                              setNewCatalogName('');
                              setNewCatalogDescription('');
                              setNewCatalogPrice('');
                              setNewCatalogStock('100');
                              setShowAddCatalogProduct(false);
                              loadQuotations();
                              persistTablesToStorage();
                              try { window.dispatchEvent(new Event('pos_data_updated')); } catch {}
                              setFormNotice({ type: 'success', text: `✓ "${newCatalogName.trim()}" added to catalog and quotation basket.` });
                            } else {
                              setFormNotice({ type: 'error', text: 'Error registering product: ' + (r.error || 'Unknown error') });
                            }
                          }}
                          className="py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-black uppercase rounded shadow-xs text-[10px] tracking-wider mt-1 cursor-pointer"
                        >
                          Register Stock &amp; Add to Quote
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Stock Search Box */}
                  <div className="relative">
                    <input
                      type="text"
                      dir="ltr"
                      placeholder="Search items with stock limits..."
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                      className="w-full text-xs py-2 pl-8 pr-3 bg-white border border-slate-200 focus:border-indigo-500 rounded-lg font-medium text-slate-900 text-left select-text focus:outline-hidden"
                    />
                    <span className="absolute left-2.5 top-2.5 text-slate-400"><Search size={12} /></span>
                  </div>

                  {/* Stock Available Selector Shelf */}
                  <div className="max-h-52 overflow-y-auto border border-slate-200 bg-white rounded-lg p-1.5 flex flex-col gap-1.5 shadow-inner">
                    {(() => {
                      const filtered = allProducts.filter(p => p.name.toLowerCase().includes(productSearch.toLowerCase()));
                      if (filtered.length === 0) {
                        return <div className="text-center text-slate-400 text-[10px] font-bold p-5 uppercase">No stock products found</div>;
                      }
                      return filtered.map(p => {
                        const cartItem = cartItems.find(x => x.id === p.id);
                        const qtyInCart = cartItem ? cartItem.quantity : 0;
                        return (
                          <div key={p.id} className="p-2 bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-between gap-2 text-xs transition-colors hover:border-slate-200">
                            <div className="min-w-0 flex-1">
                              <span className="font-extrabold text-slate-900 leading-tight block">{p.name}</span>
                              {p.description && (
                                <p className="text-[10px] text-slate-500 font-medium whitespace-pre-line line-clamp-2 mt-0.5 leading-snug" title={p.description}>
                                  {p.description}
                                </p>
                              )}
                              <div className="flex items-center gap-2 text-[9px] mt-0.5">
                                <span className={`px-1.5 py-0.5 rounded font-bold uppercase text-[8px] ${
                                  p.is_service === 1 ? 'bg-indigo-100 text-indigo-800' : p.stock > 10 ? 'bg-emerald-100 text-emerald-800' : p.stock > 0 ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'
                                }`}>
                                  {p.is_service === 1 ? 'Service (Unlimited)' : `🏠 Stock: ${p.stock}`}
                                </span>
                                <span className="text-slate-500 font-extrabold">• {settings.currency}{p.price.toFixed(2)}</span>
                              </div>
                            </div>

                            {qtyInCart > 0 ? (
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (qtyInCart <= 1) {
                                      removeCartItem(p.id);
                                    } else {
                                      handleUpdateCartQty(p.id, (qtyInCart - 1).toString());
                                    }
                                  }}
                                  className="w-5 h-5 bg-indigo-50 border border-indigo-200 text-indigo-700 font-bold rounded flex items-center justify-center hover:bg-indigo-100 cursor-pointer"
                                >
                                  -
                                </button>
                                <input
                                  type="number"
                                  dir="ltr"
                                  value={qtyInCart}
                                  onChange={(e) => handleUpdateCartQty(p.id, e.target.value)}
                                  className="w-10 text-left px-1.5 text-[10px] font-extrabold font-mono border border-slate-200 focus:border-indigo-500 rounded bg-white text-slate-900 py-0.5 select-text focus:outline-hidden"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleUpdateCartQty(p.id, (qtyInCart + 1).toString())}
                                  className="w-5 h-5 bg-indigo-50 border border-indigo-200 text-indigo-700 font-bold rounded flex items-center justify-center hover:bg-indigo-100 cursor-pointer"
                                >
                                  +
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => addToCart(p)}
                                className="px-2 py-1 bg-white hover:bg-indigo-50 border border-indigo-200 text-indigo-700 rounded font-bold text-[9px] cursor-pointer"
                              >
                                + ADD TO QUOTE
                              </button>
                            )}
                          </div>
                        );
                      });
                    })()}
                  </div>

                  {/* Discount details */}
                  <div className="flex items-center justify-between bg-white border border-slate-200 p-2.5 rounded-lg">
                    <span className="text-[10px] text-slate-500 font-bold uppercase">Flat Discount Value ({settings.currency}):</span>
                    <input
                      type="number"
                      dir="ltr"
                      step="0.01"
                      value={discountVal}
                      onChange={(e) => setDiscountVal(e.target.value)}
                      className="w-24 text-left px-2.5 text-xs font-bold bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg py-1.5 text-slate-900 select-text focus:outline-hidden leading-tight"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => setActiveFormTab('terms_conditions')}
                    className="w-full py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold uppercase rounded-lg text-xs cursor-pointer"
                  >
                    Next: Pick Terms &amp; Conditions &rarr;
                  </button>
                </div>
              )}

              {/* TAB 3: TERMS & CONDITIONS SELECTION LIBRARY */}
              {activeFormTab === 'terms_conditions' && (
                <div className="flex flex-col gap-3 font-sans mt-1">
                  <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-xs flex flex-col gap-2">
                    <span className="text-[10px] text-indigo-800 font-extrabold uppercase tracking-wider">Select Terms that apply to customer</span>
                    
                    <div className="flex flex-col gap-2 max-h-40 overflow-y-auto pr-1">
                      {savedTerms.map(t => (
                        <label key={t.id} className="flex items-start gap-2 p-2 bg-slate-50 hover:bg-indigo-50/25 rounded-md border cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedTermIds.includes(t.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedTermIds([...selectedTermIds, t.id]);
                              } else {
                                setSelectedTermIds(selectedTermIds.filter(x => x !== t.id));
                              }
                            }}
                            className="mt-0.5 shrink-0"
                          />
                          <div className="text-[10px]">
                            <div className="flex items-center justify-between gap-2">
                              <strong className="text-slate-800 uppercase">{t.title}</strong>
                              {confirmDeleteTermId === t.id ? (
                                <span className="inline-flex items-center gap-1 ml-auto">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      const next = savedTerms.filter(x => x.id !== t.id);
                                      setSavedTerms(next);
                                      setSelectedTermIds(selectedTermIds.filter(id => id !== t.id));
                                      localStorage.setItem('pos_custom_terms', JSON.stringify(next));
                                      setConfirmDeleteTermId(null);
                                    }}
                                    className="text-rose-700 font-black text-[8px] uppercase underline cursor-pointer"
                                  >
                                    Confirm
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      setConfirmDeleteTermId(null);
                                    }}
                                    className="text-slate-500 text-[8px] uppercase cursor-pointer"
                                  >
                                    Cancel
                                  </button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setConfirmDeleteTermId(t.id);
                                  }}
                                  className="text-rose-500 hover:text-rose-700 text-[8px] uppercase underline ml-auto cursor-pointer"
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                            <p className="text-slate-500 font-medium leading-relaxed mt-0.5">{t.text}</p>
                          </div>
                        </label>
                      ))}
                      {savedTerms.length === 0 && (
                        <p className="text-center font-bold text-slate-400 text-[10px] py-4 uppercase">No custom T&amp;C preset available.</p>
                      )}
                    </div>
                  </div>

                  {/* Advance T&C Creator Panel */}
                  <div className="bg-indigo-50/20 border border-indigo-200 rounded-xl p-3 flex flex-col gap-2">
                    <span className="text-[9px] text-indigo-900 font-extrabold uppercase">➕ Create New Terms in Advance</span>
                    <div className="flex flex-col gap-2 text-xs">
                      <input
                        type="text"
                        dir="ltr"
                        placeholder="e.g. Warranty Period"
                        value={newTermTitle}
                        onChange={(e) => setNewTermTitle(e.target.value)}
                        className="w-full px-3 py-1.5 border border-slate-200 focus:border-indigo-500 rounded-lg bg-white text-slate-900 font-semibold text-xs text-left select-text focus:outline-hidden"
                      />
                      <textarea
                        dir="ltr"
                        placeholder="Detailed Terms text content that will print beautifully on the quotation sheet..."
                        value={newTermText}
                        onChange={(e) => setNewTermText(e.target.value)}
                        rows={2}
                        className="w-full px-3 py-1.5 border border-slate-200 focus:border-indigo-500 rounded-lg bg-white text-slate-900 text-xs text-left select-text focus:outline-hidden resize-y"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!newTermTitle.trim() || !newTermText.trim()) {
                            setFormNotice({ type: 'error', text: 'Please enter both a Term Title and Terms rule text.' });
                            return;
                          }
                          const termId = 'term-' + Math.floor(1000 + Math.random() * 9000);
                          const item = { id: termId, title: newTermTitle.trim(), text: newTermText.trim() };
                          const list = [...savedTerms, item];
                          setSavedTerms(list);
                          localStorage.setItem('pos_custom_terms', JSON.stringify(list));
                          setNewTermTitle('');
                          setNewTermText('');
                          setFormNotice({ type: 'success', text: '✓ Custom term added to library.' });
                        }}
                        className="py-1.5 px-3 bg-indigo-600 hover:bg-indigo-700 text-white text-[9px] font-black uppercase rounded-lg self-end cursor-pointer"
                      >
                        Save to Advance Library
                      </button>
                    </div>
                  </div>

                </div>
              )}

              {/* ALWAYS VISIBLE LIVE BASKET PREVIEW (Addresses key user request) */}
              <div className="bg-white p-3.5 rounded-xl border border-indigo-200 mt-2 shadow-xs flex flex-col gap-3 font-sans">
                <div className="flex justify-between items-center border-b border-slate-100 pb-2">
                  <span className="text-[10px] text-indigo-800 font-black uppercase tracking-wider flex items-center gap-1">
                    <ShoppingBag size={12} className="text-indigo-600" />
                    🛒 Quotation Live Basket Review
                  </span>
                  <span className="text-[10px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full font-mono">
                    {cartItems.length} {cartItems.length === 1 ? 'item' : 'items'}
                  </span>
                </div>

                {cartItems.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {/* Items List Scroll Area */}
                    <div className="max-h-56 overflow-y-auto divide-y divide-slate-100 pr-1 flex flex-col">
                      {cartItems.map((item) => {
                        const lineTotal = Number(item.unitPrice || 0) * Number(item.quantity || 0);
                        return (
                          <div key={item.id} className="py-2.5 flex flex-col gap-1.5 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <span className="font-extrabold text-slate-800 block truncate">{item.name}</span>
                                <div className="flex items-center gap-1 mt-0.5">
                                  <span className="text-[9px] text-slate-400 font-bold">{settings.currency}</span>
                                  <input
                                    type="number"
                                    dir="ltr"
                                    step="0.01"
                                    min="0"
                                    value={item.unitPrice}
                                    onChange={(e) => handleUpdateCartPrice(item.id, e.target.value)}
                                    className="w-20 px-2 py-0.5 text-[11px] text-slate-900 font-bold font-mono bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded text-left select-text focus:outline-hidden"
                                    title="Adjust unit price"
                                  />
                                  <span className="text-[9px] text-slate-400">each</span>
                                </div>
                              </div>

                              <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-lg p-0.5 shadow-xs shrink-0">
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (item.quantity <= 1) {
                                      removeCartItem(item.id);
                                    } else {
                                      handleUpdateCartQty(item.id, (item.quantity - 1).toString());
                                    }
                                  }}
                                  className="w-5 h-5 text-slate-500 hover:text-indigo-600 font-extrabold rounded flex items-center justify-center hover:bg-slate-200 text-xs transition-colors cursor-pointer"
                                >
                                  -
                                </button>
                                <span className="w-6 text-center text-[11px] font-black font-mono text-slate-800">
                                  {item.quantity}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleUpdateCartQty(item.id, (item.quantity + 1).toString())}
                                  className="w-5 h-5 text-slate-500 hover:text-indigo-600 font-extrabold rounded flex items-center justify-center hover:bg-slate-200 text-xs transition-colors cursor-pointer"
                                >
                                  +
                                </button>
                              </div>

                              <div className="flex items-center gap-1.5 shrink-0">
                                <span className="font-extrabold text-slate-800 font-mono text-right w-16">
                                  {settings.currency}{lineTotal.toFixed(2)}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => removeCartItem(item.id)}
                                  className="p-1 hover:bg-rose-50 text-rose-500 rounded hover:text-rose-700 transition-colors cursor-pointer"
                                  title="Remove line item"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </div>
                            <textarea
                              rows={2}
                              dir="ltr"
                              value={item.description || ''}
                              onChange={(e) => handleUpdateCartDescription(item.id, e.target.value)}
                              placeholder="Optional item description / full features to show on quotation..."
                              className="w-full px-2.5 py-1.5 text-[11px] text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-indigo-500 text-left select-text focus:outline-hidden resize-y"
                            />
                          </div>
                        );
                      })}
                    </div>

                    {/* Financial Summary card with Discount inline modifier */}
                    <div className="bg-slate-50/50 p-3 rounded-lg border border-slate-100 flex flex-col gap-1.5 text-xs font-medium text-slate-600 mt-1">
                      <div className="flex justify-between items-center text-[11px]">
                        <span>Subtotal Value:</span>
                        <span className="font-bold font-mono text-slate-800">
                          {settings.currency}{calculateSubtotal().toFixed(2)}
                        </span>
                      </div>

                      <div className="flex justify-between items-center border-t border-dashed border-slate-200/50 pt-1.5 pb-1 flex-wrap gap-2">
                        <span className="text-[11px] flex items-center gap-1 shrink-0">Discount Amount ({settings.currency}):</span>
                        <input
                          type="number"
                          dir="ltr"
                          step="0.01"
                          placeholder="0.00"
                          value={discountVal}
                          onChange={(e) => setDiscountVal(e.target.value)}
                          className="w-20 text-left px-2 text-[11px] font-mono font-bold bg-white border border-slate-200 focus:border-indigo-500 rounded-lg py-1 text-slate-900 shadow-xs select-text focus:outline-hidden"
                        />
                      </div>

                      {(() => {
                        const sub = calculateSubtotal();
                        const disc = parseFloat(discountVal) || 0;
                        const tax = (sub - disc) * (settings.taxRate / 100);
                        const grandTotal = sub - disc + tax;
                        return (
                          <>
                            <div className="flex justify-between items-center text-[11px]">
                              <span>VAT ({settings.taxRate}%):</span>
                              <span className="font-extrabold font-mono text-slate-700">
                                {settings.currency}{tax.toFixed(2)}
                              </span>
                            </div>
                            <div className="flex justify-between items-center text-xs font-black text-indigo-950 border-t pt-1.5 border-slate-200">
                              <span className="uppercase text-[10px] tracking-wider text-indigo-900">Calculated Grand Total:</span>
                              <span className="text-sm font-mono text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-lg border border-indigo-100">
                                {settings.currency}{grandTotal.toFixed(2)}
                              </span>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                ) : (
                  <div className="p-5 border border-dashed rounded-lg bg-slate-50/50 text-center flex flex-col items-center gap-1">
                    <span className="text-slate-400 font-bold text-xs uppercase tracking-wide">Basket is empty</span>
                    <p className="text-[10px] text-slate-400 font-semibold leading-normal max-w-[240px]">
                      Select items in <span className="text-indigo-600 font-extrabold">2. Stock</span> tab to build a real-time live preview list before generating documents.
                    </p>
                  </div>
                )}

                {/* Submission Button */}
                <button
                  type="button"
                  onClick={() => handleSaveQuotation()}
                  className={`w-full py-2.5 rounded-xl text-xs font-black transition-all flex items-center justify-center gap-1.5 mt-1 cursor-pointer tracking-wider uppercase ${
                    cartItems.length === 0 || !cName.trim()
                      ? 'bg-slate-200 hover:bg-slate-300 text-slate-700 border border-slate-300' 
                      : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm hover:shadow-md'
                  }`}
                >
                  <CheckCircle size={13} />
                  {draftDocType === 'INVOICE'
                    ? 'SAVE TAX INVOICE'
                    : draftDocType === 'DELIVERY_NOTE'
                      ? 'SAVE DELIVERY NOTE'
                      : 'CREATE CHOSEN QUOTATION'}
                </button>
              </div>

            </div>
          </div>

          {/* Saved Archive of Quotations, Invoices & Delivery Notes */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-extrabold text-slate-400 uppercase tracking-wider">Saved Document Records</h4>
              <span className="text-[10px] font-bold text-slate-500 font-mono">{quotations.length} total</span>
            </div>

            {/* Archive Search */}
            <div className="relative">
              <input
                type="text"
                dir="ltr"
                value={docSearch}
                onChange={(e) => setDocSearch(e.target.value)}
                placeholder="Search ID, customer, phone or date..."
                className="w-full text-xs py-2 pl-8 pr-7 border border-slate-200 focus:border-indigo-500 rounded-lg bg-white text-slate-900 font-medium text-left select-text focus:outline-hidden"
              />
              <Search size={12} className="absolute left-2.5 top-2.5 text-slate-400" />
              {docSearch && (
                <button
                  type="button"
                  onClick={() => setDocSearch('')}
                  className="absolute right-2 top-2 text-slate-400 hover:text-slate-600 cursor-pointer"
                  title="Clear search"
                >
                  <X size={13} />
                </button>
              )}
            </div>
            
            {/* Filter Tabs */}
            <div className="flex bg-slate-100 p-1 rounded-lg gap-1 border border-slate-200">
              {(['ALL', 'QUOTATION', 'INVOICE', 'DELIVERY_NOTE'] as const).map(f => {
                const count = f === 'ALL' ? quotations.length : quotations.filter(q => q.status === f).length;
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setDocFilter(f)}
                    className={`flex-1 text-[9px] font-extrabold uppercase py-1 rounded-md transition-all leading-tight cursor-pointer ${
                      docFilter === f 
                        ? 'bg-white text-indigo-700 shadow-xs' 
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {f === 'DELIVERY_NOTE' ? 'DELIV' : f} ({count})
                  </button>
                );
              })}
            </div>

            <div className="divide-y divide-slate-100 border rounded-xl overflow-hidden bg-white max-h-96 overflow-y-auto">
              {(() => {
                const qTerm = docSearch.trim().toLowerCase();
                const filtered = quotations.filter(q => {
                  if (docFilter !== 'ALL' && q.status !== docFilter) return false;
                  if (!qTerm) return true;
                  const dateTxt = toDateInputValue(q.created_at).toLowerCase();
                  return (
                    String(q.id || '').toLowerCase().includes(qTerm) ||
                    String(q.customer_name || '').toLowerCase().includes(qTerm) ||
                    String(q.customer_phone || '').toLowerCase().includes(qTerm) ||
                    dateTxt.includes(qTerm)
                  );
                });
                if (filtered.length === 0) {
                  return <div className="p-6 text-center text-slate-400 text-xs">No {docFilter.toLowerCase().replace('_', ' ')}s found.</div>;
                }
                return filtered.map(q => {
                  const isQuote = q.status === 'QUOTATION';
                  const isInv = q.status === 'INVOICE';
                  const qExtra = getQuoteExtra(q.id, q.extra_json);
                  return (
                    <div
                      key={q.id}
                      onClick={() => { setSelectedQuote(q); setEditItems(parseQuoteItems(q.items_json)); setIsEditingQuote(false); setFormNotice(null); }}
                      className={`p-3 hover:bg-slate-50 transition-all cursor-pointer relative flex flex-col gap-1.5 ${
                        selectedQuote?.id === q.id ? 'bg-indigo-50/50 border-l-4 border-l-indigo-600' : ''
                      }`}
                    >
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-xs font-bold text-slate-800 truncate">{q.customer_name}</span>
                        <span className={`text-[8px] font-extrabold uppercase px-1.5 py-0.5 rounded-md shrink-0 ${
                          isQuote ? 'bg-indigo-100 text-indigo-800' : isInv ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'
                        }`}>
                          {q.status === 'DELIVERY_NOTE' ? 'DELIVERY NOTE' : q.status}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-[10px] text-slate-400 font-mono">
                        <span>
                          {q.id} • {new Date(q.created_at).toLocaleDateString()}
                          {qExtra.sourceDocId ? ` • From ${qExtra.sourceDocId}` : ''}
                        </span>
                        <strong className="text-slate-700 text-xs">{settings.currency}{Number(q.total || 0).toFixed(2)}</strong>
                      </div>
                      <div className="flex items-center justify-between gap-2 pt-0.5">
                        <span className="text-[9px] text-slate-400 font-semibold">
                          {q.updated_at ? `Edited ${new Date(q.updated_at).toLocaleDateString()}` : 'Original record'}
                          {qExtra.receiverSignature ? ' • ✓ Signed' : ''}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedQuote(q);
                              startEditingQuotation(q);
                            }}
                            className="px-2 py-0.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded text-[9px] font-extrabold uppercase cursor-pointer inline-flex items-center gap-1"
                          >
                            <Edit3 size={9} /> Edit
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedQuote(q);
                              setEditItems(parseQuoteItems(q.items_json));
                              setIsEditingQuote(false);
                              const parsedItems = parseQuoteItems(q.items_json);
                              handleDownloadPDF({
                                id: q.id,
                                status: q.status,
                                created_at: q.created_at,
                                customer_name: q.customer_name,
                                customer_phone: q.customer_phone,
                                customer_email: q.customer_email,
                                bank_name: q.bank_name,
                                bank_account: q.bank_account,
                                bank_branch: q.bank_branch,
                                items: parsedItems,
                                subtotal: Number(q.subtotal || 0),
                                discount: Number(q.discount || 0),
                                tax: Number(q.tax || 0),
                                total: Number(q.total || 0),
                                appliedTerms: qExtra.appliedTerms || [],
                                bankAccountName: qExtra.bankAccountName || companyName,
                                bankSortCode: qExtra.bankSortCode || '',
                                issuedBy: qExtra.issuedBy || issuerName || localStorage.getItem('logged_in_user_name') || '',
                                issuerSignature: qExtra.issuerSignature || '',
                                receiverName: qExtra.receiverName || '',
                                receiverSignature: qExtra.receiverSignature || '',
                                acceptedAt: qExtra.acceptedAt || '',
                              });
                            }}
                            className="px-2 py-0.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-[9px] font-extrabold uppercase cursor-pointer inline-flex items-center gap-1"
                          >
                            <Printer size={9} /> Reprint
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>

        </div>

        {/* RIGHTSIDE LIVE PREVIEW SHEET / PRINTER MOCK */}
        <div className="flex-1 min-h-0 bg-slate-100 lg:h-full lg:overflow-y-auto p-4 sm:p-5 relative keyboard-safe-scroll">
          
          {activeDoc ? (
            <div className="flex flex-col gap-4 max-w-2xl mx-auto">
              
              {/* Actions Workflow Action Panel */}
              <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-sm flex flex-wrap items-center justify-between gap-3 shrink-0 font-sans">
                <div className="flex items-center gap-2 text-left">
                  <span className="text-xs font-extrabold text-slate-500 uppercase tracking-wider block">Document Profile</span>
                  <p className={`text-[11px] font-black uppercase px-2.5 py-1 rounded-md tracking-wider leading-none ${
                    activeDoc.isDraft ? 'bg-amber-100 text-amber-800 border border-amber-200' : 'bg-indigo-100 text-indigo-800 border border-indigo-200'
                  }`}>
                    {activeDoc.status}
                  </p>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">
                  {activeDoc.isDraft ? (
                    <button
                      type="button"
                      onClick={() => handleSaveQuotation()}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-[11px] rounded-lg shadow-sm cursor-pointer tracking-wider flex items-center gap-1.5 uppercase transition-all hover:scale-[1.01]"
                    >
                      <CheckCircle size={13} />
                      CREATE CHOSEN QUOTATION
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedQuote(null);
                          setEditItems([]);
                          setIsEditingQuote(false);
                        }}
                        className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[11px] rounded-lg cursor-pointer tracking-wider flex items-center gap-1 transition-all"
                        title="Deselect this document to start a new blank draft"
                      >
                        <Plus size={11} />
                        CREATE NEW DRAFT
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (isEditingQuote) {
                            setIsEditingQuote(false);
                          } else {
                            startEditingQuotation(selectedQuote!);
                          }
                        }}
                        className="px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold text-[11px] rounded-lg cursor-pointer tracking-wider flex items-center gap-1 transition-all"
                      >
                        <Edit3 size={11} />
                        {isEditingQuote ? 'VIEW PREVIEW' : 'EDIT PRICE / QTY / DATE'}
                      </button>
                      {activeDoc.status === 'QUOTATION' && (
                        <button
                          type="button"
                          onClick={() => handleConvertToInvoice(activeDoc.id)}
                          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-[11px] rounded-lg shadow-xs cursor-pointer tracking-wider transition-all"
                          title="Keeps Quotation record and issues a linked Tax Invoice"
                        >
                          ISSUE INVOICE COPY
                        </button>
                      )}
                      {activeDoc.status === 'INVOICE' && (
                        <button
                          type="button"
                          onClick={() => handleConvertToDeliveryNote(activeDoc.id)}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-[11px] rounded-lg shadow-xs cursor-pointer tracking-wider transition-all"
                          title="Keeps Invoice record and issues a linked Delivery Note"
                        >
                          ISSUE DELIVERY NOTE
                        </button>
                      )}
                      {activeDoc.status === 'DELIVERY_NOTE' && (
                        <span className="text-[11px] text-emerald-700 bg-emerald-50 px-2.5 py-1.5 rounded-lg font-bold uppercase tracking-wider border border-emerald-100">
                          ✓ Delivery Note Active
                        </span>
                      )}
                      {confirmDeleteDocId === activeDoc.id ? (
                        <div className="inline-flex items-center gap-1 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1">
                          <span className="text-[10px] font-bold text-rose-700">Delete?</span>
                          <button
                            type="button"
                            onClick={() => handleDeleteDocument(activeDoc.id)}
                            className="px-2 py-0.5 bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-black rounded cursor-pointer uppercase"
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteDocId(null)}
                            className="px-2 py-0.5 bg-white border border-slate-200 text-slate-600 text-[10px] font-bold rounded cursor-pointer uppercase"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteDocId(activeDoc.id)}
                          className="px-2.5 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 font-bold text-[11px] rounded-lg cursor-pointer tracking-wider flex items-center gap-1 transition-all"
                          title="Delete permanently"
                        >
                          <Trash2 size={11} />
                          DELETE
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* WhatsApp instant PDF sharing layout */}
              <div className="border border-green-200 bg-green-50/50 p-3.5 rounded-xl flex flex-col gap-2 font-sans">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl font-sans">💬</span>
                    <div className="font-sans text-left">
                      <h4 className="text-xs font-extrabold text-green-900 uppercase">Send PDF Receipt / Quotation via WhatsApp</h4>
                      <p className="text-[10px] text-green-700 font-semibold leading-tight">
                        Compile and deliver the PDF document directly to the customer's WhatsApp number
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 font-sans">
                    <input
                      type="tel"
                      dir="ltr"
                      placeholder="e.g. +260977XXXXXX"
                      value={whatsappSharePhone}
                      onChange={(e) => { setWhatsappSharePhone(e.target.value); setWaError(null); }}
                      className="px-3 py-2 text-xs border border-green-300 focus:border-green-500 rounded-lg bg-white font-bold w-44 text-green-950 text-left select-text focus:outline-hidden"
                    />
                    <button
                      type="button"
                      disabled={waSending}
                      onClick={handleWhatsAppSharePdf}
                      className="px-3.5 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold font-sans cursor-pointer uppercase transition-all tracking-wider inline-flex items-center gap-1"
                    >
                      <Send size={11} />
                      {waSending ? 'Preparing PDF...' : 'Send PDF'}
                    </button>
                  </div>
                </div>

                {waError && (
                  <p className="text-[10px] font-bold text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5">
                    {waError}
                  </p>
                )}

                {waResult && waResult.success && (
                  <div className="bg-white border border-emerald-200 rounded-lg p-2.5 flex flex-col gap-1.5 text-[10px]">
                    <span className="font-bold text-emerald-800">
                      {waResult.mode === 'cloud_api'
                        ? `✓ PDF (${waResult.filename}) sent directly to +${waResult.phone} on WhatsApp.`
                        : `✓ PDF Document (${waResult.filename}) ready for +${waResult.phone}.`}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {waResult.whatsappUrl && (
                        <a
                          href={waResult.whatsappUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-black uppercase inline-flex items-center gap-1"
                        >
                          <Send size={10} /> Open Customer WhatsApp
                        </a>
                      )}
                      {waResult.canShareFile && lastCompiledQuotePdf && (
                        <button
                          type="button"
                          onClick={() => sharePdfFileDirectly(lastCompiledQuotePdf.filename, lastCompiledQuotePdf.doc, lastCompiledQuotePdf.caption)}
                          className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-black uppercase cursor-pointer inline-flex items-center gap-1"
                        >
                          <Share2 size={10} /> Share PDF File
                        </button>
                      )}
                      {waResult.pdfUrl && (
                        <a
                          href={waResult.pdfUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded font-bold inline-flex items-center gap-1"
                        >
                          <Download size={10} /> View PDF
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {isEditingQuote && selectedQuote ? (
                <div className="bg-white rounded-2xl border border-indigo-200 p-6 shadow-xl flex flex-col gap-5">
                  <div className="flex justify-between items-center border-b border-indigo-100 pb-3 font-sans">
                    <div>
                      <h3 className="text-xs font-extrabold text-indigo-950 uppercase tracking-widest flex items-center gap-1.5">
                        <Edit3 size={14} className="text-indigo-600" />
                        Edit {selectedQuote.status.replace('_', ' ')}: {selectedQuote.id}
                      </h3>
                      <p className="text-[10px] text-slate-400 font-extrabold uppercase mt-0.5">Adjust unit prices, quantities, date, client info &amp; reprint</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsEditingQuote(false)}
                      className="px-3 py-1 text-slate-500 hover:text-slate-800 text-xs font-bold font-sans border rounded-md cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>

                  <form onSubmit={handleSaveQuotationEdits} className="flex flex-col gap-4 font-sans text-xs">
                    {/* Client & Date details */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Customer Corporate Name</label>
                        <input
                          type="text"
                          dir="ltr"
                          required
                          value={editCName}
                          onChange={(e) => setEditCName(e.target.value)}
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 font-bold text-left select-text focus:outline-hidden"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-indigo-600 font-bold uppercase">Document Date</label>
                        <input
                          type="date"
                          dir="ltr"
                          required
                          value={editDocDate}
                          onChange={(e) => setEditDocDate(e.target.value)}
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 font-bold text-left select-text focus:outline-hidden"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Phone Number</label>
                        <input
                          type="tel"
                          dir="ltr"
                          value={editCPhone}
                          onChange={(e) => setEditCPhone(e.target.value)}
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 font-semibold text-left select-text focus:outline-hidden"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Email Address</label>
                        <input
                          type="email"
                          dir="ltr"
                          value={editCEmail}
                          onChange={(e) => setEditCEmail(e.target.value)}
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 rounded-lg text-slate-900 font-semibold text-left select-text focus:outline-hidden"
                        />
                      </div>
                    </div>

                    {/* Bank Details in Editing Form */}
                    <div className="bg-indigo-50/20 p-3.5 rounded-xl border border-indigo-100 flex flex-col gap-2.5">
                      <span className="text-[10px] text-indigo-900 font-extrabold uppercase">Update Payment Bank Options (Optional)</span>
                      <div className="flex flex-col gap-2 text-xs text-slate-700">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase">Bank Name</label>
                          <input
                            type="text"
                            dir="ltr"
                            value={editBankName}
                            onChange={(e) => setEditBankName(e.target.value)}
                            className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-lg px-3 py-2 text-slate-900 font-semibold text-left select-text focus:outline-hidden"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase">Account Name</label>
                          <input
                            type="text"
                            dir="ltr"
                            value={editBankAccountName}
                            onChange={(e) => setEditBankAccountName(e.target.value)}
                            className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-lg px-3 py-2 text-slate-900 font-semibold text-left select-text focus:outline-hidden"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase">Account Number</label>
                          <input
                            type="text"
                            dir="ltr"
                            value={editBankAccountNumber}
                            onChange={(e) => setEditBankAccountNumber(e.target.value)}
                            className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-lg px-3 py-2 text-slate-900 font-bold font-mono text-left select-text focus:outline-hidden"
                          />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          <div className="flex flex-col gap-1">
                            <label className="text-[10px] text-slate-500 font-bold uppercase">Branch Name</label>
                            <input
                              type="text"
                              dir="ltr"
                              value={editBankBranchName}
                              onChange={(e) => setEditBankBranchName(e.target.value)}
                              className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-lg px-3 py-2 text-slate-900 font-semibold text-left select-text focus:outline-hidden"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-[10px] text-slate-500 font-bold uppercase">Sort Code</label>
                            <input
                              type="text"
                              dir="ltr"
                              value={editBankSortCode}
                              onChange={(e) => setEditBankSortCode(e.target.value)}
                              className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-lg px-3 py-2 text-slate-900 font-semibold font-mono text-left select-text focus:outline-hidden"
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Issuer Details & Digital Signature in Editing Form */}
                    <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 flex flex-col gap-2.5">
                      <span className="text-[10px] text-indigo-900 font-extrabold uppercase">Issued By &amp; Digital Signature</span>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Issued By (Full Name)</label>
                        <input
                          type="text"
                          dir="ltr"
                          value={editIssuedBy}
                          onChange={(e) => setEditIssuedBy(e.target.value)}
                          placeholder="Name of issuer"
                          className="w-full bg-white border border-slate-200 focus:border-indigo-500 rounded-lg px-3 py-2 text-slate-900 font-semibold text-xs text-left select-text focus:outline-hidden"
                        />
                      </div>
                      <SignaturePad
                        value={editIssuerSignature}
                        onChange={setEditIssuerSignature}
                        label="Issuer Signature"
                        height={95}
                      />
                    </div>

                    {/* Terms & Conditions selection in Editing Form */}
                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 flex flex-col gap-1.5">
                      <span className="text-[10px] text-slate-600 font-extrabold uppercase">Update Terms &amp; Conditions Rules</span>
                      <div className="flex flex-col gap-1.5 max-h-32 overflow-y-auto">
                        {savedTerms.map(t => (
                          <label key={t.id} className="flex items-start gap-1.5 text-[10px] font-medium p-1 bg-white border rounded cursor-pointer">
                            <input
                              type="checkbox"
                              checked={editSelectedTermTexts.includes(t.text)}
                              onChange={(e) => {
                               if (e.target.checked) {
                                  setEditSelectedTermTexts([...editSelectedTermTexts, t.text]);
                                } else {
                                  setEditSelectedTermTexts(editSelectedTermTexts.filter(x => x !== t.text));
                                }
                              }}
                              className="mt-0.5 shrink-0"
                            />
                            <div>
                              <strong className="text-slate-800">{t.title}</strong>
                              <p className="text-[9px] text-slate-500 leading-tight">{t.text}</p>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Quick Catalog Shelf + Custom Item Adder */}
                    <div className="border border-indigo-100 rounded-xl p-3 bg-indigo-50/20 flex flex-col gap-2.5">
                      <span className="font-extrabold text-indigo-900 text-[10px] uppercase block">Add stock or custom line item</span>
                      <div className="flex items-center gap-1.5 overflow-x-auto py-1 max-w-full">
                        {allProducts.map(p => (
                          <button
                            type="button"
                            key={p.id}
                            onClick={() => addProductToEditItems(p)}
                            title={p.description || p.name}
                            className="px-2.5 py-1 text-[10px] font-bold bg-white hover:bg-slate-50 border border-slate-200 rounded-md whitespace-nowrap cursor-pointer"
                          >
                            + {p.name} • {settings.currency}{Number(p.price || 0).toFixed(2)}
                          </button>
                        ))}
                      </div>
                      <div className="grid grid-cols-12 gap-1.5 items-center pt-1 border-t border-indigo-100/70">
                        <input
                          type="text"
                          dir="ltr"
                          placeholder="Custom item / service name..."
                          value={customItemName}
                          onChange={(e) => setCustomItemName(e.target.value)}
                          className="col-span-5 px-2.5 py-1.5 text-[11px] bg-white border border-slate-200 focus:border-indigo-500 rounded-lg font-semibold text-slate-900 text-left select-text focus:outline-hidden"
                        />
                        <input
                          type="number"
                          dir="ltr"
                          step="0.01"
                          min="0"
                          placeholder="Price"
                          value={customItemPrice}
                          onChange={(e) => setCustomItemPrice(e.target.value)}
                          className="col-span-3 px-2.5 py-1.5 text-[11px] bg-white border border-slate-200 focus:border-indigo-500 rounded-lg font-mono font-bold text-slate-900 text-left select-text focus:outline-hidden"
                        />
                        <input
                          type="number"
                          dir="ltr"
                          min="1"
                          placeholder="Qty"
                          value={customItemQty}
                          onChange={(e) => setCustomItemQty(e.target.value)}
                          className="col-span-2 px-2.5 py-1.5 text-[11px] bg-white border border-slate-200 focus:border-indigo-500 rounded-lg font-mono font-bold text-slate-900 text-left select-text focus:outline-hidden"
                        />
                        <button
                          type="button"
                          onClick={handleAddCustomEditItem}
                          className="col-span-2 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[10px] font-extrabold uppercase cursor-pointer"
                        >
                          + Add
                        </button>
                        <textarea
                          rows={2}
                          dir="ltr"
                          placeholder="Custom item description / full features (optional)..."
                          value={customItemDescription}
                          onChange={(e) => setCustomItemDescription(e.target.value)}
                          className="col-span-12 px-2.5 py-1.5 text-[11px] bg-white border border-slate-200 focus:border-indigo-500 rounded-lg text-slate-900 font-medium text-left select-text focus:outline-hidden resize-y"
                        />
                      </div>
                    </div>

                    {/* Editable line items table (Price, Quantity & Description) */}
                    <div className="divide-y divide-slate-100 bg-slate-50 border border-slate-200 rounded-xl overflow-hidden px-3 py-1">
                      <div className="grid grid-cols-12 items-center font-bold text-slate-500 py-2 border-b text-[9px] uppercase gap-2">
                        <span className="col-span-5">Item &amp; Full Description</span>
                        <span className="col-span-3 text-left">Unit Price ({settings.currency})</span>
                        <span className="col-span-2 text-left">Qty</span>
                        <span className="col-span-2 text-right">Total</span>
                      </div>
                      {editItems.map((item, idx) => (
                        <div key={idx} className="py-2 flex flex-col gap-1.5">
                          <div className="grid grid-cols-12 items-center gap-2">
                            <input
                              type="text"
                              dir="ltr"
                              value={item.name || ''}
                              onChange={(e) => {
                                const updated = [...editItems];
                                updated[idx] = { ...updated[idx], name: e.target.value };
                                setEditItems(updated);
                              }}
                              className="col-span-5 px-2.5 py-1.5 text-xs bg-white border border-slate-200 focus:border-indigo-500 rounded-lg font-bold text-slate-900 text-left select-text focus:outline-hidden"
                              placeholder="Item name"
                            />
                            <div className="col-span-3 flex">
                              <input
                                type="number"
                                dir="ltr"
                                step="0.01"
                                min="0"
                                value={item.unitPrice}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  const updated = [...editItems];
                                  updated[idx] = { ...updated[idx], unitPrice: isNaN(val) ? 0 : Math.max(0, val) };
                                  setEditItems(updated);
                                }}
                                className="w-full text-left px-2 bg-white border border-slate-200 focus:border-indigo-500 text-xs rounded-lg font-bold font-mono py-1 text-slate-900 select-text focus:outline-hidden"
                              />
                            </div>
                            <div className="col-span-2 flex">
                              <input
                                type="number"
                                dir="ltr"
                                min="1"
                                value={item.quantity}
                                onChange={(e) => {
                                  const val = Math.max(1, parseInt(e.target.value, 10) || 1);
                                  const updated = [...editItems];
                                  updated[idx] = { ...updated[idx], quantity: val };
                                  setEditItems(updated);
                                }}
                                className="w-full text-left px-2 bg-white border border-slate-200 focus:border-indigo-500 text-xs rounded-lg font-bold font-mono py-1 text-slate-900 select-text focus:outline-hidden"
                              />
                            </div>
                            <div className="col-span-2 flex items-center justify-end gap-1">
                              <span className="text-slate-600 font-mono text-[11px] font-bold">
                                {(Number(item.unitPrice || 0) * Number(item.quantity || 0)).toFixed(2)}
                              </span>
                              <button
                                type="button"
                                onClick={() => removeItemFromEditItems(idx)}
                                className="text-rose-500 hover:text-rose-700 font-extrabold px-0.5 cursor-pointer"
                                title="Remove item"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                          <textarea
                            rows={2}
                            dir="ltr"
                            value={item.description || ''}
                            onChange={(e) => {
                              const updated = [...editItems];
                              updated[idx] = { ...updated[idx], description: e.target.value };
                              setEditItems(updated);
                            }}
                            placeholder="Item description / full features (shown below item name)..."
                            className="w-full px-2.5 py-1.5 text-[11px] bg-white border border-slate-200 focus:border-indigo-500 rounded-lg text-slate-800 font-medium text-left select-text focus:outline-hidden resize-y"
                          />
                        </div>
                      ))}
                      {editItems.length === 0 && (
                        <div className="p-4 text-center text-slate-400 font-semibold">No items in this document. Add some above.</div>
                      )}
                    </div>

                    {/* Discount & Live Totals Summary */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center bg-slate-50 border border-slate-200 rounded-xl p-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Discount ({settings.currency})</label>
                        <input
                          type="number"
                          dir="ltr"
                          step="0.01"
                          min="0"
                          value={editDiscountVal}
                          onChange={(e) => setEditDiscountVal(e.target.value)}
                          className="w-full px-3 py-2 bg-white border border-slate-200 focus:border-indigo-500 rounded-lg text-slate-900 font-semibold font-mono text-left select-text focus:outline-hidden"
                        />
                      </div>
                      {(() => {
                        const sub = editItems.reduce((s, it) => s + Number(it.unitPrice || 0) * Number(it.quantity || 0), 0);
                        const disc = Math.max(0, parseFloat(editDiscountVal) || 0);
                        const tax = Math.max(0, (sub - disc) * (Number(settings.taxRate || 0) / 100));
                        const tot = Math.max(0, sub - disc + tax);
                        return (
                          <div className="text-right space-y-0.5 font-mono text-[11px]">
                            <div className="text-slate-500">Subtotal: <strong className="text-slate-800">{settings.currency}{sub.toFixed(2)}</strong></div>
                            <div className="text-slate-500">VAT ({settings.taxRate}%): <strong className="text-slate-800">{settings.currency}{tax.toFixed(2)}</strong></div>
                            <div className="text-indigo-900 font-black text-xs">Updated Total: {settings.currency}{tot.toFixed(2)}</div>
                          </div>
                        );
                      })()}
                    </div>

                    {/* Action controls */}
                    <button
                      type="submit"
                      className="py-2.5 px-4 mt-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg text-xs tracking-wider cursor-pointer transition-all text-center uppercase"
                    >
                      SAVE CHANGES &amp; UPDATE {selectedQuote.status.replace('_', ' ')}
                    </button>
                  </form>
                </div>
              ) : (
                <>
                  {/* DELIVERY NOTE QUICK QUANTITY, PRICE & DATE EASING PANEL */}
                  {!activeDoc.isDraft && activeDoc.status === 'DELIVERY_NOTE' && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-col gap-3 font-sans text-left">
                      <div className="flex flex-wrap justify-between items-center gap-2 border-b border-amber-200 pb-2">
                        <h4 className="text-xs font-extrabold text-amber-900 uppercase tracking-wider flex items-center gap-1.5">
                          <Edit3 size={14} />
                          Delivery Note Quick Adjustments (Qty, Price &amp; Date)
                        </h4>
                        <div className="flex items-center gap-2">
                          <input
                            type="date"
                            dir="ltr"
                            value={deliveryDateInput}
                            onChange={(e) => setDeliveryDateInput(e.target.value)}
                            className="px-2.5 py-1.5 text-xs font-bold bg-white border border-amber-300 focus:border-amber-500 rounded-lg text-amber-950 text-left select-text focus:outline-hidden"
                            title="Delivery Note Date"
                          />
                          <button
                            type="button"
                            onClick={handleSaveDeliveryEasing}
                            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold rounded-lg shadow-xs cursor-pointer"
                          >
                            Save Changes
                          </button>
                        </div>
                      </div>

                      <p className="text-[11px] text-amber-700 font-semibold leading-relaxed">
                        Adjust delivered quantities, unit prices, or delivery date below before reprinting or collecting receiver signature.
                      </p>

                      <div className="divide-y divide-amber-100 max-h-44 overflow-y-auto font-sans">
                        {editItems.map((item, index) => (
                          <div key={index} className="py-2 flex flex-wrap justify-between items-center gap-2 text-xs font-semibold">
                            <div className="flex-1 min-w-[120px]">
                              <span className="font-bold text-amber-900 block truncate">{item.name}</span>
                              {item.description && (
                                <p className="text-[10px] font-normal text-amber-800/80 whitespace-pre-line line-clamp-2 mt-0.5 leading-snug">
                                  {item.description}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-amber-700">Price:</span>
                              <input
                                type="number"
                                dir="ltr"
                                step="0.01"
                                min="0"
                                value={item.unitPrice}
                                onChange={(e) => handleUpdateDeliveryPrice(index, e.target.value)}
                                className="w-20 text-left px-2 text-xs font-bold font-mono bg-white border border-amber-300 focus:border-amber-500 text-amber-900 rounded-lg py-1 select-text focus:outline-hidden"
                              />
                              <span className="text-[10px] text-amber-700">Qty:</span>
                              <input
                                type="number"
                                dir="ltr"
                                min="0"
                                value={item.quantity}
                                onChange={(e) => handleUpdateDeliveryQty(index, e.target.value)}
                                className="w-16 text-left px-2 text-xs font-bold font-mono bg-white border border-amber-300 focus:border-amber-500 text-amber-900 rounded-lg py-1 select-text focus:outline-hidden"
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* DELIVERY NOTE RECEIVER ACCEPTANCE & DIGITAL SIGNATURE PANEL */}
                  {!activeDoc.isDraft && activeDoc.status === 'DELIVERY_NOTE' && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex flex-col gap-3 font-sans text-left">
                      <div className="flex flex-wrap justify-between items-center gap-2 border-b border-emerald-200/70 pb-2">
                        <h4 className="text-xs font-extrabold text-emerald-950 uppercase tracking-wider flex items-center gap-1.5">
                          <UserCheck size={14} className="text-emerald-700" />
                          Delivery Acceptance &amp; Receiver Signature
                        </h4>
                        {activeDoc.receiverSignature && !isEditingReceiverSig && (
                          <button
                            type="button"
                            onClick={() => setIsEditingReceiverSig(true)}
                            className="px-2.5 py-1 bg-white hover:bg-emerald-100 text-emerald-800 border border-emerald-300 text-[10px] font-extrabold rounded-md cursor-pointer uppercase"
                          >
                            Update / Re-sign
                          </button>
                        )}
                      </div>

                      {activeDoc.receiverSignature && !isEditingReceiverSig ? (
                        <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-emerald-200 rounded-lg p-3">
                          <div>
                            <p className="text-xs font-extrabold text-emerald-800">
                              ✓ Accepted &amp; Signed by {activeDoc.receiverName}
                            </p>
                            {activeDoc.acceptedAt && (
                              <p className="text-[10px] text-slate-500 font-semibold mt-0.5">
                                Accepted on {new Date(activeDoc.acceptedAt).toLocaleString()}
                              </p>
                            )}
                          </div>
                          <img
                            src={activeDoc.receiverSignature}
                            alt="Receiver Signature"
                            className="h-12 max-w-[160px] object-contain border border-slate-200 rounded bg-slate-50 px-2 py-1"
                          />
                        </div>
                      ) : (
                        <div className="flex flex-col gap-2.5">
                          <p className="text-[11px] text-emerald-800 font-semibold leading-snug">
                            When handing over the goods, have the receiver enter their full name and sign below to confirm acceptance.
                          </p>
                          <div className="flex flex-col gap-1">
                            <label className="text-[10px] text-emerald-900 font-extrabold uppercase">Receiver Full Name *</label>
                            <input
                              type="text"
                              dir="ltr"
                              value={deliveryReceiverName}
                              onChange={(e) => setDeliveryReceiverName(e.target.value)}
                              placeholder="Full name of person receiving goods"
                              className="w-full px-3 py-2 text-xs bg-white border border-emerald-300 focus:border-emerald-500 rounded-lg text-slate-900 font-semibold text-left select-text focus:outline-hidden"
                            />
                          </div>
                          <SignaturePad
                            value={deliveryReceiverSig}
                            onChange={setDeliveryReceiverSig}
                            label="Receiver Digital Signature"
                            height={110}
                            placeholder="Receiver signs here with finger, stylus, or mouse"
                          />
                          <div className="flex items-center gap-2 justify-end">
                            {activeDoc.receiverSignature && (
                              <button
                                type="button"
                                onClick={() => {
                                  setDeliveryReceiverName(activeDoc.receiverName || '');
                                  setDeliveryReceiverSig(activeDoc.receiverSignature || '');
                                  setIsEditingReceiverSig(false);
                                }}
                                className="px-3 py-1.5 bg-white border border-slate-300 text-slate-600 text-[10px] font-bold rounded-lg cursor-pointer uppercase"
                              >
                                Cancel
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={handleSaveDeliveryAcceptance}
                              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-black rounded-lg shadow-xs cursor-pointer uppercase tracking-wider flex items-center gap-1.5"
                            >
                              <CheckCircle size={12} />
                              Confirm Acceptance &amp; Save Signature
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* SHEET FORM: CUSTOM A4 ELEGANTE BRAND PREVIEW */}
                  <div className="bg-white rounded-2xl border border-slate-200 p-8 shadow-xl document-print-section flex flex-col gap-6 text-slate-800 font-serif relative overflow-hidden text-left">
                    
                    {activeDoc.isDraft && (
                      <div className="absolute top-3 right-3 bg-amber-100 text-amber-800 border border-amber-200 px-3 py-1 rounded text-[9px] font-black uppercase tracking-widest pointer-events-none opacity-80 select-none">
                        DRAFT PREVIEW
                      </div>
                    )}
                    
                    {/* Visual Header Grid layout — plain neutral styling with full-color logo */}
                    <div className="flex justify-between items-start flex-wrap gap-4 border-b border-slate-200 pb-5">
                      <div className="font-sans">
                        {/* Uploaded Company Logo or Plain Monogram Fallback */}
                        <div className="flex items-center gap-3">
                          {settings.logoUrl && settings.logoUrl.trim() ? (
                            <img
                              src={settings.logoUrl}
                              alt={companyName || 'Company Logo'}
                              className="w-14 h-14 object-contain rounded-lg border border-slate-200 bg-white p-1 shadow-xs shrink-0"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="w-11 h-11 bg-slate-900 rounded-lg flex items-center justify-center text-white text-md font-serif font-extrabold shadow-sm shrink-0">
                              {logoText}
                            </div>
                          )}
                          <div>
                            <h2 className="text-md font-extrabold tracking-tight text-slate-900 uppercase font-sans leading-none">{companyName}</h2>
                            <p className="text-[10px] text-slate-500 font-bold uppercase mt-1">TPIN: {companyTPIN || 'N/A'}</p>
                            {branchInfo.name && (
                              <p className="text-[10px] text-slate-700 font-extrabold uppercase mt-0.5">Branch: {branchInfo.name}</p>
                            )}
                          </div>
                        </div>
                        {companyAddress && (
                          <p className="text-[11px] text-slate-600 mt-3 font-semibold font-sans max-w-[300px] leading-relaxed">{companyAddress}</p>
                        )}
                        {(branchInfo.phone || branchInfo.email) && (
                          <p className="text-[10px] text-slate-500 mt-0.5 font-medium font-sans max-w-[300px]">
                            {[branchInfo.phone ? `Tel: ${branchInfo.phone}` : '', branchInfo.email ? `Email: ${branchInfo.email}` : ''].filter(Boolean).join(' • ')}
                          </p>
                        )}
                      </div>

                      <div className="text-right font-sans min-w-[150px]">
                        <h1 className="text-lg font-extrabold tracking-normal text-slate-900 font-serif uppercase leading-tight">{activeDoc.status}</h1>
                        <p className="text-xs font-mono mt-1 font-bold text-slate-700">Doc ID: {activeDoc.id}</p>
                        <p className="text-[11px] text-slate-500 font-semibold mt-1">Date: {new Date(activeDoc.created_at).toLocaleString()}</p>
                        {activeDoc.issuedBy && (
                          <p className="text-[11px] text-slate-700 font-bold mt-1">Issued By: {activeDoc.issuedBy}</p>
                        )}
                      </div>
                    </div>

                    {/* Client invoice details */}
                    <div className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-5 font-sans">
                      <div>
                        <h4 className="text-[10px] text-slate-500 font-extrabold uppercase tracking-widest">Billed To Profile</h4>
                        <p className="text-xs font-extrabold text-slate-900 mt-1.5">{activeDoc.customer_name}</p>
                        {activeDoc.customer_phone && <p className="text-[11px] text-slate-500 mt-1">Phone: {activeDoc.customer_phone}</p>}
                        {activeDoc.customer_email && <p className="text-[11px] text-slate-500 font-medium mt-0.5">Email: {activeDoc.customer_email}</p>}
                      </div>

                      <div>
                        <h4 className="text-[10px] text-slate-500 font-extrabold uppercase tracking-widest">Bank Payment Details</h4>
                        <div className="text-[11px] text-slate-600 mt-1.5 space-y-1 leading-tight">
                          <p><span className="font-extrabold text-[8px] text-slate-400 uppercase mr-1">BANK NAME:</span> <strong className="text-slate-800">{activeDoc.bank_name || 'On Request'}</strong></p>
                          <p><span className="font-extrabold text-[8px] text-slate-400 uppercase mr-1">ACCOUNT NAME:</span> <strong className="text-slate-800">{activeDoc.bankAccountName || companyName || 'On Request'}</strong></p>
                          <p><span className="font-extrabold text-[8px] text-slate-400 uppercase mr-1">ACCOUNT NUMBER:</span> <strong className="text-slate-900 font-bold font-mono">{activeDoc.bank_account || 'On Request'}</strong></p>
                          <p><span className="font-extrabold text-[8px] text-slate-400 uppercase mr-1">BRANCH NAME:</span> <strong className="text-slate-800">{activeDoc.bank_branch || 'On Request'}</strong></p>
                          {activeDoc.bankSortCode && (
                            <p><span className="font-extrabold text-[8px] text-slate-400 uppercase mr-1">SORT CODE:</span> <strong className="text-slate-800 font-bold font-mono">{activeDoc.bankSortCode}</strong></p>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Sales line items table */}
                    <div className="font-sans flex-1 font-serif">
                      <table className="w-full text-left text-xs font-sans">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500 font-extrabold uppercase text-[10px] tracking-wider font-sans">
                            <th className="py-2 text-left font-sans">Item Description</th>
                            <th className="py-2 text-center">Unit Price</th>
                            <th className="py-2 text-center">Quantity</th>
                            <th className="py-2 text-right">Line Total</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-slate-700 font-semibold">
                          {activeDoc.items.map((item: any, idx: number) => (
                            <tr key={idx} className="hover:bg-slate-50/50">
                              <td className="py-2.5 align-top pr-3">
                                <div className="font-bold text-slate-800">{item.name}</div>
                                {item.description && (
                                  <div className="text-[10.5px] font-normal text-slate-600 whitespace-pre-line mt-1 leading-relaxed">
                                    {item.description}
                                  </div>
                                )}
                              </td>
                              <td className="py-2.5 text-center font-mono align-top">{settings.currency}{Number(item.unitPrice || 0).toFixed(2)}</td>
                              <td className="py-2.5 text-center font-mono align-top">{item.quantity}</td>
                              <td className="py-2.5 text-right font-mono font-bold text-slate-950 align-top">
                                {settings.currency}{(Number(item.unitPrice || 0) * Number(item.quantity || 0)).toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Summary calculation blocks */}
                    <div className="border-t border-slate-200 pt-4 flex justify-end font-sans">
                      <div className="w-[260px] flex flex-col gap-2 text-xs">
                        <div className="flex justify-between text-slate-500 font-bold">
                          <span>Subtotal:</span>
                          <span className="font-bold font-mono text-slate-800">{settings.currency}{Number(activeDoc.subtotal || 0).toFixed(2)}</span>
                        </div>
                        {Number(activeDoc.discount || 0) > 0 && (
                          <div className="flex justify-between text-slate-700 font-bold">
                            <span>Discount:</span>
                            <span className="font-mono">-{settings.currency}{Number(activeDoc.discount || 0).toFixed(2)}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-slate-500 font-bold">
                          <span>Tax (VAT {settings.taxRate}%):</span>
                          <span className="font-mono text-slate-800">{settings.currency}{Number(activeDoc.tax || 0).toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-slate-900 border-t border-slate-200 pt-2 font-black text-sm">
                          <span className="text-slate-900 uppercase text-[11px] tracking-wider">Grand Total:</span>
                          <span className="font-mono text-slate-950 bg-slate-100 px-2 py-0.5 rounded border border-slate-300">
                            {settings.currency}{Number(activeDoc.total || 0).toFixed(2)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Applied Terms and Conditions */}
                    {activeDoc.appliedTerms && activeDoc.appliedTerms.length > 0 && (
                      <div className="border-t border-slate-100 pt-3 mt-1 text-left font-sans">
                        <h4 className="text-[9px] text-slate-400 font-extrabold uppercase tracking-widest mb-1.5">Selected Terms &amp; Conditions</h4>
                        <ul className="list-disc pl-4 text-[10px] text-slate-600 font-semibold space-y-1 leading-relaxed">
                          {activeDoc.appliedTerms.map((term: string, tIdx: number) => (
                            <li key={tIdx} className="text-slate-600">{term}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Authorization & Delivery Acceptance Signatures Section */}
                    <div className="border-t border-slate-200 pt-4 mt-2 grid grid-cols-1 sm:grid-cols-2 gap-6 font-sans">
                      {/* Issued By Signature */}
                      <div className="flex flex-col gap-1.5">
                        <span className="text-[9px] font-extrabold uppercase tracking-widest text-slate-700">
                          Authorized Signature (Issued By)
                        </span>
                        <div className="h-14 border-b border-slate-300 flex items-end pb-1">
                          {activeDoc.issuerSignature ? (
                            <img
                              src={activeDoc.issuerSignature}
                              alt="Issuer Digital Signature"
                              className="max-h-12 max-w-[180px] object-contain"
                            />
                          ) : (
                            <span className="text-[10px] italic text-slate-400">No digital signature attached</span>
                          )}
                        </div>
                        <p className="text-xs font-extrabold text-slate-800">
                          Issued By: {activeDoc.issuedBy || 'Authorized Staff'}
                        </p>
                        <p className="text-[10px] text-slate-500">
                          Date: {new Date(activeDoc.created_at).toLocaleDateString()}
                        </p>
                      </div>

                      {/* Receiver Acceptance Signature (Delivery Note or Signed Doc) */}
                      {(activeDoc.status === 'DELIVERY_NOTE' || activeDoc.receiverSignature || activeDoc.receiverName) && (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[9px] font-extrabold uppercase tracking-widest text-slate-700">
                            Receiver Acceptance Signature
                          </span>
                          <div className="h-14 border-b border-slate-300 flex items-end pb-1">
                            {activeDoc.receiverSignature ? (
                              <img
                                src={activeDoc.receiverSignature}
                                alt="Receiver Acceptance Signature"
                                className="max-h-12 max-w-[180px] object-contain"
                              />
                            ) : (
                              <span className="text-[10px] italic text-slate-400 font-semibold">
                                Pending receiver signature upon delivery
                              </span>
                            )}
                          </div>
                          <p className="text-xs font-extrabold text-slate-800">
                            Received By: {activeDoc.receiverName || '______________________'}
                          </p>
                          <p className="text-[10px] text-slate-500">
                            {activeDoc.acceptedAt
                              ? `Accepted: ${new Date(activeDoc.acceptedAt).toLocaleString()}`
                              : 'Awaiting delivery acceptance'}
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Company Footer note definitions */}
                    <div className="border-t border-slate-100 pt-4 mt-2 font-sans text-center text-[10px] text-slate-400 font-semibold leading-normal">
                      <span>Powering small and medium enterprises across Copperbelt & Upper Zambia. Thank you for your trusted business!</span>
                    </div>

                  </div>
                </>
              )}

            </div>
          ) : (
            <div className="flex flex-col items-center justify-center text-slate-400 h-96 gap-3 font-sans max-w-sm mx-auto text-center">
              <div className="w-12 h-12 bg-white border border-slate-200 rounded-2xl flex items-center justify-center text-slate-400 shadow-xs">
                <FileText size={24} className="stroke-1.5" />
              </div>
              <p className="text-xs font-black text-slate-600 uppercase tracking-widest">No Document Selected</p>
              <p className="text-[11px] text-slate-400 font-semibold leading-relaxed">
                Add products under <span className="text-indigo-600 font-black">"2. Stock"</span> or fill customer details to launch real-time elegant Live Preview simulation on this workspace.
              </p>
            </div>
          )}

        </div>
      </div>

    </div>
  );
}
