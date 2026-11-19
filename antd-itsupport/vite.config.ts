import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Backend: the unchanged IT Support 0.2.0 server (Express + SQLite). `serve.mjs` runs it on this port with the built
// client; in dev mode Vite proxies /api to it.
const API = process.env.ITSUPPORT_API ?? 'http://127.0.0.1:4180'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    // The shared UI package (@dynamics/ui-shared) is linked TS source outside this app's folder. Without dedupe the
    // production bundle can contain two React instances (same file reached via two paths) → "reading 'useContext'".
    dedupe: ['react', 'react-dom', 'antd', '@ant-design/icons', 'dayjs'],
  },
  server: {
    proxy: {
      '/api': {
        target: API,
        changeOrigin: true,
        // The server accepts only same-origin requests (Origin must equal its own host). The dev page runs on
        // another port, so the proxy drops the Origin header; the session cookie and CSRF token still apply.
        configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
      },
    },
  },
})
