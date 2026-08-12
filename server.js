/**
 * ═══════════════════════════════════════════════════════════════
 *  AI 工具大全 — 后端服务（生产级）
 *  零外部依赖，仅用 Node.js 内置模块（http/fs/path/crypto/zlib）
 * ═══════════════════════════════════════════════════════════════
 *
 * 能力清单：
 *   🔒 安全：安全响应头、简单限流、输入校验、请求体大小限制、路径穿越防护
 *   💾 数据：原子写入（tmp+rename）、内存缓存 + 防抖落盘、启动自动备份
 *   🚀 性能：ETag 缓存 + 条件请求、gzip 压缩、静态文件缓存头
 *   📊 可观测：请求日志、访问统计（独立访客/热门工具）
 *   🔌 API：收藏/浏览 CRUD、服务端搜索、健康检查
 *   🛑 优雅关闭：SIGINT/SIGTERM 时 flush 待写数据
 *
 *  启动：node server.js   （默认 http://localhost:3000）
 * ═══════════════════════════════════════════════════════════════
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

/* ═══════════════════ 配置（可通过环境变量覆盖） ═══════════════════ */
const CONFIG = {
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',
  // 限流：每个 IP 每分钟最多请求数
  rateLimitWindowMs: 60 * 1000,
  rateLimitMaxRequests: 300,
  // 请求体大小上限
  maxBodyBytes: 1 * 1024 * 1024,
  // 收藏/浏览记录最大条目数
  maxFavorites: 500,
  maxRecent: 50,
  // 防抖落盘延迟
  writeDebounceMs: 500,
  // 是否开启 gzip 压缩
  gzipEnabled: true,
  // 数据备份数量
  maxBackups: 5,
};

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

/* ═══════════════════ 日志工具 ═══════════════════ */
const colors = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};
const useColor = process.stdout.isTTY;

function paint(text, color) {
  return useColor ? colors[color] + text + colors.reset : text;
}

function log(method, path, status, ms, extra = '') {
  const statusColor = status >= 500 ? 'red' : status >= 400 ? 'yellow' : status >= 300 ? 'cyan' : 'green';
  const time = new Date().toISOString().slice(11, 19);
  const parts = [
    paint(time, 'dim'),
    paint(method.padEnd(6), 'blue'),
    paint(String(status), statusColor),
    paint(ms + 'ms', 'dim'),
    path,
  ];
  if (extra) parts.push(paint(extra, 'magenta'));
  console.log(parts.join(' '));
}

/* ═══════════════════ 数据层（原子写入 + 防抖 + 备份） ═══════════════════ */
function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function defaultData() {
  return {
    // 按设备 ID 隔离的每用户数据
    users: {},
    // 全局统计（不涉及个人数据）
    stats: {
      visits: 0,
      uniqueVisitors: 0,
      visitorIPs: [],
      lastVisit: null,
      popularTools: {},
    },
  };
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return defaultData();
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const data = defaultData();
    // 旧格式迁移：{ favorites, recent, stats } → { users: { legacy: {...} }, stats }
    if (parsed.users && typeof parsed.users === 'object') {
      data.users = parsed.users;
    } else if (Array.isArray(parsed.favorites) || Array.isArray(parsed.recent)) {
      // 旧格式，迁移到 legacy 用户
      data.users = {
        legacy: {
          favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
          recent: Array.isArray(parsed.recent) ? parsed.recent : [],
        },
      };
      console.log(paint('[数据层] 检测到旧格式数据，已迁移到设备隔离结构', 'yellow'));
    }
    if (parsed.stats && typeof parsed.stats === 'object') {
      Object.assign(data.stats, parsed.stats);
      if (!Array.isArray(data.stats.visitorIPs)) data.stats.visitorIPs = [];
      if (typeof data.stats.popularTools !== 'object') data.stats.popularTools = {};
    }
    return data;
  } catch (e) {
    console.error(paint('[数据层] 读取失败，尝试从备份恢复', 'red'), e.message);
    return restoreFromBackup() || defaultData();
  }
}

function restoreFromBackup() {
  try {
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('store-') && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const backup of backups) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, backup), 'utf8'));
        console.log(paint(`[数据层] 已从备份 ${backup} 恢复`, 'yellow'));
        return data;
      } catch (e) { /* 尝试下一个备份 */ }
    }
  } catch (e) { /* 备份目录不存在 */ }
  return null;
}

