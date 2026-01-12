/**
 * 账号管理服务
 * 处理账号的增删改查、配额获取等
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import { Account, QuotaData, ModelQuota } from '../types/account';
import * as oauthService from './oauthService';
import * as antigravityService from './antigravityService';
import * as multiWindowService from './multiWindowService';
import * as oauthCallbackServer from './oauthCallbackServer';
import * as vscode from 'vscode';

// Google Cloud Code API
const CLOUD_CODE_API_BASE = 'cloudcode-pa.googleapis.com';
const FETCH_MODELS_PATH = '/v1internal:fetchAvailableModels';
const LOAD_CODE_ASSIST_PATH = '/v1internal:loadCodeAssist';

// 账号缓存和最后读取时间（用于多窗口同步）
let cachedAccounts: Account[] | null = null;
let lastReadTime = 0;
const CACHE_TTL = 2000; // 2秒缓存

// ============ 存储管理 ============

function getStoragePath(): string {
    const homeDir = os.homedir();
    const storagePath = path.join(homeDir, '.anti-quota', 'accounts.json');
    const dir = path.dirname(storagePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return storagePath;
}

/** 读取账号列表（带缓存，多窗口友好） */
export function listAccounts(): Account[] {
    const now = Date.now();

    // 如果缓存有效，直接返回
    if (cachedAccounts && now - lastReadTime < CACHE_TTL) {
        return cachedAccounts;
    }

    try {
        const storagePath = getStoragePath();
        if (!fs.existsSync(storagePath)) {
            cachedAccounts = [];
            lastReadTime = now;
            return [];
        }
        const data = fs.readFileSync(storagePath, 'utf-8');
        cachedAccounts = JSON.parse(data);
        lastReadTime = now;
        return cachedAccounts || [];
    } catch (error) {
        console.error('Failed to read accounts:', error);
        return cachedAccounts || [];
    }
}

/** 强制刷新账号缓存 */
export function invalidateCache(): void {
    cachedAccounts = null;
    lastReadTime = 0;
}

/** 保存账号列表（使用文件锁） */
async function saveAccountsAsync(accounts: Account[]): Promise<void> {
    await multiWindowService.withLock(() => {
        const storagePath = getStoragePath();
        fs.writeFileSync(storagePath, JSON.stringify(accounts, null, 2));
        cachedAccounts = accounts;
        lastReadTime = Date.now();
    });
}

/** 保存账号列表（同步版本，用于简单操作） */
function saveAccounts(accounts: Account[]): void {
    const storagePath = getStoragePath();
    fs.writeFileSync(storagePath, JSON.stringify(accounts, null, 2));
    cachedAccounts = accounts;
    lastReadTime = Date.now();
}

/** 生成唯一 ID */
function generateId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// ============ 账号操作 ============

