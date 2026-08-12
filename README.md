# 🌐 2026 AI 工具大全 | AI Tools Collection

一个全栈 AI 工具导航网站，包含 **前端 + 后端 + 数据持久化**。

## ✨ 功能特性

- **前端**：34 个分类、200+ 工具条目，中英双语、深色/浅色主题、搜索、筛选、排序、收藏、分享
- **后端**：Node.js 零依赖 HTTP 服务（仅用内置 `http`/`fs`/`path` 模块）
- **数据持久化**：收藏和浏览记录存储到 `data/store.json`（后端优先，localStorage 兜底）

## 🚀 本地运行

```bash
# 1. 进入项目目录
cd AI-Tools

# 2. 启动后端服务（零依赖，无需 npm install）
node server.js

# 3. 打开浏览器访问
#    http://localhost:3000
```

也可以使用 npm：

```bash
npm start
```

## 📁 项目结构

```
AI-Tools/
├── index.html       # 前端（单文件，含 CSS + JS）
├── server.js        # 后端服务（零依赖 Node.js HTTP 服务器）
├── package.json     # npm 配置
├── data/            # 数据目录（自动创建）
│   └── store.json   # 持久化数据（收藏 + 浏览记录 + 访问统计）
├── CNAME            # 自定义域名配置
└── .nojekyll        # GitHub Pages 配置
```

## 🔌 API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/favorites` | 获取收藏列表 |
| POST | `/api/favorites` | 保存收藏列表 `{favorites: [...]}` |
| GET | `/api/recent` | 获取最近浏览 |
| POST | `/api/recent` | 保存最近浏览 `{recent: [...]}` |
| GET | `/api/stats` | 获取访问统计 |
| POST | `/api/stats` | 记录一次访问 |

## 🌍 部署

- **GitHub Pages（纯前端）**：直接使用 `index.html`，数据保存在浏览器 localStorage
- **自托管（全栈）**：运行 `node server.js`，数据持久化到服务器 `data/store.json`
- **云平台**：可部署到 Railway / Render / Vercel（需配置 Node.js）

## 📄 许可

MIT License
