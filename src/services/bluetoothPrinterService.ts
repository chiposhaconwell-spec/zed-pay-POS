import { Capacitor, registerPlugin } from '@capacitor/core';

export interface PairedBluetoothPrinter {
  id: string;
  name: string;
  address: string;
  transport: 'ble' | 'classic' | 'dual' | 'unknown';
  source: 'android_bonded' | 'web_bluetooth_paired' | 'web_bluetooth_saved';
  isLikelyPrinter: boolean;
  deviceClassLabel?: string;
  connected?: boolean;
  nativeDevice?: any;
}

export interface BluetoothDiscoveryResult {
  platform: 'android' | 'web';
  supported: boolean;
  enabled: boolean;
  permissionGranted: boolean;
  canEnumerateAllPaired: boolean;
  devices: PairedBluetoothPrinter[];
  notice?: string;
}

interface NativePairedDeviceRaw {
  id?: string;
  address?: string;
  name?: string;
  transport?: 'ble' | 'classic' | 'dual' | 'unknown';
  deviceClassLabel?: string;
  isLikelyPrinter?: boolean;
}

interface BluetoothPrinterPluginInterface {
  getPairedDevices(): Promise<{
    supported: boolean;
    enabled: boolean;
    permissionGranted: boolean;
    devices: NativePairedDeviceRaw[];
    error?: string;
  }>;
  openBluetoothSettings(): Promise<{ opened: boolean }>;
  printEscPos(options: { address: string; dataBase64: string }): Promise<{
    printed: boolean;
    bytesSent: number;
    address: string;
  }>;
}

const BluetoothPrinter = registerPlugin<BluetoothPrinterPluginInterface>('BluetoothPrinter');

const PAIRED_DEVICES_STORAGE_KEY = 'pos_gadget_paired_bluetooth_devices_v1';
const SELECTED_PRINTER_STORAGE_PREFIX = 'pos_selected_hardware_printer_';

export const BLE_PRINTER_OPTIONAL_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', // Standard BLE thermal printer service
  '0000e7e1-0000-1000-8000-00805f9b34fb', // Custom ESC/POS BLE service
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC transparent UART service
  '0000ff00-0000-1000-8000-00805f9b34fb', // Common Chinese 58mm/80mm BLE printer service
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Star / POS BLE printer service
  '0000ae30-0000-1000-8000-00805f9b34fb', // Cat/mini thermal printer service
];

// In-memory cache of live Web BluetoothDevice handles discovered in this session
const liveWebBluetoothDevices = new Map<string, any>();

export function isNativeAndroidPlatform(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export function looksLikeThermalPrinterName(name: string): boolean {
  const n = String(name || '').toLowerCase();
  return (
    n.includes('print') ||
    n.includes('pos') ||
    n.includes('epson') ||
    n.includes('bixolon') ||
    n.includes('star') ||
    n.includes('xprinter') ||
    n.includes('rongta') ||
    n.includes('zpos') ||
    n.includes('mpt') ||
    n.includes('mtp') ||
    n.includes('thermal') ||
    n.includes('58') ||
    n.includes('80') ||
    n.includes('spp') ||
    n.includes('esc') ||
    n.includes('sunmi') ||
    n.includes('gprinter') ||
    n.includes('goojprt') ||
    n.includes('pt-') ||
    n.includes('xp-') ||
    n.includes('rp-')
  );
}

export function formatHardwarePrinterValue(printer: Pick<PairedBluetoothPrinter, 'name' | 'address' | 'id'>): string {
  const cleanName = String(printer.name || 'Bluetooth Device').trim();
  const ident = String(printer.address || printer.id || '').trim();
  if (!ident || cleanName.includes(ident)) {
    return cleanName.slice(0, 200);
  }
  const shortIdent = ident.length > 24 ? `${ident.slice(0, 12)}...` : ident;
  return `${cleanName} (${shortIdent})`.slice(0, 200);
}

function loadSavedWebPairedDevices(): PairedBluetoothPrinter[] {
  try {
    const raw = localStorage.getItem(PAIRED_DEVICES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d: any) => d && (d.id || d.address))
      .map((d: any) => ({
        id: String(d.id || d.address),
        name: String(d.name || 'Paired Bluetooth Device'),
        address: String(d.address || d.id),
        transport: (d.transport === 'classic' || d.transport === 'ble' || d.transport === 'dual' ? d.transport : 'ble') as PairedBluetoothPrinter['transport'],
        source: 'web_bluetooth_saved' as const,
        isLikelyPrinter: Boolean(d.isLikelyPrinter || looksLikeThermalPrinterName(d.name || '')),
        deviceClassLabel: d.deviceClassLabel || 'Bluetooth BLE',
        connected: false,
        nativeDevice: liveWebBluetoothDevices.get(String(d.id || d.address)),
      }));
  } catch {
    return [];
  }
}

