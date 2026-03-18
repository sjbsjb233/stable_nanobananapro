# Nano Banana Pro

`stable_nanobananapro` 由两个服务组成：

- `backend/`：FastAPI 后端
- `frontend/`：React + Vite 前端

当前仓库同时支持两套明确分离的流程：

- Codex / worktree 开发流程：只用 `./scripts/worktree-dev.sh`
- 手工本地仿真流程：保留 Docker 和 `srv_server/`，仅用于本地仿真或服务器模板维护

默认原则：

- 开发机负责改代码、跑测试、合并到 `main`、创建 release tag 和 GitHub Release
- GitHub Actions 负责构建镜像并推送 Docker Hub
- 服务器负责拉镜像、启动容器、由 Watchtower 自动更新
- 敏感配置通过 env 文件注入，不写进镜像
- 生产默认继续跟踪 `latest`，正式发布 tag 用于审计和回滚

## 项目结构

```text
stable_nanobananapro/
  backend/
  frontend/
  scripts/
    worktree-dev.sh
    ci-remote-check.sh
    build-local-sim-images.sh
    make-release-tag.sh
  .github/
    workflows/
      ci-full.yml
      release-images.yml
    release.yml
  srv_server/
```

## 一、Codex / Worktree 开发流程

Agent / Codex 在本项目只应操作当前 worktree，并且只通过 `./scripts/worktree-dev.sh` 准备和运行环境。

### 1. 初始化

```bash
./scripts/worktree-dev.sh bootstrap
```

这会为当前 worktree 建立稳定入口：

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

脚本同时维护这些实例变量：

- `NBP_INSTANCE_ID`
- `NBP_BACKEND_PORT`
- `NBP_FRONTEND_PORT`
- `NBP_BACKEND_URL`
- `NBP_FRONTEND_URL`
- `NBP_BACKEND_DATA_DIR`

### 2. 启动与停止

```bash
./scripts/worktree-dev.sh up backend
./scripts/worktree-dev.sh up frontend
./scripts/worktree-dev.sh up all
./scripts/worktree-dev.sh down
./scripts/worktree-dev.sh status
eval "$(./scripts/worktree-dev.sh shellenv)"
```

端口规则：

- `backend = 18000 + slot * 10`
- `frontend = 18001 + slot * 10`

### 3. 测试

```bash
./scripts/worktree-dev.sh test backend
./scripts/worktree-dev.sh test e2e
cd frontend && npm run lint && npm run test -- --run && npm run build
```

说明：

- `test backend` 在当前实例环境中执行 `pytest -q`
- `test e2e` 默认把 `PW_BASE_URL` 指向当前实例 `NBP_FRONTEND_URL`
- 前端本地预检查固定为 `lint + vitest + build`
- 若没有 e2e spec，不会切到 Docker 流程

### 4. Playwright CLI

当用户明确要求浏览器自动化测试时，统一用本地 Playwright CLI：

```bash
./scripts/worktree-dev.sh up all
eval "$(./scripts/worktree-dev.sh shellenv)"
./tools/playwright/scripts/playwright-cli.sh open "$NBP_FRONTEND_URL" --headed
./tools/playwright/scripts/playwright-cli.sh snapshot
```

约束：

- 先 `open`，再 `snapshot`，再按最新 ref 操作
- 页面变化后重新 `snapshot`
- 不默认伪造 cookie / session
- `TEST_ENV_ADMIN_BYPASS=false` 时按真实登录流程测试
- 结束后清理服务和 Playwright 会话

## 二、本地“生产仿真”流程

这部分保留给人工验证镜像和部署链路，不是 Codex 默认入口。

本地仿真目录约定：

```text
srv/stable/
  compose/
    docker-compose.prod.yml
    .env
  config/
    backend.prod.env
  data/
```

### 1. 构建本地仿真镜像

```bash
./scripts/build-local-sim-images.sh
```

默认行为：

- `TAG=$(git rev-parse --short HEAD)`
- 构建平台为 `linux/arm64`
- 生成 `local/stable-backend:<TAG>` 与 `local/stable-frontend:<TAG>`

### 2. 启动仿真容器

```bash
cd srv/stable/compose
docker compose -f docker-compose.prod.yml up -d --remove-orphans
docker compose -f docker-compose.prod.yml ps
```

## 三、CI 与正式发布

本次仓库改造后，发布链路职责固定如下：

- `.github/workflows/ci-full.yml`
  - 在 `pull_request` 和 `main` 上运行
  - 每个 PR 全量运行 `backend-full` / `frontend-full` / `e2e-full` / `docker-build`
  - 后端执行 `ruff + pytest --cov`
  - 前端执行 `eslint + vitest + build`
  - e2e 以 `TEST_ENV_ADMIN_BYPASS=true` 与 `TEST_FAKE_GENERATOR=true` 启动真实前后端，再跑 Playwright
  - Docker 镜像只做构建校验，不推镜像
  - 不推镜像
- `.github/workflows/release-images.yml`
  - 只在 GitHub Release `published` 时运行
  - 构建 backend / frontend 镜像
  - 推送正式版本 tag 和 `latest`
- `.github/release.yml`
  - 给 GitHub 自动生成 Release Notes 做分类

### 1. 本地预检查与远程 CI 验证

建议顺序：

```bash
./scripts/worktree-dev.sh test backend
cd frontend && npm run lint && npm run test -- --run && npm run build
./scripts/worktree-dev.sh up all
./scripts/worktree-dev.sh test e2e
./scripts/worktree-dev.sh down
./scripts/ci-remote-check.sh
```

如果只想手动触发远端 workflow，也可以直接：

