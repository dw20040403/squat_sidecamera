// HTTPS配信とWSSシグナリング（spec 5.2.1）。同じポートで提供する

import { existsSync, readFileSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import qrcode from 'qrcode-terminal';
import { Room } from './signaling.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const WEB_DIST = join(ROOT, 'web', 'dist');
const CONFIG_DIR = join(ROOT, 'config');

interface Options {
  dev: boolean;
  http: boolean;
  port: number;
  host: string;
  certDir: string;
  qr: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    dev: false,
    http: false,
    port: Number(process.env.PORT ?? 8443),
    host: process.env.HOST ?? '0.0.0.0',
    certDir: process.env.CERT_DIR ?? join(ROOT, 'certs'),
    qr: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dev') o.dev = true;
    else if (a === '--http') o.http = true;
    else if (a === '--no-qr') o.qr = false;
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--host') o.host = argv[++i];
    else if (a === '--certs') o.certDir = resolve(argv[++i]);
  }
  return o;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** baseの下にあるファイルだけを返す（ディレクトリトラバーサル対策） */
function safeJoin(base: string, urlPath: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const full = normalize(join(base, p));
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

function sendFile(res: ServerResponse, file: string, cache = false): boolean {
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': statSync(file).size,
    'Cache-Control': cache ? 'public, max-age=3600' : 'no-cache',
  });
  createReadStream(file).pipe(res);
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(body));
}

/** /config/* と /api/* */
function handleApi(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/intrinsics') {
    const dir = join(CONFIG_DIR, 'intrinsics');
    const items = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => {
            try {
              const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
              return {
                file: f,
                deviceName: j.deviceName ?? f.replace(/\.json$/, ''),
                imageSize: j.imageSize,
                approximate: !!j.approximate,
                rms: j.rms,
              };
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      : [];
    sendJson(res, 200, items);
    return true;
  }
  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (url.pathname.startsWith('/config/')) {
    const file = safeJoin(CONFIG_DIR, url.pathname.slice('/config/'.length));
    if (!file || !sendFile(res, file)) sendJson(res, 404, { error: 'not-found' });
    return true;
  }
  return false;
}

function handleStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  let p = url.pathname;
  if (p === '/' || p === '') p = '/index.html';
  const file = safeJoin(WEB_DIST, p);
  if (file && sendFile(res, file, p.startsWith('/mediapipe/') || p.startsWith('/opencv/'))) return;
  if (file && existsSync(file + '.html') && sendFile(res, file + '.html')) return;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(
    existsSync(WEB_DIST) ? 'Not found' : 'web/dist がありません。先に npm run build を実行してください。',
  );
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const certFile = join(o.certDir, 'cert.pem');
  const keyFile = join(o.certDir, 'key.pem');
  let useHttps = !o.http;
  if (useHttps && (!existsSync(certFile) || !existsSync(keyFile))) {
    console.warn(`[server] 証明書が見つかりません（${certFile}）。HTTPで起動します。`);
    console.warn(
      '[server] iPhoneからカメラを使うにはHTTPSが必要です。npm run setup:certs を実行してください。',
    );
    useHttps = false;
  }

  let viteMiddleware: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | null = null;
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (handleApi(req, res)) return;
    if (viteMiddleware) {
      viteMiddleware(req, res, () => handleStatic(req, res));
      return;
    }
    handleStatic(req, res);
  };

  const server = useHttps
    ? createHttpsServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, handler)
    : createHttpServer(handler);

  if (o.dev) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      root: join(ROOT, 'web'),
      configFile: join(ROOT, 'web', 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { server } },
      appType: 'mpa',
    });
    viteMiddleware = vite.middlewares as never;
  }

  // シグナリング
  const room = new Room('default', (m) => console.log(m));
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') return; // Viteのhmrなどは別のハンドラが処理する
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', (ws: WebSocket) => {
    alive.set(ws, true);
    const peer = {
      send: (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)),
      close: () => ws.close(),
    };
    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (data) => room.handle(peer, data.toString()));
    ws.on('close', () => room.leave(peer));
    ws.on('error', () => room.leave(peer));
  });
  // 応答のない接続を切る（相手の切断を早く検知するため）
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 5000).unref();

  server.listen(o.port, o.host, () => {
    const scheme = useHttps ? 'https' : 'http';
    console.log(`\nスクワット姿勢計測システム  (${o.dev ? '開発' : '本番'}モード, ${scheme.toUpperCase()})`);
    console.log(`  ローカル:        ${scheme}://localhost:${o.port}/`);
    const ips = lanAddresses();
    for (const ip of ips) {
      console.log(`\n  LAN ${ip}`);
      console.log(`    主端末:        ${scheme}://${ip}:${o.port}/?role=main`);
      console.log(`    副端末:        ${scheme}://${ip}:${o.port}/?role=sub`);
      console.log(`    オフライン:    ${scheme}://${ip}:${o.port}/offline.html`);
    }
    if (o.qr && ips.length) {
      const ip = ips[0];
      for (const role of ['main', 'sub']) {
        console.log(`\n  ${role === 'main' ? '主端末' : '副端末'}（${ip}）`);
        qrcode.generate(`${scheme}://${ip}:${o.port}/?role=${role}`, { small: true }, (q: string) =>
          console.log(q),
        );
      }
    }
    if (!o.dev && !existsSync(WEB_DIST))
      console.warn('\n[server] web/dist がありません。npm run build を実行してください。');
  });
}

void main();
