import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './constants';

// 模型分组配置文件路径
export const MODEL_GROUPS_FILE = path.join(DATA_DIR, "model_groups.json");

/**
 * 模型信息接口 (基础兼容)
 */
export interface ModelInfo {
    name: string;          // 模型名称 (如 "Claude Opus 4.5 (Thinking)")
    resetTime: string;     // 重置时间
    percentage: number;    // 剩余配额百分比
}

/**
 * 官方配额分组抽象
 */
export interface DiscoveredQuotaGroup {
    displayName: string;
    description?: string;
}

/**
 * 状态栏与面板模型分组接口
 */
export interface ModelGroup {
    id: string;            // 分组唯一标识 (如 "claude_gpt", "gemini_models", "gemini_argon")
    officialName: string;  // 官方原始分组名称 (如 "Claude and GPT models", "Gemini Models", "Gemini Argon")
    name: string;          // 状态栏与面板自定义显示简称 (如 "Claude", "Gemini", "Gemini Argon")
    enabled: boolean;      // 是否在状态栏常驻显示 (默认 true)
    order: number;         // 排序序号
    description?: string;  // 说明或包含模型列表 (如 "Models: Gemini Flash, Gemini Pro")
    models?: string[];     // 向下兼容保留
    createdAt?: number;    // 创建时间戳
    updatedAt?: number;    // 更新时间戳
}

/**
 * 分组配置接口
 */
export interface ModelGroupsConfig {
    version?: number;               // 配置版本号 (2: 官方原生分组与状态栏设置)
    groups: ModelGroup[];
    lastAutoGrouped?: number | null; // 上次自动分组/同步时间
}

/**
 * 默认预置的官方分组及其简称规则
 */
export const DEFAULT_OFFICIAL_GROUPS: { pattern: RegExp; shortName: string }[] = [
    { pattern: /argon/i, shortName: 'Gemini Argon' },
    { pattern: /claude|3p|gpt/i, shortName: 'Claude' },
    { pattern: /gemini/i, shortName: 'Gemini' }
];

/**
 * 模型分组管理器
 */
export class ModelGroupManager {

    /**
     * 生成分组唯一ID
     */
    static generateGroupId(officialName: string): string {
        const id = officialName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        return id || `group_${Date.now()}`;
    }

    /**
     * 生成友好的默认显示简称，防止重名/冲突
     * 针对 Gemini 与 Gemini Argon 独立区分
     */
    static generateDefaultShortName(officialName: string): string {
        for (const rule of DEFAULT_OFFICIAL_GROUPS) {
            if (rule.pattern.test(officialName)) {
                return rule.shortName;
            }
        }
        // 未知高级分组：去除末尾的 " Models" 或 " models" 后缀
        const cleaned = officialName.replace(/\s+models$/i, '').trim();
        return cleaned || officialName;
    }

    /**
     * 加载分组配置，若为旧格式自动转换为新格式
     */
    static loadGroups(): ModelGroupsConfig {
        if (!fs.existsSync(MODEL_GROUPS_FILE)) {
            return { version: 2, groups: [], lastAutoGrouped: null };
        }
        try {
            const raw = JSON.parse(fs.readFileSync(MODEL_GROUPS_FILE, 'utf8'));
            // 兼容性迁移检测：如果缺少 version 或 groups 内缺少 officialName
            if (!raw.version || (Array.isArray(raw.groups) && raw.groups.some((g: any) => !g.officialName))) {
                return this.migrateOldConfig(raw);
            }
            return raw;
        } catch (e) {
            console.error('[ModelGroupManager] Failed to load model groups', e);
            return { version: 2, groups: [], lastAutoGrouped: null };
        }
    }

