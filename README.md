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
    worktree-dev.sh                 # Codex/worktree 开发入口
    init-buildx.sh                  # 初始化 buildx（跨架构构建）
    build-local-sim-images.sh       # 构建本地仿真镜像（tag=git hash）
  release.sh                        # 一键构建并 push 到 Docker Hub
  .codex-dev-env/                   # 共享缓存 + worktree 私有运行态（git ignore）
  srv/                              # 本地仿真目录（已 git ignore）
  srv_server/                       # 服务器部署模板目录（可直接上传）
```

## 开发流程边界

- Agent / Codex worktree 流程：只使用 `./scripts/worktree-dev.sh`，不创建/删除 `git worktree`，也不调用 Docker。
- 手工本地仿真 Docker 流程：保留本文后半部分，供你人工验证镜像与部署链路；Agent 默认不调用。

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

## 一、Codex Worktree 开发流程（Agent 唯一入口）

### 1. 初始化当前 worktree

```bash
./scripts/worktree-dev.sh bootstrap
```

作用：

- 识别当前 `cwd` 对应的 worktree
- 在主仓库 `.codex-dev-env/shared/` 复用或创建 Python / npm / Playwright 依赖缓存
- 在 `.codex-dev-env/instances/<instance-id>/` 创建当前 worktree 私有 env、日志、PID、`backend-data`、Playwright 运行态
- 建立这些稳定入口：
  - `backend/.venv`
  - `backend/.env`
  - `backend/data`
  - `frontend/.env`
  - `frontend/node_modules`
  - `tools/playwright/node_modules`
  - `tools/playwright/.playwright-browsers`
  - `tools/playwright/.playwright-home`
  - `tools/playwright/.playwright-cli`
  - `tools/playwright/.cache`
  - `tools/playwright/output`
  - `tools/playwright/test-results`

实例元数据：

- `.codex-dev-env/instances/<instance-id>/instance.json`
- `.codex-dev-env/instances/<instance-id>/instance.env`

固定环境变量：

- `NBP_INSTANCE_ID`
- `NBP_BACKEND_PORT`
- `NBP_FRONTEND_PORT`
- `NBP_BACKEND_URL`
- `NBP_FRONTEND_URL`
- `NBP_BACKEND_DATA_DIR`

### 2. 启动、停止、查看状态

```bash
./scripts/worktree-dev.sh up backend
./scripts/worktree-dev.sh up frontend
./scripts/worktree-dev.sh up all
./scripts/worktree-dev.sh down
./scripts/worktree-dev.sh status
./scripts/worktree-dev.sh shellenv
```

说明：

- 后端固定使用无 `reload` 的 `uvicorn`
- 前端固定使用当前实例端口启动 `vite`
- 端口分配规则：
  - `backend = 18000 + slot * 10`
  - `frontend = 18001 + slot * 10`
- `status` 会输出当前 worktree、实例 id、端口、URL、PID、日志位置、依赖 key
- `shellenv` 可配合 `eval "$(./scripts/worktree-dev.sh shellenv)"` 临时注入实例环境

### 3. 测试

```bash
./scripts/worktree-dev.sh test backend
./scripts/worktree-dev.sh test e2e
```

说明：

- `test backend` 直接在当前实例环境下执行 `pytest -q`
- `test e2e` 默认读取当前实例的 `NBP_FRONTEND_URL`
- 如果 `tools/playwright/tests/e2e/` 里没有 spec，会直接返回，不会去跑 Docker

### 4. Playwright CLI

当需要真实浏览器自动化时，仍统一走 `tools/playwright/` 下的本地 CLI，但入口地址应来自当前实例：

```bash
./scripts/worktree-dev.sh up all
eval "$(./scripts/worktree-dev.sh shellenv)"
./tools/playwright/scripts/playwright-cli.sh open "$NBP_FRONTEND_URL" --headed
./tools/playwright/scripts/playwright-cli.sh snapshot
```

说明：

- `tools/playwright/.playwright-browsers` 现在是共享浏览器缓存
- `tools/playwright/.playwright-home`、`.playwright-cli`、`.cache`、`output`、`test-results` 都是实例私有
- `frontend/scripts/*.mjs` 会优先读取 `NBP_FRONTEND_URL`、`NBP_BACKEND_URL`、`NBP_BACKEND_DATA_DIR`
- 默认仍不要给 `playwright-cli.sh open ...` 传 `--browser chrome`

### 5. 实例 env 说明

首次 `bootstrap` 会从 `backend/.env.example`、`frontend/.env.example` 生成实例专属 env，并写到：

- `.codex-dev-env/instances/<instance-id>/env/backend.env`
- `.codex-dev-env/instances/<instance-id>/env/frontend.env`

常见需要自行补充的配置：

- `SESSION_SECRET_KEY`
- `TURNSTILE_SECRET_KEY`
- `TEST_ENV_ADMIN_BYPASS`
- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `UPSTREAM_PROVIDERS_JSON`
- `VITE_TURNSTILE_SITE_KEY`

多中转站配置示例：

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
  }
]
```

补充说明：

- `adapter_type=openai_chat_image` 适配 `/v1/chat/completions`
- `adapter_type=gemini_v1beta` 适配 Gemini 原生 `v1beta/models/*:generateContent`
- provider 运行时状态仍由后端写入实例自己的 `backend-data/providers.json`
- 如果未配置 `UPSTREAM_PROVIDERS_JSON`，后端会退回单一 `GEMINI_API_KEY + GEMINI_API_BASE_URL`
- 当 `TEST_ENV_ADMIN_BYPASS=true` 时，Playwright 可直接访问目标页面，无需伪造 cookie / session

## 二、本地“生产仿真”流程（Docker，人工专用）

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

### 6. 使用本地 Playwright CLI 测试仿真环境

如果目标是“在真实浏览器里操作当前仿真环境”，本项目统一使用 `tools/playwright/` 下的本地 Playwright CLI；需要长期回归时，优先补充同目录下的 e2e 测试。

适用场景：

- 验证当前仿真页面是否可打开
- 验证登录、跳转、弹窗、表单、路由、控制台报错
- 复现前端交互 bug

推荐流程：

1. 先确认 `./tools/playwright/scripts/playwright-cli.sh --help` 可用
2. 再确认仿真环境容器在线
3. 先读取：
   - `srv/stable/compose/docker-compose.prod.yml`
   - `srv/stable/config/backend.prod.env`
4. 确认：
   - 前端入口通常是 `http://127.0.0.1:5178`
   - 后端入口通常是 `http://127.0.0.1:8000`
   - `TEST_ENV_ADMIN_BYPASS` 当前是 `true` 还是 `false`
5. 使用本地 Playwright CLI 的典型顺序：
   - `./tools/playwright/scripts/playwright-cli.sh open <url> --headed`
   - `./tools/playwright/scripts/playwright-cli.sh snapshot`
   - `./tools/playwright/scripts/playwright-cli.sh click e12` / `fill e8 "text"` / `type "text"`
   - 页面变化后再次 `./tools/playwright/scripts/playwright-cli.sh snapshot`
   - 需要排查报错时再看 `./tools/playwright/scripts/playwright-cli.sh console`
6. 对一次性排查，可继续使用 CLI 直接操作；对会重复执行的流程，优先补到 `tools/playwright/tests/e2e/`

关键约束：

- `snapshot` 后拿到的元素 ref 只对当前页面状态可靠；页面变了就要重新 snapshot
- 不要把“仓库里可能残留的旧浏览器测试代码”当成当前标准流程；当前标准是 `tools/playwright/` 下的本地 CLI 和 e2e 测试
- 不要默认伪造 cookie / session，先看 `TEST_ENV_ADMIN_BYPASS`
- 浏览器目录固定在 `tools/playwright/.playwright-browsers/`

按鉴权模式区分：

- `TEST_ENV_ADMIN_BYPASS=true`
  - 可直接访问受保护页面
  - 通常无需登录、无需注入 cookie

- `TEST_ENV_ADMIN_BYPASS=false`
  - 应按真实登录流程测试
  - 如果页面启用了 Turnstile，就按页面当前行为处理，不要先假设可以跳过

建议在每次测试结论里固定说明：

- 是否使用了本地 Playwright CLI，或者是否执行了根目录 e2e 测试
- 实际访问的 URL
- 当前 bypass 状态
- 做了哪些页面操作
- 控制台是否存在错误或 warning
- 是否执行了会写入数据的操作


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
