import * as vscode from 'vscode';
import * as http from 'http';
import * as url from 'url';
import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import axios from 'axios';
import { AccountTreeProvider } from './accountTreeProvider';
import { AccountManager, Account, TokenInfo } from './accountManager';
import { ProcessManager } from './processManager';
import { DBManager } from './dbManager';
import {
    AUTH_URL,
    CLIENT_ID,
    CLIENT_SECRET,
    OAUTH_SCOPES,
    TOKEN_URL,
    USERINFO_URL,
    migrateDataDir,
    VSCDB_PATH
} from './constants';

import { DashboardProvider } from './dashboardProvider';
import { ModelGroupManager } from './modelGroupManager';
import { SwitcherProxy } from './switcherProxy';
import { t } from './i18n';

/**
 * 计算字符串在等宽字体下的视觉宽度
 * CJK字符和 Emoji 计为 2 个单位，其余 ASCII 字符计为 1 个单位
 */
function getVisualWidth(str: string): number {
    let width = 0;
    for (const char of str) {
        const code = char.charCodeAt(0);
        // CJK 字符范围: 0x4E00 - 0x9FFF, 全角字符: 0xFF00 - 0xFFEF
        if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0xFF00 && code <= 0xFFEF)) {
            width += 2;
        } else if (char.length > 1) { // 处理 surrogate pairs (如 Emoji)
            width += 2;
        } else {
            width += 1;
        }
    }
    return width;
}

