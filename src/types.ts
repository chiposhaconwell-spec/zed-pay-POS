export interface Product {
  id: number;
  name: string;
  sku: string;
  category: string;
  price: number;
  cost: number;
  stock: number;
  imageUrl: string;
  is_service?: number; // 0 or 1
  batch_number?: string;
  expiry_date?: string;
}

export interface Customer {
  id: number;
  name: string;
  phone: string;
  email: string;
  loyalPoints: number;
  tpin?: string;
  zra_connected?: number; // 0 or 1
  tax_band?: string;
}

export interface Order {
  id: string;
  customerId: number | null;
  orderDate: string;
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  paymentMethod: string;
  status: string;
}

export interface OrderItem {
  id: number;
  orderId: string;
  productId: number;
  quantity: number;
  unitPrice: number;
}

export interface SqlLogEntry {
  id: string;
  sql: string;
  timestamp: string;
  description: string;
  affectedRows?: number;
  isError: boolean;
  errorMessage?: string;
  executionTimeMs: number;
}

export interface StoreSettings {
  storeName: string;
  currency: string;
  taxRate: number; // in percentage, e.g. 15 for 15%
  loyaltyRatio: number; // point per dollar spent
  receiptHeader: string;
  receiptFooter: string;
  paperWidth: '58mm' | '80mm';
  logoUrl?: string;
  tpin?: string;
  termsAndConditions?: string;
  printerName?: string;
  printerInterface?: string;
  printerStatus?: 'Linked' | 'Not Linked';
}

export type ActiveTab = 'billing' | 'inventory' | 'analytics' | 'customers' | 'settings' | 'console' | 'laybys' | 'attendance' | 'quotes' | 'loans' | 'finance' | 'workspace' | 'audit';

export interface Loan {
  id: string;
  merchant_id: string;
  loan_account_id: string;
  principal_amount: number;
  interest_amount: number;
  total_repayable: number;
  daily_deduction_percentage: number;
  status: 'PENDING_REVIEW' | 'APPROVED' | 'DISBURSED' | 'ACTIVE' | 'PAID_OFF' | 'DEFAULTED';
  disbursed_at: string | null;
  due_date: string;
  created_at: string;
  updated_at: string;
}

export interface LoanAmortizationSchedule {
  id: string;
  loan_id: string;
  installment_number: number;
  principal_due: number;
  interest_due: number;
  total_due: number;
  amount_paid: number;
  is_settled: number; // 0 or 1
  due_date: string;
  settled_at: string | null;
}

export interface AutomatedDeductionLog {
  id: string;
  loan_id: string;
  source_transaction_id: string | null;
  amount_deducted: number;
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
  failure_reason: string | null;
  created_at: string;
}
