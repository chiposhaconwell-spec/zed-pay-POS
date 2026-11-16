export type ZraTaxTypeCode =
  | 'A'
  | 'B'
  | 'C1'
  | 'C2'
  | 'C3'
  | 'D'
  | 'E'
  | 'F'
  | 'IPL1'
  | 'IPL2'
  | 'TL'
  | 'ECM'
  | 'EXEEG'
  | 'TOT'
  | 'RVAT';

export interface ZraTaxTypeMeta {
  code: ZraTaxTypeCode;
  name: string;
  rate: number;
  category: 'VAT' | 'SERVICE' | 'IPL' | 'TL' | 'EXCISE' | 'TOT';
}

export const ZRA_TAX_TYPES: ZraTaxTypeMeta[] = [
  { code: 'A', name: 'A - Standard Rated VAT (16%)', rate: 16, category: 'VAT' },
  { code: 'B', name: 'B - Minimum Taxable Value / MTV (16%)', rate: 16, category: 'VAT' },
  { code: 'C1', name: 'C1 - Exports (0%)', rate: 0, category: 'VAT' },
  { code: 'C2', name: 'C2 - Zero-rated LPO / Diplomats (0%)', rate: 0, category: 'VAT' },
  { code: 'C3', name: 'C3 - Zero-rated by Nature (0%)', rate: 0, category: 'VAT' },
  { code: 'D', name: 'D - Exempt (0%)', rate: 0, category: 'VAT' },
  { code: 'E', name: 'E - Disbursement (0%)', rate: 0, category: 'VAT' },
  { code: 'RVAT', name: 'RVAT - Reverse VAT (16%)', rate: 16, category: 'VAT' },
  { code: 'F', name: 'F - Service Charge (10%)', rate: 10, category: 'SERVICE' },
  { code: 'TL', name: 'TL - Tourism Levy (1.5%)', rate: 1.5, category: 'TL' },
  { code: 'IPL1', name: 'IPL1 - Insurance Premium Levy (5%)', rate: 5, category: 'IPL' },
  { code: 'IPL2', name: 'IPL2 - Re-Insurance (0%)', rate: 0, category: 'IPL' },
  { code: 'ECM', name: 'ECM - Excise on Coal (5%)', rate: 5, category: 'EXCISE' },
  { code: 'EXEEG', name: 'EXEEG - Excise on Electricity (3%)', rate: 3, category: 'EXCISE' },
  { code: 'TOT', name: 'TOT - Turnover Tax (0%)', rate: 0, category: 'TOT' },
];

export const ZRA_PACKAGING_UNITS = [
  { code: 'BA', name: 'BA - Barrel / Bale' },
  { code: 'BG', name: 'BG - Bag' },
  { code: 'BX', name: 'BX - Box' },
  { code: 'CT', name: 'CT - Carton' },
  { code: 'NT', name: 'NT - Net / Loose' },
  { code: 'PA', name: 'PA - Packet' },
  { code: 'PU', name: 'PU - Each / Unit' },
  { code: 'OT', name: 'OT - Other' },
];

export const ZRA_QTY_UNITS = [
  { code: 'U', name: 'U - Unit / Piece' },
  { code: 'EA', name: 'EA - Each' },
  { code: 'NO', name: 'NO - Number' },
  { code: 'KG', name: 'KG - Kilogram' },
  { code: 'L', name: 'L - Litre' },
  { code: 'M', name: 'M - Metre' },
  { code: 'SET', name: 'SET - Set' },
];

export const ZRA_PAYMENT_METHODS: Record<string, { code: string; label: string }> = {
  CASH: { code: '01', label: 'CASH' },
  CREDIT: { code: '02', label: 'CREDIT' },
  CASH_CREDIT: { code: '03', label: 'CASH/CREDIT' },
  BANK_CHECK: { code: '04', label: 'BANK CHECK' },
  CARD: { code: '05', label: 'DEBIT&CREDIT CARD' },
  MOBILE_MONEY: { code: '06', label: 'MOBILE MONEY' },
  OTHER: { code: '07', label: 'OTHER' },
  BANK_TRANSFER: { code: '08', label: 'BANK TRANSFER' },
};

export interface ZraConfig {
  enabled: boolean;
  tpin: string;
  bhfId: string;
  vsdcApiUrl: string;
  dvcSrlNo: string;
  cisCode: string;
  defaultItemClsCd: string;
  defaultTaxTyCd: ZraTaxTypeCode;
  defaultPkgUnitCd: string;
  defaultQtyUnitCd: string;
  useServerProxy: boolean;
  sdcId?: string;
  mrcNo?: string;
  lastSaleInvcNo?: number;
  lastInitializedAt?: string;
  taxprNm?: string;
  bhfNm?: string;
  updatedAt?: string;
}

export const ZRA_CONFIG_STORAGE_KEY = 'pos_zra_config';

export const DEFAULT_ZRA_CONFIG: ZraConfig = {
  enabled: false,
  tpin: '',
  bhfId: '000',
  vsdcApiUrl: 'http://localhost:8080/zrasandboxvsdc',
  dvcSrlNo: 'POS-VSDC-001',
  cisCode: 'CIS-POS-01',
  defaultItemClsCd: '50102518',
  defaultTaxTyCd: 'A',
  defaultPkgUnitCd: 'BA',
  defaultQtyUnitCd: 'U',
  useServerProxy: true,
  sdcId: '',
  mrcNo: '',
  lastSaleInvcNo: 0,
};

