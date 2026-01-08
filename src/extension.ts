/**
 * Anti Quota - Antigravity 配额实时监控插件
 * 
 * 通过 Google Cloud Code API 获取实时配额
 * 复用 Antigravity IDE 已登录账号的 refresh_token
 */

import * as vscode from 'vscode';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Google OAuth 配置 (来自 Antigravity)
const GOOGLE_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = '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';

// Google Cloud Code API
const CLOUD_CODE_API_BASE = 'cloudcode-pa.googleapis.com';
const FETCH_MODELS_PATH = '/v1internal:fetchAvailableModels';
const LOAD_CODE_ASSIST_PATH = '/v1internal:loadCodeAssist';

interface QuotaInfo {
    model: string;
    displayName: string;
    percentage: number;
    resetTime: string;
    resetTimeFormatted: string;
}

interface TokenInfo {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

let statusBarItem: vscode.StatusBarItem;
let pollingTimer: NodeJS.Timeout | undefined;
let outputChannel: vscode.OutputChannel;
let cachedToken: TokenInfo | null = null;
let currentQuotas: QuotaInfo[] = [];
let isRefreshing = false;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Anti Quota');
    log('Anti Quota 插件已激活');

    // 创建单个状态栏项目
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'anti-quota.refresh';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // 初始显示
    updateStatusBar([], false);

    // 注册刷新命令
    const refreshCommand = vscode.commands.registerCommand('anti-quota.refresh', async () => {
        log('手动刷新配额...');
        await refreshQuota(true);  // 手动刷新，显示加载动画
    });

    context.subscriptions.push(refreshCommand);

    // 启动定时刷新
    startPolling();

    // 监听配置变化
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('antiQuota')) {
            restartPolling();
        }
    });

    // 立即刷新一次（静默）
    refreshQuota(false);
}

function log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    outputChannel.appendLine(`[${timestamp}] ${message}`);
}

function getColorIcon(percentage: number): string {
    if (percentage < 0) return '⚪';
    if (percentage === 0) return '🔴';
    if (percentage < 30) return '🟠';
    if (percentage < 70) return '🟡';
    return '🟢';
}

function updateStatusBar(quotas: QuotaInfo[], showLoading: boolean) {
    if (showLoading) {
        statusBarItem.text = '$(sync~spin) 刷新中...';
        statusBarItem.tooltip = '正在刷新配额...';
        return;
    }

    // 合并配额数据，避免微小跳动（1% 阈值）
    const mergedQuotas = quotas.map(newQ => {
        const oldQ = currentQuotas.find(q => q.model === newQ.model);
        if (oldQ && Math.abs(newQ.percentage - oldQ.percentage) <= 1) {
            // 变化太小，保持旧值
            return { ...newQ, percentage: oldQ.percentage };
        }
        return newQ;
    });

    currentQuotas = mergedQuotas;

    // 找到三个主要模型
    const claude = mergedQuotas.find(q => q.model === 'claude');
    const pro = mergedQuotas.find(q => q.model === 'gemini-pro');
    const flash = mergedQuotas.find(q => q.model === 'gemini-flash');

    // 构建状态栏文本
    const claudeText = claude ? `${getColorIcon(claude.percentage)} Claude: ${claude.percentage}%` : '⚪ Claude: --';
    const proText = pro ? `${getColorIcon(pro.percentage)} G Pro: ${pro.percentage}%` : '⚪ G Pro: --';
    const flashText = flash ? `${getColorIcon(flash.percentage)} G Flash: ${flash.percentage}%` : '⚪ G Flash: --';

    statusBarItem.text = `${claudeText}  ${proText}  ${flashText}`;

    // 构建详细 tooltip
    let tooltipLines = ['**Antigravity 模型配额**', '', '| 模型 | 剩余 | 重置时间 |', '|------|------|----------|'];

    for (const q of mergedQuotas) {
        if (q.percentage >= 0) {
            tooltipLines.push(`| ${q.displayName} | ${q.percentage}% | ${q.resetTimeFormatted} |`);
        }
    }

    tooltipLines.push('', '_点击刷新_');

    const tooltip = new vscode.MarkdownString(tooltipLines.join('\n'));
    tooltip.isTrusted = true;
    statusBarItem.tooltip = tooltip;
}

function startPolling() {
    const config = vscode.workspace.getConfiguration('antiQuota');
    const enabled = config.get<boolean>('enabled', true);
    const intervalSec = config.get<number>('refreshInterval', 10);

    if (!enabled) {
        log('自动刷新已禁用');
        return;
    }

    if (pollingTimer) {
        clearInterval(pollingTimer);
    }

    log(`启动自动刷新，间隔 ${intervalSec} 秒`);
    pollingTimer = setInterval(() => {
        refreshQuota(false);  // 自动刷新，静默
    }, intervalSec * 1000);
}

function restartPolling() {
    if (pollingTimer) {
        clearInterval(pollingTimer);
        pollingTimer = undefined;
    }
    startPolling();
}