```bash
gh workflow run ci-full.yml --ref <branch>
gh run list --workflow ci-full.yml --branch <branch> --limit 1
gh run watch <run-id> --exit-status
gh run view <run-id> --log-failed
```

### 2. 版本命名

正式发布统一使用：

```text
v<人类版本号>-<短hash>
```

例如：

- `v0.0.7-8f3a2c1`
- `v0.1.0-a91c0de`

这个 tag 会同时映射到：

- Git tag：源码版本锚点
- GitHub Release：正式发布记录
- Docker 镜像 tag：回滚和审计用版本号

### 3. Docker Hub 镜像 tag 约定

每次正式发布会自动推送：

- `${NAMESPACE}/${APP_NAME}-backend:<RELEASE_TAG>`
- `${NAMESPACE}/${APP_NAME}-backend:latest`
- `${NAMESPACE}/${APP_NAME}-frontend:<RELEASE_TAG>`
- `${NAMESPACE}/${APP_NAME}-frontend:latest`

说明：

- 正式 tag 用于回滚和问题定位
- `latest` 保持给当前 Watchtower 自动更新链路使用

### 4. GitHub 仓库需要配置

Repository Secrets：

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

Repository Variables：

- `DOCKERHUB_NAMESPACE`
- `APP_NAME`

Branch Protection / Required Checks 建议更新为：

- `backend-full`
- `frontend-full`
- `e2e-full`
- `docker-build`

### 5. 标准正式发布流程

先切到最新主分支：

```bash
git switch main
git pull
```

生成完整发布 tag：

```bash
SHORT="$(git rev-parse --short HEAD)"
TAG="v0.0.7-$SHORT"
```

或者使用辅助脚本：

```bash
./scripts/make-release-tag.sh v0.0.7
```

创建 annotated tag 并推送：

```bash
git tag -a "$TAG" -m "Release $TAG"
git push origin "$TAG"
```

然后再创建 GitHub Release：

```bash
gh release create "$TAG" --verify-tag --generate-notes --title "$TAG"
```

也可以在 GitHub 网页端选择刚刚 push 的 tag，再点 `Generate release notes`。

统一要求：

- 不要让 CLI 自动帮你创建 tag
- 一律先 `git tag -a`，再 `git push origin <tag>`，最后才创建 Release
- `Generate release notes` / `--generate-notes` 只能作为初稿，不能直接当最终发布正文
- 发布前应人工检查 compare 区间、主要 PR、测试/CI 变化，并补齐本次版本真正的核心功能、修复和运维影响
- Release 正文至少应覆盖：版本摘要、主要功能/修复、管理端或运维侧变化、测试/CI 改动、依赖或兼容性说明、Full Changelog 链接
- 如果正文写错或自动生成内容漏了重点，优先使用 `gh release edit <tag>` 修正现有 Release；不要删除并重建 Release
- 如果线上已经在跑该版本，而当前仅是描述问题，不要重新发布或重推镜像

### 6. 发布后会发生什么

当 GitHub Release 发布后：

1. `release-images.yml` 读取 Release tag
2. 登录 Docker Hub
3. 构建 backend / frontend 镜像
4. 推送 `${RELEASE_TAG}` 和 `latest`
5. 生产机上的 Watchtower 检测到 `latest` 更新并自动拉取

## 四、生产服务器部署

推荐直接上传 [`srv_server/`](/Users/sjbsjb233/work/tools/stable_nanobananapro/srv_server) 到服务器，例如 `/srv/stable`。

上传后目录应类似：

```text
/srv/stable/
  compose/
    docker-compose.prod.yml
    .env
  config/
    backend.env
  data/
```

初始化：

```bash
cd /srv/stable
cp compose/.env.example compose/.env
cp config/backend.env.example config/backend.env
```

启动：

```bash
cd /srv/stable/compose
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

### 1. 生产默认策略

当前仍建议：

- `BACKEND_TAG=latest`
- `FRONTEND_TAG=latest`

这样可以保持现有 Watchtower 自动更新逻辑不变。

### 2. 私有 Docker Hub 凭据

如果镜像仓库是私有的，宿主机至少执行一次：

```bash
docker login docker.io
```

然后在 `compose/.env` 中确认：

```bash
DOCKER_CONFIG_PATH=/root/.docker/config.json
```

`docker-compose.prod.yml` 已把这个文件挂载到 Watchtower 容器内的 `/config.json`，用于拉取私有镜像。

## 五、回滚

正式版本回滚优先用固定 tag：

```bash
BACKEND_TAG=v0.0.6-1a2b3c4
FRONTEND_TAG=v0.0.6-1a2b3c4
```

然后执行：

```bash
cd /srv/stable/compose
docker compose -f docker-compose.prod.yml up -d
```

不建议把“回滚”做成重新覆盖 `latest` 的自动流程。

## 六、故障排查

### 1. GitHub Release 发布后没有推镜像

检查：

- Release 是否是 `published`，而不是只 push 了 tag
- `DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN` 是否存在
- `DOCKERHUB_NAMESPACE`、`APP_NAME` 是否存在
- GitHub Actions 日志里是否卡在 Docker Hub 登录或 build 阶段

### 2. Watchtower 没有自动更新

检查：

- `BACKEND_TAG` / `FRONTEND_TAG` 是否仍为 `latest`
- 目标容器是否仍保留 `com.centurylinklabs.watchtower.enable=true`
- 宿主机 `docker login` 后的 `config.json` 是否已挂载给 Watchtower
- `docker compose -f docker-compose.prod.yml logs -f watchtower` 是否能看到拉取行为

### 3. 需要精确回滚

不要依赖 `latest` 历史状态，直接把 `compose/.env` 改为某个正式版本 tag，再执行一次：

```bash
docker compose -f docker-compose.prod.yml up -d
```
