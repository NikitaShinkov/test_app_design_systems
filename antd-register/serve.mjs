// Runs Replacement Register as a standalone local application:
//   - backend/app: the original Replacement Register server (API, storage, background jobs, Excel/Word generation),
//     vendored from old_apps; it runs in local-review mode on API_PORT;
//   - dist/: this app's production build, served on PORT; /api is forwarded to the server.
// Start: `npm run start -w antd-register` (builds, then runs this file) or `node serve.mjs` after a build. Node.js 22+.
// Environment:
//   RR_DATA    data folder (default: antd-register/data). On the first run it is filled with the bundled test data
//              (backend/seed: orders 7226, 9312, 9318; 131 proposals, 59 database records). Delete it to start over.
//   PORT       web port (default 4182); API_PORT: port of the server (default 4181)
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, 'backend', 'app');
const seed = join(here, 'backend', 'seed');
const copy = resolve(process.env.RR_DATA ?? join(here, 'data'));
const port = Number(process.env.PORT ?? 4182);
const apiPort = Number(process.env.API_PORT ?? 4181);
const dist = join(here, 'dist');

if (!existsSync(join(dist, 'index.html'))) {
  console.error('Сборка не найдена: выполните `npm run build -w antd-register` (или `npm run start:register` в корне).');
  process.exit(1);
}
if (!existsSync(join(copy, 'preview-state.json'))) {
  mkdirSync(copy, { recursive: true });
  if (existsSync(seed)) cpSync(seed, copy, { recursive: true });
  console.log(`Данные созданы из тестового набора: ${copy}`);
}

const api = spawn(process.execPath, ['server.js'], {
  cwd: serverDir,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    RR_AUTH: 'preview',
    RR_STORAGE: 'local-file',
    RR_PORT: String(apiPort),
    RR_PREVIEW_STATE: join(copy, 'preview-state.json'),
    RR_DATA_ROOT: join(copy, 'files'),
  },
});
api.on('exit', (code) => {
  console.log(`Сервер Replacement Register остановлен (код ${code}).`);
  process.exit(code ?? 1);
});

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };

http
  .createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      // Forward the request (method, headers, raw body) to the original server. Its local-review mode accepts only
      // same-origin requests (Origin must be its own port), so this page's Origin header is dropped; the request still
      // comes from this computer (127.0.0.1).
      const { origin: _origin, ...headers } = req.headers;
      const upstream = http.request(
        { host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: { ...headers, host: `127.0.0.1:${apiPort}` } },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Сервер Replacement Register недоступен.' }));
      });
      req.pipe(upstream);
      return;
    }
    const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^([/\\])+/, '');
    let file = join(dist, path);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`Replacement Register (redesign): http://127.0.0.1:${port}\nДанные: ${copy}\nДля остановки нажмите Ctrl+C.`);
  });

const stop = () => {
  api.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
