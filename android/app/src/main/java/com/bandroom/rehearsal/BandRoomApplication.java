package com.bandroom.rehearsal;

import android.app.Application;
import android.content.pm.ApplicationInfo;
import android.webkit.WebView;

/**
 * 应用级初始化。
 *
 * 关键约束：Application.onCreate 会在每个进程里各跑一次，而本应用有
 * 主进程和 :host 两个进程。WebView 的数据目录同一时刻只能被一个进程持有，
 * 所以在 :host 里绝不能碰 WebView，否则会抛
 * "Using WebView from more than one process at once" 并让主机服务直接崩溃。
 */
public class BandRoomApplication extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        if (isHostProcess()) return;

        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);
    }

    /** 进程名带 ":host" 后缀即为主机服务进程。 */
    private boolean isHostProcess() {
        String processName = currentProcessName();
        return processName != null && processName.endsWith(":host");
    }

    private String currentProcessName() {
        // API 28+ 才有 Application.getProcessName()；低版本回落到读 /proc。
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            return getProcessName();
        }
        try (java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.FileReader("/proc/self/cmdline"))) {
            String line = reader.readLine();
            return line == null ? null : line.trim();
        } catch (Exception ignored) {
            return null;
        }
    }
}
