@echo off
chcp 65001 >nul
echo ========================================
echo   Antigravity Cockpit 插件打包工具
echo ========================================
echo.

:: 编译 TypeScript
echo [1/2] 正在编译 TypeScript...
call npm run compile
if %errorlevel% neq 0 (
    echo [错误] 编译失败！
    pause
    exit /b 1
)
echo [√] 编译完成

:: 打包插件
echo.
echo [2/2] 正在打包插件...
call vsce package
if %errorlevel% neq 0 (
    echo [错误] 打包失败！
    pause
    exit /b 1
)

echo.
echo ========================================
echo   打包完成！
echo ========================================
echo.
for %%f in (*.vsix) do echo 生成的文件: %%f
echo.
echo.
echo 安装方法 (手动):
echo   code --install-extension antigravity-cockpit-*.vsix --force
echo.

set /p install_now="是否立即覆盖安装到当前 VS Code? (Y/N) [default: Y]: "
if /i "%install_now%"=="N" goto end

:: --- IDE 自动探测逻辑 ---
set "AG_BIN="
set "VS_BIN="
set "IN_BIN="

:: 1. 探测 Antigravity
where antigravity >nul 2>nul && for /f "delims=" %%i in ('where antigravity') do set "AG_BIN=%%i"
if not defined AG_BIN if exist "%LOCALAPPDATA%\Programs\Antigravity\bin\antigravity.cmd" set "AG_BIN=%LOCALAPPDATA%\Programs\Antigravity\bin\antigravity.cmd"
if not defined AG_BIN if exist "%PROGRAMFILES%\Antigravity\bin\antigravity.cmd" set "AG_BIN=%PROGRAMFILES%\Antigravity\bin\antigravity.cmd"

echo DEBUG: AG_BIN=%AG_BIN%

:: 2. 探测 VS Code (Stable)
where code >nul 2>nul && set "VS_BIN=code"
if not defined VS_BIN if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd" set "VS_BIN=%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd"
if not defined VS_BIN if exist "%PROGRAMFILES%\Microsoft VS Code\bin\code.cmd" set "VS_BIN=%PROGRAMFILES%\Microsoft VS Code\bin\code.cmd"

:: 3. 探测 VS Code Insiders
where code-insiders >nul 2>nul && set "IN_BIN=code-insiders"
if not defined IN_BIN if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd" set "IN_BIN=%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd"

echo.
echo 检测到以下 IDE 环境:
if defined AG_BIN echo   [1] Antigravity IDE  - %AG_BIN%
if defined VS_BIN echo   [2] VS Code (Stable) - %VS_BIN%
if defined IN_BIN echo   [3] VS Code Insiders - %IN_BIN%

if not defined AG_BIN if not defined VS_BIN if not defined IN_BIN (
    echo [错误] 无法找到任何支持的 IDE ^(Antigravity 或 VS Code^)。
    echo 请手动安装或将 IDE 的 bin 目录添加到系统 PATH。
    goto end
)

echo.
set "target_choice=0"
if defined AG_BIN if defined VS_BIN set "has_multiple=1"
if defined AG_BIN if defined IN_BIN set "has_multiple=1"
if defined VS_BIN if defined IN_BIN set "has_multiple=1"

if "%has_multiple%"=="1" (
    echo 发现多个安装环境，请选择目标:
    echo   [1] 仅安装到 Antigravity
    echo   [2] 仅安装到 VS Code (Stable)
    echo   [3] 仅安装到 VS Code Insiders
    echo   [A] 全部安装 (All)
    echo   [N] 跳过安装 (None)
    set /p target_choice="请输入选项 [默认 1]: "
) else (
    set "target_choice=S"
)

if /i "%target_choice%"=="N" goto end
if /i "%target_choice%"=="S" (
    if defined AG_BIN set "target_choice=1"
    if not defined AG_BIN if defined VS_BIN set "target_choice=2"
    if not defined AG_BIN if not defined VS_BIN if defined IN_BIN set "target_choice=3"
)

echo.
echo [3/3] 开始安装流程...

for %%f in (antigravity-cockpit-*.vsix) do (
    if /i "%target_choice%"=="1" if defined AG_BIN call :do_install "%AG_BIN%" "%%f"
    if /i "%target_choice%"=="2" if defined VS_BIN call :do_install "%VS_BIN%" "%%f"
    if /i "%target_choice%"=="3" if defined IN_BIN call :do_install "%IN_BIN%" "%%f"
    if /i "%target_choice%"=="A" (
        if defined AG_BIN call :do_install "%AG_BIN%" "%%f"
        if defined VS_BIN call :do_install "%VS_BIN%" "%%f"
        if defined IN_BIN call :do_install "%IN_BIN%" "%%f"
    )
    if "%target_choice%"=="0" if defined AG_BIN call :do_install "%AG_BIN%" "%%f"
    if "%target_choice%"=="" if defined AG_BIN call :do_install "%AG_BIN%" "%%f"
)

echo.
echo [√] 安装任务处理完毕。

set /p reload_now="是否立即强制重新加载 IDE 窗口? (Y/N) [default: N]: "
if /i "%reload_now%"=="Y" (
    echo 正在发送重新加载指令...
    if /i "%target_choice%"=="1" if defined AG_BIN call "%AG_BIN%" --execute-command workbench.action.reloadWindow
    if /i "%target_choice%"=="2" if defined VS_BIN call "%VS_BIN%" --execute-command workbench.action.reloadWindow
    if /i "%target_choice%"=="3" if defined IN_BIN call "%IN_BIN%" --execute-command workbench.action.reloadWindow
    if /i "%target_choice%"=="A" (
        if defined AG_BIN call "%AG_BIN%" --execute-command workbench.action.reloadWindow
        if defined VS_BIN call "%VS_BIN%" --execute-command workbench.action.reloadWindow
        if defined IN_BIN call "%IN_BIN%" --execute-command workbench.action.reloadWindow
    )
    echo [√] 已发送重载指令。
)

goto end

:do_install
echo 正在安装到 %~1: %~2
call "%~1" --install-extension "%~2" --force
exit /b

:end
echo.
echo 流程结束。
pause
