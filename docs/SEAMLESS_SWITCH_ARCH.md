# Anti Quota 账号无感切换技术架构文档 (v2.6.0)

本文档记录了 Anti Quota 插件实现「无感、零操作、百分百成功率」账号切换的核心技术细节，旨在为后续维护及类似功能的开发提供参考。

## 1. 核心挑战

要在 Antigravity (VS Code 分支) 内部实现彻底的账号切换，必须解决以下三个矛盾：

1. **身份矛盾**：插件运行在应用内部，杀死应用进程会导致插件自身也被关掉，从而无法执行后续的拉起逻辑。
2. **状态矛盾**：简单的数据库修改会被 Electron 的 WAL 模式覆盖，或者因为单例锁文件（`code.lock`）残留导致重启失败。
3. **环境污染**（最隐蔽）：子进程会继承父进程的环境变量，导致新启动的应用因持有旧的 IPC 引用而卡死。

## 2. 终极架构方案：独立守护脚本模式

### 2.1 任务移交 (Service Side)

插件不再亲自执行杀进程操作，而是启动一个完全脱离的 Node.js 进程：

- **`detached: true`**：允许子进程在父进程退出后继续运行。
- **`unref()`**：断开事件循环关联，让 VS Code 可以立即关闭。
- **参数传递**：将 AccessToken, RefreshToken 等关键信息作为命令行参数传递。

### 2.2 守护脚本流程 (Script Side)

`scripts/switch_account.js` 承担了真正的切换任务，分为四个阶段：

#### 阶段一：环境隔离 (Environment Sterilization)

彻底删除所有 `VSCODE_` 和 `ELECTRON_` 开头的环境变量，确保 `open` 命令是在一个纯净的 Session 中执行。

#### 阶段二：彻底清理 (Total Cleanup)

1. **强力杀进程**：循环执行 `pkill -9`，确保 Antigravity 及其所有 Helper 进程彻底消失。
2. **清理文件锁**：
   - 删除 `~/Library/Application Support/Antigravity/code.lock` (解决单例冲突)。
   - 删除 `state.vscdb-wal` 和 `state.vscdb-shm` (防止数据库回滚)。
   - 删除 `Singleton*` 相关 Cookie 和 Socket 文件。

#### 阶段三：数据库注入 (Database Injection)

模仿 Antigravity-Manager 的逻辑，直接使用 `sqlite3` 修改 `state.vscdb`：

- 解析并重组 `jetskiStateSync.agentManagerInitState` 字段（Protobuf 格式）。
- 强制设置 `antigravityOnboarding` 为 `true` 绕过引导。

#### 阶段四：三重启动保障 (Triple Launch Assurance)

1. **异步 `open -a`**：发起标准系统启动。
2. **五次生存检查**：每 2 秒检测一次进程。
3. **AppleScript 强制激活**：执行 `tell application "Antigravity" to activate`，这模拟了用户手动点击图标的行为。

## 3. 关键代码快照 (v2.6.0)

### 环境变量清理

```javascript
Object.keys(process.env).forEach(key => {
    if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_')) {
        delete process.env[key];
    }
});
```

### 数据库注入 SQL

```sql
INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('jetskiStateSync.agentManagerInitState', '${finalB64}');
INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('antigravityOnboarding', 'true');
```

## 4. 总结

本方案代表了目前在 VS Code 架构下实现「应用级热重启」的最强实践。通过**环境变量隔离**、**物理文件锁清理**和**后台守护脚本**，成功将原本需要手动操作 5-6 步的流程浓缩为点击一次按钮，耗时约 5-8 秒。

---
*Created by Antigravity AI @ 2026-01-10*
