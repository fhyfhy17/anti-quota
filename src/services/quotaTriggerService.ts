/**
 * 配额触发服务 - 核心 API
 * 
 * 对 Claude 模型发送请求，触发倒计时恢复
 */

import * as https from 'https';
import { Account } from '../types/account';
import * as oauthService from './oauthService';

// Cloud Code API 主机
const CLOUD_CODE_API_HOST = 'cloudcode-pa.googleapis.com';

export interface TriggerResult {
    account: string;
    model: string;
    success: boolean;
    message: string;
}

/**
 * 封装 HTTPS 请求
 */
function httpsRequest(host: string, path: string, accessToken: string, extraHeaders: any, body: any): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(body);
        const req = https.request({
            hostname: host,
            port: 443,
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                'Content-Length': Buffer.byteLength(postData),
                ...extraHeaders
            },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode || 0, data: { raw: data } });
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

/**
 * 获取 Project ID
 */
async function fetchProjectId(accessToken: string): Promise<string> {
    const DEFAULT_PROJECT_ID = 'bamboo-precept-lgxtn';
    try {
        const res = await httpsRequest(CLOUD_CODE_API_HOST, '/v1internal:loadCodeAssist', accessToken, {
            'User-Agent': 'antigravity/1.11.3 Darwin/arm64'
        }, {});

        if (res.status === 200) {
            const projectId = res.data?.cloudaicompanionProject || res.data?.cloudaicompanion_project;
            if (projectId) return projectId;
        }
        return DEFAULT_PROJECT_ID;
    } catch {
        return DEFAULT_PROJECT_ID;
    }
}

/**
 * 确保账号的 access_token 有效
 */
export async function ensureValidToken(account: Account): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    // Token 还有效（至少还有 5 分钟）
    if (account.token.access_token && account.token.expiry_timestamp > now + 300) {
        return account.token.access_token;
    }

    // 需要刷新
    const tokenRes = await oauthService.refreshAccessToken(account.token.refresh_token);
    account.token.access_token = tokenRes.access_token;
    account.token.expires_in = tokenRes.expires_in;
    account.token.expiry_timestamp = now + tokenRes.expires_in;

    return account.token.access_token;
}

/**
 * 对单个模型发送最小请求，触发配额消耗/倒计时
 * 
 * @param account 账号
 * @param modelName 模型名 ('claude' | 'gemini-2.5-pro' 等)
 * @returns 触发结果
 */
export async function triggerModel(account: Account, modelName: string): Promise<TriggerResult> {
    try {
        const accessToken = await ensureValidToken(account);
        const projectId = await fetchProjectId(accessToken);

        // Claude 使用 gpt-oss-120b-medium 作为代理触发
        // （因为它们共享配额池，且 gpt-oss 可以返回 200 OK）
        const proxyModelId = modelName === 'claude' ? 'gpt-oss-120b-medium' : modelName;

        const payload = {
            project: projectId,
            model: proxyModelId,
            request: {
                contents: [{
                    role: 'user',
                    parts: [{ text: 'Generate a short sentence to verify quota.' }]
                }],
                generationConfig: {
                    maxOutputTokens: 10,
                    temperature: 0.1
                }
            }
        };

        console.log(`[QuotaTrigger] Triggering ${account.email} - ${modelName} (Proxy: ${proxyModelId}, Project: ${projectId})`);

        const result = await httpsRequest(CLOUD_CODE_API_HOST, '/v1internal:generateContent', accessToken, {
            'User-Agent': 'antigravity/1.11.3 Darwin/arm64',
            'X-Goog-Api-Client': 'antigravity-ide/0.2.0'
        }, payload);

        console.log(`[QuotaTrigger] Response for ${modelName}: status=${result.status}`);

        if (result.status === 200 || result.status === 201 || result.status === 429) {
            return {
                account: account.email,
                model: modelName,
                success: true,
                message: result.status === 429 ? '触发成功 (已耗尽)' : '触发成功'
            };
        } else {
            const errorMsg = result.data?.error?.message || JSON.stringify(result.data).substring(0, 100);
            return {
                account: account.email,
                model: modelName,
                success: false,
                message: `HTTP ${result.status}: ${errorMsg}`
            };
        }
    } catch (error: any) {
        return {
            account: account.email,
            model: modelName,
            success: false,
            message: error.message
        };
    }
}

/**
 * 批量触发触发条件：
 * - percentage === 100（配额满，未使用，倒计时未启动）
 * - 只触发 Claude 模型（Gemini 暂不支持）
 */
export interface BatchTriggerResult {
    total: number;
    triggered: number;
    success: number;
    failed: number;
    results: TriggerResult[];
}

/**
 * 一键触发所有满配额的 Claude 模型
 * 
 * @param accounts 账号列表
 * @param onProgress 进度回调
 * @returns 批量触发结果
 */
export async function triggerAllFullQuotas(
    accounts: Account[],
    onProgress?: (current: number, total: number, result: TriggerResult) => void
): Promise<BatchTriggerResult> {
    const results: TriggerResult[] = [];

    // 收集需要触发的目标：percentage === 100 的 Claude 模型
    const targets: { account: Account; model: string }[] = [];

    for (const account of accounts) {
        // 跳过禁用和 403 账号
        if (account.disabled || account.quota?.is_forbidden) continue;

        const claudeModel = account.quota?.models.find(m => m.name === 'claude');
        if (claudeModel && claudeModel.percentage === 100) {
            targets.push({ account, model: 'claude' });
        }
    }

    console.log(`[QuotaTrigger] Found ${targets.length} targets to trigger`);

    let success = 0;
    let failed = 0;

    for (let i = 0; i < targets.length; i++) {
        const { account, model } = targets[i];
        const result = await triggerModel(account, model);
        results.push(result);

        if (result.success) {
            success++;
        } else {
            failed++;
        }

        if (onProgress) {
            onProgress(i + 1, targets.length, result);
        }
    }

    return {
        total: targets.length,
        triggered: targets.length,
        success,
        failed,
        results
    };
}
