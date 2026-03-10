import * as vscode from 'vscode';
import * as http from 'http';
import * as url from 'url';
import * as crypto from 'crypto';
import * as os from 'os';
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
    migrateDataDir
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
     * 🔍 自动导入 IDE 当前登录账号
     * 从 Antigravity IDE 的 state.vscdb 数据库读取已登录的 OAuth Token，
     * 检查该账号是否已存在于插件配置中，若不存在则自动创建并保存。
     */
    async function autoImportCurrentAccount(): Promise<void> {
        try {
            // 1. 从 IDE 数据库读取当前登录的 Token 信息
            const tokenInfo = await DBManager.readFullTokenInfo();
            if (!tokenInfo) {
                console.log('[Cockpit] IDE 数据库中未找到已登录的 Token，跳过自动导入。');
                return;
            }

            // 2. 检查 Token 是否仍然有效，若过期则尝试刷新
            let accessToken = tokenInfo.access_token;
            let refreshToken = tokenInfo.refresh_token;
            let expiry = tokenInfo.expiry;

            if (Date.now() / 1000 > expiry - 60) {
                try {
                    console.log('[Cockpit] IDE Token 已过期，尝试刷新...');
                    const refreshed = await AccountManager.refreshToken(refreshToken);
                    accessToken = refreshed.accessToken;
                    expiry = Math.floor(Date.now() / 1000) + refreshed.expiresIn;
                } catch (refreshErr) {
                    console.warn('[Cockpit] Token 刷新失败，跳过自动导入。', refreshErr);
                    return;
                }
            }

            // 3. 用 Access Token 获取用户信息 (email, name)
            let userInfo: any;
            try {
                userInfo = await getUserInfo(accessToken);
            } catch (infoErr) {
                console.warn('[Cockpit] 获取用户信息失败，跳过自动导入。', infoErr);
                return;
            }

            if (!userInfo || !userInfo.email) {
                console.warn('[Cockpit] 用户信息中无 email，跳过自动导入。');
                return;
            }

            // 4. 检查该 email 是否已存在于插件配置中
            const index = AccountManager.loadIndex();
            const existing = index.accounts.find(a => a.email === userInfo.email);

            if (existing) {
                // 账号已存在，仅更新 Token（保持最新）
                const account = AccountManager.loadAccount(existing.id);
                account.token = {
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    expiry_timestamp: expiry,
                    email: userInfo.email
                };
                account.last_used = Date.now();
                AccountManager.saveAccount(account);
                console.log(`[Cockpit] 已更新现有账号 ${userInfo.email} 的 Token。`);
                return;
            }

            // 5. 账号不存在 → 自动创建
            const accountId = (crypto as any).randomUUID
                ? (crypto as any).randomUUID()
                : Math.random().toString(36).substring(2) + Date.now().toString(36);

            const newAccount: Account = {
                id: accountId,
                email: userInfo.email,
                name: userInfo.name || '',
                created_at: Date.now(),
                last_used: Date.now(),
                disabled: false,
                token: {
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    expiry_timestamp: expiry,
                    email: userInfo.email
                }
            };

            AccountManager.saveAccount(newAccount);

            index.accounts.push({
                id: accountId,
                email: userInfo.email,
                name: userInfo.name || '',
                created_at: newAccount.created_at,
                last_used: newAccount.last_used
            });

            // 若当前无活跃账号，设为默认
            if (!index.current_account_id) {
                index.current_account_id = accountId;
            }

            AccountManager.saveIndex(index);

            console.log(`[Cockpit] 已自动导入 IDE 当前登录账号: ${userInfo.email}`);
            vscode.window.showInformationMessage(
                t('autoImportSuccess', userInfo.email),
                t('openPanel')
            ).then(selection => {
                if (selection === t('openPanel')) {
                    vscode.commands.executeCommand('antigravity-cockpit.openDashboard');
                }
            });

        } catch (e) {
            console.error('[Cockpit] 自动导入账号时发生错误:', e);
            // 自动导入失败不影响插件正常运行
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
                        const refreshed = await AccountManager.refreshToken(account.token.refresh_token);

                        // 更新内存和文件中的 Token
                        account.token.access_token = refreshed.accessToken;
                        account.token.expiry_timestamp = Math.floor(Date.now() / 1000) + refreshed.expiresIn;
                        AccountManager.saveAccount(account);

                        // 使用新 Token 重试获取配额
                        AccountManager.clearQuotaCache(); // Token 已刷新，旧缓存无效
                        quota = await AccountManager.fetchQuotaCached(refreshed.accessToken);
                        console.log('Token refreshed and quota fetched successfully.');
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
                // 获取分组内的模型
                const groupedModelNames = new Set<string>();
                groupsConfig.groups.forEach(g => {
                    g.models.forEach((modelName: string) => groupedModelNames.add(modelName));
                });

                // 只显示分组内的模型，如果没有分组则显示所有
                const modelsToShow = groupedModelNames.size > 0
                    ? quota.models.filter((m: any) => groupedModelNames.has(m.name))
                    : quota.models;

                // 计算模型名的最大宽度（中文按2位算，简单正则处理）
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

                const maxNameWidth = Math.max(...modelsToShow.map((m: any) => getLen(m.name)), 15);
                const lines: string[] = [];

                modelsToShow.forEach((m: any) => {
                    const icon = m.percentage > 50 ? "🟢" : (m.percentage > 20 ? "🟡" : "🔴");
                    const filledBlocks = Math.round(m.percentage / 10);
                    const emptyBlocks = 10 - filledBlocks;
                    const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);

                    let timeInfo = '';
                    // 使用 reset_time_raw (原始 UTC 时间) 计算倒计时
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

                    // 保持使用 → 符号，getLen 会将其识别为 2 位宽（图标/非ASCII）
                    lines.push(`${icon} ${paddedName} ${progressBar} ${pctStr} → ${timeStr}`);
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

            // 更新状态栏显示错误状态，点击时尝试重新连接
            statusBarItem.text = `$(error) ${t('reconnect')}`;
            // 详细错误信息放在 tooltip 中，方便排查
            const errorTooltip = new vscode.MarkdownString();
            errorTooltip.appendMarkdown(`**Antigravity Copilot**\n\n`);
            errorTooltip.appendMarkdown(`❌ *连接失败*\n\n`);
            errorTooltip.appendMarkdown(`错误信息: ${e.message || 'Unknown error'}\n\n`);
            if (e.response && e.response.status) {
                errorTooltip.appendMarkdown(` (Status: ${e.response.status})`);
            }
            errorTooltip.appendMarkdown(`\n\n*${t('reconnect')}*`);
            statusBarItem.tooltip = errorTooltip;

            statusBarItem.command = 'antigravity-cockpit.reconnect';
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
                    t('reconnect'),
                    t('close')
                ).then(selection => {
                    if (selection === t('reconnect')) {
                        updateStatusBar();
                    }
                });
            }
        }
    }

    // 连接状态跟踪
    let lastConnectionError = false;
    let lastNotificationTime = 0;
    let connectionErrorCount = 0;

    // Initial update: 先尝试自动导入 IDE 当前账号，再刷新状态栏
    autoImportCurrentAccount().finally(() => {
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
            autoRefreshTimer = setInterval(() => {
                updateStatusBar();
            }, intervalMs);
            console.log(`Antigravity Multi-Account Cockpit: 自动刷新已启用，间隔 ${intervalMinutes} 分钟`);
        } else {
            console.log('Antigravity Multi-Account Cockpit: 自动刷新已禁用');
        }
    }

    // 初始化定时刷新
    setupAutoRefresh();

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
            vscode.window.showErrorMessage(`添加账号失败: ${(e as Error).message}`);
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

                // 更新当前账号索引 (这部分可以先做，因为它是插件自己的配置文件)
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
        DashboardProvider.createOrShow(context.extensionUri);
        // Dashboard 打开/刷新时会通过 fetchQuotaCached 获取最新配额，
        // 这里等待短暂延时让 Dashboard 先完成缓存填充，再刷新 StatusBar（命中缓存，无重复请求）
        setTimeout(() => updateStatusBar(), 500);
    });

    let refreshAccountCommand = vscode.commands.registerCommand('antigravity-cockpit.refreshAccount', async (accountId: string) => {
        try {
            const account = AccountManager.loadAccount(accountId);
            if (account.token) {
                const refreshed = await AccountManager.refreshToken(account.token.refresh_token);
                account.token.access_token = refreshed.accessToken;
                account.token.expiry_timestamp = Math.floor(Date.now() / 1000) + refreshed.expiresIn;
                AccountManager.saveAccount(account);
                AccountManager.clearQuotaCache(); // 手动刷新 → 清除缓存，确保获取最新数据
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
        }, async () => {
            AccountManager.clearQuotaCache(); // 手动刷新全部 → 清除缓存
            const index = AccountManager.loadIndex();
            for (const accSum of index.accounts) {
                try {
                    const account = AccountManager.loadAccount(accSum.id);
                    if (account.token) {
                        const refreshed = await AccountManager.refreshToken(account.token.refresh_token);
                        account.token.access_token = refreshed.accessToken;
                        account.token.expiry_timestamp = Math.floor(Date.now() / 1000) + refreshed.expiresIn;
                        AccountManager.saveAccount(account);
                    }
                } catch (e) {
                    console.error(`无法刷新 ${accSum.email}`, e);
                }
            }
            accountTreeProvider.refresh();
            DashboardProvider.refresh(); // 刷新设置面板
            updateStatusBar(); // 同步刷新状态栏限额数据
            vscode.window.showInformationMessage(t('allAccountsRefreshed'));
        });
    });

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
        results.push('## Antigravity Multi-Account Cockpit 环境自检报告\n');

        // 1. Node.js 检测
        results.push('### 1. Node.js 环境');
        let nodePath = '';
        let nodeStatus = '❌ 未找到';
        try {
            if (platform === 'win32') {
                try {
                    const result = execSync('where node', { encoding: 'utf-8', windowsHide: true });
                    const lines = result.trim().split('\n');
                    if (lines.length > 0 && fs.existsSync(lines[0].trim())) {
                        nodePath = lines[0].trim();
                        nodeStatus = '✅ 已找到';
                    }
                } catch (e) {
                    // 忽略
                }
            } else {
                nodePath = execSync('which node', { encoding: 'utf-8' }).trim();
                if (nodePath && fs.existsSync(nodePath)) {
                    nodeStatus = '✅ 已找到';
                }
            }
        } catch (e) {
            nodeStatus = '❌ 检测失败';
        }
        results.push(`- 状态: ${nodeStatus}`);
        if (nodePath) {
            results.push(`- 路径: \`${nodePath}\``);
        }
        results.push('');

        // 2. 数据库路径检测
        results.push('### 2. Antigravity IDE 数据库');
        const { getVSCDBPath } = require('./constants');
        const dbPathOverride = config.get<string>('databasePathOverride', '');
        const actualDbPath = dbPathOverride && dbPathOverride.trim() ? dbPathOverride.trim() : getVSCDBPath();
        const dbExists = fs.existsSync(actualDbPath);
        results.push(`- 路径: \`${actualDbPath}\``);
        results.push(`- 状态: ${dbExists ? '✅ 存在' : '⚠️ 不存在（IDE 可能未安装或未启动过）'}`);
        if (dbPathOverride) {
            results.push(`- 配置覆盖: \`${dbPathOverride}\``);
        }
        results.push('');

        // 3. Antigravity 可执行文件检测
        results.push('### 3. Antigravity IDE 可执行文件');
        const exePathConfig = config.get<{ win32?: string; darwin?: string; linux?: string }>('antigravityExecutablePath', {});
        let exePath = '';
        let exeStatus = '❌ 未找到';

        if (platform === 'win32') {
            exePath = exePathConfig.win32 && exePathConfig.win32.trim()
                ? exePathConfig.win32.trim()
                : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe');
            if (fs.existsSync(exePath)) {
                exeStatus = '✅ 已找到';
            }
        } else if (platform === 'darwin') {
            exePath = exePathConfig.darwin && exePathConfig.darwin.trim()
                ? exePathConfig.darwin.trim()
                : '/Applications/Antigravity.app';
            if (fs.existsSync(exePath)) {
                exeStatus = '✅ 已找到';
            }
        } else {
            // Linux
            const possiblePaths = exePathConfig.linux && exePathConfig.linux.trim()
                ? [exePathConfig.linux.trim()]
                : ['/usr/bin/antigravity', '/opt/antigravity/antigravity', path.join(process.env.HOME || '', '.local/bin/antigravity')];
            for (const p of possiblePaths) {
                if (fs.existsSync(p)) {
                    exePath = p;
                    exeStatus = '✅ 已找到';
                    break;
                }
            }
        }

        results.push(`- 状态: ${exeStatus}`);
        if (exePath) {
            results.push(`- 路径: \`${exePath}\``);
        }
        if (Object.keys(exePathConfig).length > 0) {
            results.push(`- 配置覆盖: ${JSON.stringify(exePathConfig)}`);
        }
        results.push('');

        // 4. 平台信息
        results.push('### 4. 平台信息');
        results.push(`- 操作系统: \`${platform}\``);
        results.push(`- 架构: \`${os.arch()}\``);
        results.push('');

        // 5. 配置信息
        results.push('### 5. 当前配置');
        const switchMode = config.get<string>('switchMode', 'advanced');
        const autoRefreshInterval = config.get<number>('autoRefreshInterval', 5);
        results.push(`- 切换模式: \`${switchMode}\``);
        results.push(`- 自动刷新间隔: \`${autoRefreshInterval} 分钟\``);
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
            '环境自检报告已生成。',
            '复制报告'
        );
        if (action === '复制报告') {
            await vscode.env.clipboard.writeText(report);
            vscode.window.showInformationMessage('报告已复制到剪贴板。');
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
                    res.end('<h1>✅ 授权成功!</h1><p>您可以关闭此窗口返回 VS Code。</p><script>setTimeout(function() { window.close(); }, 2000);</script>');

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
                    res.end(`<h1>❌ 授权失败</h1><p>${queryObject.error}</p>`);
                    server.close();
                    reject(new Error(`授权服务返回错误: ${queryObject.error}`));
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

            const copy = '复制链接';
            const open = '在默认浏览器打开';
            const result = await vscode.window.showInformationMessage(
                '🔐 请在浏览器中完成 Google 授权。授权完成后将自动同步账号。',
                { modal: true },
                open,
                copy
            );

            if (result === copy) {
                await vscode.env.clipboard.writeText(authUrl);
                vscode.window.showInformationMessage('✅ 授权链接已复制到剪贴板，请在浏览器中粘贴访问。');
            } else if (result === open) {
                vscode.env.openExternal(vscode.Uri.parse(authUrl));
            } else {
                // 用户取消，关闭服务器
                server.close();
                reject(new Error('用户取消授权'));
                return;
            }
        });

        setTimeout(() => {
            if (server.listening) {
                server.close();
                reject(new Error('授权超时，请重试。'));
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
