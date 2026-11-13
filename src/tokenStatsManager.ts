import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const initSqlJs = require('sql.js');
import { getAntigravityDataDir, TOKEN_CACHE_FILE } from './constants';

// sql.js WASM 单例
let sqlJsPromise: Promise<any> | null = null;
function getSqlJs(): Promise<any> {
    if (!sqlJsPromise) {
        sqlJsPromise = initSqlJs();
    }
    return sqlJsPromise!;
}

/** 单日 Token 使用汇总 */
export interface DailyTokenSummary {
    date: string; // YYYY-MM-DD 本地日期
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number; // input + output
    stepCount: number;
    hourlyUsage?: Record<number, HourlyTokenSummary>;
    models?: Record<string, ModelTokenUsage>;
}

/** 单个模型在某范围下的 Token 消耗 */
export interface ModelTokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalTokens: number; // 总吞吐 (input + output + cacheRead)
    billedTokens: number; // 计费 (input + output)
    stepCount: number;
}

/** 呈现给 UI 的模型明细条目 */
export interface ModelDetailItem {
    modelId: string;
    modelName: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalTokens: number; // 总吞吐 (input + output + cacheRead)
    billedTokens: number; // 计费 (input + output)
    stepCount: number;
    cacheHitRate: number; // cacheRead / (cacheRead + input) * 100
    percentage: number;   // totalTokens / totalGrossTokens * 100
}

/** 单小时 Token 使用汇总 (0..23时) */
export interface HourlyTokenSummary {
    hour: number; // 0..23
    label: string; // "00:00"
    subLabel: string; // "00:00 - 01:00"
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
    stepCount: number;
}

/** 周期 Token 使用汇总 (包含独立周期缓存命中率) */
export interface PeriodTokenSummary extends DailyTokenSummary {
    cacheHitRate: number; // cacheRead / (cacheRead + input) * 100
}

/** 趋势图条目 (可表示小时或日期) */
export interface TrendItem {
    key: string; // 标识
    label: string; // X 轴精简标签 ("00:00" 或 "MM/DD")
    subLabel: string; // Tooltip 详细时段/日期
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
    stepCount: number;
}

export type TokenRangeType = 'today' | 'yesterday' | '7d' | '30d';

/** 单个会话在持久化缓存中的结构 */
export interface ConversationTokenCache {
    conversationId: string;
    title: string;
    workspaceUri?: string;
    currentModel?: string;
    lastMtimeMs: number;
    lastByteOffset: number;
    stepCount: number;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    dailyUsage: Record<string, DailyTokenSummary>;
}

/** 完整持久化缓存文件结构 */
export interface TokenCacheStore {
    version: number;
    lastSummariesDbMtime: number;
    summaries: Record<string, { title: string; workspaceUri?: string; lastModifiedTime?: number }>;
    conversations: Record<string, ConversationTokenCache>;
}

/** 汇报给 Webview 的多维统计报表 */
export interface TokenStatsReport {
    summary: {
        today: PeriodTokenSummary;
        yesterday: PeriodTokenSummary;
        thisWeek: PeriodTokenSummary;
        thisMonth: PeriodTokenSummary;
        last7d: PeriodTokenSummary;
        last30d: PeriodTokenSummary;
        allTime: PeriodTokenSummary;
        cacheHitRate: number; // 向后兼容
    };
    timeRange: TokenRangeType;
    trendType: 'hourly' | 'daily';
    trends: TrendItem[];
    dailyTrends: DailyTokenSummary[]; // 保留向后兼容
    modelRanking: ModelDetailItem[];
    projectRanking: Array<{
        projectName: string;
        workspaceUri: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        totalTokens: number;
        stepCount: number;
        conversationCount: number;
    }>;
    topConversations: Array<{
        conversationId: string;
        title: string;
        workspaceName: string;
        totalTokens: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        stepCount: number;
        lastModified: number;
    }>;
    lastScanTime: number;
    totalConversations: number;
}

export class TokenStatsManager {
    private static _cache: TokenCacheStore | null = null;
    private static _isScanning = false;

