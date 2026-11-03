cmake_minimum_required(VERSION 3.22.1)
project(bandroom LANGUAGES C CXX)

# libnode.so 与头文件由 pnpm run fetch:nodejs-mobile 下载到 android/nodejs-mobile/。
set(NODEJS_MOBILE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../nodejs-mobile")

if(NOT EXISTS "${NODEJS_MOBILE_DIR}/include/node/node.h")
    message(FATAL_ERROR "缺少 Node.js Mobile 头文件：${NODEJS_MOBILE_DIR}/include/node/node.h")
endif()

add_library(bandroom_node SHARED src/main/cpp/native-lib.cpp)

target_include_directories(bandroom_node PRIVATE
    "${NODEJS_MOBILE_DIR}/include/node"
)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
    IMPORTED_LOCATION "${NODEJS_MOBILE_DIR}/libs/${ANDROID_ABI}/libnode.so"
)

target_link_libraries(bandroom_node
    libnode
    android
    log
)
