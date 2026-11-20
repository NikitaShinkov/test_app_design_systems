import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Backend: the unchanged Replacement Register server, started by `serve.mjs` on a data copy (port 4181). In dev mode
// Vite proxies /api to it; in production serve.mjs serves dist/ and forwards /api itself.
const API = process.env.RR_API ?? 'http://127.0.0.1:4181'

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
        // The server's local-review mode accepts only same-origin requests (Origin must equal its own port). The dev
        // page runs on another port, so the proxy drops the Origin header.
        configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
      },
    },
  },
})
