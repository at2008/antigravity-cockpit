# Antigravity Multi-Account Cockpit (EN)

[English] | [中文版](./README.md)

> Antigravity Multi-Account Switcher & Quota Management Assistant

A powerful and elegant VS Code extension designed to manage multiple Antigravity accounts and their model quotas.

## 🌟 Key Features

- **Multi-Account Dashboard**: Intuitive tab-based design to view Gemini, Claude, and other model quotas across all your accounts at a glance.
- **Dual-Window Quota Monitoring on One Screen**: Simultaneously displays both the 5-hour sliding window and 7-day weekly quotas without manual toggling; automatically streamlines display for Free tier accounts without 5H limits.
- **Quota Persistence & Instant Display on Restart**: Dual-layer cache architecture (memory + local disk snapshot). Every account card is instantly rendered upon IDE startup, completely eliminating "Quota Pending Refresh" blank states and redundant requests.
- **One-Click Account Switching**: Fully automated workflow. Handles process termination, database injection, credential synchronization, and restart. Deeply adapted to Antigravity 2.6+ Windows Credential Manager and legacy architectures.
- **Native Model Groups & Status Bar Linkage**: Directly integrates with Google PA's official `quota_groups`. The status bar features compact dual-period syntax and dynamic three-color LED indicators (🟢/🟡/🔴).
- **Smart OAuth Authentication**: Built-in Google authorization flow supporting automatic browser redirection or manual link copying for broad environment compatibility.
- **Token Login & Export**: Direct login via Refresh Token. Supports individual export and batch export/import of all accounts as JSON for effortless cross-device synchronization and migration.
- **Cross-Platform Support**: Full support for **Windows / macOS / Linux**, with automatic path adaptation and process management.
- **Multilingual Support**: Fully localized interface, commands, and notifications across 10 languages (Chinese Simplified/Traditional, English, Japanese, Korean, Russian, French, Spanish, German, Italian, etc.).

## ✨ Main Features

### 🗂️ Model Group Management & Dynamic Discovery

- **Official Native Group Integration**: Replaces manual single-model ID mappings with direct synchronization of Google PA's official `quota_groups` structure.
- **Group Reference Account Selector**: Choose between automatically aggregating all logged-in accounts or selecting a specific reference account, accurately handling model differences across tiers.
- **Ghost Group Elimination**: Extracts genuine quota entries only. Re-extracts and purges obsolete or unowned "ghost groups" with one click (e.g., Free accounts will no longer show unused Argon group placeholders).
- **Custom Aliases & Sorting**: Configure short aliases (e.g., `Claude`, `Gemini`) and reorder groups using up/down controls. Collision prevention logic reliably distinguishes family series.
- **Fully Localized Modal**: Group management settings dialog supports seamless switching across all 10 languages with a modern, compact design.

### 📊 Status Bar Enhancements & Dual-Period Linkage

- **Compact Dual-Period Formatting**: Follows a clean, non-bloated syntax:

  ```text
  🟢 Claude: 80%/90% | 🟡 Gemini: 44%
  ```

  - Slash `/` separates **5-Hour Sliding Quota** and **7-Day Weekly Quota**;
  - Vertical bar `|` separates enabled model groups;
  - Clean text representation without redundant decorative emojis.
- **Dynamic Three-Color LED Warnings**: Prefix indicators (🟢/🟡/🔴) are evaluated against `min(5H, Weekly)` to reflect the tightest bottleneck, strictly aligned with panel thresholds:
  - 🟢 Sufficient: Remaining > 50%
  - 🟡 Low: Remaining 21% ~ 50%
  - 🔴 Critical: Remaining ≤ 20%
- **Streamlined Markdown Hover Tooltip**:
  - Uses compact 🕒 (5H) and 📅 (Weekly) icons for progress bars and reset countdowns;
  - Strips noisy regional labels to ensure seamless clarity across all IDE language environments;
  - Fixes Markdown bold syntax and alignment rendering under all conditions.

### ⚡ Dual-Period Quotas on One Screen & UI Polish

- **Unified Dual-Period Display**: Eliminates the top 5H / Weekly toggle buttons; both Card and List views present dual dimensions side by side.
- **Card View**:
  - Accounts with 5H quotas display both ⚡ 5H sliding bucket and 📅 7-Day weekly progress bars;
  - Free accounts without 5H limits automatically omit empty placeholder bars, keeping the UI tidy.
- **List View**:
  - Group quota column uses 🕒 / 📅 icons for natural cross-language recognition;
  - Model lists inside tooltips are stably sorted in ascending alphabetical order (A-Z);
  - Expired quotas are indicated with an elegant ⌛ hourglass icon.
- **Native CSS Smooth Progress Bars**:
  - Discards legacy Unicode character concatenation (`█░`), migrating to inline `.tt-bar` / `.tt-fill` CSS styles;
  - Eliminates height misalignment caused by Windows font glyph metric discrepancies;
  - Upgrades rendering accuracy to a continuous 0%~100% smooth gradient.

### 💾 Quota Data Persistence (Instant Boot)

- **Dual-Layer Cache Architecture**: Stores a `cached_quota` snapshot to local disk alongside the in-memory cache.
- **Instant Display on Boot**: During Phase 1 startup, the dashboard immediately fills with cached disk data, banishing blank loading states and network delays.
- **Expiration Warning**: Detects when a cached quota has passed its reset time and renders a ⚡ warning badge with an actionable refresh hint.

### ⏱️ Automatic Refresh

- **Configurable Intervals**: 1-60 minutes selectable (default: 5 minutes).
- **In-Dashboard Setting**: Adjust the refresh frequency directly in the top-right of the dashboard.
- **VS Code Settings**: Can also be configured via `antigravity-cockpit.autoRefreshInterval`.
- **Live Updates**: Settings take effect immediately without requiring a restart.

