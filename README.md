# Anti Quota

> Antigravity 配额实时监控 VS Code 插件

## 功能特点

- 🔄 **实时刷新**：默认每 10 秒自动刷新配额（可配置）
- 📊 **状态栏显示**：在 VS Code 底部显示 Claude、Gemini Pro、Gemini Flash 的配额
- 🖱️ **点击刷新**：点击状态栏配额即可手动刷新
- 🔗 **复用登录**：自动使用 Antigravity IDE 的登录状态，无需单独登录

## 前置条件

**必须安装并登录 [Antigravity IDE](https://antigravity.dev/)**

本插件直接读取 Antigravity IDE 的登录凭证，无需额外认证。

## 安装

### 方式一：从 GitHub Release 下载

1. 前往 [Releases](https://github.com/fhyfhy17/anti-quota/releases) 下载最新的 `.vsix` 文件
2. 在 VS Code 中按 `Cmd+Shift+P`，输入 `Extensions: Install from VSIX...`
3. 选择下载的 `.vsix` 文件

### 方式二：命令行安装

```bash
code --install-extension anti-quota-x.x.x.vsix
```

## 使用

安装后插件会自动启动，在状态栏显示配额信息：

```
🟢 Claude: 85%  🟡 G Pro: 45%  🟢 G Flash: 92%
```

- **点击状态栏**：手动刷新配额
- **悬停查看**：显示详细配额信息和重置时间

## 配置

在 VS Code 设置中可以配置：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `antiQuota.refreshInterval` | 10 | 自动刷新间隔（秒） |
| `antiQuota.enabled` | true | 是否启用自动刷新 |

## 状态图标

| 图标 | 含义 |
|------|------|
| 🟢 | 配额 >= 70% |
| 🟡 | 配额 30% - 70% |
| 🟠 | 配额 < 30% |
| 🔴 | 配额耗尽 |
| ⚪ | 未获取到数据 |

## 日志

查看输出面板 `Anti Quota` 可以看到详细日志（`View` → `Output` → 选择 `Anti Quota`）。

## 技术说明

插件直接调用 Google Cloud Code API (`cloudcode-pa.googleapis.com`) 获取配额信息，与 Antigravity IDE 使用相同的 API 和认证方式。

## License

MIT
