'use strict';

/**
 * 云函数：admin_keys
 * ─────────────────────────────────────────────────────────────────
 * 仅供开发者后台调用，用于批量生成/查询/禁用用户密钥
 * 通过环境变量 ADMIN_SECRET 鉴权，防止公开调用
 *
 * 环境变量（TCB 控制台配置）：
 *   ADMIN_SECRET — 自定义管理员密码，调用时必须传入
 *
 * 支持操作（action 字段）：
 *   generate  — 批量生成密钥并写入数据库
 *   list      — 查询所有密钥列表
 *   disable   — 将指定密钥积分清零（禁用）
 *   setCredit — 手动设置指定密钥的积分
 * ─────────────────────────────────────────────────────────────────
 */

const cloud  = require('@cloudbase/node-sdk');
const crypto = require('crypto');

const app = cloud.init({
  env: process.env.SCF_NAMESPACE || process.env.TCB_ENV_ID || cloud.DYNAMIC_CURRENT_ENV,
});
const db  = app.database();

exports.main = async (event) => {
  /* ── 管理员鉴权 ── */
  if (!process.env.ADMIN_SECRET || event.secret !== process.env.ADMIN_SECRET) {
    return { code: 403, message: '鉴权失败' };
  }

  const { action } = event;

  try {
    switch (action) {

      /* ── 批量生成密钥 ──
         参数：count(数量，默认1) credits(每张积分，默认10) note(备注)
         返回：生成的 key 列表
      */
      case 'generate': {
        const count   = Math.min(+event.count   || 1,  100); // 最多一次100张
        const credits = Math.min(+event.credits || 10, 999);
        const note    = event.note || '';
        const now     = new Date().toISOString();

        const keys = [];
        for (let i = 0; i < count; i++) {
          const key = 'FM-' + crypto.randomBytes(8).toString('hex').toUpperCase();
          keys.push(key);
          await db.collection('user_keys').add({
            key,
            credits,
            note,
            created_at: now,
            used_count: 0,
          });
        }
        return { code: 0, data: { keys, count, credits } };
      }

      /* ── 查询密钥列表 ──
         参数：limit(数量，默认50)
         返回：密钥文档列表
      */
      case 'list': {
        const limit = Math.min(+event.limit || 50, 200);
        const snap  = await db.collection('user_keys').limit(limit).get();
        return { code: 0, data: snap.data };
      }

      /* ── 禁用密钥（积分清零）──
         参数：key(密钥字符串)
      */
      case 'disable': {
        if (!event.key) return { code: 400, message: '缺少 key 参数' };
        const snap = await db.collection('user_keys').where({ key: event.key }).limit(1).get();
        if (!snap.data.length) return { code: 404, message: '密钥不存在' };
        await db.collection('user_keys').doc(snap.data[0]._id).update({ credits: 0 });
        return { code: 0, message: '已禁用' };
      }

      /* ── 手动设置积分 ──
         参数：key(密钥字符串) credits(新积分值)
      */
      case 'setCredit': {
        if (!event.key || event.credits === undefined) {
          return { code: 400, message: '缺少 key 或 credits 参数' };
        }
        const snap = await db.collection('user_keys').where({ key: event.key }).limit(1).get();
        if (!snap.data.length) return { code: 404, message: '密钥不存在' };
        await db.collection('user_keys').doc(snap.data[0]._id)
          .update({ credits: +event.credits });
        return { code: 0, message: '已更新', data: { credits: +event.credits } };
      }

      default:
        return { code: 400, message: `未知操作：${action}` };
    }
  } catch (err) {
    console.error('[admin_keys]', err);
    return { code: 500, message: err.message || String(err) };
  }
};
