# Nano Banana 后端开放 API 文档（实现版）

- 文档版本：v1.1（对应当前代码实现）
- 服务版本：`1.0.0`
- API 前缀：`/v1`
- OpenAPI：`/openapi.json`
- Swagger UI：`/docs`

---

## 1. 总览

本后端是一个 Job 化的图片生成服务，支持以下模型：

- `gemini-3.1-flash-image-preview`（Nano Banana 2）
- `gemini-2.5-flash-image`（Nano Banana）
- `gemini-3-pro-image-preview`（Nano Banana Pro）

核心能力：

- 异步创建任务（Job）并通过 `job_id` 查询状态
- 支持按模型切换，并按模型能力约束参数（`mode/aspect_ratio/image_size`）
- 每个 Job 独立本地落盘（请求、响应、元信息、日志、输出图）
- 支持 `job_id + X-Job-Token` 鉴权（默认）
- 支持纯文本生成图、文本 + 多参考图生成图
- 支持重试（retry）为新 Job
- 支持费用估算与预算剩余查询
- 支持 SSE 状态订阅
- 提供模型能力查询：`GET /v1/models`

明确限制：

- **不提供** job 列表接口（`GET /v1/jobs` 不可用于枚举，当前会返回 405）
- 默认单 Job 仅返回 1 张结果图（`MAX_IMAGES_PER_JOB=1`）

---

## 2. 基础约定

### 2.1 Base URL

开发环境示例：

- `http://127.0.0.1:8000`

完整接口格式：

- `{BASE_URL}/v1/...`

### 2.2 内容类型

- JSON 接口：`application/json; charset=utf-8`
- 图片下载接口：`image/png`
- SSE：`text/event-stream`

### 2.3 时间格式

所有时间字段使用 ISO-8601（UTC）。

### 2.4 统一错误格式

```json
{
  "error": {
    "code": "STRING_ENUM",
    "message": "human readable",
    "debug_id": "uuid-or-hex",
    "details": {}
  }
}
```

---

## 3. 鉴权与安全

### 3.1 Job 级鉴权模式

由环境变量控制：`JOB_AUTH_MODE=TOKEN|ID_ONLY`

- `TOKEN`（默认）
  - 创建 Job 返回 `job_access_token`
  - 读取 Job 详情/请求/响应/图片/SSE、删除、retry 需带 `X-Job-Token`
- `ID_ONLY`
  - 忽略 `X-Job-Token`

### 3.2 Admin 鉴权（计费接口）

- 接口：`/v1/billing/summary`、`/v1/billing/google/remaining`
- Header：`X-Admin-Key`
- 若未配置 `ADMIN_API_KEY`，则不校验（开发友好模式）

### 3.3 job_id 与 image_id 校验

- `job_id` 正则：`^[a-f0-9]{32}$`
- `image_id` 正则：`^image_[0-9]+$`
- 非法格式直接返回 404

### 3.4 限流

对以下读取接口按 IP 限流（共享同一 bucket）：

- `GET /v1/jobs/{job_id}`
- `GET /v1/jobs/{job_id}/request`
- `GET /v1/jobs/{job_id}/response`
- `GET /v1/jobs/{job_id}/images/{image_id}`
- `GET /v1/jobs/{job_id}/events`

默认：`RATE_LIMIT_PER_MINUTE=60`，超限返回 429 + `RATE_LIMITED`。

---

## 4. 状态机与数据模型

### 4.1 Job 状态

- `QUEUED`
- `RUNNING`
- `SUCCEEDED`
- `FAILED`
- `DELETED`（当前删除为硬删除，通常不会长时间停留）

### 4.2 参数枚举与范围

`params` 字段（按模型动态校验）：

- `aspect_ratio`：由模型能力决定（通过 `/v1/models` 查询）
  - 当前不支持 `auto`
- `image_size`：
  - `gemini-3.1-flash-image-preview`：`512 | 1K | 2K | 4K`
  - `gemini-3-pro-image-preview`：`1K | 2K | 4K`
  - `gemini-2.5-flash-image`：固定分辨率，后端会归一化为 `AUTO`
- `thinking_level`：
  - 仅 `gemini-3.1-flash-image-preview` 支持（`Minimal | High`）
  - 其他模型传入会被拒绝
