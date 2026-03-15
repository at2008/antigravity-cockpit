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
    IMPORTANT_MODELS
} from './constants';

export interface TokenInfo {
    access_token: string;
    refresh_token: string;
    expiry_timestamp: number;
    email: string;
}

export interface Account {
    id: string;
    email: string;
    name: string;
    created_at: number;
    last_used: number;
    disabled: boolean;
    token?: TokenInfo;
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
}

export class AccountManager {
    static loadIndex(): AccountIndex {
        if (!fs.existsSync(ACCOUNTS_INDEX_FILE)) {
            return { accounts: [], current_account_id: null };
        }
        try {
            return JSON.parse(fs.readFileSync(ACCOUNTS_INDEX_FILE, 'utf8'));
        } catch (e) {
            console.error('Failed to load account index', e);
            return { accounts: [], current_account_id: null };
        }
    }

    static saveIndex(index: AccountIndex) {
        const dir = path.dirname(ACCOUNTS_INDEX_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
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

    static async refreshToken(refreshToken: string): Promise<{ accessToken: string, expiresIn: number }> {
        const response = await axios.post(TOKEN_URL, {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
        }, { timeout: 10000 });

        if (response.status === 200) {
            return {
                accessToken: response.data.access_token,
                expiresIn: response.data.expires_in
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
                            "User-Agent": "Antigravity/4.1.29 (Windows NT 10.0; Win64; x64) Chrome/132.0.6834.160 Electron/39.2.3",
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
                if (status === 429 || (status && status >= 500)) {
                    console.warn(`[Cockpit] LoadCodeAssist failed at ${ep} with ${status}, trying next endpoint...`);
                    continue;
                }
                console.warn(`[Cockpit] Failed to fetch project info at ${ep}`, e.message);
                break; // Stop for other errors like 401/403
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
                            "User-Agent": "Antigravity/4.1.29 (Windows NT 10.0; Win64; x64) Chrome/132.0.6834.160 Electron/39.2.3",
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
                
                // For other errors (e.g., 401), don't fallback, just return error
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
            if (!IMPORTANT_MODELS.some(kw => name.toLowerCase().includes(kw))) {
                continue;
            }

            const quotaInfo = modelInfo.quotaInfo || {};

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

        return { is_forbidden: false, models, tier };
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
        this._quotaCache.set(cacheKey, { data, timestamp: Date.now() });
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
