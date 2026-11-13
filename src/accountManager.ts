import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import {
    ACCOUNTS_INDEX_FILE,
    ACCOUNTS_DIR,
    CLIENT_ID,
    CLIENT_SECRET,
    TOKEN_URL,
    USERINFO_URL,
    QUOTA_API_URL,
    LOAD_CODE_ASSIST_URL,
    QUOTA_API_ENDPOINTS,
    LOAD_CODE_ASSIST_ENDPOINTS,
    QUOTA_SUMMARY_ENDPOINTS,
    ANTIGRAVITY_USER_AGENT
} from './constants';

export interface TokenInfo {
    access_token: string;
    refresh_token: string;
    expiry_timestamp: number;
    email: string;
    id_token?: string;
}

export interface QuotaBucket {
    bucketId: string;
    window: '5h' | 'weekly' | string;
    remainingFraction: number;
    percentage: number;
    resetTime: string;
    resetTimeRaw: string;
    displayName?: string;
    description?: string;
}

export interface QuotaGroup {
    displayName: string;
    description?: string;
    buckets: QuotaBucket[];
}

export interface QuotaModel {
    name: string;
    percentage: number;
    reset_time: string;
    reset_time_raw: string;
    has_5h?: boolean;
    weekly_percentage?: number;
    weekly_reset_time?: string;
    weekly_reset_time_raw?: string;
    has_weekly?: boolean;
}

export interface QuotaResult {
    is_forbidden: boolean;
    is_error?: boolean;
    error_status?: number;
    error_message?: string;
    models: QuotaModel[];
    tier?: string | null;
    quota_groups?: QuotaGroup[];
}

export interface CachedQuotaInfo {
    data: QuotaResult | any;
    fetched_at: number;
}

export interface Account {
    id: string;
    email: string;
    name: string;
    created_at: number;
    last_used: number;
    disabled: boolean;
    token?: TokenInfo;
    cached_quota?: CachedQuotaInfo;
}

export interface AccountSummary {
    id: string;
    email: string;
    name: string;
    created_at: number;
    last_used: number;
}

export interface AccountIndex {
    accounts: AccountSummary[];
    current_account_id: string | null;
    ui_state?: {
        currentView?: string;
        listSortKey?: string;
        listSortOrder?: string;
    };
}

export class AccountManager {
    static loadIndex(): AccountIndex {
        let index: AccountIndex = { accounts: [], current_account_id: null };

        if (fs.existsSync(ACCOUNTS_INDEX_FILE)) {
            try {
                index = JSON.parse(fs.readFileSync(ACCOUNTS_INDEX_FILE, 'utf8'));
            } catch (e) {
                console.error('[Cockpit] Failed to load account index, will rebuild from disk', e);
            }
        }

        // 自愈机制：检测磁盘账号文件数量 vs 索引条目数
        // 如果索引缺失严重（磁盘文件比索引多 2 个以上），自动从磁盘重建
        try {
            if (fs.existsSync(ACCOUNTS_DIR)) {
                const diskFiles = fs.readdirSync(ACCOUNTS_DIR).filter((f: string) => f.endsWith('.json'));
                if (diskFiles.length > index.accounts.length + 1) {
                    console.warn(`[Cockpit] 索引自愈触发: 索引=${index.accounts.length} 磁盘=${diskFiles.length}, 正在重建...`);
                    const rebuilt = this.rebuildIndexFromDisk(index);
                    // 写回磁盘持久化重建结果
                    this.saveIndex(rebuilt);
                    return rebuilt;
                }
            }
        } catch (healErr) {
            console.error('[Cockpit] 索引自愈失败，使用原始索引', healErr);
        }

        return index;
    }

    /**
     * 从 accounts/ 目录扫描磁盘文件重建索引。
     * 保留原索引的 current_account_id 和 ui_state。
     */
    private static rebuildIndexFromDisk(existingIndex: AccountIndex): AccountIndex {
        const accountFiles = fs.readdirSync(ACCOUNTS_DIR).filter((f: string) => f.endsWith('.json'));
        const newAccounts: AccountSummary[] = [];

        for (const file of accountFiles) {
            try {
                const account: Account = JSON.parse(
                    fs.readFileSync(path.join(ACCOUNTS_DIR, file), 'utf8')
                );
                newAccounts.push({
                    id: account.id,
                    email: account.email,
                    name: account.name || '',
                    created_at: account.created_at || 0,
                    last_used: account.last_used || 0
                });
            } catch (e) {
                console.warn(`[Cockpit] 自愈: 跳过无效文件 ${file}`);
            }
        }

        // 验证 current_account_id 是否仍然有效
        let currentId = existingIndex.current_account_id;
        if (currentId && !newAccounts.find(a => a.id === currentId)) {
            currentId = newAccounts.length > 0 ? newAccounts[0].id : null;
        }

        console.log(`[Cockpit] 索引自愈完成: 恢复 ${newAccounts.length} 个账号`);
        return {
            accounts: newAccounts,
            current_account_id: currentId,
            ui_state: existingIndex.ui_state
        };
    }

