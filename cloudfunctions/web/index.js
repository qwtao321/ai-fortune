'use strict';

/**
 * 云函数：web
 * ─────────────────────────────────────────────────────────────────
 * 功能：通过 HTTP 触发器直接返回 index.html 页面内容
 *
 * HTTP 访问地址（需在 TCB 控制台创建触发路径）：
 *   路径 /web → 返回网页 HTML
 * ─────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

exports.main = async (event) => {
  /* 处理 GET / HEAD 请求 */
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Method Not Allowed',
    };
  }

  const reqPath = (event.path || event.requestContext?.path || '/web').toLowerCase();
  let fileName = 'index.html';
  let contentType = 'text/html; charset=utf-8';
  if (reqPath.endsWith('/guadict.js') || reqPath.endsWith('/guadict')) {
    fileName = 'guaDict.js';
    contentType = 'application/javascript; charset=utf-8';
  } else if (reqPath.endsWith('/fiveelementslogic.js') || reqPath.endsWith('/fiveelementslogic')) {
    fileName = 'fiveElementsLogic.js';
    contentType = 'application/javascript; charset=utf-8';
  }
  const content = fs.readFileSync(path.join(__dirname, fileName), 'utf-8');

  return {
    statusCode: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    },
    body: content,
  };
};
