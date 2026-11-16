import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { jsPDF } from 'jspdf';

/**
 * Checks if running on native Android app
 */
export function isAndroidNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

/**
 * Exports and shares/saves a jsPDF document safely across both Web and Android APK.
 * On native Android:
 * - Writes to the app's cache/documents directory using Capacitor Filesystem
 * - Obtains the native content URI
 * - Invokes Capacitor Share so the cashier can print via Android Print Spooler,
 *   send via WhatsApp, Bluetooth, Gmail, or save to Device Downloads.
 * On Web:
 * - Falls back to standard jsPDF doc.save(filename).
 */
export async function exportAndSharePdf(filename: string, doc: jsPDF): Promise<boolean> {
  try {
    if (Capacitor.isNativePlatform()) {
      // Get base64 string from jsPDF without data URI scheme header
      const dataUri = doc.output('datauristring');
      const base64Data = dataUri.split(',')[1] || dataUri;

      // Ensure filename has .pdf extension
      const safeFilename = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;

      // Write to Cache directory (clean & accessible to share sheet)
      const writeResult = await Filesystem.writeFile({
        path: safeFilename,
        data: base64Data,
        directory: Directory.Cache
      });

      // Get readable file URI
      const fileUriResult = await Filesystem.getUri({
        path: safeFilename,
        directory: Directory.Cache
      });

      const fileUri = fileUriResult.uri || writeResult.uri;

      // Invoke Android Share sheet
      try {
        await Share.share({
          title: safeFilename,
          text: `POS Receipt - ${safeFilename}`,
          url: fileUri,
          dialogTitle: 'Share or Print Receipt'
        });
        return true;
      } catch (shareErr) {
        // If share cancelled or dismissed by user
        console.log('[AndroidUtils] Share dialog closed:', shareErr);
        return true;
      }
    } else {
      // Standard browser download
      doc.save(filename);
      return true;
    }
  } catch (err) {
    console.error('[AndroidUtils] Error exporting PDF:', err);
    try {
      doc.save(filename);
    } catch (e) {
      // fallback
    }
    return false;
  }
}

/**
 * Exports CSV text files safely across Web and native Android.
 */
export async function exportAndShareCsv(filename: string, csvContent: string): Promise<boolean> {
  try {
    const safeFilename = filename.endsWith('.csv') ? filename : `${filename}.csv`;

    if (Capacitor.isNativePlatform()) {
      // Write CSV to Cache directory
      await Filesystem.writeFile({
        path: safeFilename,
        data: csvContent,
        directory: Directory.Cache,
        encoding: Encoding.UTF8
      });

      const fileUriResult = await Filesystem.getUri({
        path: safeFilename,
        directory: Directory.Cache
      });

      await Share.share({
        title: safeFilename,
        text: `Exported Report: ${safeFilename}`,
        url: fileUriResult.uri,
        dialogTitle: 'Share or Open Report'
      });
      return true;
    } else {
      // Standard web anchor click
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', safeFilename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      return true;
    }
  } catch (err) {
    console.error('[AndroidUtils] Error exporting CSV:', err);
    return false;
  }
}

/**
 * Exports arbitrary text or JSON files safely across Web and native Android.
 */
export async function exportAndShareText(filename: string, content: string, mimeType: string = 'application/json'): Promise<boolean> {
  try {
    if (Capacitor.isNativePlatform()) {
      await Filesystem.writeFile({
        path: filename,
        data: content,
        directory: Directory.Cache,
        encoding: Encoding.UTF8
      });

      const fileUriResult = await Filesystem.getUri({
        path: filename,
        directory: Directory.Cache
      });

      await Share.share({
        title: filename,
        text: `Exported file: ${filename}`,
        url: fileUriResult.uri,
        dialogTitle: 'Share or Save File'
      });
      return true;
    } else {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      return true;
    }
  } catch (err) {
    console.error('[AndroidUtils] Error exporting text file:', err);
    return false;
  }
}

/**
 * Safe print execution:
 * In Android WebView, window.print() can fail silently or throw.
 * We catch and report safely, or allow PDF sharing as the reliable alternative.
 */
export function safeSystemPrint(): void {
  try {
    if (typeof window !== 'undefined' && typeof window.print === 'function') {
      window.print();
    }
  } catch (err) {
    console.warn('[AndroidUtils] System print not supported in this WebView environment:', err);
  }
}

