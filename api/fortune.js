'use strict';

const { neon } = require('@neondatabase/serverless');
const { getGuaInfo } = require('../lib/server/guaDict');
const { FIVE_ELEMENTS_LOGIC } = require('../lib/server/fiveElementsLogic');

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
  if (req.method === 'OPTIONS') return send(res, {});
  if (req.method !== 'POST') return send(res, { code: 405, message: 'Method Not Allowed' }, 405);

  let params;
  try {
    params = await readBody(req);
  } catch (e) {
    return send(res, { code: 400, message: '请求体 JSON 解析失败' }, 400);
  }

  const {
    userKey, apiKey, checkOnly, type, mode,
    name, gender, baziInfo,
    question, hexagramData, outerResponse,
  } = params;

  const reqMode = (type || mode || 'bazi').toLowerCase();
  const finalKey = userKey || apiKey;

  if (!finalKey) return send(res, { code: 400, message: '参数不完整：缺少 userKey/apiKey' }, 400);

  try {
    const sql = getSql();
    const keyRows = await sql`
      SELECT key, credits
      FROM user_keys
      WHERE key = ${finalKey}
      LIMIT 1
    `;

    if (!keyRows.length) {
      return send(res, { code: 1002, message: '密钥无效，请检查后重新输入' });
    }

    const credits = Number(keyRows[0].credits || 0);

    if (checkOnly) {
      if (credits <= 0) return send(res, { code: 1001, message: '能量不足，请购买新密钥' });
      return send(res, { code: 0, data: { credits } });
    }

    if (reqMode === 'meihua') {
      if (!question || !hexagramData) {
        return send(res, { code: 400, message: '参数不完整：缺少 question 或 hexagramData' }, 400);
      }
      if (!hexagramData.benGuaCode || !hexagramData.huGuaCode || !hexagramData.bianGuaCode) {
        return send(res, { code: 400, message: '参数不完整：本卦/互卦/变卦编码缺失' }, 400);
      }
    } else if (!name || !baziInfo) {
      return send(res, { code: 400, message: '参数不完整：缺少 name 或 baziInfo' }, 400);
    }

    const updateRows = await sql`
      UPDATE user_keys
      SET credits = credits - 1, updated_at = NOW()
      WHERE key = ${finalKey} AND credits > 0
      RETURNING credits
    `;

    if (!updateRows.length) {
      return send(res, { code: 1001, message: '能量不足，请购买新密钥' });
    }

    const remaining = Number(updateRows[0].credits || 0);

    const aiResult = reqMode === 'meihua'
      ? await callZhipu(buildMeihuaPrompt({ question, hexagramData, outerResponse }))
      : await callZhipu(buildPrompt({ name, gender, baziInfo }));

    await sql`
      INSERT INTO fortune_records (
        key_ref, mode, question, input_payload, output_text, credits_after
      ) VALUES (
        ${finalKey},
        ${reqMode},
        ${question || null},
        ${JSON.stringify(params)},
        ${aiResult},
        ${remaining}
      )
    `;

    return send(res, {
      code: 0,
      data: {
        result: aiResult,
        credits: remaining,
      },
    });
  } catch (err) {
    console.error('[api/fortune] 执行失败：', err);
    return send(res, { code: 500, message: '服务内部错误：' + (err.message || String(err)) }, 500);
  }
};

// ─── Prompts ────────────────────────────────────────────────────────────────

function buildPrompt({ name, gender, baziInfo: b }) {
  return `命主：${name}，${gender}
四柱：${b.yearGan}${b.yearZhi} ${b.monthGan}${b.monthZhi} ${b.dayGan}${b.dayZhi} ${b.timeGan}${b.timeZhi}
纳音：${b.yearNaYin} / ${b.monthNaYin} / ${b.dayNaYin} / ${b.timeNaYin}
农历：${b.lunarYear}${b.lunarMonth}${b.lunarDay}

请用老友聊天的语气，依次输出以下四段，每段 2-3 句实质性结论，不要引用格式说明：

## 【性格特质】
（写命主真实的性格）

## 【事业走向】
（写命主事业的具体特征与建议）

## 【感情缘分】
（写感情运势与建议）

## 【健康提示】
（写需要注意的健康方向）

## 【签文】
（一句七言押韵，格式：XXXX，XXXX。）`;
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
  return { ben, hu, bian, relationInfo, elementLine };
}

function buildMeihuaPrompt({ question, hexagramData: h, outerResponse }) {
  const ctx = buildMeihuaBackgroundContext(h);
  const timeFactor = outerResponse?.timeFactor || {};
  const dirFactor = outerResponse?.directionFactor || {};
  return `问题：${question}

卦象：本卦${ctx.ben.name}，互卦${ctx.hu.name}，变卦${ctx.bian.name}，动爻第${h.movingLine || '-'}爻
体用：${ctx.elementLine}，${ctx.relationInfo.status}，${ctx.relationInfo.desc}
外应：农历${timeFactor.lunarMonthDay || '未知'} ${timeFactor.hourZhi || '未知'}时，方位${dirFactor.direction || '未知'}

请作为梅花易数专家，直接输出以下四段结论，每段内容具体、犀利：

## 【卦象解码】
（用本卦说现状，互卦说过程，变卦说走向，各一句，引用卦辞原文关键词）

## 【外应分析】
（说明贵人五行属性、阻力属性，给一句具体行动建议）

## 【过程推演】
（列2条中期具体预警，每条一句话，直接说会发生什么）

## 【结局定断】
（最终走向一句判断，然后3条行动：触发条件 → 你的动作 → 预期结果）`;
}

// ─── AI Call ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是命理师，只输出结论卡片，绝对禁止推理过程。
每个模块直接写 2-3 句结论，不得出现：计算、验证、修正、等等、推算、干支、节气等计算词汇。`;

// 服务端二次过滤：清除任何泄漏的推理行
function stripReasoning(text) {
  const REASONING_PATTERNS = [
    /^[*＊•]\s*[\*＊]?修正[:：]/m,
    /^[*＊•]\s*让我(们)?(重新)?(计算|验证|看看)/m,
    /^[*＊•]\s*(验证|检查|校验|推算|推导|计算)/m,
    /等等[，,。.]/,
    /\*\*修正[:：]/,
    /实际上[，,]/,
    /重新计算/,
    /关键检查/,
    /月干顺序/,
    /标准的月柱/,
    /节气是/,
    /让我们看看/,
  ];

  const lines = text.split('\n');
  const cleaned = [];
  let skipBlock = false;

  for (const line of lines) {
    const t = line.trim();
    // 遇到推理标志行，跳过直到下一个 ## 标题
    if (REASONING_PATTERNS.some(p => p.test(t))) {
      skipBlock = true;
      continue;
    }
    // 遇到新的 ## 标题，停止跳过
    if (/^##\s*【/.test(t)) skipBlock = false;
    if (!skipBlock) cleaned.push(line);
  }

  return cleaned.join('\n');
}

async function callZhipu(prompt) {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) throw new Error('未配置环境变量 ZHIPU_API_KEY');

  const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'glm-4-flash',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
      max_tokens: 1200,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`智谱接口异常(${resp.status})：${text}`);
  }

  const json = await resp.json();
  const message = json?.choices?.[0]?.message;
  const raw = (message?.content || message?.reasoning_content || '').trim();
  if (!raw) {
    console.error('[callZhipu] 响应结构异常：', JSON.stringify(json));
    throw new Error('智谱 API 返回异常：缺少内容');
  }
  return stripReasoning(raw);
}
