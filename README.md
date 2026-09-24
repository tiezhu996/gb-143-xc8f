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
- 按服务类型生效的资格核验（医疗辅助、救灾援助等）

## 服务资格核验

医疗辅助（`medical_assist`）、救灾援助（`disaster_relief`）等需要专业资质的服务类型，必须先由管理员登记资格（含有效期）才能录入服务记录；文化活动、社区服务等普通类型照常录入。

资格管理（需管理员令牌）：

- `POST /api/v1/admin/qualifications/volunteers/:volunteerId/issue` — 登记资格（同一类型已有有效资格时拒绝，请走续期）
- `POST /api/v1/admin/qualifications/volunteers/:volunteerId/renew` — 续期，旧资格标记为 `renewed` 留档
- `POST /api/v1/admin/qualifications/:id/revoke` — 撤销，立即失效
- `GET /api/v1/admin/qualifications/volunteers/:volunteerId` — 当前资格与历史留档
- `POST /api/v1/admin/qualifications/check` — 排班预检，按服务日期核对资格，不落库

录入核验规则：

- 单条录入：按服务日期（`recorded_at`，缺省为当天）核对本人当时资格；不符返回 422 及人员、类型、原因，积分/次数/徽章/信用均不变。
- 批量录入：先整批预检，任一记录资格不符则**整批拒绝**（422），响应中返回所有违规的人员与类型，不写入任何记录。

志愿者侧可通过 `GET /api/v1/volunteers/:id/qualifications` 查询资格留档，`GET /api/v1/volunteers/:id/summary` 返回当前资格与有效期。


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
