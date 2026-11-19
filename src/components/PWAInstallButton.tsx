import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'header' | 'drawer';
  onActionComplete?: () => void;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  variant = 'header',
  onActionComplete,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleInstallClick = async () => {
    const accepted = await install();
    if (accepted && onActionComplete) {
      onActionComplete();
    }
  };

  if (isInstallable) {
    if (variant === 'drawer') {
      return (
        <button
          type="button"
          onClick={handleInstallClick}
          className="flex items-center justify-between p-2 rounded-xl hover:bg-indigo-50 bg-indigo-50/70 text-slate-800 text-xs font-bold transition-all cursor-pointer border border-indigo-200/80 group"
        >
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-indigo-600 text-white shadow-xs group-hover:scale-105 transition-transform">
              <Download size={16} />
            </div>
            <div className="flex flex-col text-left">
              <span>Install App (PWA)</span>
              <span className="text-[9.5px] text-slate-500 font-medium">Add standalone icon to home screen</span>
            </div>
          </div>
          <span className="px-2 py-0.5 bg-indigo-600 text-white text-[9px] font-extrabold rounded-full font-mono">
            INSTALL
          </span>
        </button>
      );
    }

    return (
      <button
        type="button"
        onClick={handleInstallClick}
        title="Install Retail POS as a standalone app"
        className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500 text-[10px] sm:text-[11px] font-extrabold uppercase tracking-wider cursor-pointer transition-all shadow-xs"
      >
        <Download size={12} />
        <span>Install App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        {variant === 'drawer' ? (
          <button
            type="button"
            onClick={() => setShowIOSGuide(true)}
            className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 text-slate-800 text-xs font-bold transition-all cursor-pointer border border-slate-200 group"
          >
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-slate-800 text-white shadow-xs group-hover:scale-105 transition-transform">
                <Smartphone size={16} />
              </div>
              <div className="flex flex-col text-left">
                <span>Install on iOS</span>
                <span className="text-[9.5px] text-slate-500 font-medium">Safari Add to Home Screen</span>
              </div>
            </div>
            <span className="px-2 py-0.5 bg-slate-200 text-slate-800 text-[9px] font-extrabold rounded-full font-mono">
              iOS
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setShowIOSGuide(true)}
            title="Install on iPhone or iPad"
            className="flex items-center gap-1 px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-600 text-[10px] sm:text-[11px] font-bold cursor-pointer transition-all"
          >
            <Smartphone size={12} />
            <span className="hidden sm:inline">Install on iOS</span>
            <span className="sm:hidden">Install</span>
          </button>
        )}

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-xs">
            <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl border border-slate-200 text-slate-900">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h3 className="text-sm font-black uppercase tracking-wide text-slate-900">
                  Install on iPhone / iPad
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="p-1 rounded-lg text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="mt-3 space-y-2 text-xs text-slate-600 leading-relaxed">
                <p>
                  1. Tap the <strong className="text-slate-900">Share</strong> button in your Safari toolbar.
                </p>
                <p>
                  2. Scroll down and tap <strong className="text-slate-900">Add to Home Screen</strong>.
                </p>
                <p>
                  3. Tap <strong className="text-slate-900">Add</strong> to launch Retail POS in standalone mode.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-4 w-full rounded-xl bg-slate-900 py-2 text-xs font-bold uppercase tracking-wider text-white hover:bg-slate-800 cursor-pointer transition"
              >
                Got It
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
