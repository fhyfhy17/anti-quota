# Anti Quota

> Antigravity 配额实时监控 VS Code 插件

## 功能特点

- 🔄 **实时刷新**：默认每 10 秒自动刷新配额（可配置）
- 📊 **状态栏显示**：在 VS Code 底部显示 Claude、Gemini Pro、Gemini Flash 的配额
- 🖱️ **点击刷新**：点击状态栏任意配额即可手动刷新
- 🔐 **独立认证**：使用 Google OAuth 登录，不依赖其他应用

## 安装

1. 下载 `anti-quota-1.0.0.vsix` 文件
2. 在 VS Code 中按 `Cmd+Shift+P`，输入 `Extensions: Install from VSIX...`
3. 选择下载的 `.vsix` 文件

或使用命令行：

```bash
code --install-extension anti-quota-1.0.0.vsix
```

## 首次使用

1. 安装插件后，状态栏会显示 "🔑 未登录"
2. 点击状态栏或执行命令 `Anti Quota: 登录 Google`
3. 在浏览器中完成 Google 账号授权
4. 登录成功后，配额会自动刷新并显示

## 配置

在 VS Code 设置中可以配置：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `antiQuota.refreshInterval` | 10 | 自动刷新间隔（秒） |
| `antiQuota.enabled` | true | 是否启用自动刷新 |

## 命令

| 命令 | 说明 |
|------|------|
| `Anti Quota: 刷新配额` | 手动刷新配额 |
| `Anti Quota: 登录 Google` | 登录 Google 账号 |
| `Anti Quota: 登出` | 登出并清除认证信息 |

## 状态图标

- 🟢 绿色：配额 >= 70%
- 🟡 黄色：配额 30%-70%
- 🟠 橙色：配额 < 30%
- 🔴 红色：配额耗尽
- ⚪ 白色：未获取到数据
- 🔑 钥匙：需要登录

## 日志

查看输出面板 `Anti Quota` 可以看到详细日志。

## 技术说明

插件直接调用 Google Cloud Code API (`cloudcode-pa.googleapis.com`) 获取配额信息，与 Antigravity IDE 使用相同的 API。

## License

MIT