    static saveIndex(index: AccountIndex) {
        const dir = path.dirname(ACCOUNTS_INDEX_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // 安全校验：如果新索引的账号数量急剧减少（<现有的50%），先备份旧索引
        if (fs.existsSync(ACCOUNTS_INDEX_FILE)) {
            try {
                const oldIndex: AccountIndex = JSON.parse(fs.readFileSync(ACCOUNTS_INDEX_FILE, 'utf8'));
                if (oldIndex.accounts.length > 2 && index.accounts.length < oldIndex.accounts.length * 0.5) {
                    const backupPath = ACCOUNTS_INDEX_FILE + '.safety-backup';
                    fs.copyFileSync(ACCOUNTS_INDEX_FILE, backupPath);
                    console.warn(`[Cockpit] 索引安全备份: ${oldIndex.accounts.length} → ${index.accounts.length}, 已备份到 ${backupPath}`);
                }
            } catch (e) {
                // 读取旧索引失败不影响写入
            }
        }

        fs.writeFileSync(ACCOUNTS_INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
    }

    static loadAccount(accountId: string): Account {
        const file = path.join(ACCOUNTS_DIR, `${accountId}.json`);
        if (!fs.existsSync(file)) {
            throw new Error(`Account file not found: ${accountId}`);
        }
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }

    static saveAccount(account: Account) {
        if (!fs.existsSync(ACCOUNTS_DIR)) {
            fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
        }
        const file = path.join(ACCOUNTS_DIR, `${account.id}.json`);
        fs.writeFileSync(file, JSON.stringify(account, null, 2), 'utf8');

        // 同步更新索引文件中的摘要信息
        this.updateIndexSummary(account);
    }

    private static updateIndexSummary(account: Account) {
        try {
            const index = this.loadIndex();
            const existingIndex = index.accounts.findIndex(a => a.id === account.id);
            const summary: AccountSummary = {
                id: account.id,
                email: account.email,
                name: account.name,
                created_at: account.created_at,
                last_used: account.last_used
            };

            if (existingIndex >= 0) {
                index.accounts[existingIndex] = summary;
            } else {
                index.accounts.push(summary);
            }
            this.saveIndex(index);
        } catch (e) {
            console.error('Failed to update index summary', e);
        }
    }

    /**
     * 启动时的静默对账机制，确保索引与物理文件 100% 同步
     * (与 loadIndex 自愈形成互补：差距大时信物理文件，差距极小时清木马/死链)
     */
    static reconcileIndexAtStartup(): void {
        try {
            const index = this.loadIndex();
            let indexChanged = false;

            const actualFiles = new Set<string>();
            if (fs.existsSync(ACCOUNTS_DIR)) {
                fs.readdirSync(ACCOUNTS_DIR)
                    .filter((f: string) => f.endsWith('.json'))
                    .map((f: string) => f.replace('.json', ''))
                    .forEach((id: string) => actualFiles.add(id));
            }

            // 1. 清理死链 (索引里有，但物理文件没有)
            const validAccounts: AccountSummary[] = [];
            for (const account of index.accounts) {
                if (actualFiles.has(account.id)) {
                    validAccounts.push(account);
                } else {
                    console.log(`[Cockpit] 启动对账: 移除遗失的索引死链 ${account.email}`);
                    indexChanged = true;
                }
            }
            
            // 2. 恢复孤儿账户 (物理文件有，但不在索引里)
            const indexedIds = new Set(validAccounts.map(a => a.id));
            for (const fileId of actualFiles) {
                if (!indexedIds.has(fileId)) {
                    try {
                        const ghostFilePath = path.join(ACCOUNTS_DIR, `${fileId}.json`);
                        const accountObj = JSON.parse(fs.readFileSync(ghostFilePath, 'utf8'));
                        validAccounts.push({
                            id: accountObj.id,
                            email: accountObj.email,
                            name: accountObj.name || '',
                            created_at: accountObj.created_at || 0,
                            last_used: accountObj.last_used || 0
                        });
                        console.log(`[Cockpit] 启动对账: 从孤儿文件中恢复账号 ${accountObj.email}`);
                        indexChanged = true;
                    } catch(e) {
                        console.warn(`[Cockpit] 启动对账: 无法恢复无效的账号文件 ${fileId}.json`);
                    }
                }
            }
            
            index.accounts = validAccounts;
            if (index.current_account_id && !actualFiles.has(index.current_account_id)) {
                index.current_account_id = validAccounts.length > 0 ? validAccounts[0].id : null;
                indexChanged = true;
            }

            if (indexChanged) {
                this.saveIndex(index);
            }

        } catch (e) {
            console.error('[Cockpit] 启动对账失败', e);
        }
    }

    static async refreshToken(refreshToken: string): Promise<{ accessToken: string, expiresIn: number, idToken?: string }> {
        const response = await axios.post(TOKEN_URL, {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
        }, { timeout: 10000 });

        if (response.status === 200) {
            return {
                accessToken: response.data.access_token,
                expiresIn: response.data.expires_in,
                idToken: response.data.id_token
            };
        } else {
            throw new Error(`Token refresh failed: ${response.data}`);
        }
    }

    static async fetchQuota(accessToken: string, projectId: string | null = null) {
        // First fetch project and tier with fallback support
        let finalProjectId = projectId;
        let tier: string | null = null;

        for (const ep of LOAD_CODE_ASSIST_ENDPOINTS) {
            try {
                const loadRes = await axios.post(ep,
                    { metadata: { ideType: "ANTIGRAVITY" } },
                    {
                        headers: { 
                            "Authorization": `Bearer ${accessToken}`, 
                            "User-Agent": ANTIGRAVITY_USER_AGENT,
                            "Accept": "application/json",
                            "Content-Type": "application/json"
                        },
                        timeout: 10000
                    }
                );
                if (loadRes.status === 200) {
                    finalProjectId = loadRes.data.cloudaicompanionProject || finalProjectId;
                    tier = (loadRes.data.paidTier && loadRes.data.paidTier.id) || (loadRes.data.currentTier && loadRes.data.currentTier.id);
                    break; // Success, exit loop
                }
            } catch (e: any) {
                const status = e.response?.status;
                if (status === 401) {
                    throw e;
                }
                if (status === 429 || (status && status >= 500)) {
                    console.warn(`[Cockpit] LoadCodeAssist failed at ${ep} with ${status}, trying next endpoint...`);
                    continue;
                }
                console.warn(`[Cockpit] Failed to fetch project info at ${ep}`, e.message);
                break; // Stop for other errors like 403
            }
        }

        finalProjectId = finalProjectId || "bamboo-precept-lgxtn";

        let finalResponse: any = null;
        let lastError: any = null;

        for (const ep of QUOTA_API_ENDPOINTS) {
            try {
                const response = await axios.post(ep,
                    { project: finalProjectId },
                    {
                        headers: { 
                            "Authorization": `Bearer ${accessToken}`, 
                            "User-Agent": ANTIGRAVITY_USER_AGENT,
                            "Accept": "application/json",
                            "Content-Type": "application/json"
                        },
                        timeout: 10000
                    }
                );
                
                if (response.status === 403) {
                    return { is_forbidden: true, models: [], tier };
                }
                
                finalResponse = response;
                break; // Success, exit loop
            } catch (quotaErr: any) {
                const status = quotaErr.response?.status;
                const statusText = quotaErr.response?.statusText || '';
                const errMsg = quotaErr.message || 'Unknown error';

                if (status === 403) {
                    return { is_forbidden: true, models: [], tier };
                }

                if (status === 401) {
                    throw quotaErr;
                }

                lastError = {
                    is_error: true,
                    error_status: status || 0,
                    error_message: status ? `HTTP ${status} ${statusText}` : errMsg,
                    models: [],
                    tier
                };

                // Fallback logic: check for 429 or 5xx
                if (status === 429 || (status && status >= 500)) {
                    console.warn(`[Cockpit] Quota API 429/5xx at ${ep}, falling back to next endpoint...`);
                    continue;
                }
                
                // For other errors (e.g., mismatch, 403), don't fallback, just return error
                console.warn(`[Cockpit] Quota API error at ${ep}: HTTP ${status || 'N/A'} - ${errMsg}`);
                return lastError;
            }
        }

        if (!finalResponse) {
            return lastError || { is_error: true, error_message: 'All endpoints exhausted', models: [], tier };
        }

        const modelsData = finalResponse.data.models || {};
        const models: any[] = [];

        for (const [name, info] of Object.entries(modelsData)) {
            const modelInfo = info as any;

            // 过滤不可用、已禁用或灰显占位符模型 (如 gemini-4-carbon-disabled, tagTitle: Unavailable 等)
            if (modelInfo.disabled || name.toLowerCase().endsWith('-disabled') || modelInfo.tagTitle === 'Unavailable') {
                continue;
            }

            const quotaInfo = modelInfo.quotaInfo || {};
            // 真实有效模型必须具备有效的重置时间
            if (!quotaInfo.resetTime) {
                continue;
            }

            // 将 UTC 时间转换为本地时区显示格式
            let localResetTime = '';
            if (quotaInfo.resetTime) {
                try {
                    const resetDate = new Date(quotaInfo.resetTime);
                    // 使用 zh-CN locale 格式化为本地时间
                    localResetTime = resetDate.toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false
                    });
                } catch (e) {
                    localResetTime = quotaInfo.resetTime; // 格式化失败时保留原值
                }
            }

            models.push({
                name,
                percentage: Math.round((quotaInfo.remainingFraction || 0) * 100),
                reset_time: localResetTime,
                reset_time_raw: quotaInfo.resetTime || "" // 保留原始 UTC 时间供 tooltip 计算使用
            });
        }

        models.sort((a, b) => a.name.localeCompare(b.name));

        // Best-effort: 获取分组配额汇总 (5h + weekly)
        let quotaGroups: QuotaGroup[] | null = null;
        try {
            quotaGroups = await AccountManager.fetchQuotaSummary(accessToken, finalProjectId);
        } catch (e: any) {
            if (e.response?.status === 401) {
                throw e;
            }
            console.warn('[Cockpit] Failed to fetch quota summary, continuing with basic models', e.message || e);
        }

        // 模型配额融合 (Fusion Rule)
        // 将真实 5h 滑动桶与 weekly 周配额桶数据同时融合绑定到对应模型
        if (quotaGroups && quotaGroups.length > 0) {
            // 动态解析分组：区分 Claude/3P 组、基础 Gemini 组与特殊高级独立分组 (如 Argon, Carbon, Ultra)
            let claudeGroup: QuotaGroup | null = null;
            let geminiBaseGroup: QuotaGroup | null = null;
            const specialGroups: { group: QuotaGroup; tokens: string[] }[] = [];

            const ignoredTokens = new Set(['gemini', 'models', 'model', 'group', 'the', 'and', 'for', '4', '5', 'limit', 'weekly', '5h', 'wtu', 'bucket']);

            for (const group of quotaGroups) {
                const gname = (group.displayName || '').toLowerCase();
                const isClaude = gname.includes('claude') || gname.includes('gpt') || gname.includes('3p');
                const isGeminiBase = gname === 'gemini models' || gname === 'gemini';

                if (isClaude) {
                    if (!claudeGroup) claudeGroup = group;
                } else if (isGeminiBase) {
                    if (!geminiBaseGroup) geminiBaseGroup = group;
                } else {
                    // 特殊高级独立分组：动态提取特征代词 (如 argon, carbon 等)
                    const tokens: string[] = [];
                    for (const p of gname.split(/[^a-z0-9]+/)) {
                        if (p && !ignoredTokens.has(p) && !tokens.includes(p)) {
                            tokens.push(p);
                        }
                    }
                    for (const b of group.buckets || []) {
                        for (const bp of (b.bucketId || '').toLowerCase().split(/[^a-z0-9]+/)) {
                            if (bp && !ignoredTokens.has(bp) && !tokens.includes(bp)) {
                                tokens.push(bp);
                            }
                        }
                    }
                    if (tokens.length > 0) {
                        specialGroups.push({ group, tokens });
                    } else if (gname.includes('gemini') && !geminiBaseGroup) {
                        geminiBaseGroup = group;
                    }
                }
            }

            for (const model of models) {
                const nameLower = model.name.toLowerCase();
                const isClaudeOrGpt = nameLower.includes('claude') || nameLower.includes('gpt');

                let matchedGroup: QuotaGroup | null = null;

                // 1. 优先匹配特殊高级分组 (如 argon, carbon)
                for (const sp of specialGroups) {
                    if (sp.tokens.some(t => nameLower.includes(t))) {
                        matchedGroup = sp.group;
                        break;
                    }
                }

                // 2. 匹配常规分组
                if (!matchedGroup) {
                    if (isClaudeOrGpt) {
                        matchedGroup = claudeGroup;
                    } else if (nameLower.startsWith('gemini')) {
                        matchedGroup = geminiBaseGroup;
                    }
                }

                if (matchedGroup) {
                    // 1. 查找 5h 滑动桶
                    const bucket5h = matchedGroup.buckets.find(b => {
                        const win = b.window.toLowerCase();
                        const bid = b.bucketId.toLowerCase();
                        return win.includes('5h') || bid.includes('5h') || win.includes('hour') || bid.includes('hour');
                    });

                    if (bucket5h) {
                        model.has_5h = true;
                        model.percentage = bucket5h.percentage;
                        if (bucket5h.resetTime) {
                            model.reset_time = bucket5h.resetTime;
                            model.reset_time_raw = bucket5h.resetTimeRaw;
                        }
                    } else {
                        model.has_5h = false;
                    }

                    // 2. 查找 weekly 周配额桶
                    const bucketWeekly = matchedGroup.buckets.find(b => {
                        const win = b.window.toLowerCase();
                        const bid = b.bucketId.toLowerCase();
                        return win.includes('week') || bid.includes('week');
                    });

                    if (bucketWeekly) {
                        model.has_weekly = true;
                        model.weekly_percentage = bucketWeekly.percentage;
                        model.weekly_reset_time = bucketWeekly.resetTime;
                        model.weekly_reset_time_raw = bucketWeekly.resetTimeRaw;
                    } else {
                        // 未找到周配额桶时，保留原有基础值作为周配额兜底
                        model.has_weekly = true;
                        model.weekly_percentage = model.percentage;
                        model.weekly_reset_time = model.reset_time;
                        model.weekly_reset_time_raw = model.reset_time_raw;
                    }
                }
            }
        } else {
            // 无 quotaGroups 时，基础模型数据作为周配额兜底
            for (const model of models) {
                model.has_5h = false;
                model.has_weekly = true;
                model.weekly_percentage = model.percentage;
                model.weekly_reset_time = model.reset_time;
                model.weekly_reset_time_raw = model.reset_time_raw;
            }
        }

        return { is_forbidden: false, models, tier, quota_groups: quotaGroups || undefined };
    }

