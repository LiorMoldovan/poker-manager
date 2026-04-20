import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles/index.css'

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const newSW = reg.installing;
      if (newSW) {
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'activated') {
            window.location.reload();
          }
        });
      }
    });
    reg.update().catch(() => {});
  }).catch(() => {});
}

// Auto-detect new deploys and reload (checks every 5 minutes)
let knownDeployId: string | null = null;
async function checkForUpdate() {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return;
    const { deployId } = await res.json();
    if (!knownDeployId) {
      knownDeployId = deployId;
    } else if (deployId !== knownDeployId) {
      window.location.reload();
    }
  } catch { /* offline or error — skip */ }
}
checkForUpdate();
setInterval(checkForUpdate, 5 * 60 * 1000);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)

