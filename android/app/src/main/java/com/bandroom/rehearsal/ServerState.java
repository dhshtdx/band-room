package com.bandroom.rehearsal;

/**
 * 主机服务的状态机。刻意做成不依赖 Android API 的纯 Java 类，
 * 这样 JVM 单元测试可以直接覆盖重复启动抑制与停止后重启。
 */
public final class ServerState {

    public enum State {
        /** 尚未启动。 */
        IDLE,
        /** 已进入前台并开始解包 / 初始化 Node。 */
        STARTING,
        /** 健康检查通过，主机可用。 */
        RUNNING,
        /** 启动失败，可重试。 */
        FAILED,
        /** 已停止，可重新启动。 */
        STOPPED
    }

    private State state = State.IDLE;

    public synchronized State get() {
        return state;
    }

    /**
     * 请求启动。只有 IDLE、FAILED、STOPPED 允许进入 STARTING。
     * 已经在 STARTING 或 RUNNING 时返回 false，调用方必须放弃这次启动，
     * 否则会拉起第二个 Node 实例并占用第二个端口。
     */
    public synchronized boolean beginStart() {
        if (state == State.STARTING || state == State.RUNNING) return false;
        state = State.STARTING;
        return true;
    }

    /** 健康检查通过。 */
    public synchronized boolean markRunning() {
        if (state != State.STARTING) return false;
        state = State.RUNNING;
        return true;
    }

    /** 启动失败；保留可重试语义。 */
    public synchronized boolean markFailed() {
        if (state != State.STARTING && state != State.RUNNING) return false;
        state = State.FAILED;
        return true;
    }

    /** 正常停止。 */
    public synchronized boolean markStopped() {
        if (state == State.IDLE || state == State.STOPPED) return false;
        state = State.STOPPED;
        return true;
    }

    public synchronized boolean isActive() {
        return state == State.STARTING || state == State.RUNNING;
    }
}
