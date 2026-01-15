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
    USERINFO_URL
} from './constants';

import { DashboardProvider } from './dashboardProvider';
import { ModelGroupManager } from './modelGroupManager';
import { SwitcherProxy } from './switcherProxy';

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
    const accountTreeProvider = new AccountTreeProvider();
    // vscode.window.registerTreeDataProvider('antigravityAccounts', accountTreeProvider);

    // --- Welcome Message for First Install ---
    if (!context.globalState.get('hasShownWelcome')) {
        vscode.window.showInformationMessage(
            '🚀 Antigravity Cockpit 已成功安装！请关注底部状态栏的 UFO 图标。',
            '打开面板'
        ).then(selection => {
            if (selection === '打开面板') {
                vscode.commands.executeCommand('antigravity-cockpit.openDashboard');
            }
        });
        context.globalState.update('hasShownWelcome', true);
    }

    // --- Status Bar Section ---
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'antigravity-cockpit.openDashboard';
    context.subscriptions.push(statusBarItem);

    async function updateStatusBar() {
        const index = AccountManager.loadIndex();
        if (!index.current_account_id) {
            statusBarItem.text = "$(account) 无账号";
            statusBarItem.tooltip = "点击登录或添加 Antigravity 账号";
            statusBarItem.show();
            return;
        }

        try {
            const account = AccountManager.loadAccount(index.current_account_id);

            if (!account.token) {
                statusBarItem.text = `$(account) ${account.email.split('@')[0]}`;
                statusBarItem.tooltip = "点击查看账号详情";
                statusBarItem.show();
                return;
            }

            let quota;
            try {
                // 尝试获取配额
                quota = await AccountManager.fetchQuota(account.token.access_token);
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
                        quota = await AccountManager.fetchQuota(refreshed.accessToken);
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
                    if (m.reset_time) {
                        const resetDate = new Date(m.reset_time);
                        const now = new Date();
                        const diffMs = resetDate.getTime() - now.getTime();
                        if (diffMs > 0) {
                            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                            const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                            const resetTimeStr = resetDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
                            timeInfo = `${diffHours}h${String(diffMins).padStart(2, '0')}m (${resetTimeStr})`;
                        } else {
                            timeInfo = '已重置';
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
                const leftText = '点击打开设置面板';
                const rightText = `当前账号：${currentAccountLabel}`;

                // 剩余空格 = 总行宽 - 左侧格数 - 右侧格数
                const spaces = Math.max(1, totalLineWidth - getLen(leftText) - getLen(rightText));
                lines.push(leftText + ' '.repeat(spaces) + rightText);

                tooltip.appendMarkdown('```\n' + lines.join('\n') + '\n```\n');
            } else {
                // 无权限时简单展示当前账号
                const currentAccountLabel = account.name || account.email;
                tooltip.appendMarkdown('```\n');
                tooltip.appendMarkdown(`配额: 无权限    当前账号：${currentAccountLabel}\n`);
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
            statusBarItem.text = "$(error) 连接失败";
            // 详细错误信息放在 tooltip 中，方便排查
            const errorTooltip = new vscode.MarkdownString();
            errorTooltip.appendMarkdown(`**Antigravity Copilot**\n\n`);
            errorTooltip.appendMarkdown(`❌ *连接失败*\n\n`);
            errorTooltip.appendMarkdown(`错误信息: ${e.message || 'Unknown error'}\n\n`);
            if (e.response && e.response.status) {
                errorTooltip.appendMarkdown(` (Status: ${e.response.status})`);
            }
            errorTooltip.appendMarkdown(`\n\n*点击尝试重新连接*`);
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

                const errorMessage = e.message || '未知错误';
                vscode.window.showWarningMessage(
                    `Antigravity 账户连接失败: ${errorMessage}`,
                    '重新连接',
                    '关闭'
                ).then(selection => {
                    if (selection === '重新连接') {
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

    // Initial update
    updateStatusBar();
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
        vscode.window.showInformationMessage('正在尝试重新连接...');
        try {
            await updateStatusBar();
            if (!lastConnectionError) {
                vscode.window.showInformationMessage('连接成功！');
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
            console.log(`Antigravity Cockpit: 自动刷新已启用，间隔 ${intervalMinutes} 分钟`);
        } else {
            console.log('Antigravity Cockpit: 自动刷新已禁用');
        }
    }

    // 初始化定时刷新
    setupAutoRefresh();

    // 监听配置变化
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antigravity-cockpit.autoRefreshInterval')) {
                setupAutoRefresh();
                vscode.window.showInformationMessage('自动刷新设置已更新');
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
                vscode.window.showInformationMessage(`账号 ${userInfo.email} 添加成功！`);
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
                ? `当前为【安全模式】：将仅在 Cockpit 内切换到账号 ${item.email}，不会自动修改 IDE 数据库或重启 IDE。是否继续？`
                : `切换到账号 ${item.email} 将触发完整切换流程：关闭并自动重启 Antigravity IDE（包含数据库注入）。若自动重启失败，你可以手动重新打开 IDE。是否继续？`;

        const confirm = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            '是'
        );

        if (confirm !== '是') { return; }

        if (switchMode === 'safe') {
            // 安全模式：只更新当前账号索引与 UI，不做 Kill/注入/自动重启
            const index = AccountManager.loadIndex();
            index.current_account_id = accountId;
            AccountManager.saveIndex(index);

            accountTreeProvider.refresh();
            DashboardProvider.refresh();

            vscode.window.showInformationMessage(
                `已切换到账号 ${item.email}（安全模式）。请手动重启 Antigravity IDE 以让内置 Agent 生效。`
            );
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "正在切换 Antigravity 账号",
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ message: "正在加载账号信息..." });
                const account = AccountManager.loadAccount(accountId);
                if (!account.token) { throw new Error("该账号暂无 Token"); }

                // Check/Refresh token
                let token = account.token;
                if (Date.now() / 1000 > token.expiry_timestamp - 300) {
                    progress.report({ message: "正在刷新 Token..." });
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

                // 读取配置中的路径覆盖
                const config = vscode.workspace.getConfiguration('antigravity-cockpit');
                const dbPathOverride = config.get<string>('databasePathOverride', '');
                const exePathConfig = config.get<{ win32?: string; darwin?: string; linux?: string }>('antigravityExecutablePath', {});

                // 启动外部代理接管后续的 Kill -> Inject -> Restart
                await SwitcherProxy.executeExternalSwitch(
                    token.access_token,
                    token.refresh_token,
                    token.expiry_timestamp,
                    dbPathOverride || undefined,
                    Object.keys(exePathConfig).length > 0 ? exePathConfig : undefined
                );

                progress.report({ message: "正在请求 IDE 退出并重启..." });

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

    let openDashboardCommand = vscode.commands.registerCommand('antigravity-cockpit.openDashboard', () => {
        DashboardProvider.createOrShow(context.extensionUri);
    });

    let refreshAccountCommand = vscode.commands.registerCommand('antigravity-cockpit.refreshAccount', async (accountId: string) => {
        try {
            const account = AccountManager.loadAccount(accountId);
            if (account.token) {
                const refreshed = await AccountManager.refreshToken(account.token.refresh_token);
                account.token.access_token = refreshed.accessToken;
                account.token.expiry_timestamp = Math.floor(Date.now() / 1000) + refreshed.expiresIn;
                AccountManager.saveAccount(account);
                accountTreeProvider.refresh();
                DashboardProvider.refresh(); // 新增：刷新数据
                vscode.window.showInformationMessage(`已刷新账号 ${account.email}`);
            }
        } catch (e) {
            vscode.window.showErrorMessage(`刷新失败: ${(e as Error).message}`);
        }
    });

    let deleteAccountCommand = vscode.commands.registerCommand('antigravity-cockpit.deleteAccount', async (item: any) => {
        const accountId = item.accountId;
        const email = item.email || '未命名账号';

        if (!accountId) { return; }

        const confirm = await vscode.window.showWarningMessage(
            `确定要删除账号 ${email} 吗？此操作无法撤销。`,
            { modal: true },
            '确定'
        );

        if (confirm !== '确定') { return; }

        try {
            AccountManager.deleteAccount(accountId);

            // 如果删除了当前账号，更新状态栏
            updateStatusBar();

            accountTreeProvider.refresh();
            DashboardProvider.refresh();
            vscode.window.showInformationMessage(`账号 ${email} 已删除`);
        } catch (e) {
            vscode.window.showErrorMessage(`删除失败: ${(e as Error).message}`);
        }
    });

    let refreshAllAccountsCommand = vscode.commands.registerCommand('antigravity-cockpit.refreshAllAccounts', async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "正在刷新所有账号信息...",
            cancellable: false
        }, async () => {
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
            DashboardProvider.refresh(); // 新增：刷新数据
            vscode.window.showInformationMessage('所有账号信息已更新');
        });
    });

    // 打开外部切换代理日志目录（ag_switch_*.log 所在的临时目录）
    let openSwitchLogsCommand = vscode.commands.registerCommand('antigravity-cockpit.openSwitchLogs', async () => {
        const tempDir = os.tmpdir();
        const uri = vscode.Uri.file(tempDir);
        await vscode.env.openExternal(uri);
        vscode.window.showInformationMessage('已打开系统临时目录，请查找最新的 ag_switch_*.log 日志文件。');
    });

    // 环境自检命令
    let diagnoseEnvironmentCommand = vscode.commands.registerCommand('antigravity-cockpit.diagnoseEnvironment', async () => {
        const { execSync } = require('child_process');
        const fs = require('fs');
        const path = require('path');
        const platform = os.platform();
        const config = vscode.workspace.getConfiguration('antigravity-cockpit');

        const results: string[] = [];
        results.push('## Antigravity Cockpit 环境自检报告\n');

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
