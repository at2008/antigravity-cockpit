import * as vscode from 'vscode';
import { AccountManager, Account } from './accountManager';
import { ModelGroupManager, ModelGroup, ModelGroupsConfig, ModelInfo, DiscoveredQuotaGroup } from './modelGroupManager';
import { TokenStatsManager } from './tokenStatsManager';
import { t, getTranslations } from './i18n';

export class DashboardProvider {
    public static readonly viewType = 'antigravityDashboard';
    private static _currentPanel: DashboardProvider | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (DashboardProvider._currentPanel) {
            DashboardProvider._currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            DashboardProvider.viewType,
            'Antigravity Multi-Account Cockpit',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        DashboardProvider._currentPanel = new DashboardProvider(panel, extensionUri);
    }

    public static refresh() {
        if (DashboardProvider._currentPanel) {
            DashboardProvider._currentPanel._update();
        }
    }

    /**
     * 后台推送最新账号状态到 Webview (无损更新，不刷新整个 HTML)
     */
    public static postUpdate() {
        if (DashboardProvider._currentPanel) {
            DashboardProvider._currentPanel._postState();
        }
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._update();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // 监听配置变化（特别是语言切换），实时刷新界面以应用新翻译
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antigravity-cockpit.language') || e.affectsConfiguration('antigravity-cockpit.targetClient')) {
                this._update();
            }
        }, null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                try {
                    switch (message.command) {
                        case 'switch':
                            await vscode.commands.executeCommand('antigravity-cockpit.switchAccount', { accountId: message.accountId, email: message.email });
                            this._update();
                            return;
                        case 'refresh':
                            await vscode.commands.executeCommand('antigravity-cockpit.refreshAccount', message.accountId);
                            this._update();
                            return;
                        case 'refreshAll':
                            await vscode.commands.executeCommand('antigravity-cockpit.refreshAllAccounts');
                            this._update();
                            return;
                        case 'addAccount':
                            await vscode.commands.executeCommand('antigravity-cockpit.addAccount');
                            this._update();
                            return;
                        case 'loginWithToken':
                            await vscode.commands.executeCommand('antigravity-cockpit.loginWithToken', message.token);
                            this._update();
                            return;
                        case 'exportToken':
                            await vscode.commands.executeCommand('antigravity-cockpit.exportToken', message.accountId);
                            return;
                        case 'batchExportTokens':
                            await vscode.commands.executeCommand('antigravity-cockpit.batchExportTokens');
                            return;
                        case 'batchImportTokens':
                            await vscode.commands.executeCommand('antigravity-cockpit.batchImportTokens', message.jsonText);
                            this._update();
                            return;
                        case 'delete':
                            await vscode.commands.executeCommand('antigravity-cockpit.deleteAccount', { accountId: message.accountId, email: message.email });
                            return;

                        // === 分组管理相关命令 ===
                        case 'getGroupsConfig': {
                            const index = AccountManager.loadIndex();
                            const accounts = (index.accounts || []).map(a => AccountManager.loadAccount(a.id));
                            const sourceId = message.sourceAccountId || '__all__';
                            const prune = message.prune !== false;

                            let discovered: DiscoveredQuotaGroup[] = [];

                            if (sourceId === '__all__') {
                                for (const acc of accounts) {
                                    if (acc.cached_quota && acc.cached_quota.data) {
                                        const groups = ModelGroupManager.extractGroupsFromQuota(acc.cached_quota.data);
                                        for (const g of groups) {
                                            if (!discovered.some(d => d.displayName.toLowerCase() === g.displayName.toLowerCase())) {
                                                discovered.push(g);
                                            }
                                        }
                                    }
                                }
                            } else {
                                const targetAcc = accounts.find(a => a.id === sourceId || (sourceId === '__current__' && a.id === index.current_account_id));
                                if (targetAcc && targetAcc.cached_quota && targetAcc.cached_quota.data) {
                                    discovered = ModelGroupManager.extractGroupsFromQuota(targetAcc.cached_quota.data);
                                }
                            }

                            if (discovered.length > 0) {
                                ModelGroupManager.syncDiscoveredGroups(discovered, prune);
                            }
                            const config = ModelGroupManager.loadGroups();
                            this._panel.webview.postMessage({
                                command: 'groupsConfig',
                                config: config,
                                sourceAccountId: sourceId
                            });
                            return;
                        }

                        case 'resetGroups': {
                            const config = ModelGroupManager.resetToDefaults([]);
                            this._panel.webview.postMessage({
                                command: 'groupsConfig',
                                config: config
                            });
                            vscode.commands.executeCommand('antigravity-cockpit.refreshStatusBar');
                            vscode.window.showInformationMessage(t('configSaved'));
                            return;
                        }

                        case 'saveGroups':
                            // 直接保存完整分组配置
                            ModelGroupManager.saveGroups(message.config);
                            vscode.commands.executeCommand('antigravity-cockpit.refreshStatusBar');
                            vscode.window.showInformationMessage(t('configSaved'));
                            return;

                        case 'getRefreshInterval':
                            // 获取当前刷新间隔配置
                            const currentConfig = vscode.workspace.getConfiguration('antigravity-cockpit');
                            const currentInterval = currentConfig.get<number>('autoRefreshInterval', 5);
                            this._panel.webview.postMessage({
                                command: 'refreshIntervalValue',
                                value: currentInterval
                            });
                            return;

                        case 'setRefreshInterval':
                            // 设置刷新间隔
                            const newInterval = message.value;
                            vscode.workspace.getConfiguration('antigravity-cockpit').update(
                                'autoRefreshInterval',
                                newInterval,
                                vscode.ConfigurationTarget.Global
                            );
                            return;

                        case 'setTargetClient':
                            // 设置生效客户端
                            const newTarget = message.value;
                            await vscode.workspace.getConfiguration('antigravity-cockpit').update(
                                'targetClient',
                                newTarget,
                                vscode.ConfigurationTarget.Global
                            );
                            this._update();
                            return;

                        case 'setLanguage':
                            // 设置语言
                            const newLang = message.value;
                            await vscode.workspace.getConfiguration('antigravity-cockpit').update(
                                'language',
                                newLang,
                                vscode.ConfigurationTarget.Global
                            );
                            // 语言改变后刷新整个 webview 以应用新翻译
                            this._update();
                            return;

                        case 'updateUiState':
                            // 持久化 UI 状态到索引文件
                            const uiIndex = AccountManager.loadIndex();
                            uiIndex.ui_state = { ...uiIndex.ui_state, ...message.state };
                            AccountManager.saveIndex(uiIndex);
                            return;

                        // === Token 统计相关消息 ===
                        case 'getTokenStats': {
                            const range = message.timeRange || message.daysLimit || 'today';
                            await this._sendTokenStats(range);
                            return;
                        }
                        case 'refreshTokenStats': {
                            const range = message.timeRange || message.daysLimit || 'today';
                            await this._sendTokenStats(range);
                            return;
                        }
                    }
                } catch (err: any) {
                    console.error('[Cockpit] Webview message handler error:', err);
                    vscode.window.showErrorMessage(`[Cockpit] ${err.message || err}`);
                }
            },
            null,
            this._disposables
        );
    }

    public static refreshTokenStats() {
        if (DashboardProvider._currentPanel) {
            DashboardProvider._currentPanel._sendTokenStats('today');
        }
    }

    private async _sendTokenStats(timeRange: any = 'today') {
        try {
            const report = await TokenStatsManager.getReport(undefined, timeRange);
            this._panel.webview.postMessage({
                command: 'tokenStatsData',
                data: report
            });
        } catch (err: any) {
            console.error('[Cockpit] Failed to send token stats:', err);
        }
    }

    public async refresh() {
        this._update();
    }

    public dispose() {
        DashboardProvider._currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) { (x as any).dispose(); }
        }
    }

    private async _update() {
        const index = AccountManager.loadIndex();
        const groupsConfig = ModelGroupManager.loadGroups();

        // === 第一阶段：立即渲染（结合内存缓存与磁盘快照，不发网络请求）===
        const accountsDataPhase1 = index.accounts.map(acc => {
            const fullAcc = AccountManager.loadAccount(acc.id);
            let quota = null;
            if (fullAcc.token) {
                // 优先读取内存缓存，未命中则读取磁盘持久化快照
                quota = AccountManager.getQuota(fullAcc);
            }
            return {
                ...fullAcc,
                quota,
                isCurrent: acc.id === index.current_account_id
            };
        });

        // 立即渲染界面（已有缓存或快照的账号立即显示完整卡片）
        this._panel.webview.html = this._getHtmlForWebview(accountsDataPhase1, groupsConfig, index.ui_state || {});

        // === 第二阶段：后台获取当前账号最新配额（若内存中尚无实时缓存）===
        const currentAccPhase1 = accountsDataPhase1.find(acc => acc.isCurrent && acc.token);
        if (currentAccPhase1 && currentAccPhase1.token) {
            const inMemQuota = AccountManager.getQuotaFromCache(currentAccPhase1.token.access_token);
            if (!inMemQuota) {
                try {
                    const freshQuota = await AccountManager.fetchQuotaCached(currentAccPhase1.token.access_token);
                    if (freshQuota && !freshQuota.is_error && index.current_account_id) {
                        AccountManager.saveAccountQuota(index.current_account_id, freshQuota);
                    }
                    this._postState();
                } catch (e: any) {
                    if (e.response && e.response.status === 401) {
                        vscode.commands.executeCommand('antigravity-cockpit.refreshStatusBar');
                    }
                }
            }
        }
    }

    /**
     * 采集当前所有账号的最新状态并推送到前端
     */
    private _postState() {
        const index = AccountManager.loadIndex();
        const accountsData = index.accounts.map(acc => {
            const fullAcc = AccountManager.loadAccount(acc.id);
            let quota = null;
            if (fullAcc.token) {
                quota = AccountManager.getQuota(fullAcc);
            }
            return {
                ...fullAcc,
                quota,
                isCurrent: acc.id === index.current_account_id
            };
        });

        this._panel.webview.postMessage({
            command: 'updateAccounts',
            accounts: accountsData
        });
    }

    private _getHtmlForWebview(accountsData: any[], groupsConfig: any, uiState: any = {}) {
        const accountsJson = JSON.stringify(accountsData);
        const groupsJson = JSON.stringify(groupsConfig);
        const translationsJson = JSON.stringify(getTranslations());
        const uiStateJson = JSON.stringify(uiState);
        const languageConfig = vscode.workspace.getConfiguration('antigravity-cockpit').get<string>('language') || 'auto';
        const targetClientConfig = vscode.workspace.getConfiguration('antigravity-cockpit').get<string>('targetClient') || 'all';

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Antigravity Multi-Account Cockpit</title>
                <style>
                    :root {

                        --primary-blue: #0ea5e9;
                        --primary-blue-hover: #0284c7;
                        --primary-teal: #14b8a6;
                        --primary-teal-hover: #0d9488;
                        --bg-modal: rgba(0, 0, 0, 0.6);
                        --bg-card: var(--vscode-sideBar-background);
                        --bg-input: var(--vscode-input-background);
                        --border-color: var(--vscode-widget-border);
                        --text-primary: var(--vscode-foreground);
                        --text-secondary: var(--vscode-descriptionForeground);
                        --accent-blue: rgba(14, 165, 233, 0.1);
                        --radius: 12px;
                        --transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
                    }
                    body {
                        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
                        padding: 6px;
                        margin: 0;
                        color: var(--text-primary);
                        background-color: var(--vscode-editor-background);
                        line-height: 1.3;
                        overflow-x: hidden;
                    }
                    /* Header Area */
                    .header {
                        margin-bottom: 12px;
                        display: flex;
                        flex-direction: column;
                        gap: 10px;
                    }
                    .header-top-row {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        gap: 2px;
                        padding: 8px 0 4px 0;
                    }
                    .header-bottom-row {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        flex-wrap: wrap;
                        gap: 6px;
                        padding: 6px 0;
                    }
                    .header-title-section {
                        display: flex;
                        align-items: center;
                        gap: 2px;
                    }
                    .header h1 {
                        margin: 0;
                        font-size: 28px;
                        font-weight: 700;
                        letter-spacing: -0.5px;
                        background: linear-gradient(135deg, var(--text-primary) 0%, var(--primary-blue) 100%);
                        -webkit-background-clip: text;
                        -webkit-text-fill-color: transparent;
                        white-space: nowrap;
                    }
                    .header-actions {
                        display: flex;
                        align-items: center;
                        flex-wrap: wrap;
                        gap: 4px;
                    }

                    /* Tabs - Sidebar Style */
                    #tabViewContainer {
                        display: flex;
                        gap: 8px;
                        align-items: flex-start;
                    }
                    #panelContainer {
                        flex: 1;
                        min-width: 0;
                    }
                    .tabs {
                        display: flex;
                        flex-direction: column;
                        width: auto;
                        max-width: 180px;
                        min-width: 100px;
                        flex-shrink: 0;
                        gap: 2px;
                        padding-right: 2px;
                        border-right: 1px solid var(--border-color);
                        max-height: calc(100vh - 160px);
                        padding-bottom: 24px;
                        overflow-y: auto;
                    }
                    .tabs::-webkit-scrollbar { width: 4px; height: 4px; }
                    .tabs::-webkit-scrollbar-thumb { background: rgba(127,127,127,0.2); border-radius: 4px; }
                    .tab {
                        padding: 6px 8px;
                        cursor: pointer;
                        border-radius: 6px;
                        background: transparent;
                        color: var(--text-secondary);
                        font-size: 13px;
                        font-weight: 500;
                        transition: var(--transition);
                        display: flex;
                        align-items: center;
                        border: 1px solid transparent;
                    }
                    .tab:hover {
                        background: rgba(14, 165, 233, 0.08);
                        color: var(--text-primary);
                    }
                    .tab.active {
                        background: rgba(14, 165, 233, 0.12);
                        color: var(--primary-blue);
                        box-shadow: inset 3px 0 0 var(--primary-blue);
                    }
                    .tab-name {
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        flex: 1;
                    }

                    /* Account Panel */
                    .account-panel {
                        display: none;
                        border: 1px solid var(--border-color);
                        border-radius: 8px;
                        padding: 8px;
                        background: var(--vscode-sideBar-background);
                        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
                        animation: fadeIn 0.4s ease;
                        position: relative;
                        overflow: hidden;
                    }
                    .account-panel::before {
                        content: '';
                        position: absolute;
                        top: 0; left: 0; right: 0;
                        height: 4px;
                        background: linear-gradient(90deg, var(--primary-blue), var(--primary-teal));
                        opacity: 0.8;
                    }
                    @keyframes fadeIn {
                        from { opacity: 0; transform: translateY(10px); }
                        to { opacity: 1; transform: translateY(0); }
                    }
                    .account-panel.active {
                        display: block;
                    }
                    .panel-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 10px;
                        gap: 2px;
                        /* flex-wrap: wrap; removed for compactness */
                    }
                    .account-info h2 {
                        margin: 0;
                        font-size: 18px;
                        font-weight: 600;
                    }
                    .account-info-row {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        flex-wrap: wrap;
                    }
                    .account-info-meta {
                        margin-top: 4px;
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        color: var(--text-secondary);
                        font-size: 12px;
                        flex-wrap: wrap;
                    }
                    .meta-divider {
                        opacity: 0.3;
                        font-size: 10px;
                    }

                    /* Quota Grid */
                    .quota-grid {
                        display: grid;
                        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
                        gap: 2px;
                        margin-top: 16px;
                    }
                    .quota-card {
                        padding: 8px;
                        border-radius: 8px;
                        background: var(--vscode-editor-background);
                        border: 1px solid var(--border-color);
                        transition: var(--transition);
                        position: relative;
                    }
                    .quota-card:hover {
                        border-color: var(--primary-blue);
                        transform: translateY(-3px);
                        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
                    }
                    .quota-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 8px;
                        font-weight: 600;
                        font-size: 13px;
                    }
                    .model-id {
                        font-family: 'Consolas', 'Courier New', monospace;
                        font-size: 12px;
                        font-weight: 600;
                        color: var(--text-primary);
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                    }
                    .quota-row {
                        margin-top: 6px;
                    }
                    .quota-row-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        font-size: 11px;
                        font-weight: 600;
                        margin-bottom: 3px;
                    }
                    .quota-row-label {
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        opacity: 0.85;
                    }
                    .quota-row-value {
                        font-family: 'Consolas', 'Courier New', monospace;
                        font-size: 11px;
                    }
                    .quota-row-meta {
                        display: flex;
                        justify-content: space-between;
                        font-size: 10px;
                        color: var(--text-secondary);
                        margin-top: 2px;
                    }
                    .progress-bar {
                        height: 8px;
                        background: rgba(127, 127, 127, 0.2);
                        border-radius: 4px;
                        overflow: hidden;
                        margin-bottom: 6px;
                    }
                    .progress-bar.mini {
                        height: 6px;
                        margin-bottom: 2px;
                    }
                    .progress-fill {
                        height: 100%;
                        border-radius: 4px;
                        transition: width 1s ease-out;
                    }
                    .quota-meta {
                        display: flex;
                        justify-content: space-between;
                        font-size: 11px;
                        color: var(--text-secondary);
                        margin-top: 8px;
                    }
                    .quota-meta span:first-child {
                        opacity: 0.8;
                    }
                    .quota-meta span:last-child {
                        font-weight: 500;
                    }

                    /* Buttons */
                    .btn-group {
                        display: flex;
                        gap: 4px;
                        flex-wrap: wrap;
                        align-items: center;
                    }
                    button {
                        padding: 5px 12px;
                        cursor: pointer;
                        border: none;
                        border-radius: 4px;
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        font-size: 12px;
                        font-weight: 500;
                        transition: var(--transition);
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        white-space: nowrap;
                    }
                    button:hover {
                        background: var(--vscode-button-hoverBackground);
                        filter: brightness(1.1);
                    }
                    button:active {
                        transform: scale(0.98);
                    }
                    button:disabled {
                        opacity: 0.4;
                        cursor: not-allowed;
                    }
                    button.secondary {
                        background: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                    }
                    button.teal {
                        background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%);
                        color: white !important;
                    }
                    button.blue {
                        background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
                        color: white !important;
                    }

                    /* Custom Global Tooltip */
                    #custom-global-tooltip {
                        position: fixed;
                        visibility: hidden;
                        opacity: 0;
                        background: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-widget-border, var(--border-color));
                        padding: 10px;
                        border-radius: 6px;
                        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
                        color: var(--vscode-editor-foreground);
                        font-family: 'Consolas', 'Courier New', monospace;
                        font-size: 12px;
                        white-space: pre;
                        z-index: 99999;
                        pointer-events: none;
                        transition: opacity 0.15s ease;
                        line-height: 1.4;
                    }
                    #custom-global-tooltip.visible {
                        visibility: visible;
                        opacity: 1;
                    }
                    .tt-bar {
                        display: inline-block;
                        width: 10ch;
                        height: 9px;
                        vertical-align: middle;
                        box-sizing: border-box;
                        border: 1px solid rgba(127, 127, 127, 0.4);
                        border-radius: 2px;
                        overflow: hidden;
                        background-color: rgba(127, 127, 127, 0.12);
                        background-image: repeating-linear-gradient(
                            -45deg,
                            rgba(127, 127, 127, 0.25),
                            rgba(127, 127, 127, 0.25) 2px,
                            transparent 2px,
                            transparent 4px
                        );
                    }
                    .tt-fill {
                        display: block;
                        height: 100%;
                        background: var(--vscode-editor-foreground, currentColor);
                    }
                    .tt-grid-3 {
                        display: grid;
                        grid-template-columns: auto auto auto;
                        column-gap: 14px;
                        row-gap: 2px;
                        align-items: center;
                    }
                    .tt-grid-2 {
                        display: grid;
                        grid-template-columns: auto auto;
                        column-gap: 14px;
                        row-gap: 2px;
                        align-items: center;
                    }
                    button.danger {
                        background: #fee2e2;
                        color: #dc2626 !important;
                        border: 1px solid #fecaca;
                    }
                    button.danger:hover {
                        background: #fecaca;
                        border-color: #fca5a5;
                    }
                    button.icon-btn {
                        padding: 5px;
                        min-width: 32px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }
                    button.icon-btn.danger-hover {
                        border: 1px solid transparent;
                    }
                    button.icon-btn.danger-hover:hover {
                        background: rgba(239, 68, 68, 0.1) !important;
                        color: #ef4444 !important;
                        border-color: rgba(239, 68, 68, 0.3);
                    }
                    button.icon-btn svg {
                        width: 15px;
                        height: 15px;
                        opacity: 0.85;
                        transition: opacity 0.2s, scale 0.2s;
                        transform-origin: center;
                    }
                    button.icon-btn:hover svg {
                        opacity: 1;
                        scale: 1.15;
                    }
                    @keyframes spin {
                        100% { transform: rotate(360deg); }
                    }
                    .rotating {
                        animation: spin 1s linear infinite !important;
                    }

                    .badge {
                        font-size: 10px;
                        padding: 2px 8px;
                        border-radius: 12px;
                        background: #4ade80;
                        color: #064e3b;
                        font-weight: 700;
                        margin-left: 8px;
                    }

                    /* Responsive Media Queries */
                    @media (max-width: 500px) {
                        .header-top-row {
                            flex-direction: column;
                            align-items: flex-start;
                        }
                        .header-bottom-row {
                            flex-direction: column;
                            align-items: flex-start;
                            padding: 8px;
                        }
                        .header-actions {
                            width: 100%;
                        }
                    }

                    @media (max-width: 350px) {
                        body { padding: 8px; }
                        .header h1 { font-size: 22px; }
                        .quota-grid { grid-template-columns: 1fr; }
                        .panel-header {
                            flex-direction: column;
                            align-items: flex-start;
                        }
                        .btn-group {
                            width: 100%;
                            justify-content: flex-start;
                        }
                        .btn-group button {
                            flex: 1;
                        }
                    }

                    /* View Toggle */
                    .view-toggle {
                        display: flex;
                        background: var(--vscode-button-secondaryBackground);
                        border-radius: 8px;
                        padding: 3px;
                        width: fit-content;
                    }
                    .view-toggle-btn {
                        padding: 4px 14px;
                        cursor: pointer;
                        border-radius: 6px;
                        font-size: 12px;
                        font-weight: 500;
                        color: var(--vscode-button-secondaryForeground);
                        transition: var(--transition);
                        user-select: none;
                    }
                    .view-toggle-btn:hover {
                        color: var(--vscode-foreground);
                    }
                    .view-toggle-btn.active {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                    }
                    .list-view {
                        display: none;
                        width: 100%;
                        overflow-x: auto;
                    }
                    .list-view.active {
                        display: block;
                    }
                    .account-table {
                        width: 100%;
                        border-collapse: separate;
                        border-spacing: 0;
                        font-size: 12px;
                        background: var(--vscode-sideBar-background);
                        border-radius: 4px;
                        overflow: hidden;
                        border: 1px solid var(--border-color);
                    }
                    .account-table th {
                        text-align: left;
                        padding: 6px 8px;
                        background: var(--vscode-editor-group-header-tabsBackground);
                        border-bottom: 1px solid var(--border-color);
                        font-weight: 600;
                        color: var(--text-secondary);
                        white-space: nowrap;
                    }
                     .account-table td {
                        padding: 8px 10px;
                        border-bottom: 1px solid var(--border-color);
                        vertical-align: middle;
                        white-space: nowrap;
                    }
                    .account-table .btn-group {
                        flex-wrap: nowrap !important;
                    }
                    th.sortable {
                        cursor: pointer;
                        user-select: none;
                        transition: color 0.2s;
                    }
                    th.sortable:hover {
                        color: var(--text-primary);
                    }
                    .sort-icon {
                        font-size: 10px;
                        margin-left: 4px;
                        display: inline-block;
                        width: 10px;
                    }
                    .status-dot {
                        display: inline-block;
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                    }
                    .status-dot.active {
                        background: #4ade80;
                        box-shadow: 0 0 8px rgba(74, 222, 128, 0.6);
                    }
                    .status-dot.inactive {
                        background: var(--text-secondary);
                        opacity: 0.3;
                    }

                    /* Group Quota Stack in List View */
                    .group-quota-stack {
                        display: flex;
                        flex-direction: column;
                        gap: 3px;
                        width: 105px;
                        height: 28px;
                        justify-content: center;
                        cursor: default;
                    }
                    .group-quota-row {
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        width: 100%;
                        height: 11px;
                    }
                    .group-quota-label {
                        font-size: 10px;
                        opacity: 0.85;
                        width: 14px;
                        flex-shrink: 0;
                        line-height: 1;
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                    }
                    .group-quota-bars {
                        display: flex;
                        align-items: center;
                        gap: 2px;
                        flex-grow: 1;
                        height: 7px;
                    }
                    .group-quota-bar {
                        width: 100%;
                        height: 100%;
                        background: rgba(127, 127, 127, 0.15);
                        border-radius: 3px;
                        overflow: hidden;
                        position: relative;
                    }
                    .group-quota-fill {
                        height: 100%;
                        border-radius: 3px;
                        transition: width 0.3s ease;
                    }
                    .group-quota-bar.no-data {
                        background: transparent;
                        border: none;
                        pointer-events: none;
                    }

                    /* Modal Overlays */
                    .modal-overlay {
                        display: none;
                        position: fixed;
                        top: 0; left: 0; width: 100%; height: 100%;
                        background: var(--bg-modal);
                        z-index: 1000;
                        justify-content: center;
                        align-items: center;
                        backdrop-filter: blur(8px);
                    }
                    .modal-overlay.active { display: flex; }
                    .modal {
                        background: var(--vscode-sideBar-background);
                        border: 1px solid var(--border-color);
                        border-radius: 16px;
                        width: 90%;
                        max-width: 640px;
                        max-height: 85vh;
                        overflow: visible; /* Allow dropdowns to overflow if needed */
                        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
                        display: flex;
                        flex-direction: column;
                        position: relative;
                    }
                    .modal-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        padding: 8px 12px;
                        background: var(--vscode-editor-group-header-tabsBackground);
                        border-bottom: 1px solid var(--border-color);
                        border-top-left-radius: 16px;
                        border-top-right-radius: 16px;
                    }
                    .modal-header h2 {
                        margin: 0;
                        font-size: 16px;
                        font-weight: 600;
                    }
                    .modal-close {
                        background: transparent;
                        color: var(--text-secondary);
                        font-size: 20px;
                        padding: 0 8px;
                        border-radius: 4px;
                        min-width: auto;
                    }
                    .modal-close:hover {
                        background: rgba(255, 255, 255, 0.1);
                        color: var(--text-primary);
                    }
                    .modal-body {
                        padding: 8px 8px 20px 8px;
                        overflow-y: auto;
                        flex: 1;
                        position: relative;
                    }
                    .modal-footer {
                        padding: 10px 12px;
                        background: var(--vscode-editor-group-header-tabsBackground);
                        border-top: 1px solid var(--border-color);
                        display: flex;
                        justify-content: flex-end;
                        gap: 8px;
                        border-bottom-left-radius: 16px;
                        border-bottom-right-radius: 16px;
                    }

                    /* Group Management Styles */
                    .info-tip {
                        background: var(--accent-blue);
                        border: 1px solid var(--primary-blue);
                        border-radius: 8px;
                        padding: 12px 16px;
                        margin-bottom: 20px;
                        font-size: 13px;
                        color: var(--text-primary);
                        display: flex;
                        align-items: flex-start;
                        gap: 10px;
                    }
                    .action-buttons {
                        display: flex;
                        gap: 2px;
                        margin-bottom: 12px;
                    }
                    .groups-section-title {
                        font-size: 14px;
                        font-weight: 700;
                        margin-bottom: 6px;
                        color: var(--text-secondary);
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                    }
                    .groups-list {
                        display: flex;
                        flex-direction: column;
                        gap: 8px;
                    }
                    .group-source-bar {
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        background: var(--card-bg, rgba(255, 255, 255, 0.04));
                        border: 1px solid var(--border-color);
                        border-radius: 8px;
                        padding: 8px 12px;
                        margin-bottom: 12px;
                    }
                    .group-source-label {
                        font-size: 12px;
                        font-weight: 600;
                        color: var(--text-secondary);
                        white-space: nowrap;
                    }
                    .group-source-select {
                        flex: 1;
                        background: var(--bg-input, rgba(0, 0, 0, 0.2));
                        border: 1px solid var(--border-color);
                        color: var(--text-primary);
                        border-radius: 4px;
                        padding: 4px 8px;
                        font-size: 12px;
                    }
                    .group-source-select:focus {
                        outline: none;
                        border-color: var(--primary-blue);
                    }
                    .group-item-card {
                        background: var(--card-bg, rgba(255, 255, 255, 0.04));
                        border: 1px solid var(--border-color);
                        border-radius: 8px;
                        padding: 10px 14px;
                        display: flex;
                        align-items: center;
                        gap: 12px;
                        transition: var(--transition);
                    }
                    .group-item-card:hover {
                        border-color: var(--primary-teal);
                        background: rgba(20, 184, 166, 0.08);
                    }
                    .group-item-card.disabled-group {
                        opacity: 0.55;
                    }
                    .group-toggle-wrap {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                    }
                    .group-toggle-checkbox {
                        cursor: pointer;
                        width: 17px;
                        height: 17px;
                        accent-color: var(--primary-teal);
                    }
                    .group-info-main {
                        flex: 1;
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                        min-width: 0;
                    }
                    .group-name-row {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    .group-name-label {
                        font-size: 11px;
                        color: var(--text-secondary);
                        white-space: nowrap;
                    }
                    .group-short-input {
                        background: var(--bg-input, rgba(0, 0, 0, 0.2));
                        border: 1px solid var(--border-color);
                        color: var(--text-primary);
                        border-radius: 4px;
                        padding: 3px 8px;
                        font-size: 13px;
                        font-weight: 600;
                        width: 170px;
                        transition: border-color 0.2s;
                    }
                    .group-short-input:focus {
                        outline: none;
                        border-color: var(--primary-blue);
                    }
                    .group-official-desc {
                        font-size: 12px;
                        color: var(--text-secondary);
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        flex-wrap: wrap;
                    }
                    .group-badge {
                        background: rgba(14, 165, 233, 0.15);
                        color: var(--text-primary);
                        border-radius: 4px;
                        padding: 1px 6px;
                        font-size: 11px;
                        font-family: monospace;
                    }
                    .group-order-controls {
                        display: flex;
                        flex-direction: column;
                        gap: 2px;
                    }
                    .group-order-btn {
                        background: transparent;
                        border: 1px solid var(--border-color);
                        color: var(--text-secondary);
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 10px;
                        padding: 3px 6px;
                        line-height: 1;
                        transition: var(--transition);
                    }
                    .group-order-btn:hover:not(:disabled) {
                        background: var(--primary-teal);
                        color: #fff;
                        border-color: var(--primary-teal);
                    }
                    .group-order-btn:disabled {
                        opacity: 0.25;
                        cursor: not-allowed;
                    }
                    .empty-state {
                        text-align: center;
                        padding: 60px 24px;
                        color: var(--text-secondary);
                    }
                    .empty-state-icon { font-size: 48px; margin-bottom: 10px; }

                    /* Token View Styles */
                    .token-view {
                        display: flex;
                        flex-direction: column;
                        gap: 12px;
                        animation: fadeIn 0.3s ease;
                    }
                    .token-toolbar {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        padding: 8px 12px;
                        background: var(--vscode-sideBar-background);
                        border: 1px solid var(--border-color);
                        border-radius: 8px;
                    }
                    .token-toolbar-left {
                        display: flex;
                        align-items: center;
                        gap: 12px;
                    }
                    .token-view-title {
                        font-size: 15px;
                        font-weight: 700;
                        color: var(--text-primary);
                    }
                    .token-scan-time {
                        font-size: 11px;
                        color: var(--text-secondary);
                    }
                    .token-toolbar-right {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    .token-range-toggle {
                        display: flex;
                        background: var(--vscode-editor-background);
                        border: 1px solid var(--border-color);
                        border-radius: 6px;
                        overflow: hidden;
                    }
                    .token-range-btn {
                        padding: 3px 10px;
                        font-size: 11px;
                        background: transparent;
                        border: none;
                        color: var(--text-secondary);
                        cursor: pointer;
                        transition: var(--transition);
                    }
                    .token-range-btn:hover {
                        color: var(--text-primary);
                    }
                    .token-range-btn.active {
                        background: var(--primary-blue);
                        color: #fff;
                        font-weight: 600;
                    }
                    .token-kpi-grid {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
                        gap: 8px;
                    }
                    .token-kpi-card {
                        background: var(--vscode-sideBar-background);
                        border: 1px solid var(--border-color);
                        border-radius: 8px;
                        padding: 10px;
                        display: flex;
                        flex-direction: column;
                        gap: 6px;
                        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
                    }
                    .token-kpi-card.highlight {
                        border-color: rgba(74, 222, 128, 0.4);
                        background: linear-gradient(135deg, var(--vscode-sideBar-background) 0%, rgba(74, 222, 128, 0.05) 100%);
                    }
                    .token-kpi-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }
                    .token-kpi-title {
                        font-size: 12px;
                        font-weight: 600;
                        color: var(--text-secondary);
                    }
                    .token-badge {
                        font-size: 10px;
                        padding: 1px 6px;
                        border-radius: 4px;
                        background: rgba(14, 165, 233, 0.15);
                        color: var(--primary-blue);
                        font-weight: 500;
                    }
                    .token-badge.today {
                        background: rgba(14, 165, 233, 0.15);
                        color: #0ea5e9;
                    }
                    .token-badge.yesterday {
                        background: rgba(168, 85, 247, 0.15);
                        color: #a855f7;
                    }
                    .token-badge.week {
                        background: rgba(59, 130, 246, 0.15);
                        color: #3b82f6;
                    }
                    .token-badge.range7d {
                        background: rgba(245, 158, 11, 0.15);
                        color: #f59e0b;
                    }
                    .token-badge.range30d {
                        background: rgba(20, 184, 166, 0.15);
                        color: #14b8a6;
                    }
                    .token-badge.all {
                        background: rgba(100, 116, 139, 0.15);
                        color: #94a3b8;
                    }
                    .token-badge.hit-rate {
                        background: rgba(16, 185, 129, 0.15);
                        color: #10b981;
                    }
                    .token-kpi-value {
                        font-size: 24px;
                        font-weight: 700;
                        color: var(--text-primary);
                        letter-spacing: -0.5px;
                        line-height: 1.1;
                    }
                    .token-kpi-value.green {
                        color: #10b981;
                    }
                    .token-kpi-details {
                        display: flex;
                        flex-direction: column;
                        gap: 2px;
                        font-size: 11px;
                        color: var(--text-secondary);
                        margin-top: 4px;
                        border-top: 1px dashed rgba(127, 127, 127, 0.15);
                        padding-top: 4px;
                    }
                    .token-kpi-subitem {
                        display: flex;
                        justify-content: space-between;
                    }
                    .token-kpi-subitem.cache b {
                        color: #10b981;
                    }
                    .token-kpi-subitem.green b {
                        color: #10b981;
                    }
                    .token-section-card {
                        background: var(--vscode-sideBar-background);
                        border: 1px solid var(--border-color);
                        border-radius: 8px;
                        padding: 8px 12px;
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                    }
                    .token-section-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }
                    .token-section-title {
                        font-size: 13px;
                        font-weight: 600;
                        color: var(--text-primary);
                    }
                    .token-legend {
                        display: flex;
                        gap: 12px;
                        font-size: 11px;
                        color: var(--text-secondary);
                    }
                    .legend-item {
                        display: flex;
                        align-items: center;
                        gap: 4px;
                    }
                    .legend-dot {
                        width: 8px;
                        height: 8px;
                        border-radius: 2px;
                    }
                    .legend-dot.billed { background: #0ea5e9; }
                    .legend-dot.cache { background: #10b981; }

                    .token-chart-container {
                        height: 72px;
                        display: flex;
                        align-items: flex-end;
                        gap: 6px;
                        padding: 2px 6px;
                        box-sizing: border-box;
                        position: relative;
                        overflow-x: auto;
                        overflow-y: hidden;
                    }
                    .token-chart-container::-webkit-scrollbar {
                        height: 4px;
                    }
                    .token-chart-container::-webkit-scrollbar-thumb {
                        background: rgba(127, 127, 127, 0.25);
                        border-radius: 4px;
                    }
                    .token-bar-col {
                        flex: 1;
                        min-width: 16px;
                        height: 100%;
                        display: flex;
                        flex-direction: column;
                        justify-content: flex-end;
                        align-items: center;
                        position: relative;
                        cursor: pointer;
                    }
                    .token-bar-stack {
                        width: 100%;
                        max-width: 24px;
                        display: flex;
                        flex-direction: column;
                        justify-content: flex-end;
                        border-radius: 3px 3px 0 0;
                        overflow: hidden;
                        transition: var(--transition);
                    }
                    .token-bar-col:hover .token-bar-stack {
                        filter: brightness(1.25);
                    }
                    .bar-cache {
                        background: #10b981;
                        width: 100%;
                    }
                    .bar-billed {
                        background: #0ea5e9;
                        width: 100%;
                    }
                    .token-bar-date {
                        font-size: 9px;
                        line-height: 12px;
                        height: 12px;
                        margin-top: 2px;
                        color: var(--text-secondary);
                        white-space: nowrap;
                        text-align: center;
                        width: 100%;
                    }

                    .token-grid-cols {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
                        gap: 10px;
                    }
                    .token-table-scroll {
                        max-height: 280px;
                        overflow-y: auto;
                    }
                    .token-data-table {
                        width: 100%;
                        border-collapse: collapse;
                        font-size: 12px;
                    }
                    .token-data-table th {
                        text-align: left;
                        padding: 6px 8px;
                        color: var(--text-secondary);
                        font-weight: 500;
                        border-bottom: 1px solid var(--border-color);
                        position: sticky;
                        top: 0;
                        background: var(--vscode-sideBar-background);
                        z-index: 1;
                    }
                    .token-data-table td {
                        padding: 6px 8px;
                        border-bottom: 1px solid rgba(127, 127, 127, 0.08);
                        color: var(--text-primary);
                    }
                    .token-data-table tr:hover td {
                        background: rgba(14, 165, 233, 0.05);
                    }
                    .token-proj-bar {
                        height: 4px;
                        border-radius: 2px;
                        background: var(--primary-blue);
                        margin-top: 3px;
                    }
                    .token-model-icon-box {
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        width: 14px;
                        height: 14px;
                        flex-shrink: 0;
                    }
                    .token-model-icon-box svg {
                        width: 14px;
                        height: 14px;
                        display: block;
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="header-top-row">
                        <div class="header-title-section">
                            <h1>Antigravity Multi-Account Cockpit</h1>
                        </div>
                        <div class="view-toggle">
                            <div class="view-toggle-btn active" id="btnViewTab" onclick="switchView('tab')">${t('accountsTab')}</div>
                            <div class="view-toggle-btn" id="btnViewList" onclick="switchView('list')">${t('accountsTab')} (List)</div>
                            <div class="view-toggle-btn" id="btnViewToken" onclick="switchView('token')">📊 ${t('tokenStatsTab')}</div>
                        </div>
                    </div>
                    
                    <div class="header-bottom-row">
                        <div class="header-actions">
                            <button class="teal" onclick="openGroupManager()">${t('groupingTab')}</button>
                            <button class="blue" onclick="addAccount()">${t('addAccount')}</button>
                            <button class="secondary" onclick="openTokenLoginModal()">🔑 ${t('tokenLoginBtn')}</button>
                            <button class="secondary" onclick="batchExport()">📦 ${t('batchExportBtn')}</button>
                            <button class="secondary" onclick="openBatchImportModal()">📥 ${t('batchImportBtn')}</button>
                            <button class="secondary" onclick="refreshAll()">${t('refreshAll')}</button>
                        </div>
                        <div class="header-actions">
                            <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-secondary);">
                                ${t('targetClientsLabel')}:
                                <select id="targetClientSelect" onchange="updateTargetClient()" style="padding:4px 8px;font-size:12px;border-radius:6px;border:1px solid var(--border-color);background:var(--vscode-input-background);color:var(--vscode-input-foreground);outline:none;">
                                    <option value="all">${t('targetClientAll')}</option>
                                    <option value="ide">${t('targetClientIde')}</option>
                                    <option value="app_cli">${t('targetClientAppCli')}</option>
                                </select>
                            </label>
                            <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-secondary);">
                                ${t('languageLabel')}:
                                <select id="languageSelect" onchange="updateLanguage()" style="padding:4px 8px;font-size:12px;border-radius:6px;border:1px solid var(--border-color);background:var(--vscode-input-background);color:var(--vscode-input-foreground);outline:none;">
                                    <option value="auto">${t('langAuto')}</option>
                                    <option value="zh-cn">${t('langZh')}</option>
                                    <option value="zh-tw">${t('langZhTw')}</option>
                                    <option value="en">${t('langEn')}</option>
                                    <option value="ja">${t('langJa')}</option>
                                    <option value="ko">${t('langKo')}</option>
                                    <option value="ru">${t('langRu')}</option>
                                    <option value="fr">${t('langFr')}</option>
                                    <option value="es">${t('langEs')}</option>
                                    <option value="de">${t('langDe')}</option>
                                    <option value="it">${t('langIt')}</option>
                                </select>
                            </label>
                            <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-secondary);">
                                ${t('refreshIntervalLabel')}:
                                <select id="refreshIntervalSelect" onchange="updateRefreshInterval()" style="padding:4px 8px;font-size:12px;border-radius:6px;border:1px solid var(--border-color);background:var(--vscode-input-background);color:var(--vscode-input-foreground);outline:none;">
                                    <option value="1">1 ${t('minutes')}</option>
                                    <option value="2">2 ${t('minutes')}</option>
                                    <option value="5">5 ${t('minutes')}</option>
                                    <option value="10">10 ${t('minutes')}</option>
                                    <option value="15">15 ${t('minutes')}</option>
                                    <option value="30">30 ${t('minutes')}</option>
                                    <option value="60">60 ${t('minutes')}</option>
                                </select>
                            </label>
                        </div>
                    </div>
                </div>
                
                <!-- Global Tooltip Element -->
                <div id="custom-global-tooltip"></div>

                <!-- 卡片视图容器 -->
                <div id="tabViewContainer">
                    <div class="tabs" id="tabContainer"></div>
                    <div id="panelContainer"></div>
                </div>

                <!-- 列表视图容器 -->
                <div id="listViewContainer" class="list-view">
                    <table class="account-table">
                        <thead>
                            <tr>
                                <th id="listCounterHeader" style="width: 32px; white-space: nowrap;">#</th>
                                <th class="sortable" onclick="setListSort('email')">${t('accountEmailHeader')} <span class="sort-icon" id="sort-icon-email"></span></th>
                                <th class="sortable" onclick="setListSort('name')">${t('accountNameHeader')} <span class="sort-icon" id="sort-icon-name"></span></th>
                                <th class="sortable" onclick="setListSort('tier')">${t('accountTierHeader')} <span class="sort-icon" id="sort-icon-tier"></span></th>
                                <th class="sortable" onclick="setListSort('quota')" title="优先对比第一组配额，其次第二组...">${t('groupQuotaHeader')} <span class="sort-icon" id="sort-icon-quota"></span></th>
                                <th class="sortable" onclick="setListSort('lastActive')">${t('lastActiveHeader')} <span class="sort-icon" id="sort-icon-lastActive"></span></th>
                                <th style="text-align: right; width: 140px;">${t('actionsHeader')}</th>
                            </tr>
                        </thead>
                        <tbody id="accountTableBody">
                            <!-- 动态生成 -->
                        </tbody>
                    </table>
                </div>

                <!-- Token 统计视图容器 -->
                <div id="tokenViewContainer" class="token-view" style="display: none;">
                    <div class="token-toolbar">
                        <div class="token-toolbar-left">
                            <span class="token-view-title">📊 ${t('tokenStatsTab')}</span>
                            <span id="tokenLastScanTime" class="token-scan-time"></span>
                        </div>
                        <div class="token-toolbar-right">
                            <div class="token-range-toggle">
                                <button class="token-range-btn active" id="btnRangeToday" onclick="setTokenRange('today')">${t('tokenStatsRangeToday')}</button>
                                <button class="token-range-btn" id="btnRangeYesterday" onclick="setTokenRange('yesterday')">${t('tokenStatsRangeYesterday')}</button>
                                <button class="token-range-btn" id="btnRange7d" onclick="setTokenRange('7d')">${t('tokenStatsRange7d')}</button>
                                <button class="token-range-btn" id="btnRange30d" onclick="setTokenRange('30d')">${t('tokenStatsRange30d')}</button>
                            </div>
                            <button class="secondary" id="btnRefreshTokens" onclick="refreshTokenStatsUI()">🔄 ${t('tokenStatsRefreshBtn')}</button>
                        </div>
                    </div>

                    <!-- KPI 指标卡片网格 -->
                    <div class="token-kpi-grid">
                        <div class="token-kpi-card">
                            <div class="token-kpi-header">
                                <span class="token-kpi-title">${t('tokenStatsToday')}</span>
                                <span class="token-badge today">⚡ Today</span>
                            </div>
                            <div class="token-kpi-value" id="kpiTodayGross">-</div>
                            <div class="token-kpi-details">
                                <div class="token-kpi-subitem"><span>${t('tokenStatsPromptTokens')}:</span><b id="kpiTodayPrompt">-</b></div>
                                <div class="token-kpi-subitem"><span>${t('tokenStatsOutputTokens')}:</span><b id="kpiTodayCompletion">-</b></div>
                                <div class="token-kpi-subitem cache"><span>${t('tokenStatsCacheTokens')}:</span><b id="kpiTodayCache">-</b></div>
                                <div class="token-kpi-subitem"><span>${t('tokenStatsTotalBilled')}:</span><b id="kpiTodayBilled">-</b></div>
                                <div class="token-kpi-subitem"><span>${t('tokenStatsStepCount')}:</span><b id="kpiTodaySteps">-</b></div>
                                <div class="token-kpi-subitem green" style="border-top: 1px dashed rgba(127,127,127,0.2); padding-top: 4px; margin-top: 4px;">
                                    <span>${t('tokenStatsCacheHitRate')}:</span><b id="kpiTodayHitRate">-%</b>
                                </div>
                            </div>
                        </div>

                        <div class="token-kpi-card" id="kpiDynamicCard">
                            <div class="token-kpi-header">
                                <span class="token-kpi-title" id="kpiDynamicTitle">${t('tokenStatsThisWeek')}</span>
                                <span class="token-badge week" id="kpiDynamicBadge">📅 Week</span>
                            </div>
                            <div class="token-kpi-value" id="kpiWeekGross">-</div>
                            <div class="token-kpi-details">
                                <div class="token-kpi-subitem"><span>${t('tokenStatsPromptTokens')}:</span><b id="kpiWeekPrompt">-</b></div>
                                <div class="token-kpi-subitem"><span>${t('tokenStatsOutputTokens')}:</span><b id="kpiWeekCompletion">-</b></div>
                                <div class="token-kpi-subitem cache"><span>${t('tokenStatsCacheTokens')}:</span><b id="kpiWeekCache">-</b></div>
                                <div class="token-kpi-subitem"><span>${t('tokenStatsTotalBilled')}:</span><b id="kpiWeekBilled">-</b></div>
                                <div class="token-kpi-subitem"><span>${t('tokenStatsStepCount')}:</span><b id="kpiWeekSteps">-</b></div>
                                <div class="token-kpi-subitem green" style="border-top: 1px dashed rgba(127,127,127,0.2); padding-top: 4px; margin-top: 4px;">
                                    <span>${t('tokenStatsCacheHitRate')}:</span><b id="kpiWeekHitRate">-%</b>
                                </div>
                            </div>
                        </div>

                        <div class="token-kpi-card">
                            <div class="token-kpi-header">
                                <span class="token-kpi-title">${t('tokenStatsAllTime')}</span>
                                <span class="token-badge all">🌐 All Time</span>
                            </div>
                            <div class="token-kpi-value" id="kpiAllTimeGross">-</div>
                            <div class="token-kpi-details">
                                <div class="token-kpi-subitem"><span>${t('tokenStatsPromptTokens')}:</span><b id="kpiAllPrompt">-</b></div>
                                <div class="token-kpi-subitem"><span>${t('tokenStatsOutputTokens')}:</span><b id="kpiAllCompletion">-</b></div>
                                <div class="token-kpi-subitem cache"><span>${t('tokenStatsCacheTokens')}:</span><b id="kpiAllCache">-</b></div>
                                <div class="token-kpi-subitem"><span>${t('tokenStatsTotalBilled')}:</span><b id="kpiAllTimeBilled">-</b></div>
                                <div class="token-kpi-subitem"><span>${t('tokenStatsConversations')} / ${t('tokenStatsStepCount')}:</span><b id="kpiAllConvsSteps">-</b></div>
                                <div class="token-kpi-subitem green" style="border-top: 1px dashed rgba(127,127,127,0.2); padding-top: 4px; margin-top: 4px;">
                                    <span>${t('tokenStatsCacheHitRate')}:</span><b id="kpiAllHitRate">-%</b>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 消耗趋势柱状图 (支持24小时分布与每日分布联动) -->
                    <div class="token-section-card">
                        <div class="token-section-header">
                            <span class="token-section-title" id="tokenTrendTitle">📈 ${t('tokenStatsHourlyTrends')} (${t('tokenStatsRangeToday')})</span>
                            <div class="token-legend">
                                <span class="legend-item"><span class="legend-dot billed"></span>${t('tokenStatsTotalBilled')}</span>
                                <span class="legend-item"><span class="legend-dot cache"></span>${t('tokenStatsCacheTokens')}</span>
                            </div>
                        </div>
                        <div class="token-chart-container" id="tokenChartContainer">
                            <div style="margin: auto; color: var(--text-secondary);">${t('tokenStatsLoading')}</div>
                        </div>
                    </div>

                    <!-- 模型消耗明细卡片 (与时间区间联动) -->
                    <div class="token-section-card">
                        <div class="token-section-header">
                            <span class="token-section-title" id="tokenModelRankingTitle">🤖 ${t('tokenStatsModelRanking')} (${t('tokenStatsRangeToday')})</span>
                        </div>
                        <div class="token-table-scroll">
                            <table class="token-data-table">
                                <thead>
                                    <tr>
                                        <th style="width: 30px;">#</th>
                                        <th>${t('tokenStatsModelHeader')}</th>
                                        <th style="text-align: right;">${t('tokenStatsTokensHeader')}</th>
                                        <th style="text-align: right; width: 110px;">${t('tokenStatsCacheHitRate')}</th>
                                        <th style="text-align: right; width: 70px;">${t('tokenStatsStepCount')}</th>
                                    </tr>
                                </thead>
                                <tbody id="tokenModelTableBody">
                                    <tr><td colspan="5" style="text-align: center; color: var(--text-secondary);">${t('tokenStatsLoading')}</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <!-- 左右双栏：项目工程分布 与 高消耗会话排行 -->
                    <div class="token-grid-cols">
                        <div class="token-section-card">
                            <div class="token-section-header">
                                <span class="token-section-title">📁 ${t('tokenStatsProjectRanking')}</span>
                            </div>
                            <div class="token-table-scroll">
                                <table class="token-data-table">
                                    <thead>
                                        <tr>
                                            <th style="width: 30px;">#</th>
                                            <th>${t('tokenStatsProjectHeader')}</th>
                                            <th style="text-align: right;">${t('tokenStatsTokensHeader')}</th>
                                            <th style="text-align: right; width: 60px;">${t('tokenStatsConversations')}</th>
                                        </tr>
                                    </thead>
                                    <tbody id="tokenProjectTableBody">
                                        <tr><td colspan="4" style="text-align: center; color: var(--text-secondary);">${t('tokenStatsLoading')}</td></tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <div class="token-section-card">
                            <div class="token-section-header">
                                <span class="token-section-title">🔥 ${t('tokenStatsTopConversations')}</span>
                            </div>
                            <div class="token-table-scroll">
                                <table class="token-data-table">
                                    <thead>
                                        <tr>
                                            <th style="width: 30px;">#</th>
                                            <th>${t('tokenStatsSessionHeader')}</th>
                                            <th style="text-align: right;">${t('tokenStatsTokensHeader')}</th>
                                            <th style="text-align: right; width: 75px;">${t('tokenStatsTimeHeader')}</th>
                                        </tr>
                                    </thead>
                                    <tbody id="tokenSessionsTableBody">
                                        <tr><td colspan="4" style="text-align: center; color: var(--text-secondary);">${t('tokenStatsLoading')}</td></tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 分组管理弹窗 -->
                <div class="modal-overlay" id="groupModal">
                    <div class="modal" style="max-width: 620px;">
                        <div class="modal-header">
                            <h2>⚙️ ${t('statusBarGroupSettingsTitle')}</h2>
                            <button class="modal-close" onclick="closeGroupManager()">&times;</button>
                        </div>
                        <div class="modal-body">
                            <div class="group-source-bar">
                                <span class="group-source-label">📌 ${t('groupSourceLabel')}:</span>
                                <select id="groupSourceSelect" onchange="changeGroupSource(this.value)" class="group-source-select">
                                    <option value="__all__">${t('groupSourceAll')}</option>
                                </select>
                                <button class="secondary" style="padding: 4px 10px; font-size: 12px;" onclick="syncFromSelectedSource()" title="${t('groupSourceExtractTip')}">🔄 ${t('groupSourceExtractBtn')}</button>
                            </div>
                            <div class="info-tip" style="margin-bottom: 12px;">
                                <span>💡</span>
                                <span>${t('statusBarGroupSettingsTip')}</span>
                            </div>
                            <div class="groups-list" id="groupsList">
                                <!-- 分组列表动态渲染 -->
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button class="secondary" onclick="resetGroupsToDefault()">${t('resetDefaultsBtn')}</button>
                            <div style="flex: 1;"></div>
                            <button class="secondary" onclick="closeGroupManager()">${t('cancel')}</button>
                            <button class="blue" onclick="saveGroups()">${t('saveGroupsBtn')}</button>
                        </div>
                    </div>
                </div>

                <!-- Token 登录弹窗 -->
                <div class="modal-overlay" id="tokenLoginModal">
                    <div class="modal" style="max-width: 480px;">
                        <div class="modal-header">
                            <h2>🔑 ${t('tokenLoginTitle')}</h2>
                            <button class="modal-close" onclick="closeTokenLoginModal()">&times;</button>
                        </div>
                        <div class="modal-body">
                            <div class="info-tip">
                                <span>💡</span>
                                <span>${t('tokenLoginDescription')}</span>
                            </div>
                            <textarea id="tokenInput" placeholder="${t('tokenLoginPlaceholder')}" style="width:100%;min-height:80px;padding:10px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);font-family:monospace;font-size:13px;resize:vertical;box-sizing:border-box;"></textarea>
                            <div style="margin-top:10px;font-size:12px;color:var(--text-secondary);">${t('tokenSecurityWarning')}</div>
                        </div>
                        <div class="modal-footer">
                            <button class="secondary" onclick="closeTokenLoginModal()">${t('cancel')}</button>
                            <button class="blue" onclick="submitTokenLogin()">${t('tokenLoginSubmit')}</button>
                        </div>
                    </div>
                </div>

                <!-- 批量导入弹窗 -->
                <div class="modal-overlay" id="batchImportModal">
                    <div class="modal" style="max-width: 520px;">
                        <div class="modal-header">
                            <h2>📥 ${t('batchImportTitle')}</h2>
                            <button class="modal-close" onclick="closeBatchImportModal()">&times;</button>
                        </div>
                        <div class="modal-body">
                            <div class="info-tip">
                                <span>💡</span>
                                <span>${t('batchImportDescription')}</span>
                            </div>
                            <textarea id="batchImportInput" placeholder="${t('batchImportPlaceholder')}" style="width:100%;min-height:120px;padding:10px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);font-family:monospace;font-size:12px;resize:vertical;box-sizing:border-box;"></textarea>
                            <div style="margin-top:10px;font-size:12px;color:var(--text-secondary);">${t('tokenSecurityWarning')}</div>
                        </div>
                        <div class="modal-footer">
                            <button class="secondary" onclick="closeBatchImportModal()">${t('cancel')}</button>
                            <button class="blue" onclick="submitBatchImport()">${t('batchImportSubmit')}</button>
                        </div>
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    const state = vscode.getState() || {};
                    const translations = ${translationsJson};
                    let initialUiState = ${uiStateJson};
                    let currentView = state.currentView || initialUiState.currentView || 'tab';
                    let accounts = ${accountsJson};
                    let groupsConfig = ${groupsJson};
                    let initialLanguage = "${languageConfig}";
                    let initialTargetClient = "${targetClientConfig}";

                    function msg(key, ...args) {
                        let text = translations[key] || key;
                        args.forEach((arg, i) => {
                            text = text.replace('{' + i + '}', String(arg));
                        });
                        return text;
                    }

                    function getVisualWidth(str) {
                        if (!str) return 0;
                        let width = 0;
                        for (const char of str) {
                            const code = char.charCodeAt(0);
                            if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0xFF00 && code <= 0xFFEF)) {
                                width += 2;
                            } else if (char.length > 1) {
                                width += 2;
                            } else {
                                width += 1;
                            }
                        }
                        return width;
                    }

                    // 优先使用 state 中的 activeAccountId，防止刷新后跳变
                    let activeAccountId = state.activeAccountId;
                    // 验证 ID 是否依然有效 (防止账号被删除后停留在无效 ID)
                    if (!activeAccountId || !accounts.find(a => a.id === activeAccountId)) {
                        activeAccountId = accounts.find(a => a.isCurrent)?.id || accounts[0]?.id;
                    }

                    let activeDropdownId = null;
                    let listSortKey = state.listSortKey || initialUiState.listSortKey || 'default';
                    let listSortOrder = state.listSortOrder || initialUiState.listSortOrder || 'asc';
                    
                    function setListSort(key) {
                        if (listSortKey === key) {
                            listSortOrder = listSortOrder === 'asc' ? 'desc' : 'asc';
                        } else {
                            listSortKey = key;
                            listSortOrder = 'asc';
                        }
                        vscode.setState({ ...state, listSortKey, listSortOrder, currentView });
                        vscode.postMessage({ command: 'updateUiState', state: { currentView, listSortKey, listSortOrder } });
                        renderListView();
                    }

                    // 获取所有可用模型
                    function getAllModels() {
                        const models = [];
                        accounts.forEach(acc => {
                            if (acc.quota && acc.quota.models) {
                                acc.quota.models.forEach(m => {
                                    if (!models.find(x => x.name === m.name)) {
                                        models.push({
                                            name: m.name,
                                            resetTime: m.reset_time || '',
                                            percentage: m.percentage
                                        });
                                    }
                                });
                            }
                        });
                        return models;
                    }

                    // 获取已分组的模型集合
                    function getGroupedModels() {
                        const grouped = new Set();
                        groupsConfig.groups.forEach(g => {
                            g.models.forEach(m => grouped.add(m));
                        });
                        return grouped;
                    }

                    // 更新刷新间隔
                    function updateRefreshInterval() {
                        const select = document.getElementById('refreshIntervalSelect');
                        const value = parseInt(select.value, 10);
                        vscode.postMessage({ command: 'setRefreshInterval', value: value });
                    }

                    // 更新生效客户端
                    function updateTargetClient() {
                        const select = document.getElementById('targetClientSelect');
                        const value = select.value;
                        vscode.postMessage({ command: 'setTargetClient', value: value });
                    }

                    // 更新语言
                    function updateLanguage() {
                        const select = document.getElementById('languageSelect');
                        const value = select.value;
                        vscode.postMessage({ command: 'setLanguage', value: value });
                    }

                    // 监听来自扩展的消息
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'groupsConfig') {
                            groupsConfig = message.config;
                            renderGroupsList();
                        } else if (message.command === 'refreshIntervalValue') {
                            const select = document.getElementById('refreshIntervalSelect');
                            if (select) {
                                select.value = message.value.toString();
                            }
                        } else if (message.command === 'updateAccounts') {
                            // 第二阶段：后台获取到新配额数据，无缝更新界面
                            accounts = message.accounts;
                            render();
                            renderListView();
                        } else if (message.command === 'tokenStatsData') {
                            renderTokenStats(message.data);
                        }
                    });

                    // 初始化时获取刷新间隔
                    vscode.postMessage({ command: 'getRefreshInterval' });
                    
                    // 初始化语言选择
                    const languageSelect = document.getElementById('languageSelect');
                    if (languageSelect) {
                        languageSelect.value = initialLanguage;
                    }
                    const targetClientSelect = document.getElementById('targetClientSelect');
                    if (targetClientSelect) {
                        targetClientSelect.value = initialTargetClient;
                    }

                    function switchView(view) {
                        currentView = view;
                        vscode.setState({ ...state, currentView: view, listSortKey, listSortOrder });
                        vscode.postMessage({ command: 'updateUiState', state: { currentView, listSortKey, listSortOrder } });
                        updateViewUI();
                    }

                    function renderModelsGrid(models) {
                        if (!models || models.length === 0) return '';
                        return '<div class="quota-grid">' + models.map(m => {
                            // 周配额 (所有账号和模型均支持)
                            let weeklyPct = m.weekly_percentage !== undefined ? m.weekly_percentage : m.percentage;
                            let colorWeekly = '#4ade80';
                            if (weeklyPct <= 20) colorWeekly = '#f87171';
                            else if (weeklyPct <= 50) colorWeekly = '#fbbf24';
                            let fillWeekly = Math.max(0, Math.min(100, weeklyPct));
                            let resetWeeklyText = m.weekly_reset_time || m.reset_time || '-';

                            // 5H 配额 (仅当具备 5H 额度时渲染，无 5H 额度时不显示占位符与长文本)
                            let row5hHtml = '';
                            if (m.has_5h) {
                                let color5h = '#4ade80';
                                if (m.percentage <= 20) color5h = '#f87171';
                                else if (m.percentage <= 50) color5h = '#fbbf24';
                                let fill5h = Math.max(0, Math.min(100, m.percentage));

                                const rawReset5h = m.reset_time_raw || m.reset_time;
                                const isOverdue5h = rawReset5h && !isNaN(new Date(rawReset5h).getTime()) && (new Date(rawReset5h).getTime() <= Date.now());
                                const overdueTitle5h = isOverdue5h ? (initialLanguage.startsWith('zh') ? ' title="已达预定重置时间，建议刷新"' : ' title="Reset time reached, refresh recommended"') : '';
                                const reset5hText = isOverdue5h ? ((m.reset_time || '-') + ' ⚡') : (m.reset_time || '-');

                                row5hHtml = '<div class="quota-row">' +
                                    '<div class="quota-row-header">' +
                                        '<span class="quota-row-label">⚡ 5H</span>' +
                                        '<span class="quota-row-value" style="color:' + color5h + '">' + m.percentage + '%</span>' +
                                    '</div>' +
                                    '<div class="progress-bar mini">' +
                                        '<div class="progress-fill" style="width:' + fill5h + '%; background:' + color5h + '; box-shadow:0 0 8px ' + color5h + '44"></div>' +
                                    '</div>' +
                                    '<div class="quota-row-meta">' +
                                        '<span>' + msg('reset') + '</span>' +
                                        '<span' + overdueTitle5h + '>' + reset5hText + '</span>' +
                                    '</div>' +
                                '</div>';
                            }

                            const weeklyRowStyle = m.has_5h ? ' style="margin-top:8px; padding-top:6px; border-top:1px dashed var(--border-color);"' : '';

                            return '<div class="quota-card">' +
                                '<div class="quota-header">' +
                                    '<span class="model-id" title="' + m.name + '">' + m.name + '</span>' +
                                '</div>' +
                                row5hHtml +
                                '<div class="quota-row"' + weeklyRowStyle + '>' +
                                    '<div class="quota-row-header">' +
                                        '<span class="quota-row-label">📅 ' + msg('quotaWindowWeeklyShort') + '</span>' +
                                        '<span class="quota-row-value" style="color:' + colorWeekly + '">' + weeklyPct + '%</span>' +
                                    '</div>' +
                                    '<div class="progress-bar mini">' +
                                        '<div class="progress-fill" style="width:' + fillWeekly + '%; background:' + colorWeekly + '; box-shadow:0 0 8px ' + colorWeekly + '44"></div>' +
                                    '</div>' +
                                    '<div class="quota-row-meta">' +
                                        '<span>' + msg('reset') + '</span>' +
                                        '<span>' + resetWeeklyText + '</span>' +
                                    '</div>' +
                                '</div>' +
                            '</div>';
                        }).join('') + '</div>';
                    }

                    let tokenStatsData = null;
                    let tokenStatsLoaded = false;
                    let currentTokenRange = 'today';

                    function fetchTokenStats() {
                        vscode.postMessage({ command: 'getTokenStats', timeRange: currentTokenRange });
                    }

                    function refreshTokenStatsUI() {
                        const btn = document.getElementById('btnRefreshTokens');
                        if (btn) btn.style.opacity = '0.5';
                        vscode.postMessage({ command: 'refreshTokenStats', timeRange: currentTokenRange });
                    }

                    function setTokenRange(range) {
                        currentTokenRange = range;
                        const btnToday = document.getElementById('btnRangeToday');
                        const btnYesterday = document.getElementById('btnRangeYesterday');
                        const btn7d = document.getElementById('btnRange7d');
                        const btn30d = document.getElementById('btnRange30d');
                        [btnToday, btnYesterday, btn7d, btn30d].forEach(btn => {
                            if (btn) btn.classList.remove('active');
                        });
                        if (range === 'today' && btnToday) btnToday.classList.add('active');
                        if (range === 'yesterday' && btnYesterday) btnYesterday.classList.add('active');
                        if (range === '7d' && btn7d) btn7d.classList.add('active');
                        if (range === '30d' && btn30d) btn30d.classList.add('active');

                        // 若已有缓存报表数据，立即原地更新第二张 KPI 卡片，提供零延迟即时交互
                        if (tokenStatsData && tokenStatsData.summary) {
                            updateDynamicKpiCard(tokenStatsData, range);
                        }

                        fetchTokenStats();
                    }

                    function updateDynamicKpiCard(report, forcedRange) {
                        if (!report || !report.summary) return;
                        const r = forcedRange || report.timeRange || 'today';
                        let dynData = report.summary.thisWeek || {};
                        let dynTitle = msg('tokenStatsThisWeek');
                        let dynBadge = '📅 Week';
                        let dynBadgeClass = 'token-badge week';

                        if (r === 'yesterday') {
                            dynData = report.summary.yesterday || {};
                            dynTitle = msg('tokenStatsYesterday');
                            dynBadge = '⏮ Yesterday';
                            dynBadgeClass = 'token-badge yesterday';
                        } else if (r === '7d') {
                            dynData = report.summary.last7d || {};
                            dynTitle = msg('tokenStatsLast7Days');
                            dynBadge = '📊 7 Days';
                            dynBadgeClass = 'token-badge range7d';
                        } else if (r === '30d') {
                            dynData = report.summary.last30d || {};
                            dynTitle = msg('tokenStatsLast30Days');
                            dynBadge = '📆 30 Days';
                            dynBadgeClass = 'token-badge range30d';
                        }

                        const dynTitleEl = document.getElementById('kpiDynamicTitle');
                        if (dynTitleEl) dynTitleEl.textContent = dynTitle;
                        const dynBadgeEl = document.getElementById('kpiDynamicBadge');
                        if (dynBadgeEl) {
                            dynBadgeEl.textContent = dynBadge;
                            dynBadgeEl.className = dynBadgeClass;
                        }

                        const dynBilled = (dynData.inputTokens || 0) + (dynData.outputTokens || 0);
                        const dynGross = dynBilled + (dynData.cacheReadTokens || 0);
                        document.getElementById('kpiWeekGross').textContent = formatTokens(dynGross);
                        document.getElementById('kpiWeekBilled').textContent = formatTokens(dynBilled);
                        document.getElementById('kpiWeekPrompt').textContent = formatTokens(dynData.inputTokens || 0);
                        document.getElementById('kpiWeekCompletion').textContent = formatTokens(dynData.outputTokens || 0);
                        document.getElementById('kpiWeekCache').textContent = formatTokens(dynData.cacheReadTokens || 0);
                        document.getElementById('kpiWeekSteps').textContent = (dynData.stepCount || 0).toLocaleString();
                        document.getElementById('kpiWeekHitRate').textContent = (dynData.cacheHitRate || 0) + '%';
                    }

                    function formatTokens(num) {
                        if (!num || isNaN(num)) return '0';
                        if (num >= 1000000000) return (num / 1000000000).toFixed(2) + 'B';
                        if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
                        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
                        return Number(num).toLocaleString();
                    }

                    function renderTokenStats(report) {
                        if (!report) return;
                        tokenStatsData = report;
                        tokenStatsLoaded = true;

                        const btn = document.getElementById('btnRefreshTokens');
                        if (btn) btn.style.opacity = '1';

                        // Scan time
                        const timeEl = document.getElementById('tokenLastScanTime');
                        if (timeEl && report.lastScanTime) {
                            const d = new Date(report.lastScanTime);
                            timeEl.textContent = '🕒 ' + d.toLocaleTimeString();
                        }

                        // KPI: Today
                        const today = report.summary.today || {};
                        const todayBilled = (today.inputTokens || 0) + (today.outputTokens || 0);
                        const todayGross = todayBilled + (today.cacheReadTokens || 0);
                        document.getElementById('kpiTodayGross').textContent = formatTokens(todayGross);
                        document.getElementById('kpiTodayBilled').textContent = formatTokens(todayBilled);
                        document.getElementById('kpiTodayPrompt').textContent = formatTokens(today.inputTokens || 0);
                        document.getElementById('kpiTodayCompletion').textContent = formatTokens(today.outputTokens || 0);
                        document.getElementById('kpiTodayCache').textContent = formatTokens(today.cacheReadTokens || 0);
                        document.getElementById('kpiTodaySteps').textContent = (today.stepCount || 0).toLocaleString();
                        document.getElementById('kpiTodayHitRate').textContent = (today.cacheHitRate || 0) + '%';

                        // KPI: 动态时段卡片 (今天->本周, 昨天->昨天, 近7天->近7天, 近30天->近30天)
                        updateDynamicKpiCard(report);

                        // KPI: All Time
                        const all = report.summary.allTime || {};
                        const allBilled = (all.inputTokens || 0) + (all.outputTokens || 0);
                        const allGross = allBilled + (all.cacheReadTokens || 0);
                        document.getElementById('kpiAllTimeGross').textContent = formatTokens(allGross);
                        document.getElementById('kpiAllTimeBilled').textContent = formatTokens(allBilled);
                        document.getElementById('kpiAllPrompt').textContent = formatTokens(all.inputTokens || 0);
                        document.getElementById('kpiAllCompletion').textContent = formatTokens(all.outputTokens || 0);
                        document.getElementById('kpiAllCache').textContent = formatTokens(all.cacheReadTokens || 0);
                        document.getElementById('kpiAllConvsSteps').textContent = (report.totalConversations || 0).toLocaleString() + ' / ' + (all.stepCount || 0).toLocaleString();
                        document.getElementById('kpiAllHitRate').textContent = (all.cacheHitRate || 0) + '%';

                        // 趋势卡片标题联动
                        const titleEl = document.getElementById('tokenTrendTitle');
                        let rangeLabel = msg('tokenStatsRangeToday');
                        if (report.timeRange === 'yesterday') rangeLabel = msg('tokenStatsRangeYesterday');
                        else if (report.timeRange === '7d') rangeLabel = msg('tokenStatsRange7d');
                        else if (report.timeRange === '30d') rangeLabel = msg('tokenStatsRange30d');

                        if (titleEl) {
                            if (report.trendType === 'hourly') {
                                titleEl.textContent = '📈 ' + msg('tokenStatsHourlyTrends') + ' (' + rangeLabel + ')';
                            } else {
                                titleEl.textContent = '📈 ' + msg('tokenStatsDailyTrends') + ' (' + rangeLabel + ')';
                            }
                        }

                        // 模型明细卡片标题联动
                        const modelTitleEl = document.getElementById('tokenModelRankingTitle');
                        if (modelTitleEl) {
                            modelTitleEl.textContent = '🤖 ' + msg('tokenStatsModelRanking') + ' (' + rangeLabel + ')';
                        }

                        // Chart: Trends (hourly or daily)
                        renderTrendsChart(report.trends || [], report.trendType || 'hourly');

                        // Model Ranking
                        renderModelRanking(report.modelRanking || []);

                        // Projects Ranking
                        renderProjectRanking(report.projectRanking || []);

                        // Top Sessions
                        renderTopSessions(report.topConversations || []);
                    }

                    function getModelLogoSvg(modelName) {
                        const name = (modelName || '').toLowerCase();
                        if (name.includes('gemini') || name.includes('argon') || name.includes('carbon')) {
                            return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="#3186FF"/><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#gemini-g0)"/><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#gemini-g1)"/><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#gemini-g2)"/><defs><linearGradient id="gemini-g0" x1="7" y1="15.5" x2="11" y2="12" gradientUnits="userSpaceOnUse"><stop stop-color="#08B962"/><stop offset="1" stop-color="#08B962" stop-opacity="0"/></linearGradient><linearGradient id="gemini-g1" x1="8" y1="5.5" x2="11.5" y2="11" gradientUnits="userSpaceOnUse"><stop stop-color="#F94543"/><stop offset="1" stop-color="#F94543" stop-opacity="0"/></linearGradient><linearGradient id="gemini-g2" x1="3.5" y1="13.5" x2="17.5" y2="12" gradientUnits="userSpaceOnUse"><stop stop-color="#FABC12"/><stop offset=".46" stop-color="#FABC12" stop-opacity="0"/></linearGradient></defs></svg>';
                        }
                        if (name.includes('claude') || name.includes('anthropic') || name.includes('sonnet') || name.includes('haiku') || name.includes('opus')) {
                            return '<svg viewBox="0 0 24 24" width="14" height="14" fill="#D97757"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>';
                        }
                        if (name.includes('gpt') || name.includes('openai') || name.includes('o1') || name.includes('o3') || name.includes('chatgpt')) {
                            return '<svg viewBox="0 0 24 24" width="14" height="14" fill="#10A37F"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 8.487a4.47 4.47 0 0 1 2.346-1.974V12.1a.776.776 0 0 0 .387.683l5.843 3.37-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 8.487zm16.597 3.855l-5.843-3.37 2.02-1.168a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.674a.79.79 0 0 0-.402-.684zm2.02-3.689l-.141-.085-4.784-2.759a.776.776 0 0 0-.78 0L9.409 9.178V6.845a.08.08 0 0 1 .033-.062L14.28 3.99a4.5 4.5 0 0 1 6.677 4.663zM8.306 15.421l-2.02-1.168a.071.071 0 0 1-.038-.052V8.618a4.494 4.494 0 0 1 7.37-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.392.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.607 1.5-2.602-1.5z"/></svg>';
                        }
                        if (name.includes('deepseek')) {
                            return '<svg viewBox="0 0 24 24" width="14" height="14" fill="#4D6BFE"><path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"/></svg>';
                        }
                        if (name.includes('qwen')) {
                            return '<svg viewBox="0 0 24 24" width="14" height="14" fill="#082DFF"><path d="M19.713 2.825h-5.907c0-.251-.066-.503-.196-.728L12.819.728A1.46 1.46 0 0 0 11.559 0h-1.58c-.52 0-1 .275-1.26.728l-2.42 4.19a1.45 1.45 0 0 0 0 1.453l.791 1.37c.26.448.74.727 1.26.727h11.36c.52 0 1-.275 1.26-.728l.79-1.37a1.45 1.45 0 0 0 0-1.451l-.79-1.37a1.46 1.46 0 0 0-1.26-.728zM.195 9.905l2.951 5.115a1.46 1.46 0 0 0-.531.531l-.791 1.37a1.45 1.45 0 0 0 0 1.452l.79 1.37c.26.448.74.727 1.26.727h4.84c.52 0 1-.275 1.26-.728l.79-1.37a1.45 1.45 0 0 0 0-1.451L5.086 7.083a1.46 1.46 0 0 0-1.26-.728h-1.58c-.52 0-1 .276-1.26.728l-.79 1.37a1.45 1.45 0 0 0 0 1.452m15.888 13.367 2.951-5.115c.217.125.469.196.728.196h1.582c.52 0 1-.275 1.26-.728l.79-1.37a1.45 1.45 0 0 0 0-1.451l-2.42-4.191a1.46 1.46 0 0 0-1.259-.728h-1.582c-.52 0-1 .276-1.259.728l-5.678 9.838a1.45 1.45 0 0 0 0 1.452l.79 1.37c.26.448.74.727 1.26.727h1.582c.52 0 1-.275 1.26-.728z"/></svg>';
                        }
                        if (name.includes('mistral') || name.includes('codestral')) {
                            return '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M3.428 3.4h3.429v3.428H3.428V3.4zm13.714 0h3.43v3.428h-3.43V3.4z" fill="#FFD700"/><path d="M3.428 6.828h6.857v3.429H3.429V6.828zm10.286 0h6.857v3.429h-6.857V6.828z" fill="#FFAF00"/><path d="M3.428 10.258h17.144v3.428H3.428v-3.428z" fill="#FF8205"/><path d="M3.428 13.686h3.429v3.428H3.428v-3.428zm6.858 0h3.429v3.428h-3.429v-3.428zm6.856 0h3.43v3.428h-3.43v-3.428z" fill="#FA500F"/><path d="M0 17.114h10.286v3.429H0v-3.429zm13.714 0H24v3.429H13.714v-3.429z" fill="#E10500"/></svg>';
                        }
                        if (name.includes('llama') || name.includes('meta')) {
                            return '<svg viewBox="0 0 24 24" width="14" height="14" fill="#0082FB"><path d="M12 14.6c-2.3 0-4.3-1.6-4.9-3.8.6-2.2 2.6-3.8 4.9-3.8s4.3 1.6 4.9 3.8c-.6 2.2-2.6 3.8-4.9 3.8M12 5C8 5 4.6 7.6 3.4 11.4c-.2.6-.2 1.3 0 1.9 1.2 3.8 4.6 6.4 8.6 6.4s7.4-2.6 8.6-6.4c.2-.6.2-1.3 0-1.9C19.4 7.6 16 5 12 5Z"/></svg>';
                        }
                        return '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="opacity:0.75;"><path d="M9 2L10.5 6.5L15 8L10.5 9.5L9 14L7.5 9.5L3 8L7.5 6.5L9 2ZM17 12L18 15L21 16L18 17L17 20L16 17L13 16L16 15L17 12Z"/></svg>';
                    }

                    function renderModelRanking(models) {
                        const tbody = document.getElementById('tokenModelTableBody');
                        if (!tbody) return;
                        if (!models || models.length === 0) {
                            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);">' + msg('tokenStatsNoData') + '</td></tr>';
                            return;
                        }

                        const maxModelTotal = models[0].totalTokens || 1;
                        let html = '';
                        models.forEach((m, idx) => {
                            const pct = Math.max(3, Math.min(100, Math.round((m.totalTokens / maxModelTotal) * 100)));
                            const billed = m.billedTokens || (m.inputTokens + m.outputTokens);
                            const gross = m.totalTokens || (billed + m.cacheReadTokens);
                            const tip = 'Model: ' + m.modelName + '<br/>' +
                                msg('tokenStatsTotalTokens') + ': ' + formatTokens(gross) + '<br/>' +
                                msg('tokenStatsTotalBilled') + ': ' + formatTokens(billed) + ' (' + formatTokens(m.inputTokens) + ' in, ' + formatTokens(m.outputTokens) + ' out)<br/>' +
                                msg('tokenStatsCacheTokens') + ': ' + formatTokens(m.cacheReadTokens) + ' (' + m.cacheHitRate + '%)<br/>' +
                                msg('tokenStatsStepCount') + ': ' + m.stepCount;

                            html += '<tr onmouseenter="showCustomTooltip(event, this)" onmouseleave="hideCustomTooltip()" data-tooltip="' + tip.replace(/"/g, '&quot;') + '">' +
                                '<td style="color:var(--text-secondary);font-weight:600;">' + (idx + 1) + '</td>' +
                                '<td>' +
                                    '<div style="display:flex;align-items:center;gap:6px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px;" title="' + m.modelName + '">' +
                                        '<span class="token-model-icon-box">' + getModelLogoSvg(m.modelName) + '</span>' +
                                        '<span style="overflow:hidden;text-overflow:ellipsis;">' + m.modelName + '</span>' +
                                    '</div>' +
                                    '<div class="token-proj-bar" style="width:' + pct + '%;"></div>' +
                                '</td>' +
                                '<td style="text-align:right;">' +
                                    '<div style="font-weight:600;">' + formatTokens(gross) + ' <span style="font-size:11px;color:var(--text-secondary);font-weight:normal;">(' + m.percentage + '%)</span></div>' +
                                    '<div style="font-size:10px;color:var(--text-secondary);">' + msg('tokenStatsTotalBilled') + ': ' + formatTokens(billed) + ' (' + formatTokens(m.inputTokens) + ' in / ' + formatTokens(m.outputTokens) + ' out)</div>' +
                                '</td>' +
                                '<td style="text-align:right;">' +
                                    '<div style="font-size:11px;color:#10b981;font-weight:600;">⚡ ' + formatTokens(m.cacheReadTokens) + '</div>' +
                                    '<div style="font-size:10px;color:#10b981;font-weight:600;">' + m.cacheHitRate + '%</div>' +
                                '</td>' +
                                '<td style="text-align:right;color:var(--text-secondary);font-size:12px;">' + m.stepCount + '</td>' +
                            '</tr>';
                        });
                        tbody.innerHTML = html;
                    }

                    function renderTrendsChart(trends, trendType) {
                        const container = document.getElementById('tokenChartContainer');
                        if (!container) return;
                        if (!trends || trends.length === 0) {
                            container.innerHTML = '<div style="margin:auto;color:var(--text-secondary);">' + msg('tokenStatsNoData') + '</div>';
                            return;
                        }

                        let maxVal = 1;
                        trends.forEach(t => {
                            const billed = (t.inputTokens || 0) + (t.outputTokens || 0);
                            const cache = (t.cacheReadTokens || 0);
                            const gross = billed + cache;
                            if (gross > maxVal) maxVal = gross;
                        });

                        const chartHeight = 52;
                        let html = '';
                        trends.forEach((t, idx) => {
                            const billed = (t.inputTokens || 0) + (t.outputTokens || 0);
                            const cache = (t.cacheReadTokens || 0);
                            const gross = billed + cache;
                            const billedH = Math.max(billed > 0 ? 2 : 0, Math.round((billed / maxVal) * chartHeight));
                            const cacheH = Math.max(cache > 0 ? 2 : 0, Math.round((cache / maxVal) * chartHeight));

                            let showLabel = false;
                            if (trendType === 'hourly') {
                                // 24小时显示: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00, 23:00
                                showLabel = (idx % 4 === 0) || (idx === 23);
                            } else if (trends.length <= 10) {
                                showLabel = true;
                            } else {
                                const step = trends.length > 14 ? 5 : 2;
                                const distFromEnd = trends.length - 1 - idx;
                                showLabel = (distFromEnd % step === 0) || (idx === 0 && distFromEnd >= step - 1);
                            }

                            const cacheSum = cache + (t.inputTokens || 0);
                            const dayHitRate = cacheSum > 0 ? (Math.round((cache / cacheSum) * 1000) / 10) : 0;

                            const tip = t.subLabel + '<br/>' +
                                msg('tokenStatsTotalTokens') + ': ' + formatTokens(gross) + '<br/>' +
                                msg('tokenStatsTotalBilled') + ': ' + formatTokens(billed) + ' (' + formatTokens(t.inputTokens || 0) + ' in, ' + formatTokens(t.outputTokens || 0) + ' out)<br/>' +
                                msg('tokenStatsCacheTokens') + ': ' + formatTokens(cache) + ' (' + dayHitRate + '%)<br/>' +
                                msg('tokenStatsStepCount') + ': ' + (t.stepCount || 0);

                            html += '<div class="token-bar-col" onmouseenter="showCustomTooltip(event, this)" onmouseleave="hideCustomTooltip()" data-tooltip="' + tip.replace(/"/g, '&quot;') + '">' +
                                '<div class="token-bar-stack">' +
                                    '<div class="bar-cache" style="height:' + cacheH + 'px;"></div>' +
                                    '<div class="bar-billed" style="height:' + billedH + 'px;"></div>' +
                                '</div>' +
                                '<div class="token-bar-date">' + (showLabel ? t.label : '') + '</div>' +
                            '</div>';
                        });
                        container.innerHTML = html;
                    }

                    function renderProjectRanking(projects) {
                        const tbody = document.getElementById('tokenProjectTableBody');
                        if (!tbody) return;
                        if (!projects || projects.length === 0) {
                            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-secondary);">' + msg('tokenStatsNoData') + '</td></tr>';
                            return;
                        }

                        const maxProjTotal = projects[0].totalTokens || 1;
                        let html = '';
                        projects.forEach((p, idx) => {
                            const pct = Math.max(3, Math.min(100, Math.round((p.totalTokens / maxProjTotal) * 100)));
                            const tip = 'Prompt: ' + formatTokens(p.inputTokens) + '<br/>Completion: ' + formatTokens(p.outputTokens) + '<br/>Cache Read: ' + formatTokens(p.cacheReadTokens) + '<br/>Steps: ' + p.stepCount;
                            html += '<tr onmouseenter="showCustomTooltip(event, this)" onmouseleave="hideCustomTooltip()" data-tooltip="' + tip.replace(/"/g, '&quot;') + '">' +
                                '<td style="color:var(--text-secondary);font-weight:600;">' + (idx + 1) + '</td>' +
                                '<td>' +
                                    '<div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;" title="' + p.projectName + '">' + p.projectName + '</div>' +
                                    '<div class="token-proj-bar" style="width:' + pct + '%;"></div>' +
                                '</td>' +
                                '<td style="text-align:right;">' +
                                    '<div style="font-weight:600;">' + formatTokens(p.totalTokens) + '</div>' +
                                    '<div style="font-size:10px;color:#10b981;">⚡ ' + formatTokens(p.cacheReadTokens) + '</div>' +
                                '</td>' +
                                '<td style="text-align:right;color:var(--text-secondary);">' + p.conversationCount + '</td>' +
                            '</tr>';
                        });
                        tbody.innerHTML = html;
                    }

                    function renderTopSessions(sessions) {
                        const tbody = document.getElementById('tokenSessionsTableBody');
                        if (!tbody) return;
                        if (!sessions || sessions.length === 0) {
                            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-secondary);">' + msg('tokenStatsNoData') + '</td></tr>';
                            return;
                        }

                        let html = '';
                        sessions.forEach((s, idx) => {
                            const tip = 'ID: ' + s.conversationId + '<br/>Prompt: ' + formatTokens(s.inputTokens) + '<br/>Completion: ' + formatTokens(s.outputTokens) + '<br/>Cache Read: ' + formatTokens(s.cacheReadTokens) + '<br/>Steps: ' + s.stepCount;
                            const timeStr = s.lastModified ? new Date(s.lastModified).toLocaleDateString() : '-';
                            html += '<tr onmouseenter="showCustomTooltip(event, this)" onmouseleave="hideCustomTooltip()" data-tooltip="' + tip.replace(/"/g, '&quot;') + '">' +
                                '<td style="color:var(--text-secondary);font-weight:600;">' + (idx + 1) + '</td>' +
                                '<td>' +
                                    '<div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;" title="' + s.title + '">' + s.title + '</div>' +
                                    '<div style="font-size:10px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;">' + s.workspaceName + '</div>' +
                                '</td>' +
                                '<td style="text-align:right;">' +
                                    '<div style="font-weight:600;">' + formatTokens(s.totalTokens) + '</div>' +
                                    '<div style="font-size:10px;color:#10b981;">⚡ ' + formatTokens(s.cacheReadTokens) + '</div>' +
                                '</td>' +
                                '<td style="text-align:right;font-size:11px;color:var(--text-secondary);">' + timeStr + '</td>' +
                            '</tr>';
                        });
                        tbody.innerHTML = html;
                    }

                    function updateViewUI() {
                        const tabContainer = document.getElementById('tabViewContainer');
                        const listContainer = document.getElementById('listViewContainer');
                        const tokenContainer = document.getElementById('tokenViewContainer');
                        const btnTab = document.getElementById('btnViewTab');
                        const btnList = document.getElementById('btnViewList');
                        const btnToken = document.getElementById('btnViewToken');

                        if (currentView === 'tab') {
                            tabContainer.style.display = 'flex';
                            listContainer.classList.remove('active');
                            if (tokenContainer) tokenContainer.style.display = 'none';
                            btnTab.classList.add('active');
                            btnList.classList.remove('active');
                            if (btnToken) btnToken.classList.remove('active');
                        } else if (currentView === 'list') {
                            tabContainer.style.display = 'none';
                            listContainer.classList.add('active');
                            if (tokenContainer) tokenContainer.style.display = 'none';
                            btnTab.classList.remove('active');
                            btnList.classList.add('active');
                            if (btnToken) btnToken.classList.remove('active');
                            renderListView();
                        } else if (currentView === 'token') {
                            tabContainer.style.display = 'none';
                            listContainer.classList.remove('active');
                            if (tokenContainer) tokenContainer.style.display = 'flex';
                            btnTab.classList.remove('active');
                            btnList.classList.remove('active');
                            if (btnToken) btnToken.classList.add('active');
                            if (!tokenStatsLoaded) {
                                fetchTokenStats();
                            }
                        }
                    }

                    function deleteAccount(id, email) {
                        vscode.postMessage({
                            command: 'delete',
                            accountId: id,
                            email: email
                        });
                    }

                    function showCustomTooltip(e, element) {
                        const content = element.getAttribute('data-tooltip');
                        if (!content) return;
                        const tooltip = document.getElementById('custom-global-tooltip');
                        tooltip.innerHTML = content.replace(/\\n/g, '<br>');
                        tooltip.classList.add('visible');
                        moveCustomTooltip(e);
                    }

                    function hideCustomTooltip() {
                        const tooltip = document.getElementById('custom-global-tooltip');
                        tooltip.classList.remove('visible');
                    }

                    function moveCustomTooltip(e) {
                        const tooltip = document.getElementById('custom-global-tooltip');
                        if (!tooltip.classList.contains('visible')) return;
                        
                        let x = e.clientX + 15;
                        let y = e.clientY + 15;
                        
                        const rect = tooltip.getBoundingClientRect();
                        if (x + rect.width > window.innerWidth) {
                            x = window.innerWidth - rect.width - 10;
                        }
                        if (y + rect.height > window.innerHeight) {
                            y = window.innerHeight - rect.height - 10;
                        }
                        
                        tooltip.style.left = x + 'px';
                        tooltip.style.top = y + 'px';
                    }

                    function getGroupQuotas(acc) {
                        if (!acc.quota || acc.quota.is_error || !acc.quota.models) return [];
                        const groups = (groupsConfig && groupsConfig.groups) ? groupsConfig.groups : [];
                        if (groups.length === 0) {
                            return acc.quota.models.map(m => m.has_5h ? Math.min(m.percentage, m.weekly_percentage !== undefined ? m.weekly_percentage : 100) : (m.weekly_percentage !== undefined ? m.weekly_percentage : m.percentage));
                        }
                        
                        return groups.map(group => {
                            if (acc.quota.quota_groups && acc.quota.quota_groups.length > 0) {
                                const qg = acc.quota.quota_groups.find(item => {
                                    const dn = (item.displayName || '').toLowerCase();
                                    const on = (group.officialName || '').toLowerCase();
                                    const gid = (group.id || '').toLowerCase();
                                    if (dn === on) return true;
                                    if (gid.includes('claude') || gid.includes('3p')) return dn.includes('claude') || dn.includes('gpt') || dn.includes('3p');
                                    if (gid === 'gemini_models' || gid === 'gemini') return dn === 'gemini models' || dn === 'gemini';
                                    const spToken = gid.replace(/gemini_?/g, '').replace(/_models?/g, '').replace(/[^a-z0-9]+/g, '');
                                    if (spToken && dn.includes(spToken)) return true;
                                    return false;
                                });
                                if (qg && qg.buckets && qg.buckets.length > 0) {
                                    return Math.min(...qg.buckets.map(b => b.percentage));
                                }
                            }
                            const gid = (group.id || '').toLowerCase();
                            const on = (group.officialName || '').toLowerCase();
                            const isClaude = gid.includes('claude') || gid.includes('3p') || on.includes('claude');
                            const isGeminiBase = (gid === 'gemini_models' || gid === 'gemini' || on === 'gemini models' || on === 'gemini');
                            const spToken = gid.replace(/gemini_?/g, '').replace(/_models?/g, '').replace(/[^a-z0-9]+/g, '');
                            const matchedModels = acc.quota.models.filter(m => {
                                const n = m.name.toLowerCase();
                                if (isClaude) return n.includes('claude') || n.includes('gpt');
                                if (spToken && !isGeminiBase) return n.includes(spToken);
                                if (isGeminiBase) return n.includes('gemini');
                                return false;
                            });
                            if (matchedModels.length > 0) {
                                return Math.min(...matchedModels.map(m => m.has_5h ? Math.min(m.percentage, m.weekly_percentage !== undefined ? m.weekly_percentage : 100) : (m.weekly_percentage !== undefined ? m.weekly_percentage : m.percentage)));
                            }
                            return -1;
                        });
                    }

                    function renderListView() {
                        const tbody = document.getElementById('accountTableBody');
                        tbody.innerHTML = '';

                        const listHeader = document.getElementById('listCounterHeader');
                        if (listHeader) {
                            listHeader.innerHTML = \`# <span style="font-size:10px; opacity:0.6; font-weight:normal;">(\${accounts.length})</span>\`;
                        }

                        // 更新表头排序图标
                        ['email', 'name', 'tier', 'quota', 'lastActive'].forEach(key => {
                            const icon = document.getElementById(\`sort-icon-\${key}\`);
                            if (icon) {
                                if (listSortKey === key) {
                                    icon.innerHTML = listSortOrder === 'asc' ? '▲' : '▼';
                                    icon.style.opacity = '1';
                                } else {
                                    icon.innerHTML = '↕';
                                    icon.style.opacity = '0.3';
                                }
                            }
                        });

                        if (accounts.length === 0) {
                            tbody.innerHTML = \`<tr><td colspan="7" style="text-align:center;padding:30px;">\${msg('noAccount')}</td></tr>\`;
                            return;
                        }

                        let sortedAccounts = [...accounts];
                        if (listSortKey !== 'default') {
                            sortedAccounts.sort((a, b) => {
                                let valA, valB;
                                if (listSortKey === 'email') {
                                    valA = a.email.toLowerCase();
                                    valB = b.email.toLowerCase();
                                } else if (listSortKey === 'name') {
                                    valA = (a.name || '').toLowerCase();
                                    valB = (b.name || '').toLowerCase();
                                } else if (listSortKey === 'tier') {
                                    valA = (a.quota && a.quota.tier) ? a.quota.tier : '';
                                    valB = (b.quota && b.quota.tier) ? b.quota.tier : '';
                                } else if (listSortKey === 'lastActive') {
                                    valA = a.last_used || 0;
                                    valB = b.last_used || 0;
                                } else if (listSortKey === 'quota') {
                                    const qA = getGroupQuotas(a);
                                    const qB = getGroupQuotas(b);
                                    for (let i = 0; i < Math.max(qA.length, qB.length); i++) {
                                        const qtA = qA[i] !== undefined ? qA[i] : -1;
                                        const qtB = qB[i] !== undefined ? qB[i] : -1;
                                        if (qtA !== qtB) {
                                            return listSortOrder === 'asc' ? qtA - qtB : qtB - qtA;
                                        }
                                    }
                                    return 0;
                                }
                                
                                if (valA < valB) return listSortOrder === 'asc' ? -1 : 1;
                                if (valA > valB) return listSortOrder === 'asc' ? 1 : -1;
                                return 0;
                            });
                        }

                        sortedAccounts.forEach(acc => {
                            const tr = document.createElement('tr');
                            if (acc.isCurrent) tr.className = 'current-account';

                            const lastUsedDate = new Date(acc.last_used);
                            const lastUsedStr = lastUsedDate.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                            
                            const statusDotClass = acc.isCurrent ? 'active' : 'inactive';
                            const statusTitle = acc.isCurrent ? msg('activeStatus') : msg('inactiveStatus');

                            const subTier = (acc.quota && acc.quota.tier) ? acc.quota.tier : '-';

                            // 计算各分组配额显示
                            let groupQuotasHtml = '';
                            let stackFullTitle = '';

                            if (!acc.quota || acc.quota.is_error) {
                                groupQuotasHtml = \`<div style="opacity:0.4; font-size:10px; text-align:center;">\${acc.quota?.is_error ? '❌' : '⏳'}</div>\`;
                                stackFullTitle = acc.quota?.is_error ? msg('quotaFetchError') : msg('quotaPendingRefresh');
                            } else {
                                const allGroupDetails = [];
                                const itemsToRender = [];

                                if (acc.quota && acc.quota.models && acc.quota.models.length > 0) {
                                    const sortedModels = [...acc.quota.models].sort((a, b) => 
                                        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
                                    );
                                    sortedModels.forEach(m => itemsToRender.push({ model: m }));
                                }

                                function makeAsciiBar(pct) {
                                    const safePct = Math.max(0, Math.min(100, Math.round(pct || 0)));
                                    return '<span class="tt-bar"><span class="tt-fill" style="width:' + safePct + '%;"></span></span>';
                                }

                                function formatCountdown(rawTime) {
                                    if (!rawTime) return '-';
                                    const d = new Date(rawTime);
                                    if (isNaN(d.getTime())) return '-';
                                    const diff = d.getTime() - Date.now();
                                    if (diff <= 0) return msg('reset');
                                    const h = Math.floor(diff / 3600000);
                                    const m = Math.floor((diff % 3600000) / 60000);
                                    if (h >= 24) {
                                        const days = Math.floor(h / 24);
                                        return days + 'd' + (h % 24) + 'h';
                                    }
                                    const tStr = d.toLocaleTimeString(initialLanguage.startsWith('zh') ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                                    return h + 'h' + String(m).padStart(2, '0') + 'm (' + tStr + ')';
                                }

                                const hasAny5h = (acc.quota.models || []).some(m => m.has_5h);

                                if (itemsToRender.length > 0) {
                                    itemsToRender.forEach(it => {
                                        const m = it.model;
                                        const effectivePct = m.has_5h ? m.percentage : (m.weekly_percentage !== undefined ? m.weekly_percentage : m.percentage);
                                        const icon = effectivePct > 50 ? '🟢' : (effectivePct > 20 ? '🟡' : '🔴');
                                        
                                        // 周配额 文本
                                        const wPct = m.weekly_percentage !== undefined ? m.weekly_percentage : m.percentage;
                                        const wStr = (wPct.toFixed(0) + '%').padStart(4, ' ');
                                        const rwStr = formatCountdown(m.weekly_reset_time_raw || m.weekly_reset_time || m.reset_time_raw);
                                        const weeklyCell = '<span>📅 ' + makeAsciiBar(wPct) + ' ' + wStr + ' → ' + rwStr + '</span>';
                                        const nameCell = '<span>' + icon + ' ' + m.name + '</span>';

                                        if (hasAny5h) {
                                            // 账号包含 5H 额度时，三列对齐显示（无 5H 的模型该列留空，不显示 - 与 | 分隔符）
                                            let h5Cell = '<span></span>';
                                            if (m.has_5h) {
                                                const p5Str = (m.percentage.toFixed(0) + '%').padStart(4, ' ');
                                                const r5Str = formatCountdown(m.reset_time_raw || m.reset_time);
                                                h5Cell = '<span>🕒 ' + makeAsciiBar(m.percentage) + ' ' + p5Str + ' → ' + r5Str + '</span>';
                                            }
                                            allGroupDetails.push(nameCell + h5Cell + weeklyCell);
                                        } else {
                                            // 账号无 5H 额度时 (Free 账号)，双列紧凑展示周配额
                                            allGroupDetails.push(nameCell + weeklyCell);
                                        }
                                    });
                                    const gridClass = hasAny5h ? 'tt-grid-3' : 'tt-grid-2';
                                    stackFullTitle = '<div class="' + gridClass + '">' + allGroupDetails.join('') + '</div>';
                                } else {
                                    stackFullTitle = '  ( ' + msg('noAccount') + ' )';
                                }

                                // 构建分组条形图 HTML
                                const groups = (groupsConfig && groupsConfig.groups && groupsConfig.groups.length > 0)
                                    ? groupsConfig.groups
                                    : [{ name: 'Default', officialName: 'Default', id: 'default' }];

                                function getGroupQuotaVal(g, winType) {
                                    if (acc.quota.quota_groups && acc.quota.quota_groups.length > 0) {
                                        const qg = acc.quota.quota_groups.find(item => {
                                            const dn = (item.displayName || '').toLowerCase();
                                            const on = (g.officialName || '').toLowerCase();
                                            const gid = (g.id || '').toLowerCase();
                                            if (dn === on) return true;
                                            if (gid.includes('claude') || gid.includes('3p')) return dn.includes('claude') || dn.includes('gpt') || dn.includes('3p');
                                            if (gid === 'gemini_models' || gid === 'gemini') return dn === 'gemini models' || dn === 'gemini';
                                            const spToken = gid.replace(/gemini_?/g, '').replace(/_models?/g, '').replace(/[^a-z0-9]+/g, '');
                                            if (spToken && dn.includes(spToken)) return true;
                                            return false;
                                        });
                                        if (qg && qg.buckets) {
                                            const b = qg.buckets.find(bk => {
                                                const w = (bk.window || '').toLowerCase();
                                                const bid = (bk.bucketId || '').toLowerCase();
                                                return winType === '5h'
                                                    ? (w.includes('5h') || bid.includes('5h') || w.includes('hour') || bid.includes('hour'))
                                                    : (w.includes('week') || bid.includes('week'));
                                            });
                                            if (b) return b.percentage;
                                        }
                                    }
                                    const gid = (g.id || '').toLowerCase();
                                    const on = (g.officialName || '').toLowerCase();
                                    const isClaude = gid.includes('claude') || gid.includes('3p') || on.includes('claude');
                                    const isGeminiBase = (gid === 'gemini_models' || gid === 'gemini' || on === 'gemini models' || on === 'gemini');
                                    const spToken = gid.replace(/gemini_?/g, '').replace(/_models?/g, '').replace(/[^a-z0-9]+/g, '');
                                    const matched = (acc.quota.models || []).filter(m => {
                                        const mn = (m.name || '').toLowerCase();
                                        if (isClaude) return mn.includes('claude') || mn.includes('gpt');
                                        if (spToken && !isGeminiBase) return mn.includes(spToken);
                                        if (isGeminiBase) return mn.includes('gemini');
                                        return false;
                                    });
                                    if (matched.length > 0) {
                                        if (winType === '5h') {
                                            const m5 = matched.filter(m => m.has_5h);
                                            return m5.length > 0 ? Math.min(...m5.map(m => m.percentage)) : -1;
                                        } else {
                                            return Math.min(...matched.map(m => m.weekly_percentage !== undefined ? m.weekly_percentage : m.percentage));
                                        }
                                    }
                                    return -1;
                                }

                                const activeGroupsForAcc = groups.filter(g => getGroupQuotaVal(g, 'weekly') >= 0 || getGroupQuotaVal(g, '5h') >= 0);

                                if (activeGroupsForAcc.length === 0) {
                                    groupQuotasHtml = '<div style="opacity:0.4; font-size:10px; text-align:center;">-</div>';
                                } else {
                                    const barsWeeklyHtml = activeGroupsForAcc.map(g => {
                                        const val = getGroupQuotaVal(g, 'weekly');
                                        if (val < 0) return '<div class="group-quota-bar no-data"></div>';
                                        let color = '#4ade80';
                                        if (val <= 20) color = '#f87171';
                                        else if (val <= 50) color = '#fbbf24';
                                        return '<div class="group-quota-bar" title="' + (g.name || g.officialName) + ': ' + val + '%"><div class="group-quota-fill" style="width:' + val + '%; background:' + color + '"></div></div>';
                                    }).join('');

                                    const isOverdue = (acc.quota.models || []).some(m => {
                                        const raw5h = m.has_5h ? (m.reset_time_raw || m.reset_time) : null;
                                        const is5hOverdue = raw5h && !isNaN(new Date(raw5h).getTime()) && (new Date(raw5h).getTime() <= Date.now());
                                        
                                        const rawWeekly = m.weekly_reset_time_raw || m.weekly_reset_time || m.reset_time_raw;
                                        const isWeeklyOverdue = rawWeekly && !isNaN(new Date(rawWeekly).getTime()) && (new Date(rawWeekly).getTime() <= Date.now());
                                        
                                        return is5hOverdue || isWeeklyOverdue;
                                    });

                                    if (isOverdue) {
                                        // 过了重置时间（不论 5H 还是周配额），居中展示反转沙漏图标 ⌛，不再绘制旧进度条
                                        groupQuotasHtml = '<div style="opacity:0.75; font-size:12px; text-align:center;">⌛</div>';
                                    } else if (hasAny5h) {
                                        const bars5hHtml = activeGroupsForAcc.map(g => {
                                            const val = getGroupQuotaVal(g, '5h');
                                            if (val < 0) return '<div class="group-quota-bar no-data"></div>';
                                            let color = '#4ade80';
                                            if (val <= 20) color = '#f87171';
                                            else if (val <= 50) color = '#fbbf24';
                                            return '<div class="group-quota-bar" title="' + (g.name || g.officialName) + ' (5H): ' + val + '%"><div class="group-quota-fill" style="width:' + val + '%; background:' + color + '"></div></div>';
                                        }).join('');

                                        groupQuotasHtml = 
                                            '<div class="group-quota-row">' +
                                                '<span class="group-quota-label" title="' + msg('quotaWindow5h') + '">🕒</span>' +
                                                '<div class="group-quota-bars">' + bars5hHtml + '</div>' +
                                            '</div>' +
                                            '<div class="group-quota-row">' +
                                                '<span class="group-quota-label" title="' + msg('quotaWindowWeekly') + '">📅</span>' +
                                                '<div class="group-quota-bars">' + barsWeeklyHtml + '</div>' +
                                            '</div>';
                                    } else {
                                        // 无 5H 额度时，仅渲染单行周配额条
                                        groupQuotasHtml = 
                                            '<div class="group-quota-row">' +
                                                '<span class="group-quota-label" title="' + msg('quotaWindowWeekly') + '">📅</span>' +
                                                '<div class="group-quota-bars">' + barsWeeklyHtml + '</div>' +
                                            '</div>';
                                    }
                                }
                            }

                            tr.innerHTML = \`
                                <td><span class="status-dot \${statusDotClass}" title="\${statusTitle}"></span></td>
                                <td>\${acc.email}</td>
                                <td>\${acc.name || '-'}</td>
                                <td><span class="badge" style="background:#e0f2fe;color:#0369a1;border:1px solid #7dd3fc; margin-left: 0;">\${subTier}</span></td>
                                <td><div class="group-quota-stack" 
                                         data-tooltip="\${stackFullTitle.replace(/\"/g, '&quot;')}"
                                         onmouseenter="showCustomTooltip(event, this)" 
                                         onmouseleave="hideCustomTooltip()"
                                         onmousemove="moveCustomTooltip(event)">\${groupQuotasHtml || '-'}</div></td>
                                <td style="color:var(--text-secondary);font-size:12px;">\${lastUsedStr}</td>
                                <td style="text-align: right;">
                                    <div class="btn-group" style="justify-content: flex-end;">
                                        \${!acc.isCurrent ? \`<button class="teal icon-btn" title="\${msg('switchBtn')}" onclick="switchAccount('\${acc.id}', '\${acc.email}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/></svg></button>\` : \`<span style="font-size:14px;color:#4ade80;margin-right:8px;font-weight:bold;" title="\${msg('currentAccountLabel')}">✓</span>\`}
                                        <button class="secondary icon-btn" title="\${msg('refreshBtn')}" onclick="refreshAccount('\${acc.id}', this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></button>
                                        <button class="secondary icon-btn" title="\${msg('exportTokenBtn')}" onclick="exportToken('\${acc.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/></svg></button>
                                        <button class="secondary icon-btn danger-hover" title="\${msg('deleteBtn')}" onclick="deleteAccount('\${acc.id}', '\${acc.email}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>
                                    </div>
                                </td>
                            \`;
                            tbody.appendChild(tr);
                        });
                    }

function render() {
    const tabContainer = document.getElementById('tabContainer');
    const panelContainer = document.getElementById('panelContainer');

    tabContainer.innerHTML = '';
    panelContainer.innerHTML = '';

    const tabHeaderGroup = document.createElement('div');
    tabHeaderGroup.style = "display: flex; justify-content: space-between; align-items: center; padding: 4px 6px 8px 6px; margin-bottom: 2px; border-bottom: 1px solid var(--border-color); font-size: 11px; font-weight: 700; color: var(--text-secondary); letter-spacing: 0.5px;";
    tabHeaderGroup.innerHTML = \`<span>ACCOUNTS</span><span style="background: rgba(14, 165, 233, 0.15); color: var(--primary-blue); padding: 2px 6px; border-radius: 10px; font-size: 9px; line-height: 1;">\${accounts.length}</span>\`;
    tabContainer.appendChild(tabHeaderGroup);

    // Render Tabs View
    accounts.forEach(acc => {
        const tab = document.createElement('div');
        tab.className = 'tab' + (acc.id === activeAccountId ? ' active' : '');
        const shortEmail = acc.email.split('@')[0];
        const dotColor = acc.isCurrent ? '#4ade80' : 'var(--text-secondary)';
        const dotGlow = acc.isCurrent ? 'box-shadow: 0 0 8px rgba(74, 222, 128, 0.6);' : 'opacity: 0.3;';
        tab.innerHTML = \`<span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:\${dotColor}; \${dotGlow} margin-right:6px; flex-shrink:0;"></span>
                         <span class="tab-name">\${shortEmail}</span>\`;
        if (acc.isCurrent) {
            tab.innerHTML += \`<span class="badge" style="margin-left:4px; padding:1px 4px; font-size:9px;">\${msg('currentAccountLabel').toUpperCase()}</span>\`;
        }

        tab.setAttribute('data-tooltip', acc.email);
        tab.onmouseenter = (e) => showCustomTooltip(e, tab);
        tab.onmouseleave = () => hideCustomTooltip();
        tab.onmousemove = (e) => moveCustomTooltip(e);
                            tab.onclick = () => {
                                activeAccountId = acc.id;
                                vscode.setState({ activeAccountId: activeAccountId });
                                render();
                            };
                            tabContainer.appendChild(tab);

                            const panel = document.createElement('div');
                            panel.className = 'account-panel' + (acc.id === activeAccountId ? ' active' : '');

                            let quotaHtml = '';
                            if (acc.quota && acc.quota.is_error) {
                                // 配额获取返回了具体错误（如 429 / 500 等）
                                const isRateLimit = acc.quota.error_status === 429;
                                const errorTitle = isRateLimit ? msg('quotaRateLimited') : msg('quotaFetchError');
                                const errorDetail = acc.quota.error_message || 'Unknown error';
                                quotaHtml = \`
                                    <div style="text-align:center; padding: 24px 20px; background: rgba(248, 113, 113, 0.08); border-radius: 12px; border: 1px dashed rgba(248, 113, 113, 0.5); color: var(--text-secondary); margin-top:20px;">
                                        <div style="font-size: 24px; margin-bottom:12px;">\${isRateLimit ? '⏱️' : '❌'}</div>
                                        <div style="color: #f87171; font-weight: 600; font-size: 15px;">\${errorTitle}</div>
                                        <div style="font-size: 12px; margin-top: 8px; line-height: 1.6; opacity: 0.8;">\${msg('quotaErrorDetail', errorDetail)}</div>
                                        <div style="font-size: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(248, 113, 113, 0.15); color: var(--vscode-textLink-foreground); cursor: pointer;" onclick="refreshAccount('\${acc.id}')">
                                            \${msg('quotaRetryHint')}
                                        </div>
                                    </div>\`;
                            } else if (acc.quota && !acc.quota.is_forbidden) {
                                if (acc.quota.models && acc.quota.models.length > 0) {
                                    quotaHtml = renderModelsGrid(acc.quota.models);
                                } else {
                                    quotaHtml = \`
                                        <div style="text-align:center; padding: 24px 20px; background: rgba(14, 165, 233, 0.05); border-radius: 12px; border: 1px dashed rgba(14, 165, 233, 0.4); color: var(--text-secondary); margin-top:20px;">
                                            <div style="font-size: 24px; margin-bottom:12px;">ℹ️</div>
                                            <div style="color: var(--text-primary); font-weight: 600; font-size: 14px;">\${msg('noAccount')}</div>
                                        </div>\`;
                                }
                            } else {
                                // 区分当前账号和非当前账号的提示
                                if (acc.isCurrent) {
                                    // 当前账号无数据 - 可能正在加载
                                    quotaHtml = \`
                                        <div style="text-align:center; padding: 20px; background: rgba(14, 165, 233, 0.05); border-radius: 12px; border: 1px dashed rgba(14, 165, 233, 0.4); color: var(--text-secondary); margin-top:20px;">
                                            <div style="font-size: 18px; margin-bottom:8px;">⏳</div>
                                            <div style="color: var(--text-primary);">\${msg('loading')}</div>
                                            <div style="font-size: 12px; margin-top: 8px; opacity: 0.8;">\${msg('loadingTooltip')}</div>
                                        </div>\`;
                                } else {
                                    // 非当前账号无数据 - 正常现象，友好提示
                                    quotaHtml = \`
                                        <div style="text-align:center; padding: 24px 20px; background: rgba(14, 165, 233, 0.05); border-radius: 12px; border: 1px dashed rgba(14, 165, 233, 0.4); color: var(--text-secondary); margin-top:20px;">
                                            <div style="font-size: 24px; margin-bottom:12px;">💤</div>
                                            <div style="color: var(--text-primary); font-weight: 600; font-size: 15px;">\${msg('quotaPendingRefresh')}</div>
                                            <div style="font-size: 12px; margin-top: 8px; line-height: 1.6; opacity: 0.8;">\${msg('quotaPendingDetail')}</div>
                                            <div style="font-size: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(14, 165, 233, 0.1); color: var(--vscode-textLink-foreground); cursor: pointer;" onclick="refreshAccount('\${acc.id}')">
                                                \${msg('quotaManualRefresh')}
                                            </div>
                                        </div>\`;
                                }
                            }

                            const lastUsedDate = new Date(acc.last_used);
                            const lastUsedStr = lastUsedDate.toLocaleString('zh-CN', { 
                                month: '2-digit', 
                                day: '2-digit', 
                                hour: '2-digit', 
                                minute: '2-digit' 
                            });

                            panel.innerHTML = \`
                                <div class="panel-header">
                                    <div class="account-info">
                                        <div class="account-info-row">
                                            <h2>\${acc.name || msg('unnamedAccount')}</h2>
                                            \${acc.quota?.tier ? 
                                                \`<span class="badge" style="background:var(--accent-blue);color:var(--primary-blue);margin-left:0;border:1px solid var(--primary-blue)">\${acc.quota.tier.toUpperCase()}</span>\` : 
                                                \`<span class="badge" style="background:transparent;color:var(--text-secondary);margin-left:0;border:1px solid var(--border-color);opacity:0.6;">-</span>\`
                                            }
                                        </div>
                                        <div class="account-info-meta">
                                            <span>\${acc.email}</span>
                                            <span class="meta-divider">|</span>
                                            <span style="opacity: 0.8;">\${msg('lastActiveHeader')}: \${lastUsedStr}</span>
                                        </div>
                                    </div>
                                    <div class="btn-group">
                                        <button class="secondary" onclick="refreshAccount('\${acc.id}')">\${msg('refreshBtn')}</button>
                                        <button class="secondary" onclick="exportToken('\${acc.id}')">🔑 \${msg('exportTokenBtn')}</button>
                                        <button onclick="switchAccount('\${acc.id}', '\${acc.email}')" \${acc.isCurrent ? 'disabled' : ''}>
                                            \${acc.isCurrent ? msg('currentAccountLabel') : msg('switchBtn')}
                                        </button>
                                    </div>
                                </div>
                                \${quotaHtml}
                                <div style="margin-top: 10px; padding-top: 12px; border-top: 1px solid var(--border-color); display:flex; justify-content: flex-end;">
                                    <button class="danger" onclick="deleteAccount('\${acc.id}', '\${acc.email}')">\${msg('deleteBtn')}</button>
                                </div>
                            \`;
                            panelContainer.appendChild(panel);
                        });
                        updateViewUI();
                    }

                    let currentSourceAccountId = '__all__';

                    function populateGroupSourceSelect() {
                        const select = document.getElementById('groupSourceSelect');
                        if (!select) return;
                        select.innerHTML = '<option value="__all__">${t('groupSourceAll')}</option>';
                        accounts.forEach(acc => {
                            const opt = document.createElement('option');
                            opt.value = acc.id;
                            const tierText = (acc.quota && acc.quota.tier) ? \` [\${acc.quota.tier}]\` : '';
                            const currentTag = acc.isCurrent ? ' (' + msg('currentAccountLabel') + ')' : '';
                            opt.textContent = \`\${acc.name || acc.email}\${tierText}\${currentTag}\`;
                            select.appendChild(opt);
                        });
                        select.value = currentSourceAccountId;
                    }

                    // 打开分组管理弹窗
                    function openGroupManager() {
                        populateGroupSourceSelect();
                        vscode.postMessage({ command: 'getGroupsConfig', sourceAccountId: currentSourceAccountId, prune: true });
                        document.getElementById('groupModal').classList.add('active');
                        renderGroupsList();
                    }

                    function changeGroupSource(val) {
                        currentSourceAccountId = val;
                        vscode.postMessage({ command: 'getGroupsConfig', sourceAccountId: val, prune: true });
                    }

                    function syncFromSelectedSource() {
                        vscode.postMessage({ command: 'getGroupsConfig', sourceAccountId: currentSourceAccountId, prune: true });
                    }

                    // 关闭分组管理弹窗
                    function closeGroupManager() {
                        document.getElementById('groupModal').classList.remove('active');
                    }

                    // 渲染分组列表
                    function renderGroupsList() {
                        const container = document.getElementById('groupsList');
                        if (!groupsConfig || !groupsConfig.groups || groupsConfig.groups.length === 0) {
                            container.innerHTML = \`
                                <div class="empty-state" style="padding: 30px 10px;">
                                    <div class="empty-state-icon" style="font-size: 32px;">📭</div>
                                    <p>\${msg('noGroupConfigured') || '暂无可配置的模型分组'}</p>
                                </div>
                            \`;
                            return;
                        }

                        // 按 order 升序排序
                        const sorted = [...groupsConfig.groups].sort((a, b) => (a.order || 0) - (b.order || 0));

                        container.innerHTML = sorted.map((g, index) => {
                            const isFirst = index === 0;
                            const isLast = index === sorted.length - 1;
                            const isChecked = g.enabled !== false;
                            const officialName = g.officialName || g.name;
                            const shortName = g.name || g.officialName;
                            const desc = g.description ? \`<span style="opacity: 0.75;">(\${g.description})</span>\` : '';

                            return \`
                                <div class="group-item-card \${isChecked ? '' : 'disabled-group'}" data-group-id="\${g.id}">
                                    <div class="group-toggle-wrap">
                                        <input type="checkbox" class="group-toggle-checkbox" id="chk-\${g.id}" 
                                            \${isChecked ? 'checked' : ''} 
                                            onchange="toggleGroupEnabled('\${g.id}', this.checked)" title="\${msg('showOnStatusBar') || '在状态栏显示'}">
                                    </div>
                                    <div class="group-info-main">
                                        <div class="group-name-row">
                                            <span class="group-name-label">\${msg('groupShortNameLabel') || '显示简称'}:</span>
                                            <input type="text" class="group-short-input" value="\${shortName}" 
                                                onchange="updateGroupShortName('\${g.id}', this.value)"
                                                placeholder="\${msg('groupShortNamePlaceholder')}">
                                        </div>
                                        <div class="group-official-desc">
                                            <span class="group-badge">\${officialName}</span>
                                            \${desc}
                                        </div>
                                    </div>
                                    <div class="group-order-controls">
                                        <button class="group-order-btn" onclick="moveGroupOrder('\${g.id}', -1)" \${isFirst ? 'disabled' : ''} title="\${msg('moveUp')}">▲</button>
                                        <button class="group-order-btn" onclick="moveGroupOrder('\${g.id}', 1)" \${isLast ? 'disabled' : ''} title="\${msg('moveDown')}">▼</button>
                                    </div>
                                </div>
                            \`;
                        }).join('');
                    }

                    // 切换分组在状态栏的展示开关
                    function toggleGroupEnabled(groupId, enabled) {
                        const group = groupsConfig.groups.find(g => g.id === groupId);
                        if (group) {
                            group.enabled = enabled;
                            renderGroupsList();
                        }
                    }

                    // 更新分组显示简称
                    function updateGroupShortName(groupId, newName) {
                        const group = groupsConfig.groups.find(g => g.id === groupId);
                        if (group) {
                            group.name = newName.trim() || group.officialName;
                        }
                    }

                    // 调整分组展示顺序
                    function moveGroupOrder(groupId, direction) {
                        const sorted = [...groupsConfig.groups].sort((a, b) => (a.order || 0) - (b.order || 0));
                        const idx = sorted.findIndex(g => g.id === groupId);
                        if (idx < 0) return;
                        const targetIdx = idx + direction;
                        if (targetIdx < 0 || targetIdx >= sorted.length) return;

                        const cur = sorted[idx];
                        const target = sorted[targetIdx];
                        const temp = cur.order || (idx + 1);
                        cur.order = target.order || (targetIdx + 1);
                        target.order = temp;

                        sorted.sort((a, b) => (a.order || 0) - (b.order || 0));
                        sorted.forEach((g, i) => g.order = i + 1);
                        groupsConfig.groups = sorted;

                        renderGroupsList();
                    }

                    // 恢复默认分组配置
                    function resetGroupsToDefault() {
                        vscode.postMessage({ command: 'resetGroups' });
                    }

                    // 保存分组设置
                    function saveGroups() {
                        vscode.postMessage({ command: 'saveGroups', config: groupsConfig });
                        closeGroupManager();
                    }

                    // 接收来自扩展的消息
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'groupsConfig') {
                            groupsConfig = message.config;
                            if (message.sourceAccountId) {
                                currentSourceAccountId = message.sourceAccountId;
                                const select = document.getElementById('groupSourceSelect');
                                if (select) select.value = currentSourceAccountId;
                            }
                            renderGroupsList();
                            renderListView();
                        }
                    });

                    function switchAccount(id, email) {
                        vscode.postMessage({ command: 'switch', accountId: id, email: email });
                    }
                    function refreshAccount(id, btn) {
                        if (btn) {
                            const svg = btn.querySelector('svg');
                            if (svg) {
                                svg.classList.add('rotating');
                            } else {
                                btn.style.opacity = '0.5';
                            }
                        }
                        vscode.postMessage({ command: 'refresh', accountId: id });
                    }
                    function refreshAll() {
                        document.querySelectorAll('button[onclick*="refresh"] svg').forEach(el => el.classList.add('rotating'));
                        vscode.postMessage({ command: 'refreshAll' });
                    }
                    function addAccount() {
                        vscode.postMessage({ command: 'addAccount' });
                    }

                    // Token 登录弹窗
                    function openTokenLoginModal() {
                        document.getElementById('tokenLoginModal').classList.add('active');
                        document.getElementById('tokenInput').value = '';
                        document.getElementById('tokenInput').focus();
                    }
                    function closeTokenLoginModal() {
                        document.getElementById('tokenLoginModal').classList.remove('active');
                    }
                    function submitTokenLogin() {
                        const token = document.getElementById('tokenInput').value.trim();
                        if (!token) return;
                        vscode.postMessage({ command: 'loginWithToken', token: token });
                        closeTokenLoginModal();
                    }

                    // 导出 Token
                    function exportToken(accountId) {
                        vscode.postMessage({ command: 'exportToken', accountId: accountId });
                    }

                    // 批量导出
                    function batchExport() {
                        vscode.postMessage({ command: 'batchExportTokens' });
                    }

                    // 批量导入弹窗
                    function openBatchImportModal() {
                        document.getElementById('batchImportModal').classList.add('active');
                        document.getElementById('batchImportInput').value = '';
                        document.getElementById('batchImportInput').focus();
                    }
                    function closeBatchImportModal() {
                        document.getElementById('batchImportModal').classList.remove('active');
                    }
                    function submitBatchImport() {
                        const jsonText = document.getElementById('batchImportInput').value.trim();
                        if (!jsonText) return;
                        vscode.postMessage({ command: 'batchImportTokens', jsonText: jsonText });
                        closeBatchImportModal();
                    }

                    render();
                </script>
            </body>
            </html>`;
    }
}
