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
  return { ben, hu, bian, relationInfo, elementLine };
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
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.85,
      max_tokens: 800,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`智谱接口异常(${resp.status})：${text}`);
  }

  const json = await resp.json();
  const content = json?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('智谱 API 返回异常：缺少内容');
  return content;
}
