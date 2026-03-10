import * as vscode from 'vscode';

export interface Translations {
    welcomeMessage: string;
    openPanel: string;
    loading: string;
    loadingTooltip: string;
    noAccount: string;
    loginTooltip: string;
    accountDetailsTooltip: string;
    autoImportSuccess: string;
    autoRefreshUpdated: string;
    refreshSuccess: string;
    refreshFailed: string;
    addAccountFailed: string;
    accountDeleted: string;
    deleteFailed: string;
    allAccountsRefreshed: string;
    reconnecting: string;
    reconnectSuccess: string;
    connectionFailed: string;
    reconnect: string;
    close: string;
    switchConfirmTitle: string;
    switchConfirmSafe: string;
    switchConfirmAdvanced: string;
    confirm: string;
    envCheckFailed: string;
    envCheckWarning: string;
    tryAnyway: string;
    continue: string;
    cancel: string;
    switchingAccount: string;
    loadingAccountInfo: string;
    refreshingToken: string;
    preparingProxy: string;
    requestingRestart: string;
    switchFailed: string;
    openLogsTip: string;
    currentAccount: string;
    openSettingsPanel: string;
    reset: string;
    quotaNoPermission: string;
    quotaPendingRefresh: string;
    quotaPendingDetail: string;
    quotaManualRefresh: string;
    deleteConfirm: string;
    autoGroupSuccess: string;
    configSaved: string;
    newGroup: string;

    // Dashboard strings
    dashboardTitle: string;
    accountsTab: string;
    groupingTab: string;
    settingsTab: string;
    refreshAll: string;
    addAccount: string;
    currentAccountLabel: string;
    quotaDetails: string;
    switchBtn: string;
    refreshBtn: string;
    deleteBtn: string;
    autoGroupBtn: string;
    addGroupBtn: string;
    saveGroupsBtn: string;
    refreshIntervalLabel: string;
    minutes: string;
    switchLogsBtn: string;
    envDiagnoseBtn: string;
    activeStatus: string;
    inactiveStatus: string;
    unnamedAccount: string;
    languageLabel: string;
    langAuto: string;
    langZh: string;
    langEn: string;
    accountEmailHeader: string;
    accountNameHeader: string;
    accountTierHeader: string;
    lastActiveHeader: string;
    actionsHeader: string;
    groupListHeader: string;
    
    // OAuth strings
    oauthSuccessTitle: string;
    oauthSuccessMessage: string;
    oauthFailedTitle: string;
    oauthFailedServiceError: string;
    oauthProcessMessage: string;
    oauthCopyLink: string;
    oauthOpenBrowser: string;
    oauthClipboardSuccess: string;
    oauthUserCancelled: string;
    oauthTimeout: string;

    // Token login & export strings
    tokenLoginBtn: string;
    exportTokenBtn: string;
    tokenLoginTitle: string;
    tokenLoginDescription: string;
    tokenLoginPlaceholder: string;
    tokenLoginSubmit: string;
    tokenLoginSuccess: string;
    tokenLoginFailed: string;
    tokenLoginValidating: string;
    exportTokenTitle: string;
    exportTokenWarning: string;
    exportTokenCopied: string;
    exportTokenNoToken: string;
    tokenSecurityWarning: string;
    copyToClipboard: string;

    // Batch token export/import strings
    batchExportBtn: string;
    batchImportBtn: string;
    batchExportTitle: string;
    batchExportDescription: string;
    batchExportSuccess: string;
    batchExportNoAccounts: string;
    batchImportTitle: string;
    batchImportDescription: string;
    batchImportPlaceholder: string;
    batchImportSubmit: string;
    batchImportSuccess: string;
    batchImportFailed: string;
    batchImportValidating: string;
    batchImportInvalidFormat: string;
    batchImportProgress: string;

    // Environment diagnose strings
    envDiagnoseTitle: string;
    envReportGenerated: string;
    copyReport: string;
    reportCopied: string;
    nodeSection: string;
    dbSection: string;
    exeSection: string;
    platformSection: string;
    configSection: string;
    statusFound: string;
    statusNotFound: string;
    statusFoundLong: string;
    statusNotFoundLong: string;
    statusDetectFailed: string;
    statusLabelText: string;
    pathLabelText: string;
    configOverrideLabel: string;
    osLabelText: string;
    archLabelText: string;
    switchModeLabelText: string;
    refreshIntervalLabelText: string;
}

