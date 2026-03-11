'use strict';

/**
 * 云函数：fortune
 * ─────────────────────────────────────────────────────────────────
 * 功能：校验用户购买的 user_key 积分 → 扣减 → 调用智谱 GLM-4 → 返回命理解读
 *
 * 支持两种调用方式：
 *   1. HTTP 触发器（前端 fetch 调用）  ← 推荐，无需 TCB JS SDK
 *   2. SDK callFunction（旧方式，向后兼容）
 *
 * 数据库集合：user_keys
 *   字段：key(string)  credits(number)  note(string)  created_at(string)
 *
 * 请求参数（JSON body）：
 *   userKey    : string        — 用户购买的密钥
 *   checkOnly  : boolean       — true 时仅校验不推演（用于保存密钥时验证）
 *   name       : string        — 姓名
 *   gender     : '男' | '女'
 *   baziInfo   : { 四柱/纳音/五行/农历/公历 }
 *
 * 返回格式：
 *   成功推演  → { code: 0,    data: { result: "...", credits: 剩余积分 } }
 *   仅校验    → { code: 0,    data: { credits: 剩余积分 } }
 *   积分不足  → { code: 1001, message: "能量不足，请购买新密钥" }
 *   密钥无效  → { code: 1002, message: "密钥无效，请检查后重新输入" }
 *   参数缺失  → { code: 400,  message: "参数不完整" }
 *   服务错误  → { code: 500,  message: "..." }
 *
 * 环境变量（TCB 控制台 › 云函数 › fortune › 函数配置 › 环境变量）：
 *   ZHIPU_API_KEY  — 智谱 AI 平台 API Key（https://open.bigmodel.cn/）
 * ─────────────────────────────────────────────────────────────────
 */

const cloud = require('@cloudbase/node-sdk');
const https = require('https');
const { getGuaInfo } = require('./guaDict');
const { FIVE_ELEMENTS_LOGIC } = require('./fiveElementsLogic');

const app = cloud.init({
  env: process.env.SCF_NAMESPACE || process.env.TCB_ENV_ID || cloud.DYNAMIC_CURRENT_ENV,
});
const db  = app.database();
const _   = db.command;

/* CORS 响应头（回显 origin，兼容 file:// null 来源和线上域名） */
function corsHeaders(origin) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'false',
  };
}

/* 包装成 HTTP 响应格式 */
function httpResp(statusCode, data, origin) {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify(data) };
}

/* ══════════════════════════════════════════════════════════════════
   主入口
   ══════════════════════════════════════════════════════════════════ */
