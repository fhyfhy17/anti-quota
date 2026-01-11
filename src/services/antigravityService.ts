/**
 * Antigravity IDE 服务 (v12.0 - 精简版)
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawn } from 'child_process';

// ============ 路径配置 ============

export function getDbPath(): string {
    const platform = os.platform();
    const homeDir = os.homedir();
    if (platform === 'darwin') {
        return path.join(homeDir, 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb');
    } else if (platform === 'win32') {
        const appData = process.env.APPDATA || path.join(homeDir, 'AppData/Roaming');
        return path.join(appData, 'Antigravity/User/globalStorage/state.vscdb');
    } else {
        return path.join(homeDir, '.config/Antigravity/User/globalStorage/state.vscdb');
    }
}

export function setDbFileWritable(writable: boolean): void {
    const dbPath = getDbPath();
    const mode = writable ? 0o644 : 0o444;

    try {
        if (fs.existsSync(dbPath)) {
            fs.chmodSync(dbPath, mode);
        }
        ['.vscdb-wal', '.vscdb-shm', '.vscdb.backup'].forEach(suffix => {
            const p = dbPath.replace('.vscdb', suffix);
            if (fs.existsSync(p)) {
                fs.chmodSync(p, mode);
            }
        });
    } catch (error) {
        console.error('[Antigravity] Failed to set permissions:', error);
    }
}

/** 清理 SQLite 锁定文件 */
export function cleanUpLockFiles(): void {
    const dbPath = getDbPath();
    ['.vscdb-wal', '.vscdb-shm'].forEach(suffix => {
        const p = dbPath.replace('.vscdb', suffix);
        if (fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
                console.log(`[Antigravity] Deleted lock file: ${p}`);
            } catch (e) {
                console.error(`[Antigravity] Failed to delete lock file: ${p}`, e);
            }
        }
    });
}

// ============ 切号标志管理 ============

const SWITCH_FLAG_FILE = path.join(os.homedir(), '.anti-quota', 'switch_pending.json');

interface SwitchPendingData {
    timestamp: number;
    fromEmail?: string;
    toEmail?: string;
    activeSessionId?: string; // 切号时正在进行的对话 ID
}

/** 标记切号操作（切号前调用） */
export function markSwitchPending(fromEmail?: string, toEmail?: string, activeSessionId?: string): void {
    try {
        const backupDir = path.dirname(SWITCH_FLAG_FILE);
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        const data: SwitchPendingData = {
            timestamp: Date.now(),
            fromEmail,
            toEmail,
            activeSessionId
        };
        fs.writeFileSync(SWITCH_FLAG_FILE, JSON.stringify(data, null, 2), 'utf-8');
        console.log('[Antigravity] Switch pending marked, activeSessionId:', activeSessionId || 'none');
    } catch (e) {
        console.error('[Antigravity] Failed to mark switch pending:', e);
    }
}

/** 检查是否有待处理的切号操作（启动时调用） */
export function checkSwitchPending(): SwitchPendingData | null {
    if (!fs.existsSync(SWITCH_FLAG_FILE)) {
        return null;
    }
    try {
        const content = fs.readFileSync(SWITCH_FLAG_FILE, 'utf-8');
        const data: SwitchPendingData = JSON.parse(content);
        // 只有 5 分钟内的标志才有效（防止过期标志影响，给 IDE 重启留出时间）
        if (Date.now() - data.timestamp < 300000) {
            return data;
        }
        // 过期了，清除
        clearSwitchPending();
        return null;
    } catch (e) {
        return null;
    }
}

/** 清除切号标志 */
export function clearSwitchPending(): void {
    if (fs.existsSync(SWITCH_FLAG_FILE)) {
        try {
            fs.unlinkSync(SWITCH_FLAG_FILE);
            console.log('[Antigravity] Switch pending cleared');
        } catch (e) {
            console.error('[Antigravity] Failed to clear switch pending:', e);
        }
    }
}

// ============ 应用控制 ============

/** 获取所有可能的编辑器数据库路径 */
export function getAllEditorDbPaths(): { name: string; path: string; keyName: string }[] {
    const platform = os.platform();
    const homeDir = os.homedir();

    const editors = [
        { name: 'Antigravity', folder: 'Antigravity', keyName: 'jetskiStateSync.agentManagerInitState' },
        { name: 'Cursor', folder: 'Cursor', keyName: 'jetskiStateSync.agentManagerInitState' },
        { name: 'Windsurf', folder: 'Windsurf', keyName: 'jetskiStateSync.agentManagerInitState' },
        { name: 'Kiro', folder: 'Kiro', keyName: 'jetskiStateSync.agentManagerInitState' },
    ];

    return editors.map(editor => {
        let dbPath: string;
        if (platform === 'darwin') {
            dbPath = path.join(homeDir, `Library/Application Support/${editor.folder}/User/globalStorage/state.vscdb`);
        } else if (platform === 'win32') {
            const appData = process.env.APPDATA || path.join(homeDir, 'AppData/Roaming');
            dbPath = path.join(appData, `${editor.folder}/User/globalStorage/state.vscdb`);
        } else {
            dbPath = path.join(homeDir, `.config/${editor.folder}/User/globalStorage/state.vscdb`);
        }
        return { name: editor.name, path: dbPath, keyName: editor.keyName };
    });
}

