import { db } from './index.ts';
import {
  businesses,
  stores,
  products,
  customers,
  orders,
  orderItems,
  auditLogs,
  cashUps,
  doubleEntryJournal,
  receiptRefundLedger,
  cashFlowLedger,
  paymentMethodLedger,
  financialStatementsLedger,
  posSyncSnapshots,
} from './schema.ts';
import { eq, desc } from 'drizzle-orm';

export interface SyncPushPayload {
  businessId: string;
  businessName?: string;
  ownerEmail?: string;
  tables: Record<string, any[]>;
  settings?: Record<string, any> | null;
}

export async function pushPosSyncToCloudSql(payload: SyncPushPayload) {
  const nowIso = new Date().toISOString();
  const bizId = (payload.businessId || '__global__').trim();
  const tables = payload.tables || {};
  const tablesJsonStr = JSON.stringify(tables);
  const settingsJsonStr = payload.settings ? JSON.stringify(payload.settings) : null;

  const bizRows = Array.isArray(tables.businesses) ? tables.businesses : [];
  const matchingBiz = bizRows.find((b: any) => b.id === bizId) || bizRows[0];
  const bizName = payload.businessName || matchingBiz?.name || 'Synced Business';
  const ownerEmail = (payload.ownerEmail || matchingBiz?.email || '').toLowerCase().trim();

  // 1. Upsert primary business snapshot
  await db
    .insert(posSyncSnapshots)
    .values({
      businessId: bizId,
      businessName: bizName,
      ownerEmail,
      tablesJson: tablesJsonStr,
      settingsJson: settingsJsonStr,
      updatedAt: nowIso,
    })
    .onConflictDoUpdate({
      target: posSyncSnapshots.businessId,
      set: {
        businessName: bizName,
        ownerEmail,
        tablesJson: tablesJsonStr,
        settingsJson: settingsJsonStr,
        updatedAt: nowIso,
      },
    });

  // Also keep a '__latest__' pointer snapshot for instant device discovery
  if (bizId !== '__latest__') {
    await db
      .insert(posSyncSnapshots)
      .values({
        businessId: '__latest__',
        businessName: bizName,
        ownerEmail,
        tablesJson: tablesJsonStr,
        settingsJson: settingsJsonStr,
        updatedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: posSyncSnapshots.businessId,
        set: {
          businessName: bizName,
          ownerEmail,
          tablesJson: tablesJsonStr,
          settingsJson: settingsJsonStr,
          updatedAt: nowIso,
        },
      });
  }

  // 2. Synchronize relational tables in Cloud SQL
  try {
    // Businesses
    for (const b of bizRows) {
      if (!b || !b.id) continue;
      await db
        .insert(businesses)
        .values({
          id: String(b.id),
          name: String(b.name || 'Business'),
          owner: String(b.owner || ''),
          email: String(b.email || ''),
          password: String(b.password || ''),
        })
        .onConflictDoUpdate({
          target: businesses.id,
          set: {
            name: String(b.name || 'Business'),
            owner: String(b.owner || ''),
            email: String(b.email || ''),
            password: String(b.password || ''),
          },
        });
    }

    // Stores
    const storeRows = Array.isArray(tables.stores) ? tables.stores : [];
    for (const s of storeRows) {
      if (!s || !s.id) continue;
      await db
        .insert(stores)
        .values({
          id: String(s.id),
          businessId: String(s.business_id || bizId),
          name: String(s.name || s.id),
          location: String(s.location || ''),
          allowDiscounts: Number(s.allow_discounts ?? 1),
          allowRefunds: Number(s.allow_refunds ?? 1),
          allowLaybys: Number(s.allow_laybys ?? 1),
          requireManagerDiscount: Number(s.require_manager_discount ?? 0),
          stocktakeFrequency: String(s.stocktake_frequency || 'weekly'),
        })
        .onConflictDoUpdate({
          target: stores.id,
          set: {
            businessId: String(s.business_id || bizId),
            name: String(s.name || s.id),
            location: String(s.location || ''),
            allowDiscounts: Number(s.allow_discounts ?? 1),
            allowRefunds: Number(s.allow_refunds ?? 1),
            allowLaybys: Number(s.allow_laybys ?? 1),
            requireManagerDiscount: Number(s.require_manager_discount ?? 0),
            stocktakeFrequency: String(s.stocktake_frequency || 'weekly'),
          },
        });
    }

    // Products (with stock, batch_number, expiry_date)
    const prodRows = Array.isArray(tables.products) ? tables.products : [];
    for (const p of prodRows) {
      if (!p || p.id === undefined) continue;
      const skuVal = String(p.sku || `SKU-${p.id}`);
      await db
        .insert(products)
        .values({
          id: Number(p.id),
          name: String(p.name || 'Product'),
          sku: skuVal,
          category: String(p.category || 'General'),
          price: String(Number(p.price || 0).toFixed(2)),
          cost: String(Number(p.cost || 0).toFixed(2)),
          stock: Number(p.stock || 0),
          imageUrl: String(p.imageUrl || ''),
          businessId: String(p.business_id || bizId),
          isService: Number(p.is_service || 0),
          batchNumber: String(p.batch_number || ''),
          expiryDate: String(p.expiry_date || ''),
        })
        .onConflictDoUpdate({
          target: products.id,
          set: {
            name: String(p.name || 'Product'),
            sku: skuVal,
            category: String(p.category || 'General'),
            price: String(Number(p.price || 0).toFixed(2)),
            cost: String(Number(p.cost || 0).toFixed(2)),
            stock: Number(p.stock || 0),
            imageUrl: String(p.imageUrl || ''),
            businessId: String(p.business_id || bizId),
            isService: Number(p.is_service || 0),
            batchNumber: String(p.batch_number || ''),
            expiryDate: String(p.expiry_date || ''),
          },
        });
    }

    // Customers
    const custRows = Array.isArray(tables.customers) ? tables.customers : [];
    for (const c of custRows) {
      if (!c || c.id === undefined) continue;
      await db
        .insert(customers)
        .values({
          id: Number(c.id),
          name: String(c.name || 'Customer'),
          phone: String(c.phone || ''),
          email: String(c.email || ''),
          loyalPoints: Number(c.loyalPoints || 0),
          tpin: String(c.tpin || ''),
          zraConnected: Number(c.zra_connected || 0),
          taxBand: String(c.tax_band || 'A - Standard Rate (16%)'),
          businessId: String(c.business_id || bizId),
        })
        .onConflictDoUpdate({
          target: customers.id,
          set: {
            name: String(c.name || 'Customer'),
            phone: String(c.phone || ''),
            email: String(c.email || ''),
            loyalPoints: Number(c.loyalPoints || 0),
            tpin: String(c.tpin || ''),
            zraConnected: Number(c.zra_connected || 0),
            taxBand: String(c.tax_band || 'A - Standard Rate (16%)'),
            businessId: String(c.business_id || bizId),
          },
        });
    }

    // Orders
    const orderRows = Array.isArray(tables.orders) ? tables.orders : [];
    for (const o of orderRows) {
      if (!o || !o.id) continue;
      await db
        .insert(orders)
        .values({
          id: String(o.id),
          customerId: o.customerId ? Number(o.customerId) : null,
          orderDate: String(o.orderDate || nowIso),
          subtotal: String(Number(o.subtotal || 0).toFixed(2)),
          tax: String(Number(o.tax || 0).toFixed(2)),
          discount: String(Number(o.discount || 0).toFixed(2)),
          total: String(Number(o.total || 0).toFixed(2)),
          paymentMethod: String(o.paymentMethod || 'Cash'),
          status: String(o.status || 'Completed'),
          storeId: String(o.store_id || ''),
          performedBy: String(o.performed_by || 'owner'),
        })
        .onConflictDoUpdate({
          target: orders.id,
          set: {
            status: String(o.status || 'Completed'),
            total: String(Number(o.total || 0).toFixed(2)),
            paymentMethod: String(o.paymentMethod || 'Cash'),
          },
        });
    }

    // Order Items
    const itemRows = Array.isArray(tables.order_items) ? tables.order_items : [];
    for (const oi of itemRows) {
      if (!oi || !oi.id) continue;
      await db
        .insert(orderItems)
        .values({
          id: String(oi.id),
          orderId: String(oi.orderId || ''),
          productId: Number(oi.productId || 0),
          quantity: Number(oi.quantity || 1),
          unitPrice: String(Number(oi.unitPrice || 0).toFixed(2)),
        })
        .onConflictDoNothing();
    }

    // Double-entry Journal
    const journalRows = Array.isArray(tables.double_entry_journal) ? tables.double_entry_journal : [];
    for (const j of journalRows) {
      if (!j || !j.id) continue;
      await db
        .insert(doubleEntryJournal)
        .values({
          id: String(j.id),
          entryDate: String(j.date || nowIso),
          referenceId: String(j.reference || ''),
          module: 'POS_LEDGER',
          description: String(j.description || ''),
          debitAccount: String(j.account_debit || ''),
          creditAccount: String(j.account_credit || ''),
          amount: String(Number(j.amount || 0).toFixed(2)),
          storeId: 'all',
          performedBy: 'system',
        })
        .onConflictDoUpdate({
          target: doubleEntryJournal.id,
          set: {
            amount: String(Number(j.amount || 0).toFixed(2)),
            description: String(j.description || ''),
          },
        });
    }

    // Receipt & Refund Ledger
    const rrRows = Array.isArray(tables.receipt_refund_ledger) ? tables.receipt_refund_ledger : [];
    for (const r of rrRows) {
      if (!r || !r.id) continue;
      await db
        .insert(receiptRefundLedger)
        .values({
          id: String(r.id),
          entryDate: String(r.date || nowIso),
          txType: String(r.entry_type || 'RECEIPT'),
          referenceId: String(r.order_id || ''),
          customerName: String(r.customer_name || 'Walk-In Customer'),
          paymentMethod: String(r.payment_method || 'Cash'),
          grossAmount: String(Number(r.total_amount || 0).toFixed(2)),
          taxAmount: String(Number(r.tax || 0).toFixed(2)),
          discountAmount: String(Number(r.discount || 0).toFixed(2)),
          netRevenue: String(Number(r.net_revenue_impact || 0).toFixed(2)),
          cogsAmount: String(Number(r.cogs_amount || 0).toFixed(2)),
          storeId: String(r.store_id || ''),
          performedBy: String(r.performed_by || ''),
          status: String(r.status || 'Posted'),
          notes: String(r.journal_ref || ''),
        })
        .onConflictDoUpdate({
          target: receiptRefundLedger.id,
          set: {
            status: String(r.status || 'Posted'),
            grossAmount: String(Number(r.total_amount || 0).toFixed(2)),
          },
        });
    }

    // Cash Flow Ledger
    const cfRows = Array.isArray(tables.cash_flow_ledger) ? tables.cash_flow_ledger : [];
    for (const cf of cfRows) {
      if (!cf || !cf.id) continue;
      const netVal = Number(cf.net_cash_change || 0);
      await db
        .insert(cashFlowLedger)
        .values({
          id: String(cf.id),
          entryDate: String(cf.date || nowIso),
          activityCategory: String(cf.activity_type || 'OPERATING'),
          direction: String(cf.direction || 'INFLOW'),
          paymentMethod: String(cf.payment_method || 'Cash'),
          referenceId: String(cf.reference_id || ''),
          description: String(cf.description || ''),
          amount: String(Math.abs(netVal).toFixed(2)),
          signedAmount: String(netVal.toFixed(2)),
          storeId: String(cf.store_id || ''),
          performedBy: String(cf.performed_by || ''),
        })
        .onConflictDoUpdate({
          target: cashFlowLedger.id,
          set: {
            signedAmount: String(netVal.toFixed(2)),
            amount: String(Math.abs(netVal).toFixed(2)),
          },
        });
    }

    // Payment Method Ledger
    const pmRows = Array.isArray(tables.payment_method_ledger) ? tables.payment_method_ledger : [];
    for (const pm of pmRows) {
      if (!pm || !pm.id) continue;
      await db
        .insert(paymentMethodLedger)
        .values({
          methodKey: String(pm.id),
          methodLabel: `${pm.payment_method} (${pm.store_id})`,
          accountCode: String(pm.account_id || 'acc_cash'),
          grossInflows: String(Number((pm.gross_receipts || 0) + (pm.layby_receipts || 0)).toFixed(2)),
          refundOutflows: String(Number(pm.refunds_out || 0).toFixed(2)),
          expenseOutflows: String(Number(pm.expenses_out || 0).toFixed(2)),
          netBalance: String(Number(pm.net_balance || 0).toFixed(2)),
          txCount: Number(pm.transaction_count || 0),
          updatedAt: nowIso,
        })
        .onConflictDoUpdate({
          target: paymentMethodLedger.methodKey,
          set: {
            grossInflows: String(Number((pm.gross_receipts || 0) + (pm.layby_receipts || 0)).toFixed(2)),
            refundOutflows: String(Number(pm.refunds_out || 0).toFixed(2)),
            expenseOutflows: String(Number(pm.expenses_out || 0).toFixed(2)),
            netBalance: String(Number(pm.net_balance || 0).toFixed(2)),
            txCount: Number(pm.transaction_count || 0),
            updatedAt: nowIso,
          },
        });
    }

    // EOD Cash Ups
    const cuRows = Array.isArray(tables.cash_ups) ? tables.cash_ups : [];
    for (const cu of cuRows) {
      if (!cu || !cu.id) continue;
      await db
        .insert(cashUps)
        .values({
          id: String(cu.id),
          storeId: String(cu.store_id || ''),
          date: String(cu.date || nowIso.split('T')[0]),
          expectedCash: String(Number(cu.sum_cash_expected || 0).toFixed(2)),
          actualCash: String(Number(cu.sum_cash_actual || 0).toFixed(2)),
          variance: String(Number(cu.variance || 0).toFixed(2)),
          expectedCard: String(Number(cu.sum_card_expected || 0).toFixed(2)),
          expectedMobile: String(Number(cu.sum_momo_expected || 0).toFixed(2)),
          status: 'SYNCED',
          performedBy: String(cu.cashier_name || ''),
          notes: String(cu.notes || ''),
          createdAt: String(cu.created_at || nowIso),
        })
        .onConflictDoUpdate({
          target: cashUps.id,
          set: {
            expectedCash: String(Number(cu.sum_cash_expected || 0).toFixed(2)),
            actualCash: String(Number(cu.sum_cash_actual || 0).toFixed(2)),
            variance: String(Number(cu.variance || 0).toFixed(2)),
            expectedCard: String(Number(cu.sum_card_expected || 0).toFixed(2)),
            expectedMobile: String(Number(cu.sum_momo_expected || 0).toFixed(2)),
            notes: String(cu.notes || ''),
          },
        });
    }

    // Financial Statements Snapshot
    const fsRows = Array.isArray(tables.financial_statements_ledger) ? tables.financial_statements_ledger : [];
    for (const fs of fsRows) {
      if (!fs || !fs.id) continue;
      await db
        .insert(financialStatementsLedger)
        .values({
          statementKey: String(fs.id),
          statementType: 'FULL_STATEMENT_SNAPSHOT',
          section: String(fs.store_id || 'all'),
          lineItem: `Net Income: ${fs.net_operating_income || 0} | Total Assets: ${fs.total_assets || 0} | Net Cash Flow: ${fs.net_cash_flow || 0}`,
          amount: String(Number(fs.net_operating_income || 0).toFixed(2)),
          storeId: String(fs.store_id || 'all'),
          updatedAt: nowIso,
        })
        .onConflictDoUpdate({
          target: financialStatementsLedger.statementKey,
          set: {
            lineItem: `Net Income: ${fs.net_operating_income || 0} | Total Assets: ${fs.total_assets || 0} | Net Cash Flow: ${fs.net_cash_flow || 0}`,
            amount: String(Number(fs.net_operating_income || 0).toFixed(2)),
            updatedAt: nowIso,
          },
        });
    }

    // Audit Logs
    const alRows = Array.isArray(tables.audit_logs) ? tables.audit_logs.slice(0, 100) : [];
    for (const al of alRows) {
      if (!al || !al.id) continue;
      await db
        .insert(auditLogs)
        .values({
          id: String(al.id),
          module: String(al.module || 'SYSTEM'),
          action: String(al.action || ''),
          details: String(al.details || ''),
          amount: String(Number(al.amount || 0).toFixed(2)),
          storeId: String(al.store_id || ''),
          performedBy: String(al.performed_by || ''),
          createdAt: String(al.created_at || nowIso),
        })
        .onConflictDoNothing();
    }
  } catch (relErr) {
    console.warn('[CloudSQL Sync] Relational table mirror warning:', relErr);
  }

  return {
    success: true,
    businessId: bizId,
    businessName: bizName,
    updatedAt: nowIso,
  };
}

