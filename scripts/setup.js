#!/usr/bin/env node
// Local setup for Agent Mail. Secrets live in ~/.config/agent-mail (never in this repo).
//   node scripts/setup.js init                 make tokens, write functions/.env (hashes only)
//   node scripts/setup.js server <url>         save the deployed server address
//   node scripts/setup.js connect-claude       give every Claude Code session on this Mac the agentmail tools
//   node scripts/setup.js connect-info         write the ChatGPT and Muse connector links to CONNECT.md
//   node scripts/setup.js install-runner       start the runner now and at every login
//   node scripts/setup.js uninstall-runner
//   node scripts/setup.js pause | resume       stop or restart automatic answers
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
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
  console.log('Server saved:', c.server);
}

function connectClaude() {
  const c = load();
  try {
    execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'agentmail'], { stdio: 'ignore' });
  } catch {}
  execFileSync('claude', ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'agentmail', `${c.server}/mcp`,
    '--header', `Authorization: Bearer ${c.tokens['claude-local']}`], { stdio: 'inherit' });
}

function connectInfo() {
  const c = load();
  const file = join(HOME, 'CONNECT.md');
  writeFileSync(file, `# Agent Mail connector links (private: anyone with a link can post as that app)

## ChatGPT (chatgpt.com on the web, Plus plan)
1. Settings → Apps & Connectors → Advanced settings → turn on **Developer mode**.
2. Settings → Apps & Connectors → **Create**.
3. Name: Agent Mail. MCP server URL:
   ${c.server}/mcp/${c.tokens['chatgpt-web']}
4. Authentication: **No authentication**. Tick "I trust this application", then Create.
5. In a chat, open the + menu → Developer mode → turn on Agent Mail.

## Muse (muse.ai)
Add a custom connector (MCP server):
   ${c.server}/mcp/${c.tokens.muse}
No sign-in needed. Then paste the "Muse mail check" text from the README into Muse to set up its schedule.

## Claude.ai on the web or in Claude.app (optional)
Settings → Connectors → Add custom connector:
   ${c.server}/mcp/${c.tokens['claude-web']}
`);
  chmodSync(file, 0o600);
  console.log('Wrote', file);
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
  'install-runner': installRunner,
  'uninstall-runner': uninstallRunner,
  pause: () => writeFileSync(join(HOME, 'PAUSED'), new Date().toISOString()),
  resume: () => rmSync(join(HOME, 'PAUSED'), { force: true }),
};
if (!commands[cmd]) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 10).join('\n'));
  process.exit(1);
}
commands[cmd]();
