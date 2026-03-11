# Nano Banana Pro (Backend + Frontend)

本项目维护目标：

- 开发机（Mac）负责本地开发、构建镜像、推送 Docker Hub
- 服务器（Linux）负责拉取镜像、启动/更新容器
- 业务数据（jobs、日志、结果图）持久化在服务器目录，不跟容器生命周期绑定
- 敏感配置（API Key、密钥）通过 `env_file` 注入，不打进镜像

## 项目结构

```text
stable_nanobananapro/
  backend/                          # FastAPI 后端
  frontend/                         # React 前端
  scripts/
    init-buildx.sh                  # 初始化 buildx（跨架构构建）
    build-local-sim-images.sh       # 构建本地仿真镜像（tag=git hash）
  release.sh                        # 一键构建并 push 到 Docker Hub
  srv/                              # 本地仿真目录（已 git ignore）
  srv_server/                       # 服务器部署模板目录（可直接上传）
```

## 后端能力概览

- Job 生命周期：`QUEUED -> RUNNING -> SUCCEEDED/FAILED`
- 支持模型：
  - `gemini-3.1-flash-image-preview`
  - `gemini-2.5-flash-image`
  - `gemini-3-pro-image-preview`
- API 前缀：`/v1`
- 默认鉴权：`cookie session + 用户系统`
- 除 `GET /v1/health` 与登录接口外，其他接口都要求已登录
- 首次启动会自动创建 bootstrap 管理员（默认 `admin / admin123456`，请立即改密或通过 env 覆盖）
- 登录必须通过 Cloudflare Turnstile；普通用户在高风险生成条件下还会触发二次 Turnstile 校验
- 每个 Job 落盘文件：
  - `meta.json`
  - `request.json`
  - `response.json`
  - `result/image_0.png`
  - `logs/job.log`

## 一、日常本地开发流程

### 1. 后端开发启动

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 如果你有自己的 .env，可以跳过
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

文档地址：

- Swagger: `http://localhost:8000/docs`
- OpenAPI: `http://localhost:8000/openapi.json`

### 2. 前端开发启动

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

默认前端：`http://localhost:5173`

可配项：

- `VITE_API_BASE_URL=http://127.0.0.1:8000`
- `VITE_TURNSTILE_SITE_KEY=0x4AAAAAACoBxRJwxj2oUZDc`
- `VITE_LOG_LEVEL=INFO`
- `VITE_LOG_RETENTION_DAYS=3`
- `VITE_LOG_MAX_ENTRIES=1200`

新增后端认证/配额相关 env：

- `SESSION_SECRET_KEY`
- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- `DEFAULT_USER_DAILY_IMAGE_LIMIT`
- `DEFAULT_USER_CONCURRENT_JOBS_LIMIT`
- `DEFAULT_ADMIN_CONCURRENT_JOBS_LIMIT`
- `DEFAULT_USER_TURNSTILE_JOB_COUNT_THRESHOLD`
- `DEFAULT_USER_TURNSTILE_DAILY_USAGE_THRESHOLD`

新增多中转站调度配置：

- `UPSTREAM_PROVIDERS_JSON`

示例：

```json
[
  {
    "provider_id": "mmw",
    "label": "MMW",
    "adapter_type": "openai_chat_image",
    "base_url": "https://api.mmw.ink",
    "api_key": "sk-xxx",
    "cost_per_image_cny": 0.09,
    "initial_balance_cny": 21.5,
    "supported_models": ["gemini-2.5-flash-image", "gemini-3-pro-image-preview", "gemini-3.1-flash-image-preview"]
  },
  {
    "provider_id": "zx2",
    "label": "ZX2",
    "adapter_type": "gemini_v1beta",
    "base_url": "http://zx2.example/v1beta",
    "api_key": "sk-xxx",
    "cost_per_image_cny": 0.05,
    "initial_balance_cny": 10,
    "supported_models": ["gemini-3.1-flash-image-preview"]
  }
]
```

