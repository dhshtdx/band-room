package com.bandroom.rehearsal;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 把 APK assets 里的 nodejs-project 解包到应用私有的版本化运行目录。
 *
 * 运行目录按「版本号 + versionCode」命名，升级 APK 时换新目录、旧目录整体删除，
 * 不会出现半新半旧的混合状态。用户数据放在 BAND_ROOM_DATA_DIR，与本目录分离。
 */
public final class AssetInstaller {

    private static final String ASSET_PROJECT = "nodejs-project";

    private final Context context;

    public AssetInstaller(Context context) {
        this.context = context.getApplicationContext();
    }

    /** 版本化运行目录名，例如 run-1.0.4-10004。 */
    public static String runtimeDirName(String versionName, int versionCode) {
        return "run-" + sanitize(versionName) + "-" + versionCode;
    }

    static String sanitize(String value) {
        if (value == null || value.isEmpty()) return "0";
        return value.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    /**
     * 判断该版本目录是否已经完整解包过。
     *
     * 只看文件存不存在是不够的：同一个 versionCode 下重新打包（开发期反复构建、
     * 或修复资源后重发同版本号）时，旧目录会带着过期内容被复用。
     * 因此额外比对 APK 内 assets 的打包时间戳标记文件。
     */
    public boolean isInstalled(File runtimeDir) {
        if (!new File(runtimeDir, "main.mjs").isFile()
                || !new File(runtimeDir, "server/index.js").isFile()
                || !new File(runtimeDir, "package.json").isFile()) {
            return false;
        }
        long expected = assetStamp();
        if (expected <= 0) return true;
        return new File(runtimeDir, STAMP_FILE).isFile()
                && readStamp(runtimeDir) == expected;
    }

    static final String STAMP_FILE = ".asset-stamp";

    /** 用 APK 自身包的 lastUpdateTime 作为资源版本指纹。 */
    private long assetStamp() {
        try {
            return context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0).lastUpdateTime;
        } catch (Exception error) {
            return 0L;
        }
    }

    private long readStamp(File runtimeDir) {
        try {
            String text = new String(java.nio.file.Files.readAllBytes(
                    new File(runtimeDir, STAMP_FILE).toPath()), java.nio.charset.StandardCharsets.UTF_8).trim();
            return Long.parseLong(text);
        } catch (Exception error) {
            return -1L;
        }
    }

    /** 解包到目标目录。先解到 .staging 再整体改名，避免残缺目录。 */
    public boolean install(File runtimeDir) throws IOException {
        if (isInstalled(runtimeDir)) return false;
        File parent = runtimeDir.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("无法创建运行目录：" + parent);
        }
        File staging = new File(parent, runtimeDir.getName() + ".staging");
        deleteRecursively(staging);
        if (!staging.mkdirs()) throw new IOException("无法创建暂存目录：" + staging);
        copyAssetTree(ASSET_PROJECT, staging);
        // 记录本次解包对应的 APK 指纹，供下次 isInstalled 判断是否过期。
        try {
            java.nio.file.Files.write(new File(staging, STAMP_FILE).toPath(),
                    String.valueOf(assetStamp()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (IOException ignored) {
            // 写不进去只影响复用判定，不影响本次运行。
        }
        deleteRecursively(runtimeDir);
        if (!staging.renameTo(runtimeDir)) throw new IOException("无法启用运行目录：" + runtimeDir);
        return true;
    }

    /** 清理运行根目录下不属于 keep 的历史版本。 */
    public void pruneOldRuntimes(File root, String keep) {
        File[] children = root.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (!child.isDirectory()) continue;
            if (child.getName().equals(keep)) continue;
            if (child.getName().startsWith("run-")) deleteRecursively(child);
        }
    }

    private void copyAssetTree(String assetPath, File target) throws IOException {
        AssetManager assets = context.getAssets();
        String[] children = assets.list(assetPath);
        if (children == null || children.length == 0) {
            copyAssetFile(assetPath, target);
            return;
        }
        if (!target.isDirectory() && !target.mkdirs()) throw new IOException("无法创建目录：" + target);
        for (String child : children) copyAssetTree(assetPath + "/" + child, new File(target, child));
    }

    private void copyAssetFile(String assetPath, File target) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("无法创建目录：" + parent);
        }
        try (InputStream input = context.getAssets().open(assetPath);
             OutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        }
    }

    public static void deleteRecursively(File target) {
        if (target == null || !target.exists()) return;
        File[] children = target.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        target.delete();
    }
}
