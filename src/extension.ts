/**
 * Anti Quota - Antigravity 多账号配额管理插件
 * 
 * 功能：
 * - 多账号管理（添加、删除、切换）
 * - 实时配额监控（整合自第一版的及时刷新功能）
 * - 无感切换（不重启 IDE）
 * - 配额低于阈值自动切换
 * - 1% 阈值防跳动
 */

import * as vscode from 'vscode';
import { AccountsViewProvider } from './webview/AccountsViewProvider';

import * as accountService from './services/accountService';
import * as multiWindowService from './services/multiWindowService';
import { Account, DEFAULT_SETTINGS, ModelQuota } from './types/account';

// 状态
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let provider: AccountsViewProvider;

// 定时器
let quotaRefreshTimer: NodeJS.Timeout | undefined;
let autoSwitchTimer: NodeJS.Timeout | undefined;

// 当前状态
let isRefreshing = false;
let lastAutoSwitchTime = 0;

// 缓存的配额数据（用于 1% 阈值防跳动）
interface CachedQuota {
    model: string;
    percentage: number;
    resetTime: string;
}
let cachedQuotas: CachedQuota[] = [];

// ============ 激活 ============

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Anti Quota');
    log('🚀 Anti Quota 插件已激活');

    // 创建配额状态栏（点击打开账号管理）
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    statusBarItem.command = 'anti-quota.openAccountManager';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // 创建侧边栏 Provider（独立 Activity Bar 图标）
    provider = new AccountsViewProvider(context.extensionUri, () => {
        updateStatusBar();
    });
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(AccountsViewProvider.viewType, provider)
    );

    // 注册命令
    registerCommands(context);

    // 初始化多窗口协调服务
    multiWindowService.initialize(() => {
        // 其他窗口修改了账号数据，刷新缓存和UI
        log('检测到账号数据变化（其他窗口），刷新...');
        accountService.invalidateCache();
        updateStatusBar();
        provider.refresh();
    });

    // 初始化
    initialize();

    // 监听配置变化
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('antiQuota')) {
            restartTimers();
        }
    });
}

// ============ 初始化 ============

async function initialize() {
    // 显示初始状态
    updateStatusBar();

    // 尝试自动导入
    const accounts = accountService.listAccounts();
    if (accounts.length === 0) {
        log('首次启动，尝试自动导入账号...');
        try {
            const imported = await accountService.autoImportFromEditor();
            if (imported) {
                log(`✅ 自动导入账号: ${imported.email}`);
                vscode.window.showInformationMessage(`Anti Quota: 已自动导入账号 ${imported.email}`);
            }
        } catch (error) {
            log(`自动导入失败: ${error}`);
        }
    }

    // 刷新当前账号配额
    await refreshCurrentAccountQuota();

    // 检查是否有账号没有配额数据，静默补齐
    const allAccounts = accountService.listAccounts();
    const missingQuotaAccounts = allAccounts.filter(a => !a.quota?.models?.length && !a.quota?.is_forbidden);
    if (missingQuotaAccounts.length > 0) {
        log(`发现 ${missingQuotaAccounts.length} 个账号缺少配额数据，后台补齐中...`);
        // 异步补齐，不阻塞启动
        setTimeout(async () => {
            for (const account of missingQuotaAccounts) {
                try {
                    await accountService.fetchAccountQuota(account.id);
                    log(`✅ 补齐配额: ${account.email}`);
                } catch (e) {
                    log(`补齐配额失败: ${account.email}`);
                }
            }
            updateStatusBar();

        }, 1000);
    }

    // 启动定时器
    startTimers();
}

// ============ 命令注册 ============

