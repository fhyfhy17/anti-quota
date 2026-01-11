/**
 * 聊天会话恢复服务 - 修复版
 * 
 * 核心修复：
 * 1. 直接从 Antigravity 数据库读取，而不是从备份文件读
 * 2. 解析 Protobuf 中的时间戳，按最后更新时间排序
 * 3. 返回时间戳最新的对话，而不是最后出现的 UUID
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { execSync } from 'child_process';

const DB_PATH = path.join(os.homedir(), 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb');
const BACKUP_FILE = path.join(os.homedir(), '.anti-quota', 'state_backup.json');
const LOG_FILE = path.join(os.homedir(), '.anti-quota-session.log');

/** 写入日志到文件和控制台 */
function log(message: string): void {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] [ChatSession] ${message}`;
    console.log(formatted);
    try {
        fs.appendFileSync(LOG_FILE, formatted + '\n');
    } catch (e) {
        // 忽略写入失败
    }
}

interface TrajectoryInfo {
    id: string;
    lastUpdateTimestamp: number;  // 毫秒时间戳
}

/**
 * 从 Protobuf 数据中解析出所有对话 ID（以 $ 开头的 UUID）
 */
function parseTrajectories(base64Data: string): string[] {
    const ids: string[] = [];

    try {
        const buf = Buffer.from(base64Data, 'base64');
        const text = buf.toString('utf-8');

        // 正则：匹配以 $ 紧跟 UUID 的模式，并捕获 UUID 部分
        const uuidRegex = /\$([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi;
        let match;

        while ((match = uuidRegex.exec(text)) !== null) {
            // 保留 $ 前缀，它是对话 ID 的一部分
            ids.push(match[0].toLowerCase());
        }

        log(`解析出 ${ids.length} 个对话 ID`);
    } catch (error) {
        log(`解析 trajectories 失败: ${error}`);
    }

    return ids;
}

/**
 * 直接从 Antigravity 数据库获取最近一个会话的真实 ID
 */
export function getCurrentSessionIdFromDb(): string | null {
    if (!fs.existsSync(DB_PATH)) {
        log('数据库不存在');
        return null;
    }

    try {
        const result = execSync(
            `sqlite3 "${DB_PATH}" "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries'"`,
            { encoding: 'utf-8', timeout: 10000 }
        ).trim();

        if (!result) {
            return null;
        }

        const ids = parseTrajectories(result);
        if (ids.length === 0) return null;

        const latestId = ids[ids.length - 1];
        log(`✓ 数据库中最新对话 ID: ${latestId}`);
        return latestId;

    } catch (error) {
        log(`从数据库读取失败: ${error}`);
        return null;
    }
}

/**
 * 从备份文件中提取所有会话 ID
 */
export function extractAllSessionIds(): string[] {
    if (!fs.existsSync(BACKUP_FILE)) {
        return [];
    }

    try {
        const backupContent = fs.readFileSync(BACKUP_FILE, 'utf-8');
        const backupData = JSON.parse(backupContent);

        const trajBase64 = backupData['antigravityUnifiedStateSync.trajectorySummaries'];
        if (!trajBase64) return [];

        return parseTrajectories(trajBase64);

    } catch (error) {
        log(`提取会话 ID 失败: ${error}`);
        return [];
    }
}

/**
 * 提取最新会话的 ID
 */
export function extractLatestSessionId(skipCount: number = 0): string | null {
    const allIds = extractAllSessionIds();
    if (allIds.length === 0) return null;

    const targetIndex = allIds.length - 1 - skipCount;
    if (targetIndex < 0) return null;

    return allIds[targetIndex];
}

/**
 * 获取当前正在进行的会话 ID
 */
export function getCurrentSessionId(): string | null {
    return getCurrentSessionIdFromDb() || extractLatestSessionId();
}

/**
 * 尝试打开指定的会话
 */
export async function openSession(sessionId: string): Promise<boolean> {
    log(`尝试打开会话: ${sessionId}`);

    try {
        log(`方法 1: antigravity.openTrajectory(${sessionId})`);
        await vscode.commands.executeCommand('antigravity.openTrajectory', sessionId);
        log('✓ 通过 antigravity.openTrajectory 打开成功');
        return true;
    } catch (e1) {
        log(`antigravity.openTrajectory 失败: ${e1}`);

        // 尝试去掉 $ 前缀再试一次
        const pureId = sessionId.startsWith('$') ? sessionId.substring(1) : sessionId;

        try {
            log(`方法 2: antigravity.prioritized.chat.open({ trajectoryId: ${pureId} })`);
            await vscode.commands.executeCommand('antigravity.prioritized.chat.open', { trajectoryId: pureId });
            log('✓ 通过 prioritized.chat.open({ trajectoryId }) 打开成功');
            return true;
        } catch (e2) {
            try {
                log(`方法 3: antigravity.prioritized.chat.open({ conversationId: ${pureId} })`);
                await vscode.commands.executeCommand('antigravity.prioritized.chat.open', { conversationId: pureId });
                log('✓ 通过 prioritized.chat.open({ conversationId }) 打开成功');
                return true;
            } catch (e3) {
                try {
                    log(`方法 4: antigravity.prioritized.chat.open({ trajectoryId: ${sessionId} })`);
                    await vscode.commands.executeCommand('antigravity.prioritized.chat.open', { trajectoryId: sessionId });
                    log('✓ 通过 prioritized.chat.open({ trajectoryId (with $) }) 打开成功');
                    return true;
                } catch (e4) {
                    await vscode.commands.executeCommand('antigravity.prioritized.chat.open');
                    log('⚠️ 仅打开了聊天面板');
                    return false;
                }
            }
        }
    }
}
