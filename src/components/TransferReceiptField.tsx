import React, { useRef, useState } from 'react';
import { Upload, Eye, X, Trash2, FileText, Download, AlertCircle, CheckCircle2 } from 'lucide-react';
import {
  TransferReceiptAttachment,
  processTransferReceiptFile,
} from '../transferReceipts';

interface TransferReceiptFieldProps {
  referenceValue: string;
  onReferenceChange: (val: string) => void;
  receipt: TransferReceiptAttachment | null;
  onReceiptChange: (receipt: TransferReceiptAttachment | null) => void;
  label?: string;
  placeholder?: string;
  compact?: boolean;
}

export function TransferReceiptField({
  referenceValue,
  onReferenceChange,
  receipt,
  onReceiptChange,
  label = 'Reference ID / Note',
  placeholder = 'e.g. Bank Deposit Ref #8492',
  compact = false,
}: TransferReceiptFieldProps) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const [isProcessing, setIsProcessing] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFieldError(null);
    setIsProcessing(true);
    try {
      const processed = await processTransferReceiptFile(file);
      onReceiptChange(processed);
      if (!referenceValue.trim()) {
        const baseName = processed.fileName.replace(/\.[^.]+$/, '').slice(0, 32);
        if (baseName) onReferenceChange(baseName);
      }
    } catch (err: any) {
      setFieldError(err?.message || 'Unable to attach receipt file.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label
        className={
          compact
            ? 'block text-[10px] font-black uppercase text-slate-500'
            : 'block text-xs font-bold text-slate-600'
        }
      >
        {label}
      </label>

      <div className="flex items-stretch gap-1.5">
        <input
          type="text"
          placeholder={placeholder}
          value={referenceValue}
          onChange={(e) => onReferenceChange(e.target.value)}
          className={
            compact
              ? 'flex-1 min-w-0 bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500'
              : 'flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500'
          }
        />

        <button
          type="button"
          onClick={() => uploadInputRef.current?.click()}
          disabled={isProcessing}
          title="Upload transfer receipt image or PDF"
          className="px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 rounded-lg text-[10px] font-black uppercase flex items-center gap-1 cursor-pointer shrink-0 transition-colors disabled:opacity-50"
        >
          <Upload size={12} />
          <span>Upload</span>
        </button>
      </div>

      {/* Hidden Upload Input */}
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/*,application/pdf"
        onChange={handleFileSelected}
        className="hidden"
      />

      {fieldError && (
        <div className="text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1 flex items-center gap-1.5">
          <AlertCircle size={12} className="shrink-0" />
          <span>{fieldError}</span>
        </div>
      )}

      {isProcessing && (
        <div className="text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg px-2 py-1">
          Processing receipt attachment...
        </div>
      )}

      {receipt && (
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-emerald-50 border border-emerald-200 rounded-lg">
          <div className="flex items-center gap-2 min-w-0">
            {receipt.mimeType.startsWith('image/') && receipt.dataUrl && receipt.dataUrl.trim() ? (
              <img
                src={receipt.dataUrl}
                alt="Receipt thumbnail"
                className="w-7 h-7 rounded border border-emerald-300 object-cover shrink-0 bg-white"
              />
            ) : (
              <div className="w-7 h-7 rounded border border-emerald-300 bg-white flex items-center justify-center text-emerald-700 shrink-0">
                <FileText size={13} />
              </div>
            )}
            <div className="min-w-0">
              <div className="text-[10px] font-black text-emerald-900 flex items-center gap-1 truncate">
                <CheckCircle2 size={11} className="text-emerald-600 shrink-0" />
                <span className="truncate">{receipt.fileName}</span>
              </div>
              <div className="text-[9px] text-emerald-700 font-semibold">Receipt attached</div>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setShowPreviewModal(true)}
              className="p-1 px-1.5 bg-white hover:bg-emerald-100 border border-emerald-200 text-emerald-800 rounded text-[9px] font-black uppercase flex items-center gap-1 cursor-pointer"
            >
              <Eye size={11} />
              <span>View</span>
            </button>
            <button
              type="button"
              onClick={() => onReceiptChange(null)}
              title="Remove attached receipt"
              className="p-1 bg-white hover:bg-rose-100 border border-rose-200 text-rose-600 rounded cursor-pointer"
            >
              <Trash2 size={11} />
            </button>
          </div>
        </div>
      )}

      {/* PREVIEW MODAL */}
      {showPreviewModal && receipt && (
        <TransferReceiptViewerModal
          receipt={receipt}
          referenceLabel={referenceValue}
          onClose={() => setShowPreviewModal(false)}
        />
      )}
    </div>
  );
}

interface TransferReceiptViewerModalProps {
  receipt: TransferReceiptAttachment;
  referenceLabel?: string;
  onClose: () => void;
}

export function TransferReceiptViewerModal({
  receipt,
  referenceLabel,
  onClose,
}: TransferReceiptViewerModalProps) {
  const isImage = receipt.mimeType.startsWith('image/') || receipt.dataUrl.startsWith('data:image/');

  const handleDownload = () => {
    const link = document.createElement('a');
    link.href = receipt.dataUrl;
    link.download = receipt.fileName || 'transfer-receipt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div className="min-w-0">
            <h4 className="text-xs font-black uppercase tracking-wider text-slate-900 truncate">
              Transfer Receipt {referenceLabel ? `— ${referenceLabel}` : ''}
            </h4>
            <p className="text-[10px] text-slate-500 font-mono truncate">{receipt.fileName}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={handleDownload}
              className="px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-[10px] font-black uppercase flex items-center gap-1 cursor-pointer"
            >
              <Download size={12} />
              <span>Save</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-slate-200 text-slate-500 cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="p-4 overflow-auto flex-1 flex items-center justify-center bg-slate-100">
          {!receipt.dataUrl || !receipt.dataUrl.trim() ? (
            <div className="flex flex-col items-center gap-2 p-6 bg-white rounded-xl border border-slate-200 text-slate-500 text-xs font-bold">
              <FileText size={32} className="text-slate-400" />
              <span>Receipt preview unavailable</span>
            </div>
          ) : isImage ? (
            <img
              src={receipt.dataUrl}
              alt={receipt.fileName}
              className="max-w-full max-h-[70vh] rounded-xl shadow-sm border border-slate-200 bg-white object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-3 p-6 bg-white rounded-xl border border-slate-200 w-full">
              <FileText size={40} className="text-indigo-600" />
              <div className="text-xs font-bold text-slate-800">{receipt.fileName}</div>
              <iframe
                src={receipt.dataUrl}
                title={receipt.fileName}
                className="w-full h-[55vh] rounded-lg border border-slate-200"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
