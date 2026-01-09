/**
 * 多窗口协调服务
 * 处理多个 VS Code 窗口同时运行时的状态同步和锁机制
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const LOCK_DIR = path.join(os.homedir(), '.anti-quota');
const LOCK_FILE = path.join(LOCK_DIR, '.lock');
const STATE_FILE = path.join(LOCK_DIR, '.state');

// 当前窗口的唯一标识
const WINDOW_ID = `${process.pid}-${Date.now()}`;

interface GlobalState {
    /** 主窗口 ID（负责自动切换的窗口） */
    masterWindowId?: string;
    /** 主窗口心跳时间 */
    masterHeartbeat?: number;
    /** 最后切换时间 */
    lastSwitchTime?: number;
    /** 最后切换的账号 ID */
    lastSwitchAccountId?: string;
    /** 账号文件最后修改时间 */
    accountsModifiedTime?: number;
}

let cachedState: GlobalState = {};
let heartbeatTimer: NodeJS.Timeout | undefined;
let fileWatchTimer: NodeJS.Timeout | undefined;
let onAccountsChanged: (() => void) | undefined;

/**
 * 初始化多窗口协调
 */
export function initialize(onAccountsChangedCallback?: () => void): void {
    onAccountsChanged = onAccountsChangedCallback;

    // 确保目录存在
    if (!fs.existsSync(LOCK_DIR)) {
        fs.mkdirSync(LOCK_DIR, { recursive: true });
    }

    // 尝试成为主窗口
    tryBecomeMaster();

    // 启动心跳
    heartbeatTimer = setInterval(() => {
        if (isMaster()) {
            updateHeartbeat();
        } else {
            // 检查主窗口是否还活着
            checkMasterAlive();
        }
    }, 5000);

    // 监听账号文件变化
    startFileWatcher();

    console.log(`[MultiWindow] Initialized, windowId: ${WINDOW_ID}, isMaster: ${isMaster()}`);
}

/**
 * 清理资源
 */
export function dispose(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
    }
    if (fileWatchTimer) {
        clearInterval(fileWatchTimer);
    }

    // 如果是主窗口，清理主窗口状态
    if (isMaster()) {
        const state = readState();
        delete state.masterWindowId;
        delete state.masterHeartbeat;
        writeState(state);
    }
}

/**
 * 检查当前窗口是否是主窗口
 */
export function isMaster(): boolean {
    const state = readState();
    return state.masterWindowId === WINDOW_ID;
}

/**
 * 尝试成为主窗口
 */
function tryBecomeMaster(): boolean {
    const state = readState();
    const now = Date.now();

    // 如果没有主窗口，或者主窗口心跳超时（15秒），则成为主窗口
    if (!state.masterWindowId ||
        !state.masterHeartbeat ||
        now - state.masterHeartbeat > 15000) {

        state.masterWindowId = WINDOW_ID;
        state.masterHeartbeat = now;
        writeState(state);
        console.log(`[MultiWindow] Became master window`);
        return true;
    }

    return false;
}

/**
 * 更新心跳
 */
function updateHeartbeat(): void {
    const state = readState();
    state.masterHeartbeat = Date.now();
    writeState(state);
}

/**
 * 检查主窗口是否还活着
 */
function checkMasterAlive(): void {
    const state = readState();
    const now = Date.now();

    if (state.masterHeartbeat && now - state.masterHeartbeat > 15000) {
        // 主窗口已死，尝试接管
        console.log(`[MultiWindow] Master window dead, trying to take over`);
        tryBecomeMaster();
    }
}

/**
 * 获取文件锁（用于写入操作）
 */
export async function acquireLock(timeout: number = 5000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        try {
            // 尝试创建锁文件（独占方式）
            const fd = fs.openSync(LOCK_FILE, 'wx');
            fs.writeSync(fd, WINDOW_ID);
            fs.closeSync(fd);
            return true;
        } catch (e: any) {
            if (e.code === 'EEXIST') {
                // 锁已存在，检查是否过期（5秒）
                try {
                    const stat = fs.statSync(LOCK_FILE);
                    if (Date.now() - stat.mtimeMs > 5000) {
                        // 锁已过期，删除它
                        fs.unlinkSync(LOCK_FILE);
                        continue;
                    }
                } catch {
                    // 文件可能已被删除
                }
                // 等待一小段时间后重试
                await sleep(50);
            } else {
                throw e;
            }
        }
    }

    return false;
}

/**
 * 释放文件锁
 */
export function releaseLock(): void {
    try {
        // 只删除自己创建的锁
        const content = fs.readFileSync(LOCK_FILE, 'utf-8');
        if (content === WINDOW_ID) {
            fs.unlinkSync(LOCK_FILE);
        }
    } catch {
        // 忽略错误
    }
}

/**
 * 使用锁执行操作
 */
export async function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const acquired = await acquireLock();
    if (!acquired) {
        throw new Error('无法获取文件锁，请稍后重试');
    }

    try {
        return await fn();
    } finally {
        releaseLock();
    }
}

/**
 * 记录切换事件
 */
export function recordSwitch(accountId: string): void {
    const state = readState();
    state.lastSwitchTime = Date.now();
    state.lastSwitchAccountId = accountId;
    writeState(state);
}

/**
 * 获取最后切换时间
 */
export function getLastSwitchTime(): number {
    const state = readState();
    return state.lastSwitchTime || 0;
}

/**
 * 检查是否可以执行自动切换
 * 只有主窗口可以执行，且距离上次切换至少 5 分钟
 */
export function canAutoSwitch(): boolean {
    if (!isMaster()) {
        return false;
    }

    const lastSwitch = getLastSwitchTime();
    const now = Date.now();

    // 至少间隔 5 分钟
    return now - lastSwitch >= 5 * 60 * 1000;
}

/**
 * 启动文件监听
 */
function startFileWatcher(): void {
    const accountsFile = path.join(LOCK_DIR, 'accounts.json');
    let lastModified = 0;

    try {
        if (fs.existsSync(accountsFile)) {
            lastModified = fs.statSync(accountsFile).mtimeMs;
        }
    } catch { }

    fileWatchTimer = setInterval(() => {
        try {
            if (fs.existsSync(accountsFile)) {
                const currentModified = fs.statSync(accountsFile).mtimeMs;
                if (currentModified > lastModified) {
                    lastModified = currentModified;
                    console.log(`[MultiWindow] Accounts file changed, notifying...`);
                    onAccountsChanged?.();
                }
            }
        } catch { }
    }, 2000);
}

/**
 * 获取当前窗口 ID
 */
export function getWindowId(): string {
    return WINDOW_ID;
}

// ============ 内部工具函数 ============

function readState(): GlobalState {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const content = fs.readFileSync(STATE_FILE, 'utf-8');
            cachedState = JSON.parse(content);
        }
    } catch {
        cachedState = {};
    }
    return cachedState;
}

function writeState(state: GlobalState): void {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        cachedState = state;
    } catch (e) {
        console.error('[MultiWindow] Failed to write state:', e);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
