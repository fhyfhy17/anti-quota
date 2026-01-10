/**
 * Antigravity IDE 服务 (v11.0 - 终极物理同步版)
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawn } from 'child_process';
import initSqlJs from 'sql.js';

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
    const SQL = await initSqlJs({
        locateFile: (file: string) => path.join(__dirname, '../../node_modules/sql.js/dist', file)
    });

    if (!fs.existsSync(dbPath)) throw new Error('数据库不存在');

    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    try {
        console.log('[Antigravity] Starting Nuclear Injection...');

        // 1. 处理 jetskiStateSync (控制 AI 核心令牌)
        const jetskiKey = 'jetskiStateSync.agentManagerInitState';
        const jetskiRes = db.exec(`SELECT value FROM ItemTable WHERE key = '${jetskiKey}'`);
        if (jetskiRes.length && jetskiRes[0].values.length) {
            // 这里我们保持原有的其他字段，只替换 OAuth field (field 6)
            // 但为了保险，我们可以直接移除 key 再重新插入，或者使用我们的 Proto 工具
            // 简化处理：直接更新
            const currentValue = jetskiRes[0].values[0][0] as string;
            const blob = Buffer.from(currentValue, 'base64');
            const cleanData = removeField(blob, 6); // 借用之前的逻辑
            const newField = createOAuthField(accessToken, refreshToken, expiry);
            const finalData = Buffer.concat([cleanData, newField]);
            db.run(`UPDATE ItemTable SET value = ? WHERE key = ?`, [finalData.toString('base64'), jetskiKey]);
        }

        // 2. 处理 antigravityAuthStatus (控制 UI 身份和右上角显示)
        if (email) {
            const authKey = 'antigravityAuthStatus';
            const newAuth = {
                email: email,
                apiKey: accessToken,
                name: email.split('@')[0],
                // 彻底删除 proto 缓存，强制 IDE 重新握手
            };
            db.run(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`, [authKey, JSON.stringify(newAuth)]);
            console.log('[Antigravity] Written fresh antigravityAuthStatus');
        }

        // 3. 抹杀所有可能导致“跳回”的缓存键
        const keysToDelete = [
            'google.geminicodeassist',
            'google.geminicodeassist.hasRunOnce',
            'geminiCodeAssist.chatThreads'
        ];
        keysToDelete.forEach(k => {
            db.run(`DELETE FROM ItemTable WHERE key = ? OR key LIKE ?`, [k, k + '.%']);
        });

        // 4. 重置 Onboarding (确保引导逻辑重新触发以加载状态)
        db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", ['antigravityOnboarding', 'true']);

        const data = db.export();
        setDbFileWritable(true);
        fs.writeFileSync(dbPath, Buffer.from(data));
        console.log('[Antigravity] Final DB written successfully');

    } finally {
        db.close();
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
    console.log('[Antigravity] === 触发终极无感切换 (V11) ===');

    // 1. 预杀 (非强制，但增加成功率)
    nuclearKill();
    await new Promise(r => setTimeout(r, 800));

    // 2. 清理环境
    cleanUpLockFiles();

    // 3. 物理注入
    await injectToken(accessToken, refreshToken, expiry, email);

    // 4. 再次确保锁定
    // 我们不再把文件锁死，因为我们要重启它

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