- `temperature`：`0 ~ 2`
- `timeout_sec`：`JOB_TIMEOUT_SEC_MIN ~ JOB_TIMEOUT_SEC_MAX`（默认 15~600）
- `max_retries`：`0 ~ 3`
- `mode`：`IMAGE_ONLY | TEXT_AND_IMAGE`
  - 兼容旧写法：`TEXT_IMAGE`（会自动映射到 `TEXT_AND_IMAGE`）
  - 若模型不支持文本输出（如 `gemini-3.1-flash-image-preview`），`TEXT_AND_IMAGE` 会被拒绝

### 4.3 Job 元信息（`GET /v1/jobs/{job_id}` 主体）

典型结构：

```json
{
  "job_id": "32c57a3eb3d2ededb5e0c60e71e382a9",
  "created_at": "2026-02-26T17:24:11.123456+00:00",
  "updated_at": "2026-02-26T17:24:36.654321+00:00",
  "status": "SUCCEEDED",
  "model": "gemini-3-pro-image-preview",
  "mode": "IMAGE_ONLY",
  "params": {
    "aspect_ratio": "1:1",
    "image_size": "1K",
    "temperature": 0.5,
    "timeout_sec": 90,
    "max_retries": 0
  },
  "result": {
    "images": [
      {
        "image_id": "image_0",
        "filename": "result/image_0.png",
        "mime": "image/png",
        "width": 1024,
        "height": 1024,
        "sha256": "..."
      }
    ]
  },
  "usage": {
    "prompt_token_count": 15,
    "cached_content_token_count": 0,
    "candidates_token_count": 1223,
    "thoughts_token_count": 151,
    "total_token_count": 1389
  },
  "billing": {
    "currency": "USD",
    "estimated_cost_usd": 0.149268,
    "breakdown": {
      "text_input_cost_usd": 0.00003,
      "text_output_cost_usd": 0.015238,
      "image_output_cost_usd": 0.134
    },
    "pricing_version": "2026-01-12",
    "pricing_notes": "fallback estimate from image_size fixed cost"
  },
  "error": null,
  "auth": {
    "token_hash": "sha256-hex"
  }
}
```

说明：

- `auth` 为当前实现中的内部字段；客户端不应依赖。
- 失败任务 `status=FAILED` 时，`error` 会有详细信息，`usage/billing` 也会存在（可能为 0）。

---

## 5. 接口详细定义

## 5.1 查询模型能力

### GET `/v1/models`

作用：返回后端当前支持的模型、参数能力、默认参数与默认模型。

成功响应 `200`（示意）：

```json
{
  "default_model": "gemini-3-pro-image-preview",
  "models": [
    {
      "model_id": "gemini-3.1-flash-image-preview",
      "label": "Nano Banana 2",
      "supports_text_output": false,
      "supports_image_size": true,
      "supported_modes": ["IMAGE_ONLY"],
      "supported_aspect_ratios": ["1:1", "1:4", "..."],
      "supported_image_sizes": ["512", "1K", "2K", "4K"],
      "default_params": {
        "aspect_ratio": "1:1",
        "image_size": "1K",
        "thinking_level": "High",
        "temperature": 0.7,
        "timeout_sec": 120,
        "max_retries": 1
      }
    }
  ]
}
```

---

## 5.2 健康检查

### GET `/v1/health`

作用：服务存活与版本检查。

成功响应 `200`：

```json
{
  "status": "ok",
  "time": "2026-02-26T17:16:49.870988Z",
  "version": "1.0.0"
}
```

---

## 5.3 创建 Job（异步）

### POST `/v1/jobs`

支持两种提交方式：

- JSON（适合纯文本/程序调用）
- multipart/form-data（适合上传参考图）

### Header

- 可选：`Idempotency-Key: <string>`

实现行为（当前）：

- 同一个 key 在 TTL 内重复请求，会直接返回第一次的 job（不做请求体一致性比对）
- TTL：`IDEMPOTENCY_TTL_SEC`（默认 24h）

### 方式 A：JSON 请求体

```json
{
  "prompt": "A realistic yellow banana on a wooden table",
  "model": "gemini-3.1-flash-image-preview",
  "params": {
    "aspect_ratio": "1:1",
    "image_size": "1K",
    "temperature": 0.7,
    "timeout_sec": 60,
    "max_retries": 1
  },
  "mode": "IMAGE_ONLY",
  "reference_images": [
    {
      "mime": "image/png",
      "data_base64": "..."
    }
  ]
}
```

