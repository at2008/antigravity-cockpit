import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import { getVSCDBPath } from './constants';
import { t } from './i18n';
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
     * 在 Windows 系统下，采用三层融合探测法寻找真实的 Antigravity IDE 可执行文件绝对路径
     */
    private static getWindowsIdePath(overridePath?: string): string {
        if (overridePath && overridePath.trim()) {
            return overridePath.trim();
        }

        // 1. 尝试从注册表 URL Scheme 中获取路径 (antigravity-ide 协议)
        const regKeys = [
            'HKCU\\Software\\Classes\\antigravity-ide\\shell\\open\\command',
            'HKLM\\Software\\Classes\\antigravity-ide\\shell\\open\\command'
        ];
        
        for (const key of regKeys) {
            try {
                const output = execSync(`reg query "${key}" /ve`, { 
                    encoding: 'utf-8', 
                    stdio: ['ignore', 'pipe', 'ignore'],
                    windowsHide: true 
                });
                const match = output.match(/REG_SZ\s+"([^"]+)"/i) || output.match(/REG_SZ\s+(.+)$/im);
                if (match && match[1]) {
                    const exePath = match[1].trim();
                    if (fs.existsSync(exePath)) {
                        return exePath;
                    }
                }
            } catch (e) {
                // 忽略
            }
        }

        // 2. 尝试从 Uninstall 注册表模糊匹配
        const uninstallKeys = [
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
        ];
        for (const ukey of uninstallKeys) {
            try {
                const searchOutput = execSync(`reg query "${ukey}" /s /f "Antigravity IDE"`, {
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    windowsHide: true
                });
                const lines = searchOutput.split('\n');
                let foundSubKey = '';
                for (const line of lines) {
                    if (line.trim().startsWith('HKEY_')) {
                        foundSubKey = line.trim();
                        break; 
                    }
                }
                if (foundSubKey) {
                    const iconOutput = execSync(`reg query "${foundSubKey}" /v "DisplayIcon"`, {
                        encoding: 'utf-8',
                        stdio: ['ignore', 'pipe', 'ignore'],
                        windowsHide: true
                    });
                    const iconMatch = iconOutput.match(/REG_SZ\s+"([^"]+)"/i) || iconOutput.match(/REG_SZ\s+(.+)$/im);
                    if (iconMatch && iconMatch[1]) {
                        const iconPath = iconMatch[1].trim().replace(/"/g, '');
                        if (fs.existsSync(iconPath)) {
                            return iconPath;
                        }
                    }
                    
                    const locOutput = execSync(`reg query "${foundSubKey}" /v "InstallLocation"`, {
                        encoding: 'utf-8',
                        stdio: ['ignore', 'pipe', 'ignore'],
                        windowsHide: true
                    });
                    const locMatch = locOutput.match(/REG_SZ\s+"([^"]+)"/i) || locOutput.match(/REG_SZ\s+(.+)$/im);
                    if (locMatch && locMatch[1]) {
                        const locPath = locMatch[1].trim().replace(/"/g, '');
                        const exePath = path.join(locPath, 'Antigravity IDE.exe');
                        if (fs.existsSync(exePath)) {
                            return exePath;
                        }
                    }
                }
            } catch (e) {
                // 忽略
            }
        }

        // 3. Fallback: 物理磁盘多路径探测
        const localAppData = process.env.LOCALAPPDATA || '';
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

        const possibleDirs = [
            path.join(localAppData, 'Programs', 'Antigravity IDE'),
            path.join(localAppData, 'Programs', 'Antigravity'),
            path.join(programFiles, 'Antigravity IDE'),
            path.join(programFilesX86, 'Antigravity IDE'),
            path.join(programFiles, 'Antigravity'),
            path.join(programFilesX86, 'Antigravity')
        ];

        for (const dir of possibleDirs) {
            const newExe = path.join(dir, 'Antigravity IDE.exe');
            if (fs.existsSync(newExe)) {
                return newExe;
            }
        }

        // 最终兜底
        return path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe');
    }

    /**
     * 在 macOS 系统下，采用三层融合探测法寻找真实的 Antigravity IDE 可执行文件（App Bundle）绝对路径
     */
    private static getDarwinIdePath(overridePath?: string): string {
        if (overridePath && overridePath.trim()) {
            return overridePath.trim();
        }

        // 1. 尝试使用 osascript 动态查询 Launch Services 数据库 (高优先匹配新版)
        const appsToQuery = ['Antigravity IDE', 'Antigravity'];
        for (const appName of appsToQuery) {
            try {
                const output = execSync(`osascript -e 'POSIX path of (path to application "${appName}")'`, {
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'ignore']
                }).trim();
                if (output && fs.existsSync(output)) {
                    return output;
                }
            } catch (e) {
                // 忽略
            }
        }

        // 2. Fallback: 物理磁盘多路径探测
        const home = process.env.HOME || '';
        const possibleApps = [
            '/Applications/Antigravity IDE.app',
            path.join(home, 'Applications', 'Antigravity IDE.app'),
            '/Applications/Antigravity.app',
            path.join(home, 'Applications', 'Antigravity.app')
        ];

        for (const appPath of possibleApps) {
            if (fs.existsSync(appPath)) {
                return appPath;
            }
        }

        // 最终兜底
        return '/Applications/Antigravity IDE.app';
    }

    /**
     * 在 Linux 系统下，采用三层融合探测法寻找真实的 Antigravity IDE 可执行文件绝对路径
     */
    private static getLinuxIdePath(overridePath?: string): string {
        if (overridePath && overridePath.trim()) {
            return overridePath.trim();
        }

        // 1. 尝试使用 which 检索全局环境变量 (高优先匹配新版)
        const commands = ['antigravity-ide', 'antigravity'];
        for (const cmd of commands) {
            try {
                const output = execSync(`which ${cmd}`, {
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'ignore']
                }).trim();
                if (output && fs.existsSync(output)) {
                    return output;
                }
            } catch (e) {
                // 忽略
            }
        }

        // 2. Fallback: 物理磁盘多路径探测
        const home = process.env.HOME || '';
        const possiblePaths = [
            '/usr/bin/antigravity-ide',
            '/usr/local/bin/antigravity-ide',
            '/opt/antigravity-ide/antigravity-ide',
            '/snap/bin/antigravity-ide',
            path.join(home, '.local/bin/antigravity-ide'),
            '/usr/bin/antigravity',
            '/usr/local/bin/antigravity',
            '/opt/antigravity/antigravity',
            '/snap/bin/antigravity',
            path.join(home, '.local/bin/antigravity')
        ];

        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                return p;
            }
        }

        // 最终兜底
        return '/usr/bin/antigravity-ide';
    }

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
            result.nodeJs = { ok: false, error: t('nodeNotFound') };
            result.success = false;
            result.suggestions.push(t('nodeInstallTip'));
        }

        // 2. 检查 npm (用于外部脚本运行环境)
        try {
            const npmCmd = platform === 'win32' ? 'npm.cmd --version' : 'npm --version';
            const npmVersion = execSync(npmCmd, { encoding: 'utf-8', windowsHide: true }).trim();
            result.npm = { ok: true, version: npmVersion };
        } catch (e) {
            result.npm = { ok: false, error: t('npmNotAvailable') };
            // npm 不是必须的，不影响 success
            result.suggestions.push(t('npmInstallTip'));
        }

        // 3. 检查数据库文件
        const actualDbPath = dbPathOverride && dbPathOverride.trim()
            ? dbPathOverride.trim()
            : getVSCDBPath();

        if (fs.existsSync(actualDbPath)) {
            result.database = { ok: true, path: actualDbPath };
        } else {
            result.database = { ok: false, path: actualDbPath, error: t('dbNotFound') };
            result.success = false;
            result.suggestions.push(t('dbNotFoundTip', actualDbPath));
            result.suggestions.push(t('dbNotExists'));
        }

        // 4. 检查 IDE 可执行文件
        let idePath = '';
        if (platform === 'win32') {
            idePath = SwitcherProxy.getWindowsIdePath(exePathOverride?.win32);
        } else if (platform === 'darwin') {
            idePath = SwitcherProxy.getDarwinIdePath(exePathOverride?.darwin);
        } else {
            idePath = SwitcherProxy.getLinuxIdePath(exePathOverride?.linux);
        }

        if (idePath && fs.existsSync(idePath)) {
            result.ide = { ok: true, path: idePath };
        } else {
            result.ide = { ok: false, path: idePath, error: t('ideNotFound') };
            // IDE 路径问题不是致命的，可以通过协议启动
            result.suggestions.push(t('ideNotExists', idePath || '(未知)'));
            result.suggestions.push(t('ideManualStartTip'));
        }

        return result;
    }

    /**
     * 格式化环境检查结果为用户可读的消息
     */
    static formatCheckResult(result: EnvironmentCheckResult): string {
        const lines: string[] = [];
        lines.push(t('envCheckResultTitle'));

        lines.push(`- Node.js: ${result.nodeJs.ok ? '✅ ' + result.nodeJs.path : '❌ ' + result.nodeJs.error}`);
        lines.push(`- npm: ${result.npm.ok ? '✅ v' + result.npm.version : '⚠️ ' + result.npm.error}`);
        lines.push(`- ${t('envCheckDb')}: ${result.database.ok ? '✅ ' + t('envCheckExists') : '❌ ' + result.database.error}`);
        lines.push(`- ${t('envCheckIde')}: ${result.ide.ok ? '✅ ' + t('envCheckExists') : '⚠️ ' + result.ide.error}`);

        if (result.suggestions.length > 0) {
            lines.push(t('suggestionsTitle'));
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
const SQL_JS_PATH = path.join(NODE_MODULES, 'sql.js');
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
            const result = execSync('tasklist /NH 2>nul', { encoding: 'utf-8', shell: true, windowsHide: true });
            const lower = result.toLowerCase();
            const running = lower.includes('antigravity.exe') || lower.includes('antigravity ide.exe');
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
            // Windows: 使用 taskkill 强制关闭所有 Antigravity.exe 和 Antigravity IDE.exe 进程
            try {
                execSync('taskkill /F /IM Antigravity.exe /T 2>nul', { 
                    encoding: 'utf-8', 
                    shell: true, 
                    windowsHide: true,
                    timeout: 10000
                });
            } catch (e) {
                log('taskkill Antigravity.exe 完成（可能没有运行中的进程）: ' + (e.message || ''));
            }
            try {
                execSync('taskkill /F /IM "Antigravity IDE.exe" /T 2>nul', { 
                    encoding: 'utf-8', 
                    shell: true, 
                    windowsHide: true,
                    timeout: 10000
                });
            } catch (e) {
                log('taskkill Antigravity IDE.exe 完成（可能没有运行中的进程）: ' + (e.message || ''));
            }
            log('taskkill 命令已执行');
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

// === 备份清理函数 ===
function cleanOldBackups(dbPath, maxBackups = 5) {
    try {
        const dir = path.dirname(dbPath);
        const base = path.basename(dbPath);
        const files = fs.readdirSync(dir);
        
        // 筛选以 state.vscdb.ag-backup- 开头的文件
        const backupPrefix = base + '.ag-backup-';
        const backups = files
            .filter(f => f.startsWith(backupPrefix))
            .map(f => {
                const fullPath = path.join(dir, f);
                let stat;
                try {
                    stat = fs.statSync(fullPath);
                } catch (e) {
                    return null;
                }
                return { name: f, path: fullPath, mtime: stat.mtimeMs };
            })
            .filter(item => item !== null)
            // 按修改时间从新到旧排序
            .sort((a, b) => b.mtime - a.mtime);
            
        if (backups.length > maxBackups) {
            const filesToDelete = backups.slice(maxBackups);
            log('检测到备份数量 ' + backups.length + ' 超出限制 ' + maxBackups + '，开始清理历史垃圾...');
            for (const file of filesToDelete) {
                try {
                    fs.unlinkSync(file.path);
                    log('删除超期备份: ' + file.name);
                } catch (err) {
                    log('删除备份失败: ' + file.name + ', error: ' + err.message);
                }
            }
        }
    } catch (e) {
        log('自动清理备份异常: ' + e.message);
    }
}

// === 加载 sql.js (纯 WASM，无原生依赖) ===
async function loadSqlJs() {
    module.paths.push(NODE_MODULES);
    const initSqlJs = require(SQL_JS_PATH);
    const SQL = await initSqlJs();
    log('sql.js (WASM) 加载成功');
    return SQL;
}

// === 注入 Token ===
async function injectToken() {
    log('开始注入 Token 到数据库...');
    
    if (!fs.existsSync(DB_PATH)) {
        log('错误: 数据库文件不存在: ' + DB_PATH);
        return false;
    }
    
    let backupPath = '';
    try {
        try {
            backupPath = DB_PATH + '.ag-backup-' + Date.now();
            fs.copyFileSync(DB_PATH, backupPath);
            log('已创建数据库备份: ' + backupPath);
            
            // 限制最多 5 次备份，删除其余过旧的
            cleanOldBackups(DB_PATH, 5);
        } catch (e) {
            log('创建或清理数据库备份失败（将继续尝试注入）: ' + (e.message || e));
        }

        // 加载 sql.js (纯 WASM，无原生模块兼容性问题)
        const SQL = await loadSqlJs();
        const dbBuffer = fs.readFileSync(DB_PATH);
        
        // SQLite 头部魔数魔数防 WASM 崩溃的前置合法性拦截
        if (dbBuffer.length > 0) {
            const magic = dbBuffer.toString('utf-8', 0, 15);
            if (!magic.startsWith('SQLite format 3')) {
                throw new Error('数据库文件损坏或非 SQLite 3 格式');
            }
        } else {
            throw new Error('数据库文件大小为 0');
        }

        const db = new SQL.Database(dbBuffer);
        
        const KEY_OLD = 'jetskiStateSync.agentManagerInitState';
        const KEY_NEW = 'antigravityUnifiedStateSync.oauthToken';
        const KEY_ONBOARD = 'antigravityOnboarding';
        
        // 1. 新格式注入
        try {
            const oauthInfo = createOAuthInfo(ACCESS_TOKEN, REFRESH_TOKEN, EXPIRY);
            const oauthInfoB64 = oauthInfo.toString('base64');
            const inner2 = encodeStringField(1, oauthInfoB64);
            const inner1 = encodeStringField(1, "oauthTokenInfoSentinelKey");
            const inner = Buffer.concat([inner1, encodeLenDelim(2, inner2)]);
            const outer = encodeLenDelim(1, inner);
            const outerB64 = outer.toString('base64');
            
            db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", [KEY_NEW, outerB64]);
            log('新格式注入成功');
        } catch (e) {
            log('新格式注入异常: ' + e.message);
        }

        // 2. 旧格式注入
        try {
            const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
            stmt.bind([KEY_OLD]);
            if (stmt.step()) {
                const row = stmt.getAsObject();
                const blob = Buffer.from(row.value, 'base64');
                let clean = removeField(blob, 1); // 移除 UserID
                clean = removeField(clean, 2); // 移除 Email
                clean = removeField(clean, 6); // 移除 OAuthTokenInfo
                
                const emailField = createEmailField(EMAIL);
                const tokenField = createOldFormatField(ACCESS_TOKEN, REFRESH_TOKEN, EXPIRY);
                const finalB64 = Buffer.concat([clean, emailField, tokenField]).toString('base64');
                
                db.run("UPDATE ItemTable SET value = ? WHERE key = ?", [finalB64, KEY_OLD]);
                log('旧格式注入成功');
            } else {
                log('旧格式跳过: key 不存在');
            }
            stmt.free();
        } catch (e) {
            log('旧格式注入异常: ' + e.message);
        }

        // 3. Onboarding 标记
        db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", [KEY_ONBOARD, "true"]);
        
        // 4. 擦除旧账号可能残留的冲突缓存键，迫使新版 IDE 启动时使用新 Token 触发自愈拉取与状态重建
        db.run("DELETE FROM ItemTable WHERE key = ?", ["antigravityAuthStatus"]);
        db.run("DELETE FROM ItemTable WHERE key = ?", ["antigravityUnifiedStateSync.userStatus"]);
        
        // 写回磁盘
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
        log('数据库写回磁盘成功');
        
        db.close();
        return true;
    } catch (e) {
        log('注入流程异常: ' + e.message);
        // 如果有备份文件，且注入异常，执行自动回滚还原数据库
        if (backupPath && fs.existsSync(backupPath)) {
            try {
                fs.copyFileSync(backupPath, DB_PATH);
                log('🚨 注入流程异常已触发自动回滚还原数据库！');
            } catch (rollbackErr) {
                log('🚨 严重错误：自动回滚失败: ' + (rollbackErr.message || rollbackErr));
            }
        }
        return false;
    }
}

// === 启动 IDE ===
function startIDE() {
    log('正在启动 Antigravity IDE...');
    
    try {
        if (PLATFORM === 'win32') {
            // 优先使用配置覆盖的路径
            let exePath = '';
            const override = EXE_PATH_OVERRIDE.win32 && EXE_PATH_OVERRIDE.win32.trim();
            if (override) {
                exePath = override;
            } else {
                // 三层融合探测法寻找真实的 Antigravity IDE 可执行文件绝对路径
                // 1. 尝试从注册表 URL Scheme 中获取路径 (antigravity-ide 协议)
                const regKeys = [
                    'HKCU\\Software\\Classes\\antigravity-ide\\shell\\open\\command',
                    'HKLM\\Software\\Classes\\antigravity-ide\\shell\\open\\command'
                ];
                
                for (const key of regKeys) {
                    try {
                        const output = execSync('reg query "' + key + '" /ve', { 
                            encoding: 'utf-8', 
                            stdio: ['ignore', 'pipe', 'ignore'],
                            windowsHide: true 
                        });
                        const match = output.match(/REG_SZ\\s+"([^"]+)"/i) || output.match(/REG_SZ\\s+(.+)$/im);
                        if (match && match[1]) {
                            const p = match[1].trim();
                            if (fs.existsSync(p)) {
                                exePath = p;
                                break;
                            }
                        }
                    } catch (e) {}
                }

                // 2. 尝试从 Uninstall 注册表模糊匹配
                if (!exePath) {
                    const uninstallKeys = [
                        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
                        'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
                    ];
                    for (const ukey of uninstallKeys) {
                        try {
                            const searchOutput = execSync('reg query "' + ukey + '" /s /f "Antigravity IDE"', {
                                encoding: 'utf-8',
                                stdio: ['ignore', 'pipe', 'ignore'],
                                windowsHide: true
                            });
                            const lines = searchOutput.split('\\n');
                            let foundSubKey = '';
                            for (const line of lines) {
                                if (line.trim().startsWith('HKEY_')) {
                                    foundSubKey = line.trim();
                                    break; 
                                }
                            }
                            if (foundSubKey) {
                                const iconOutput = execSync('reg query "' + foundSubKey + '" /v "DisplayIcon"', {
                                    encoding: 'utf-8',
                                    stdio: ['ignore', 'pipe', 'ignore'],
                                    windowsHide: true
                                });
                                const iconMatch = iconOutput.match(/REG_SZ\\s+"([^"]+)"/i) || iconOutput.match(/REG_SZ\\s+(.+)$/im);
                                if (iconMatch && iconMatch[1]) {
                                    const iconPath = iconMatch[1].trim().replace(/"/g, '');
                                    if (fs.existsSync(iconPath)) {
                                        exePath = iconPath;
                                        break;
                                    }
                                }
                                
                                const locOutput = execSync('reg query "' + foundSubKey + '" /v "InstallLocation"', {
                                    encoding: 'utf-8',
                                    stdio: ['ignore', 'pipe', 'ignore'],
                                    windowsHide: true
                                });
                                const locMatch = locOutput.match(/REG_SZ\\s+"([^"]+)"/i) || locOutput.match(/REG_SZ\\s+(.+)$/im);
                                if (locMatch && locMatch[1]) {
                                    const locPath = locMatch[1].trim().replace(/"/g, '');
                                    const p = path.join(locPath, 'Antigravity IDE.exe');
                                    if (fs.existsSync(p)) {
                                        exePath = p;
                                        break;
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                }

                // 3. Fallback: 物理磁盘探测
                if (!exePath) {
                    const localAppData = process.env.LOCALAPPDATA || '';
                    const programFiles = process.env.ProgramFiles || 'C:/Program Files';
                    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';

                    const possibleDirs = [
                        path.join(localAppData, 'Programs', 'Antigravity IDE'),
                        path.join(localAppData, 'Programs', 'Antigravity'),
                        path.join(programFiles, 'Antigravity IDE'),
                        path.join(programFilesX86, 'Antigravity IDE'),
                        path.join(programFiles, 'Antigravity'),
                        path.join(programFilesX86, 'Antigravity')
                    ];

                    for (const dir of possibleDirs) {
                        const p = path.join(dir, 'Antigravity IDE.exe');
                        if (fs.existsSync(p)) {
                            exePath = p;
                            break;
                        }
                    }
                }

                // 4. 最终兜底
                if (!exePath) {
                    exePath = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe');
                }
            }
            
            log('LOCALAPPDATA: ' + (process.env.LOCALAPPDATA || ''));
            log('使用的 IDE 路径: ' + exePath);
            log('路径是否存在: ' + fs.existsSync(exePath));

            // 方法1: 优先尝试直接启动物理文件路径（spawn 速度极快且完全无弹错风险）
            if (exePath && fs.existsSync(exePath)) {
                if (isAntigravityRunning()) {
                    log('物理启动跳过: 检测到 Antigravity 进程已经在运行');
                    return true;
                }
                
                log('尝试直接 spawn 启动 IDE 可执行文件: ' + exePath);
                
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
                log('spawn 直接启动创建成功，PID: ' + child.pid);
                log('IDE 启动指令已发送');
                return true;
            }

            // 方法2: 如果物理文件不存在，再尝试使用注册表协议启动（降级容错机制）
            log('物理路径不存在，降级尝试使用协议启动 (explorer antigravity://)');
            const release = require('os').release();
            let isWin11 = false;
            try {
                const build = parseInt(release.split('.')[2] || '0');
                isWin11 = build >= 22000;
                log('Windows 版本: ' + release + (isWin11 ? ' (Win11+)' : ' (Win10 or older)'));
            } catch (verErr) {
                log('版本检测失败，默认为非 Win11: ' + verErr.message);
                isWin11 = false;
            }

            if (isWin11) {
                try {
                    const result1 = require('child_process').execSync(
                        'explorer antigravity://',
                        { encoding: 'utf-8', timeout: 10000 }
                    );
                    log('协议启动执行成功，输出: ' + (result1 || '(无输出)'));
                    return true;
                } catch (e1) {
                    log('协议启动抛出异常: ' + (e1.message || e1));
                    log('等待 3 秒后检测 IDE 进程是否已启动...');
                    
                    try {
                        require('child_process').execSync(
                            'ping -n 4 127.0.0.1 > nul',
                            { encoding: 'utf-8', windowsHide: true, timeout: 10000 }
                        );
                    } catch (waitErr) {}
                    
                    if (isAntigravityRunning()) {
                        log('协议启动检测成功 (进程已在运行)');
                        return true;
                    }
                }
            }
            
            log('Windows 上所有启动方法都失败了!');
            return false;
            
        } else if (PLATFORM === 'darwin') {
            // macOS: 优先使用配置覆盖的路径，否则自动检测新版 2.0，最后退化到 1.x
            let appPath = '';
            const override = EXE_PATH_OVERRIDE.darwin && EXE_PATH_OVERRIDE.darwin.trim();
            if (override) {
                appPath = override;
            } else {
                const newApp = '/Applications/Antigravity IDE.app';
                const oldApp = '/Applications/Antigravity.app';
                appPath = fs.existsSync(newApp) ? newApp : oldApp;
            }
            
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
            // Linux: 优先使用配置覆盖的路径，否则采用三层融合探测
            let exePath = '';
            const override = EXE_PATH_OVERRIDE.linux && EXE_PATH_OVERRIDE.linux.trim();
            if (override) {
                exePath = override;
            } else {
                // 1. 尝试使用 which 检索全局环境变量
                const commands = ['antigravity-ide', 'antigravity'];
                for (const cmd of commands) {
                    try {
                        const output = execSync('which ' + cmd, {
                            encoding: 'utf-8',
                            stdio: ['ignore', 'pipe', 'ignore']
                        }).trim();
                        if (output && fs.existsSync(output)) {
                            exePath = output;
                            break;
                        }
                    } catch (e) {}
                }

                // 2. Fallback: 物理磁盘多路径探测
                if (!exePath) {
                    const home = process.env.HOME || '';
                    const possiblePaths = [
                        '/usr/bin/antigravity-ide',
                        '/usr/local/bin/antigravity-ide',
                        '/opt/antigravity-ide/antigravity-ide',
                        '/snap/bin/antigravity-ide',
                        path.join(home, '.local/bin/antigravity-ide'),
                        '/usr/bin/antigravity',
                        '/usr/local/bin/antigravity',
                        '/opt/antigravity/antigravity',
                        '/snap/bin/antigravity',
                        path.join(home, '.local/bin/antigravity')
                    ];

                    for (const p of possiblePaths) {
                        if (fs.existsSync(p)) {
                            exePath = p;
                            break;
                        }
                    }
                }

                // 3. 兜底
                if (!exePath) {
                    exePath = '/usr/bin/antigravity-ide';
                }
            }
            
            log('Linux 尝试启动路径: ' + exePath);
            if (fs.existsSync(exePath)) {
                log('找到可执行文件: ' + exePath);
                spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
                return true;
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
