plugins {
    id("com.android.application")
}

val nodejsMobileRuntime = file("../nodejs-mobile")

android {
    namespace = "com.bandroom.rehearsal"
    compileSdk = 35
    ndkVersion = "27.0.12077973"

    defaultConfig {
        applicationId = "com.bandroom.rehearsal"
        minSdk = 26
        targetSdk = 35
        versionCode = 10005
        versionName = "1.0.5"

        ndk {
            // 首版只发布 arm64-v8a；x86_64 仅供模拟器与开发构建。
            abiFilters += listOf("arm64-v8a", "x86_64")
        }

        externalNativeBuild {
            cmake {
                arguments += listOf("-DANDROID_STL=c++_shared")
                cppFlags += "-std=c++17"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("../nodejs-mobile/libs")
            assets.srcDirs("src/main/assets")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            // 首版交付可侧载 APK：使用 Android 调试证书签名。
            // 公开发布必须通过外部密钥重新签名，私钥不进入仓库。
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
            // libnode.so 与 libc++_shared.so 需要以未压缩形式按页对齐映射。
            keepDebugSymbols += "**/libnode.so"
        }
        resources {
            excludes += listOf("META-INF/LICENSE*", "META-INF/NOTICE*")
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    lint {
        abortOnError = false
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}

tasks.register("verifyNodeRuntime") {
    doLast {
        val required = listOf(
            File(nodejsMobileRuntime, "libs/arm64-v8a/libnode.so"),
            File(nodejsMobileRuntime, "include/node/node.h")
        )
        val missing = required.filterNot { it.isFile }
        if (missing.isNotEmpty()) {
            throw GradleException(
                "缺少 Node.js Mobile 运行时；请先运行 pnpm run fetch:nodejs-mobile。缺失：$missing"
            )
        }
    }
}

tasks.named("preBuild") { dependsOn("verifyNodeRuntime") }