function registerCommands(context: vscode.ExtensionContext) {
    // 手动刷新
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-quota.refresh', async () => {
            log('手动刷新配额...');
            await refreshCurrentAccountQuota(true);
        })
    );

    // 刷新所有
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-quota.refreshAll', async () => {
            log('刷新所有账号配额...');
            const result = await accountService.refreshAllQuotas();
            vscode.window.showInformationMessage(`刷新完成: ${result.success} 成功, ${result.failed} 失败`);
            updateStatusBar();
            provider.refresh();
        })
    );

    // 显示配额详情
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-quota.showQuotaDetails', () => {
            showQuotaDetailsPanel(context);
        })
    );

    // 打开账号管理（状态栏点击）
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-quota.openAccountManager', async () => {
            // 1. 聚焦到账号管理侧边栏视图
            vscode.commands.executeCommand('antiQuota.accountsView.focus');

            // 2. 刷新所有账号配额
            log('打开账号管理，刷新所有账号配额...');
            statusBarItem.text = '$(sync~spin) 刷新中...';
            try {
                await accountService.refreshAllQuotas();
                updateStatusBar();
                provider.refresh();
            } catch (error) {
                log(`刷新失败: ${error}`);
                updateStatusBar();
            }
        })
    );

    // 添加账号
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-quota.addAccount', async () => {
            const token = await vscode.window.showInputBox({
                prompt: '输入 refresh_token',
                placeHolder: '1//...',
                ignoreFocusOut: true
            });
            if (token) {
                try {
                    const account = await accountService.addAccountByToken(token);
                    vscode.window.showInformationMessage(`已添加账号: ${account.email}`);
                    provider.refresh();
                    updateStatusBar();
                } catch (error: any) {
                    vscode.window.showErrorMessage(`添加失败: ${error.message}`);
                }
            }
        })
    );

    // 切换账号
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-quota.switchAccount', async () => {
            const accounts = accountService.listAccounts();
            if (accounts.length === 0) {
                vscode.window.showWarningMessage('没有可切换的账号');
                return;
            }

            const current = await accountService.getCurrentAccount();
            const items = accounts.map(a => ({
                label: a.email,
                description: a.id === current?.id ? '(当前)' : '',
                detail: a.quota?.models.map(m => `${m.displayName}: ${m.percentage}%`).join(' | ') || '未获取配额',
                account: a
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: '选择要切换的账号'
            });

            if (selected && selected.account.id !== current?.id) {
                const mode = await vscode.window.showQuickPick([
                    { label: '⚡ 无感切换', description: '不重启 IDE', mode: 'seamless' as const },
                    { label: '🔄 重启切换', description: '需要重启 IDE', mode: 'full' as const }
                ], {
                    placeHolder: '选择切换方式'
                });

                if (mode) {
                    try {
                        await accountService.switchAccount(selected.account.id, mode.mode);

                        if (mode.mode === 'seamless') {
                            // 【修复】无感切换后重新加载窗口,确保 IDE 读取最新账号信息
                            // 否则过一会儿 IDE 会把旧账号信息写回数据库,导致切换失效
                            vscode.window.showInformationMessage(
                                `已无感切换到 ${selected.account.email},窗口即将重新加载...`
                            );
                            // 延迟重新加载,让消息有时间显示
                            setTimeout(() => {
                                vscode.commands.executeCommand('workbench.action.reloadWindow');
                            }, 1000);
                        } else {
                            vscode.window.showInformationMessage(
                                `已切换到 ${selected.account.email}，请重启 IDE`
                            );
                        }

                        provider.refresh();
                        updateStatusBar();
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`切换失败: ${error.message}`);
                    }
                }
            }
        })
    );

    // 自动切换开关
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-quota.toggleAutoSwitch', () => {
            const config = vscode.workspace.getConfiguration('antiQuota');
            const current = config.get<boolean>('autoSwitch.enabled', true);
            config.update('autoSwitch.enabled', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`自动切换已${!current ? '启用' : '禁用'}`);
        })
    );
}

// ============ 定时器管理 ============

