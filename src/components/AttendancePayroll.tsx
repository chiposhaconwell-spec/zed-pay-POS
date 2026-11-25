import React, { useState, useEffect, useMemo } from 'react';
import {
  runSql,
  persistTablesToStorage,
  getActiveBusinessId,
  getActiveStoreId,
  sqlEsc,
  ensurePayrollEntriesTable,
  syncAllAccountingSystems,
  logEmployeeAudit,
  getAllSelectableAccounts,
  upsertUserAndMembership,
  syncUsersAndMembershipsFromLegacyTables,
  pushDatabaseToServer,
} from '../db';
import {
  auth,
  syncStaffAndMembershipsToCloud,
  revokeCredentialMembershipInCloud,
} from '../firebase';
import { computeCredentialHashSync, normalizeAuthEmail } from '../multiTenantAuth';
import { exportAndSharePdf } from '../androidUtils';
import { jsPDF } from 'jspdf';
import { DEFAULT_COMPANY_LOGO } from '../App';
import {
  Users,
  Clock,
  Printer,
  Search,
  Play,
  Square,
  Calculator,
  DollarSign,
  Layers,
  Plus,
  Coins,
  FileText,
  Upload,
  Shield,
  Trash,
  Edit,
  Eye,
  Download,
  CheckSquare,
  X,
  Banknote,
  PlusCircle,
  MinusCircle,
  CheckCircle2,
  Calendar,
  RefreshCw,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { StoreSettings } from '../types';

interface AttendancePayrollProps {
  settings: StoreSettings;
  userRole?: string;
  activeStore?: string;
}

interface TimesheetRecord {
  id: string;
  employee_name: string;
  employee_role: string;
  date: string;
  clock_in: string;
  clock_out: string | null;
  hours_worked: number;
  hourly_rate: number;
  gross_payment: number;
  status: 'PENDING' | 'PAID';
}

export interface PayrollLineItem {
  id: string;
  category: string;
  description: string;
  amount: number;
}

export interface PayrollEntry {
  id: string;
  staff_id: string;
  employee_name: string;
  employee_role: string;
  pay_period: string;
  payment_date: string;
  basic_salary: number;
  additions: PayrollLineItem[];
  deductions: PayrollLineItem[];
  total_additions: number;
  total_deductions: number;
  gross_salary: number;
  net_salary: number;
  payment_account_id: string;
  status: 'DRAFT' | 'PAID';
  notes: string;
  created_at: string;
  updated_at: string;
  store_id: string;
}

const ADDITION_CATEGORIES = [
  'Bonus',
  'Housing Allowance',
  'Transport Allowance',
  'Overtime Pay',
  'Sales Commission',
  'Meal / Airtime Allowance',
  'Leave Encashment',
  'Other Addition',
];

const DEDUCTION_CATEGORIES = [
  'Salary Advance',
  'PAYE Income Tax',
  'NAPSA Pension',
  'NHIMA Health',
  'Staff Loan Repayment',
  'Absence / Late Deduction',
  'Shortage / Damage Recovery',
  'Other Deduction',
];

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

const formatPayPeriodLabel = (ym: string) => {
  const parts = String(ym || '').split('-');
  if (parts.length !== 2) return ym || 'Current Period';
  const y = Number(parts[0]);
  const m = Number(parts[1]) - 1;
  const d = new Date(y, m, 1);
  if (isNaN(d.getTime())) return ym;
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
};

export default function AttendancePayroll({ settings, userRole = 'owner', activeStore }: AttendancePayrollProps) {
  const [records, setRecords] = useState<TimesheetRecord[]>([]);
  const [employeeNameInput, setEmployeeNameInput] = useState('');
  const [employeeRoleInput, setEmployeeRoleInput] = useState('Sales Person');
  const [hourlyRateInput, setHourlyRateInput] = useState('25.00');
  const [selectedStaff, setSelectedStaff] = useState<string>('');
  
  // Navigation & detailed staff views hooks
  const [activeSubTab, setActiveSubTab] = useState<'clock' | 'payroll' | 'roster'>('payroll');
  const [staffList, setStaffList] = useState<any[]>([]);
  const [editingStaffId, setEditingStaffId] = useState<string | null>(null);
  const [showRegisterModal, setShowRegisterModal] = useState(false);
  const [viewingStaffDetail, setViewingStaffDetail] = useState<any | null>(null);

  // Payroll Management state
  const [selectedPayPeriod, setSelectedPayPeriod] = useState<string>(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [payrollEntries, setPayrollEntries] = useState<PayrollEntry[]>([]);
  const [payrollSearch, setPayrollSearch] = useState('');
  const [payrollStatusFilter, setPayrollStatusFilter] = useState<'ALL' | 'DRAFT' | 'PAID'>('ALL');
  const [payrollFeedback, setPayrollFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [selectableAccounts, setSelectableAccounts] = useState(() => getAllSelectableAccounts());

  // Add / Deduct Salary Modal states
  const [editingPayroll, setEditingPayroll] = useState<PayrollEntry | null>(null);
  const [draftBasicSalary, setDraftBasicSalary] = useState('');
  const [draftAdditions, setDraftAdditions] = useState<PayrollLineItem[]>([]);
  const [draftDeductions, setDraftDeductions] = useState<PayrollLineItem[]>([]);
  const [draftPayAccount, setDraftPayAccount] = useState('acc_bank');
  const [draftPayDate, setDraftPayDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [draftNotes, setDraftNotes] = useState('');

  // Quick Add / Deduct item inputs inside editor
  const [newAddCategory, setNewAddCategory] = useState(ADDITION_CATEGORIES[0]);
  const [newAddDescription, setNewAddDescription] = useState('');
  const [newAddAmount, setNewAddAmount] = useState('');
  const [newDedCategory, setNewDedCategory] = useState(DEDUCTION_CATEGORIES[0]);
  const [newDedDescription, setNewDedDescription] = useState('');
  const [newDedAmount, setNewDedAmount] = useState('');

  // Add custom/ad-hoc employee payroll modal
  const [showAddCustomPayrollModal, setShowAddCustomPayrollModal] = useState(false);
  const [customEmpName, setCustomEmpName] = useState('');
  const [customEmpRole, setCustomEmpRole] = useState('Sales Person');
  const [customEmpSalary, setCustomEmpSalary] = useState('5000');

  // In-UI confirm modal
  const [payrollConfirmAction, setPayrollConfirmAction] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    tone: 'emerald' | 'rose';
    onConfirm: () => void;
  } | null>(null);

  // Form states matching full requirements
  const [firstName, setFirstName] = useState('');
  const [surname, setSurname] = useState('');
  const [contact, setContact] = useState('');
  const [email, setEmail] = useState('');
  const [resAddress, setResAddress] = useState('');
  const [joiningDate, setJoiningDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [basicSalary, setBasicSalary] = useState('8000');
  
  // File attachments state (stored as base64 strings dynamically)
  const [nrcFile, setNrcFile] = useState('');
  const [nrcFilename, setNrcFilename] = useState('');
  const [contractFile, setContractFile] = useState('');
  const [contractFilename, setContractFilename] = useState('');
  const [password, setPassword] = useState('1234');

  // Checklist Permission Matrices conforming precisely to user specifications
  const DEFAULT_PERMS = {
    sales: { discount: true, gift: false, add_charges: false, give_credit: false },
    inventory: { view_only: true, create: false, edit: false },
    customer: { view_only: true, create: false, edit: false },
    reports: { low_stock: false, expired_stock: false, profits: false, sales: false, payment_modes: false, sold_by: false, top_customers: false },
    expense: { add_expense: false, modify_expense: false },
    settings: { create_store: false, manage_settings: false },
    staff: { attendance_management: false, payroll_management: false, manage_staff: false },
    receipt: { create_receipt: true, view_all_receipt: true, edit_receipt: false, return_receipt: false }
  };
  const [perms, setPerms] = useState(DEFAULT_PERMS);
  const [extraPermsMeta, setExtraPermsMeta] = useState<Record<string, any>>({});
  
  // Quick clock in / out selections
  const [quickName, setQuickName] = useState('');
  const [successNote, setSuccessNote] = useState('');

  // Active employees list unique (linked dynamically to staff on load)
  const [employeeList, setEmployeeList] = useState<{name: string, role: string, rate: number}[]>([]);

  const loadStaffMembers = () => {
    const activeBizId = getActiveBusinessId();
    if (activeBizId) {
      syncUsersAndMembershipsFromLegacyTables(activeBizId);
    }
    const bizCond = activeBizId ? `business_id = '${sqlEsc(activeBizId)}'` : `(business_id IS NULL OR business_id = '')`;
    const res = runSql(`SELECT * FROM staff WHERE ${bizCond}`, 'Staff: Fetch all registered profiles');
    if (res.success && Array.isArray(res.data)) {
      setStaffList(res.data);
      
      if (res.data.length > 0) {
        // Feed into employeeList dynamically for clock-in dropdown options
        const clockable = res.data.map((st: any) => ({
          name: `${st.first_name} ${st.surname}`,
          role: st.basic_salary > 10000 ? 'Store Manager' : 'Sales Person',
          rate: Math.round(parseFloat(st.basic_salary || '8000') / 160) // approx hourly rate estimator
        }));
        setEmployeeList(clockable);
        // Sync quick clock-in default selection
        const hasMatched = clockable.some(c => c.name === quickName);
        if (!hasMatched) {
          setQuickName(clockable[0].name);
        }
      }
    }
  };

  const loadAttendance = () => {
    const activeBizId = getActiveBusinessId();
    const bizCond = activeBizId ? `business_id = '${sqlEsc(activeBizId)}'` : `(business_id IS NULL OR business_id = '')`;
    const res = runSql(`SELECT * FROM time_attendance WHERE ${bizCond} ORDER BY date DESC, clock_in DESC`, 'Attendance: Retrieve worktimes cards');
    if (res.success && Array.isArray(res.data)) {
      setRecords(res.data);
      
      // Also update lists
      const uniqueNames: Record<string, typeof employeeList[0]> = {};
      employeeList.forEach(e => { uniqueNames[e.name] = e; });
      
      res.data.forEach((r: any) => {
        if (!uniqueNames[r.employee_name]) {
          uniqueNames[r.employee_name] = {
            name: r.employee_name,
            role: r.employee_role,
            rate: r.hourly_rate
          };
        }
      });
      setEmployeeList(Object.values(uniqueNames));
    }
  };

  const notifyPayroll = (type: 'success' | 'error', text: string) => {
    setPayrollFeedback({ type, text });
    setTimeout(() => setPayrollFeedback(null), 4500);
  };

  const parseLineItemsJson = (raw: any): PayrollLineItem[] => {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        return parsed.map((item: any, idx: number) => ({
          id: String(item.id || `li-${idx}-${Date.now()}`),
          category: String(item.category || 'Adjustment'),
          description: String(item.description || item.category || 'Adjustment'),
          amount: Math.max(0, Number(item.amount || 0)),
        }));
      }
    } catch {}
    return [];
  };

  const loadPayrollEntries = (periodOverride?: string, syncStaffList?: any[]) => {
    ensurePayrollEntriesTable();
    const period = periodOverride || selectedPayPeriod;
    const activeBizId = getActiveBusinessId();
    const resolvedStoreId = getActiveStoreId(activeStore, activeBizId);
    const bizCond = activeBizId ? `business_id = '${sqlEsc(activeBizId)}'` : `(business_id IS NULL OR business_id = '')`;

    // Optionally seed DRAFT entries for any registered staff missing for this period
    const roster = syncStaffList || staffList;
    if (Array.isArray(roster) && roster.length > 0) {
      const existingRes = runSql(
        `SELECT staff_id, employee_name FROM payroll_entries WHERE ${bizCond} AND pay_period = '${sqlEsc(period)}'`,
        'Payroll: Check existing period entries',
        true
      );
      const existingRows = existingRes.success && Array.isArray(existingRes.data) ? existingRes.data : [];
      const existingStaffIds = new Set(existingRows.map((r: any) => String(r.staff_id || '')));
      const existingNames = new Set(existingRows.map((r: any) => String(r.employee_name || '').toLowerCase().trim()));
      let insertedAny = false;

      roster.forEach((st: any) => {
        const sid = String(st.id || '');
        const fullName = `${st.first_name || st.name || 'Staff'} ${st.surname || ''}`.trim();
        if ((sid && existingStaffIds.has(sid)) || existingNames.has(fullName.toLowerCase())) {
          return;
        }
        const basic = Math.max(0, Number(st.basic_salary ?? 0));
        const roleLabel =
          String(st.role || '').trim() || (basic > 10000 ? 'Store Manager' : 'Staff Member');
        const entryId = `PAY-${period.replace(/[^0-9]/g, '')}-${sid.replace(/[^a-zA-Z0-9_-]/g, '') || Math.floor(1000 + Math.random() * 9000)}`;
        const nowIso = new Date().toISOString();
        const stStore = String(st.store_id || resolvedStoreId);
        runSql(
          `INSERT INTO payroll_entries (id, staff_id, employee_name, employee_role, pay_period, payment_date, basic_salary, additions_json, deductions_json, total_additions, total_deductions, gross_salary, net_salary, payment_account_id, status, notes, created_at, updated_at, business_id, store_id) VALUES (
            '${sqlEsc(entryId)}',
            '${sqlEsc(sid)}',
            '${sqlEsc(fullName)}',
            '${sqlEsc(roleLabel)}',
            '${sqlEsc(period)}',
            '${nowIso.split('T')[0]}',
            ${basic},
            '[]',
            '[]',
            0,
            0,
            ${basic},
            ${basic},
            'acc_bank',
            'DRAFT',
            '',
            '${nowIso}',
            '${nowIso}',
            '${sqlEsc(activeBizId)}',
            '${sqlEsc(stStore)}'
          )`,
          `Payroll: Initialize draft payslip for ${fullName}`,
          true
        );
        insertedAny = true;
      });
      if (insertedAny) {
        persistTablesToStorage();
      }
    }

    const res = runSql(
      `SELECT * FROM payroll_entries WHERE ${bizCond} AND pay_period = '${sqlEsc(period)}' ORDER BY employee_name ASC`,
      'Payroll: Fetch period entries',
      true
    );
    if (res.success && Array.isArray(res.data)) {
      const parsed: PayrollEntry[] = res.data.map((r: any) => {
        const additions = parseLineItemsJson(r.additions_json);
        const deductions = parseLineItemsJson(r.deductions_json);
        const basic = Number(r.basic_salary || 0);
        const totalAdd = additions.reduce((s, x) => s + x.amount, 0);
        const totalDed = deductions.reduce((s, x) => s + x.amount, 0);
        const gross = basic + totalAdd;
        const net = gross - totalDed;
        return {
          id: String(r.id),
          staff_id: String(r.staff_id || ''),
          employee_name: String(r.employee_name || 'Employee'),
          employee_role: String(r.employee_role || 'Staff'),
          pay_period: String(r.pay_period || period),
          payment_date: String(r.payment_date || new Date().toISOString().split('T')[0]),
          basic_salary: basic,
          additions,
          deductions,
          total_additions: totalAdd,
          total_deductions: totalDed,
          gross_salary: gross,
          net_salary: net,
          payment_account_id: String(r.payment_account_id || 'acc_bank'),
          status: r.status === 'PAID' ? 'PAID' : 'DRAFT',
          notes: String(r.notes || ''),
          created_at: String(r.created_at || ''),
          updated_at: String(r.updated_at || ''),
          store_id: String(r.store_id || resolvedStoreId),
        };
      });
      setPayrollEntries(parsed);
    } else {
      setPayrollEntries([]);
    }
  };

  useEffect(() => {
    ensurePayrollEntriesTable();
    loadAttendance();
    loadStaffMembers();
    setSelectableAccounts(getAllSelectableAccounts());

    const handleRefresh = () => {
      loadAttendance();
      loadStaffMembers();
      loadPayrollEntries();
      setSelectableAccounts(getAllSelectableAccounts());
    };
    window.addEventListener('pos_data_updated', handleRefresh);
    window.addEventListener('local_db_restored', handleRefresh);
    window.addEventListener('database-rehydrated', handleRefresh);
    return () => {
      window.removeEventListener('pos_data_updated', handleRefresh);
      window.removeEventListener('local_db_restored', handleRefresh);
      window.removeEventListener('database-rehydrated', handleRefresh);
    };
  }, []);

  useEffect(() => {
    loadPayrollEntries(selectedPayPeriod, staffList);
  }, [selectedPayPeriod, staffList.length]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, fileType: 'nrc' | 'contract') => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result as string;
      if (fileType === 'nrc') {
        setNrcFile(base64);
        setNrcFilename(file.name);
      } else {
        setContractFile(base64);
        setContractFilename(file.name);
      }
    };
    reader.readAsDataURL(file);
  };

  const resetForm = () => {
    setFirstName('');
    setSurname('');
    setContact('');
    setEmail('');
    setResAddress('');
    setJoiningDate(new Date().toISOString().split('T')[0]);
    setBasicSalary('8000');
    setPassword('1234');
    setNrcFile('');
    setNrcFilename('');
    setContractFile('');
    setContractFilename('');
    setEditingStaffId(null);
    setPerms(DEFAULT_PERMS);
    setExtraPermsMeta({});
  };

  const handleSaveStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (userRole === 'sales') {
      notifyPayroll('error', 'Access Denied: Only Business Owners or Store Managers can configure staff accounts.');
      return;
    }

    const cleanFirst = firstName.trim();
    const cleanSurname = surname.trim();
    const cleanContact = contact.trim();
    const cleanEmail = normalizeAuthEmail(email);

    if (!cleanFirst || !cleanSurname || !cleanContact || !cleanEmail) {
      notifyPayroll('error', 'Please fill out first name, surname, contact, and email address.');
      return;
    }

    const salaryNum = parseFloat(basicSalary) || 0;
    const rawPass = String(password || '').trim() || '1234';
    const fullStaffName = `${cleanFirst} ${cleanSurname}`.trim();
    const activeBizId = getActiveBusinessId();
    const activeStoreId = getActiveStoreId(activeStore, activeBizId);
    const derivedRole: 'manager' | 'sales' =
      extraPermsMeta?.role === 'manager' || perms.staff?.manage_staff || perms.settings?.manage_settings
        ? 'manager'
        : 'sales';
    const accessibleBranches: string[] =
      Array.isArray(extraPermsMeta?.accessible_branches) && extraPermsMeta.accessible_branches.length > 0
        ? extraPermsMeta.accessible_branches
        : [activeStoreId];
    const isSuspended = Boolean(extraPermsMeta?.suspended);

    const permissionsString = JSON.stringify({
      ...extraPermsMeta,
      ...perms,
      role: derivedRole,
      password: rawPass,
      accessible_branches: accessibleBranches,
      suspended: isSuspended,
    });
    const staffId = editingStaffId || `staff-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
    const bizMatch = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';

    let saveRes: { success: boolean; error?: string };
    if (editingStaffId) {
      const sql = `
        UPDATE staff 
        SET name = '${sqlEsc(fullStaffName)}',
            role = '${sqlEsc(derivedRole)}',
            pin = '${sqlEsc(rawPass.slice(0, 6))}',
            first_name = '${sqlEsc(cleanFirst)}',
            surname = '${sqlEsc(cleanSurname)}',
            contact = '${sqlEsc(cleanContact)}',
            email = '${sqlEsc(cleanEmail)}',
            residential_address = '${sqlEsc(resAddress.trim())}',
            joining_date = '${sqlEsc(joiningDate)}',
            nrc_file = '${sqlEsc(nrcFile)}',
            nrc_filename = '${sqlEsc(nrcFilename)}',
            contract_file = '${sqlEsc(contractFile)}',
            contract_filename = '${sqlEsc(contractFilename)}',
            basic_salary = ${salaryNum},
            permissions_json = '${sqlEsc(permissionsString)}',
            password = '${sqlEsc(rawPass)}'
        WHERE id = '${sqlEsc(editingStaffId)}'${bizMatch}
      `;
      saveRes = runSql(sql, `Staff: Update profile ${staffId}`);
    } else {
      const sql = `
        INSERT INTO staff (id, name, role, hourly_rate, pin, store_id, first_name, surname, contact, email, residential_address, joining_date, nrc_file, nrc_filename, contract_file, contract_filename, basic_salary, permissions_json, business_id, password)
        VALUES (
          '${sqlEsc(staffId)}',
          '${sqlEsc(fullStaffName)}',
          '${sqlEsc(derivedRole)}',
          ${Math.round(salaryNum / 160) || 0},
          '${sqlEsc(rawPass.slice(0, 6))}',
          '${sqlEsc(activeStoreId)}',
          '${sqlEsc(cleanFirst)}',
          '${sqlEsc(cleanSurname)}',
          '${sqlEsc(cleanContact)}',
          '${sqlEsc(cleanEmail)}',
          '${sqlEsc(resAddress.trim())}',
          '${sqlEsc(joiningDate)}',
          '${sqlEsc(nrcFile)}',
          '${sqlEsc(nrcFilename)}',
          '${sqlEsc(contractFile)}',
          '${sqlEsc(contractFilename)}',
          ${salaryNum},
          '${sqlEsc(permissionsString)}',
          '${sqlEsc(activeBizId)}',
          '${sqlEsc(rawPass)}'
        )
      `;
      saveRes = runSql(sql, `Staff: Onboard new profile ${staffId}`);
    }

    if (!saveRes.success) {
      notifyPayroll('error', `Could not save staff account: ${saveRes.error || 'Database error'}`);
      return;
    }

    if (activeBizId) {
      upsertUserAndMembership({
        id: `mem_staff_${staffId}_${activeBizId}`,
        businessId: activeBizId,
        email: cleanEmail,
        fullName: fullStaffName,
        password: rawPass,
        credentialHash: computeCredentialHashSync(cleanEmail, rawPass),
        role: derivedRole,
        storeId: accessibleBranches[0] || activeStoreId,
        accessibleBranches,
        permissionsJson: permissionsString,
        status: isSuspended ? 'SUSPENDED' : 'ACTIVE',
      });
    }

    const wasEditing = Boolean(editingStaffId);
    resetForm();
    setShowRegisterModal(false);
    loadStaffMembers();
    persistTablesToStorage();
    window.dispatchEvent(new Event('pos_data_updated'));

    notifyPayroll(
      'success',
      wasEditing
        ? `Updated ${fullStaffName} locally — syncing to cloud...`
        : `Registered ${fullStaffName} locally — syncing to cloud...`
    );

    if (activeBizId) {
      const [fbSyncRes, sqlPushRes] = await Promise.all([
        syncStaffAndMembershipsToCloud(activeBizId).catch(() => ({ success: false, details: '' })),
        pushDatabaseToServer(activeBizId).catch(() => ({ success: false, details: '' })),
      ]);
      if (fbSyncRes.success || sqlPushRes.success) {
        notifyPayroll(
          'success',
          wasEditing
            ? `✓ Updated & saved ${fullStaffName} to cloud.`
            : `✓ Onboarded & saved ${fullStaffName} to cloud.`
        );
      }
    }
  };

  const handleEditStaff = (st: any) => {
    setEditingStaffId(st.id);
    setFirstName(st.first_name || st.name || '');
    setSurname(st.surname || '');
    setContact(st.contact || '');
    setEmail(st.email || '');
    setResAddress(st.residential_address || '');
    setJoiningDate(st.joining_date || new Date().toISOString().split('T')[0]);
    setBasicSalary(String(st.basic_salary ?? '0'));
    setPassword(st.password || '1234');
    setNrcFile(st.nrc_file || '');
    setNrcFilename(st.nrc_filename || '');
    setContractFile(st.contract_file || '');
    setContractFilename(st.contract_filename || '');
    try {
      const raw = st.permissions_json ? JSON.parse(st.permissions_json) : null;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const isObj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
        setPerms({
          sales: { ...DEFAULT_PERMS.sales, ...(isObj(raw.sales) ? raw.sales : {}) },
          inventory: { ...DEFAULT_PERMS.inventory, ...(isObj(raw.inventory) ? raw.inventory : {}) },
          customer: { ...DEFAULT_PERMS.customer, ...(isObj(raw.customer) ? raw.customer : {}) },
          reports: { ...DEFAULT_PERMS.reports, ...(isObj(raw.reports) ? raw.reports : {}) },
          expense: { ...DEFAULT_PERMS.expense, ...(isObj(raw.expense) ? raw.expense : {}) },
          settings: { ...DEFAULT_PERMS.settings, ...(isObj(raw.settings) ? raw.settings : {}) },
          staff: { ...DEFAULT_PERMS.staff, ...(isObj(raw.staff) ? raw.staff : {}) },
          receipt: { ...DEFAULT_PERMS.receipt, ...(isObj(raw.receipt) ? raw.receipt : {}) }
        });
        const { sales: _s, inventory: _i, customer: _c, reports: _r, expense: _e, settings: _st, staff: _sf, receipt: _rc, ...restMeta } = raw;
        setExtraPermsMeta(restMeta);
      } else {
        setPerms(DEFAULT_PERMS);
        setExtraPermsMeta({});
      }
    } catch (e) {
      console.error(e);
      setPerms(DEFAULT_PERMS);
      setExtraPermsMeta({});
    }
    setShowRegisterModal(true);
  };

  const handleDeleteStaff = (id: string, name: string, staffEmail?: string, staffPassword?: string) => {
    if (userRole === 'sales') {
      notifyPayroll('error', 'Access Denied: Only Business Owners or Managers can remove staff accounts.');
      return;
    }
    setPayrollConfirmAction({
      title: 'Delete Staff Account',
      message: `Are you sure you want to delete "${name}"? This removes their login credentials locally and from the cloud.`,
      confirmLabel: 'Delete Staff',
      tone: 'rose',
      onConfirm: () => {
        setPayrollConfirmAction(null);
        const activeBizId = getActiveBusinessId();
        const bizMatch = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
        const cleanEmail = normalizeAuthEmail(staffEmail || '');
        const res = runSql(`DELETE FROM staff WHERE id = '${sqlEsc(id)}'${bizMatch}`, `Staff: Delete profile ${id}`);
        if (res.success) {
          if (activeBizId && cleanEmail) {
            runSql(
              `DELETE FROM business_memberships WHERE business_id = '${sqlEsc(activeBizId)}' AND LOWER(email) = '${sqlEsc(cleanEmail)}'`,
              `Staff: Delete membership for ${cleanEmail}`
            );
          }
          loadStaffMembers();
          persistTablesToStorage();
          window.dispatchEvent(new Event('pos_data_updated'));
          notifyPayroll('success', `Deleted staff member ${name} — syncing removal to cloud...`);

          if (activeBizId) {
            void Promise.all([
              auth.currentUser && cleanEmail
                ? revokeCredentialMembershipInCloud({
                    businessId: activeBizId,
                    membershipId: `mem_staff_${id}_${activeBizId}`,
                    email: cleanEmail,
                    password: staffPassword || undefined,
                  }).catch(() => {})
                : Promise.resolve(),
              syncStaffAndMembershipsToCloud(activeBizId).catch(() => ({ success: false })),
              pushDatabaseToServer(activeBizId).catch(() => ({ success: false })),
            ]).then(() => {
              notifyPayroll('success', `✓ Removed ${name} locally & from cloud.`);
            });
          }
        }
      },
    });
  };

  // Helper trigger action helper to download encoded attachments
  const handleDownloadBase64 = (base64Data: string, filename: string) => {
    if (!base64Data) return;
    const link = document.createElement('a');
    link.href = base64Data;
    link.download = filename || 'attachment';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleRegisterEmployee = (e: React.FormEvent) => {
    e.preventDefault();
    if (userRole === 'sales') {
      alert('Access Denied: Only Store Manager or Business Owner can register new duty staff.');
      return;
    }
    if (!employeeNameInput) return;
    
    const rateNum = parseFloat(hourlyRateInput) || 20.00;
    const newList = [...employeeList, { name: employeeNameInput, role: employeeRoleInput, rate: rateNum }];
    setEmployeeList(newList);
    setQuickName(employeeNameInput);
    setEmployeeNameInput('');
    alert(`Registered employee ${employeeNameInput} in local terminal session.`);
  };

  const handleClockIn = () => {
    const matched = employeeList.find(x => x.name === quickName);
    const role = matched ? matched.role : 'Sales Person';
    const rate = matched ? matched.rate : 25.00;

    const todayStr = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toTimeString().split(' ')[0]; // HH:MM:SS

    const activeBizId = getActiveBusinessId();
    const activeStoreId = getActiveStoreId(undefined, activeBizId);
    const bizMatch = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';

    // Check if player has already checked in and not checked out yet today
    const activeRes = runSql(`
      SELECT * FROM time_attendance 
      WHERE employee_name = '${quickName.replace(/'/g, "''")}' AND clock_out IS NULL${bizMatch}
    `, 'Attendance: Guard active shifts');

    if (activeRes.success && activeRes.data && activeRes.data.length > 0) {
      alert(`Access Warning: Employee ${quickName} has an active clocked-in session currently! Please clock out first.`);
      return;
    }

    const recId = 'attend-' + Math.floor(1000 + Math.random() * 9000);
    const insertSql = `
      INSERT INTO time_attendance (id, employee_name, employee_role, date, clock_in, clock_out, hours_worked, hourly_rate, gross_payment, status, business_id, store_id)
      VALUES (
        '${recId}',
        '${quickName.replace(/'/g, "''")}',
        '${sqlEsc(role)}',
        '${todayStr}',
        '${timeStr}',
        NULL,
        0,
        ${rate},
        0,
        'PENDING',
        '${sqlEsc(activeBizId)}',
        '${sqlEsc(activeStoreId)}'
      )
    `;
    const res = runSql(insertSql, `Attendance: Clock-In employee ${quickName} at ${timeStr}`);
    if (res.success) {
      setSuccessNote(`✓ ${quickName} CLOCKED IN successfully at ${timeStr}!`);
      setTimeout(() => setSuccessNote(''), 4000);
      loadAttendance();
      persistTablesToStorage();
    }
  };

  const handleClockOut = (recordId: string) => {
    const timeStr = new Date().toTimeString().split(' ')[0]; // HH:MM:SS
    
    // Fetch clock in details
    const recArr = records.filter(x => x.id === recordId);
    if (recArr.length === 0) return;
    const r = recArr[0];

    // Calculate approximate elapsed hours
    const cIn = r.clock_in.split(':');
    const cOut = timeStr.split(':');
    const inMin = parseInt(cIn[0]) * 60 + parseInt(cIn[1]);
    const outMin = parseInt(cOut[0]) * 60 + parseInt(cOut[1]);
    
    let diffHours = parseFloat(((outMin - inMin) / 60).toFixed(2));
    if (diffHours <= 0) diffHours = 0.5; // minimum safety half-hour

    const gross = parseFloat((diffHours * r.hourly_rate).toFixed(2));
    const activeBizId = getActiveBusinessId();
    const bizMatch = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';

    const updateSql = `
      UPDATE time_attendance 
      SET clock_out = '${timeStr}', hours_worked = ${diffHours}, gross_payment = ${gross} 
      WHERE id = '${sqlEsc(recordId)}'${bizMatch}
    `;
    const res = runSql(updateSql, `Attendance: Clock-Out shift record ${recordId} at ${timeStr}`);
    if (res.success) {
      setSuccessNote(`✓ ${r.employee_name} CLOCKED OUT! Elapsed hours: ${diffHours} hrs, Gross wage: K${gross}`);
      setTimeout(() => setSuccessNote(''), 4000);
      loadAttendance();
      persistTablesToStorage();
    }
  };

  const handleMarkAsPaid = (employeeName: string) => {
    if (userRole === 'sales') {
      alert('Access Denied: Only Store Manager or Business Owner can approve and clear payroll payouts.');
      return;
    }
    const activeBizId = getActiveBusinessId();
    const bizMatch = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
    const updateSql = `
      UPDATE time_attendance 
      SET status = 'PAID' 
      WHERE employee_name = '${employeeName.replace(/'/g, "''")}' AND status = 'PENDING' AND clock_out IS NOT NULL${bizMatch}
    `;
    const res = runSql(updateSql, `Payroll: Clear accumulated outstanding salary payouts to ${employeeName}`);
    if (res.success) {
      alert(`Wages payout cleared successfully for ${employeeName}. Transactions logged in SQL.`);
      loadAttendance();
      persistTablesToStorage();
    }
  };

  // Grouped stats by Employee for payroll dashboard
  const payrollSummary = records.reduce((acc, current) => {
    if (!acc[current.employee_name]) {
      acc[current.employee_name] = {
        name: current.employee_name,
        role: current.employee_role,
        pendingWages: 0,
        paidWages: 0,
        totalHours: 0,
        shiftsCount: 0
      };
    }
    const target = acc[current.employee_name];
    target.shiftsCount += 1;
    target.totalHours += current.hours_worked;
    if (current.status === 'PENDING') {
      target.pendingWages += current.gross_payment;
    } else {
      target.paidWages += current.gross_payment;
    }
    return acc;
  }, {} as Record<string, any>);

  const totalCompanyOutstandingPayroll: number = Object.values(payrollSummary).reduce((sum: number, item: any) => sum + item.pendingWages, 0) as number;

  const handleSyncBasicSalariesFromStaff = () => {
    if (userRole === 'sales') {
      notifyPayroll('error', 'Access Denied: Only Business Owners or Store Managers can sync payroll.');
      return;
    }
    const activeBizId = getActiveBusinessId();
    const bizCond = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
    let updatedCount = 0;

    staffList.forEach((st: any) => {
      const sid = String(st.id || '');
      const basic = Math.max(0, Number(st.basic_salary ?? 0));
      const matchedDraft = payrollEntries.find(
        (pe) => pe.status === 'DRAFT' && (pe.staff_id === sid || pe.employee_name.toLowerCase() === `${st.first_name || ''} ${st.surname || ''}`.trim().toLowerCase())
      );
      if (matchedDraft && matchedDraft.basic_salary !== basic) {
        const gross = basic + matchedDraft.total_additions;
        const net = gross - matchedDraft.total_deductions;
        runSql(
          `UPDATE payroll_entries SET basic_salary = ${basic}, gross_salary = ${gross}, net_salary = ${net}, updated_at = '${new Date().toISOString()}' WHERE id = '${sqlEsc(matchedDraft.id)}'${bizCond}`,
          `Payroll: Sync basic salary for ${matchedDraft.employee_name}`
        );
        updatedCount++;
      }
    });

    loadPayrollEntries(selectedPayPeriod, staffList);
    persistTablesToStorage();
    notifyPayroll(
      'success',
      updatedCount > 0
        ? `Synced updated basic salaries for ${updatedCount} draft payslip(s).`
        : 'All registered staff & basic salaries are up to date for this pay period.'
    );
  };

  const openPayrollEditor = (entry: PayrollEntry) => {
    setEditingPayroll(entry);
    setDraftBasicSalary(String(entry.basic_salary ?? 0));
    setDraftAdditions(entry.additions.map((x) => ({ ...x })));
    setDraftDeductions(entry.deductions.map((x) => ({ ...x })));
    setDraftPayAccount(entry.payment_account_id || 'acc_bank');
    setDraftPayDate(entry.payment_date || new Date().toISOString().split('T')[0]);
    setDraftNotes(entry.notes || '');
    setNewAddCategory(ADDITION_CATEGORIES[0]);
    setNewAddDescription('');
    setNewAddAmount('');
    setNewDedCategory(DEDUCTION_CATEGORIES[0]);
    setNewDedDescription('');
    setNewDedAmount('');
  };

  const handleAddAdditionItem = () => {
    const amt = parseFloat(newAddAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      notifyPayroll('error', 'Enter a valid positive addition amount.');
      return;
    }
    const label = newAddDescription.trim() || newAddCategory;
    setDraftAdditions((prev) => [
      ...prev,
      {
        id: `add-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        category: newAddCategory,
        description: label,
        amount: parseFloat(amt.toFixed(2)),
      },
    ]);
    setNewAddDescription('');
    setNewAddAmount('');
  };

  const handleAddDeductionItem = () => {
    const amt = parseFloat(newDedAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      notifyPayroll('error', 'Enter a valid positive deduction amount.');
      return;
    }
    const label = newDedDescription.trim() || newDedCategory;
    setDraftDeductions((prev) => [
      ...prev,
      {
        id: `ded-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        category: newDedCategory,
        description: label,
        amount: parseFloat(amt.toFixed(2)),
      },
    ]);
    setNewDedDescription('');
    setNewDedAmount('');
  };

  const savePayrollEditorChanges = (targetStatus?: 'DRAFT' | 'PAID'): PayrollEntry | null => {
    if (!editingPayroll) return null;
    if (userRole === 'sales') {
      notifyPayroll('error', 'Access Denied: Only Business Owners or Store Managers can modify payroll.');
      return null;
    }
    const basic = Math.max(0, parseFloat(draftBasicSalary) || 0);
    const totalAdd = parseFloat(draftAdditions.reduce((s, x) => s + x.amount, 0).toFixed(2));
    const totalDed = parseFloat(draftDeductions.reduce((s, x) => s + x.amount, 0).toFixed(2));
    const gross = parseFloat((basic + totalAdd).toFixed(2));
    const net = parseFloat((gross - totalDed).toFixed(2));
    const finalStatus: 'DRAFT' | 'PAID' = targetStatus || editingPayroll.status;
    const nowIso = new Date().toISOString();
    const activeBizId = getActiveBusinessId();
    const bizCond = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';

    const res = runSql(
      `UPDATE payroll_entries SET
        basic_salary = ${basic},
        additions_json = '${sqlEsc(JSON.stringify(draftAdditions))}',
        deductions_json = '${sqlEsc(JSON.stringify(draftDeductions))}',
        total_additions = ${totalAdd},
        total_deductions = ${totalDed},
        gross_salary = ${gross},
        net_salary = ${net},
        payment_account_id = '${sqlEsc(draftPayAccount)}',
        payment_date = '${sqlEsc(draftPayDate)}',
        status = '${finalStatus}',
        notes = '${sqlEsc(draftNotes.trim())}',
        updated_at = '${nowIso}'
      WHERE id = '${sqlEsc(editingPayroll.id)}'${bizCond}`,
      `Payroll: Save ${finalStatus} entry for ${editingPayroll.employee_name}`
    );

    if (!res.success) {
      notifyPayroll('error', res.error || 'Failed to save payroll adjustments.');
      return null;
    }

    const updatedEntry: PayrollEntry = {
      ...editingPayroll,
      basic_salary: basic,
      additions: draftAdditions,
      deductions: draftDeductions,
      total_additions: totalAdd,
      total_deductions: totalDed,
      gross_salary: gross,
      net_salary: net,
      payment_account_id: draftPayAccount,
      payment_date: draftPayDate,
      status: finalStatus,
      notes: draftNotes.trim(),
      updated_at: nowIso,
    };

    logEmployeeAudit(
      'PAYROLL',
      finalStatus === 'PAID' ? 'Paid Employee Salary' : 'Updated Salary Adjustments',
      `${updatedEntry.employee_name} (${updatedEntry.pay_period}): Basic ${settings.currency}${basic.toFixed(2)}, Additions +${settings.currency}${totalAdd.toFixed(2)}, Deductions -${settings.currency}${totalDed.toFixed(2)}, Net ${settings.currency}${net.toFixed(2)}`,
      net,
      updatedEntry.store_id,
      userRole
    );

    syncAllAccountingSystems(`Payroll ${finalStatus} ${updatedEntry.employee_name}`);
    persistTablesToStorage();
    loadPayrollEntries(selectedPayPeriod, staffList);
    setEditingPayroll(null);
    try {
      window.dispatchEvent(new Event('pos_data_updated'));
    } catch {}
    notifyPayroll(
      'success',
      finalStatus === 'PAID'
        ? `Salary paid & posted to Finance Ledger for ${updatedEntry.employee_name} (${settings.currency}${net.toFixed(2)}).`
        : `Payroll adjustments saved for ${updatedEntry.employee_name}.`
    );
    return updatedEntry;
  };

  const handleCreateCustomPayroll = (e: React.FormEvent) => {
    e.preventDefault();
    if (userRole === 'sales') {
      notifyPayroll('error', 'Access Denied: Only Owners or Managers can create payroll entries.');
      return;
    }
    const empName = customEmpName.trim();
    if (!empName) {
      notifyPayroll('error', 'Please enter the employee full name.');
      return;
    }
    const basic = Math.max(0, parseFloat(customEmpSalary) || 0);
    const activeBizId = getActiveBusinessId();
    const resolvedStoreId = getActiveStoreId(activeStore, activeBizId);
    const nowIso = new Date().toISOString();
    const entryId = `PAY-${selectedPayPeriod.replace(/[^0-9]/g, '')}-${Date.now()}`;

    runSql(
      `INSERT INTO payroll_entries (id, staff_id, employee_name, employee_role, pay_period, payment_date, basic_salary, additions_json, deductions_json, total_additions, total_deductions, gross_salary, net_salary, payment_account_id, status, notes, created_at, updated_at, business_id, store_id) VALUES (
        '${sqlEsc(entryId)}',
        '',
        '${sqlEsc(empName)}',
        '${sqlEsc(customEmpRole.trim() || 'Employee')}',
        '${sqlEsc(selectedPayPeriod)}',
        '${nowIso.split('T')[0]}',
        ${basic},
        '[]',
        '[]',
        0,
        0,
        ${basic},
        ${basic},
        'acc_bank',
        'DRAFT',
        '',
        '${nowIso}',
        '${nowIso}',
        '${sqlEsc(activeBizId)}',
        '${sqlEsc(resolvedStoreId)}'
      )`,
      `Payroll: Add custom employee entry for ${empName}`
    );

    persistTablesToStorage();
    loadPayrollEntries(selectedPayPeriod, staffList);
    setShowAddCustomPayrollModal(false);
    setCustomEmpName('');
    setCustomEmpRole('Sales Person');
    setCustomEmpSalary('5000');
    notifyPayroll('success', `Added ${empName} to ${formatPayPeriodLabel(selectedPayPeriod)} payroll.`);
  };

  const handleTogglePayStatus = (entry: PayrollEntry) => {
    if (userRole === 'sales') {
      notifyPayroll('error', 'Access Denied: Only Business Owners or Store Managers can mark payroll as paid.');
      return;
    }
    const nextStatus = entry.status === 'PAID' ? 'DRAFT' : 'PAID';
    const actionText =
      nextStatus === 'PAID'
        ? `Disburse net salary of ${settings.currency}${entry.net_salary.toFixed(2)} to ${entry.employee_name} and post to Finance Wages Expense?`
        : `Revert ${entry.employee_name}'s payslip back to DRAFT so you can edit adjustments?`;

    setPayrollConfirmAction({
      title: nextStatus === 'PAID' ? 'Confirm Salary Payment' : 'Reopen Payslip to Draft',
      message: actionText,
      confirmLabel: nextStatus === 'PAID' ? 'Confirm & Mark Paid' : 'Reopen Draft',
      tone: nextStatus === 'PAID' ? 'emerald' : 'rose',
      onConfirm: () => {
        const activeBizId = getActiveBusinessId();
        const bizCond = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
        const nowIso = new Date().toISOString();
        const payDate = nextStatus === 'PAID' ? nowIso.split('T')[0] : entry.payment_date;

        runSql(
          `UPDATE payroll_entries SET status = '${nextStatus}', payment_date = '${sqlEsc(payDate)}', updated_at = '${nowIso}' WHERE id = '${sqlEsc(entry.id)}'${bizCond}`,
          `Payroll: Mark ${entry.employee_name} as ${nextStatus}`
        );

        logEmployeeAudit(
          'PAYROLL',
          nextStatus === 'PAID' ? 'Paid Employee Salary' : 'Reopened Payroll Draft',
          `${entry.employee_name} (${entry.pay_period}): Net ${settings.currency}${entry.net_salary.toFixed(2)}`,
          entry.net_salary,
          entry.store_id,
          userRole
        );

        syncAllAccountingSystems(`Payroll ${nextStatus} #${entry.id}`);
        persistTablesToStorage();
        loadPayrollEntries(selectedPayPeriod, staffList);
        try {
          window.dispatchEvent(new Event('pos_data_updated'));
        } catch {}
        notifyPayroll(
          'success',
          nextStatus === 'PAID'
            ? `Salary paid for ${entry.employee_name} and synced to Finance.`
            : `Payslip for ${entry.employee_name} reopened as Draft.`
        );
      },
    });
  };

  const handleDeletePayrollEntry = (entry: PayrollEntry) => {
    if (userRole === 'sales') return;
    setPayrollConfirmAction({
      title: 'Delete Payroll Entry',
      message: `Remove ${entry.employee_name} from ${formatPayPeriodLabel(entry.pay_period)} payroll?`,
      confirmLabel: 'Remove Entry',
      tone: 'rose',
      onConfirm: () => {
        const activeBizId = getActiveBusinessId();
        const bizCond = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
        runSql(`DELETE FROM payroll_entries WHERE id = '${sqlEsc(entry.id)}'${bizCond}`, 'Payroll: Delete entry');
        syncAllAccountingSystems(`Deleted Payroll #${entry.id}`);
        persistTablesToStorage();
        loadPayrollEntries(selectedPayPeriod, staffList);
        try {
          window.dispatchEvent(new Event('pos_data_updated'));
        } catch {}
        notifyPayroll('success', `Removed ${entry.employee_name} from ${entry.pay_period} payroll.`);
      },
    });
  };

  const accountLabelLookup = useMemo(() => {
    const map = new Map<string, string>();
    selectableAccounts.forEach((a) => map.set(a.accountId, a.label));
    return map;
  }, [selectableAccounts]);

  const filteredPayrollEntries = useMemo(() => {
    const q = payrollSearch.trim().toLowerCase();
    return payrollEntries.filter((entry) => {
      if (payrollStatusFilter !== 'ALL' && entry.status !== payrollStatusFilter) return false;
      if (q) {
        const hay = `${entry.employee_name} ${entry.employee_role} ${entry.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [payrollEntries, payrollSearch, payrollStatusFilter]);

  const payrollTotals = useMemo(() => {
    return filteredPayrollEntries.reduce(
      (acc, e) => {
        acc.basic += e.basic_salary;
        acc.additions += e.total_additions;
        acc.deductions += e.total_deductions;
        acc.gross += e.gross_salary;
        acc.net += e.net_salary;
        if (e.status === 'PAID') acc.paidCount += 1;
        return acc;
      },
      { basic: 0, additions: 0, deductions: 0, gross: 0, net: 0, paidCount: 0 }
    );
  }, [filteredPayrollEntries]);

  // Helper: Draw formal Company Header WITH Company Logo onto jsPDF
  const drawCompanyPdfHeader = async (
    doc: jsPDF,
    documentTitle: string,
    subtitle: string,
    pageWidth = 210
  ): Promise<number> => {
    const margin = 15;
    const logoSrc = settings.logoUrl || DEFAULT_COMPANY_LOGO;
    let textStartX = margin;

    try {
      const normalizedLogo = await loadNormalizedPngImage(logoSrc);
      if (normalizedLogo) {
        const maxLogoDim = 18;
        const ratio = Math.min(maxLogoDim / normalizedLogo.width, maxLogoDim / normalizedLogo.height);
        const drawW = Math.max(9, normalizedLogo.width * ratio);
        const drawH = Math.max(9, normalizedLogo.height * ratio);
        doc.addImage(normalizedLogo.dataUrl, 'PNG', margin, 13, drawW, drawH);
        textStartX = margin + drawW + 5;
      }
    } catch {
      // Non-fatal fallback if logo cannot decode
    }

    const companyName = (settings.storeName || 'POS MERCHANT').toUpperCase();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(15, 23, 42);
    doc.text(companyName, textStartX, 19);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(71, 85, 105);
    const addrParts = [settings.billingAddress, settings.billingCity, settings.billingCountry].filter(Boolean).join(', ');
    if (addrParts) {
      doc.text(addrParts, textStartX, 24.5);
    }
    const contactLine = [
      settings.tpin ? `TPIN: ${settings.tpin}` : '',
      settings.billingPhone ? `Tel: ${settings.billingPhone}` : '',
      settings.billingEmail ? `Email: ${settings.billingEmail}` : '',
    ]
      .filter(Boolean)
      .join('  |  ');
    if (contactLine) {
      doc.text(contactLine, textStartX, addrParts ? 29.5 : 24.5);
    }

    // Document Title Banner on Right / Below
    doc.setFillColor(30, 41, 59);
    doc.rect(margin, 36, pageWidth - margin * 2, 13, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.text(documentTitle.toUpperCase(), margin + 4, 43.5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(subtitle, pageWidth - margin - 4, 43.5, { align: 'right' });

    return 56;
  };

  // Generate Single Employee Formal Payslip PDF with Company Logo
  const handleDownloadPayslipPdf = async (entry: PayrollEntry) => {
    try {
      const doc = new jsPDF({ format: 'a4', orientation: 'portrait' });
      const curr = settings.currency || 'K';
      const fmt = (n: number) =>
        `${n < 0 ? '-' : ''}${curr}${Math.abs(n).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;

      let y = await drawCompanyPdfHeader(
        doc,
        'OFFICIAL EMPLOYEE PAYSLIP',
        `PAY PERIOD: ${formatPayPeriodLabel(entry.pay_period).toUpperCase()}`
      );

      // Employee Metadata Box
      const staffProfile = staffList.find((s) => String(s.id) === entry.staff_id);
      doc.setFillColor(248, 250, 252);
      doc.setDrawColor(203, 213, 225);
      doc.roundedRect(15, y, 180, 26, 2, 2, 'FD');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(15, 23, 42);
      doc.text(`Employee: ${entry.employee_name}`, 20, y + 7);
      doc.text(`Payslip Ref: ${entry.id}`, 190, y + 7, { align: 'right' });

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(51, 65, 85);
      doc.text(`Designation: ${entry.employee_role}`, 20, y + 13.5);
      doc.text(`Status: ${entry.status}`, 190, y + 13.5, { align: 'right' });

      const contactInfo = [
        staffProfile?.contact ? `Phone: ${staffProfile.contact}` : '',
        staffProfile?.email ? `Email: ${staffProfile.email}` : '',
      ]
        .filter(Boolean)
        .join('  |  ');
      doc.text(contactInfo || `Staff ID: ${entry.staff_id || 'Ad-Hoc'}`, 20, y + 20);
      const payMethodLabel = accountLabelLookup.get(entry.payment_account_id) || entry.payment_account_id;
      doc.text(`Payment Date: ${entry.payment_date}  |  Method: ${payMethodLabel}`, 190, y + 20, { align: 'right' });

      y += 35;

      const writeLine = (label: string, amountStr: string, isBold = false, color: [number, number, number] = [30, 41, 59]) => {
        if (y > 265) {
          doc.addPage();
          y = 20;
        }
        doc.setFont('helvetica', isBold ? 'bold' : 'normal');
        doc.setFontSize(9.5);
        doc.setTextColor(color[0], color[1], color[2]);
        doc.text(label, 20, y);
        doc.text(amountStr, 190, y, { align: 'right' });
        doc.setDrawColor(241, 245, 249);
        doc.line(18, y + 2, 192, y + 2);
        y += 7;
      };

      // Section I: Earnings & Additions
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(15, 23, 42);
      doc.text('I. EARNINGS & SALARY ADDITIONS', 15, y);
      doc.setDrawColor(16, 185, 129);
      doc.line(15, y + 2, 195, y + 2);
      y += 9;

      writeLine('Basic Monthly Salary', fmt(entry.basic_salary), true);
      if (entry.additions.length === 0) {
        writeLine('Bonuses & Allowances (None recorded)', fmt(0), false, [100, 116, 139]);
      } else {
        entry.additions.forEach((add) => {
          const desc = add.description && add.description !== add.category
            ? `${add.category} — ${add.description}`
            : add.category;
          writeLine(`(+) ${desc}`, `+${fmt(add.amount)}`, false, [4, 120, 87]);
        });
      }

      doc.setFillColor(236, 253, 245);
      doc.rect(15, y - 1, 180, 9, 'F');
      y += 5;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(6, 78, 59);
      doc.text('GROSS SALARY (BASIC + ADDITIONS)', 20, y);
      doc.text(fmt(entry.gross_salary), 190, y, { align: 'right' });
      y += 12;

      // Section II: Deductions
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(15, 23, 42);
      doc.text('II. DEDUCTIONS (ADVANCES, STATUTORY & OTHER)', 15, y);
      doc.setDrawColor(244, 63, 94);
      doc.line(15, y + 2, 195, y + 2);
      y += 9;

      if (entry.deductions.length === 0) {
        writeLine('Salary Advances / Tax / Deductions (None recorded)', fmt(0), false, [100, 116, 139]);
      } else {
        entry.deductions.forEach((ded) => {
          const desc = ded.description && ded.description !== ded.category
            ? `${ded.category} — ${ded.description}`
            : ded.category;
          writeLine(`(-) ${desc}`, `-${fmt(ded.amount)}`, false, [190, 18, 60]);
        });
      }

      doc.setFillColor(255, 241, 242);
      doc.rect(15, y - 1, 180, 9, 'F');
      y += 5;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(159, 18, 57);
      doc.text('TOTAL DEDUCTIONS', 20, y);
      doc.text(`-${fmt(entry.total_deductions)}`, 190, y, { align: 'right' });
      y += 14;

      // Net Salary Highlight Box
      doc.setFillColor(30, 41, 59);
      doc.rect(15, y, 180, 14, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(255, 255, 255);
      doc.text('NET SALARY PAYABLE (TAKE-HOME)', 20, y + 9);
      doc.text(fmt(entry.net_salary), 190, y + 9, { align: 'right' });
      y += 22;

      if (entry.notes) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(71, 85, 105);
        doc.text('Payroll Remarks / Notes:', 15, y);
        y += 5;
        doc.setFont('helvetica', 'normal');
        const splitNotes = doc.splitTextToSize(entry.notes, 180);
        doc.text(splitNotes, 15, y);
        y += splitNotes.length * 4.5 + 8;
      } else {
        y += 10;
      }

      if (y > 250) {
        doc.addPage();
        y = 30;
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(100, 116, 139);
      doc.text('Authorized Employer Signature: ________________________', 15, y);
      doc.text('Employee Signature: ________________________', 112, y);
      y += 10;
      doc.setFontSize(7.5);
      doc.text(`Generated by ${(settings.storeName || 'POS System')} on ${new Date().toLocaleString()}`, 15, y);

      const safeName = entry.employee_name.replace(/[^a-zA-Z0-9_-]/g, '_');
      await exportAndSharePdf(`Payslip_${safeName}_${entry.pay_period}.pdf`, doc);
      notifyPayroll('success', `Payslip PDF generated for ${entry.employee_name}.`);
    } catch (err) {
      notifyPayroll('error', `Could not generate Payslip PDF: ${String(err)}`);
    }
  };

  // Generate Complete Payroll Summary Register PDF with Company Logo
  const handleDownloadPayrollRegisterPdf = async () => {
    try {
      const doc = new jsPDF({ format: 'a4', orientation: 'landscape' });
      const curr = settings.currency || 'K';
      const fmt = (n: number) =>
        `${n < 0 ? '-' : ''}${curr}${Math.abs(n).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;

      let y = await drawCompanyPdfHeader(
        doc,
        'COMPANY PAYROLL REGISTER & SALARY SCHEDULE',
        `PERIOD: ${formatPayPeriodLabel(selectedPayPeriod).toUpperCase()}  |  STAFF: ${filteredPayrollEntries.length}`,
        297
      );

      // Summary Boxes
      const cards = [
        { label: 'TOTAL BASIC SALARIES', val: fmt(payrollTotals.basic) },
        { label: 'TOTAL ADDITIONS (+)', val: `+${fmt(payrollTotals.additions)}` },
        { label: 'TOTAL DEDUCTIONS (-)', val: `-${fmt(payrollTotals.deductions)}` },
        { label: 'TOTAL NET PAYROLL', val: fmt(payrollTotals.net) },
      ];
      cards.forEach((c, idx) => {
        const bx = 15 + idx * 68;
        doc.setFillColor(idx === 3 ? 30 : 248, idx === 3 ? 41 : 250, idx === 3 ? 59 : 252);
        doc.setDrawColor(203, 213, 225);
        doc.roundedRect(bx, y, 64, 15, 1.5, 1.5, 'FD');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7);
        doc.setTextColor(idx === 3 ? 203 : 100, idx === 3 ? 213 : 116, idx === 3 ? 225 : 139);
        doc.text(c.label, bx + 3, y + 5);
        doc.setFontSize(10);
        doc.setTextColor(idx === 3 ? 255 : 15, idx === 3 ? 255 : 23, idx === 3 ? 255 : 42);
        doc.text(c.val, bx + 3, y + 11.5);
      });

      y += 22;

      const drawTableHeader = () => {
        doc.setFillColor(241, 245, 249);
        doc.rect(15, y, 267, 8, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(51, 65, 85);
        doc.text('EMPLOYEE NAME', 18, y + 5.5);
        doc.text('BASIC', 90, y + 5.5, { align: 'right' });
        doc.text('ADDITIONS (BONUSES / ALLOW.)', 95, y + 5.5);
        doc.text('DEDUCTIONS (ADVANCES / TAX)', 168, y + 5.5);
        doc.text('NET PAY', 252, y + 5.5, { align: 'right' });
        doc.text('STATUS', 279, y + 5.5, { align: 'right' });
        y += 10;
      };

      drawTableHeader();

      if (filteredPayrollEntries.length === 0) {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(9);
        doc.setTextColor(100, 116, 139);
        doc.text('No payroll entries recorded for this pay period.', 18, y + 4);
        y += 12;
      } else {
        filteredPayrollEntries.forEach((entry) => {
          const addText =
            entry.additions.length > 0
              ? entry.additions.map((a) => `${a.category}: +${fmt(a.amount)}`).join(', ')
              : 'None';
          const dedText =
            entry.deductions.length > 0
              ? entry.deductions.map((d) => `${d.category}: -${fmt(d.amount)}`).join(', ')
              : 'None';

          const addLines = doc.splitTextToSize(addText, 68);
          const dedLines = doc.splitTextToSize(dedText, 64);
          const rowLines = Math.max(1, addLines.length, dedLines.length);
          const rowHeight = Math.max(8, rowLines * 4 + 4);

          if (y + rowHeight > 185) {
            doc.addPage();
            y = 18;
            drawTableHeader();
          }

          doc.setFont('helvetica', 'bold');
          doc.setFontSize(8);
          doc.setTextColor(15, 23, 42);
          doc.text(entry.employee_name.slice(0, 28), 18, y + 4);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7);
          doc.setTextColor(100, 116, 139);
          doc.text(entry.employee_role.slice(0, 26), 18, y + 7.8);

          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(30, 41, 59);
          doc.text(fmt(entry.basic_salary), 90, y + 4.5, { align: 'right' });

          doc.setFontSize(7.2);
          doc.setTextColor(4, 120, 87);
          doc.text(addLines, 95, y + 4);

          doc.setTextColor(190, 18, 60);
          doc.text(dedLines, 168, y + 4);

          doc.setFont('helvetica', 'bold');
          doc.setFontSize(8.5);
          doc.setTextColor(15, 23, 42);
          doc.text(fmt(entry.net_salary), 252, y + 4.5, { align: 'right' });

          doc.setFontSize(7.5);
          doc.setTextColor(entry.status === 'PAID' ? 4 : 180, entry.status === 'PAID' ? 120 : 83, entry.status === 'PAID' ? 87 : 9);
          doc.text(entry.status, 279, y + 4.5, { align: 'right' });

          doc.setDrawColor(226, 232, 240);
          doc.line(15, y + rowHeight, 282, y + rowHeight);
          y += rowHeight + 1.5;
        });
      }

      if (y > 175) {
        doc.addPage();
        y = 22;
      }
      y += 4;
      doc.setFillColor(241, 245, 249);
      doc.rect(15, y, 267, 9, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(15, 23, 42);
      doc.text('GRAND TOTALS', 18, y + 6);
      doc.text(fmt(payrollTotals.basic), 90, y + 6, { align: 'right' });
      doc.setTextColor(4, 120, 87);
      doc.text(`+${fmt(payrollTotals.additions)}`, 95, y + 6);
      doc.setTextColor(190, 18, 60);
      doc.text(`-${fmt(payrollTotals.deductions)}`, 168, y + 6);
      doc.setTextColor(15, 23, 42);
      doc.text(fmt(payrollTotals.net), 252, y + 6, { align: 'right' });

      y += 18;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(100, 116, 139);
      doc.text('Prepared By (HR / Payroll): ____________________________', 15, y);
      doc.text('Approved By (Managing Director): ____________________________', 150, y);

      await exportAndSharePdf(`Payroll_Register_${selectedPayPeriod}.pdf`, doc);
      notifyPayroll('success', `Payroll Register PDF generated for ${formatPayPeriodLabel(selectedPayPeriod)}.`);
    } catch (err) {
      notifyPayroll('error', `Could not export Payroll Register PDF: ${String(err)}`);
    }
  };

  // Generate Attendance Shifts or Staff Roster PDF with Company Logo
  const handlePrintPayrollPDF = async () => {
    if (activeSubTab === 'payroll') {
      await handleDownloadPayrollRegisterPdf();
      return;
    }
    try {
      const doc = new jsPDF({ format: 'a4', orientation: 'portrait' });
      const curr = settings.currency || 'K';
      const title =
        activeSubTab === 'clock'
          ? 'STAFF SHIFT ATTENDANCE & HOURLY WAGES REPORT'
          : 'CORPORATE STAFF DIRECTORY & PAYROLL ROSTER';
      let y = await drawCompanyPdfHeader(doc, title, `GENERATED: ${new Date().toLocaleDateString()}`);

      if (activeSubTab === 'clock') {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(51, 65, 85);
        doc.text('STAFF NAME', 18, y);
        doc.text('DATE', 75, y);
        doc.text('HOURS', 115, y, { align: 'right' });
        doc.text('WAGES', 155, y, { align: 'right' });
        doc.text('STATUS', 190, y, { align: 'right' });
        y += 3;
        doc.line(15, y, 195, y);
        y += 5;

        records.forEach((rec) => {
          if (y > 272) {
            doc.addPage();
            y = 20;
          }
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8.5);
          doc.setTextColor(30, 41, 59);
          doc.text(String(rec.employee_name || '').slice(0, 30), 18, y);
          doc.text(String(rec.date || ''), 75, y);
          doc.text(`${Number(rec.hours_worked || 0).toFixed(2)}h`, 115, y, { align: 'right' });
          doc.text(`${curr}${Number(rec.gross_payment || 0).toFixed(2)}`, 155, y, { align: 'right' });
          doc.text(String(rec.status || 'PENDING'), 190, y, { align: 'right' });
          y += 6;
        });
      } else {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(51, 65, 85);
        doc.text('STAFF NAME', 18, y);
        doc.text('CONTACT', 80, y);
        doc.text('JOINED', 140, y);
        doc.text('BASIC SALARY', 190, y, { align: 'right' });
        y += 3;
        doc.line(15, y, 195, y);
        y += 5;

        staffList.forEach((st) => {
          if (y > 272) {
            doc.addPage();
            y = 20;
          }
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8.5);
          doc.setTextColor(30, 41, 59);
          doc.text(`${st.first_name || st.name || ''} ${st.surname || ''}`.trim().slice(0, 28), 18, y);
          doc.text(String(st.contact || st.email || '').slice(0, 26), 80, y);
          doc.text(String(st.joining_date || ''), 140, y);
          doc.text(`${curr}${Number(st.basic_salary || 0).toFixed(2)}`, 190, y, { align: 'right' });
          y += 6;
        });
      }

      await exportAndSharePdf(
        `${activeSubTab === 'clock' ? 'Attendance_Report' : 'Staff_Roster'}_${new Date().toISOString().split('T')[0]}.pdf`,
        doc
      );
    } catch (err) {
      notifyPayroll('error', `Could not generate PDF: ${String(err)}`);
    }
  };

  return (
    <div className="flex-1 flex overflow-hidden flex-col bg-slate-50 relative">
      
      {/* Title Header bar */}
      <div className="px-5 py-4 bg-white border-b border-slate-200 flex flex-wrap justify-between items-center gap-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
            <Users size={20} />
          </div>
          <div>
            <h2 className="text-md font-bold text-slate-800">Staff Management, Payroll & Roles</h2>
            <p className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">Salary Adjustments, Payslips, Attendance & Permissions</p>
          </div>
        </div>

        {/* Tab Navigation selectors */}
        <div className="flex flex-wrap bg-slate-100 p-1 rounded-xl border border-slate-200/60 max-w-full gap-1">
          <button
            onClick={() => {
              loadPayrollEntries(selectedPayPeriod, staffList);
              setActiveSubTab('payroll');
            }}
            className={`px-4 py-2 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
              activeSubTab === 'payroll'
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-slate-500 hover:text-slate-900'
            }`}
          >
            <Banknote size={13} />
            Salary Payroll & Payslips
          </button>
          <button
            onClick={() => setActiveSubTab('clock')}
            className={`px-4 py-2 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
              activeSubTab === 'clock' 
                ? 'bg-white text-indigo-600 shadow-sm' 
                : 'text-slate-500 hover:text-slate-900'
            }`}
          >
            <Clock size={13} />
            Shifts & Duty Clock
          </button>
          <button
            onClick={() => {
              loadStaffMembers();
              setActiveSubTab('roster');
            }}
            className={`px-4 py-2 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
              activeSubTab === 'roster' 
                ? 'bg-white text-indigo-600 shadow-sm' 
                : 'text-slate-500 hover:text-slate-900'
            }`}
            id="btn-staff-perms-system"
          >
            <Users size={13} />
            Staff Directory & Permissions
          </button>
        </div>

        <button
          onClick={handlePrintPayrollPDF}
          className="flex items-center gap-1.5 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold cursor-pointer shadow-xs"
        >
          <Printer size={13} />
          {activeSubTab === 'payroll' ? 'PAYROLL PDF (WITH LOGO)' : 'EXPORT REPORT PDF'}
        </button>
      </div>

      {payrollFeedback && (
        <div
          className={`mx-5 mt-3 px-4 py-2.5 rounded-xl border text-xs font-bold flex items-center justify-between ${
            payrollFeedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          <span>{payrollFeedback.text}</span>
          <button onClick={() => setPayrollFeedback(null)} className="p-0.5 hover:opacity-70 cursor-pointer">
            <X size={14} />
          </button>
        </div>
      )}

      {successNote && (
        <div className="mx-5 mt-4 p-3.5 bg-indigo-900 text-amber-300 font-bold text-xs rounded-xl shadow-md animate-bounce flex items-center gap-2">
          <Clock size={16} />
          <span>{successNote}</span>
        </div>
      )}

      {/* CLOCK SECTION */}
      {activeSubTab === 'clock' ? (
        <div className="flex-1 p-5 overflow-y-auto flex flex-col gap-5">
          
          {/* TOP ROW: ATTENDANCE CONTROL / QUICK CLOCK-IN CARD */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            
            {/* Action Card: Clock Console */}
            <div className="bg-white border border-slate-250/70 p-4 rounded-xl flex flex-col gap-3.5 shadow-3xs">
              <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-100 pb-2">
                <Clock size={13} className="text-indigo-600" />
                SME Shift Duty Log
              </h3>

              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] text-slate-400 font-extrabold uppercase">Select Clocking Staff</label>
                <select
                  value={quickName}
                  onChange={(e) => setQuickName(e.target.value)}
                  className="px-3 py-2 text-xs font-bold bg-slate-50 border border-slate-200 rounded-lg text-slate-700 focus:outline-hidden"
                >
                  {employeeList.map(e => (
                    <option key={e.name} value={e.name}>{e.name} ({e.role})</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-1">
                <button
                  onClick={handleClockIn}
                  className="flex items-center justify-center gap-1.5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-lg shadow-3xs cursor-pointer uppercase tracking-wider"
                >
                  <Play size={12} fill="white" />
                  CLOCK IN
                </button>
                
                <div className="text-[10px] text-slate-400 font-medium flex items-center justify-center text-center p-1.5 border border-dashed border-slate-200 rounded-lg">
                  Records clock-in timestamp and calculates payment logs
                </div>
              </div>
            </div>

            {/* Quick Helper Banner */}
            <div className="bg-white border border-slate-250/70 p-4 rounded-xl flex flex-col gap-3 shadow-3xs justify-between">
              <div>
                <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-100 pb-2">
                  <Shield size={13} className="text-indigo-600" />
                  Privileges Gating Control
                </h3>
                <p className="text-[11.5px] text-slate-500 mt-2 font-medium leading-relaxed">
                  Registered staff permissions automatically control their user accounts on sale terminals, warehouse edit capabilities, customer modifications, and reports viewing.
                </p>
              </div>

              <button
                onClick={() => {
                  resetForm();
                  setShowRegisterModal(true);
                  setActiveSubTab('roster');
                }}
                className="py-1.5 w-full bg-slate-850 hover:bg-slate-900 active:bg-slate-950 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1 cursor-pointer transition-all border border-slate-700 shadow-sm"
              >
                <Plus size={12} />
                ONBOARD NEW STAFF MEMBER
              </button>
            </div>

            {/* Payroll Stats card */}
            <div className="bg-slate-900 text-white p-4 rounded-xl flex flex-col justify-between shadow-md">
              <div>
                <p className="text-[10px] text-amber-400 font-mono font-extrabold uppercase tracking-wider">Payroll Accrual Monitor</p>
                <p className="text-2xl font-mono font-extrabold text-white mt-1">
                  {settings.currency}{totalCompanyOutstandingPayroll.toFixed(2)}
                </p>
                <p className="text-[10px] text-slate-400 font-medium mt-1">
                  Accumulated outstanding hourly wage balances across all sale shifts.
                </p>
              </div>

              <div className="flex items-center gap-2 border-t border-slate-800 pt-3 mt-3 text-xs text-slate-400 font-medium">
                <span className="inline-block w-2.5 h-2.5 bg-yellow-400 rounded-full animate-ping"></span>
                <span>Double-entry ledger matched logs</span>
              </div>
            </div>

          </div>

          {/* CLOCK OUT & PAYMENTS */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-3xs">
            <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <Calculator size={13} className="text-indigo-600" />
              Active Payroll Logs & Outstanding Wages
            </h3>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 font-bold uppercase border-b border-slate-100 text-[10px]">
                    <th className="py-2.5 px-3">Staff Name</th>
                    <th className="py-2.5 px-3">Role Level</th>
                    <th className="py-2.5 px-3 text-center">Duty Shifts</th>
                    <th className="py-2.5 px-3 text-center">Total Hours</th>
                    <th className="py-2.5 px-3 text-center">Paid Wages</th>
                    <th className="py-2.5 px-3 text-right">Pending Payout</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                  {Object.values(payrollSummary).length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-6 text-center text-slate-400 text-xs">
                        No shift history recorded in database yet! Secure clock in to start logs.
                      </td>
                    </tr>
                  ) : (
                    (Object.values(payrollSummary) as any[]).map(staff => (
                      <tr key={staff.name} className="hover:bg-slate-50/50">
                        <td className="py-3 px-3 font-extrabold text-slate-800">{staff.name}</td>
                        <td className="py-3 px-3 text-slate-500">{staff.role}</td>
                        <td className="py-3 px-3 text-center font-mono">{staff.shiftsCount} shifts</td>
                        <td className="py-3 px-3 text-center font-mono">{staff.totalHours.toFixed(1)} hrs</td>
                        <td className="py-3 px-3 text-center font-mono text-slate-500">{settings.currency}{staff.paidWages.toFixed(2)}</td>
                        <td className="py-3 px-3 text-right font-mono text-amber-600">{settings.currency}{staff.pendingWages.toFixed(2)}</td>
                        <td className="py-3 px-3 text-right">
                          {staff.pendingWages > 0 ? (
                            <button
                              onClick={() => handleMarkAsPaid(staff.name)}
                              className="bg-emerald-50 active:bg-emerald-100 text-emerald-800 py-1 px-2.5 rounded-md text-[11px] font-extrabold cursor-pointer border border-emerald-200/50"
                            >
                              Mark Paid
                            </button>
                          ) : (
                            <span className="text-[10px] text-slate-400 font-mono uppercase bg-slate-100 px-1.5 py-0.5 rounded-md">Paid Up</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* BOTTOM SECTION: SHIFTS JOURNAL */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-3xs overflow-hidden flex flex-col">
            <h3 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
              <Layers size={13} className="text-indigo-600" />
              Duty Shifts Ledger & Clock Times
            </h3>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-700">
                <thead>
                  <tr className="bg-slate-100 text-slate-500 font-bold uppercase text-[9px] border-b border-slate-200">
                    <th className="py-2 px-3">Date</th>
                    <th className="py-2 px-3">Staff Name</th>
                    <th className="py-2 px-3 text-center">Clock In</th>
                    <th className="py-2 px-3 text-center">Clock Out</th>
                    <th className="py-2 px-3 text-center">Hours Worked</th>
                    <th className="py-2 px-3 text-center">Hourly Rate</th>
                    <th className="py-2 px-3 text-right">Wages</th>
                    <th className="py-2 px-3 text-center">Status</th>
                    <th className="py-2 px-3 text-right">Trigger Check</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-semibold">
                  {records.map(rec => {
                    const isActive = rec.clock_out === null;
                    return (
                      <tr key={rec.id} className={`hover:bg-slate-50/50 ${isActive ? 'bg-indigo-50/20' : ''}`}>
                        <td className="py-2.5 px-3 font-mono text-[11px] text-slate-500">{rec.date}</td>
                        <td className="py-2.5 px-3 font-extrabold text-slate-800">{rec.employee_name}</td>
                        <td className="py-2.5 px-3 text-center font-mono text-slate-502">{rec.clock_in}</td>
                        <td className={`py-2.5 px-3 text-center font-mono ${isActive ? 'text-rose-500 animate-pulse font-bold' : 'text-slate-502'}`}>
                          {isActive ? 'SHIFTACTIVE' : rec.clock_out}
                        </td>
                        <td className="py-2.5 px-3 text-center font-mono">{rec.hours_worked} hrs</td>
                        <td className="py-2.5 px-3 text-center font-mono text-slate-400">{settings.currency}{rec.hourly_rate}</td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-800">
                          {settings.currency}{rec.gross_payment.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded-full ${
                            rec.status === 'PAID' ? 'bg-emerald-100 text-emerald-800' : 'bg-yellow-105 text-yellow-800'
                          }`}>
                            {rec.status}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {isActive ? (
                            <button
                              onClick={() => handleClockOut(rec.id)}
                              className="bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-[10px] py-1 px-2 rounded-lg cursor-pointer flex items-center justify-center gap-0.5 ml-auto uppercase tracking-wider shadow-3xs"
                            >
                              <Square size={9} fill="white" />
                              CLOCK OUT
                            </button>
                          ) : (
                            <span className="text-[10px] text-slate-400 font-medium">Duty Completed</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      ) : activeSubTab === 'payroll' ? (
        /* SALARY PAYROLL & ADJUSTMENTS TAB SECTION */
        <div className="flex-1 p-5 overflow-y-auto flex flex-col gap-4">
          {/* Top Controls Bar */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-3xs flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 bg-slate-50 border border-slate-300 rounded-xl px-3 py-1.5">
                <Calendar size={14} className="text-indigo-600" />
                <span className="text-[10px] font-black uppercase text-slate-500">Pay Period:</span>
                <input
                  type="month"
                  value={selectedPayPeriod}
                  onChange={(e) => setSelectedPayPeriod(e.target.value)}
                  className="bg-transparent text-xs font-black text-slate-800 focus:outline-hidden cursor-pointer"
                />
              </div>

              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400" />
                <input
                  type="text"
                  value={payrollSearch}
                  onChange={(e) => setPayrollSearch(e.target.value)}
                  placeholder="Search employee..."
                  className="pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-800 focus:outline-hidden w-48"
                />
              </div>

              <select
                value={payrollStatusFilter}
                onChange={(e) => setPayrollStatusFilter(e.target.value as 'ALL' | 'DRAFT' | 'PAID')}
                className="bg-slate-50 border border-slate-300 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-700"
              >
                <option value="ALL">All Statuses</option>
                <option value="DRAFT">Draft / Pending</option>
                <option value="PAID">Paid</option>
              </select>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleSyncBasicSalariesFromStaff}
                className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw size={13} />
                <span>Sync Staff Salaries</span>
              </button>
              <button
                type="button"
                onClick={() => setShowAddCustomPayrollModal(true)}
                className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-extrabold flex items-center gap-1.5 cursor-pointer shadow-xs"
              >
                <Plus size={14} />
                <span>Add Employee Payroll</span>
              </button>
              <button
                type="button"
                onClick={handleDownloadPayrollRegisterPdf}
                className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-extrabold flex items-center gap-1.5 cursor-pointer shadow-xs"
              >
                <Download size={14} />
                <span>Full Payroll PDF</span>
              </button>
            </div>
          </div>

          {/* 4 Summary KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-3xs">
              <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider block">
                Total Basic Salaries ({filteredPayrollEntries.length} staff)
              </span>
              <span className="text-xl font-black font-mono text-slate-900 mt-1 block">
                {settings.currency}{payrollTotals.basic.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-emerald-200 shadow-3xs">
              <span className="text-[10px] font-black uppercase text-emerald-700 tracking-wider block">
                Total Additions (Bonuses & Allowances)
              </span>
              <span className="text-xl font-black font-mono text-emerald-700 mt-1 block">
                +{settings.currency}{payrollTotals.additions.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-rose-200 shadow-3xs">
              <span className="text-[10px] font-black uppercase text-rose-700 tracking-wider block">
                Total Deductions (Advances, Tax, Loans)
              </span>
              <span className="text-xl font-black font-mono text-rose-700 mt-1 block">
                -{settings.currency}{payrollTotals.deductions.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>

            <div className="bg-slate-900 text-white p-4 rounded-xl border border-slate-800 shadow-md">
              <span className="text-[10px] font-black uppercase text-emerald-300 tracking-wider block">
                Net Payroll Payable ({payrollTotals.paidCount}/{filteredPayrollEntries.length} Paid)
              </span>
              <span className="text-xl font-black font-mono text-white mt-1 block">
                {settings.currency}{payrollTotals.net.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          </div>

          {/* Payroll Table */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-3xs flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
              <div>
                <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                  <Banknote size={14} className="text-indigo-600" />
                  <span>{formatPayPeriodLabel(selectedPayPeriod)} — Employee Salaries, Additions & Deductions</span>
                </h3>
                <p className="text-[11px] text-slate-500">
                  Add bonuses, housing/transport allowances, overtime or deduct salary advances, PAYE, NAPSA, and loans before generating official payslip PDFs.
                </p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-100 text-slate-600 font-black uppercase text-[10px] border-b border-slate-200">
                    <th className="py-2.5 px-3">Employee</th>
                    <th className="py-2.5 px-3 text-right">Basic Salary</th>
                    <th className="py-2.5 px-3">Additions (+)</th>
                    <th className="py-2.5 px-3">Deductions (-)</th>
                    <th className="py-2.5 px-3 text-right">Net Salary</th>
                    <th className="py-2.5 px-3">Account & Status</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                  {filteredPayrollEntries.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-400 text-xs">
                        <div className="flex flex-col items-center gap-2">
                          <Banknote size={28} className="text-slate-300" />
                          <span>
                            No payroll entries yet for {formatPayPeriodLabel(selectedPayPeriod)}. Onboard staff in Staff Directory or click &ldquo;Add Employee Payroll&rdquo;.
                          </span>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredPayrollEntries.map((entry) => {
                      const accLabel = accountLabelLookup.get(entry.payment_account_id) || entry.payment_account_id;
                      return (
                        <tr key={entry.id} className="hover:bg-slate-50/70 align-top">
                          <td className="py-3 px-3">
                            <div className="font-black text-slate-900">{entry.employee_name}</div>
                            <div className="text-[10px] text-slate-500 font-medium">{entry.employee_role}</div>
                          </td>
                          <td className="py-3 px-3 text-right font-mono font-bold text-slate-800 whitespace-nowrap">
                            {settings.currency}{entry.basic_salary.toFixed(2)}
                          </td>
                          <td className="py-3 px-3">
                            <div className="font-mono font-black text-emerald-700">
                              +{settings.currency}{entry.total_additions.toFixed(2)}
                            </div>
                            {entry.additions.length > 0 && (
                              <div className="text-[10px] text-emerald-800/80 space-y-0.5 mt-1">
                                {entry.additions.map((a) => (
                                  <div key={a.id} className="truncate max-w-[200px]">
                                    • {a.description}: +{settings.currency}{a.amount.toFixed(2)}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-3">
                            <div className="font-mono font-black text-rose-700">
                              -{settings.currency}{entry.total_deductions.toFixed(2)}
                            </div>
                            {entry.deductions.length > 0 && (
                              <div className="text-[10px] text-rose-800/80 space-y-0.5 mt-1">
                                {entry.deductions.map((d) => (
                                  <div key={d.id} className="truncate max-w-[200px]">
                                    • {d.description}: -{settings.currency}{d.amount.toFixed(2)}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-3 text-right font-mono font-black text-slate-900 text-sm whitespace-nowrap">
                            {settings.currency}{entry.net_salary.toFixed(2)}
                          </td>
                          <td className="py-3 px-3">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase ${
                                entry.status === 'PAID'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-amber-100 text-amber-800'
                              }`}
                            >
                              {entry.status === 'PAID' ? <CheckCircle2 size={10} /> : null}
                              {entry.status}
                            </span>
                            <div className="text-[10px] text-slate-500 mt-1 truncate max-w-[140px]">{accLabel}</div>
                          </td>
                          <td className="py-3 px-3 text-right">
                            <div className="flex items-center justify-end gap-1.5 flex-wrap">
                              <button
                                type="button"
                                onClick={() => openPayrollEditor(entry)}
                                className="px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-[10.5px] font-extrabold cursor-pointer flex items-center gap-1"
                              >
                                <Calculator size={11} />
                                <span>Add / Deduct</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDownloadPayslipPdf(entry)}
                                className="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-[10.5px] font-extrabold cursor-pointer flex items-center gap-1"
                                title="Download Employee Payslip PDF with Company Logo"
                              >
                                <FileText size={11} />
                                <span>Payslip PDF</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleTogglePayStatus(entry)}
                                className={`px-2.5 py-1.5 rounded-lg text-[10.5px] font-extrabold cursor-pointer border ${
                                  entry.status === 'PAID'
                                    ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200'
                                    : 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600'
                                }`}
                              >
                                {entry.status === 'PAID' ? 'Paid ✓' : 'Mark Paid'}
                              </button>
                              {entry.status === 'DRAFT' && (
                                <button
                                  type="button"
                                  onClick={() => handleDeletePayrollEntry(entry)}
                                  className="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg cursor-pointer"
                                  title="Remove Draft Entry"
                                >
                                  <Trash size={12} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        /* ROSTER DIRECTORY TAB SECTION */
        <div className="flex-1 p-5 overflow-y-auto flex flex-col gap-4">
          
          <div className="flex justify-between items-center bg-white p-4 rounded-xl border border-slate-200 shadow-3xs flex-wrap gap-2">
            <div>
              <h3 className="text-md font-bold text-slate-800">Corporate Staff Roster</h3>
              <p className="text-xs text-slate-500">Configure core employee parameters, upload documents, and define granular privilege levels.</p>
            </div>
            <button
              onClick={() => {
                resetForm();
                setShowRegisterModal(true);
              }}
              className="py-2 px-3.5 bg-indigo-650 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg cursor-pointer shadow-3xs transition-all flex items-center gap-2"
            >
              <Plus size={14} />
              ADD NEW STAFF PROFILE
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {staffList.map((st) => {
              let parsedPerms: Record<string, any> = {};
              try {
                const raw = st.permissions_json ? JSON.parse(st.permissions_json) : null;
                if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                  parsedPerms = raw;
                }
              } catch (e) {
                console.error(e);
              }

              const activePermissionCount = Object.values(parsedPerms || {}).reduce((sum: number, section: any) => {
                if (!section || typeof section !== 'object' || Array.isArray(section)) return sum;
                return sum + Object.values(section).filter((val) => val === true).length;
              }, 0);

              return (
                <div key={st.id} className="bg-white border border-slate-200 rounded-xl p-4 shadow-3xs hover:shadow-2xs transition-all flex flex-col justify-between">
                  <div>
                    {/* Member Information Header */}
                    <div className="flex justify-between items-start border-b border-slate-100 pb-3 mb-3">
                      <div>
                        <h4 className="text-sm font-black text-slate-800">{st.first_name || st.name || 'Staff'} {st.surname || ''}</h4>
                        <span className="text-[10px] bg-indigo-50 font-semibold px-2 py-0.5 text-indigo-700 rounded-full mt-1 inline-block uppercase">
                          {settings.currency}{st.basic_salary ?? 0}/mo Basic
                        </span>
                      </div>
                      <div className="flex gap-1">
                        <button
                          onClick={() => {
                            loadPayrollEntries(selectedPayPeriod, staffList);
                            setActiveSubTab('payroll');
                          }}
                          className="p-1 hover:bg-emerald-50 text-emerald-700 rounded cursor-pointer"
                          title="Open Payroll & Payslip"
                        >
                          <Banknote size={13} />
                        </button>
                        <button
                          onClick={() => handleEditStaff(st)}
                          className="p-1 hover:bg-slate-100 text-indigo-600 rounded cursor-pointer"
                          title="Edit Profile"
                        >
                          <Edit size={13} />
                        </button>
                        <button
                          onClick={() => handleDeleteStaff(st.id, `${st.first_name || st.name || ''} ${st.surname || ''}`.trim(), st.email, st.password)}
                          className="p-1 hover:bg-slate-100 text-rose-600 rounded cursor-pointer"
                          title="Delete Profile"
                        >
                          <Trash size={13} />
                        </button>
                      </div>
                    </div>

                    {/* Member Details list */}
                    <div className="flex flex-col gap-2 text-xs font-medium text-slate-500">
                      <div>
                        <span className="text-[10px] text-slate-400 block uppercase font-bold">Contact Phone / Email</span>
                        <span className="text-slate-800 font-bold">{st.contact}</span> • <span className="font-mono text-[11px]">{st.email}</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-400 block uppercase font-bold">Residential Residence Address</span>
                        <span className="text-slate-700">{st.residential_address || 'Not Registered'}</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-400 block uppercase font-bold">Official Joining Date</span>
                        <span className="text-slate-800 font-bold">{st.joining_date}</span>
                      </div>

                      {/* File Upload Attachment indicators */}
                      <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-slate-100">
                        <div>
                          <span className="text-[10px] text-slate-450 block font-bold">NRC Attachment:</span>
                          {st.nrc_file ? (
                            <button
                              onClick={() => handleDownloadBase64(st.nrc_file, st.nrc_filename || 'nrc_card.png')}
                              className="text-[10.5px] text-indigo-600 font-bold flex items-center gap-1 hover:underline text-left mt-0.5"
                            >
                              <Download size={11} />
                              {st.nrc_filename ? (st.nrc_filename.length > 15 ? `${st.nrc_filename.substring(0,12)}...` : st.nrc_filename) : 'NRC Form'}
                            </button>
                          ) : (
                            <span className="text-[10px] text-slate-400 italic block mt-0.5">No file</span>
                          )}
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-450 block font-bold">Contract Form:</span>
                          {st.contract_file ? (
                            <button
                              onClick={() => handleDownloadBase64(st.contract_file, st.contract_filename || 'employment_contract.pdf')}
                              className="text-[10.5px] text-indigo-600 font-bold flex items-center gap-1 hover:underline text-left mt-0.5"
                            >
                              <Download size={11} />
                              {st.contract_filename ? (st.contract_filename.length > 15 ? `${st.contract_filename.substring(0,12)}...` : st.contract_filename) : 'Contract'}
                            </button>
                          ) : (
                            <span className="text-[10px] text-slate-400 italic block mt-0.5">No file</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Summary Roles Box */}
                  <div className="mt-4 pt-3 border-t border-slate-150-dashed">
                    <span className="text-[10px] text-slate-400 block uppercase font-bold tracking-wider mb-1.5 flex items-center gap-1">
                      <Shield size={10} className="text-slate-405" />
                      Assigned Privilege Permissions:
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {/* Render flags dynamically matching parsed JSON levels */}
                      {parsedPerms.sales?.discount && <span className="bg-emerald-50 text-emerald-800 text-[10px] font-bold px-1.5 py-0.5 rounded-md border border-emerald-100">Sales Disc</span>}
                      {parsedPerms.sales?.gift && <span className="bg-emerald-50 text-emerald-800 text-[10px] font-bold px-1.5 py-0.5 rounded-md border border-emerald-100">Sales Gift</span>}
                      {parsedPerms.sales?.give_credit && <span className="bg-amber-50 text-amber-800 text-[10px] font-bold px-1.5 py-0.5 rounded-md border border-amber-105/70">Sales Credit</span>}
                      {parsedPerms.inventory?.create && <span className="bg-sky-50 text-sky-800 text-[10px] font-bold px-1.5 py-0.5 rounded-md border border-sky-100">Inv Create</span>}
                      {parsedPerms.reports?.profits && <span className="bg-purple-50 text-purple-800 text-[10px] font-bold px-1.5 py-0.5 rounded-md border border-purple-100">Rep Profits</span>}
                      {parsedPerms.settings?.manage_settings && <span className="bg-rose-50 text-rose-800 text-[10px] font-bold px-1.5 py-0.5 rounded-md border border-rose-100">Sys Control</span>}
                      <button
                        onClick={() => setViewingStaffDetail(st)}
                        className="text-[10px] font-black text-indigo-700 bg-indigo-50 border border-indigo-150 rounded px-2 py-0.5 text-center cursor-pointer ml-auto hover:bg-indigo-100 transition-all"
                      >
                        See All ({activePermissionCount} Active)
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {staffList.length === 0 && (
              <div className="col-span-full py-12 text-center bg-white border border-slate-200 rounded-xl text-slate-400 font-medium text-xs shadow-3xs flex flex-col items-center justify-center gap-2">
                <Users size={32} className="text-slate-300 animate-pulse" />
                <span>No staff profiles on file. Click "ADD NEW STAFF PROFILE" to onboard employees.</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* DETAILED PRIVILEGES VIEW MODAL OVERLAY */}
      {viewingStaffDetail && (
        <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-3xs flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="w-full max-w-xl bg-white border border-slate-200 rounded-2xl p-6 shadow-2xl overflow-y-auto max-h-[90vh]">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <Shield className="text-indigo-650" size={18} />
                <h4 className="font-bold text-slate-800 text-sm">Full Permissions: {viewingStaffDetail.first_name} {viewingStaffDetail.surname}</h4>
              </div>
              <button 
                onClick={() => setViewingStaffDetail(null)} 
                className="p-1 text-slate-400 hover:text-slate-900 rounded bg-slate-100 cursor-pointer text-xs font-bold"
              >
                ✕ Close
              </button>
            </div>

            <div className="flex flex-col gap-4 font-sans text-xs">
              {['sales', 'inventory', 'customer', 'reports', 'expense', 'settings', 'staff', 'receipt'].map((sectionKey) => {
                let parsed: Record<string, any> = {};
                try {
                  const raw = viewingStaffDetail.permissions_json ? JSON.parse(viewingStaffDetail.permissions_json) : null;
                  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                    parsed = raw;
                  }
                } catch(e){}
                const rawGroup = parsed[sectionKey];
                const group = rawGroup && typeof rawGroup === 'object' && !Array.isArray(rawGroup) ? rawGroup : {};
                const keys = Object.keys(group);
                
                return (
                  <div key={sectionKey} className="bg-slate-50 p-3 rounded-xl border border-slate-150">
                    <h5 className="font-bold text-slate-850 uppercase tracking-widest text-[10px] mb-2 flex items-center gap-1.5 border-b border-slate-200 pb-1.5">
                      <span className="inline-block w-2 h-2 bg-indigo-600 rounded-full"></span>
                      {sectionKey} PRIVILEGES
                    </h5>
                    <div className="grid grid-cols-2 gap-2">
                      {keys.map((k) => (
                        <div key={k} className="flex items-center gap-2 text-slate-700 font-medium">
                          <CheckSquare size={13} className={group[k] ? 'text-indigo-600' : 'text-slate-300'} />
                          <span className="capitalize">{k.replace(/_/g, ' ')}</span>
                          <span className={`text-[9px] font-black uppercase px-1 rounded ${group[k] ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-400'}`}>
                            {group[k] ? 'ALLOWED' : 'LOCKED'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* REGISTER NEW / EDIT STAFF MODAL DIALOG OVERLAY */}
      {showRegisterModal && (
        <div className="absolute inset-0 bg-slate-950/75 backdrop-blur-3xs flex items-center justify-center p-4 z-50 overflow-y-auto">
          <motion.div 
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-4xl bg-white border border-slate-200 rounded-2xl p-6 flex flex-col gap-5 shadow-2xl overflow-y-auto max-h-[92vh] text-left"
          >
            {/* Modal Header */}
            <div className="flex justify-between items-center border-b border-slate-150 pb-3 shrink-0">
              <div className="flex items-center gap-2">
                <Users className="text-indigo-650" size={18} />
                <div>
                  <h3 className="text-sm font-black uppercase tracking-wider text-slate-800">
                    {editingStaffId ? 'Edit Sale Profile' : 'Onboard New SME Employee'}
                  </h3>
                  <p className="text-[10.5px] text-slate-450 font-medium">Provision personal records, monthly salaries, and tick dynamic privilege authorization gates</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowRegisterModal(false);
                  resetForm();
                }}
                className="text-slate-400 hover:text-slate-900 duration-150 p-1 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>

            <form onSubmit={handleSaveStaff} className="flex-1 overflow-y-auto pr-1 flex flex-col lg:flex-row gap-6">
              
              {/* LEFT COLUMN: STAFF PROFILE DETAILS */}
              <div className="flex-1 flex flex-col gap-3.5 max-w-full lg:max-w-md bg-slate-50/70 p-4 rounded-xl border border-slate-150">
                <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-700 font-mono border-b border-slate-150 pb-1.5 flex items-center gap-1">
                  <span>📝 Personal Records Registry</span>
                </h4>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-450 font-bold uppercase">First Name *</label>
                    <input
                      type="text"
                      required
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      placeholder="e.g. Lombe"
                      className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-slate-800 font-bold focus:outline-hidden"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-450 font-bold uppercase">Surname *</label>
                    <input
                      type="text"
                      required
                      value={surname}
                      onChange={(e) => setSurname(e.target.value)}
                      placeholder="e.g. Kapambwe"
                      className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-slate-800 font-bold focus:outline-hidden"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-450 font-bold uppercase">Contact Phone *</label>
                    <input
                      type="text"
                      required
                      value={contact}
                      onChange={(e) => setContact(e.target.value)}
                      placeholder="+260 971..."
                      className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-slate-800 font-bold focus:outline-hidden"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-450 font-bold uppercase">Email Inbox *</label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@pos.zm"
                      className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-slate-800 font-semibold focus:outline-hidden"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1 text-xs">
                  <label className="text-[10px] text-slate-450 font-bold uppercase">Residential Address *</label>
                  <textarea
                    required
                    value={resAddress}
                    onChange={(e) => setResAddress(e.target.value)}
                    placeholder="Residential house number, street, plot and district details"
                    rows={2}
                    className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-slate-800 font-semibold focus:outline-hidden text-xs resize-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-450 font-bold uppercase">Onboarding Date</label>
                    <input
                      type="date"
                      value={joiningDate}
                      onChange={(e) => setJoiningDate(e.target.value)}
                      className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-slate-800 font-bold focus:outline-hidden"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-450 font-bold uppercase">Basic Monthly Salary ({settings.currency})</label>
                    <input
                      type="number"
                      required
                      value={basicSalary}
                      onChange={(e) => setBasicSalary(e.target.value)}
                      placeholder="8000"
                      className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-slate-800 font-black focus:outline-hidden text-center text-sm"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1 text-xs">
                  <label className="text-[10px] text-slate-450 font-bold uppercase">Supervisor Sign-Off Password / Access PIN *</label>
                  <input
                    type="text"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter secure password (e.g. 1234)"
                    className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-slate-800 font-bold focus:outline-hidden"
                  />
                </div>

                {/* File Upload Sections */}
                <div className="flex flex-col gap-3 py-2 border-t border-slate-200-dashed mt-1.5 text-xs">
                  <div className="bg-white border border-slate-200 rounded-lg p-2.5">
                    <span className="text-[10px] text-slate-450 block font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                      <Upload size={10} className="text-indigo-600" /> Upload NRC Card (PDF / Image)
                    </span>
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      onChange={(e) => handleFileChange(e, 'nrc')}
                      className="w-full text-[10.5px] cursor-pointer text-slate-500 file:mr-2 file:py-1 file:px-2 file:rounded-md file:border-0 file:text-[10px] file:font-black file:bg-indigo-50 file:text-indigo-700"
                    />
                    {nrcFilename && (
                      <span className="text-[10px] text-emerald-600 font-semibold mt-1 inline-block truncate max-w-full">
                        ✓ Attached: {nrcFilename}
                      </span>
                    )}
                  </div>

                  <div className="bg-white border border-slate-200 rounded-lg p-2.5">
                    <span className="text-[10px] text-slate-450 block font-bold uppercase tracking-wider mb-1 flex items-center gap-1">
                      <Upload size={10} className="text-indigo-600" /> Upload Signed Contract Form
                    </span>
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      onChange={(e) => handleFileChange(e, 'contract')}
                      className="w-full text-[10.5px] cursor-pointer text-slate-500 file:mr-2 file:py-1 file:px-2 file:rounded-md file:border-0 file:text-[10px] file:font-black file:bg-indigo-50 file:text-indigo-700"
                    />
                    {contractFilename && (
                      <span className="text-[10px] text-emerald-600 font-semibold mt-1 inline-block truncate max-w-full">
                        ✓ Attached: {contractFilename}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* RIGHT COLUMN: GRANULAR PERMISSION MATRICES */}
              <div className="flex-1 flex flex-col gap-4">
                <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-700 font-mono border-b border-slate-150 pb-1.5 flex items-center gap-1.5">
                  <Shield size={12} className="text-indigo-600 animate-pulse" />
                  <span>🛡️ Granular Authorization Permissions Level</span>
                </h4>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  
                  {/* Sales Perms */}
                  <div className="bg-indigo-50/20 border border-indigo-150 rounded-xl p-3 shadow-3xs">
                    <span className="text-[10px] font-black uppercase text-indigo-700 block tracking-widest pb-1 border-b border-indigo-100 mb-2">
                      💰 Sales Terminal Control
                    </span>
                    <div className="flex flex-col gap-1 text-[11px] font-semibold text-slate-700">
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.sales.discount}
                          onChange={(e) => setPerms({ ...perms, sales: { ...perms.sales, discount: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Discount Cart</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.sales.gift}
                          onChange={(e) => setPerms({ ...perms, sales: { ...perms.sales, gift: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Award Gift Assets</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.sales.add_charges}
                          onChange={(e) => setPerms({ ...perms, sales: { ...perms.sales, add_charges: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Add Service Charges</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.sales.give_credit}
                          onChange={(e) => setPerms({ ...perms, sales: { ...perms.sales, give_credit: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Give Ledger Credit</span>
                      </label>
                    </div>
                  </div>

                  {/* Inventory Perms */}
                  <div className="bg-indigo-50/20 border border-indigo-150 rounded-xl p-3 shadow-3xs">
                    <span className="text-[10px] font-black uppercase text-indigo-700 block tracking-widest pb-1 border-b border-indigo-100 mb-2">
                      📦 Inventory & Warehouse
                    </span>
                    <div className="flex flex-col gap-1 text-[11px] font-semibold text-slate-700">
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.inventory.view_only}
                          onChange={(e) => setPerms({ ...perms, inventory: { ...perms.inventory, view_only: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>View Only Catalogues</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.inventory.create}
                          onChange={(e) => setPerms({ ...perms, inventory: { ...perms.inventory, create: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Create Products / Assets</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.inventory.edit}
                          onChange={(e) => setPerms({ ...perms, inventory: { ...perms.inventory, edit: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Edit Product Parameters</span>
                      </label>
                    </div>
                  </div>

                  {/* Customer Management Perms */}
                  <div className="bg-indigo-50/20 border border-indigo-150 rounded-xl p-3 shadow-3xs">
                    <span className="text-[10px] font-black uppercase text-indigo-700 block tracking-widest pb-1 border-b border-indigo-100 mb-2">
                      👥 Customer Relations Hub
                    </span>
                    <div className="flex flex-col gap-1 text-[11px] font-semibold text-slate-700">
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.customer.view_only}
                          onChange={(e) => setPerms({ ...perms, customer: { ...perms.customer, view_only: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>View Only Profiles</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.customer.create}
                          onChange={(e) => setPerms({ ...perms, customer: { ...perms.customer, create: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Create Client Cards</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.customer.edit}
                          onChange={(e) => setPerms({ ...perms, customer: { ...perms.customer, edit: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Edit Client Parameters</span>
                      </label>
                    </div>
                  </div>

                  {/* Reports and Analytics Perms */}
                  <div className="bg-indigo-50/20 border border-indigo-150 rounded-xl p-3 shadow-3xs">
                    <span className="text-[10px] font-black uppercase text-indigo-700 block tracking-widest pb-1 border-b border-indigo-100 mb-2">
                      📈 Analytics & Reports
                    </span>
                    <div className="flex flex-col gap-0.5 text-[10.5px] font-semibold text-slate-700">
                      <label className="flex items-center gap-2 cursor-pointer p-0.5 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.reports.low_stock}
                          onChange={(e) => setPerms({ ...perms, reports: { ...perms.reports, low_stock: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Low Stock Warnings</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-0.5 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.reports.expired_stock}
                          onChange={(e) => setPerms({ ...perms, reports: { ...perms.reports, expired_stock: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Expired Stock Control</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-0.5 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.reports.profits}
                          onChange={(e) => setPerms({ ...perms, reports: { ...perms.reports, profits: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Gross Net Profits</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-0.5 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.reports.sales}
                          onChange={(e) => setPerms({ ...perms, reports: { ...perms.reports, sales: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Shift Sales Stats</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-0.5 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.reports.payment_modes}
                          onChange={(e) => setPerms({ ...perms, reports: { ...perms.reports, payment_modes: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Payment Models Breakdown</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-0.5 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.reports.sold_by}
                          onChange={(e) => setPerms({ ...perms, reports: { ...perms.reports, sold_by: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Sold-By Logs tracking</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-0.5 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.reports.top_customers}
                          onChange={(e) => setPerms({ ...perms, reports: { ...perms.reports, top_customers: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Top Client loyalty spend</span>
                      </label>
                    </div>
                  </div>

                  {/* Expense Perms */}
                  <div className="bg-indigo-50/20 border border-indigo-150 rounded-xl p-3 shadow-3xs">
                    <span className="text-[10px] font-black uppercase text-indigo-700 block tracking-widest pb-1 border-b border-indigo-100 mb-2">
                      💸 Expense & Payments Out
                    </span>
                    <div className="flex flex-col gap-1 text-[11px] font-semibold text-slate-700">
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.expense.add_expense}
                          onChange={(e) => setPerms({ ...perms, expense: { ...perms.expense, add_expense: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Add Corporate Expense</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.expense.modify_expense}
                          onChange={(e) => setPerms({ ...perms, expense: { ...perms.expense, modify_expense: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Modify Historic Expenses</span>
                      </label>
                    </div>
                  </div>

                  {/* Settings Perms */}
                  <div className="bg-indigo-50/20 border border-indigo-150 rounded-xl p-3 shadow-3xs">
                    <span className="text-[10px] font-black uppercase text-indigo-700 block tracking-widest pb-1 border-b border-indigo-100 mb-2">
                      ⚙️ Enterprise Configuration Settings
                    </span>
                    <div className="flex flex-col gap-1 text-[11px] font-semibold text-slate-700">
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.settings.create_store}
                          onChange={(e) => setPerms({ ...perms, settings: { ...perms.settings, create_store: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Create Stores Outlets</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.settings.manage_settings}
                          onChange={(e) => setPerms({ ...perms, settings: { ...perms.settings, manage_settings: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Manage Corporate Settings</span>
                      </label>
                    </div>
                  </div>

                  {/* Staff & Attendance Perms */}
                  <div className="bg-indigo-50/20 border border-indigo-150 rounded-xl p-3 shadow-3xs">
                    <span className="text-[10px] font-black uppercase text-indigo-700 block tracking-widest pb-1 border-b border-indigo-100 mb-2">
                      👥 Staff & Duty Timesheet
                    </span>
                    <div className="flex flex-col gap-1 text-[11px] font-semibold text-slate-700">
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.staff.attendance_management}
                          onChange={(e) => setPerms({ ...perms, staff: { ...perms.staff, attendance_management: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Attendance Management logs</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.staff.payroll_management}
                          onChange={(e) => setPerms({ ...perms, staff: { ...perms.staff, payroll_management: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Payroll Management calculations</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.staff.manage_staff}
                          onChange={(e) => setPerms({ ...perms, staff: { ...perms.staff, manage_staff: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Onboard / Modify Staff</span>
                      </label>
                    </div>
                  </div>

                  {/* Receipt Management Perms */}
                  <div className="bg-indigo-50/20 border border-indigo-150 rounded-xl p-3 shadow-3xs">
                    <span className="text-[10px] font-black uppercase text-indigo-700 block tracking-widest pb-1 border-b border-indigo-100 mb-2">
                      🧾 Receipts & Transactions History
                    </span>
                    <div className="flex flex-col gap-1 text-[11px] font-semibold text-slate-700">
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.receipt.create_receipt}
                          onChange={(e) => setPerms({ ...perms, receipt: { ...perms.receipt, create_receipt: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Create Receipt Invoice</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.receipt.view_all_receipt}
                          onChange={(e) => setPerms({ ...perms, receipt: { ...perms.receipt, view_all_receipt: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>View All Historic Receipts</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.receipt.edit_receipt}
                          onChange={(e) => setPerms({ ...perms, receipt: { ...perms.receipt, edit_receipt: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Edit Printed Invoices</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-1 rounded hover:bg-white transition-all">
                        <input
                          type="checkbox"
                          checked={perms.receipt.return_receipt}
                          onChange={(e) => setPerms({ ...perms, receipt: { ...perms.receipt, return_receipt: e.target.checked } })}
                          className="accent-indigo-650 h-3.5 w-3.5"
                        />
                        <span>Accept Returns & Return Receipt</span>
                      </label>
                    </div>
                  </div>

                </div>
              </div>

            </form>

            {/* Modal Actions Footer */}
            <div className="flex justify-end gap-2.5 border-t border-slate-150 pt-3 shrink-0 select-none">
              <button
                type="button"
                onClick={() => {
                  setShowRegisterModal(false);
                  resetForm();
                }}
                className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg text-xs font-bold cursor-pointer hover:bg-slate-50 transition-all"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveStaff}
                className="px-5 py-2 bg-indigo-650 hover:bg-indigo-700 text-white rounded-lg text-xs font-black shadow-3xs cursor-pointer select-none"
              >
                {editingStaffId ? 'Save Profile Settings' : 'Onboard Employee'}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* SALARY ADDITIONS & DEDUCTIONS EDITOR MODAL */}
      {editingPayroll && (
        <div className="absolute inset-0 bg-slate-950/75 backdrop-blur-3xs flex items-center justify-center p-4 z-50 overflow-y-auto">
          <motion.div
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-4xl bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-4 shadow-2xl max-h-[92vh] overflow-y-auto"
          >
            <div className="flex justify-between items-start border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-black uppercase tracking-wider text-slate-900 flex items-center gap-2">
                  <Calculator size={16} className="text-indigo-600" />
                  <span>Salary Adjustments — {editingPayroll.employee_name}</span>
                </h3>
                <p className="text-xs text-slate-500">
                  {editingPayroll.employee_role} • Pay Period: <span className="font-bold text-slate-700">{formatPayPeriodLabel(editingPayroll.pay_period)}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingPayroll(null)}
                className="p-1.5 text-slate-400 hover:text-slate-900 bg-slate-100 rounded-lg cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>

            {/* Basic Salary & Payment Details */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200 text-xs">
              <div>
                <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                  Basic Monthly Salary ({settings.currency})
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={draftBasicSalary}
                  onChange={(e) => setDraftBasicSalary(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 font-mono font-black text-slate-900"
                />
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                  Disbursement Account
                </label>
                <select
                  value={draftPayAccount}
                  onChange={(e) => setDraftPayAccount(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 font-bold text-slate-800"
                >
                  {selectableAccounts.map((acc) => (
                    <option key={acc.accountId} value={acc.accountId}>
                      {acc.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                  Payment Date
                </label>
                <input
                  type="date"
                  value={draftPayDate}
                  onChange={(e) => setDraftPayDate(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 font-bold text-slate-800"
                />
              </div>
            </div>

            {/* Two-Column Additions & Deductions Builders */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* ADDITIONS (+) */}
              <div className="bg-emerald-50/40 border border-emerald-200 rounded-xl p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between border-b border-emerald-200/70 pb-2">
                  <span className="text-xs font-black uppercase text-emerald-900 flex items-center gap-1.5">
                    <PlusCircle size={14} className="text-emerald-600" />
                    Add to Salary (Bonuses & Allowances)
                  </span>
                  <span className="font-mono font-black text-xs text-emerald-700">
                    +{settings.currency}{draftAdditions.reduce((s, x) => s + x.amount, 0).toFixed(2)}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                  <select
                    value={newAddCategory}
                    onChange={(e) => setNewAddCategory(e.target.value)}
                    className="bg-white border border-emerald-200 rounded-lg px-2 py-1.5 font-bold text-slate-800"
                  >
                    {ADDITION_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Note (optional)"
                    value={newAddDescription}
                    onChange={(e) => setNewAddDescription(e.target.value)}
                    className="bg-white border border-emerald-200 rounded-lg px-2.5 py-1.5 text-slate-800"
                  />
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      step="0.01"
                      placeholder="Amount"
                      value={newAddAmount}
                      onChange={(e) => setNewAddAmount(e.target.value)}
                      className="w-full bg-white border border-emerald-200 rounded-lg px-2 py-1.5 font-mono font-bold text-slate-900"
                    />
                    <button
                      type="button"
                      onClick={handleAddAdditionItem}
                      className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-black cursor-pointer shrink-0"
                    >
                      + Add
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5 max-h-44 overflow-y-auto">
                  {draftAdditions.length === 0 ? (
                    <p className="text-[11px] text-slate-400 italic py-2">
                      No bonuses or allowances added yet.
                    </p>
                  ) : (
                    draftAdditions.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between bg-white border border-emerald-100 rounded-lg px-3 py-1.5 text-xs"
                      >
                        <div>
                          <span className="font-bold text-slate-800">{item.category}</span>
                          {item.description !== item.category && (
                            <span className="text-slate-500 ml-1.5">({item.description})</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-black text-emerald-700">
                            +{settings.currency}{item.amount.toFixed(2)}
                          </span>
                          <button
                            type="button"
                            onClick={() => setDraftAdditions((prev) => prev.filter((x) => x.id !== item.id))}
                            className="text-slate-400 hover:text-rose-600 cursor-pointer"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* DEDUCTIONS (-) */}
              <div className="bg-rose-50/40 border border-rose-200 rounded-xl p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between border-b border-rose-200/70 pb-2">
                  <span className="text-xs font-black uppercase text-rose-900 flex items-center gap-1.5">
                    <MinusCircle size={14} className="text-rose-600" />
                    Deduct from Salary (Advances, Tax, Loans)
                  </span>
                  <span className="font-mono font-black text-xs text-rose-700">
                    -{settings.currency}{draftDeductions.reduce((s, x) => s + x.amount, 0).toFixed(2)}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                  <select
                    value={newDedCategory}
                    onChange={(e) => setNewDedCategory(e.target.value)}
                    className="bg-white border border-rose-200 rounded-lg px-2 py-1.5 font-bold text-slate-800"
                  >
                    {DEDUCTION_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Note (optional)"
                    value={newDedDescription}
                    onChange={(e) => setNewDedDescription(e.target.value)}
                    className="bg-white border border-rose-200 rounded-lg px-2.5 py-1.5 text-slate-800"
                  />
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      step="0.01"
                      placeholder="Amount"
                      value={newDedAmount}
                      onChange={(e) => setNewDedAmount(e.target.value)}
                      className="w-full bg-white border border-rose-200 rounded-lg px-2 py-1.5 font-mono font-bold text-slate-900"
                    />
                    <button
                      type="button"
                      onClick={handleAddDeductionItem}
                      className="px-2.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-black cursor-pointer shrink-0"
                    >
                      - Deduct
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5 max-h-44 overflow-y-auto">
                  {draftDeductions.length === 0 ? (
                    <p className="text-[11px] text-slate-400 italic py-2">
                      No salary advances or deductions applied yet.
                    </p>
                  ) : (
                    draftDeductions.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between bg-white border border-rose-100 rounded-lg px-3 py-1.5 text-xs"
                      >
                        <div>
                          <span className="font-bold text-slate-800">{item.category}</span>
                          {item.description !== item.category && (
                            <span className="text-slate-500 ml-1.5">({item.description})</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-black text-rose-700">
                            -{settings.currency}{item.amount.toFixed(2)}
                          </span>
                          <button
                            type="button"
                            onClick={() => setDraftDeductions((prev) => prev.filter((x) => x.id !== item.id))}
                            className="text-slate-400 hover:text-rose-600 cursor-pointer"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Notes & Live Summary Strip */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
              <div>
                <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                  Payslip Remarks / Notes (Printed on PDF)
                </label>
                <input
                  type="text"
                  value={draftNotes}
                  onChange={(e) => setDraftNotes(e.target.value)}
                  placeholder="e.g. Monthly salary settlement including sales bonus & advance recovery"
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-800"
                />
              </div>

              {(() => {
                const b = Math.max(0, parseFloat(draftBasicSalary) || 0);
                const a = draftAdditions.reduce((s, x) => s + x.amount, 0);
                const d = draftDeductions.reduce((s, x) => s + x.amount, 0);
                const g = b + a;
                const net = g - d;
                return (
                  <div className="bg-slate-900 text-white rounded-xl px-4 py-3 flex items-center justify-between">
                    <div className="text-[11px] space-y-0.5 text-slate-300">
                      <div>Gross: <span className="font-mono font-bold text-white">{settings.currency}{g.toFixed(2)}</span></div>
                      <div>Deductions: <span className="font-mono font-bold text-rose-300">-{settings.currency}{d.toFixed(2)}</span></div>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] font-black uppercase text-emerald-300 block">Net Take-Home</span>
                      <span className="text-xl font-black font-mono text-white">
                        {settings.currency}{net.toFixed(2)}
                      </span>
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={() => setEditingPayroll(null)}
                className="px-4 py-2 border border-slate-200 text-slate-600 rounded-xl text-xs font-bold hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => savePayrollEditorChanges()}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-extrabold cursor-pointer"
              >
                Save Changes
              </button>
              <button
                type="button"
                onClick={async () => {
                  const saved = savePayrollEditorChanges();
                  if (saved) await handleDownloadPayslipPdf(saved);
                }}
                className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-extrabold cursor-pointer flex items-center gap-1.5"
              >
                <FileText size={13} />
                <span>Save & Payslip PDF</span>
              </button>
              {editingPayroll.status !== 'PAID' && (
                <button
                  type="button"
                  onClick={() => savePayrollEditorChanges('PAID')}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-extrabold cursor-pointer"
                >
                  Save & Mark Paid
                </button>
              )}
            </div>
          </motion.div>
        </div>
      )}

      {/* ADD AD-HOC EMPLOYEE PAYROLL MODAL */}
      {showAddCustomPayrollModal && (
        <div className="absolute inset-0 bg-slate-950/75 backdrop-blur-3xs flex items-center justify-center p-4 z-50">
          <form
            onSubmit={handleCreateCustomPayroll}
            className="w-full max-w-md bg-white border border-slate-200 rounded-2xl p-5 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
              <h3 className="text-sm font-black uppercase text-slate-900">
                Add Employee to {formatPayPeriodLabel(selectedPayPeriod)} Payroll
              </h3>
              <button
                type="button"
                onClick={() => setShowAddCustomPayrollModal(false)}
                className="p-1 bg-slate-100 rounded-lg text-slate-500 cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>
            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Employee Full Name *</label>
                <input
                  type="text"
                  required
                  value={customEmpName}
                  onChange={(e) => setCustomEmpName(e.target.value)}
                  placeholder="e.g. Chanda Mulenga"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 font-bold text-slate-900"
                />
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">Role / Designation</label>
                <input
                  type="text"
                  value={customEmpRole}
                  onChange={(e) => setCustomEmpRole(e.target.value)}
                  placeholder="e.g. Cashier / Driver"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 font-semibold text-slate-800"
                />
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                  Basic Monthly Salary ({settings.currency}) *
                </label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={customEmpSalary}
                  onChange={(e) => setCustomEmpSalary(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 font-mono font-black text-slate-900"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowAddCustomPayrollModal(false)}
                className="px-4 py-2 border border-slate-200 rounded-xl text-xs font-bold text-slate-600 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-extrabold cursor-pointer"
              >
                Add to Payroll
              </button>
            </div>
          </form>
        </div>
      )}

      {/* IN-UI CONFIRMATION MODAL FOR PAYROLL ACTIONS */}
      {payrollConfirmAction && (
        <div className="absolute inset-0 bg-slate-950/75 backdrop-blur-3xs flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl p-5 shadow-2xl space-y-4">
            <h3 className="text-sm font-black uppercase text-slate-900">{payrollConfirmAction.title}</h3>
            <p className="text-xs text-slate-600 leading-relaxed">{payrollConfirmAction.message}</p>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setPayrollConfirmAction(null)}
                className="px-4 py-2 border border-slate-200 rounded-xl text-xs font-bold text-slate-600 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const fn = payrollConfirmAction.onConfirm;
                  setPayrollConfirmAction(null);
                  fn();
                }}
                className={`px-4 py-2 text-white rounded-xl text-xs font-extrabold cursor-pointer ${
                  payrollConfirmAction.tone === 'emerald'
                    ? 'bg-emerald-600 hover:bg-emerald-700'
                    : 'bg-rose-600 hover:bg-rose-700'
                }`}
              >
                {payrollConfirmAction.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
