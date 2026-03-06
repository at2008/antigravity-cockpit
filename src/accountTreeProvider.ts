import * as vscode from 'vscode';
import { AccountManager, Account, TokenInfo } from './accountManager';
import { ProcessManager } from './processManager';
import { DBManager } from './dbManager';

export class AccountTreeProvider implements vscode.TreeDataProvider<AccountItem | QuotaItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<AccountItem | QuotaItem | undefined | void> = new vscode.EventEmitter<AccountItem | QuotaItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<AccountItem | QuotaItem | undefined | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: AccountItem | QuotaItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: AccountItem): Promise<(AccountItem | QuotaItem)[]> {
        if (!element) {
            // Root - List accounts
            const index = AccountManager.loadIndex();
            return index.accounts.map(acc => {
                const isCurrent = acc.id === index.current_account_id;
                return new AccountItem(
                    acc.email,
                    acc.name,
                    acc.id,
                    isCurrent ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
                    isCurrent
                );
            });
        } else {
            // Account details - List quotas
            try {
                const account = AccountManager.loadAccount(element.accountId);
                if (!account.token) {
                    return [];
                }

                // Check if token needs refresh
                let token = account.token;
                if (Date.now() / 1000 > token.expiry_timestamp - 300) {
                    const refreshed = await AccountManager.refreshToken(token.refresh_token);
                    token.access_token = refreshed.accessToken;
                    token.expiry_timestamp = Math.floor(Date.now() / 1000) + refreshed.expiresIn;
                    account.token = token;
                    AccountManager.saveAccount(account);
                }

                const quota = await AccountManager.fetchQuota(token.access_token);
                if (quota.is_forbidden) {
                    return [new QuotaItem("Forbidden", "No access", vscode.TreeItemCollapsibleState.None)];
                }

                return quota.models.map(m => new QuotaItem(m.name, `${m.percentage}%`, vscode.TreeItemCollapsibleState.None));
            } catch (e) {
                return [new QuotaItem("Error", (e as Error).message, vscode.TreeItemCollapsibleState.None)];
            }
        }
    }
}

class AccountItem extends vscode.TreeItem {
    constructor(
        public readonly email: string,
        public readonly name: string,
        public readonly accountId: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly isCurrent: boolean
    ) {
        super(email, collapsibleState);
        this.tooltip = `${name} (${email})`;
        this.description = name;
        this.contextValue = 'account';
        if (isCurrent) {
            this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
        } else {
            this.iconPath = new vscode.ThemeIcon('account');
        }
    }
}

class QuotaItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly percentage: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.description = percentage;
        this.tooltip = `${label}: ${percentage}`;

        const num = parseInt(percentage);
        if (!isNaN(num)) {
            if (num > 50) {
                this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
            } else if (num > 20) {
                this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
            } else {
                this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
            }
        }
    }
}
