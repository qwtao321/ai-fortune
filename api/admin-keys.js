'use strict';

const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new Error('未配置环境变量 DATABASE_URL');
  }
  return neon(process.env.DATABASE_URL);
}

function send(res, data, status = 200) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(data));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return {};
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, { code: 405, message: 'Method Not Allowed' }, 405);

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return send(res, { code: 400, message: '请求体 JSON 解析失败' }, 400);
  }

  const { secret, action } = body;
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return send(res, { code: 403, message: '鉴权失败' }, 403);
  }

  try {
    const sql = getSql();
    switch (action) {
      case 'generate': {
        const count = Math.min(Number(body.count || 1), 100);
        const credits = Math.min(Number(body.credits || 10), 999);
        const note = body.note || '';
        const keys = [];

        for (let i = 0; i < count; i++) {
          const key = 'FM-' + crypto.randomBytes(8).toString('hex').toUpperCase();
          keys.push(key);
          await sql`
            INSERT INTO user_keys (key, credits, note)
            VALUES (${key}, ${credits}, ${note})
          `;
        }
        return send(res, { code: 0, data: { keys, count, credits } });
      }
      case 'list': {
        const limit = Math.min(Number(body.limit || 50), 200);
        const rows = await sql`
          SELECT key, credits, note, created_at, updated_at
          FROM user_keys
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
        return send(res, { code: 0, data: rows });
      }
      case 'disable': {
        if (!body.key) return send(res, { code: 400, message: '缺少 key 参数' }, 400);
        const result = await sql`
          UPDATE user_keys
          SET credits = 0, updated_at = NOW()
          WHERE key = ${body.key}
          RETURNING key
        `;
        if (!result.length) return send(res, { code: 404, message: '密钥不存在' }, 404);
        return send(res, { code: 0, message: '已禁用' });
      }
      case 'setCredit': {
        if (!body.key || body.credits === undefined) {
          return send(res, { code: 400, message: '缺少 key 或 credits 参数' }, 400);
        }
        const credits = Number(body.credits);
        const result = await sql`
          UPDATE user_keys
          SET credits = ${credits}, updated_at = NOW()
          WHERE key = ${body.key}
          RETURNING key, credits
        `;
        if (!result.length) return send(res, { code: 404, message: '密钥不存在' }, 404);
        return send(res, { code: 0, message: '已更新', data: { credits } });
      }
      default:
        return send(res, { code: 400, message: `未知操作：${action}` }, 400);
    }
  } catch (err) {
    console.error('[api/admin-keys] 执行失败：', err);
    return send(res, { code: 500, message: err.message || String(err) }, 500);
  }
};
