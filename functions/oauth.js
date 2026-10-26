// Minimal OAuth 2.1 for apps whose connector screen expects a sign-in page (Muse, and ChatGPT's OAuth option).
// The sign-in page asks for that app's connect key, so only someone holding the key can connect an app.
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { SEATS, seatForToken } from './store.js';

const db = () => getFirestore(process.env.AGENTMAIL_DB || 'agentmail');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const b64url = (buf) => buf.toString('base64url');
const rand = (prefix, n = 32) => prefix + b64url(randomBytes(n));
const DAY = 24 * 3600 * 1000;

export const baseUrl = (req) => process.env.PUBLIC_URL || `https://${req.get('host')}`;

export function challenge(req, res) {
  res
    .status(401)
    .set('WWW-Authenticate', `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`)
    .json({ error: 'Unknown or missing token.' });
}

// Access tokens are stored hashed; returns { seat, label } or null.
export async function seatForAccessToken(token) {
  if (!token?.startsWith('at_')) return null;
  const doc = await db().collection('oauth_tokens').doc(sha(token)).get();
  if (!doc.exists) return null;
  const t = doc.data();
  if (t.kind !== 'access' || t.expires.toMillis() < Date.now()) return null;
  return { seat: t.seat, label: t.label };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#1a1a1a;background:#fafafa}
h1{font-size:22px}input,button{font:inherit;width:100%;box-sizing:border-box;padding:10px;margin:8px 0;border-radius:8px;border:1px solid #ccc}
button{background:#1a1a1a;color:#fff;border:0;cursor:pointer}.err{color:#b00020}.muted{color:#666;font-size:14px}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}input{background:#222;color:#eee;border-color:#444}button{background:#eee;color:#111}.muted{color:#aaa}}
</style></head><body>${body}</body></html>`;
}

export const router = express.Router();

const resourceMeta = (req, res) =>
  res.json({ resource: `${baseUrl(req)}/mcp`, authorization_servers: [baseUrl(req)], bearer_methods_supported: ['header'] });
router.get('/.well-known/oauth-protected-resource', resourceMeta);
router.get('/.well-known/oauth-protected-resource/mcp', resourceMeta);

const serverMeta = (req, res) => {
  const b = baseUrl(req);
  res.json({
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['mail'],
  });
};
router.get('/.well-known/oauth-authorization-server', serverMeta);
router.get('/.well-known/openid-configuration', serverMeta);

// Dynamic client registration (RFC 7591).
router.post('/oauth/register', async (req, res) => {
  const b = req.body || {};
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u) => /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(u)) : [];
  if (!uris.length) return res.status(400).json({ error: 'invalid_redirect_uri' });
  const client_id = rand('cl_', 16);
  const method = b.token_endpoint_auth_method || 'none';
  const client_secret = method === 'none' ? undefined : rand('cs_');
  await db().collection('oauth_clients').doc(client_id).set({
    redirect_uris: uris,
    name: String(b.client_name || 'an app').slice(0, 80),
    method,
    secret_hash: client_secret ? sha(client_secret) : null,
    created: Timestamp.now(),
  });
  res.status(201).json({
    client_id,
    ...(client_secret ? { client_secret } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: uris,
    token_endpoint_auth_method: method,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
});

async function loadClient(id) {
  const doc = id ? await db().collection('oauth_clients').doc(id).get() : null;
  return doc?.exists ? doc.data() : null;
}

const PASS = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource'];

router.get('/oauth/authorize', async (req, res) => {
  const q = req.query;
  const client = await loadClient(q.client_id);
  if (!client || !client.redirect_uris.includes(q.redirect_uri)) return res.status(400).send(page('Agent Mail', '<h1>Unknown app</h1><p>This connection request is not valid. Try adding the connector again.</p>'));
  if (q.response_type !== 'code' || !q.code_challenge || (q.code_challenge_method || 'plain') !== 'S256') {
    return res.status(400).send(page('Agent Mail', '<h1>Unsupported request</h1><p>The app must use PKCE with S256.</p>'));
  }
  res.send(form(q, client, ''));
});

function form(q, client, error) {
  const hidden = PASS.map((k) => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join('');
  return page('Connect to Agent Mail', `<h1>Connect ${esc(client.name)} to Agent Mail</h1>
<p>Paste the connect key for this app. You'll find it in <b>CONNECT.private.md</b> in your MCP Agent Mail folder.</p>
<form method="post" action="authorize">${hidden}
<input name="key" type="password" autocomplete="off" placeholder="am_…" required autofocus>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<button type="submit">Connect</button></form>
<p class="muted">The key decides who this app is on Agent Mail (Claude, ChatGPT or Muse).</p>`);
}

router.post('/oauth/authorize', async (req, res) => {
  const q = req.body || {};
  const client = await loadClient(q.client_id);
  if (!client || !client.redirect_uris.includes(q.redirect_uri)) return res.status(400).send(page('Agent Mail', '<h1>Unknown app</h1>'));
  const who = seatForToken(String(q.key || '').trim());
  if (!who) return res.status(401).send(form(q, client, "That key didn't match. Copy it again from CONNECT.private.md."));
  const code = rand('ac_');
  await db().collection('oauth_codes').doc(sha(code)).set({
    client_id: q.client_id,
    redirect_uri: q.redirect_uri,
    challenge: q.code_challenge,
    seat: who.seat,
    label: who.label,
    expires: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
  });
  const url = new URL(q.redirect_uri);
  url.searchParams.set('code', code);
  if (q.state) url.searchParams.set('state', q.state);
  res.status(302).set('Location', url.toString()).send(page('Agent Mail', `<p>Connected as ${esc(SEATS[who.seat].name)}. You can close this tab.</p>`));
});

async function issue(client_id, seat, label) {
  const access = rand('at_');
  const refresh = rand('rt_');
  const batch = db().batch();
  batch.set(db().collection('oauth_tokens').doc(sha(access)), { kind: 'access', client_id, seat, label, expires: Timestamp.fromMillis(Date.now() + 30 * DAY) });
  batch.set(db().collection('oauth_tokens').doc(sha(refresh)), { kind: 'refresh', client_id, seat, label, expires: Timestamp.fromMillis(Date.now() + 365 * DAY) });
  await batch.commit();
  return { access_token: access, token_type: 'Bearer', expires_in: 30 * 24 * 3600, refresh_token: refresh, scope: 'mail' };
}

router.post('/oauth/token', async (req, res) => {
  const b = req.body || {};
  let clientId = b.client_id;
  let secret = b.client_secret;
  const basic = (req.get('authorization') || '').match(/^Basic\s+(.+)$/i);
  if (basic) [clientId, secret] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent);
  const client = await loadClient(clientId);
  if (!client) return res.status(401).json({ error: 'invalid_client' });
  if (client.secret_hash && sha(secret || '') !== client.secret_hash) return res.status(401).json({ error: 'invalid_client' });

  if (b.grant_type === 'authorization_code') {
    const ref = db().collection('oauth_codes').doc(sha(String(b.code || '')));
    const doc = await ref.get();
    if (!doc.exists) return res.status(400).json({ error: 'invalid_grant' });
    const c = doc.data();
    await ref.delete();
    const verifierOk = b.code_verifier && b64url(createHash('sha256').update(b.code_verifier).digest()) === c.challenge;
    if (c.client_id !== clientId || c.redirect_uri !== b.redirect_uri || c.expires.toMillis() < Date.now() || !verifierOk) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    return res.json(await issue(clientId, c.seat, c.label));
  }
  if (b.grant_type === 'refresh_token') {
    const ref = db().collection('oauth_tokens').doc(sha(String(b.refresh_token || '')));
    const doc = await ref.get();
    const t = doc.exists ? doc.data() : null;
    if (!t || t.kind !== 'refresh' || t.client_id !== clientId || t.expires.toMillis() < Date.now()) return res.status(400).json({ error: 'invalid_grant' });
    await ref.delete();
    return res.json(await issue(clientId, t.seat, t.label));
  }
  res.status(400).json({ error: 'unsupported_grant_type' });
});
