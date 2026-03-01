# srv_server

这套目录用于上传到生产服务器（例如 `/srv/stable`）。

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

把整个 `srv_server/` 上传到服务器目标目录（例如 `/srv/stable`）。

## 2. 服务器初始化

在服务器上执行：

```bash
cd /srv/stable
cp compose/.env.example compose/.env
cp config/backend.env.example config/backend.env
```

然后编辑：

- `compose/.env`：镜像仓库、端口、tag、watchtower 轮询间隔
- `config/backend.env`：后端业务环境变量（密钥等）

## 3. 首次启动

```bash
cd /srv/stable/compose
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

## 4. watchtower 自动更新说明

- 当前配置通过 `watchtower` 监听带 label 的 `backend/frontend` 容器。
- 默认 `BACKEND_TAG=latest`、`FRONTEND_TAG=latest`，当你推送新的 `latest` 镜像后，watchtower 会自动拉取并滚动重启容器。
- 如果你改成固定 hash tag（例如 `a1b2c3d`），watchtower不会自动切换到新 hash，需要你手动改 `.env` 并 `docker compose up -d`。

## 5. 回滚

如果你使用固定版本 tag：

1. 修改 `compose/.env` 里的 `BACKEND_TAG` / `FRONTEND_TAG`
2. 执行：

```bash
cd /srv/stable/compose
docker compose -f docker-compose.prod.yml up -d
```
