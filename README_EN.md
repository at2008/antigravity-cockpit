# Antigravity Multi-Account Cockpit (EN)

[English] | [中文版](./README.md)

> Antigravity Multi-Account Switcher & Quota Management Assistant

A powerful and elegant VS Code extension designed to manage multiple Antigravity accounts and their model quotas.

## 🌟 Key Features

- **Multi-Account Dashboard**: Intuitive tab-based design to view Gemini, Claude, and other model quotas across all your accounts at a glance.
- **One-Click Account Switching**: Automated workflow. When switching, the extension automatically closes Antigravity, updates the underlying database (injecting token), and restarts it. Supports **Safe** and **Advanced** modes.
- **Real-Time Quota Monitoring**: Visual progress bars show remaining quotas, automatically color-coded (Green/Yellow/Red) based on availability.
- **Smart OAuth Authentication**: Built-in Google authorization flow, supporting automatic browser redirection or manual link copying to ensure compatibility.
- **Token Login & Export**: Direct login via Refresh Token. Supports individual export and batch export/import of all accounts as JSON, simplifying synchronization and backup across multiple devices.
- **Status Bar Overview**: Real-time display of the active account and quota summary in the VS Code status bar. Hover to see a detailed Markdown panel.
- **Cross-Platform Support**: Full support for **Windows / macOS / Linux**, with automatic path adaptation and process management.
- **Multilingual Support**: Fully localized interface, commands, and notifications, supporting Chinese (Simp/Trad), English, Japanese, Korean, Russian, French, Spanish, German, Italian, etc.

## ✨ Main Features

### 🗂️ Model Group Management

- **Auto Grouping**: Automatically creates groups based on model families (Claude, Gemini 3 Pro, Gemini 3 Flash, etc.).
- **Manual Grouping**: Create, edit, and delete groups manually for flexible model categorization.
- **Group Display**: Status bar shows the lowest remaining quota from each group.
- **Compact UI**: Clean and minimalistic design for the group management modal.

### 📊 Status Bar Enhancements

- **Grouped Quota Display**: Status bar format: `🟢 Claude: 100% | 🔴 Gemini 3 Flash: 0% | 🟢 Gemini 3 Pro: 100%`
- **Detailed Hover Tooltip**: Hover over the status bar to see a full monitoring panel, including:
  - Model Name (Monospaced alignment)
  - Visual Progress Bar
  - Remaining Percentage
  - Remaining count and reset time
- **Table Formatting**: Uses code blocks for perfectly aligned tabular display.

### ⏱️ Automatic Refresh

- **Configurable Intervals**: Choose from 1-60 minutes, default is 5 minutes.
- **In-Dashboard Setting**: Adjust the refresh frequency directly in the top-right of the dashboard.
- **VS Code Settings**: Can also be configured via `antigravity-cockpit.autoRefreshInterval`.
- **Live Updates**: Settings take effect immediately without a restart.

### 🔌 Connection Monitoring

- **Auto Detection**: Automatically checks account connectivity at the configured interval.
- **Failure Indicators**: Shows `$(error) Connection Failed` in the status bar if a check fails.
- **Smart Notifications**: Shows a warning notification on the first failure to avoid interruptions.
- **One-Click Reconnect**:
  - Click the status bar to retry the connection.
  - Notification provides "Reconnect" and "Close" buttons.
- **Success Feedback**: Shows "Connected Successfully!" after a successful reconnection.

### 🔑 Token Export & Import (Cross-Device Sync)

New mechanism based on Refresh Tokens to simplify syncing multiple accounts across different devices:

- **Token Login**: Direct login by pasting a Refresh Token, bypassing the browser OAuth flow.
- **Individual Export**: Click the 🔑 icon on any account card to quickly copy its Refresh Token.
- **Batch Export (JSON)**: Click the 📦 icon in the header to export all account tokens as a copyable JSON string.
- **Batch Import**: Click the 📥 icon in the header and paste the exported JSON to sync all accounts at once.
- **Responsive Layout**: Header action buttons and account tabs now support automatic wrapping for narrow sidebars.

### Cross-Platform Switching

Newly refactored account switching engine for a more stable, configurable, and cross-platform experience:

