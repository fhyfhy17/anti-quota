/**
 * Antigravity IDE 服务
 * 处理数据库读写、Token 注入、应用控制等
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawn } from 'child_process';

// ============ 路径配置 ============

/** 获取 Antigravity 数据库路径 */
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

// ============ 应用控制 ============

/** 检查 Antigravity 是否在运行 */
export function isAntigravityRunning(): boolean {
    const platform = os.platform();

    try {
        if (platform === 'darwin') {
            const result = execSync('pgrep -f "Antigravity.app"', { encoding: 'utf-8' });
            return result.trim().length > 0;
        } else if (platform === 'win32') {
            const result = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /NH', { encoding: 'utf-8' });
            return result.toLowerCase().includes('antigravity.exe');
        } else {
            const result = execSync('pgrep -f "antigravity"', { encoding: 'utf-8' });
            return result.trim().length > 0;
        }
    } catch {
        return false;
    }
}

/** 关闭 Antigravity */
export async function closeAntigravity(timeoutSecs: number = 10): Promise<void> {
    const platform = os.platform();

    if (!isAntigravityRunning()) {
        return;
    }

    try {
        if (platform === 'darwin') {
            try {
                execSync('osascript -e \'quit app "Antigravity"\'', { timeout: 5000 });
            } catch {
                execSync('pkill -9 -f "Antigravity.app"');
            }
        } else if (platform === 'win32') {
            execSync('taskkill /F /IM Antigravity.exe', { windowsHide: true });
        } else {
            execSync('pkill -9 -f "antigravity"');
        }
    } catch (error) {
        console.log('[Antigravity] Close command failed:', error);
    }

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutSecs * 1000) {
        if (!isAntigravityRunning()) {
            return;
        }
        await sleep(500);
    }

    if (isAntigravityRunning()) {
        throw new Error('无法关闭 Antigravity，请手动关闭后重试');
    }
}

/** 启动 Antigravity */
export async function startAntigravity(): Promise<void> {
    const platform = os.platform();

    try {
        if (platform === 'darwin') {
            execSync('open -a Antigravity', { stdio: 'pipe', timeout: 10000 });
            await sleep(3000);
        } else if (platform === 'win32') {
            execSync('start antigravity://', { stdio: 'ignore', windowsHide: true });
        } else {
            spawn('antigravity', [], { detached: true, stdio: 'ignore' }).unref();
        }
    } catch (error) {
        throw error;
    }
}

// ============ Protobuf 工具函数 ============

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

function readVarint(data: Buffer, offset: number): { value: number; newOffset: number } {
    let result = 0;
    let shift = 0;
    let pos = offset;

    while (pos < data.length) {
        const byte = data[pos];
        result |= (byte & 0x7F) << shift;
        pos++;
        if ((byte & 0x80) === 0) {
            break;
        }
        shift += 7;
        if (shift >= 35) break;
    }

    return { value: result >>> 0, newOffset: pos };
}

function skipField(data: Buffer, offset: number, wireType: number): number {
    switch (wireType) {
        case 0:
            return readVarint(data, offset).newOffset;
        case 1:
            return offset + 8;
        case 2:
            const { value: length, newOffset } = readVarint(data, offset);
            return newOffset + length;
        case 5:
            return offset + 4;
        default:
            throw new Error(`Unknown wire type: ${wireType}`);
    }
}

function removeField(data: Buffer, fieldNum: number): Buffer {
    const result: number[] = [];
    let offset = 0;

    while (offset < data.length) {
        const startOffset = offset;
        const { value: tag, newOffset } = readVarint(data, offset);
        const wireType = tag & 7;
        const currentField = tag >> 3;

        if (currentField === fieldNum) {
            offset = skipField(data, newOffset, wireType);
        } else {
            const nextOffset = skipField(data, newOffset, wireType);
            for (let i = startOffset; i < nextOffset; i++) {
                result.push(data[i]);
            }
            offset = nextOffset;
        }
    }

    return Buffer.from(result);
}

function findField(data: Buffer, targetField: number): Buffer | null {
    let offset = 0;

    while (offset < data.length) {
        try {
            const { value: tag, newOffset } = readVarint(data, offset);
            const wireType = tag & 7;
            const fieldNum = tag >> 3;

            if (fieldNum === targetField && wireType === 2) {
                const { value: length, newOffset: contentOffset } = readVarint(data, newOffset);
                return data.subarray(contentOffset, contentOffset + length);
            }

            offset = skipField(data, newOffset, wireType);
        } catch {
            break;
        }
    }

    return null;
}

