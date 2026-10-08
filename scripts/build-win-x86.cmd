@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x86 -host_arch=x64
if errorlevel 1 exit /b %errorlevel%
set "PATH=%~dp0..\artifacts\tools\nasm-3.02\nasm-3.02;%PATH%"
npx tauri build --target i686-pc-windows-msvc --bundles nsis --no-sign
