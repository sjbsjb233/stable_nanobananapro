# Nano Banana Pro (Backend + Frontend)

项目包含：

- 后端（FastAPI）：异步 Job 化出图服务，支持多模型（`gemini-3.1-flash-image-preview` / `gemini-2.5-flash-image` / `gemini-3-pro-image-preview`），接口前缀 `/v1`
- 前端（React + Vite + Tailwind）：目录 `frontend/`，已对接后端接口

## 功能概览

- Job 生命周期：`QUEUED -> RUNNING -> SUCCEEDED/FAILED`
- 支持模型切换（Nano Banana 2 / Nano Banana / Nano Banana Pro），并按模型约束参数
- 提供模型能力接口：`GET /v1/models`
- 每个 Job 本地落盘：`meta.json / request.json / response.json / result/image_0.png / logs/job.log`
- 默认鉴权：`job_id + X-Job-Token`（仅落盘 token hash）
- 无 job 列表接口（防枚举）
- 计费：usage token 记录 + 按 pricing 表估算
- billing 接口：
  - `/v1/billing/summary`
  - `/v1/billing/google/remaining`
- 支持多参考图上传（`multipart/form-data` 的 `reference_images`，默认最多 14 张）

## 快速开始

1. 安装依赖

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. 配置环境变量

```bash
cp .env.example .env
# 填入 GEMINI_API_KEY
# 如需代理访问 Google，可设置 GEMINI_HTTP_PROXY，例如：
# GEMINI_HTTP_PROXY=http://server.sjbsjb.xyz:6890
```

3. 启动

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

4. 文档

- Swagger: `http://localhost:8000/docs`
- OpenAPI: `http://localhost:8000/openapi.json`

## 前端启动（本地）

```bash
cd frontend
npm install
npm run dev
```

默认打开 `http://localhost:5173`。

- 默认后端地址会自动使用 `http://<当前主机>:8000`
- 也可通过环境变量覆盖：`VITE_API_BASE_URL=http://127.0.0.1:8000`

## Docker Compose（前后端一起）

```bash
docker compose up --build
```

- 前端：`http://localhost:5173`
- 后端：`http://localhost:8000`

## 创建 Job 示例

### JSON（无参考图）

```bash
curl -s -X POST http://localhost:8000/v1/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "a cinematic banana robot in studio lighting",
    "model": "gemini-3.1-flash-image-preview",
    "params": {
      "aspect_ratio": "1:1",
      "image_size": "1K",
      "temperature": 0.7,
      "timeout_sec": 60,
      "max_retries": 1
    },
    "mode": "IMAGE_ONLY"
  }'
```

### multipart（多参考图）

```bash
curl -s -X POST http://localhost:8000/v1/jobs \
  -F 'prompt=generate an ad poster keeping style of refs' \
  -F 'model=gemini-2.5-flash-image' \
  -F 'mode=IMAGE_ONLY' \
  -F 'params={"aspect_ratio":"1:1","image_size":"1K","temperature":0.7,"timeout_sec":60,"max_retries":1}' \
  -F 'reference_images=@/path/to/ref1.png' \
  -F 'reference_images=@/path/to/ref2.jpg'
```

## 模型能力查询

```bash
curl -s http://localhost:8000/v1/models
```

后端会返回每个模型支持的 `mode`、`aspect_ratio`、`image_size` 选项，前端会基于该接口动态适配表单。

备注：
- 当前模型 `aspect_ratio` 不支持 `auto`（官方接口会直接返回 400）
- `thinking_level` 目前仅 `gemini-3.1-flash-image-preview` 支持（`Minimal` / `High`）

## 数据目录

默认 `DATA_DIR=./data`：

```text
data/
  jobs/
    <job_id>/
      meta.json
      request.json
      response.json
      result/
        image_0.png
      logs/
        job.log
```

## 测试

```bash
cd backend
pytest -q
```
