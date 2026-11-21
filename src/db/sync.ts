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
  finalizedTransactionEvents,
  posSyncSnapshots,
} from './schema.ts';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { computeCredentialHashSync, normalizeAuthEmail } from '../multiTenantAuth.ts';

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

const serverDeletedBusinessIds = new Set<string>([
  'default_biz',
  '__latest__',
  '__global__',
]);

function scrubCloudSnapshotTables(rawTables: Record<string, any[]>): Record<string, any[]> {
  const t: Record<string, any[]> = { ...(rawTables || {}) };
  const legacyStores = new Set(['lusaka', 'kitwe', 'ndola', 'store_main']);
  const legacyLaybys = new Set(['layby-1004', 'LBY-8082']);
  const legacyInsts = new Set(['inst-001', 'inst-002', 'inst-54859']);
  const legacyOrders = new Set(['TXN-8801', 'TXN-8802', 'TXN-8803', 'TXN-8798', 'TXN-8799', 'TXN-8800', 'TXN-8795', 'TXN-8796', 'TXN-8797']);
  const legacyLoans = new Set(['LOAN-001', 'LOAN-002']);

  if (Array.isArray(t.businesses)) {
    t.businesses = dedupeByKey(
      t.businesses.filter(
        (b: any) =>
          b?.id &&
          !serverDeletedBusinessIds.has(String(b.id).trim()) &&
          b?.email !== 'owner@pos.zm'
      ),
      (b: any) => String(b.id).trim()
    );
  }
  if (Array.isArray(t.stores)) {
    t.stores = t.stores.filter(
      (s: any) =>
        !serverDeletedBusinessIds.has(String(s?.business_id || '').trim()) &&
        !legacyStores.has(String(s?.id || '').toLowerCase())
    );
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
  if (serverDeletedBusinessIds.has(bizId)) {
    return {
      success: false,
      businessId: bizId,
      businessName: payload.businessName || bizId,
      updatedAt: nowIso,
      ignoredDeletedBusiness: true,
    };
  }
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
      businessId: String(o.business_id || bizId),
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
            businessId: sql`excluded."business_id"`,
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
      businessId: String(oi.business_id || bizId),
      storeId: String(oi.store_id || primaryStoreId),
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
      businessId: bizId,
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
            businessId: sql`excluded."business_id"`,
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
      businessId: bizId,
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
            businessId: sql`excluded."business_id"`,
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
        businessId: bizId,
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
            businessId: sql`excluded."business_id"`,
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
      businessId: bizId,
      storeId: String(pm.store_id || primaryStoreId),
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
            businessId: sql`excluded."business_id"`,
            storeId: sql`excluded."store_id"`,
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
      businessId: String(cu.business_id || bizId),
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
            businessId: sql`excluded."business_id"`,
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
      businessId: bizId,
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
            businessId: sql`excluded."business_id"`,
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
      businessId: String(al.business_id || bizId),
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

function snapshotMatchesCredential(
  snap: typeof posSyncSnapshots.$inferSelect,
  cleanEmail: string,
  cleanCredHash: string
): boolean {
  try {
    const parsed = JSON.parse(snap.tablesJson || '{}');
    const memberships = Array.isArray(parsed?.business_memberships) ? parsed.business_memberships : [];
    for (const m of memberships) {
      if (normalizeAuthEmail(m?.email) !== cleanEmail) continue;
      if (m?.credential_hash && String(m.credential_hash).trim() === cleanCredHash) return true;
      if (m?.password && m.password !== 'cloud_recovered' && computeCredentialHashSync(cleanEmail, String(m.password)) === cleanCredHash) {
        return true;
      }
    }
    const bizRows = Array.isArray(parsed?.businesses) ? parsed.businesses : [];
    for (const b of bizRows) {
      if (normalizeAuthEmail(b?.email) !== cleanEmail) continue;
      if (b?.password && b.password !== 'cloud_recovered' && computeCredentialHashSync(cleanEmail, String(b.password)) === cleanCredHash) {
        return true;
      }
    }
    const staffList = Array.isArray(parsed?.staff) ? parsed.staff : [];
    for (const st of staffList) {
      if (normalizeAuthEmail(st?.email) !== cleanEmail) continue;
      if (st?.password && computeCredentialHashSync(cleanEmail, String(st.password)) === cleanCredHash) return true;
      if (st?.pin && computeCredentialHashSync(cleanEmail, String(st.pin)) === cleanCredHash) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function pullPosSyncFromCloudSql(businessId?: string, email?: string, credentialHash?: string) {
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
    (s) => !serverDeletedBusinessIds.has(String(s.businessId || '').trim())
  );

  const availableBusinesses = realBusinessSnapshots.map((s) => ({
    businessId: s.businessId,
    businessName: s.businessName || s.businessId,
    ownerEmail: s.ownerEmail || '',
    updatedAt: s.updatedAt,
  }));

  const cleanBizId = businessId ? businessId.trim() : '';
  const cleanEmail = email ? email.trim().toLowerCase() : '';
  const cleanCredHash = credentialHash ? credentialHash.trim().toLowerCase() : '';
  const hasExplicitSelector = Boolean(cleanBizId || cleanEmail || cleanCredHash);

  let targetSnap: (typeof posSyncSnapshots.$inferSelect) | null = null;
  let matchedBusinessIds: string[] = [];

  if (cleanCredHash && cleanEmail) {
    const matchedSnaps = realBusinessSnapshots.filter((s) =>
      snapshotMatchesCredential(s, cleanEmail, cleanCredHash)
    );
    matchedBusinessIds = matchedSnaps.map((s) => s.businessId);
    if (cleanBizId) {
      targetSnap = matchedSnaps.find((s) => s.businessId === cleanBizId) || null;
    } else {
      targetSnap = matchedSnaps[0] || null;
    }
  } else {
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
    if (!targetSnap && !hasExplicitSelector) {
      targetSnap = realBusinessSnapshots[0] || null;
    }
  }

  if (!targetSnap) {
    return {
      found: false,
      availableBusinesses: cleanCredHash ? [] : availableBusinesses,
      matchedBusinessIds,
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
    availableBusinesses: cleanCredHash ? [] : availableBusinesses,
    matchedBusinessIds,
  };
}

// ============================================================================
// SERVER-SIDE FINALIZED TRANSACTION MIRROR (Firestore Commit -> Central SQL)
// ============================================================================

export interface FinalizedTransactionMirrorPayload {
  txType: 'SALE' | 'REFUND' | 'EOD_CASHUP';
  businessId: string;
  businessName?: string;
  ownerEmail?: string;
  storeId: string;
  storeName?: string;
  firestorePath?: string;
  source?: string;
  order?: {
    id: string;
    customerId?: number | null;
    customerName?: string;
    orderDate: string;
    subtotal: number;
    tax: number;
    discount: number;
    total: number;
    cogsAmount?: number;
    paymentMethod: string;
    status: string;
    performed_by: string;
  };
  items?: Array<{
    id: string;
    productId: number;
    productName?: string;
    quantity: number;
    unitPrice: number;
    unitCost?: number;
  }>;
  updatedProducts?: Array<{
    id: number;
    name: string;
    sku?: string;
    category?: string;
    price: number;
    cost: number;
    stock: number;
    imageUrl?: string;
    is_service?: number;
    batch_number?: string;
    expiry_date?: string;
  }>;
  cashUp?: {
    id: string;
    date: string;
    cashierName?: string;
    expectedCash: number;
    actualCash: number;
    variance: number;
    expectedCard: number;
    expectedMobile: number;
    notes?: string;
    createdAt?: string;
  };
}

export async function mirrorFinalizedTransactionToCloudSql(
  payload: FinalizedTransactionMirrorPayload,
  actorUid?: string
) {
  const nowIso = new Date().toISOString();
  const bizId = String(payload.businessId || '').trim();
  const storeId = String(payload.storeId || 'main').trim() || 'main';
  if (!bizId || bizId === 'default_biz' || bizId === '__global__') {
    throw new Error('Valid businessId is required to mirror finalized transaction.');
  }

  // Ensure business and store reference records exist in Central SQL
  await db
    .insert(businesses)
    .values({
      id: bizId,
      name: String(payload.businessName || bizId),
      email: String(payload.ownerEmail || ''),
    })
    .onConflictDoNothing();

  await db
    .insert(stores)
    .values({
      id: storeId,
      businessId: bizId,
      name: String(payload.storeName || storeId),
    })
    .onConflictDoNothing();

  const txType = payload.txType || 'SALE';

  if ((txType === 'SALE' || txType === 'REFUND') && payload.order?.id) {
    const o = payload.order;
    const orderId = String(o.id).trim();
    const subtotalNum = Number(o.subtotal || 0);
    const taxNum = Number(o.tax || 0);
    const discountNum = Number(o.discount || 0);
    const totalNum = Number(o.total || 0);
    const occurredAt = String(o.orderDate || nowIso);

    const computedCogs =
      o.cogsAmount !== undefined
        ? Number(o.cogsAmount || 0)
        : (payload.items || []).reduce((acc, it) => {
            const c = Number(it.unitCost ?? Number(it.unitPrice || 0) * 0.7);
            return acc + c * Number(it.quantity || 1);
          }, 0);

    const netRevImpact = Math.max(0, totalNum - taxNum);

    await db
      .insert(orders)
      .values({
        id: orderId,
        businessId: bizId,
        customerId: o.customerId ? Number(o.customerId) : null,
        orderDate: occurredAt,
        subtotal: subtotalNum.toFixed(2),
        tax: taxNum.toFixed(2),
        discount: discountNum.toFixed(2),
        total: totalNum.toFixed(2),
        paymentMethod: String(o.paymentMethod || 'Cash'),
        status: txType === 'REFUND' ? 'Refunded' : String(o.status || 'Completed'),
        storeId,
        performedBy: String(o.performed_by || 'owner'),
      })
      .onConflictDoUpdate({
        target: orders.id,
        set: {
          businessId: sql`excluded."business_id"`,
          status: sql`excluded."status"`,
          total: sql`excluded."total"`,
          paymentMethod: sql`excluded."payment_method"`,
          storeId: sql`excluded."store_id"`,
        },
      });

    if (Array.isArray(payload.items) && payload.items.length > 0) {
      const cleanItems = payload.items
        .filter((it) => it && it.id)
        .map((it) => ({
          id: String(it.id),
          businessId: bizId,
          storeId,
          orderId,
          productId: Number(it.productId || 0),
          quantity: Math.max(1, Number(it.quantity || 1)),
          unitPrice: Number(it.unitPrice || 0).toFixed(2),
        }));
      if (cleanItems.length > 0) {
        await db.insert(orderItems).values(cleanItems).onConflictDoNothing();
      }
    }

    if (Array.isArray(payload.updatedProducts) && payload.updatedProducts.length > 0) {
      for (const p of payload.updatedProducts) {
        if (!p || p.id === undefined || p.id === null) continue;
        const pid = Number(p.id);
        await db
          .insert(products)
          .values({
            id: pid,
            name: String(p.name || `Item #${pid}`),
            sku: String(p.sku || `SKU-${pid}-${bizId.slice(-4)}`),
            category: String(p.category || 'General'),
            price: Number(p.price || 0).toFixed(2),
            cost: Number(p.cost || 0).toFixed(2),
            stock: Number(p.stock || 0),
            imageUrl: String(p.imageUrl || ''),
            businessId: bizId,
            isService: Number(p.is_service || 0),
            batchNumber: String(p.batch_number || ''),
            expiryDate: String(p.expiry_date || ''),
          })
          .onConflictDoUpdate({
            target: products.id,
            set: {
              stock: sql`excluded."stock"`,
              price: sql`excluded."price"`,
              cost: sql`excluded."cost"`,
            },
          });
      }
    }

    const rrId = namespaceKey(bizId, `${txType}_${orderId}`);
    const sign = txType === 'REFUND' ? -1 : 1;
    await db
      .insert(receiptRefundLedger)
      .values({
        id: rrId,
        businessId: bizId,
        entryDate: occurredAt,
        txType: txType === 'REFUND' ? 'REFUND' : 'RECEIPT',
        referenceId: orderId,
        customerName: String(o.customerName || 'Walk-In Customer'),
        paymentMethod: String(o.paymentMethod || 'Cash'),
        grossAmount: (sign * totalNum).toFixed(2),
        taxAmount: (sign * taxNum).toFixed(2),
        discountAmount: (sign * discountNum).toFixed(2),
        netRevenue: (sign * netRevImpact).toFixed(2),
        cogsAmount: (sign * computedCogs).toFixed(2),
        storeId,
        performedBy: String(o.performed_by || 'owner'),
        status: 'Posted',
        notes: payload.firestorePath ? `Mirrored from ${payload.firestorePath}` : 'Mirrored finalized transaction',
      })
      .onConflictDoUpdate({
        target: receiptRefundLedger.id,
        set: {
          status: sql`excluded."status"`,
          grossAmount: sql`excluded."gross_amount"`,
          netRevenue: sql`excluded."net_revenue"`,
          cogsAmount: sql`excluded."cogs_amount"`,
        },
      });

    const cfId = namespaceKey(bizId, `CF_${txType}_${orderId}`);
    await db
      .insert(cashFlowLedger)
      .values({
        id: cfId,
        businessId: bizId,
        entryDate: occurredAt,
        activityCategory: 'OPERATING',
        direction: txType === 'REFUND' ? 'OUTFLOW' : 'INFLOW',
        paymentMethod: String(o.paymentMethod || 'Cash'),
        referenceId: orderId,
        description:
          txType === 'REFUND'
            ? `POS Refund #${orderId} (${o.paymentMethod || 'Cash'})`
            : `POS Sale #${orderId} (${o.paymentMethod || 'Cash'})`,
        amount: totalNum.toFixed(2),
        signedAmount: (sign * totalNum).toFixed(2),
        storeId,
        performedBy: String(o.performed_by || 'owner'),
      })
      .onConflictDoUpdate({
        target: cashFlowLedger.id,
        set: {
          amount: sql`excluded."amount"`,
          signedAmount: sql`excluded."signed_amount"`,
        },
      });

    const eventId = namespaceKey(bizId, `${txType}_${orderId}`);
    await db
      .insert(finalizedTransactionEvents)
      .values({
        eventId,
        businessId: bizId,
        storeId,
        txType,
        orderId,
        source: String(payload.source || 'firestore_commit_trigger'),
        firestorePath: String(payload.firestorePath || `businesses/${bizId}/orders/${orderId}`),
        grossTotal: (sign * totalNum).toFixed(2),
        taxAmount: (sign * taxNum).toFixed(2),
        discountAmount: (sign * discountNum).toFixed(2),
        netRevenue: (sign * netRevImpact).toFixed(2),
        cogsAmount: (sign * computedCogs).toFixed(2),
        paymentMethod: String(o.paymentMethod || 'Cash'),
        performedBy: String(o.performed_by || actorUid || 'owner'),
        status: 'MIRRORED',
        occurredAt,
        mirroredAt: nowIso,
      })
      .onConflictDoUpdate({
        target: finalizedTransactionEvents.eventId,
        set: {
          status: sql`excluded."status"`,
          grossTotal: sql`excluded."gross_total"`,
          netRevenue: sql`excluded."net_revenue"`,
          mirroredAt: sql`excluded."mirrored_at"`,
        },
      });

    return {
      success: true,
      mirrored: true,
      eventId,
      businessId: bizId,
      storeId,
      txType,
      orderId,
      mirroredAt: nowIso,
    };
  }

  if (txType === 'EOD_CASHUP' && payload.cashUp?.id) {
    const cu = payload.cashUp;
    const cashUpId = String(cu.id).trim();
    const occurredAt = String(cu.createdAt || nowIso);

    await db
      .insert(cashUps)
      .values({
        id: cashUpId,
        businessId: bizId,
        storeId,
        date: String(cu.date || nowIso.split('T')[0]),
        expectedCash: Number(cu.expectedCash || 0).toFixed(2),
        actualCash: Number(cu.actualCash || 0).toFixed(2),
        variance: Number(cu.variance || 0).toFixed(2),
        expectedCard: Number(cu.expectedCard || 0).toFixed(2),
        expectedMobile: Number(cu.expectedMobile || 0).toFixed(2),
        status: 'SYNCED',
        performedBy: String(cu.cashierName || ''),
        notes: String(cu.notes || ''),
        createdAt: occurredAt,
      })
      .onConflictDoUpdate({
        target: cashUps.id,
        set: {
          businessId: sql`excluded."business_id"`,
          expectedCash: sql`excluded."expected_cash"`,
          actualCash: sql`excluded."actual_cash"`,
          variance: sql`excluded."variance"`,
          notes: sql`excluded."notes"`,
        },
      });

    const eventId = namespaceKey(bizId, `EOD_${cashUpId}`);
    await db
      .insert(finalizedTransactionEvents)
      .values({
        eventId,
        businessId: bizId,
        storeId,
        txType: 'EOD_CASHUP',
        orderId: cashUpId,
        source: String(payload.source || 'firestore_commit_trigger'),
        firestorePath: String(payload.firestorePath || `businesses/${bizId}/cash_ups/${cashUpId}`),
        grossTotal: Number(cu.actualCash || 0).toFixed(2),
        taxAmount: '0.00',
        discountAmount: '0.00',
        netRevenue: Number(cu.variance || 0).toFixed(2),
        cogsAmount: '0.00',
        paymentMethod: 'EOD Cash-Up',
        performedBy: String(cu.cashierName || actorUid || 'owner'),
        status: 'MIRRORED',
        occurredAt,
        mirroredAt: nowIso,
      })
      .onConflictDoUpdate({
        target: finalizedTransactionEvents.eventId,
        set: {
          mirroredAt: sql`excluded."mirrored_at"`,
        },
      });

    return {
      success: true,
      mirrored: true,
      eventId,
      businessId: bizId,
      storeId,
      txType: 'EOD_CASHUP',
      orderId: cashUpId,
      mirroredAt: nowIso,
    };
  }

  throw new Error('Unsupported or incomplete finalized transaction payload.');
}

export async function getCentralSqlReportingSummary(params: {
  businessId: string;
  storeId?: string;
  startDate?: string;
  endDate?: string;
}) {
  const bizId = String(params.businessId || '').trim();
  if (!bizId || bizId === '__global__') {
    throw new Error('businessId is required for central SQL reporting.');
  }

  const cleanStoreId = params.storeId && params.storeId !== 'all' ? params.storeId.trim() : '';
  const startDate = params.startDate ? params.startDate.trim() : '';
  const endDate = params.endDate ? params.endDate.trim() : '';

  const inDateRange = (rawDate?: string | null) => {
    const d = String(rawDate || '').slice(0, 10);
    if (!d) return !startDate && !endDate;
    if (startDate && d < startDate) return false;
    if (endDate && d > endDate) return false;
    return true;
  };

  const orderConditions = cleanStoreId
    ? and(eq(orders.businessId, bizId), eq(orders.storeId, cleanStoreId))
    : eq(orders.businessId, bizId);

  const bizOrders = (await db.select().from(orders).where(orderConditions)).filter((o) =>
    inDateRange(o.orderDate)
  );

  const completedOrders = bizOrders.filter((o) => String(o.status || '').toLowerCase() !== 'refunded');
  const refundedOrders = bizOrders.filter((o) => String(o.status || '').toLowerCase() === 'refunded');

  const grossSales = completedOrders.reduce((acc, o) => acc + Number(o.total || 0), 0);
  const refundTotal = refundedOrders.reduce((acc, o) => acc + Number(o.total || 0), 0);
  const taxCollected = completedOrders.reduce((acc, o) => acc + Number(o.tax || 0), 0);
  const discountsAllowed = completedOrders.reduce((acc, o) => acc + Number(o.discount || 0), 0);

  const rrConditions = cleanStoreId
    ? and(eq(receiptRefundLedger.businessId, bizId), eq(receiptRefundLedger.storeId, cleanStoreId))
    : eq(receiptRefundLedger.businessId, bizId);

  const bizRR = (await db.select().from(receiptRefundLedger).where(rrConditions)).filter((r) =>
    inDateRange(r.entryDate)
  );
  const totalCogs = bizRR.reduce((acc, r) => acc + Number(r.cogsAmount || 0), 0);

  const netRevenue = Math.max(0, grossSales - refundTotal - taxCollected);
  const grossProfit = netRevenue - totalCogs;

  // Payment method breakdown from completed orders
  const pmMap = new Map<string, { method: string; count: number; total: number }>();
  for (const o of completedOrders) {
    const method = String(o.paymentMethod || 'Cash');
    const cur = pmMap.get(method) || { method, count: 0, total: 0 };
    cur.count += 1;
    cur.total += Number(o.total || 0);
    pmMap.set(method, cur);
  }

  // Branch breakdown across completed + refunded orders
  const storeRows = await db.select().from(stores).where(eq(stores.businessId, bizId));
  const storeNameMap = new Map(storeRows.map((s) => [s.id, s.name]));
  const branchMap = new Map<
    string,
    { storeId: string; storeName: string; orderCount: number; refundCount: number; grossSales: number; refunds: number }
  >();
  for (const o of bizOrders) {
    const stId = String(o.storeId || 'main');
    const cur = branchMap.get(stId) || {
      storeId: stId,
      storeName: storeNameMap.get(stId) || stId,
      orderCount: 0,
      refundCount: 0,
      grossSales: 0,
      refunds: 0,
    };
    if (String(o.status || '').toLowerCase() === 'refunded') {
      cur.refundCount += 1;
      cur.refunds += Number(o.total || 0);
    } else {
      cur.orderCount += 1;
      cur.grossSales += Number(o.total || 0);
    }
    branchMap.set(stId, cur);
  }

  // Top selling products from order_items joined in memory
  const orderIds = bizOrders.map((o) => o.id);
  const topProducts: Array<{ productId: number; name: string; quantitySold: number; revenue: number }> = [];
  if (orderIds.length > 0) {
    const itemsRows = await db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds.slice(0, 500)));
    const bizProducts = await db.select().from(products).where(eq(products.businessId, bizId));
    const prodNameMap = new Map(bizProducts.map((p) => [p.id, p.name]));
    const prodAgg = new Map<number, { productId: number; name: string; quantitySold: number; revenue: number }>();
    for (const it of itemsRows) {
      const pid = Number(it.productId || 0);
      const cur = prodAgg.get(pid) || {
        productId: pid,
        name: prodNameMap.get(pid) || `Product #${pid}`,
        quantitySold: 0,
        revenue: 0,
      };
      cur.quantitySold += Number(it.quantity || 0);
      cur.revenue += Number(it.quantity || 0) * Number(it.unitPrice || 0);
      prodAgg.set(pid, cur);
    }
    topProducts.push(
      ...Array.from(prodAgg.values())
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 8)
    );
  }

  // Cash-up reconciliation stats
  const cuConditions = cleanStoreId
    ? and(eq(cashUps.businessId, bizId), eq(cashUps.storeId, cleanStoreId))
    : eq(cashUps.businessId, bizId);
  const bizCashUps = (await db.select().from(cashUps).where(cuConditions)).filter((cu) => inDateRange(cu.date));
  const totalCashUpVariance = bizCashUps.reduce((acc, cu) => acc + Number(cu.variance || 0), 0);

  // Recent mirrored Firestore -> SQL finalized events
  const evConditions = cleanStoreId
    ? and(eq(finalizedTransactionEvents.businessId, bizId), eq(finalizedTransactionEvents.storeId, cleanStoreId))
    : eq(finalizedTransactionEvents.businessId, bizId);
  const recentEvents = (
    await db
      .select()
      .from(finalizedTransactionEvents)
      .where(evConditions)
      .orderBy(desc(finalizedTransactionEvents.mirroredAt))
  )
    .filter((ev) => inDateRange(ev.occurredAt))
    .slice(0, 25);

  return {
    businessId: bizId,
    storeId: cleanStoreId || 'all',
    generatedAt: new Date().toISOString(),
    metrics: {
      completedOrderCount: completedOrders.length,
      refundOrderCount: refundedOrders.length,
      grossSales: Number(grossSales.toFixed(2)),
      refundTotal: Number(refundTotal.toFixed(2)),
      taxCollected: Number(taxCollected.toFixed(2)),
      discountsAllowed: Number(discountsAllowed.toFixed(2)),
      netRevenue: Number(netRevenue.toFixed(2)),
      cogsAmount: Number(totalCogs.toFixed(2)),
      grossProfit: Number(grossProfit.toFixed(2)),
      cashUpCount: bizCashUps.length,
      cashUpVariance: Number(totalCashUpVariance.toFixed(2)),
      mirroredEventCount: recentEvents.length,
    },
    paymentBreakdown: Array.from(pmMap.values()).sort((a, b) => b.total - a.total),
    branchBreakdown: Array.from(branchMap.values()).sort((a, b) => b.grossSales - a.grossSales),
    topProducts,
    recentEvents,
  };
}

export async function deleteBusinessFromCloudSql(businessId: string) {
  const cleanBizId = String(businessId || '').trim();
  if (!cleanBizId) {
    throw new Error('businessId is required to delete business from Cloud SQL.');
  }
  serverDeletedBusinessIds.add(cleanBizId);
  const bizPrefix = `${cleanBizId}::`;

  await db.delete(posSyncSnapshots).where(eq(posSyncSnapshots.businessId, cleanBizId));
  await db.delete(orderItems).where(eq(orderItems.businessId, cleanBizId));
  await db.delete(orders).where(eq(orders.businessId, cleanBizId));
  await db.delete(products).where(eq(products.businessId, cleanBizId));
  await db.delete(customers).where(eq(customers.businessId, cleanBizId));
  await db.delete(stores).where(eq(stores.businessId, cleanBizId));
  await db.delete(auditLogs).where(eq(auditLogs.businessId, cleanBizId));
  await db.delete(cashUps).where(eq(cashUps.businessId, cleanBizId));
  await db
    .delete(doubleEntryJournal)
    .where(
      sql`${doubleEntryJournal.businessId} = ${cleanBizId} OR LEFT(${doubleEntryJournal.id}, ${bizPrefix.length}) = ${bizPrefix}`
    );
  await db
    .delete(receiptRefundLedger)
    .where(
      sql`${receiptRefundLedger.businessId} = ${cleanBizId} OR LEFT(${receiptRefundLedger.id}, ${bizPrefix.length}) = ${bizPrefix}`
    );
  await db
    .delete(cashFlowLedger)
    .where(
      sql`${cashFlowLedger.businessId} = ${cleanBizId} OR LEFT(${cashFlowLedger.id}, ${bizPrefix.length}) = ${bizPrefix}`
    );
  await db
    .delete(paymentMethodLedger)
    .where(
      sql`${paymentMethodLedger.businessId} = ${cleanBizId} OR LEFT(${paymentMethodLedger.methodKey}, ${bizPrefix.length}) = ${bizPrefix}`
    );
  await db
    .delete(financialStatementsLedger)
    .where(
      sql`${financialStatementsLedger.businessId} = ${cleanBizId} OR LEFT(${financialStatementsLedger.statementKey}, ${bizPrefix.length}) = ${bizPrefix}`
    );
  await db
    .delete(finalizedTransactionEvents)
    .where(
      sql`${finalizedTransactionEvents.businessId} = ${cleanBizId} OR LEFT(${finalizedTransactionEvents.eventId}, ${bizPrefix.length}) = ${bizPrefix}`
    );
  await db.delete(businesses).where(eq(businesses.id, cleanBizId));

  // Scrub deleted businessId out of any remaining posSyncSnapshots JSON payloads
  try {
    const remainingSnaps = await db.select().from(posSyncSnapshots);
    for (const snap of remainingSnaps) {
      if (!snap.tablesJson || !snap.tablesJson.includes(cleanBizId)) continue;
      try {
        const parsed = JSON.parse(snap.tablesJson);
        const cleaned: Record<string, any[]> = {};
        for (const [tbl, rows] of Object.entries(parsed || {})) {
          if (!Array.isArray(rows)) continue;
          cleaned[tbl] = rows.filter(
            (r: any) =>
              String(r?.id || '').trim() !== cleanBizId &&
              String(r?.business_id || '').trim() !== cleanBizId
          );
        }
        await db
          .update(posSyncSnapshots)
          .set({ tablesJson: JSON.stringify(cleaned) })
          .where(eq(posSyncSnapshots.businessId, snap.businessId));
      } catch {}
    }
  } catch {}

  return {
    success: true,
    deletedBusinessId: cleanBizId,
    deletedAt: new Date().toISOString(),
  };
}