    /**
     * 获取按模型组汇总的配额数据 (包含 5h 滑动窗口与 weekly 周配额桶)
     * 支持 Sandbox -> Daily -> Prod 三级回退
     */
    static async fetchQuotaSummary(accessToken: string, projectId: string | null = null): Promise<QuotaGroup[] | null> {
        const payload = projectId ? { project: projectId } : {};

        for (const ep of QUOTA_SUMMARY_ENDPOINTS) {
            try {
                const res = await axios.post(ep, payload, {
                    headers: {
                        "Authorization": `Bearer ${accessToken}`,
                        "User-Agent": ANTIGRAVITY_USER_AGENT,
                        "Accept": "application/json",
                        "Content-Type": "application/json"
                    },
                    timeout: 10000
                });

                if (res.status === 200 && res.data && Array.isArray(res.data.groups)) {
                    const groups: QuotaGroup[] = res.data.groups.map((g: any) => ({
                        displayName: g.displayName || '',
                        description: g.description || undefined,
                        buckets: (g.buckets || []).map((b: any) => {
                            const remainingFraction = typeof b.remainingFraction === 'number' ? b.remainingFraction : 0;
                            let localResetTime = '';
                            if (b.resetTime) {
                                try {
                                    const resetDate = new Date(b.resetTime);
                                    localResetTime = resetDate.toLocaleString('zh-CN', {
                                        month: '2-digit',
                                        day: '2-digit',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        hour12: false
                                    });
                                } catch {
                                    localResetTime = b.resetTime;
                                }
                            }
                            return {
                                bucketId: b.bucketId || '',
                                window: b.window || '',
                                remainingFraction,
                                percentage: Math.round(remainingFraction * 100),
                                resetTime: localResetTime,
                                resetTimeRaw: b.resetTime || '',
                                displayName: b.displayName || undefined,
                                description: b.description || undefined
                            };
                        })
                    }));
                    return groups;
                }
            } catch (e: any) {
                const status = e.response?.status;
                if (status === 401) {
                    throw e;
                }
                if (status === 429 || (status && status >= 500)) {
                    console.warn(`[Cockpit] QuotaSummary failed at ${ep} with ${status}, falling back...`);
                    continue;
                }
                console.warn(`[Cockpit] QuotaSummary request error at ${ep}: HTTP ${status || 'N/A'} - ${e.message}`);
                break;
            }
        }
        return null;
    }

