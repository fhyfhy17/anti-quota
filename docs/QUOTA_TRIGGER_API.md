# 配额触发服务 - API 端点文档

## 概述

通过 Google Cloud Code 内部 API，对 Claude 模型发送最小请求以触发配额倒计时恢复。

---

## API 端点

### 主机

```
cloudcode-pa.googleapis.com
```

### 端点 1: 获取 Project ID

```
POST /v1internal:loadCodeAssist
```

**用途**: 获取当前账号关联的 `projectId`

**请求头**:

```
Authorization: Bearer {access_token}
User-Agent: antigravity/1.11.3 Darwin/arm64
Content-Type: application/json
```

**请求体**: `{}`

**响应**:

```json
{
  "cloudaicompanionProject": "bamboo-precept-xxxxx"
}
```

> 注: 字段名可能是 `cloudaicompanionProject` 或 `cloudaicompanion_project`

**默认值**: 如果获取失败，使用 `bamboo-precept-lgxtn`

---

### 端点 2: 发送内容生成请求

```
POST /v1internal:generateContent
```

**用途**: 发送最小请求消耗配额，触发倒计时

**请求头**:

```
Authorization: Bearer {access_token}
User-Agent: antigravity/1.11.3 Darwin/arm64
X-Goog-Api-Client: antigravity-ide/0.2.0
Content-Type: application/json
```

**请求体**:

```json
{
  "project": "bamboo-precept-xxxxx",
  "model": "gpt-oss-120b-medium",
  "request": {
    "contents": [{
      "role": "user",
      "parts": [{ "text": "Generate a short sentence to verify quota." }]
    }],
    "generationConfig": {
      "maxOutputTokens": 10,
      "temperature": 0.1
    }
  }
}
```

**响应状态码**:

| 状态码 | 含义 |
|-------|------|
| 200/201 | 请求成功，配额已消耗 |
| 429 | 配额已耗尽（也算成功触发） |
| 其他 | 失败 |

---

## 模型映射

| 目标模型 | 实际请求模型 | 说明 |
|---------|-------------|------|
| `claude` | `gpt-oss-120b-medium` | Claude 和 gpt-oss 共享配额池 |
| `gemini-2.5-pro` | `gemini-2.5-pro` | 直接使用 |
| `gemini-2.5-flash` | `gemini-2.5-flash` | 直接使用 |

> ⚠️ 目前只对 Claude 有效，Gemini 模型暂不支持此触发方式

---

## 核心函数 (quotaTriggerService.ts)

| 函数 | 用途 |
|------|------|
| `httpsRequest()` | 通用 HTTPS POST 请求封装 |
| `fetchProjectId()` | 调用端点1获取 projectId |
| `ensureValidToken()` | 确保 access_token 有效，自动刷新 |
| `triggerModel()` | 对单个模型发送请求 |
| `triggerAllFullQuotas()` | ⚡ 批量触发所有满配额 Claude |

---

## ⚡ 一键触发 Claude 倒计时（已实现）

**目标**: 对所有未开始倒计时的 Claude 模型发送请求，统一启动 5 小时恢复倒计时

**触发条件**: `percentage === 100`（配额满，从未使用或已恢复）

> 注意：API 返回的 `resetTime` 总是 `now + 5h`，无论是否真正触发过。
> 真正的判断依据是 `remainingFraction === 1`（即 percentage 100%）

**使用方式**:

1. 打开账号管理侧边栏
2. 点击顶部工具栏的 ⚡ 按钮
3. 确认后自动触发所有满配额 Claude 账号

**判断逻辑**:

```typescript
// 需要触发：配额 100% 满（从未使用或已恢复）
const needsTrigger = percentage === 100;  // remainingFraction === 1
```

---

## 文件位置

```
src/services/quotaTriggerService.ts
```
