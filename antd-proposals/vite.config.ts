import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    // The shared UI package (@dynamics/ui-shared) is linked TS source outside this app's folder. Without dedupe the
    // production bundle can contain two React instances (same file reached via two paths) → "reading 'useContext'".
    dedupe: ['react', 'react-dom', 'antd', '@ant-design/icons', 'dayjs'],
  },
})
