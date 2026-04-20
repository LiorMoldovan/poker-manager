import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_VAPID_PUBLIC_KEY': JSON.stringify(process.env.VITE_VAPID_PUBLIC_KEY || ''),
  },
  server: {
    port: 3000,
    open: true,
    headers: {
      'Cache-Control': 'no-store'
    }
  }
})

