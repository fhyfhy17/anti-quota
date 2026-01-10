/**
 * Codeium 扩展 Patch 服务
 * 
 * 参考 WindsurfSwitch 实现原理：
 * 1. 修改 Antigravity 的 Codeium 扩展核心文件
 * 2. 注入自定义命令 codeium.switchAccountNoAuth
 * 3. 绕过服务器验证，直接写入会话
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

export interface PatchResult {
    success: boolean;
    error?: string;
}

export interface PatchCheckResult {
    needsRestart: boolean;
    error?: string;
}

export interface PermissionCheckResult {
    hasPermission: boolean;
    error?: string;
}

export class CodeiumPatchService {
    // 补丁标识关键字
    private static readonly PATCH_KEYWORD_1 = "codeium.switchAccountNoAuth";
    private static readonly PATCH_KEYWORD_2 = "handleAuthTokenNoAuth";

    /**
     * 获取 Codeium 扩展路径
     */
    private static getCodeiumExtensionPath(): string | null {
        try {
            // Antigravity 的 AI 功能在 jetskiAgent 中，不是作为扩展存在
            const possiblePaths = [
                // macOS - Antigravity
                '/Applications/Antigravity.app/Contents/Resources/app/out/jetskiAgent/main.js',
                path.join(os.homedir(), 'Applications/Antigravity.app/Contents/Resources/app/out/jetskiAgent/main.js'),

                // macOS - Windsurf (作为备用)
                '/Applications/Windsurf.app/Contents/Resources/app/extensions/codeium.windsurf/dist/extension.js',

                // Linux - Antigravity
                '/usr/share/antigravity/resources/app/out/jetskiAgent/main.js',
                '/opt/Antigravity/resources/app/out/jetskiAgent/main.js',

                // Windows - Antigravity
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'resources', 'app', 'out', 'jetskiAgent', 'main.js'),
                path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Antigravity', 'resources', 'app', 'out', 'jetskiAgent', 'main.js'),
            ];

            for (const p of possiblePaths) {
                if (fs.existsSync(p)) {
                    console.log(`[CodeiumPatch] 找到 AI 核心文件: ${p}`);
                    return p;
                }
            }

            console.error('[CodeiumPatch] 未找到 AI 核心文件');
            return null;
        } catch (error) {
            console.error('[CodeiumPatch] 搜索文件路径失败:', error);
            return null;
        }
    }

    /**
     * 检查文件是否可写
     */
    private static isFileWritable(filePath: string): boolean {
        try {
            fs.accessSync(filePath, fs.constants.W_OK);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 获取权限修复建议
     */
    private static getPermissionFixSuggestion(filePath: string): string {
        const platform = os.platform();

        if (platform === 'darwin') {
            return `请在终端运行:\nsudo chmod 666 "${filePath}"`;
        } else if (platform === 'linux') {
            return `请在终端运行:\nsudo chmod 666 "${filePath}"`;
        } else if (platform === 'win32') {
            return `请以管理员身份运行 PowerShell:\nicacls "${filePath}" /grant Users:F`;
        }

        return '请授予文件写入权限';
    }

    /**
     * 检查补丁是否已应用
     */
    static async isPatchApplied(): Promise<boolean> {
        console.log('[CodeiumPatch] 检查补丁是否已应用...');

        try {
            const extensionPath = this.getCodeiumExtensionPath();
            if (!extensionPath) {
                console.warn('[CodeiumPatch] 无法获取 Codeium 扩展路径');
                return false;
            }

            const fileContent = fs.readFileSync(extensionPath, 'utf-8');

            const hasKeyword1 = fileContent.includes(this.PATCH_KEYWORD_1);
            const hasKeyword2 = fileContent.includes(this.PATCH_KEYWORD_2);

            const isApplied = hasKeyword1 && hasKeyword2;
            console.log(`[CodeiumPatch] 补丁${isApplied ? '已应用' : '未应用'}`);

            return isApplied;
        } catch (error) {
            console.error('[CodeiumPatch] 检查补丁失败:', error);
            return false;
        }
    }

    /**
     * 检查写入权限
     */
    static checkWritePermission(): PermissionCheckResult {
        console.log('[CodeiumPatch] 检查写入权限...');

        try {
            const extensionPath = this.getCodeiumExtensionPath();

            if (!extensionPath) {
                return {
                    hasPermission: false,
                    error: "未找到 Antigravity 安装。请确保 Antigravity IDE 已安装。"
                };
            }

            if (!fs.existsSync(extensionPath)) {
                return {
                    hasPermission: false,
                    error: `Codeium 扩展文件不存在: ${extensionPath}`
                };
            }

            if (!this.isFileWritable(extensionPath)) {
                const suggestion = this.getPermissionFixSuggestion(extensionPath);
                return {
                    hasPermission: false,
                    error: `文件权限不足: ${extensionPath}\n\n${suggestion}`
                };
            }

            console.log('[CodeiumPatch] 权限检查通过');
            return {
                hasPermission: true
            };
        } catch (error) {
            return {
                hasPermission: false,
                error: `权限检查失败: ${error instanceof Error ? error.message : '未知错误'}`
            };
        }
    }

    /**
     * 应用补丁
     * 
     * 实现原理：
     * 1. 找到原有的 handleAuthToken 函数
     * 2. 复制一份命名为 handleAuthTokenNoAuth（去掉服务器验证）
     * 3. 注册新命令 codeium.switchAccountNoAuth
     */
    static async applyPatch(): Promise<PatchResult> {
        console.log('[CodeiumPatch] 开始应用补丁...');

        try {
            const extensionPath = this.getCodeiumExtensionPath();
            if (!extensionPath) {
                return {
                    success: false,
                    error: "未找到 Antigravity 安装"
                };
            }

            // 检查权限
            const permissionCheck = this.checkWritePermission();
            if (!permissionCheck.hasPermission) {
                return {
                    success: false,
                    error: permissionCheck.error
                };
            }

            // 读取原始文件
            console.log('[CodeiumPatch] 读取原始文件...');
            let fileContent = fs.readFileSync(extensionPath, 'utf-8');
            const originalSize = fileContent.length;

            // 备份原始文件
            const backupPath = extensionPath + '.backup';
            if (!fs.existsSync(backupPath)) {
                fs.writeFileSync(backupPath, fileContent, 'utf-8');
                console.log(`[CodeiumPatch] 已备份原始文件到: ${backupPath}`);
            }

            // 【第一步】查找 handleAuthToken 函数
            // 这里需要根据实际的 Codeium 扩展代码来调整
            // 目前先提供一个通用的注入点

            // 尝试找到命令注册的位置
            const commandRegistrationPattern = /commands\.registerCommand\s*\(\s*['"](codeium\.|windsurf\.)/;
            const match = fileContent.match(commandRegistrationPattern);

            if (!match) {
                return {
                    success: false,
                    error: '未找到命令注册点。Codeium 扩展版本可能不兼容。\n\n请检查扩展版本或手动应用补丁。'
                };
            }

            // 【第二步】注入新命令
            // 在找到的命令注册附近注入我们的自定义命令
            const injectionCode = `
// ========== Anti Quota Patch START ==========
// 无感换号自定义命令
commands.registerCommand("codeium.switchAccountNoAuth", async (params) => {
    try {
        const { apiKey, email, name } = params;
        
        // 直接构造会话对象（绕过服务器验证）
        const session = {
            id: require('crypto').randomUUID(),
            accessToken: apiKey,
            account: {
                label: name || email,
                id: email
            },
            scopes: []
        };
        
        // 写入 secrets（模拟 handleAuthToken 的行为）
        await context.secrets.store('codeium.sessions', JSON.stringify([session]));
        
        // 触发会话变更事件
        // 这里需要根据实际扩展实现来调整
        
        console.log('[Anti Quota] 账号切换成功:', email);
        
        return { success: true, session };
    } catch (error) {
        console.error('[Anti Quota] 账号切换失败:', error);
        return { success: false, error: error.message };
    }
});
// ========== Anti Quota Patch END ==========
`;

            // 在第一个命令注册之前插入我们的代码
            const insertIndex = fileContent.indexOf(match[0]);
            fileContent = fileContent.substring(0, insertIndex) +
                injectionCode +
                fileContent.substring(insertIndex);

            // 写入修改后的文件
            console.log('[CodeiumPatch] 写入修改后的文件...');
            fs.writeFileSync(extensionPath, fileContent, 'utf-8');

            // 验证
            const verificationContent = fs.readFileSync(extensionPath, 'utf-8');
            const hasKeyword = verificationContent.includes(this.PATCH_KEYWORD_1);

            if (hasKeyword) {
                console.log('[CodeiumPatch] 补丁应用成功');
                console.log(`[CodeiumPatch] 文件大小: ${originalSize} -> ${fileContent.length} (+${fileContent.length - originalSize}字节)`);
                return {
                    success: true
                };
            } else {
                return {
                    success: false,
                    error: "补丁验证失败"
                };
            }

        } catch (error) {
            console.error('[CodeiumPatch] 补丁应用失败:', error);
            return {
                success: false,
                error: `补丁失败: ${error instanceof Error ? error.message : '未知错误'}`
            };
        }
    }

    /**
     * 检查并应用补丁（如果需要）
     */
    static async checkAndApplyPatch(): Promise<PatchCheckResult> {
        console.log('[CodeiumPatch] 开始检查并应用补丁...');

        try {
            // 1. 检查补丁是否已应用
            if (await this.isPatchApplied()) {
                console.log('[CodeiumPatch] 补丁已应用，无需重新应用');
                return {
                    needsRestart: false
                };
            }

            console.log('[CodeiumPatch] 补丁未应用，需要应用补丁');

            // 2. 检查权限
            const permissionCheck = this.checkWritePermission();
            if (!permissionCheck.hasPermission) {
                return {
                    needsRestart: false,
                    error: permissionCheck.error
                };
            }

            // 3. 应用补丁
            const patchResult = await this.applyPatch();
            if (!patchResult.success) {
                return {
                    needsRestart: false,
                    error: patchResult.error
                };
            }

            // 4. 补丁成功，需要重启
            console.log('[CodeiumPatch] 补丁应用成功，需要重启 IDE');
            return {
                needsRestart: true
            };

        } catch (error) {
            return {
                needsRestart: false,
                error: `补丁流程失败: ${error instanceof Error ? error.message : '未知错误'}`
            };
        }
    }

    /**
     * 移除补丁（恢复原始文件）
     */
    static async removePatch(): Promise<PatchResult> {
        console.log('[CodeiumPatch] 移除补丁...');

        try {
            const extensionPath = this.getCodeiumExtensionPath();
            if (!extensionPath) {
                return {
                    success: false,
                    error: "未找到 Codeium 扩展"
                };
            }

            const backupPath = extensionPath + '.backup';
            if (!fs.existsSync(backupPath)) {
                return {
                    success: false,
                    error: "未找到备份文件"
                };
            }

            // 恢复备份
            const backupContent = fs.readFileSync(backupPath, 'utf-8');
            fs.writeFileSync(extensionPath, backupContent, 'utf-8');

            console.log('[CodeiumPatch] 补丁已移除，已恢复原始文件');
            return {
                success: true
            };

        } catch (error) {
            return {
                success: false,
                error: `移除补丁失败: ${error instanceof Error ? error.message : '未知错误'}`
            };
        }
    }

    /**
     * 获取补丁状态信息
     */
    static async getPatchInfo(): Promise<{
        isPatched: boolean;
        extensionPath: string | null;
        hasPermission: boolean;
        backupExists: boolean;
    }> {
        const extensionPath = this.getCodeiumExtensionPath();
        const isPatched = await this.isPatchApplied();
        const permissionCheck = this.checkWritePermission();

        const backupPath = extensionPath ? extensionPath + '.backup' : null;
        const backupExists = backupPath ? fs.existsSync(backupPath) : false;

        return {
            isPatched,
            extensionPath,
            hasPermission: permissionCheck.hasPermission,
            backupExists
        };
    }
}