    /**
     * 读取并加载本地持久化缓存
     */
    private static async loadCache(): Promise<TokenCacheStore> {
        if (this._cache) {
            return this._cache;
        }

        try {
            if (fs.existsSync(TOKEN_CACHE_FILE)) {
                const content = await fs.promises.readFile(TOKEN_CACHE_FILE, 'utf-8');
                const parsed = JSON.parse(content);
                if (parsed && parsed.version === 4) {
                    this._cache = parsed;
                    return this._cache!;
                }
            }
        } catch (err) {
            console.warn('[TokenStatsManager] 读取缓存失败，将重建新缓存:', err);
        }

        this._cache = {
            version: 4,
            lastSummariesDbMtime: 0,
            summaries: {},
            conversations: {}
        };
        return this._cache;
    }

    /**
     * 将缓存持久化至磁盘
     */
    private static async saveCache(): Promise<void> {
        if (!this._cache) {
            return;
        }
        try {
            const dir = path.dirname(TOKEN_CACHE_FILE);
            if (!fs.existsSync(dir)) {
                await fs.promises.mkdir(dir, { recursive: true });
            }
            const tmpFile = `${TOKEN_CACHE_FILE}.tmp.${Date.now()}`;
            await fs.promises.writeFile(tmpFile, JSON.stringify(this._cache, null, 2), 'utf-8');
            await fs.promises.rename(tmpFile, TOKEN_CACHE_FILE);
        } catch (err) {
            console.error('[TokenStatsManager] 写入缓存失败:', err);
        }
    }

    /**
     * 同步 conversation_summaries.db 获取会话标题与关联工程
     */
    private static async syncSummariesDb(dataDir: string, cache: TokenCacheStore): Promise<void> {
        const dbPath = path.join(dataDir, 'conversation_summaries.db');
        if (!fs.existsSync(dbPath)) {
            return;
        }

        try {
            const stat = await fs.promises.stat(dbPath);
            if (stat.mtimeMs <= cache.lastSummariesDbMtime && Object.keys(cache.summaries).length > 0) {
                return; // 未变更，复用缓存
            }

            const SQL = await getSqlJs();
            const buffer = await fs.promises.readFile(dbPath);
            const db = new SQL.Database(buffer);

            const results = db.exec('SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries');
            if (results && results.length > 0 && results[0].values) {
                const values = results[0].values;
                for (const row of values) {
                    const id = String(row[0]);
                    const title = String(row[1] || id.slice(0, 8));
                    const wsUri = row[2] ? String(row[2]) : '';
                    const lastModified = Number(row[3]) || 0;
                    cache.summaries[id] = {
                        title,
                        workspaceUri: wsUri,
                        lastModifiedTime: lastModified
                    };
                }
            }
            db.close();
            cache.lastSummariesDbMtime = stat.mtimeMs;
        } catch (err) {
            console.warn('[TokenStatsManager] 读取 conversation_summaries.db 失败 (可能被占用或损坏):', err);
        }
    }

    /**
     * 将 ISO 8601 UTC 字符串转换为本地 YYYY-MM-DD
     */
    public static toLocalDateString(isoDateStr: string): string {
        try {
            const d = new Date(isoDateStr);
            if (isNaN(d.getTime())) {
                return new Date().toISOString().slice(0, 10);
            }
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        } catch {
            return new Date().toISOString().slice(0, 10);
        }
    }

    /**
     * 增量解析单个 transcript.jsonl 文件
     */
    private static async scanTranscriptIncremental(
        filePath: string,
        convId: string,
        cache: TokenCacheStore
    ): Promise<void> {
        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(filePath);
        } catch {
            return;
        }

        let conv = cache.conversations[convId];
        if (!conv) {
            conv = {
                conversationId: convId,
                title: cache.summaries[convId]?.title || convId.slice(0, 8),
                workspaceUri: cache.summaries[convId]?.workspaceUri || '',
                currentModel: 'Gemini 3.8 Flash (Medium)',
                lastMtimeMs: 0,
                lastByteOffset: 0,
                stepCount: 0,
                inputTokens: 0,
                cacheReadTokens: 0,
                outputTokens: 0,
                dailyUsage: {}
            };
            cache.conversations[convId] = conv;
        } else {
            if (!conv.currentModel) {
                conv.currentModel = 'Gemini 3.8 Flash (Medium)';
            }
            // 同步最新的 title 与 workspace
            if (cache.summaries[convId]?.title) {
                conv.title = cache.summaries[convId].title;
            }
            if (cache.summaries[convId]?.workspaceUri) {
                conv.workspaceUri = cache.summaries[convId].workspaceUri;
            }
        }