exports.main = async (event) => {
  const isHttp = !!(event.httpMethod); // 判断是否为 HTTP 触发器调用

  /* 提取请求来源（用于 CORS 回显） */
  const origin = isHttp
    ? (event.headers && (event.headers['origin'] || event.headers['Origin'])) || null
    : null;

  /* 处理 CORS 预检请求 */
  if (isHttp && event.httpMethod === 'OPTIONS') {
    return httpResp(200, {}, origin);
  }

  /* 解析参数：HTTP 触发器从 body 解析，SDK 调用直接用 event */
  let params;
  if (isHttp) {
    try {
      params = JSON.parse(event.body || '{}');
    } catch (e) {
      return httpResp(400, { code: 400, message: '请求体 JSON 解析失败' }, origin);
    }
  } else {
    params = event;
  }

  const {
    userKey, apiKey, checkOnly, type, mode,
    name, gender, baziInfo,
    question, hexagramData, outerResponse,
  } = params;
  const reqMode = (type || mode || 'bazi').toLowerCase();
  const finalKey = userKey || apiKey;

  /* 统一返回包装：HTTP 触发器用 httpResp，SDK 调用直接返回 */
  const reply = (data) => isHttp ? httpResp(200, data, origin) : data;

  if (!finalKey) return reply({ code: 400, message: '参数不完整：缺少 userKey/apiKey' });

  try {
    /* ── 1. 查询 user_keys 集合 ── */
    const snap = await db
      .collection('user_keys')
      .where({ key: finalKey })
      .limit(1)
      .get();

    if (!snap.data || snap.data.length === 0) {
      return reply({ code: 1002, message: '密钥无效，请检查后重新输入' });
    }

    const keyDoc  = snap.data[0];
    const credits = keyDoc.credits || 0;

    /* ── 2. 仅校验模式（checkOnly=true）：返回积分不消耗 ── */
    if (checkOnly) {
      if (credits <= 0) return reply({ code: 1001, message: '能量不足，请购买新密钥' });
      return reply({ code: 0, data: { credits } });
    }

    /* ── 3. 推演前校验参数 ── */
    if (reqMode === 'meihua') {
      if (!question || !hexagramData) {
        return reply({ code: 400, message: '参数不完整：缺少 question 或 hexagramData' });
      }
      if (!hexagramData.benGuaCode || !hexagramData.huGuaCode || !hexagramData.bianGuaCode) {
        return reply({ code: 400, message: '参数不完整：本卦/互卦/变卦编码缺失' });
      }
    } else if (!name || !baziInfo) {
      return reply({ code: 400, message: '参数不完整：缺少 name 或 baziInfo' });
    }

    /* ── 4. 校验积分 ── */
    if (credits <= 0) {
      return reply({ code: 1001, message: '能量不足，请购买新密钥' });
    }

    /* ── 5. 原子扣减积分（防并发重复消费） ── */
    await db
      .collection('user_keys')
      .doc(keyDoc._id)
      .update({ credits: _.inc(-1) });

    const remaining = credits - 1;

    /* ── 6. 调用智谱 GLM-4 ── */
    const aiResult = reqMode === 'meihua'
      ? await callZhipu(buildMeihuaPrompt({ question, hexagramData, outerResponse }))
      : await callZhipu(buildPrompt({ name, gender, baziInfo }));

    return reply({
      code: 0,
      data: {
        result:  aiResult,
        credits: remaining,
      },
    });

  } catch (err) {
    console.error('[fortune] 执行失败：', err);
    return reply({ code: 500, message: '服务内部错误：' + (err.message || String(err)) });
  }
};

/* ══════════════════════════════════════════════════════════════════
   构建命理 Prompt
   ══════════════════════════════════════════════════════════════════ */
function buildPrompt({ name, gender, baziInfo: b }) {
  return `你是一位精通中西命理、玄学与心理学的智者，说话幽默睿智且充满人格魅力。

为命主「${name}」（${gender}）进行八字命理分析。

【四柱八字】
年柱：${b.yearGan}${b.yearZhi}（${b.yearNaYin}·${b.yearWuXing}）
月柱：${b.monthGan}${b.monthZhi}（${b.monthNaYin}·${b.monthWuXing}）
日柱：${b.dayGan}${b.dayZhi}（${b.dayNaYin}·${b.dayWuXing}）
时柱：${b.timeGan}${b.timeZhi}（${b.timeNaYin}·${b.timeWuXing}）
农历：${b.lunarYear}${b.lunarMonth}${b.lunarDay}

请依次分析以下四个维度，每项 2-3 句，语气像对老朋友说话，不要用"根据八字"开场：

【性格特质】

【事业走向】

【感情缘分】

【健康提示】

最后，用一句七言押韵签文收尾，格式如：
【签文】XXXX，XXXX。`;
}

function guaMetaFromCode(code, fallbackName) {
  if (!code || String(code).length < 2) {
    return { name: fallbackName || '未定卦', guaci: '此卦需结合动爻与体用关系综合判断。' };
  }
  const upper = +String(code)[0];
  const lower = +String(code)[1];
  const g = getGuaInfo(upper, lower);
  return {
    name: g.name || fallbackName || '未定卦',
    guaci: `${g.meaning || '卦义待补全'}；${g.advice || '建议待补全'}`,
  };
}

