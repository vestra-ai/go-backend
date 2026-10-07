// A one-page "Sign in with Google" through Supabase, on http://localhost:3000, for trying real tokens by hand:
// it shows the Supabase access token the app would get, and calls our server's GET /app/me with it.
// Needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env, http://localhost:3000 in Supabase's Redirect URLs, and
// APP_ORIGINS=http://localhost:3000 on the server (so the browser may call it). Dev only. Ctrl-C stops it.
import { createServer } from 'node:http';
import { loadEnv } from './dev-real.js';

const env = loadEnv(process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1]! : '.env');
const port = Number(process.env.LOGIN_PORT ?? 3000);
const server = env.SERVER_URL ?? `http://localhost:${env.PORT ?? 8080}`;
const page = (supabaseUrl: string, key: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Go: sign-in check</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --box:#f4f4f5; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --muted:#999; --box:#1d1d20; } }
  body { font: 15px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); max-width: 760px; margin: 32px auto; padding: 0 16px; }
  button { font: inherit; padding: 8px 14px; margin: 4px 8px 4px 0; border-radius: 8px; border: 1px solid var(--muted); background: var(--box); color: var(--fg); cursor: pointer; }
  pre { background: var(--box); padding: 12px; border-radius: 8px; white-space: pre-wrap; word-break: break-all; }
  .muted { color: var(--muted); }
</style></head><body>
<h1>Go: Supabase sign-in check</h1>
<p class="muted">Project ${supabaseUrl} · server ${server}</p>
<button id="in">Sign in with Google</button><button id="me">Call GET /app/me</button><button id="copy">Copy token</button><button id="out">Sign out</button>
<h3>Session</h3><pre id="session">Not signed in.</pre>
<h3>Server says</h3><pre id="server">-</pre>
<script type="module">
  import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
  const sb = createClient(${JSON.stringify(supabaseUrl)}, ${JSON.stringify(key)});
  const $ = (id) => document.getElementById(id);
  const show = async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return ($('session').textContent = 'Not signed in.');
    const claims = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    $('session').textContent = 'user ' + claims.sub + ' (' + claims.email + ')\\nexpires ' + new Date(claims.exp * 1000).toLocaleTimeString() + '\\n\\naccess token:\\n' + session.access_token;
  };
  $('in').onclick = () => sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin } });
  $('out').onclick = async () => (await sb.auth.signOut(), show());
  $('copy').onclick = async () => { const { data: { session } } = await sb.auth.getSession(); if (session) await navigator.clipboard.writeText(session.access_token); };
  $('me').onclick = async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return ($('server').textContent = 'Sign in first.');
    try {
      const r = await fetch(${JSON.stringify(server)} + '/app/me', { headers: { authorization: 'Bearer ' + session.access_token } });
      $('server').textContent = r.status + ' ' + JSON.stringify(await r.json(), null, 2);
    } catch (e) { $('server').textContent = 'Could not reach the server (is APP_ORIGINS=' + location.origin + ' set?): ' + e.message; }
  };
  sb.auth.onAuthStateChange(() => show());
  show();
</script></body></html>`;

createServer((req, res) => {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env first (see docs/SUPABASE-SETUP.md).\n');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(env.SUPABASE_URL.replace(/\/+$/, ''), env.SUPABASE_PUBLISHABLE_KEY));
}).listen(port, '127.0.0.1', () => console.log(`Sign-in check page on http://localhost:${port}`));