export function activate(context: vscode.ExtensionContext) {
    // 🔄 配置目录迁移：从旧路径 ~/.antigravity_tools 复制到 ~/.antigravity_cockpit
    migrateDataDir();

    const accountTreeProvider = new AccountTreeProvider();
    // vscode.window.registerTreeDataProvider('antigravityAccounts', accountTreeProvider);

    // --- Welcome Message for First Install ---
    if (!context.globalState.get('hasShownWelcome')) {
        vscode.window.showInformationMessage(
            t('welcomeMessage'),
            t('openPanel')
        ).then(selection => {
            if (selection === t('openPanel')) {
                vscode.commands.executeCommand('antigravity-cockpit.openDashboard');
            }
        });
        context.globalState.update('hasShownWelcome', true);
    }

    // --- Status Bar Section ---
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
    statusBarItem.command = 'antigravity-cockpit.openDashboard';
    context.subscriptions.push(statusBarItem);

    // 立即显示状态栏（初始状态）
    statusBarItem.text = `$(sync~spin) ${t('loading')}`;
    statusBarItem.tooltip = t('loadingTooltip');
    statusBarItem.show();

    // --- Configuration Change Listener ---
    // 监听配置变化（特别是语言切换），并实时刷新界面显示
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('antigravity-cockpit.language')) {
            updateStatusBar();
            // 如果面板已打开，通知面板更新语言（虽然面板通常会由 dashboardProvider 自己更新）
            vscode.commands.executeCommand('antigravity-cockpit.refreshAccounts');
        }
    }));




    /**
     * 🔄 IDE 账号同步检测
     * 每次定时刷新时调用，检测 Antigravity IDE 中当前登录的账号
     * 是否与插件的 current_account_id 一致。
     * 
     * - 如果一致 → 无需操作
     * - 如果不一致且该 email 已在插件中 → 切换 current_account_id + 更新 Token
     * - 如果不一致且该 email 不在插件中 → 自动创建新账号并设为当前账号
     * 
     * @returns true 如果发生了账号切换/导入（调用方可据此刷新 UI）
     */
    async function syncWithIdeAccount(): Promise<boolean> {
        try {
            // 1. 从 IDE 数据库读取当前登录的 Token
            const tokenInfo = await DBManager.readFullTokenInfo();
            if (!tokenInfo) {
                // IDE 中无登录信息（可能 IDE 未启动或已登出），不做任何操作
                return false;
            }

            // 2. 确保 Token 可用（如果在 5 分钟内过期，则提前刷新）
            let accessToken = tokenInfo.access_token;
            let refreshToken = tokenInfo.refresh_token;
            let expiry = tokenInfo.expiry;

            if (Date.now() / 1000 > expiry - 300) {
                try {
                    const refreshed = await AccountManager.refreshToken(refreshToken);
                    accessToken = refreshed.accessToken;
                    expiry = Math.floor(Date.now() / 1000) + refreshed.expiresIn;
                } catch (refreshErr) {
                    console.warn('[Cockpit] IDE Token 刷新失败，跳过同步检测。');
                    return false;
                }
            }

            // 3. 快速路径：先用 access_token 比对当前账号，避免不必要的 API 请求
            const index = AccountManager.loadIndex();
            if (index.current_account_id) {
                try {
                    const currentAccount = AccountManager.loadAccount(index.current_account_id);
                    if (currentAccount.token && currentAccount.token.refresh_token === refreshToken) {
                        // refresh_token 相同 → 同一个账号，确认为活跃状态
                        currentAccount.last_used = Date.now();
                        AccountManager.saveAccount(currentAccount);
                        // 账号并未真正变更，静默处理，返回 false 防止全局触发了无意义的渲染重绘
                        return false;
                    }
                } catch (e) {
                    // 当前账号加载失败，继续进行完整检测
                }
            }

            // 4. refresh_token 不同 → 需要获取 email 进行精确匹配
            let userInfo: any;
            try {
                userInfo = await getUserInfo(accessToken);
            } catch (infoErr) {
                console.warn('[Cockpit] 同步检测：获取用户信息失败，跳过。');
                return false;
            }

            if (!userInfo || !userInfo.email) {
                return false;
            }

            const ideEmail = userInfo.email;

            // 5. 检查当前账号是否已经是这个 email
            if (index.current_account_id) {
                try {
                    const currentAccount = AccountManager.loadAccount(index.current_account_id);
                    if (currentAccount.email === ideEmail) {
                        // email 一致，只需更新 Token（IDE 可能刷新了 Token）
                        currentAccount.token = {
                            access_token: accessToken,
                            refresh_token: refreshToken,
                            expiry_timestamp: expiry,
                            email: ideEmail
                        };
                        currentAccount.last_used = Date.now();
                        AccountManager.saveAccount(currentAccount);
                        return true;
                    }
                } catch (e) {
                    // 继续
                }
            }

            // 6. IDE 的 email 与插件当前账号不同 → 需要切换
            console.log(`[Cockpit] 检测到 IDE 账号变更: IDE=${ideEmail}`);

            const existing = index.accounts.find(a => a.email === ideEmail);

            if (existing) {
                // 6a. 该 email 在插件中已有记录 → 切换到该账号并更新 Token
                const account = AccountManager.loadAccount(existing.id);
                // 清除该账号旧 Token 的缓存（Token 即将被更新）
                if (account.token) {
                    AccountManager.clearQuotaCache(account.token.access_token);
                }
                account.token = {
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    expiry_timestamp: expiry,
                    email: ideEmail
                };
                account.last_used = Date.now();
                AccountManager.saveAccount(account);

                index.current_account_id = existing.id;
                AccountManager.saveIndex(index);

                console.log(`[Cockpit] 已同步切换到已有账号: ${ideEmail}`);
                vscode.window.showInformationMessage(t('ideSyncSwitched', ideEmail));

                // 刷新 UI
                accountTreeProvider.refresh();
                DashboardProvider.refresh();
                return true;

            } else {
                // 6b. 全新账号 → 自动导入并设为当前
                const accountId = (crypto as any).randomUUID
                    ? (crypto as any).randomUUID()
                    : Math.random().toString(36).substring(2) + Date.now().toString(36);

                const newAccount: Account = {
                    id: accountId,
                    email: ideEmail,
                    name: userInfo.name || '',
                    created_at: Date.now(),
                    last_used: Date.now(),
                    disabled: false,
                    token: {
                        access_token: accessToken,
                        refresh_token: refreshToken,
                        expiry_timestamp: expiry,
                        email: ideEmail
                    }
                };

                AccountManager.saveAccount(newAccount);

                index.accounts.push({
                    id: accountId,
                    email: ideEmail,
                    name: userInfo.name || '',
                    created_at: newAccount.created_at,
                    last_used: newAccount.last_used
                });

                // 设为当前账号
                index.current_account_id = accountId;
                AccountManager.saveIndex(index);

                // 新账号无缓存，无需清除

                console.log(`[Cockpit] 已自动导入并切换到新账号: ${ideEmail}`);
                vscode.window.showInformationMessage(
                    t('ideSyncImported', ideEmail),
                    t('openPanel')
                ).then(selection => {
                    if (selection === t('openPanel')) {
                        vscode.commands.executeCommand('antigravity-cockpit.openDashboard');
                    }
                });

                // 刷新 UI
                accountTreeProvider.refresh();
                DashboardProvider.refresh();
                return true;
            }

        } catch (e) {
            console.error('[Cockpit] IDE 账号同步检测出错:', e);
            return false;
        }
    }

    async function updateStatusBar() {
        const index = AccountManager.loadIndex();
        if (!index.current_account_id) {
            statusBarItem.text = `$(account) ${t('noAccount')}`;
            statusBarItem.tooltip = t('loginTooltip');
            statusBarItem.show();
            return;
        }

        try {
            const account = AccountManager.loadAccount(index.current_account_id);

            if (!account.token) {
                statusBarItem.text = `$(account) ${account.email.split('@')[0]}`;
                statusBarItem.tooltip = t('accountDetailsTooltip');
                statusBarItem.show();
                return;
            }

            let quota;
            try {
                // 尝试获取配额（使用缓存版本，避免与 Dashboard 重复请求）
                quota = await AccountManager.fetchQuotaCached(account.token.access_token);
            } catch (err: any) {
                // 如果是 401 (Unauthorized)，尝试刷新 Token
                if (err.response && err.response.status === 401) {
                    try {
                        console.log('Token expired (401), attempting to refresh...');
                        const oldAccessToken = account.token.access_token;
                        const refreshed = await AccountManager.refreshToken(account.token.refresh_token);

                        // 更新内存和文件中的 Token
                        account.token.access_token = refreshed.accessToken;
                        account.token.expiry_timestamp = Math.floor(Date.now() / 1000) + refreshed.expiresIn;
                        AccountManager.saveAccount(account);

                        // 使用新 Token 重试获取配额
                        AccountManager.clearQuotaCache(oldAccessToken);
                        quota = await AccountManager.fetchQuotaCached(refreshed.accessToken);
                        console.log('Token refreshed and quota fetched successfully.');
                        DashboardProvider.refresh(); // 通知面板刷新以显示新数据
                    } catch (refreshErr) {
                        // 刷新失败，抛出原始错误或刷新错误
                        console.error('Failed to refresh token:', refreshErr);
                        throw err; // 抛出原始 401 错误，让外层 catch 处理
                    }
                } else {
                    // 非 401 错误，直接抛出
                    throw err;
                }
            }

            // 首次安装时初始化默认分组（如果分组为空）
            // 将 quota.models 转换为 ModelInfo[] 格式
            const modelsForInit = (quota.models || []).map((m: any) => ({
                name: m.name,
                resetTime: m.reset_time || '',
                percentage: m.percentage || 0
            }));
            ModelGroupManager.initDefaultGroupIfNeeded(modelsForInit);

            // 加载分组配置
            const groupsConfig = ModelGroupManager.loadGroups();

            if (quota.is_error) {
                // 配额 API 返回了具体错误（如 429），显示错误状态但不影响面板功能
                const errText = quota.error_message || 'Error';
                statusBarItem.text = `$(warning) ${account.email.split('@')[0]} ⚠`;
                
                const errorTooltip = new vscode.MarkdownString();
                errorTooltip.isTrusted = true;
                errorTooltip.supportHtml = true;
                errorTooltip.appendMarkdown(`🛸 **Antigravity Copilot**\n\n`);
                errorTooltip.appendMarkdown(`⚠️ ${t('quotaFetchError')}: ${errText}\n\n`);
                errorTooltip.appendMarkdown(`*${t('quotaRetryHint')}*\n`);
                statusBarItem.tooltip = errorTooltip;
                statusBarItem.command = 'antigravity-cockpit.openDashboard';
                statusBarItem.show();
                return;
            }

            if (groupsConfig.groups.length === 0 || quota.is_forbidden) {
                // 无分组或无权限，显示简单状态
                statusBarItem.text = `$(account) ${account.email.split('@')[0]}`;
            } else {
                // 按分组显示每个分组中剩余额度最低的模型
                const groupTexts: string[] = [];

                for (const group of groupsConfig.groups) {
                    // 找出该分组中的模型 (group.models 是模型名称字符串数组)
                    const groupModels = quota.models.filter((m: any) =>
                        group.models.includes(m.name)
                    );

                    if (groupModels.length > 0) {
                        // 找出剩余额度最低的模型
                        const lowestModel = groupModels.reduce((min: any, m: any) =>
                            m.percentage < min.percentage ? m : min
                            , groupModels[0]);

                        // 根据额度选择颜色图标
                        const icon = lowestModel.percentage > 50 ? "🟢" : (lowestModel.percentage > 20 ? "🟡" : "🔴");
                        groupTexts.push(`${icon} ${group.name}: ${lowestModel.percentage}%`);
                    }
                }

                if (groupTexts.length > 0) {
                    statusBarItem.text = groupTexts.join(" | ");
                } else {
                    statusBarItem.text = `$(account) ${account.email.split('@')[0]}`;
                }
            }

            // Generate detailed tooltip for hover
            let tooltip = new vscode.MarkdownString();
            tooltip.isTrusted = true;
            tooltip.supportHtml = true;

            tooltip.appendMarkdown(`🛸 **Antigravity Copilot**\n\n`);

            if (!quota.is_forbidden) {
                // 极致精确的视觉宽度计算
                const getLen = (s: string) => {
                    let len = 0;
                    for (const char of s) {
                        const code = char.charCodeAt(0);
                        // 1. Emoji 图标 (surrogate pairs) -> 2位
                        if (char.length > 1) { len += 2; }
                        // 2. 中文字符、全角符号 -> 2位
                        else if (code >= 0x4E00 && code <= 0x9FFF || code >= 0xFF00 && code <= 0xFFEF) {
                            len += 2;
                        }
                        // 3. 进度条块、箭头、ASCII、普通符号 -> 1位
                        // (注意：█ \u2588, ░ \u2591, → \u2192 在等宽字体下都是1位)
                        else { len += 1; }
                    }
                    return len;
                };

                const itemsToRender: { isGroup?: boolean, name?: string, model?: any }[] = [];

                if (groupsConfig && groupsConfig.groups && groupsConfig.groups.length > 0) {
                    groupsConfig.groups.forEach((group: any, index: number) => {
                        const groupModels = quota.models.filter((m: any) => group.models.includes(m.name));
                        if (groupModels.length > 0) {
                            groupModels.forEach((m: any) => itemsToRender.push({ model: m }));
                        }
                    });
                } else {
                    quota.models.forEach((m: any) => itemsToRender.push({ model: m }));
                }

                const modelsOnly = itemsToRender.filter(item => item.model).map(item => item.model);
                const maxNameWidth = Math.max(...modelsOnly.map(m => getLen(m.name)), 15);
                const lines: string[] = [];

                itemsToRender.forEach(item => {
                    if (item.model) {
                        const m = item.model;
                        const icon = m.percentage > 50 ? "🟢" : (m.percentage > 20 ? "🟡" : "🔴");
                        const filledBlocks = Math.round(m.percentage / 10);
                        const emptyBlocks = 10 - filledBlocks;
                        const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);

                        let timeInfo = '';
                        const rawResetTime = m.reset_time_raw || m.reset_time;
                        if (rawResetTime) {
                            const resetDate = new Date(rawResetTime);
                            const now = new Date();
                            const diffMs = resetDate.getTime() - now.getTime();
                            if (diffMs > 0) {
                                const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                                const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                                const resetTimeStr = resetDate.toLocaleTimeString(vscode.env.language.startsWith('zh') ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                                timeInfo = `${diffHours}h${String(diffMins).padStart(2, '0')}m (${resetTimeStr})`;
                            } else {
                                timeInfo = t('reset');
                            }
                        }

                        const pctStr = (m.percentage.toFixed(0) + '%').padStart(4, ' ');
                        const timeStr = timeInfo.padStart(13, ' ');

                        const namePadding = ' '.repeat(Math.max(0, maxNameWidth - getLen(m.name)));
                        const paddedName = m.name + namePadding;

                        lines.push(`${icon} ${paddedName} ${progressBar} ${pctStr} → ${timeStr}`);
                    }
                });

                // 用固定公式计算总行宽：icon(2) + 模型名(N) + 进度条(10) + 百分比(4) + 箭头(1) + 时间(13) + 空格(5) = N + 35
                const currentAccountLabel = account.name || account.email;
                const totalLineWidth = maxNameWidth + 35;
                const leftText = t('openSettingsPanel');
                const rightText = t('currentAccount', currentAccountLabel);

                // 剩余空格 = 总行宽 - 左侧格数 - 右侧格数
                const spaces = Math.max(1, totalLineWidth - getLen(leftText) - getLen(rightText));
                lines.push(leftText + ' '.repeat(spaces) + rightText);

                tooltip.appendMarkdown('```\n' + lines.join('\n') + '\n```\n');
            } else {
                // 无权限时简单展示当前账号
                const currentAccountLabel = account.name || account.email;
                tooltip.appendMarkdown('```\n');
                tooltip.appendMarkdown(`${t('quotaNoPermission')}    ${t('currentAccount', currentAccountLabel)}\n`);
                tooltip.appendMarkdown('```\n');
            }

            statusBarItem.tooltip = tooltip;
            statusBarItem.command = 'antigravity-cockpit.openDashboard';
            statusBarItem.show();

            // 连接成功，重置错误状态
            lastConnectionError = false;
            connectionErrorCount = 0;
        } catch (e: any) {
            connectionErrorCount++;

            // 更新状态栏显示错误状态，点击时打开管理面板（而非仅重连）
            statusBarItem.text = `$(error) ${t('reconnect')}`;
            // 详细错误信息放在 tooltip 中，方便排查
            const errorTooltip = new vscode.MarkdownString();
            errorTooltip.appendMarkdown(`**Antigravity Copilot**\n\n`);
            errorTooltip.appendMarkdown(`❌ *连接失败*\n\n`);
            errorTooltip.appendMarkdown(`错误信息: ${e.message || 'Unknown error'}\n\n`);
            if (e.response && e.response.status) {
                errorTooltip.appendMarkdown(` (Status: ${e.response.status})`);
            }
            errorTooltip.appendMarkdown(`\n\n*点击打开管理面板，可切换账号或重试*`);
            statusBarItem.tooltip = errorTooltip;

            // 关键修复：错误状态下点击打开面板，而非僵死在 reconnect
            statusBarItem.command = 'antigravity-cockpit.openDashboard';
            statusBarItem.show();

            // 避免频繁通知：使用配置的刷新间隔作为通知间隔
            const now = Date.now();
            const notifyConfig = vscode.workspace.getConfiguration('antigravity-cockpit'); const notifyIntervalMs = (notifyConfig.get<number>('autoRefreshInterval', 5)) * 60 * 1000;
            const shouldNotify = !lastConnectionError || (now - lastNotificationTime > notifyIntervalMs);

            if (shouldNotify) {
                lastConnectionError = true;
                lastNotificationTime = now;

                const errorMessage = e.message || (vscode.env.language.startsWith('zh') ? '未知错误' : 'Unknown error');
                vscode.window.showWarningMessage(
                    t('connectionFailed', errorMessage),
                    t('openPanel'),
                    t('reconnect'),
                    t('close')
                ).then(selection => {
                    if (selection === t('reconnect')) {
                        updateStatusBar();
                    } else if (selection === t('openPanel')) {
                        vscode.commands.executeCommand('antigravity-cockpit.openDashboard');
                    }
                });
            }
        }
    }

    // 连接状态跟踪
    let lastConnectionError = false;
    let lastNotificationTime = 0;
    let connectionErrorCount = 0;

    // Initial update: 先检测 IDE 当前账号并同步（覆盖首次导入 + 账号变更检测），再刷新状态栏
    syncWithIdeAccount().finally(() => {
        updateStatusBar();
    });
    // Refresh status bar when list is refreshed
    const originalRefresh = accountTreeProvider.refresh.bind(accountTreeProvider);
    accountTreeProvider.refresh = () => {
        originalRefresh();
        updateStatusBar();
    };

    // 注册刷新状态栏命令 (供分组管理等功能调用)
    let refreshStatusBarCommand = vscode.commands.registerCommand('antigravity-cockpit.refreshStatusBar', () => {
        updateStatusBar();
    });
    context.subscriptions.push(refreshStatusBarCommand);

    // 注册重新连接命令
    let reconnectCommand = vscode.commands.registerCommand('antigravity-cockpit.reconnect', async () => {
        vscode.window.showInformationMessage(t('reconnecting'));
        try {
            await updateStatusBar();
            if (!lastConnectionError) {
                vscode.window.showInformationMessage(t('reconnectSuccess'));
            }
        } catch (e) {
            // 错误已在 updateStatusBar 中处理
        }
    });
    context.subscriptions.push(reconnectCommand);

    // --- 定时自动刷新功能 ---
    let autoRefreshTimer: NodeJS.Timeout | undefined;

    function setupAutoRefresh() {
        // 清除现有定时器
        if (autoRefreshTimer) {
            clearInterval(autoRefreshTimer);
            autoRefreshTimer = undefined;
        }

        // 读取配置
        const config = vscode.workspace.getConfiguration('antigravity-cockpit');
        const intervalMinutes = config.get<number>('autoRefreshInterval', 5);

        if (intervalMinutes > 0) {
            const intervalMs = intervalMinutes * 60 * 1000;
            autoRefreshTimer = setInterval(async () => {
                // 先检测 IDE 账号是否变更，再刷新状态栏
                const changed = await syncWithIdeAccount();
                if (changed) {
                    DashboardProvider.refresh();
                }
                updateStatusBar();
            }, intervalMs);
            console.log(`Antigravity Multi-Account Cockpit: 自动刷新已启用，间隔 ${intervalMinutes} 分钟`);
        } else {
            console.log('Antigravity Multi-Account Cockpit: 自动刷新已禁用');
        }
    }

    // 初始化定时刷新
    setupAutoRefresh();

    // --- DB 文件实时监听 (实时感知 IDE 登录) ---
    let dbWatchTimeout: NodeJS.Timeout | undefined;
    try {
        if (fs.existsSync(VSCDB_PATH)) {
            fs.watch(VSCDB_PATH, (eventType) => {
                if (eventType === 'change') {
                    // 加入防抖(Debounce)，等待 IDE 写入稳定后再读取
                    if (dbWatchTimeout) {
                        clearTimeout(dbWatchTimeout);
                    }
                    dbWatchTimeout = setTimeout(async () => {
                        const changed = await syncWithIdeAccount();
                        if (changed) {
                            DashboardProvider.refresh();
                            updateStatusBar();
                        }
                    }, 2000); // 延迟 2 秒执行
                }
            });
            console.log(`[Cockpit] 已开启全局数据库监听: ${VSCDB_PATH}`);
        }
    } catch (err) {
        console.warn('[Cockpit] 数据库监听启动失败, 退化为轮询模式:', err);
    }

    // 监听配置变化
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antigravity-cockpit.autoRefreshInterval')) {
                setupAutoRefresh();
                vscode.window.showInformationMessage(t('autoRefreshUpdated'));
            }
        })
    );

    // 确保插件停用时清除定时器
    context.subscriptions.push({
        dispose: () => {
            if (autoRefreshTimer) {
                clearInterval(autoRefreshTimer);
            }
        }
    });

    let refreshCommand = vscode.commands.registerCommand('antigravity-cockpit.refreshAccounts', () => {
        accountTreeProvider.refresh();
    });

    let addAccountCommand = vscode.commands.registerCommand('antigravity-cockpit.addAccount', async () => {
        try {
            const tokenInfo = await performOAuth();
            if (tokenInfo) {
                const userInfo = await getUserInfo(tokenInfo.access_token);

                const index = AccountManager.loadIndex();
                const existing = index.accounts.find(a => a.email === userInfo.email);

                let accountId: string;
                let account: Account;

                if (existing) {
                    accountId = existing.id;
                    account = AccountManager.loadAccount(accountId);
                } else {
                    accountId = (crypto as any).randomUUID ? (crypto as any).randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
                    account = {
                        id: accountId,
                        email: userInfo.email,
                        name: userInfo.name || '',
                        created_at: Date.now(),
                        last_used: Date.now(),
                        disabled: false
                    };
                    index.accounts.push({
                        id: accountId,
                        email: userInfo.email,
                        name: userInfo.name || '',
                        created_at: account.created_at,
                        last_used: account.last_used
                    });
                    if (!index.current_account_id) {
                        index.current_account_id = accountId;
                    }
                    AccountManager.saveIndex(index);
                }

                account.token = {
                    access_token: tokenInfo.access_token,
                    refresh_token: tokenInfo.refresh_token,
                    expiry_timestamp: Math.floor(Date.now() / 1000) + tokenInfo.expires_in,
                    email: userInfo.email
                };
                account.name = userInfo.name || account.name;
                account.last_used = Date.now();

                AccountManager.saveAccount(account);
                accountTreeProvider.refresh();
                DashboardProvider.refresh(); // 新增：刷新面板
                vscode.window.showInformationMessage(t('refreshSuccess', userInfo.email));
            }
        } catch (e) {
            vscode.window.showErrorMessage(t('addAccountFailed', (e as Error).message));
        }
    });

    let switchAccountCommand = vscode.commands.registerCommand('antigravity-cockpit.switchAccount', async (item: any) => {
        const accountId = item.accountId;
        if (!accountId) { return; }

        const config = vscode.workspace.getConfiguration('antigravity-cockpit');
        const switchMode = config.get<string>('switchMode', 'advanced');

        const message =
            switchMode === 'safe'
                ? t('switchConfirmSafe', item.email)
                : t('switchConfirmAdvanced', item.email);

        const confirm = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            t('confirm')
        );

        if (confirm !== t('confirm')) { return; }

        if (switchMode === 'safe') {
            // 安全模式：只更新当前账号索引与 UI，不做 Kill/注入/自动重启
            const index = AccountManager.loadIndex();
            index.current_account_id = accountId;
            AccountManager.saveIndex(index);

            // 更新最后活跃时间
            try {
                const account = AccountManager.loadAccount(accountId);
                account.last_used = Date.now();
                AccountManager.saveAccount(account);
            } catch (e) {}

            accountTreeProvider.refresh();
            DashboardProvider.refresh();

            vscode.window.showInformationMessage(
                t('switchConfirmSafe', item.email).split('\n\n')[0] + ' (Safe Mode)'
            );
            return;
        }

        // 高级模式下，先进行环境预检查
        const dbPathOverride = config.get<string>('databasePathOverride', '');
        const exePathConfig = config.get<{ win32?: string; darwin?: string; linux?: string }>('antigravityExecutablePath', {});

        const envCheck = SwitcherProxy.checkEnvironment(
            dbPathOverride || undefined,
            Object.keys(exePathConfig).length > 0 ? exePathConfig : undefined
        );

        if (!envCheck.success) {
            // 有致命问题，显示详细信息
            const detailMessage = envCheck.suggestions.join('\n');
            const action = await vscode.window.showErrorMessage(
                t('envCheckFailed', detailMessage),
                { modal: true },
                t('tryAnyway'),
                t('cancel')
            );

            if (action !== t('tryAnyway')) {
                return;
            }
        } else if (envCheck.suggestions.length > 0) {
            // 有警告信息，但不是致命问题
            const warnMessage = envCheck.suggestions.join('\n');
            const action = await vscode.window.showWarningMessage(
                t('envCheckWarning', warnMessage),
                { modal: true },
                t('continue'),
                t('cancel')
            );

            if (action !== t('continue')) {
                return;
            }
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t('switchingAccount'),
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ message: t('loadingAccountInfo') });
                const account = AccountManager.loadAccount(accountId);
                if (!account.token) { throw new Error(vscode.env.language.startsWith('zh') ? "该账号暂无 Token" : "The account has no Token"); }

                // Check/Refresh token
                let token = account.token;
                if (Date.now() / 1000 > token.expiry_timestamp - 300) {
                    progress.report({ message: t('refreshingToken') });
                    const refreshed = await AccountManager.refreshToken(token.refresh_token);
                    token.access_token = refreshed.accessToken;
                    token.expiry_timestamp = Math.floor(Date.now() / 1000) + refreshed.expiresIn;
                    account.token = token;
                    AccountManager.saveAccount(account);
                }

                progress.report({ message: "准备外部代理切换流程..." });

                // 更新最后活跃时间
                account.last_used = Date.now();
                AccountManager.saveAccount(account);

                // 更新当前账号索引
                const index = AccountManager.loadIndex();
                index.current_account_id = accountId;
                AccountManager.saveIndex(index);

                // 读取配置中的等待时间
                const processWaitSeconds = config.get<number>('processWaitSeconds', 10);

                // 启动外部代理接管后续的 Kill -> Inject -> Restart
                await SwitcherProxy.executeExternalSwitch(
                    token.access_token,
                    token.refresh_token,
                    token.expiry_timestamp,
                    account.email,
                    dbPathOverride || undefined,
                    Object.keys(exePathConfig).length > 0 ? exePathConfig : undefined,
                    processWaitSeconds
                );

                progress.report({ message: t('requestingRestart') });

                // 等待一小会儿确保代理脚本已启动
                await new Promise(resolve => setTimeout(resolve, 800));

                // 主动命令 IDE 退出 (双重保险)
                try {
                    await vscode.commands.executeCommand('workbench.action.quit');
                } catch (e) {
                    console.log('Quit command failed, relying on hard kill.');
                }

                accountTreeProvider.refresh();
                DashboardProvider.refresh();
            } catch (e) {
                vscode.window.showErrorMessage(`切换失败: ${(e as Error).message}`);
            }
        });
    });

    let openDashboardCommand = vscode.commands.registerCommand('antigravity-cockpit.openDashboard', async () => {
        // Phase 0: 立即打开面板（使用本地缓存数据渲染，0 延迟）
        DashboardProvider.createOrShow(context.extensionUri);

        // Phase 1: 后台检测 IDE 账号一致性（不阻塞面板显示）
        const accountChanged = await syncWithIdeAccount();

        // Phase 2: 如果账号发生变更，刷新面板内容
        if (accountChanged) {
            DashboardProvider.refresh();
        }
        // 无论是否变更，都刷新状态栏（可能有新的配额数据）
        updateStatusBar();
    });

    let refreshAccountCommand = vscode.commands.registerCommand('antigravity-cockpit.refreshAccount', async (accountId: string) => {
        try {
            await syncWithIdeAccount(); // 刷新前先主动侦测一次账号表更
            const account = AccountManager.loadAccount(accountId);
            if (account.token) {
                const oldAccessToken = account.token.access_token;
                const refreshed = await AccountManager.refreshToken(account.token.refresh_token);
                account.token.access_token = refreshed.accessToken;
                account.token.expiry_timestamp = Math.floor(Date.now() / 1000) + refreshed.expiresIn;
                account.last_used = Date.now();
                AccountManager.saveAccount(account);
                // 仅清除该账号旧 Token 的缓存，不影响其他账号
                AccountManager.clearQuotaCache(oldAccessToken);
                // 立即用新 Token 获取最新配额（写入缓存），供 Dashboard 直接读取
                await AccountManager.fetchQuotaCached(account.token.access_token);
                accountTreeProvider.refresh();
                DashboardProvider.refresh(); // 刷新设置面板
                updateStatusBar(); // 同步刷新状态栏限额数据
                vscode.window.showInformationMessage(t('refreshSuccess', account.email));
            }
        } catch (e) {
            vscode.window.showErrorMessage(t('refreshFailed', (e as Error).message));
        }
    });

    let deleteAccountCommand = vscode.commands.registerCommand('antigravity-cockpit.deleteAccount', async (item: any) => {
        const accountId = item.accountId;
        const email = item.email || '未命名账号';

        if (!accountId) { return; }

        const confirm = await vscode.window.showWarningMessage(
            t('deleteConfirm', email),
            { modal: true },
            t('confirm')
        );

        if (confirm !== t('confirm')) { return; }

        try {
            AccountManager.deleteAccount(accountId);

            // 如果删除了当前账号，更新状态栏
            updateStatusBar();

            accountTreeProvider.refresh();
            DashboardProvider.refresh();
            vscode.window.showInformationMessage(t('accountDeleted', email));
        } catch (e) {
            vscode.window.showErrorMessage(t('deleteFailed', (e as Error).message));
        }
    });

    let refreshAllAccountsCommand = vscode.commands.registerCommand('antigravity-cockpit.refreshAllAccounts', async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t('loading'),
            cancellable: false
        }, async (progress) => {
            progress.report({ message: '正在检测 IDE 最新登录状态...' });
            await syncWithIdeAccount(); // 新增：刷新前先主动侦测一次
            
            AccountManager.clearQuotaCache(); // 手动刷新全部 → 清除缓存
            const index = AccountManager.loadIndex();
            const total = index.accounts.length;
            
            for (let i = 0; i < total; i++) {
                const accSum = index.accounts[i];
                progress.report({ message: t('refreshingProgress', i + 1, total, accSum.email) });
                
                try {
                    const account = AccountManager.loadAccount(accSum.id);
                    if (account.token) {
                        const refreshed = await AccountManager.refreshToken(account.token.refresh_token);
                        account.token.access_token = refreshed.accessToken;
                        account.token.expiry_timestamp = Math.floor(Date.now() / 1000) + refreshed.expiresIn;
                        account.last_used = Date.now();
                        AccountManager.saveAccount(account);
                        // 立即获取配额写入缓存，供 Dashboard 直接读取
                        await AccountManager.fetchQuotaCached(account.token.access_token);
                    }
                    
                    // 局部刷新 UI: 仪表盘、侧边栏、状态栏
                    DashboardProvider.postUpdate(); // 仪表盘实时更新单个账号数据
                    accountTreeProvider.refresh();   // 侧边栏同步刷新
                    updateStatusBar();               // 状态栏同步刷新 (如果是当前账号)
                } catch (e) {
                    console.error(`无法刷新 ${accSum.email}`, e);
                }
            }
            // 循环结束后做最后的全局同步
            DashboardProvider.refresh(); // 做一次完整的 _update (含翻译等)
            vscode.window.showInformationMessage(t('allAccountsRefreshed'));
        });
    });

    // --- Token 登录命令 ---
    let loginWithTokenCommand = vscode.commands.registerCommand('antigravity-cockpit.loginWithToken', async (refreshTokenArg?: string) => {
        try {
            // 支持从 Dashboard 传入 token，或弹出输入框让用户手动输入
            let refreshTokenInput = refreshTokenArg;
            if (!refreshTokenInput) {
                refreshTokenInput = await vscode.window.showInputBox({
                    prompt: t('tokenLoginTitle'),
                    placeHolder: t('tokenLoginPlaceholder'),
                    password: true,
                    ignoreFocusOut: true
                });
            }

            if (!refreshTokenInput || !refreshTokenInput.trim()) {
                return;
            }

            const refreshTokenValue = refreshTokenInput.trim();

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('tokenLoginValidating'),
                cancellable: false
            }, async () => {
                // 1. 用 refresh_token 获取 access_token
                const refreshed = await AccountManager.refreshToken(refreshTokenValue);
                const accessToken = refreshed.accessToken;
                const expiresIn = refreshed.expiresIn;

                // 2. 获取用户信息
                const userInfo = await getUserInfo(accessToken);
                if (!userInfo || !userInfo.email) {
                    throw new Error('Failed to retrieve user info from token');
                }

                // 3. 查重 → 创建或更新账号
                const index = AccountManager.loadIndex();
                const existing = index.accounts.find(a => a.email === userInfo.email);

                let accountId: string;
                let account: Account;

                if (existing) {
                    accountId = existing.id;
                    account = AccountManager.loadAccount(accountId);
                } else {
                    accountId = (crypto as any).randomUUID
                        ? (crypto as any).randomUUID()
                        : Math.random().toString(36).substring(2) + Date.now().toString(36);
                    account = {
                        id: accountId,
                        email: userInfo.email,
                        name: userInfo.name || '',
                        created_at: Date.now(),
                        last_used: Date.now(),
                        disabled: false
                    };
                    index.accounts.push({
                        id: accountId,
                        email: userInfo.email,
                        name: userInfo.name || '',
                        created_at: account.created_at,
                        last_used: account.last_used
                    });
                    if (!index.current_account_id) {
                        index.current_account_id = accountId;
                    }
                    AccountManager.saveIndex(index);
                }

                account.token = {
                    access_token: accessToken,
                    refresh_token: refreshTokenValue,
                    expiry_timestamp: Math.floor(Date.now() / 1000) + expiresIn,
                    email: userInfo.email
                };
                account.name = userInfo.name || account.name;
                account.last_used = Date.now();

                AccountManager.saveAccount(account);
                accountTreeProvider.refresh();
                DashboardProvider.refresh();
                vscode.window.showInformationMessage(t('tokenLoginSuccess', userInfo.email));
            });
        } catch (e) {
            vscode.window.showErrorMessage(t('tokenLoginFailed', (e as Error).message));
        }
    });
    context.subscriptions.push(loginWithTokenCommand);

    // --- 导出 Token 命令 ---
    let exportTokenCommand = vscode.commands.registerCommand('antigravity-cockpit.exportToken', async (accountId?: string) => {
        try {
            // 如果未传入 accountId，使用当前活跃账号
            if (!accountId) {
                const index = AccountManager.loadIndex();
                accountId = index.current_account_id || undefined;
            }

            if (!accountId) {
                vscode.window.showWarningMessage(t('exportTokenNoToken'));
                return;
            }

            const account = AccountManager.loadAccount(accountId);
            if (!account.token || !account.token.refresh_token) {
                vscode.window.showWarningMessage(t('exportTokenNoToken'));
                return;
            }

            // 先弹出安全警告确认
            const confirm = await vscode.window.showWarningMessage(
                t('exportTokenWarning'),
                { modal: true },
                t('copyToClipboard')
            );

            if (confirm === t('copyToClipboard')) {
                await vscode.env.clipboard.writeText(account.token.refresh_token);
                vscode.window.showInformationMessage(t('exportTokenCopied'));
            }
        } catch (e) {
            vscode.window.showErrorMessage((e as Error).message);
        }
    });
    context.subscriptions.push(exportTokenCommand);

    // --- 批量导出 Token 命令 ---
    let batchExportCommand = vscode.commands.registerCommand('antigravity-cockpit.batchExportTokens', async () => {
        try {
            const index = AccountManager.loadIndex();
            const exportData: { version: number; accounts: { email: string; refresh_token: string }[] } = {
                version: 1,
                accounts: []
            };

            for (const accSum of index.accounts) {
                try {
                    const account = AccountManager.loadAccount(accSum.id);
                    if (account.token && account.token.refresh_token) {
                        exportData.accounts.push({
                            email: account.email,
                            refresh_token: account.token.refresh_token
                        });
                    }
                } catch (e) {
                    console.warn(`Skipping account ${accSum.email}:`, e);
                }
            }

            if (exportData.accounts.length === 0) {
                vscode.window.showWarningMessage(t('batchExportNoAccounts'));
                return;
            }

            // 安全警告确认
            const confirm = await vscode.window.showWarningMessage(
                t('exportTokenWarning'),
                { modal: true },
                t('copyToClipboard')
            );

            if (confirm === t('copyToClipboard')) {
                await vscode.env.clipboard.writeText(JSON.stringify(exportData, null, 2));
                vscode.window.showInformationMessage(t('batchExportSuccess', exportData.accounts.length));
            }
        } catch (e) {
            vscode.window.showErrorMessage((e as Error).message);
        }
    });
    context.subscriptions.push(batchExportCommand);

    // --- 批量导入 Token 命令 ---
    let batchImportCommand = vscode.commands.registerCommand('antigravity-cockpit.batchImportTokens', async (jsonText?: string) => {
        try {
            // 支持从 Dashboard 传入 JSON，或弹出输入框
            let input = jsonText;
            if (!input) {
                input = await vscode.window.showInputBox({
                    prompt: t('batchImportTitle'),
                    placeHolder: t('batchImportPlaceholder'),
                    ignoreFocusOut: true
                });
            }

            if (!input || !input.trim()) {
                return;
            }

            let parsed: any;
            try {
                parsed = JSON.parse(input.trim());
            } catch (e) {
                vscode.window.showErrorMessage(t('batchImportInvalidFormat'));
                return;
            }

            if (!parsed.version || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
                vscode.window.showErrorMessage(t('batchImportInvalidFormat'));
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('batchImportValidating'),
                cancellable: false
            }, async (progress) => {
                let newCount = 0;
                let updatedCount = 0;
                let failedCount = 0;
                const total = parsed.accounts.length;

                for (let i = 0; i < total; i++) {
                    const item = parsed.accounts[i];
                    if (!item.refresh_token) {
                        failedCount++;
                        continue;
                    }

                    progress.report({ message: t('batchImportProgress', i + 1, total) });

                    try {
                        // 1. 用 refresh_token 获取 access_token
                        const refreshed = await AccountManager.refreshToken(item.refresh_token);
                        const accessToken = refreshed.accessToken;
                        const expiresIn = refreshed.expiresIn;

                        // 2. 获取用户信息
                        const userInfo = await getUserInfo(accessToken);
                        if (!userInfo || !userInfo.email) {
                            failedCount++;
                            continue;
                        }

                        // 3. 查重 → 创建或更新
                        const index = AccountManager.loadIndex();
                        const existing = index.accounts.find(a => a.email === userInfo.email);

                        let accountId: string;
                        let account: Account;

                        if (existing) {
                            accountId = existing.id;
                            account = AccountManager.loadAccount(accountId);
                            updatedCount++;
                        } else {
                            accountId = (crypto as any).randomUUID
                                ? (crypto as any).randomUUID()
                                : Math.random().toString(36).substring(2) + Date.now().toString(36);
                            account = {
                                id: accountId,
                                email: userInfo.email,
                                name: userInfo.name || '',
                                created_at: Date.now(),
                                last_used: Date.now(),
                                disabled: false
                            };
                            index.accounts.push({
                                id: accountId,
                                email: userInfo.email,
                                name: userInfo.name || '',
                                created_at: account.created_at,
                                last_used: account.last_used
                            });
                            if (!index.current_account_id) {
                                index.current_account_id = accountId;
                            }
                            AccountManager.saveIndex(index);
                            newCount++;
                        }

                        account.token = {
                            access_token: accessToken,
                            refresh_token: item.refresh_token,
                            expiry_timestamp: Math.floor(Date.now() / 1000) + expiresIn,
                            email: userInfo.email
                        };
                        account.name = userInfo.name || account.name;
                        account.last_used = Date.now();
                        AccountManager.saveAccount(account);
                    } catch (e) {
                        console.error(`Failed to import token for ${item.email || 'unknown'}:`, e);
                        failedCount++;
                    }
                }

                accountTreeProvider.refresh();
                DashboardProvider.refresh();
                const successCount = newCount + updatedCount;
                vscode.window.showInformationMessage(t('batchImportSuccess', successCount, newCount, updatedCount));
            });
        } catch (e) {
            vscode.window.showErrorMessage(t('batchImportFailed', (e as Error).message));
        }
    });
    context.subscriptions.push(batchImportCommand);

    // 打开外部切换代理日志目录（ag_switch_*.log 所在的临时目录）
    let openSwitchLogsCommand = vscode.commands.registerCommand('antigravity-cockpit.openSwitchLogs', async () => {
        const tempDir = os.tmpdir();
        const uri = vscode.Uri.file(tempDir);
        await vscode.env.openExternal(uri);
        vscode.window.showInformationMessage(t('openLogsTip'));
    });

    // 环境自检命令
    let diagnoseEnvironmentCommand = vscode.commands.registerCommand('antigravity-cockpit.diagnoseEnvironment', async () => {
        const { execSync } = require('child_process');
        const fs = require('fs');
        const path = require('path');
        const platform = os.platform();
        const config = vscode.workspace.getConfiguration('antigravity-cockpit');

        const results: string[] = [];
        results.push(t('envDiagnoseTitle'));

        // 1. Node.js 检测
        results.push(t('nodeSection'));
        let nodePath = '';
        let nodeStatus = t('statusNotFound');
        try {
            if (platform === 'win32') {
                try {
                    const result = execSync('where node', { encoding: 'utf-8', windowsHide: true });
                    const lines = result.trim().split('\n');
                    if (lines.length > 0 && fs.existsSync(lines[0].trim())) {
                        nodePath = lines[0].trim();
                        nodeStatus = t('statusFound');
                    }
                } catch (e) {
                    // 忽略
                }
            } else {
                nodePath = execSync('which node', { encoding: 'utf-8' }).trim();
                if (nodePath && fs.existsSync(nodePath)) {
                    nodeStatus = t('statusFound');
                }
            }
        } catch (e) {
            nodeStatus = t('statusDetectFailed');
        }
        results.push(t('statusLabelText', nodeStatus));
        if (nodePath) {
            results.push(t('pathLabelText', nodePath));
        }
        results.push('');

        // 2. 数据库路径检测
        results.push(t('dbSection'));
        const { getVSCDBPath } = require('./constants');
        const dbPathOverride = config.get<string>('databasePathOverride', '');
        const actualDbPath = dbPathOverride && dbPathOverride.trim() ? dbPathOverride.trim() : getVSCDBPath();
        const dbExists = fs.existsSync(actualDbPath);
        results.push(t('pathLabelText', actualDbPath));
        results.push(t('statusLabelText', dbExists ? t('statusFoundLong') : t('statusNotFoundLong')));
        if (dbPathOverride) {
            results.push(t('configOverrideLabel', dbPathOverride));
        }
        results.push('');

        // 3. Antigravity 可执行文件检测
        results.push(t('exeSection'));
        const exePathConfig = config.get<{ win32?: string; darwin?: string; linux?: string }>('antigravityExecutablePath', {});
        let exePath = '';
        let exeStatus = t('statusNotFound');

        if (platform === 'win32') {
            exePath = exePathConfig.win32 && exePathConfig.win32.trim()
                ? exePathConfig.win32.trim()
                : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe');
            if (fs.existsSync(exePath)) {
                exeStatus = t('statusFound');
            }
        } else if (platform === 'darwin') {
            exePath = exePathConfig.darwin && exePathConfig.darwin.trim()
                ? exePathConfig.darwin.trim()
                : '/Applications/Antigravity.app';
            if (fs.existsSync(exePath)) {
                exeStatus = t('statusFound');
            }
        } else {
            // Linux
            const possiblePaths = exePathConfig.linux && exePathConfig.linux.trim()
                ? [exePathConfig.linux.trim()]
                : ['/usr/bin/antigravity', '/opt/antigravity/antigravity', path.join(process.env.HOME || '', '.local/bin/antigravity')];
            for (const p of possiblePaths) {
                if (fs.existsSync(p)) {
                    exePath = p;
                    exeStatus = t('statusFound');
                    break;
                }
            }
        }

        results.push(t('statusLabelText', exeStatus));
        if (exePath) {
            results.push(t('pathLabelText', exePath));
        }
        if (Object.keys(exePathConfig).length > 0) {
            results.push(t('configOverrideLabel', JSON.stringify(exePathConfig)));
        }
        results.push('');

        // 4. 平台信息
        results.push(t('platformSection'));
        results.push(t('osLabelText', platform));
        results.push(t('archLabelText', os.arch()));
        results.push('');

        // 5. 配置信息
        results.push(t('configSection'));
        const switchMode = config.get<string>('switchMode', 'advanced');
        const autoRefreshInterval = config.get<number>('autoRefreshInterval', 5);
        results.push(t('switchModeLabelText', switchMode));
        results.push(t('refreshIntervalLabelText', autoRefreshInterval));
        results.push('');

        // 显示结果
        const report = results.join('\n');
        const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown'
        });
        await vscode.window.showTextDocument(doc);

        // 提供复制按钮
        const action = await vscode.window.showInformationMessage(
            t('envReportGenerated'),
            t('copyReport')
        );
        if (action === t('copyReport')) {
            await vscode.env.clipboard.writeText(report);
            vscode.window.showInformationMessage(t('reportCopied'));
        }
    });

    context.subscriptions.push(
        refreshCommand,
        addAccountCommand,
        switchAccountCommand,
        deleteAccountCommand,
        openDashboardCommand,
        refreshAccountCommand,
        refreshAllAccountsCommand,
        openSwitchLogsCommand,
        diagnoseEnvironmentCommand
    );

    // --- 启动时自动同步 IDE 真实登录状态 ---
    setTimeout(async () => {
        try {
            console.log('正在检查 IDE 数据库中的真实登录状态...');

            // 增加重试机制：尝试读取数据库 10 次，每次间隔 4 秒
            // 应对 IDE 刚启动时数据库可能被锁定的情况
            let dbTokenInfo: { access_token: string; refresh_token: string; expiry: number; } | null = null;

            for (let i = 0; i < 10; i++) {
                try {
                    dbTokenInfo = await DBManager.readFullTokenInfo();
                    if (dbTokenInfo) {
                        console.log('成功读取 IDE 数据库。');
                        break;
                    }
                } catch (readErr) {
                    console.warn(`第 ${i + 1} 次读取 IDE 数据库失败:`, readErr);
                }
                if (i < 9) {
                    await new Promise(r => setTimeout(r, 4000));
                }
            }

            if (dbTokenInfo) {
                const index = AccountManager.loadIndex();
                let foundAccount: Account | undefined;
                let foundInLocal = false;

                // 1. 尝试精确 Token 匹配 (快速)
                for (const accSum of index.accounts) {
                    try {
                        const acc = AccountManager.loadAccount(accSum.id);
                        if (acc.token && acc.token.access_token === dbTokenInfo.access_token) {
                            foundAccount = acc;
                            foundInLocal = true;
                            break;
                        }
                    } catch (e) { /* ignore */ }
                }

                // 2. 如果 Token 不匹配，尝试通过 API 验证身份
                if (!foundAccount) {
                    try {
                        // 使用 IDE 中的 Token 去请求用户信息
                        const res = await axios.get(USERINFO_URL, {
                            headers: { Authorization: `Bearer ${dbTokenInfo.access_token}` },
                            timeout: 5000
                        });
                        const userInfo = res.data;
                        const email = userInfo.email;

                        if (email) {
                            // 通过 Email 查找本地账号
                            for (const accSum of index.accounts) {
                                if (accSum.email === email) {
                                    foundAccount = AccountManager.loadAccount(accSum.id);
                                    foundInLocal = true;
                                    // 顺便更新本地 Token
                                    if (foundAccount.token) {
                                        foundAccount.token = {
                                            access_token: dbTokenInfo.access_token,
                                            refresh_token: dbTokenInfo.refresh_token,
                                            expiry_timestamp: dbTokenInfo.expiry,
                                            email: email
                                        };
                                        AccountManager.saveAccount(foundAccount);
                                    }
                                    break;
                                }
                            }

                            // 3. 如果本地也没有，自动创建新账号 (Auto Import)
                            if (!foundAccount) {
                                console.log(`发现新账号 ${email}，正在自动导入...`);
                                const accountId = (crypto as any).randomUUID ? (crypto as any).randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
                                const newAccount: Account = {
                                    id: accountId,
                                    email: email,
                                    name: userInfo.name || '',
                                    created_at: Date.now(),
                                    last_used: Date.now(),
                                    disabled: false,
                                    token: {
                                        access_token: dbTokenInfo.access_token,
                                        refresh_token: dbTokenInfo.refresh_token,
                                        expiry_timestamp: dbTokenInfo.expiry,
                                        email: email
                                    }
                                };

                                // Save to index
                                index.accounts.push({
                                    id: accountId,
                                    email: email,
                                    name: userInfo.name || '',
                                    created_at: newAccount.created_at,
                                    last_used: newAccount.last_used
                                });
                                AccountManager.saveIndex(index);
                                AccountManager.saveAccount(newAccount);

                                foundAccount = newAccount;
                                foundInLocal = true;
                                vscode.window.showInformationMessage(`已自动导入 IDE 当前账号: ${email}`);
                            }
                        }
                    } catch (e) {
                        console.warn('无法验证 IDE 数据库中的 Token 身份:', e);
                    }
                }

                if (foundAccount) {
                    if (foundAccount.id !== index.current_account_id) {
                        // 发现不一致，执行切换
                        index.current_account_id = foundAccount.id;
                        AccountManager.saveIndex(index);

                        // 刷新 UI
                        accountTreeProvider.refresh();
                        DashboardProvider.refresh();
                        updateStatusBar();

                        vscode.window.showInformationMessage(`已自动同步当前账号为: ${foundAccount.email}`);
                    } else {
                        console.log('插件状态与 IDE 数据库一致。');
                    }
                } else {
                    console.log('IDE 中登录的是未知账号且无法获取信息，跳过同步。');
                }
            } else {
                console.log('无法从 IDE 数据库读取 Token，跳过同步。');
            }
        } catch (e) {
            console.error('自动同步状态失败:', e);
        }
    }, 8000); // 延迟 8 秒执行，等待 IDE 完全初始化
}

