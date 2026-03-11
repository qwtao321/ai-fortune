# 云函数对接完整指南

## 总览

```
前端 index.html
  └─ @cloudbase/js-sdk
       └─ 调用云函数 fortune
            ├─ 查/扣 TCB 数据库 api_keys
            └─ 调用 智谱 GLM-4 API
```

---

## 第一步：TCB 控制台前置设置

### 1.1 开启匿名登录

> 控制台 → 云开发 → 你的环境 → 登录授权 → **匿名登录** → 开启

前端用 `anonymousAuthProvider().signIn()` 登录，必须在此开启。

### 1.2 创建数据库集合 `api_keys`

> 控制台 → 数据库 → 添加集合 → 名称填 `api_keys`

手动插入一条测试文档（点击"添加记录"）：

```json
{
  "key":     "TEST-KEY-0001",
  "credits": 100,
  "remark":  "测试账户"
}
```

**字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | string | 用户输入的 API Key（自定义，唯一） |
| `credits` | number | 剩余积分，每次测算 -1 |
| `remark` | string | 备注（可选） |

### 1.3 设置数据库权限

> 点击集合 `api_keys` → 权限设置 → 选择 **自定义安全规则**

填入以下规则（只允许云函数读写，前端不可直接操作）：

```json
{
  "read": false,
  "write": false
}
```

云函数内部调用使用管理员权限，不受此限制。

---

## 第二步：获取智谱 AI API Key

1. 注册登录 [https://open.bigmodel.cn/](https://open.bigmodel.cn/)
2. 控制台 → API Keys → **创建 API Key**
3. 复制保存（格式类似 `xxxxxxxx.xxxxxxxxxxxxxxxx`）

**模型选择建议：**

| 模型 | 效果 | 费用 |
|------|------|------|
| `glm-4-flash` | 够用，响应快 | 免费额度内免费 |
| `glm-4` | 更好 | 约 ¥0.1/千 token |
| `glm-4-plus` | 最佳 | 约 ¥0.2/千 token |

---

## 第三步：部署云函数

### 方式 A：控制台直接粘贴（推荐新手）

1. 控制台 → **云函数** → **新建云函数**
2. 函数名：`fortune`，运行环境：`Nodejs 18`
3. 创建后点击函数名 → **函数代码** → 在线编辑器
4. 将 `cloudfunctions/fortune/index.js` 的内容**完整粘贴**进去
5. 点击**保存并部署**

### 方式 B：CloudBase CLI 上传（推荐有 Node.js 环境）

```bash
# 安装 CLI
npm install -g @cloudbase/cli

# 登录（会打开浏览器扫码）
tcb login

# 在项目根目录执行
tcb fn deploy fortune --env 你的环境ID
```

---

## 第四步：配置环境变量

> 控制台 → 云函数 → fortune → **函数配置** → 环境变量

| 变量名 | 值 |
|--------|----|
| `ZHIPU_API_KEY` | 你在第二步获取的智谱 API Key |

**重要**：配置完成后需要点击**保存**，并重新**部署**一次函数才能生效。

---

## 第五步：测试云函数

> 控制台 → 云函数 → fortune → **函数测试**

粘贴以下测试参数：

```json
{
  "apiKey": "TEST-KEY-0001",
  "name": "张三",
  "gender": "男",
  "baziInfo": {
    "yearGan": "庚", "yearZhi": "午",
    "monthGan": "戊", "monthZhi": "申",
    "dayGan": "甲", "dayZhi": "子",
    "timeGan": "壬", "timeZhi": "午",
    "yearNaYin": "路旁土", "monthNaYin": "大驿土",
    "dayNaYin": "海中金", "timeNaYin": "杨柳木",
    "yearWuXing": "金火", "monthWuXing": "土金",
    "dayWuXing": "木水", "timeWuXing": "水火",
    "lunarYear": "一九九〇年", "lunarMonth": "七月", "lunarDay": "初一",
    "solarDate": "1990-08-21"
  }
}
```

**期望返回：**
```json
{
  "code": 0,
  "data": { "result": "..." }
}
```

---

## 第六步：配置前端并上线

### 6.1 获取你的环境 ID

> 控制台 → 云开发 → 环境总览 → **环境 ID**（格式：`your-env-xxxx`）

### 6.2 打开网页设置

1. 用浏览器打开 `index.html`（或部署到 TCB 静态托管后访问）
2. 点击右下角 **⚙** 按钮
3. 填入 **环境 ID** 和你在数据库里创建的 **API Key**（如 `TEST-KEY-0001`）
4. 点击**保存设置**

### 6.3 部署到 TCB 静态托管（可选）

```bash
tcb hosting deploy index.html -e 你的环境ID
```

访问地址：`https://你的环境ID.tcloudbaseapp.com/index.html`

---

## 常见问题

**Q：前端报"腾讯云 JS SDK 未加载"**
> 检查网络能否访问 `cdn.jsdelivr.net`，必要时换国内 CDN 镜像。

**Q：报错 `LOGIN_FAILED` 或 `ANONYMOUS_NOT_ALLOWED`**
> 回到第一步 1.1，确认已在控制台开启**匿名登录**。

**Q：云函数报"未配置环境变量 ZHIPU_API_KEY"**
> 确认已在函数配置里保存环境变量，并重新部署了函数。

**Q：想批量生成 API Key 卖给用户**
> 在数据库 `api_keys` 集合中批量插入文档即可，`key` 字段建议用 UUID 生成：
> ```js
> const { v4: uuidv4 } = require('uuid');
> const key = 'FM-' + uuidv4().replace(/-/g,'').substring(0,16).toUpperCase();
> // 例：FM-A3B9C2D1E4F5A6B7
> ```

---

## 文件目录结构

```
AI/
├── index.html                    ← 前端单文件（直接部署）
└── cloudfunctions/
    └── fortune/
        ├── index.js              ← 云函数主逻辑
        └── package.json          ← 依赖声明（当前无第三方依赖）
```
