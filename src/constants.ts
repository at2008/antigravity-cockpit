import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const CLIENT_SECRET = "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";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const QUOTA_API_ENDPOINTS = [
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
    "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"
];

export const LOAD_CODE_ASSIST_ENDPOINTS = [
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
    "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
];

export const QUOTA_API_URL = QUOTA_API_ENDPOINTS[0];
export const LOAD_CODE_ASSIST_URL = LOAD_CODE_ASSIST_ENDPOINTS[0];

/** 旧配置目录（保留兼容，仅用于迁移检测） */
export const OLD_DATA_DIR = path.join(os.homedir(), ".antigravity_tools");
/** 新配置目录 */
export const DATA_DIR = path.join(os.homedir(), ".antigravity_cockpit");
export const ACCOUNTS_INDEX_FILE = path.join(DATA_DIR, "accounts.json");
export const ACCOUNTS_DIR = path.join(DATA_DIR, "accounts");

/** 生效客户端类型定义 */
export type TargetClient = 'all' | 'ide' | 'app_cli';

export interface ClientDbInfo {
    client: 'ide' | 'app_cli';
    name: string;
    path: string;
    exists: boolean;
}

/**
 * 从旧目录 (~/.antigravity_tools) 复制配置到新目录 (~/.antigravity_cockpit)。
 * - 仅在旧目录存在 且 新目录不存在时执行
 * - 采用复制方式，旧目录和文件原样保留
 * - 只会执行一次，后续启动新目录已存在则跳过
 */
export function migrateDataDir(): void {
    // 新目录已存在 → 无需迁移
    if (fs.existsSync(DATA_DIR)) {
        return;
    }

    // 旧目录不存在 → 全新安装，无需迁移
    if (!fs.existsSync(OLD_DATA_DIR)) {
        return;
    }

    try {
        console.log(`[Cockpit] 检测到旧配置目录: ${OLD_DATA_DIR}，开始复制到 ${DATA_DIR}`);
        copyDirRecursive(OLD_DATA_DIR, DATA_DIR);
        console.log(`[Cockpit] 配置迁移完成。旧目录已保留。`);
    } catch (err) {
        console.error(`[Cockpit] 配置迁移失败:`, err);
        // 迁移失败不影响正常启动，用户可手动复制
    }
}

/**
 * 递归复制目录（纯 Node.js，不依赖 fs.cpSync 以兼容低版本 Node 16）
 */
function copyDirRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });

    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * 获取指定客户端类型的候选数据库路径列表
 * 规则：
 * - 如果提供了 overridePath，优先仅使用 overridePath
 * - target === 'ide': 包含 IDE 2.6+ 共享目录 (Antigravity) 与旧版 IDE 目录 (Antigravity IDE <= 2.5.5)
 * - target === 'app_cli': 包含 Antigravity 工具端/桌面端路径
 * - target === 'all' (默认): 包含两者
 */
export function getAntigravityDbCandidates(target: TargetClient = 'all', overridePath?: string): ClientDbInfo[] {
    if (overridePath && overridePath.trim()) {
        const p = overridePath.trim();
        return [{
            client: 'ide',
            name: 'Override DB',
            path: p,
            exists: fs.existsSync(p)
        }];
    }

    const platform = os.platform();
    const candidates: ClientDbInfo[] = [];

    let sharedPath = '';
    let legacyIdePath = '';

    if (platform === 'win32') {
        const appData = process.env.APPDATA || '';
        sharedPath = path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
        legacyIdePath = path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
    } else if (platform === 'darwin') {
        const home = os.homedir();
        sharedPath = path.join(home, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
        legacyIdePath = path.join(home, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
    } else {
        const home = os.homedir();
        sharedPath = path.join(home, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
        legacyIdePath = path.join(home, '.config', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
    }

    if (target === 'all') {
        candidates.push({ client: 'ide', name: 'Antigravity (IDE 2.6+ & Desktop)', path: sharedPath, exists: fs.existsSync(sharedPath) });
        candidates.push({ client: 'ide', name: 'Antigravity IDE (Legacy <= 2.5.5)', path: legacyIdePath, exists: fs.existsSync(legacyIdePath) });
    } else if (target === 'ide') {
        candidates.push({ client: 'ide', name: 'Antigravity (IDE 2.6+)', path: sharedPath, exists: fs.existsSync(sharedPath) });
        candidates.push({ client: 'ide', name: 'Antigravity IDE (Legacy <= 2.5.5)', path: legacyIdePath, exists: fs.existsSync(legacyIdePath) });
    } else if (target === 'app_cli') {
        candidates.push({ client: 'app_cli', name: 'Antigravity Desktop/Tool', path: sharedPath, exists: fs.existsSync(sharedPath) });
    }

    return candidates;
}

/**
 * 获取符合条件且实际存在的数据库路径列表。
 * 如果都不存在，在 target 为 'all' 或包含该客户端时，返回默认的主候选路径以防报错。
 */
export function getActiveDbPaths(target: TargetClient = 'all', overridePath?: string): string[] {
    const candidates = getAntigravityDbCandidates(target, overridePath);
    const existing = candidates.filter(c => c.exists).map(c => c.path);
    if (existing.length > 0) {
        return existing;
    }
    return candidates.length > 0 ? [candidates[0].path] : [getVSCDBPath(overridePath, target)];
}

/**
 * 获取 Antigravity IDE 的全局状态数据库路径
 * @param overridePath 配置中的覆盖路径（可选）
 * @param target 目标客户端（可选）
 * @returns 数据库文件路径
 */
export function getVSCDBPath(overridePath?: string, target: TargetClient = 'all'): string {
    if (overridePath && overridePath.trim()) {
        return overridePath.trim();
    }

    const candidates = getAntigravityDbCandidates(target);
    const found = candidates.find(c => c.exists);
    if (found) {
        return found.path;
    }
    return candidates.length > 0 ? candidates[0].path : '';
}

// 向后兼容：保留常量导出（使用默认路径）
export const VSCDB_PATH = getVSCDBPath();

export const CLI_SESSION_PATH = path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token');

export const IMPORTANT_MODELS = ["gemini", "claude"];
export const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export const OAUTH_SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const DB_KEY_AGENT_STATE = "jetskiStateSync.agentManagerInitState";
export const DB_KEY_UNIFIED_STATE = "antigravityUnifiedStateSync.oauthToken";
export const DB_KEY_ONBOARDING = "antigravityOnboarding";
