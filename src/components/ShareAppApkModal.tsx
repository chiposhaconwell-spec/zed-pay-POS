import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  Bluetooth,
  Check,
  Copy,
  Download,
  MessageCircle,
  QrCode,
  Share2,
  Smartphone,
  Upload,
  Wifi,
  X,
  AlertCircle,
} from 'lucide-react';
import {
  ApkShareTarget,
  canBrowserShareApkFiles,
  getNativeApkInfo,
  isAndroidNative,
  shareApkFileViaWebShare,
  shareNativeInstalledApk,
} from '../androidUtils';

interface ShareAppApkModalProps {
  isOpen: boolean;
  onClose: () => void;
  storeName: string;
}

interface HostedApkInfo {
  hasApk: boolean;
  filename: string | null;
  sizeBytes: number;
  updatedAt: string | null;
  downloadUrl: string | null;
  appUrl: string | null;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function ShareAppApkModal({ isOpen, onClose, storeName }: ShareAppApkModalProps) {
  const nativeAndroid = isAndroidNative();
  const [nativeInfo, setNativeInfo] = useState<{ available: boolean; sizeBytes: number; packageName: string } | null>(null);
  const [hostedInfo, setHostedInfo] = useState<HostedApkInfo | null>(null);
  const [localApkFile, setLocalApkFile] = useState<File | null>(null);
  const [uploadingApk, setUploadingApk] = useState(false);
  const [sharingChannel, setSharingChannel] = useState<ApkShareTarget | null>(null);
  const [whatsappPhone, setWhatsappPhone] = useState('');
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'info' | 'error'; text: string } | null>(null);
  const apkInputRef = useRef<HTMLInputElement | null>(null);

  const safeAppFileName = `${(storeName || 'RetailPOS').replace(/[^a-zA-Z0-9_-]+/g, '_')}_POS.apk`;
  const appOriginUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const shareTargetUrl = hostedInfo?.downloadUrl || appOriginUrl;

