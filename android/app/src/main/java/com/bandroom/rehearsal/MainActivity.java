package com.bandroom.rehearsal;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 主机控制台。只加载 http://127.0.0.1:4173/host，
 * 其余地址一律交给外部浏览器；file:// 与 content:// 永不进 WebView。
 */
public class MainActivity extends Activity {

    private static final String TAG = "BandRoomMain";
    private static final int FILE_CHOOSER_REQUEST = 0x4173;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final LocalNavigationPolicy policy = new LocalNavigationPolicy(ServiceConfig.PORT);

    private WebView webView;
    private LinearLayout statusPanel;
    private TextView statusText;
    private ValueCallback<Uri[]> pendingFileCallback;
    private boolean loaded;
    private int pollAttempts;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildLayout();
        startHostService();
        pollUntilReady();
    }

    /** 只搭界面，不碰 Node。 */
    private void buildLayout() {
        FrameLayout root = new FrameLayout(this);

        webView = new WebView(this);
        configureWebView(webView);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        statusPanel = new LinearLayout(this);
        statusPanel.setOrientation(LinearLayout.VERTICAL);
        statusPanel.setPadding(48, 96, 48, 48);
        statusPanel.setBackgroundColor(0xFF111827);

        statusText = new TextView(this);
        statusText.setTextColor(0xFFE5E7EB);
        statusText.setTextSize(16f);
        statusText.setText("正在启动 Band Room 主机…");

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(view -> {
            pollAttempts = 0;
            statusText.setText("正在重新启动…");
            startHostService();
            pollUntilReady();
        });

        statusPanel.addView(statusText);
        statusPanel.addView(retry);
        root.addView(statusPanel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                return handleNavigation(request.getUrl().toString());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView webView, String url) {
                return handleNavigation(url);
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileCallback != null) pendingFileCallback.onReceiveValue(null);
                pendingFileCallback = callback;
                Intent picker = new Intent(Intent.ACTION_GET_CONTENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                // HTML accept 可包含 .gp5 等扩展名，EXTRA_MIME_TYPES 只接受 MIME。
                // 曲谱在不同文件提供方的 MIME 不一致，因此允许选择所有可打开文件，
                // 由服务端校验扩展名、大小及实际曲谱内容。
                picker.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(picker, "选择文件"), FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception error) {
                    Log.w(TAG, "打开文件选择器失败", error);
                    pendingFileCallback = null;
                    return false;
                }
            }
        });
    }

    /** 返回 true 表示由本应用接管（即阻止 WebView 自己加载）。 */
    private boolean handleNavigation(String url) {
        if (policy.shouldNavigate(url)) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception error) {
            Log.w(TAG, "无法外部打开：" + url, error);
        }
        return true;
    }

    private void startHostService() {
        Intent intent = new Intent(this, BandRoomService.class);
        intent.setAction(ServiceConfig.ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }

    /**
     * 在主线程轮询，但每次探测都丢到后台线程执行。
     * 直接在主线程发 HTTP 会抛 NetworkOnMainThreadException，
     * 被 probeHealth 的 catch 吞掉后表现为「永远启动中」。
     */
    private void pollUntilReady() {
        pollAttempts++;
        if (pollAttempts > 120) {
            showFailure("主机启动超时。请确认设备存储可用后点重试。");
            return;
        }
        new Thread(() -> {
            boolean ready = probeHealth();
            handler.post(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (ready) showConsole();
                else handler.postDelayed(this::pollUntilReady, 500);
            });
        }, "band-room-health").start();
    }

    private boolean probeHealth() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(ServiceConfig.healthUrl()).openConnection();
            connection.setConnectTimeout(800);
            connection.setReadTimeout(800);
            return connection.getResponseCode() == 200;
        } catch (Exception ignored) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void showConsole() {
        if (loaded) {
            statusPanel.setVisibility(View.GONE);
            return;
        }
        loaded = true;
        statusPanel.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(policy.hostUrl());
    }

    private void showFailure(String message) {
        loaded = false;
        webView.setVisibility(View.INVISIBLE);
        statusPanel.setVisibility(View.VISIBLE);
        statusText.setText(message);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_CHOOSER_REQUEST) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (pendingFileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            result = new Uri[]{data.getData()};
        }
        pendingFileCallback.onReceiveValue(result);
        pendingFileCallback = null;
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 主机服务继续运行：切后台与锁屏不停止房间。
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        if (!loaded) {
            pollAttempts = 0;
            pollUntilReady();
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