function backupData() {
  try {
    ensureDirs();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_DIR, `store-${stamp}.json`);
    if (fs.existsSync(DATA_FILE)) {
      fs.copyFileSync(DATA_FILE, backupFile);
      // 清理旧备份
      const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('store-')).sort();
      while (backups.length > CONFIG.maxBackups) {
        fs.unlinkSync(path.join(BACKUP_DIR, backups.shift()));
      }
    }
  } catch (e) {
    console.error(paint('[数据层] 备份失败', 'red'), e.message);
  }
}

/* 原子写入：先写临时文件，再 rename 覆盖，避免写一半崩溃导致数据损坏 */
function atomicWrite(filePath, data) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/* 内存缓存 + 防抖落盘 */
let cache = loadData();
let dirty = false;
let writeTimer = null;

function scheduleWrite() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      atomicWrite(DATA_FILE, cache);
    } catch (e) {
      console.error(paint('[数据层] 写入失败', 'red'), e.message);
      dirty = true; // 标记重新尝试
    }
  }, CONFIG.writeDebounceMs);
}

function flushNow() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (dirty) {
    dirty = false;
    try { atomicWrite(DATA_FILE, cache); } catch (e) { console.error(paint('[数据层] flush 失败', 'red'), e.message); }
  }
}

/* ═══════════════════ 限流（简单滑动窗口，按 IP） ═══════════════════ */
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  let record = rateLimitMap.get(ip);
  if (!record || now - record.windowStart > CONFIG.rateLimitWindowMs) {
    record = { windowStart: now, count: 0 };
    rateLimitMap.set(ip, record);
  }
  record.count++;
  return record.count > CONFIG.rateLimitMaxRequests;
}
// 定期清理限流表，防止内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap) {
    if (now - record.windowStart > CONFIG.rateLimitWindowMs * 2) rateLimitMap.delete(ip);
  }
}, CONFIG.rateLimitWindowMs).unref();

/* ═══════════════════ 工具函数 ═══════════════════ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function sendJSON(res, status, obj, req) {
  const body = JSON.stringify(obj);
  sendWithBody(res, status, body, 'application/json; charset=utf-8', req);
}

function sendWithBody(res, status, body, contentType, req) {
  const headers = {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
    ...SECURITY_HEADERS,
  };
  let payload = body;
  // gzip 压缩（仅当客户端支持且内容足够大）
  const acceptEncoding = req?.headers?.['accept-encoding'] || '';
  if (CONFIG.gzipEnabled && typeof body === 'string' && body.length > 1024 && acceptEncoding.includes('gzip')) {
    payload = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = Buffer.byteLength(payload);
  res.writeHead(status, headers);
  res.end(payload);
}

function readBody(req, limit = CONFIG.maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', () => reject(new Error('BODY_READ_ERROR')));
  });
}

function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown';
}

/* 输入校验：收藏/浏览记录必须是字符串数组且不超限 */
function sanitizeStringArray(arr, maxLen) {
  if (!Array.isArray(arr)) return null;
  return arr.filter(x => typeof x === 'string' && x.length > 0 && x.length <= 200).slice(0, maxLen);
}

/* 设备 ID 校验：只允许 UUID 风格的字符，长度 8~64，防注入任意 key */
function sanitizeDeviceId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(trimmed)) return null;
  return trimmed;
}

/* 获取指定设备的数据，不存在则创建空结构 */
function getUserData(deviceId) {
  if (!cache.users[deviceId]) {
    cache.users[deviceId] = { favorites: [], recent: [] };
  }
  if (!Array.isArray(cache.users[deviceId].favorites)) cache.users[deviceId].favorites = [];
  if (!Array.isArray(cache.users[deviceId].recent)) cache.users[deviceId].recent = [];
  return cache.users[deviceId];
}