function startTimers() {
    const config = vscode.workspace.getConfiguration('antiQuota');
    const refreshInterval = config.get<number>('refreshInterval', DEFAULT_SETTINGS.refreshInterval);
    const autoSwitchEnabled = config.get<boolean>('autoSwitch.enabled', DEFAULT_SETTINGS.autoSwitch.enabled);
    const autoSwitchInterval = config.get<number>('autoSwitch.checkInterval', DEFAULT_SETTINGS.autoSwitch.checkInterval);

    // 配额刷新定时器
    if (quotaRefreshTimer) clearInterval(quotaRefreshTimer);
    quotaRefreshTimer = setInterval(() => {
        refreshCurrentAccountQuota();
    }, refreshInterval * 1000);
    log(`配额刷新定时器已启动，间隔 ${refreshInterval} 秒`);

    // 自动切换定时器
    if (autoSwitchTimer) clearInterval(autoSwitchTimer);
    if (autoSwitchEnabled) {
        autoSwitchTimer = setInterval(() => {
            checkAndAutoSwitch();
        }, autoSwitchInterval * 1000);
        log(`自动切换定时器已启动，间隔 ${autoSwitchInterval} 秒`);
    }
}

function restartTimers() {
    log('配置已更改，重启定时器...');
    startTimers();
}

// ============ 配额刷新 ============

async function refreshCurrentAccountQuota(showLoading: boolean = false) {
    if (isRefreshing) return;
    isRefreshing = true;

    try {
        if (showLoading) {
            statusBarItem.text = '$(sync~spin) 刷新中...';
        }

        const current = await accountService.getCurrentAccount();
        if (current) {
            await accountService.fetchAccountQuota(current.id);
            updateStatusBar();
            log(`配额刷新成功: ${current.email}`);
        } else {
            log('未找到当前账号');
        }
    } catch (error) {
        log(`配额刷新失败: ${error}`);
    } finally {
        isRefreshing = false;
        updateStatusBar();
    }
}

// ============ 自动切换 ============

async function checkAndAutoSwitch() {
    const config = vscode.workspace.getConfiguration('antiQuota');
    const enabled = config.get<boolean>('autoSwitch.enabled', true);
    const threshold = config.get<number>('autoSwitch.threshold', 10);
    const notifyOnSwitch = config.get<boolean>('autoSwitch.notifyOnSwitch', true);

    if (!enabled) return;

    // 多窗口环境下，只有主窗口可以执行自动切换
    if (!multiWindowService.canAutoSwitch()) {
        log('非主窗口或切换间隔不足，跳过自动切换检查');
        return;
    }

    const now = Date.now();

    try {
        const current = await accountService.getCurrentAccount();
        if (!current?.quota?.models.length) return;

        // 获取当前账号最低配额
        const currentLowest = accountService.getLowestQuota(current);
        log(`当前账号 ${current.email} 最低配额: ${currentLowest}%`);

        if (currentLowest < threshold) {
            log(`配额 ${currentLowest}% 低于阈值 ${threshold}%，寻找更好的账号...`);

            // 刷新所有账号配额
            await accountService.refreshAllQuotas();

            // 找到最佳账号
            const best = accountService.getBestAvailableAccount(current.id);
            if (best) {
                const bestLowest = accountService.getLowestQuota(best);
                log(`找到备选账号 ${best.email}，最低配额: ${bestLowest}%`);

                if (bestLowest > currentLowest) {
                    // 执行切换
                    await accountService.switchAccount(best.id, 'seamless');
                    multiWindowService.recordSwitch(best.id);

                    log(`✅ 自动切换成功: ${current.email} → ${best.email}`);

                    if (notifyOnSwitch) {
                        vscode.window.showInformationMessage(
                            `⚡ 配额不足，已自动切换到 ${best.email}，窗口即将重新加载...`,
                            '查看详情'
                        ).then(action => {
                            if (action === '查看详情') {
                                vscode.commands.executeCommand('anti-quota.showQuotaDetails');
                            }
                        });
                    }

                    updateStatusBar();
                    provider.refresh();

                    // 【修复】自动切换后也需要重新加载窗口
                    setTimeout(() => {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }, notifyOnSwitch ? 2000 : 1000);
                } else {
                    log('没有找到配额更高的账号');
                }
            } else {
                log('没有可用的备选账号');
            }
        }
    } catch (error) {
        log(`自动切换检查失败: ${error}`);
    }
}

