import * as vscode from 'vscode';

/**
 * Antigravity 内部认证服务桥接
 * 
 * 通过 ExtHostAntigravityAuthService 直接调用 IDE 内部 API
 * 实现真正的静默账号切换，无需重启
 */
export class AntigravityAuthBridge {

    /**
     * 尝试通过扩展主机 API 更新认证状态
     * 
     * @param authData 认证数据 { email, apiKey, name }
     * @returns 是否成功调用 API
     */
    public static async updateAuthStatus(authData: {
        email: string;
        apiKey: string;
        name?: string;
    }): Promise<boolean> {
        try {
            console.log('[AuthBridge] 尝试通过内部 API 更新认证状态...');

            // 方法 1: 尝试通过 vscode 扩展 API (如果暴露)
            // @ts-ignore - 访问可能存在的内部 API
            const antigravityAPI = vscode?.extensions?.getExtension('antigravity-internal')?.exports;

            if (antigravityAPI?.setAntigravityAuthStatus) {
                console.log('[AuthBridge] ✅ 发现 Antigravity 内部 API');
                await antigravityAPI.setAntigravityAuthStatus({
                    email: authData.email,
                    apiKey: authData.apiKey,
                    name: authData.name || authData.email.split('@')[0]
                });
                return true;
            }

            // 方法 2: 尝试通过命令调用
            const updateCommands = [
                'antigravity.updateAuthStatus',
                'antigravity.setAuthStatus',
                '_antigravity.auth.update'
            ];

            for (const cmd of updateCommands) {
                try {
                    const commands = await vscode.commands.getCommands();
                    if (commands.includes(cmd)) {
                        console.log(`[AuthBridge] 发现命令: ${cmd}`);
                        await vscode.commands.executeCommand(cmd, authData);
                        return true;
                    }
                } catch (e) {
                    // 继续尝试下一个
                }
            }

            console.log('[AuthBridge] ❌ 未找到可用的内部 API');
            return false;

        } catch (error: any) {
            console.error('[AuthBridge] 调用失败:', error.message);
            return false;
        }
    }

    /**
     * 检查是否支持静默更新
     */
    public static async isSupported(): Promise<boolean> {
        try {
            // @ts-ignore
            const antigravityAPI = vscode?.extensions?.getExtension('antigravity-internal')?.exports;
            return !!antigravityAPI?.setAntigravityAuthStatus;
        } catch {
            return false;
        }
    }
}
