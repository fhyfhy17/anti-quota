/**
 * 终极版账号切换脚本 v3 - 彻底解决环境干扰、单例锁、启动卡死问题
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============ 环境变量清理 (核心：断绝与旧进程的血缘关系) ============
Object.keys(process.env).forEach(key => {
    if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_') || key.startsWith('ATOM_')) {
        delete process.env[key];
    }
});
// 确保 PATH 包含标准路径
process.env.PATH = `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`;

// ============ 常量与配置 ============
const [, , accessToken, refreshToken, expiryStr, email] = process.argv;
const expiry = parseInt(expiryStr);
const logFile = path.join(os.homedir(), '.anti_quota_debug.log');

function log(msg) {
    const time = new Date().toISOString();
    const line = `[${time}] ${msg}\n`;
    fs.appendFileSync(logFile, line);
    console.log(line);
}

log(`\n\n========== 终极切换 v3 开始 [PID: ${process.pid}] ==========`);
log(`目标: ${email}`);

// ============ 0. 环境路径 ============
const homeDir = os.homedir();
const dbPath = path.join(homeDir, 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb');
const userDataDir = path.join(homeDir, 'Library/Application Support/Antigravity');

// ============ 1. 彻底杀死 Antigravity ============

async function killAntigravity() {
    log('正在清理旧进程...');
    try {
        // 1. 柔性退出
        execSync('osascript -e \'tell application "Antigravity" to quit\'', { timeout: 2000 });
    } catch (e) { }

    await new Promise(r => setTimeout(r, 1000));

    // 2. 精确杀死 Antigravity 进程（不影响 VS Code 等其他 Electron 应用）
    try {
        // 只杀死 Antigravity.app 目录下的进程
        execSync(`pkill -9 -f "Antigravity.app"`, { stdio: 'ignore' });
    } catch (e) { }

    await new Promise(r => setTimeout(r, 1000));
    log('✓ 进程清理完成');
}

// ============ 2. 清理锁与缓存 (彻底断后) ============

function cleanLocksAndCache() {
    log('正在清理锁文件与原子缓存...');

    // 清理所有可能的锁文件
    const locks = [
        'code.lock',
        'SingletonLock',
        'SingletonCookie',
        'SingletonSocket'
    ];

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
    ['wal', 'shm'].forEach(s => {
        const p = dbPath + '-' + s;
        if (fs.existsSync(p)) {
            try { fs.unlinkSync(p); log(`✓ 已清理数据库锁: ${s}`); } catch (e) { }
        }
    });
}

// ============ 3. 数据库逻辑 (Protobuf) ============

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

async function inject() {
    log('正在注入 Token...');
    let currentData;
    try {
        currentData = execSync(`sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'jetskiStateSync.agentManagerInitState'"`).toString().trim();
    } catch (e) { currentData = ""; }

    let finalB64;
    if (!currentData) {
        finalB64 = createOauthField(accessToken, refreshToken, expiry).toString('base64');
    } else {
        const blob = Buffer.from(currentData, 'base64');
        const finalData = Buffer.concat([removeField(blob, 6), createOauthField(accessToken, refreshToken, expiry)]);
        finalB64 = finalData.toString('base64');
    }

    const sql = `
        INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('jetskiStateSync.agentManagerInitState', '${finalB64}');
        INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('antigravityOnboarding', 'true');
    `;
    const tmpSql = path.join(os.tmpdir(), `switch_${Date.now()}.sql`);
    fs.writeFileSync(tmpSql, sql);
    execSync(`sqlite3 "${dbPath}" < "${tmpSql}"`);
    fs.unlinkSync(tmpSql);
    log('✓ 数据库注入成功');
}

async function restoreState() {
    const backupFile = path.join(os.homedir(), '.anti-quota', 'state_backup.json');
    if (!fs.existsSync(backupFile)) {
        log('没有找到备份文件，跳过恢复');
        return;
    }

    log('正在强制恢复聊天状态...');
    try {
        const backupContent = fs.readFileSync(backupFile, 'utf-8');
        const backupData = JSON.parse(backupContent);

        const sqlParts = [];
        for (const [key, value] of Object.entries(backupData)) {
            // 注意：value 是 base64 字符串，需要转义单引号以防 SQL 注入（虽然备份文件是我们生成的）
            const escapedValue = value.replace(/'/g, "''");
            sqlParts.push(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${key}', '${escapedValue}');`);
            log(`- 准备恢复: ${key} (${value.length} 字节)`);
        }

        if (sqlParts.length > 0) {
            const tmpSql = path.join(os.tmpdir(), `restore_${Date.now()}.sql`);
            fs.writeFileSync(tmpSql, sqlParts.join('\n'));
            execSync(`sqlite3 "${dbPath}" < "${tmpSql}"`);
            fs.unlinkSync(tmpSql);
            log(`✓ 成功恢复了 ${sqlParts.length} 个状态键`);
        }

        // 恢复成功后删除备份文件，防止重复恢复
        // fs.unlinkSync(backupFile); 
        // 先不要删，方便调试
    } catch (e) {
        log(`❌ 恢复状态失败: ${e.message}`);
    }
}

// ============ 4. 终极启动逻辑 (异步 + 模拟用户) ============

async function safeStart() {
    log('执行拉起流程...');

    // 1. 第一次拉起 (使用异步 spawn，不阻塞系统)
    log('步骤 [1/3]: 异步 open 启动...');
    const p1 = spawn('open', ['-a', 'Antigravity'], { detached: true, stdio: 'ignore' });
    p1.unref();

    await new Promise(r => setTimeout(r, 4000));

    // 2. 检查进程
    let alive = false;
    try {
        // 精确匹配主进程，带路径
        const check = execSync('ps -ef | grep "/Applications/Antigravity.app/Contents/MacOS/Electron" | grep -v grep | grep -v "--type="').toString().trim();
        if (check) alive = true;
    } catch (e) { }

    if (!alive) {
        log('步骤 [2/3]: 再次尝试 open (冷启动)...');
        spawn('open', ['/Applications/Antigravity.app'], { detached: true, stdio: 'ignore' }).unref();
        await new Promise(r => setTimeout(r, 3000));
    }

    // 3. 最终唤醒：使用 AppleScript (即便已经运行也能前置)
    log('步骤 [3/3]: 执行 AppleScript 激活 (强力回弹)...');
    try {
        // 使用非阻塞的 spawn。osascript 有时会因为等待 UI 响应而超时
        const p3 = spawn('osascript', ['-e', 'tell application "Antigravity" to activate'], { detached: true, stdio: 'ignore' });
        p3.unref();
        log('✓ 激活指令已发出');
    } catch (e) {
        log(`激活指令异常: ${e.message}`);
    }

    // 生存确认
    for (let i = 1; i <= 3; i++) {
        log(`生存检查 #${i}...`);
        await new Promise(r => setTimeout(r, 2000));
        try {
            const check = execSync('ps -ef | grep "/Applications/Antigravity.app/Contents/MacOS/Electron" | grep -v grep | grep -v "--type="').toString().trim();
            if (check) {
                log('✓✓✓ 确认主进程已在运行中！');
                return;
            }
        } catch (e) { }
    }

    log('警告: 应用未能在预期时间内拉起，可能正在初始化，请观察 Dock 栏。');
}

// ============ 5. 主流程 ============

async function main() {
    try {
        await killAntigravity();
        cleanLocksAndCache();
        await inject();
        await restoreState();

        log('安静等待 1.5s 确保系统资源完全归位...');
        await new Promise(r => setTimeout(r, 1500));

        await safeStart();
        log('========== 终极切换任务完全结束！ ==========');

    } catch (e) {
        log(`\n!!! CRITICAL FAILURE !!!\n${e.message}\n${e.stack}`);
    }
}

main();