    // --- 配额缓存层 ---
    private static _quotaCache = new Map<string, { data: any; timestamp: number }>();
    private static readonly _CACHE_TTL = 15 * 1000; // 15 秒 TTL

    /**
     * 带缓存的配额获取。
     * 短时间内（TTL 内）对同一 accessToken 的多次调用直接复用缓存，
     * 避免 StatusBar / Dashboard / TreeView 各自独立发起重复请求。
     */
    static async fetchQuotaCached(accessToken: string, projectId: string | null = null) {
        const cacheKey = accessToken.substring(0, 32);
        const cached = this._quotaCache.get(cacheKey);

        if (cached && (Date.now() - cached.timestamp) < this._CACHE_TTL) {
            return cached.data;
        }

        const data = await this.fetchQuota(accessToken, projectId);
        if (!data.is_error) {
            this._quotaCache.set(cacheKey, { data, timestamp: Date.now() });
        }
        return data;
    }

    /**
     * 仅从缓存中读取配额数据（不发起网络请求）。
     * 用于 Dashboard 首次打开时快速渲染已有数据，无论是否过期。
     * 返回 null 表示缓存中没有该 token 的数据。
     */
    static getQuotaFromCache(accessToken: string): any | null {
        const cacheKey = accessToken.substring(0, 32);
        const cached = this._quotaCache.get(cacheKey);
        return cached ? cached.data : null;
    }

