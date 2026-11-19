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
import { desc, sql } from 'drizzle-orm';

export interface SyncPushPayload {
  businessId: string;
  businessName?: string;
  ownerEmail?: string;
  tables: Record<string, any[]>;
  settings?: Record<string, any> | null;
}

function dedupeByKey<T>(rows: T[], getKey: (row: T) => string | number | null | undefined): T[] {
  const map = new Map<string, T>();
  for (const row of rows) {
    const k = getKey(row);
    if (k === null || k === undefined || k === '') continue;
    map.set(String(k), row);
  }
  return Array.from(map.values());
}

function scrubCloudSnapshotTables(rawTables: Record<string, any[]>): Record<string, any[]> {
  const t: Record<string, any[]> = { ...(rawTables || {}) };
  const legacyStores = new Set(['lusaka', 'kitwe', 'ndola', 'store_main']);
  const legacyLaybys = new Set(['layby-1004', 'LBY-8082']);
  const legacyInsts = new Set(['inst-001', 'inst-002', 'inst-54859']);
  const legacyOrders = new Set(['TXN-8801', 'TXN-8802', 'TXN-8803', 'TXN-8798', 'TXN-8799', 'TXN-8800', 'TXN-8795', 'TXN-8796', 'TXN-8797']);
  const legacyLoans = new Set(['LOAN-001', 'LOAN-002']);

  if (Array.isArray(t.businesses)) {
    t.businesses = t.businesses.filter((b: any) => b?.id !== 'default_biz' && b?.email !== 'owner@pos.zm');
  }
  if (Array.isArray(t.stores)) {
    t.stores = t.stores.filter((s: any) => s?.business_id !== 'default_biz' && !legacyStores.has(String(s?.id || '').toLowerCase()));
  }
  if (Array.isArray(t.store_products)) {
    t.store_products = t.store_products.filter((sp: any) => !legacyStores.has(String(sp?.store_id || '').toLowerCase()));
  }
  if (Array.isArray(t.orders)) {
    t.orders = t.orders.filter((o: any) => !legacyOrders.has(String(o?.id || '')));
  }
  if (Array.isArray(t.order_items)) {
    t.order_items = t.order_items.filter((oi: any) => !legacyOrders.has(String(oi?.orderId || '')));
  }
  if (Array.isArray(t.laybys)) {
    t.laybys = t.laybys.filter((l: any) => !legacyLaybys.has(String(l?.id || '')));
  }
  if (Array.isArray(t.layby_installments)) {
    t.layby_installments = t.layby_installments.filter((i: any) => !legacyLaybys.has(String(i?.layby_id || '')) && !legacyInsts.has(String(i?.id || '')));
  }
  if (Array.isArray(t.loans)) {
    t.loans = t.loans.filter((l: any) => !legacyLoans.has(String(l?.id || '')) && String(l?.merchant_id || '') !== 'default_biz');
  }
  if (Array.isArray(t.loan_amortization_schedule)) {
    t.loan_amortization_schedule = t.loan_amortization_schedule.filter((a: any) => !legacyLoans.has(String(a?.loan_id || '')) && !String(a?.id || '').startsWith('AMORT-1-'));
  }
  if (Array.isArray(t.automated_deduction_logs)) {
    t.automated_deduction_logs = t.automated_deduction_logs.filter((d: any) => !legacyLoans.has(String(d?.loan_id || '')) && !['DED-001', 'DED-002'].includes(String(d?.id || '')));
  }
  if (Array.isArray(t.quotations)) {
    t.quotations = t.quotations.filter((q: any) => String(q?.id || '') !== 'QT-1025');
  }
  if (Array.isArray(t.double_entry_journal)) {
    t.double_entry_journal = t.double_entry_journal.filter((j: any) =>
      !legacyLaybys.has(String(j?.reference || '')) &&
      !legacyOrders.has(String(j?.reference || '')) &&
      String(j?.reference || '') !== 'OPEN-INV-01' &&
      String(j?.id || '') !== 'JRN_LBY_INST_inst-54859' &&
      String(j?.id || '') !== 'JRN_OPENING_INVENTORY_CAPITAL'
    );
  }
  if (Array.isArray(t.ledger_entries)) {
    t.ledger_entries = t.ledger_entries.filter((le: any) =>
      !['le-1', 'le-2', 'le-3', 'le-4', 'le-5', 'le-6'].includes(String(le?.id || '')) &&
      !['tx-999', 'tx-1000'].includes(String(le?.transaction_id || '')) &&
      !String(le?.id || '').includes('OPENING_INVENTORY_CAPITAL') &&
      !String(le?.id || '').includes('inst-54859') &&
      !String(le?.id || '').startsWith('le-ledger_TXN-8')
    );
  }
  if (Array.isArray(t.receipt_refund_ledger)) {
    t.receipt_refund_ledger = t.receipt_refund_ledger.filter((r: any) =>
      !legacyLaybys.has(String(r?.order_id || '')) &&
      !legacyOrders.has(String(r?.order_id || '')) &&
      !legacyStores.has(String(r?.store_id || '').toLowerCase()) &&
      String(r?.id || '') !== 'RCPT_LBY_inst-54859'
    );
  }
  if (Array.isArray(t.cash_flow_ledger)) {
    t.cash_flow_ledger = t.cash_flow_ledger.filter((c: any) =>
      !legacyLaybys.has(String(c?.reference_id || '')) &&
      !legacyOrders.has(String(c?.reference_id || '')) &&
      !legacyStores.has(String(c?.store_id || '').toLowerCase()) &&
      String(c?.id || '') !== 'CF_LBY_inst-54859'
    );
  }
  if (Array.isArray(t.payment_method_ledger)) {
    t.payment_method_ledger = t.payment_method_ledger.filter((p: any) => !legacyStores.has(String(p?.store_id || '').toLowerCase()));
  }
  if (Array.isArray(t.financial_statements_ledger)) {
    t.financial_statements_ledger = t.financial_statements_ledger.filter((f: any) => !legacyStores.has(String(f?.store_id || '').toLowerCase()));
  }
  if (Array.isArray(t.cash_ups)) {
    t.cash_ups = t.cash_ups.filter((c: any) => !legacyStores.has(String(c?.store_id || '').toLowerCase()) && c?.id !== 'EOD-LIVE-2026-10-18-ALL');
  }
  const legacyOperators = new Set([
    'alice mwansa',
    'brian banda',
    'alice@pos.zm',
    'brian@pos.zm',
    'chiposha conwell',
    'owner@pos.zm',
    'jane carter',
    'marcus brody',
  ]);
  if (Array.isArray(t.staff)) {
    t.staff = t.staff.filter(
      (st: any) =>
        st?.business_id !== 'default_biz' &&
        !['staff-101', 'staff-102', 'staff-103'].includes(String(st?.id || '')) &&
        !['alice@pos.zm', 'brian@pos.zm', 'owner@pos.zm'].includes(String(st?.email || '').toLowerCase())
    );
  }
  if (Array.isArray(t.audit_logs)) {
    t.audit_logs = t.audit_logs.filter((a: any) =>
      String(a?.id || '') !== 'AUDIT_1792321282567_rn0mx' &&
      !String(a?.details || '').includes('LBY-8082') &&
      !legacyStores.has(String(a?.store_id || '').toLowerCase()) &&
      !legacyOperators.has(String(a?.performed_by || '').trim().toLowerCase())
    );
  }
  if (Array.isArray(t.transactions)) {
    t.transactions = t.transactions.filter((tx: any) => {
      const id = String(tx?.id || '');
      const terminal = String(tx?.pos_terminal_id || '').toLowerCase();
      const perf = String(tx?.performed_by || '').trim().toLowerCase();
      if (['tx-999', 'tx-1000', 'TX_AUDIT_1792321282567_rn0mx'].includes(id)) return false;
      if (legacyOperators.has(perf)) return false;
      if (id.startsWith('ledger_TXN-8')) return false;
      if (String(tx?.narration || '').includes('LBY-8082')) return false;
      if (terminal.includes('pos-lusaka') || terminal.includes('pos-ndola') || terminal.includes('pos-kitwe')) return false;
      return true;
    });
  }
  return t;
}

