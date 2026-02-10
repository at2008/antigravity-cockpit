import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import { getVSCDBPath } from './constants';
export interface EnvironmentCheckResult {
    success: boolean;
    nodeJs: { ok: boolean; path?: string; error?: string };
    npm: { ok: boolean; version?: string; error?: string };
    database: { ok: boolean; path?: string; error?: string };
    ide: { ok: boolean; path?: string; error?: string };
    suggestions: string[];
}

export class SwitcherProxy {
    /**
     * 预检查切换所需的运行环境
     * @param dbPathOverride 数据库路径覆盖（可选）
     * @param exePathOverride IDE 可执行文件路径覆盖（可选）
     * @returns 检查结果，包含各项状态和修复建议
     */
    static checkEnvironment(
        dbPathOverride?: string,
        exePathOverride?: { win32?: string; darwin?: string; linux?: string }
    ): EnvironmentCheckResult {
        const platform = os.platform();
        const result: EnvironmentCheckResult = {
            success: true,
            nodeJs: { ok: false },
            npm: { ok: false },
            database: { ok: false },
            ide: { ok: false },
            suggestions: []
        };

        // 1. 检查 Node.js
        let nodeExe = '';
        if (platform === 'win32') {
            const possibleNodePaths = [
                path.join(process.env.PROGRAMFILES || '', 'nodejs', 'node.exe'),
                path.join(process.env['PROGRAMFILES(X86)'] || '', 'nodejs', 'node.exe'),
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
                path.join(process.env.APPDATA || '', 'npm', 'node.exe'),
                'C:\\Program Files\\nodejs\\node.exe',
                'C:\\nodejs\\node.exe',
            ];

            for (const p of possibleNodePaths) {
                if (fs.existsSync(p)) {
                    nodeExe = p;
                    break;
                }
            }

            if (!nodeExe) {
                try {
                    const whereResult = execSync('where node', { encoding: 'utf-8', windowsHide: true });
                    const lines = whereResult.trim().split('\n');
                    if (lines.length > 0 && fs.existsSync(lines[0].trim())) {
                        nodeExe = lines[0].trim();
                    }
                } catch (e) {
                    // 忽略
                }
            }
        } else {
            try {
                nodeExe = execSync('which node', { encoding: 'utf-8' }).trim();
            } catch (e) {
                if (fs.existsSync('/usr/bin/node')) {
                    nodeExe = '/usr/bin/node';
                }
            }
        }

        if (nodeExe && fs.existsSync(nodeExe)) {
            result.nodeJs = { ok: true, path: nodeExe };
        } else {
            result.nodeJs = { ok: false, error: '未找到 Node.js' };
            result.success = false;
            result.suggestions.push('❌ 请安装 Node.js: https://nodejs.org/ (建议 LTS 版本)');
        }

        // 2. 检查 npm (用于备用安装 sqlite3)
        try {
            const npmCmd = platform === 'win32' ? 'npm.cmd --version' : 'npm --version';
            const npmVersion = execSync(npmCmd, { encoding: 'utf-8', windowsHide: true }).trim();
            result.npm = { ok: true, version: npmVersion };
        } catch (e) {
            result.npm = { ok: false, error: 'npm 不可用' };
            // npm 不是必须的，只是备用方案，不影响 success
            result.suggestions.push('⚠️ npm 未安装或不可用。如果 sqlite3 模块不兼容，将无法自动修复。建议安装 Node.js 完整版。');
        }

        // 3. 检查数据库文件
        const actualDbPath = dbPathOverride && dbPathOverride.trim()
            ? dbPathOverride.trim()
            : getVSCDBPath();

        if (fs.existsSync(actualDbPath)) {
            result.database = { ok: true, path: actualDbPath };
        } else {
            result.database = { ok: false, path: actualDbPath, error: '数据库文件不存在' };
            result.success = false;
            result.suggestions.push(`❌ Antigravity IDE 数据库不存在: ${actualDbPath}`);
            result.suggestions.push('   请确保已安装并至少启动过一次 Antigravity IDE');
        }

        // 4. 检查 IDE 可执行文件
        let idePath = '';
        if (platform === 'win32') {
            idePath = exePathOverride?.win32?.trim() ||
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe');
        } else if (platform === 'darwin') {
            idePath = exePathOverride?.darwin?.trim() || '/Applications/Antigravity.app';
        } else {
            const possiblePaths = exePathOverride?.linux?.trim()
                ? [exePathOverride.linux.trim()]
                : ['/usr/bin/antigravity', '/opt/antigravity/antigravity',
                    path.join(process.env.HOME || '', '.local/bin/antigravity')];
            for (const p of possiblePaths) {
                if (fs.existsSync(p)) {
                    idePath = p;
                    break;
                }
            }
        }

        if (idePath && fs.existsSync(idePath)) {
            result.ide = { ok: true, path: idePath };
        } else {
            result.ide = { ok: false, path: idePath, error: 'IDE 可执行文件不存在' };
            // IDE 路径问题不是致命的，可以通过协议启动
            result.suggestions.push(`⚠️ Antigravity IDE 可执行文件未找到: ${idePath || '(未知)'}`);
            result.suggestions.push('   切换后可能需要手动启动 IDE');
        }

        return result;
    }

