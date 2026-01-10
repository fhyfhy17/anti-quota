/**
 * 账号切换服务（合规版：官方登录 + reload）
 *
 * 目标：
 * - 点击“⚡ 无感切换”时，不做任何注入/篡改/绕过。
 * - 触发 Antigravity 官方登录流程，让用户在 UI 中选择账号。
 * - 登录完成后自动 reload window，使新账号生效。
 */

import * as vscode from 'vscode';
import { Account } from '../types/account';
import * as antigravityService from './antigravityService';
import * as oauthService from './oauthService';

export class SeamlessSwitchService {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Anti Quota - 无感换号');
    }

    private log(message: string): void {
        const timestamp = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${timestamp}] ${message}`);
        console.log(`[SeamlessSwitch] ${message}`);
    }

    showLog(): void {
        this.outputChannel.show();
    }

    async switchAccount(account: Account): Promise<{
        success: boolean;
        error?: string;
        method?: 'officialLoginReload' | 'failed';
    }> {
        this.outputChannel.clear();

        try {
            this.log('========== 启动账号切换（官方登录 + 刷新窗口）==========');
            this.log(`目标账号: ${account.email}`);

            // 使用 withProgress 显示持续的进度提示
            return await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `⚡ 正在切换到账号: ${account.email}`,
                cancellable: true
            }, async (progress, token) => {

                // 检查是否取消
                if (token.isCancellationRequested) {
                    this.log('用户取消了切换');
                    return { success: false, error: '用户取消', method: 'failed' };
                }

                progress.report({ increment: 10, message: '准备打开登录窗口...' });

                // 先显示一个明确的提示
                const choice = await vscode.window.showInformationMessage(
                    `🔄 即将切换到: ${account.email}\n\n点击"继续"后，请在弹出的登录窗口中选择该账号。\n如果没有弹出，请手动点击 IDE 左下角的账号图标。`,
                    { modal: true },
                    '继续',
                    '取消'
                );

                if (choice !== '继续') {
                    this.log('用户取消了切换');
                    return { success: false, error: '用户取消', method: 'failed' };
                }

                progress.report({ increment: 20, message: '正在打开登录窗口...' });

                const authChangedPromise = this.waitForAntigravityAuthChange(90_000);

                try {
                    await this.triggerAntigravityLogin();
                    this.log('已触发登录命令');
                } catch (error) {
                    this.log(`触发登录失败: ${error}`);
                    vscode.window.showWarningMessage(
                        `无法自动打开登录窗口。\n\n请手动操作：\n1. 点击 IDE 左下角的账号图标\n2. 选择 "${account.email}"\n3. 完成后点击下方"已完成登录"按钮`,
                        '已完成登录',
                        '取消'
                    ).then(action => {
                        if (action === '已完成登录') {
                            vscode.commands.executeCommand('workbench.action.reloadWindow');
                        }
                    });
                    return { success: false, error: '无法触发登录', method: 'failed' };
                }

                progress.report({ increment: 30, message: '等待您完成登录（最多90秒）...' });

                const authChanged = await authChangedPromise;

                if (!authChanged) {
                    this.log('⚠️  未检测到认证会话变更（可能取消登录或超时）');
                    const retry = await vscode.window.showWarningMessage(
                        '未检测到登录变更。\n\n可能原因：\n- 您取消了登录\n- 登录超时\n- 您选择了相同的账号\n\n是否仍然刷新窗口？',
                        { modal: true },
                        '刷新窗口',
                        '取消'
                    );
                    if (retry !== '刷新窗口') {
                        return { success: false, error: '未检测到登录变更', method: 'failed' };
                    }
                } else {
                    this.log('✅ 检测到认证会话变更');
                }

                progress.report({ increment: 40, message: '验证登录账号...' });

                // 尝试确认当前登录邮箱
                const actualEmail = await this.tryGetCurrentIdeEmail();
                if (actualEmail) {
                    this.log(`当前 IDE 登录账号: ${actualEmail}`);
                    if (actualEmail !== account.email) {
                        const action = await vscode.window.showWarningMessage(
                            `⚠️ 检测到您登录的是: ${actualEmail}\n但目标账号是: ${account.email}\n\n是否仍然刷新窗口？`,
                            { modal: true },
                            '仍然刷新',
                            '取消'
                        );
                        if (action !== '仍然刷新') {
                            this.log('用户取消刷新，切换流程终止');
                            return { success: false, error: '账号不匹配，用户取消', method: 'failed' };
                        }
                    }
                } else {
                    this.log('⚠️  无法确认当前登录邮箱（将直接刷新窗口）');
                }

                progress.report({ increment: 50, message: '正在刷新窗口...' });
                this.log('执行刷新窗口以应用账号切换...');

                await vscode.commands.executeCommand('workbench.action.reloadWindow');
                return { success: true, method: 'officialLoginReload' };
            });

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.log(`❌ 切换失败: ${msg}`);
            vscode.window.showErrorMessage(`切换失败: ${msg}`);
            return { success: false, error: msg, method: 'failed' };
        }
    }

    /**
     * 检查是否支持（是否能触发官方登录）
     */
    async isGracefulSwitchSupported(): Promise<boolean> {
        try {
            const commands = await vscode.commands.getCommands(true);
            if (commands.includes('antigravity.login')) {
                return true;
            }
            // @ts-ignore
            return !!vscode.authentication?.getSession;
        } catch {
            return false;
        }
    }

    private async triggerAntigravityLogin(): Promise<void> {
        const commands = await vscode.commands.getCommands(true);

        if (commands.includes('antigravity.login')) {
            this.log('触发命令: antigravity.login');
            await vscode.commands.executeCommand('antigravity.login');
            return;
        }

        // 兜底：使用 VS Code Authentication API（会弹出账号选择/登录）
        // 注意：这不保证“直接切到指定邮箱”，只能让用户在官方 UI 中选择。
        // @ts-ignore - 兼容旧版本类型
        const auth = vscode.authentication;
        if (auth?.getSession) {
            this.log('触发 vscode.authentication.getSession(antigravity_auth)');
            // @ts-ignore - clearSessionPreference 在部分版本可用
            await auth.getSession('antigravity_auth', [], { createIfNone: true, clearSessionPreference: true });
            return;
        }

        throw new Error('无法触发 Antigravity 登录：未找到 antigravity.login，且当前 VS Code API 不支持 authentication.getSession');
    }

    private waitForAntigravityAuthChange(timeoutMs: number): Promise<boolean> {
        return new Promise(resolve => {
            // @ts-ignore - 兼容旧版本类型
            const auth = vscode.authentication;
            if (!auth?.onDidChangeSessions) {
                resolve(false);
                return;
            }

            let done = false;
            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                disposable.dispose();
                resolve(false);
            }, timeoutMs);

            const disposable = auth.onDidChangeSessions((e: any) => {
                try {
                    const providerId = e?.provider?.id || e?.authenticationProvider?.id;
                    if (providerId !== 'antigravity_auth') {
                        return;
                    }
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    disposable.dispose();
                    resolve(true);
                } catch {
                    // ignore
                }
            });
        });
    }

    private async tryGetCurrentIdeEmail(): Promise<string | null> {
        try {
            const current = await antigravityService.getCurrentAccountFromEditor();
            if (!current?.accessToken) {
                return null;
            }
            const userInfo = await oauthService.getUserInfo(current.accessToken);
            return userInfo?.email || null;
        } catch {
            return null;
        }
    }
}
