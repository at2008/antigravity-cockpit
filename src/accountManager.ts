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
        // First fetch project and tier
        let finalProjectId = projectId;
        let tier: string | null = null;

        try {
            const loadRes = await axios.post(LOAD_CODE_ASSIST_URL,
                { metadata: { ideType: "ANTIGRAVITY" } },
                {
                    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "antigravity/windows/amd64" },
                    timeout: 10000
                }
            );
            if (loadRes.status === 200) {
                finalProjectId = loadRes.data.cloudaicompanionProject || finalProjectId;
                tier = (loadRes.data.paidTier && loadRes.data.paidTier.id) || (loadRes.data.currentTier && loadRes.data.currentTier.id);
            }
        } catch (e) {
            console.warn('Failed to fetch project info', e);
        }

        finalProjectId = finalProjectId || "bamboo-precept-lgxtn";

        const response = await axios.post(QUOTA_API_URL,
            { project: finalProjectId },
            {
                headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "antigravity/1.11.3 Darwin/arm64" },
                timeout: 10000
            }
        );

        if (response.status === 403) {
            return { is_forbidden: true, models: [], tier };
        }

        const modelsData = response.data.models || {};
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
