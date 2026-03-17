# AGENTS.md

本文件用于让后续 Agent / 维护者快速接管本项目，并严格区分：

- Codex / worktree 开发流程：只用命令行和 `./scripts/worktree-dev.sh`
- 人工本地仿真 Docker 流程：保留给你自己手工验证，Agent 默认不调用

## 1. 项目定位

- 项目名：`stable_nanobananapro`
- 架构：
  - `backend/`：FastAPI 后端
  - `frontend/`：React + Vite 前端
- 发布方式：Docker 镜像发布到 Docker Hub，生产机通过 Compose + Watchtower 更新
- 核心原则：
  - 开发机负责：改代码、跑测试、构建镜像、推送镜像
  - 生产机负责：拉镜像并运行容器
  - 数据目录持久化，不跟容器生命周期绑定
  - 密钥配置通过 `env_file` 注入，不写进镜像
  - 除健康检查与登录接口外，其余 API 默认都要求已登录

## 2. 代码目录与职责

- 常改目录：
  - `backend/app/`
  - `backend/tests/`
  - `frontend/src/`
  - `frontend/scripts/`
  - `tools/playwright/`
  - `backend/requirements*.txt`
  - `README.md`
  - `AGENTS.md`
  - `scripts/`
- 一般不改：
  - `srv/`
  - `srv_server/`
- 新开发环境状态目录：
  - `.codex-dev-env/shared/`：共享依赖和下载缓存
  - `.codex-dev-env/instances/<instance-id>/`：当前 worktree 私有 env、数据、日志、PID、Playwright 运行态

## 3. 认证与配置要点

- `backend/.env` 现在应是实例私有 env 的符号链接，真实文件位于 `.codex-dev-env/instances/<instance-id>/env/backend.env`
- `frontend/.env` 同理，真实文件位于 `.codex-dev-env/instances/<instance-id>/env/frontend.env`
- 首次启动会按 `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` 自动创建管理员
- `TEST_ENV_ADMIN_BYPASS` 默认建议保持 `false`，仅在本地自动化测试需要时开启
- 当前项目的敏感项主要包括：
  - `SESSION_SECRET_KEY`
  - `TURNSTILE_SECRET_KEY`
  - `GEMINI_API_KEY`
  - `UPSTREAM_PROVIDERS_JSON`
- 前端 Turnstile 站点密钥：
  - 开发 / worktree 环境：`VITE_TURNSTILE_SITE_KEY`
  - Docker 运行时：`FRONTEND_TURNSTILE_SITE_KEY`
- 多中转站 provider 配置通过 `UPSTREAM_PROVIDERS_JSON` 注入
- provider 的启用状态、备注、余额与运行时状态由后端写入实例自己的 `backend-data/providers.json`

## 4. Agent / Codex Worktree 流程

### 4.1 硬约束

- 只处理“当前 `cwd` 所在 worktree”
- 不创建、不删除、不切换 `git worktree`
- 不调用 `docker`、`docker compose`、`buildx`
- 不读写 `srv/stable` 作为运行目录
- 共享的只有依赖和下载缓存
- 会相互污染的内容必须按实例隔离

### 4.2 唯一入口

主脚本：

```bash
./scripts/worktree-dev.sh
```

支持命令：

```bash
./scripts/worktree-dev.sh bootstrap
./scripts/worktree-dev.sh up backend
./scripts/worktree-dev.sh up frontend
./scripts/worktree-dev.sh up all
./scripts/worktree-dev.sh down
./scripts/worktree-dev.sh status
./scripts/worktree-dev.sh test backend
./scripts/worktree-dev.sh test e2e
./scripts/worktree-dev.sh shellenv
```

### 4.3 Bootstrap 后的稳定入口

脚本会为当前 worktree 建立这些固定入口：

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

对应真实状态目录：

```text
.codex-dev-env/
  shared/
    pip-cache/
    npm-cache/
    playwright-browsers/
    python-envs/<python-version>-<requirements-hash>/
    frontend-deps/<node-version>-<package-lock-hash>/
    playwright-deps/<node-version>-<package-lock-hash>/
  instances/<instance-id>/
    instance.json
    instance.env
    env/
      backend.env
      frontend.env
    runtime/
      backend-data/
      logs/
      pids/
      playwright-home/
      playwright-cli/
      playwright-cache/
      playwright-output/
      playwright-test-results/
```