        // 文件大小缩小或重建，重置偏移量
        if (stat.size < conv.lastByteOffset) {
            conv.lastByteOffset = 0;
            conv.stepCount = 0;
            conv.inputTokens = 0;
            conv.cacheReadTokens = 0;
            conv.outputTokens = 0;
            conv.dailyUsage = {};
        }

        // 未变更，完全跳过
        if (stat.mtimeMs === conv.lastMtimeMs && stat.size === conv.lastByteOffset) {
            return;
        }

        // 增量从 lastByteOffset 读取
        const startOffset = conv.lastByteOffset;
        let bytesReadCount = 0;

        await new Promise<void>((resolve) => {
            const stream = fs.createReadStream(filePath, {
                start: startOffset,
                encoding: 'utf-8',
                flags: 'r'
            });

            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            rl.on('line', (line: string) => {
                // 监听模型变更设置
                if (line.includes('Model Selection')) {
                    const m = line.match(/The user changed setting `Model Selection` from .*? to (.*?)(?:\.\s*No need|<\/USER_SETTINGS_CHANGE>|\.\n|\.$)/);
                    if (m && m[1]) {
                        conv.currentModel = m[1].trim();
                    }
                }

                // 计算实际字节长度 (包括可能的 \n)
                const lineBytes = Buffer.byteLength(line, 'utf-8') + 1;
                bytesReadCount += lineBytes;

                if (!line.includes('input_tokens')) {
                    return;
                }

                try {
                    const data = JSON.parse(line);
                    if (data && typeof data.input_tokens === 'number') {
                        const inTok = Number(data.input_tokens) || 0;
                        const cacheTok = Number(data.cache_read_tokens) || 0;
                        const outTok = Number(data.output_tokens) || 0;
                        const dateStr = TokenStatsManager.toLocalDateString(data.created_at);
                        const dt = new Date(data.created_at);
                        const hour = !isNaN(dt.getTime()) ? dt.getHours() : 0;

                        conv.stepCount += 1;
                        conv.inputTokens += inTok;
                        conv.cacheReadTokens += cacheTok;
                        conv.outputTokens += outTok;

                        if (!conv.dailyUsage[dateStr]) {
                            conv.dailyUsage[dateStr] = {
                                date: dateStr,
                                inputTokens: 0,
                                cacheReadTokens: 0,
                                outputTokens: 0,
                                totalTokens: 0,
                                stepCount: 0,
                                hourlyUsage: {},
                                models: {}
                            };
                        }

                        const dItem = conv.dailyUsage[dateStr];
                        dItem.inputTokens += inTok;
                        dItem.cacheReadTokens += cacheTok;
                        dItem.outputTokens += outTok;
                        dItem.totalTokens += inTok + outTok;
                        dItem.stepCount += 1;

                        // 累加单日模型明细
                        const curModel = conv.currentModel || 'Gemini 3.8 Flash (Medium)';
                        if (!dItem.models) {
                            dItem.models = {};
                        }
                        if (!dItem.models[curModel]) {
                            dItem.models[curModel] = {
                                inputTokens: 0,
                                outputTokens: 0,
                                cacheReadTokens: 0,
                                totalTokens: 0,
                                billedTokens: 0,
                                stepCount: 0
                            };
                        }
                        const mUsage = dItem.models[curModel];
                        mUsage.inputTokens += inTok;
                        mUsage.outputTokens += outTok;
                        mUsage.cacheReadTokens += cacheTok;
                        mUsage.billedTokens = (mUsage.billedTokens || 0) + inTok + outTok;
                        mUsage.totalTokens = (mUsage.totalTokens || 0) + inTok + outTok + cacheTok;
                        mUsage.stepCount += 1;

                        if (!dItem.hourlyUsage) {
                            dItem.hourlyUsage = {};
                        }
                        if (!dItem.hourlyUsage[hour]) {
                            const nextH = (hour + 1) % 24;
                            dItem.hourlyUsage[hour] = {
                                hour,
                                label: String(hour).padStart(2, '0') + ':00',
                                subLabel: String(hour).padStart(2, '0') + ':00 - ' + String(nextH).padStart(2, '0') + ':00',
                                inputTokens: 0,
                                cacheReadTokens: 0,
                                outputTokens: 0,
                                totalTokens: 0,
                                stepCount: 0
                            };
                        }
                        const hItem = dItem.hourlyUsage[hour];
                        hItem.inputTokens += inTok;
                        hItem.cacheReadTokens += cacheTok;
                        hItem.outputTokens += outTok;
                        hItem.totalTokens += inTok + outTok;
                        hItem.stepCount += 1;
                    }
                } catch {
                    // 忽略可能存在的半截损坏行
                }
            });

            rl.on('close', () => {
                resolve();
            });

            stream.on('error', (err) => {
                console.warn(`[TokenStatsManager] 读取日志流出错 [${convId}]:`, err);
                resolve();
            });
        });

