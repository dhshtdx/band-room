// Band Room Android 主机：在专用线程中运行 Node.js Mobile。
// Node 的 Start() 会阻塞到事件循环结束，因此必须离开 JNI 调用线程，
// 否则 Java 侧会一直卡在 service 启动流程里。

#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>

#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "node.h"

#define LOG_TAG "BandRoomNode"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

struct StartArgs {
    std::string entryPath;
    std::string workingDir;
};

// 把 Java 侧的字符串复制进堆内存，交给 Node 线程；
// 不能依赖 JNI 的局部引用在另一线程里还活着。
void startNodeBlocking(StartArgs* args) {
    std::vector<std::string> storage;
    storage.emplace_back("node");
    storage.push_back(args->entryPath);

    std::vector<char*> argv;
    argv.reserve(storage.size() + 1);
    for (auto& item : storage) argv.push_back(const_cast<char*>(item.c_str()));
    argv.push_back(nullptr);

    if (chdir(args->workingDir.c_str()) != 0) {
        LOGE("切换工作目录失败：%s", args->workingDir.c_str());
    }

    LOGI("启动 Node.js：%s（工作目录 %s）", args->entryPath.c_str(), args->workingDir.c_str());
    const int code = node::Start(static_cast<int>(argv.size() - 1), argv.data());
    LOGI("Node.js 已退出，返回码 %d", code);

    delete args;
    pthread_exit(nullptr);
}

void* threadEntry(void* raw) {
    startNodeBlocking(static_cast<StartArgs*>(raw));
    return nullptr;
}

}  // namespace

extern "C" JNIEXPORT jboolean JNICALL
Java_com_bandroom_rehearsal_NodeRunner_startNode(
        JNIEnv* env, jclass /*clazz*/, jstring entryPath, jstring workingDir) {
    if (entryPath == nullptr || workingDir == nullptr) return JNI_FALSE;

    const char* entryChars = env->GetStringUTFChars(entryPath, nullptr);
    const char* dirChars = env->GetStringUTFChars(workingDir, nullptr);
    if (entryChars == nullptr || dirChars == nullptr) {
        if (entryChars) env->ReleaseStringUTFChars(entryPath, entryChars);
        if (dirChars) env->ReleaseStringUTFChars(workingDir, dirChars);
        return JNI_FALSE;
    }

    auto* args = new StartArgs{std::string(entryChars), std::string(dirChars)};
    env->ReleaseStringUTFChars(entryPath, entryChars);
    env->ReleaseStringUTFChars(workingDir, dirChars);

    pthread_t thread;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    // Node 线程需要较大的栈：AlphaTab 解析曲谱与 JSON 序列化都在这里发生。
    pthread_attr_setstacksize(&attr, 8 * 1024 * 1024);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

    const int created = pthread_create(&thread, &attr, threadEntry, args);
    pthread_attr_destroy(&attr);
    if (created != 0) {
        LOGE("创建 Node 线程失败：%d", created);
        delete args;
        return JNI_FALSE;
    }
    return JNI_TRUE;
}