/** 获取当前账号（匹配 IDE 数据库中的账号，自动同步） */
export async function getCurrentAccount(): Promise<Account | null> {
    let accounts = listAccounts();

    // 尝试从 IDE 获取当前登录的账号
    try {
        const dbAccount = await antigravityService.getCurrentAccountFromEditor();
        if (dbAccount?.refreshToken && dbAccount?.accessToken) {
            // 检查列表中是否存在（先按 refresh_token，再按 email）
            let matched = accounts.find(a => a.token.refresh_token === dbAccount.refreshToken);

            if (matched) {
                // 已存在，同步最新的 access_token
                const now = Math.floor(Date.now() / 1000);
                if (matched.token.access_token !== dbAccount.accessToken) {
                    matched.token.access_token = dbAccount.accessToken;
                    matched.token.expiry_timestamp = now + 3600;
                    matched.last_used = now;
                    // 清除 403 状态，重新获取配额
                    if (matched.quota?.is_forbidden) {
                        matched.quota = undefined;
                    }
                    saveAccounts(accounts);
                    console.log('[Account] Synced token from IDE for:', matched.email);
                }
                return matched;
            } else {
                // 尝试获取用户信息，看是否按 email 已存在
                console.log('[Account] Checking if account exists by email...');
                try {
                    const userInfo = await oauthService.getUserInfo(dbAccount.accessToken);
                    const now = Math.floor(Date.now() / 1000);

                    // 按 email 查找是否已存在
                    const existingByEmail = accounts.find(a => a.email === userInfo.email);
                    if (existingByEmail) {
                        // 邮箱已存在，更新 token（用户可能重新授权了）
                        existingByEmail.token = {
                            access_token: dbAccount.accessToken,
                            refresh_token: dbAccount.refreshToken,
                            expires_in: 3600,
                            expiry_timestamp: now + 3600,
                            token_type: 'Bearer'
                        };
                        existingByEmail.last_used = now;
                        // 清除 403 状态
                        if (existingByEmail.quota?.is_forbidden) {
                            existingByEmail.quota = undefined;
                        }
                        saveAccounts(accounts);
                        console.log('[Account] Updated existing account with new token:', userInfo.email);
                        return existingByEmail;
                    }

                    // 完全不存在，自动添加到列表
                    console.log('[Account] Auto adding current IDE account...');
                    const newAccount: Account = {
                        id: generateId(),
                        email: userInfo.email,
                        name: userInfo.name,
                        token: {
                            access_token: dbAccount.accessToken,
                            refresh_token: dbAccount.refreshToken,
                            expires_in: 3600,
                            expiry_timestamp: now + 3600,
                            token_type: 'Bearer'
                        },
                        created_at: now,
                        last_used: now,
                        priority: accounts.length
                    };
                    accounts.push(newAccount);
                    saveAccounts(accounts);
                    console.log('[Account] Auto added:', userInfo.email);

                    // 自动获取配额
                    try {
                        await fetchAccountQuota(newAccount.id);
                    } catch (e) {
                        console.log('[Account] Auto fetch quota failed:', e);
                    }

                    return newAccount;
                } catch (e) {
                    console.log('[Account] Failed to auto add:', e);
                }
            }
        }
    } catch (error) {
        console.log('[Account] Failed to get current account from IDE:', error);
    }

    // 回退：返回最近使用的账号
    if (accounts.length === 0) return null;
    return accounts.reduce((prev, curr) =>
        prev.last_used > curr.last_used ? prev : curr
    );
}

/** 通过 refresh_token 添加账号 */
export async function addAccountByToken(refreshToken: string): Promise<Account> {
    const accounts = listAccounts();

    // 检查 refresh_token 是否已存在
    const existingByToken = accounts.find(a => a.token.refresh_token === refreshToken);
    if (existingByToken) {
        // 静默返回现有账号（批量导入时跳过重复）
        console.log('[Account] Token already exists, skipping:', existingByToken.email);
        return existingByToken;
    }

    // 刷新 Token 并获取用户信息
    let email = `account_${Date.now()}`;
    let name: string | undefined;
    let accessToken = '';
    let expiresIn = 3600;

    try {
        const tokenRes = await oauthService.refreshAccessToken(refreshToken);
        accessToken = tokenRes.access_token;
        expiresIn = tokenRes.expires_in;

        const userInfo = await oauthService.getUserInfo(accessToken);
        email = userInfo.email;
        name = userInfo.name;
    } catch (error) {
        console.error('Failed to get user info:', error);
    }

    const now = Math.floor(Date.now() / 1000);

    // 再次检查是否有同邮箱的账号（可能用不同的 refresh_token）
    const existingByEmail = accounts.find(a => a.email === email);
    if (existingByEmail) {
        // 更新现有账号的 token
        existingByEmail.token = {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: expiresIn,
            expiry_timestamp: now + expiresIn,
            token_type: 'Bearer'
        };
        existingByEmail.last_used = now;
        // 清除 403 状态
        if (existingByEmail.quota?.is_forbidden) {
            existingByEmail.quota = undefined;
        }
        saveAccounts(accounts);
        console.log('[Account] Updated existing account with new token:', email);

        // 自动获取配额
        try {
            await fetchAccountQuota(existingByEmail.id);
        } catch (e) {
            console.log('[Account] Auto fetch quota failed:', e);
        }

        return existingByEmail;
    }

    const newAccount: Account = {
        id: generateId(),
        email,
        name,
        token: {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: expiresIn,
            expiry_timestamp: now + expiresIn,
            token_type: 'Bearer'
        },
        created_at: now,
        last_used: now,
        priority: accounts.length
    };

    accounts.push(newAccount);
    saveAccounts(accounts);

    // 自动获取配额
    try {
        await fetchAccountQuota(newAccount.id);
    } catch (e) {
        console.log('[Account] Auto fetch quota failed:', e);
    }

    return newAccount;
}