- **Dual Switching Modes**:
  - **Safe Mode**: Switches the account within the extension only and prompts the user to restart the IDE manually.
  - **Advanced Mode**: Full automated workflow - Kill process → Inject Token → Auto-restart IDE (Default).
- **Cross-Platform Path Adaptation**:
  - Windows: `%APPDATA%\Antigravity\User\globalStorage\state.vscdb`
  - macOS: `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`
  - Linux: `~/.config/Antigravity/User/globalStorage/state.vscdb`
- **Protocol-First Launch**: Tries `antigravity://` protocol first, falling back to executable path if it fails.
- **Safety Backups**: Automatically backs up `state.vscdb` before injection, creating `.ag-backup-<timestamp>` files.
- **Configurable Overrides**: Supports custom database and executable paths.

### 🔧 Diagnostics & Debugging

- **Environment Diagnosis Command** (`antigravity-cockpit.diagnoseEnvironment`):
  - Checks Node.js executable path.
  - Verifies database path existence and permissions.
  - Detects Antigravity executable path.
  - Generates a copyable diagnostic report.
- **Quick Log Access** (`antigravity-cockpit.openSwitchLogs`):
  - One-click access to the switch logs directory (`%TEMP%/ag_switch_*.log`).
  - Useful for troubleshooting switching issues.

## ⚙️ Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `antigravity-cockpit.autoRefreshInterval` | Auto refresh interval in minutes (1-60). | `5` |
| `antigravity-cockpit.switchMode` | Switch mode: `safe` (Manual restart) / `advanced` (Full auto). | `advanced` |
| `antigravity-cockpit.databasePathOverride` | Custom database path (leave empty for default). | `""` |
| `antigravity-cockpit.antigravityExecutablePath.win32` | Custom Antigravity.exe path for Windows. | `""` |
| `antigravity-cockpit.antigravityExecutablePath.darwin` | Custom Antigravity.app path for macOS. | `""` |
| `antigravity-cockpit.antigravityExecutablePath.linux` | Custom Antigravity executable path for Linux. | `""` |
| `antigravity-cockpit.language` | Interface language: `auto` / `zh-cn` / `en` | `auto` |
| `antigravity-cockpit.processWaitSeconds` | Process status check wait time in seconds (5-60). | `10` |

## 🛠️ Installation & Development

### Prerequisites

- **Node.js**: >= 16.x
- **Antigravity**: ^1.80.0

### Quick Start

1. Clone the repository locally.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Compile the extension:

   ```bash
   npm run compile
   ```

4. Press `F5` in VS Code to launch the **Extension Development Host** to start testing.

## 📖 Usage Guide

### Open Management Panel

Click the account icon in the status bar (e.g., `$(account) user`) or press `Ctrl+Shift+P` and search for: `Antigravity: Open Account Management Panel`.

### Add New Account

Click **"+ Add New Account"** in the top-right of the dashboard. Choose "Open Browser" or "Copy Link". Once authorized, the extension will sync automatically.

### Switch Account

Go to the desired account tab and click **"Switch to this Account"**. Note: This will automatically restart Antigravity to apply changes.

### Manage Groups

1. Click **"⚙️ Group Management"** in the top-right of the dashboard.
2. Click **"🪄 Auto Group"** to quickly create groups by model family.
3. Or click **"+ Add Group"** to create groups manually.
4. Add/remove models from groups.
5. Click **"💾 Save Groups"** to save your configuration.

### Set Refresh Interval

- **Method 1**: Use the dropdown menu in the top-right of the dashboard.
- **Method 2**: Go to VS Code settings, search for `antigravity-cockpit`, and modify `Auto Refresh Interval`.

## 📁 Project Structure

- `src/extension.ts`: Main entry point and command registration.
- `src/dashboardProvider.ts`: Webview-based interactive dashboard implementation.
- `src/accountManager.ts`: Data persistence and Quota API interaction.
- `src/modelGroupManager.ts`: Manages group configurations (CRUD).
- `src/dbManager.ts`: Handles secure injection and data encoding for `state.vscdb`.
- `src/processManager.ts`: Lifecycle management for the Antigravity process (Find/Kill/Restart).

## 📝 License

MIT License
