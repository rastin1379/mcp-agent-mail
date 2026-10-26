#!/usr/bin/env node
// Local setup for Agent Mail. Secrets live in ~/.config/agent-mail (never in this repo).
//   node scripts/setup.js init                 make tokens, write functions/.env (hashes only)
//   node scripts/setup.js server <url>         save the deployed server address
//   node scripts/setup.js connect-claude       give every Claude Code session on this Mac the agentmail tools
//   node scripts/setup.js connect-info         write the ChatGPT and Muse connector links to CONNECT.md
//   node scripts/setup.js install-skills       give Claude Code and Codex the when-to-use-Agent-Mail skill
//   node scripts/setup.js install-runner       start the runner now and at every login
//   node scripts/setup.js uninstall-runner
//   node scripts/setup.js pause | resume       stop or restart automatic answers
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = join(homedir(), '.config', 'agent-mail');
const CONFIG = join(HOME, 'config.json');
const LABEL = 'com.agentmail.runner';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
// label -> seat. Each app that connects gets its own token, so one can be revoked alone.
const TOKENS = { 'claude-local': 'claude', 'chatgpt-local': 'chatgpt', 'chatgpt-web': 'chatgpt', muse: 'muse', 'claude-web': 'claude' };

mkdirSync(HOME, { recursive: true, mode: 0o700 });
const load = () => JSON.parse(readFileSync(CONFIG, 'utf8'));
const save = (c) => {
  writeFileSync(CONFIG, JSON.stringify(c, null, 2));
  chmodSync(CONFIG, 0o600);
};

function init() {
  const c = existsSync(CONFIG) ? load() : {};
  c.tokens ??= {};
  for (const label of Object.keys(TOKENS)) c.tokens[label] ??= 'am_' + randomBytes(24).toString('base64url');
  c.workdir ??= join(homedir(), 'Work');
  c.shared ??= join(ROOT, 'shared');
  c.poll_seconds ??= 6;
  c.claude ??= { enabled: true, allow_bash: false };
  c.chatgpt ??= { enabled: true, allow_writes: true };
  c.limits ??= { per_thread_per_day: 8, per_seat_per_hour: 20, run_minutes: 15, grace_seconds: 15 };
  save(c);
  mkdirSync(c.shared, { recursive: true });
  const hashes = Object.entries(TOKENS)
    .map(([label, seat]) => `${label}:${seat}:${createHash('sha256').update(c.tokens[label]).digest('hex')}`)
    .join(',');
  writeFileSync(join(ROOT, 'functions', '.env'), `AGENTMAIL_DB=agentmail\nSEAT_TOKENS=${hashes}\n`);
  console.log(`Tokens are in ${CONFIG}; functions/.env has their hashes.`);
}

function server(url) {
  if (!url) throw new Error('Usage: setup.js server <url>');
  const c = load();
  c.server = url.replace(/\/+$/, '');
  save(c);
  // The OAuth metadata must name the public address, so the function needs it too.
  const env = join(ROOT, 'functions', '.env');
  const lines = readFileSync(env, 'utf8').split('\n').filter((l) => l && !l.startsWith('PUBLIC_URL='));
  writeFileSync(env, [...lines, `PUBLIC_URL=${c.server}`, ''].join('\n'));
  console.log('Server saved:', c.server);
}

function connectClaude() {
  const c = load();
  try {
    execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'agentmail'], { stdio: 'ignore' });
  } catch {}
  execFileSync('claude', ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'agentmail', `${c.server}/mcp`,
    '--header', `X-Agent-Mail-Token: ${c.tokens['claude-local']}`], { stdio: 'inherit' });
}

// Muse has no skills folder we can write to, so it gets this as a rule pasted into its chat.
const MUSE_RULE = `Please save this as a standing rule for all our chats. You're on Agent Mail with Claude and ChatGPT. Both run on my Mac and can read my work files (~/Work); you can't. So whenever I ask about something on my Mac or in my files, or want work done there, ask Claude (or ChatGPT) with Agent Mail's ask tool instead of saying you can't reach it. Make the message self-contained, since they can't see our chat. If the answer isn't back when ask returns, tell me it's on the way and pick it up on your next mail check. Tell me who you asked and what they said. Never put passwords or payment details in a message, and anything that would post, email, message people or buy still needs my tap.`;

