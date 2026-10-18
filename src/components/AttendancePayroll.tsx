import React, { useState, useEffect } from 'react';
import { runSql, persistTablesToStorage } from '../db';
import { safeSystemPrint } from '../androidUtils';
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
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { StoreSettings } from '../types';

interface AttendancePayrollProps {
  settings: StoreSettings;
  userRole?: string;
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

export default function AttendancePayroll({ settings, userRole = 'owner' }: AttendancePayrollProps) {
  const [records, setRecords] = useState<TimesheetRecord[]>([]);
  const [employeeNameInput, setEmployeeNameInput] = useState('');
  const [employeeRoleInput, setEmployeeRoleInput] = useState('Sales Person');
  const [hourlyRateInput, setHourlyRateInput] = useState('25.00');
  const [selectedStaff, setSelectedStaff] = useState<string>('');
  
  // Navigation & detailed staff views hooks
  const [activeSubTab, setActiveSubTab] = useState<'clock' | 'roster'>('clock');
  const [staffList, setStaffList] = useState<any[]>([]);
  const [editingStaffId, setEditingStaffId] = useState<string | null>(null);
  const [showRegisterModal, setShowRegisterModal] = useState(false);
  const [viewingStaffDetail, setViewingStaffDetail] = useState<any | null>(null);

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
  const [perms, setPerms] = useState({
    sales: { discount: true, gift: false, add_charges: false, give_credit: false },
    inventory: { view_only: true, create: false, edit: false },
    customer: { view_only: true, create: false, edit: false },
    reports: { low_stock: false, expired_stock: false, profits: false, sales: false, payment_modes: false, sold_by: false, top_customers: false },
    expense: { add_expense: false, modify_expense: false },
    settings: { create_store: false, manage_settings: false },
    staff: { attendance_management: false, payroll_management: false, manage_staff: false },
    receipt: { create_receipt: true, view_all_receipt: true, edit_receipt: false, return_receipt: false }
  });
  
  // Quick clock in / out selections
  const [quickName, setQuickName] = useState('');
  const [successNote, setSuccessNote] = useState('');

  // Active employees list unique (linked dynamically to staff on load)
  const [employeeList, setEmployeeList] = useState<{name: string, role: string, rate: number}[]>([]);

  const loadStaffMembers = () => {
    const res = runSql('SELECT * FROM staff', 'Staff: Fetch all registered profiles');
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
    const res = runSql('SELECT * FROM time_attendance ORDER BY date DESC, clock_in DESC', 'Attendance: Retrieve worktimes cards');
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

  useEffect(() => {
    loadAttendance();
    loadStaffMembers();
  }, []);

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
    setPerms({
      sales: { discount: true, gift: false, add_charges: false, give_credit: false },
      inventory: { view_only: true, create: false, edit: false },
      customer: { view_only: true, create: false, edit: false },
      reports: { low_stock: false, expired_stock: false, profits: false, sales: false, payment_modes: false, sold_by: false, top_customers: false },
      expense: { add_expense: false, modify_expense: false },
      settings: { create_store: false, manage_settings: false },
      staff: { attendance_management: false, payroll_management: false, manage_staff: false },
      receipt: { create_receipt: true, view_all_receipt: true, edit_receipt: false, return_receipt: false }
    });
  };

  const handleSaveStaff = (e: React.FormEvent) => {
    e.preventDefault();
    if (userRole === 'sales') {
      alert('Access Denied: Only Business Owners or Store Managers can configure staff accounts.');
      return;
    }
    
    if (!firstName || !surname || !contact || !email) {
      alert('Please fill out first name, surname, contact and email address.');
      return;
    }
    
    const salaryNum = parseFloat(basicSalary) || 0;
    const permissionsString = JSON.stringify(perms);
    const staffId = editingStaffId || `staff-${Math.floor(1000 + Math.random() * 9000)}`;
    
    if (editingStaffId) {
      const sql = `
        UPDATE staff 
        SET first_name = '${firstName.replace(/'/g, "''")}',
            surname = '${surname.replace(/'/g, "''")}',
            contact = '${contact.replace(/'/g, "''")}',
            email = '${email.replace(/'/g, "''")}',
            residential_address = '${resAddress.replace(/'/g, "''")}',
            joining_date = '${joiningDate}',
            nrc_file = '${nrcFile.replace(/'/g, "''")}',
            nrc_filename = '${nrcFilename.replace(/'/g, "''")}',
            contract_file = '${contractFile.replace(/'/g, "''")}',
            contract_filename = '${contractFilename.replace(/'/g, "''")}',
            basic_salary = ${salaryNum},
            permissions_json = '${permissionsString.replace(/'/g, "''")}',
            password = '${password.replace(/'/g, "''")}'
        WHERE id = '${editingStaffId}'
      `;
      const res = runSql(sql, `Staff: Update profile ${staffId}`);
      if (res.success) {
        alert(`✓ Staff Profile Updated: Changed details for ${firstName} ${surname}.`);
      }
    } else {
      const sql = `
        INSERT INTO staff (id, first_name, surname, contact, email, residential_address, joining_date, nrc_file, nrc_filename, contract_file, contract_filename, basic_salary, permissions_json, business_id, password)
        VALUES (
          '${staffId}',
          '${firstName.replace(/'/g, "''")}',
          '${surname.replace(/'/g, "''")}',
          '${contact.replace(/'/g, "''")}',
          '${email.replace(/'/g, "''")}',
          '${resAddress.replace(/'/g, "''")}',
          '${joiningDate}',
          '${nrcFile.replace(/'/g, "''")}',
          '${nrcFilename.replace(/'/g, "''")}',
          '${contractFile.replace(/'/g, "''")}',
          '${contractFilename.replace(/'/g, "''")}',
          ${salaryNum},
          '${permissionsString.replace(/'/g, "''")}',
          'default_biz',
          '${password.replace(/'/g, "''")}'
        )
      `;
      const res = runSql(sql, `Staff: Onboard new profile ${staffId}`);
      if (res.success) {
        alert(`✓ Staff Profile Registered: Successfully onboarded ${firstName} ${surname}.`);
      }
    }
    
    resetForm();
    setShowRegisterModal(false);
    loadStaffMembers();
    persistTablesToStorage();
  };

  const handleEditStaff = (st: any) => {
    setEditingStaffId(st.id);
    setFirstName(st.first_name);
    setSurname(st.surname);
    setContact(st.contact);
    setEmail(st.email);
    setResAddress(st.residential_address);
    setJoiningDate(st.joining_date);
    setBasicSalary(st.basic_salary.toString());
    setPassword(st.password || '1234');
    setNrcFile(st.nrc_file || '');
    setNrcFilename(st.nrc_filename || '');
    setContractFile(st.contract_file || '');
    setContractFilename(st.contract_filename || '');
    try {
      if (st.permissions_json) {
        setPerms(JSON.parse(st.permissions_json));
      }
    } catch (e) {
      console.error(e);
    }
    setShowRegisterModal(true);
  };

  const handleDeleteStaff = (id: string, name: string) => {
    if (userRole === 'sales') {
      alert('Access Denied: Only Business Owners can terminate rosters.');
      return;
    }
    if (confirm(`Are you absolutely sure you want to delete staff member "${name}"? This removes their credentials permanently.`)) {
      const res = runSql(`DELETE FROM staff WHERE id = '${id}'`, `Staff: Delete profile ${id}`);
      if (res.success) {
        alert(`Deleted staff member ${name}`);
        loadStaffMembers();
        persistTablesToStorage();
      }
    }
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

    // Check if player has already checked in and not checked out yet today
    const activeRes = runSql(`
      SELECT * FROM time_attendance 
      WHERE employee_name = '${quickName.replace(/'/g, "''")}' AND clock_out IS NULL
    `, 'Attendance: Guard active shifts');

    if (activeRes.success && activeRes.data && activeRes.data.length > 0) {
      alert(`Access Warning: Employee ${quickName} has an active clocked-in session currently! Please clock out first.`);
      return;
    }

    const recId = 'attend-' + Math.floor(1000 + Math.random() * 9000);
    const insertSql = `
      INSERT INTO time_attendance (id, employee_name, employee_role, date, clock_in, clock_out, hours_worked, hourly_rate, gross_payment, status)
      VALUES (
        '${recId}',
        '${quickName.replace(/'/g, "''")}',
        '${role}',
        '${todayStr}',
        '${timeStr}',
        NULL,
        0,
        ${rate},
        0,
        'PENDING'
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

    const updateSql = `
      UPDATE time_attendance 
      SET clock_out = '${timeStr}', hours_worked = ${diffHours}, gross_payment = ${gross} 
      WHERE id = '${recordId}'
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
    const updateSql = `
      UPDATE time_attendance 
      SET status = 'PAID' 
      WHERE employee_name = '${employeeName.replace(/'/g, "''")}' AND status = 'PENDING' AND clock_out IS NOT NULL
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

  const handlePrintPayrollPDF = () => {
    // Print window triggers safe system print event
    safeSystemPrint();
  };

  return (
    <div className="flex-1 flex overflow-hidden flex-col bg-slate-50 relative">
      
      {/* Title Header bar */}
      <div className="px-5 py-4 bg-white border-b border-slate-200 flex flex-wrap justify-between items-center gap-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
            <Clock size={20} />
          </div>
          <div>
            <h2 className="text-md font-bold text-slate-800">Time Clock, Payroll & Roles</h2>
            <p className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">Attendance Ledger & Dual Dynamic Permissions Matrix</p>
          </div>
        </div>

        {/* Tab Navigation selectors */}
        <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200/60 max-w-full">
          <button
            onClick={() => setActiveSubTab('clock')}
            className={`px-4 py-2 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
              activeSubTab === 'clock' 
                ? 'bg-white text-indigo-600 shadow-sm' 
                : 'text-slate-500 hover:text-slate-900'
            }`}
          >
            <Clock size={13} />
            Shifts & Payouts
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
          className="flex items-center gap-1.5 px-3.5 py-2 border border-slate-250 hover:bg-slate-50 text-slate-600 rounded-lg text-xs font-bold cursor-pointer"
        >
          <Printer size={13} />
          PRINT REPORT (PDF)
        </button>
      </div>

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
              let parsedPerms: any = {};
              try {
                if (st.permissions_json) parsedPerms = JSON.parse(st.permissions_json);
              } catch (e) {
                console.error(e);
              }

              return (
                <div key={st.id} className="bg-white border border-slate-200 rounded-xl p-4 shadow-3xs hover:shadow-2xs transition-all flex flex-col justify-between">
                  <div>
                    {/* Member Information Header */}
                    <div className="flex justify-between items-start border-b border-slate-100 pb-3 mb-3">
                      <div>
                        <h4 className="text-sm font-black text-slate-800">{st.first_name} {st.surname}</h4>
                        <span className="text-[10px] bg-indigo-50 font-semibold px-2 py-0.5 text-indigo-700 rounded-full mt-1 inline-block uppercase">
                          K{st.basic_salary}/mo Basic
                        </span>
                      </div>
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleEditStaff(st)}
                          className="p-1 hover:bg-slate-100 text-indigo-600 rounded cursor-pointer"
                          title="Edit Profile"
                        >
                          <Edit size={13} />
                        </button>
                        <button
                          onClick={() => handleDeleteStaff(st.id, `${st.first_name} ${st.surname}`)}
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
                        See All ({Object.values(parsedPerms).reduce((sum: number, section: any) => sum + Object.values(section).filter(Boolean).length, 0)} Active)
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
                let parsed: any = {};
                try {
                  if (viewingStaffDetail.permissions_json) parsed = JSON.parse(viewingStaffDetail.permissions_json);
                } catch(e){}
                const group = parsed[sectionKey] || {};
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

    </div>
  );
}