说明：

- `adapter_type=openai_chat_image` 适配通过 `/v1/chat/completions` 返回图片链接或 data URI 的中转站
- `adapter_type=gemini_v1beta` 适配 Gemini 原生 `v1beta/models/*:generateContent`
- provider 的启用状态、备注、剩余余额、运行时成功率/熔断状态由后端持久化到 `data/providers.json`
- 如果未配置 `UPSTREAM_PROVIDERS_JSON`，后端会退回旧的单一 `GEMINI_API_KEY + GEMINI_API_BASE_URL` 模式

### 3. 本地开发测试

```bash
cd backend
pytest -q
```

## 二、本地“生产仿真”流程（Docker）

目的：在 Mac 上以生产姿势运行（不挂源码、不用 reload、用镜像启动）。

### 1. 准备本地仿真目录

本项目约定本地仿真目录为：

```text
srv/stable/
  compose/
    docker-compose.prod.yml
    .env
  config/
    backend.prod.env
  data/
```

说明：`srv/` 已在 `.gitignore` 中忽略，仅作本地环境使用。

前端 Docker 运行时配置：

- `FRONTEND_DEFAULT_API_BASE_URL`
- `FRONTEND_TURNSTILE_SITE_KEY`

说明：

- `FRONTEND_TURNSTILE_SITE_KEY` 由前端容器启动时写入 `runtime-config.js`
- 这和后端的 `TURNSTILE_SITE_KEY` 不是同一条配置链路；改后端 env 不会自动改前端登录页使用的 site key

### 2. 构建本地仿真镜像（推荐用脚本）

使用脚本：[`scripts/build-local-sim-images.sh`](./scripts/build-local-sim-images.sh)

```bash
./scripts/build-local-sim-images.sh
```

行为说明：

- 默认 `TAG=$(git rev-parse --short HEAD)`
- 默认构建平台：`linux/arm64`（适配 Apple Silicon）
- 生成镜像：
  - `local/stable-backend:<TAG>`
  - `local/stable-frontend:<TAG>`
- 自动更新 `srv/stable/compose/.env` 的 `REGISTRY` 与 `TAG`

可手工指定 tag：

```bash
./scripts/build-local-sim-images.sh 2026-02-28_localtest
```

### 3. 启动本地仿真容器

```bash
cd srv/stable/compose
docker compose -f docker-compose.prod.yml up -d --remove-orphans
docker compose -f docker-compose.prod.yml ps
```

### 4. 更新本地仿真到最新版本

```bash
# 在项目根目录
./scripts/build-local-sim-images.sh

# 强制重建容器，确保新 env 与新镜像都生效
cd srv/stable/compose
docker compose -f docker-compose.prod.yml down --remove-orphans
docker compose -f docker-compose.prod.yml up -d --force-recreate --remove-orphans
```

### 5. 常见坑（本地仿真）

1. 改了 `backend.prod.env` 但不生效：

- 仅 `restart` 不一定会重读 `env_file`
- 需要 `up -d --force-recreate`

2. `srv/stable/data/jobs` 没有任务：

- 通常是请求打到了另一个本地后端（例如你本机自己跑的 `uvicorn :8000`）
- 用 `lsof -nP -iTCP:8000 -sTCP:LISTEN` 排查端口冲突

3. 报 `Server disconnected without sending a response`：

- 常见是 `GEMINI_HTTP_PROXY` 代理不可用
- 先在容器内验证网络，再决定是否禁用代理

## 三、发布到 Docker Hub（开发机）

### 1. 初始化 buildx（首次）

使用脚本：[`scripts/init-buildx.sh`](./scripts/init-buildx.sh)

```bash
chmod +x scripts/init-buildx.sh release.sh
./scripts/init-buildx.sh
```

### 2. 一键构建并推送镜像

使用脚本：[`release.sh`](./release.sh)

```bash
./release.sh
```

行为说明：

