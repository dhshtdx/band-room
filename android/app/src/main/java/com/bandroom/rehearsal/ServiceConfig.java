package com.bandroom.rehearsal;

import java.security.SecureRandom;
import java.util.Base64;

/**
 * 主机服务的固定参数。抽出来便于 JVM 测试断言端口与令牌规则。
 */
public final class ServiceConfig {

    /** 固定端口：二维码与局域网加入地址必须稳定，不能每次启动跳端口。 */
    public static final int PORT = 4173;

    public static final String ACTION_START = "com.bandroom.rehearsal.action.START";
    public static final String ACTION_STOP = "com.bandroom.rehearsal.action.STOP";

    public static final String CHANNEL_ID = "band_room_host";
    public static final int NOTIFICATION_ID = 4173;

    private ServiceConfig() {
    }

    /** 生成内部停机令牌；只在本进程内使用，不入日志、不进通知。 */
    public static String newShutdownToken() {
        byte[] raw = new byte[32];
        new SecureRandom().nextBytes(raw);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }

    public static String healthUrl() {
        return "http://127.0.0.1:" + PORT + "/api/health";
    }

    public static String shutdownUrl() {
        return "http://127.0.0.1:" + PORT + "/api/internal/shutdown";
    }

    public static String hostUrl() {
        return "http://127.0.0.1:" + PORT + "/host";
    }
}