const en: Translations = {
    welcomeMessage: '🚀 Antigravity Multi-Account Cockpit installed successfully! Check the UFO icon in the status bar.',
    openPanel: 'Open Panel',
    loading: 'Loading...',
    loadingTooltip: 'Loading Antigravity account information...',
    noAccount: 'No Account',
    loginTooltip: 'Click to login or add Antigravity account',
    accountDetailsTooltip: 'Click to view account details',
    autoImportSuccess: '🛸 Automatically recognized and imported account: {0}',
    autoRefreshUpdated: 'Auto-refresh settings updated',
    refreshSuccess: 'Successfully refreshed account {0}',
    refreshFailed: 'Refresh failed: {0}',
    addAccountFailed: 'Add account failed: {0}',
    accountDeleted: 'Account {0} deleted',
    deleteFailed: 'Delete failed: {0}',
    allAccountsRefreshed: 'All account information updated',
    reconnecting: 'Attempting to reconnect...',
    reconnectSuccess: 'Connected successfully!',
    connectionFailed: 'Antigravity account connection failed: {0}',
    reconnect: 'Reconnect',
    close: 'Close',
    switchConfirmTitle: 'Switching to account {0}',
    switchConfirmSafe: '【Safe Mode】Only updates the current account in the plugin. IDE will not be restarted.\n\nPlease restart Antigravity IDE manually for the changes to take effect.',
    switchConfirmAdvanced: '⚠️ This action will:\n• Close all Antigravity IDE processes\n• Update credentials in IDE database\n• Automatically restart IDE in ~10 seconds\n\nPlease wait a few seconds after restart for the new account to appear.',
    confirm: 'Confirm',
    envCheckFailed: '⚠️ Environment check failed, account switching may not work:\n\n{0}',
    envCheckWarning: '⚠️ Environment check found warnings:\n\n{0}\n\nContinue switching?',
    tryAnyway: 'Try Anyway',
    continue: 'Continue',
    cancel: 'Cancel',
    switchingAccount: 'Switching Antigravity Account',
    loadingAccountInfo: 'Loading account information...',
    refreshingToken: 'Refreshing token...',
    preparingProxy: 'Preparing external proxy...',
    requestingRestart: 'Requesting IDE exit and restart...',
    switchFailed: 'Switch failed: {0}',
    openLogsTip: 'Opened system temp directory. Look for latest ag_switch_*.log files.',
    currentAccount: 'Current Account: {0}',
    openSettingsPanel: 'Click to open settings panel',
    reset: 'Reset',
    quotaNoPermission: 'Quota: No Permission',
    quotaPendingRefresh: 'Quota Pending Refresh',
    quotaPendingDetail: 'To reduce the risk of API rate limits, background updates only primary account.',
    quotaManualRefresh: 'Click "Refresh" above to get quota manually.',
    deleteConfirm: 'Are you sure you want to delete account {0}? This action cannot be undone.',
    autoGroupSuccess: 'Created {0} groups automatically',
    configSaved: 'Group configuration saved',
    newGroup: 'New Group',

    dashboardTitle: 'Antigravity Multi-Account Cockpit',
    accountsTab: 'Accounts',
    groupingTab: 'Grouping',
    settingsTab: 'Settings',
    refreshAll: 'Refresh All',
    addAccount: 'Add Account',
    currentAccountLabel: 'Current',
    quotaDetails: 'Quota Details',
    switchBtn: 'Switch',
    refreshBtn: 'Refresh',
    deleteBtn: 'Delete',
    autoGroupBtn: 'Auto Group',
    addGroupBtn: 'Add Group',
    saveGroupsBtn: 'Save Groups',
    refreshIntervalLabel: 'Auto-refresh Interval',
    minutes: 'Minutes',
    switchLogsBtn: 'Switch Logs',
    envDiagnoseBtn: 'Env Diagnose',
    activeStatus: 'Active',
    inactiveStatus: 'Inactive',
    unnamedAccount: 'Unnamed Account',
    languageLabel: '🌐 Language/语言',
    langAuto: 'Auto',
    langZh: '简体中文',
    langEn: 'English',
    accountEmailHeader: 'Account (Email)',
    accountNameHeader: 'Name',
    accountTierHeader: 'Tier',
    lastActiveHeader: 'Last Active',
    actionsHeader: 'Actions',
    groupListHeader: 'Group List',
    oauthSuccessTitle: '✅ Authorization Successful!',
    oauthSuccessMessage: 'You can close this window and return to VS Code.',
    oauthFailedTitle: '❌ Authorization Failed',
    oauthFailedServiceError: 'Authorization service returned error: {0}',
    oauthProcessMessage: '🔐 Please complete Google authorization in your browser. Account will be synced automatically after completion.',
    oauthCopyLink: 'Copy Link',
    oauthOpenBrowser: 'Open in Default Browser',
    oauthClipboardSuccess: '✅ Authorization link copied to clipboard. Please paste it in your browser.',
    oauthUserCancelled: 'User cancelled authorization',
    oauthTimeout: 'Authorization timed out, please try again.',

    tokenLoginBtn: 'Token Login',
    exportTokenBtn: 'Export Token',
    tokenLoginTitle: 'Login with Refresh Token',
    tokenLoginDescription: 'Only paste the Refresh Token value (e.g. 1//0xxx...). Do NOT paste your email, password, or other content. You can export the token from an existing account.',
    tokenLoginPlaceholder: '1//0xxxxxxx...',
    tokenLoginSubmit: 'Login',
    tokenLoginSuccess: 'Successfully logged in via Token: {0}',
    tokenLoginFailed: 'Token login failed: {0}',
    tokenLoginValidating: 'Validating token...',
    exportTokenTitle: 'Export Refresh Token',
    exportTokenWarning: '⚠️ Security Warning: The Refresh Token is equivalent to your account password. Only share it through secure channels. Do NOT send it via chat or email.',
    exportTokenCopied: '✅ Refresh Token copied to clipboard.',
    exportTokenNoToken: 'This account has no valid Token. Please refresh the account first.',
    tokenSecurityWarning: '⚠️ This token is equivalent to your password. Keep it safe!',
    copyToClipboard: 'Copy to Clipboard',

    batchExportBtn: 'Export All',
    batchImportBtn: 'Import All',
    batchExportTitle: 'Batch Export Tokens',
    batchExportDescription: 'All account tokens have been exported as JSON. Copy and transfer via a secure channel.',
    batchExportSuccess: '✅ All {0} account tokens exported to clipboard.',
    batchExportNoAccounts: 'No accounts with valid tokens to export.',
    batchImportTitle: 'Batch Import Tokens',
    batchImportDescription: 'Only paste the JSON text from Batch Export. Format example:\n{"version":1,"accounts":[{"email":"...","refresh_token":"1//..."}]}',
    batchImportPlaceholder: '{"version":1,"accounts":[{"email":"...","refresh_token":"1//..."}]}',
    batchImportSubmit: 'Import All',
    batchImportSuccess: 'Successfully imported {0} accounts ({1} new, {2} updated).',
    batchImportFailed: 'Batch import failed: {0}',
    batchImportValidating: 'Importing accounts...',
    batchImportInvalidFormat: 'Invalid format. Please paste the JSON exported from batch export.',
    batchImportProgress: 'Importing account {0}/{1}...',

    envDiagnoseTitle: '## Antigravity Multi-Account Cockpit Environment Check Report\n',
    envReportGenerated: 'Environment check report generated.',
    copyReport: 'Copy Report',
    reportCopied: 'Report copied to clipboard.',
    nodeSection: '### 1. Node.js Environment',
    dbSection: '### 2. Antigravity IDE Database',
    exeSection: '### 3. Antigravity IDE Executable',
    platformSection: '### 4. Platform Info',
    configSection: '### 5. Current Configuration',
    statusFound: '✅ Found',
    statusNotFound: '❌ Not Found',
    statusFoundLong: '✅ Exists',
    statusNotFoundLong: '⚠️ Not found (IDE may not be installed or launched)',
    statusDetectFailed: '❌ Detection failed',
    statusLabelText: '- Status: {0}',
    pathLabelText: '- Path: `{0}`',
    configOverrideLabel: '- Config Override: `{0}`',
    osLabelText: '- OS: `{0}`',
    archLabelText: '- Architecture: `{0}`',
    switchModeLabelText: '- Switch Mode: `{0}`',
    refreshIntervalLabelText: '- Auto-refresh Interval: `{0} Minutes`',
};

