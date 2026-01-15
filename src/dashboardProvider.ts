import * as vscode from 'vscode';
import { AccountManager, Account } from './accountManager';
import { ModelGroupManager, ModelGroup, ModelGroupsConfig, ModelInfo } from './modelGroupManager';

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
            'Antigravity 账号中心',
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

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._update();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async message => {
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
                        vscode.window.showInformationMessage('分组配置已保存');
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
        this._panel.webview.html = await this._getHtmlForWebview();
    }

    private async _getHtmlForWebview() {
        const index = AccountManager.loadIndex();
        const groupsConfig = ModelGroupManager.loadGroups();
        const accountsData = await Promise.all(index.accounts.map(async acc => {
            const fullAcc = AccountManager.loadAccount(acc.id);
            let quota = null;
            if (fullAcc.token) {
                try {
                    quota = await AccountManager.fetchQuota(fullAcc.token.access_token);
                } catch (e) { }
            }
            return {
                ...fullAcc,
                quota,
                isCurrent: acc.id === index.current_account_id
            };
        }));

        const accountsJson = JSON.stringify(accountsData);
        const groupsJson = JSON.stringify(groupsConfig);

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Antigravity Cockpit</title>
                <style>
                    :root {
                        --primary-purple: #8b5cf6;
                        --primary-purple-hover: #7c3aed;
                        --primary-blue: #0ea5e9;
                        --primary-blue-hover: #0284c7;
                        --primary-teal: #14b8a6;
                        --primary-teal-hover: #0d9488;
                        --bg-modal: rgba(0, 0, 0, 0.4);
                        --bg-card: #ffffff;
                        --bg-input: #f8fafc;
                        --border-color: #e2e8f0;
                        --text-primary: #1e293b;
                        --text-secondary: #64748b;
                        --accent-light: #f0f9ff;
                        --accent-purple-light: #faf5ff;
                    }
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                        padding: 20px;
                        color: var(--vscode-editor-foreground);
                        background-color: var(--vscode-editor-background);
                    }
                    .header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 20px;
                        border-bottom: 1px solid var(--vscode-widget-border);
                        padding-bottom: 10px;
                    }
                    .tabs {
                        display: flex;
                        gap: 10px;
                        margin-bottom: 20px;
                        overflow-x: auto;
                        padding-bottom: 5px;
                    }
                    .tab {
                        padding: 8px 16px;
                        cursor: pointer;
                        border-radius: 4px;
                        background: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                        white-space: nowrap;
                    }
                    .tab.active {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                    }
                    .account-panel {
                        display: none;
                        border: 1px solid var(--vscode-widget-border);
                        border-radius: 8px;
                        padding: 20px;
                        background: var(--vscode-sideBar-background);
                        position: relative;
                    }
                    .account-panel.active {
                        display: block;
                    }
                    .panel-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: flex-start;
                        margin-bottom: 20px;
                    }
                    .account-info h2 {
                        margin: 0;
                        font-size: 1.5em;
                    }
                    .account-info p {
                        margin: 5px 0 0 0;
                        opacity: 0.8;
                    }
                    .quota-grid {
                        display: grid;
                        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
                        gap: 15px;
                        margin-top: 20px;
                    }
                    .quota-card {
                        padding: 15px;
                        border-radius: 6px;
                        background: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-widget-border);
                    }
                    .quota-header {
                        display: flex;
                        justify-content: space-between;
                        margin-bottom: 10px;
                        font-weight: bold;
                    }
                    .progress-bar {
                        height: 6px;
                        background: #444;
                        border-radius: 3px;
                        overflow: hidden;
                    }
                    .progress-fill {
                        height: 100%;
                    }
                    .btn-group {
                        display: flex;
                        gap: 8px;
                        flex-wrap: wrap;
                    }
                    button {
                        padding: 6px 12px;
                        cursor: pointer;
                        border: none;
                        border-radius: 4px;
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        font-size: 12px;
                        transition: all 0.2s ease;
                    }
                    button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
                    button:disabled {
                        opacity: 0.5;
                        cursor: not-allowed;
                    }
                    button.secondary {
                        background: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                    }
                    button.purple {
                        background: var(--primary-purple);
                        color: white;
                    }
                    button.purple:hover {
                        background: var(--primary-purple-hover);
                    }
                    button.blue {
                        background: var(--primary-blue);
                        color: white;
                    }
                    button.blue:hover {
                        background: var(--primary-blue-hover);
                    }
                    .badge {
                        font-size: 10px;
                        padding: 2px 6px;
                        border-radius: 10px;
                        background: #4ade80;
                        color: black;
                        margin-left: 5px;
                    }

                    /* 分组管理弹窗样式 */
                    .modal-overlay {
                        display: none;
                        position: fixed;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        background: var(--bg-modal);
                        z-index: 1000;
                        justify-content: center;
                        align-items: center;
                        backdrop-filter: blur(4px);
                    }
                    .modal-overlay.active {
                        display: flex;
                    }
                    .modal {
                        background: var(--bg-card);
                        border-radius: 8px;
                        width: 90%;
                        max-width: 640px;
                        max-height: 80vh;
                        overflow: hidden;
                        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
                        animation: modalSlideIn 0.2s ease;
                        display: flex;
                        flex-direction: column;
                    }
                    @keyframes modalSlideIn {
                        from {
                            opacity: 0;
                            transform: translateY(-10px);
                        }
                        to {
                            opacity: 1;
                            transform: translateY(0);
                        }
                    }
                    .modal-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        padding: 12px 16px;
                        border-bottom: 1px solid var(--border-color);
                        background: var(--bg-input);
                        flex-shrink: 0;
                    }
                    .modal-header h2 {
                        margin: 0;
                        font-size: 14px;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        color: var(--text-primary);
                        font-weight: 600;
                    }
                    .modal-close {
                        background: transparent;
                        border: none;
                        font-size: 18px;
                        cursor: pointer;
                        color: var(--text-secondary);
                        padding: 2px 6px;
                        line-height: 1;
                        border-radius: 4px;
                    }
                    .modal-close:hover {
                        color: var(--text-primary);
                        background: rgba(0,0,0,0.05);
                    }
                    .modal-body {
                        padding: 12px 16px;
                        overflow-y: auto;
                        background: var(--bg-card);
                        color: var(--text-primary);
                        flex: 1;
                        min-height: 0;
                    }
                    .modal-footer {
                        display: flex;
                        justify-content: flex-end;
                        gap: 8px;
                        padding: 10px 16px;
                        border-top: 1px solid var(--border-color);
                        background: var(--bg-input);
                        flex-shrink: 0;
                    }
                    
                    /* 提示信息 */
                    .info-tip {
                        background: #f0f9ff;
                        border: 1px solid #bae6fd;
                        border-radius: 6px;
                        padding: 8px 12px;
                        margin-bottom: 12px;
                        font-size: 12px;
                        color: #0369a1;
                        display: flex;
                        align-items: flex-start;
                        gap: 6px;
                        line-height: 1.4;
                    }
                    .info-tip::before {
                        content: "💡";
                        font-size: 12px;
                    }
                    
                    /* 操作按钮组 */
                    .action-buttons {
                        display: flex;
                        gap: 8px;
                        margin-bottom: 12px;
                    }
                    
                    /* 分组列表 */
                    .groups-section-title {
                        font-size: 12px;
                        font-weight: 600;
                        margin-bottom: 8px;
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        color: var(--text-secondary);
                    }
                    .groups-section-title::before {
                        content: "📁";
                        font-size: 12px;
                    }
                    .groups-list {
                        display: flex;
                        flex-direction: column;
                        gap: 10px;
                    }
                    .group-card {
                        background: var(--bg-input);
                        border: 1px dashed #cbd5e1;
                        border-radius: 6px;
                        padding: 10px 12px;
                        position: relative;
                    }
                    .group-card:hover {
                        border-color: var(--primary-blue);
                    }
                    .group-card-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 8px;
                    }
                    .group-name {
                        font-weight: 600;
                        font-size: 13px;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        color: var(--text-primary);
                    }
                    .group-name::before {
                        content: "📁";
                        font-size: 12px;
                    }
                    .group-name-input {
                        background: transparent;
                        border: none;
                        border-bottom: 1px solid var(--border-color);
                        color: var(--text-primary);
                        font-size: 13px;
                        font-weight: 600;
                        padding: 2px 4px;
                        width: 140px;
                    }
                    .group-name-input:focus {
                        outline: none;
                        border-bottom-color: var(--primary-blue);
                    }
                    .group-delete-btn {
                        background: transparent;
                        border: none;
                        color: var(--text-secondary);
                        cursor: pointer;
                        padding: 2px 4px;
                        font-size: 14px;
                        opacity: 0.5;
                        border-radius: 4px;
                    }
                    .group-delete-btn:hover {
                        opacity: 1;
                        color: #ef4444;
                        background: #fef2f2;
                    }
                    
                    /* 模型标签 */
                    .model-tags {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 6px;
                        align-items: center;
                    }
                    .model-tag {
                        background: #e0f2fe;
                        border: 1px solid #7dd3fc;
                        border-radius: 4px;
                        padding: 4px 8px;
                        font-size: 11px;
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        color: #0369a1;
                    }
                    .model-tag:hover {
                        background: #bae6fd;
                    }
                    .model-tag-remove {
                        cursor: pointer;
                        opacity: 0.5;
                        font-size: 12px;
                        line-height: 1;
                    }
                    .model-tag-remove:hover {
                        opacity: 1;
                        color: #ef4444;
                    }
                    .add-model-btn {
                        background: white;
                        border: 1px dashed #94a3b8;
                        border-radius: 4px;
                        padding: 4px 8px;
                        font-size: 11px;
                        color: var(--primary-blue);
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        gap: 2px;
                    }
                    .add-model-btn:hover {
                        border-color: var(--primary-blue);
                        background: var(--accent-light);
                    }
                    
                    /* 模型选择下拉 */
                    .model-dropdown {
                        position: relative;
                        display: inline-block;
                    }
                    .model-dropdown-content {
                        display: none;
                        position: absolute;
                        top: 100%;
                        left: 0;
                        background: white;
                        border: 1px solid var(--border-color);
                        border-radius: 6px;
                        min-width: 180px;
                        max-height: 180px;
                        overflow-y: auto;
                        z-index: 100;
                        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
                        margin-top: 2px;
                    }
                    .model-dropdown-content.show {
                        display: block;
                    }
                    .model-dropdown-item {
                        padding: 6px 10px;
                        cursor: pointer;
                        font-size: 11px;
                        color: var(--text-primary);
                    }
                    .model-dropdown-item:hover {
                        background: var(--accent-light);
                    }
                    .model-dropdown-item.disabled {
                        opacity: 0.4;
                        cursor: not-allowed;
                        color: var(--text-secondary);
                    }
                    
                    /* 空状态 */
                    .empty-state {
                        text-align: center;
                        padding: 30px 16px;
                        color: var(--text-secondary);
                    }
                    .empty-state-icon {
                        font-size: 40px;
                        margin-bottom: 8px;
                    }
                    .empty-state p {
                        font-size: 12px;
                        margin: 0;
                    }
                </style>
                <style>
                    /* 列表视图样式 */
                    .view-toggle {
                        display: flex;
                        background: var(--vscode-button-secondaryBackground);
                        border-radius: 4px;
                        padding: 2px;
                        margin-right: 15px;
                    }
                    .view-toggle-btn {
                        padding: 4px 12px;
                        cursor: pointer;
                        border-radius: 3px;
                        font-size: 12px;
                        color: var(--vscode-button-secondaryForeground);
                        transition: all 0.2s;
                    }
                    .view-toggle-btn.active {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                    }
                    .list-view {
                        display: none;
                        width: 100%;
                    }
                    .list-view.active {
                        display: block;
                    }
                    .account-table {
                        width: 100%;
                        border-collapse: collapse;
                        font-size: 13px;
                        background: var(--vscode-editor-background);
                        border-radius: 8px;
                        overflow: hidden;
                        border: 1px solid var(--vscode-widget-border);
                    }
                    .account-table th {
                        text-align: left;
                        padding: 12px;
                        background: var(--vscode-editor-group-header-tabsBackground);
                        border-bottom: 1px solid var(--vscode-widget-border);
                        font-weight: 600;
                        color: var(--text-secondary);
                    }
                    .account-table td {
                        padding: 12px;
                        border-bottom: 1px solid var(--vscode-widget-border);
                        vertical-align: middle;
                    }
                    .account-table tr:last-child td {
                        border-bottom: none;
                    }
                    .account-table tr:hover {
                        background: rgba(127, 127, 127, 0.05);
                    }
                    .account-table tr.current-account {
                        background: rgba(74, 222, 128, 0.05);
                    }
                    .status-dot {
                        display: inline-block;
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        margin-right: 8px;
                    }
                    .status-dot.active {
                        background: #4ade80;
                        box-shadow: 0 0 4px #4ade80;
                    }
                    .status-dot.inactive {
                        background: #94a3b8;
                    }
                    .delete-btn {
                        color: #ef4444 !important;
                        background: rgba(239, 68, 68, 0.1) !important;
                        border: 1px solid rgba(239, 68, 68, 0.2) !important;
                    }
                    .delete-btn:hover {
                        background: rgba(239, 68, 68, 0.2) !important;
                        opacity: 1;
                    }
                    .danger-zone {
                        margin-top: 30px;
                        padding-top: 20px;
                        border-top: 1px solid var(--border-color);
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <div style="display:flex;align-items:center;gap:20px;">
                        <h1>Antigravity 账号中心</h1>
                        <div class="view-toggle">
                            <div class="view-toggle-btn active" id="btnViewTab" onclick="switchView('tab')">卡片视图</div>
                            <div class="view-toggle-btn" id="btnViewList" onclick="switchView('list')">列表视图</div>
                        </div>
                    </div>
                    <div class="btn-group">
                        <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-secondary);">
                            刷新间隔:
                            <select id="refreshIntervalSelect" onchange="updateRefreshInterval()" style="padding:2px 4px;font-size:11px;border-radius:4px;border:1px solid var(--vscode-widget-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);">
                                <option value="1">1分钟</option>
                                <option value="2">2分钟</option>
                                <option value="5">5分钟</option>
                                <option value="10">10分钟</option>
                                <option value="15">15分钟</option>
                                <option value="30">30分钟</option>
                                <option value="60">60分钟</option>
                            </select>
                        </label>
                        <button class="purple" onclick="openGroupManager()">⚙️ 分组管理</button>
                        <button onclick="addAccount()">+ 添加新账号</button>
                        <button class="secondary" onclick="refreshAll()">刷新所有账号</button>
                    </div>
                </div>
                
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
                                <th style="width: 50px;">状态</th>
                                <th>账号 (Email)</th>
                                <th>姓名</th>
                                <th>订阅层级</th>
                                <th>上次使用</th>
                                <th style="text-align: right;">操作</th>
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
                            <h2>⚙️ 分组管理</h2>
                            <button class="modal-close" onclick="closeGroupManager()">&times;</button>
                        </div>
                        <div class="modal-body">
                            <div class="action-buttons">
                                <button class="purple" onclick="autoGroup()">🪄 自动分组</button>
                                <button class="secondary" onclick="addNewGroup()">+ 添加分组</button>
                            </div>
                            
                            <div class="groups-section-title">分组列表</div>
                            <div class="groups-list" id="groupsList">
                                <!-- 分组列表动态渲染 -->
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button class="secondary" onclick="closeGroupManager()">取消</button>
                            <button class="blue" onclick="saveGroups()">💾 保存分组</button>
                        </div>
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    const state = vscode.getState() || {};
                    let currentView = state.currentView || 'tab';
                    const accounts = ${accountsJson};
                    let groupsConfig = ${groupsJson};
                    
                    // 优先使用 state 中的 activeAccountId，防止刷新后跳变
                    let activeAccountId = state.activeAccountId;
                    // 验证 ID 是否依然有效 (防止账号被删除后停留在无效 ID)
                    if (!activeAccountId || !accounts.find(a => a.id === activeAccountId)) {
                        activeAccountId = accounts.find(a => a.isCurrent)?.id || accounts[0]?.id;
                    }

                    let activeDropdownId = null;

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

                    // 监听来自扩展的消息
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'groupsConfig') {
                            groupsConfig = message.config;
                            renderGroupsList(); // Fix: function name was renderGroups in previous snippet, ensuring consistent naming
                        } else if (message.command === 'refreshIntervalValue') {
                            const select = document.getElementById('refreshIntervalSelect');
                            if (select) {
                                select.value = message.value.toString();
                            }
                        }
                    });

                    // 初始化时获取刷新间隔
                    vscode.postMessage({ command: 'getRefreshInterval' });

                    function switchView(view) {
                        currentView = view;
                        vscode.setState({ ...state, currentView: view });
                        updateViewUI();
                    }

                    function updateViewUI() {
                        const tabContainer = document.getElementById('tabViewContainer');
                        const listContainer = document.getElementById('listViewContainer');
                        const btnTab = document.getElementById('btnViewTab');
                        const btnList = document.getElementById('btnViewList');

                        if (currentView === 'tab') {
                            tabContainer.style.display = 'block';
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

                    function renderListView() {
                        const tbody = document.getElementById('accountTableBody');
                        tbody.innerHTML = '';

                        if (accounts.length === 0) {
                            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px;">暂无账号，请点击右上角添加。</td></tr>';
                            return;
                        }

                        accounts.forEach(acc => {
                            const tr = document.createElement('tr');
                            if (acc.isCurrent) tr.className = 'current-account';

                            const lastUsedDate = new Date(acc.last_used);
                            const lastUsedStr = lastUsedDate.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                            
                            const statusDotClass = acc.isCurrent ? 'active' : 'inactive';
                            const statusTitle = acc.isCurrent ? '当前激活' : '未激活';

                            const subTier = (acc.quota && acc.quota.tier) ? acc.quota.tier : '-';

                            tr.innerHTML = \`
                                <td><span class="status-dot \${statusDotClass}" title="\${statusTitle}"></span></td>
                                <td>\${acc.email}</td>
                                <td>\${acc.name || '-'}</td>
                                <td><span class="badge" style="background:#e0f2fe;color:#0369a1;border:1px solid #7dd3fc;">\${subTier}</span></td>
                                <td style="color:var(--text-secondary);font-size:12px;">\${lastUsedStr}</td>
                                <td style="text-align: right;">
                                    <div class="btn-group" style="justify-content: flex-end;">
                                        \${!acc.isCurrent ? \`<button class="purple" onclick="switchAccount('\${acc.id}', '\${acc.email}')">切换</button>\` : '<span style="font-size:12px;color:#4ade80;margin-right:10px;">当前使用中</span>'}
                                        <button class="secondary" onclick="refreshAccount('\${acc.id}')">刷新</button>
                                        <button class="delete-btn" onclick="deleteAccount('\${acc.id}', '\${acc.email}')">删除</button>
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
                        
                        // Render Tabs View
                        accounts.forEach(acc => {
                            const tab = document.createElement('div');
                            tab.className = 'tab' + (acc.id === activeAccountId ? ' active' : '');
                            tab.innerHTML = acc.email.split('@')[0] + (acc.isCurrent ? '<span class="badge">当前激活</span>' : '');
                            tab.onclick = () => {
                                activeAccountId = acc.id;
                                vscode.setState({ activeAccountId: activeAccountId });
                                render();
                            };
                            tabContainer.appendChild(tab);

                            const panel = document.createElement('div');
                            panel.className = 'account-panel' + (acc.id === activeAccountId ? ' active' : '');
                            
                            let quotaHtml = '';
                            if (acc.quota && !acc.quota.is_forbidden) {
                                quotaHtml = '<div class="quota-grid">' + acc.quota.models.map(m => {
                                    const color = m.percentage > 50 ? '#4ade80' : (m.percentage > 20 ? '#fbbf24' : '#f87171');
                                    return \`
                                        <div class="quota-card">
                                            <div class="quota-header">
                                                <span>\${m.name}</span>
                                                <span style="color: \${color}">\${m.percentage}%</span>
                                            </div>
                                            <div class="progress-bar">
                                                <div class="progress-fill" style="width: \${m.percentage}%; background: \${color}"></div>
                                            </div>
                                            <div style="font-size: 10px; margin-top: 5px; color: #888">重置时间: \${m.reset_time || '未知'}</div>
                                        </div>
                                    \`;
                                }).join('') + '</div>';
                            } else {
                                quotaHtml = '<p style="color: #f87171">暂无配额数据 (无权限或网络错误)</p>';
                            }

                            panel.innerHTML = \`
                                <div class="panel-header">
                                    <div class="account-info">
                                        <h2>\${acc.name}</h2>
                                        <p>\${acc.email}</p>
                                        \${acc.quota?.tier ? '<p style="font-size: 12px"><b>订阅级别:</b> ' + acc.quota.tier + '</p>' : ''}
                                    </div>
                                    <div class="btn-group">
                                        <button class="secondary" onclick="refreshAccount('\${acc.id}')">刷新此账号</button>
                                        <button onclick="switchAccount('\${acc.id}', '\${acc.email}')" \${acc.isCurrent ? 'disabled' : ''}>\${acc.isCurrent ? '已是当前账号' : '切换到此账号'}</button>
                                    </div>
                                </div>
                                \${quotaHtml}
                                <div class="danger-zone">
                                    <button class="delete-btn" onclick="deleteAccount('\${acc.id}', '\${acc.email}')">删除此账号</button>
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
                                    <div class="empty-state-icon">📂</div>
                                    <p>暂无分组，点击"自动分组"或"添加分组"开始管理</p>
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
                                    <button class="group-delete-btn" onclick="deleteGroup('\${group.id}')" title="删除分组">🗑️</button>
                                </div>
                                <div class="model-tags">
                                    \${group.models.map(modelName => \`
                                        <div class="model-tag">
                                            <span>\${modelName}</span>
                                            <span class="model-tag-remove" onclick="removeModelFromGroup('\${group.id}', '\${modelName}')">&times;</span>
                                        </div>
                                    \`).join('')}
                                    <div class="model-dropdown">
                                        <button class="add-model-btn" onclick="toggleModelDropdown('\${group.id}', event)">+ 添加模型</button>
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
                        const dropdown = document.getElementById('dropdown-' + groupId);
                        
                        // 关闭其他下拉框
                        document.querySelectorAll('.model-dropdown-content').forEach(d => {
                            if (d.id !== 'dropdown-' + groupId) {
                                d.classList.remove('show');
                            }
                        });
                        
                        dropdown.classList.toggle('show');
                        activeDropdownId = dropdown.classList.contains('show') ? groupId : null;
                    }

                    // 点击其他地方关闭下拉框
                    document.addEventListener('click', () => {
                        document.querySelectorAll('.model-dropdown-content').forEach(d => {
                            d.classList.remove('show');
                        });
                        activeDropdownId = null;
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
                        vscode.postMessage({ command: 'addGroup', groupName: '新分组' });
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
                    function refreshAccount(id) {
                        vscode.postMessage({ command: 'refresh', accountId: id });
                    }
                    function refreshAll() {
                        vscode.postMessage({ command: 'refreshAll' });
                    }
                    function addAccount() {
                        vscode.postMessage({ command: 'addAccount' });
                    }

                    render();
                </script>
            </body>
            </html>`;
    }
}
