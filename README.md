# Anti Quota - Antigravity 多账号配额管理

🚀 一个强大的 VS Code 扩展，用于管理 Antigravity 多账号和实时监控配额使用情况。

---

## ✨ 核心功能

### 🔐 多账号管理

- **添加账号**: 支持 refresh_token 导入和 Google OAuth 授权
- **批量导入**: 一次性导入多个账号（支持 JSON 数组或换行分隔）
- **自动导入**: 首次启动自动导入 Antigravity/Cursor/Windsurf 当前登录账号

### ⚡ 无感切换

- **无感切换**: 直接修改 IDE 数据库 Token，无需重启！
- **重启切换**: 传统方式，关闭 IDE 后修改，需要手动重启

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

## ⚙️ 配置选项

在 VS Code 设置中搜索 `antiQuota`：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `refreshInterval` | 30 | 配额刷新间隔（秒） |
| `enabled` | true | 是否启用自动刷新 |
| `autoSwitch.enabled` | true | 是否启用自动切换 |
| `autoSwitch.threshold` | 10 | 自动切换阈值（%） |
| `autoSwitch.checkInterval` | 60 | 自动切换检查间隔（秒） |
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

A: 这是正常的。无感切换只修改了底层 Token，UI 显示的用户信息需要重启才会更新。可通过状态栏配额变化确认切换成功。

**Q: 自动切换没有生效？**

A: 检查以下几点：

1. 确保 `antiQuota.autoSwitch.enabled` 为 `true`
2. 确保有多个账号且配额数据已获取
3. 自动切换至少间隔 5 分钟，避免频繁切换

**Q: 添加账号失败？**

A: 确保 refresh_token 格式正确（以 `1//` 开头）。如果使用 OAuth，请确保在 [Google 权限管理](https://myaccount.google.com/permissions) 中撤销应用权限后重试。

---

## 📝 更新日志

### v2.0.0

- 🎉 全新多账号管理系统
- ⚡ 无感切换功能
- 🤖 配额自动切换功能
- 🎨 侧边栏账号管理面板
- 📊 配额详情面板

### v1.0.2

- 配额监控基础功能

---

## 📄 License

MIT

---

## 🙏 致谢

灵感来源于 [Antigravity-Assistant](https://github.com/carlxing521/Antigravity-Assistant)
