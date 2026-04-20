export const config = { runtime: 'edge' };

const DEPLOY_ID = process.env.VERCEL_DEPLOYMENT_ID || Date.now().toString();

export default function handler(): Response {
  return new Response(JSON.stringify({ deployId: DEPLOY_ID }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}
