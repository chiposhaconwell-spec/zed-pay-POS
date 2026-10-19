import React, { useState, useEffect } from 'react';
import { jsPDF } from 'jspdf';
import { exportAndSharePdf, safeSystemPrint } from '../androidUtils';
import { runSql, persistTablesToStorage, upsertCustomerSync, logEmployeeAudit, syncAllAccountingSystems } from '../db';
import { 
  Users, 
  Search, 
  Coins, 
  ArrowRight, 
  Calendar, 
  Percent, 
  CheckCircle, 
  Plus, 
  UserPlus, 
  Phone, 
  Mail, 
  DollarSign, 
  ShoppingBag, 
  Receipt, 
  Printer, 
  Eye, 
  AlertTriangle,
  Camera,
  Activity
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { StoreSettings } from '../types';
import { DEFAULT_COMPANY_LOGO } from '../App';

interface LaybysBoardProps {
  settings: StoreSettings;
  activeStore?: string;
  onTriggerSalesCounterAction?: (action: 'camera' | 'cashup') => void;
}

interface Layby {
  id: string;
  customer_id: number | null;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  total_amount: number;
  deposit_amount: number;
  amount_paid: number;
  balance_due: number;
  status: 'PENDING' | 'COMPLETED' | 'CANCELLED';
  items_json: string; // serialized JSON array
  store_id?: string;
  created_at: string;
}

interface Installment {
  id: string;
  layby_id: string;
  amount: number;
  payment_method: string;
  received_by: string;
  created_at: string;
}

export default function LaybysBoard({ settings, activeStore = '', onTriggerSalesCounterAction }: LaybysBoardProps) {
  const [laybys, setLaybys] = useState<Layby[]>([]);
  const [showSaleOptions, setShowSaleOptions] = useState(false);
  const [selectedLayby, setSelectedLayby] = useState<Layby | null>(null);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [searchText, setSearchText] = useState('');
  
  // Create New Layby Form
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [existingCustomers, setExistingCustomers] = useState<any[]>([]);
  const [selectedCustId, setSelectedCustId] = useState<string>('');
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [selectedItems, setSelectedItems] = useState<any[]>([]); // list of products
  const [customDeposit, setCustomDeposit] = useState<string>('');
  const [allProducts, setAllProducts] = useState<any[]>([]);
  const [itemSearchQuery, setItemSearchQuery] = useState('');
  
  // Add payment states
  const [paymentAmount, setPaymentAmount] = useState('');
  const [payMethod, setPayMethod] = useState('Cash');
  const [cashierName, setCashierName] = useState('Alice Mwansa');
  const [successMsg, setSuccessMsg] = useState('');

  // Installment receipt state variables
  const [activeInstReceipt, setActiveInstReceipt] = useState<any | null>(null);
  const [whatsappPhone, setWhatsappPhone] = useState<string>('');

  const compileInstallmentReceipt = (layby: Layby, allInsts: Installment[], targetInst: Installment) => {
    // Sort all installments chronologically to trace progressive balance
    const sortedInsts = [...allInsts].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    
    let cumulativePaid = 0;
    const targetIndex = sortedInsts.findIndex(x => x.id === targetInst.id);
    
    // Calculate up to target index
    for (let i = 0; i <= targetIndex; i++) {
      cumulativePaid += sortedInsts[i].amount;
    }
    
    const balanceAfter = layby.total_amount - cumulativePaid;
    const balanceBefore = balanceAfter + targetInst.amount;
    
    return {
      installmentId: targetInst.id,
      laybyId: layby.id,
      customerName: layby.customer_name,
      customerPhone: layby.customer_phone,
      amountPaidThisTime: targetInst.amount,
      previousBalance: balanceBefore,
      newBalance: balanceAfter,
      totalContractAmount: layby.total_amount,
      totalAmountPaidSoFar: cumulativePaid,
      paymentMethod: targetInst.payment_method,
      receivedBy: targetInst.received_by,
      createdAt: targetInst.created_at,
      items: parseItems(layby.items_json)
    };
  };

  const handleWhatsAppSend = (phone: string, receiptData: any) => {
    if (!phone) {
      alert('Please enter a valid WhatsApp phone number.');
      return;
    }
    const cleanPhone = phone.replace(/[^\d+]/g, '');
    const headerDecor = "============================";
    let msg = `*${settings.storeName.toUpperCase()} LAYBY RECEIPT*\n`;
    msg += `*Receipt ID:* ${receiptData.installmentId}\n`;
    msg += `*Layby Contract ID:* ${receiptData.laybyId}\n`;
    msg += `*Date:* ${new Date(receiptData.createdAt).toLocaleDateString()}\n`;
    msg += `${headerDecor}\n`;
    msg += `*Customer:* ${receiptData.customerName}\n`;
    msg += `*Phone:* ${receiptData.customerPhone}\n`;
    msg += `${headerDecor}\n`;
    msg += `*Reserved Items:*\n`;
    receiptData.items.forEach((item: any) => {
      msg += `• ${item.name} x${item.quantity} (${settings.currency}${item.unitPrice.toFixed(2)} ea)\n`;
    });
    msg += `${headerDecor}\n`;
    msg += `*TOTAL CONTRACT:* ${settings.currency}${receiptData.totalContractAmount.toFixed(2)}\n`;
    msg += `*PAID THIS TIME:* ${settings.currency}${receiptData.amountPaidThisTime.toFixed(2)}\n`;
    msg += `*PAID SO FAR:* ${settings.currency}${receiptData.totalAmountPaidSoFar.toFixed(2)}\n`;
    msg += `*PREVIOUS BALANCE:* ${settings.currency}${receiptData.previousBalance.toFixed(2)}\n`;
    msg += `*NEW BALANCE DUE: ${settings.currency}${receiptData.newBalance.toFixed(2)}*\n`;
    msg += `${headerDecor}\n`;
    msg += `*Payment Mode:* ${receiptData.paymentMethod.toUpperCase()}\n`;
    msg += `*Received By:* ${receiptData.receivedBy}\n`;
    if (settings.receiptFooter) {
      msg += `\n_${settings.receiptFooter}_`;
    }
    
    const url = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(msg)}`;
    window.open(url, '_blank');
  };

  const generateInstPdfReceipt = (receiptData: any) => {
    try {
      const logoToUse = settings.logoUrl || DEFAULT_COMPANY_LOGO;
      // Dynamically expand physical ticket size
      let ticketHeight = 160;
      if (logoToUse) ticketHeight += 20;
      if (settings.termsAndConditions) {
        ticketHeight += Math.ceil(settings.termsAndConditions.length / 45) * 4 + 10;
      }

      const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: [80, ticketHeight]
      });

      doc.setFont('times', 'normal');

      let headingOffset = 10;

      // Draw Company Logo picture
      if (logoToUse) {
        try {
          doc.addImage(logoToUse, 'PNG', 32.5, headingOffset, 15, 15);
          headingOffset += 18;
        } catch (err) {
          console.warn("Error rendering logo in PDF, skipping:", err);
          headingOffset += 2;
        }
      }

      // Title
      doc.setFont('times', 'bold');
      doc.setFontSize(13);
      doc.text(settings.storeName.toUpperCase(), 40, headingOffset, { align: 'center' });
      headingOffset += 5;

      doc.setFont('times', 'normal');
      doc.setFontSize(8);
      if (settings.receiptHeader) {
        doc.text(settings.receiptHeader, 40, headingOffset, { align: 'center' });
        headingOffset += 4.5;
      }

      // TPIN Number
      if (settings.tpin) {
        doc.setFont('times', 'bold');
        doc.text(`TPIN: ${settings.tpin}`, 40, headingOffset, { align: 'center' });
        doc.setFont('times', 'normal');
        headingOffset += 4.5;
      }

      doc.setFont('times', 'bold');
      doc.text('INSTALLMENT PAYMENT RECEIPT', 40, headingOffset, { align: 'center' });
      headingOffset += 5;
      
      doc.setFont('times', 'normal');
      doc.setFontSize(7.5);
      doc.text(`RECEIPT NO: ${receiptData.installmentId}`, 4, headingOffset); headingOffset += 4;
      doc.text(`CONTRACT ID: ${receiptData.laybyId}`, 4, headingOffset); headingOffset += 4;
      doc.text(`DATE/TIME: ${new Date(receiptData.createdAt).toLocaleString()}`, 4, headingOffset); headingOffset += 4;
      doc.text(`CUSTOMER: ${receiptData.customerName}`, 4, headingOffset); headingOffset += 4;
      doc.text(`PHONE: ${receiptData.customerPhone}`, 4, headingOffset); headingOffset += 4;

      // Divider
      doc.setDrawColor(200);
      doc.setLineWidth(0.2);
      doc.line(4, headingOffset, 76, headingOffset);
      headingOffset += 4;

      // Table Header
      doc.setFont('helvetica', 'bold');
      doc.text('RESERVED ITEM', 4, headingOffset);
      doc.text('QTY', 44, headingOffset, { align: 'center' });
      doc.text('PRICE', 58, headingOffset, { align: 'right' });
      doc.text('TOTAL', 76, headingOffset, { align: 'right' });
      headingOffset += 4;
      doc.setFont('helvetica', 'normal');

      receiptData.items.forEach((item: any) => {
        const itemY = headingOffset;
        const nameLines = doc.splitTextToSize(item.name, 35);
        doc.text(nameLines, 4, itemY);
        doc.text(item.quantity.toString(), 44, itemY, { align: 'center' });
        doc.text(`${settings.currency}${item.unitPrice.toFixed(2)}`, 58, itemY, { align: 'right' });
        doc.text(`${settings.currency}${(item.unitPrice * item.quantity).toFixed(2)}`, 76, itemY, { align: 'right' });
        headingOffset += (nameLines.length * 3.5) + 1;
      });

      // Divider
      doc.line(4, headingOffset, 76, headingOffset);
      headingOffset += 5;

      // Outstanding details
      doc.text('Total Contract Value:', 46, headingOffset, { align: 'right' });
      doc.text(`${settings.currency}${receiptData.totalContractAmount.toFixed(2)}`, 76, headingOffset, { align: 'right' });
      headingOffset += 4;

      doc.setFont('helvetica', 'bold');
      doc.text('INSTALLMENT PAID:', 46, headingOffset, { align: 'right' });
      doc.text(`${settings.currency}${receiptData.amountPaidThisTime.toFixed(2)}`, 76, headingOffset, { align: 'right' });
      headingOffset += 4;
      doc.setFont('helvetica', 'normal');

      doc.text('Total Settled So Far:', 46, headingOffset, { align: 'right' });
      doc.text(`${settings.currency}${receiptData.totalAmountPaidSoFar.toFixed(2)}`, 76, headingOffset, { align: 'right' });
      headingOffset += 4;

      doc.setFont('helvetica', 'bold');
      doc.text('NEW BALANCE DUE:', 46, headingOffset, { align: 'right' });
      doc.text(`${settings.currency}${receiptData.newBalance.toFixed(2)}`, 76, headingOffset, { align: 'right' });
      headingOffset += 5;

      // Divider
      doc.line(4, headingOffset, 76, headingOffset);
      headingOffset += 4;

      doc.setFontSize(7);
      doc.text(`Payment Channel: ${receiptData.paymentMethod}`, 4, headingOffset); headingOffset += 4;
      doc.text(`Served by: ${receiptData.receivedBy}`, 4, headingOffset); headingOffset += 4;

      // Render Divider for Footer info
      doc.setDrawColor(200);
      doc.line(4, headingOffset, 76, headingOffset);
      headingOffset += 4.5;

      // Support Terms and Conditions
      if (settings.termsAndConditions) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.5);
        doc.text('TERMS & CONDITIONS:', 4, headingOffset);
        headingOffset += 3.2;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6);
        
        const lines = doc.splitTextToSize(settings.termsAndConditions, 72);
        lines.forEach((l: string) => {
          doc.text(l, 4, headingOffset);
          headingOffset += 3.0;
        });
        headingOffset += 2;
      }

      if (settings.receiptFooter) {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(7.5);
        doc.text(settings.receiptFooter, 40, headingOffset, { align: 'center' });
      }

      exportAndSharePdf(`Layby_Receipt_${receiptData.installmentId}.pdf`, doc);
    } catch (err: any) {
      alert('Error generating PDF receipt: ' + err.message);
    }
  };

  const loadData = () => {
    const storeWhere = activeStore ? `WHERE LOWER(store_id) = '${activeStore.toLowerCase()}'` : '';
    const res = runSql(`SELECT * FROM laybys ${storeWhere} ORDER BY created_at DESC`, 'Layby: Fetch branch layaway customer accounts');
    if (res.success && Array.isArray(res.data)) {
      setLaybys(res.data);
    }
    
    const spAllRes = runSql('SELECT product_id, store_id, stock, price FROM store_products', 'Layby: Check branch stock map', true);
    const spList = (spAllRes.success && Array.isArray(spAllRes.data)) ? spAllRes.data : [];
    const prodRes = runSql('SELECT * FROM products', 'Layby: Load stock catalog');
    if (prodRes.success && Array.isArray(prodRes.data)) {
      const branchProds = prodRes.data.map((p: any) => {
        const override = spList.find((sp: any) => Number(sp.product_id) === Number(p.id) && String(sp.store_id) === String(activeStore));
        const hasAnyBranchRecord = spList.some((sp: any) => Number(sp.product_id) === Number(p.id));
        return {
          ...p,
          price: override !== undefined ? Number(override.price) : Number(p.price || 0),
          stock: override !== undefined ? Number(override.stock) : (hasAnyBranchRecord ? 0 : Number(p.stock || 0))
        };
      }).filter((p: any) => p.stock > 0 || p.is_service === 1);
      setAllProducts(branchProds);
    }

    const custRes = runSql('SELECT * FROM customers ORDER BY name ASC', 'Layby: Load saved CRM customers');
    if (custRes.success && Array.isArray(custRes.data)) {
      setExistingCustomers(custRes.data);
    }

    if (selectedLayby) {
      const activeId = selectedLayby.id;
      const instRes = runSql(`SELECT * FROM layby_installments WHERE layby_id = '${activeId}' ORDER BY created_at DESC`, 'Layby: Fetch payments log');
      if (instRes.success && Array.isArray(instRes.data)) {
        setInstallments(instRes.data);
      }
      
      // refresh active selected layby record from db
      const freshRes = runSql(`SELECT * FROM laybys WHERE id = '${activeId}'`, 'Layby: Sync client tracker data');
      if (freshRes.success && Array.isArray(freshRes.data) && freshRes.data.length > 0) {
        setSelectedLayby(freshRes.data[0]);
      }
    }
  };

  useEffect(() => {
    loadData();
  }, [selectedLayby?.id, activeStore]);

  const filteredLaybys = laybys.filter(l => 
    l.customer_name.toLowerCase().includes(searchText.toLowerCase()) ||
    l.customer_phone.includes(searchText) ||
    l.id.toLowerCase().includes(searchText.toLowerCase())
  );

  const calculateGrandTotal = () => {
    return selectedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  };

  const filteredProductsToSelect = allProducts.filter(p => {
    const q = itemSearchQuery.toLowerCase().trim();
    if (!q) return true;
    return (
      (p.name && p.name.toLowerCase().includes(q)) ||
      (p.sku && p.sku.toLowerCase().includes(q)) ||
      (p.category && p.category.toLowerCase().includes(q))
    );
  });

  const handleSelectItem = (p: any) => {
    const existsIdx = selectedItems.findIndex(x => x.id === p.id);
    if (existsIdx > -1) {
      const updated = [...selectedItems];
      if (updated[existsIdx].quantity < p.stock) {
        updated[existsIdx].quantity += 1;
        setSelectedItems(updated);
      } else {
        alert(`Cannot exceed available warehouse inventory stock (${p.stock} units)!`);
      }
    } else {
      setSelectedItems([...selectedItems, { ...p, quantity: 1 }]);
    }
  };

  const handleUpdateItemQuantity = (pId: number, delta: number) => {
    setSelectedItems(prev => {
      return prev.map(item => {
        if (item.id === pId) {
          const newQty = item.quantity + delta;
          if (newQty > item.stock) {
            alert(`Cannot exceed available warehouse inventory stock (${item.stock} units)!`);
            return item;
          }
          return newQty > 0 ? { ...item, quantity: newQty } : null;
        }
        return item;
      }).filter(Boolean) as any[];
    });
  };

  const handleRemoveSelectItem = (pId: number) => {
    setSelectedItems(selectedItems.filter(x => x.id !== pId));
  };

  const handleCreateLayby = (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientName || !clientPhone || selectedItems.length === 0) {
      alert('Please enter customer details and select products!');
      return;
    }

    const total = calculateGrandTotal();
    const depositNum = parseFloat(customDeposit) || Math.round(total * 0.2); // Default 20% down payment
    
    if (depositNum >= total) {
      alert('Downpayment cannot exceed or equal total amount! If full payment, use Sale Screen instead.');
      return;
    }

    const laybyId = 'LBY-' + Math.floor(1000 + Math.random() * 9000);
    const dateStr = new Date().toISOString();
    const itemsJson = JSON.stringify(selectedItems.map(x => ({ id: x.id, name: x.name, quantity: x.quantity, unitPrice: x.price })));

    // Central CRM Customer Synchronization
    const syncedCust = upsertCustomerSync({
      name: clientName,
      phone: clientPhone,
      email: clientEmail,
      loyalPointsDelta: Math.floor(depositNum * 0.1) // Accrue initial loyalty points for downpayment
    });
    const finalCustId = syncedCust ? syncedCust.id : 100 + Math.floor(Math.random() * 900);

    const targetBranch = activeStore || 'main';
    // Insert layby record with branch store_id
    const insertLaybySql = `
      INSERT INTO laybys (id, customer_id, customer_name, customer_phone, customer_email, total_amount, deposit_amount, amount_paid, balance_due, status, items_json, store_id, created_at)
      VALUES (
        '${laybyId}',
        ${finalCustId},
        '${clientName.replace(/'/g, "''")}',
        '${clientPhone.replace(/'/g, "''")}',
        '${clientEmail.replace(/'/g, "''")}',
        ${total.toFixed(2)},
        ${depositNum.toFixed(2)},
        ${depositNum.toFixed(2)},
        ${(total - depositNum).toFixed(2)},
        'PENDING',
        '${itemsJson.replace(/'/g, "''")}',
        '${targetBranch}',
        '${dateStr}'
      )
    `;
    const laybyRes = runSql(insertLaybySql, `Layby: Provision client invoice tracking contract ${laybyId} for branch ${targetBranch}`);
    
    if (laybyRes.success) {
      const activeCashier = localStorage.getItem('logged_in_user_name') || cashierName || 'Cashier';
      logEmployeeAudit('LAYBY', 'Created Layby Contract', `Contract #${laybyId} for ${clientName}, Total: K${total.toFixed(2)}, Deposit: K${depositNum.toFixed(2)}`, depositNum, targetBranch, activeCashier);

      // Record initial installment
      const installmentId = 'inst-' + Math.floor(10000 + Math.random() * 90000);
      runSql(`
        INSERT INTO layby_installments (id, layby_id, amount, payment_method, received_by, created_at)
        VALUES ('${installmentId}', '${laybyId}', ${depositNum.toFixed(2)}, 'Cash', '${activeCashier.replace(/'/g, "''")}', '${dateStr}')
      `, `Layby: Log initial security deposit +K${depositNum}`);

      // Decrement physical warehouse stock instantly to reserve items in the selected branch
      selectedItems.forEach((x) => {
        runSql(`UPDATE products SET stock = stock - ${x.quantity} WHERE id = ${x.id}`, `Layby: Reserve stock item ${x.sku}`);
        runSql(`UPDATE store_products SET stock = stock - ${x.quantity} WHERE product_id = ${x.id} AND store_id = '${targetBranch}'`, `Layby: Reserve branch stock in ${targetBranch}`);
      });

      // Clear layout
      setClientName('');
      setClientPhone('');
      setClientEmail('');
      setSelectedItems([]);
      setCustomDeposit('');
      setItemSearchQuery('');
      setShowCreateModal(false);
      syncAllAccountingSystems(`Layby Created #${laybyId}`);
      loadData();
      try {
        window.dispatchEvent(new Event('pos_data_updated'));
      } catch (e) {}
      persistTablesToStorage();
      alert(`Layby account ${laybyId} successfully configured.`);
    } else {
      alert('Failed registering layby. Error: ' + laybyRes.error);
    }
  };

  const handleAddPayment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLayby) return;

    const payNum = parseFloat(paymentAmount);
    if (isNaN(payNum) || payNum <= 0) {
      alert('Enter a valid amount!');
      return;
    }

    if (payNum > selectedLayby.balance_due) {
      alert(`Cannot overpay! Maximum outstanding balance is only ${settings.currency}${selectedLayby.balance_due.toFixed(2)}.`);
      return;
    }

    const dateStr = new Date().toISOString();
    const instId = 'inst-' + Math.floor(10000 + Math.random() * 90000);

    // Record installment
    const addInstSql = `
      INSERT INTO layby_installments (id, layby_id, amount, payment_method, received_by, created_at)
      VALUES ('${instId}', '${selectedLayby.id}', ${payNum.toFixed(2)}, '${payMethod}', '${cashierName.replace(/'/g, "''")}', '${dateStr}')
    `;
    const instRes = runSql(addInstSql, `Layby: Collect partial payment +K${payNum.toFixed(2)} on invoice ${selectedLayby.id}`);

    if (instRes.success) {
      logEmployeeAudit('LAYBY', 'Recorded Layby Payment', `Layby #${selectedLayby.id}, Payment K${payNum.toFixed(2)} via ${payMethod}, Customer: ${selectedLayby.customer_name}`, payNum, selectedLayby.store_id || 'lusaka', cashierName);
      const newPaid = selectedLayby.amount_paid + payNum;
      const newDue = selectedLayby.total_amount - newPaid;
      const isCompleted = newDue <= 0.01;
      const finalStatus = isCompleted ? 'COMPLETED' : 'PENDING';

      // Update layby balance
      runSql(`
        UPDATE laybys 
        SET amount_paid = ${newPaid.toFixed(2)}, balance_due = ${newDue.toFixed(2)}, status = '${finalStatus}' 
        WHERE id = '${selectedLayby.id}'
      `, 'Layby: Update client installment statements');

      if (isCompleted) {
        const orderId = selectedLayby.id;
        const checkOrder = runSql(`SELECT id FROM orders WHERE id = '${orderId}'`);
        if (!checkOrder.success || !checkOrder.data || checkOrder.data.length === 0) {
          const storeId = selectedLayby.store_id || 'lusaka';
          runSql(`
            INSERT INTO orders (id, customerId, orderDate, subtotal, tax, discount, total, paymentMethod, status, store_id, performed_by)
            VALUES (
              '${orderId}',
              ${selectedLayby.customer_id || 'NULL'},
              '${dateStr}',
              ${Number(selectedLayby.total_amount || 0).toFixed(2)},
              0.00,
              0.00,
              ${Number(selectedLayby.total_amount || 0).toFixed(2)},
              'Layby (Paid in Full)',
              'Completed',
              '${storeId}',
              '${cashierName.replace(/'/g, "''")}'
            )
          `, `Layby Completion: Log finished sale ${orderId} into orders ledger`);

          if (selectedLayby.items_json) {
            try {
              const items = JSON.parse(selectedLayby.items_json);
              items.forEach((it: any, idx: number) => {
                runSql(`
                  INSERT INTO order_items (id, orderId, productId, quantity, unitPrice)
                  VALUES (
                    '${orderId}_item_${idx + 1}',
                    '${orderId}',
                    ${it.id || 0},
                    ${it.quantity || 1},
                    ${it.unitPrice || it.price || 0}
                  )
                `);
              });
            } catch (e) {}
          }
        } else {
          runSql(`
            UPDATE orders
            SET status = 'Completed', paymentMethod = 'Layby (Paid in Full)'
            WHERE id = '${orderId}'
          `);
        }
      }
      persistTablesToStorage();

      // Sync customer profile and loyalty points into central CRM database
      upsertCustomerSync({
        name: selectedLayby.customer_name,
        phone: selectedLayby.customer_phone,
        email: selectedLayby.customer_email,
        loyalPointsDelta: Math.floor(payNum * 0.1)
      });

      // Double-entry record for the incoming payment asset
      const txId = `tx_layby_pay_${Math.floor(100 + Math.random() * 900)}`;
      let clearingAccountId = 'cash-clearing-account-uuid';
      let channel = 'CASH';
      if (payMethod === 'MTN Mobile Money') {
        clearingAccountId = 'mtn-clearing-account-uuid';
        channel = 'MTN_MOMO';
      } else if (payMethod === 'Airtel Money') {
        clearingAccountId = 'airtel-clearing-account-uuid';
        channel = 'AIRTEL_MONEY';
      }

      runSql(`
        INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at)
        VALUES ('${txId}', 'idemp-${txId}', 'POS-LUSAKA-01', '${channel}', 'POS-LAYBY-REF-${selectedLayby.id}', ${payNum.toFixed(4)}, 0.00, 'SUCCESS', 'Layby installment client payment ${selectedLayby.id}', '${dateStr}')
      `, 'Double Entry: Record layby installment');

      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_deb', '${txId}', '${clearingAccountId}', 'DEBIT', ${payNum.toFixed(4)}, '${dateStr}')
      `, 'Double Entry: Debit asset clearing');

      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_cre_merch', '${txId}', 'merchant-wallet-account-uuid', 'CREDIT', ${payNum.toFixed(4)}, '${dateStr}')
      `, 'Double Entry: Credit customer liability settlement');

      setPaymentAmount('');
      setSuccessMsg('Payment successfully registered and journaled into Double-Entry Ledger!');
      setTimeout(() => setSuccessMsg(''), 4000);

      const newReceipt = {
        installmentId: instId,
        laybyId: selectedLayby.id,
        customerName: selectedLayby.customer_name,
        customerPhone: selectedLayby.customer_phone,
        amountPaidThisTime: payNum,
        previousBalance: selectedLayby.balance_due,
        newBalance: newDue,
        totalContractAmount: selectedLayby.total_amount,
        totalAmountPaidSoFar: newPaid,
        paymentMethod: payMethod,
        receivedBy: cashierName,
        createdAt: dateStr,
        items: parseItems(selectedLayby.items_json)
      };
      setActiveInstReceipt(newReceipt);
      setWhatsappPhone(selectedLayby.customer_phone || '');

      syncAllAccountingSystems(`Layby Installment #${instId}`);
      loadData();
      try {
        window.dispatchEvent(new Event('pos_data_updated'));
      } catch (e) {}
      persistTablesToStorage();
    }
  };

  const parseItems = (itemsJson: string) => {
    try {
      return JSON.parse(itemsJson);
    } catch {
      return [];
    }
  };

  const handlePrintLaybyReceipt = () => {
    if (!selectedLayby) return;
    
    // Play sound click and load interactive receipt popup print view
    safeSystemPrint();
  };

  return (
    <div className="flex-1 flex overflow-hidden flex-col bg-slate-50 relative">
      
      {/* Module Title Header area */}
      <div className="px-5 py-4 bg-white border-b border-slate-200 flex flex-wrap justify-between items-center gap-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
            <Coins size={20} />
          </div>
          <div>
            <h2 className="text-md font-bold text-slate-800">Layby System Dashboard</h2>
            <p className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">Client Instalment Payment Tracker</p>
          </div>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          {/* Option dropdown trigger */}
          <div className="relative">
            <button
              onClick={() => setShowSaleOptions(prev => !prev)}
              className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-lg text-xs font-bold shadow-xs cursor-pointer tracking-wider uppercase flex items-center"
            >
              <ShoppingBag size={14} className="mr-1" />
              ANOTHER SALE
            </button>

            <AnimatePresence>
              {showSaleOptions && (
                <>
                  {/* Invisible overlay backdrop click-away */}
                  <div className="absolute inset-0 z-40" onClick={() => setShowSaleOptions(false)} />
                  
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="absolute right-0 mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-xl p-2.5 z-55 flex flex-col gap-1.5 text-left"
                    style={{ position: 'absolute', top: '100%', right: 0 }}
                  >
                    <span className="text-[9px] uppercase font-extrabold text-slate-400 block px-2.5 mb-1 font-mono">Counter Utilities</span>
                    <button
                      type="button"
                      onClick={() => {
                        setShowSaleOptions(false);
                        onTriggerSalesCounterAction?.('camera');
                      }}
                      className="w-full text-left font-semibold text-xs text-slate-700 hover:bg-slate-50 p-2 rounded-lg flex items-center gap-2 cursor-pointer transition-colors"
                    >
                      <Camera size={14} className="text-emerald-500" />
                      <span>Camera Barcode Scan</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowSaleOptions(false);
                        onTriggerSalesCounterAction?.('cashup');
                      }}
                      className="w-full text-left font-semibold text-xs text-slate-700 hover:bg-slate-50 p-2 rounded-lg flex items-center gap-2 cursor-pointer transition-colors"
                    >
                      <Activity size={14} className="text-amber-500" />
                      <span>EOD Cash Up reconciler</span>
                    </button>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>

          {/* Create new layby */}
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 active:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs cursor-pointer tracking-wider"
          >
            <UserPlus size={14} />
            CREATE NEW LAYBY
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        
        {/* LEFTSIDE BAR: CLIENTS LAYBY LIST */}
        <div className={`w-full md:w-5/12 bg-white border-r border-slate-200 flex-col overflow-hidden ${
          selectedLayby ? 'hidden md:flex' : 'flex-1 md:flex flex'
        }`}>
          
          {/* Keyword search filter */}
          <div className="p-3.5 border-b border-slate-100 relative">
            <Search size={15} className="absolute left-6.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search customers name, phone or LBY#..."
              className="w-full pl-9 pr-4 py-1.5 bg-slate-100 border-none focus:bg-white focus:ring-2 focus:ring-indigo-500 rounded-lg text-xs font-semibold text-slate-700"
            />
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {filteredLaybys.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-xs font-semibold">
                No active layby statements found matching your filter keyword.
              </div>
            ) : (
              filteredLaybys.map((lay, idx) => {
                const isCompleted = lay.status === 'COMPLETED';
                const percentPaid = lay.total_amount > 0 ? Math.round((lay.amount_paid / lay.total_amount) * 100) : 0;

                return (
                  <div
                    key={`${lay.id}-${idx}`}
                    onClick={() => setSelectedLayby(lay)}
                    className={`p-4 hover:bg-slate-50 transition-all cursor-pointer relative flex flex-col gap-2 ${
                      selectedLayby?.id === lay.id ? 'bg-indigo-50/70 border-l-4 border-l-indigo-600' : ''
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <h4 className="text-xs font-bold text-slate-800">{lay.customer_name}</h4>
                        <p className="text-[10px] text-slate-400 font-mono mt-0.5">{lay.id} • {new Date(lay.created_at).toLocaleDateString()}</p>
                      </div>
                      <span className={`text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full ${
                        isCompleted 
                          ? 'bg-emerald-100 text-emerald-800' 
                          : 'bg-amber-100 text-amber-800 animate-pulse'
                      }`}>
                        {lay.status}
                      </span>
                    </div>

                    <div className="flex justify-between items-center text-[11px] font-mono mt-1">
                      <div className="text-slate-500 font-sans">
                        Paid: <strong className="text-emerald-600 font-mono">{settings.currency}{lay.amount_paid.toFixed(2)}</strong>
                      </div>
                      <div className="text-slate-500 font-sans">
                        Due: <strong className="text-rose-500 font-mono">{settings.currency}{lay.balance_due.toFixed(2)}</strong>
                      </div>
                    </div>

                    {/* Miniature ProgressBar */}
                    <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden mt-1">
                      <div 
                        className={`h-full rounded-full transition-all ${isCompleted ? 'bg-emerald-500' : 'bg-indigo-600'}`} 
                        style={{ width: `${percentPaid}%` }}
                      ></div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* RIGHTSIDE DETAIL DISPLAY PANEL */}
        <div className={`flex-1 bg-slate-50 overflow-y-auto p-3 sm:p-5 pb-16 flex-col gap-4 ${
          selectedLayby ? 'flex' : 'hidden md:flex'
        }`}>
          
          {selectedLayby ? (
            <div className="flex flex-col gap-4">
              
              {/* Back button for mobile view */}
              <div className="md:hidden flex items-center mb-1">
                <button
                  type="button"
                  onClick={() => setSelectedLayby(null)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 rounded-lg text-xs font-extrabold shadow-xs cursor-pointer"
                >
                  <ArrowRight size={14} className="rotate-180" />
                  <span>← Back to Laybys List</span>
                </button>
              </div>

              {/* Customer Profile Summary banner */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
                <div className="flex justify-between items-start flex-wrap gap-2">
                  <div>
                    <span className="text-[9px] text-indigo-600 font-bold tracking-wider uppercase bg-indigo-50 px-2 py-0.5 rounded-md">CONTRACT LEDGER RECORD</span>
                    <h3 className="text-base font-extrabold text-slate-800 mt-1">{selectedLayby.customer_name}</h3>
                    
                    <div className="flex items-center gap-4 text-xs text-slate-500 mt-2 font-semibold">
                      <div className="flex items-center gap-1">
                        <Phone size={12} className="text-slate-400" />
                        <span>{selectedLayby.customer_phone}</span>
                      </div>
                      {selectedLayby.customer_email && (
                        <div className="flex items-center gap-1">
                          <Mail size={12} className="text-slate-400" />
                          <span>{selectedLayby.customer_email}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 bg-slate-100 py-1.5 px-3 rounded-lg text-xs font-bold text-slate-700">
                    <Calendar size={13} className="text-slate-500" />
                    <span>Started: {new Date(selectedLayby.created_at).toLocaleDateString()}</span>
                  </div>
                </div>

                {/* Overall finance stats segment */}
                <div className="grid grid-cols-3 gap-3 border-t border-slate-100 mt-4 pt-4 text-center">
                  <div className="bg-slate-50 rounded-lg p-2.5">
                    <p className="text-[10px] text-slate-400 font-bold uppercase">Total Contract Value</p>
                    <p className="text-sm font-extrabold font-mono text-slate-700 mt-1">{settings.currency}{selectedLayby.total_amount.toFixed(2)}</p>
                  </div>
                  <div className="bg-emerald-50 text-emerald-800 rounded-lg p-2.5">
                    <p className="text-[10px] text-emerald-600 font-bold uppercase">Settled Payments</p>
                    <p className="text-sm font-extrabold font-mono mt-1">{settings.currency}{selectedLayby.amount_paid.toFixed(2)}</p>
                  </div>
                  <div className={`rounded-lg p-2.5 ${selectedLayby.status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800 animate-pulse'}`}>
                    <p className="text-[10px] font-bold uppercase">Outstanding Balance</p>
                    <p className="text-sm font-extrabold font-mono mt-1">{settings.currency}{selectedLayby.balance_due.toFixed(2)}</p>
                  </div>
                </div>
              </div>

              {/* Items details breakdown */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
                <h4 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <ShoppingBag size={14} className="text-slate-505" />
                  Reserved Warehouse Stock Items (Reserved On Hold)
                </h4>

                <div className="overflow-x-auto divide-y divide-slate-100">
                  {parseItems(selectedLayby.items_json).map((item: any, idx: number) => (
                    <div key={idx} className="py-2.5 flex justify-between items-center text-xs">
                      <div className="font-bold text-slate-700">
                        {item.name}
                        <span className="text-slate-400 font-medium ml-1.5">x{item.quantity}</span>
                      </div>
                      <div className="font-mono text-slate-500 text-right">
                        <div>{settings.currency}{(item.unitPrice * item.quantity).toFixed(2)}</div>
                        <div className="text-[10px] text-slate-400">({settings.currency}{item.unitPrice.toFixed(2)} ea)</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Collect installment payment ledger form */}
              {selectedLayby.status !== 'COMPLETED' ? (
                <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
                  <h4 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider mb-3">Collect Installment Payment</h4>
                  
                  {successMsg && (
                    <div className="p-3 bg-emerald-100 text-emerald-800 text-xs font-bold rounded-lg mb-3">
                      {successMsg}
                    </div>
                  )}

                  <form onSubmit={handleAddPayment} className="flex flex-wrap gap-3 items-end">
                    <div className="flex-1 min-w-[150px] flex flex-col gap-1.5">
                      <label className="text-[10px] text-slate-400 font-extrabold uppercase">Payment Amount ({settings.currency})</label>
                      <input
                        type="number"
                        step="0.01"
                        value={paymentAmount}
                        onChange={(e) => setPaymentAmount(e.target.value)}
                        placeholder={`e.g. ${selectedLayby.balance_due}`}
                        className="px-3 py-1.5 text-xs font-bold bg-slate-50 border border-slate-200 focus:bg-white rounded-lg w-full text-slate-800"
                      />
                    </div>

                    <div className="w-[140px] flex flex-col gap-1.5">
                      <label className="text-[10px] text-slate-400 font-extrabold uppercase">Option Channel</label>
                      <select
                        value={payMethod}
                        onChange={(e) => setPayMethod(e.target.value)}
                        className="px-3 py-1.5 text-xs font-bold bg-slate-50 border border-slate-200 rounded-lg w-full text-slate-800"
                      >
                        <option value="Cash">Cash Counter</option>
                        <option value="MTN Mobile Money">MTN Kwacha MoMo</option>
                        <option value="Airtel Money">Airtel Kwacha MoMo</option>
                      </select>
                    </div>

                    <button
                      type="submit"
                      className="px-4 py-2 bg-indigo-600 active:bg-indigo-700 text-white font-bold text-xs rounded-lg shadow-xs cursor-pointer tracking-wider shrink-0"
                    >
                      RECORD CONTRIBUTION
                    </button>
                  </form>
                </div>
              ) : (
                <div className="bg-emerald-100 border border-emerald-200 rounded-xl p-4 text-center text-emerald-800 font-bold text-xs">
                  ✓ CUSTOMER ACCOUNT FULLY SETTLED AND COMPLETED! RETAIL ITEMS ARE READY FOR HANDOVER.
                </div>
              )}

              {/* Installments Ledger Statement History */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
                <div className="flex justify-between items-center mb-3">
                  <h4 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                    <Receipt size={14} className="text-slate-400" />
                    Receipt Statement & Installment History
                  </h4>
                  
                  <button
                    onClick={handlePrintLaybyReceipt}
                    className="flex items-center gap-1 px-3 py-1.5 border border-slate-250 hover:bg-slate-50 rounded-lg text-xs font-bold text-slate-600 cursor-pointer"
                  >
                    <Printer size={12} />
                    Print Statement PDF
                  </button>
                </div>

                <div className="divide-y divide-slate-100 max-h-48 overflow-y-auto">
                  {installments.length === 0 ? (
                    <div className="py-4 text-center text-slate-400 text-xs">
                      No payments associated with this layby id.
                    </div>
                  ) : (
                    installments.map((inst, index) => (
                      <div key={inst.id} className="py-2.5 flex justify-between items-center text-xs">
                        <div>
                          <p className="font-bold text-slate-700">Payment Contribution #{installments.length - index}</p>
                          <p className="text-[10px] text-slate-400 font-semibold uppercase">{inst.payment_method} • Received by {inst.received_by}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="text-right">
                            <p className="font-mono font-bold text-emerald-600">+{settings.currency}{inst.amount.toFixed(2)}</p>
                            <p className="text-[10px] text-slate-400">{new Date(inst.created_at).toLocaleDateString()}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const rcpt = compileInstallmentReceipt(selectedLayby, installments, inst);
                              setActiveInstReceipt(rcpt);
                              setWhatsappPhone(rcpt.customerPhone || '');
                            }}
                            className="p-1.5 text-slate-400 hover:text-indigo-600 rounded bg-slate-50 hover:bg-indigo-50 border border-slate-100 cursor-pointer transition-all flex items-center justify-center"
                            title="Print/Share Payment Receipt with New Balance"
                          >
                            <Printer size={12} />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

            </div>
          ) : (
            <div className="flex flex-col items-center justify-center text-slate-400 h-96 gap-2">
              <Users size={32} className="stroke-1 animate-pulse" />
              <p className="text-sm font-semibold">Select a layby customer to view active installment logs.</p>
            </div>
          )}

        </div>
      </div>

      {/* CREATE NEW LAYBY CLIENT POPUP MODAL */}
      <AnimatePresence>
        {showCreateModal && (
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[85vh]"
            >
              <div className="p-4 bg-slate-900 text-white font-bold text-sm tracking-wider flex justify-between items-center shrink-0">
                <span>CREATE NEW INSTALLMENT CLIENT CONTRACT</span>
                <button onClick={() => setShowCreateModal(false)} className="hover:text-amber-400 font-extrabold cursor-pointer">✕</button>
              </div>

              <form onSubmit={handleCreateLayby} className="p-5 overflow-y-auto flex flex-col gap-4">
                
                {/* Customer input info mapping */}
                <div className="bg-slate-50 p-3 rounded-lg flex flex-col gap-3 border border-slate-200">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-indigo-600 font-extrabold uppercase tracking-wider flex items-center justify-between">
                      <span>Select Existing CRM Customer</span>
                      <span className="text-[9px] text-slate-400 font-normal">Or type custom details below</span>
                    </label>
                    <select
                      value={selectedCustId}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSelectedCustId(val);
                        if (val) {
                          const found = existingCustomers.find((c: any) => c.id === parseInt(val));
                          if (found) {
                            setClientName(found.name || '');
                            setClientPhone(found.phone || '');
                            setClientEmail(found.email || '');
                          }
                        }
                      }}
                      className="px-3 py-1.5 text-xs font-bold bg-white border border-slate-300 rounded-md focus:ring-2 focus:ring-indigo-500 text-slate-800 cursor-pointer"
                    >
                      <option value="">-- [Optional] Select Registered CRM Customer --</option>
                      {existingCustomers.map((c: any) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.phone || 'No phone'} | {c.loyalPoints || 0} pts)
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] text-slate-400 font-bold uppercase">Customer Full Name</label>
                      <input
                        type="text"
                        value={clientName}
                        onChange={(e) => setClientName(e.target.value)}
                        required
                        placeholder="e.g. Jane Mwansa"
                        className="px-3 py-1.5 text-xs font-semibold bg-white border border-slate-200 rounded-md focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] text-slate-400 font-bold uppercase">Customer Mobile Phone</label>
                      <input
                        type="tel"
                        value={clientPhone}
                        onChange={(e) => setClientPhone(e.target.value)}
                        required
                        placeholder="+260 977 XX XX XX"
                        className="px-3 py-1.5 text-xs font-semibold bg-white border border-slate-200 rounded-md focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div className="col-span-1 sm:col-span-2 flex flex-col gap-1">
                      <label className="text-[10px] text-slate-400 font-bold uppercase">Customer Email (Optional)</label>
                      <input
                        type="email"
                        value={clientEmail}
                        onChange={(e) => setClientEmail(e.target.value)}
                        placeholder="client@mail.zm"
                        className="px-3 py-1.5 text-xs font-semibold bg-white border border-slate-200 rounded-md focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>
                </div>

                {/* Warehouse Product Search & Selector */}
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between items-center">
                    <h4 className="text-xs font-extrabold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                      <ShoppingBag size={14} className="text-indigo-600" />
                      <span>Select Reserve Items</span>
                    </h4>
                    <span className="text-[10px] text-slate-400 font-semibold font-mono">
                      {filteredProductsToSelect.length} product(s) available
                    </span>
                  </div>

                  {/* Search Bar Input */}
                  <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      value={itemSearchQuery}
                      onChange={(e) => setItemSearchQuery(e.target.value)}
                      placeholder="Search items by name, SKU, or category..."
                      className="w-full pl-8 pr-8 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:bg-white font-medium"
                    />
                    {itemSearchQuery && (
                      <button
                        type="button"
                        onClick={() => setItemSearchQuery('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs font-bold"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {/* Filtered Product Selector Grid */}
                  <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-lg bg-slate-50 p-1.5 flex flex-wrap gap-1.5">
                    {filteredProductsToSelect.length === 0 ? (
                      <div className="w-full text-center py-4 text-xs text-slate-400 font-medium">
                        No matching warehouse items found for "{itemSearchQuery}"
                      </div>
                    ) : (
                      filteredProductsToSelect.map(p => {
                        const selectedQty = selectedItems.find(x => x.id === p.id)?.quantity || 0;
                        const isSelected = selectedQty > 0;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => handleSelectItem(p)}
                            className={`px-2.5 py-1.5 text-[11px] font-bold border rounded-lg transition-all text-left flex items-center gap-2 cursor-pointer shadow-3xs ${
                              isSelected
                                ? 'bg-indigo-50 border-indigo-300 text-indigo-700 ring-1 ring-indigo-400'
                                : 'bg-white hover:bg-slate-100 border-slate-200 text-slate-800'
                            }`}
                          >
                            <div className="flex flex-col">
                              <span className="font-bold truncate max-w-[150px]">{p.name}</span>
                              <span className="text-[9px] text-slate-400 font-mono">{p.sku} • Stock: {p.stock}</span>
                            </div>
                            <span className="ml-auto font-mono text-emerald-600 font-extrabold">{settings.currency}{p.price.toFixed(2)}</span>
                            {selectedQty > 0 && (
                              <span className="bg-indigo-600 text-white text-[9px] font-black px-1.5 py-0.5 rounded-full">
                                x{selectedQty}
                              </span>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Selected checkout cart list */}
                {selectedItems.length > 0 && (
                  <div className="border border-slate-200 rounded-lg p-2.5 bg-slate-50/80 flex flex-col gap-1.5 max-h-36 overflow-y-auto">
                    <span className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wider">
                      Selected Items in Contract ({selectedItems.length})
                    </span>
                    {selectedItems.map((sat) => (
                      <div key={sat.id} className="flex justify-between items-center text-xs text-slate-700 bg-white p-1.5 rounded-md border border-slate-150">
                        <div className="flex flex-col">
                          <span className="font-bold text-slate-800">{sat.name}</span>
                          <span className="text-[9.5px] font-mono text-slate-400">{settings.currency}{sat.price.toFixed(2)} each</span>
                        </div>
                        <div className="flex items-center gap-3">
                          {/* Quantity adjustments */}
                          <div className="flex items-center gap-1 bg-slate-100 rounded border border-slate-200 px-1 py-0.5">
                            <button
                              type="button"
                              onClick={() => handleUpdateItemQuantity(sat.id, -1)}
                              className="w-4 h-4 text-xs font-black text-slate-600 hover:text-indigo-600 flex items-center justify-center cursor-pointer"
                            >
                              -
                            </button>
                            <span className="font-mono text-xs font-extrabold px-1 text-slate-800">{sat.quantity}</span>
                            <button
                              type="button"
                              onClick={() => handleUpdateItemQuantity(sat.id, 1)}
                              className="w-4 h-4 text-xs font-black text-slate-600 hover:text-indigo-600 flex items-center justify-center cursor-pointer"
                            >
                              +
                            </button>
                          </div>

                          <span className="font-mono font-bold text-slate-900 w-16 text-right">
                            {settings.currency}{(sat.price * sat.quantity).toFixed(2)}
                          </span>

                          <button
                            type="button"
                            onClick={() => handleRemoveSelectItem(sat.id)}
                            className="text-rose-500 hover:text-rose-700 font-bold text-[11px] px-1 cursor-pointer"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Totals & Downpayment amount input */}
                <div className="bg-slate-900 text-white p-3.5 rounded-lg flex flex-col sm:flex-row justify-between items-center gap-3">
                  <div className="text-center sm:text-left">
                    <p className="text-[10px] text-slate-400 font-mono uppercase font-semibold">Total Contract Value</p>
                    <p className="text-lg font-mono font-extrabold text-emerald-400">{settings.currency}{calculateGrandTotal().toFixed(2)}</p>
                  </div>

                  <div className="flex flex-col gap-1 w-full sm:w-[180px]">
                    <label className="text-[9px] text-slate-350 font-sans uppercase">Security Downpayment ({settings.currency})</label>
                    <input
                      type="number"
                      value={customDeposit}
                      onChange={(e) => setCustomDeposit(e.target.value)}
                      placeholder={`Min: ${(calculateGrandTotal() * 0.2).toFixed(2)}`}
                      className="px-2 py-1 text-xs bg-slate-800 text-white rounded-md border border-slate-700 font-bold focus:outline-hidden text-center"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-3 shrink-0 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="px-4 py-2 bg-slate-105 rounded-lg text-xs font-bold text-slate-600 hover:bg-slate-200 cursor-pointer"
                  >
                    CANCEL
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold shadow-xs cursor-pointer tracking-wider"
                  >
                     PROVISION CONTRACT
                  </button>
                </div>

              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* INSTALMENT RECEIPT CONFIRMATION MODAL */}
      <AnimatePresence>
        {activeInstReceipt && (
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-sm overflow-hidden flex flex-col"
            >
              <div className="p-3.5 bg-emerald-600 text-white font-bold text-xs tracking-wider flex justify-between items-center shrink-0 uppercase font-sans">
                <span className="flex items-center gap-1.5">
                  <CheckCircle size={14} />
                  Installment Recorded Successfully
                </span>
                <button 
                  onClick={() => setActiveInstReceipt(null)} 
                  className="hover:text-amber-300 hover:bg-emerald-700/50 px-2 py-1 rounded font-extrabold cursor-pointer transition-colors"
                >
                  ✕
                </button>
              </div>

              <div className="p-4 flex flex-col gap-3 text-left overflow-y-auto max-h-[75vh]">
                <div className="text-center pb-2 border-b border-dashed border-slate-200">
                  <p className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wider">Installment Contribution Receipt</p>
                  <p className="text-[10px] font-mono text-slate-500 mt-0.5 font-bold">{activeInstReceipt.installmentId}</p>
                </div>

                {/* Simulated Paper Invoice Ticket */}
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 flex flex-col gap-2.5 font-sans shadow-sm">
                  <div className="text-center border-b border-slate-200 pb-1.5 flex flex-col items-center gap-0.5">
                    {settings.logoUrl && (
                      <img src={settings.logoUrl} alt="Store logo" className="max-h-10 object-contain mb-1" referrerPolicy="no-referrer" />
                    )}
                    <h5 className="font-extrabold text-[12px] text-slate-800 uppercase tracking-tight">{settings.storeName}</h5>
                    {settings.tpin && (
                      <span className="text-[8px] font-bold text-slate-500 font-mono tracking-wider">TPIN: {settings.tpin}</span>
                    )}
                    <p className="text-[9px] text-slate-500 mt-0.5">{settings.receiptHeader || 'Retail POS Counter Services'}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] text-slate-600 border-b border-slate-100 pb-2">
                    <div>
                      <span className="text-[8px] text-slate-450 font-semibold block uppercase">Contract ID</span>
                      <strong className="text-slate-700 font-mono">{activeInstReceipt.laybyId}</strong>
                    </div>
                    <div className="text-right">
                      <span className="text-[8px] text-slate-450 font-semibold block uppercase">Date Time</span>
                      <strong className="text-slate-700 font-mono">{new Date(activeInstReceipt.createdAt).toLocaleString()}</strong>
                    </div>
                    <div>
                      <span className="text-[8px] text-slate-450 font-semibold block uppercase">Client Profile</span>
                      <strong className="text-indigo-650">{activeInstReceipt.customerName}</strong>
                    </div>
                    <div className="text-right">
                      <span className="text-[8px] text-slate-450 font-semibold block uppercase">Contact Line</span>
                      <strong className="text-slate-700 font-mono">{activeInstReceipt.customerPhone}</strong>
                    </div>
                  </div>

                  {/* Reserved items lists */}
                  <div>
                    <span className="text-[8px] text-slate-400 font-black block uppercase mb-1">Contract Reserved Items</span>
                    <div className="flex flex-col gap-1 max-h-24 overflow-y-auto divide-y divide-slate-100">
                      {activeInstReceipt.items.map((it: any, i: number) => (
                        <div key={i} className="flex justify-between items-center text-[10px] pt-1 text-slate-650">
                          <span>{it.name} x{it.quantity}</span>
                          <span className="font-mono text-slate-500">{settings.currency}{(it.unitPrice * it.quantity).toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Financial calculations & the BRAND NEW BALANCE */}
                  <div className="border-t border-slate-200 pt-2 flex flex-col gap-1 text-[11px]">
                    <div className="flex justify-between items-center text-[10px] text-slate-550">
                      <span>Total Contract Value:</span>
                      <span className="font-mono font-bold text-slate-700">{settings.currency}{activeInstReceipt.totalContractAmount.toFixed(2)}</span>
                    </div>

                    <div className="flex justify-between items-center bg-emerald-50 text-emerald-800 px-2 py-1 rounded-lg border border-dashed border-emerald-250 my-1">
                      <span className="text-[10px] font-black uppercase">Installment Paid:</span>
                      <strong className="font-mono text-[12px] font-black text-emerald-700">+{settings.currency}{activeInstReceipt.amountPaidThisTime.toFixed(2)}</strong>
                    </div>

                    <div className="flex justify-between items-center text-[10px] text-slate-550">
                      <span>Cumulative Settled So Far:</span>
                      <span className="font-mono font-semibold text-slate-700">{settings.currency}{activeInstReceipt.totalAmountPaidSoFar.toFixed(2)}</span>
                    </div>

                    <div className="flex justify-between items-center text-[10px] text-slate-550 border-b border-slate-100 pb-0.5">
                      <span>Previous Outstanding Balance:</span>
                      <span className="font-mono font-semibold text-slate-505">{settings.currency}{activeInstReceipt.previousBalance.toFixed(2)}</span>
                    </div>

                    <div className={`flex justify-between items-center px-2 py-1.5 rounded-lg mt-1 ${activeInstReceipt.newBalance <= 0.01 ? 'bg-emerald-100 text-emerald-900 border border-emerald-300' : 'bg-red-50 text-rose-950 border border-rose-150'}`}>
                      <span className="text-[10px] font-extrabold uppercase">NEW OUTSTANDING BALANCE:</span>
                      <strong className="font-mono text-[13px] font-black text-rose-700">
                        {activeInstReceipt.newBalance <= 0.01 ? '✓ FULLY SETTLED' : `${settings.currency}${activeInstReceipt.newBalance.toFixed(2)}`}
                      </strong>
                    </div>
                  </div>

                  {settings.termsAndConditions && (
                    <div className="border-t border-dashed border-slate-200 pt-2 pb-1 text-[8px] font-sans text-slate-500 leading-normal">
                      <span className="font-extrabold uppercase text-slate-600 block mb-0.5">Terms & Conditions</span>
                      <p className="whitespace-pre-line font-mono">{settings.termsAndConditions}</p>
                    </div>
                  )}

                  <div className="text-[8px] text-slate-400 font-medium text-center mt-0.5 border-t border-slate-150 pt-1.5 font-mono">
                    Channel: {activeInstReceipt.paymentMethod} | Served By: {activeInstReceipt.receivedBy}
                  </div>
                </div>

                {/* WhatsApp Share Form */}
                <div className="bg-indigo-50 border border-indigo-150 rounded-xl p-2.5 flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5 select-none text-[9px] text-indigo-800 font-extrabold uppercase">
                    <span>📱 Share Dispatch Receipt via WhatsApp</span>
                  </div>
                  
                  <div className="flex gap-2">
                    <input
                      type="tel"
                      value={whatsappPhone}
                      onChange={(e) => setWhatsappPhone(e.target.value)}
                      placeholder="e.g. 260977XXXXXX"
                      className="flex-1 bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-800 font-semibold focus:outline-indigo-500 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => handleWhatsAppSend(whatsappPhone, activeInstReceipt)}
                      className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[10px] font-black cursor-pointer transition-colors shadow-3xs uppercase"
                    >
                      Send WhatsApp
                    </button>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => generateInstPdfReceipt(activeInstReceipt)}
                    className="flex items-center justify-center gap-1 py-1.5 px-2 border border-slate-250 hover:bg-slate-50 text-slate-700 rounded-lg text-[10px] font-black cursor-pointer transition-all uppercase"
                  >
                    <Printer size={11} className="text-slate-500" />
                    Download PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveInstReceipt(null)}
                    className="py-1.5 px-2 bg-slate-900 hover:bg-slate-850 text-white rounded-lg text-[10px] font-black tracking-wider text-center cursor-pointer shadow-3xs transition-all uppercase"
                  >
                    Close Receipt
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
