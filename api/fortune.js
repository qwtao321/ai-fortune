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
  const currentYear = new Date().getFullYear();
  return `命主：${name}，${gender}
四柱：${b.yearGan}${b.yearZhi}（${b.yearNaYin}·${b.yearWuXing}） ${b.monthGan}${b.monthZhi}（${b.monthNaYin}·${b.monthWuXing}） ${b.dayGan}${b.dayZhi}（${b.dayNaYin}·${b.dayWuXing}） ${b.timeGan}${b.timeZhi}（${b.timeNaYin}·${b.timeWuXing}）
农历：${b.lunarYear}${b.lunarMonth}${b.lunarDay}
当前年份：${currentYear}年

你是资深命理师，用老友聊天的语气输出以下五段。每段必须点名具体干支作为依据，禁止推理过程。

## 【原局格局】
3-4句。从日柱、月柱分析性格天赋和一生最高成就上限，点名具体干支纳音。

## 【当前大运】
必须包含以下三点，每点一句：
1. 当前所处大运的干支名称和大致年份区间
2. 这段大运的核心主题（用一个词概括，如"破局期"/"积累期"/"收获期"）
3. **转折点**：明确指出这10年内哪一年（或哪个时间节点）是命运走向改变的关键转折，说明转折方向（向上/向下/质变）以及应对策略

## 【近三年走势】
按年份输出，每年2句：关键词 + 具体建议或风险。
**${currentYear}年**：
**${currentYear + 1}年**：
**${currentYear + 2}年**：

## 【方位建议】
结合当前大运和流年，给出办公/居住朝向建议，注明五行补救逻辑，1-2句。

## 【签文】
一句七言押韵签文，格式：XXXX，XXXX。

---
最后单独输出以下JSON块（不要放在任何段落内，直接写在最后）：
\`\`\`trendData
{"years":[${Array.from({length:10},(_,i)=>currentYear+i).join(',')}],"career":[0,0,0,0,0,0,0,0,0,0],"wealth":[0,0,0,0,0,0,0,0,0,0],"overall":[0,0,0,0,0,0,0,0,0,0]}
\`\`\`
请将上面JSON中的0替换为你基于五行旺衰推算的实际数值（0-100），不要解释数值来源。`;
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

【卦象数据】
本卦：${ctx.ben.name} — ${ctx.ben.guaci}
互卦：${ctx.hu.name} — ${ctx.hu.guaci}
变卦：${ctx.bian.name} — ${ctx.bian.guaci}
动爻：第${h.movingLine || '-'}爻
体用：${ctx.elementLine}
生克：${ctx.relationInfo.status} — ${ctx.relationInfo.desc}
气场：${ctx.relationInfo.vibe}
外应时间：农历${timeFactor.lunarMonthDay || '未知'} ${timeFactor.hourZhi || '未知'}时 季节${timeFactor.seasonWuxing || '未知'}
外应方位：${dirFactor.direction || '未知'}

你是梅花易数专家，直接输出以下四段结论。
每段结论必须点名具体卦名（如"${ctx.ben.name}卦象征…"）或体用关系作为依据，让用户感受到是针对这组卦象的分析，而非泛泛而谈。
每段 3-4 句，禁止推理过程。

## 【卦象解码】
结合本卦卦义说当前处境，引用互卦说中期变化，引用变卦说最终走向，每卦各点名一次。

## 【外应分析】
指出贵人五行属性和阻力属性，结合外应时间与方位给出一句具体行动建议。

## 【过程推演】
基于体用生克关系列出 2 条具体预警，直接说会出现什么情况，各一句。

## 【结局定断】
给出最终走向判断，附 3 条行动建议，格式：触发条件 → 你的动作 → 预期结果。`;
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
      max_tokens: 1600,
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
