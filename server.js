#!/usr/bin/env node
/* Otaku Archive — server cục bộ, lưu ảnh thẳng vào thư mục.
   Chạy:  node server.js   rồi mở  http://localhost:3000
   Không cần cài thêm gói nào (chỉ dùng module có sẵn của Node). */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LIB  = path.resolve(process.env.LIBRARY_DIR || path.join(ROOT, 'library'));
const DIRS = { images: path.join(LIB, 'images'), thumbs: path.join(LIB, 'thumbs') };
const DATA = path.join(LIB, 'data.json');
const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';          // chỉ máy này truy cập được
const MAX_BODY = 60 * 1024 * 1024; // 60 MB mỗi lần ghi

fs.mkdirSync(DIRS.images, { recursive: true });
fs.mkdirSync(DIRS.thumbs, { recursive: true });

const idOk = s => /^[a-z0-9]{4,40}$/.test(s);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Dữ liệu quá lớn')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj));

function writeAtomic(file, buf) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

/* Dọn file ảnh không còn được tham chiếu.
   Chỉ xoá sau khi mồ côi liên tục > 60 giây, để nút "Hoàn tác" luôn hoạt động. */
const orphans = new Map();
let gcTimer = null;
function gc() {
  let referenced = new Set();
  try {
    const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    referenced = new Set((d.photos || []).map(p => p.id));
  } catch (e) { return; }               // chưa có dữ liệu thì không dọn gì
  const now = Date.now();
  const seen = new Set();
  for (const dir of Object.values(DIRS)) {
    for (const name of fs.readdirSync(dir)) {
      const id = name.replace(/\.jpg$/, '');
      if (!idOk(id)) continue;
      if (referenced.has(id)) { orphans.delete(id); continue; }
      seen.add(id);
      if (!orphans.has(id)) { orphans.set(id, now); continue; }
      if (now - orphans.get(id) > 60000) {
        for (const d of Object.values(DIRS)) { try { fs.unlinkSync(path.join(d, id + '.jpg')); } catch (e) {} }
        orphans.delete(id);
      }
    }
  }
  for (const id of [...orphans.keys()]) if (!seen.has(id)) orphans.delete(id);
}
function scheduleGc() { clearTimeout(gcTimer); gcTimer = setTimeout(gc, 65000); }

const server = http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host || '').split(':')[0];
    if (host !== 'localhost' && host !== '127.0.0.1') return send(res, 403, 'Forbidden', 'text/plain');
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/api/info') return json(res, 200, { dir: LIB });

    if (p === '/api/state') {
      if (req.method === 'GET') {
        return send(res, 200, fs.existsSync(DATA) ? fs.readFileSync(DATA) : 'null');
      }
      if (req.method === 'PUT') {
        const d = JSON.parse((await readBody(req)).toString('utf8'));
        if (!Array.isArray(d.series) || !Array.isArray(d.chars) || !Array.isArray(d.photos)) throw new Error('Dữ liệu không hợp lệ');
        writeAtomic(DATA, Buffer.from(JSON.stringify(d, null, 1)));
        scheduleGc();
        return json(res, 200, { ok: true });
      }
    }

    let m = p.match(/^\/api\/img\/(images|thumbs)\/([a-z0-9]+)$/);
    if (m && req.method === 'PUT') {
      if (!idOk(m[2])) return json(res, 400, { error: 'id không hợp lệ' });
      const buf = await readBody(req);
      if (!buf.length) return json(res, 400, { error: 'Ảnh rỗng' });
      writeAtomic(path.join(DIRS[m[1]], m[2] + '.jpg'), buf);
      return json(res, 200, { ok: true });
    }

    m = p.match(/^\/library\/(images|thumbs)\/([a-z0-9]+)\.jpg$/);
    if (m && req.method === 'GET') {
      const file = path.join(DIRS[m[1]], m[2] + '.jpg');
      if (!fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
      return fs.createReadStream(file).pipe(res);
    }
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('\n  Otaku Archive đang chạy');
  console.log('  Mở trình duyệt:  http://localhost:' + PORT);
  console.log('  Ảnh được lưu tại: ' + LIB + '\n');
  scheduleGc();
});