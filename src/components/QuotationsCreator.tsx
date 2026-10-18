import React, { useState, useEffect } from 'react';
import { runSql, persistTablesToStorage } from '../db';
import { jsPDF } from 'jspdf';
import { exportAndSharePdf } from '../androidUtils';
import { 
  FileText, 
  Search, 
  Phone, 
  Mail, 
  Trash2, 
  Plus, 
  Printer, 
  CheckCircle, 
  ShoppingBag, 
  Edit3, 
  RefreshCcw, 
  Building, 
  CreditCard 
} from 'lucide-react';
import { StoreSettings } from '../types';

interface QuotationsCreatorProps {
  settings: StoreSettings;
}

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
}

export default function QuotationsCreator({ settings }: QuotationsCreatorProps) {
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [selectedQuote, setSelectedQuote] = useState<Quotation | null>(null);
  
  // Create Form State
  const [companyName, setCompanyName] = useState('SME Retailers Ltd');
  const [companyTPIN, setCompanyTPIN] = useState('1003449910');
  const [companyAddress, setCompanyAddress] = useState('Plot 45, Independence Avenue, Lusaka');
  const [logoText, setLogoText] = useState('咖啡'); // custom text logo
  
  // The 5 Core Banking Fields requested
  const [bankName, setBankName] = useState('Zambia National Commercial Bank (Zanaco)');
  const [bankAccountName, setBankAccountName] = useState('SME Retailers Ltd');
  const [bankAccountNumber, setBankAccountNumber] = useState('1020088991102');
  const [bankBranchName, setBankBranchName] = useState('Lusaka Commercial Branch');
  const [bankSortCode, setBankSortCode] = useState('01-02-03');

  // Client Info
  const [cName, setCName] = useState('');
  const [cPhone, setCPhone] = useState('');
  const [cEmail, setCEmail] = useState('');

  // Cart Selection
  const [cartItems, setCartItems] = useState<any[]>([]);
  const [discountVal, setDiscountVal] = useState('0.00');
  const [allProducts, setAllProducts] = useState<any[]>([]);
  
  // Custom editing states for the currently selected quotation (Delivery Note easing!)
  const [editItems, setEditItems] = useState<any[]>([]);

  // Filter state
  const [docFilter, setDocFilter] = useState<'ALL' | 'QUOTATION' | 'INVOICE' | 'DELIVERY_NOTE'>('ALL');

  // Quotation/Invoice Editing state
  const [isEditingQuote, setIsEditingQuote] = useState(false);
  const [editCName, setEditCName] = useState('');
  const [editCPhone, setEditCPhone] = useState('');
  const [editCEmail, setEditCEmail] = useState('');
  const [editDiscountVal, setEditDiscountVal] = useState('0.00');

  // Editing Bank States
  const [editBankName, setEditBankName] = useState('');
  const [editBankAccountName, setEditBankAccountName] = useState('');
  const [editBankAccountNumber, setEditBankAccountNumber] = useState('');
  const [editBankBranchName, setEditBankBranchName] = useState('');
  const [editBankSortCode, setEditBankSortCode] = useState('');
  const [editSelectedTermTexts, setEditSelectedTermTexts] = useState<string[]>([]);

  // WhatsApp share phone state
  const [whatsappSharePhone, setWhatsappSharePhone] = useState('');

  // Form Section tab state
  const [activeFormTab, setActiveFormTab] = useState<'client_bank' | 'items_stock' | 'terms_conditions'>('client_bank');

  // Search & Catalog Add product states
  const [productSearch, setProductSearch] = useState('');
  const [showAddCatalogProduct, setShowAddCatalogProduct] = useState(false);
  const [newCatalogName, setNewCatalogName] = useState('');
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

  // Fetch / Retrieve extra quote attributes helper
  interface QuoteExtraData {
    appliedTerms: string[];
    bankAccountName: string;
    bankSortCode: string;
  }

  const getQuoteExtra = (quoteId: string): QuoteExtraData => {
    const data = localStorage.getItem(`pos_quote_extra_${quoteId}`);
    if (data) {
      try {
        return JSON.parse(data);
      } catch (e) {}
    }
    return {
      appliedTerms: [],
      bankAccountName: companyName,
      bankSortCode: '01-02-03'
    };
  };

  const loadQuotations = () => {
    const res = runSql('SELECT * FROM quotations ORDER BY created_at DESC', 'Quotations: Fetch active invoices');
    if (res.success && Array.isArray(res.data)) {
      setQuotations(res.data);
    }
    const prodRes = runSql('SELECT * FROM products', 'Quotations: Fetch catalog reference');
    if (prodRes.success && Array.isArray(prodRes.data)) {
      setAllProducts(prodRes.data);
    }
    if (selectedQuote) {
      const qRes = runSql(`SELECT * FROM quotations WHERE id = '${selectedQuote.id}'`, 'Quotations: Fetch active');
      if (qRes.success && Array.isArray(qRes.data) && qRes.data.length > 0) {
        setSelectedQuote(qRes.data[0]);
      }
    }
  };

  useEffect(() => {
    loadQuotations();

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
  }, []);

  const addToCart = (prod: any) => {
    const idx = cartItems.findIndex(x => x.id === prod.id);
    if (idx > -1) {
      const updated = [...cartItems];
      updated[idx].quantity += 1;
      setCartItems(updated);
    } else {
      setCartItems([...cartItems, { id: prod.id, name: prod.name, quantity: 1, unitPrice: prod.price }]);
    }
  };

  const removeCartItem = (pId: number) => {
    setCartItems(cartItems.filter(x => x.id !== pId));
  };

  const handleUpdateCartQty = (pId: number, qtyString: string) => {
    const qty = parseInt(qtyString) || 1;
    setCartItems(cartItems.map(item => item.id === pId ? { ...item, quantity: qty } : item));
  };

  const calculateSubtotal = () => {
    return cartItems.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
  };

  const handleSaveQuotation = (e?: React.FormEvent | React.MouseEvent) => {
    if (e) e.preventDefault();
    
    // Explicit manual validation of client profile & stock
    if (!cName || cName.trim() === '') {
      alert('REQUIRED: Please fill out Customer Corporate Name under "1. Client & Bank" tab!');
      setActiveFormTab('client_bank');
      return;
    }
    
    if (cartItems.length === 0) {
      alert('REQUIRED: Your quotation basket is empty! Please add products from the "2. Stock" tab.');
      setActiveFormTab('items_stock');
      return;
    }

    if (!bankName || bankName.trim() === '') {
      alert('REQUIRED: Please fill out Bank Name under "1. Client & Bank" tab!');
      setActiveFormTab('client_bank');
      return;
    }

    if (!bankAccountName || bankAccountName.trim() === '') {
      alert('REQUIRED: Please fill out Bank Account Name under "1. Client & Bank" tab!');
      setActiveFormTab('client_bank');
      return;
    }

    if (!bankAccountNumber || bankAccountNumber.trim() === '') {
      alert('REQUIRED: Please fill out Bank Account Number under "1. Client & Bank" tab!');
      setActiveFormTab('client_bank');
      return;
    }

    if (!bankBranchName || bankBranchName.trim() === '') {
      alert('REQUIRED: Please fill out Bank Branch Name under "1. Client & Bank" tab!');
      setActiveFormTab('client_bank');
      return;
    }

    if (!bankSortCode || bankSortCode.trim() === '') {
      alert('REQUIRED: Please fill out Bank Sort Code under "1. Client & Bank" tab!');
      setActiveFormTab('client_bank');
      return;
    }

    const sub = calculateSubtotal();
    const discountNum = parseFloat(discountVal) || 0;
    const taxNum = (sub - discountNum) * (settings.taxRate / 100);
    const tot = sub - discountNum + taxNum;

    const qId = 'QT-' + Math.floor(1000 + Math.random() * 9000);
    const dateStr = new Date().toISOString();
    const itemsJson = JSON.stringify(cartItems);

    const escapedCName = (cName || '').replace(/'/g, "''");
    const escapedCPhone = (cPhone || '').replace(/'/g, "''");
    const escapedCEmail = (cEmail || '').replace(/'/g, "''");
    const escapedBankName = (bankName || '').replace(/'/g, "''");
    const escapedBankAccountNumber = (bankAccountNumber || '').replace(/'/g, "''");
    const escapedBankBranchName = (bankBranchName || '').replace(/'/g, "''");

    const qry = `
      INSERT INTO quotations (id, customer_name, customer_phone, customer_email, items_json, subtotal, tax, discount, total, bank_name, bank_account, bank_branch, status, created_at)
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
        'QUOTATION',
        '${dateStr}'
      )
    `;
    const res = runSql(qry, `Docs: File new sales quotation document ${qId}`);
    if (res.success) {
      // Save extra metadata
      const extra: QuoteExtraData = {
        appliedTerms: savedTerms.filter(t => selectedTermIds.includes(t.id)).map(t => t.text),
        bankAccountName: bankAccountName || companyName,
        bankSortCode: bankSortCode || '01-02-03'
      };
      localStorage.setItem(`pos_quote_extra_${qId}`, JSON.stringify(extra));

      setCName('');
      setCPhone('');
      setCEmail('');
      setCartItems([]);
      setDiscountVal('0.00');
      setSelectedTermIds([]);
      setActiveFormTab('client_bank');
      
      // Auto-fetch and select the newly created document
      const qRes = runSql(`SELECT * FROM quotations WHERE id = '${qId}'`, 'Quotations: Retrieve just created doc');
      if (qRes.success && Array.isArray(qRes.data) && qRes.data.length > 0) {
        setSelectedQuote(qRes.data[0]);
        setEditItems([]);
        setIsEditingQuote(false);
      }
      
      alert(`Custom Quotation ${qId} successfully recorded and displayed.`);
      loadQuotations();
      persistTablesToStorage();
    } else {
      alert('Error recording: ' + res.error);
    }
  };

  // 1-Click Conversions: Convert Quotation ➔ Invoice
  const handleConvertToInvoice = (quoteId: string) => {
    const freshRes = runSql(`UPDATE quotations SET status = 'INVOICE' WHERE id = '${quoteId}'`, `Docs: Convert Quote ${quoteId} to Registered Invoice`);
    if (freshRes.success) {
      alert(`Document ${quoteId} converted successfully to INVOICE.`);
      loadQuotations();
      persistTablesToStorage();
    }
  };

  // Convert Invoice ➔ Delivery Note
  const handleConvertToDeliveryNote = (quoteId: string) => {
    const freshRes = runSql(`UPDATE quotations SET status = 'DELIVERY_NOTE' WHERE id = '${quoteId}'`, `Docs: Convert Invoice ${quoteId} to Delivery Note`);
    if (freshRes.success) {
      alert(`Document ${quoteId} converted successfully to DELIVERY NOTE. Line items quantities can now be customized easily.`);
      loadQuotations();
      persistTablesToStorage();
    }
  };

  // EDIT LINE ITEMS IN DELIVERY NOTE / EASING OF QUANTITIES
  const handleUpdateDeliveryQty = (idx: number, qtyString: string) => {
    const qty = parseInt(qtyString) || 0;
    const updated = [...editItems];
    
    if (qty <= 0) {
      // remove item from Delivery Note
      updated.splice(idx, 1);
    } else {
      updated[idx].quantity = qty;
    }
    
    setEditItems(updated);
  };

  const handleSaveDeliveryEasing = () => {
    if (!selectedQuote) return;

    // Recalculate totals based on eased items
    const sub = editItems.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
    const discountNum = selectedQuote.discount;
    const taxNum = (sub - discountNum) * (settings.taxRate / 100);
    const tot = sub - discountNum + taxNum;

    const itemsJson = JSON.stringify(editItems);
    const qry = `
      UPDATE quotations 
      SET 
        items_json = '${itemsJson.replace(/'/g, "''")}',
        subtotal = ${sub.toFixed(2)},
        tax = ${taxNum.toFixed(2)},
        total = ${tot.toFixed(2)}
      WHERE id = '${selectedQuote.id}'
    `;
    const res = runSql(qry, `Docs: Ease quantities/items on Delivery Note ${selectedQuote.id}`);
    if (res.success) {
      alert(`Delivery Note ${selectedQuote.id} items eased and updated successfully in SQL.`);
      loadQuotations();
      persistTablesToStorage();
    }
  };

  // Start Editing Quotation
  const startEditingQuotation = (q: Quotation) => {
    setEditCName(q.customer_name);
    setEditCPhone(q.customer_phone || '');
    setEditCEmail(q.customer_email || '');
    setEditDiscountVal(q.discount.toString());
    setEditItems(JSON.parse(q.items_json));

    // Load extra metadata
    const extra = getQuoteExtra(q.id);
    setEditSelectedTermTexts(extra.appliedTerms || []);
    setEditBankAccountName(extra.bankAccountName || q.customer_name);
    setEditBankSortCode(extra.bankSortCode || '01-02-03');

    // These columns are part of the db row
    setEditBankName(q.bank_name || 'Zambia National Commercial Bank (Zanaco)');
    setEditBankAccountNumber(q.bank_account || '1020088991102');
    setEditBankBranchName(q.bank_branch || 'Lusaka Commercial Branch');

    setIsEditingQuote(true);
  };

  const addProductToEditItems = (prod: any) => {
    const idx = editItems.findIndex(x => x.id === prod.id);
    if (idx > -1) {
      const updated = [...editItems];
      updated[idx].quantity += 1;
      setEditItems(updated);
    } else {
      setEditItems([...editItems, { id: prod.id, name: prod.name, quantity: 1, unitPrice: prod.price }]);
    }
  };

  const removeItemFromEditItems = (idx: number) => {
    const updated = editItems.filter((_, i) => i !== idx);
    setEditItems(updated);
  };

  const handleSaveQuotationEdits = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedQuote) return;
    if (!editCName || editItems.length === 0) {
      alert('Please fill out Customer corporate name and add at least one item!');
      return;
    }

    const sub = editItems.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
    const discountNum = parseFloat(editDiscountVal) || 0;
    const taxNum = (sub - discountNum) * (settings.taxRate / 100);
    const tot = sub - discountNum + taxNum;

    const itemsJson = JSON.stringify(editItems);

    const qry = `
      UPDATE quotations
      SET
        customer_name = '${editCName.replace(/'/g, "''")}',
        customer_phone = '${editCPhone}',
        customer_email = '${editCEmail}',
        items_json = '${itemsJson.replace(/'/g, "''")}',
        subtotal = ${sub.toFixed(2)},
        tax = ${taxNum.toFixed(2)},
        discount = ${discountNum.toFixed(2)},
        total = ${tot.toFixed(2)},
        bank_name = '${editBankName.replace(/'/g, "''")}',
        bank_account = '${editBankAccountNumber}',
        bank_branch = '${editBankBranchName.replace(/'/g, "''")}'
      WHERE id = '${selectedQuote.id}'
    `;

    const res = runSql(qry, `Docs: Update Quotation ${selectedQuote.id}`);
    if (res.success) {
      // Save extra metadata
      const extra: QuoteExtraData = {
        appliedTerms: editSelectedTermTexts,
        bankAccountName: editBankAccountName,
        bankSortCode: editBankSortCode
      };
      localStorage.setItem(`pos_quote_extra_${selectedQuote.id}`, JSON.stringify(extra));

      alert(`Quotation ${selectedQuote.id} updated successfully.`);
      setIsEditingQuote(false);
      loadQuotations();
      persistTablesToStorage();
    } else {
      alert('Error updating quotation: ' + res.error);
    }
  };

  const handleDeleteDocument = (docId: string) => {
    if (window.confirm(`Are you sure you want to permanently delete document ${docId}?`)) {
      const res = runSql(`DELETE FROM quotations WHERE id = '${docId}'`, `Docs: Delete document ${docId}`);
      if (res.success) {
        alert(`Document ${docId} deleted successfully.`);
        setSelectedQuote(null);
        setIsEditingQuote(false);
        loadQuotations();
        persistTablesToStorage();
      } else {
        alert('Error deleting document: ' + res.error);
      }
    }
  };

  const activeDoc = selectedQuote 
    ? {
        id: selectedQuote.id,
        status: selectedQuote.status,
        created_at: selectedQuote.created_at,
        customer_name: selectedQuote.customer_name,
        customer_phone: selectedQuote.customer_phone,
        customer_email: selectedQuote.customer_email,
        bank_name: selectedQuote.bank_name,
        bank_account: selectedQuote.bank_account,
        bank_branch: selectedQuote.bank_branch,
        items: selectedQuote.status === 'DELIVERY_NOTE' ? editItems : JSON.parse(selectedQuote.items_json),
        subtotal: selectedQuote.status === 'DELIVERY_NOTE' ? editItems.reduce((sum: number, item: any) => sum + (item.unitPrice * item.quantity), 0) : selectedQuote.subtotal,
        discount: selectedQuote.discount,
        tax: selectedQuote.status === 'DELIVERY_NOTE' ? (editItems.reduce((sum: number, item: any) => sum + (item.unitPrice * item.quantity), 0) - selectedQuote.discount) * (settings.taxRate / 100) : selectedQuote.tax,
        total: selectedQuote.status === 'DELIVERY_NOTE' ? (editItems.reduce((sum: number, item: any) => sum + (item.unitPrice * item.quantity), 0) - selectedQuote.discount) * (1 + settings.taxRate / 100) : selectedQuote.total,
        appliedTerms: getQuoteExtra(selectedQuote.id).appliedTerms,
        bankAccountName: getQuoteExtra(selectedQuote.id).bankAccountName || companyName,
        bankSortCode: getQuoteExtra(selectedQuote.id).bankSortCode || '01-02-03',
        isDraft: false
      }
    : (cartItems.length > 0 || cName) 
    ? {
        id: 'QT-DRAFT-PREVIEW',
        status: 'DRAFT QUOTATION',
        created_at: new Date().toISOString(),
        customer_name: cName || 'Draft Customer Name',
        customer_phone: cPhone || 'Not provided yet',
        customer_email: cEmail || 'Not provided yet',
        bank_name: bankName,
        bank_account: bankAccountNumber,
        bank_branch: bankBranchName,
        items: cartItems,
        subtotal: calculateSubtotal(),
        discount: parseFloat(discountVal) || 0,
        tax: (calculateSubtotal() - (parseFloat(discountVal) || 0)) * (settings.taxRate / 100),
        total: (calculateSubtotal() - (parseFloat(discountVal) || 0)) * (1 + settings.taxRate / 100),
        appliedTerms: savedTerms.filter(t => selectedTermIds.includes(t.id)).map(t => t.text),
        bankAccountName: bankAccountName || companyName,
        bankSortCode: bankSortCode || '01-02-03',
        isDraft: true
      }
    : null;

  const handleDownloadPDF = (docData: any) => {
    if (!docData) return null;
    try {
      const doc = new jsPDF({ format: 'a4', orientation: 'portrait' });
      const margin = 15;
      const contentWidth = 180; // 210 - 2 * 15
      
      // Header Section
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(20);
      doc.setTextColor(30, 41, 59); // Slate-800
      doc.text(companyName.toUpperCase(), margin, 25);
      
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(100, 116, 139); // Slate-500
      doc.text(`TPIN: ${companyTPIN}`, margin, 31);
      doc.text(companyAddress, margin, 36);
      
      // Right-side document type and metadata
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.setTextColor(79, 70, 229); // Indigo-600
      const statusLabel = docData.status === 'QUOTATION' ? 'QUOTATION' : docData.status === 'INVOICE' ? 'TAX INVOICE' : 'DELIVERY NOTE';
      doc.text(statusLabel, 210 - margin, 25, { align: 'right' });
      
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(100, 116, 139); // Slate-500
      doc.text(`Doc ID: ${docData.id}`, 210 - margin, 31, { align: 'right' });
      doc.text(`Date: ${new Date(docData.created_at).toLocaleDateString()}`, 210 - margin, 36, { align: 'right' });
      
      // Horizontal Line Divider
      doc.setDrawColor(226, 232, 240); // Slate-200
      doc.setLineWidth(0.5);
      doc.line(margin, 42, 210 - margin, 42);
      
      // Two-column layout: Customer Details & Payment Bank Details
      const colY = 50;
      
      // Column 1: Customer Details
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(79, 70, 229); // Indigo-600
      doc.text('CLIENT DETAILS', margin, colY);
      
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(30, 41, 59); // Slate-800
      doc.text(docData.customer_name, margin, colY + 6);
      
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(71, 85, 105); // Slate-600
      doc.text(`Phone: ${docData.customer_phone || 'N/A'}`, margin, colY + 11);
      doc.text(`Email: ${docData.customer_email || 'N/A'}`, margin, colY + 16);
      
      // Column 2: Bank Transfer Details
      const rightColX = 115;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(79, 70, 229); // Indigo-600
      doc.text('PAYMENT DETAILS', rightColX, colY);
      
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(71, 85, 105); // Slate-600
      doc.text(`Bank: ${docData.bank_name || 'N/A'}`, rightColX, colY + 6);
      doc.text(`Account Name: ${docData.bankAccountName || companyName}`, rightColX, colY + 11);
      doc.text(`Account No: ${docData.bank_account || 'N/A'}`, rightColX, colY + 16);
      doc.text(`Branch: ${docData.bank_branch || 'N/A'}`, rightColX, colY + 21);
      doc.text(`Sort Code: ${docData.bankSortCode || '01-02-03'}`, rightColX, colY + 26);
      
      // Line Items Table Header
      let tableY = 85;
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
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(71, 85, 105); // Slate-600
      
      docData.items.forEach((item: any, idx: number) => {
        // Draw thin bottom border
        doc.setDrawColor(241, 245, 249); // Slate-100
        doc.setLineWidth(0.3);
        doc.line(margin, currentY + 7, 210 - margin, currentY + 7);
        
        // Row details
        doc.text((idx + 1).toString(), margin + 3, currentY + 5);
        doc.text(item.name || '', margin + 12, currentY + 5);
        doc.text(item.quantity.toString(), margin + 105, currentY + 5, { align: 'right' });
        doc.text(`${settings.currency}${item.unitPrice.toFixed(2)}`, margin + 135, currentY + 5, { align: 'right' });
        doc.text(`${settings.currency}${(item.unitPrice * item.quantity).toFixed(2)}`, margin + 175, currentY + 5, { align: 'right' });
        
        currentY += 7.5;
      });
      
      // Totals Panel
      const totalPanelY = currentY + 5;
      const rightAlignX = 195;
      
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(100, 116, 139); // Slate-500
      doc.text('Subtotal:', 125, totalPanelY);
      doc.text(`${settings.currency}${docData.subtotal.toFixed(2)}`, rightAlignX, totalPanelY, { align: 'right' });
      
      let nextTotalY = totalPanelY + 5;
      if (docData.discount > 0) {
        doc.text('Discount:', 125, nextTotalY);
        doc.text(`-${settings.currency}${docData.discount.toFixed(2)}`, rightAlignX, nextTotalY, { align: 'right' });
        nextTotalY += 5;
      }
      
      doc.text(`VAT (${settings.taxRate}%):`, 125, nextTotalY);
      doc.text(`${settings.currency}${docData.tax.toFixed(2)}`, rightAlignX, nextTotalY, { align: 'right' });
      
      // Grand Total Box
      const gTotalY = nextTotalY + 5;
      doc.setFillColor(79, 70, 229, 0.05); // Subtle indigo tint
      doc.rect(120, gTotalY, 75, 8, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(79, 70, 229); // Indigo-600
      doc.text('GRAND TOTAL:', 125, gTotalY + 5.5);
      doc.text(`${settings.currency}${docData.total.toFixed(2)}`, rightAlignX - 2, gTotalY + 5.5, { align: 'right' });
      
      // Terms & Conditions Block
      if (docData.appliedTerms && docData.appliedTerms.length > 0) {
        let termsY = gTotalY + 20;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(30, 41, 59); // Slate-800
        doc.text('TERMS & CONDITIONS', margin, termsY);
        
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(100, 116, 139); // Slate-500
        
        let termOffset = termsY + 5;
        docData.appliedTerms.forEach((term: string, idx: number) => {
          doc.text(`${idx + 1}. ${term}`, margin + 3, termOffset);
          termOffset += 4.5;
        });
      }
      
      // Footnote at page bottom
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8.5);
      doc.setTextColor(148, 163, 184); // Slate-400
      doc.text('Thank you for choice of partnership!', 105, 280, { align: 'center' });
      doc.text('This document is dynamically generated via SME Core Corporate POS.', 105, 284, { align: 'center' });
      
      const fileName = `${docData.status.replace(/\s+/g, '_')}_${docData.id}.pdf`;
      exportAndSharePdf(fileName, doc);
      return fileName;
    } catch (err) {
      console.error('PDF Download Error:', err);
      alert('Error generating PDF download: ' + err);
      return null;
    }
  };

  const handlePrintDoc = () => {
    if (activeDoc) {
      handleDownloadPDF(activeDoc);
    } else {
      alert('No active document to generate a PDF for.');
    }
  };

  return (
    <div className="flex-1 flex overflow-hidden flex-col bg-slate-50 relative">
      
      {/* Upper header action controls */}
      <div className="px-5 py-4 bg-white border-b border-slate-200 flex flex-wrap justify-between items-center gap-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
            <FileText size={20} />
          </div>
          <div>
            <h2 className="text-md font-bold text-slate-800">Corp Documents Engine</h2>
            <p className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">Quotations, Invoices & Delivery Notes</p>
          </div>
        </div>

        {activeDoc && (
          <button
            onClick={handlePrintDoc}
            className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer transition-all uppercase tracking-wider shadow-sm animate-pulse-once"
          >
            <Printer size={14} className="text-white" />
            PRINT / DOWNLOAD PDF
          </button>
        )}
      </div>

      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        
        {/* LEFTSIDE DOCUMENT SELECTOR & NEW DOC CREATOR */}
        <div className="w-full lg:w-5/12 bg-white border-r border-slate-200 flex flex-col overflow-y-auto p-4 gap-4 max-h-screen">
          
          {/* Section: Create New Quote with Tabbed Flow */}
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 shadow-3xs flex flex-col gap-3">
            <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-100 pb-2">
              <Building size={14} className="text-indigo-600" />
              1. DOCUMENT WORKSTATION CREATOR
            </h3>

            {/* Step Tabs Selector */}
            <div className="flex border-b border-slate-200 mt-1 font-sans text-[10px] gap-1 pb-1">
              <button
                type="button"
                onClick={() => setActiveFormTab('client_bank')}
                className={`flex-1 py-1 px-1.5 font-bold uppercase rounded-lg text-center transition-all ${
                  activeFormTab === 'client_bank' ? 'bg-indigo-600 text-white shadow-2xs' : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                1. Info &amp; Bank
              </button>
              <button
                type="button"
                onClick={() => setActiveFormTab('items_stock')}
                className={`flex-1 py-1 px-1.5 font-bold uppercase rounded-lg text-center transition-all ${
                  activeFormTab === 'items_stock' ? 'bg-indigo-600 text-white shadow-2xs' : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                2. Stock ({cartItems.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveFormTab('terms_conditions')}
                className={`flex-1 py-1 px-1.5 font-bold uppercase rounded-lg text-center transition-all ${
                  activeFormTab === 'terms_conditions' ? 'bg-indigo-600 text-white shadow-2xs' : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                3. T&amp;C ({selectedTermIds.length})
              </button>
            </div>

            <div className="flex flex-col gap-3">
              
              {/* TAB 1: CLIENT & BANK INFO */}
              {activeFormTab === 'client_bank' && (
                <div className="flex flex-col gap-3 font-sans mt-1">
                  {/* Customer Corporate profile */}
                  <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm flex flex-col gap-2.5">
                    <span className="text-[10px] text-indigo-700 font-extrabold uppercase block tracking-wider">Customer Contact Profile</span>
                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] text-slate-400 font-bold uppercase">Customer Corporate Name *</label>
                      <input
                        type="text"
                        required
                        value={cName}
                        onChange={(e) => setCName(e.target.value)}
                        placeholder="Mopani Copper Mines PLC"
                        className="px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-semibold focus:outline-none"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex flex-col gap-1">
                        <label className="text-[9px] text-slate-400 font-bold uppercase">Phone Number</label>
                        <input
                          type="tel"
                          value={cPhone}
                          onChange={(e) => setCPhone(e.target.value)}
                          placeholder="+260 977 XXXXXX"
                          className="px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[9px] text-slate-400 font-bold uppercase">Email Address</label>
                        <input
                          type="email"
                          value={cEmail}
                          onChange={(e) => setCEmail(e.target.value)}
                          placeholder="procurement@mopani.zm"
                          className="px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Bank details input fields with headings */}
                  <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm flex flex-col gap-2">
                    <div className="flex justify-between items-center pb-1 border-b border-slate-100">
                      <span className="text-[10px] text-indigo-700 font-extrabold uppercase tracking-wider">Payment Bank Details Section</span>
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
                          alert('Default Bank details saved. These will auto-fill next time.');
                        }}
                        className="text-[9px] text-indigo-600 hover:text-indigo-800 font-bold uppercase hover:underline"
                      >
                        Set as Default
                      </button>
                    </div>

                    <div className="flex flex-col gap-2 text-xs">
                      <div className="flex flex-col gap-0.5">
                        <label className="text-[9px] text-slate-400 font-bold uppercase">BANK NAME</label>
                        <input
                          type="text"
                          required
                          value={bankName}
                          onChange={(e) => setBankName(e.target.value)}
                          placeholder="Zambia National Commercial Bank"
                          className="px-2.5 py-1 bg-slate-50 border border-slate-201 rounded-md text-slate-850 font-semibold"
                        />
                      </div>

                      <div className="flex flex-col gap-0.5">
                        <label className="text-[9px] text-slate-400 font-bold uppercase">ACCOUNT NAME</label>
                        <input
                          type="text"
                          required
                          value={bankAccountName}
                          onChange={(e) => setBankAccountName(e.target.value)}
                          placeholder="SME Retailers Ltd"
                          className="px-2.5 py-1 bg-slate-50 border border-slate-201 rounded-md text-slate-850 font-semibold"
                        />
                      </div>

                      <div className="flex flex-col gap-0.5">
                        <label className="text-[9px] text-slate-400 font-bold uppercase">ACCOUNT NUMBER</label>
                        <input
                          type="text"
                          required
                          value={bankAccountNumber}
                          onChange={(e) => setBankAccountNumber(e.target.value)}
                          placeholder="1020088991102"
                          className="px-2.5 py-1 bg-slate-50 border border-slate-201 rounded-md text-slate-850 font-bold font-mono"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div className="flex flex-col gap-0.5">
                          <label className="text-[9px] text-slate-400 font-bold uppercase">BRANCH NAME</label>
                          <input
                            type="text"
                            required
                            value={bankBranchName}
                            onChange={(e) => setBankBranchName(e.target.value)}
                            placeholder="Lusaka Commercial Branch"
                            className="px-2.5 py-1 bg-slate-50 border border-slate-201 rounded-md text-slate-850 font-medium"
                          />
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <label className="text-[9px] text-slate-400 font-bold uppercase">SORT CODE</label>
                          <input
                            type="text"
                            required
                            value={bankSortCode}
                            onChange={(e) => setBankSortCode(e.target.value)}
                            placeholder="01-02-03"
                            className="px-2.5 py-1 bg-slate-50 border border-slate-201 rounded-md text-slate-850 font-bold font-mono"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setActiveFormTab('items_stock')}
                    className="w-full py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold uppercase rounded-lg text-xs"
                  >
                    Next: Add Products &amp; Stock &rarr;
                  </button>
                </div>
              )}

              {/* TAB 2: STOCK INDEX & INVENTORY SHELF */}
              {activeFormTab === 'items_stock' && (
                <div className="flex flex-col gap-3 font-sans mt-1">
                  
                  {/* Quick Product Creator directly to Inventory Stock */}
                  <div className="border border-indigo-150 rounded-xl p-3 bg-indigo-50/20">
                    <div className="flex justify-between items-center">
                      <span className="font-extrabold text-[10px] text-indigo-900 uppercase">📦 Want to add a new stock item?</span>
                      <button
                        type="button"
                        onClick={() => setShowAddCatalogProduct(!showAddCatalogProduct)}
                        className="text-[9px] bg-indigo-600 hover:bg-indigo-700 text-white font-black px-2 py-0.5 rounded uppercase"
                      >
                        {showAddCatalogProduct ? 'CLOSE PANEL' : '+ QUICK CREATE NEW ITEM'}
                      </button>
                    </div>

                    {showAddCatalogProduct && (
                      <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-indigo-100 text-xs">
                        <div className="flex flex-col gap-0.5">
                          <label className="text-[8px] text-slate-400 font-bold uppercase">ITEM NAME</label>
                          <input
                            type="text"
                            placeholder="Copper spool wire 5mm"
                            value={newCatalogName}
                            onChange={(e) => setNewCatalogName(e.target.value)}
                            className="p-1.5 border rounded-md font-semibold bg-white"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[8px] text-slate-400 font-bold uppercase">SELLING PRICE ({settings.currency})</label>
                            <input
                              type="number"
                              step="0.01"
                              placeholder="350.00"
                              value={newCatalogPrice}
                              onChange={(e) => setNewCatalogPrice(e.target.value)}
                              className="p-1.5 w-full border rounded-md font-bold text-slate-800 bg-white"
                            />
                          </div>
                          <div>
                            <label className="text-[8px] text-slate-400 font-bold uppercase">STOCK COUNT</label>
                            <input
                              type="number"
                              placeholder="150"
                              value={newCatalogStock}
                              onChange={(e) => setNewCatalogStock(e.target.value)}
                              className="p-1.5 w-full border rounded-md text-slate-800 bg-white font-medium"
                            />
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            if (!newCatalogName || !newCatalogPrice) {
                              alert('Please complete the Name and Price fields.');
                              return;
                            }
                            const priceVal = parseFloat(newCatalogPrice);
                            const stockCount = parseInt(newCatalogStock) || 0;
                            const costVal = priceVal * 0.7;
                            const pId = 'P-' + Math.floor(1000 + Math.random() * 9000);
                            
                            const qryInsert = `
                              INSERT INTO products (id, name, stock, cost, price)
                              VALUES (
                                '${pId}',
                                '${newCatalogName.replace(/'/g, "''")}',
                                ${stockCount},
                                ${costVal.toFixed(2)},
                                ${priceVal.toFixed(2)}
                              )
                            `;
                            const r = runSql(qryInsert, `Stock Inventory quick registration: ${newCatalogName}`);
                            if (r.success) {
                              // Auto add to the quotation cart
                              setCartItems([...cartItems, { id: pId, name: newCatalogName, quantity: 1, unitPrice: priceVal }]);
                              setNewCatalogName('');
                              setNewCatalogPrice('');
                              setNewCatalogStock('100');
                              setShowAddCatalogProduct(false);
                              loadQuotations();
                              persistTablesToStorage();
                              alert(`"${newCatalogName}" registered in system and added successfully into current quotation cart!`);
                            } else {
                              alert('Error registering product: ' + r.error);
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
                      placeholder="Search items with stock limits..."
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                      className="w-full text-xs py-1.5 pl-8 pr-3 border border-slate-200 rounded-lg font-medium"
                    />
                    <span className="absolute left-2.5 top-2.5 text-slate-400"><Search size={12} /></span>
                  </div>

                  {/* Stock Available Selector Shelf */}
                  <div className="max-h-52 overflow-y-auto border bg-white rounded-lg p-1.5 flex flex-col gap-1.5 shadow-inner">
                    {(() => {
                      const filtered = allProducts.filter(p => p.name.toLowerCase().includes(productSearch.toLowerCase()));
                      if (filtered.length === 0) {
                        return <div className="text-center text-slate-400 text-[10px] font-bold p-5 uppercase">No stock products found</div>;
                      }
                      return filtered.map(p => {
                        const cartItem = cartItems.find(x => x.id === p.id);
                        const qtyInCart = cartItem ? cartItem.quantity : 0;
                        return (
                          <div key={p.id} className="p-2 bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-between text-xs transition-colors hover:border-slate-200">
                            <div>
                              <span className="font-extrabold text-slate-805 leading-tight block">{p.name}</span>
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
                                  className="w-5 h-5 bg-indigo-50 border text-indigo-700 font-bold rounded flex items-center justify-center hover:bg-indigo-100"
                                >
                                  -
                                </button>
                                <input
                                  type="number"
                                  value={qtyInCart}
                                  onChange={(e) => handleUpdateCartQty(p.id, e.target.value)}
                                  className="w-8 text-center text-[10px] font-extrabold font-mono border rounded bg-white py-0.5"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleUpdateCartQty(p.id, (qtyInCart + 1).toString())}
                                  className="w-5 h-5 bg-indigo-50 border text-indigo-700 font-bold rounded flex items-center justify-center hover:bg-indigo-100"
                                >
                                  +
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => addToCart(p)}
                                className="px-2 py-1 bg-white hover:bg-indigo-50 border border-indigo-200 text-indigo-700 rounded font-bold text-[9px]"
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
                  <div className="flex items-center justify-between bg-white border p-2.5 rounded-lg">
                    <span className="text-[10px] text-slate-405 font-bold uppercase">Flat Discount Value ({settings.currency}):</span>
                    <input
                      type="number"
                      step="0.01"
                      value={discountVal}
                      onChange={(e) => setDiscountVal(e.target.value)}
                      className="w-24 text-center text-xs font-bold bg-slate-50 border border-slate-200 rounded-lg py-1 leading-tight"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => setActiveFormTab('terms_conditions')}
                    className="w-full py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold uppercase rounded-lg text-xs"
                  >
                    Next: Pick Terms &amp; Conditions &rarr;
                  </button>
                </div>
              )}

              {/* TAB 3: TERMS & CONDITIONS SELECTION LIBRARY */}
              {activeFormTab === 'terms_conditions' && (
                <div className="flex flex-col gap-3 font-sans mt-1">
                  <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm flex flex-col gap-2">
                    <span className="text-[10px] text-indigo-750 font-extrabold uppercase tracking-wider">Select Terms that apply to customer</span>
                    
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
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  if (confirm(`Delete the term rule "${t.title}" permanently?`)) {
                                    setSavedTerms(savedTerms.filter(x => x.id !== t.id));
                                    localStorage.setItem('pos_custom_terms', JSON.stringify(savedTerms.filter(x => x.id !== t.id)));
                                  }
                                }}
                                className="text-rose-500 hover:text-rose-700 text-[8px] uppercase underline ml-auto"
                              >
                                Delete
                              </button>
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
                  <div className="bg-indigo-50/20 border border-indigo-150 rounded-xl p-3 flex flex-col gap-2">
                    <span className="text-[9px] text-indigo-900 font-extrabold uppercase">➕ Create New Terms in Advance</span>
                    <div className="flex flex-col gap-1.5 text-xs">
                      <input
                        type="text"
                        placeholder="e.g. Warranty Period"
                        value={newTermTitle}
                        onChange={(e) => setNewTermTitle(e.target.value)}
                        className="p-1 px-2 border border-slate-201 rounded bg-white font-semibold"
                      />
                      <textarea
                        placeholder="Detailed Terms text content that will print beautifully on the quotation sheet..."
                        value={newTermText}
                        onChange={(e) => setNewTermText(e.target.value)}
                        rows={2}
                        className="p-1 px-2 border border-slate-201 rounded bg-white text-[10px]"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!newTermTitle || !newTermText) {
                            alert('Please state Term Heading Title and rules text.');
                            return;
                          }
                          const termId = 'term-' + Math.floor(1000 + Math.random() * 9000);
                          const item = { id: termId, title: newTermTitle, text: newTermText };
                          const list = [...savedTerms, item];
                          setSavedTerms(list);
                          localStorage.setItem('pos_custom_terms', JSON.stringify(list));
                          setNewTermTitle('');
                          setNewTermText('');
                          alert('Added to your advance terms library list successfully!');
                        }}
                        className="py-1 px-3 bg-indigo-600 hover:bg-indigo-700 text-white text-[9px] font-black uppercase rounded self-end cursor-pointer"
                      >
                        Save to Advance Library
                      </button>
                    </div>
                  </div>

                </div>
              )}

              {/* ALWAYS VISIBLE LIVE BASKET PREVIEW (Addresses key user request) */}
              <div className="bg-white p-3.5 rounded-xl border border-indigo-200 mt-2 shadow-3xs flex flex-col gap-3 font-sans">
                <div className="flex justify-between items-center border-b border-slate-100 pb-2">
                  <span className="text-[10px] text-indigo-750 font-black uppercase tracking-wider flex items-center gap-1">
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
                        const lineTotal = item.unitPrice * item.quantity;
                        return (
                          <div key={item.id} className="py-2 flex items-center justify-between gap-2.5 text-xs">
                            <div className="min-w-0 flex-1">
                              <span className="font-extrabold text-slate-800 block truncate">{item.name}</span>
                              <span className="text-[10px] text-slate-400 font-semibold font-mono">
                                {settings.currency}{item.unitPrice.toFixed(2)} each
                              </span>
                            </div>

                            <div className="flex items-center gap-1 bg-slate-50 border rounded-lg p-0.5 shadow-3xs shrink-0">
                              <button
                                type="button"
                                onClick={() => {
                                  if (item.quantity <= 1) {
                                    removeCartItem(item.id);
                                  } else {
                                    handleUpdateCartQty(item.id, (item.quantity - 1).toString());
                                  }
                                }}
                                className="w-5 h-5 text-slate-500 hover:text-indigo-600 font-extrabold rounded flex items-center justify-center hover:bg-slate-200 text-xs transition-colors"
                              >
                                -
                              </button>
                              <span className="w-6 text-center text-[11px] font-black font-mono text-slate-800">
                                {item.quantity}
                              </span>
                              <button
                                type="button"
                                onClick={() => handleUpdateCartQty(item.id, (item.quantity + 1).toString())}
                                className="w-5 h-5 text-slate-500 hover:text-indigo-600 font-extrabold rounded flex items-center justify-center hover:bg-slate-200 text-xs transition-colors"
                              >
                                +
                              </button>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <span className="font-extrabold text-slate-800 font-mono text-right w-16">
                                {settings.currency}{lineTotal.toFixed(2)}
                              </span>
                              <button
                                type="button"
                                onClick={() => removeCartItem(item.id)}
                                className="p-1 hover:bg-rose-50 text-rose-500 rounded hover:text-rose-700 transition-colors"
                                title="Remove line item"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
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
                          step="0.01"
                          placeholder="0.00"
                          value={discountVal}
                          onChange={(e) => setDiscountVal(e.target.value)}
                          className="w-16 text-center text-[11px] font-mono font-bold bg-white border rounded py-0.5 shadow-3xs"
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
                              <span className="font-extrabold font-mono text-slate-750">
                                {settings.currency}{tax.toFixed(2)}
                              </span>
                            </div>
                            <div className="flex justify-between items-center text-xs font-black text-indigo-950 border-t pt-1.5 border-slate-200">
                              <span className="uppercase text-[10px] tracking-wider text-indigo-900">Calculated Grand Total:</span>
                              <span className="text-sm font-mono text-indigo-650 bg-indigo-50 px-2 py-0.5 rounded-lg border border-indigo-100">
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
                  disabled={cartItems.length === 0}
                  className={`w-full py-2.5 rounded-xl text-xs font-black transition-all flex items-center justify-center gap-1.5 mt-1 cursor-pointer tracking-wider uppercase ${
                    cartItems.length === 0 
                      ? 'bg-slate-200 text-slate-400 cursor-not-allowed border border-slate-300' 
                      : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm hover:shadow-md'
                  }`}
                >
                  <CheckCircle size={13} />
                  CREATE CHOSEN QUOTATION
                </button>
              </div>

            </div>
          </div>

          {/* List of existing Quotations / Invoices */}
          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-extrabold text-slate-400 uppercase tracking-wider">Historical Corporate Documents</h4>
            
            {/* Filter Tabs */}
            <div className="flex bg-slate-100 p-1 rounded-lg gap-1 border">
              {(['ALL', 'QUOTATION', 'INVOICE', 'DELIVERY_NOTE'] as const).map(f => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setDocFilter(f)}
                  className={`flex-1 text-[9px] font-extrabold uppercase py-1 rounded-md transition-all leading-tight ${
                    docFilter === f 
                      ? 'bg-white text-indigo-700 shadow-3xs' 
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {f === 'DELIVERY_NOTE' ? 'DELIV' : f}
                </button>
              ))}
            </div>

            <div className="divide-y divide-slate-100 border rounded-xl overflow-hidden bg-white">
              {(() => {
                const filtered = quotations.filter(q => {
                  if (docFilter === 'ALL') return true;
                  return q.status === docFilter;
                });
                if (filtered.length === 0) {
                  return <div className="p-6 text-center text-slate-400 text-xs">No {docFilter.toLowerCase().replace('_', ' ')}s recorded.</div>;
                }
                return filtered.map(q => {
                  const isQuote = q.status === 'QUOTATION';
                  const isInv = q.status === 'INVOICE';
                  return (
                    <div
                      key={q.id}
                      onClick={() => { setSelectedQuote(q); setEditItems(JSON.parse(q.items_json)); setIsEditingQuote(false); }}
                      className={`p-3 hover:bg-slate-50 transition-all cursor-pointer relative flex flex-col gap-1.5 ${
                        selectedQuote?.id === q.id ? 'bg-indigo-50/50 border-l-4 border-l-indigo-600' : ''
                      }`}
                    >
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-bold text-slate-800">{q.customer_name}</span>
                        <span className={`text-[8px] font-extrabold uppercase px-1.5 py-0.5 rounded-md ${
                          isQuote ? 'bg-indigo-100 text-indigo-800' : isInv ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'
                        }`}>
                          {q.status}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-[10px] text-slate-400 font-mono">
                        <span>{q.id} • {new Date(q.created_at).toLocaleDateString()}</span>
                        <strong className="text-slate-700 text-xs">{settings.currency}{q.total.toFixed(2)}</strong>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>

        </div>

        {/* RIGHTSIDE LIVE PREVIEW SHEET / PRINTER MOCK */}
        <div className="flex-1 bg-slate-100 overflow-y-auto p-5 relative">
          
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
                      {activeDoc.status === 'QUOTATION' && (
                        <>
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
                            {isEditingQuote ? 'VIEW PREVIEW' : 'EDIT QUOTATION'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleConvertToInvoice(activeDoc.id)}
                            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-[11px] rounded-lg shadow-3xs cursor-pointer tracking-wider transition-all"
                          >
                            CONVERT TO INVOICE
                          </button>
                        </>
                      )}
                      {activeDoc.status === 'INVOICE' && (
                        <button
                          type="button"
                          onClick={() => handleConvertToDeliveryNote(activeDoc.id)}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-[11px] rounded-lg shadow-3xs cursor-pointer tracking-wider transition-all"
                        >
                          CONVERT TO DELIVERY NOTE
                        </button>
                      )}
                      {activeDoc.status === 'DELIVERY_NOTE' && (
                        <span className="text-[11px] text-emerald-700 bg-emerald-50 px-2.5 py-1.5 rounded-lg font-bold uppercase tracking-wider border border-emerald-100">
                          ✓ Shipments Ready for Easing
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => handleDeleteDocument(activeDoc.id)}
                        className="px-2.5 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 font-bold text-[11px] rounded-lg cursor-pointer tracking-wider flex items-center gap-1 transition-all"
                        title="Delete permanently"
                      >
                        <Trash2 size={11} />
                        DELETE
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* WhatsApp instant sharing layout */}
              <div className="border border-green-200 bg-green-50/50 p-3.5 rounded-xl flex items-center justify-between flex-wrap gap-3 font-sans">
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-sans">💬</span>
                  <div className="font-sans text-left">
                    <h4 className="text-xs font-extrabold text-green-900 uppercase">Instant WhatsApp sharing</h4>
                    <p className="text-[10px] text-green-700 font-semibold leading-tight">
                      Share quotation/invoice details and bank info direct to customer chat
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 font-sans">
                  <input
                    type="text"
                    placeholder="Customer phone prefix"
                    value={whatsappSharePhone}
                    onChange={(e) => setWhatsappSharePhone(e.target.value)}
                    className="px-2.5 py-1.5 text-xs border border-green-300 rounded-lg bg-white font-bold w-44 text-green-950 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (!whatsappSharePhone) {
                        alert('Please fill in a valid phone number (including country prefix, e.g. +260977...) to share this via WhatsApp.');
                        return;
                      }

                      // Generate and download the PDF document for the user first
                      const pdfFileName = handleDownloadPDF(activeDoc);
                      
                      const cleanPhone = whatsappSharePhone.replace(/[^\d+]/g, '');
                      const headerDecor = '━━━━━━━━━━━━━━━━━━━━━━━━━';
                      let msg = `⚙️ *DOCUMENT DETAILS: ${activeDoc.status}* ⚙️\n`;
                      msg += `*${companyName.toUpperCase()}*\n`;
                      msg += `_TPIN: ${companyTPIN}_\n`;
                      msg += `${companyAddress}\n`;
                      msg += `${headerDecor}\n`;
                      msg += `*Doc ID:* ${activeDoc.id}\n`;
                      msg += `*Date:* ${new Date(activeDoc.created_at).toLocaleDateString()}\n`;
                      msg += `*Client Name:* ${activeDoc.customer_name}\n`;
                      msg += `${headerDecor}\n\n`;

                      msg += `✨ *LINE ITEMS:*\n`;
                      activeDoc.items.forEach((item: any) => {
                        msg += `• *${item.name}*\n`;
                        msg += `  ${settings.currency}${item.unitPrice.toFixed(2)} x ${item.quantity} ➔ *${settings.currency}${(item.unitPrice * item.quantity).toFixed(2)}*\n`;
                      });
                      msg += `\n${headerDecor}\n`;
                      msg += `*Subtotal:* ${settings.currency}${activeDoc.subtotal.toFixed(2)}\n`;
                      if (activeDoc.discount > 0) {
                        msg += `*Discount:* -${settings.currency}${activeDoc.discount.toFixed(2)}\n`;
                      }
                      msg += `*VAT (${settings.taxRate}%):* ${settings.currency}${activeDoc.tax.toFixed(2)}\n`;
                      msg += `*GRAND TOTAL: ${settings.currency}${activeDoc.total.toFixed(2)}*\n`;
                      msg += `${headerDecor}\n\n`;

                      msg += `🏛️ *ZAMBIA BANK DETAILS FOR PAYMENT:*\n`;
                      msg += `• *BANK NAME:* ${activeDoc.bank_name}\n`;
                      msg += `• *ACCOUNT NAME:* ${activeDoc.bankAccountName}\n`;
                      msg += `• *ACCOUNT NUMBER:* ${activeDoc.bank_account}\n`;
                      msg += `• *BRANCH NAME:* ${activeDoc.bank_branch}\n`;
                      msg += `• *SORT CODE:* ${activeDoc.bankSortCode}\n`;
                      msg += `${headerDecor}\n\n`;

                      if (activeDoc.appliedTerms && activeDoc.appliedTerms.length > 0) {
                        msg += `📝 *TERMS & CONDITIONS:*\n`;
                        activeDoc.appliedTerms.forEach((term: string, idx: number) => {
                          msg += `${idx + 1}. ${term}\n`;
                        });
                        msg += `${headerDecor}\n\n`;
                      }

                      msg += `*Thank you for choice of partnership!*\n`;
                      msg += `_This document has been synchronized via SME Core POS engine._`;

                      const url = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(msg)}`;
                      
                      alert(`📄 PDF Quotation downloaded successfully as "${pdfFileName || 'document.pdf'}".\n\nWe are now opening WhatsApp. You can simply drag-and-drop or attach the downloaded PDF file directly in the chat to send it to your customer!`);
                      window.open(url, '_blank');
                    }}
                    className="px-3.5 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-xs font-bold font-sans cursor-pointer uppercase transition-all tracking-wider"
                  >
                    Share via WhatsApp
                  </button>
                </div>
              </div>

              {isEditingQuote && selectedQuote ? (
                <div className="bg-white rounded-2xl border border-indigo-200 p-6 shadow-xl flex flex-col gap-5">
                  <div className="flex justify-between items-center border-b border-indigo-100 pb-3 font-sans">
                    <div>
                      <h3 className="text-xs font-extrabold text-indigo-950 uppercase tracking-widest flex items-center gap-1.5">
                        <Edit3 size={14} className="text-indigo-600" />
                        Edit Quotation: {selectedQuote.id}
                      </h3>
                      <p className="text-[10px] text-slate-400 font-extrabold uppercase mt-0.5">Modifying client profile & items list</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsEditingQuote(false)}
                      className="px-3 py-1 text-slate-500 hover:text-slate-800 text-xs font-bold font-sans border rounded-md"
                    >
                      Cancel
                    </button>
                  </div>

                  <form onSubmit={handleSaveQuotationEdits} className="flex flex-col gap-4 font-sans text-xs">
                    {/* Client details */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1 col-span-2">
                        <label className="text-[10px] text-slate-400 font-bold uppercase">Customer Corporate Name</label>
                        <input
                          type="text"
                          required
                          value={editCName}
                          onChange={(e) => setEditCName(e.target.value)}
                          className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-bold"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-slate-400 font-bold uppercase">Phone Number</label>
                        <input
                          type="text"
                          value={editCPhone}
                          onChange={(e) => setEditCPhone(e.target.value)}
                          className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-semibold"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-slate-400 font-bold uppercase">Email Address</label>
                        <input
                          type="email"
                          value={editCEmail}
                          onChange={(e) => setEditCEmail(e.target.value)}
                          className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-semibold"
                        />
                      </div>
                    </div>

                    {/* Bank Details in Editing Form */}
                    <div className="bg-indigo-50/20 p-3 rounded-xl border border-indigo-100 flex flex-col gap-2">
                      <span className="text-[10px] text-indigo-900 font-extrabold uppercase">Update Payment Bank Options</span>
                      <div className="flex flex-col gap-1.5 text-xs text-slate-700">
                        <div className="flex flex-col">
                          <label className="text-[9px] text-slate-400 font-bold">BANK NAME</label>
                          <input
                            type="text"
                            required
                            value={editBankName}
                            onChange={(e) => setEditBankName(e.target.value)}
                            className="bg-white border rounded p-1 px-2 font-bold"
                          />
                        </div>
                        <div className="flex flex-col">
                          <label className="text-[9px] text-slate-400 font-bold">ACCOUNT NAME</label>
                          <input
                            type="text"
                            required
                            value={editBankAccountName}
                            onChange={(e) => setEditBankAccountName(e.target.value)}
                            className="bg-white border rounded p-1 px-2 font-bold"
                          />
                        </div>
                        <div className="flex flex-col">
                          <label className="text-[9px] text-slate-400 font-bold">ACCOUNT NUMBER</label>
                          <input
                            type="text"
                            required
                            value={editBankAccountNumber}
                            onChange={(e) => setEditBankAccountNumber(e.target.value)}
                            className="bg-white border rounded p-1 px-2 font-bold font-mono"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="flex flex-col">
                            <label className="text-[9px] text-slate-400 font-bold">BRANCH NAME</label>
                            <input
                              type="text"
                              required
                              value={editBankBranchName}
                              onChange={(e) => setEditBankBranchName(e.target.value)}
                              className="bg-white border rounded p-1 px-2 font-semibold"
                            />
                          </div>
                          <div className="flex flex-col">
                            <label className="text-[9px] text-slate-400 font-bold">SORT CODE</label>
                            <input
                              type="text"
                              required
                              value={editBankSortCode}
                              onChange={(e) => setEditBankSortCode(e.target.value)}
                              className="bg-white border rounded p-1 px-2 font-semibold font-mono"
                            />
                          </div>
                        </div>
                      </div>
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

                    {/* Quick Catalog Shelf */}
                    <div className="border border-indigo-100 rounded-xl p-3 bg-indigo-50/20">
                      <span className="font-extrabold text-indigo-900 text-[10px] uppercase block mb-1.5">Add products to this quotation</span>
                      <div className="flex items-center gap-1.5 overflow-x-auto py-1 max-w-full">
                        {allProducts.map(p => (
                          <button
                            type="button"
                            key={p.id}
                            onClick={() => addProductToEditItems(p)}
                            className="px-2.5 py-1 text-[10px] font-bold bg-white hover:bg-slate-50 border border-slate-200 rounded-md whitespace-nowrap"
                          >
                            + {p.name} • {settings.currency}{p.price.toFixed(2)}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Draft line items table */}
                    <div className="divide-y divide-slate-100 bg-slate-50 border rounded-xl overflow-hidden px-3 py-1">
                      <div className="flex justify-between items-center font-bold text-slate-400 py-2 border-b text-[9px] uppercase">
                        <span>Selected items</span>
                        <div className="flex gap-14 mr-4">
                          <span>QTY</span>
                          <span>PRICE</span>
                        </div>
                      </div>
                      {editItems.map((item, idx) => (
                        <div key={idx} className="py-2 flex justify-between items-center">
                          <span className="font-bold text-slate-700">{item.name}</span>
                          <div className="flex items-center gap-3">
                            <input
                              type="number"
                              min="1"
                              value={item.quantity}
                              onChange={(e) => {
                                const val = parseInt(e.target.value) || 1;
                                const updated = [...editItems];
                                updated[idx].quantity = val;
                                setEditItems(updated);
                              }}
                              className="w-12 text-center bg-white border border-slate-200 text-xs rounded-md font-bold py-0.5"
                            />
                            <span className="text-slate-550 font-mono w-14 text-right">
                              {settings.currency}{(item.unitPrice * item.quantity).toFixed(2)}
                            </span>
                            <button
                              type="button"
                              onClick={() => removeItemFromEditItems(idx)}
                              className="text-rose-500 hover:text-rose-700 font-extrabold px-1"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                      {editItems.length === 0 && (
                        <div className="p-4 text-center text-slate-400 font-semibold">No items in this quotation. Add some above.</div>
                      )}
                    </div>

                    {/* Discount option */}
                    <div className="flex flex-col gap-1 max-w-xs">
                      <label className="text-[10px] text-slate-400 font-bold uppercase">Discount ({settings.currency})</label>
                      <input
                        type="number"
                        step="0.01"
                        value={editDiscountVal}
                        onChange={(e) => setEditDiscountVal(e.target.value)}
                        className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-semibold"
                      />
                    </div>

                    {/* Action controls */}
                    <button
                      type="submit"
                      className="py-2.5 px-4 mt-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg text-xs tracking-wider cursor-pointer transition-all text-center uppercase"
                    >
                      SAVE UPDATED QUOTATION
                    </button>
                  </form>
                </div>
              ) : (
                <>
                  {/* DELIVERY NOTE PRODUCT QUANTITY EASING DRAG PANEL */}
                  {!activeDoc.isDraft && activeDoc.status === 'DELIVERY_NOTE' && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-col gap-3 font-sans text-left">
                      <div className="flex justify-between items-center border-b border-amber-150 pb-2">
                        <h4 className="text-xs font-extrabold text-amber-900 uppercase tracking-wider flex items-center gap-1.5">
                          <Edit3 size={14} />
                          Delivery Note Shipments Easing Panel
                        </h4>
                        <button
                          type="button"
                          onClick={handleSaveDeliveryEasing}
                          className="px-3 py-1 bg-amber-600 active:bg-amber-700 text-white text-[11px] font-bold rounded-md shadow-xs cursor-pointer"
                        >
                          Save Easing Changes
                        </button>
                      </div>

                      <p className="text-[11px] text-amber-700 font-semibold leading-relaxed">
                        Corporate clients frequently request custom quantity easing at delivery due to transit limits. Adjust the delivered counts below. Saving will automatically update the Delivery Note totals.
                      </p>

                      <div className="divide-y divide-amber-100 max-h-40 overflow-y-auto font-sans">
                        {editItems.map((item, index) => (
                          <div key={index} className="py-2 flex justify-between items-center text-xs font-semibold">
                            <span className="font-bold text-amber-900">{item.name}</span>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-amber-600">Delivering Count:</span>
                              <input
                                type="number"
                                value={item.quantity}
                                onChange={(e) => handleUpdateDeliveryQty(index, e.target.value)}
                                className="w-16 text-center text-xs font-bold bg-white border border-amber-250 text-amber-805 rounded-md py-0.5"
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* SHEET FORM: CUSTOM A4 ELEGANTE BRAND PREVIEW */}
                  <div className="bg-white rounded-2xl border border-slate-250 p-8 shadow-xl document-print-section flex flex-col gap-6 text-slate-800 font-serif relative overflow-hidden text-left">
                    
                    {activeDoc.isDraft && (
                      <div className="absolute top-3 right-3 bg-amber-100 text-amber-800 border border-amber-201 px-3 py-1 rounded text-[9px] font-black uppercase tracking-widest pointer-events-none opacity-80 select-none">
                        DRAFT PREVIEW
                      </div>
                    )}
                    
                    {/* Visual Header Grid layout */}
                    <div className="flex justify-between items-start flex-wrap gap-4 border-b border-indigo-100 pb-5">
                      <div className="font-sans">
                        {/* Mock Logo */}
                        <div className="flex items-center gap-2">
                          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center text-white text-md font-serif font-extrabold shadow-sm">
                            {logoText}
                          </div>
                          <div>
                            <h2 className="text-md font-extrabold tracking-tight text-indigo-900 uppercase font-sans leading-none">{companyName}</h2>
                            <p className="text-[10px] text-slate-400 font-bold uppercase mt-1">TPIN: {companyTPIN}</p>
                          </div>
                        </div>
                        <p className="text-[11px] text-slate-500 mt-3 font-semibold font-sans max-w-[280px] leading-relaxed">{companyAddress}</p>
                      </div>

                      <div className="text-right font-sans min-w-[150px]">
                        <h1 className="text-lg font-extrabold tracking-normal text-indigo-950 font-serif uppercase leading-tight">{activeDoc.status}</h1>
                        <p className="text-xs font-mono mt-1 font-bold text-slate-705">Doc ID: {activeDoc.id}</p>
                        <p className="text-[11px] text-slate-500 font-semibold mt-1">Date: {new Date(activeDoc.created_at).toLocaleString()}</p>
                      </div>
                    </div>

                    {/* Client invoice details */}
                    <div className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-5 font-sans">
                      <div>
                        <h4 className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest">Billed To Profile</h4>
                        <p className="text-xs font-extrabold text-slate-900 mt-1.5">{activeDoc.customer_name}</p>
                        {activeDoc.customer_phone && <p className="text-[11px] text-slate-500 mt-1">Phone: {activeDoc.customer_phone}</p>}
                        {activeDoc.customer_email && <p className="text-[11px] text-slate-500 font-medium mt-0.5">Email: {activeDoc.customer_email}</p>}
                      </div>

                      <div>
                        <h4 className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest">Zambia Bank Details</h4>
                        <div className="text-[11px] text-slate-550 mt-1.5 space-y-1 leading-tight">
                          <p><span className="font-extrabold text-[8px] text-slate-400 uppercase mr-1">BANK NAME:</span> <strong className="text-slate-800">{activeDoc.bank_name}</strong></p>
                          <p><span className="font-extrabold text-[8px] text-slate-400 uppercase mr-1">ACCOUNT NAME:</span> <strong className="text-slate-800">{activeDoc.bankAccountName || companyName}</strong></p>
                          <p><span className="font-extrabold text-[8px] text-slate-400 uppercase mr-1">ACCOUNT NUMBER:</span> <strong className="text-indigo-950 font-bold font-mono">{activeDoc.bank_account}</strong></p>
                          <p><span className="font-extrabold text-[8px] text-slate-400 uppercase mr-1">BRANCH NAME:</span> <strong className="text-slate-800">{activeDoc.bank_branch}</strong></p>
                          <p><span className="font-extrabold text-[8px] text-slate-400 uppercase mr-1">SORT CODE:</span> <strong className="text-slate-800 font-bold font-mono">{activeDoc.bankSortCode || '01-02-03'}</strong></p>
                        </div>
                      </div>
                    </div>

                    {/* Sales line items table */}
                    <div className="font-sans flex-1 font-serif">
                      <table className="w-full text-left text-xs font-sans">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-450 font-extrabold uppercase text-[10px] tracking-wider font-sans">
                            <th className="py-2 text-left font-sans">Item Description</th>
                            <th className="py-2 text-center">Unit Price</th>
                            <th className="py-2 text-center">Quantity</th>
                            <th className="py-2 text-right">Line Total</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-105 text-slate-700 font-semibold">
                          {activeDoc.items.map((item: any, idx: number) => (
                            <tr key={idx} className="hover:bg-slate-50/50">
                              <td className="py-2.5 font-bold text-slate-800">{item.name}</td>
                              <td className="py-2.5 text-center font-mono">{settings.currency}{item.unitPrice.toFixed(2)}</td>
                              <td className="py-2.5 text-center font-mono">{item.quantity}</td>
                              <td className="py-2.5 text-right font-mono font-bold text-slate-950">
                                {settings.currency}{(item.unitPrice * item.quantity).toFixed(2)}
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
                          <span className="font-bold font-mono text-slate-800">{settings.currency}{activeDoc.subtotal.toFixed(2)}</span>
                        </div>
                        {activeDoc.discount > 0 && (
                          <div className="flex justify-between text-rose-600 font-bold">
                            <span>Discount:</span>
                            <span className="font-mono">-{settings.currency}{activeDoc.discount.toFixed(2)}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-slate-500 font-bold">
                          <span>Tax (VAT {settings.taxRate}%):</span>
                          <span className="font-mono text-slate-800">{settings.currency}{activeDoc.tax.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-slate-900 border-t border-slate-200 pt-2 font-black text-sm">
                          <span className="text-indigo-900 uppercase text-[11px] tracking-wider">Grand Total:</span>
                          <span className="font-mono text-indigo-950 bg-indigo-50/50 px-2 py-0.5 rounded border border-indigo-100">
                            {settings.currency}{activeDoc.total.toFixed(2)}
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

                    {/* Company Footer note definitions */}
                    <div className="border-t border-slate-100 pt-4 mt-4 font-sans text-center text-[10px] text-slate-400 font-semibold leading-normal">
                      <span>Powering small and medium enterprises across Copperbelt & Upper Zambia. Thank you for your trusted business!</span>
                    </div>

                  </div>
                </>
              )}

            </div>
          ) : (
            <div className="flex flex-col items-center justify-center text-slate-400 h-96 gap-3 font-sans max-w-sm mx-auto text-center">
              <div className="w-12 h-12 bg-white border rounded-2xl flex items-center justify-center text-slate-400 shadow-3xs">
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