/**
 * 获取 Antigravity 数据库路径
 */
function getAntigravityDbPath(): string {
    const platform = os.platform();
    const home = os.homedir();

    if (platform === 'darwin') {
        return path.join(home, 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb');
    } else if (platform === 'win32') {
        return path.join(process.env.APPDATA || '', 'Antigravity/User/globalStorage/state.vscdb');
    } else {
        return path.join(home, '.config/Antigravity/User/globalStorage/state.vscdb');
    }
}

/**
 * 从 Antigravity 数据库提取 refresh_token
 */
async function extractRefreshTokenFromDb(): Promise<string | null> {
    try {
        const dbPath = getAntigravityDbPath();

        // 使用 sqlite3 CLI 读取数据
        const { stdout } = await execAsync(
            `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'jetskiStateSync.agentManagerInitState'"`,
            { timeout: 5000 }
        );

        if (!stdout.trim()) {
            log('数据库中未找到登录状态');
            return null;
        }

        // Base64 解码
        const base64Data = stdout.trim();
        const buffer = Buffer.from(base64Data, 'base64');

        // 解析 Protobuf 提取 refresh_token
        const refreshToken = parseProtobufForRefreshToken(buffer);
        return refreshToken;

    } catch (error) {
        log(`提取 refresh_token 失败: ${error}`);
        return null;
    }
}

/**
 * 简单的 Protobuf 解析器 - 提取 refresh_token
 */
function parseProtobufForRefreshToken(buffer: Buffer): string | null {
    try {
        const oauthData = findProtobufField(buffer, 6);
        if (!oauthData) return null;

        const refreshTokenBytes = findProtobufField(oauthData, 3);
        if (!refreshTokenBytes) return null;

        return refreshTokenBytes.toString('utf-8');
    } catch (error) {
        return null;
    }
}

function findProtobufField(buffer: Buffer, fieldNumber: number): Buffer | null {
    let pos = 0;

    while (pos < buffer.length) {
        const { value: tag, newPos: tagEndPos } = readVarint(buffer, pos);
        if (tagEndPos >= buffer.length) break;

        const wireType = tag & 0x07;
        const field = tag >> 3;

        pos = tagEndPos;

        if (wireType === 2) {
            const { value: length, newPos: lenEndPos } = readVarint(buffer, pos);
            pos = lenEndPos;

            if (field === fieldNumber) {
                return buffer.slice(pos, pos + length);
            }

            pos += length;
        } else if (wireType === 0) {
            const { newPos } = readVarint(buffer, pos);
            pos = newPos;
        } else if (wireType === 1) {
            pos += 8;
        } else if (wireType === 5) {
            pos += 4;
        } else {
            break;
        }
    }

    return null;
}

function readVarint(buffer: Buffer, pos: number): { value: number; newPos: number } {
    let result = 0;
    let shift = 0;

    while (pos < buffer.length) {
        const byte = buffer[pos];
        result |= (byte & 0x7f) << shift;
        pos++;

        if ((byte & 0x80) === 0) {
            break;
        }
        shift += 7;
    }

    return { value: result, newPos: pos };
}

/**
 * 使用 refresh_token 获取 access_token
 */
async function refreshAccessToken(refreshToken: string): Promise<TokenInfo | null> {
    return new Promise((resolve) => {
        const postData = new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        }).toString();

        const req = https.request({
            hostname: 'oauth2.googleapis.com',
            port: 443,
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.access_token) {
                        const expiresIn = json.expires_in || 3600;
                        resolve({
                            accessToken: json.access_token,
                            refreshToken: refreshToken,
                            expiresAt: Date.now() + (expiresIn * 1000) - 60000
                        });
                    } else {
                        log(`Token 刷新失败: ${data}`);
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });

        req.write(postData);
        req.end();
    });
}

/**
 * 获取有效的 access_token
 */
async function getValidAccessToken(forceRefresh: boolean = false): Promise<string | null> {
    if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAt) {
        return cachedToken.accessToken;
    }

    const refreshToken = await extractRefreshTokenFromDb();
    if (!refreshToken) {
        log('无法获取 refresh_token，请确保 Antigravity IDE 已登录');
        return null;
    }

    const tokenInfo = await refreshAccessToken(refreshToken);
    if (tokenInfo) {
        cachedToken = tokenInfo;
        return tokenInfo.accessToken;
    }

    return null;
}

/**
 * 获取项目 ID
 */
async function loadProjectId(accessToken: string): Promise<string> {
    return new Promise((resolve) => {
        const postData = JSON.stringify({
            metadata: { ideType: 'ANTIGRAVITY' }
        });

        const req = https.request({
            hostname: CLOUD_CODE_API_BASE,
            port: 443,
            path: LOAD_CODE_ASSIST_PATH,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.cloudaicompanionProject || 'bamboo-precept-lgxtn');
                } catch (e) {
                    resolve('bamboo-precept-lgxtn');
                }
            });
        });

        req.on('error', () => resolve('bamboo-precept-lgxtn'));
        req.on('timeout', () => { req.destroy(); resolve('bamboo-precept-lgxtn'); });

        req.write(postData);
        req.end();
    });
}

