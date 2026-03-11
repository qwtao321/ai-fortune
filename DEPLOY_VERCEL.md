# Vercel 后端改造部署说明

## 1. 项目现状
- 前端页面仍为根目录 `index.html`（静态）。
- 后端已迁移为 Vercel Functions：
  - `api/fortune.js`
  - `api/admin-keys.js`
- 前端调用地址已改为同域：`/api/fortune`。

## 2. 环境变量（Vercel Project Settings -> Environment Variables）
- `DATABASE_URL`：Neon Postgres 连接串
- `ZHIPU_API_KEY`：智谱 API Key
- `ADMIN_SECRET`：后台密钥管理接口鉴权口令

建议三个环境都配置：`Development` / `Preview` / `Production`。

## 3. 初始化数据库
在 Neon 控制台 SQL Editor 执行 `db/schema.sql` 全量内容。

## 4. 验证步骤
1. 访问首页，输入密钥时会触发 `/api/fortune` 的 `checkOnly` 校验。
2. 正常推演一次，确认：
   - 返回结果成功
   - `user_keys.credits` 被扣减
   - `fortune_records` 新增记录
3. 调用 `/api/admin-keys` 验证密钥管理动作（generate/list/disable/setCredit）。

## 5. 注意事项
- `cloudfunctions` 目录为历史代码，当前线上链路已不再依赖。
- 若要完全清理历史代码，可在确认新链路稳定后删除 `cloudfunctions` 与旧文档。