### 🔌 Connection Monitoring

- **Auto Detection**: Automatically checks account connectivity at the configured interval.
- **Failure Indicators**: Shows `$(error) Connection Failed` in the status bar if a check fails.
- **Smart Notifications**: Shows a warning notification on the first failure to avoid unnecessary interruptions.
- **One-Click Reconnect**:
  - Click the status bar to retry the connection;
  - Notification provides "Reconnect" and "Close" action buttons.
- **Success Feedback**: Displays "Connected Successfully!" upon successful reconnection.

### 🔑 Token Export & Import (Cross-Device Sync)

- **Token Login**: Direct login by pasting a Refresh Token, bypassing the browser OAuth flow.
- **Individual Export**: Click the 🔑 icon on any account card to quickly copy its Refresh Token.
- **Batch Export (JSON)**: Click the 📦 icon in the header to export all account tokens as a copyable JSON string.
- **Batch Import**: Click the 📥 icon in the header and paste the exported JSON to sync all accounts at once.
- **Responsive Layout**: Header action buttons and account tabs automatically wrap for narrow sidebars.

### 🔄 Cross-Platform Switching & Antigravity 2.6+ Adaptation

- **Dual Switching Modes**:
  - **Safe Mode**: Switches the account within the extension only and prompts the user to restart the IDE manually;
  - **Advanced Mode**: Full automated workflow - Kill process → Inject Token / Credentials → Auto-restart IDE (Default).
- **Antigravity 2.6+ Credential Synchronization**:
  - Adapts to Antigravity 2.6+'s credential store, synchronizing with the native Windows Credential Manager (`gemini:antigravity`);
  - Automatically probes database paths across versions, supporting both 2.6+ shared storage and <= 2.5.5 standalone directories.
- **Cross-Platform Path Adaptation**:
  - Windows: `%APPDATA%\Antigravity\User\globalStorage\state.vscdb`
  - macOS: `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`
  - Linux: `~/.config/Antigravity/User/globalStorage/state.vscdb`
- **Protocol-First Launch**: Tries `antigravity://` protocol first, falling back to executable path if needed.
- **Safety Backups**: Automatically backs up `state.vscdb` before injection, creating `.ag-backup-<timestamp>` files.
- **Configurable Overrides**: Supports custom database and executable paths.

### 🔧 Diagnostics & Debugging

- **Environment Diagnosis Command** (`antigravity-cockpit.diagnoseEnvironment`):
  - Checks Node.js executable path;
  - Verifies database path existence and permissions;
  - Detects Antigravity executable path;
  - Generates a copyable diagnostic report.
- **Quick Log Access** (`antigravity-cockpit.openSwitchLogs`):
  - One-click access to the switch logs directory (`%TEMP%/ag_switch_*.log`);
  - Useful for troubleshooting switching issues.

## ⚙️ Configuration Options

| Option | Description | Default |
| -------- | ------------- | --------- |
| `antigravity-cockpit.autoRefreshInterval` | Auto refresh interval in minutes (1-60). | `5` |
| `antigravity-cockpit.switchMode` | Switch mode: `safe` (Manual restart) / `advanced` (Full auto). | `advanced` |
| `antigravity-cockpit.databasePathOverride` | Custom database path (leave empty for default). | `""` |
| `antigravity-cockpit.antigravityExecutablePath.win32` | Custom Antigravity.exe path for Windows. | `""` |
| `antigravity-cockpit.antigravityExecutablePath.darwin` | Custom Antigravity.app path for macOS. | `""` |
| `antigravity-cockpit.antigravityExecutablePath.linux` | Custom Antigravity executable path for Linux. | `""` |
| `antigravity-cockpit.language` | Interface language: `auto` / `zh-cn` / `en`, etc. | `auto` |
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

Click **"+ Add New Account"** in the top-right of the dashboard. Choose "Open Browser" or "Copy Link". Once authorized, the extension will sync automatically. You can also use **Token Login** to paste an existing Refresh Token directly.

### Switch Account

Go to the desired account tab and click **"Switch to this Account"**. Note: In advanced mode, this will automatically restart Antigravity to apply changes.

### Model Groups & Status Bar Settings

1. Click **"⚙️ Group Management"** in the top-right of the dashboard;
2. Select a **[Group Reference Account]** at the top (e.g., "Aggregate All Accounts" or a specific high-tier account);
3. Click **"Re-extract"** to fetch the latest official model groups and prune ghost groups;
4. Toggle visibility, customize short aliases, and adjust order using the **"↑ / ↓"** buttons;
5. Click **"Save"**; the status bar will immediately reflect the updated dual-period indicators.

### Set Refresh Interval

- **Method 1**: Use the dropdown menu in the top-right of the dashboard;
- **Method 2**: Go to VS Code settings, search for `antigravity-cockpit`, and modify `Auto Refresh Interval`.

## 📁 Project Structure

- `src/extension.ts`: Main entry point and command registration.
- `src/dashboardProvider.ts`: Webview-based interactive dashboard (Card/List views and unified dual-period layout).
- `src/accountManager.ts`: Data persistence, dual-layer cache (memory + disk snapshot), and Quota API interaction.
- `src/modelGroupManager.ts`: Official native model group manager handling extraction, ghost group pruning, and alias ordering.
- `src/dbManager.ts`: Handles secure injection, credential synchronization, and data encoding for `state.vscdb`.
- `src/processManager.ts`: Lifecycle management for the Antigravity process (Find/Kill/Restart).

## 📝 License

MIT License
