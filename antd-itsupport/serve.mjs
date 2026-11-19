// Runs the redesigned IT Support: the unchanged IT Support 0.2.0 server (API, security, SQLite) serving this app's
// production build (dist/) on a fixed local port.
//
// Run it with the Node.js bundled in the IT Support release (its better-sqlite3 build matches that runtime):
//   "<IT-Support>\runtime\node.exe" serve.mjs
// Environment:
//   ITSUPPORT_HOME  IT Support 0.2.0 release folder (default: ..\..\old_apps\IT-Support-0.2.0-Windows-x64)
//   PORT            default 4180
//   APP_DATA_DIR    data folder (default: %LOCALAPPDATA%\it-support-assets-redesign — a separate copy, so the
//                   original app and this version never share one database)
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const home = resolve(process.env.ITSUPPORT_HOME ?? join(here, '..', '..', 'old_apps', 'IT-Support-0.2.0-Windows-x64'));
const dataDir = process.env.APP_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? here, 'it-support-assets-redesign');
const { startServer } = await import(pathToFileURL(join(home, 'dist', 'server', 'index.js')).href);

const running = await startServer({
  port: Number(process.env.PORT ?? 4180),
  clientDir: join(here, 'dist'),
  dataDir,
});
console.log(`IT Support (redesign): ${running.url}\nДанные: ${dataDir}\nДля остановки нажмите Ctrl+C.`);
const stop = () => void running.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