/** 批量添加账号（支持多种格式） */
export async function addAccountsBatch(input: string): Promise<{ success: number; failed: number; errors: string[] }> {
    const tokens: string[] = [];
    const errors: string[] = [];

    // 尝试解析 JSON 数组
    try {
        const parsed = JSON.parse(input);
        if (Array.isArray(parsed)) {
            for (const item of parsed) {
                if (typeof item === 'string') {
                    tokens.push(item);
                } else if (item.refresh_token) {
                    tokens.push(item.refresh_token);
                }
            }
        }
    } catch {
        // 非 JSON，按行分割
        const lines = input.split(/[\n,;]+/).map(s => s.trim()).filter(s => s);
        for (const line of lines) {
            if (line.startsWith('1//')) {
                tokens.push(line);
            }
        }
    }

    let success = 0;
    for (const token of tokens) {
        try {
            await addAccountByToken(token);
            success++;
        } catch (error: any) {
            errors.push(`${token.substring(0, 20)}...: ${error.message}`);
        }
    }

    return { success, failed: tokens.length - success, errors };
}

/** OAuth 授权添加账号 */
export async function addAccountViaOAuth(callbackUrl: string): Promise<Account> {
    const code = oauthService.extractCodeFromUrl(callbackUrl);
    if (!code) {
        throw new Error('无效的回调 URL');
    }

    const tokenResponse = await oauthService.exchangeCode(code);
    if (!tokenResponse.refresh_token) {
        throw new Error('未获取到 refresh_token，请在 https://myaccount.google.com/permissions 撤销应用权限后重试');
    }

    const userInfo = await oauthService.getUserInfo(tokenResponse.access_token);
    const accounts = listAccounts();

    // 检查是否已存在
    const existing = accounts.find(a => a.email === userInfo.email);
    if (existing) {
        // 更新现有账号的 Token
        existing.token = {
            access_token: tokenResponse.access_token,
            refresh_token: tokenResponse.refresh_token,
            expires_in: tokenResponse.expires_in,
            expiry_timestamp: Math.floor(Date.now() / 1000) + tokenResponse.expires_in,
            token_type: tokenResponse.token_type || 'Bearer'
        };
        existing.last_used = Math.floor(Date.now() / 1000);
        saveAccounts(accounts);
        return existing;
    }

    const now = Math.floor(Date.now() / 1000);
    const newAccount: Account = {
        id: generateId(),
        email: userInfo.email,
        name: userInfo.name,
        token: {
            access_token: tokenResponse.access_token,
            refresh_token: tokenResponse.refresh_token,
            expires_in: tokenResponse.expires_in,
            expiry_timestamp: now + tokenResponse.expires_in,
            token_type: tokenResponse.token_type || 'Bearer'
        },
        created_at: now,
        last_used: now,
        priority: accounts.length
    };

    accounts.push(newAccount);
    saveAccounts(accounts);

    // 自动获取配额
    try {
        await fetchAccountQuota(newAccount.id);
    } catch (e) {
        console.log('[Account] Auto fetch quota failed:', e);
    }

    return newAccount;
}

/**
 * 启动完整的 OAuth 授权流程
 * 1. 启动本地回调服务器
 * 2. 打开浏览器进行 Google 授权
 * 3. 自动接收回调并添加账号
 */
export async function startOAuthFlow(): Promise<Account> {
    // 启动回调服务器并等待授权码
    const codePromise = oauthCallbackServer.startCallbackServer();

    // 返回授权 URL（调用方负责打开浏览器）
    const authUrl = oauthService.getAuthUrl();

    // 等待授权码
    const code = await codePromise;

    // 停止服务器
    oauthCallbackServer.stopCallbackServer();

    // 交换 Token
    const tokenResponse = await oauthService.exchangeCode(code);
    if (!tokenResponse.refresh_token) {
        throw new Error('未获取到 refresh_token，请在 https://myaccount.google.com/permissions 撤销应用权限后重试');
    }

    // 获取用户信息并添加账号
    const userInfo = await oauthService.getUserInfo(tokenResponse.access_token);
    const accounts = listAccounts();

    // 检查是否已存在
    const existing = accounts.find(a => a.email === userInfo.email);
    if (existing) {
        // 更新现有账号的 Token
        existing.token = {
            access_token: tokenResponse.access_token,
            refresh_token: tokenResponse.refresh_token,
            expires_in: tokenResponse.expires_in,
            expiry_timestamp: Math.floor(Date.now() / 1000) + tokenResponse.expires_in,
            token_type: tokenResponse.token_type || 'Bearer'
        };
        existing.last_used = Math.floor(Date.now() / 1000);
        saveAccounts(accounts);
        return existing;
    }

    const now = Math.floor(Date.now() / 1000);
    const newAccount: Account = {
        id: generateId(),
        email: userInfo.email,
        name: userInfo.name,
        token: {
            access_token: tokenResponse.access_token,
            refresh_token: tokenResponse.refresh_token,
            expires_in: tokenResponse.expires_in,
            expiry_timestamp: now + tokenResponse.expires_in,
            token_type: tokenResponse.token_type || 'Bearer'
        },
        created_at: now,
        last_used: now,
        priority: accounts.length
    };

    accounts.push(newAccount);
    saveAccounts(accounts);

    // 自动获取配额
    try {
        await fetchAccountQuota(newAccount.id);
    } catch (e) {
        console.log('[Account] Auto fetch quota failed:', e);
    }

    return newAccount;
}

