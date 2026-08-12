/**
 * AI 工具大全 - 后端服务
 * 零依赖 Node.js 服务器（仅用内置 http/fs/path 模块）
 *
 * 功能：
 *   1. 静态文件服务（前端 index.html）
 *   2. REST API（收藏/浏览记录持久化到 JSON 文件）
 *   3. 访问统计
 *
 * 启动：node server.js  （默认 http://localhost:3000）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

// ─── 初始化数据目录 ───
function initData() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    const empty = { favorites: [], recent: [], stats: { visits: 0, lastVisit: null } };
    fs.writeFileSync(DATA_FILE, JSON.stringify(empty, null, 2), 'utf8');
  }
  return readData();
}

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { favorites: [], recent: [], stats: { visits: 0, lastVisit: null } };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ─── MIME 类型 ───
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// ─── 响应辅助 ───
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { resolve({}); }
    });
  });
}

// ─── API 路由 ───
async function handleApi(req, res, pathname) {
  const data = readData();
  const method = req.method;

  // 健康检查
  if (pathname === '/api/health') {
    return sendJSON(res, 200, { status: 'ok', service: 'ai-tools-backend', time: new Date().toISOString() });
  }

  // 收藏
  if (pathname === '/api/favorites') {
    if (method === 'GET') {
      return sendJSON(res, 200, { favorites: data.favorites || [] });
    }
    if (method === 'POST' || method === 'PUT') {
      const body = await readBody(req);
      data.favorites = Array.isArray(body.favorites) ? body.favorites : [];
      writeData(data);
      return sendJSON(res, 200, { ok: true, count: data.favorites.length });
    }
  }

  // 最近浏览
  if (pathname === '/api/recent') {
    if (method === 'GET') {
      return sendJSON(res, 200, { recent: data.recent || [] });
    }
    if (method === 'POST' || method === 'PUT') {
      const body = await readBody(req);
      data.recent = Array.isArray(body.recent) ? body.recent : [];
      writeData(data);
      return sendJSON(res, 200, { ok: true, count: data.recent.length });
    }
  }

  // 访问统计
  if (pathname === '/api/stats') {
    if (method === 'GET') {
      return sendJSON(res, 200, data.stats || { visits: 0 });
    }
    if (method === 'POST') {
      data.stats = data.stats || { visits: 0, lastVisit: null };
      data.stats.visits = (data.stats.visits || 0) + 1;
      data.stats.lastVisit = new Date().toISOString();
      writeData(data);
      return sendJSON(res, 200, data.stats);
    }
  }

  return sendJSON(res, 404, { error: 'Not Found', path: pathname });
}

// ─── 静态文件服务 ───
function serveStatic(res, pathname) {
  // 防止目录遍历
  let filePath = path.join(ROOT, path.normalize(pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (pathname === '/' || pathname === '') {
    filePath = path.join(ROOT, 'index.html');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>404 Not Found</h1>');
      } else {
        res.writeHead(500); res.end('Server Error');
      }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ─── 服务器 ───
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // API 路由
  if (pathname.startsWith('/api/')) {
    return handleApi(req, res, pathname);
  }

  // 静态文件
  return serveStatic(res, pathname);
});

initData();

server.listen(PORT, HOST, () => {
  console.log('==========================================');
  console.log('  🌐 AI 工具大全 后端服务已启动');
  console.log(`  ➜ 本地访问: http://localhost:${PORT}`);
  console.log(`  ➜ 局域网访问: http://${HOST}:${PORT}`);
  console.log('==========================================');
});
