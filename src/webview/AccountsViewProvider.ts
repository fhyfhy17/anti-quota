/**
 * 账号管理侧边栏 WebView Provider
 */

import * as vscode from 'vscode';
import * as accountService from '../services/accountService';
import { Account } from '../types/account';

export class AccountsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'antiQuota.accountsView';

    private _view?: vscode.WebviewView;
    private _onStatusUpdate: () => void;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        onStatusUpdate?: () => void
    ) {
        this._onStatusUpdate = onStatusUpdate || (() => { });
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // 处理来自 WebView 的消息
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'ready':
                    this._sendAccounts();
                    break;
                case 'addToken':
                    await this._addToken(data.token);
                    break;
                case 'startOAuthFlow':
                    await this._startOAuthFlow();
                    break;
                case 'handleOAuthCallback':
                    await this._handleOAuthCallback(data.url);
                    break;
                case 'deleteAccount':
                    this._deleteAccount(data.accountId);
                    break;
                case 'switchAccount':
                    await this._switchAccount(data.accountId, data.mode);
                    break;
                case 'refreshQuota':
                    await this._refreshQuota(data.accountId);
                    break;
                case 'refreshAll':
                    await this._refreshAll();
                    break;
                case 'toggleDisabled':
                    this._toggleDisabled(data.accountId);
                    break;
                case 'importFromFile':
                    await this._importFromFile();
                    break;
                case 'exportAccounts':
                    this._exportAccounts();
                    break;
                case 'updateModelThreshold':
                    this._updateModelThreshold(data.model, data.threshold);
                    break;
                case 'updateAutoSwitchEnabled':
                    this._updateAutoSwitchEnabled(data.enabled);
                    break;
            }
        });
    }

    /** 发送账号列表到 WebView */
    private async _sendAccounts() {
        const accounts = accountService.listAccounts();
        const current = await accountService.getCurrentAccount();

        // 获取当前设置
        const config = vscode.workspace.getConfiguration('antiQuota');
        const autoSwitchEnabled = config.get<boolean>('autoSwitch.enabled', true);
        const claudeThreshold = config.get<number>('autoSwitch.thresholds.claude', 0);
        const geminiProThreshold = config.get<number>('autoSwitch.thresholds.gemini-pro', 0);
        const geminiFlashThreshold = config.get<number>('autoSwitch.thresholds.gemini-flash', 0);

        this._view?.webview.postMessage({
            type: 'accounts',
            accounts,
            currentId: current?.id,
            settings: {
                autoSwitchEnabled,
                modelThresholds: {
                    claude: claudeThreshold,
                    'gemini-pro': geminiProThreshold,
                    'gemini-flash': geminiFlashThreshold
                }
            }
        });
    }

    /** 添加 Token */
    private async _addToken(token: string) {
        try {
            const result = await accountService.addAccountsBatch(token);
            if (result.success > 0) {
                vscode.window.showInformationMessage(`成功添加 ${result.success} 个账号`);
                this._sendAccounts();
                this._onStatusUpdate();
            }
            if (result.failed > 0) {
                vscode.window.showWarningMessage(`${result.failed} 个账号添加失败`);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`添加失败: ${error.message}`);
        }
    }

    /** 启动 OAuth 授权流程（自动模式） */
    private async _startOAuthFlow() {
        try {
            this._view?.webview.postMessage({ type: 'oauthStarted' });

            // 先打开浏览器
            const authUrl = accountService.getOAuthUrl();
            vscode.env.openExternal(vscode.Uri.parse(authUrl));

            // 启动 OAuth 流程并等待回调
            const account = await accountService.startOAuthFlow();

            vscode.window.showInformationMessage(`成功添加账号: ${account.email}`);
            this._sendAccounts();
            this._onStatusUpdate();
        } catch (error: any) {
            vscode.window.showErrorMessage(`OAuth 授权失败: ${error.message}`);
        } finally {
            this._view?.webview.postMessage({ type: 'oauthDone' });
        }
    }

    /** 处理 OAuth 回调（手动粘贴模式） */
    private async _handleOAuthCallback(callbackUrl: string) {
        try {
            const account = await accountService.addAccountViaOAuth(callbackUrl);
            vscode.window.showInformationMessage(`成功添加账号: ${account.email}`);
            this._sendAccounts();
            this._onStatusUpdate();
        } catch (error: any) {
            vscode.window.showErrorMessage(`OAuth 失败: ${error.message}`);
        }
    }

    /** 删除账号 */
    private _deleteAccount(accountId: string) {
        accountService.deleteAccount(accountId);
        vscode.window.showInformationMessage('账号已删除');
        this._sendAccounts();
        this._onStatusUpdate();
    }

    /** 切换账号 */
    private async _switchAccount(accountId: string, mode: 'seamless' | 'full' = 'seamless') {
        try {
            this._view?.webview.postMessage({ type: 'switching', accountId });

            const accounts = accountService.listAccounts();
            const account = accounts.find(a => a.id === accountId);

            // 执行切换
            await accountService.switchAccount(accountId, mode);

            // 根据模式显示不同的消息
            if (mode === 'full') {
                vscode.window.showInformationMessage(`已修改配置，请手动重启 Antigravity: ${account?.email}`);
            } else {
                // seamless 模式会自动处理（可能是 Patch 方式或传统方式）
                // 如果是 Patch 方式，会显示相应的提示
                // 如果是传统方式，可能需要重新加载窗口
                vscode.window.showInformationMessage(`⚡ 已切换到 ${account?.email}`);
            }

            this._sendAccounts();
            this._onStatusUpdate();
        } catch (error: any) {
            // 处理特殊错误
            if (error.message === 'NEEDS_RESTART') {
                vscode.window.showInformationMessage('补丁已安装，IDE 正在重启...');
                return;
            }

            vscode.window.showErrorMessage(`切换失败: ${error.message}`);
        } finally {
            this._view?.webview.postMessage({ type: 'switchDone', accountId });
        }
    }

    /** 刷新单个账号配额 */
    private async _refreshQuota(accountId: string) {
        try {
            this._view?.webview.postMessage({ type: 'refreshing', accountId });
            await accountService.fetchAccountQuota(accountId);
            this._sendAccounts();
            this._onStatusUpdate();
        } catch (error: any) {
            vscode.window.showErrorMessage(`刷新失败: ${error.message}`);
        } finally {
            this._view?.webview.postMessage({ type: 'refreshDone', accountId });
        }
    }

    /** 刷新所有账号配额 */
    private async _refreshAll() {
        try {
            this._view?.webview.postMessage({ type: 'refreshingAll' });
            const result = await accountService.refreshAllQuotas();
            vscode.window.showInformationMessage(`刷新完成: ${result.success} 成功, ${result.failed} 失败`);
            this._sendAccounts();
            this._onStatusUpdate();
        } catch (error: any) {
            vscode.window.showErrorMessage(`刷新失败: ${error.message}`);
        } finally {
            this._view?.webview.postMessage({ type: 'refreshAllDone' });
        }
    }

    /** 切换账号禁用状态 */
    private _toggleDisabled(accountId: string) {
        const accounts = accountService.listAccounts();
        const account = accounts.find(a => a.id === accountId);
        if (account) {
            accountService.updateAccount(accountId, { disabled: !account.disabled });
            this._sendAccounts();
        }
    }

    /** 从文件导入账号 */
    private async _importFromFile() {
        try {
            // 打开文件选择对话框
            const fileUri = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: {
                    'JSON 文件': ['json'],
                    '所有文件': ['*']
                },
                title: '选择账号 JSON 文件'
            });

            if (!fileUri || fileUri.length === 0) {
                return;
            }

            this._view?.webview.postMessage({ type: 'importing' });

            // 读取文件内容
            const fileContent = await vscode.workspace.fs.readFile(fileUri[0]);
            const jsonString = Buffer.from(fileContent).toString('utf-8');

            // 批量导入
            const result = await accountService.addAccountsBatch(jsonString);

            if (result.success > 0) {
                vscode.window.showInformationMessage(`成功导入 ${result.success} 个账号`);
                this._sendAccounts();
                this._onStatusUpdate();
            }
            if (result.failed > 0) {
                vscode.window.showWarningMessage(`${result.failed} 个账号导入失败`);
            }
            if (result.success === 0 && result.failed === 0) {
                vscode.window.showWarningMessage('文件中未找到有效的账号数据');
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`导入失败: ${error.message}`);
        } finally {
            this._view?.webview.postMessage({ type: 'importDone' });
        }
    }

    /** 导出账号 */
    private _exportAccounts() {
        const exported = accountService.exportAccounts();
        const content = JSON.stringify(exported, null, 2);
        vscode.env.clipboard.writeText(content);
        vscode.window.showInformationMessage(`已复制 ${exported.length} 个账号到剪贴板`);
    }

    /** 更新指定模型的自动切换阈值 */
    private _updateModelThreshold(model: string, threshold: number) {
        const config = vscode.workspace.getConfiguration('antiQuota');
        config.update(`autoSwitch.thresholds.${model}`, threshold, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`${model} 阈值已设置为 ${threshold}%`);
    }

    /** 更新自动切换启用状态 */
    private _updateAutoSwitchEnabled(enabled: boolean) {
        const config = vscode.workspace.getConfiguration('antiQuota');
        config.update('autoSwitch.enabled', enabled, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`自动切换已${enabled ? '启用' : '禁用'}`);
    }

    /** 刷新 WebView */
    refresh() {
        this._sendAccounts();
    }

    /** 生成 WebView HTML */
    private _getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Anti Quota</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            padding: 12px;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-widget-border);
        }

        .header h2 {
            font-size: 14px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .header-actions {
            display: flex;
            gap: 4px;
        }

        .icon-btn {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            padding: 4px;
            opacity: 0.7;
            transition: opacity 0.15s, color 0.15s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .icon-btn:hover {
            opacity: 1;
            color: var(--vscode-foreground);
        }

        .icon-btn svg {
            width: 16px;
            height: 16px;
            fill: currentColor;
        }

        .icon-btn.spin svg {
            animation: spin 1s linear infinite;
        }

        .flat-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .flat-icon svg {
            width: 16px;
            height: 16px;
            fill: currentColor;
        }

        .flat-icon.large svg {
            width: 32px;
            height: 32px;
        }

        .add-section {
            margin-bottom: 16px;
        }

        .add-tabs {
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
        }

        .tab-btn {
            flex: 1;
            padding: 8px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.2s;
        }

        .tab-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .tab-btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .add-form {
            display: none;
        }

        .add-form.active {
            display: block;
        }

        .add-form textarea {
            width: 100%;
            min-height: 60px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 8px;
            font-family: inherit;
            font-size: 11px;
            resize: vertical;
            margin-bottom: 8px;
        }

        .add-form textarea::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        .add-form .btn-row {
            display: flex;
            gap: 8px;
        }

        .btn {
            flex: 1;
            padding: 8px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.2s;
        }

        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .btn-primary:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .accounts-list {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .account-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            padding: 8px 10px;
            transition: all 0.2s;
        }

        .account-card:hover {
            border-color: var(--vscode-focusBorder);
        }

        .account-card.current {
            border-color: var(--vscode-charts-green);
            background: color-mix(in srgb, var(--vscode-charts-green) 8%, var(--vscode-editor-background));
        }

        .account-card.disabled {
            opacity: 0.5;
        }

        .account-card.forbidden {
            border-color: var(--vscode-charts-red);
        }

        .account-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .account-email {
            font-weight: 600;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 4px;
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .account-email .badge {
            font-size: 9px;
            padding: 1px 4px;
            border-radius: 8px;
            font-weight: normal;
            flex-shrink: 0;
        }

        .badge-current {
            background: var(--vscode-charts-green);
            color: white;
        }

        .badge-disabled {
            background: var(--vscode-charts-orange);
            color: white;
        }

        .badge-forbidden {
            background: var(--vscode-charts-red);
            color: white;
        }

        .account-actions {
            display: flex;
            gap: 2px;
            flex-shrink: 0;
        }

        .icon-btn.primary {
            color: var(--vscode-button-background);
        }

        .icon-btn.primary:hover {
            color: var(--vscode-button-hoverBackground);
        }

        .icon-btn.secondary {
            color: var(--vscode-descriptionForeground);
        }

        .account-stats {
            display: flex;
            gap: 12px;
            margin-bottom: 12px;
            padding: 6px 8px;
            background: var(--vscode-editor-background);
            border-radius: 4px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            border: 1px solid var(--vscode-widget-border);
        }

        .stat-item b {
            color: var(--vscode-foreground);
            margin-left: 2px;
        }

        .quota-list {
            display: grid;
            grid-template-columns: auto auto 1fr;
            gap: 4px 12px;
            margin-top: 6px;
        }

        .quota-item {
            display: contents;
        }

        .quota-label {
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
            white-space: nowrap;
        }

        .quota-value {
            font-weight: 600;
            font-size: 10px;
            text-align: left;
            min-width: 35px;
        }



        .quota-value.high { color: var(--vscode-charts-green); }
        .quota-value.medium { color: var(--vscode-charts-yellow); }
        .quota-value.low { color: var(--vscode-charts-orange); }
        .quota-value.critical { color: var(--vscode-charts-red); }

        .reset-time {
            color: var(--vscode-descriptionForeground);
            font-size: 9px;
            opacity: 0.7;
            margin-left: 2px;
        }

        .divider {
            width: 1px;
            height: 12px;
            background: var(--vscode-widget-border);
            margin: 0 2px;
        }

        .empty-state {
            text-align: center;
            padding: 32px 16px;
            color: var(--vscode-descriptionForeground);
        }

        .empty-state .icon {
            font-size: 32px;
            margin-bottom: 12px;
        }

        .empty-state p {
            margin-bottom: 16px;
        }

        .loading {
            display: inline-block;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }

        /* 页面切换动画 */
        .page {
            display: none;
            animation: fadeIn 0.2s ease-out;
        }

        .page.active {
            display: block;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .settings-section {
            margin-top: 8px;
        }

        .settings-title {
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--vscode-foreground);
        }

        .setting-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
        }

        .setting-label {
            font-size: 12px;
            flex: 1;
        }

        .setting-value {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }

        /* Toggle Switch */
        .toggle-switch {
            position: relative;
            display: inline-block;
            width: 40px;
            height: 20px;
        }

        .toggle-switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .toggle-slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            transition: .4s;
            border-radius: 10px;
        }

        .toggle-slider:before {
            position: absolute;
            content: "";
            height: 14px;
            width: 14px;
            left: 2px;
            bottom: 2px;
            background-color: var(--vscode-descriptionForeground);
            transition: .4s;
            border-radius: 50%;
        }

        .toggle-switch input:checked + .toggle-slider {
            background-color: var(--vscode-button-background);
            border-color: var(--vscode-button-background);
        }

        .toggle-switch input:checked + .toggle-slider:before {
            transform: translateX(20px);
            background-color: white;
        }

        /* Range Slider */
        input[type="range"] {
            -webkit-appearance: none;
            appearance: none;
            height: 4px;
            background: var(--vscode-input-background);
            border-radius: 2px;
            outline: none;
        }

        input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 16px;
            height: 16px;
            background: var(--vscode-button-background);
            border-radius: 50%;
            cursor: pointer;
        }

        input[type="range"]::-moz-range-thumb {
            width: 16px;
            height: 16px;
            background: var(--vscode-button-background);
            border-radius: 50%;
            cursor: pointer;
            border: none;
        }

        #threshold-display {
            font-weight: 600;
            color: var(--vscode-button-background);
        }
    </style>
