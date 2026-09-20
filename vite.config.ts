import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'

const DEV_SESSION_FILE = path.resolve(__dirname, 'node_modules/.vite/dev-session.json')

function getStoredDevSession() {
  try {
    if (fs.existsSync(DEV_SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(DEV_SESSION_FILE, 'utf8'))
    }
  } catch {}
  return null
}

function saveStoredDevSession(session: any) {
  try {
    const dir = path.dirname(DEV_SESSION_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(DEV_SESSION_FILE, JSON.stringify(session), 'utf8')
  } catch {}
}

function clearStoredDevSession() {
  try {
    if (fs.existsSync(DEV_SESSION_FILE)) fs.unlinkSync(DEV_SESSION_FILE)
  } catch {}
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'dev-auth-bridge',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const host = req.headers.host || 'localhost:3000'
          const url = new URL(req.url || '', `http://${host}`)

          if (url.pathname === '/__dev_auth_sync') {
            if (req.method === 'POST') {
              let body = ''
              req.on('data', chunk => { body += chunk })
              req.on('end', () => {
                try {
                  const data = JSON.parse(body)
                  if (data && (data.access_token || data.refresh_token)) {
                    saveStoredDevSession(data)
                  }
                  res.writeHead(200, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ ok: true }))
                } catch {
                  res.writeHead(400, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ error: 'invalid json' }))
                }
              })
              return
            }
            if (req.method === 'GET') {
              const session = getStoredDevSession()
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(session || {}))
              return
            }
            if (req.method === 'DELETE') {
              clearStoredDevSession()
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
              return
            }
          }

          if (url.pathname === '/__dev_open_chrome') {
            const targetUrl = 'http://localhost:3000/?dev_bridge=1'
            exec(`start "" "${targetUrl}"`, () => {})
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
            return
          }

          next()
        })
      }
    }
  ],
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

