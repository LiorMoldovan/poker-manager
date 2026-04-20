export const config = {
  api: {
    bodyParser: {
      sizeLimit: '20mb',
    },
  },
  maxDuration: 60,
};

const SUPABASE_URL = 'https://ursjltxklmxmapfvkttj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TzhEQmU6mX2n-utnOUAtwQ_zkGTR13j';
const GH_OWNER = 'LiorMoldovan';
const GH_REPO = 'poker-manager';
const GH_BRANCH = 'main';
const MAX_BACKUPS = 3;

async function verifyAuth(
  authHeader: string | undefined,
): Promise<{ error: string; status: number } | null> {
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Missing authentication', status: 401 };
  }

  const token = authHeader.slice(7);

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
    });
    if (res.ok) return null;
    const body = await res.text();
    return { error: `Auth failed (${res.status}): ${body}`, status: 401 };
  } catch (e) {
    return { error: `Auth check error: ${e instanceof Error ? e.message : String(e)}`, status: 500 };
  }
}

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

export default async function handler(
  req: { method?: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> },
  res: { status(code: number): { json(data: unknown): void; send(data: string): void } },
) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const rawAuth = req.headers.authorization;
  const authHeader = typeof rawAuth === 'string' ? rawAuth : Array.isArray(rawAuth) ? rawAuth[0] : undefined;
  const authResult = await verifyAuth(authHeader);
  if (authResult) {
    return res.status(authResult.status).json({ error: { message: authResult.error } });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(500).json({ error: { message: 'GITHUB_TOKEN not configured' } });
  }

  try {
    const { action, groupName, fileName, content, contentBase64 } = req.body || {};

    if (!action || !groupName) {
      return res.status(400).json({ error: { message: 'Missing action or groupName' } });
    }

    const safeName = (groupName as string).replace(/[^a-zA-Z0-9\u0590-\u05FF_-]/g, '_');
    const dir = `backups/${safeName}`;

    if (action === 'push') {
      if (!fileName || (!content && !contentBase64)) {
        return res.status(400).json({ error: { message: 'Missing fileName or content' } });
      }

      const filePath = `${dir}/${fileName}`;
      const encoded = (contentBase64 as string) || Buffer.from(content as string, 'utf-8').toString('base64');

      let sha: string | undefined;
      const existing = await ghApi(token, filePath);
      if (existing.ok) {
        const data = await existing.json();
        sha = (data as { sha: string }).sha;
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

      return res.status(200).json({ success: true });
    }

    if (action === 'list') {
      const listRes = await ghApi(token, dir);
      if (!listRes.ok) {
        if (listRes.status === 404) return res.status(200).json({ files: [] });
        throw new Error(`GitHub list failed (${listRes.status})`);
      }
      const files = (await listRes.json()) as { name: string; size: number }[];
      const result = files
        .filter((f: { name: string }) => f.name.endsWith('.json'))
        .sort((a: { name: string }, b: { name: string }) => b.name.localeCompare(a.name))
        .map((f: { name: string; size: number }) => ({ name: f.name, size: f.size }));
      return res.status(200).json({ files: result });
    }

    if (action === 'fetch') {
      if (!fileName) {
        return res.status(400).json({ error: { message: 'Missing fileName' } });
      }
      const fetchRes = await ghApi(token, `${dir}/${fileName}`);
      if (!fetchRes.ok) throw new Error(`GitHub fetch failed (${fetchRes.status})`);
      const data = await fetchRes.json();
      const decoded = Buffer.from((data as { content: string }).content.replace(/\n/g, ''), 'base64').toString('utf-8');
      return res.status(200).json({ content: decoded });
    }

    return res.status(400).json({ error: { message: `Unknown action: ${action}` } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Backup proxy error';
    return res.status(502).json({ error: { message } });
  }
}
