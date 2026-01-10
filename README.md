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
- 详细说明: [docs/SEAMLESS_SWITCH.md](docs/SEAMLESS_SWITCH.md)

### 🤖 自动切换（亮点功能）

- 当前账号配额低于设定阈值时，自动切换到配额更高的账号
- 可配置阈值（默认 10%）和检查间隔
- 切换时可选择是否通知

### 📊 实时监控

- 状态栏显示三大模型（Claude、Gemini Pro、Gemini Flash）配额
- 彩色进度条直观展示配额剩余
- 自动刷新（可配置间隔）

---

## 📸 功能展示

### 侧边栏账号管理

- 账号卡片列表
- 配额进度条
- 一键切换、刷新、删除

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
3. 完成授权后，粘贴回调 URL
4. 点击"确认"

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
| `refreshInterval` | 30 | 配额刷新间隔（秒） |
| `enabled` | true | 是否启用自动刷新 |
| `autoSwitch.enabled` | true | 是否启用自动切换 |
| `autoSwitch.threshold` | 10 | 自动切换阈值（%） |
| `autoSwitch.checkInterval` | 30 | 自动切换检查间隔（秒），配额显著下降时会立即检查 |
| `autoSwitch.notifyOnSwitch` | true | 切换时显示通知 |

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

## 🔧 支持的编辑器

- Antigravity
- Cursor
- Windsurf
- Kiro
- 其他基于 VS Code 的编辑器

---

## ❓ 常见问题

**Q: 无感切换后，编辑器右上角用户信息没变？**

A: 当前方案会在登录完成后自动 `Reload Window`，正常情况下右上角账号会随之更新；如果没变，通常是登录时选错账号或登录被取消。

**Q: 自动切换没有生效？**

A: 检查以下几点：

1. 确保 `antiQuota.autoSwitch.enabled` 为 `true`
2. 确保有多个账号且配额数据已获取
3. 自动切换至少间隔 5 分钟，避免频繁切换

**Q: 添加账号失败？**

A: 确保 refresh_token 格式正确（以 `1//` 开头）。如果使用 OAuth，请确保在 [Google 权限管理](https://myaccount.google.com/permissions) 中撤销应用权限后重试。

---

## 📝 更新日志

### v2.8.0 ✨ 用户体验优化

- 🚫 **修复重复弹窗问题**：点击"取消"后30分钟内不再重复提示切换
- ⚙️ **设置面板**：可在账号管理侧边栏直接调整自动切换阈值，无需进入 VS Code 设置
- 🎚️ **可视化滑块**：拖动滑块即可调整阈值（1%-100%），实时显示当前值
- 🔔 **智能提醒**：新增"30分钟内不再提醒"按钮，更人性化的通知体验
- ⚡ **智能触发**：缩短检查间隔到30秒，配额显著下降（≥5%）时立即检查，无需等待
- 🔄 **实时刷新**：自动切换检查前会刷新所有账号配额，确保用最新数据做决策

### v2.0.0

- 🎉 全新多账号管理系统
- ⚡ 无感切换功能
- 🤖 配额自动切换功能
- 🎨 侧边栏账号管理面板
- 📊 配额详情面板

### v2.4.0 🎉 重大更新

- 🔥 **全新账号切换实现**：参考 Antigravity-Manager，采用"关闭→注入→重启"方式
- ✅ **100% 成功率**：直接操作数据库，不再依赖不稳定的 API
- 🚀 **更快更稳定**：无需手动操作，自动完成所有步骤
- 📝 **详细日志**：切换过程实时显示，问题一目了然

### v2.3.4

- ⚡ 重大改进：无感切换增加进度条提示，不再容易错过
- 🎯 优化用户体验：分步确认，每一步都有明确提示
- 🛡️ 增强错误处理：登录失败、超时、选错账号都有友好提示
- ✨ 支持取消操作：可随时中断切换流程

### v2.3.3

- ⚡ 优化无感切换体验：改为弹窗强提示，避免错过登录
- 🐛 修复部分环境下 Seamless Switch 无法弹出的问题

### v2.3.0 ~ v2.3.2

- 优化自动导入逻辑
- 修复模型排序问题

---

## 📄 License

MIT

---

## 🙏 致谢

灵感来源于 [Antigravity-Assistant](https://github.com/carlxing521/Antigravity-Assistant)
