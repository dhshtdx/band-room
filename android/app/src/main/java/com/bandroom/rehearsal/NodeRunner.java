package com.bandroom.rehearsal;

/**
 * JNI 桥：在专用 pthread 里调用 node::Start()。
 * Node 的 Start() 会阻塞到事件循环结束，绝不能跑在 JNI 调用线程上。
 */
public final class NodeRunner {

    private static boolean libraryLoaded;

    private NodeRunner() {
    }

    /** 幂等加载 libbandroom_node.so；失败时抛出带原因的异常供上层显示。 */
    public static synchronized void ensureLoaded() {
        if (libraryLoaded) return;
        System.loadLibrary("bandroom_node");
        libraryLoaded = true;
    }

    /**
     * 启动 Node。entryFile 为入口脚本绝对路径，workingDir 为运行目录。
     * 返回 true 表示 Node 线程已创建；Node 自身的退出码不会回传到这里。
     */
    public static native boolean startNode(String entryFile, String workingDir);
}
