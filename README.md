# Antigravity Multi-Account Cockpit

> Antigravity 多账号切换与配额管理助手

一个强大且优雅的 VS Code 插件，专门用于管理多个 Antigravity 账号及其模型配额。

![Logo](https://raw.githubusercontent.com/at2008/antigravity-cockpit/master/resources/icon.png)

## 🌟 核心功能

- **多账号仪表盘 (Dashboard)**：采用直观的 Tab 页设计，一目了然地查看各账号下的 Gemini、Claude 等模型配额。
- **一键切换账号 (SwitcherProxy v10)**：全自动流程。点击切换后，插件会自动关闭 Antigravity 进程、更新底层数据库（注入 Token）并重新启动。支持**安全模式**与**高级模式**两种切换策略。
- **跨平台支持**：完整支持 **Windows / macOS / Linux** 三大平台，自动适配路径与进程管理逻辑。
- **配额实时监控**：支持进度条可视化展示剩余配额，并根据余量自动显示绿色、黄色或红色状态。
- **智能 OAuth 认证**：内置 Google 授权流程，支持自动跳转或手动复制授权链接，解决各种浏览器环境下的兼容性问题。
- **状态栏概览**：在 VS Code 右下角实时显示当前活跃账号及配额简报，鼠标悬停即可查看详细 Markdown 面板。
- **全中文支持**：界面、命令、提示信息及状态栏均已完成深度中文本地化。

## ✨ 新增功能

### 🔄 SwitcherProxy v10 - 跨平台账号切换

全新重构的账号切换引擎，提供更稳定、可配置、跨平台的切换体验：

- **双模式切换**：
  - **安全模式 (safe)**：仅切换插件内当前账号，提示用户手动重启 IDE（适合谨慎用户）
  - **高级模式 (advanced)**：完整自动流程 - Kill 进程 → 注入 Token → 自动重启 IDE（默认）
- **跨平台路径适配**：
  - Windows: `%APPDATA%\Antigravity\User\globalStorage\state.vscdb`
  - macOS: `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`
  - Linux: `~/.config/Antigravity/User/globalStorage/state.vscdb`
- **协议优先启动**：优先尝试 `antigravity://` 协议，失败时自动回退到可执行文件路径
- **安全备份**：注入 Token 前自动备份 `state.vscdb`，生成 `.ag-backup-<timestamp>` 文件
- **可配置覆盖**：支持自定义数据库路径和可执行文件路径

### 🔧 诊断与调试工具

- **环境自检命令** (`antigravity-cockpit.diagnoseEnvironment`)：
  - 检查 Node.js 可执行路径
  - 验证数据库路径存在性与权限
  - 检测 Antigravity 可执行路径
  - 生成可复制的诊断报告
- **日志快速访问** (`antigravity-cockpit.openSwitchLogs`)：
  - 一键打开账号切换日志目录 (`%TEMP%/ag_switch_*.log`)
  - 方便排查切换失败问题

### 🗂️ 模型分组管理

- **自动分组**：根据模型系列名称（Claude、Gemini 3 Pro、Gemini 3 Flash 等）自动创建分组
- **手动分组**：支持手动创建、编辑、删除分组，灵活管理模型归类
- **分组显示**：状态栏按分组显示每个分组中剩余额度最低的模型数据
- **紧凑界面**：分组管理弹窗采用清新简洁的 UI 设计

### 📊 状态栏增强

- **分组配额显示**：状态栏格式 `🟢 Claude: 100% | 🔴 Gemini 3 Flash: 0% | 🟢 Gemini 3 Pro: 100%`
- **详细悬停提示**：鼠标悬停显示完整的配额监控面板，包含：
  - 模型名称（等宽对齐）
  - 进度条可视化
  - 剩余百分比
  - 剩余时间和重置时间
- **表格式对齐**：使用代码块实现完美对齐的表格式显示

### ⏱️ 定时自动刷新

- **可配置刷新间隔**：1-60 分钟可选，默认 5 分钟
- **管理界面设置**：在仪表盘右上角直接调整刷新频率
- **VS Code 设置**：也可通过 `antigravity-cockpit.autoRefreshInterval` 配置
- **实时生效**：修改配置后立即生效，无需重启

### 🔌 连接状态监测

- **自动检测**：按配置的刷新间隔自动检测账户连接状态
- **失败提示**：连接失败时状态栏显示 `$(error) 连接失败`
- **智能通知**：首次失败弹出警告通知，避免频繁打扰
- **一键重连**：
  - 点击状态栏尝试重新连接
  - 通知弹窗提供【重新连接】【关闭】按钮
- **成功反馈**：重连成功后显示"连接成功！"提示

## ⚙️ 配置选项

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `antigravity-cockpit.autoRefreshInterval` | 自动刷新间隔（分钟），1-60 可选 | `5` |
| `antigravity-cockpit.switchMode` | 账号切换模式：`safe` (手动重启) / `advanced` (自动完整流程) | `advanced` |
| `antigravity-cockpit.databasePathOverride` | 数据库路径覆盖（留空使用平台默认路径） | `""` |
| `antigravity-cockpit.antigravityExecutablePath.win32` | Windows 平台 Antigravity.exe 路径覆盖 | `""` |
| `antigravity-cockpit.antigravityExecutablePath.darwin` | macOS 平台 Antigravity.app 路径覆盖 | `""` |
| `antigravity-cockpit.antigravityExecutablePath.linux` | Linux 平台 Antigravity 可执行文件路径覆盖 | `""` |

## 🛠️ 安装与开发

### 依赖环境

- **Node.js**: >= 16.x
- **VS Code**: ^1.80.0
- **SQLite3**: 用于读写 Antigravity 数据库

### 快速开始

1. 克隆本项目到本地。
2. 在项目根目录运行安装依赖：

   ```bash
   npm install
   ```

3. 编译插件代码：

   ```bash
   npm run compile
   ```

4. 在 VS Code 中按 `F5` 启动 **扩展开发宿主** 窗口即可开始使用。

## 📖 使用指南

### 打开管理面板

点击界面右下角状态栏的账号图标（如 `$(account) user`），或者按下 `Ctrl+Shift+P` 搜索并运行命令：`Antigravity: 打开账号管理面板`。

### 添加新账号

在管理面板右上角点击 **"+ 添加新账号"**，在弹出的对话框中选择"自动打开浏览器"或"复制链接"，完成授权后插件会自动同步新账号。

### 切换账号

在管理面板中选择对应的账号 Tab，点击右上方的 **"切换到此账号"** 按钮即可。注意：此操作会自动关闭并重启 Antigravity 以确保配置生效。

### 分组管理

1. 点击管理面板右上角的 **"⚙️ 分组管理"** 按钮
2. 点击 **"🪄 自动分组"** 快速按模型系列创建分组
3. 或点击 **"+ 添加分组"** 手动创建分组
4. 在分组中添加/移除模型
5. 点击 **"💾 保存分组"** 保存配置

### 设置刷新频率

- **方式一**：在管理面板右上角的下拉菜单中选择刷新间隔
- **方式二**：打开 VS Code 设置，搜索 `antigravity-cockpit`，修改 `Auto Refresh Interval`

## 📁 项目结构

- `src/extension.ts`: 插件入口及命令注册中心。
- `src/dashboardProvider.ts`: 基于 Webview 的交互式仪表盘实现。
- `src/accountManager.ts`: 账号数据的持久化及配额 API 交互。
- `src/modelGroupManager.ts`: 模型分组管理器，负责分组配置的增删改查。
- `src/dbManager.ts`: 负责对 `state.vscdb` 的安全注入与数据编码。
- `src/processManager.ts`: Antigravity 进程的生命周期管理（查找/关闭/重启）。

## 📝 许可证

MIT License
