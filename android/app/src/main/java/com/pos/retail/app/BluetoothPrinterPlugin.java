package com.pos.retail.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.OutputStream;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

@CapacitorPlugin(
    name = "BluetoothPrinter",
    permissions = {
        @Permission(
            alias = "bluetoothConnect",
            strings = { Manifest.permission.BLUETOOTH_CONNECT }
        ),
        @Permission(
            alias = "bluetoothScan",
            strings = { Manifest.permission.BLUETOOTH_SCAN }
        )
    }
)
public class BluetoothPrinterPlugin extends Plugin {

    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private BluetoothAdapter getAdapter() {
        Context context = getContext();
        if (context == null) return null;
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        if (manager != null && manager.getAdapter() != null) {
            return manager.getAdapter();
        }
        return BluetoothAdapter.getDefaultAdapter();
    }

    private boolean needsBluetoothConnectPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && getPermissionState("bluetoothConnect") != PermissionState.GRANTED;
    }

    @PluginMethod
    public void getPairedDevices(PluginCall call) {
        BluetoothAdapter adapter = getAdapter();
        if (adapter == null) {
            JSObject ret = new JSObject();
            ret.put("supported", false);
            ret.put("enabled", false);
            ret.put("permissionGranted", true);
            ret.put("devices", new JSArray());
            call.resolve(ret);
            return;
        }

        if (needsBluetoothConnectPermission()) {
            requestPermissionForAlias("bluetoothConnect", call, "pairedDevicesPermissionCallback");
            return;
        }

        resolvePairedDevices(call, adapter);
    }

    @PermissionCallback
    private void pairedDevicesPermissionCallback(PluginCall call) {
        if (needsBluetoothConnectPermission()) {
            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("enabled", false);
            ret.put("permissionGranted", false);
            ret.put("devices", new JSArray());
            ret.put("error", "Bluetooth permission (Nearby devices) was denied on this gadget.");
            call.resolve(ret);
            return;
        }
        BluetoothAdapter adapter = getAdapter();
        if (adapter == null) {
            JSObject ret = new JSObject();
            ret.put("supported", false);
            ret.put("enabled", false);
            ret.put("permissionGranted", true);
            ret.put("devices", new JSArray());
            call.resolve(ret);
            return;
        }
        resolvePairedDevices(call, adapter);
    }

    @SuppressLint("MissingPermission")
    private void resolvePairedDevices(PluginCall call, BluetoothAdapter adapter) {
        try {
            boolean enabled = adapter.isEnabled();
            JSArray devicesArr = new JSArray();

            if (enabled) {
                Set<BluetoothDevice> bondedDevices = adapter.getBondedDevices();
                if (bondedDevices != null) {
                    for (BluetoothDevice device : bondedDevices) {
                        JSObject item = new JSObject();
                        String address = device.getAddress() != null ? device.getAddress() : "";
                        String rawName = device.getName();
                        String name = (rawName != null && !rawName.trim().isEmpty()) ? rawName.trim() : ("Bluetooth Device (" + address + ")");

                        int devType = device.getType();
                        String transport = "unknown";
                        if (devType == BluetoothDevice.DEVICE_TYPE_CLASSIC) transport = "classic";
                        else if (devType == BluetoothDevice.DEVICE_TYPE_LE) transport = "ble";
                        else if (devType == BluetoothDevice.DEVICE_TYPE_DUAL) transport = "dual";

                        BluetoothClass btClass = device.getBluetoothClass();
                        int majorClass = btClass != null ? btClass.getMajorDeviceClass() : -1;
                        String classLabel = describeMajorClass(majorClass);
                        boolean isImaging = majorClass == BluetoothClass.Device.Major.IMAGING;
                        boolean nameLooksLikePrinter = looksLikePrinterName(name);

                        item.put("id", address);
                        item.put("address", address);
                        item.put("name", name);
                        item.put("transport", transport);
                        item.put("deviceClassLabel", classLabel);
                        item.put("isLikelyPrinter", isImaging || nameLooksLikePrinter);
                        devicesArr.put(item);
                    }
                }
            }

            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("enabled", enabled);
            ret.put("permissionGranted", true);
            ret.put("devices", devicesArr);
            call.resolve(ret);
        } catch (SecurityException se) {
            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("enabled", false);
            ret.put("permissionGranted", false);
            ret.put("devices", new JSArray());
            ret.put("error", "Bluetooth permission required: " + se.getMessage());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to read paired Bluetooth devices: " + e.getMessage());
        }
    }

    @PluginMethod
    public void openBluetoothSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_BLUETOOTH_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("opened", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Unable to open Bluetooth settings: " + e.getMessage());
        }
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void printEscPos(PluginCall call) {
        String address = call.getString("address", "");
        String dataBase64 = call.getString("dataBase64", "");

        if (address == null || address.trim().isEmpty()) {
            call.reject("Bluetooth printer MAC address is required.");
            return;
        }
        if (dataBase64 == null || dataBase64.isEmpty()) {
            call.reject("No ESC/POS print payload provided.");
            return;
        }
        if (needsBluetoothConnectPermission()) {
            call.reject("Bluetooth Connect permission not granted. Please refresh paired Bluetooth devices first.");
            return;
        }

        BluetoothAdapter adapter = getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth is disabled or unavailable on this gadget.");
            return;
        }

        final byte[] payload;
        try {
            payload = Base64.decode(dataBase64, Base64.DEFAULT);
        } catch (Exception e) {
            call.reject("Invalid ESC/POS payload encoding.");
            return;
        }

        final String targetAddress = address.trim();
        new Thread(() -> {
            BluetoothSocket socket = null;
            try {
                BluetoothDevice device = adapter.getRemoteDevice(targetAddress);
                try {
                    adapter.cancelDiscovery();
                } catch (Exception ignored) {}

                socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
                socket.connect();

                OutputStream out = socket.getOutputStream();
                out.write(payload);
                out.flush();
                Thread.sleep(150);

                JSObject res = new JSObject();
                res.put("printed", true);
                res.put("bytesSent", payload.length);
                res.put("address", targetAddress);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Bluetooth RFCOMM print failed for " + targetAddress + ": " + e.getMessage());
            } finally {
                if (socket != null) {
                    try {
                        socket.close();
                    } catch (Exception ignored) {}
                }
            }
        }).start();
    }

    private String describeMajorClass(int majorClass) {
        switch (majorClass) {
            case BluetoothClass.Device.Major.IMAGING:
                return "Printer / Imaging";
            case BluetoothClass.Device.Major.PERIPHERAL:
                return "Peripheral";
            case BluetoothClass.Device.Major.COMPUTER:
                return "Computer";
            case BluetoothClass.Device.Major.PHONE:
                return "Phone";
            case BluetoothClass.Device.Major.AUDIO_VIDEO:
                return "Audio / Video";
            case BluetoothClass.Device.Major.UNCATEGORIZED:
                return "Bluetooth Device";
            default:
                return "Paired Bluetooth";
        }
    }

    private boolean looksLikePrinterName(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        return n.contains("print") || n.contains("pos") || n.contains("epson")
            || n.contains("bixolon") || n.contains("star") || n.contains("xprinter")
            || n.contains("rongta") || n.contains("zpos") || n.contains("mpt")
            || n.contains("mtp") || n.contains("thermal") || n.contains("58")
            || n.contains("80") || n.contains("spp") || n.contains("esc")
            || n.contains("sunmi") || n.contains("gprinter") || n.contains("goojprt");
    }
}
