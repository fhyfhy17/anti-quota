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
// 记录用户拒绝切换的模型（key: accountId:modelName, value: 1）
let userRejectedModels: Set<string> = new Set();
// 记录上次的配额值，用于检测显著下降
let lastQuotaSnapshot: number = -1;

// 缓存的配额数据（用于 1% 阈值防跳动）
interface CachedQuota {
    model: string;
    percentage: number;
    resetTime: string;
}
let cachedQuotas: CachedQuota[] = [];

// ============ 激活 ============

export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Anti Quota');
    log('🚀 Anti Quota 插件已激活');

    // 自动解锁数据库权限（针对 V2.2.0 物理锁定方案的自我修复）
    try {
        const antigravityService = await import('./services/antigravityService');
        antigravityService.setDbFileWritable(true);
    } catch (e) {
        log(`解锁数据库失败: ${e}`);
    }

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

                        vscode.window.showInformationMessage(
                            mode.mode === 'seamless'
                                ? `⚡ 已无感切换到 ${selected.account.email}`
                                : `已切换到 ${selected.account.email}，请手动重启 Antigravity IDE`
                        );

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

    // 手动触发自动切换检查（用于测试）
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-quota.checkAndSwitch', async () => {
            log('手动触发自动切换检查...');
            await checkAndAutoSwitch();
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

            // 获取刷新后的最新配额
            const updatedAccount = await accountService.getCurrentAccount();
            const currentLowest = updatedAccount ? accountService.getLowestQuota(updatedAccount) : -1;

            // 检测配额是否显著下降（≥5%）
            if (lastQuotaSnapshot !== -1 && currentLowest !== -1) {
                const quotaDrop = lastQuotaSnapshot - currentLowest;
                if (quotaDrop >= 5) {
                    log(`⚡ 检测到配额显著下降: ${lastQuotaSnapshot}% → ${currentLowest}% (下降 ${quotaDrop}%)，立即触发自动切换检查`);
                    // 立即触发检查，不等待定时器
                    setTimeout(() => checkAndAutoSwitch(), 100);
                }
            }

            // 更新配额快照
            if (currentLowest !== -1) {
                lastQuotaSnapshot = currentLowest;
            }

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
    const enabled = config.get<boolean>('autoSwitch.enabled', DEFAULT_SETTINGS.autoSwitch.enabled);
    const interactive = config.get<boolean>('autoSwitch.interactive', DEFAULT_SETTINGS.autoSwitch.interactive);
    const notifyOnSwitch = config.get<boolean>('autoSwitch.notifyOnSwitch', DEFAULT_SETTINGS.autoSwitch.notifyOnSwitch);

    if (!enabled) return;

    // 多窗口环境下，只有主窗口可以执行自动切换控制逻辑
    if (!multiWindowService.canAutoSwitch()) {
        return;
    }

    try {
        // ✨ 先静默刷新所有账号的配额，确保数据是最新的
        log('🔄 自动切换检查：正在刷新所有账号配额...');
        const refreshResult = await accountService.refreshAllQuotas();
        log(`✅ 配额刷新完成: ${refreshResult.success} 成功, ${refreshResult.failed} 失败`);

        // 刷新后更新 UI
        updateStatusBar();
        provider.refresh();

        const current = await accountService.getCurrentAccount();
        if (!current?.quota?.models.length) return;

        // 获取分模型阈值
        const modelThresholds = config.get<any>('autoSwitch.thresholds', { claude: 0, 'gemini-pro': 0, 'gemini-flash': 0 });

        // 遍历当前账号的所有模型，检查是否需要切换
        for (const model of current.quota.models) {
            const thresholdValue = modelThresholds[model.name] || 0;

            // 如果该模型设定了阈值，且当前配额低于阈值
            if (thresholdValue > 0 && model.percentage < thresholdValue) {
                // 检查是否已经针对此账号的此模型点过“取消”
                const rejectionKey = `${current.id}:${model.name}`;
                if (userRejectedModels.has(rejectionKey)) {
                    log(`用户已取消 ${current.email} 的 ${model.displayName} 切换提示，跳过检查`);
                    continue;
                }

                log(`⚠️ 当前账号 ${current.email} 的模型 ${model.displayName} 配额不足: ${model.percentage}% (低于阈值 ${thresholdValue}%)`);

                // 尝试寻找更好的同类型账号
                const best = accountService.getBestAvailableAccountForModel(model.name, thresholdValue, model.percentage, current.id);

                if (!best) {
                    log(`没有更优的同类型账号可用（全都不高于阈值或不高于当前账号）`);
                    continue; // 检查下一个模型
                }

                const bestModelQuota = best.quota?.models.find(m => m.name === model.name)?.percentage ?? 0;
                log(`📊 找到更优账号: ${best.email} (${model.displayName} 配额 ${bestModelQuota}%)`);

                // 交互逻辑
                if (interactive) {
                    const message = `⚠️ 配额不足: 当前账号 ${current.email} 的 ${model.displayName} 仅剩 ${model.percentage}%。是否切换到更优账号 ${best.email} (${model.displayName} 为 ${bestModelQuota}%)？`;

                    // 只有“切换”和“取消”按钮
                    const action = await vscode.window.showWarningMessage(message, { modal: true }, '切换', '取消');

                    if (action === '取消' || !action) {
                        userRejectedModels.add(rejectionKey);
                        log(`用户点击了取消，后续不再弹出 ${current.email} 的 ${model.displayName} 切换提示`);
                        continue; // 检查下一个模型
                    }
                }

                // 执行切换
                log(`🚀 正在执行自动切换到 ${best.email}...`);
                statusBarItem.text = `$(sync~spin) 自动切换中...`;

                try {
                    await accountService.switchAccount(best.id, 'seamless');
                    multiWindowService.recordSwitch(best.id);

                    log(`✅ 切换成功: ${best.email}`);

                    if (notifyOnSwitch && !interactive) {
                        vscode.window.showInformationMessage(`⚡ ${model.displayName} 配额低于 ${thresholdValue}%，已自动切换到 ${best.email} (${bestModelQuota}%)`);
                    }

                    updateStatusBar();
                    provider.refresh();

                    // 切换成功后退出整个检查流程，新账号会由下一次定时检查负责
                    return;
                } catch (switchError: any) {
                    log(`❌ 切换失败: ${switchError.message}`);
                    vscode.window.showErrorMessage(`自动切换失败: ${switchError.message}`);
                    // 切换失败了，由于当前账号配额依然低，我们不必标记 userRejectedModels，下次还会尝试（可能针对另一个 best 账号）
                    return;
                }
            }
        }

        const currentLowest = accountService.getLowestQuota(current);
        log(`✅ 当前账号 ${current.email} 所有设定阈值的模型配额均充足 (最低: ${currentLowest}%)`);

    } catch (error) {
        log(`自动切换逻辑异常: ${error}`);
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
