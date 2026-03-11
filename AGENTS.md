# AGENTS.md

本文件用于让后续 Agent/维护者快速接管本项目，按统一流程完成开发、仿真、发布与生产更新。

## 1. 项目定位

- 项目名：`stable_nanobananapro`
- 架构：
  - `backend/`：FastAPI 后端
  - `frontend/`：React + Vite 前端
- 发布方式：Docker 镜像发布到 Docker Hub，生产机通过 Compose + Watchtower 更新
- 核心原则：
  - 开发机负责：改代码、构建镜像、推送镜像
  - 生产机负责：拉镜像并运行容器
  - 数据目录持久化，不跟容器生命周期绑定
  - 密钥配置通过 `env_file` 注入，不写进镜像
  - 当前系统已包含用户登录/会话/Turnstile；除健康检查与登录接口外，其余 API 默认都要求已登录

## 2. 开发阶段：主要工作目录

开发时通常只改以下目录：

- `backend/app/`：后端业务代码
- `backend/tests/`：后端测试
- `frontend/src/`：前端源码
- `backend/requirements*.txt`：后端依赖（运行时/测试）
- `backend/Dockerfile`、`frontend/Dockerfile`：镜像构建
- `scripts/`：自动化脚本
- `README.md`、本文件：流程文档

一般不改：

- `srv/`：本地仿真运行目录（本地环境产物，已忽略）
- `srv_server/`：服务器部署模板（改部署策略时才改）

认证相关额外关注：

- `backend/.env` 需要配置 `SESSION_SECRET_KEY`、`TURNSTILE_SECRET_KEY`
- 首次启动会按 `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` 自动创建管理员
- 前端 Turnstile 站点密钥走 `frontend/.env` 的 `VITE_TURNSTILE_SITE_KEY`
- 多中转站走 `UPSTREAM_PROVIDERS_JSON` 注入；provider 的启用状态、备注、余额与运行时状态由后端写入 `data/providers.json`
- 如果未配置 `UPSTREAM_PROVIDERS_JSON`，后端会退回旧的单一 `GEMINI_API_KEY` / `GEMINI_API_BASE_URL` 模式

## 3. 开发环境运行（非 Docker）

### 3.1 后端

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 3.2 前端

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

### 3.3 测试

```bash
cd backend
pytest -q
```

## 4. 本地仿真环境（Docker）

开发完成后，先在本机按“生产姿势”仿真验证，再发布。

本地仿真目录：

```text
srv/stable/
  compose/
  config/
  data/
```

### 4.1 一键仿真部署（推荐）

脚本：`scripts/deploy-local-sim.sh`

```bash
./scripts/deploy-local-sim.sh
```

功能：

1. 调用 `scripts/build-local-sim-images.sh` 构建本地仿真镜像（默认 tag=当前 git hash）
2. 更新 `srv/stable/compose/.env` 的 `TAG`
3. `docker compose down`
4. `docker compose up -d --force-recreate`
5. 输出容器状态

可指定 tag(一般情况下，如果没有用户的要求，统一不用指定tag，默认就用当前的git hash)：

```bash
./scripts/deploy-local-sim.sh 2026-02-28_local
```

### 4.2 仅构建仿真镜像

脚本：`scripts/build-local-sim-images.sh`

```bash
./scripts/build-local-sim-images.sh
```

说明：该脚本只构建+加载镜像并更新 `.env`，不自动重启容器。

## 5. 发布到 Docker Hub（开发机,这一步只有在用户要求的时候才允许做，平时开发不需要频繁发布）

### 5.1 初始化 buildx（首次）

```bash
./scripts/init-buildx.sh
```

### 5.2 一键构建并推送（生产镜像）

脚本：`release.sh`

```bash
./release.sh
```

默认行为：

- `TAG=$(git rev-parse --short HEAD)`
- 构建 `linux/amd64`
- 推送 backend/frontend 两个镜像
- 同时推送 `latest`

可手工指定 tag(一般情况下，如果没有用户的要求，统一不用指定tag，默认就用当前的git hash)：

```bash
./release.sh 2026-02-28_01
```

## 6. 服务器更新流程（自动,你不用管）

生产机部署使用 `srv_server/` 模板。

当前策略：

- 生产 Compose 包含 `watchtower`
- `BACKEND_TAG=latest`、`FRONTEND_TAG=latest` 时：
  - 开发机执行 `./release.sh` 推送新 `latest`
  - 服务器自动检测并拉取最新镜像，重建服务

如果生产机使用固定 hash tag，则需要手工修改 `.env` 并执行 `docker compose up -d`。

## 7. 常见问题与处理

1. 改了 env 不生效：
- 原因：容器 `restart` 不会重读 `env_file`
- 处理：`docker compose up -d --force-recreate <service>`

2. 仿真目录没有 job：
- 通常是请求打到了另一个本机服务（端口冲突）
- 用 `lsof -nP -iTCP:8000 -sTCP:LISTEN` 排查

3. `UPSTREAM_ERROR: Server disconnected...`：
- 常见原因是 `GEMINI_HTTP_PROXY` 不可用
- 先在容器内验证代理链路，再决定是否关闭代理

## 8. Agent 执行约定

后续 Agent 在本项目应优先遵循：

1. 先在开发目录修改代码并通过基本测试
2. 使用仿真脚本验证 Docker 运行链路
3. 使用 `release.sh` 推送 Docker Hub(这一步只有在用户要求的时候才允许做，平时开发不需要频繁发布)
4. 依赖服务器 Watchtower 自动更新
5. 涉及流程变更时同步更新 `README.md` 与本文件