说明：

- `reference_images` 为可选
- `data_base64` 为空会被忽略

### 方式 B：multipart/form-data

字段：

- `prompt`（必填）
- `model`（可选，默认取服务端 `DEFAULT_MODEL`）
- `mode`（可选，默认 `IMAGE_ONLY`）
- `params`（可选，JSON 字符串）
- 或分别传：`aspect_ratio`、`image_size`、`temperature`、`timeout_sec`、`max_retries`
- `reference_images`（可重复上传多个文件）

参考图约束：

- MIME 必须以 `image/` 开头
- 数量上限：`MAX_REFERENCE_IMAGES`（默认 14）

### 成功响应 `201`

```json
{
  "job_id": "string",
  "job_access_token": "string",
  "status": "QUEUED",
  "created_at": "ISO-8601"
}
```

当 `JOB_AUTH_MODE=ID_ONLY`：`job_access_token` 可能为 `null`。

### 常见错误

- `400 INVALID_INPUT`：参数校验失败、参考图类型不正确、参考图超上限
- `429 RATE_LIMITED`：队列满（`JOB_QUEUE_MAX`）

### curl 示例（multipart + 多图）

```bash
curl -X POST http://127.0.0.1:8000/v1/jobs \
  -F 'prompt=Use references to generate a clean product shot.' \
  -F 'model=gemini-2.5-flash-image' \
  -F 'mode=IMAGE_ONLY' \
  -F 'params={"aspect_ratio":"1:1","image_size":"1K","temperature":0.6,"timeout_sec":120,"max_retries":1}' \
  -F 'reference_images=@./ref1.jpg' \
  -F 'reference_images=@./ref2.png'
```

---

## 5.4 查询 Job 元信息

### GET `/v1/jobs/{job_id}`

Header：

- `X-Job-Token: <job_access_token>`（`JOB_AUTH_MODE=TOKEN` 时必需）

成功响应 `200`：返回完整 `meta`（见 4.3）。

错误：

- `403 JOB_TOKEN_INVALID`
- `404 JOB_NOT_FOUND`
- `429 RATE_LIMITED`

---

## 5.5 查询 Job 请求快照

### GET `/v1/jobs/{job_id}/request`

Header：`X-Job-Token`（TOKEN 模式）

成功响应 `200`：

```json
{
  "job_id": "...",
  "request": {
    "prompt": "...",
    "model": "gemini-3-pro-image-preview",
    "negative_prompt": null,
    "generation_config": {
      "response_modalities": ["Image"],
      "temperature": 0.6,
      "image_config": {
        "aspect_ratio": "1:1",
        "image_size": "1K"
      }
    },
    "reference_images": [
      {
        "filename": "input/reference_0.jpg",
        "mime": "image/jpeg"
      }
    ]
  }
}
```

说明：

- 这里保存的是可复现请求快照
- 不包含 API key 等敏感信息

---

## 5.6 查询 Job 响应摘要

### GET `/v1/jobs/{job_id}/response`

Header：`X-Job-Token`（TOKEN 模式）

成功响应 `200`：

```json
{
  "job_id": "...",
  "response": {
    "latency_ms": 27484,
    "finish_reason": "STOP",
    "safety_ratings": [],
    "raw_summary": {
      "parts_count": 1,
      "has_inline_image": true
    }
  }
}
```

失败任务中可能含：

- `response.upstream_error`（上游错误摘要）

---

## 5.7 下载生成图片

### GET `/v1/jobs/{job_id}/images/{image_id}`

Header：`X-Job-Token`（TOKEN 模式）

成功响应 `200`：

- `Content-Type: image/png`
- body 为二进制 PNG

说明：

- 当前实现会将上游返回图片统一转换为 PNG 后落盘
- 因此 `result.images[*].mime` 与下载头部都是 `image/png`

错误：

- `403 JOB_TOKEN_INVALID`
- `404 JOB_NOT_FOUND`
- `404 IMAGE_NOT_FOUND`
- `429 RATE_LIMITED`

---

## 5.8 订阅 Job 事件（SSE）

### GET `/v1/jobs/{job_id}/events`

Header：`X-Job-Token`（TOKEN 模式）

返回：`text/event-stream`

事件类型：

- `event: status`
  - 在状态变化时推送
  - 数据包含：`job_id`、`status`、`usage`、`billing`、`result`