/** 从编辑器数据库读取当前登录的账号信息 */
export async function getCurrentAccountFromEditor(): Promise<{ refreshToken: string; accessToken: string; source: string } | null> {
    const editors = getAllEditorDbPaths();

    for (const editor of editors) {
        if (!fs.existsSync(editor.path)) {
            continue;
        }

        try {
            const result = await readTokensFromDb(editor.path, editor.keyName);
            if (result?.refreshToken && result?.accessToken) {
                return {
                    refreshToken: result.refreshToken,
                    accessToken: result.accessToken,
                    source: editor.name
                };
            }
        } catch (error) {
            console.error(`[Antigravity] Failed to read from ${editor.name}:`, error);
        }
    }

    return null;
}

/** 从指定数据库读取 tokens（使用 sqlite3 CLI） */
async function readTokensFromDb(dbPath: string, keyName: string): Promise<{ refreshToken: string; accessToken: string } | null> {
    try {
        const { execSync } = require('child_process');
        const stdout = execSync(
            `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = '${keyName}'"`,
            { encoding: 'utf-8', timeout: 5000 }
        );

        if (!stdout.trim()) {
            return null;
        }

        const blob = Buffer.from(stdout.trim(), 'base64');
        const oauthInfo = findFieldInBlob(blob, 6);
        if (!oauthInfo) {
            return null;
        }

        const accessTokenData = findFieldInBlob(oauthInfo, 1);
        const accessToken = accessTokenData ? accessTokenData.toString('utf-8') : '';

        const refreshTokenData = findFieldInBlob(oauthInfo, 3);
        const refreshToken = refreshTokenData ? refreshTokenData.toString('utf-8') : '';

        if (refreshToken && refreshToken.startsWith('1//') && accessToken) {
            return { refreshToken, accessToken };
        }

        return null;
    } catch (error) {
        return null;
    }
}

function findFieldInBlob(data: Buffer, targetField: number): Buffer | null {
    let offset = 0;
    while (offset < data.length) {
        try {
            const tag = readVarint(data, offset);
            const wireType = tag.value & 7;
            const fieldNum = tag.value >> 3;
            if (fieldNum === targetField && wireType === 2) {
                const len = readVarint(data, tag.newOffset);
                return data.subarray(len.newOffset, len.newOffset + len.value);
            }
            offset = skipField(data, tag.newOffset, wireType);
        } catch { break; }
    }
    return null;
}


/** 深度杀死所有 Antigravity 相关的进程 */
export function nuclearKill(): void {
    const platform = os.platform();
    console.log('[Antigravity] Executing Nuclear Kill...');

    try {
        if (platform === 'darwin') {
            // 杀掉主应用、所有 Helper 进程、以及可能存在的 Electron 独立进程
            execSync('pkill -9 -i "Antigravity"', { stdio: 'ignore' });
            execSync('pkill -9 -f "Antigravity Helper"', { stdio: 'ignore' });
            execSync('pkill -9 -f "jetskiAgent"', { stdio: 'ignore' });
        } else if (platform === 'win32') {
            execSync('taskkill /F /IM Antigravity.exe /T', { stdio: 'ignore' });
        }
    } catch (e) {
        // 忽略进程不存在的错误
    }
}

// ============ Protobuf 工具 ============

function encodeVarint(value: number): number[] {
    const bytes: number[] = [];
    let v = value >>> 0;
    while (v >= 0x80) {
        bytes.push((v & 0x7F) | 0x80);
        v = v >>> 7;
    }
    bytes.push(v);
    return bytes;
}

function createOAuthField(accessToken: string, refreshToken: string, expiry: number): Buffer {
    const parts: number[] = [];
    const addString = (field: number, str: string) => {
        parts.push(...encodeVarint((field << 3) | 2));
        const buf = Buffer.from(str, 'utf-8');
        parts.push(...encodeVarint(buf.length));
        for (const b of buf) parts.push(b);
    };

    addString(1, accessToken);
    addString(2, 'Bearer');
    addString(3, refreshToken);

    // Field 4: expiry
    const timestampParts: number[] = [];
    timestampParts.push(...encodeVarint((1 << 3) | 0));
    timestampParts.push(...encodeVarint(expiry));
    parts.push(...encodeVarint((4 << 3) | 2));
    parts.push(...encodeVarint(timestampParts.length));
    parts.push(...timestampParts);

    const tag6 = (6 << 3) | 2;
    const field6: number[] = [];
    field6.push(...encodeVarint(tag6));
    field6.push(...encodeVarint(parts.length));
    field6.push(...parts);

    return Buffer.from(field6);
}

// ============ 终极注入 ============

