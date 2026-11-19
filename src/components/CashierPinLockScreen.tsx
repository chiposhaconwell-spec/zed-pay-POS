import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  Building2,
  Delete,
  Lock,
  MapPin,
  RotateCcw,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import {
  ActiveShift,
  BusinessSession,
  StaffMember,
  getLocalStaffMembers,
  fetchStaffMembers,
  verifyCashierPin,
} from '../services/terminalAuthService';
import { PWAInstallButton } from './PWAInstallButton';

interface CashierPinLockScreenProps {
  businessSession: BusinessSession;
  activeStoreName?: string;
  onUnlockShift: (shift: ActiveShift) => void;
  onRequestAdminAccess: () => void;
}

export default function CashierPinLockScreen({
  businessSession,
  activeStoreName,
  onUnlockShift,
  onRequestAdminAccess,
}: CashierPinLockScreenProps) {
  const [pin, setPin] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [shakeTrigger, setShakeTrigger] = useState<number>(0);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [staffCount, setStaffCount] = useState<number>(() =>
    getLocalStaffMembers(businessSession.businessId).filter((s) => s.isActive).length
  );

  useEffect(() => {
    let mounted = true;
    fetchStaffMembers(businessSession.businessId)
      .then((list: StaffMember[]) => {
        if (mounted) {
          setStaffCount(list.filter((s) => s.isActive).length);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [businessSession.businessId]);

  const triggerPinSubmit = async (candidatePin: string) => {
    if (isVerifying || candidatePin.length !== 4) return;
    setIsVerifying(true);
    setErrorMsg(null);
    try {
      const shift = await verifyCashierPin(businessSession.businessId, candidatePin);
      setPin('');
      onUnlockShift(shift);
    } catch (err: any) {
      setErrorMsg(err?.message === 'Invalid PIN' ? 'Invalid PIN' : err?.message || 'Invalid PIN');
      setShakeTrigger((prev) => prev + 1);
      setTimeout(() => {
        setPin('');
      }, 280);
    } finally {
      setIsVerifying(false);
    }
  };

  const handleDigitPress = (digit: string) => {
    if (isVerifying) return;
    setErrorMsg(null);
    setPin((prev) => {
      if (prev.length >= 4) return prev;
      const next = prev + digit;
      if (next.length === 4) {
        void triggerPinSubmit(next);
      }
      return next;
    });
  };

  const handleBackspace = () => {
    if (isVerifying) return;
    setErrorMsg(null);
    setPin((prev) => prev.slice(0, -1));
  };

  const handleClear = () => {
    if (isVerifying) return;
    setErrorMsg(null);
    setPin('');
  };

  // Support physical numeric keyboard entry alongside touch keypad
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        handleDigitPress(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleBackspace();
      } else if (e.key === 'Escape' || e.key === 'Delete') {
        e.preventDefault();
        handleClear();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isVerifying]);

  const keypadDigits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-slate-950 text-slate-100 select-none overflow-y-auto">
      {/* Top Business Banner */}
      <div className="bg-slate-900 border-b border-slate-800 px-4 py-3 flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
            <Building2 size={18} />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-400 font-mono">
              Authorized POS Terminal
            </div>
            <h1 className="text-sm sm:text-base font-black text-white truncate">
              {businessSession.businessName || 'Retail POS Shop'}
            </h1>
          </div>
          {activeStoreName && (
            <span className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-[10px] font-bold uppercase text-slate-300">
              <MapPin size={11} className="text-emerald-400" />
              {activeStoreName}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <PWAInstallButton variant="header" />
          <button
            type="button"
            onClick={onRequestAdminAccess}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/35 text-indigo-300 border border-indigo-500/40 text-xs font-extrabold uppercase tracking-wider cursor-pointer transition-all"
          >
            <ShieldCheck size={14} />
            <span>Admin Access</span>
          </button>
        </div>
      </div>

      {/* Centered Touch PIN Pad */}
      <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-3xl p-5 sm:p-6 shadow-2xl flex flex-col items-center gap-5"
        >
          <div className="flex flex-col items-center text-center gap-1.5">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-inner">
              <Lock size={22} />
            </div>
            <h2 className="text-base font-black uppercase tracking-wider text-white mt-1">
              Cashier PIN Unlock
            </h2>
            <p className="text-xs text-slate-400">
              Enter your 4-digit staff PIN to start a POS shift at{' '}
              <span className="text-slate-200 font-bold">{businessSession.businessName}</span>
            </p>
          </div>

          {/* 4-Dot Masked PIN Indicator with Shake on Error */}
          <motion.div
            key={shakeTrigger}
            animate={
              shakeTrigger > 0
                ? { x: [0, -10, 10, -8, 8, -4, 4, 0] }
                : { x: 0 }
            }
            transition={{ duration: 0.36 }}
            className="w-full flex flex-col items-center gap-2"
          >
            <div
              className={`flex items-center justify-center gap-4 px-6 py-4 rounded-2xl bg-slate-950 border w-full transition-colors ${
                errorMsg
                  ? 'border-rose-500/80 bg-rose-950/20'
                  : pin.length > 0
                    ? 'border-emerald-500/60'
                    : 'border-slate-800'
              }`}
              aria-label="PIN entry display"
            >
              {[0, 1, 2, 3].map((idx) => {
                const filled = idx < pin.length;
                return (
                  <div
                    key={idx}
                    className={`w-4 h-4 rounded-full transition-all duration-150 ${
                      errorMsg
                        ? 'bg-rose-500 scale-110 shadow-[0_0_10px_rgba(244,63,94,0.55)]'
                        : filled
                          ? 'bg-emerald-400 scale-110 shadow-[0_0_10px_rgba(52,211,153,0.55)]'
                          : 'bg-slate-700 border border-slate-600'
                    }`}
                  />
                );
              })}
            </div>

            <div className="min-h-[24px] flex items-center justify-center">
              {errorMsg ? (
                <div className="flex items-center gap-1.5 text-rose-400 text-xs font-extrabold uppercase tracking-wider">
                  <AlertCircle size={13} />
                  <span>{errorMsg}</span>
                </div>
              ) : isVerifying ? (
                <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider animate-pulse">
                  Verifying PIN...
                </span>
              ) : staffCount === 0 ? (
                <span className="text-[11px] text-amber-400 font-semibold text-center">
                  No active cashiers configured yet — open Admin Access to add PINs
                </span>
              ) : (
                <span className="text-[11px] text-slate-500 font-mono">
                  {staffCount} active staff PIN{staffCount === 1 ? '' : 's'} linked
                </span>
              )}
            </div>
          </motion.div>

          {/* Touch-Friendly 4-Digit Keypad */}
          <div className="grid grid-cols-3 gap-3 w-full">
            {keypadDigits.map((digit) => (
              <button
                key={digit}
                type="button"
                disabled={isVerifying}
                onClick={() => handleDigitPress(digit)}
                className="min-h-[60px] sm:min-h-[66px] rounded-2xl bg-slate-800 hover:bg-slate-700 active:bg-emerald-600 active:scale-95 text-white text-2xl font-black font-mono border border-slate-700/80 shadow-md cursor-pointer transition-all flex items-center justify-center disabled:opacity-50"
              >
                {digit}
              </button>
            ))}

            <button
              type="button"
              disabled={isVerifying || pin.length === 0}
              onClick={handleClear}
              className="min-h-[60px] sm:min-h-[66px] rounded-2xl bg-slate-950 hover:bg-slate-800 active:scale-95 text-slate-300 text-xs font-black uppercase tracking-wider border border-slate-800 cursor-pointer transition-all flex items-center justify-center gap-1 disabled:opacity-40"
              title="Clear PIN"
            >
              <RotateCcw size={15} />
              <span>Clear</span>
            </button>

            <button
              type="button"
              disabled={isVerifying}
              onClick={() => handleDigitPress('0')}
              className="min-h-[60px] sm:min-h-[66px] rounded-2xl bg-slate-800 hover:bg-slate-700 active:bg-emerald-600 active:scale-95 text-white text-2xl font-black font-mono border border-slate-700/80 shadow-md cursor-pointer transition-all flex items-center justify-center disabled:opacity-50"
            >
              0
            </button>

            <button
              type="button"
              disabled={isVerifying || pin.length === 0}
              onClick={handleBackspace}
              className="min-h-[60px] sm:min-h-[66px] rounded-2xl bg-slate-950 hover:bg-slate-800 active:scale-95 text-amber-300 border border-slate-800 cursor-pointer transition-all flex items-center justify-center disabled:opacity-40"
              title="Backspace"
              aria-label="Backspace"
            >
              <Delete size={20} />
            </button>
          </div>

          {/* Device Footer Status */}
          <div className="w-full pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-500">
            <span className="flex items-center gap-1.5">
              <UserCheck size={13} className="text-emerald-500" />
              Device Linked: {businessSession.ownerEmail || businessSession.businessId}
            </span>
            <button
              type="button"
              onClick={onRequestAdminAccess}
              className="text-indigo-400 hover:text-indigo-300 font-bold cursor-pointer underline underline-offset-2"
            >
              Manager / Owner
            </button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