function createOAuthField(accessToken: string, refreshToken: string, expiry: number): Buffer {
    const parts: number[] = [];

    // Field 1: access_token
    const tag1 = (1 << 3) | 2;
    parts.push(...encodeVarint(tag1));
    const accessBytes = Buffer.from(accessToken, 'utf-8');
    parts.push(...encodeVarint(accessBytes.length));
    for (const b of accessBytes) parts.push(b);

    // Field 2: token_type = "Bearer"
    const tag2 = (2 << 3) | 2;
    parts.push(...encodeVarint(tag2));
    const tokenType = Buffer.from('Bearer', 'utf-8');
    parts.push(...encodeVarint(tokenType.length));
    for (const b of tokenType) parts.push(b);

    // Field 3: refresh_token
    const tag3 = (3 << 3) | 2;
    parts.push(...encodeVarint(tag3));
    const refreshBytes = Buffer.from(refreshToken, 'utf-8');
    parts.push(...encodeVarint(refreshBytes.length));
    for (const b of refreshBytes) parts.push(b);

    // Field 4: expiry (Timestamp message)
    const timestampParts: number[] = [];
    const timestampTag = (1 << 3) | 0;
    timestampParts.push(...encodeVarint(timestampTag));
    timestampParts.push(...encodeVarint(expiry));

    const tag4 = (4 << 3) | 2;
    parts.push(...encodeVarint(tag4));
    parts.push(...encodeVarint(timestampParts.length));
    parts.push(...timestampParts);

    // 包装为 Field 6
    const tag6 = (6 << 3) | 2;
    const field6: number[] = [];
    field6.push(...encodeVarint(tag6));
    field6.push(...encodeVarint(parts.length));
    field6.push(...parts);

    return Buffer.from(field6);
}

// ============ 数据库操作 ============

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
        const oauthInfo = findField(blob, 6);
        if (!oauthInfo) {
            return null;
        }

        // Field 1: access_token
        const accessTokenData = findField(oauthInfo, 1);
        const accessToken = accessTokenData ? accessTokenData.toString('utf-8') : '';

        // Field 3: refresh_token
        const refreshTokenData = findField(oauthInfo, 3);
        const refreshToken = refreshTokenData ? refreshTokenData.toString('utf-8') : '';

        if (refreshToken && refreshToken.startsWith('1//') && accessToken) {
            return { refreshToken, accessToken };
        }

        return null;
    } catch (error) {
        return null;
    }
}

/** 注入 Token 到数据库（使用 sqlite3 CLI） */
export async function injectToken(accessToken: string, refreshToken: string, expiry: number): Promise<void> {
    const dbPath = getDbPath();

    if (!fs.existsSync(dbPath)) {
        throw new Error(`数据库不存在: ${dbPath}\n请先启动一次 Antigravity`);
    }

    try {
        const { execSync } = require('child_process');

        // 1. 读取当前数据
        const currentValue = execSync(
            `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'jetskiStateSync.agentManagerInitState'"`,
            { encoding: 'utf-8', timeout: 5000 }
        ).trim();

        if (!currentValue) {
            throw new Error('数据库中未找到 Token 数据，请先在 Antigravity 中登录一次');
        }

        // 2. Base64 解码
        const blob = Buffer.from(currentValue, 'base64');

        // 3. 移除旧 Field 6
        const cleanData = removeField(blob, 6);

        // 4. 创建新 Field 6
        const newField = createOAuthField(accessToken, refreshToken, expiry);

        // 5. 合并数据
        const finalData = Buffer.concat([cleanData, newField]);
        const finalB64 = finalData.toString('base64');

        // 6. 写入数据库
        execSync(
            `sqlite3 "${dbPath}" "UPDATE ItemTable SET value = '${finalB64}' WHERE key = 'jetskiStateSync.agentManagerInitState'"`,
            { timeout: 5000 }
        );

        // 7. 写入 Onboarding 标记
        execSync(
            `sqlite3 "${dbPath}" "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('antigravityOnboarding', 'true')"`,
            { timeout: 5000 }
        );

        console.log('[Antigravity] Token injected successfully');
    } catch (error) {
        console.error('[Antigravity] Inject token failed:', error);
        throw error;
    }
}

/** 切换账号(无感切换 - 不重启应用) */
export async function switchAccountSeamless(accessToken: string, refreshToken: string, expiry: number): Promise<void> {
    const dbPath = getDbPath();

    // 备份数据库
    if (fs.existsSync(dbPath)) {
        const backupPath = dbPath + '.backup';
        fs.copyFileSync(dbPath, backupPath);
    } else {
        throw new Error(`数据库不存在: ${dbPath}`);
    }

    // 直接注入 Token
    await injectToken(accessToken, refreshToken, expiry);

    // 【修复】重新加载窗口,确保 IDE 重新读取已修改的账号信息
    // 避免 IDE 过一会儿又把旧账号信息写回数据库
    console.log('[Antigravity] Reloading window to apply account switch...');
}

/** 切换账号（完整切换 - 关闭应用修改数据库） */
export async function switchAccountFull(accessToken: string, refreshToken: string, expiry: number): Promise<void> {
    // 1. 关闭 Antigravity
    await closeAntigravity(15);
    await sleep(2000);

    const dbPath = getDbPath();

    // 2. 备份数据库
    if (fs.existsSync(dbPath)) {
        const backupPath = dbPath + '.backup';
        fs.copyFileSync(dbPath, backupPath);
    } else {
        throw new Error(`数据库不存在: ${dbPath}`);
    }

    // 3. 注入 Token
    await injectToken(accessToken, refreshToken, expiry);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
