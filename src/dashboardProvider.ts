import * as vscode from 'vscode';
import { AccountManager, Account } from './accountManager';
import { ModelGroupManager, ModelGroup, ModelGroupsConfig, ModelInfo } from './modelGroupManager';
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
            if (e.affectsConfiguration('antigravity-cockpit.language')) {
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
                        case 'getGroupsConfig':
                            // 获取当前分组配置
                            const config = ModelGroupManager.loadGroups();
                            this._panel.webview.postMessage({
                                command: 'groupsConfig',
                                config: config
                            });
                            return;

                        case 'autoGroup':
                            // 自动分组
                            const models: ModelInfo[] = message.models || [];
                            const autoGroups = ModelGroupManager.autoGroup(models);
                            let autoConfig = ModelGroupManager.loadGroups();
                            autoConfig.groups = autoGroups;
                            autoConfig.lastAutoGrouped = Date.now();
                            ModelGroupManager.saveGroups(autoConfig);
                            this._panel.webview.postMessage({
                                command: 'groupsConfig',
                                config: autoConfig
                            });
                            vscode.commands.executeCommand('antigravity-cockpit.refreshStatusBar');
                            vscode.window.showInformationMessage(`已自动创建 ${autoGroups.length} 个分组`);
                            return;

                        case 'addGroup':
                            // 添加新分组
                            let addConfig = ModelGroupManager.loadGroups();
                            const newGroup = ModelGroupManager.createGroup(message.groupName || '新分组');
                            addConfig = ModelGroupManager.addGroup(addConfig, newGroup);
                            ModelGroupManager.saveGroups(addConfig);
                            this._panel.webview.postMessage({
                                command: 'groupsConfig',
                                config: addConfig
                            });
                            return;

                        case 'deleteGroup':
                            // 删除分组
                            let deleteConfig = ModelGroupManager.loadGroups();
                            deleteConfig = ModelGroupManager.deleteGroup(deleteConfig, message.groupId);
                            ModelGroupManager.saveGroups(deleteConfig);
                            this._panel.webview.postMessage({
                                command: 'groupsConfig',
                                config: deleteConfig
                            });
                            return;

                        case 'updateGroupName':
                            // 更新分组名称
                            let renameConfig = ModelGroupManager.loadGroups();
                            renameConfig = ModelGroupManager.updateGroup(renameConfig, message.groupId, { name: message.newName });
                            ModelGroupManager.saveGroups(renameConfig);
                            this._panel.webview.postMessage({
                                command: 'groupsConfig',
                                config: renameConfig
                            });
                            return;

                        case 'addModelToGroup':
                            // 向分组添加模型
                            let addModelConfig = ModelGroupManager.loadGroups();
                            addModelConfig = ModelGroupManager.addModelToGroup(addModelConfig, message.groupId, message.modelName);
                            ModelGroupManager.saveGroups(addModelConfig);
                            this._panel.webview.postMessage({
                                command: 'groupsConfig',
                                config: addModelConfig
                            });
                            return;

                        case 'removeModelFromGroup':
                            // 从分组移除模型
                            let removeModelConfig = ModelGroupManager.loadGroups();
                            removeModelConfig = ModelGroupManager.removeModelFromGroup(removeModelConfig, message.groupId, message.modelName);
                            ModelGroupManager.saveGroups(removeModelConfig);
                            this._panel.webview.postMessage({
                                command: 'groupsConfig',
                                config: removeModelConfig
                            });
                            return;

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

        // === 第一阶段：立即渲染（使用缓存数据，不发网络请求）===
        const accountsDataPhase1 = index.accounts.map(acc => {
            const fullAcc = AccountManager.loadAccount(acc.id);
            let quota = null;
            if (fullAcc.token) {
                // 仅读缓存，不发起 API 请求
                quota = AccountManager.getQuotaFromCache(fullAcc.token.access_token);
            }
            return {
                ...fullAcc,
                quota,
                isCurrent: acc.id === index.current_account_id
            };
        });

        // 立即渲染界面（当前账号配额通常已被状态栏定时刷新缓存）
        this._panel.webview.html = this._getHtmlForWebview(accountsDataPhase1, groupsConfig, index.ui_state || {});

        // === 第二阶段：后台获取当前账号缺失的配额数据 ===
        // 仅对当前账号发起 API 请求，非当前账号保持 null（显示"待刷新"提示）
        const currentAccMissing = accountsDataPhase1.find(acc => acc.isCurrent && acc.token && !acc.quota);
        if (currentAccMissing) {
            const accountsDataPhase2 = await Promise.all(index.accounts.map(async acc => {
                const fullAcc = AccountManager.loadAccount(acc.id);
                const isCurrent = acc.id === index.current_account_id;
                let quota = null;
                if (fullAcc.token) {
                    if (isCurrent) {
                        // 当前账号：发起 API 请求获取最新配额
                        try {
                            quota = await AccountManager.fetchQuotaCached(fullAcc.token.access_token);
                        } catch (e: any) {
                            if (e.response && e.response.status === 401) {
                                // 发现 401 自动触发状态栏的刷新逻辑（含 Token 自动刷新）
                                vscode.commands.executeCommand('antigravity-cockpit.refreshStatusBar');
                            }
                        }
                    } else {
                        // 非当前账号：仅读缓存，无缓存保持 null（显示友好提示）
                        quota = AccountManager.getQuotaFromCache(fullAcc.token.access_token);
                    }
                }
                return {
                    ...fullAcc,
                    quota,
                    isCurrent
                };
            }));

            // 通过 postMessage 推送更新数据，前端 JS 动态刷新
            this._panel.webview.postMessage({
                command: 'updateAccounts',
                accounts: accountsDataPhase2
            });
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
                // 仅读缓存
                quota = AccountManager.getQuotaFromCache(fullAcc.token.access_token);
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
                        margin-bottom: 6px;
                        font-weight: 600;
                        font-size: 13px;
                    }
                    .progress-bar {
                        height: 8px;
                        background: rgba(127, 127, 127, 0.2);
                        border-radius: 4px;
                        overflow: hidden;
                        margin-bottom: 6px;
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
                        background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
                        color: white !important;
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

                    /* List View Utilities */
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
                        width: 90px;
                        height: 24px;
                        justify-content: center;
                    }
                    .group-quota-bar {
                        width: 100%;
                        height: 100%;
                        background: rgba(127, 127, 127, 0.15);
                        border-radius: 4px;
                        overflow: hidden;
                        position: relative;
                    }
                    .group-quota-fill {
                        height: 100%;
                        border-radius: 4px;
                        transition: width 0.3s ease;
                    }
                    .group-quota-bar.no-data {
                        border: 1px dashed var(--text-secondary);
                        background: transparent;
                        opacity: 0.4;
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
                        gap: 2px;
                    }
                    .group-card {
                        background: rgba(20, 184, 166, 0.08);
                        border: 1px solid rgba(20, 184, 166, 0.25);
                        border-radius: 8px;
                        padding: 6px 12px;
                        transition: var(--transition);
                        position: relative; /* Ensure it can host z-index */
                    }
                    .group-card.has-open-dropdown {
                        z-index: 100; /* Boost stacking context when dropdown is open */
                        box-shadow: 0 4px 20px rgba(0,0,0,0.2);
                        background: rgba(20, 184, 166, 0.15);
                    }
                    .group-card:hover {
                        border-color: var(--primary-teal);
                        background: rgba(20, 184, 166, 0.12);
                        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
                    }
                    .group-card-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 4px;
                    }
                    .group-name {
                        display: flex;
                        align-items: center;
                        gap: 2px;
                        font-weight: 600;
                    }
                    .group-name-input {
                        background: transparent;
                        border: none;
                        border-bottom: 1px solid transparent;
                        color: var(--text-primary);
                        font-size: 14px;
                        font-weight: 600;
                        padding: 2px 0;
                        width: 200px;
                        transition: border-color 0.2s;
                    }
                    .group-name-input:focus {
                        outline: none;
                        border-bottom-color: var(--primary-blue);
                    }
                    .group-danger {
                        background: transparent;
                        border: none;
                        color: var(--text-secondary);
                        cursor: pointer;
                        font-size: 16px;
                        padding: 4px;
                        border-radius: 4px;
                        transition: var(--transition);
                    }
                    .group-danger:hover {
                        background: rgba(239, 68, 68, 0.1);
                        color: #ef4444;
                    }
                    .model-tags {
                        display: flex;
                        /* flex-wrap: wrap; removed for compactness */
                        gap: 2px;
                        align-items: center;
                    }
                    .model-tag {
                        background: rgba(14, 165, 233, 0.12);
                        color: var(--text-primary);
                        border: 1px solid rgba(14, 165, 233, 0.3);
                        border-radius: 6px;
                        padding: 4px 10px;
                        font-size: 12px;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        transition: var(--transition);
                    }
                    .model-tag:hover {
                        background: rgba(14, 165, 233, 0.2);
                        border-color: var(--primary-blue);
                    }
                    .model-tag-remove {
                        cursor: pointer;
                        opacity: 0.6;
                        font-size: 16px;
                    }
                    .model-tag-remove:hover {
                        opacity: 1;
                        color: #ef4444;
                    }
                    .add-model-btn {
                        background: transparent;
                        border: 1px dashed var(--border-color);
                        color: var(--primary-blue);
                        border-radius: 6px;
                        padding: 4px 10px;
                        font-size: 12px;
                        cursor: pointer;
                        transition: var(--transition);
                    }
                    .add-model-btn:hover {
                        border-color: var(--primary-blue);
                        background: var(--accent-blue);
                    }
                    .model-dropdown {
                        position: relative;
                        display: inline-block;
                    }
                    .model-dropdown-content {
                        display: none;
                        position: fixed;
                        background: var(--vscode-sideBar-background);
                        border: 1px solid var(--border-color);
                        border-radius: 8px;
                        min-width: 220px;
                        max-height: 200px;
                        overflow-y: auto;
                        z-index: 10000;
                        box-shadow: 0 8px 24px rgba(0,0,0,0.4);
                    }
                    .model-dropdown-content.show { display: block; }
                    .model-dropdown-item {
                        padding: 4px 8px;
                        cursor: pointer;
                        font-size: 13px;
                        color: var(--text-primary);
                        transition: background 0.2s;
                    }
                    .model-dropdown-item:hover {
                        background: var(--vscode-list-hoverBackground);
                    }
                    .model-dropdown-item.disabled {
                        opacity: 0.4;
                        cursor: not-allowed;
                    }
                    .empty-state {
                        text-align: center;
                        padding: 60px 24px;
                        color: var(--text-secondary);
                    }
                    .empty-state-icon { font-size: 48px; margin-bottom: 10px; }
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

                <!-- 分组管理弹窗 -->
                <div class="modal-overlay" id="groupModal">
                    <div class="modal">
                        <div class="modal-header">
                            <h2>${t('groupingTab')}</h2>
                            <button class="modal-close" onclick="closeGroupManager()">&times;</button>
                        </div>
                        <div class="modal-body">
                            <div class="action-buttons">
                                <button class="teal" onclick="autoGroup()">${t('autoGroupBtn')}</button>
                                <button class="secondary" onclick="addNewGroup()">${t('addGroupBtn')}</button>
                            </div>
                            
                            <div class="groups-section-title">${t('groupListHeader')}</div>
                            <div class="groups-list" id="groupsList">
                                <!-- 分组列表动态渲染 -->
                            </div>
                        </div>
                        <div class="modal-footer">
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
                        }
                    });

                    // 初始化时获取刷新间隔
                    vscode.postMessage({ command: 'getRefreshInterval' });
                    
                    // 初始化语言选择
                    const languageSelect = document.getElementById('languageSelect');
                    if (languageSelect) {
                        languageSelect.value = initialLanguage;
                    }

                    function switchView(view) {
                        currentView = view;
                        vscode.setState({ ...state, currentView: view, listSortKey, listSortOrder });
                        vscode.postMessage({ command: 'updateUiState', state: { currentView, listSortKey, listSortOrder } });
                        updateViewUI();
                    }

                    function updateViewUI() {
                        const tabContainer = document.getElementById('tabViewContainer');
                        const listContainer = document.getElementById('listViewContainer');
                        const btnTab = document.getElementById('btnViewTab');
                        const btnList = document.getElementById('btnViewList');

                        if (currentView === 'tab') {
                            tabContainer.style.display = 'flex';
                            listContainer.classList.remove('active');
                            btnTab.classList.add('active');
                            btnList.classList.remove('active');
                        } else {
                            tabContainer.style.display = 'none';
                            listContainer.classList.add('active');
                            btnTab.classList.remove('active');
                            btnList.classList.add('active');
                            renderListView();
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
                        if (!acc.quota || acc.quota.is_error) return [];
                        if (!groupsConfig || !groupsConfig.groups) return [];
                        
                        return groupsConfig.groups.map(group => {
                            let minPercentage = 101;
                            let found = false;
                            if (acc.quota && acc.quota.models) {
                                group.models.forEach(modelName => {
                                    const m = acc.quota.models.find(x => x.name === modelName);
                                    if (m) {
                                        minPercentage = Math.min(minPercentage, m.percentage);
                                        found = true;
                                    }
                                });
                            }
                            return found ? minPercentage : -1;
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
                                
                                if (groupsConfig && groupsConfig.groups && groupsConfig.groups.length > 0) {
                                    groupsConfig.groups.forEach((group, index) => {
                                        const groupModels = [];
                                        if (acc.quota && acc.quota.models) {
                                            group.models.forEach(modelName => {
                                                const m = acc.quota.models.find(x => x.name === modelName);
                                                if (m) groupModels.push(m);
                                            });
                                        }
                                        if (groupModels.length > 0) {
                                            groupModels.forEach(m => itemsToRender.push({ model: m }));
                                        }
                                    });
                                } else {
                                    if (acc.quota && acc.quota.models) {
                                        acc.quota.models.forEach(m => itemsToRender.push({ model: m }));
                                    }
                                }

                                if (itemsToRender.length > 0) {
                                    const modelsOnly = itemsToRender.filter(item => item.model).map(item => item.model);
                                    const maxNameWidth = Math.max(...modelsOnly.map(m => getVisualWidth(m.name)), 10);
                                    
                                    itemsToRender.forEach(item => {
                                        if (item.model) {
                                            const m = item.model;
                                            const icon = m.percentage > 50 ? "🟢" : (m.percentage > 20 ? "🟡" : "🔴");
                                            let timeInfo = '';
                                            const rawResetTime = m.reset_time_raw || m.reset_time;
                                            if (rawResetTime) {
                                                const resetDate = new Date(rawResetTime);
                                                const now = new Date();
                                                const diffMs = resetDate.getTime() - now.getTime();
                                                if (diffMs > 0) {
                                                    const h = Math.floor(diffMs / 3600000);
                                                    const min = Math.floor((diffMs % 3600000) / 60000);
                                                    const timeStr = resetDate.toLocaleTimeString(initialLanguage.startsWith('zh') ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                                                    timeInfo = \`\${h}h\${String(min).padStart(2, '0')}m (\${timeStr})\`;
                                                } else {
                                                    timeInfo = msg('reset');
                                                }
                                            }
                                            const paddingSize = Math.max(0, maxNameWidth - getVisualWidth(m.name));
                                            const padding = ' '.repeat(paddingSize);
                                            const pctStr = (m.percentage.toFixed(0) + '%').padStart(4, ' ');
                                            
                                            // 进度条可视化 (类似 statusbar)
                                            const filledBlocks = Math.round(m.percentage / 10);
                                            const emptyBlocks = 10 - filledBlocks;
                                            const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);

                                            allGroupDetails.push(\`\${icon} \${m.name}\${padding} \${progressBar} \${pctStr} → \${timeInfo.padStart(13, ' ')}\`);
                                        }
                                    });
                                } else {
                                    allGroupDetails.push(\`  ( \${msg('noAccount')} )\`);
                                }
                                
                                stackFullTitle = allGroupDetails.join('\\n');

                                // 构建分组条形图 HTML
                                groupQuotasHtml = groupsConfig.groups.map((group, index) => {
                                    let minPercentage = 101;
                                    let found = false;
                                    
                                    if (acc.quota && acc.quota.models) {
                                        group.models.forEach(modelName => {
                                            const m = acc.quota.models.find(x => x.name === modelName);
                                            if (m) {
                                                minPercentage = Math.min(minPercentage, m.percentage);
                                                found = true;
                                            }
                                        });
                                    }

                                    const dotHtml = index === 0 
                                        ? \`<div style="position: absolute; right: 100%; margin-right: 4px; height: 100%; aspect-ratio: 1 / 1; border-radius: 50%; background: #8b5cf6; box-shadow: 0 0 4px rgba(139, 92, 246, 0.5);"></div>\` 
                                        : '';

                                    if (!found) {
                                        return \`
                                            <div style="position: relative; flex-grow: 1; display: flex; align-items: stretch; min-height: 2px; max-height: 6px; width: 100%;">
                                                \${dotHtml}
                                                <div class="group-quota-bar no-data"></div>
                                            </div>
                                        \`;
                                    }

                                    let color = '#4ade80';
                                    if (minPercentage <= 20) color = '#f87171';
                                    else if (minPercentage <= 50) color = '#fbbf24';

                                    return \`
                                        <div style="position: relative; flex-grow: 1; display: flex; align-items: stretch; min-height: 2px; max-height: 6px; width: 100%;">
                                            \${dotHtml}
                                            <div class="group-quota-bar">
                                                <div class="group-quota-fill" style="width: \${minPercentage}%; background: \${color}"></div>
                                            </div>
                                        </div>
                                    \`;
                                }).join('');
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
                                quotaHtml = '<div class="quota-grid">' + acc.quota.models.map(m => {
                                    // 更智能的颜色策略
                                    let color = '#4ade80'; // 绿色 (足够)
                                    if (m.percentage <= 20) color = '#f87171'; // 红色 (告急)
                                    else if (m.percentage <= 50) color = '#fbbf24'; // 黄色 (注意)

                                    return \`
                                        <div class="quota-card">
                                            <div class="quota-header">
                                                <span>\${m.name}</span>
                                                <span style="color: \${color}">\${m.percentage}%</span>
                                            </div>
                                            <div class="progress-bar">
                                                <div class="progress-fill" style="width: \${m.percentage}%; background: \${color}; box-shadow: 0 0 10px \${color}44"></div>
                                            </div>
                                            <div class="quota-meta">
                                                <span>\${msg('reset')}</span>
                                                <span>\${m.reset_time || '-'}</span>
                                            </div>
                                        </div>
                                    \`;
                                }).join('') + '</div>';
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

// 渲染分组列表
function renderGroupsList() {
    const container = document.getElementById('groupsList');
    const allModels = getAllModels();
    const groupedModels = getGroupedModels();

    if (groupsConfig.groups.length === 0) {
        container.innerHTML = \`
                                <div class="empty-state">
                                    <div class="empty-state-icon"></div>
                                    <p>\${msg('noAccount')}</p>
                                </div>
                            \`;
                            return;
                        }
                        
                        container.innerHTML = groupsConfig.groups.map((group, index) => \`
                            <div class="group-card" data-group-id="\${group.id}">
                                <div class="group-card-header">
                                    <div class="group-name">
                                        <input type="text" class="group-name-input" value="\${group.name}" 
                                            onchange="updateGroupName('\${group.id}', this.value)" 
                                            onclick="event.stopPropagation()">
                                    </div>
                                    <button class="group-danger" onclick="deleteGroup('\${group.id}')" title="\${msg('deleteBtn')}">\${msg('deleteBtn')}</button>
                                </div>
                                <div class="model-tags">
                                    \${group.models.map(modelName => \`
                                        <div class="model-tag">
                                            <span>\${modelName}</span>
                                            <span class="model-tag-remove" onclick="removeModelFromGroup('\${group.id}', '\${modelName}')">&times;</span>
                                        </div>
                                    \`).join('')}
                                    <div class="model-dropdown">
                                        <button class="add-model-btn" onclick="toggleModelDropdown('\${group.id}', event)">\${msg('addModelBtn')}</button>
                                        <div class="model-dropdown-content" id="dropdown-\${group.id}">
                                            \${allModels.filter(m => !group.models.includes(m.name)).map(m => \`
                                                <div class="model-dropdown-item \${groupedModels.has(m.name) && !group.models.includes(m.name) ? 'disabled' : ''}" 
                                                    onclick="\${groupedModels.has(m.name) && !group.models.includes(m.name) ? '' : \`addModelToGroup('\${group.id}', '\${m.name}')\`}">
                                                    \${m.name}
                                                    \${groupedModels.has(m.name) ? ' (已在其他分组)' : ''}
                                                </div>
                                            \`).join('')}
                                            \${allModels.filter(m => !group.models.includes(m.name)).length === 0 ? '<div class="model-dropdown-item" style="opacity: 0.5">没有可添加的模型</div>' : ''}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        \`).join('');
                    }

                    // 切换模型下拉框
                    function toggleModelDropdown(groupId, event) {
                        event.stopPropagation();
                        const btn = event.currentTarget;
                        const dropdown = document.getElementById('dropdown-' + groupId);
                        const card = btn.closest('.group-card');
                        
                        // 关闭其他下拉框
                        document.querySelectorAll('.model-dropdown-content').forEach(d => {
                            if (d.id !== 'dropdown-' + groupId) {
                                d.classList.remove('show');
                                if (d.closest('.group-card')) d.closest('.group-card').classList.remove('has-open-dropdown');
                            }
                        });
                        
                        const isShowing = dropdown.classList.contains('show');
                        if (!isShowing) {
                            // 计算位置
                            const rect = btn.getBoundingClientRect();
                            const dropdownWidth = 220; // 与 CSS 保持一致
                            const dropdownMaxHeight = 200;
                            
                            // 优先右对齐（按钮通常在右侧）
                            let left = rect.right - dropdownWidth;
                            // 如果左侧超出屏幕，则左对齐
                            if (left < 10) left = rect.left;
                            
                            // 智能判断上下弹出
                            const spaceBelow = window.innerHeight - rect.bottom;
                            const spaceAbove = rect.top;
                            
                            if (spaceBelow < dropdownMaxHeight && spaceAbove > spaceBelow) {
                                // 向上弹出 (计算实际高度，如果内容没那么多则贴合)
                                dropdown.style.display = 'block'; // 暂时显示以测量高度
                                const actualHeight = Math.min(dropdown.scrollHeight, dropdownMaxHeight);
                                dropdown.style.display = ''; // 清除内联样式，让 .show 类生效
                                dropdown.style.top = (rect.top - actualHeight - 4) + 'px';
                            } else {
                                // 向下弹出
                                dropdown.style.top = (rect.bottom + 4) + 'px';
                                dropdown.style.display = ''; // 确保清除可能残余的内联样式
                            }
                            
                            dropdown.style.left = left + 'px';
                            card.classList.add('has-open-dropdown');
                            dropdown.classList.add('show');
                        } else {
                            card.classList.remove('has-open-dropdown');
                            dropdown.classList.remove('show');
                        }
                        
                        activeDropdownId = dropdown.classList.contains('show') ? groupId : null;
                    }

                    // 点击其他地方关闭下拉框
                    document.addEventListener('click', () => {
                        document.querySelectorAll('.model-dropdown-content').forEach(d => {
                            d.classList.remove('show');
                        });
                        document.querySelectorAll('.group-card').forEach(c => {
                            c.classList.remove('has-open-dropdown');
                        });
                        activeDropdownId = null;
                    });

                    // 滚动时关闭下拉框，防止 fixed 定位的菜单跟随滚动脱离原位
                    document.querySelector('.modal-body').addEventListener('scroll', () => {
                        if (activeDropdownId) {
                            document.querySelectorAll('.model-dropdown-content').forEach(d => {
                                d.classList.remove('show');
                            });
                            document.querySelectorAll('.group-card').forEach(c => {
                                c.classList.remove('has-open-dropdown');
                            });
                            activeDropdownId = null;
                        }
                    });

                    // 打开分组管理弹窗
                    function openGroupManager() {
                        document.getElementById('groupModal').classList.add('active');
                        renderGroupsList();
                    }

                    // 关闭分组管理弹窗
                    function closeGroupManager() {
                        document.getElementById('groupModal').classList.remove('active');
                    }

                    // 自动分组
                    function autoGroup() {
                        const models = getAllModels();
                        vscode.postMessage({ command: 'autoGroup', models: models });
                    }

                    // 添加新分组
                    function addNewGroup() {
                        vscode.postMessage({ command: 'addGroup', groupName: msg('newGroup') });
                    }

                    // 删除分组
                    function deleteGroup(groupId) {
                        vscode.postMessage({ command: 'deleteGroup', groupId: groupId });
                    }

                    // 更新分组名称
                    function updateGroupName(groupId, newName) {
                        vscode.postMessage({ command: 'updateGroupName', groupId: groupId, newName: newName });
                    }

                    // 向分组添加模型
                    function addModelToGroup(groupId, modelName) {
                        vscode.postMessage({ command: 'addModelToGroup', groupId: groupId, modelName: modelName });
                    }

                    // 从分组移除模型
                    function removeModelFromGroup(groupId, modelName) {
                        vscode.postMessage({ command: 'removeModelFromGroup', groupId: groupId, modelName: modelName });
                    }

                    // 保存分组
                    function saveGroups() {
                        vscode.postMessage({ command: 'saveGroups', config: groupsConfig });
                        closeGroupManager();
                    }

                    // 接收来自扩展的消息
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'groupsConfig') {
                            groupsConfig = message.config;
                            renderGroupsList();
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