- `event: error`
  - 流不可用时推送

示例：

```text
event: status
data: {"job_id":"...","status":"SUCCEEDED","usage":{...},"billing":{...},"result":{...}}
```

终止条件：

- 状态到达 `SUCCEEDED | FAILED | DELETED` 时流结束

---

## 5.9 删除 Job

### DELETE `/v1/jobs/{job_id}`

Header：`X-Job-Token`（TOKEN 模式）

成功响应 `200`：

```json
{
  "job_id": "...",
  "deleted": true
}
```

实现行为：

- 当前为**硬删除**（直接删除 Job 目录）
- 删除后读取接口应返回 404

---

## 5.10 Retry（基于旧 Job 创建新 Job）

### POST `/v1/jobs/{job_id}/retry`

Header：`X-Job-Token`（TOKEN 模式）

请求体：

```json
{
  "override_params": {
    "aspect_ratio": "1:1",
    "image_size": "1K",
    "temperature": 0.5,
    "timeout_sec": 60,
    "max_retries": 0
  }
}
```

说明：

- 会复制原 Job 的 `prompt`、`mode`、参考图
- 生成全新的 `new_job_id` 与 `new_job_access_token`

成功响应 `201`：

```json
{
  "new_job_id": "...",
  "new_job_access_token": "..."
}
```

---

## 5.11 费用汇总（本服务口径）

### GET `/v1/billing/summary`

Header：

- 可选/按配置必需：`X-Admin-Key`

成功响应 `200`：

```json
{
  "currency": "USD",
  "mode": "INTERNAL_ESTIMATE",
  "budget_usd": 10.0,
  "spent_usd": 0.436786,
  "remaining_usd": 9.563214,
  "period": {
    "type": "MONTHLY",
    "start": "2026-02-01",
    "end": "2026-03-01"
  },
  "by_model": [
    {
      "model": "gemini-3-pro-image-preview",
      "spent_usd": 0.436786,
      "jobs": 4
    }
  ],
  "last_updated_at": "2026-02-26T17:20:41.585975+00:00",
  "notes": "Estimated from job-level usage + official pricing."
}
```

统计范围（当前实现）：

- 纳入 `SUCCEEDED` 与 `FAILED` 任务
- 使用各任务 `billing.estimated_cost_usd` 求和

---

## 5.12 Google 剩余额度统一入口

### GET `/v1/billing/google/remaining`

Header：

- 可选/按配置必需：`X-Admin-Key`

### INTERNAL 模式（`BILLING_MODE=INTERNAL`）返回 `200`

```json
{
  "supported": true,
  "mode": "INTERNAL_ESTIMATE",
  "currency": "USD",
  "google_remaining_usd": 9.714562,
  "google_spent_usd": 0.285438,
  "source": "This service internal ledger (estimated)",
  "notes": "Not an official Google balance. Configure BigQuery billing export for closer-to-official numbers.",
  "as_of": null
}
```

### BIGQUERY 模式（`BILLING_MODE=BIGQUERY`）

- 若已配置：`GOOGLE_REPORTED_SPEND_USD` + `GOOGLE_REPORTED_REMAINING_USD`，返回 `200`
- 若未配置，返回 `501`

`501` 示例：

```json
{
  "supported": false,
  "mode": "UNCONFIGURED",
  "message": "Google balance cannot be fetched directly via Gemini API. Configure INTERNAL budget or BIGQUERY export."
}
```

---

## 6. 错误码清单（实现中可见）

- `INVALID_INPUT`
- `JOB_NOT_FOUND`
- `JOB_TOKEN_INVALID`
- `RATE_LIMITED`
- `UPSTREAM_TIMEOUT`
- `UPSTREAM_RATE_LIMIT`
- `SAFETY_BLOCKED`
- `NO_IMAGE_PART`
- `IMAGE_NOT_FOUND`
- `BILLING_NOT_CONFIGURED`

说明：

- 任务失败时 `meta.error.type` 还可能出现 `UPSTREAM_ERROR`（内部失败归类）
- 这与统一响应 `error.code` 是两套字段，前者用于 Job 结果审计

---

## 7. 计费规则（当前实现）

默认 pricing（可由 `PRICING_TABLE_PATH` 覆盖）：

