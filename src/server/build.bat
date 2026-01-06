@echo off
setlocal enabledelayedexpansion

REM NDK toolchain path
set NDK_TOOLCHAIN=%ANDROID_NDK_HOME%\toolchains\llvm\prebuilt\windows-x86_64\bin

REM aarch64
set TARGET=aarch64-linux-android
set TARGET_CC=%NDK_TOOLCHAIN%\aarch64-linux-android33-clang.cmd
set TARGET_CXX=%NDK_TOOLCHAIN%\aarch64-linux-android33-clang++.cmd
set TARGET_AR=%NDK_TOOLCHAIN%\llvm-ar
set TARGET_LINKER=%NDK_TOOLCHAIN%\aarch64-linux-android33-clang.cmd

set CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=!TARGET_LINKER!
cargo build --target=!TARGET! --release

endlocal