function scopeTablesToBusiness(
  rawTables: Record<string, any[]>,
  bizId: string
): { tables: Record<string, any[]>; primaryStoreId: string } {
  const cleaned = scrubCloudSnapshotTables(rawTables);
  const isSpecificBiz = Boolean(bizId && bizId !== '__global__' && bizId !== '__latest__');

  const rawStores = Array.isArray(cleaned.stores) ? cleaned.stores : [];
  const filteredStores = isSpecificBiz
    ? rawStores.filter((s: any) => !s?.business_id || String(s.business_id) === bizId)
    : rawStores;
  const primaryStoreId = String(filteredStores[0]?.id || 'main');

  const scoped: Record<string, any[]> = {};
  for (const [tableName, rows] of Object.entries(cleaned)) {
    if (!Array.isArray(rows)) continue;
    if (tableName === 'businesses') {
      const filteredBiz = isSpecificBiz
        ? rows.filter((b: any) => String(b?.id || '') === bizId || String(b?.business_id || '') === bizId)
        : rows;
      scoped[tableName] = filteredBiz.map((b: any) => ({
        ...b,
        business_id: String(b?.business_id || b?.id || bizId),
        store_id: String(b?.store_id || primaryStoreId),
      }));
    } else if (tableName === 'stores') {
      scoped[tableName] = filteredStores.map((s: any) => ({
        ...s,
        business_id: String(s?.business_id || bizId),
        store_id: String(s?.store_id || s?.id || primaryStoreId),
      }));
    } else if (tableName === 'accounts') {
      scoped[tableName] = rows.map((r: any) => ({ ...r }));
    } else {
      const filteredRows = isSpecificBiz
        ? rows.filter((r: any) => {
            if (!r || typeof r !== 'object') return false;
            const rowBiz = String(r.business_id || (tableName === 'loans' ? r.merchant_id : '') || '').trim();
            return !rowBiz || rowBiz === bizId;
          })
        : rows;
      scoped[tableName] = filteredRows.map((r: any) => ({
        ...r,
        business_id: String(r?.business_id || bizId),
        store_id: String(r?.store_id || primaryStoreId),
      }));
    }
  }
  return { tables: scoped, primaryStoreId };
}

