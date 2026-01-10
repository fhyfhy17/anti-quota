/**
 * 账号切换服务 - 不能杀进程，只能注入 Token + Reload Window
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Account } from '../types/account';
import * as oauthService from './oauthService';

export class DirectSwitchService {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Anti Quota - 直接切换');
    }

    private log(message: string): void {
        const timestamp = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${timestamp}] ${message}`);
        console.log(`[DirectSwitch] ${message}`);
    }

    async switchAccount(account: Account): Promise<{
        success: boolean;
        error?: string;
    }> {
        this.outputChannel.clear();
        this.outputChannel.show();

        try {
            this.log('========== 开始账号切换 (独立进程模式) ==========');
            this.log(`目标账号: ${account.email}`);

            // 1. 确保 Token 有效
            const now = Math.floor(Date.now() / 1000);
            if (!account.token.access_token || account.token.expiry_timestamp < now + 300) {
                this.log('Token 即将过期，正在刷新...');
                try {
                    const tokenRes = await oauthService.refreshAccessToken(account.token.refresh_token);
                    account.token.access_token = tokenRes.access_token;
                    account.token.expires_in = tokenRes.expires_in;
                    account.token.expiry_timestamp = now + tokenRes.expires_in;
                    this.log('✓ Token 刷新成功');
                } catch (error) {
                    throw new Error(`Token 刷新失败: ${error}`);
                }
            }

            // 2. 准备脚本路径
            const scriptPath = path.join(__dirname, '../../scripts/switch_account.js');
            if (!fs.existsSync(scriptPath)) {
                throw new Error(`找不到切换脚本: ${scriptPath}`);
            }

            // 3. 启动独立进程
            this.log('正在启动独立切换进程...');
            this.log(`Script: ${scriptPath}`);

            const child = require('child_process').spawn('node', [
                scriptPath,
                account.token.access_token,
                account.token.refresh_token,
                Math.floor(account.token.expiry_timestamp).toString(),
                account.email
            ], {
                detached: true,
                stdio: 'ignore'
            });

            if (child.disconnect) child.disconnect();
            child.unref();

            this.log('✓ 独立进程已启动 (PID: ' + child.pid + ')');
            this.log('插件任务完成，Antigravity 将在 3 秒后自动重启...');

            vscode.window.showInformationMessage(`✅ 切换任务已移交后台 (PID: ${child.pid})。\n\nAntigravity 即将自动重启，在此期间请勿手动操作。`);

            return { success: true };

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.log(`❌ 启动失败: ${msg}`);
            vscode.window.showErrorMessage(`切换失败: ${msg}`);
            return { success: false, error: msg };
        }
    }
}
