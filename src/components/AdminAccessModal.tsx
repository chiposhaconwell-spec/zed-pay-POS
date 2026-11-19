import React, { useState } from 'react';
import { motion } from 'motion/react';
import { AlertCircle, KeyRound, Lock, LogOut, ShieldCheck, Unlock, X } from 'lucide-react';
import { BusinessSession, verifyAdminUnlock } from '../services/terminalAuthService';

interface AdminAccessModalProps {
  isOpen: boolean;
  businessSession: BusinessSession;
  onClose: () => void;
  onUnlockAdminDashboard: (verifiedInfo: { verifiedBy: string; role: 'owner' | 'manager' }) => void;
  onDeviceLogout: () => Promise<void> | void;
}

export default function AdminAccessModal({
  isOpen,
  businessSession,
  onClose,
  onUnlockAdminDashboard,
  onDeviceLogout,
}: AdminAccessModalProps) {
  const [authMode, setAuthMode] = useState<'password' | 'pin'>('password');
  const [passwordInput, setPasswordInput] = useState('');
  const [managerPinInput, setManagerPinInput] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  if (!isOpen) return null;

  const handleVerify = async (actionAfterVerify: 'admin' | 'logout') => {
    setErrorMsg(null);
    setIsChecking(true);
    try {
      const result = await verifyAdminUnlock({
        businessId: businessSession.businessId,
        ownerEmail: businessSession.ownerEmail,
        mode: authMode,
        password: passwordInput,
        pin: managerPinInput,
      });

      if (!result.ok) {
        setErrorMsg(result.error || 'Verification failed.');
        return;
      }

      setPasswordInput('');
      setManagerPinInput('');
      if (actionAfterVerify === 'logout') {
        await onDeviceLogout();
      } else {
        onUnlockAdminDashboard({ verifiedBy: result.verifiedBy, role: result.role });
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to verify credentials.');
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4 select-none">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden text-slate-100"
      >
        <div className="px-5 py-4 bg-slate-950/80 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-indigo-500/15 border border-indigo-500/40 flex items-center justify-center text-indigo-400">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-wider text-white">
                Admin Access Verification
              </h3>
              <p className="text-[11px] text-slate-400">
                Verify Owner Password or Manager PIN for {businessSession.businessName}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleVerify('admin');
          }}
          className="p-5 flex flex-col gap-4"
        >
          {/* Mode Toggle: Owner Password vs Manager PIN */}
          <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-950 rounded-xl border border-slate-800">
            <button
              type="button"
              onClick={() => {
                setAuthMode('password');
                setErrorMsg(null);
              }}
              className={`py-2 px-3 rounded-lg text-xs font-extrabold uppercase tracking-wider cursor-pointer transition-all flex items-center justify-center gap-1.5 ${
                authMode === 'password'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Lock size={13} />
              <span>Owner Password</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthMode('pin');
                setErrorMsg(null);
              }}
              className={`py-2 px-3 rounded-lg text-xs font-extrabold uppercase tracking-wider cursor-pointer transition-all flex items-center justify-center gap-1.5 ${
                authMode === 'pin'
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <KeyRound size={13} />
              <span>Manager PIN</span>
            </button>
          </div>

          {errorMsg && (
            <div className="px-3.5 py-2.5 rounded-xl bg-rose-950/70 border border-rose-500/50 text-rose-200 text-xs font-bold flex items-center gap-2">
              <AlertCircle size={15} className="shrink-0 text-rose-400" />
              <span>{errorMsg}</span>
            </div>
          )}

          {authMode === 'password' ? (
            <div className="flex flex-col gap-3">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                  Authorized Owner / Manager Email
                </label>
                <div className="px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 font-mono text-xs truncate">
                  {businessSession.ownerEmail || 'Owner Account'}
                </div>
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                  Account Password *
                </label>
                <input
                  type="password"
                  autoFocus
                  value={passwordInput}
                  onChange={(e) => {
                    setPasswordInput(e.target.value);
                    setErrorMsg(null);
                  }}
                  placeholder="Enter Owner/Manager password"
                  className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 focus:border-indigo-500 rounded-xl text-slate-100 font-mono text-sm focus:outline-hidden"
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                Active Manager 4-Digit PIN *
              </label>
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                autoFocus
                value={managerPinInput}
                onChange={(e) => {
                  const digitsOnly = e.target.value.replace(/\D/g, '').slice(0, 4);
                  setManagerPinInput(digitsOnly);
                  setErrorMsg(null);
                }}
                placeholder="• • • •"
                className="w-full px-4 py-3 bg-slate-950 border border-slate-700 focus:border-emerald-500 rounded-xl text-center tracking-[0.6em] text-slate-100 font-mono text-xl font-black focus:outline-hidden"
              />
              <span className="text-[11px] text-slate-500">
                Requires an active staff profile with the Manager role.
              </span>
            </div>
          )}

          <div className="flex flex-col gap-2 pt-1">
            <button
              type="submit"
              disabled={isChecking}
              className="w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-black uppercase tracking-wider cursor-pointer shadow-lg flex items-center justify-center gap-2 transition-all disabled:opacity-50"
            >
              <Unlock size={15} />
              <span>{isChecking ? 'Verifying...' : 'Unlock Admin Dashboard'}</span>
            </button>

            <button
              type="button"
              disabled={isChecking}
              onClick={() => void handleVerify('logout')}
              className="w-full py-2.5 px-4 rounded-xl bg-rose-950/70 hover:bg-rose-900 text-rose-200 border border-rose-800/80 text-xs font-extrabold uppercase tracking-wider cursor-pointer flex items-center justify-center gap-2 transition-all disabled:opacity-50"
            >
              <LogOut size={14} />
              <span>Verify &amp; Full Device Logout</span>
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