export async function injectToken(accessToken: string, refreshToken: string, expiry: number, email?: string): Promise<void> {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) throw new Error('数据库不存在');

    console.log('[Antigravity] Starting Nuclear Injection (CLI mode)...');
    setDbFileWritable(true);

    try {
        // 1. 读取并更新 jetskiStateSync
        const jetskiKey = 'jetskiStateSync.agentManagerInitState';
        const currentValue = execSync(
            `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = '${jetskiKey}'"`,
            { encoding: 'utf-8', timeout: 10000 }
        ).trim();

        if (currentValue) {
            const blob = Buffer.from(currentValue, 'base64');
            const cleanData = removeField(blob, 6);
            const newField = createOAuthField(accessToken, refreshToken, expiry);
            const finalData = Buffer.concat([cleanData, newField]);
            const newValue = finalData.toString('base64').replace(/'/g, "''");
            execSync(
                `sqlite3 "${dbPath}" "UPDATE ItemTable SET value = '${newValue}' WHERE key = '${jetskiKey}'"`,
                { encoding: 'utf-8', timeout: 10000 }
            );
            console.log('[Antigravity] Updated jetskiStateSync');
        }

        // 2. 更新 antigravityAuthStatus
        if (email) {
            const authKey = 'antigravityAuthStatus';
            const newAuth = JSON.stringify({
                email: email,
                apiKey: accessToken,
                name: email.split('@')[0],
            }).replace(/'/g, "''");
            execSync(
                `sqlite3 "${dbPath}" "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${authKey}', '${newAuth}')"`,
                { encoding: 'utf-8', timeout: 10000 }
            );
            console.log('[Antigravity] Written fresh antigravityAuthStatus');
        }

        // 3. 删除缓存键
        const keysToDelete = [
            'google.geminicodeassist',
            'google.geminicodeassist.hasRunOnce',
            'geminiCodeAssist.chatThreads'
        ];
        for (const k of keysToDelete) {
            try {
                execSync(
                    `sqlite3 "${dbPath}" "DELETE FROM ItemTable WHERE key = '${k}' OR key LIKE '${k}.%'"`,
                    { encoding: 'utf-8', timeout: 10000 }
                );
            } catch (e) { }
        }

        // 4. 重置 Onboarding
        execSync(
            `sqlite3 "${dbPath}" "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('antigravityOnboarding', 'true')"`,
            { encoding: 'utf-8', timeout: 10000 }
        );

        console.log('[Antigravity] Final DB written successfully');
    } catch (error) {
        console.error('[Antigravity] Injection failed:', error);
        throw error;
    }
}

// 辅助：从 Buffer 中移除 Proto 字段 (复用之前的实现)
function removeField(data: Buffer, fieldNum: number): Buffer {
    const result: number[] = [];
    let offset = 0;
    while (offset < data.length) {
        const startOffset = offset;
        const tag = readVarint(data, offset);
        const wireType = tag.value & 7;
        const currentField = tag.value >> 3;
        const nextOffset = skipField(data, tag.newOffset, wireType);
        if (currentField !== fieldNum) {
            for (let i = startOffset; i < nextOffset; i++) result.push(data[i]);
        }
        offset = nextOffset;
    }
    return Buffer.from(result);
}

function readVarint(data: Buffer, offset: number) {
    let result = 0, shift = 0, pos = offset;
    while (pos < data.length) {
        const byte = data[pos++];
        result |= (byte & 0x7F) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return { value: result >>> 0, newOffset: pos };
}

function skipField(data: Buffer, offset: number, wireType: number): number {
    if (wireType === 0) return readVarint(data, offset).newOffset;
    if (wireType === 1) return offset + 8;
    if (wireType === 2) {
        const len = readVarint(data, offset);
        return len.newOffset + len.value;
    }
    if (wireType === 5) return offset + 4;
    throw new Error('Unknown wire type');
}

// ============ 暴露给外部的切换接口 ============

export async function switchAccountSeamless(accessToken: string, refreshToken: string, expiry: number, email?: string): Promise<void> {
    console.log('[Antigravity] === 触发无感切换 (V13.0 - 精简版) ===');

    // 0. 标记切号操作
    markSwitchPending(undefined, email);

    // 1. 先杀进程（释放数据库锁）
    console.log('[Antigravity] Step 1: 关闭 Antigravity...');
    nuclearKill();
    await new Promise(r => setTimeout(r, 1000));

    // 2. 清理锁文件
    cleanUpLockFiles();
    await new Promise(r => setTimeout(r, 200));

    // 3. 注入新 Token
    console.log('[Antigravity] Step 2: 注入新 Token...');
    await injectToken(accessToken, refreshToken, expiry, email);

    console.log('[Antigravity] 注入完成，正在重启...');
    if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Antigravity'], { detached: true, stdio: 'ignore' }).unref();
    }
}

export async function switchAccountFull(accessToken: string, refreshToken: string, expiry: number, email?: string): Promise<void> {
    nuclearKill();
    await new Promise(r => setTimeout(r, 1000));
    cleanUpLockFiles();
    await injectToken(accessToken, refreshToken, expiry, email);
    console.log('[Antigravity] 完整切换完成，请手动或点击“重载”打开 IDE');
}
