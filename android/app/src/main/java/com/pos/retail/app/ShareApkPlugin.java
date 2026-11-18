package com.pos.retail.app;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;

@CapacitorPlugin(name = "ShareApk")
public class ShareApkPlugin extends Plugin {

    @PluginMethod
    public void getApkInfo(PluginCall call) {
        try {
            Context context = getContext();
            ApplicationInfo appInfo = context.getApplicationInfo();
            String sourcePath = appInfo.publicSourceDir != null ? appInfo.publicSourceDir : appInfo.sourceDir;
            File sourceFile = new File(sourcePath);

            JSObject ret = new JSObject();
            ret.put("available", sourceFile.exists());
            ret.put("sizeBytes", sourceFile.exists() ? sourceFile.length() : 0);
            ret.put("packageName", context.getPackageName());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Unable to inspect installed APK: " + e.getMessage());
        }
    }

    @PluginMethod
    public void shareInstalledApk(PluginCall call) {
        String target = call.getString("target", "chooser");
        String fileName = call.getString("fileName", "RetailPOS.apk");
        String message = call.getString("message", "Install this POS App APK");
        String title = call.getString("title", "Share POS App APK");

        if (fileName == null || fileName.trim().isEmpty()) {
            fileName = "RetailPOS.apk";
        }
        String safeName = fileName.replaceAll("[^a-zA-Z0-9._-]", "_");
        if (!safeName.toLowerCase().endsWith(".apk")) {
            safeName = safeName + ".apk";
        }

        try {
            Context context = getContext();
            ApplicationInfo appInfo = context.getApplicationInfo();
            String sourcePath = appInfo.publicSourceDir != null ? appInfo.publicSourceDir : appInfo.sourceDir;
            File sourceApk = new File(sourcePath);
            if (!sourceApk.exists()) {
                call.reject("Installed APK binary was not found on this device.");
                return;
            }

            File sharedDir = new File(context.getCacheDir(), "shared_apk");
            if (!sharedDir.exists()) {
                sharedDir.mkdirs();
            }
            File destApk = new File(sharedDir, safeName);

            try (InputStream in = new FileInputStream(sourceApk);
                 OutputStream out = new FileOutputStream(destApk)) {
                byte[] buffer = new byte[65536];
                int len;
                while ((len = in.read(buffer)) > 0) {
                    out.write(buffer, 0, len);
                }
            }

            Uri apkUri = FileProvider.getUriForFile(
                context,
                context.getPackageName() + ".fileprovider",
                destApk
            );

            Intent baseIntent = new Intent(Intent.ACTION_SEND);
            baseIntent.setType("application/vnd.android.package-archive");
            baseIntent.putExtra(Intent.EXTRA_STREAM, apkUri);
            baseIntent.putExtra(Intent.EXTRA_SUBJECT, title);
            baseIntent.putExtra(Intent.EXTRA_TEXT, message);
            baseIntent.setClipData(ClipData.newRawUri(safeName, apkUri));
            baseIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            PackageManager pm = context.getPackageManager();
            String resolvedTarget = null;

            if ("whatsapp".equalsIgnoreCase(target)) {
                String[] waPackages = new String[] { "com.whatsapp", "com.whatsapp.w4b" };
                for (String pkg : waPackages) {
                    Intent targeted = new Intent(baseIntent);
                    targeted.setPackage(pkg);
                    if (targeted.resolveActivity(pm) != null) {
                        context.grantUriPermission(pkg, apkUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        targeted.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        getActivity().startActivity(targeted);
                        resolvedTarget = pkg;
                        break;
                    }
                }
            } else if ("bluetooth".equalsIgnoreCase(target)) {
                String[] btPackages = new String[] {
                    "com.android.bluetooth",
                    "com.google.android.bluetooth",
                    "com.mediatek.bluetooth"
                };
                for (String pkg : btPackages) {
                    Intent targeted = new Intent(baseIntent);
                    targeted.setPackage(pkg);
                    if (targeted.resolveActivity(pm) != null) {
                        context.grantUriPermission(pkg, apkUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        targeted.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        getActivity().startActivity(targeted);
                        resolvedTarget = pkg;
                        break;
                    }
                }
            } else if ("quickshare".equalsIgnoreCase(target)) {
                List<ResolveInfo> candidates = pm.queryIntentActivities(baseIntent, PackageManager.MATCH_DEFAULT_ONLY);
                for (ResolveInfo info : candidates) {
                    String pkg = info.activityInfo.packageName;
                    String cls = info.activityInfo.name != null ? info.activityInfo.name.toLowerCase() : "";
                    String label = info.loadLabel(pm) != null ? info.loadLabel(pm).toString().toLowerCase() : "";
                    if (cls.contains("nearby") || cls.contains("quickshare") || label.contains("quick share") || label.contains("nearby share")) {
                        Intent targeted = new Intent(baseIntent);
                        targeted.setClassName(pkg, info.activityInfo.name);
                        context.grantUriPermission(pkg, apkUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        targeted.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        getActivity().startActivity(targeted);
                        resolvedTarget = pkg;
                        break;
                    }
                }
            }

            if (resolvedTarget == null) {
                List<ResolveInfo> resInfoList = pm.queryIntentActivities(baseIntent, PackageManager.MATCH_DEFAULT_ONLY);
                for (ResolveInfo resolveInfo : resInfoList) {
                    String pkg = resolveInfo.activityInfo.packageName;
                    context.grantUriPermission(pkg, apkUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                }
                Intent chooser = Intent.createChooser(baseIntent, title);
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().startActivity(chooser);
                resolvedTarget = "chooser";
            }

            JSObject res = new JSObject();
            res.put("shared", true);
            res.put("target", resolvedTarget);
            res.put("fileName", safeName);
            res.put("sizeBytes", destApk.length());
            call.resolve(res);
        } catch (Exception e) {
            call.reject("Failed to share APK: " + e.getMessage());
        }
    }
}
