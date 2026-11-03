package com.bandroom.rehearsal;

import java.net.URI;
import java.net.URISyntaxException;

/** WebView 导航白名单：只允许本机 Band Room 服务地址。 */
public final class LocalNavigationPolicy {

    private final int port;

    public LocalNavigationPolicy(int port) {
        this.port = port;
    }

    public int getPort() {
        return port;
    }

    /** 本机服务的 origin，用于拼装初始地址。 */
    public String origin() {
        return "http://127.0.0.1:" + port;
    }

    public String hostUrl() {
        return origin() + "/host";
    }

    /** 只认 http + 回环主机 + 本机端口；其余交给外部浏览器或直接拒绝。 */
    public boolean isAllowed(String url) {
        if (url == null || url.isEmpty()) return false;
        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException error) {
            return false;
        }
        if (!"http".equalsIgnoreCase(uri.getScheme())) return false;
        String host = uri.getHost();
        if (!"127.0.0.1".equals(host) && !"localhost".equals(host)) return false;
        return uri.getPort() == port;
    }

    /** 空地址（about:blank、data:）视为内部渲染，放行。 */
    public boolean shouldNavigate(String url) {
        if (url == null || url.isEmpty() || url.startsWith("about:") || url.startsWith("data:")) return true;
        return isAllowed(url);
    }
}