const zh: Translations = {
    welcomeMessage: '🚀 Antigravity Multi-Account Cockpit 已成功安装！请关注底部状态栏的 UFO 图标。',
    openPanel: '打开面板',
    loading: '加载中...',
    loadingTooltip: '正在加载 Antigravity 账号信息...',
    noAccount: '无账号',
    loginTooltip: '点击登录或添加 Antigravity 账号',
    accountDetailsTooltip: '点击查看账号详情',
    autoImportSuccess: '🛸 已自动识别并导入当前登录账号: {0}',
    autoRefreshUpdated: '自动刷新设置已更新',
    refreshSuccess: '已刷新账号 {0}',
    refreshFailed: '刷新失败: {0}',
    addAccountFailed: '添加账号失败: {0}',
    accountDeleted: '账号 {0} 已删除',
    deleteFailed: '删除失败: {0}',
    allAccountsRefreshed: '所有账号信息已更新',
    reconnecting: '正在尝试重新连接...',
    reconnectSuccess: '连接成功！',
    connectionFailed: 'Antigravity 账户连接失败: {0}',
    reconnect: '重新连接',
    close: '关闭',
    switchConfirmTitle: '即将切换到账号 {0}',
    switchConfirmSafe: '【安全模式】仅更新插件内的当前账号，不会修改 IDE 数据库或重启 IDE。\n\n切换后请手动重启 Antigravity IDE 以使新账号生效。',
    switchConfirmAdvanced: '⚠️ 此操作将：\n• 关闭所有 Antigravity IDE 进程\n• 更新账号凭据到 IDE 数据库\n• 约 10 秒后自动重新启动 IDE\n\nAntigravity 重启后，需要等待几秒钟才会显示新账号；',
    confirm: '确定',
    envCheckFailed: '⚠️ 环境检查发现问题，可能无法完成账号切换：\n\n{0}',
    envCheckWarning: '⚠️ 环境检查发现以下警告：\n\n{0}\n\n是否继续切换？',
    tryAnyway: '仍然尝试切换',
    continue: '继续',
    cancel: '取消',
    switchingAccount: '正在切换 Antigravity 账号',
    loadingAccountInfo: '正在加载账号信息...',
    refreshingToken: '正在刷新 Token...',
    preparingProxy: '准备外部代理切换流程...',
    requestingRestart: '正在请求 IDE 退出并重启...',
    switchFailed: '切换失败: {0}',
    openLogsTip: '已打开系统临时目录，请查找最新的 ag_switch_*.log 日志文件。',
    currentAccount: '当前账号：{0}',
    openSettingsPanel: '点击打开设置面板',
    reset: '重置',
    quotaNoPermission: '配额: 无权限',
    quotaPendingRefresh: '配额数据待刷新',
    quotaPendingDetail: '为降低触发 API 频率限制的风险，后台仅自动刷新当前启用的账号',
    quotaManualRefresh: '点击上方【刷新】按钮可手动获取配额',
    deleteConfirm: '确定要删除账号 {0} 吗？此操作无法撤销。',
    autoGroupSuccess: '已自动创建 {0} 个分组',
    configSaved: '分组配置已保存',
    newGroup: '新分组',

    dashboardTitle: 'Antigravity 多账号管理控制台',
    accountsTab: '账号列表',
    groupingTab: '分组管理',
    settingsTab: '设置',
    refreshAll: '刷新全部',
    addAccount: '添加账号',
    currentAccountLabel: '当前',
    quotaDetails: '配额详情',
    switchBtn: '切换',
    refreshBtn: '刷新',
    deleteBtn: '删除',
    autoGroupBtn: '自动分组',
    addGroupBtn: '新增分组',
    saveGroupsBtn: '保存分组',
    refreshIntervalLabel: '自动刷新间隔',
    minutes: '分钟',
    switchLogsBtn: '切换日志',
    envDiagnoseBtn: '环境自检',
    activeStatus: '当前激活',
    inactiveStatus: '未激活',
    unnamedAccount: '未命名账号',
    languageLabel: '🌐 语言/Language',
    langAuto: '自动',
    langZh: '简体中文',
    langEn: 'English',
    accountEmailHeader: '账号 (Email)',
    accountNameHeader: '姓名',
    accountTierHeader: '层级',
    lastActiveHeader: '最后活跃',
    actionsHeader: '操作',
    groupListHeader: '分组列表',
    oauthSuccessTitle: '✅ 授权成功!',
    oauthSuccessMessage: '您可以关闭此窗口返回 VS Code。',
    oauthFailedTitle: '❌ 授权失败',
    oauthFailedServiceError: '授权服务返回错误: {0}',
    oauthProcessMessage: '🔐 请在浏览器中完成 Google 授权。授权完成后将自动同步账号。',
    oauthCopyLink: '复制链接',
    oauthOpenBrowser: '在默认浏览器打开',
    oauthClipboardSuccess: '✅ 授权链接已复制到剪贴板，请在浏览器中粘贴访问。',
    oauthUserCancelled: '用户取消授权',
    oauthTimeout: '授权超时，请重试。',

    tokenLoginBtn: 'Token 登录',
    exportTokenBtn: '导出 Token',
    tokenLoginTitle: '使用 Refresh Token 登录',
    tokenLoginDescription: '请仅粘贴 Refresh Token 值（如 1//0xxx...），不要粘贴邮箱、密码或其他内容。您可以从已有账号中导出 Token。',
    tokenLoginPlaceholder: '1//0xxxxxxx...',
    tokenLoginSubmit: '登录',
    tokenLoginSuccess: '已通过 Token 成功登录: {0}',
    tokenLoginFailed: 'Token 登录失败: {0}',
    tokenLoginValidating: '正在验证 Token...',
    exportTokenTitle: '导出 Refresh Token',
    exportTokenWarning: '⚠️ 安全警告: Refresh Token 等同于账号密码，请仅通过安全渠道传输。切勿在聊天或邮件中发送！',
    exportTokenCopied: '✅ Refresh Token 已复制到剪贴板。',
    exportTokenNoToken: '该账号暂无有效 Token，请先刷新账号。',
    tokenSecurityWarning: '⚠️ 此 Token 等同于密码，请妥善保管！',
    copyToClipboard: '复制到剪贴板',

    batchExportBtn: '批量导出',
    batchImportBtn: '批量导入',
    batchExportTitle: '批量导出 Token',
    batchExportDescription: '所有账号的 Token 已导出为 JSON 格式，请通过安全渠道传输。',
    batchExportSuccess: '✅ 已导出 {0} 个账号的 Token 到剪贴板。',
    batchExportNoAccounts: '没有可导出的账号（无有效 Token）。',
    batchImportTitle: '批量导入 Token',
    batchImportDescription: '请仅粘贴批量导出的 JSON 文本。格式示例:\n{"version":1,"accounts":[{"email":"...","refresh_token":"1//..."}]}',
    batchImportPlaceholder: '{"version":1,"accounts":[{"email":"...","refresh_token":"1//..."}]}',
    batchImportSubmit: '批量导入',
    batchImportSuccess: '成功导入 {0} 个账号（{1} 个新建, {2} 个更新）。',
    batchImportFailed: '批量导入失败: {0}',
    batchImportValidating: '正在导入账号...',
    batchImportInvalidFormat: '格式无效，请粘贴批量导出的 JSON 文本。',
    batchImportProgress: '正在导入第 {0}/{1} 个账号...',

    envDiagnoseTitle: '## Antigravity Multi-Account Cockpit 环境自检报告\n',
    envReportGenerated: '环境自检报告已生成。',
    copyReport: '复制报告',
    reportCopied: '报告已复制到剪贴板。',
    nodeSection: '### 1. Node.js 环境',
    dbSection: '### 2. Antigravity IDE 数据库',
    exeSection: '### 3. Antigravity IDE 可执行文件',
    platformSection: '### 4. 平台信息',
    configSection: '### 5. 当前配置',
    statusFound: '✅ 已找到',
    statusNotFound: '❌ 未找到',
    statusFoundLong: '✅ 存在',
    statusNotFoundLong: '⚠️ 不存在（IDE 可能未安装或未启动过）',
    statusDetectFailed: '❌ 检测失败',
    statusLabelText: '- 状态: {0}',
    pathLabelText: '- 路径: \`{0}\`',
    configOverrideLabel: '- 配置覆盖: \`{0}\`',
    osLabelText: '- 操作系统: \`{0}\`',
    archLabelText: '- 架构: \`{0}\`',
    switchModeLabelText: '- 切换模式: \`{0}\`',
    refreshIntervalLabelText: '- 自动刷新间隔: \`{0} 分钟\`',
};

export function getTranslations(): Translations {
    const config = vscode.workspace.getConfiguration('antigravity-cockpit');
    const langConfig = config.get<string>('language') || 'auto';

    if (langConfig === 'zh-cn') {
        return zh;
    } else if (langConfig === 'en') {
        return en;
    }

    const lang = vscode.env.language;
    return lang.startsWith('zh') ? zh : en;
}

export function t(key: keyof Translations, ...args: any[]): string {
    const translations = getTranslations();
    let text = translations[key] || key;
    args.forEach((arg, i) => {
        text = text.replace(`{${i}}`, String(arg));
    });
    return text;
}
