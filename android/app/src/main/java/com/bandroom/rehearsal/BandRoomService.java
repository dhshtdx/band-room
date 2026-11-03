package com.bandroom.rehearsal;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 主机前台服务，跑在独立的 :host 进程里。
 *
 * 生命周期要点（顺序不能变）：
 * 1. onStartCommand 立刻进入前台并显示通知——Android 8 对 startForeground 有时限，
 *    必须先发通知再做任何解包或 Node 初始化。
 * 2. 后台线程复制 assets 到版本化运行目录。
 * 3. 通过 JNI 拉起 Node 线程。
 * 4. Activity 轮询 /api/health 判断就绪。
 * 5. 通知「停止主机」打内部令牌端点，等 Node 线程退出后结束本进程。
 */
public class BandRoomService extends Service {

    private static final String TAG = "BandRoomService";

    private final ServerState state = new ServerState();
    private volatile Thread bootstrapThread;
    private String shutdownToken = "";

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(ServiceConfig.NOTIFICATION_ID, buildNotification("正在启动"),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(ServiceConfig.NOTIFICATION_ID, buildNotification("正在启动"));
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ServiceConfig.ACTION_STOP.equals(action)) {
            requestShutdown();
            return START_NOT_STICKY;
        }
        startHost();
        // 被系统回收后不自动重启：宿主需要用户显式打开应用，
        // 否则会在没有 Activity 的情况下反复拉起 Node。
        return START_NOT_STICKY;
    }

    private void startHost() {
        if (!state.beginStart()) {
            Log.i(TAG, "主机已在启动或运行中，忽略重复启动请求");
            return;
        }
        updateNotification("正在启动");
        shutdownToken = ServiceConfig.newShutdownToken();
        bootstrapThread = new Thread(this::bootstrap, "band-room-bootstrap");
        bootstrapThread.start();
    }

    private void bootstrap() {
        try {
            NodeRunner.ensureLoaded();

            File dataRoot = getApplicationContext().getFilesDir();
            File runtimesRoot = new File(dataRoot, "runtime");
            if (!runtimesRoot.isDirectory() && !runtimesRoot.mkdirs()) {
                throw new IllegalStateException("无法创建运行根目录");
            }

            String versionName = BuildConfigCompat.versionName(this);
            int versionCode = BuildConfigCompat.versionCode(this);
            String dirName = AssetInstaller.runtimeDirName(versionName, versionCode);
            File runtimeDir = new File(runtimesRoot, dirName);

            AssetInstaller installer = new AssetInstaller(this);
            boolean copied = installer.install(runtimeDir);
            installer.pruneOldRuntimes(runtimesRoot, dirName);
            Log.i(TAG, copied ? "已解包 Node 资源到 " + runtimeDir : "复用已有 Node 资源 " + runtimeDir);

            File mediaDir = new File(dataRoot, "media");
            if (!mediaDir.isDirectory() && !mediaDir.mkdirs()) {
                throw new IllegalStateException("无法创建媒体目录");
            }

            // Node 侧读取的环境变量：入口固定放在运行目录根部。
            setEnv("PORT", String.valueOf(ServiceConfig.PORT));
            setEnv("BAND_ROOM_DATA_DIR", mediaDir.getAbsolutePath());
            setEnv("BAND_ROOM_SHUTDOWN_TOKEN", shutdownToken);
            setEnv("BAND_ROOM_ANDROID", "1");
            setEnv("NODE_ENV", "production");

            File entry = new File(runtimeDir, "main.mjs");
            if (!entry.isFile()) throw new IllegalStateException("缺少 Node 入口 main.mjs");

            boolean started = NodeRunner.startNode(entry.getAbsolutePath(), runtimeDir.getAbsolutePath());
            if (!started) throw new IllegalStateException("Node 线程创建失败");

            if (waitForHealth()) {
                state.markRunning();
                updateNotification("主机运行中");
                Log.i(TAG, "主机已就绪：http://127.0.0.1:" + ServiceConfig.PORT + "/host");
            } else {
                state.markFailed();
                updateNotification("启动超时");
                Log.e(TAG, "主机健康检查超时");
            }
        } catch (Throwable error) {
            state.markFailed();
            updateNotification("启动失败");
            Log.e(TAG, "主机启动失败", error);
        }
    }

    /** 轮询健康检查，最多等 60 秒。 */
    private boolean waitForHealth() {
        for (int attempt = 0; attempt < 120; attempt++) {
            if (probeHealth()) return true;
            try {
                Thread.sleep(500);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return false;
    }

    private boolean probeHealth() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(ServiceConfig.healthUrl()).openConnection();
            connection.setConnectTimeout(1000);
            connection.setReadTimeout(1000);
            connection.setRequestMethod("GET");
            return connection.getResponseCode() == 200;
        } catch (Exception ignored) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** 打内部停机端点，然后结束 :host 进程。 */
    private void requestShutdown() {
        updateNotification("正在停止");
        Thread worker = new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(ServiceConfig.shutdownUrl()).openConnection();
                connection.setConnectTimeout(2000);
                connection.setReadTimeout(5000);
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Authorization", "Bearer " + shutdownToken);
                connection.getResponseCode();
            } catch (Exception error) {
                Log.w(TAG, "停机请求失败，仍结束进程", error);
            } finally {
                if (connection != null) connection.disconnect();
                state.markStopped();
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
                // Node 线程是 detached 且阻塞在事件循环里；
                // 结束 :host 进程是唯一可靠的收尾方式，下一次启动会换新的运行实例。
                System.exit(0);
            }
        }, "band-room-shutdown");
        worker.start();
    }

    private void setEnv(String key, String value) {
        try {
            android.system.Os.setenv(key, value, true);
        } catch (Exception error) {
            Log.w(TAG, "设置环境变量失败：" + key, error);
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                ServiceConfig.CHANNEL_ID, "Band Room 主机",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("局域网排练主机运行状态");
        channel.setShowBadge(false);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String status) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent stop = new Intent(this, BandRoomService.class);
        stop.setAction(ServiceConfig.ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 1, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new Notification.Builder(this, ServiceConfig.CHANNEL_ID)
                .setContentTitle("Band Room 主机" + status)
                .setContentText("局域网排练主机：" + ServiceConfig.PORT + " 端口")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(contentIntent)
                .addAction(new Notification.Action.Builder(
                        null, "停止主机", stopIntent).build())
                .build();
    }

    private void updateNotification(String status) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(ServiceConfig.NOTIFICATION_ID, buildNotification(status));
    }

    @Override
    public void onDestroy() {
        state.markStopped();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** 读取应用版本，避免直接依赖 BuildConfig（单元测试 JVM 里没有）。 */
    static final class BuildConfigCompat {
        static String versionName(Context context) {
            try {
                return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
            } catch (Exception error) {
                return "0";
            }
        }

        static int versionCode(Context context) {
            try {
                return (int) context.getPackageManager().getPackageInfo(context.getPackageName(), 0).getLongVersionCode();
            } catch (Exception error) {
                return 0;
            }
        }
    }
}