/* ═══════════════════ API 路由 ═══════════════════ */
async function handleApi(req, res, pathname, ip) {
  const method = req.method;

  // 健康检查
  if (pathname === '/api/health') {
    return sendJSON(res, 200, {
      status: 'ok',
      service: 'ai-tools-backend',
      version: '2.0.0',
      uptime: Math.floor(process.uptime()),
      time: new Date().toISOString(),
    }, req);
  }

  // 收藏 - 列表（按设备隔离）
  if (pathname === '/api/favorites') {
    if (method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const deviceId = sanitizeDeviceId(url.searchParams.get('device') || '');
      if (!deviceId) return sendJSON(res, 400, { error: '缺少或非法的 device 参数' }, req);
      const user = getUserData(deviceId);
      return sendJSON(res, 200, { favorites: user.favorites }, req);
    }
    if (method === 'POST' || method === 'PUT') {
      const body = await readBody(req);
      const deviceId = sanitizeDeviceId(body.device);
      if (!deviceId) return sendJSON(res, 400, { error: '缺少或非法的 device 参数' }, req);
      const favs = sanitizeStringArray(body.favorites, CONFIG.maxFavorites);
      if (favs === null) return sendJSON(res, 400, { error: 'favorites 必须是字符串数组' }, req);
      const user = getUserData(deviceId);
      user.favorites = favs;
      scheduleWrite();
      return sendJSON(res, 200, { ok: true, count: user.favorites.length }, req);
    }
  }

  // 收藏 - 单项操作（按设备隔离）
  if (pathname === '/api/favorites/toggle') {
    if (method === 'POST') {
      const body = await readBody(req);
      const deviceId = sanitizeDeviceId(body.device);
      if (!deviceId) return sendJSON(res, 400, { error: '缺少或非法的 device 参数' }, req);
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) return sendJSON(res, 400, { error: '缺少 id' }, req);
      const user = getUserData(deviceId);
      const idx = user.favorites.indexOf(id);
      let added = false;
      if (idx > -1) { user.favorites.splice(idx, 1); }
      else { user.favorites.push(id); added = true; }
      if (user.favorites.length > CONFIG.maxFavorites) user.favorites = user.favorites.slice(-CONFIG.maxFavorites);
      scheduleWrite();
      return sendJSON(res, 200, { ok: true, added, count: user.favorites.length }, req);
    }
  }

  // 最近浏览 - 列表（按设备隔离）
  if (pathname === '/api/recent') {
    if (method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const deviceId = sanitizeDeviceId(url.searchParams.get('device') || '');
      if (!deviceId) return sendJSON(res, 400, { error: '缺少或非法的 device 参数' }, req);
      const user = getUserData(deviceId);
      return sendJSON(res, 200, { recent: user.recent }, req);
    }
    if (method === 'POST' || method === 'PUT') {
      const body = await readBody(req);
      const deviceId = sanitizeDeviceId(body.device);
      if (!deviceId) return sendJSON(res, 400, { error: '缺少或非法的 device 参数' }, req);
      const recent = sanitizeStringArray(
        Array.isArray(body.recent) ? body.recent : body.recent?.map?.(r => r.id),
        CONFIG.maxRecent
      );
      if (recent === null) return sendJSON(res, 400, { error: 'recent 数据格式错误' }, req);
      const user = getUserData(deviceId);
      user.recent = recent;
      scheduleWrite();
      return sendJSON(res, 200, { ok: true, count: user.recent.length }, req);
    }
  }

  // 访问统计
  if (pathname === '/api/stats') {
    if (method === 'GET') {
      return sendJSON(res, 200, {
        visits: cache.stats.visits,
        uniqueVisitors: cache.stats.uniqueVisitors,
        lastVisit: cache.stats.lastVisit,
        popularTools: Object.entries(cache.stats.popularTools || {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([id, count]) => ({ id, count })),
      }, req);
    }
    if (method === 'POST') {
      cache.stats.visits = (cache.stats.visits || 0) + 1;
      cache.stats.lastVisit = new Date().toISOString();
      if (!cache.stats.visitorIPs) cache.stats.visitorIPs = [];
      if (!cache.stats.visitorIPs.includes(ip)) {
        cache.stats.visitorIPs.push(ip);
        cache.stats.uniqueVisitors = cache.stats.visitorIPs.length;
      }
      // 记录工具点击热度（body 里可传 toolId）
      const body = await readBody(req).catch(() => ({}));
      if (body.toolId && typeof body.toolId === 'string') {
        if (!cache.stats.popularTools) cache.stats.popularTools = {};
        cache.stats.popularTools[body.toolId] = (cache.stats.popularTools[body.toolId] || 0) + 1;
      }
      scheduleWrite();
      return sendJSON(res, 200, {
        visits: cache.stats.visits,
        uniqueVisitors: cache.stats.uniqueVisitors,
      }, req);
    }
  }

  // 服务端搜索（供未来扩展，前端暂用客户端搜索）
  if (pathname === '/api/search') {
    if (method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (!q) return sendJSON(res, 400, { error: '缺少 q 参数' }, req);
      return sendJSON(res, 200, { query: q, note: '服务端搜索暂未接入数据，前端使用客户端即时搜索' }, req);
    }
  }

  return sendJSON(res, 404, { error: 'Not Found', path: pathname }, req);
}

