export interface TransferReceiptAttachment {
  dataUrl: string;
  fileName: string;
  mimeType: string;
  uploadedAt: string;
}

const STORAGE_KEY = 'pos_transfer_receipts_v1';

function readReceiptMap(): Record<string, TransferReceiptAttachment> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeReceiptMap(map: Record<string, TransferReceiptAttachment>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (err) {
    console.warn('Unable to cache transfer receipt in localStorage:', err);
  }
}

export function saveTransferReceipt(transferId: string, receipt: TransferReceiptAttachment | null): void {
  if (!transferId) return;
  const map = readReceiptMap();
  if (receipt) {
    map[transferId] = receipt;
  } else {
    delete map[transferId];
  }
  writeReceiptMap(map);
}

export function parseTransferNotes(notesRaw?: string | null): {
  note: string;
  receipt: TransferReceiptAttachment | null;
} {
  if (!notesRaw || typeof notesRaw !== 'string') {
    return { note: '', receipt: null };
  }
  const trimmed = notesRaw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        const dataUrl = parsed.receiptDataUrl || parsed.dataUrl || '';
        const receipt: TransferReceiptAttachment | null = dataUrl
          ? {
              dataUrl,
              fileName: parsed.receiptFileName || parsed.fileName || 'transfer-receipt.jpg',
              mimeType: parsed.receiptMimeType || parsed.mimeType || 'image/jpeg',
              uploadedAt: parsed.uploadedAt || new Date().toISOString(),
            }
          : null;
        return {
          note: typeof parsed.note === 'string' ? parsed.note : '',
          receipt,
        };
      }
    } catch {
      // fall back to raw string
    }
  }
  return { note: notesRaw, receipt: null };
}

export function encodeTransferNotesWithReceipt(
  noteText: string,
  receipt: TransferReceiptAttachment | null
): string {
  if (!receipt) {
    return noteText.trim();
  }
  return JSON.stringify({
    note: noteText.trim(),
    receiptDataUrl: receipt.dataUrl,
    receiptFileName: receipt.fileName,
    receiptMimeType: receipt.mimeType,
    uploadedAt: receipt.uploadedAt,
  });
}

export function getTransferReceipt(
  transferId: string,
  notesRaw?: string | null
): TransferReceiptAttachment | null {
  const fromNotes = parseTransferNotes(notesRaw).receipt;
  if (fromNotes) return fromNotes;
  const map = readReceiptMap();
  return transferId && map[transferId] ? map[transferId] : null;
}

export async function processTransferReceiptFile(file: File): Promise<TransferReceiptAttachment> {
  const nowIso = new Date().toISOString();
  const isImage = file.type.startsWith('image/');
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

  if (!isImage && !isPdf) {
    throw new Error('Unsupported file format. Please upload an image (JPG, PNG, WEBP) or PDF receipt.');
  }

  if (isPdf) {
    if (file.size > 2.5 * 1024 * 1024) {
      throw new Error('PDF receipt is too large (max 2.5 MB).');
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read PDF file.'));
      reader.readAsDataURL(file);
    });
    return {
      dataUrl,
      fileName: file.name || `receipt-${Date.now()}.pdf`,
      mimeType: 'application/pdf',
      uploadedAt: nowIso,
    };
  }

  // Compress image via canvas so it stores cleanly across AlaSQL, SQLite & localStorage
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });

  try {
    const compressed = await new Promise<string>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1200;
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;
        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, width);
        canvas.height = Math.max(1, height);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(rawDataUrl);
          return;
        }
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.78));
      };
      img.onerror = () => reject(new Error('Failed to process receipt image.'));
      img.src = rawDataUrl;
    });
    return {
      dataUrl: compressed,
      fileName: file.name || `receipt-${Date.now()}.jpg`,
      mimeType: 'image/jpeg',
      uploadedAt: nowIso,
    };
  } catch {
    return {
      dataUrl: rawDataUrl,
      fileName: file.name || `receipt-${Date.now()}.jpg`,
      mimeType: file.type || 'image/jpeg',
      uploadedAt: nowIso,
    };
  }
}