export interface WhatsAppPdfDispatchResult {
  success: boolean;
  mode: 'cloud_api' | 'native_file_share' | 'link_and_download';
  phone: string;
  filename: string;
  pdfUrl?: string;
  whatsappUrl?: string;
  error?: string;
  canShareFile: boolean;
}

/**
 * Triggers native mobile / Web Share sheet with the actual PDF File attachment
 * so the user can attach the compiled PDF directly in WhatsApp on phones/tablets.
 */
export async function sharePdfFileDirectly(filename: string, doc: jsPDF, caption?: string): Promise<boolean> {
  const safeFilename = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
  try {
    if (Capacitor.isNativePlatform()) {
      return await exportAndSharePdf(safeFilename, doc);
    }
    const blob = doc.output('blob');
    const file = new File([blob], safeFilename, { type: 'application/pdf' });
    if (typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      await navigator.share({
        title: safeFilename,
        text: caption || `Official PDF Receipt (${safeFilename})`,
        files: [file],
      });
      return true;
    }
  } catch (err) {
    console.warn('[AndroidUtils] Direct file share declined or unavailable:', err);
  }
  return false;
}

/**
 * Compiles the receipt PDF, uploads it to the server so it has a real downloadable PDF URL
 * (and delivers directly as a PDF document attachment if WhatsApp Cloud API is configured),
 * and opens the customer's WhatsApp number with the direct PDF link & local PDF file ready.
 */
export async function dispatchPdfToWhatsApp(params: {
  phone: string;
  filename: string;
  doc: jsPDF;
  storeName: string;
  caption: string;
}): Promise<WhatsAppPdfDispatchResult> {
  const cleanPhone = String(params.phone || '').replace(/[^\d+]/g, '');
  const digitsOnly = cleanPhone.replace(/\D/g, '');
  const safeFilename = params.filename.endsWith('.pdf') ? params.filename : `${params.filename}.pdf`;

  if (!digitsOnly || digitsOnly.length < 7) {
    return {
      success: false,
      mode: 'link_and_download',
      phone: cleanPhone,
      filename: safeFilename,
      error: 'Please enter a valid WhatsApp phone number (with country code, e.g. +26097...).',
      canShareFile: false,
    };
  }

  let canShareFile = Capacitor.isNativePlatform();
  try {
    const testBlob = params.doc.output('blob');
    const testFile = new File([testBlob], safeFilename, { type: 'application/pdf' });
    if (!canShareFile && typeof navigator !== 'undefined' && typeof navigator.canShare === 'function') {
      canShareFile = navigator.canShare({ files: [testFile] });
    }
  } catch {}

  const dataUri = params.doc.output('datauristring');
  const pdfBase64 = dataUri.includes(',') ? dataUri.split(',')[1] : dataUri;

  let pdfUrl = '';
  let sentDirectly = false;

  try {
    const resp = await fetch('/api/whatsapp/send-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: digitsOnly,
        filename: safeFilename,
        pdfBase64,
        caption: params.caption,
      }),
    });
    if (resp.ok) {
      const data = await resp.json();
      sentDirectly = Boolean(data?.sentDirectly);
      pdfUrl = data?.pdfUrl || '';
    }
  } catch (err) {
    console.warn('[WhatsApp PDF] Server dispatch check failed, falling back to local file + WhatsApp chat:', err);
  }

  if (sentDirectly) {
    return {
      success: true,
      mode: 'cloud_api',
      phone: digitsOnly,
      filename: safeFilename,
      pdfUrl,
      canShareFile,
    };
  }

  // On native Android/mobile share-capable devices, try sharing the actual PDF file;
  // on desktop browsers, save the PDF locally and open wa.me directly to the customer's number with the direct PDF URL.
  const msgLines = [
    `Hello! Here is your official PDF receipt from *${params.storeName.toUpperCase()}*:`,
    params.caption,
    pdfUrl ? `📄 *Download Receipt PDF:*\n${pdfUrl}` : `📎 _PDF File: ${safeFilename}_`,
  ].filter(Boolean);

  const whatsappUrl = `https://wa.me/${digitsOnly}?text=${encodeURIComponent(msgLines.join('\n\n'))}`;

  // Trigger local PDF download on desktop web so the actual PDF file is immediately saved too
  if (!Capacitor.isNativePlatform()) {
    try {
      params.doc.save(safeFilename);
    } catch {}
  }

  return {
    success: true,
    mode: 'link_and_download',
    phone: digitsOnly,
    filename: safeFilename,
    pdfUrl,
    whatsappUrl,
    canShareFile,
  };
}