/** 从 IDE 自动导入账号 */
export async function autoImportFromEditor(): Promise<Account | null> {
    const current = await antigravityService.getCurrentAccountFromEditor();
    if (!current?.refreshToken) {
        return null;
    }

    try {
        return await addAccountByToken(current.refreshToken);
    } catch (error: any) {
        if (error.message.includes('已存在')) {
            // 账号已存在，返回现有账号
            const accounts = listAccounts();
            return accounts.find(a => a.token.refresh_token === current.refreshToken) || null;
        }
        throw error;
    }
}

/** 删除账号 */
export function deleteAccount(accountId: string): void {
    let accounts = listAccounts();
    accounts = accounts.filter(a => a.id !== accountId);
    saveAccounts(accounts);
}

/** 批量删除账号 */
export function deleteAccounts(accountIds: string[]): void {
    let accounts = listAccounts();
    accounts = accounts.filter(a => !accountIds.includes(a.id));
    saveAccounts(accounts);
}

/** 更新账号 */
export function updateAccount(accountId: string, updates: Partial<Account>): void {
    const accounts = listAccounts();
    const account = accounts.find(a => a.id === accountId);
    if (account) {
        Object.assign(account, updates);
        saveAccounts(accounts);
    }
}

// ============ 账号切换 ============

/** 切换账号 */
export async function switchAccount(accountId: string, mode: 'seamless' | 'full' = 'seamless'): Promise<void> {
    const accounts = listAccounts();
    const account = accounts.find(a => a.id === accountId);
    if (!account) {
        throw new Error('账号不存在');
    }

    // 切换
    if (mode === 'full') {
        // FULL 模式需要依赖 token 注入，必须确保 Token 有效
        const now = Math.floor(Date.now() / 1000);
        if (!account.token.access_token || account.token.expiry_timestamp < now + 300) {
            try {
                const tokenRes = await oauthService.refreshAccessToken(account.token.refresh_token);
                account.token.access_token = tokenRes.access_token;
                account.token.expires_in = tokenRes.expires_in;
                account.token.expiry_timestamp = now + tokenRes.expires_in;
                saveAccounts(accounts);
            } catch (error) {
                throw new Error(`Token 刷新失败: ${error}`);
            }
        }

        // 完整切换模式：修改配置文件 + 手动重启
        console.log('[Account] Using FULL switch mode');
        await antigravityService.switchAccountFull(
            account.token.access_token,
            account.token.refresh_token,
            account.token.expiry_timestamp,
            account.email
        );
    } else {
        // 直接切换模式（参考 Antigravity-Manager）
        // 1. 关闭 Antigravity
        // 2. 注入 Token 到数据库
        // 3. 重启 Antigravity

        console.log('[Account] Using DIRECT switch mode (Close -> Inject -> Restart)');

        try {
            // 动态导入直接切换服务
            const { DirectSwitchService } = await import('./directSwitchService');
            console.log('[Account] ✓ DirectSwitchService loaded');

            const directService = new DirectSwitchService();
            console.log('[Account] Calling directService.switchAccount...');

            const result = await directService.switchAccount(account);
            console.log('[Account] Direct switch result:', JSON.stringify(result));

            if (result.success) {
                // 切换成功，更新 last_used 并返回
                console.log('[Account] ✓ Direct switch SUCCESS!');
                account.last_used = Math.floor(Date.now() / 1000);
                saveAccounts(accounts);
                return;
            }

            // 切换失败，抛出错误
            console.error('[Account] ❌ Direct switch FAILED:', result.error);
            throw new Error(`账号切换失败: ${result.error}`);

        } catch (error: any) {
            // 记录并抛出
            console.error('[Account] ❌ Direct switch error:', error);
            throw new Error(`账号切换异常: ${error.message}`);
        }
    }

    // 更新 last_used
    account.last_used = Math.floor(Date.now() / 1000);
    saveAccounts(accounts);
}