function namespaceKey(bizId: string, rawKey: string): string {
  const prefix = `${bizId}::`;
  return rawKey.startsWith(prefix) ? rawKey : `${prefix}${rawKey}`;
}

export async function pushPosSyncToCloudSql(payload: SyncPushPayload) {
  const nowIso = new Date().toISOString();
  const bizId = (payload.businessId || '__global__').trim();
  const { tables, primaryStoreId } = scopeTablesToBusiness(payload.tables || {}, bizId);
  const tablesJsonStr = JSON.stringify(tables);
  const settingsJsonStr = payload.settings ? JSON.stringify(payload.settings) : null;

  const bizRows = Array.isArray(tables.businesses) ? tables.businesses : [];
  const matchingBiz = bizRows.find((b: any) => b.id === bizId) || bizRows[0];
  const bizName = payload.businessName || matchingBiz?.name || 'Synced Business';
  const ownerEmail = (payload.ownerEmail || matchingBiz?.email || '').toLowerCase().trim();

  // 1. Upsert isolated per-business snapshot ONLY (never overwrite a shared global '__latest__' row)
  try {
    const snapRows = [
      {
        businessId: bizId,
        businessName: bizName,
        ownerEmail,
        tablesJson: tablesJsonStr,
        settingsJson: settingsJsonStr,
        updatedAt: nowIso,
      },
    ];

    await db
      .insert(posSyncSnapshots)
      .values(snapRows)
      .onConflictDoUpdate({
        target: posSyncSnapshots.businessId,
        set: {
          businessName: sql`excluded."business_name"`,
          ownerEmail: sql`excluded."owner_email"`,
          tablesJson: sql`excluded."tables_json"`,
          settingsJson: sql`excluded."settings_json"`,
          updatedAt: sql`excluded."updated_at"`,
        },
      });
  } catch (error) {
    console.warn('[CloudSQL Sync] Snapshot upsert failed:', (error as any)?.message || error);
    throw new Error('Failed to synchronize POS snapshot to Cloud SQL. Please try again shortly.', {
      cause: error,
    });
  }

  // 2. Synchronize relational tables in Cloud SQL strictly scoped to this business
  try {
    const cleanBusinesses = dedupeByKey(
      bizRows.filter((b: any) => b && b.id),
      (b: any) => b.id
    ).map((b: any) => ({
      id: String(b.id),
      name: String(b.name || 'Business'),
      owner: String(b.owner || ''),
      email: String(b.email || ''),
      password: String(b.password || ''),
    }));

    if (cleanBusinesses.length > 0) {
      await db
        .insert(businesses)
        .values(cleanBusinesses)
        .onConflictDoUpdate({
          target: businesses.id,
          set: {
            name: sql`excluded."name"`,
            owner: sql`excluded."owner"`,
            email: sql`excluded."email"`,
            password: sql`excluded."password"`,
          },
        });
    }

    const storeRows = Array.isArray(tables.stores) ? tables.stores : [];
    const cleanStores = dedupeByKey(
      storeRows.filter((s: any) => s && s.id),
      (s: any) => s.id
    ).map((s: any) => ({
      id: String(s.id),
      businessId: String(s.business_id || bizId),
      name: String(s.name || s.id),
      location: String(s.location || ''),
      phone: String(s.phone || ''),
      email: String(s.email || ''),
      allowDiscounts: Number(s.allow_discounts ?? 1),
      allowRefunds: Number(s.allow_refunds ?? 1),
      allowLaybys: Number(s.allow_laybys ?? 1),
      requireManagerDiscount: Number(s.require_manager_discount ?? 0),
      stocktakeFrequency: String(s.stocktake_frequency || 'weekly'),
    }));

    if (cleanStores.length > 0) {
      await db
        .insert(stores)
        .values(cleanStores)
        .onConflictDoUpdate({
          target: stores.id,
          set: {
            businessId: sql`excluded."business_id"`,
            name: sql`excluded."name"`,
            location: sql`excluded."location"`,
            phone: sql`excluded."phone"`,
            email: sql`excluded."email"`,
            allowDiscounts: sql`excluded."allow_discounts"`,
            allowRefunds: sql`excluded."allow_refunds"`,
            allowLaybys: sql`excluded."allow_laybys"`,
            requireManagerDiscount: sql`excluded."require_manager_discount"`,
            stocktakeFrequency: sql`excluded."stocktake_frequency"`,
          },
        });
    }

    const prodRows = Array.isArray(tables.products) ? tables.products : [];
    const seenSkus = new Set<string>();
    const cleanProducts = dedupeByKey(
      prodRows.filter((p: any) => p && p.id !== undefined && p.id !== null),
      (p: any) => Number(p.id)
    ).map((p: any) => {
      let skuVal = String(p.sku || `SKU-${p.id}`).trim() || `SKU-${p.id}`;
      if (seenSkus.has(skuVal)) {
        skuVal = `${skuVal}-${p.id}`;
      }
      seenSkus.add(skuVal);
      return {
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
      };
    });

    if (cleanProducts.length > 0) {
      await db
        .insert(products)
        .values(cleanProducts)
        .onConflictDoUpdate({
          target: products.id,
          set: {
            name: sql`excluded."name"`,
            sku: sql`excluded."sku"`,
            category: sql`excluded."category"`,
            price: sql`excluded."price"`,
            cost: sql`excluded."cost"`,
            stock: sql`excluded."stock"`,
            imageUrl: sql`excluded."image_url"`,
            businessId: sql`excluded."business_id"`,
            isService: sql`excluded."is_service"`,
            batchNumber: sql`excluded."batch_number"`,
            expiryDate: sql`excluded."expiry_date"`,
          },
        });
    }

    const custRows = Array.isArray(tables.customers) ? tables.customers : [];
    const cleanCustomers = dedupeByKey(
      custRows.filter((c: any) => c && c.id !== undefined && c.id !== null),
      (c: any) => Number(c.id)
    ).map((c: any) => ({
      id: Number(c.id),
      name: String(c.name || 'Customer'),
      phone: String(c.phone || ''),
      email: String(c.email || ''),
      loyalPoints: Number(c.loyalPoints || 0),
      tpin: String(c.tpin || ''),
      zraConnected: Number(c.zra_connected || 0),
      taxBand: String(c.tax_band || 'A - Standard Rate (16%)'),
      businessId: String(c.business_id || bizId),
    }));

    if (cleanCustomers.length > 0) {
      await db
        .insert(customers)
        .values(cleanCustomers)
        .onConflictDoUpdate({
          target: customers.id,
          set: {
            name: sql`excluded."name"`,
            phone: sql`excluded."phone"`,
            email: sql`excluded."email"`,
            loyalPoints: sql`excluded."loyal_points"`,
            tpin: sql`excluded."tpin"`,
            zraConnected: sql`excluded."zra_connected"`,
            taxBand: sql`excluded."tax_band"`,
            businessId: sql`excluded."business_id"`,
          },
        });
    }

    const orderRows = Array.isArray(tables.orders) ? tables.orders : [];
    const cleanOrders = dedupeByKey(
      orderRows.filter((o: any) => o && o.id),
      (o: any) => o.id
    ).map((o: any) => ({
      id: String(o.id),
      customerId: o.customerId ? Number(o.customerId) : null,
      orderDate: String(o.orderDate || nowIso),
      subtotal: String(Number(o.subtotal || 0).toFixed(2)),
      tax: String(Number(o.tax || 0).toFixed(2)),
      discount: String(Number(o.discount || 0).toFixed(2)),
      total: String(Number(o.total || 0).toFixed(2)),
      paymentMethod: String(o.paymentMethod || 'Cash'),
      status: String(o.status || 'Completed'),
      storeId: String(o.store_id || primaryStoreId),
      performedBy: String(o.performed_by || 'owner'),
    }));

    if (cleanOrders.length > 0) {
      await db
        .insert(orders)
        .values(cleanOrders)
        .onConflictDoUpdate({
          target: orders.id,
          set: {
            status: sql`excluded."status"`,
            total: sql`excluded."total"`,
            paymentMethod: sql`excluded."payment_method"`,
            storeId: sql`excluded."store_id"`,
          },
        });
    }

    const itemRows = Array.isArray(tables.order_items) ? tables.order_items : [];
    const cleanOrderItems = dedupeByKey(
      itemRows.filter((oi: any) => oi && oi.id),
      (oi: any) => oi.id
    ).map((oi: any) => ({
      id: String(oi.id),
      orderId: String(oi.orderId || ''),
      productId: Number(oi.productId || 0),
      quantity: Number(oi.quantity || 1),
      unitPrice: String(Number(oi.unitPrice || 0).toFixed(2)),
    }));

    if (cleanOrderItems.length > 0) {
      await db.insert(orderItems).values(cleanOrderItems).onConflictDoNothing();
    }

    const bizPrefix = `${bizId}::`;

    const journalRows = Array.isArray(tables.double_entry_journal) ? tables.double_entry_journal : [];
    const cleanJournal = dedupeByKey(
      journalRows.filter((j: any) => j && j.id),
      (j: any) => namespaceKey(bizId, String(j.id))
    ).map((j: any) => ({
      id: namespaceKey(bizId, String(j.id)),
      entryDate: String(j.date || nowIso),
      referenceId: String(j.reference || ''),
      module: 'POS_LEDGER',
      description: String(j.description || ''),
      debitAccount: String(j.account_debit || ''),
      creditAccount: String(j.account_credit || ''),
      amount: String(Number(j.amount || 0).toFixed(2)),
      storeId: String(j.store_id || primaryStoreId),
      performedBy: String(j.performed_by || 'system'),
    }));

    await db.delete(doubleEntryJournal).where(sql`LEFT(${doubleEntryJournal.id}, ${bizPrefix.length}) = ${bizPrefix}`);
    if (cleanJournal.length > 0) {
      await db
        .insert(doubleEntryJournal)
        .values(cleanJournal)
        .onConflictDoUpdate({
          target: doubleEntryJournal.id,
          set: {
            amount: sql`excluded."amount"`,
            description: sql`excluded."description"`,
            storeId: sql`excluded."store_id"`,
          },
        });
    }

    const rrRows = Array.isArray(tables.receipt_refund_ledger) ? tables.receipt_refund_ledger : [];
    const cleanRR = dedupeByKey(
      rrRows.filter((r: any) => r && r.id),
      (r: any) => namespaceKey(bizId, String(r.id))
    ).map((r: any) => ({
      id: namespaceKey(bizId, String(r.id)),
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
      storeId: String(r.store_id || primaryStoreId),
      performedBy: String(r.performed_by || ''),
      status: String(r.status || 'Posted'),
      notes: String(r.journal_ref || ''),
    }));

    await db.delete(receiptRefundLedger).where(sql`LEFT(${receiptRefundLedger.id}, ${bizPrefix.length}) = ${bizPrefix}`);
    if (cleanRR.length > 0) {
      await db
        .insert(receiptRefundLedger)
        .values(cleanRR)
        .onConflictDoUpdate({
          target: receiptRefundLedger.id,
          set: {
            status: sql`excluded."status"`,
            grossAmount: sql`excluded."gross_amount"`,
            storeId: sql`excluded."store_id"`,
          },
        });
    }

    const cfRows = Array.isArray(tables.cash_flow_ledger) ? tables.cash_flow_ledger : [];
    const cleanCF = dedupeByKey(
      cfRows.filter((cf: any) => cf && cf.id),
      (cf: any) => namespaceKey(bizId, String(cf.id))
    ).map((cf: any) => {
      const netVal = Number(cf.net_cash_change || 0);
      return {
        id: namespaceKey(bizId, String(cf.id)),
        entryDate: String(cf.date || nowIso),
        activityCategory: String(cf.activity_type || 'OPERATING'),
        direction: String(cf.direction || 'INFLOW'),
        paymentMethod: String(cf.payment_method || 'Cash'),
        referenceId: String(cf.reference_id || ''),
        description: String(cf.description || ''),
        amount: String(Math.abs(netVal).toFixed(2)),
        signedAmount: String(netVal.toFixed(2)),
        storeId: String(cf.store_id || primaryStoreId),
        performedBy: String(cf.performed_by || ''),
      };
    });

    await db.delete(cashFlowLedger).where(sql`LEFT(${cashFlowLedger.id}, ${bizPrefix.length}) = ${bizPrefix}`);
    if (cleanCF.length > 0) {
      await db
        .insert(cashFlowLedger)
        .values(cleanCF)
        .onConflictDoUpdate({
          target: cashFlowLedger.id,
          set: {
            signedAmount: sql`excluded."signed_amount"`,
            amount: sql`excluded."amount"`,
            storeId: sql`excluded."store_id"`,
          },
        });
    }

    const pmRows = Array.isArray(tables.payment_method_ledger) ? tables.payment_method_ledger : [];
    const cleanPM = dedupeByKey(
      pmRows.filter((pm: any) => pm && pm.id),
      (pm: any) => namespaceKey(bizId, String(pm.id))
    ).map((pm: any) => ({
      methodKey: namespaceKey(bizId, String(pm.id)),
      methodLabel: `${pm.payment_method} (${pm.store_id || primaryStoreId})`,
      accountCode: String(pm.account_id || 'acc_cash'),
      grossInflows: String(Number((pm.gross_receipts || 0) + (pm.layby_receipts || 0)).toFixed(2)),
      refundOutflows: String(Number(pm.refunds_out || 0).toFixed(2)),
      expenseOutflows: String(Number(pm.expenses_out || 0).toFixed(2)),
      netBalance: String(Number(pm.net_balance || 0).toFixed(2)),
      txCount: Number(pm.transaction_count || 0),
      updatedAt: nowIso,
    }));

    await db.delete(paymentMethodLedger).where(sql`LEFT(${paymentMethodLedger.methodKey}, ${bizPrefix.length}) = ${bizPrefix}`);
    if (cleanPM.length > 0) {
      await db
        .insert(paymentMethodLedger)
        .values(cleanPM)
        .onConflictDoUpdate({
          target: paymentMethodLedger.methodKey,
          set: {
            grossInflows: sql`excluded."gross_inflows"`,
            refundOutflows: sql`excluded."refund_outflows"`,
            expenseOutflows: sql`excluded."expense_outflows"`,
            netBalance: sql`excluded."net_balance"`,
            txCount: sql`excluded."tx_count"`,
            updatedAt: sql`excluded."updated_at"`,
          },
        });
    }

    const cuRows = Array.isArray(tables.cash_ups) ? tables.cash_ups : [];
    const cleanCashUps = dedupeByKey(
      cuRows.filter((cu: any) => cu && cu.id),
      (cu: any) => cu.id
    ).map((cu: any) => ({
      id: String(cu.id),
      storeId: String(cu.store_id || primaryStoreId),
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
    }));

    if (cleanCashUps.length > 0) {
      await db
        .insert(cashUps)
        .values(cleanCashUps)
        .onConflictDoUpdate({
          target: cashUps.id,
          set: {
            expectedCash: sql`excluded."expected_cash"`,
            actualCash: sql`excluded."actual_cash"`,
            variance: sql`excluded."variance"`,
            expectedCard: sql`excluded."expected_card"`,
            expectedMobile: sql`excluded."expected_mobile"`,
            notes: sql`excluded."notes"`,
          },
        });
    }

    const fsRows = Array.isArray(tables.financial_statements_ledger) ? tables.financial_statements_ledger : [];
    const cleanFS = dedupeByKey(
      fsRows.filter((fs: any) => fs && fs.id),
      (fs: any) => namespaceKey(bizId, String(fs.id))
    ).map((fs: any) => ({
      statementKey: namespaceKey(bizId, String(fs.id)),
      statementType: 'FULL_STATEMENT_SNAPSHOT',
      section: String(fs.store_id || primaryStoreId),
      lineItem: `Net Income: ${fs.net_operating_income || 0} | Total Assets: ${fs.total_assets || 0} | Net Cash Flow: ${fs.net_cash_flow || 0}`,
      amount: String(Number(fs.net_operating_income || 0).toFixed(2)),
      storeId: String(fs.store_id || primaryStoreId),
      updatedAt: nowIso,
    }));

    await db.delete(financialStatementsLedger).where(sql`LEFT(${financialStatementsLedger.statementKey}, ${bizPrefix.length}) = ${bizPrefix}`);
    if (cleanFS.length > 0) {
      await db
        .insert(financialStatementsLedger)
        .values(cleanFS)
        .onConflictDoUpdate({
          target: financialStatementsLedger.statementKey,
          set: {
            lineItem: sql`excluded."line_item"`,
            amount: sql`excluded."amount"`,
            storeId: sql`excluded."store_id"`,
            updatedAt: sql`excluded."updated_at"`,
          },
        });
    }

    const alRows = Array.isArray(tables.audit_logs) ? tables.audit_logs.slice(0, 100) : [];
    const cleanAL = dedupeByKey(
      alRows.filter((al: any) => al && al.id),
      (al: any) => al.id
    ).map((al: any) => ({
      id: String(al.id),
      module: String(al.module || 'SYSTEM'),
      action: String(al.action || ''),
      details: String(al.details || ''),
      amount: String(Number(al.amount || 0).toFixed(2)),
      storeId: String(al.store_id || primaryStoreId),
      performedBy: String(al.performed_by || ''),
      createdAt: String(al.created_at || nowIso),
    }));

    if (cleanAL.length > 0) {
      await db.insert(auditLogs).values(cleanAL).onConflictDoNothing();
    }
  } catch (relErr: any) {
    console.warn('[CloudSQL Sync] Relational table mirror warning:', relErr?.message || relErr);
  }

  return {
    success: true,
    businessId: bizId,
    businessName: bizName,
    updatedAt: nowIso,
  };
}