    /**
     * 格式化环境检查结果为用户可读的消息
     */
    static formatCheckResult(result: EnvironmentCheckResult): string {
        const lines: string[] = [];
        lines.push('### 环境检查结果\n');

        lines.push(`- Node.js: ${result.nodeJs.ok ? '✅ ' + result.nodeJs.path : '❌ ' + result.nodeJs.error}`);
        lines.push(`- npm: ${result.npm.ok ? '✅ v' + result.npm.version : '⚠️ ' + result.npm.error}`);
        lines.push(`- 数据库: ${result.database.ok ? '✅ 存在' : '❌ ' + result.database.error}`);
        lines.push(`- IDE: ${result.ide.ok ? '✅ 存在' : '⚠️ ' + result.ide.error}`);

        if (result.suggestions.length > 0) {
            lines.push('\n### 建议\n');
            lines.push(result.suggestions.join('\n'));
        }

        return lines.join('\n');
    }
    /**
     * 创建并在外部执行一个独立脚本，接管账号切换的后续工作。
     * 跨平台支持 (Windows/Linux/macOS)
     * 
     * 流程：
     * 1. 生成独立的 Node.js 脚本（包含完整的注入逻辑）
     * 2. 使用平台特定方式启动独立进程
     * 3. 独立进程监测 IDE 进程关闭 -> 等待 -> 注入 -> 启动
     * 
     * @param accessToken OAuth access token
     * @param refreshToken OAuth refresh token
     * @param expiry Token 过期时间戳（秒）
     * @param dbPathOverride 数据库路径覆盖（可选）
     * @param exePathOverride Antigravity 可执行文件路径覆盖（可选，按平台）
     * @param processWaitSeconds 进程关闭/启动等待时间（秒，默认10秒，低配机器建议20-30秒）
     */
    static async executeExternalSwitch(
        accessToken: string,
        refreshToken: string,
        expiry: number,
        email: string,
        dbPathOverride?: string,
        exePathOverride?: { win32?: string; darwin?: string; linux?: string },
        processWaitSeconds: number = 10
    ) {
        const tempDir = os.tmpdir();
        const timestamp = Date.now();
        const mainScriptPath = path.join(tempDir, `ag_switch_${timestamp}.js`);
        const logPath = path.join(tempDir, `ag_switch_${timestamp}.log`);

        // 获取 extension 根目录下的 node_modules 路径
        const extensionRoot = path.join(__dirname, '..');
        const nodeModulesPath = path.join(extensionRoot, 'node_modules');
        const platform = os.platform();

        // 获取 Node.js 可执行文件路径
        // process.execPath 在 Electron 应用中返回的是 Electron 可执行文件，不是 Node.js
        // 需要找到系统中的 Node.js
        let nodeExe = '';
        if (platform === 'win32') {
            // Windows: 尝试多个可能的 Node.js 路径
            const possibleNodePaths = [
                path.join(process.env.PROGRAMFILES || '', 'nodejs', 'node.exe'),
                path.join(process.env['PROGRAMFILES(X86)'] || '', 'nodejs', 'node.exe'),
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
                path.join(process.env.APPDATA || '', 'npm', 'node.exe'),
                'C:\\Program Files\\nodejs\\node.exe',
                'C:\\nodejs\\node.exe',
            ];

            for (const p of possibleNodePaths) {
                if (fs.existsSync(p)) {
                    nodeExe = p;
                    break;
                }
            }

            // 如果找不到，尝试使用 where 命令
            if (!nodeExe) {
                try {
                    const result = execSync('where node', { encoding: 'utf-8', windowsHide: true });
                    const lines = result.trim().split('\n');
                    if (lines.length > 0 && fs.existsSync(lines[0].trim())) {
                        nodeExe = lines[0].trim();
                    }
                } catch (e) {
                    // 忽略
                }
            }
        } else {
            // Linux/macOS: 使用 which 命令
            try {
                nodeExe = execSync('which node', { encoding: 'utf-8' }).trim();
            } catch (e) {
                nodeExe = '/usr/bin/node';
            }
        }

        if (!nodeExe || !fs.existsSync(nodeExe)) {
            throw new Error('Cannot find Node.js executable');
        }

        // 获取实际使用的数据库路径
        const actualDbPath = dbPathOverride && dbPathOverride.trim()
            ? dbPathOverride.trim()
            : getVSCDBPath();

        // 生成跨平台的独立 Node.js 脚本
        const mainScriptContent = `
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// === 配置 ===
const LOG_PATH = ${JSON.stringify(logPath)};
const DB_PATH = ${JSON.stringify(actualDbPath)};
const NODE_MODULES = ${JSON.stringify(nodeModulesPath)};
const ACCESS_TOKEN = ${JSON.stringify(accessToken)};
const REFRESH_TOKEN = ${JSON.stringify(refreshToken)};
const EXPIRY = ${expiry};
const EMAIL = ${JSON.stringify(email)};
const PLATFORM = ${JSON.stringify(platform)};
const EXE_PATH_OVERRIDE = ${JSON.stringify(exePathOverride || {})};
const PROCESS_WAIT_SECONDS = ${processWaitSeconds};

// === 日志 ===
function log(msg) {
    const ts = new Date().toISOString();
    const line = \`[\${ts}] \${msg}\\n\`;
    fs.appendFileSync(LOG_PATH, line);
    // 控制台输出已移除，日志仅写入文件
}

// === 等待函数 ===
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// === 检测 Antigravity 进程 ===
function isAntigravityRunning() {
    try {
        if (PLATFORM === 'win32') {
            const result = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /NH 2>nul', { encoding: 'utf-8', shell: true, windowsHide: true });
            const running = result.toLowerCase().includes('antigravity.exe');
            log('进程检测结果: ' + (running ? '运行中' : '已退出'));
            return running;
        } else {
            // Linux/macOS
            const result = execSync('pgrep -i antigravity || true', { encoding: 'utf-8' });
            return result.trim().length > 0;
        }
    } catch (e) {
        log('进程检测异常: ' + (e.message || e));
        return false;
    }
}

// === 强制关闭所有 Antigravity 进程 ===
function killAllAntigravity() {
    log('正在强制关闭所有 Antigravity 进程...');
    try {
        if (PLATFORM === 'win32') {
            // Windows: 使用 taskkill 强制关闭所有 Antigravity.exe 进程
            try {
                execSync('taskkill /F /IM Antigravity.exe /T 2>nul', { 
                    encoding: 'utf-8', 
                    shell: true, 
                    windowsHide: true,
                    timeout: 10000
                });
                log('taskkill 命令已执行');
            } catch (e) {
                // taskkill 在没有匹配进程时会返回非零退出码，这是正常的
                log('taskkill 完成（可能没有运行中的进程）: ' + (e.message || ''));
            }
        } else {
            // Linux/macOS: 使用 pkill
            try {
                execSync('pkill -9 -i antigravity || true', { encoding: 'utf-8' });
                log('pkill 命令已执行');
            } catch (e) {
                log('pkill 完成: ' + (e.message || ''));
            }
        }
    } catch (e) {
        log('关闭进程时发生错误: ' + (e.message || e));
    }
    log('关闭进程命令已执行');
}

// === 等待进程完全退出 ===
async function waitForProcessExit(maxWaitSec = 30) {
    log('等待 Antigravity IDE 进程退出...');
    // 简化：直接等待固定时间，避免 execSync 在 VBScript 进程中卡住
    log('等待 ' + maxWaitSec + ' 秒让进程完全退出...');
    await sleep(maxWaitSec * 1000);
    log('等待完成，假设 IDE 进程已退出');
    return true;
}
// === Protobuf 编解码 ===
function encodeVarint(v) {
    const buf = [];
    while (v >= 128) {
        buf.push((v % 128) | 128);
        v = Math.floor(v / 128);
    }
    buf.push(v);
    return Buffer.from(buf);
}

function readVarint(data, offset) {
    let result = 0;
    let multiplier = 1;
    let pos = offset;
    while (true) {
        const byte = data[pos];
        result += (byte & 127) * multiplier;
        pos++;
        if (!(byte & 128)) break;
        multiplier *= 128;
    }
    return [result, pos];
}

function skipField(data, offset, wireType) {
    if (wireType === 0) return readVarint(data, offset)[1];
    if (wireType === 1) return offset + 8;
    if (wireType === 2) {
        const [len, off] = readVarint(data, offset);
        return off + len;
    }
    if (wireType === 5) return offset + 4;
    return offset;
}

function removeField(data, fieldNum) {
    let res = Buffer.alloc(0);
    let off = 0;
    while (off < data.length) {
        const start = off;
        if (off >= data.length) break;
        const [tag, tagOff] = readVarint(data, off);
        const wire = tag & 7;
        const currentField = Math.floor(tag / 8);
        if (currentField === fieldNum) {
            off = skipField(data, tagOff, wire);
        } else {
            off = skipField(data, tagOff, wire);
            res = Buffer.concat([res, data.subarray(start, off)]);
        }
    }
    return res;
}

function encodeLenDelim(fieldNum, data) {
    const tag = (fieldNum << 3) | 2;
    return Buffer.concat([encodeVarint(tag), encodeVarint(data.length), data]);
}

function encodeStringField(fieldNum, value) {
    return encodeLenDelim(fieldNum, Buffer.from(value, 'utf-8'));
}

function createOAuthInfo(at, rt, exp) {
    const f1 = encodeStringField(1, at);
    const f2 = encodeStringField(2, "Bearer");
    const f3 = encodeStringField(3, rt);
    const tsMsg = Buffer.concat([encodeVarint((1 << 3) | 0), encodeVarint(exp)]);
    const f4 = encodeLenDelim(4, tsMsg);
    return Buffer.concat([f1, f2, f3, f4]);
}

function createEmailField(email) {
    return encodeStringField(2, email);
}

function createOldFormatField(at, rt, exp) {
    const info = createOAuthInfo(at, rt, exp);
    return encodeLenDelim(6, info);
}

// === 动态加载 sqlite3 ===
async function loadSqlite3() {
    // 方法1: 尝试使用插件自带的 sqlite3
    try {
        module.paths.push(NODE_MODULES);
        const sqlite3 = require('sqlite3');
        log('使用插件目录的 sqlite3 模块');
        return sqlite3;
    } catch (e) {
        log('插件目录 sqlite3 加载失败: ' + (e.message || e));
    }

    // 方法2: 尝试使用系统全局的 sqlite3
    try {
        const sqlite3 = require('sqlite3');
        log('使用系统全局的 sqlite3 模块');
        return sqlite3;
    } catch (e) {
        log('系统全局 sqlite3 不可用: ' + (e.message || e));
    }

    // 方法3: 在临时目录安装兼容版本
    log('尝试在临时目录安装 sqlite3...');
    const tempSqliteDir = path.join(require('os').tmpdir(), 'ag_sqlite3_temp');
    
    try {
        // 确保目录存在
        if (!fs.existsSync(tempSqliteDir)) {
            fs.mkdirSync(tempSqliteDir, { recursive: true });
        }
        
        // 检查是否已经安装过
        const tempNodeModules = path.join(tempSqliteDir, 'node_modules');
        if (fs.existsSync(path.join(tempNodeModules, 'sqlite3'))) {
            log('发现已安装的临时 sqlite3，尝试加载...');
            module.paths.unshift(tempNodeModules);
            try {
                const sqlite3 = require('sqlite3');
                log('临时目录 sqlite3 加载成功');
                return sqlite3;
            } catch (loadErr) {
                log('临时目录 sqlite3 加载失败，将重新安装: ' + loadErr.message);
                // 删除旧的安装
                fs.rmSync(tempNodeModules, { recursive: true, force: true });
            }
        }
        
        // 创建 package.json
        const pkgJson = { name: 'ag-sqlite-temp', version: '1.0.0', dependencies: { sqlite3: '^5.1.6' } };
        fs.writeFileSync(path.join(tempSqliteDir, 'package.json'), JSON.stringify(pkgJson));
        
        // 执行 npm install
        log('正在安装 sqlite3（这可能需要几分钟，请耐心等待）...');
        execSync('npm install --prefer-offline --no-audit --no-fund', {
            cwd: tempSqliteDir,
            encoding: 'utf-8',
            timeout: 300000, // 5分钟超时
            windowsHide: true
        });
        log('sqlite3 安装完成');
        
        // 加载新安装的模块
        module.paths.unshift(tempNodeModules);
        const sqlite3 = require('sqlite3');
        log('临时安装的 sqlite3 加载成功');
        return sqlite3;
    } catch (installErr) {
        log('sqlite3 安装失败: ' + (installErr.message || installErr));
        throw new Error('无法加载 sqlite3 模块，请确保系统已安装 npm');
    }
}

// === 注入 Token ===
async function injectToken() {
    log('开始注入 Token 到数据库...');
    
    if (!fs.existsSync(DB_PATH)) {
        log('错误: 数据库文件不存在: ' + DB_PATH);
        return false;
    }
    
    try {
        try {
            const backupPath = DB_PATH + '.ag-backup-' + Date.now();
            fs.copyFileSync(DB_PATH, backupPath);
            log('已创建数据库备份: ' + backupPath);
        } catch (e) {
            log('创建数据库备份失败（将继续尝试注入）: ' + (e.message || e));
        }

        // 动态加载 sqlite3（带备用方案）
        const sqlite3 = await loadSqlite3();
        
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(DB_PATH);
            const KEY_OLD = 'jetskiStateSync.agentManagerInitState';
            const KEY_NEW = 'antigravityUnifiedStateSync.oauthToken';
            const KEY_ONBOARD = 'antigravityOnboarding';
            
            db.serialize(() => {
                // 1. 新格式注入
                try {
                    const oauthInfo = createOAuthInfo(ACCESS_TOKEN, REFRESH_TOKEN, EXPIRY);
                    const oauthInfoB64 = oauthInfo.toString('base64');
                    const inner2 = encodeStringField(1, oauthInfoB64);
                    const inner1 = encodeStringField(1, "oauthTokenInfoSentinelKey");
                    const inner = Buffer.concat([inner1, encodeLenDelim(2, inner2)]);
                    const outer = encodeLenDelim(1, inner);
                    const outerB64 = outer.toString('base64');
                    
                    db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", [KEY_NEW, outerB64], (err) => {
                        if (err) log('新格式注入失败: ' + err.message);
                        else log('新格式注入成功');
                    });
                } catch (e) {
                    log('新格式注入异常: ' + e.message);
                }

                // 2. 旧格式注入
                db.get("SELECT value FROM ItemTable WHERE key = ?", [KEY_OLD], (err, row) => {
                    if (err || !row) {
                        log('旧格式跳过: ' + (err ? err.message : 'key 不存在'));
                    } else {
                        try {
                            const blob = Buffer.from(row.value, 'base64');
                            let clean = removeField(blob, 1); // UserID
                            clean = removeField(clean, 2); // Email
                            clean = removeField(clean, 6); // OAuthTokenInfo
                            
                            const emailField = createEmailField(EMAIL);
                            const tokenField = createOldFormatField(ACCESS_TOKEN, REFRESH_TOKEN, EXPIRY);
                            const finalB64 = Buffer.concat([clean, emailField, tokenField]).toString('base64');
                            
                            db.run("UPDATE ItemTable SET value = ? WHERE key = ?", [finalB64, KEY_OLD], (err) => {
                                if (err) log('旧格式注入失败: ' + err.message);
                                else log('旧格式注入成功');
                            });
                        } catch (e) {
                            log('旧格式注入异常: ' + e.message);
                        }
                    }
                });

                // 3. Onboarding 标记
                db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", [KEY_ONBOARD, "true"], (err) => {
                    db.close();
                    resolve(true);
                });
            });
        });
    } catch (e) {
        log('注入流程异常: ' + e.message);
        return false;
    }
}

// === 启动 IDE ===
function startIDE() {
    log('正在启动 Antigravity IDE...');
    
    try {
        if (PLATFORM === 'win32') {
            // 优先使用配置覆盖的路径
            let exePath = EXE_PATH_OVERRIDE.win32 && EXE_PATH_OVERRIDE.win32.trim() 
                ? EXE_PATH_OVERRIDE.win32.trim() 
                : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe');
            
            log('LOCALAPPDATA: ' + (process.env.LOCALAPPDATA || ''));
            log('使用的 IDE 路径: ' + exePath);
            log('路径是否存在: ' + fs.existsSync(exePath));

            // 方法1: 先尝试用协议启动（等价于你在资源管理器运行 antigravity://）
            // 方法1: 先尝试用协议启动（等价于你在资源管理器运行 antigravity://）
            const release = require('os').release();
            let isWin11 = false;
            try {
                const release = require('os').release();
                const build = parseInt(release.split('.')[2] || '0');
                isWin11 = build >= 22000;
                log('Windows 版本: ' + release + (isWin11 ? ' (Win11+)' : ' (Win10 or older)'));
            } catch (verErr) {
                log('版本检测失败，默认为非 Win11: ' + verErr.message);
                isWin11 = false;
            }

            if (isWin11) {
                log('尝试方法1: 使用 explorer antigravity:// 启动 IDE');
                try {
                    const result1 = require('child_process').execSync(
                        'explorer antigravity://',
                        { encoding: 'utf-8', timeout: 10000 }
                    );
                    log('方法1 执行成功，输出: ' + (result1 || '(无输出)'));
                    return true;
                } catch (e1) {
                    log('方法1 失败: ' + (e1.message || e1));
                }
            } else {
                log('Win10 兼容模式: 跳过协议启动，直接尝试方法2 (spawn exe)');
            }

            // 方法2: 如果知道 exe 路径，直接拉起进程
            if (exePath && fs.existsSync(exePath)) {
                log('尝试方法2: spawn 直接启动 Antigravity.exe');
                
                // 关键修复：清理环境变量，防止污染新进程
                // 避免继承当前 VS Code 的 IPC 句柄、WebView 状态等
                const cleanEnv = { ...process.env };
                Object.keys(cleanEnv).forEach(key => {
                    if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_')) {
                        delete cleanEnv[key];
                    }
                });

                const child = require('child_process').spawn(exePath, [], {
                    detached: true,
                    stdio: 'ignore',
                    env: cleanEnv // 使用干净的环境变量
                });
                child.unref();
                log('方法2 spawn 创建成功，PID: ' + child.pid);
                log('IDE 启动指令已发送');
                return true;
            } else {
                log('方法2 失败: 找不到可执行文件路径');
            }

            log('Windows 上所有启动方法都失败了!');
            return false;
            
        } else if (PLATFORM === 'darwin') {
            // macOS: 优先使用配置覆盖的路径
            let appPath = EXE_PATH_OVERRIDE.darwin && EXE_PATH_OVERRIDE.darwin.trim()
                ? EXE_PATH_OVERRIDE.darwin.trim()
                : '/Applications/Antigravity.app';
            
            log('使用的 macOS App 路径: ' + appPath);
            if (fs.existsSync(appPath)) {
                execSync(\`open "\${appPath}"\`);
                log('通过 App 路径启动成功');
                return true;
            }
            log('App 路径不存在，尝试协议启动');
            execSync('open antigravity://');
            return true;
            
        } else {
            // Linux: 优先使用配置覆盖的路径
            const possiblePaths = [];
            if (EXE_PATH_OVERRIDE.linux && EXE_PATH_OVERRIDE.linux.trim()) {
                possiblePaths.push(EXE_PATH_OVERRIDE.linux.trim());
            }
            possiblePaths.push(
                '/usr/bin/antigravity',
                '/opt/antigravity/antigravity',
                path.join(process.env.HOME || '', '.local/bin/antigravity')
            );
            
            log('Linux 尝试路径: ' + possiblePaths.join(', '));
            for (const p of possiblePaths) {
                if (fs.existsSync(p)) {
                    log('找到可执行文件: ' + p);
                    spawn(p, [], { detached: true, stdio: 'ignore' }).unref();
                    return true;
                }
            }
            
            // 尝试 xdg-open
            log('未找到可执行文件，尝试协议启动');
            try {
                execSync('xdg-open antigravity://');
                return true;
            } catch (e) {
                log('Linux 启动失败: ' + e.message);
            }
        }
    } catch (e) {
        log('启动 IDE 失败: ' + e.message);
    }
    
    return false;
}

// === 主流程 ===
async function main() {
    log('========================================');
    log('Antigravity Multi-Account Cockpit 账号切换代理启动');
    log('平台: ' + PLATFORM);
    log('数据库: ' + DB_PATH);
    log('========================================');
    
    // 1. 先等待让 VS Code 发出 quit 命令
    const initialWait = Math.max(2, Math.floor(PROCESS_WAIT_SECONDS / 5));
    log('等待 ' + initialWait + ' 秒让主进程发送退出命令...');
    await sleep(initialWait * 1000);
    
    // 2. 主动强制关闭所有 Antigravity 进程
    killAllAntigravity();
    
    // 3. 等待 IDE 进程完全退出
    const exitWait = Math.max(5, Math.floor(PROCESS_WAIT_SECONDS / 2));
    await waitForProcessExit(exitWait);
    
    // 4. 额外等待确保文件锁释放
    const releaseWait = Math.max(3, Math.floor(PROCESS_WAIT_SECONDS / 3));
    log('等待 ' + releaseWait + ' 秒确保资源完全释放...');
    await sleep(releaseWait * 1000);
    
    // 3. 注入 Token
    const injected = await injectToken();
    if (!injected) {
        log('注入失败，终止流程');
        process.exit(1);
    }
    
    // 4. 等待一下确保写入完成
    await sleep(1000);
    
    // 5. 启动 IDE
    const started = startIDE();
    if (started) {
        log('IDE 启动指令已发送');
    } else {
        log('IDE 启动失败，请手动打开 Antigravity');
    }
    
    log('========================================');
    log('账号切换流程完成');
    log('========================================');
    
    // 清理自身
    await sleep(2000);
    try {
        fs.unlinkSync(${JSON.stringify(mainScriptPath)});
    } catch (e) {}
    
    process.exit(0);
}

main().catch(e => {
    log('致命错误: ' + e.message);
    process.exit(1);
});
`;

        // 写入主脚本
        fs.writeFileSync(mainScriptPath, mainScriptContent, 'utf-8');

        // 根据平台启动独立进程
        if (platform === 'win32') {
            // Windows: 使用 VBScript 包装确保完全独立
            const vbsPath = path.join(tempDir, `ag_launch_${timestamp}.vbs`);
            // VBScript 不需要对路径中的反斜杠进行 JavaScript 风格的双转义
            const nodeExeVbs = nodeExe;
            const scriptPathVbs = mainScriptPath;
            // 使用 0 = 隐藏窗口，避免弹出控制台界面
            // 调试建议：如果怀疑脚本未运行，可暂时将 0 改为 1 以显示窗口
            const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & "${nodeExeVbs}" & Chr(34) & " " & Chr(34) & "${scriptPathVbs}" & Chr(34), 0, False
`;
            fs.writeFileSync(vbsPath, vbsContent, 'utf-8');

            const child = spawn('wscript', [vbsPath], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
            child.unref();

        } else {
            // Linux/macOS: 使用 nohup + setsid 确保独立
            const shellCmd = `nohup "${nodeExe}" "${mainScriptPath}" > "${logPath}" 2>&1 &`;

            spawn('sh', ['-c', shellCmd], {
                detached: true,
                stdio: 'ignore'
            }).unref();
        }
    }
}
