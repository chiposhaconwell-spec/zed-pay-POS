import { relations } from 'drizzle-orm';
import { integer, numeric, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

// 1. Users table linked to Firebase Auth UID
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(), // Firebase Auth UID
  email: text('email').notNull(),
  displayName: text('display_name'),
  role: text('role').default('sales'),
  createdAt: timestamp('created_at').defaultNow(),
});

// 2. Businesses table
export const businesses = pgTable('businesses', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  owner: text('owner'),
  email: text('email'),
  password: text('password'),
  createdAt: timestamp('created_at').defaultNow(),
});

// 3. Stores / Branches table
export const stores = pgTable('stores', {
  id: text('id').primaryKey(),
  businessId: text('business_id'),
  name: text('name').notNull(),
  location: text('location'),
  allowDiscounts: integer('allow_discounts').default(1),
  allowRefunds: integer('allow_refunds').default(1),
  allowLaybys: integer('allow_laybys').default(1),
  requireManagerDiscount: integer('require_manager_discount').default(0),
  stocktakeFrequency: text('stocktake_frequency').default('weekly'),
});

// 4. Products table
export const products = pgTable('products', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  sku: text('sku').notNull().unique(),
  category: text('category'),
  price: numeric('price', { precision: 12, scale: 2 }).notNull(),
  cost: numeric('cost', { precision: 12, scale: 2 }).default('0.00'),
  stock: integer('stock').default(0),
  imageUrl: text('image_url'),
  businessId: text('business_id').default('default_biz'),
  isService: integer('is_service').default(0),
  batchNumber: text('batch_number'),
  expiryDate: text('expiry_date'),
});

// 5. Customers table
export const customers = pgTable('customers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  loyalPoints: integer('loyal_points').default(0),
  tpin: text('tpin'),
  zraConnected: integer('zra_connected').default(0),
  taxBand: text('tax_band').default('A - Standard Rate (16%)'),
  businessId: text('business_id').default('default_biz'),
});

// 6. Orders table
export const orders = pgTable('orders', {
  id: text('id').primaryKey(),
  customerId: integer('customer_id'),
  orderDate: text('order_date').notNull(),
  subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull(),
  tax: numeric('tax', { precision: 12, scale: 2 }).notNull(),
  discount: numeric('discount', { precision: 12, scale: 2 }).default('0.00'),
  total: numeric('total', { precision: 12, scale: 2 }).notNull(),
  paymentMethod: text('payment_method').notNull(),
  status: text('status').default('Completed'),
  storeId: text('store_id').default('lusaka'),
  performedBy: text('performed_by').default('owner'),
});

// 7. Order Items table
export const orderItems = pgTable('order_items', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull(),
  productId: integer('product_id').notNull(),
  quantity: integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
});

// 8. Audit Logs table
export const auditLogs = pgTable('audit_logs', {
  id: text('id').primaryKey(),
  module: text('module').notNull(),
  action: text('action').notNull(),
  details: text('details'),
  amount: numeric('amount', { precision: 12, scale: 2 }).default('0.00'),
  storeId: text('store_id').default('lusaka'),
  performedBy: text('performed_by'),
  createdAt: text('created_at'),
});

// 9. EOD Cash-Ups table
export const cashUps = pgTable('cash_ups', {
  id: text('id').primaryKey(),
  storeId: text('store_id').default('lusaka'),
  date: text('date').notNull(),
  expectedCash: numeric('expected_cash', { precision: 12, scale: 2 }).default('0.00'),
  actualCash: numeric('actual_cash', { precision: 12, scale: 2 }).default('0.00'),
  variance: numeric('variance', { precision: 12, scale: 2 }).default('0.00'),
  expectedCard: numeric('expected_card', { precision: 12, scale: 2 }).default('0.00'),
  expectedMobile: numeric('expected_mobile', { precision: 12, scale: 2 }).default('0.00'),
  status: text('status').default('LIVE'),
  performedBy: text('performed_by'),
  notes: text('notes'),
  createdAt: text('created_at'),
});

// 10. Double-Entry General Journal table
export const doubleEntryJournal = pgTable('double_entry_journal', {
  id: text('id').primaryKey(),
  entryDate: text('entry_date').notNull(),
  referenceId: text('reference_id'),
  module: text('module'),
  description: text('description'),
  debitAccount: text('debit_account').notNull(),
  creditAccount: text('credit_account').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  storeId: text('store_id').default('lusaka'),
  performedBy: text('performed_by'),
});

