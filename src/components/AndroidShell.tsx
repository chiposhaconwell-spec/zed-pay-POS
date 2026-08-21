import React, { useState, useEffect } from 'react';
import { Wifi, Battery, Zap, Printer, ShieldCheck, RefreshCw, Layers, Sliders, Play, Smartphone, Tablet } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface AndroidShellProps {
  children: React.ReactNode;
  activeTab: string;
  setActiveTab: (tab: any) => void;
  showSqlSplit: boolean;
  setShowSqlSplit: (show: boolean) => void;
  storeName: string;
}

export default function AndroidShell({
  children,
  activeTab,
  setActiveTab,
  showSqlSplit,
  setShowSqlSplit,
  storeName,
}: AndroidShellProps) {
  const [timeStr, setTimeStr] = useState('');
  const [batteryLevel, setBatteryLevel] = useState(98);
  const [deviceMode, setDeviceMode] = useState<'tablet' | 'handheld'>('tablet');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTimeStr(now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);

    // Slowly drain battery a tiny bit just for realistic effect, toggle charging
    const batInterval = setInterval(() => {
      setBatteryLevel(prev => {
        if (prev <= 15) return 100;
        return prev - 1;
      });
    }, 180000);

    // Dynamic rotation & screen orientation detector for smart phone screens
    const handleDeviceSizing = () => {
      const isPortrait = window.innerHeight > window.innerWidth;
      const isMobileScreen = window.innerWidth < 768; // standard device width
      if (isMobileScreen) {
        if (isPortrait) {
          setDeviceMode('handheld');
        } else {
          setDeviceMode('tablet');
        }
      }
    };
    
    window.addEventListener('resize', handleDeviceSizing);
    window.addEventListener('orientationchange', handleDeviceSizing);
    handleDeviceSizing(); // initial trigger

    return () => {
      clearInterval(interval);
      clearInterval(batInterval);
      window.removeEventListener('resize', handleDeviceSizing);
      window.removeEventListener('orientationchange', handleDeviceSizing);
    };
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-100 p-0 sm:p-4 font-sans select-none overflow-x-hidden">
      {/* Outer Quick-Controls Menu (Platform level decoration but in bounds) */}
      <div className="w-full max-w-6xl mb-3 flex flex-wrap justify-between items-center px-2 hidden sm:flex">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-xl font-bold bg-gradient-to-r from-slate-800 to-slate-900 bg-clip-text text-transparent">
            Smart Android POS Emulator
          </h1>
          <p className="text-xs text-slate-500 font-medium">SME Sale powered by a local SQL relational database</p>
        </div>

        {/* Device Switcher */}
        <div className="flex items-center gap-1.5 mt-2 sm:mt-0 bg-white shadow-xs border border-slate-200/80 rounded-lg p-1">
          <button
            id="toggle-tablet-mode"
            onClick={() => setDeviceMode('tablet')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer ${
              deviceMode === 'tablet'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Tablet size={13} />
            Android Tablet Flatbed
          </button>
          <button
            id="toggle-handheld-mode"
            onClick={() => setDeviceMode('handheld')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer ${
              deviceMode === 'handheld'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Smartphone size={13} />
            Handheld Smart Terminal
          </button>
        </div>
      </div>

      {/* Main Device Outer Housing Container */}
      <motion.div
        layout
        className={`relative bg-slate-900 shadow-none sm:shadow-2xl border-0 sm:border-4 border-slate-700/60 rounded-none sm:rounded-3xl transition-all duration-300 w-full h-screen sm:h-auto ${
          deviceMode === 'tablet'
            ? 'sm:w-full sm:max-w-6xl sm:aspect-[16/10.5] sm:p-4 md:p-6 flex flex-col'
            : 'sm:w-full sm:max-w-sm sm:aspect-[9/18.5] sm:p-3 flex flex-col'
        }`}
      >
        {/* Top Camera Notch & Barcode Scanner Visual Overlay on Shell */}
        <div className="absolute top-0 left-1/2 transform -translate-x-1/2 h-4 w-28 bg-slate-700/60 rounded-b-xl flex items-center justify-center gap-2 z-40 hidden sm:flex">
          <div className="w-1.5 h-1.5 rounded-full bg-slate-900"></div>
          <div className="w-8 h-1 rounded bg-slate-800"></div>
        </div>

        {/* Physical Paper dispenser at the top of the device (For receipt layout animation) */}
        <div className="absolute -top-1.5 left-1/4 right-1/4 h-1 bg-slate-950 border border-t-slate-800 border-b-slate-900 rounded-t-sm z-30 flex items-center justify-center hidden sm:flex">
          <div className="w-full h-0.5 bg-black opacity-40"></div>
        </div>

        {/* Screen/Glass Surface */}
        <div className="relative flex-1 flex flex-col bg-slate-50 rounded-none sm:rounded-2xl overflow-hidden border-0 sm:border border-slate-900 h-full">
          
          {/* Android Status Bar */}
          <div className="flex items-center justify-between px-3.5 py-1.5 bg-slate-900 text-slate-300 text-xs font-semibold font-mono z-30 transition-all border-b border-slate-800">
            {/* Left Status Indicators: Time, Store, Active Tab */}
            <div className="flex items-center gap-2">
              <span className="text-white text-[11px] leading-none">{timeStr || '12:00'}</span>
              <span className="text-[10px] px-1 text-slate-500 font-mono">|</span>
              <span className="text-[10px] text-emerald-400 font-semibold tracking-wide flex items-center gap-1 uppercase">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block animate-pulse"></span>
                {storeName || 'SME Retail'}
              </span>
            </div>

            {/* Middle Logo/Status */}
            <div className="hidden sm:flex items-center gap-1 text-[9px] bg-slate-850 py-0.5 px-2 rounded border border-slate-800 text-slate-400">
              <ShieldCheck size={9} className="text-indigo-400" />
              <span>SECURE SQL ENGINE</span>
            </div>

            {/* Right Status Indicators: Wifi, Battery, Peripheral Indicators */}
            <div className="flex items-center gap-2 text-[10px]">
              <div className="flex items-center gap-1.5 text-slate-400 mr-2 border-r border-slate-800 pr-2">
                <Printer size={11} className={`${activeTab === 'billing' ? 'text-indigo-300' : 'text-slate-500'}`} title="POS Thermal Printer Ready" />
                <span className="text-[9px] hidden md:inline font-mono text-slate-500">PRNT.OK</span>
              </div>
              <Wifi size={12} className="text-slate-300" />
              <div className="flex items-center gap-0.5" title={`${batteryLevel}% charging`}>
                <span className="text-[9px] mr-1">{batteryLevel}%</span>
                <Battery size={13} className="text-indigo-400" />
                <Zap size={10} className="text-amber-400 -ml-0.5" />
              </div>
            </div>
          </div>

          {/* Display Working Surface Panel */}
          <div className="flex-1 flex overflow-hidden relative">
            {/* Inner Surface Slots Grid */}
            <div className="flex-1 flex flex-col h-full relative">
              {children}
            </div>
          </div>

          {/* Android Navigation Overlay (Soft-keys) at bottom */}
          <div className="h-9 bg-slate-950 flex items-center justify-around px-4 sm:px-24 md:px-32 border-t border-slate-900 z-30 shrink-0 pb-safe">
            
            {/* Back Button (resets state filter/closes overlay) */}
            <button
              id="android-back-btn"
              onClick={() => {
                try { navigator.vibrate?.(15); } catch(e){}
                // Synthetically trigger back action: switch back categories, reset console logs or active popups
                if (activeTab !== 'billing') {
                  setActiveTab('billing');
                }
              }}
              className="flex items-center justify-center w-12 h-7 rounded-sm active:bg-slate-800 group cursor-pointer active-touch"
              title="Back to Sales Register"
            >
              <div className="w-0 h-0 border-t-6 border-t-transparent border-r-8 border-r-slate-400 border-b-6 border-b-transparent group-active:border-r-slate-200 transition-colors"></div>
            </button>

            {/* Home Button (Returns to Register Screen) */}
            <button
              id="android-home-btn"
              onClick={() => {
                try { navigator.vibrate?.(15); } catch(e){}
                setActiveTab('billing');
              }}
              className="flex items-center justify-center w-12 h-7 rounded-sm active:bg-slate-800 group cursor-pointer active-touch"
              title="Home Register"
            >
              <div className="w-3.5 h-3.5 rounded-full border-2 border-slate-400 group-active:border-slate-200 group-active:bg-slate-800 transition-all"></div>
            </button>

            {/* Recents Button (Toggles Side Multi-Task SQL Terminal Panel!) */}
            <button
              id="android-recent-btn"
              onClick={() => {
                try { navigator.vibrate?.(15); } catch(e){}
                setShowSqlSplit(!showSqlSplit);
              }}
              className={`flex items-center justify-center w-12 h-7 rounded-sm transition-all cursor-pointer active-touch ${
                showSqlSplit ? 'bg-indigo-900/40 border border-indigo-700/30' : 'active:bg-slate-800 group'
              }`}
              title="Toggle SQL Monitor (Split-Screen)"
            >
              <div className={`w-3.5 h-3.5 border-2 rounded-[2px] transition-all ${
                showSqlSplit
                  ? 'border-indigo-400 bg-indigo-500/70'
                  : 'border-slate-400 group-active:border-slate-200'
              }`}></div>
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
