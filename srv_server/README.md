# srv_server

这套目录用于直接上传到生产服务器，例如 `/srv/stable`。

目录结构：

```text
srv_server/
  compose/
    docker-compose.prod.yml
    .env.example
  config/
    backend.env.example
  data/
    .gitkeep
```

## 1. 上传到服务器

把整个 [`srv_server/`](/Users/sjbsjb233/work/tools/stable_nanobananapro/srv_server) 上传到服务器目标目录，例如 `/srv/stable`。

## 2. 初始化配置

在服务器上执行：

```bash
cd /srv/stable
cp compose/.env.example compose/.env
cp config/backend.env.example config/backend.env
```

然后编辑：

- `compose/.env`
- `config/backend.env`

### `compose/.env` 最低配置项

建议至少确认这些值：

```dotenv
REGISTRY=docker.io
NAMESPACE=your-dockerhub-namespace
APP_NAME=stable-nanobananapro
BACKEND_TAG=latest
FRONTEND_TAG=latest
BACKEND_PORT=8000
FRONTEND_PORT=5178
WATCHTOWER_POLL_INTERVAL=300
TZ=Asia/Shanghai
FRONTEND_DEFAULT_API_BASE_URL=http://127.0.0.1:8000
FRONTEND_TURNSTILE_SITE_KEY=
DOCKER_CONFIG_PATH=/root/.docker/config.json
```

说明：

- `BACKEND_TAG` / `FRONTEND_TAG` 默认用 `latest`，保持 Watchtower 自动更新
- `DOCKER_CONFIG_PATH` 用于把宿主机 Docker 登录后的 `config.json` 挂给 Watchtower

### `config/backend.env` 最低配置项

至少需要按实际环境填写这些变量：

- `SESSION_SECRET_KEY`
- `TURNSTILE_SECRET_KEY`
- `TURNSTILE_SITE_KEY`
- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `UPSTREAM_PROVIDERS_JSON`
- `DATA_DIR`

仓库已提供 [`config/backend.env.example`](/Users/sjbsjb233/work/tools/stable_nanobananapro/srv_server/config/backend.env.example) 作为起点。

## 3. 私有 Docker Hub 登录

如果 backend/frontend 镜像是私有仓库，宿主机至少要先执行一次：

```bash
docker login docker.io
```

然后确认宿主机上存在：

```text
/root/.docker/config.json
```

当前 compose 已把该文件挂载为 Watchtower 容器内的 `/config.json`，用于拉取私有镜像。

## 4. 首次启动

```bash
cd /srv/stable/compose
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

检查三类服务：

- `stable-nanobananapro-backend`
- `stable-nanobananapro-frontend`
- `watchtower`

## 5. Watchtower 自动更新策略

当前策略保持最小改动：

- `BACKEND_TAG=latest`
- `FRONTEND_TAG=latest`
- `watchtower` 只监听带 `watchtower.enable=true` label 的前后端容器

正式发布后，GitHub Actions 会把新镜像同时推送为：

- `<正式版本 tag>`
- `latest`

因此生产环境会继续盯住 `latest` 自动更新，而正式版本 tag 用于回滚。

查看 Watchtower 日志：

```bash
cd /srv/stable/compose
docker compose -f docker-compose.prod.yml logs -f watchtower
```

## 6. 手工回滚

如果新版本有问题，优先把 `compose/.env` 中的：

- `BACKEND_TAG`
- `FRONTEND_TAG`

改成某个历史正式版本 tag，例如：

```dotenv
BACKEND_TAG=v0.0.6-1a2b3c4
FRONTEND_TAG=v0.0.6-1a2b3c4
```

然后执行：

```bash
cd /srv/stable/compose
docker compose -f docker-compose.prod.yml up -d
```

不建议通过“重新覆盖 `latest`”做第一优先级回滚。

## 7. 常见问题

### Watchtower 没有拉到新镜像

检查：

- `compose/.env` 是否仍是 `latest`
- 宿主机是否执行过 `docker login docker.io`
- `DOCKER_CONFIG_PATH` 指向的文件是否存在
- 目标服务是否仍保留 watchtower label

### 修改 `backend.env` 后服务未生效

`env_file` 改动通常需要重新创建容器：

```bash
cd /srv/stable/compose
docker compose -f docker-compose.prod.yml up -d --force-recreate backend
```
