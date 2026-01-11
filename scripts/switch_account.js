/**
 * 终极版账号切换脚本 v5 - 深度跨平台版本 (macOS + Windows)
 * 支持 Windows 自动下载 sqlite3.exe
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { createWriteStream } = require('fs');

// ============ 平台检测 ============
const platform = process.platform;
const isWindows = platform === 'win32';
const isMac = platform === 'darwin';

// ============ 环境变量清理 ============
Object.keys(process.env).forEach(key => {
    if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_') || key.startsWith('ATOM_')) {
        delete process.env[key];
    }
});

// 确保 PATH 包含标准路径 (仅非 Windows)
if (!isWindows) {
    process.env.PATH = `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`;
}

// ============ 常量与配置 ============
const [, , accessToken, refreshToken, expiryStr, email] = process.argv;
const expiry = parseInt(expiryStr);
const homeDir = os.homedir();
const antiQuotaDir = path.join(homeDir, '.anti-quota');
const logFile = path.join(antiQuotaDir, 'switch_debug.log');

// 确保目录存在
if (!fs.existsSync(antiQuotaDir)) {
    fs.mkdirSync(antiQuotaDir, { recursive: true });
}

function log(msg) {
    const time = new Date().toISOString();
    const line = `[${time}] ${msg}\n`;
    try {
        fs.appendFileSync(logFile, line);
    } catch (e) { }
    console.log(line.trim());
}

log(`\n\n========== 终极切换 v5 开始 [PID: ${process.pid}] [平台: ${platform}] ==========`);
log(`目标: ${email}`);

// ============ 0. 环境路径 (跨平台) ============
const userDataDir = isWindows
    ? path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Antigravity')
    : path.join(homeDir, 'Library/Application Support/Antigravity');

const dbPath = path.join(userDataDir, 'User/globalStorage/state.vscdb');
const sqlite3Path = path.join(antiQuotaDir, 'sqlite3.exe');

// Windows 下可能的应用安装路径
const windowsAppPaths = [
    path.join(process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), 'Programs', 'Antigravity', 'Antigravity.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Antigravity', 'Antigravity.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Antigravity', 'Antigravity.exe'),
];

log(`数据目录: ${userDataDir}`);
log(`数据库路径: ${dbPath}`);

// ============ 自动下载 SQLite3 工具 (仅 Windows) ============

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        log(`正在下载: ${url}`);
        const file = createWriteStream(dest);

        const request = (urlStr) => {
            https.get(urlStr, (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    request(response.headers.location);
                    return;
                }
                if (response.statusCode !== 200) {
                    reject(new Error(`下载失败: HTTP ${response.statusCode}`));
                    return;
                }
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
            }).on('error', (err) => {
                fs.unlink(dest, () => { });
                reject(err);
            });
        };
        request(url);
    });
}

function unzip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        try {
            execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, {
                timeout: 30000
            });
            resolve();
        } catch (e) {
            reject(e);
        }
    });
}

async function ensureSqlite3() {
    if (!isWindows) {
        try {
            execSync('sqlite3 --version', { stdio: 'ignore', timeout: 3000 });
            return 'sqlite3';
        } catch (e) {
            throw new Error('sqlite3 未安装，请在 macOS 上运行: brew install sqlite3');
        }
    }

    if (fs.existsSync(sqlite3Path)) {
        try {
            execSync(`"${sqlite3Path}" --version`, { stdio: 'ignore', timeout: 3000 });
            return sqlite3Path;
        } catch (e) {
            fs.unlinkSync(sqlite3Path);
        }
    }

    log('首次运行，正在为 Windows 下载 sqlite3.exe (约 1MB)...');
    const zipUrl = 'https://www.sqlite.org/2024/sqlite-tools-win-x64-3470000.zip';
    const zipPath = path.join(antiQuotaDir, 'sqlite3.zip');
    const extractDir = path.join(antiQuotaDir, 'sqlite3_temp');

    try {
        await downloadFile(zipUrl, zipPath);
        if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
        await unzip(zipPath, extractDir);

        const files = fs.readdirSync(extractDir);
        for (const file of files) {
            const fullPath = path.join(extractDir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                const exe = path.join(fullPath, 'sqlite3.exe');
                if (fs.existsSync(exe)) {
                    fs.copyFileSync(exe, sqlite3Path);
                    break;
                }
            } else if (file === 'sqlite3.exe') {
                fs.copyFileSync(fullPath, sqlite3Path);
                break;
            }
        }

        fs.unlinkSync(zipPath);
        fs.rmSync(extractDir, { recursive: true, force: true });

        if (!fs.existsSync(sqlite3Path)) throw new Error('解压后未找到 sqlite3.exe');
        log('✓ sqlite3.exe 安装成功');
        return sqlite3Path;
    } catch (e) {
        log(`❌ 自动下载 sqlite3 失败: ${e.message}`);
        throw e;
    }
}

// ============ 1. 彻底杀死 Antigravity (跨平台) ============

async function killAntigravity() {
    log('正在清理旧进程...');

    if (isWindows) {
        try {
            // 使用 taskkill 强制结束进程树
            execSync('taskkill /F /IM Antigravity.exe /T', { stdio: 'ignore', timeout: 5000 });
            log('✓ taskkill 命令已执行');
        } catch (e) { }
    } else {
        try {
            execSync('osascript -e \'tell application "Antigravity" to quit\'', { timeout: 2000 });
        } catch (e) { }

        await new Promise(r => setTimeout(r, 1000));

        try {
            execSync(`pkill -9 -f "Antigravity.app"`, { stdio: 'ignore' });
        } catch (e) { }
    }

    await new Promise(r => setTimeout(r, 1500));
    log('✓ 进程清理完成');
}

// ============ 2. 清理锁与缓存 ============

function cleanLocksAndCache() {
    log('正在清理锁文件...');

    const locks = ['code.lock', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'];

    locks.forEach(lock => {
        const p = path.join(userDataDir, lock);
        if (fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
                log(`✓ 已清理锁文件: ${lock}`);
            } catch (e) {
                log(`无法清理锁文件 ${lock}: ${e.message}`);
            }
        }
    });

    // 清理数据库 WAL
    ['-wal', '-shm'].forEach(suffix => {
        const p = dbPath + suffix;
        if (fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
                log(`✓ 已清理数据库锁: ${suffix}`);
            } catch (e) { }
        }
    });
}

// ============ 3. Protobuf 编解码 ============

function encodeVarint(value) {
    const buf = [];
    let v = BigInt(value);
    while (v >= 128n) {
        buf.push(Number((v & 127n) | 128n));
        v >>= 7n;
    }
    buf.push(Number(v));
    return Buffer.from(buf);
}

function readVarint(data, offset) {
    let result = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < data.length) {
        const byte = data[pos];
        result |= BigInt(byte & 0x7F) << shift;
        pos += 1;
        if ((byte & 0x80) === 0) break;
        shift += 7n;
    }
    return { value: result, newOffset: pos };
}

function removeField(data, fieldNum) {
    const pieces = [];
    let offset = 0;
    while (offset < data.length) {
        const start = offset;
        let tagRes;
        try { tagRes = readVarint(data, offset); } catch (e) { break; }
        const wireType = Number(tagRes.value & 7n);
        const currentField = Number(tagRes.value >> 3n);
        let end;
        if (wireType === 0) end = readVarint(data, tagRes.newOffset).newOffset;
        else if (wireType === 1) end = tagRes.newOffset + 8;
        else if (wireType === 2) {
            const lenRes = readVarint(data, tagRes.newOffset);
            end = lenRes.newOffset + Number(lenRes.value);
        } else if (wireType === 5) end = tagRes.newOffset + 4;
        else break;
        if (currentField !== fieldNum) pieces.push(data.slice(start, end));
        offset = end;
    }
    return Buffer.concat(pieces);
}

function createOauthField(accessToken, refreshToken, expiry) {
    const field1 = Buffer.concat([encodeVarint((1 << 3) | 2), encodeVarint(accessToken.length), Buffer.from(accessToken, 'utf-8')]);
    const field2 = Buffer.concat([encodeVarint((2 << 3) | 2), encodeVarint(6), Buffer.from("Bearer", 'utf-8')]);
    const field3 = Buffer.concat([encodeVarint((3 << 3) | 2), encodeVarint(refreshToken.length), Buffer.from(refreshToken, 'utf-8')]);
    const timestampMsg = Buffer.concat([encodeVarint((1 << 3) | 0), encodeVarint(expiry)]);
    const field4 = Buffer.concat([encodeVarint((4 << 3) | 2), encodeVarint(timestampMsg.length), timestampMsg]);
    const oauthInfo = Buffer.concat([field1, field2, field3, field4]);
    return Buffer.concat([encodeVarint((6 << 3) | 2), encodeVarint(oauthInfo.length), oauthInfo]);
}

// ============ 4. 数据库注入 ============

async function injectToken(sqlite3Cmd) {
    log('正在注入 Token...');

    if (!fs.existsSync(dbPath)) throw new Error(`数据库文件不存在: ${dbPath}`);

    let currentData = '';
    try {
        const getCmd = isWindows
            ? `"${sqlite3Cmd}" "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'jetskiStateSync.agentManagerInitState'"`
            : `${sqlite3Cmd} "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'jetskiStateSync.agentManagerInitState'"`;
        currentData = execSync(getCmd, { encoding: 'utf-8', timeout: 10000 }).trim();
    } catch (e) { }

    let finalB64;
    if (!currentData) {
        finalB64 = createOauthField(accessToken, refreshToken, expiry).toString('base64');
    } else {
        const blob = Buffer.from(currentData, 'base64');
        const finalData = Buffer.concat([removeField(blob, 6), createOauthField(accessToken, refreshToken, expiry)]);
        finalB64 = finalData.toString('base64');
    }

    const sql = `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('jetskiStateSync.agentManagerInitState', '${finalB64}');
INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('antigravityOnboarding', 'true');`;

    const tmpSql = path.join(os.tmpdir(), `switch_${Date.now()}.sql`);
    fs.writeFileSync(tmpSql, sql);

    try {
        if (isWindows) {
            // Windows 下使用 .read 命令更加稳定
            execSync(`"${sqlite3Cmd}" "${dbPath}" ".read '${tmpSql.replace(/\\/g, '/')}'"`, { shell: 'cmd.exe', timeout: 10000 });
        } else {
            execSync(`${sqlite3Cmd} "${dbPath}" < "${tmpSql}"`, { timeout: 10000 });
        }
        log('✓ 数据库注入成功');
    } finally {
        try { fs.unlinkSync(tmpSql); } catch (e) { }
    }
}

// ============ 5. 恢复状态 (跨平台) ============

async function restoreState(sqlite3Cmd) {
    const backupFile = path.join(antiQuotaDir, 'state_backup.json');
    if (!fs.existsSync(backupFile)) return;

    log('正在恢复聊天状态...');
    try {
        const backupContent = fs.readFileSync(backupFile, 'utf-8');
        const backupData = JSON.parse(backupContent);

        const sqlParts = [];
        for (const [key, value] of Object.entries(backupData)) {
            const escapedValue = (value + '').replace(/'/g, "''");
            sqlParts.push(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${key}', '${escapedValue}');`);
        }

        if (sqlParts.length > 0) {
            const tmpSql = path.join(os.tmpdir(), `restore_${Date.now()}.sql`);
            fs.writeFileSync(tmpSql, sqlParts.join('\n'));
            if (isWindows) {
                execSync(`"${sqlite3Cmd}" "${dbPath}" ".read '${tmpSql.replace(/\\/g, '/')}'"`, { shell: 'cmd.exe', timeout: 10000 });
            } else {
                execSync(`${sqlite3Cmd} "${dbPath}" < "${tmpSql}"`, { timeout: 10000 });
            }
            fs.unlinkSync(tmpSql);
            log(`✓ 成功恢复了 ${sqlParts.length} 个状态键`);
        }
    } catch (e) {
        log(`❌ 恢复状态失败: ${e.message}`);
    }
}

// ============ 6. 启动应用 (跨平台) ============

function isProcessAlive() {
    try {
        if (isWindows) {
            const check = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /NH', { encoding: 'utf-8' }).trim();
            return check.includes('Antigravity.exe');
        } else {
            const check = execSync('ps -ef | grep "/Applications/Antigravity.app/Contents/MacOS/Electron" | grep -v grep | grep -v "--type="', { encoding: 'utf-8' }).trim();
            return !!check;
        }
    } catch (e) { return false; }
}

async function startAntigravity() {
    log('正在尝试拉起 Antigravity...');

    if (isWindows) {
        let launched = false;
        for (const appPath of windowsAppPaths) {
            if (fs.existsSync(appPath)) {
                log(`通过路径启动: ${appPath}`);
                spawn(appPath, [], { detached: true, stdio: 'ignore', shell: true }).unref();
                launched = true;
                break;
            }
        }
        if (!launched) {
            log('未找到安装路径，尝试使用 start 命令...');
            spawn('start', ['""', 'Antigravity'], { detached: true, stdio: 'ignore', shell: true }).unref();
        }
    } else {
        spawn('open', ['-a', 'Antigravity'], { detached: true, stdio: 'ignore' }).unref();
        await new Promise(r => setTimeout(r, 4000));
        if (!isProcessAlive()) {
            spawn('open', ['/Applications/Antigravity.app'], { detached: true, stdio: 'ignore' }).unref();
        }
        try {
            spawn('osascript', ['-e', 'tell application "Antigravity" to activate'], { detached: true, stdio: 'ignore' }).unref();
        } catch (e) { }
    }

    // 生存确认
    for (let i = 1; i <= 3; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (isProcessAlive()) {
            log('✓✓✓ 确认主进程已在运行中！');
            return;
        }
    }
    log('警告: 应用未能在预期时间内响应，请检查运行状态。');
}

// ============ 主流程 ============

async function main() {
    try {
        if (!accessToken || !refreshToken) throw new Error('参数缺失');

        const sqlite3Cmd = await ensureSqlite3();
        log(`使用 sqlite3 指令: ${sqlite3Cmd}`);

        await killAntigravity();
        cleanLocksAndCache();

        await new Promise(r => setTimeout(r, 1000));
        await injectToken(sqlite3Cmd);
        await restoreState(sqlite3Cmd);

        await new Promise(r => setTimeout(r, 1000));
        await startAntigravity();

        log('========== 终极切换 v5 完成！ ==========');
    } catch (e) {
        log(`\n!!! CRITICAL FAILURE !!!\n${e.message}\n${e.stack}`);
        process.exit(1);
    }
}

main();