async function performOAuth(): Promise<any> {
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            const parsedUrl = url.parse(req.url || '', true);
            const pathname = parsedUrl.pathname;
            const queryObject = parsedUrl.query;

            // 忽略图标请求
            if (pathname === '/favicon.ico') {
                res.writeHead(404);
                res.end();
                return;
            }

            // 只处理授权回调路径
            if (pathname === '/oauth-callback') {
                if (queryObject.code) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`<h1>${t('oauthSuccessTitle')}</h1><p>${t('oauthSuccessMessage')}</p><script>setTimeout(function() { window.close(); }, 2000);</script>`);

                    try {
                        const response = await axios.post(TOKEN_URL, {
                            client_id: CLIENT_ID,
                            client_secret: CLIENT_SECRET,
                            code: (queryObject.code as string),
                            redirect_uri: `http://127.0.0.1:${(server.address() as any).port}/oauth-callback`,
                            grant_type: "authorization_code",
                        });
                        resolve(response.data);
                    } catch (e) {
                        reject(e);
                    } finally {
                        server.close();
                    }
                } else if (queryObject.error) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`<h1>${t('oauthFailedTitle')}</h1><p>${queryObject.error}</p>`);
                    server.close();
                    reject(new Error(t('oauthFailedServiceError', queryObject.error)));
                }
            }
        });

        server.listen(0, '127.0.0.1', async () => {
            const port = (server.address() as any).port;
            const redirectUri = `http://127.0.0.1:${port}/oauth-callback`;
            const params = new URLSearchParams({
                client_id: CLIENT_ID,
                redirect_uri: redirectUri,
                response_type: 'code',
                scope: OAUTH_SCOPES.join(' '),
                access_type: 'offline',
                prompt: 'consent',
                include_granted_scopes: 'true'
            });
            const authUrl = `${AUTH_URL}?${params.toString()}`;

            const result = await vscode.window.showInformationMessage(
                t('oauthProcessMessage'),
                { modal: true },
                t('oauthOpenBrowser'),
                t('oauthCopyLink')
            );

            if (result === t('oauthCopyLink')) {
                await vscode.env.clipboard.writeText(authUrl);
                vscode.window.showInformationMessage(t('oauthClipboardSuccess'));
            } else if (result === t('oauthOpenBrowser')) {
                vscode.env.openExternal(vscode.Uri.parse(authUrl));
            } else {
                // 用户取消，关闭服务器
                server.close();
                reject(new Error(t('oauthUserCancelled')));
                return;
            }
        });

        setTimeout(() => {
            if (server.listening) {
                server.close();
                reject(new Error(t('oauthTimeout')));
            }
        }, 300000);
    });
}

async function getUserInfo(accessToken: string): Promise<any> {
    const response = await axios.get(USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    return response.data;
}

export function deactivate() { }