// ============ 状态栏更新（整合第一版的及时刷新功能） ============

/**
 * 获取配额对应的颜色图标（来自第一版）
 */
function getColorIcon(percentage: number): string {
    if (percentage < 0) return '⚪';
    if (percentage === 0) return '🔴';
    if (percentage < 30) return '🟠';
    if (percentage < 70) return '🟡';
    return '🟢';
}

/**
 * 格式化重置时间（来自第一版）
 */
function formatResetTime(isoTime: string): string {
    if (!isoTime) return '--';
    try {
        const date = new Date(isoTime);
        const diff = date.getTime() - Date.now();
        if (diff < 0) return '已重置';

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        return `${hours}h ${minutes}m`;
    } catch {
        return '--';
    }
}

/**
 * 更新状态栏（整合第一版的及时刷新功能）
 * - 1% 阈值防跳动：配额变化小于 1% 时保持原值，避免微小波动
 * - Markdown 表格式 Tooltip：显示详细配额和重置时间
 * - 颜色 Emoji：直观显示配额状态
 */
function updateStatusBar() {
    const accounts = accountService.listAccounts();

    if (accounts.length === 0) {
        statusBarItem.text = '$(account) 无账号';
        statusBarItem.tooltip = '点击添加账号';
        return;
    }

    // 获取当前账号（同步方式）
    accountService.getCurrentAccount().then(current => {
        if (!current) {
            statusBarItem.text = '$(account) 未登录';
            statusBarItem.tooltip = '点击管理账号';
            return;
        }

        if (!current.quota?.models.length) {
            statusBarItem.text = '$(sync) 获取配额中...';
            statusBarItem.tooltip = '点击管理账号';
            return;
        }

        // 【第一版核心功能】1% 阈值防跳动
        const models = current.quota.models;
        const mergedQuotas: CachedQuota[] = models.map(newQ => {
            const oldQ = cachedQuotas.find(q => q.model === newQ.name);
            if (oldQ && Math.abs(newQ.percentage - oldQ.percentage) <= 1) {
                // 变化太小（≤1%），保持旧值，避免状态栏频繁跳动
                return { model: newQ.name, percentage: oldQ.percentage, resetTime: newQ.reset_time };
            }
            return { model: newQ.name, percentage: newQ.percentage, resetTime: newQ.reset_time };
        });

        // 更新缓存
        cachedQuotas = mergedQuotas;

        // 找到三个主要模型
        const claude = mergedQuotas.find(q => q.model === 'claude');
        const pro = mergedQuotas.find(q => q.model === 'gemini-pro');
        const flash = mergedQuotas.find(q => q.model === 'gemini-flash');

        // 构建状态栏文本（第一版格式）
        const claudeText = claude ? `${getColorIcon(claude.percentage)} Claude: ${claude.percentage}%` : '⚪ Claude: --';
        const proText = pro ? `${getColorIcon(pro.percentage)} G Pro: ${pro.percentage}%` : '⚪ G Pro: --';
        const flashText = flash ? `${getColorIcon(flash.percentage)} G Flash: ${flash.percentage}%` : '⚪ G Flash: --';

        statusBarItem.text = `${claudeText}  ${proText}  ${flashText}`;

        // 【第一版核心功能】Markdown 表格式 Tooltip
        const model = models.find(m => m.name);
        let tooltipLines = [
            `**Antigravity 配额监控**`,
            ``,
            `👤 当前账号: ${current.email}`,
            ``,
            `| 模型 | 剩余 | 重置时间 |`,
            `|------|------|----------|`
        ];

        // 按固定顺序排序 tooltip 中的模型显示
        const sortedQuotas = [...mergedQuotas].sort((a, b) => {
            const order: Record<string, number> = { 'claude': 0, 'gemini-pro': 1, 'gemini-flash': 2 };
            return (order[a.model] ?? 99) - (order[b.model] ?? 99);
        });

        for (const q of sortedQuotas) {
            const displayName = q.model === 'claude' ? 'Claude Sonnet' :
                q.model === 'gemini-pro' ? 'Gemini 3 Pro' :
                    q.model === 'gemini-flash' ? 'Gemini 3 Flash' : q.model;
            const resetFormatted = formatResetTime(q.resetTime);
            tooltipLines.push(`| ${displayName} | ${q.percentage}% | ${resetFormatted} |`);
        }

        tooltipLines.push(``);
        tooltipLines.push(`📊 共管理 ${accounts.length} 个账号`);
        tooltipLines.push(``);
        tooltipLines.push(`_点击打开账号管理_`);

        const tooltip = new vscode.MarkdownString(tooltipLines.join('\n'));
        tooltip.isTrusted = true;
        statusBarItem.tooltip = tooltip;
    });
}