    /**
     * 保存分组配置
     */
    static saveGroups(config: ModelGroupsConfig): void {
        const dir = path.dirname(MODEL_GROUPS_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        config.version = 2;
        fs.writeFileSync(MODEL_GROUPS_FILE, JSON.stringify(config, null, 2), 'utf8');
    }

    /**
     * 旧配置升级迁移
     */
    private static migrateOldConfig(oldConfig: any): ModelGroupsConfig {
        const now = Date.now();
        const newGroups: ModelGroup[] = [];

        // 预设已知的官方默认分组作为基础
        const knownDefaults = [
            { officialName: 'Claude and GPT models', name: 'Claude', description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS' },
            { officialName: 'Gemini Models', name: 'Gemini', description: 'Models within this group: Gemini Flash, Gemini Pro' }
        ];

        let order = 1;
        for (const item of knownDefaults) {
            newGroups.push({
                id: this.generateGroupId(item.officialName),
                officialName: item.officialName,
                name: item.name,
                enabled: true,
                order: order++,
                description: item.description,
                createdAt: now,
                updatedAt: now
            });
        }

        const migratedConfig: ModelGroupsConfig = {
            version: 2,
            groups: newGroups,
            lastAutoGrouped: now
        };

        try {
            this.saveGroups(migratedConfig);
            console.log('[ModelGroupManager] 成功将旧版分组配置升级为 V2 官方模型分组规范');
        } catch (e) {
            console.warn('[ModelGroupManager] 写入迁移配置失败:', e);
        }

        return migratedConfig;
    }

    /**
     * 发现并同步官方模型分组
     * 保持现有用户的自定义简称、启用状态和排序不变，仅追加新发现的官方分组
     * @param discovered 接口下发的最新分组列表
     * @param pruneMissing 是否移除未在 discovered 中出现的分组 (清理幽灵分组)
     */
    static syncDiscoveredGroups(discovered: DiscoveredQuotaGroup[], pruneMissing: boolean = false): ModelGroupsConfig {
        const config = this.loadGroups();
        let changed = false;

        if (!discovered || discovered.length === 0) {
            return config;
        }

        // 如果开启了 pruneMissing，移除不再存在的幽灵分组
        if (pruneMissing) {
            const validNames = new Set(discovered.map(d => d.displayName.toLowerCase()));
            const filtered = config.groups.filter(g => validNames.has(g.officialName.toLowerCase()));
            if (filtered.length !== config.groups.length) {
                config.groups = filtered;
                changed = true;
            }
        }

        for (const item of discovered) {
            if (!item.displayName) continue;

            const existingIndex = config.groups.findIndex(g =>
                g.officialName.toLowerCase() === item.displayName.toLowerCase() ||
                g.id === this.generateGroupId(item.displayName)
            );

            if (existingIndex >= 0) {
                // 已存在，若描述更新则更新描述
                if (item.description && config.groups[existingIndex].description !== item.description) {
                    config.groups[existingIndex].description = item.description;
                    changed = true;
                }
            } else {
                // 新发现的分组，追加到列表中，默认 enabled = true (全选策略)
                const newGroup: ModelGroup = {
                    id: this.generateGroupId(item.displayName),
                    officialName: item.displayName,
                    name: this.generateDefaultShortName(item.displayName),
                    enabled: true,
                    order: config.groups.length + 1,
                    description: item.description,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };
                config.groups.push(newGroup);
                changed = true;
            }
        }

        if (changed) {
            config.lastAutoGrouped = Date.now();
            this.saveGroups(config);
        }

        return config;
    }

    /**
     * 从账号配额数据中真实提取其具备的模型分组
     * 绝不凭空捏造未具备的模型
     */
    static extractGroupsFromQuota(quotaData: any): DiscoveredQuotaGroup[] {
        if (!quotaData || quotaData.is_error) return [];
        const discovered: DiscoveredQuotaGroup[] = [];

        if (quotaData.quota_groups && Array.isArray(quotaData.quota_groups) && quotaData.quota_groups.length > 0) {
            for (const qg of quotaData.quota_groups) {
                if (qg.displayName && !discovered.some(d => d.displayName.toLowerCase() === qg.displayName.toLowerCase())) {
                    discovered.push({ displayName: qg.displayName, description: qg.description });
                }
            }
        } else if (quotaData.models && Array.isArray(quotaData.models) && quotaData.models.length > 0) {
            if (quotaData.models.some((m: any) => /claude|3p|gpt/i.test(m.name))) {
                discovered.push({ displayName: 'Claude and GPT models', description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS' });
            }
            if (quotaData.models.some((m: any) => /argon/i.test(m.name))) {
                discovered.push({ displayName: 'Gemini 4 Argon', description: 'For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.' });
            }
            if (quotaData.models.some((m: any) => /gemini/i.test(m.name) && !/argon/i.test(m.name))) {
                discovered.push({ displayName: 'Gemini Models', description: 'Models within this group: Gemini Flash, Gemini Pro' });
            }
        }
        return discovered;
    }

    /**
     * 重置为默认分组配置
     */
    static resetToDefaults(discovered: DiscoveredQuotaGroup[]): ModelGroupsConfig {
        const now = Date.now();
        const baseList = (discovered && discovered.length > 0) ? discovered : [
            { displayName: 'Claude and GPT models', description: 'Models: Claude Opus, Claude Sonnet, GPT-OSS' },
            { displayName: 'Gemini Models', description: 'Models: Gemini Flash, Gemini Pro' }
        ];

        let order = 1;
        const groups: ModelGroup[] = baseList.map(item => ({
            id: this.generateGroupId(item.displayName),
            officialName: item.displayName,
            name: this.generateDefaultShortName(item.displayName),
            enabled: true,
            order: order++,
            description: item.description,
            createdAt: now,
            updatedAt: now
        }));

        const newConfig: ModelGroupsConfig = {
            version: 2,
            groups,
            lastAutoGrouped: now
        };

        this.saveGroups(newConfig);
        return newConfig;
    }

    /**
     * 首次安装默认初始化检测（兼容旧方法调用）
     */
    static initDefaultGroupIfNeeded(models?: any[]): ModelGroupsConfig | null {
        const config = this.loadGroups();
        if (config.groups.length === 0) {
            return this.resetToDefaults([]);
        }
        return null;
    }

    // --- 保留兼容辅助方法 (保证旧引用不抛异常) ---
    static createGroup(name: string, models: string[] = []): ModelGroup {
        const now = Date.now();
        return {
            id: this.generateGroupId(name),
            officialName: name,
            name: this.generateDefaultShortName(name),
            enabled: true,
            order: 999,
            models,
            createdAt: now,
            updatedAt: now
        };
    }

    static addGroup(config: ModelGroupsConfig, group: ModelGroup): ModelGroupsConfig {
        return {
            ...config,
            groups: [...config.groups, group]
        };
    }

    static updateGroup(config: ModelGroupsConfig, groupId: string, updates: Partial<ModelGroup>): ModelGroupsConfig {
        return {
            ...config,
            groups: config.groups.map(g =>
                g.id === groupId
                    ? { ...g, ...updates, updatedAt: Date.now() }
                    : g
            )
        };
    }

    static deleteGroup(config: ModelGroupsConfig, groupId: string): ModelGroupsConfig {
        return {
            ...config,
            groups: config.groups.filter(g => g.id !== groupId)
        };
    }
}