function buildMeihuaBackgroundContext(h) {
  const ben = guaMetaFromCode(h.benGuaCode, h.benGuaName || `${h.upper || '?'}上${h.lower || '?'}下`);
  const hu = guaMetaFromCode(h.huGuaCode, h.huGuaName || '互卦');
  const bian = guaMetaFromCode(h.bianGuaCode, h.bianGuaName || '变卦');
  const relationKey = h.relation || '失衡';
  const relationInfo = FIVE_ELEMENTS_LOGIC[relationKey] || FIVE_ELEMENTS_LOGIC['失衡'];
  const elementLine = `体卦:${h.tiGua || '-'} 用卦:${h.yongGua || '-'} 关系:${relationKey}`;
  return {
    ben,
    hu,
    bian,
    relationKey,
    relationInfo,
    elementLine,
  };
}

function buildMeihuaPrompt({ question, hexagramData: h, outerResponse }) {
  const ctx = buildMeihuaBackgroundContext(h);
  const timeFactor = outerResponse?.timeFactor || {};
  const dirFactor = outerResponse?.directionFactor || {};
  return `你现在扮演一位“犀利的战略咨询师兼梅花易数专家”。请直接给结论，不说空话。

用户问题：${question}

【结构化背景（用于推理，不要照抄）】
- 本卦：${ctx.ben.name}（编码:${h.benGuaCode}）｜卦辞：${ctx.ben.guaci}
- 互卦：${ctx.hu.name}（编码:${h.huGuaCode}）｜卦辞：${ctx.hu.guaci}
- 变卦：${ctx.bian.name}（编码:${h.bianGuaCode}）｜卦辞：${ctx.bian.guaci}
- 动爻：第 ${h.movingLine || '-'} 爻
- ${ctx.elementLine}
- 生克结论：${ctx.relationInfo.status}
- 生克断语：${ctx.relationInfo.desc}
- 气场建议：${ctx.relationInfo.vibe}
- 外应时间：农历${timeFactor.lunarMonthDay || '未知'}，${timeFactor.hourZhi || '未知'}时，季节旺衰${timeFactor.seasonWuxing || '未知'}
- 外应方位：${dirFactor.direction || '未知'}（${dirFactor.source || '未知来源'}）

你现在的身份是解卦专家。我已为你提供了完整的易数三境（本卦、互卦、变卦）和外应信息。
请严格使用 Markdown 输出，并严格按以下四段标题（原样输出）：
## 【卦象解码】
简述本卦（现状）、互卦（过程）、变卦（未来）含义，必须引用上面卦辞关键词。

## 【外应分析】
结合当前时间与方位分析五行能量增益或损耗，并明确指出“贵人属性”和“阻力属性”。

## 【过程推演】
利用互卦剖析中期隐藏变化，至少列出 2 条具体干扰。

## 【结局定断】
根据变卦给出最终走向，并给出 3 条像 PM 处理 Bug 一样具体的行动建议（每条都要有：触发条件、动作、预期反馈）。`;
}

/* ══════════════════════════════════════════════════════════════════
   调用智谱 GLM-4（原生 HTTPS）
   ══════════════════════════════════════════════════════════════════ */
function callZhipu(prompt) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ZHIPU_API_KEY;
    if (!apiKey) return reject(new Error('未配置环境变量 ZHIPU_API_KEY'));

    const body = JSON.stringify({
      model: 'glm-4-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.85,
      max_tokens: 800,
    });

    const options = {
      hostname: 'open.bigmodel.cn',
      path: '/api/paas/v4/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.choices && json.choices[0]) {
            resolve(json.choices[0].message.content.trim());
          } else {
            reject(new Error('智谱 API 返回异常：' + raw));
          }
        } catch (e) {
          reject(new Error('解析响应失败：' + raw));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