- 默认 `TAG=$(git rev-parse --short HEAD)`
- 目标平台：`linux/amd64`（服务器常见架构）
- 默认镜像：
  - `docker.io/sjbsjb233/stable-nanobananapro-backend:<TAG>`
  - `docker.io/sjbsjb233/stable-nanobananapro-frontend:<TAG>`
- 默认同时推送 `latest`

可选参数：

```bash
./release.sh 2026-02-28_01                # 手工指定 TAG
PUSH_LATEST=0 ./release.sh                # 不推 latest
NAMESPACE=sjbsjb233 APP_NAME=stable ./release.sh
```

## 四、生产服务器部署流程（Linux）

推荐直接使用本仓库模板目录：[`srv_server/`](./srv_server)

### 1. 上传部署模板

把 `srv_server/` 上传到服务器目标目录（例如 `/srv/stable`）。

上传后服务器目录应类似：

```text
/srv/stable/
  compose/
    docker-compose.prod.yml
    .env
  config/
    backend.env
  data/
```

### 2. 初始化配置

```bash
cd /srv/stable
cp compose/.env.example compose/.env
cp config/backend.env.example config/backend.env
```

然后按实际环境编辑：

- `compose/.env`
- `config/backend.env`

### 3. 启动生产容器

```bash
cd /srv/stable/compose
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

## 五、生产更新策略（两种）

### 策略 A：自动更新（watchtower + latest）

条件：

- `compose/.env` 中 `BACKEND_TAG=latest`、`FRONTEND_TAG=latest`
- `watchtower` 服务启用

流程：

1. 开发机执行 `./release.sh` 推送新 `latest`
2. 服务器 watchtower 自动拉新镜像并重启对应容器

适合：个人项目、快速迭代。

### 策略 B：手工可控更新（固定 hash tag）

流程：

1. 开发机执行 `./release.sh`，记住输出 tag（如 `416796a`）
2. 服务器编辑 `compose/.env`：

```bash
BACKEND_TAG=416796a
FRONTEND_TAG=416796a
```

3. 执行：

```bash
cd /srv/stable/compose
docker compose -f docker-compose.prod.yml up -d
```

适合：追求可回滚、可审计版本。

## 六、回滚流程（生产）

如果新版本异常：

1. 修改 `compose/.env` 中 `BACKEND_TAG`、`FRONTEND_TAG` 为上一版本
2. 执行：

```bash
cd /srv/stable/compose
docker compose -f docker-compose.prod.yml up -d
```

即可回滚。

## 七、镜像最小化说明

### backend 镜像

- 运行时依赖文件：`backend/requirements.runtime.txt`
- `backend/Dockerfile` 只安装运行时依赖
- `pytest` 等测试依赖仅保留在 `backend/requirements.txt`（开发/测试用）

### frontend 镜像

- 多阶段构建：`node:20-alpine` build + `nginx:1.27-alpine` runtime
- 最终镜像仅包含 `dist` 静态文件与 nginx 配置

## 八、常用运维命令

### 查看容器状态

```bash
docker compose -f docker-compose.prod.yml ps
```

### 查看后端日志

```bash
docker compose -f docker-compose.prod.yml logs -f backend
```

### 检查容器内环境变量

```bash
docker compose -f docker-compose.prod.yml exec backend env | grep -E 'GEMINI|JOB_AUTH_MODE|JOB_WATCHDOG_TIMEOUT_SEC|DATA_DIR'
```

`JOB_WATCHDOG_TIMEOUT_SEC` 控制单个 job 的最大运行时长，超时后 job 会直接标记为 `FAILED`，不会继续等待后续 provider fallback 完成。

### 仅重建后端（env 改动后常用）

```bash
docker compose -f docker-compose.prod.yml up -d --force-recreate backend
```

## 九、API 示例

### 创建 Job（JSON）

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

### 查询模型能力

```bash
curl -s http://localhost:8000/v1/models
```
