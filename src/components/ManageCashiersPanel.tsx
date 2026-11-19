import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
} from 'lucide-react';
import {
  StaffMember,
  createCashier,
  deleteCashier,
  fetchStaffMembers,
  getLocalStaffMembers,
  resetCashierPin,
  toggleCashierStatus,
} from '../services/terminalAuthService';

interface ManageCashiersPanelProps {
  businessId: string;
  businessName: string;
  onSwitchToCashierPinMode?: () => void;
}

export default function ManageCashiersPanel({
  businessId,
  businessName,
  onSwitchToCashierPinMode,
}: ManageCashiersPanelProps) {
  const [cashiers, setCashiers] = useState<StaffMember[]>(() => getLocalStaffMembers(businessId));
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [role, setRole] = useState<'cashier' | 'manager'>('cashier');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [revealedPinIds, setRevealedPinIds] = useState<Record<string, boolean>>({});
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resetPinValue, setResetPinValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const loadRoster = async () => {
    if (!businessId) return;
    setIsLoading(true);
    try {
      const list = await fetchStaffMembers(businessId);
      setCashiers(list);
    } catch {
      setCashiers(getLocalStaffMembers(businessId));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setCashiers(getLocalStaffMembers(businessId));
    void loadRoster();

    const onUpdated = () => {
      setCashiers(getLocalStaffMembers(businessId));
    };
    window.addEventListener('pos_data_updated', onUpdated);
    return () => window.removeEventListener('pos_data_updated', onUpdated);
  }, [businessId]);

  const generateUniquePin = () => {
    const usedPins = new Set(cashiers.map((c) => c.pin));
    for (let i = 0; i < 100; i++) {
      const candidate = String(Math.floor(1000 + Math.random() * 9000));
      if (!usedPins.has(candidate)) {
        setPin(candidate);
        setFeedback(null);
        return;
      }
    }
  };

  const handleAddCashier = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    setIsSaving(true);
    try {
      const created = await createCashier({
        businessId,
        name,
        pin,
        role,
      });
      setCashiers((prev) => [...prev.filter((c) => c.id !== created.id), created]);
      setName('');
      setPin('');
      setRole('cashier');
      setFeedback({
        type: 'success',
        text: `Added ${created.role === 'manager' ? 'Manager' : 'Cashier'} "${created.name}" with 4-digit PIN (synced to Firebase).`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err?.message || 'Failed to add cashier.' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleActive = async (member: StaffMember) => {
    setFeedback(null);
    try {
      const updated = await toggleCashierStatus(businessId, member.id, !member.isActive);
      setCashiers((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setFeedback({
        type: 'success',
        text: `${updated.name} is now ${updated.isActive ? 'ACTIVE' : 'INACTIVE'} on the POS lock screen.`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err?.message || 'Failed updating status.' });
    }
  };

  const handleSaveResetPin = async (member: StaffMember) => {
    setFeedback(null);
    try {
      const updated = await resetCashierPin(businessId, member.id, resetPinValue);
      setCashiers((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setResettingId(null);
      setResetPinValue('');
      setFeedback({
        type: 'success',
        text: `Updated 4-digit PIN for "${updated.name}".`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err?.message || 'Failed resetting PIN.' });
    }
  };

  const handleRemoveCashier = async (member: StaffMember) => {
    setFeedback(null);
    try {
      await deleteCashier(businessId, member.id);
      setCashiers((prev) => prev.filter((c) => c.id !== member.id));
      setConfirmDeleteId(null);
      setFeedback({
        type: 'success',
        text: `Removed "${member.name}" from terminal PIN access.`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err?.message || 'Failed removing cashier.' });
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs flex flex-col gap-4 text-left">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3.5">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-emerald-600 text-white shadow-xs">
            <KeyRound size={17} />
          </div>
          <div>
            <h3 className="text-sm font-black uppercase tracking-wider text-slate-900">
              Manage Cashiers &amp; Terminal PINs
            </h3>
            <p className="text-[11px] text-slate-500">
              Cashiers log in on this device with a unique 4-digit PIN only (no email required) — scoped to{' '}
              <span className="font-bold text-slate-700">{businessName || businessId}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadRoster()}
            disabled={isLoading}
            className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
            <span>Sync PINs</span>
          </button>
          {onSwitchToCashierPinMode && (
            <button
              type="button"
              onClick={onSwitchToCashierPinMode}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black uppercase tracking-wider flex items-center gap-1.5 cursor-pointer shadow-sm transition-all"
            >
              <Lock size={14} />
              <span>Switch to Cashier PIN Mode</span>
            </button>
          )}
        </div>
      </div>

      {feedback && (
        <div
          className={`px-3.5 py-2.5 rounded-xl border text-xs font-bold flex items-center justify-between gap-2 ${
            feedback.type === 'error'
              ? 'bg-rose-50 border-rose-200 text-rose-800'
              : 'bg-emerald-50 border-emerald-200 text-emerald-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedback.type === 'error' ? <AlertCircle size={15} /> : <Check size={15} />}
            <span>{feedback.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-[10px] font-black uppercase px-2 py-0.5 rounded hover:bg-black/5 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Add Cashier Form (Name + 4-Digit PIN + Role — NO Email) */}
        <form
          onSubmit={handleAddCashier}
          className="lg:col-span-1 bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-col gap-3"
        >
          <div className="flex items-center gap-1.5 border-b border-slate-200 pb-2">
            <UserPlus size={14} className="text-emerald-600" />
            <span className="text-xs font-black uppercase tracking-wider text-slate-800">
              Add Cashier / Manager PIN
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-extrabold uppercase text-slate-500">
              Staff Full Name *
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. John Banda"
              className="w-full px-3 py-2 bg-white border border-slate-200 focus:border-emerald-500 focus:outline-hidden rounded-lg text-xs font-bold text-slate-800"
            />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-extrabold uppercase text-slate-500">
                4-Digit Terminal PIN *
              </label>
              <button
                type="button"
                onClick={generateUniquePin}
                className="text-[10px] font-black text-indigo-600 hover:text-indigo-700 cursor-pointer"
              >
                Auto-Generate
              </button>
            </div>
            <input
              type="text"
              inputMode="numeric"
              maxLength={4}
              required
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="4 digits (e.g. 4829)"
              className="w-full px-3 py-2 bg-white border border-slate-200 focus:border-emerald-500 focus:outline-hidden rounded-lg text-sm font-mono font-black tracking-[0.35em] text-slate-900"
            />
            <span className="text-[10px] text-slate-400">
              Must be 4 digits &amp; unique within this shop.
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-extrabold uppercase text-slate-500">
              Terminal Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'cashier' | 'manager')}
              className="w-full px-3 py-2 bg-white border border-slate-200 focus:border-emerald-500 focus:outline-hidden rounded-lg text-xs font-bold text-slate-800 cursor-pointer"
            >
              <option value="cashier">Cashier (POS Sales Only)</option>
              <option value="manager">Manager (POS + Admin PIN Unlock)</option>
            </select>
          </div>

          <button
            type="submit"
            disabled={isSaving || pin.length !== 4 || !name.trim()}
            className="mt-1 py-2.5 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-black uppercase tracking-wider cursor-pointer transition-all disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            <UserPlus size={14} />
            <span>{isSaving ? 'Saving...' : 'Create Cashier PIN'}</span>
          </button>
        </form>

        {/* Cashiers List */}
        <div className="lg:col-span-2 flex flex-col gap-2.5">
          {cashiers.length === 0 ? (
            <div className="flex-1 min-h-[180px] rounded-xl border border-dashed border-slate-300 bg-slate-50 flex flex-col items-center justify-center p-6 text-center gap-2">
              <KeyRound size={24} className="text-slate-400" />
              <p className="text-xs font-bold text-slate-600">
                No PIN cashiers created yet for {businessName || 'this business'}.
              </p>
              <p className="text-[11px] text-slate-400 max-w-sm">
                Add your first cashier with a 4-digit PIN on the left, then click &ldquo;Switch to Cashier PIN Mode&rdquo; to lock the dashboard and launch the POS keypad.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 font-extrabold text-[10px] uppercase tracking-wider border-b border-slate-200">
                    <th className="py-2.5 px-3">Staff Name</th>
                    <th className="py-2.5 px-3">Role</th>
                    <th className="py-2.5 px-3">4-Digit PIN</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {cashiers.map((member) => {
                    const isPinRevealed = Boolean(revealedPinIds[member.id]);
                    const isResetting = resettingId === member.id;
                    const isDeleting = confirmDeleteId === member.id;
                    return (
                      <tr key={member.id} className={member.isActive ? 'bg-white' : 'bg-rose-50/40'}>
                        <td className="py-2.5 px-3 font-extrabold text-slate-900">
                          {member.name}
                        </td>
                        <td className="py-2.5 px-3">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-black uppercase ${
                              member.role === 'manager'
                                ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                                : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            }`}
                          >
                            {member.role === 'manager' && <ShieldCheck size={11} />}
                            {member.role}
                          </span>
                        </td>
                        <td className="py-2.5 px-3">
                          {isResetting ? (
                            <div className="flex items-center gap-1.5">
                              <input
                                type="text"
                                inputMode="numeric"
                                maxLength={4}
                                value={resetPinValue}
                                onChange={(e) =>
                                  setResetPinValue(e.target.value.replace(/\D/g, '').slice(0, 4))
                                }
                                placeholder="New PIN"
                                className="w-20 px-2 py-1 rounded border border-indigo-400 font-mono text-xs font-black text-center"
                              />
                              <button
                                type="button"
                                onClick={() => void handleSaveResetPin(member)}
                                className="px-2 py-1 rounded bg-emerald-600 text-white text-[10px] font-black cursor-pointer"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setResettingId(null);
                                  setResetPinValue('');
                                }}
                                className="px-2 py-1 rounded bg-slate-200 text-slate-700 text-[10px] font-bold cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono font-black tracking-widest text-slate-800 bg-slate-100 px-2 py-0.5 rounded">
                                {isPinRevealed ? member.pin : '••••'}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setRevealedPinIds((prev) => ({
                                    ...prev,
                                    [member.id]: !prev[member.id],
                                  }))
                                }
                                className="p-1 text-slate-500 hover:text-slate-800 cursor-pointer"
                                title={isPinRevealed ? 'Hide PIN' : 'Show PIN'}
                              >
                                {isPinRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                              </button>
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-3">
                          <span
                            className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase ${
                              member.isActive
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-rose-100 text-rose-700'
                            }`}
                          >
                            {member.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {isDeleting ? (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => void handleRemoveCashier(member)}
                                className="px-2 py-1 rounded bg-rose-600 text-white text-[10px] font-black cursor-pointer"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="px-2 py-1 rounded bg-slate-200 text-slate-700 text-[10px] font-bold cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setResettingId(member.id);
                                  setResetPinValue('');
                                }}
                                className="px-2 py-1 rounded bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-[10px] font-bold cursor-pointer"
                              >
                                Reset PIN
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleToggleActive(member)}
                                className={`px-2 py-1 rounded border text-[10px] font-bold cursor-pointer inline-flex items-center gap-1 ${
                                  member.isActive
                                    ? 'bg-amber-50 hover:bg-amber-100 text-amber-800 border-amber-200'
                                    : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border-emerald-200'
                                }`}
                              >
                                {member.isActive ? <UserX size={11} /> : <UserCheck size={11} />}
                                {member.isActive ? 'Deactivate' : 'Activate'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(member.id)}
                                className="p-1 rounded bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 cursor-pointer"
                                title="Delete Cashier"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