function persistWebPairedDevices(devices: PairedBluetoothPrinter[]): void {
  try {
    const serializable = devices.map((d) => ({
      id: d.id,
      name: d.name,
      address: d.address,
      transport: d.transport,
      isLikelyPrinter: d.isLikelyPrinter,
      deviceClassLabel: d.deviceClassLabel,
    }));
    localStorage.setItem(PAIRED_DEVICES_STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // ignore storage quota failures
  }
}

export function saveSelectedPrinterMetadata(businessId: string | undefined, printer: PairedBluetoothPrinter | null): void {
  const key = `${SELECTED_PRINTER_STORAGE_PREFIX}${businessId || 'default'}`;
  try {
    if (!printer) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(
      key,
      JSON.stringify({
        id: printer.id,
        name: printer.name,
        address: printer.address,
        transport: printer.transport,
        optionValue: formatHardwarePrinterValue(printer),
      })
    );
  } catch {}
}

export function getSelectedPrinterMetadata(businessId: string | undefined): {
  id: string;
  name: string;
  address: string;
  transport: string;
  optionValue: string;
} | null {
  const key = `${SELECTED_PRINTER_STORAGE_PREFIX}${businessId || 'default'}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sortPairedDevices(list: PairedBluetoothPrinter[]): PairedBluetoothPrinter[] {
  return [...list].sort((a, b) => {
    if (a.isLikelyPrinter !== b.isLikelyPrinter) return a.isLikelyPrinter ? -1 : 1;
    if (Boolean(a.connected) !== Boolean(b.connected)) return a.connected ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Discovers ALL paired Bluetooth devices available on this gadget.
 * - On native Android: returns every bonded Classic/BLE/Dual Bluetooth device on the gadget via BluetoothAdapter.getBondedDevices().
 * - On Web / PWA: queries navigator.bluetooth.getDevices() for paired devices authorized on this origin and merges saved gadget devices.
 */
export async function listPairedBluetoothDevicesOnGadget(): Promise<BluetoothDiscoveryResult> {
  if (isNativeAndroidPlatform()) {
    try {
      const res = await BluetoothPrinter.getPairedDevices();
      const mapped: PairedBluetoothPrinter[] = (res.devices || []).map((d) => {
        const addr = String(d.address || d.id || '');
        const name = String(d.name || addr || 'Bluetooth Device');
        return {
          id: addr || name,
          address: addr,
          name,
          transport: d.transport || 'classic',
          source: 'android_bonded',
          isLikelyPrinter: Boolean(d.isLikelyPrinter || looksLikeThermalPrinterName(name)),
          deviceClassLabel: d.deviceClassLabel || 'Paired Bluetooth',
          connected: false,
        };
      });

      let notice: string | undefined;
      if (!res.supported) {
        notice = 'Bluetooth adapter was not detected on this Android gadget.';
      } else if (!res.permissionGranted) {
        notice = res.error || 'Grant "Nearby devices" (Bluetooth) permission to list paired Bluetooth devices on this gadget.';
      } else if (!res.enabled) {
        notice = 'Bluetooth is turned off on this gadget. Turn on Bluetooth to list paired devices.';
      } else if (mapped.length === 0) {
        notice = 'No paired Bluetooth devices found on this gadget yet. Pair your printer in Android Bluetooth settings and tap Refresh.';
      }

      return {
        platform: 'android',
        supported: Boolean(res.supported),
        enabled: Boolean(res.enabled),
        permissionGranted: Boolean(res.permissionGranted),
        canEnumerateAllPaired: true,
        devices: sortPairedDevices(mapped),
        notice,
      };
    } catch (err: any) {
      return {
        platform: 'android',
        supported: true,
        enabled: false,
        permissionGranted: false,
        canEnumerateAllPaired: true,
        devices: [],
        notice: err?.message || 'Unable to query Android paired Bluetooth devices.',
      };
    }
  }

  // Web / PWA path
  const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;
  const bt = nav?.bluetooth;
  const savedDevices = loadSavedWebPairedDevices();
  const mergedMap = new Map<string, PairedBluetoothPrinter>();

  for (const d of savedDevices) {
    mergedMap.set(d.id, d);
  }

  let canGetDevices = false;
  let bluetoothSupported = Boolean(bt);
  let notice: string | undefined;

  if (bt && typeof bt.getDevices === 'function') {
    canGetDevices = true;
    try {
      const permittedDevices: any[] = await bt.getDevices();
      for (const dev of permittedDevices) {
        if (!dev?.id) continue;
        liveWebBluetoothDevices.set(dev.id, dev);
        const name = String(dev.name || `BLE Device (${String(dev.id).slice(0, 8)})`);
        mergedMap.set(dev.id, {
          id: String(dev.id),
          address: String(dev.id),
          name,
          transport: 'ble',
          source: 'web_bluetooth_paired',
          isLikelyPrinter: looksLikeThermalPrinterName(name),
          deviceClassLabel: 'Bluetooth LE (Paired)',
          connected: Boolean(dev.gatt?.connected),
          nativeDevice: dev,
        });
      }
      persistWebPairedDevices(Array.from(mergedMap.values()));
    } catch (err: any) {
      notice = err?.message || 'Browser blocked reading paired Bluetooth devices in this frame.';
    }
  }

  const devices = sortPairedDevices(Array.from(mergedMap.values()));

  if (!bluetoothSupported) {
    notice =
      'This browser/iframe restricts Web Bluetooth access. Open the app directly in Chrome/Edge (HTTPS) or install the Android APK to list every paired Bluetooth device on your gadget.';
  } else if (devices.length === 0) {
    notice = canGetDevices
      ? 'Browsers hide OS-paired Bluetooth devices until authorized once. Click "Show / Pair Gadget Bluetooth" below to view and select paired Bluetooth devices on your gadget.'
      : 'Click "Show / Pair Gadget Bluetooth" below to select a paired Bluetooth printer from your gadget.';
  }

  return {
    platform: 'web',
    supported: bluetoothSupported,
    enabled: bluetoothSupported,
    permissionGranted: true,
    canEnumerateAllPaired: canGetDevices,
    devices,
    notice,
  };
}

/**
 * Opens the gadget's Bluetooth device selector / OS Bluetooth pairing flow.
 * - On Web: opens navigator.bluetooth.requestDevice({ acceptAllDevices: true }) so all Bluetooth devices on the gadget appear.
 * - On Android: refreshes bonded devices (prompting runtime permission if needed) or opens Android Bluetooth Settings.
 */
export async function pairOrPickBluetoothDeviceOnGadget(options?: {
  openNativeSettings?: boolean;
}): Promise<{ printer: PairedBluetoothPrinter | null; discovery?: BluetoothDiscoveryResult; error?: string }> {
  if (isNativeAndroidPlatform()) {
    if (options?.openNativeSettings) {
      try {
        await BluetoothPrinter.openBluetoothSettings();
      } catch (err: any) {
        return { printer: null, error: err?.message || 'Unable to open Android Bluetooth settings.' };
      }
    }
    const discovery = await listPairedBluetoothDevicesOnGadget();
    return {
      printer: discovery.devices[0] || null,
      discovery,
      error: discovery.permissionGranted ? undefined : discovery.notice,
    };
  }

  const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;
  if (!nav?.bluetooth || typeof nav.bluetooth.requestDevice !== 'function') {
    return {
      printer: null,
      error:
        'Web Bluetooth is unavailable in this browser or embedded frame. Open the app in a standalone Chrome/Edge window (HTTPS) or use the Android APK.',
    };
  }

  try {
    const device = await nav.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: BLE_PRINTER_OPTIONAL_SERVICES,
    });

    if (!device) {
      return { printer: null, error: 'No Bluetooth device selected.' };
    }

    liveWebBluetoothDevices.set(device.id, device);
    const name = String(device.name || `Bluetooth Device (${String(device.id).slice(0, 8)})`);
    const entry: PairedBluetoothPrinter = {
      id: String(device.id),
      address: String(device.id),
      name,
      transport: 'ble',
      source: 'web_bluetooth_paired',
      isLikelyPrinter: looksLikeThermalPrinterName(name),
      deviceClassLabel: 'Bluetooth LE (Paired)',
      connected: Boolean(device.gatt?.connected),
      nativeDevice: device,
    };

    const existing = loadSavedWebPairedDevices().filter((d) => d.id !== entry.id);
    persistWebPairedDevices([entry, ...existing]);

    const discovery = await listPairedBluetoothDevicesOnGadget();
    return { printer: entry, discovery };
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    if (msg.toLowerCase().includes('cancelled') || msg.toLowerCase().includes('canceled')) {
      return { printer: null };
    }
    return { printer: null, error: msg || 'Bluetooth device pairing failed.' };
  }
}

export async function openGadgetBluetoothSettings(): Promise<void> {
  if (isNativeAndroidPlatform()) {
    await BluetoothPrinter.openBluetoothSettings();
  }
}

export function removeSavedWebBluetoothDevice(id: string): void {
  const existing = loadSavedWebPairedDevices().filter((d) => d.id !== id);
  persistWebPairedDevices(existing);
  liveWebBluetoothDevices.delete(id);
}

/**
 * Connects to a Web Bluetooth BLE printer GATT server and locates a writable ESC/POS characteristic.
 */
export async function connectWebBluetoothGattPrinter(
  printerOrDevice: PairedBluetoothPrinter | any
): Promise<{ device: any; writeChar: any }> {
  let device = printerOrDevice?.gatt ? printerOrDevice : printerOrDevice?.nativeDevice;

  if (!device && printerOrDevice?.id) {
    device = liveWebBluetoothDevices.get(printerOrDevice.id);
  }

  if (!device && typeof navigator !== 'undefined' && (navigator as any).bluetooth?.getDevices) {
    const list: any[] = await (navigator as any).bluetooth.getDevices();
    device = list.find(
      (d) =>
        d.id === printerOrDevice?.id ||
        d.id === printerOrDevice?.address ||
        (printerOrDevice?.name && d.name === printerOrDevice.name)
    );
  }

  if (!device) {
    throw new Error(
      'No active Bluetooth handle for this printer in the current browser tab. Click "Show / Pair Gadget Bluetooth" to reconnect it.'
    );
  }

  liveWebBluetoothDevices.set(device.id, device);
  const server = device.gatt?.connected ? device.gatt : await device.gatt?.connect();
  if (!server) {
    throw new Error('GATT server connection handshake failed.');
  }

  const services = await server.getPrimaryServices();
  let foundCharacteristics: any[] = [];
  for (const service of services) {
    try {
      const chars = await service.getCharacteristics();
      foundCharacteristics = [...foundCharacteristics, ...chars];
    } catch {
      // ignore inaccessible services
    }
  }

  const writeChar = foundCharacteristics.find(
    (c) => c.properties?.write || c.properties?.writeWithoutResponse
  );
  if (!writeChar) {
    throw new Error('Connected to Bluetooth device, but no writable ESC/POS print characteristic was exposed.');
  }

  return { device, writeChar };
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Sends raw ESC/POS bytes to a paired hardware Bluetooth printer on Android native or Web Bluetooth.
 */
export async function sendEscPosToHardwarePrinter(params: {
  printer?: PairedBluetoothPrinter | null;
  addressOrId?: string;
  writeChar?: any;
  bytes: Uint8Array;
}): Promise<{ dispatched: boolean; method: 'android_rfcomm' | 'web_ble' | 'none'; error?: string }> {
  const { printer, addressOrId, writeChar, bytes } = params;
  const targetAddr = printer?.address || addressOrId || '';

  if (isNativeAndroidPlatform()) {
    if (!targetAddr) {
      return { dispatched: false, method: 'none', error: 'No paired Android Bluetooth device address selected.' };
    }
    try {
      await BluetoothPrinter.printEscPos({
        address: targetAddr,
        dataBase64: uint8ArrayToBase64(bytes),
      });
      return { dispatched: true, method: 'android_rfcomm' };
    } catch (err: any) {
      return {
        dispatched: false,
        method: 'android_rfcomm',
        error: err?.message || 'Failed sending ESC/POS stream over Android Bluetooth.',
      };
    }
  }

  try {
    let charToUse = writeChar;
    if (!charToUse && (printer || addressOrId)) {
      const target: any = printer || { id: addressOrId, address: addressOrId };
      const conn = await connectWebBluetoothGattPrinter(target);
      charToUse = conn.writeChar;
    }
    if (!charToUse) {
      return { dispatched: false, method: 'none', error: 'No active Web Bluetooth write characteristic.' };
    }
    const chunkSize = 20;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.slice(i, i + chunkSize);
      if (typeof charToUse.writeValueWithoutResponse === 'function' && charToUse.properties?.writeWithoutResponse) {
        await charToUse.writeValueWithoutResponse(chunk);
      } else {
        await charToUse.writeValue(chunk);
      }
    }
    return { dispatched: true, method: 'web_ble' };
  } catch (err: any) {
    return {
      dispatched: false,
      method: 'web_ble',
      error: err?.message || 'Web Bluetooth print transfer failed.',
    };
  }
}