function getQuotaIcon(percentage: number): string {
    if (percentage >= 50) return '🟢';
    if (percentage >= 30) return '🟡';
    if (percentage >= 10) return '🟠';
    return '🔴';
}

// ============ 配额详情面板 ============

function showQuotaDetailsPanel(context: vscode.ExtensionContext) {
    const panel = vscode.window.createWebviewPanel(
        'antiQuotaDetails',
        'Anti Quota - 配额详情',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    const accounts = accountService.listAccounts();

    accountService.getCurrentAccount().then(current => {
        panel.webview.html = getQuotaDetailsHtml(accounts, current);
    });

    // 处理消息
    panel.webview.onDidReceiveMessage(async (data) => {
        switch (data.type) {
            case 'switch':
                try {
                    await accountService.switchAccount(data.accountId, data.mode);
                    vscode.window.showInformationMessage('切换成功');
                    // 刷新面板
                    accountService.getCurrentAccount().then(current => {
                        panel.webview.html = getQuotaDetailsHtml(accountService.listAccounts(), current);
                    });
                    updateStatusBar();
                    provider.refresh();
                } catch (error: any) {
                    vscode.window.showErrorMessage(`切换失败: ${error.message}`);
                }
                break;
            case 'refresh':
                try {
                    await accountService.fetchAccountQuota(data.accountId);
                    accountService.getCurrentAccount().then(current => {
                        panel.webview.html = getQuotaDetailsHtml(accountService.listAccounts(), current);
                    });
                    updateStatusBar();
                } catch (error: any) {
                    vscode.window.showErrorMessage(`刷新失败: ${error.message}`);
                }
                break;
        }
    }, undefined, context.subscriptions);
}

function getQuotaDetailsHtml(accounts: Account[], currentAccount: Account | null): string {
    const getQuotaColor = (percentage: number): string => {
        if (percentage >= 50) return '#4caf50';
        if (percentage >= 30) return '#ff9800';
        if (percentage >= 10) return '#ff5722';
        return '#f44336';
    };

    const accountCards = accounts.map(account => {
        const isCurrent = account.id === currentAccount?.id;
        // 按固定顺序排序模型：Claude Sonnet -> Gemini 3 Pro -> Gemini 3 Flash
        const sortedModels = account.quota?.models
            ? [...account.quota.models].sort((a, b) => {
                const order: Record<string, number> = { 'claude': 0, 'gemini-pro': 1, 'gemini-flash': 2 };
                return (order[a.name] ?? 99) - (order[b.name] ?? 99);
            })
            : [];
        const quotaHtml = sortedModels.length > 0 ? sortedModels.map(m => `
            <div class="quota-item">
                <div class="quota-label">${m.displayName}</div>
                <div class="quota-bar">
                    <div class="quota-fill" style="width: ${m.percentage}%; background: ${getQuotaColor(m.percentage)}"></div>
                </div>
                <div class="quota-value">${m.percentage}%</div>
            </div>
        `).join('') : '<div class="no-quota">无配额数据</div>';

        return `
            <div class="account-card ${isCurrent ? 'current' : ''} ${account.quota?.is_forbidden ? 'forbidden' : ''}">
                <div class="account-header">
                    <div class="account-info">
                        <div class="account-email">${account.email}</div>
                        ${isCurrent ? '<span class="badge current">当前</span>' : ''}
                        ${account.disabled ? '<span class="badge disabled">禁用</span>' : ''}
                        ${account.quota?.is_forbidden ? '<span class="badge forbidden">403</span>' : ''}
                    </div>
                    <div class="account-actions">
                        <button onclick="refresh('${account.id}')">🔄</button>
                        ${!isCurrent ? `
                            <button onclick="switchAccount('${account.id}', 'seamless')">⚡ 无感切换</button>
                        ` : ''}
                    </div>
                </div>
                <div class="quota-list">${quotaHtml}</div>
            </div>
        `;
    }).join('');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Anti Quota - 配额详情</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #fff;
            min-height: 100vh;
            padding: 24px;
        }
        h1 {
            text-align: center;
            margin-bottom: 24px;
            font-size: 24px;
            background: linear-gradient(90deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .accounts-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
            gap: 20px;
            max-width: 1200px;
            margin: 0 auto;
        }
        .account-card {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 16px;
            padding: 20px;
            transition: all 0.3s ease;
        }
        .account-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
        }
        .account-card.current {
            border-color: #4caf50;
            background: rgba(76, 175, 80, 0.1);
        }
        .account-card.forbidden {
            border-color: #f44336;
            background: rgba(244, 67, 54, 0.1);
        }
        .account-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
        }
        .account-email {
            font-size: 16px;
            font-weight: 600;
        }
        .badge {
            display: inline-block;
            font-size: 11px;
            padding: 3px 8px;
            border-radius: 12px;
            margin-left: 8px;
            font-weight: 500;
        }
        .badge.current { background: #4caf50; }
        .badge.disabled { background: #ff9800; }
        .badge.forbidden { background: #f44336; }
        .account-actions {
            display: flex;
            gap: 8px;
        }
        .account-actions button {
            background: rgba(255, 255, 255, 0.1);
            border: none;
            padding: 8px 16px;
            border-radius: 8px;
            color: #fff;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.2s;
        }
        .account-actions button:hover {
            background: rgba(255, 255, 255, 0.2);
        }
        .quota-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .quota-item {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .quota-label {
            width: 120px;
            font-size: 13px;
            color: rgba(255, 255, 255, 0.7);
        }
        .quota-bar {
            flex: 1;
            height: 8px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 4px;
            overflow: hidden;
        }
        .quota-fill {
            height: 100%;
            border-radius: 4px;
            transition: width 0.5s ease;
        }
        .quota-value {
            width: 50px;
            text-align: right;
            font-weight: 600;
            font-size: 14px;
        }
        .no-quota {
            color: rgba(255, 255, 255, 0.5);
            font-size: 13px;
            text-align: center;
            padding: 16px;
        }
        .stats {
            text-align: center;
            margin-top: 24px;
            color: rgba(255, 255, 255, 0.5);
            font-size: 13px;
        }
    </style>
</head>
<body>
    <h1>🔐 Anti Quota - 多账号配额管理</h1>
    <div class="accounts-grid">${accountCards}</div>
    <div class="stats">共 ${accounts.length} 个账号</div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        function switchAccount(id, mode) {
            vscode.postMessage({ type: 'switch', accountId: id, mode });
        }
        
        function refresh(id) {
            vscode.postMessage({ type: 'refresh', accountId: id });
        }
    </script>
</body>
</html>`;
}

// ============ 工具函数 ============

function log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    outputChannel.appendLine(`[${timestamp}] ${message}`);
}

// ============ 停用 ============

export function deactivate() {
    if (quotaRefreshTimer) clearInterval(quotaRefreshTimer);
    if (autoSwitchTimer) clearInterval(autoSwitchTimer);
    multiWindowService.dispose();
    statusBarItem?.dispose();
    log('Anti Quota 插件已停用');
}
