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
- `TEST_ENV_ADMIN_BYPASS` 是后端测试环境开关，默认 `false`
- 首次启动会按 `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` 自动创建管理员
- 前端 Turnstile 站点密钥在开发环境走 `frontend/.env` 的 `VITE_TURNSTILE_SITE_KEY`，Docker 环境走前端容器的 `FRONTEND_TURNSTILE_SITE_KEY`
- 多中转站走 `UPSTREAM_PROVIDERS_JSON` 注入；provider 的启用状态、备注、余额与运行时状态由后端写入 `data/providers.json`
- 如果未配置 `UPSTREAM_PROVIDERS_JSON`，后端会退回旧的单一 `GEMINI_API_KEY` / `GEMINI_API_BASE_URL` 模式
- 当 `TEST_ENV_ADMIN_BYPASS=true` 时，后端会把所有受保护请求直接视为 admin 访问，不校验 cookie / session，也不会要求登录页 Turnstile
- 在上述测试环境下使用 Playwright 时，无需注入任何 cookie 或 session，直接访问目标页面即可开始测试

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

## 8. Playwright 本地 CLI 使用约定

后续 Agent 如果需要“在真实浏览器里测试当前仿真环境”，统一使用 `tools/playwright/` 下的本地 Playwright CLI，也不要先手工伪造 cookie。

项目内固定入口：

- `./tools/playwright/scripts/setup-playwright.sh`：首次安装 Playwright 依赖与 Chromium
- `./tools/playwright/scripts/playwright-cli.sh`：后续统一 CLI 入口
- `tools/playwright/node_modules/`：Playwright Node 依赖
- `tools/playwright/.playwright-browsers/`：浏览器二进制缓存目录
- `tools/playwright/.playwright-home/`：`playwright-cli` daemon 与运行态缓存目录
- `tools/playwright/.playwright-cli/`：CLI 快照与控制台日志
- `./tools/playwright/scripts/playwright-cli.sh open ...` 不要传 `--browser chrome`
- 默认 headless 模式优先走项目内 `chromium-headless-shell`
- 传 `--headed` 时切到项目内完整 Chromium
- `tools/playwright/playwright.config.ts` 与 `tools/playwright/tests/e2e/`：后续沉淀回归测试的标准位置

### 8.1 什么时候用

- 用户明确要求“用 Playwright / 浏览器自动化测试”
- 需要确认仿真环境当前页面是否真的能打开、跳转、加载数据
- 需要复现前端交互问题、登录流程问题、路由问题、控制台报错

### 8.2 默认做法

1. 先确认 `npx` 可用
2. 确认 `./tools/playwright/scripts/playwright-cli.sh --help` 可用；如果不可用，先执行 `./tools/playwright/scripts/setup-playwright.sh`
3. 再确认仿真容器是否在线，例如前端 `5178`、后端 `8000`
4. 优先直接调用本地 Playwright CLI 进行浏览器操作
5. 默认先 `open`，再 `snapshot`，再根据最新 ref 做 `click/fill/type`
6. 页面发生明显变化后重新 `snapshot`，不要复用旧 ref
7. 如果某个流程需要重复回归，优先补到 `tools/playwright/tests/e2e/` 并通过 `npm --prefix tools/playwright run test:e2e` 执行
8. 如果测试过程中临时启动了前端 dev server、后端 uvicorn、docker 仿真容器外的附加服务，或打开了 Playwright 浏览器 session，测试结束后必须显式清理，不能假设脚本结束后会自动退出
9. 清理时至少确认两类资源：
   - 临时服务端口不再监听，例如 `5173`、`5178`、`8000`、`8011`、其他本次测试新开的端口
   - Playwright 会话已关闭，优先使用 `./tools/playwright/scripts/playwright-cli.sh close`、`close-all`，必要时再用 `kill-all`

### 8.3 推荐工具顺序

- `./tools/playwright/scripts/playwright-cli.sh open <url> --headed`
- `./tools/playwright/scripts/playwright-cli.sh snapshot`
- `./tools/playwright/scripts/playwright-cli.sh click e12` / `fill e8 "text"` / `type "text"`
- `./tools/playwright/scripts/playwright-cli.sh wait-for "text"`
- `./tools/playwright/scripts/playwright-cli.sh console`
- 需要长期保留的验证流程时，补 `tools/playwright/tests/e2e/` 里的 spec 并执行 `npm --prefix tools/playwright run test:e2e`

说明：

- `snapshot` 是核心步骤；没有新快照时，不要假设旧元素 ref 仍然有效
- 优先用本地 CLI 原生命令，不要上来就写大段脚本
- 一次性排查可用 CLI；重复回归场景优先沉淀为 e2e 测试
- 若本次测试临时起了服务或浏览器，会话结束前必须主动回收，避免残留后台进程占用端口影响后续开发

### 8.4 针对本项目的固定入口

- 本地仿真前端通常是 `http://127.0.0.1:5178`
- 本地仿真后端通常是 `http://127.0.0.1:8000`
- 先读 `srv/stable/compose/docker-compose.prod.yml`
- 再读 `srv/stable/config/backend.prod.env`

重点确认：

- 前端端口映射是否还是 `5178:80`
- 后端端口映射是否还是 `8000:8000`
- `TEST_ENV_ADMIN_BYPASS` 当前是 `true` 还是 `false`

### 8.5 本项目测试时的规则

- 当 `TEST_ENV_ADMIN_BYPASS=true` 时：
  - 直接访问目标页面即可
  - 不需要注入 cookie / session
  - 不需要先走登录页

- 当 `TEST_ENV_ADMIN_BYPASS=false` 时：
  - 这是“真实登录模式”
  - 应按页面当前真实行为测试，不要人为跳过登录
  - 若登录页启用了 Turnstile，则按实际页面状态处理

### 8.6 不推荐的做法

- 不要默认改代码去“方便测试”
- 不要默认新增 e2e spec，除非用户明确要求写测试文件
- 不要先假设必须运行仓库内残留的旧浏览器测试入口
- 不要在没有确认当前 env 的情况下，直接断言旁路模式一定开启
- 不要使用过期 snapshot 的 ref 连续操作多个页面

### 8.7 输出结果时至少说明

- 这次是否使用了本地 Playwright CLI，或者是否执行了根目录 e2e 测试
- 访问的入口地址
- 当前 `TEST_ENV_ADMIN_BYPASS` 状态
- 实际执行了哪些页面操作
- 控制台是否有报错或 warning
- 是否只做了浏览器验证，还是还执行了真实提交/写操作
- 测试结束后是否已清理临时服务、端口监听和 Playwright 会话；如果没有清理，要明确列出残留项

## 9. Agent 执行约定

后续 Agent 在本项目应优先遵循：

1. 先在开发目录修改代码并通过基本测试
2. 使用仿真脚本验证 Docker 运行链路
3. 使用 `release.sh` 推送 Docker Hub(这一步只有在用户要求的时候才允许做，平时开发不需要频繁发布)
4. 依赖服务器 Watchtower 自动更新
5. 涉及流程变更时同步更新 `README.md` 与本文件
