import { verifySupabaseAuth } from './_auth';

export const config = { runtime: 'edge' };

const GH_OWNER = 'LiorMoldovan';
const GH_REPO = 'poker-manager';
const GH_BRANCH = 'main';
const MAX_BACKUPS = 3;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function ghHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };
}

async function ghApi(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`, {
    ...init,
    headers: { ...ghHeaders(token), ...init?.headers },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authError = await verifySupabaseAuth(req);
  if (authError) return authError;

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: { message: 'GITHUB_TOKEN not configured' } }), {
      status: 500, headers: JSON_HEADERS,
    });
  }

  try {
    const { action, groupName, fileName, content } = await req.json();

    if (!action || !groupName) {
      return new Response(JSON.stringify({ error: { message: 'Missing action or groupName' } }), {
        status: 400, headers: JSON_HEADERS,
      });
    }

    const safeName = groupName.replace(/[^a-zA-Z0-9\u0590-\u05FF_-]/g, '_');
    const dir = `backups/${safeName}`;

    if (action === 'push') {
      if (!fileName || !content) {
        return new Response(JSON.stringify({ error: { message: 'Missing fileName or content' } }), {
          status: 400, headers: JSON_HEADERS,
        });
      }

      const filePath = `${dir}/${fileName}`;
      const encoded = btoa(unescape(encodeURIComponent(content)));

      let sha: string | undefined;
      const existing = await ghApi(token, filePath);
      if (existing.ok) {
        const data = await existing.json();
        sha = data.sha;
      }

      const body: Record<string, unknown> = {
        message: `Backup: ${safeName} - ${fileName}`,
        content: encoded,
        branch: GH_BRANCH,
      };
      if (sha) body.sha = sha;

      const putRes = await ghApi(token, filePath, { method: 'PUT', body: JSON.stringify(body) });
      if (!putRes.ok) {
        const err = await putRes.text();
        throw new Error(`GitHub push failed (${putRes.status}): ${err}`);
      }

      const listRes = await ghApi(token, dir);
      if (listRes.ok) {
        const files = (await listRes.json()) as { name: string; sha: string; path: string }[];
        const jsonFiles = files
          .filter((f: { name: string }) => f.name.endsWith('.json'))
          .sort((a: { name: string }, b: { name: string }) => b.name.localeCompare(a.name));

        for (const old of jsonFiles.slice(MAX_BACKUPS)) {
          await ghApi(token, old.path, {
            method: 'DELETE',
            body: JSON.stringify({ message: `Prune: ${old.name}`, sha: old.sha, branch: GH_BRANCH }),
          });
        }
      }

      return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
    }

    if (action === 'list') {
      const listRes = await ghApi(token, dir);
      if (!listRes.ok) {
        if (listRes.status === 404) return new Response(JSON.stringify({ files: [] }), { headers: JSON_HEADERS });
        throw new Error(`GitHub list failed (${listRes.status})`);
      }
      const files = (await listRes.json()) as { name: string; size: number }[];
      const result = files
        .filter((f: { name: string }) => f.name.endsWith('.json'))
        .sort((a: { name: string }, b: { name: string }) => b.name.localeCompare(a.name))
        .map((f: { name: string; size: number }) => ({ name: f.name, size: f.size }));
      return new Response(JSON.stringify({ files: result }), { headers: JSON_HEADERS });
    }

    if (action === 'fetch') {
      if (!fileName) {
        return new Response(JSON.stringify({ error: { message: 'Missing fileName' } }), {
          status: 400, headers: JSON_HEADERS,
        });
      }
      const fetchRes = await ghApi(token, `${dir}/${fileName}`);
      if (!fetchRes.ok) throw new Error(`GitHub fetch failed (${fetchRes.status})`);
      const data = await fetchRes.json();
      const decoded = decodeURIComponent(escape(atob((data.content as string).replace(/\n/g, ''))));
      return new Response(JSON.stringify({ content: decoded }), { headers: JSON_HEADERS });
    }

    return new Response(JSON.stringify({ error: { message: `Unknown action: ${action}` } }), {
      status: 400, headers: JSON_HEADERS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Backup proxy error';
    return new Response(JSON.stringify({ error: { message } }), {
      status: 502, headers: JSON_HEADERS,
    });
  }
}
