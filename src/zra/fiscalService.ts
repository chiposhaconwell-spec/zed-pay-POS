import QRCode from 'qrcode';
import { runSql, persistTablesToStorage } from '../db';
import {
  getZraConfig,
  saveZraConfig,
  nextZraInvoiceNo,
  getZraTaxMeta,
  ZraConfig,
  ZraTaxTypeCode,
} from './zraConfig';

export const ZRA_QUEUE_STORAGE_KEY = 'pos_zra_offline_queue';
export const ZRA_RECORDS_STORAGE_KEY = 'pos_zra_fiscal_records';

export interface ZraSaleItemInput {
  productId?: number | string;
  itemNm: string;
  itemCd?: string;
  itemClsCd?: string;
  taxTyCd?: ZraTaxTypeCode | string;
  pkgUnitCd?: string;
  qtyUnitCd?: string;
  qty: number;
  prc: number;
  dcRt?: number;
  dcAmt?: number;
  isService?: boolean;
}

export interface ZraSaleInput {
  orderId: string;
  salesDateIso?: string;
  items: ZraSaleItemInput[];
  totalAmount?: number;
  discountAmount?: number;
  paymentMethod?: string;
  cashierName?: string;
  cashierId?: string;
  customerName?: string;
  customerTpin?: string;
  customerPhone?: string;
  isRefund?: boolean;
  orgInvcNo?: number;
  orgSdcId?: string;
  rfdRsnCd?: string;
  currencyTyCd?: string;
  exchangeRt?: number;
}

export interface ZraFiscalReceiptData {
  status: 'LOCAL_ONLY' | 'FISCALIZED' | 'QUEUED_OFFLINE' | 'ERROR';
  tpin: string;
  bhfId: string;
  taxBand: string;
  sdcId: string;
  mrcNo: string;
  rcptNo: number;
  cisInvcNo: string;
  intrlData: string;
  rcptSign: string;
  formattedIntrlData: string;
  formattedRcptSign: string;
  qrCodeUrl: string;
  qrDataUrl: string;
  vsdcRcptPbctDate: string;
  fiscalCode: string;
  receiptLabel: 'NS' | 'NR' | 'CS' | 'PS';
  fiscalizedAt: string;
  errorMessage?: string;
}

export interface ZraOfflineQueueItem {
  id: string;
  orderId: string;
  endpoint: string;
  vsdcApiUrl: string;
  useServerProxy: boolean;
  payload: Record<string, any>;
  saleInput: ZraSaleInput;
  createdAt: string;
  retryCount: number;
  lastError?: string;
}

export interface ZraSubmissionResult {
  status: 'LOCAL_ONLY' | 'FISCALIZED' | 'QUEUED_OFFLINE' | 'FAILED';
  fiscalStatus: 'LOCAL_ONLY' | 'FISCALIZED' | 'QUEUED_OFFLINE' | 'ERROR';
  zraData: ZraFiscalReceiptData | null;
  payload?: Record<string, any>;
  rawResponse?: any;
  error?: string;
  queueItemId?: string;
}

export interface ZraInitResult {
  success: boolean;
  alreadyInstalled?: boolean;
  message: string;
  sdcId?: string;
  mrcNo?: string;
  lastSaleInvcNo?: number;
  taxprNm?: string;
  bhfNm?: string;
  raw?: any;
}

class VsdcNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VsdcNetworkError';
  }
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function formatHyphen4(value?: string): string {
  const clean = String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!clean) return '';
  return clean.match(/.{1,4}/g)?.join('-') || clean;
}

export function formatZraTimestamp14(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    date.getFullYear().toString() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

export function formatZraDate8(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    date.getFullYear().toString() +
    pad(date.getMonth() + 1) +
    pad(date.getDate())
  );
}

export function mapPaymentMethodToZraCode(method?: string): string {
  const m = String(method || '').toUpperCase();
  if (m.includes('SPLIT')) return '03';
  if (m.includes('LAYBY') || m.includes('CREDIT')) {
    if (m.includes('CARD') || m.includes('VISA') || m.includes('MASTER')) return '05';
    return '02';
  }
  if (m.includes('AIRTEL') || m.includes('MTN') || m.includes('MOMO') || m.includes('MOBILE') || m.includes('ZOONA') || m.includes('ZAMTEL')) {
    return '06';
  }
  if (m.includes('CHECK') || m.includes('CHEQUE')) return '04';
  if (m.includes('CARD') || m.includes('POS') || m.includes('VISA') || m.includes('DEBIT')) return '05';
  if (m.includes('TRANSFER') || m.includes('EFT') || m.includes('BANK')) return '08';
  if (m.includes('CASH')) return '01';
  return '07';
}

export function mapCurrencyCode(raw?: string): string {
  const val = String(raw || '').trim().toUpperCase();
  if (!val || val === 'K' || val === 'ZK' || val === 'ZMW') return 'ZMW';
  if (val === '$') return 'USD';
  if (val === '£') return 'GBP';
  if (val === '€') return 'EUR';
  if (val === 'R') return 'ZAR';
  if (val.length === 3) return val;
  return 'ZMW';
}