export async function pullPosSyncFromCloudSql(businessId?: string, email?: string) {
  const allSnapshots = await db
    .select()
    .from(posSyncSnapshots)
    .orderBy(desc(posSyncSnapshots.updatedAt));

  const availableBusinesses = allSnapshots
    .filter((s) => s.businessId !== '__latest__' && s.businessId !== '__global__')
    .map((s) => ({
      businessId: s.businessId,
      businessName: s.businessName || s.businessId,
      ownerEmail: s.ownerEmail || '',
      updatedAt: s.updatedAt,
    }));

  let targetSnap = null;
  if (businessId && businessId.trim()) {
    targetSnap = allSnapshots.find((s) => s.businessId === businessId.trim());
  }
  if (!targetSnap && email && email.trim()) {
    const cleanEmail = email.trim().toLowerCase();
    targetSnap = allSnapshots.find(
      (s) => s.businessId !== '__latest__' && (s.ownerEmail || '').toLowerCase() === cleanEmail
    );
  }
  if (!targetSnap) {
    targetSnap =
      allSnapshots.find((s) => s.businessId !== '__latest__' && s.businessId !== '__global__') ||
      allSnapshots.find((s) => s.businessId === '__latest__') ||
      allSnapshots[0] ||
      null;
  }

  if (!targetSnap) {
    return {
      found: false,
      availableBusinesses: [],
    };
  }

  let parsedTables: Record<string, any[]> = {};
  let parsedSettings: Record<string, any> | null = null;
  try {
    parsedTables = JSON.parse(targetSnap.tablesJson);
  } catch {
    parsedTables = {};
  }
  try {
    parsedSettings = targetSnap.settingsJson ? JSON.parse(targetSnap.settingsJson) : null;
  } catch {
    parsedSettings = null;
  }

  return {
    found: true,
    businessId: targetSnap.businessId,
    businessName: targetSnap.businessName,
    ownerEmail: targetSnap.ownerEmail,
    tables: parsedTables,
    settings: parsedSettings,
    updatedAt: targetSnap.updatedAt,
    availableBusinesses,
  };
}