- 输入：`$2.00 / 1M tokens`
- 输出文本+思考：`$12.00 / 1M tokens`
- 输出图片：`$120.00 / 1M tokens`
- fallback 单图成本：`1K/2K -> 0.134 USD`, `4K -> 0.24 USD`

使用字段（来自 usage metadata 归一化）：

- `prompt_token_count`
- `cached_content_token_count`
- `candidates_token_count`
- `thoughts_token_count`
- `total_token_count`

公式：

- `text_input_cost = prompt_token_count / 1e6 * input_per_1m`
- `text_output_cost = (candidates_token_count + thoughts_token_count) / 1e6 * output_text_per_1m`
- `image_output_cost`
  - 当前实现采用 fallback（按 `image_size` * 图片数量）
- `estimated_cost_usd = text_input_cost + text_output_cost + image_output_cost`

计费明细落盘：

- `billing.estimated_cost_usd`
- `billing.breakdown.text_input_cost_usd`
- `billing.breakdown.text_output_cost_usd`
- `billing.breakdown.image_output_cost_usd`
- `billing.pricing_version`
- `billing.pricing_notes`

---

## 8. 本地落盘结构

根目录：`DATA_DIR/jobs/<job_id>/`

```text
DATA_DIR/
  jobs/
    <job_id>/
      meta.json
      request.json
      response.json
      input/
        reference_0.jpg
        reference_1.png
      result/
        image_0.png
      logs/
        job.log
```

说明：

- 成功任务会包含 `result/image_0.png`
- 有参考图时会保存到 `input/`

---

## 9. 环境变量（当前实现）

必填：

- `GEMINI_API_KEY`

常用：

- `DATA_DIR`（默认 `./data`）
- `MAX_IMAGES_PER_JOB`（默认 1）
- `MAX_REFERENCE_IMAGES`（默认 14）
- `JOB_WORKERS`（默认 2）
- `JOB_QUEUE_MAX`（默认 100）
- `JOB_TIMEOUT_SEC_DEFAULT`（默认 60）
- `JOB_TIMEOUT_SEC_MIN`（默认 10）
- `JOB_TIMEOUT_SEC_MAX`（默认 180）
- `JOB_AUTH_MODE=TOKEN|ID_ONLY`（默认 TOKEN）
- `RATE_LIMIT_PER_MINUTE`（默认 60）
- `ADMIN_API_KEY`（可空）
- `BILLING_MODE=INTERNAL|BIGQUERY`（默认 INTERNAL）
- `BUDGET_USD`（默认 100）
- `PRICING_TABLE_PATH`（可选）
- `IDEMPOTENCY_TTL_SEC`（默认 86400）
- `GOOGLE_REPORTED_SPEND_USD` / `GOOGLE_REPORTED_REMAINING_USD`（BIGQUERY 模式可用）

---

## 10. 推荐调用流程

1. `POST /v1/jobs` 创建任务，保存 `job_id` 和 `job_access_token`
2. 轮询 `GET /v1/jobs/{job_id}` 或订阅 `GET /v1/jobs/{job_id}/events`
3. 成功后读取：
   - `GET /v1/jobs/{job_id}`（状态、usage、billing、图片元数据）
   - `GET /v1/jobs/{job_id}/images/image_0`（下载图片）
4. 需要调试时：
   - `GET /v1/jobs/{job_id}/request`
   - `GET /v1/jobs/{job_id}/response`
5. 需要重跑时：
   - `POST /v1/jobs/{job_id}/retry`

---

## 11. 示例：前端最小轮询逻辑

```ts
async function waitJob(baseUrl: string, jobId: string, token: string) {
  while (true) {
    const r = await fetch(`${baseUrl}/v1/jobs/${jobId}`, {
      headers: { "X-Job-Token": token }
    });
    if (!r.ok) throw new Error(`job query failed: ${r.status}`);
    const meta = await r.json();

    if (meta.status === "SUCCEEDED") return meta;
    if (meta.status === "FAILED") throw new Error(meta?.error?.message || "job failed");

    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
}
```

---

## 12. 与需求文档的对齐状态（摘要）

- Job 化：已实现
- 本地目录持久化：已实现
- 按 job_id 查询：已实现
- 不提供 job 列表：已满足（无列表能力）
- OpenAPI：已提供
- usage + billing：已实现
- Google remaining 接口：已实现（INTERNAL/BIGQUERY 模式）
- 多参考图：已实现（默认最多 14 张）