// ============ 配额获取 ============

function httpsPost(hostname: string, path: string, headers: Record<string, string>, body: any): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(body);

        const req = https.request({
            hostname,
            port: 443,
            path,
            method: 'POST',
            headers: {
                ...headers,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 15000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode || 0, data: null });
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });

        req.write(postData);
        req.end();
    });
}

/** 获取 Project ID */
async function fetchProjectId(accessToken: string): Promise<string | null> {
    try {
        const result = await httpsPost(CLOUD_CODE_API_BASE, LOAD_CODE_ASSIST_PATH, {
            'Authorization': `Bearer ${accessToken}`,
            'User-Agent': 'antigravity/1.11.3 Darwin/arm64'
        }, {
            metadata: { ideType: 'ANTIGRAVITY' }
        });

        console.log(`[Quota] fetchProjectId response: status=${result.status}, data=${JSON.stringify(result.data)?.substring(0, 500)}`);

        if (result.status === 200) {
            const projectId = result.data?.cloudaicompanionProject || result.data?.cloudaicompanion_project;
            if (projectId) return projectId;
        }

        // 记录失败原因
        console.log(`[Quota] fetchProjectId failed: status=${result.status}, error=${result.data?.error?.message || 'unknown'}`);
        return null;
    } catch (error) {
        console.log(`[Quota] fetchProjectId exception:`, error);
        return null;
    }
}

/** 获取账号配额 */
export async function fetchAccountQuota(accountId: string): Promise<QuotaData> {
    const accounts = listAccounts();
    const account = accounts.find(a => a.id === accountId);

    if (!account) {
        throw new Error('账号不存在');
    }

    // 确保 Token 有效
    const now = Math.floor(Date.now() / 1000);
    if (!account.token.access_token || account.token.expiry_timestamp < now + 300) {
        try {
            const tokenRes = await oauthService.refreshAccessToken(account.token.refresh_token);
            account.token.access_token = tokenRes.access_token;
            account.token.expires_in = tokenRes.expires_in;
            account.token.expiry_timestamp = now + tokenRes.expires_in;
            saveAccounts(accounts);
        } catch (error) {
            throw error;
        }
    }


    // 获取 Project ID，如果没有返回则使用默认值
    const DEFAULT_PROJECT_ID = 'bamboo-precept-lgxtn';
    const projectId = await fetchProjectId(account.token.access_token) || DEFAULT_PROJECT_ID;
    console.log(`[Quota] ${account.email} using project ID: ${projectId}`);

    // 获取配额
    const result = await httpsPost(CLOUD_CODE_API_BASE, FETCH_MODELS_PATH, {
        'Authorization': `Bearer ${account.token.access_token}`,
        'User-Agent': 'antigravity/1.11.3 Darwin/arm64'
    }, { project: projectId });

    console.log(`[Quota] fetchModels for ${account.email}: status=${result.status}, error=${result.data?.error?.message || 'none'}`);

    if (result.status === 403) {
        console.log(`[Quota] ${account.email} got 403, full response:`, JSON.stringify(result.data)?.substring(0, 500));
        const quota: QuotaData = {
            models: [],
            last_updated: Math.floor(Date.now() / 1000),
            is_forbidden: true
        };
        account.quota = quota;
        saveAccounts(accounts);
        return quota;
    }

    const quota: QuotaData = {
        models: [],
        last_updated: Math.floor(Date.now() / 1000)
    };

    if (result.data?.models) {
        for (const [name, info] of Object.entries(result.data.models as Record<string, any>)) {
            const quotaInfo = info.quotaInfo;
            if (!quotaInfo) continue;

            const nameLower = name.toLowerCase();
            let displayName = '';
            let modelType = '';

            // Claude Sonnet（不含 Thinking）
            if (nameLower.includes('claude') && nameLower.includes('sonnet') && !nameLower.includes('thinking')) {
                displayName = 'Claude Sonnet';
                modelType = 'claude';
            }
            // Gemini 3 Pro High
            else if (nameLower.includes('gemini') && nameLower.includes('3') && nameLower.includes('pro') && nameLower.includes('high')) {
                displayName = 'Gemini 3 Pro';
                modelType = 'gemini-pro';
            }
            // Gemini 3 Flash
            else if (nameLower.includes('gemini') && nameLower.includes('3') && nameLower.includes('flash') && !nameLower.includes('thinking') && !nameLower.includes('lite')) {
                displayName = 'Gemini 3 Flash';
                modelType = 'gemini-flash';
            }
            else {
                continue;
            }

            // 避免重复
            if (quota.models.find(q => q.name === modelType)) {
                continue;
            }

            quota.models.push({
                name: modelType,
                displayName,
                percentage: Math.round((quotaInfo.remainingFraction ?? 0) * 100),
                reset_time: quotaInfo.resetTime || ''
            });
        }
    }

    // 按固定顺序排序模型：Claude Sonnet -> Gemini 3 Pro -> Gemini 3 Flash
    const modelOrder: Record<string, number> = {
        'claude': 0,
        'gemini-pro': 1,
        'gemini-flash': 2
    };
    quota.models.sort((a, b) => (modelOrder[a.name] ?? 99) - (modelOrder[b.name] ?? 99));

    account.quota = quota;
    saveAccounts(accounts);
    return quota;
}

