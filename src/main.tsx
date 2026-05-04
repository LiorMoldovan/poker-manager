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

// Clear the bootstrap watchdog set in index.html. By the time this
// line runs, the main module has loaded and React has at least
// started rendering — if we got here at all, the worst-case "blank
// screen because the JS chunk 404'd" failure mode is ruled out.
// (Errors from INSIDE React get caught by ErrorBoundary in App.tsx.)
//
// Three things to tear down: the hard watchdog timer, the soft
// loading-overlay timer (in case the overlay hasn't been added yet),
// and the overlay DOM element (in case it has). All three are no-ops
// if not present, so the cleanup is safe even when the overlay never
// appeared (typical fast-boot path).
const w = window as unknown as {
  __pokerBootWatchdog?: ReturnType<typeof setTimeout>;
  __pokerLoadingOverlayTimer?: ReturnType<typeof setTimeout>;
};
if (w.__pokerBootWatchdog) {
  clearTimeout(w.__pokerBootWatchdog);
  w.__pokerBootWatchdog = undefined;
}
if (w.__pokerLoadingOverlayTimer) {
  clearTimeout(w.__pokerLoadingOverlayTimer);
  w.__pokerLoadingOverlayTimer = undefined;
}
const __pwaOverlay = document.getElementById('__pwa_loading_overlay');
if (__pwaOverlay) __pwaOverlay.remove();