function connectInfo() {
  const c = load();
  const file = join(HOME, 'CONNECT.md');
  writeFileSync(file, `# Agent Mail: connect ChatGPT and Muse (private: these keys let an app act as that teammate)

## ChatGPT (chatgpt.com in a browser)
1. Open https://chatgpt.com/plugins and click **+** → **Add custom MCP server**.
   (No Plugins page? Use Settings → Apps → Advanced settings → Developer mode, then **Create app**.)
2. Name: Agent Mail. Connection: **Public endpoint**. URL:
   ${c.server}/${c.tokens['chatgpt-web']}/mcp
3. Authentication: **None**. Tick "I understand and want to continue", then **Create as a plugin** and install it.
   If it only offers OAuth, use the URL ${c.server}/mcp and paste this key on the sign-in page:
   ${c.tokens['chatgpt-web']}
4. In a new chat type **@Agent Mail** and ask, for example:
   "@Agent Mail ask Claude what the newest file in ~/Work/Agents/Trends/daily-x is."

## Muse (muse.ai)
1. Settings → **Connectors** → **Add custom connector**. URL:
   ${c.server}/mcp
   (No such button? Send Muse: "Create a custom connector. Name: Agent Mail. Transport: remote streamable HTTP. URL: ${c.server}/mcp. Auth: OAuth.")
2. Muse opens an Agent Mail sign-in page. Paste this key and click Connect:
   ${c.tokens.muse}
   (If Muse never shows a sign-in page, use this URL instead, which needs no sign-in: ${c.server}/${c.tokens.muse}/mcp)
3. Then send Muse the mail-check text below so it checks its mail on a schedule.

### Muse mail check
Set up a recurring check, as often as you're allowed: call Agent Mail's check_inbox. For each message, do what it asks and answer with send (same thread_id, to the sender). Skip messages that don't need an answer, and never send thank-yous. Anything that would post, message people, email or buy still needs my tap as usual. If there's no mail, do nothing and don't report.

### Muse standing rule (paste once, so Muse asks its teammates without being told)
${MUSE_RULE}

## Claude.ai / Claude.app chat (optional)
Settings → Connectors → Add custom connector: ${c.server}/${c.tokens['claude-web']}/mcp
`);
  chmodSync(file, 0o600);
  console.log('Wrote', file);
}

// Copies, so the skill keeps working if this folder moves. Run again after editing skills/agent-mail.
function installSkills() {
  const src = join(ROOT, 'skills', 'agent-mail', 'SKILL.md');
  for (const app of ['.claude', '.codex']) {
    const dir = join(homedir(), app, 'skills', 'agent-mail');
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, join(dir, 'SKILL.md'));
    console.log('Installed', join(dir, 'SKILL.md'));
  }
}

function installRunner() {
  const node = execFileSync('which', ['node']).toString().trim();
  const logs = join(HOME, 'logs');
  mkdirSync(logs, { recursive: true });
  mkdirSync(dirname(PLIST), { recursive: true });
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(node)}</string><string>${esc(join(ROOT, 'runner', 'runner.js'))}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>${esc(homedir())}</string>
  </dict>
  <key>WorkingDirectory</key><string>${esc(homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${esc(join(logs, 'launchd.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(logs, 'launchd.log'))}</string>
</dict>
</plist>
`);
  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' });
  } catch {}
  execFileSync('launchctl', ['bootstrap', domain, PLIST], { stdio: 'inherit' });
  console.log('Runner installed and started. Log:', join(logs, 'runner.log'));
}

function uninstallRunner() {
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' });
  } catch {}
  rmSync(PLIST, { force: true });
  console.log('Runner stopped and removed.');
}

const [cmd, arg] = process.argv.slice(2);
const commands = {
  init,
  server: () => server(arg),
  'connect-claude': connectClaude,
  'connect-info': connectInfo,
  'install-skills': installSkills,
  'install-runner': installRunner,
  'uninstall-runner': uninstallRunner,
  pause: () => writeFileSync(join(HOME, 'PAUSED'), new Date().toISOString()),
  resume: () => rmSync(join(HOME, 'PAUSED'), { force: true }),
};
if (!commands[cmd]) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).join('\n'));
  process.exit(1);
}
commands[cmd]();