function sanitizeZraConfig(raw: Partial<ZraConfig> | null | undefined): ZraConfig {
  const base = { ...DEFAULT_ZRA_CONFIG };
  if (!raw || typeof raw !== 'object') return base;
  const taxCodeSet = new Set(ZRA_TAX_TYPES.map((t) => t.code));
  const cleanedTax = typeof raw.defaultTaxTyCd === 'string' && taxCodeSet.has(raw.defaultTaxTyCd as ZraTaxTypeCode)
    ? (raw.defaultTaxTyCd as ZraTaxTypeCode)
    : base.defaultTaxTyCd;
  return {
    enabled: Boolean(raw.enabled),
    tpin: String(raw.tpin ?? '').trim(),
    bhfId: String(raw.bhfId ?? '000').trim() || '000',
    vsdcApiUrl: String(raw.vsdcApiUrl ?? base.vsdcApiUrl).trim().replace(/\/+$/, '') || base.vsdcApiUrl,
    dvcSrlNo: String(raw.dvcSrlNo ?? base.dvcSrlNo).trim() || base.dvcSrlNo,
    cisCode: String(raw.cisCode ?? base.cisCode).trim() || base.cisCode,
    defaultItemClsCd: String(raw.defaultItemClsCd ?? base.defaultItemClsCd).trim() || base.defaultItemClsCd,
    defaultTaxTyCd: cleanedTax,
    defaultPkgUnitCd: String(raw.defaultPkgUnitCd ?? base.defaultPkgUnitCd).trim() || base.defaultPkgUnitCd,
    defaultQtyUnitCd: String(raw.defaultQtyUnitCd ?? base.defaultQtyUnitCd).trim() || base.defaultQtyUnitCd,
    useServerProxy: raw.useServerProxy !== undefined ? Boolean(raw.useServerProxy) : true,
    sdcId: raw.sdcId ? String(raw.sdcId).trim() : '',
    mrcNo: raw.mrcNo ? String(raw.mrcNo).trim() : '',
    lastSaleInvcNo: Number.isFinite(Number(raw.lastSaleInvcNo)) ? Math.max(0, Number(raw.lastSaleInvcNo)) : 0,
    lastInitializedAt: raw.lastInitializedAt ? String(raw.lastInitializedAt) : undefined,
    taxprNm: raw.taxprNm ? String(raw.taxprNm) : undefined,
    bhfNm: raw.bhfNm ? String(raw.bhfNm) : undefined,
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : undefined,
  };
}

export function getZraConfig(): ZraConfig {
  try {
    const raw = localStorage.getItem(ZRA_CONFIG_STORAGE_KEY);
    if (raw) {
      return sanitizeZraConfig(JSON.parse(raw));
    }
    const settingsRaw = localStorage.getItem('android_pos_settings');
    if (settingsRaw) {
      const parsedSettings = JSON.parse(settingsRaw);
      if (parsedSettings?.zraConfig) {
        return sanitizeZraConfig(parsedSettings.zraConfig);
      }
      if (parsedSettings?.tpin) {
        return sanitizeZraConfig({ tpin: parsedSettings.tpin });
      }
    }
  } catch {
    // fallback to defaults
  }
  return { ...DEFAULT_ZRA_CONFIG };
}

export function saveZraConfig(partial: Partial<ZraConfig>): ZraConfig {
  const current = getZraConfig();
  const next = sanitizeZraConfig({
    ...current,
    ...partial,
    updatedAt: new Date().toISOString(),
  });

  try {
    localStorage.setItem(ZRA_CONFIG_STORAGE_KEY, JSON.stringify(next));
    const settingsRaw = localStorage.getItem('android_pos_settings');
    if (settingsRaw) {
      const parsedSettings = JSON.parse(settingsRaw);
      if (parsedSettings && typeof parsedSettings === 'object') {
        parsedSettings.zraConfig = next;
        if (next.tpin && !parsedSettings.tpin) {
          parsedSettings.tpin = next.tpin;
        }
        localStorage.setItem('android_pos_settings', JSON.stringify(parsedSettings));
      }
    }
  } catch {
    // ignore storage quota errors
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('zra_config_updated', { detail: next }));
  }
  return next;
}

export function nextZraInvoiceNo(): number {
  const current = getZraConfig();
  const nextNo = (current.lastSaleInvcNo || 0) + 1;
  saveZraConfig({ lastSaleInvcNo: nextNo });
  return nextNo;
}

export function subscribeZraConfig(listener: (cfg: ZraConfig) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (ev: Event) => {
    const custom = ev as CustomEvent<ZraConfig>;
    listener(custom?.detail || getZraConfig());
  };
  const storageHandler = (ev: StorageEvent) => {
    if (ev.key === ZRA_CONFIG_STORAGE_KEY || ev.key === 'android_pos_settings') {
      listener(getZraConfig());
    }
  };
  window.addEventListener('zra_config_updated', handler);
  window.addEventListener('storage', storageHandler);
  return () => {
    window.removeEventListener('zra_config_updated', handler);
    window.removeEventListener('storage', storageHandler);
  };
}

export function getZraTaxMeta(code?: string): ZraTaxTypeMeta {
  const upper = String(code || 'A').trim().toUpperCase();
  const match = ZRA_TAX_TYPES.find((t) => t.code === upper);
  return match || ZRA_TAX_TYPES[0];
}