    /**
     * 获取账号配额（结合内存缓存与磁盘持久化快照）。
     * 1. 优先读取内存中的实时缓存（若有 token）；
     * 2. 若内存无，则读取账号文件持久化的 cached_quota，并回填内存缓存；
     * 3. 否则返回 null。
     */
    static getQuota(account: Account): any | null {
        if (account.token?.access_token) {
            const memQuota = this.getQuotaFromCache(account.token.access_token);
            if (memQuota) {
                return memQuota;
            }
        }
        if (account.cached_quota?.data) {
            // 回填内存缓存以供后续短时间内高效复用
            if (account.token?.access_token) {
                const cacheKey = account.token.access_token.substring(0, 32);
                this._quotaCache.set(cacheKey, {
                    data: account.cached_quota.data,
                    timestamp: account.cached_quota.fetched_at || Date.now()
                });
            }
            return account.cached_quota.data;
        }
        return null;
    }

    /**
     * 保存指定账号的最新配额快照到磁盘文件。
     */
    static saveAccountQuota(accountId: string, quotaData: any): void {
        if (!quotaData || quotaData.is_error) {
            return;
        }
        try {
            const account = this.loadAccount(accountId);
            account.cached_quota = {
                data: quotaData,
                fetched_at: Date.now()
            };
            this.saveAccount(account);
        } catch (e) {
            console.error(`[Cockpit] Failed to save cached quota for ${accountId}:`, e);
        }
    }

    /** 清除配额缓存。传入 accessToken 时仅清除该账号的缓存，不传则清除全部 */
    static clearQuotaCache(accessToken?: string): void {
        if (accessToken) {
            const cacheKey = accessToken.substring(0, 32);
            this._quotaCache.delete(cacheKey);
        } else {
            this._quotaCache.clear();
        }
    }

    static deleteAccount(accountId: string) {
        const index = this.loadIndex();

        // Remove from index
        const originalLength = index.accounts.length;
        index.accounts = index.accounts.filter(acc => acc.id !== accountId);

        if (index.accounts.length === originalLength) {
            console.warn(`Account ${accountId} not found in index.`);
        }

        // Handle current account deletion
        if (index.current_account_id === accountId) {
            index.current_account_id = index.accounts.length > 0 ? index.accounts[0].id : null;
        }

        this.saveIndex(index);

        // Delete file
        const file = path.join(ACCOUNTS_DIR, `${accountId}.json`);
        if (fs.existsSync(file)) {
            try {
                fs.unlinkSync(file);
            } catch (e) {
                console.error(`Failed to delete account file: ${file}`, e);
            }
        }
    }
}