/**
 * 调用 Google Cloud Code API 获取实时配额
 */
async function fetchQuotaFromGoogleApi(accessToken: string, projectId: string): Promise<QuotaInfo[]> {
    return new Promise((resolve) => {
        const postData = JSON.stringify({
            project: projectId
        });

        const req = https.request({
            hostname: CLOUD_CODE_API_BASE,
            port: 443,
            path: FETCH_MODELS_PATH,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                'User-Agent': 'antigravity/1.11.3 Darwin/arm64',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        log(`API 错误: ${res.statusCode}`);
                        resolve([]);
                        return;
                    }

                    const json = JSON.parse(data);
                    const quotas = parseGoogleApiResponse(json);
                    resolve(quotas);
                } catch (e) {
                    resolve([]);
                }
            });
        });

        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });

        req.write(postData);
        req.end();
    });
}

/**
 * 解析 Google API 响应
 * 只保留主要模型：Gemini 3 系列, Claude Sonnet/Opus
 */
function parseGoogleApiResponse(response: any): QuotaInfo[] {
    const quotas: QuotaInfo[] = [];

    try {
        const models = response.models || {};

        for (const [modelName, modelInfo] of Object.entries(models)) {
            const info = modelInfo as any;
            if (!info.quotaInfo) continue;

            const remainingFraction = info.quotaInfo.remainingFraction ?? 0;
            const resetTime = info.quotaInfo.resetTime || '';
            const nameLower = modelName.toLowerCase();

            // 只保留主要模型
            // 过滤条件：只要 Gemini 3 系列和 Claude（排除 2.5 等旧版本）
            let displayName = '';
            let modelType = '';

            // Claude 模型（只保留 Sonnet 4.5，不含 Thinking）
            if (nameLower.includes('claude') && nameLower.includes('sonnet') && !nameLower.includes('thinking')) {
                displayName = 'Claude Sonnet 4.5';
                modelType = 'claude';
            }
            // Gemini 3 Pro High（主力模型）
            else if (nameLower.includes('gemini') && nameLower.includes('3') && nameLower.includes('pro') && nameLower.includes('high')) {
                displayName = 'Gemini 3 Pro';
                modelType = 'gemini-pro';
            }
            // Gemini 3 Flash（不含 Thinking/Lite）
            else if (nameLower.includes('gemini') && nameLower.includes('3') && nameLower.includes('flash') && !nameLower.includes('thinking') && !nameLower.includes('lite')) {
                displayName = 'Gemini 3 Flash';
                modelType = 'gemini-flash';
            }
            else {
                continue;  // 跳过其他模型
            }

            // 避免重复添加同类型模型
            if (quotas.find(q => q.model === modelType)) {
                continue;
            }

            quotas.push({
                model: modelType,
                displayName,
                percentage: Math.round(remainingFraction * 100),
                resetTime,
                resetTimeFormatted: formatResetTime(resetTime)
            });
        }

        return quotas;

    } catch (e) {
        return [];
    }
}

function formatModelName(name: string): string {
    // gemini-2.5-pro -> Gemini 2.5 Pro
    return name
        .split('-')
        .map(part => {
            if (/^\d/.test(part)) return part;
            return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(' ')
        .replace(/(\d+) (\d+)/g, '$1.$2');
}

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
 * 刷新配额
 */
async function refreshQuota(showLoading: boolean = false) {
    if (isRefreshing) return;
    isRefreshing = true;

    try {
        // 如果是手动刷新，显示加载动画
        if (showLoading) {
            updateStatusBar(currentQuotas, true);
        }

        const accessToken = await getValidAccessToken(showLoading);
        if (!accessToken) {
            if (showLoading) {
                vscode.window.showWarningMessage('无法获取 access_token，请确保 Antigravity IDE 已登录');
            }
            updateStatusBar(currentQuotas, false);
            return;
        }

        const projectId = await loadProjectId(accessToken);
        const quotas = await fetchQuotaFromGoogleApi(accessToken, projectId);

        if (quotas.length > 0) {
            updateStatusBar(quotas, false);
            log(`配额刷新成功: ${quotas.filter(q => ['claude', 'gemini-pro', 'gemini-flash'].includes(q.model)).map(q => `${q.displayName}:${q.percentage}%`).join(', ')}`);
        } else {
            updateStatusBar(currentQuotas, false);
            if (showLoading) {
                vscode.window.showWarningMessage('获取配额失败');
            }
        }

    } catch (error) {
        log(`刷新配额失败: ${error}`);
        updateStatusBar(currentQuotas, false);
        cachedToken = null;
    } finally {
        isRefreshing = false;
    }
}

export function deactivate() {
    if (pollingTimer) {
        clearInterval(pollingTimer);
    }
    statusBarItem?.dispose();
    log('Anti Quota 插件已停用');
}
