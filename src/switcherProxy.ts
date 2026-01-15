import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import { getVSCDBPath } from './constants';

export class SwitcherProxy {
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
     */
    static async executeExternalSwitch(
        accessToken: string,
        refreshToken: string,
        expiry: number,
        dbPathOverride?: string,
        exePathOverride?: { win32?: string; darwin?: string; linux?: string }
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
const PLATFORM = ${JSON.stringify(platform)};
const EXE_PATH_OVERRIDE = ${JSON.stringify(exePathOverride || {})};

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
    // 注意：IDE 已经在退出过程中，不需要主动 kill
    // 直接跳过 taskkill，避免在 VBScript 启动的进程中卡住
    log('跳过 taskkill（IDE 已在退出中）');
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

function createField6(at, rt, exp) {
    const f1 = Buffer.concat([encodeVarint((1 << 3) | 2), encodeVarint(Buffer.byteLength(at)), Buffer.from(at)]);
    const f2 = Buffer.concat([encodeVarint((2 << 3) | 2), encodeVarint(6), Buffer.from("Bearer")]);
    const f3 = Buffer.concat([encodeVarint((3 << 3) | 2), encodeVarint(Buffer.byteLength(rt)), Buffer.from(rt)]);
    
    const tsMsg = Buffer.concat([encodeVarint((1 << 3) | 0), encodeVarint(exp)]);
    const f4 = Buffer.concat([encodeVarint((4 << 3) | 2), encodeVarint(tsMsg.length), tsMsg]);
    
    const info = Buffer.concat([f1, f2, f3, f4]);
    return Buffer.concat([encodeVarint((6 << 3) | 2), encodeVarint(info.length), info]);
}

// === 注入 Token ===
async function injectToken() {
    log('开始注入 Token 到数据库...');
    
    if (!fs.existsSync(DB_PATH)) {
        log('错误: 数据库文件不存在: ' + DB_PATH);
        return false;
    }
    
    try {
        // 先做一次完整备份，避免注入失败导致 IDE 无法启动
        try {
            const backupPath = DB_PATH + '.ag-backup-' + Date.now();
            fs.copyFileSync(DB_PATH, backupPath);
            log('已创建数据库备份: ' + backupPath);
        } catch (e) {
            log('创建数据库备份失败（将继续尝试注入）: ' + (e.message || e));
        }

        // 动态加载 sqlite3
        module.paths.push(NODE_MODULES);
        const sqlite3 = require('sqlite3');
        
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(DB_PATH);
            const AG_KEY = 'jetskiStateSync.agentManagerInitState';
            const ONBOARD_KEY = 'antigravityOnboarding';
            
            db.get("SELECT value FROM ItemTable WHERE key = ?", [AG_KEY], (err, row) => {
                if (err || !row) {
                    log('错误: 无法读取数据库 - ' + (err || 'key 不存在'));
                    db.close();
                    resolve(false);
                    return;
                }
                
                try {
                    const blob = Buffer.from(row.value, 'base64');
                    const clean = removeField(blob, 6);
                    const newField = createField6(ACCESS_TOKEN, REFRESH_TOKEN, EXPIRY);
                    const finalB64 = Buffer.concat([clean, newField]).toString('base64');
                    
                    db.serialize(() => {
                        db.run("UPDATE ItemTable SET value = ? WHERE key = ?", [finalB64, AG_KEY]);
                        db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", [ONBOARD_KEY, "true"], () => {
                            db.close();
                            log('Token 注入成功!');
                            resolve(true);
                        });
                    });
                } catch (e) {
                    log('注入逻辑错误: ' + e.message);
                    db.close();
                    resolve(false);
                }
            });
        });
    } catch (e) {
        log('sqlite3 加载失败: ' + e.message);
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

            // 方法2: 如果知道 exe 路径，直接拉起进程
            if (fs.existsSync(exePath)) {
                log('尝试方法2: spawn 直接启动 Antigravity.exe');
                try {
                    const child = require('child_process').spawn(exePath, [], {
                        detached: true,
                        stdio: ['ignore', 'ignore', 'ignore'],
                        windowsHide: false
                    });

                    log('方法2 spawn 创建成功，PID: ' + (child.pid || 'unknown'));
                    child.unref();
                    return true;
                } catch (e2) {
                    log('方法2 失败: ' + (e2.message || e2));
                }
            } else {
                log('方法2 跳过：推测的 exePath 不存在');
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
    log('Antigravity Cockpit 账号切换代理启动');
    log('平台: ' + PLATFORM);
    log('数据库: ' + DB_PATH);
    log('========================================');
    
    // 1. 先等待 2 秒让 VS Code 发出 quit 命令
    log('等待 2 秒让主进程发送退出命令...');
    await sleep(2000);
    
    // 2. 主动强制关闭所有 Antigravity 进程
    killAllAntigravity();
    
    // 3. 等待 IDE 进程完全退出（简化为固定等待 5 秒）
    await waitForProcessExit(5);
    
    // 4. 额外等待确保文件锁释放
    log('等待 3 秒确保资源完全释放...');
    await sleep(3000);
    
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
            // VBScript 中双引号需要用 "" 转义，路径中的反斜杠保持不变
            const nodeExeVbs = nodeExe.replace(/\\/g, '\\\\');
            const scriptPathVbs = mainScriptPath.replace(/\\/g, '\\\\');
            // 使用 1 而不是 0，让 Node.js 进程有桌面访问权限
            // 0 = 隐藏窗口，可能导致无法启动 GUI 程序
            // 1 = 正常窗口，有桌面访问权限
            const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & "${nodeExeVbs}" & Chr(34) & " " & Chr(34) & "${scriptPathVbs}" & Chr(34), 1, False
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
