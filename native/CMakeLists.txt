cmake_minimum_required(VERSION 3.25)
project(VisikiNativeAudio LANGUAGES C CXX)

if(NOT WIN32 OR NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "Visiki native audio requires the Windows x64 MSVC toolchain.")
endif()

set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set(SMTG_USE_STATIC_CRT ON CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ADD_VST3_UTILITIES OFF CACHE BOOL "" FORCE)
add_subdirectory(vendor/vst3sdk EXCLUDE_FROM_ALL)

add_library(visiki_ebur128 STATIC vendor/libebur128/ebur128/ebur128.c)
target_include_directories(visiki_ebur128 PUBLIC vendor/libebur128/ebur128
    PRIVATE vendor/libebur128/ebur128/queue)
target_compile_definitions(visiki_ebur128 PRIVATE _USE_MATH_DEFINES _CRT_SECURE_NO_WARNINGS)

add_executable(VisikiAudioHost audio-host.cpp vst3-host.cpp vst3-window.cpp
    vendor/vst3sdk/public.sdk/source/common/memorystream.cpp
    vendor/vst3sdk/public.sdk/source/vst/hosting/module_win32.cpp
    vendor/vst3sdk/public.sdk/source/vst/hosting/plugprovider.cpp)
target_compile_features(VisikiAudioHost PRIVATE cxx_std_17)
target_compile_options(VisikiAudioHost PRIVATE /utf-8)
target_compile_definitions(VisikiAudioHost PRIVATE _CRT_SECURE_NO_WARNINGS)
target_link_libraries(VisikiAudioHost PRIVATE sdk_hosting visiki_ebur128 ole32 user32 advapi32 shell32)

if(NOT DEFINED VISIKI_NATIVE_OUTPUT)
    set(VISIKI_NATIVE_OUTPUT "${CMAKE_CURRENT_SOURCE_DIR}/../dist-native")
endif()
set_target_properties(VisikiAudioHost PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${VISIKI_NATIVE_OUTPUT}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${VISIKI_NATIVE_OUTPUT}")