  const refreshApkStatus = async () => {
    if (nativeAndroid) {
      const info = await getNativeApkInfo();
      setNativeInfo(info);
    }
    try {
      const resp = await fetch('/api/app/apk-info');
      if (resp.ok) {
        const data: HostedApkInfo = await resp.json();
        setHostedInfo(data);
      }
    } catch {
      // Offline or local-only mode
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setFeedback(null);
    setCopied(false);
    refreshApkStatus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !shareTargetUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(shareTargetUrl, { width: 180, margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, shareTargetUrl]);

  if (!isOpen) return null;

  const resolveBrowserApkFile = async (): Promise<File | null> => {
    if (localApkFile) return localApkFile;
    if (!hostedInfo?.hasApk) return null;

    const resp = await fetch('/api/app/download-apk');
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const fname = hostedInfo.filename || safeAppFileName;
    const file = new File([blob], fname, { type: 'application/vnd.android.package-archive' });
    setLocalApkFile(file);
    return file;
  };

  const triggerApkDownload = (fileOrUrl: File | string, filename: string) => {
    const link = document.createElement('a');
    if (typeof fileOrUrl === 'string') {
      link.href = fileOrUrl;
    } else {
      const objUrl = URL.createObjectURL(fileOrUrl);
      link.href = objUrl;
      setTimeout(() => URL.revokeObjectURL(objUrl), 15000);
    }
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const buildWhatsAppShareUrl = (): string => {
    const cleanDigits = whatsappPhone.replace(/\D/g, '');
    const appTitle = storeName ? `${storeName} POS` : 'Retail POS';
    const lines = [
      `Install *${appTitle}* Android App:`,
      hostedInfo?.downloadUrl
        ? `📦 Direct APK Download:\n${hostedInfo.downloadUrl}`
        : `🌐 Open App Link:\n${appOriginUrl}`,
    ];
    const encoded = encodeURIComponent(lines.join('\n\n'));
    return cleanDigits.length >= 7
      ? `https://wa.me/${cleanDigits}?text=${encoded}`
      : `https://wa.me/?text=${encoded}`;
  };

  const handleShareApk = async (target: ApkShareTarget) => {
    setFeedback(null);
    setSharingChannel(target);
    const appTitle = storeName ? `${storeName} POS App (APK)` : 'Retail POS App (APK)';
    const shareMsg = `Install ${storeName || 'Retail POS'} on your Android device.`;

    try {
      // 1. Native Android APK installed on device: extract base.apk via FileProvider & launch target directly
      if (nativeAndroid) {
        const res = await shareNativeInstalledApk({
          target,
          fileName: safeAppFileName,
          title: appTitle,
          message: shareMsg,
        });
        if (res.shared) {
          const targetLabel =
            target === 'bluetooth'
              ? 'Bluetooth'
              : target === 'quickshare'
                ? 'Quick Share'
                : target === 'whatsapp'
                  ? 'WhatsApp'
                  : 'Android Share Sheet';
          setFeedback({
            type: 'success',
            text: `Opened ${targetLabel} with ${safeAppFileName} attached.`,
          });
        } else {
          setFeedback({
            type: 'error',
            text: res.error || 'Unable to launch native Android APK share.',
          });
        }
        return;
      }

      // 2. Web / Mobile Browser Mode
      const apkFile = await resolveBrowserApkFile();

      // Try Web Share API with real .apk file attachment (works in Android Chrome / Edge / ChromeOS for Quick Share, Bluetooth, WhatsApp)
      if (apkFile && canBrowserShareApkFiles()) {
        const shared = await shareApkFileViaWebShare(apkFile, appTitle, shareMsg);
        if (shared) {
          setFeedback({
            type: 'success',
            text: `Share sheet opened with ${apkFile.name} attached. Choose Bluetooth, Quick Share, or WhatsApp.`,
          });
          return;
        }
      }

      // If Web Share with link is available when no file share is supported
      if (!apkFile && typeof navigator !== 'undefined' && typeof navigator.share === 'function' && target === 'chooser') {
        try {
          await navigator.share({ title: appTitle, text: shareMsg, url: appOriginUrl });
          setFeedback({ type: 'success', text: 'App link shared via system share sheet.' });
          return;
        } catch {
          // Fall through to browser guidance/download
        }
      }

      if (target === 'whatsapp') {
        const waAnchor = document.createElement('a');
        waAnchor.href = buildWhatsAppShareUrl();
        waAnchor.target = '_blank';
        waAnchor.rel = 'noopener noreferrer';
        document.body.appendChild(waAnchor);
        waAnchor.click();
        document.body.removeChild(waAnchor);
        setFeedback({
          type: 'info',
          text: hostedInfo?.hasApk
            ? 'Opened WhatsApp with the direct APK download link.'
            : 'Opened WhatsApp with the app link. Attach an .apk below if you want recipients to download the APK directly.',
        });
        return;
      }

      if (apkFile) {
        triggerApkDownload(apkFile, apkFile.name);
        setFeedback({
          type: 'info',
          text:
            target === 'bluetooth'
              ? `Downloaded ${apkFile.name}. Your browser environment does not allow direct Bluetooth socket transfer from web tabs—send the downloaded .apk via your device's Bluetooth / Quick Share menu or use the installed Android app.`
              : `Downloaded ${apkFile.name}. Right-click or tap Share -> Quick Share / Bluetooth on your device to transfer it directly.`,
        });
      } else {
        setFeedback({
          type: 'error',
          text: 'No .apk binary is attached in this browser session yet. Attach your compiled .apk file below (or open Share App inside the installed Android APK) to send the .apk directly via Bluetooth, Quick Share, or WhatsApp.',
        });
      }
    } finally {
      setSharingChannel(null);
    }
  };

  const handleSelectApkFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.apk')) {
      setFeedback({ type: 'error', text: 'Please choose a valid Android .apk package file.' });
      return;
    }

    setLocalApkFile(file);
    setUploadingApk(true);
    setFeedback(null);

    try {
      const resp = await fetch('/api/app/upload-apk', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.android.package-archive',
          'x-apk-filename': file.name,
        },
        body: file,
      });
      if (resp.ok) {
        await refreshApkStatus();
        setFeedback({
          type: 'success',
          text: `${file.name} (${formatBytes(file.size)}) attached & hosted! You can now share it via Bluetooth, Quick Share, or WhatsApp.`,
        });
      } else {
        const errData = await resp.json().catch(() => ({}));
        setFeedback({
          type: 'info',
          text: `${file.name} loaded locally for device sharing (${errData?.error || 'server upload skipped'}).`,
        });
      }
    } catch {
      setFeedback({
        type: 'info',
        text: `${file.name} loaded locally for Quick Share / Bluetooth / Web Share.`,
      });
    } finally {
      setUploadingApk(false);
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareTargetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setFeedback({ type: 'info', text: `Share URL: ${shareTargetUrl}` });
    }
  };

  const activeApkSize = nativeInfo?.available
    ? nativeInfo.sizeBytes
    : localApkFile?.size || hostedInfo?.sizeBytes || 0;
  const activeApkLabel = nativeInfo?.available
    ? safeAppFileName
    : localApkFile?.name || hostedInfo?.filename || null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4 select-text">
      <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto p-5 sm:p-6 space-y-4 text-slate-900">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-2xl bg-teal-600 text-white shadow-xs">
              <Share2 size={20} />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-wide text-slate-900">
                Share App (Direct APK)
              </h3>
              <p className="text-[11px] font-medium text-slate-500">
                Send the Android APK directly via Bluetooth, WhatsApp, or Quick Share
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* APK Binary Status Card */}
        <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <Smartphone size={18} className={nativeAndroid || activeApkLabel ? 'text-emerald-600 shrink-0' : 'text-amber-600 shrink-0'} />
            <div className="min-w-0">
              <div className="text-xs font-black text-slate-800 truncate">
                {nativeAndroid
                  ? `Installed APK Ready (${safeAppFileName})`
                  : activeApkLabel
                    ? `APK Ready: ${activeApkLabel}`
                    : 'Web Mode (Attach .apk for direct file transfer)'}
              </div>
              <div className="text-[10.5px] font-medium text-slate-500">
                {nativeAndroid
                  ? `Extracts installed package directly (${formatBytes(activeApkSize)}) — works offline`
                  : activeApkLabel
                    ? `Package size: ${formatBytes(activeApkSize)}`
                    : 'Upload or select your built .apk file once to enable direct APK sharing from browser'}
              </div>
            </div>
          </div>

          {!nativeAndroid && (
            <div className="flex items-center gap-1.5">
              <input
                ref={apkInputRef}
                type="file"
                accept=".apk,application/vnd.android.package-archive"
                onChange={handleSelectApkFile}
                className="hidden"
              />
              <button
                type="button"
                disabled={uploadingApk}
                onClick={() => apkInputRef.current?.click()}
                className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-[10.5px] font-extrabold uppercase tracking-wider flex items-center gap-1 cursor-pointer disabled:opacity-60"
              >
                <Upload size={12} />
                <span>{uploadingApk ? 'Attaching...' : activeApkLabel ? 'Replace APK' : 'Attach .APK'}</span>
              </button>
            </div>
          )}
        </div>

        {feedback && (
          <div
            className={`px-3.5 py-2.5 rounded-xl border text-xs font-bold flex items-start gap-2 ${
              feedback.type === 'error'
                ? 'bg-rose-50 border-rose-200 text-rose-800'
                : feedback.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-sky-50 border-sky-200 text-sky-900'
            }`}
          >
            <AlertCircle size={15} className="shrink-0 mt-0.5" />
            <span>{feedback.text}</span>
          </div>
        )}

        {/* Direct APK Share Channels */}
        <div className="space-y-2">
          <span className="text-[10px] font-black uppercase tracking-wider text-slate-500 block">
            Choose Sharing Channel
          </span>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {/* Bluetooth */}
            <button
              type="button"
              disabled={sharingChannel !== null}
              onClick={() => handleShareApk('bluetooth')}
              className="p-3.5 rounded-2xl border border-blue-200 bg-blue-50/70 hover:bg-blue-100 text-left transition-all cursor-pointer flex flex-col gap-1.5 disabled:opacity-60"
            >
              <div className="p-2 w-fit rounded-xl bg-blue-600 text-white shadow-xs">
                <Bluetooth size={17} />
              </div>
              <span className="text-xs font-black text-slate-900">Bluetooth</span>
              <span className="text-[10px] font-medium text-slate-600 leading-tight">
                {sharingChannel === 'bluetooth' ? 'Preparing APK...' : 'Direct offline .apk transfer'}
              </span>
            </button>

            {/* Quick Share */}
            <button
              type="button"
              disabled={sharingChannel !== null}
              onClick={() => handleShareApk('quickshare')}
              className="p-3.5 rounded-2xl border border-indigo-200 bg-indigo-50/70 hover:bg-indigo-100 text-left transition-all cursor-pointer flex flex-col gap-1.5 disabled:opacity-60"
            >
              <div className="p-2 w-fit rounded-xl bg-indigo-600 text-white shadow-xs">
                <Wifi size={17} />
              </div>
              <span className="text-xs font-black text-slate-900">Quick Share</span>
              <span className="text-[10px] font-medium text-slate-600 leading-tight">
                {sharingChannel === 'quickshare' ? 'Launching Quick Share...' : 'High-speed nearby APK transfer'}
              </span>
            </button>

            {/* WhatsApp */}
            <button
              type="button"
              disabled={sharingChannel !== null}
              onClick={() => handleShareApk('whatsapp')}
              className="p-3.5 rounded-2xl border border-emerald-200 bg-emerald-50/70 hover:bg-emerald-100 text-left transition-all cursor-pointer flex flex-col gap-1.5 disabled:opacity-60"
            >
              <div className="p-2 w-fit rounded-xl bg-emerald-600 text-white shadow-xs">
                <MessageCircle size={17} />
              </div>
              <span className="text-xs font-black text-slate-900">WhatsApp</span>
              <span className="text-[10px] font-medium text-slate-600 leading-tight">
                {sharingChannel === 'whatsapp'
                  ? 'Opening WhatsApp...'
                  : nativeAndroid
                    ? 'Send .apk directly in chat'
                    : hostedInfo?.hasApk
                      ? 'Send APK download via WhatsApp'
                      : 'Share via WhatsApp chat'}
              </span>
            </button>
          </div>

          {/* WhatsApp optional recipient & system share button */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
            {!nativeAndroid && (
              <div className="flex items-center gap-1.5">
                <input
                  type="tel"
                  placeholder="Optional WhatsApp # (e.g. +26097...)"
                  value={whatsappPhone}
                  onChange={(e) => setWhatsappPhone(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-semibold text-slate-800 bg-white focus:outline-none focus:border-emerald-500"
                />
              </div>
            )}

            <button
              type="button"
              disabled={sharingChannel !== null}
              onClick={() => handleShareApk('chooser')}
              className={`py-2 px-3.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-extrabold uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer shadow-xs disabled:opacity-60 ${
                nativeAndroid ? 'sm:col-span-2' : ''
              }`}
            >
              <Share2 size={14} />
              <span>Open Full System Share Sheet</span>
            </button>
          </div>
        </div>

        {/* Download Link & QR Code */}
        <div className="pt-3 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-3 gap-3 items-center">
          <div className="sm:col-span-2 space-y-2">
            <span className="text-[10px] font-black uppercase tracking-wider text-slate-500 block">
              {hostedInfo?.hasApk ? 'Direct APK Download Link' : 'App Install / Referral Link'}
            </span>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                readOnly
                value={shareTargetUrl}
                className="w-full px-2.5 py-1.5 rounded-lg bg-slate-100 border border-slate-200 text-[11px] font-mono text-slate-700"
              />
              <button
                type="button"
                onClick={handleCopyLink}
                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-900 text-white text-[10px] font-extrabold uppercase flex items-center gap-1 shrink-0 cursor-pointer"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>

            {hostedInfo?.hasApk && (
              <a
                href="/api/app/download-apk"
                download={hostedInfo.filename || safeAppFileName}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-[11px] font-extrabold border border-slate-200"
              >
                <Download size={13} />
                <span>Download {hostedInfo.filename || safeAppFileName}</span>
              </a>
            )}
          </div>

          <div className="flex flex-col items-center justify-center bg-slate-50 border border-slate-200 rounded-2xl p-2">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="Scan to install POS app" className="w-24 h-24 rounded-lg" />
            ) : (
              <div className="w-24 h-24 flex items-center justify-center text-slate-400">
                <QrCode size={32} />
              </div>
            )}
            <span className="text-[9px] font-extrabold uppercase text-slate-500 mt-1">
              Scan to Get App
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