// 11. Receipt & Refund Ledger table
export const receiptRefundLedger = pgTable('receipt_refund_ledger', {
  id: text('id').primaryKey(),
  entryDate: text('entry_date').notNull(),
  txType: text('tx_type').notNull(),
  referenceId: text('reference_id').notNull(),
  customerName: text('customer_name'),
  paymentMethod: text('payment_method').notNull(),
  grossAmount: numeric('gross_amount', { precision: 12, scale: 2 }).default('0.00'),
  taxAmount: numeric('tax_amount', { precision: 12, scale: 2 }).default('0.00'),
  discountAmount: numeric('discount_amount', { precision: 12, scale: 2 }).default('0.00'),
  netRevenue: numeric('net_revenue', { precision: 12, scale: 2 }).default('0.00'),
  cogsAmount: numeric('cogs_amount', { precision: 12, scale: 2 }).default('0.00'),
  storeId: text('store_id').default('lusaka'),
  performedBy: text('performed_by'),
  status: text('status').default('Posted'),
  notes: text('notes'),
});

// 12. Cash Flow Statement Ledger table
export const cashFlowLedger = pgTable('cash_flow_ledger', {
  id: text('id').primaryKey(),
  entryDate: text('entry_date').notNull(),
  activityCategory: text('activity_category').notNull(),
  direction: text('direction').notNull(),
  paymentMethod: text('payment_method').notNull(),
  referenceId: text('reference_id'),
  description: text('description'),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  signedAmount: numeric('signed_amount', { precision: 12, scale: 2 }).notNull(),
  storeId: text('store_id').default('lusaka'),
  performedBy: text('performed_by'),
});

// 13. Cash by Payment Method Sub-Ledger table
export const paymentMethodLedger = pgTable('payment_method_ledger', {
  methodKey: text('method_key').primaryKey(),
  methodLabel: text('method_label').notNull(),
  accountCode: text('account_code').notNull(),
  grossInflows: numeric('gross_inflows', { precision: 12, scale: 2 }).default('0.00'),
  refundOutflows: numeric('refund_outflows', { precision: 12, scale: 2 }).default('0.00'),
  expenseOutflows: numeric('expense_outflows', { precision: 12, scale: 2 }).default('0.00'),
  netBalance: numeric('net_balance', { precision: 12, scale: 2 }).default('0.00'),
  txCount: integer('tx_count').default(0),
  updatedAt: text('updated_at'),
});

// 14. Financial Statements Snapshot (P&L, Balance Sheet, Cash Flow, EOD)
export const financialStatementsLedger = pgTable('financial_statements_ledger', {
  statementKey: text('statement_key').primaryKey(),
  statementType: text('statement_type').notNull(),
  section: text('section').notNull(),
  lineItem: text('line_item').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).default('0.00'),
  storeId: text('store_id').default('all'),
  updatedAt: text('updated_at'),
});

// 15. Full POS Multi-Table State Synchronization Snapshot table
export const posSyncSnapshots = pgTable('pos_sync_snapshots', {
  businessId: text('business_id').primaryKey(),
  businessName: text('business_name'),
  ownerEmail: text('owner_email'),
  tablesJson: text('tables_json').notNull(),
  settingsJson: text('settings_json'),
  updatedAt: text('updated_at').notNull(),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  orders: many(orders),
}));

export const businessesRelations = relations(businesses, ({ many }) => ({
  stores: many(stores),
  products: many(products),
  customers: many(customers),
}));

export const storesRelations = relations(stores, ({ one, many }) => ({
  business: one(businesses, {
    fields: [stores.businessId],
    references: [businesses.id],
  }),
  orders: many(orders),
  cashUps: many(cashUps),
  journalEntries: many(doubleEntryJournal),
  receiptRefundEntries: many(receiptRefundLedger),
  cashFlowEntries: many(cashFlowLedger),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  business: one(businesses, {
    fields: [products.businessId],
    references: [businesses.id],
  }),
  orderItems: many(orderItems),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  business: one(businesses, {
    fields: [customers.businessId],
    references: [businesses.id],
  }),
  orders: many(orders),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, {
    fields: [orders.customerId],
    references: [customers.id],
  }),
  store: one(stores, {
    fields: [orders.storeId],
    references: [stores.id],
  }),
  items: many(orderItems),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
  product: one(products, {
    fields: [orderItems.productId],
    references: [products.id],
  }),
}));

export const cashUpsRelations = relations(cashUps, ({ one }) => ({
  store: one(stores, {
    fields: [cashUps.storeId],
    references: [stores.id],
  }),
}));

export const doubleEntryJournalRelations = relations(doubleEntryJournal, ({ one }) => ({
  store: one(stores, {
    fields: [doubleEntryJournal.storeId],
    references: [stores.id],
  }),
}));

export const receiptRefundLedgerRelations = relations(receiptRefundLedger, ({ one }) => ({
  store: one(stores, {
    fields: [receiptRefundLedger.storeId],
    references: [stores.id],
  }),
}));

export const cashFlowLedgerRelations = relations(cashFlowLedger, ({ one }) => ({
  store: one(stores, {
    fields: [cashFlowLedger.storeId],
    references: [stores.id],
  }),
}));


