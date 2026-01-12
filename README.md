# Anti Quota - Antigravity 多账号配额管理

🚀 一个强大的 VS Code 扩展，用于管理 Antigravity 多账号和实时监控配额使用情况。

---

## ✨ 核心功能

### 🔐 多账号管理

- **添加账号**: 支持 refresh_token 导入和 Google OAuth 授权
- **批量导入**: 一次性导入多个账号（支持 JSON 数组或换行分隔）
- **自动导入**: 首次启动自动导入 Antigravity/Cursor/Windsurf 当前登录账号

### ⚡ 账号切换

- 点击账号右侧 **蓝色闪电 ⚡** 即可切换账号
- **全新实现**：参考 Antigravity-Manager，采用"关闭→注入→重启"方式
- **稳定可靠**：直接操作数据库，100% 成功率
- 切换过程：关闭 Antigravity → 备份数据库 → 注入 Token → 重启 Antigravity

### 🤖 自动切换（亮点功能）

- 当前账号配额低于设定阈值时，自动切换到配额更高的账号
- 可分模型配置阈值（默认 0% 关闭，需在设置中开启）

### 📊 实时监控

- 状态栏显示三大模型（Claude、Gemini Pro、Gemini Flash）配额
- 自动刷新（可配置间隔）

### 🕒 一键触发 Claude 倒计时

- 一键触发所有 Claude 模型（100% 满额状态）的 5 小时恢复倒计时
- 统一所有账号的恢复时间，确保在 5 小时后所有账号同时可用
- 通过侧边栏顶部的 **时钟图标 🕒** 操作，支持实时进度查看 (x/y)

---

## 📸 功能展示

### 侧边栏账号管理

- 账号卡片列表，显示模型配额和恢复倒计时
- 一键切换、刷新、禁用、删除账号
- 批量导入/导出账号
- 🕒 一键触发所有 Claude 倒计时（统一恢复时间）
- 设置页面：分模型配置自动切换阈值

### 状态栏

```
🟢 Claude: 85%  🟡 G Pro: 35%  🟢 G Flash: 92%
```

---

## 🚀 快速开始

### 首次使用

插件会自动检测并导入当前 Antigravity/Cursor/Windsurf 编辑器中的账号。

### 添加更多账号

#### 方式一：Refresh Token

1. 点击侧边栏 "+ Token" 标签
2. 粘贴 refresh_token（支持多个，换行分隔）
3. 点击"添加账号"

#### 方式二：Google OAuth

1. 点击侧边栏 "🔐 OAuth" 标签
2. 点击"开始 Google 授权"
3. 在浏览器完成授权，自动添加账号

---

## 🧪 开发与打包（VSIX）

改完代码后建议先更新 `package.json` 的 `version`，再打包，避免 IDE 因版本相同继续加载旧逻辑：

```bash
npm run package
```

生成 `anti-quota-<version>.vsix` 后，在 Antigravity / VS Code：

1. 打开命令面板 `Cmd+Shift+P`
2. 执行 `Extensions: Install from VSIX...`
3. 选择 `anti-quota-<version>.vsix`

---

## ⚙️ 配置选项

在 VS Code 设置中搜索 `antiQuota`：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `refreshInterval` | 10 | 配额刷新间隔（秒） |
| `enabled` | true | 是否启用自动刷新 |
| `autoSwitch.enabled` | true | 是否启用自动切换 |
| `autoSwitch.thresholds.claude` | 0 | Claude 自动切换阈值（%），0 表示关闭 |
| `autoSwitch.thresholds.gemini-pro` | 0 | Gemini Pro 自动切换阈值（%） |
| `autoSwitch.thresholds.gemini-flash` | 0 | Gemini Flash 自动切换阈值（%） |
| `autoSwitch.checkInterval` | 30 | 自动切换检查间隔（秒） |

---

## 📋 命令

| 命令 | 说明 |
|------|------|
| `Anti Quota: 刷新当前账号配额` | 手动刷新当前账号配额 |
| `Anti Quota: 刷新所有账号配额` | 刷新所有账号配额 |
| `Anti Quota: 显示配额详情` | 打开配额详情面板 |
| `Anti Quota: 打开账号管理` | 打开侧边栏账号管理 |
| `Anti Quota: 添加账号` | 快速添加账号 |
| `Anti Quota: 切换账号` | 切换到其他账号 |
| `Anti Quota: 开关自动切换` | 切换自动切换功能 |
| `Anti Quota: 显示日志` | 查看插件运行日志 |

---

## 🎨 配额颜色说明

| 颜色 | 百分比 | 状态 |
|------|--------|------|
| 🟢 绿色 | >= 50% | 健康 |
| 🟡 黄色 | 30% - 50% | 注意 |
| 🟠 橙色 | 10% - 30% | 警告 |
| 🔴 红色 | < 10% | 危险 |

---

## 💾 数据存储

- 账号数据存储在 `~/.anti-quota/accounts.json`
- 不会发送任何数据到第三方服务器
- Token 安全存储在本地

---

---

## 📄 License

MIT

---