export async function generateQrDataUrl(text: string): Promise<string> {
  if (!text) return '';
  try {
    return await QRCode.toDataURL(text, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    });
  } catch {
    return '';
  }
}

function sqlEscape(val: string): string {
  return String(val ?? '').replace(/'/g, "''");
}

function loadRecordsMap(): Record<string, ZraFiscalReceiptData> {
  try {
    const raw = localStorage.getItem(ZRA_RECORDS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {}
  return {};
}

function saveFiscalRecord(orderId: string, record: ZraFiscalReceiptData, payload?: Record<string, any>) {
  try {
    const map = loadRecordsMap();
    map[orderId] = record;
    localStorage.setItem(ZRA_RECORDS_STORAGE_KEY, JSON.stringify(map));
  } catch {}

  try {
    const nowIso = new Date().toISOString();
    const recordId = `zra_${sqlEscape(orderId)}`;
    runSql(`DELETE FROM zra_invoices WHERE order_id = '${sqlEscape(orderId)}'`, 'ZRA: Replace fiscal invoice entry', true);
    runSql(
      `INSERT INTO zra_invoices (id, order_id, status, tpin, bhf_id, sdc_id, mrc_no, rcpt_no, cis_invc_no, intrl_data, rcpt_sign, qr_code_url, vsdc_date, payload_json, record_json, created_at, updated_at) VALUES (
        '${recordId}',
        '${sqlEscape(orderId)}',
        '${sqlEscape(record.status)}',
        '${sqlEscape(record.tpin)}',
        '${sqlEscape(record.bhfId)}',
        '${sqlEscape(record.sdcId)}',
        '${sqlEscape(record.mrcNo)}',
        ${Number(record.rcptNo || 0)},
        '${sqlEscape(record.cisInvcNo)}',
        '${sqlEscape(record.intrlData)}',
        '${sqlEscape(record.rcptSign)}',
        '${sqlEscape(record.qrCodeUrl)}',
        '${sqlEscape(record.vsdcRcptPbctDate)}',
        '${sqlEscape(payload ? JSON.stringify(payload) : '{}')}',
        '${sqlEscape(JSON.stringify(record))}',
        '${nowIso}',
        '${nowIso}'
      )`,
      `ZRA: Persist fiscal signature for ${orderId}`,
      true
    );
    persistTablesToStorage(true);
  } catch {}
}

function loadOfflineQueueFromStorage(): ZraOfflineQueueItem[] {
  try {
    const raw = localStorage.getItem(ZRA_QUEUE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

function saveOfflineQueueToStorage(queue: ZraOfflineQueueItem[]) {
  try {
    localStorage.setItem(ZRA_QUEUE_STORAGE_KEY, JSON.stringify(queue));
  } catch {}

  try {
    runSql(`DELETE FROM zra_sync_queue`, 'ZRA Queue: Clear sync snapshot', true);
    queue.forEach((item) => {
      runSql(
        `INSERT INTO zra_sync_queue (id, order_id, endpoint, payload_json, sale_json, retry_count, last_error, created_at) VALUES (
          '${sqlEscape(item.id)}',
          '${sqlEscape(item.orderId)}',
          '${sqlEscape(item.endpoint)}',
          '${sqlEscape(JSON.stringify(item.payload))}',
          '${sqlEscape(JSON.stringify(item.saleInput))}',
          ${Number(item.retryCount || 0)},
          '${sqlEscape(item.lastError || '')}',
          '${sqlEscape(item.createdAt)}'
        )`,
        `ZRA Queue: Save pending item ${item.orderId}`,
        true
      );
    });
    persistTablesToStorage(true);
  } catch {}

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('zra_queue_updated', { detail: queue }));
  }
}

async function postToVsdcEndpoint(
  vsdcApiUrl: string,
  path: string,
  payload: Record<string, any>,
  useServerProxy: boolean
): Promise<any> {
  const cleanBase = String(vsdcApiUrl || '').trim().replace(/\/+$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const targetUrl = `${cleanBase}${cleanPath}`;

  if (typeof navigator !== 'undefined' && navigator.onLine === false && !cleanBase.includes('localhost') && !cleanBase.includes('127.0.0.1')) {
    throw new VsdcNetworkError('Device browser reports offline status.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    if (useServerProxy) {
      let resp: Response;
      try {
        resp = await fetch('/api/zra/forward', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl, payload }),
          signal: controller.signal,
        });
      } catch (fetchErr: any) {
        throw new VsdcNetworkError(fetchErr?.message || 'Unable to reach local POS proxy server');
      }

      const json = await resp.json().catch(() => null);
      if (resp.status === 502 || resp.status === 503 || resp.status === 504 || json?.networkError) {
        throw new VsdcNetworkError(json?.error || `VSDC unreachable (HTTP ${resp.status})`);
      }
      if (!resp.ok && !json) {
        throw new VsdcNetworkError(`VSDC proxy HTTP ${resp.status}`);
      }
      return json;
    } else {
      let resp: Response;
      try {
        resp = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (fetchErr: any) {
        throw new VsdcNetworkError(fetchErr?.message || 'Network connection to VSDC failed');
      }
      const json = await resp.json().catch(() => null);
      if (!resp.ok && !json) {
        throw new VsdcNetworkError(`VSDC endpoint HTTP ${resp.status}`);
      }
      return json;
    }
  } finally {
    clearTimeout(timer);
  }
}

let autoSyncStarted = false;
let isProcessingQueue = false;

export const FiscalService = {
  /**
   * Initialize or test connection to the VSDC device via /initializer/selectInitInfo.
   */
  async initializeDevice(configOverride?: Partial<ZraConfig>): Promise<ZraInitResult> {
    const merged: ZraConfig = {
      ...getZraConfig(),
      ...(configOverride || {}),
    };

    if (!merged.tpin || merged.tpin.trim().length < 6) {
      return { success: false, message: 'Enter a valid TPIN before initializing VSDC.' };
    }
    if (!merged.bhfId) {
      return { success: false, message: 'Enter a valid Branch ID (e.g. 000).' };
    }
    if (!merged.vsdcApiUrl) {
      return { success: false, message: 'Enter the VSDC API base URL.' };
    }

    try {
      const data = await postToVsdcEndpoint(
        merged.vsdcApiUrl,
        '/initializer/selectInitInfo',
        {
          tpin: merged.tpin.trim(),
          bhfId: merged.bhfId.trim(),
          dvcSrlNo: (merged.dvcSrlNo || 'POS-VSDC-001').trim(),
        },
        merged.useServerProxy
      );

      const code = String(data?.resultCd || '');
      const msg = String(data?.resultMsg || 'Unknown VSDC response');

      if (code === '000' || code === '902') {
        const info = data?.data?.info || {};
        const sdcId = info.sdcId || merged.sdcId || '';
        const mrcNo = info.mrcNo || merged.mrcNo || '';
        const lastSaleInvcNo = Number(info.lastSaleInvcNo ?? merged.lastSaleInvcNo ?? 0);
        const taxprNm = info.taxprNm || merged.taxprNm || '';
        const bhfNm = info.bhfNm || merged.bhfNm || '';

        saveZraConfig({
          ...merged,
          sdcId,
          mrcNo,
          lastSaleInvcNo,
          taxprNm,
          bhfNm,
          lastInitializedAt: new Date().toISOString(),
        });

        return {
          success: true,
          alreadyInstalled: code === '902',
          message: code === '902'
            ? `VSDC Connected (Device already initialized: ${msg})`
            : `VSDC Initialized Successfully${sdcId ? ` • SDC ID: ${sdcId}` : ''}`,
          sdcId,
          mrcNo,
          lastSaleInvcNo,
          taxprNm,
          bhfNm,
          raw: data,
        };
      }

      return {
        success: false,
        message: `VSDC returned [${code || 'ERR'}]: ${msg}`,
        raw: data,
      };
    } catch (err: any) {
      return {
        success: false,
        message: err?.message || 'Could not connect to VSDC service',
      };
    }
  },

  /**
   * Maps POS sale data & items into ZRA VSDC TrnsSalesSaveWrReq JSON payload.
   * All unit prices (prc) are treated as tax-inclusive per ZRA Smart Invoice CIS & VSDC specification.
   */
  mapSaleToVsdcPayload(
    saleData: ZraSaleInput,
    config: ZraConfig = getZraConfig(),
    invcNoOverride?: number
  ): Record<string, any> {
    const saleDate = saleData.salesDateIso ? new Date(saleData.salesDateIso) : new Date();
    const safeDate = isNaN(saleDate.getTime()) ? new Date() : saleDate;
    const cfmDt = formatZraTimestamp14(safeDate);
    const salesDt = formatZraDate8(safeDate);
    const invcNo = invcNoOverride ?? nextZraInvoiceNo();
    const cisInvcNo = saleData.orderId || `INV-${invcNo}`;

    const isRefund = Boolean(saleData.isRefund);
    const pmtTyCd = mapPaymentMethodToZraCode(saleData.paymentMethod);

    // Header accumulator across all 15 ZRA tax buckets
    const buckets: Record<string, { taxbl: number; rate: number; tax: number }> = {
      A: { taxbl: 0, rate: 16, tax: 0 },
      B: { taxbl: 0, rate: 16, tax: 0 },
      C1: { taxbl: 0, rate: 0, tax: 0 },
      C2: { taxbl: 0, rate: 0, tax: 0 },
      C3: { taxbl: 0, rate: 0, tax: 0 },
      D: { taxbl: 0, rate: 0, tax: 0 },
      E: { taxbl: 0, rate: 0, tax: 0 },
      F: { taxbl: 0, rate: 10, tax: 0 },
      Ipl1: { taxbl: 0, rate: 5, tax: 0 },
      Ipl2: { taxbl: 0, rate: 0, tax: 0 },
      Tl: { taxbl: 0, rate: 1.5, tax: 0 },
      Ecm: { taxbl: 0, rate: 5, tax: 0 },
      Exeeg: { taxbl: 0, rate: 3, tax: 0 },
      Tot: { taxbl: 0, rate: 0, tax: 0 },
      Rvat: { taxbl: 0, rate: 16, tax: 0 },
    };

    const rawItems = Array.isArray(saleData.items) ? saleData.items : [];
    const totalGrossFromLines = rawItems.reduce(
      (sum, it) => sum + Math.max(0, Number(it.prc || 0)) * Math.max(0, Number(it.qty || 0)),
      0
    );
    const headerDiscountTotal = Math.max(0, Number(saleData.discountAmount || 0));

    let totTaxblAmt = 0;
    let totTaxAmt = 0;
    let totAmt = 0;
    let headerTlAmt = 0;

    const itemList = rawItems.map((it, idx) => {
      const qty = Math.max(0.0001, Number(it.qty || 1));
      const prc = Math.max(0, Number(it.prc || 0));
      const splyAmt = round2(prc * qty);

      // Proportional share of cart-wide discount if item discount wasn't explicitly provided
      const lineShareDiscount =
        it.dcAmt !== undefined
          ? Math.max(0, Number(it.dcAmt || 0))
          : headerDiscountTotal > 0 && totalGrossFromLines > 0
            ? round2((splyAmt / totalGrossFromLines) * headerDiscountTotal)
            : 0;
      const dcRt =
        it.dcRt !== undefined
          ? round2(Number(it.dcRt || 0))
          : splyAmt > 0 && lineShareDiscount > 0
            ? round2((lineShareDiscount / splyAmt) * 100)
            : 0;

      const lineTotAmt = round2(Math.max(0, splyAmt - lineShareDiscount));
      const taxCode = String(it.taxTyCd || config.defaultTaxTyCd || 'A').toUpperCase();
      const taxMeta = getZraTaxMeta(taxCode);
      const rate = taxMeta.rate;

      const lineTaxbl = rate > 0 ? round2(lineTotAmt / (1 + rate / 100)) : lineTotAmt;
      const lineTax = rate > 0 ? round2(lineTotAmt - lineTaxbl) : 0;

      // Map item-level tax fields per VSDC v1.0.11.4 spec
      let vatCatCd: string | null = null;
      let vatTaxblAmt = 0;
      let vatAmt = 0;
      let iplCatCd: string | null = null;
      let iplTaxblAmt = 0;
      let iplAmt = 0;
      let tlCatCd: string | null = null;
      let tlTaxblAmt = 0;
      let tlAmt = 0;
      let exciseTxCatCd: string | null = null;
      let exciseTaxblAmt = 0;
      let exciseTxAmt = 0;

      if (taxMeta.category === 'IPL') {
        iplCatCd = taxMeta.code;
        iplTaxblAmt = lineTaxbl;
        iplAmt = lineTax;
        const bKey = taxMeta.code === 'IPL1' ? 'Ipl1' : 'Ipl2';
        buckets[bKey].taxbl = round2(buckets[bKey].taxbl + lineTaxbl);
        buckets[bKey].tax = round2(buckets[bKey].tax + lineTax);
      } else if (taxMeta.category === 'TL') {
        tlCatCd = 'TL';
        tlTaxblAmt = lineTaxbl;
        tlAmt = lineTax;
        headerTlAmt = round2(headerTlAmt + lineTax);
        buckets.Tl.taxbl = round2(buckets.Tl.taxbl + lineTaxbl);
        buckets.Tl.tax = round2(buckets.Tl.tax + lineTax);
      } else if (taxMeta.category === 'EXCISE') {
        exciseTxCatCd = taxMeta.code;
        exciseTaxblAmt = lineTaxbl;
        exciseTxAmt = lineTax;
        const bKey = taxMeta.code === 'ECM' ? 'Ecm' : 'Exeeg';
        buckets[bKey].taxbl = round2(buckets[bKey].taxbl + lineTaxbl);
        buckets[bKey].tax = round2(buckets[bKey].tax + lineTax);
      } else {
        vatCatCd = taxMeta.code;
        vatTaxblAmt = lineTaxbl;
        vatAmt = lineTax;
        const bKey = taxMeta.code === 'RVAT' ? 'Rvat' : taxMeta.code === 'TOT' ? 'Tot' : taxMeta.code;
        if (buckets[bKey]) {
          buckets[bKey].taxbl = round2(buckets[bKey].taxbl + lineTaxbl);
          buckets[bKey].tax = round2(buckets[bKey].tax + lineTax);
        } else {
          buckets.A.taxbl = round2(buckets.A.taxbl + lineTaxbl);
          buckets.A.tax = round2(buckets.A.tax + lineTax);
        }
      }

      totTaxblAmt = round2(totTaxblAmt + lineTaxbl);
      totTaxAmt = round2(totTaxAmt + lineTax);
      totAmt = round2(totAmt + lineTotAmt);

      const cleanItemCd = (it.itemCd || `ZM${config.defaultQtyUnitCd || 'U'}${it.productId || idx + 1}`)
        .replace(/[^A-Za-z0-9_-]/g, '')
        .slice(0, 20);
      const cleanClsCd = (it.itemClsCd || config.defaultItemClsCd || '50102518')
        .replace(/[^0-9]/g, '')
        .slice(0, 10) || '50102518';

      return {
        itemSeq: idx + 1,
        itemCd: cleanItemCd,
        itemClsCd: cleanClsCd,
        itemNm: String(it.itemNm || `Item ${idx + 1}`).slice(0, 200),
        bcd: cleanItemCd,
        pkgUnitCd: it.pkgUnitCd || config.defaultPkgUnitCd || 'BA',
        pkg: 1,
        qtyUnitCd: it.qtyUnitCd || config.defaultQtyUnitCd || 'U',
        qty: round2(qty),
        prc: round2(prc),
        splyAmt,
        dcRt,
        dcAmt: lineShareDiscount,
        isrccCd: null,
        isrccNm: null,
        isrcRt: 0,
        isrcAmt: 0,
        vatCatCd,
        exciseTxCatCd,
        tlCatCd,
        iplCatCd,
        vatTaxblAmt,
        vatAmt,
        exciseTaxblAmt,
        exciseTxAmt,
        tlTaxblAmt,
        tlAmt,
        iplTaxblAmt,
        iplAmt,
        taxblAmt: lineTaxbl,
        taxAmt: lineTax,
        totAmt: lineTotAmt,
      };
    });

    const cleanCustTpin = String(saleData.customerTpin || '').replace(/\D/g, '');
    const validCustTpin = cleanCustTpin.length === 10 ? cleanCustTpin : null;
    const cleanPhone = String(saleData.customerPhone || '').replace(/[^\d+]/g, '');
    const validCustPhone = cleanPhone.length >= 7 && cleanPhone !== 'N/A' ? cleanPhone.slice(0, 20) : null;
    const actor = String(saleData.cashierName || 'Cashier').slice(0, 60);
    const actorId = String(saleData.cashierId || actor || 'admin').slice(0, 20);

    return {
      tpin: config.tpin.trim(),
      bhfId: (config.bhfId || '000').trim(),
      orgInvcNo: isRefund ? Number(saleData.orgInvcNo || 0) : 0,
      cisInvcNo,
      custTpin: validCustTpin,
      custNm: saleData.customerName && saleData.customerName !== 'N/A'
        ? String(saleData.customerName).slice(0, 60)
        : null,
      custMblNo: validCustPhone,
      salesTyCd: 'N',
      rcptTyCd: isRefund ? 'R' : 'S',
      pmtTyCd,
      salesSttsCd: isRefund ? '05' : '02',
      cfmDt,
      salesDt,
      stockRlsDt: cfmDt,
      cnclReqDt: null,
      cnclDt: null,
      rfdDt: isRefund ? cfmDt : null,
      rfdRsnCd: isRefund ? (saleData.rfdRsnCd || '01') : null,
      totItemCnt: itemList.length,
      taxblAmtA: buckets.A.taxbl,
      taxblAmtB: buckets.B.taxbl,
      taxblAmtC1: buckets.C1.taxbl,
      taxblAmtC2: buckets.C2.taxbl,
      taxblAmtC3: buckets.C3.taxbl,
      taxblAmtD: buckets.D.taxbl,
      taxblAmtE: buckets.E.taxbl,
      taxblAmtF: buckets.F.taxbl,
      taxblAmtIpl1: buckets.Ipl1.taxbl,
      taxblAmtIpl2: buckets.Ipl2.taxbl,
      taxblAmtTl: buckets.Tl.taxbl,
      taxblAmtEcm: buckets.Ecm.taxbl,
      taxblAmtExeeg: buckets.Exeeg.taxbl,
      taxblAmtTot: buckets.Tot.taxbl,
      taxblAmtRvat: buckets.Rvat.taxbl,
      taxRtA: buckets.A.rate,
      taxRtB: buckets.B.rate,
      taxRtC1: buckets.C1.rate,
      taxRtC2: buckets.C2.rate,
      taxRtC3: buckets.C3.rate,
      taxRtD: buckets.D.rate,
      taxRtE: buckets.E.rate,
      taxRtF: buckets.F.rate,
      taxRtIpl1: buckets.Ipl1.rate,
      taxRtIpl2: buckets.Ipl2.rate,
      taxRtTl: buckets.Tl.rate,
      taxRtEcm: buckets.Ecm.rate,
      taxRtExeeg: buckets.Exeeg.rate,
      taxRtTot: buckets.Tot.rate,
      taxRtRvat: buckets.Rvat.rate,
      taxAmtA: buckets.A.tax,
      taxAmtB: buckets.B.tax,
      taxAmtC1: buckets.C1.tax,
      taxAmtC2: buckets.C2.tax,
      taxAmtC3: buckets.C3.tax,
      taxAmtD: buckets.D.tax,
      taxAmtE: buckets.E.tax,
      taxAmtF: buckets.F.tax,
      taxAmtIpl1: buckets.Ipl1.tax,
      taxAmtIpl2: buckets.Ipl2.tax,
      taxAmtTl: buckets.Tl.tax,
      taxAmtEcm: buckets.Ecm.tax,
      taxAmtExeeg: buckets.Exeeg.tax,
      taxAmtTot: buckets.Tot.tax,
      taxAmtRvat: buckets.Rvat.tax,
      totTaxblAmt,
      totTaxAmt,
      totAmt,
      tlAmt: headerTlAmt,
      prchrAcptcYn: 'N',
      remark: `${config.cisCode || 'CIS'} POS Order ${cisInvcNo}`,
      regrId: actorId,
      regrNm: actor,
      modrId: actorId,
      modrNm: actor,
      saleCtyCd: '1',
      currencyTyCd: mapCurrencyCode(saleData.currencyTyCd),
      exchangeRt: Number(saleData.exchangeRt || 1),
      destnCountryCd: null,
      dbtRsnCd: null,
      invcAdjustReason: null,
      ...(isRefund && saleData.orgSdcId ? { orgSdcId: saleData.orgSdcId } : {}),
      itemList,
    };
  },

  /**
   * Submits a sale invoice to ZRA VSDC.
   * - If ZRA is toggled OFF: returns immediately and marks the sale as "LOCAL_ONLY".
   * - If ZRA is toggled ON: maps items and POSTs to {vsdcApiUrl}/trnsSales/saveSales.
   * - On success: attaches SDC_ID, Fiscal Signature, and QR Code (URL + DataURL) to receipt object.
   * - On network failure while ON: saves payload to persistent offline sync queue for auto-retry.
   */
  async submitInvoice(saleData: ZraSaleInput): Promise<ZraSubmissionResult> {
    const config = getZraConfig();

    // 1. Toggle OFF -> return immediately as LOCAL_ONLY
    if (!config.enabled) {
      return {
        status: 'LOCAL_ONLY',
        fiscalStatus: 'LOCAL_ONLY',
        zraData: null,
      };
    }

    const payload = this.mapSaleToVsdcPayload(saleData, config);
    const primaryTaxMeta = getZraTaxMeta(
      saleData.items?.[0]?.taxTyCd || config.defaultTaxTyCd
    );

    // Ensure basic configuration exists before sending
    if (!config.tpin || !config.vsdcApiUrl) {
      const errMsg = 'ZRA is enabled, but TPIN or VSDC API URL is not configured.';
      return this._enqueueFailedSubmission(saleData, payload, config, primaryTaxMeta.name, errMsg);
    }

    try {
      const resJson = await postToVsdcEndpoint(
        config.vsdcApiUrl,
        '/trnsSales/saveSales',
        payload,
        config.useServerProxy
      );

      const resultCd = String(resJson?.resultCd || '');
      const resultMsg = String(resJson?.resultMsg || '');

      if (resultCd === '000' && resJson?.data) {
        const d = resJson.data;
        const sdcId = String(d.sdcId || config.sdcId || '');
        const mrcNo = String(d.mrcNo || config.mrcNo || '');
        const rcptNo = Number(d.rcptNo || 0);
        const intrlData = String(d.intrlData || '');
        const rcptSign = String(d.rcptSign || '');
        const vsdcRcptPbctDate = String(d.vsdcRcptPbctDate || payload.cfmDt);
        const qrCodeUrl = String(
          d.qrCodeUrl ||
          `https://siportal.zra.org.zm/common/link/ebm/receipt/indexEbmReceiptData?Data=${config.tpin}${config.bhfId}${rcptSign}`
        );
        const qrDataUrl = await generateQrDataUrl(qrCodeUrl);

        if (sdcId && sdcId !== config.sdcId) {
          saveZraConfig({ sdcId, mrcNo: mrcNo || config.mrcNo });
        }

        const zraData: ZraFiscalReceiptData = {
          status: 'FISCALIZED',
          tpin: config.tpin,
          bhfId: config.bhfId,
          taxBand: primaryTaxMeta.name,
          sdcId,
          mrcNo,
          rcptNo,
          cisInvcNo: payload.cisInvcNo,
          intrlData,
          rcptSign,
          formattedIntrlData: formatHyphen4(intrlData),
          formattedRcptSign: formatHyphen4(rcptSign),
          qrCodeUrl,
          qrDataUrl,
          vsdcRcptPbctDate,
          fiscalCode: `${sdcId || 'SDC'}-${rcptNo || payload.cisInvcNo}`,
          receiptLabel: saleData.isRefund ? 'NR' : 'NS',
          fiscalizedAt: new Date().toISOString(),
        };

        saveFiscalRecord(saleData.orderId, zraData, payload);

        return {
          status: 'FISCALIZED',
          fiscalStatus: 'FISCALIZED',
          zraData,
          payload,
          rawResponse: resJson,
        };
      }

      // Non-000 VSDC API business error
      return {
        status: 'FAILED',
        fiscalStatus: 'ERROR',
        zraData: {
          status: 'ERROR',
          tpin: config.tpin,
          bhfId: config.bhfId,
          taxBand: primaryTaxMeta.name,
          sdcId: config.sdcId || '',
          mrcNo: config.mrcNo || '',
          rcptNo: 0,
          cisInvcNo: payload.cisInvcNo,
          intrlData: '',
          rcptSign: '',
          formattedIntrlData: '',
          formattedRcptSign: '',
          qrCodeUrl: '',
          qrDataUrl: '',
          vsdcRcptPbctDate: '',
          fiscalCode: `ERR-${resultCd || 'VSDC'}`,
          receiptLabel: saleData.isRefund ? 'NR' : 'NS',
          fiscalizedAt: new Date().toISOString(),
          errorMessage: resultMsg || `VSDC Error ${resultCd}`,
        },
        payload,
        rawResponse: resJson,
        error: `VSDC [${resultCd}]: ${resultMsg || 'Rejection error'}`,
      };
    } catch (err: any) {
      // Network/transport failure -> queue to persistent offline sync queue
      const msg = err?.message || 'VSDC connection unreachable';
      return this._enqueueFailedSubmission(saleData, payload, config, primaryTaxMeta.name, msg);
    }
  },

  async _enqueueFailedSubmission(
    saleData: ZraSaleInput,
    payload: Record<string, any>,
    config: ZraConfig,
    taxBandName: string,
    errorMsg: string
  ): Promise<ZraSubmissionResult> {
    const queue = loadOfflineQueueFromStorage();
    const existingIdx = queue.findIndex((q) => q.orderId === saleData.orderId);
    const queueId = existingIdx >= 0 ? queue[existingIdx].id : `zraq_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;

    const queueItem: ZraOfflineQueueItem = {
      id: queueId,
      orderId: saleData.orderId,
      endpoint: '/trnsSales/saveSales',
      vsdcApiUrl: config.vsdcApiUrl,
      useServerProxy: config.useServerProxy,
      payload,
      saleInput: saleData,
      createdAt: existingIdx >= 0 ? queue[existingIdx].createdAt : new Date().toISOString(),
      retryCount: existingIdx >= 0 ? queue[existingIdx].retryCount + 1 : 0,
      lastError: errorMsg,
    };

    if (existingIdx >= 0) {
      queue[existingIdx] = queueItem;
    } else {
      queue.push(queueItem);
    }
    saveOfflineQueueToStorage(queue);

    const zraData: ZraFiscalReceiptData = {
      status: 'QUEUED_OFFLINE',
      tpin: config.tpin,
      bhfId: config.bhfId,
      taxBand: taxBandName,
      sdcId: config.sdcId || 'PENDING-SYNC',
      mrcNo: config.mrcNo || '',
      rcptNo: 0,
      cisInvcNo: payload.cisInvcNo,
      intrlData: '',
      rcptSign: '',
      formattedIntrlData: 'QUEUED-OFFLINE-SYNC',
      formattedRcptSign: 'PENDING-VSDC-SIGN',
      qrCodeUrl: '',
      qrDataUrl: '',
      vsdcRcptPbctDate: payload.cfmDt,
      fiscalCode: `QUEUED-${payload.cisInvcNo}`,
      receiptLabel: saleData.isRefund ? 'NR' : 'NS',
      fiscalizedAt: new Date().toISOString(),
      errorMessage: errorMsg,
    };

    saveFiscalRecord(saleData.orderId, zraData, payload);

    return {
      status: 'QUEUED_OFFLINE',
      fiscalStatus: 'QUEUED_OFFLINE',
      zraData,
      payload,
      error: errorMsg,
      queueItemId: queueId,
    };
  },

  getOfflineQueue(): ZraOfflineQueueItem[] {
    return loadOfflineQueueFromStorage();
  },

  removeQueueItem(id: string): ZraOfflineQueueItem[] {
    const queue = loadOfflineQueueFromStorage().filter((q) => q.id !== id);
    saveOfflineQueueToStorage(queue);
    return queue;
  },

  getFiscalRecordByOrderId(orderId: string): ZraFiscalReceiptData | null {
    if (!orderId) return null;
    const map = loadRecordsMap();
    if (map[orderId]) return map[orderId];
    try {
      const res = runSql(
        `SELECT record_json FROM zra_invoices WHERE order_id = '${sqlEscape(orderId)}' LIMIT 1`,
        'ZRA: Lookup fiscal record',
        true
      );
      if (res.success && Array.isArray(res.data) && res.data[0]?.record_json) {
        return JSON.parse(res.data[0].record_json);
      }
    } catch {}
    return null;
  },

  async retryQueueItem(id: string): Promise<{ synced: boolean; message: string }> {
    const queue = loadOfflineQueueFromStorage();
    const item = queue.find((q) => q.id === id);
    if (!item) return { synced: false, message: 'Queue item not found.' };

    const cfg = getZraConfig();
    const targetUrl = cfg.vsdcApiUrl || item.vsdcApiUrl;

    try {
      const resJson = await postToVsdcEndpoint(
        targetUrl,
        item.endpoint || '/trnsSales/saveSales',
        item.payload,
        cfg.useServerProxy
      );

      if (String(resJson?.resultCd || '') === '000' && resJson?.data) {
        const d = resJson.data;
        const sdcId = String(d.sdcId || cfg.sdcId || '');
        const mrcNo = String(d.mrcNo || cfg.mrcNo || '');
        const rcptNo = Number(d.rcptNo || 0);
        const intrlData = String(d.intrlData || '');
        const rcptSign = String(d.rcptSign || '');
        const qrCodeUrl = String(
          d.qrCodeUrl ||
          `https://siportal.zra.org.zm/common/link/ebm/receipt/indexEbmReceiptData?Data=${cfg.tpin}${cfg.bhfId}${rcptSign}`
        );
        const qrDataUrl = await generateQrDataUrl(qrCodeUrl);
        const primaryTaxMeta = getZraTaxMeta(
          item.saleInput?.items?.[0]?.taxTyCd || cfg.defaultTaxTyCd
        );

        const zraData: ZraFiscalReceiptData = {
          status: 'FISCALIZED',
          tpin: cfg.tpin || item.payload.tpin,
          bhfId: cfg.bhfId || item.payload.bhfId,
          taxBand: primaryTaxMeta.name,
          sdcId,
          mrcNo,
          rcptNo,
          cisInvcNo: item.payload.cisInvcNo,
          intrlData,
          rcptSign,
          formattedIntrlData: formatHyphen4(intrlData),
          formattedRcptSign: formatHyphen4(rcptSign),
          qrCodeUrl,
          qrDataUrl,
          vsdcRcptPbctDate: String(d.vsdcRcptPbctDate || item.payload.cfmDt),
          fiscalCode: `${sdcId || 'SDC'}-${rcptNo || item.payload.cisInvcNo}`,
          receiptLabel: item.saleInput?.isRefund ? 'NR' : 'NS',
          fiscalizedAt: new Date().toISOString(),
        };

        saveFiscalRecord(item.orderId, zraData, item.payload);
        this.removeQueueItem(item.id);
        return { synced: true, message: `Invoice ${item.orderId} fiscalized (SDC: ${sdcId}, Rcpt #${rcptNo}).` };
      }

      const errMsg = `VSDC [${resJson?.resultCd || 'ERR'}]: ${resJson?.resultMsg || 'Rejected'}`;
      const updated = queue.map((q) =>
        q.id === id ? { ...q, retryCount: q.retryCount + 1, lastError: errMsg } : q
      );
      saveOfflineQueueToStorage(updated);
      return { synced: false, message: errMsg };
    } catch (err: any) {
      const errMsg = err?.message || 'VSDC unreachable';
      const updated = queue.map((q) =>
        q.id === id ? { ...q, retryCount: q.retryCount + 1, lastError: errMsg } : q
      );
      saveOfflineQueueToStorage(updated);
      return { synced: false, message: errMsg };
    }
  },

  async processOfflineQueue(): Promise<{ processed: number; succeeded: number; remaining: number }> {
    if (isProcessingQueue) {
      const q = loadOfflineQueueFromStorage();
      return { processed: 0, succeeded: 0, remaining: q.length };
    }
    const queue = loadOfflineQueueFromStorage();
    if (queue.length === 0) return { processed: 0, succeeded: 0, remaining: 0 };

    const cfg = getZraConfig();
    if (!cfg.enabled) return { processed: 0, succeeded: 0, remaining: queue.length };

    isProcessingQueue = true;
    let succeeded = 0;
    try {
      for (const item of [...queue]) {
        const res = await this.retryQueueItem(item.id);
        if (res.synced) {
          succeeded++;
        }
      }
    } finally {
      isProcessingQueue = false;
    }

    const remaining = loadOfflineQueueFromStorage().length;
    return { processed: queue.length, succeeded, remaining };
  },

  startAutoSync(): void {
    if (autoSyncStarted || typeof window === 'undefined') return;
    autoSyncStarted = true;

    const trySync = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const cfg = getZraConfig();
      if (!cfg.enabled) return;
      if (loadOfflineQueueFromStorage().length === 0) return;
      this.processOfflineQueue().catch(() => {});
    };

    window.addEventListener('online', () => {
      setTimeout(trySync, 1200);
    });

    setInterval(trySync, 30000);
    setTimeout(trySync, 2500);
  },
};
