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
                        gap: 2px;
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
                        gap: 2px;
                        /* flex-wrap: wrap; removed for compactness */
                    }

                    /* Tabs */
                    .tabs {
                        display: flex;
                        gap: 6px;
                        margin-bottom: 6px;
                        overflow-x: auto;
                        padding: 4px 0;
                        scrollbar-width: none;
                        -ms-overflow-style: none;
                    }
                    .tabs::-webkit-scrollbar { display: none; }
                    .tab {
                        padding: 6px 16px;
                        cursor: pointer;
                        border-radius: 20px;
                        background: linear-gradient(135deg, rgba(14, 165, 233, 0.15) 0%, rgba(20, 184, 166, 0.15) 100%);
                        color: var(--text-primary);
                        white-space: nowrap;
                        font-size: 13px;
                        font-weight: 500;
                        border: 1px solid rgba(14, 165, 233, 0.2);
                        transition: var(--transition);
                    }
                    .tab:hover {
                        background: linear-gradient(135deg, rgba(14, 165, 233, 0.25) 0%, rgba(20, 184, 166, 0.25) 100%);
                        border-color: rgba(14, 165, 233, 0.4);
                        transform: translateY(-1px);
                    }
                    .tab.active {
                        background: linear-gradient(135deg, #0ea5e9 0%, #14b8a6 100%);
                        color: white;
                        border-color: transparent;
                        box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3);
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
                    .account-info p {
                        margin: 4px 0 0 0;
                        color: var(--text-secondary);
                        font-size: 13px;
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
                        flex-wrap: nowrap;
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
                    button.danger {
                        background: #fee2e2;
                        color: #dc2626 !important;
                        border: 1px solid #fecaca;
                    }
                    button.danger:hover {
                        background: #fecaca;
                        border-color: #fca5a5;
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
                        overflow: hidden;
                        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
                        display: flex;
                        flex-direction: column;
                    }
                    .modal-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        padding: 8px 12px;
                        background: var(--vscode-editor-group-header-tabsBackground);
                        border-bottom: 1px solid var(--border-color);
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
                        padding: 8px;
                        overflow-y: auto;
                        flex: 1;
                    }
                    .modal-footer {
                        padding: 10px 12px;
                        background: var(--vscode-editor-group-header-tabsBackground);
                        border-top: 1px solid var(--border-color);
                        display: flex;
                        justify-content: flex-end;
                        gap: 8px;
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
                        position: absolute;
                        bottom: 100%;
                        left: 0;
                        background: var(--vscode-sideBar-background);
                        border: 1px solid var(--border-color);
                        border-radius: 12px;
                        min-width: 200px;
                        max-height: 240px;
                        overflow-y: auto;
                        z-index: 1001;
                        box-shadow: 0 10px 30px rgba(0,0,0,0.3);
                        margin-bottom: 6px;
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
                            <h1>Antigravity Cockpit</h1>
                        </div>
                        <div class="view-toggle">
                            <div class="view-toggle-btn active" id="btnViewTab" onclick="switchView('tab')">卡片视图</div>
                            <div class="view-toggle-btn" id="btnViewList" onclick="switchView('list')">列表视图</div>
                        </div>
                    </div>
                    
                    <div class="header-bottom-row">
                        <div class="header-actions">
                            <button class="teal" onclick="openGroupManager()">分组管理</button>
                            <button class="blue" onclick="addAccount()">添加账号</button>
                            <button class="secondary" onclick="refreshAll()">刷新所有</button>
                        </div>
                        <div class="header-actions">
                            <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-secondary);">
                                间隔:
                                <select id="refreshIntervalSelect" onchange="updateRefreshInterval()" style="padding:4px 8px;font-size:12px;border-radius:6px;border:1px solid var(--border-color);background:var(--vscode-input-background);color:var(--vscode-input-foreground);outline:none;">
                                    <option value="1">1分钟</option>
                                    <option value="2">2分钟</option>
                                    <option value="5">5分钟</option>
                                    <option value="10">10分钟</option>
                                    <option value="15">15分钟</option>
                                    <option value="30">30分钟</option>
                                    <option value="60">60分钟</option>
                                </select>
                            </label>
                        </div>
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
                                <th style="width: 24px;">#</th>
                                <th>账号 (Email)</th>
                                <th>姓名</th>
                                <th>层级</th>
                                <th>最后活跃</th>
                                <th style="text-align: right; width: 140px;">操作</th>
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
                            <h2>分组管理</h2>
                            <button class="modal-close" onclick="closeGroupManager()">&times;</button>
                        </div>
                        <div class="modal-body">
                            <div class="action-buttons">
                                <button class="teal" onclick="autoGroup()">自动分组</button>
                                <button class="secondary" onclick="addNewGroup()">添加分组</button>
                            </div>
                            
                            <div class="groups-section-title">分组列表</div>
                            <div class="groups-list" id="groupsList">
                                <!-- 分组列表动态渲染 -->
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button class="secondary" onclick="closeGroupManager()">取消</button>
                            <button class="blue" onclick="saveGroups()">保存分组</button>
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
                                        \${!acc.isCurrent ? \`<button class="teal" onclick="switchAccount('\${acc.id}', '\${acc.email}')">切换</button>\` : '<span style="font-size:12px;color:#4ade80;margin-right:10px;">使用中</span>'}
                                        <button class="secondary" onclick="refreshAccount('\${acc.id}')">刷新</button>
                                        <button class="danger" onclick="deleteAccount('\${acc.id}', '\${acc.email}')">删除</button>
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
                            const shortEmail = acc.email.split('@')[0];
                            tab.innerHTML = \`<span>\${shortEmail}</span>\${acc.isCurrent ? '<span class="badge">ACTIVE</span>' : ''}\`;
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
                                                <span>重置时间</span>
                                                <span>\${m.reset_time || '未知'}</span>
                                            </div>
                                        </div>
                                    \`;
                                }).join('') + '</div>';
                            } else {
                                quotaHtml = \`
                                    <div style="text-align:center; padding: 20px; background: rgba(248, 113, 113, 0.05); border-radius: 12px; border: 1px dashed #f87171; color: #f87171; margin-top:20px;">
                                        <div style="font-size: 18px; margin-bottom:8px;">!</div>
                                        <div>暂无配额数据 (Token失效或权限受限)</div>
                                    </div>\`;
                            }

                            panel.innerHTML = \`
                                <div class="panel-header">
                                    <div class="account-info">
                                        <h2>\${acc.name || '未命名账号'}</h2>
                                        <p>\${acc.email}</p>
                                        \${acc.quota?.tier ? \`<div style="margin-top:8px;"><span class="badge" style="background:var(--accent-blue);color:var(--primary-blue);margin-left:0;border:1px solid var(--primary-blue)">\${acc.quota.tier.toUpperCase()}</span></div>\` : ''}
                                    </div>
                                    <div class="btn-group">
                                        <button class="secondary" onclick="refreshAccount('\${acc.id}')">刷新</button>
                                        <button onclick="switchAccount('\${acc.id}', '\${acc.email}')" \${acc.isCurrent ? 'disabled' : ''}>
                                            \${acc.isCurrent ? '当前主账号' : '切换到此账号'}
                                        </button>
                                    </div>
                                </div>
                                \${quotaHtml}
                                <div style="margin-top: 10px; padding-top: 12px; border-top: 1px solid var(--border-color); display:flex; justify-content: flex-end;">
                                    <button class="danger" onclick="deleteAccount('\${acc.id}', '\${acc.email}')">移除此账号</button>
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
                                    <button class="group-danger" onclick="deleteGroup('\${group.id}')" title="删除分组">移除</button>
                                </div>
                                <div class="model-tags">
                                    \${group.models.map(modelName => \`
                                        <div class="model-tag">
                                            <span>\${modelName}</span>
                                            <span class="model-tag-remove" onclick="removeModelFromGroup('\${group.id}', '\${modelName}')">&times;</span>
                                        </div>
                                    \`).join('')}
                                    <div class="model-dropdown">
                                        <button class="add-model-btn" onclick="toggleModelDropdown('\${group.id}', event)">添加模型</button>
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