export async function pullPosSyncFromCloudSql(businessId?: string, email?: string) {
  let allSnapshots: (typeof posSyncSnapshots.$inferSelect)[] = [];
  try {
    allSnapshots = await db
      .select()
      .from(posSyncSnapshots)
      .orderBy(desc(posSyncSnapshots.updatedAt));
  } catch (error) {
    console.warn('[CloudSQL Sync] Snapshot pull failed:', (error as any)?.message || error);
    throw new Error('Failed to load POS snapshot from Cloud SQL. Please try again shortly.', {
      cause: error,
    });
  }

  const realBusinessSnapshots = allSnapshots.filter(
    (s) => s.businessId !== '__latest__' && s.businessId !== '__global__'
  );

  const availableBusinesses = realBusinessSnapshots.map((s) => ({
    businessId: s.businessId,
    businessName: s.businessName || s.businessId,
    ownerEmail: s.ownerEmail || '',
    updatedAt: s.updatedAt,
  }));

  const cleanBizId = businessId ? businessId.trim() : '';
  const cleanEmail = email ? email.trim().toLowerCase() : '';
  const hasExplicitSelector = Boolean(cleanBizId || cleanEmail);

  let targetSnap: (typeof posSyncSnapshots.$inferSelect) | null = null;
  if (cleanBizId) {
    targetSnap = realBusinessSnapshots.find((s) => s.businessId === cleanBizId) || null;
  }
  if (!targetSnap && cleanEmail) {
    targetSnap =
      realBusinessSnapshots.find((s) => (s.ownerEmail || '').toLowerCase() === cleanEmail) ||
      realBusinessSnapshots.find((s) => {
        try {
          const parsed = JSON.parse(s.tablesJson);
          const staffList = Array.isArray(parsed?.staff) ? parsed.staff : [];
          return staffList.some(
            (st: any) => st?.email && String(st.email).trim().toLowerCase() === cleanEmail
          );
        } catch {
          return false;
        }
      }) ||
      null;
  }

  // Only allow generic lookup when caller did NOT pass any businessId or email (e.g. /api/sync/status)
  if (!targetSnap && !hasExplicitSelector) {
    targetSnap = realBusinessSnapshots[0] || null;
  }

  if (!targetSnap) {
    return {
      found: false,
      availableBusinesses,
    };
  }

  let parsedTables: Record<string, any[]> = {};
  let parsedSettings: Record<string, any> | null = null;
  try {
    parsedTables = scopeTablesToBusiness(JSON.parse(targetSnap.tablesJson), targetSnap.businessId).tables;
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
