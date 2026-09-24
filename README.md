# 志愿者积分与信用评估

记录志愿服务、计算积分信用、处理投诉和生成排行榜的后端服务。

## 快速启动（Docker Compose）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：

- 前端：http://localhost:8243
- 后端健康检查：http://localhost:3243/api/health
- 数据库端口：localhost:5743

停止并清理容器、网络和数据卷：

```bash
docker compose down -v --remove-orphans
```

## 主要功能

- 志愿者档案与服务记录
- 积分、徽章和信用分计算
- 投诉处理、后台调整和排行榜
- 按服务类型生效的资格管理（医疗辅助、救灾援助需持证排班）

## 服务资格

医疗辅助（medical_assist）、救灾援助（disaster_relief）两类服务必须持有有效资格才能排班，
其余类型（文化活动、社区服务等）无需资格照常录入。

- 管理员登记资格：`POST /api/v1/admin/qualifications`，需指定服务类型和有效期；同一志愿者同一类型只保留一份有效资格
- 续期：`POST /api/v1/admin/qualifications/:id/renew`，旧资格置为 renewed 留档，新资格紧接旧有效期生效
- 撤销：`POST /api/v1/admin/qualifications/:id/revoke`，撤销当日立即失效；撤销日前的历史服务仍可补录
- 资格到期自动失效，失效/撤销后可重新登记
- 录入服务记录（单条或批量）时按服务日期核对本人当时资格：不符合即整批拒绝，返回志愿者和服务类型，积分、次数、徽章、信用均不变
- 查询资格：`GET /api/v1/volunteers/:id/qualifications`（当前资格 + 历史留档）；志愿者详情 `/summary` 同样包含当前资格与有效期

## 本地开发

前端：

```bash
cd frontend
npm install
npm run dev
```

后端：

```bash
cd backend
npm install
npm run dev
```

数据库可通过根目录的 Docker Compose 单独启动：

```bash
docker compose up -d db
```

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | Static HTML + Nginx |
| 后端 | Express + TypeScript |
| 数据库 | PostgreSQL |
| 部署 | Docker Compose + Nginx |

## 项目目录结构

```text
.
├── docker-compose.yml
├── .env.example
├── .env
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   └── ...
├── backend/
│   ├── Dockerfile
│   └── ...
└── database/
    └── ...
```

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| COMPOSE_PROJECT_NAME | Compose 项目名，避免中文目录名导致项目名为空 | gb-143 |
| DB_NAME | 数据库名称 | volunteer_db |
| DB_USER | 数据库用户 | volunteer_user |
| DB_PASSWORD | 数据库密码 | volunteer_pass |
| DB_ROOT_PASSWORD | 数据库 root/superuser 密码 | volunteer_root_pwd |
| JWT_SECRET | 后端签名密钥 | volunteer_credit_secret_key_2026 |
| FRONTEND_PORT | 前端宿主机端口 | 8243 |
| BACKEND_PORT | 后端宿主机端口 | 3243 |
| DB_PORT | 数据库宿主机端口 | 5743 |

## Docker 部署说明

- `docker-compose.yml` 顶层已声明 `name: gb-143`，可以在中文目录名下直接运行。
- 数据库使用 Docker 命名卷 `db_data` 持久化，不绑定到宿主中文路径。
- 前端容器使用 Nginx 托管静态资源，并将 `/api` 反向代理到后端服务名 `backend`。
- 后端会等待数据库健康后再启动，前端会等待后端健康后再启动。
- 如本机端口冲突，修改根目录 `.env` 中的 `FRONTEND_PORT`、`BACKEND_PORT` 或 `DB_PORT`。

## License

MIT