        conv.lastByteOffset = Math.min(startOffset + bytesReadCount, stat.size);
        conv.lastMtimeMs = stat.mtimeMs;
    }

    /**
     * 执行全量/增量扫描并持久化最新统计
     */
    public static async scan(overrideDataDir?: string): Promise<TokenCacheStore> {
        if (this._isScanning) {
            return this.loadCache();
        }

        this._isScanning = true;
        try {
            const dataDir = getAntigravityDataDir(overrideDataDir);
            const brainDir = path.join(dataDir, 'brain');
            const cache = await this.loadCache();

            // 1. 同步会话名称与关联工作区
            await this.syncSummariesDb(dataDir, cache);

            // 2. 检查 brain 目录
            if (!fs.existsSync(brainDir)) {
                return cache;
            }

            const entries = await fs.promises.readdir(brainDir, { withFileTypes: true });
            const convDirs = entries.filter(e => e.isDirectory()).map(e => e.name);

            // 3. 逐个会话增量扫描
            for (const convId of convDirs) {
                const transcriptPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
                await this.scanTranscriptIncremental(transcriptPath, convId, cache);
            }

            // 4. 持久化缓存
            await this.saveCache();
            return cache;
        } finally {
            this._isScanning = false;
        }
    }

    /**
     * 获取完整统计报表
     * @param overrideDataDir 自定义数据路径
     * @param rangeInput 统计区间 ('today' | 'yesterday' | '7d' | '30d')，兼容数字
     */
    public static async getReport(
        overrideDataDir?: string,
        rangeInput: TokenRangeType | number = 'today'
    ): Promise<TokenStatsReport> {
        let timeRange: TokenRangeType = 'today';
        if (typeof rangeInput === 'number') {
            timeRange = rangeInput <= 1 ? 'today' : (rangeInput <= 7 ? '7d' : '30d');
        } else if (rangeInput) {
            timeRange = rangeInput;
        }

        const cache = await this.scan(overrideDataDir);

        const now = new Date();
        const todayStr = this.toLocalDateString(now.toISOString());
        const yDate = new Date(now);
        yDate.setDate(now.getDate() - 1);
        const yesterdayStr = this.toLocalDateString(yDate.toISOString());

        // 计算近7天开始日期 (含今日共7天)
        const d7Date = new Date(now);
        d7Date.setDate(now.getDate() - 6);
        const last7dStartStr = this.toLocalDateString(d7Date.toISOString());

        // 计算近30天开始日期 (含今日共30天)
        const d30Date = new Date(now);
        d30Date.setDate(now.getDate() - 29);
        const last30dStartStr = this.toLocalDateString(d30Date.toISOString());

        // 计算本周一开始的日期
        const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1; // 0=Mon, 6=Sun
        const monday = new Date(now);
        monday.setDate(now.getDate() - dayOfWeek);
        const thisWeekStartStr = this.toLocalDateString(monday.toISOString());

        // 本月开始日期
        const thisMonthStartStr = `${todayStr.slice(0, 7)}-01`;

        const summary = {
            today: { date: todayStr, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, stepCount: 0, cacheHitRate: 0 },
            yesterday: { date: yesterdayStr, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, stepCount: 0, cacheHitRate: 0 },
            thisWeek: { date: 'this_week', inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, stepCount: 0, cacheHitRate: 0 },
            thisMonth: { date: 'this_month', inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, stepCount: 0, cacheHitRate: 0 },
            last7d: { date: 'last_7d', inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, stepCount: 0, cacheHitRate: 0 },
            last30d: { date: 'last_30d', inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, stepCount: 0, cacheHitRate: 0 },
            allTime: { date: 'all_time', inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, stepCount: 0, cacheHitRate: 0 },
            cacheHitRate: 0
        };

        const dailyMap: Record<string, DailyTokenSummary> = {};
        const projectMap: Record<string, {
            projectName: string;
            workspaceUri: string;
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            totalTokens: number;
            stepCount: number;
            conversationCount: number;
            seenConvs: Set<string>;
        }> = {};

        const topConvs: Array<{
            conversationId: string;
            title: string;
            workspaceName: string;
            totalTokens: number;
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            stepCount: number;
            lastModified: number;
        }> = [];

        // 聚合所有会话
        for (const [convId, conv] of Object.entries(cache.conversations)) {
            // All time
            summary.allTime.inputTokens += conv.inputTokens;
            summary.allTime.cacheReadTokens += conv.cacheReadTokens;
            summary.allTime.outputTokens += conv.outputTokens;
            summary.allTime.totalTokens += conv.inputTokens + conv.outputTokens;
            summary.allTime.stepCount += conv.stepCount;

            // Project 映射
            let wsUri = conv.workspaceUri || '';
            let projName = 'Global / Scratch';
            if (wsUri) {
                try {
                    let firstUri = wsUri;
                    if (wsUri.trim().startsWith('[')) {
                        const parsedUris = JSON.parse(wsUri);
                        if (Array.isArray(parsedUris) && parsedUris.length > 0) {
                            firstUri = parsedUris[0];
                        }
                    }
                    // 处理 file:///d%3A/PyCode/antigravity-cockpit 或 file:///d:/PyCode/antigravity-cockpit
                    const cleanPath = decodeURIComponent(firstUri.replace(/^file:\/\/\/?/, '')).replace(/[\\/]+$/, '');
                    projName = path.basename(cleanPath) || firstUri;
                } catch {
                    projName = wsUri;
                }
            }

            if (!projectMap[projName]) {
                projectMap[projName] = {
                    projectName: projName,
                    workspaceUri: wsUri,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    totalTokens: 0,
                    stepCount: 0,
                    conversationCount: 0,
                    seenConvs: new Set()
                };
            }
            const pItem = projectMap[projName];
            pItem.inputTokens += conv.inputTokens;
            pItem.outputTokens += conv.outputTokens;
            pItem.cacheReadTokens += conv.cacheReadTokens;
            pItem.totalTokens += conv.inputTokens + conv.outputTokens;
            pItem.stepCount += conv.stepCount;
            if (!pItem.seenConvs.has(convId)) {
                pItem.seenConvs.add(convId);
                pItem.conversationCount += 1;
            }

            // Top 对话
            const convTotal = conv.inputTokens + conv.outputTokens;
            if (convTotal > 0 || conv.cacheReadTokens > 0) {
                topConvs.push({
                    conversationId: convId,
                    title: conv.title || convId.slice(0, 8),
                    workspaceName: projName,
                    totalTokens: convTotal,
                    inputTokens: conv.inputTokens,
                    outputTokens: conv.outputTokens,
                    cacheReadTokens: conv.cacheReadTokens,
                    stepCount: conv.stepCount,
                    lastModified: conv.lastMtimeMs
                });
            }

            // 聚合每日用量
            for (const [dateStr, dayUsage] of Object.entries(conv.dailyUsage)) {
                if (!dailyMap[dateStr]) {
                    dailyMap[dateStr] = {
                        date: dateStr,
                        inputTokens: 0,
                        cacheReadTokens: 0,
                        outputTokens: 0,
                        totalTokens: 0,
                        stepCount: 0
                    };
                }
                const targetDay = dailyMap[dateStr];
                targetDay.inputTokens += dayUsage.inputTokens;
                targetDay.cacheReadTokens += dayUsage.cacheReadTokens;
                targetDay.outputTokens += dayUsage.outputTokens;
                targetDay.totalTokens += dayUsage.totalTokens;
                targetDay.stepCount += dayUsage.stepCount;

                // Today
                if (dateStr === todayStr) {
                    summary.today.inputTokens += dayUsage.inputTokens;
                    summary.today.cacheReadTokens += dayUsage.cacheReadTokens;
                    summary.today.outputTokens += dayUsage.outputTokens;
                    summary.today.totalTokens += dayUsage.totalTokens;
                    summary.today.stepCount += dayUsage.stepCount;
                }

                // Yesterday
                if (dateStr === yesterdayStr) {
                    summary.yesterday.inputTokens += dayUsage.inputTokens;
                    summary.yesterday.cacheReadTokens += dayUsage.cacheReadTokens;
                    summary.yesterday.outputTokens += dayUsage.outputTokens;
                    summary.yesterday.totalTokens += dayUsage.totalTokens;
                    summary.yesterday.stepCount += dayUsage.stepCount;
                }

                // This Week
                if (dateStr >= thisWeekStartStr && dateStr <= todayStr) {
                    summary.thisWeek.inputTokens += dayUsage.inputTokens;
                    summary.thisWeek.cacheReadTokens += dayUsage.cacheReadTokens;
                    summary.thisWeek.outputTokens += dayUsage.outputTokens;
                    summary.thisWeek.totalTokens += dayUsage.totalTokens;
                    summary.thisWeek.stepCount += dayUsage.stepCount;
                }

                // This Month
                if (dateStr >= thisMonthStartStr && dateStr <= todayStr) {
                    summary.thisMonth.inputTokens += dayUsage.inputTokens;
                    summary.thisMonth.cacheReadTokens += dayUsage.cacheReadTokens;
                    summary.thisMonth.outputTokens += dayUsage.outputTokens;
                    summary.thisMonth.totalTokens += dayUsage.totalTokens;
                    summary.thisMonth.stepCount += dayUsage.stepCount;
                }

                // Last 7 Days
                if (dateStr >= last7dStartStr && dateStr <= todayStr) {
                    summary.last7d.inputTokens += dayUsage.inputTokens;
                    summary.last7d.cacheReadTokens += dayUsage.cacheReadTokens;
                    summary.last7d.outputTokens += dayUsage.outputTokens;
                    summary.last7d.totalTokens += dayUsage.totalTokens;
                    summary.last7d.stepCount += dayUsage.stepCount;
                }

                // Last 30 Days
                if (dateStr >= last30dStartStr && dateStr <= todayStr) {
                    summary.last30d.inputTokens += dayUsage.inputTokens;
                    summary.last30d.cacheReadTokens += dayUsage.cacheReadTokens;
                    summary.last30d.outputTokens += dayUsage.outputTokens;
                    summary.last30d.totalTokens += dayUsage.totalTokens;
                    summary.last30d.stepCount += dayUsage.stepCount;
                }
            }
        }

        // 计算各周期的独立缓存命中率 = cacheRead / (cacheRead + input) * 100
        const calcHitRate = (cacheRead: number, input: number) => {
            const sum = cacheRead + input;
            return sum > 0 ? Math.round((cacheRead / sum) * 1000) / 10 : 0;
        };

        summary.today.cacheHitRate = calcHitRate(summary.today.cacheReadTokens, summary.today.inputTokens);
        summary.yesterday.cacheHitRate = calcHitRate(summary.yesterday.cacheReadTokens, summary.yesterday.inputTokens);
        summary.thisWeek.cacheHitRate = calcHitRate(summary.thisWeek.cacheReadTokens, summary.thisWeek.inputTokens);
        summary.thisMonth.cacheHitRate = calcHitRate(summary.thisMonth.cacheReadTokens, summary.thisMonth.inputTokens);
        summary.last7d.cacheHitRate = calcHitRate(summary.last7d.cacheReadTokens, summary.last7d.inputTokens);
        summary.last30d.cacheHitRate = calcHitRate(summary.last30d.cacheReadTokens, summary.last30d.inputTokens);
        summary.allTime.cacheHitRate = calcHitRate(summary.allTime.cacheReadTokens, summary.allTime.inputTokens);
        summary.cacheHitRate = summary.allTime.cacheHitRate;

        // 根据时间区间生成趋势图 (今日/昨日生成 24 小时分布，近7天/近30天生成每日分布)
        let trendType: 'hourly' | 'daily' = 'daily';
        const trends: TrendItem[] = [];

        if (timeRange === 'today' || timeRange === 'yesterday') {
            trendType = 'hourly';
            const targetDate = timeRange === 'today' ? todayStr : yesterdayStr;

            const hourlyBuckets: HourlyTokenSummary[] = [];
            for (let h = 0; h < 24; h++) {
                const nextH = (h + 1) % 24;
                hourlyBuckets.push({
                    hour: h,
                    label: String(h).padStart(2, '0') + ':00',
                    subLabel: `${targetDate} ${String(h).padStart(2, '0')}:00 - ${String(nextH).padStart(2, '0')}:00`,
                    inputTokens: 0,
                    cacheReadTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                    stepCount: 0
                });
            }

            for (const conv of Object.values(cache.conversations)) {
                const dayItem = conv.dailyUsage[targetDate];
                if (dayItem && dayItem.hourlyUsage) {
                    for (let h = 0; h < 24; h++) {
                        const hData = dayItem.hourlyUsage[h];
                        if (hData) {
                            hourlyBuckets[h].inputTokens += hData.inputTokens;
                            hourlyBuckets[h].cacheReadTokens += hData.cacheReadTokens;
                            hourlyBuckets[h].outputTokens += hData.outputTokens;
                            hourlyBuckets[h].totalTokens += hData.totalTokens;
                            hourlyBuckets[h].stepCount += hData.stepCount;
                        }
                    }
                }
            }

            for (const h of hourlyBuckets) {
                trends.push({
                    key: String(h.hour),
                    label: h.label,
                    subLabel: h.subLabel,
                    inputTokens: h.inputTokens,
                    cacheReadTokens: h.cacheReadTokens,
                    outputTokens: h.outputTokens,
                    totalTokens: h.totalTokens,
                    stepCount: h.stepCount
                });
            }
        } else {
            trendType = 'daily';
            const daysLimit = timeRange === '7d' ? 7 : 30;
            for (let i = daysLimit - 1; i >= 0; i--) {
                const targetDate = new Date(now);
                targetDate.setDate(now.getDate() - i);
                const dStr = this.toLocalDateString(targetDate.toISOString());
                const dateParts = dStr.split('-');
                const shortDate = dateParts.length === 3 ? `${dateParts[1]}/${dateParts[2]}` : dStr;
                if (dailyMap[dStr]) {
                    const item = dailyMap[dStr];
                    trends.push({
                        key: dStr,
                        label: shortDate,
                        subLabel: dStr,
                        inputTokens: item.inputTokens,
                        cacheReadTokens: item.cacheReadTokens,
                        outputTokens: item.outputTokens,
                        totalTokens: item.totalTokens,
                        stepCount: item.stepCount
                    });
                } else {
                    trends.push({
                        key: dStr,
                        label: shortDate,
                        subLabel: dStr,
                        inputTokens: 0,
                        cacheReadTokens: 0,
                        outputTokens: 0,
                        totalTokens: 0,
                        stepCount: 0
                    });
                }
            }
        }

        // 保留 30 天每日趋势供向后兼容
        const dailyTrends: DailyTokenSummary[] = [];
        for (let i = 29; i >= 0; i--) {
            const targetDate = new Date(now);
            targetDate.setDate(now.getDate() - i);
            const dStr = this.toLocalDateString(targetDate.toISOString());
            if (dailyMap[dStr]) {
                dailyTrends.push(dailyMap[dStr]);
            } else {
                dailyTrends.push({
                    date: dStr,
                    inputTokens: 0,
                    cacheReadTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                    stepCount: 0
                });
            }
        }

        // 项目排行 (按 totalTokens 倒序)
        const projectRanking = Object.values(projectMap).map(p => ({
            projectName: p.projectName,
            workspaceUri: p.workspaceUri,
            inputTokens: p.inputTokens,
            outputTokens: p.outputTokens,
            cacheReadTokens: p.cacheReadTokens,
            totalTokens: p.totalTokens,
            stepCount: p.stepCount,
            conversationCount: p.conversationCount
        })).sort((a, b) => b.totalTokens - a.totalTokens);

        // Top 会话 (按 totalTokens 倒序，最多取前 20)
        topConvs.sort((a, b) => b.totalTokens - a.totalTokens);
        const topConversations = topConvs.slice(0, 20);

        // 聚合模型统计 (与 timeRange 严格联动)
        const modelAggMap: Record<string, {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            totalTokens: number;
            billedTokens: number;
            stepCount: number;
        }> = {};
        let totalRangeGrossTokens = 0;

        const targetDates = new Set<string>();
        if (timeRange === 'today') {
            targetDates.add(todayStr);
        } else if (timeRange === 'yesterday') {
            targetDates.add(yesterdayStr);
        } else {
            const daysLimit = timeRange === '7d' ? 7 : 30;
            for (let i = 0; i < daysLimit; i++) {
                const d = new Date(now);
                d.setDate(now.getDate() - i);
                targetDates.add(this.toLocalDateString(d.toISOString()));
            }
        }

        for (const conv of Object.values(cache.conversations)) {
            for (const [dateStr, dayUsage] of Object.entries(conv.dailyUsage)) {
                if (!targetDates.has(dateStr)) continue;
                if (!dayUsage.models) continue;
                for (const [mName, mData] of Object.entries(dayUsage.models)) {
                    if (!modelAggMap[mName]) {
                        modelAggMap[mName] = {
                            inputTokens: 0,
                            outputTokens: 0,
                            cacheReadTokens: 0,
                            totalTokens: 0,
                            billedTokens: 0,
                            stepCount: 0
                        };
                    }
                    const agg = modelAggMap[mName];
                    agg.inputTokens += mData.inputTokens;
                    agg.outputTokens += mData.outputTokens;
                    agg.cacheReadTokens += mData.cacheReadTokens;
                    const bTok = (mData.billedTokens || (mData.inputTokens + mData.outputTokens));
                    const gTok = (mData.totalTokens || (bTok + mData.cacheReadTokens));
                    agg.billedTokens += bTok;
                    agg.totalTokens += gTok;
                    agg.stepCount += mData.stepCount;
                    totalRangeGrossTokens += gTok;
                }
            }
        }

        const modelRanking: ModelDetailItem[] = Object.entries(modelAggMap).map(([mName, mData]) => {
            const cacheHitRate = calcHitRate(mData.cacheReadTokens, mData.inputTokens);
            const billedTokens = mData.billedTokens || (mData.inputTokens + mData.outputTokens);
            const grossTokens = mData.totalTokens || (billedTokens + mData.cacheReadTokens);
            const percentage = totalRangeGrossTokens > 0
                ? Math.round((grossTokens / totalRangeGrossTokens) * 1000) / 10
                : 0;
            return {
                modelId: mName,
                modelName: mName,
                inputTokens: mData.inputTokens,
                outputTokens: mData.outputTokens,
                cacheReadTokens: mData.cacheReadTokens,
                totalTokens: grossTokens,
                billedTokens,
                stepCount: mData.stepCount,
                cacheHitRate,
                percentage
            };
        }).sort((a, b) => b.totalTokens - a.totalTokens);

        return {
            summary,
            timeRange,
            trendType,
            trends,
            dailyTrends,
            modelRanking,
            projectRanking,
            topConversations,
            lastScanTime: Date.now(),
            totalConversations: Object.keys(cache.conversations).length
        };
    }
}