/** 刷新所有账号配额 */
export async function refreshAllQuotas(): Promise<{ success: number; failed: number }> {
    const accounts = listAccounts();
    let success = 0;
    let failed = 0;

    for (const account of accounts) {
        try {
            await fetchAccountQuota(account.id);
            success++;
        } catch {
            failed++;
        }
    }

    return { success, failed };
}

/** 获取最佳可用账号（配额最高且未禁用） */
export function getBestAvailableAccount(excludeId?: string): Account | null {
    const accounts = listAccounts();

    const available = accounts
        .filter(a => a.id !== excludeId && !a.disabled && !a.quota?.is_forbidden)
        .sort((a, b) => {
            const aQuota = getLowestQuota(a);
            const bQuota = getLowestQuota(b);
            return bQuota - aQuota;  // 降序
        });

    return available[0] || null;
}

/** 
 * 获取特定模型的最佳备选账号
 * - 必须未禁用、非 403
 * - 该模型配额必须高于设定阈值
 * - 该模型配额必须高于当前账号的配额
 * - 如果有多个最高值相同的，则随机返回一个
 */
export function getBestAvailableAccountForModel(modelName: string, threshold: number, currentAccountPercentage: number, excludeId?: string): Account | null {
    const accounts = listAccounts();

    // 1. 筛选出可用的备选账号
    const candidates = accounts.filter(a => {
        if (a.id === excludeId || a.disabled || a.quota?.is_forbidden) return false;
        const model = a.quota?.models.find(m => m.name === modelName);
        if (!model) return false;

        // 必须高于其设定阈值，且高于当前账号该模型的配额
        return model.percentage > threshold && model.percentage > currentAccountPercentage;
    });

    if (candidates.length === 0) return null;

    // 2. 找到该模型配额最高的账号们
    let maxPercentage = -1;
    candidates.forEach(a => {
        const p = a.quota?.models.find(m => m.name === modelName)?.percentage ?? -1;
        if (p > maxPercentage) maxPercentage = p;
    });

    const bestCandidates = candidates.filter(a => {
        const p = a.quota?.models.find(m => m.name === modelName)?.percentage ?? -1;
        return p === maxPercentage;
    });

    // 3. 从最高配额的账号中随机选一个
    const randomIndex = Math.floor(Math.random() * bestCandidates.length);
    return bestCandidates[randomIndex];
}

/** 获取账号最低配额 */
export function getLowestQuota(account: Account): number {
    if (!account.quota?.models.length) return -1;
    return Math.min(...account.quota.models.map(m => m.percentage));
}

/** 获取 OAuth 授权 URL */
export function getOAuthUrl(): string {
    return oauthService.getAuthUrl();
}

/** 导出账号 */
export function exportAccounts(accountIds?: string[]): { email: string; refresh_token: string }[] {
    const accounts = listAccounts();
    const toExport = accountIds
        ? accounts.filter(a => accountIds.includes(a.id))
        : accounts;

    return toExport.map(a => ({
        email: a.email,
        refresh_token: a.token.refresh_token
    }));
}