</head>
<body>
    <div class="header">
        <h2 id="view-title">
            <span class="flat-icon"><svg viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg></span>
            账号管理
        </h2>
        <div class="header-actions">
            <div id="main-actions" style="display: flex; gap: 4px;">
                <button class="icon-btn" onclick="importFromFile()" title="📥 从文件导入"><svg viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg></button>
                <button class="icon-btn" id="refresh-all-btn" onclick="refreshAll()" title="🔄 刷新全部"><svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg></button>
                <button class="icon-btn" onclick="exportAccounts()" title="📤 导出账号"><svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>
                <button class="icon-btn" onclick="togglePage('settings')" title="设置"><svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94L14.4 2.81c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg></button>
            </div>
            <div id="settings-actions" style="display: none;">
                <button class="icon-btn" onclick="togglePage('accounts')" title="返回"><svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg></button>
            </div>
        </div>
    </div>

    <div id="accounts-page" class="page active">
        <div class="add-section">
            <div class="add-tabs">
                <button class="tab-btn active" onclick="showTab('oauth')">🔐 OAuth</button>
                <button class="tab-btn" onclick="showTab('token')">+ Token</button>
            </div>
            
            <div id="oauth-form" class="add-form active">
                <button id="oauth-btn" class="btn btn-primary" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;" onclick="startOAuth()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                    开始 Google 授权
                </button>
                <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; text-align: center;">
                    点击后自动打开浏览器，完成授权后自动添加账号
                </div>
            </div>
            
            <div id="token-form" class="add-form">
                <textarea id="token-input" placeholder="粘贴 refresh_token（支持多个，换行或逗号分隔）"></textarea>
                <div class="btn-row">
                    <button class="btn btn-primary" onclick="addToken()">添加账号</button>
                </div>
            </div>
        </div>

        <div id="account-stats-container" class="account-stats">
            <div class="stat-item">总账号: <b id="stat-total">0</b></div>
            <div class="stat-item">当前激活: <b id="stat-active">0</b></div>
        </div>

        <div id="accounts-container" class="accounts-list">
            <div class="empty-state">
                <div class="icon"><span class="flat-icon large"><svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8l8 5 8-5v10zm-8-7L4 6h16l-8 5z"/></svg></span></div>
                <p>暂无账号</p>
                <button class="btn btn-primary" style="display: flex; align-items: center; justify-content: center; gap: 6px;" onclick="importFromFile()"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> 从文件导入</button>
            </div>
        </div>
    </div>

    <div id="settings-page" class="page">
        <div class="settings-section">
            <div class="settings-title">
                <span class="flat-icon"><svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94L14.4 2.81c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg></span>
                自动切换设置
            </div>
            <div class="setting-row">
                <div class="setting-label">配额低于阈值自动切换</div>
                <label class="toggle-switch">
                    <input type="checkbox" id="auto-switch-enabled" onchange="updateAutoSwitchEnabled(this.checked)">
                    <span class="toggle-slider"></span>
                </label>
            </div>
            <div class="setting-row" style="margin-top: 12px; border-top: 1px solid var(--vscode-widget-border); padding-top: 12px;">
                <div class="setting-label" style="font-weight: 600;">分模型详细设置 (0% 为不检查)</div>
            </div>

            <!-- Claude -->
            <div class="setting-row">
                <div class="setting-label">
                    Claude 阈值: <span id="display-claude">0</span>%
                </div>
            </div>
            <div class="setting-row">
                <input type="range" id="threshold-claude" min="0" max="100" value="0" 
                       oninput="updateModelThresholdDisplay('claude', this.value)" 
                       onchange="updateModelThreshold('claude', this.value)"
                       style="width: 100%; margin: 0;">
            </div>

            <!-- G Pro -->
            <div class="setting-row" style="margin-top: 8px;">
                <div class="setting-label">
                    Gemini Pro 阈值: <span id="display-gemini-pro">0</span>%
                </div>
            </div>
            <div class="setting-row">
                <input type="range" id="threshold-gemini-pro" min="0" max="100" value="0" 
                       oninput="updateModelThresholdDisplay('gemini-pro', this.value)" 
                       onchange="updateModelThreshold('gemini-pro', this.value)"
                       style="width: 100%; margin: 0;">
            </div>

            <!-- G Flash -->
            <div class="setting-row" style="margin-top: 8px;">
                <div class="setting-label">
                    Gemini Flash 阈值: <span id="display-gemini-flash">0</span>%
                </div>
            </div>
            <div class="setting-row">
                <input type="range" id="threshold-gemini-flash" min="0" max="100" value="0" 
                       oninput="updateModelThresholdDisplay('gemini-flash', this.value)" 
                       onchange="updateModelThreshold('gemini-flash', this.value)"
                       style="width: 100%; margin: 0;">
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let accounts = [];
        let currentId = null;
        let switchingId = null;
        let refreshingId = null;

        // 初始化
        vscode.postMessage({ type: 'ready' });

        // 接收消息
        window.addEventListener('message', event => {
            const data = event.data;
            switch (data.type) {
                case 'accounts':
                    accounts = data.accounts;
                    currentId = data.currentId;
                    
                    // 更新设置UI
                    if (data.settings) {
                        const enabledCheckbox = document.getElementById('auto-switch-enabled');
                        if (enabledCheckbox) enabledCheckbox.checked = data.settings.autoSwitchEnabled;

                        if (data.settings.modelThresholds) {
                            const mt = data.settings.modelThresholds;
                            ['claude', 'gemini-pro', 'gemini-flash'].forEach(model => {
                                const input = document.getElementById('threshold-' + model);
                                const display = document.getElementById('display-' + model);
                                if (input) input.value = mt[model] || 0;
                                if (display) display.textContent = mt[model] || 0;
                            });
                        }
                    }
                    
                    renderAccounts();
                    break;
                case 'oauthUrl':
                    // URL 已在后端打开
                    break;
                case 'switching':
                    switchingId = data.accountId;
                    renderAccounts();
                    break;
                case 'switchDone':
                    switchingId = null;
                    renderAccounts();
                    break;
                case 'refreshing':
                    refreshingId = data.accountId;
                    renderAccounts();
                    break;
                case 'refreshDone':
                    refreshingId = null;
                    renderAccounts();
                    break;
                case 'refreshingAll':
                    refreshingId = 'all';
                    renderAccounts();
                    break;
                case 'refreshAllDone':
                    refreshingId = null;
                    renderAccounts();
                    break;
                case 'oauthStarted':
                    document.getElementById('oauth-btn').disabled = true;
                    document.getElementById('oauth-btn').innerHTML = '<span class="flat-icon spin"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg></span> 等待授权...';
                    break;
                case 'oauthDone':
                    document.getElementById('oauth-btn').disabled = false;
                    document.getElementById('oauth-btn').innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg> 开始 Google 授权';
                    break;
            }
        });

        function showTab(tab) {
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelectorAll('.add-form').forEach(form => form.classList.remove('active'));
            
            event.currentTarget.classList.add('active');
            document.getElementById(tab + '-form').classList.add('active');
        }

        function togglePage(pageId) {
            // 切换页面显示
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById(pageId + '-page').classList.add('active');

            // 切换标题和动作按钮
            const titleEl = document.getElementById('view-title');
            const mainActions = document.getElementById('main-actions');
            const settingsActions = document.getElementById('settings-actions');

            if (pageId === 'settings') {
                titleEl.innerHTML = '<span class="flat-icon"><svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94L14.4 2.81c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg></span> 设置中心';
                mainActions.style.display = 'none';
                settingsActions.style.display = 'flex';
            } else {
                titleEl.innerHTML = '<span class="flat-icon"><svg viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg></span> 账号管理';
                mainActions.style.display = 'flex';
                settingsActions.style.display = 'none';
            }
        }

        function addToken() {
            const token = document.getElementById('token-input').value.trim();
            if (!token) return;
            vscode.postMessage({ type: 'addToken', token });
            document.getElementById('token-input').value = '';
        }

        function startOAuth() {
            vscode.postMessage({ type: 'startOAuthFlow' });
        }

        function importFromFile() {
            vscode.postMessage({ type: 'importFromFile' });
        }

        function refreshAll() {
            vscode.postMessage({ type: 'refreshAll' });
        }

        function exportAccounts() {
            vscode.postMessage({ type: 'exportAccounts' });
        }

        function deleteAccount(id) {
            vscode.postMessage({ type: 'deleteAccount', accountId: id });
        }

        function switchAccount(id, mode) {
            vscode.postMessage({ type: 'switchAccount', accountId: id, mode });
        }

        function refreshQuota(id) {
            vscode.postMessage({ type: 'refreshQuota', accountId: id });
        }

        function toggleDisabled(id) {
            vscode.postMessage({ type: 'toggleDisabled', accountId: id });
        }

        function updateModelThreshold(model, value) {
            const val = parseInt(value);
            document.getElementById('display-' + model).textContent = val;
            vscode.postMessage({ type: 'updateModelThreshold', model, threshold: val });
        }

        function updateModelThresholdDisplay(model, value) {
            document.getElementById('display-' + model).textContent = value;
        }

        function updateAutoSwitchEnabled(enabled) {
            vscode.postMessage({ type: 'updateAutoSwitchEnabled', enabled });
        }

        function getQuotaClass(percentage) {
            if (percentage >= 50) return 'high';
            if (percentage >= 30) return 'medium';
            if (percentage >= 10) return 'low';
            return 'critical';
        }

        function formatResetTime(isoTime) {
            if (!isoTime) return '';
            try {
                const date = new Date(isoTime);
                const diff = date.getTime() - Date.now();
                if (diff < 0) return '';
                const hours = Math.floor(diff / (1000 * 60 * 60));
                const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                return hours > 0 ? \`\${hours}h \${minutes}m\` : \`\${minutes}m\`;
            } catch {
                return '';
            }
        }

        function renderAccounts() {
            const container = document.getElementById('accounts-container');
            
            // 更新统计信息
            document.getElementById('stat-total').textContent = accounts.length;
            document.getElementById('stat-active').textContent = accounts.filter(a => !a.disabled).length;
            if (accounts.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state">
                        <div class="icon"><span class="flat-icon large"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8l8 5 8-5v10zm-8-7L4 6h16l-8 5z"/></svg></span></div>
                        <p>暂无账号</p>
                        <button class="btn btn-primary" style="display: flex; align-items: center; justify-content: center; gap: 6px;" onclick="autoImport()"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> 自动导入当前账号</button>
                    </div>
                \`;
                return;
            }

            container.innerHTML = accounts.map(account => {
                const isCurrent = account.id === currentId;
                const isSwitching = account.id === switchingId;
                const isRefreshing = account.id === refreshingId || refreshingId === 'all';
                const classes = [
                    'account-card',
                    isCurrent ? 'current' : '',
                    account.disabled ? 'disabled' : '',
                    account.quota?.is_forbidden ? 'forbidden' : ''
                ].filter(Boolean).join(' ');

                let badges = '';
                if (isCurrent) badges += '<span class="badge badge-current">当前</span>';
                if (account.disabled) badges += '<span class="badge badge-disabled">禁用</span>';
                if (account.quota?.is_forbidden) badges += '<span class="badge badge-forbidden">403</span>';

                let quotaHtml = '';
                if (account.quota?.models?.length) {
                    // 按固定顺序排序模型：Claude Sonnet -> Gemini 3 Pro -> Gemini 3 Flash
                    const modelOrder = { 'claude': 0, 'gemini-pro': 1, 'gemini-flash': 2 };
                    const sortedModels = [...account.quota.models].sort((a, b) => 
                        (modelOrder[a.name] ?? 99) - (modelOrder[b.name] ?? 99)
                    );
                    quotaHtml = '<div class="quota-list">' + sortedModels.map(m => {
                        const resetTime = formatResetTime(m.reset_time);
                        return '<div class="quota-item">' +
                            '<span class="quota-label">' + m.displayName + ':</span>' +
                            '<span class="quota-value ' + getQuotaClass(m.percentage) + '">' + m.percentage + '%</span>' +
                            '<span class="reset-time">' + (resetTime ? 'R: ' + resetTime : '') + '</span>' +
                            '</div>';
                    }).join('') + '</div>';
                } else if (account.quota?.is_forbidden) {
                    quotaHtml = '<div class="quota-list"><span style="color: var(--vscode-charts-red); font-size: 10px;">无权限</span></div>';
                } else {
                    quotaHtml = '<div class="quota-list"><span style="color: var(--vscode-descriptionForeground); font-size: 10px;">点击刷新获取配额 →</span></div>';
                }

                return \`
                    <div class="\${classes}">
                        <div class="account-header">
                            <div class="account-email">
                                \${account.email}
                                \${badges}
                            </div>
                            <div class="account-actions">
                                \${!isCurrent ? \`
                                    <button class="icon-btn primary \${isSwitching ? 'spin' : ''}" onclick="switchAccount('\${account.id}', 'seamless')" title="切换账号" \${isSwitching ? 'disabled' : ''}>
                                        <svg viewBox="0 0 24 24"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>
                                    </button>
                                \` : ''}
                                <button class="icon-btn \${isRefreshing ? 'spin' : ''}" onclick="refreshQuota('\${account.id}')" title="刷新配额">
                                    <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                                </button>
                                <button class="icon-btn" onclick="toggleDisabled('\${account.id}')" title="\${account.disabled ? '启用' : '禁用'}">
                                    \${account.disabled ? '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'}
                                </button>
                                <button class="icon-btn" onclick="deleteAccount('\${account.id}')" title="删除"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
                            </div>
                        </div>
                        \${quotaHtml}
                    </div>
                \`;
            }).join('');
        }
    </script>
</body>
</html>`;
    }
}