### 4.4 统一环境变量

脚本会生成并维护：

- `NBP_INSTANCE_ID`
- `NBP_BACKEND_PORT`
- `NBP_FRONTEND_PORT`
- `NBP_BACKEND_URL`
- `NBP_FRONTEND_URL`
- `NBP_BACKEND_DATA_DIR`

所有运行命令和辅助脚本都应优先 `source` / 使用这些变量。

### 4.5 端口规则

- 每个实例分配一个 `slot`
- `backend = 18000 + slot * 10`
- `frontend = 18001 + slot * 10`
- `bootstrap` 会探测现有实例和端口占用，避免并行冲突

### 4.6 日常使用方式

初始化：

```bash
./scripts/worktree-dev.sh bootstrap
```

启动服务：

```bash
./scripts/worktree-dev.sh up all
```

查看状态：

```bash
./scripts/worktree-dev.sh status
```

临时注入实例环境：

```bash
eval "$(./scripts/worktree-dev.sh shellenv)"
```

停止服务：

```bash
./scripts/worktree-dev.sh down
```

## 5. 测试与 Playwright 约定

### 5.1 后端测试

```bash
./scripts/worktree-dev.sh test backend
```

### 5.2 Playwright e2e

```bash
./scripts/worktree-dev.sh test e2e
```

说明：

- `test e2e` 默认把 `PW_BASE_URL` 指向当前实例 `NBP_FRONTEND_URL`
- 如果没有 e2e spec，脚本会直接返回，不会改走 Docker

### 5.3 浏览器 CLI 使用约定

如果用户明确要求“用 Playwright / 浏览器自动化测试”，统一使用本地 Playwright CLI：

```bash
./scripts/worktree-dev.sh up all
eval "$(./scripts/worktree-dev.sh shellenv)"
./tools/playwright/scripts/playwright-cli.sh open "$NBP_FRONTEND_URL" --headed
./tools/playwright/scripts/playwright-cli.sh snapshot
```

规则：

- 默认先 `open`，再 `snapshot`，再按最新 ref 操作
- 页面明显变化后重新 `snapshot`
- 不要默认伪造 cookie / session
- 如果 `TEST_ENV_ADMIN_BYPASS=true`，可直接访问目标页面
- 如果 `TEST_ENV_ADMIN_BYPASS=false`，按真实登录流程测试
- 结束后必须清理：
  - `./scripts/worktree-dev.sh down`
  - Playwright 会话优先 `close` / `close-all`

测试结果汇报至少说明：

- 使用的是 Playwright CLI 还是 `test e2e`
- 访问入口地址
- `TEST_ENV_ADMIN_BYPASS` 当前状态
- 实际做了哪些页面操作
- 控制台是否有 error / warning
- 是否做了真实写操作
- 临时服务和 Playwright 会话是否已清理

## 6. 手工本地仿真 Docker 流程

这一节只给你人工使用，Agent 默认不调用。

本地仿真目录：

```text
srv/stable/
  compose/
  config/
  data/
```

相关脚本：

- `scripts/build-local-sim-images.sh`
- `scripts/deploy-local-sim.sh`
- `scripts/init-buildx.sh`

说明：

- Docker 仿真仍保留，用于你手工验证“生产姿势”
- Agent 做开发、调试、测试时，默认只走 `./scripts/worktree-dev.sh`

## 7. 发布与生产更新

- `release.sh` 只在用户明确要求发布时才允许执行
- 平时开发不要频繁推送 Docker Hub
- 生产机通过 Watchtower 自动更新 `latest`

## 8. Agent 执行约定

后续 Agent 在本项目应优先遵循：

1. 先修改开发目录代码并通过基本测试
2. 默认用 `./scripts/worktree-dev.sh` 完成环境准备、启动、测试、Playwright 验证
3. 不要为了测试方便而默认改代码
4. 不要默认新增 e2e spec，除非用户明确要求
5. 只有在用户明确要求时，才允许碰 Docker 发布链路或执行 `release.sh`
6. 涉及流程变更时同步更新 `README.md` 与本文件