/* ═══════════════════ 静态文件服务（ETag + 条件请求 + gzip） ═══════════════════ */
function serveStatic(req, res, pathname) {
  let filePath;
  if (pathname === '/' || pathname === '') {
    filePath = path.join(ROOT, 'index.html');
  } else {
    // 路径穿越防护
    const normalized = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    filePath = path.join(ROOT, normalized);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403, { ...SECURITY_HEADERS }); res.end('Forbidden'); return;
    }
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      res.end('<h1>404 Not Found</h1>');
      return;
    }
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    // 生成 ETag（基于文件大小 + 修改时间）
    const etag = `"${crypto.createHash('md5').update(`${stat.size}-${stat.mtimeMs}`).digest('hex').slice(0, 16)}"`;

    // 条件请求：If-None-Match 命中则返回 304
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'ETag': etag, ...SECURITY_HEADERS });
      res.end();
      return;
    }

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { ...SECURITY_HEADERS }); res.end('Server Error'); return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      const headers = {
        'Content-Type': contentType,
        'ETag': etag,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
        ...SECURITY_HEADERS,
      };

      let payload = content;
      const acceptEncoding = req.headers['accept-encoding'] || '';
      if (CONFIG.gzipEnabled && content.length > 1024 && acceptEncoding.includes('gzip') && contentType.startsWith('text')) {
        payload = zlib.gzipSync(content);
        headers['Content-Encoding'] = 'gzip';
      }
      headers['Content-Length'] = payload.length;
      res.writeHead(200, headers);
      res.end(payload);
    });
  });
}

/* ═══════════════════ HTTP 服务器 ═══════════════════ */
const server = http.createServer(async (req, res) => {
  const startTime = process.hrtime.bigint();
  const ip = getClientIP(req);
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    res.writeHead(400, { ...SECURITY_HEADERS }); res.end('Bad Request'); return;
  }
  const pathname = decodeURIComponent(url.pathname);

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  // 限流
  if (isRateLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    res.end(JSON.stringify({ error: 'Too Many Requests', retryAfter: CONFIG.rateLimitWindowMs / 1000 }));
    log(req.method, pathname, 429, 0, 'rate-limited');
    return;
  }

  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, ip);
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (e) {
    const status = e.message === 'PAYLOAD_TOO_LARGE' ? 413
      : e.message === 'INVALID_JSON' ? 400 : 500;
    sendJSON(res, status, { error: e.message === 'PAYLOAD_TOO_LARGE' ? '请求体过大' : '服务器内部错误' }, req);
  }

  // 请求日志
  const ms = Number(process.hrtime.bigint() - startTime) / 1e6;
  res.on('finish', () => {
    log(req.method, pathname, res.statusCode, ms.toFixed(1));
  });
});

/* ═══════════════════ 优雅关闭 ═══════════════════ */
function shutdown(signal) {
  console.log(paint(`\n[服务器] 收到 ${signal}，正在优雅关闭…`, 'yellow'));
  flushNow(); // 立即落盘待写数据
  server.close(() => {
    console.log(paint('[服务器] 数据已保存，进程退出', 'green'));
    process.exit(0);
  });
  // 强制退出兜底
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/* ═══════════════════ 启动 ═══════════════════ */
ensureDirs();
backupData(); // 启动时备份现有数据

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log('');
  console.log(paint('  ══════════════════════════════════════════', 'cyan'));
  console.log(paint('   🌐 AI 工具大全 — 后端服务 v2.0', 'bold'));
  console.log(paint('  ══════════════════════════════════════════', 'cyan'));
  console.log(`  ➜ 本地访问:   ${paint('http://localhost:' + CONFIG.port, 'green')}`);
  console.log(`  ➜ 局域网访问: ${paint('http://' + CONFIG.host + ':' + CONFIG.port, 'green')}`);
  console.log(`  ➜ 数据文件:   ${paint(DATA_FILE, 'dim')}`);
  console.log(`  ➜ API 前缀:   ${paint('/api/', 'blue')}`);
  console.log(paint('  ──────────────────────────────────────────', 'cyan'));
  console.log(`  🔒 安全: 限流(${CONFIG.rateLimitMaxRequests}/min) 请求体限制(${CONFIG.maxBodyBytes / 1024}KB) 安全头`);
  console.log(`  💾 数据: 原子写入 + 防抖(${CONFIG.writeDebounceMs}ms) + 启动备份(${CONFIG.maxBackups}份)`);
  console.log(`  🚀 性能: ETag缓存 + gzip压缩`);
  console.log(paint('  ══════════════════════════════════════════', 'cyan'));
  console.log('');
});
