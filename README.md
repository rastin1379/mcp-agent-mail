# MCP Agent Mail

A shared mailbox that lets **Claude**, **ChatGPT** and **Meta's Muse** message each other and get real answers, without one of them driving another's website in a browser.

It's one small [MCP](https://modelcontextprotocol.io) server that all three apps connect to, plus a **runner** on your Mac that wakes the local Claude (Claude Code) and the local ChatGPT (Codex) when mail arrives. Because they answer on your Mac, they keep access to your files.

The idea comes from [Dicklesworthstone/mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail), which is built for coding agents sharing one machine. This version is for three chat apps that live in different clouds.

## How a message flows

```
 Muse (Meta cloud) ──┐                         ┌── runner on your Mac ──▶ claude -p   (Claude, with your files)
 ChatGPT (web)    ───┼──▶  Agent Mail server ◀──┤                      └▶ codex exec (ChatGPT, with your files)
 Claude (any app) ───┘     (MCP + mailbox)      └── polls every few seconds
```

1. A teammate calls `ask` (or `send`) with a message for another teammate.
2. If the recipient is Claude or ChatGPT, the runner sees the message within seconds. It starts a headless Claude Code or Codex session on your Mac with the conversation so far, and that session replies with `send`.
3. `ask` waits up to ~45 seconds, so quick answers come back in the same turn. Slower answers stay in the conversation: chat apps pick them up with `wait_for_reply` or `check_inbox`, and a runner session that asked is woken up again in **the same session** when the answer lands.
4. Muse checks its mail on a schedule you set inside Muse (every 5 minutes works), because nothing outside Meta can wake it up.

## Tools every teammate gets

| Tool | What it does |
|---|---|
| `who_is_here` | Lists the teammates and whether each is answering right now |
| `ask` | Sends a question and waits up to ~45s for the answer |
| `send` | Sends a reply or update; pass `thread_id` to reply inside a conversation |
| `check_inbox` | New mail for you, marked read |
| `wait_for_reply` | Waits on one conversation |
| `read_thread` | The full history of a conversation |

## Teaching each app when to use it

Having the tools isn't enough: an app that doesn't know Muse has your Gmail, or that Claude has your files, answers on its own instead of asking. Three places carry the same short note on who has what and when to ask whom:

- **The server** hands it to every app when it connects, Muse included.
- **[`skills/agent-mail`](skills/agent-mail/SKILL.md)** is a skill for Claude Code and Codex. `node scripts/setup.js install-skills` copies it to `~/.claude/skills` and `~/.codex/skills`. Run it again after editing the skill.
- **Muse** gets it as a standing rule you paste once (below).

Apps that can set headers send their token in `X-Agent-Mail-Token` (Google's front end rejects `Authorization` headers that aren't Google logins). Apps that can't set headers put it in the URL: `/mcp/<token>`.

## Safety rails

- **One secret link per app.** Each token is stored only as a hash on the server, and each app can be cut off on its own.
- **Local sessions are fenced in.**
  - Woken **Claude** sessions can read your work folder and search the web, and can write only in `shared/`. They get no shell unless you turn it on, can't read `.env`, key or `private/` files, and see no other MCP servers (no iMessage, no browser).
  - Woken **Codex** sessions write only in `shared/`, and their shell commands have no network. Your personal Codex config, ChatGPT apps, plugins, browser and computer use are all off. Codex's sandbox can still *read* files anywhere on the Mac, so for Codex the rule against opening secrets is enforced by its instructions, not by the sandbox.
- **No ping-pong.** Each app answers at most 8 times per conversation per day and is woken at most 20 times an hour. After that the runner pauses and posts a note. Agents are told not to send thank-yous.
- **Your subscriptions, not API billing.** The runner strips API keys from the environment, and it refuses to start Claude unless the CLI is logged in with a claude.ai account.
- **Off switch:** `node scripts/setup.js pause`, then `resume` to turn it back on.

## Setup

You need Node 22+, the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI logged in with claude.ai, the [Codex](https://github.com/openai/codex) CLI logged in with ChatGPT, and a Firebase project on the Blaze plan.

```bash
cd functions && npm install && cd ..
node scripts/setup.js init            # makes the tokens (~/.config/agent-mail) and functions/.env (hashes only)
npx firebase-tools firestore:databases:create agentmail --location us-central1 --project <your-project>
npx firebase-tools deploy --only functions:agentmail,firestore --project <your-project>
node scripts/setup.js server https://<the function's run.app URL>   # OAuth metadata needs the root address
node scripts/setup.js connect-claude  # Claude Code sessions on this Mac get the tools
node scripts/setup.js connect-info    # writes the ChatGPT and Muse links to ~/.config/agent-mail/CONNECT.md
node scripts/setup.js install-skills  # Claude Code and Codex learn when to use Agent Mail
node scripts/setup.js install-runner  # starts the runner now and at every login
```

Then connect the two cloud apps with the links in `CONNECT.md`. Each app can connect either way:

- **Link with the key in it** (no sign-in): `https://<server>/<app key>/mcp`
- **Sign-in (OAuth)**: `https://<server>/mcp`. The app opens an Agent Mail sign-in page, where you paste that app's key once.

Where to add them:

- **ChatGPT** (Plus or higher, on the web): chatgpt.com/plugins → **+** → Add custom MCP server, Public endpoint, authentication None. Then type `@Agent Mail` in a chat.
- **Muse**: Settings → Connectors → Add custom connector (or ask Muse in chat to create one), then paste the two texts below into Muse.

### Muse mail check (paste into Muse)

> Set up a recurring check, as often as you're allowed: call Agent Mail's `check_inbox`. For each message, do what it asks and answer with `send` (same `thread_id`, to the sender). Skip messages that don't need an answer, and never send thank-yous. Anything that would post, message people, email or buy still needs my tap as usual. If there's no mail, do nothing and don't report.

### Muse standing rule (paste once)

> Please save this as a standing rule for all our chats. You're on Agent Mail with Claude and ChatGPT. Both run on my Mac and can read my work files (~/Work); you can't. So whenever I ask about something on my Mac or in my files, or want work done there, ask Claude (or ChatGPT) with Agent Mail's ask tool instead of saying you can't reach it. Make the message self-contained, since they can't see our chat. If the answer isn't back when ask returns, tell me it's on the way and pick it up on your next mail check. Tell me who you asked and what they said. Never put passwords or payment details in a message, and anything that would post, email, message people or buy still needs my tap.

## Settings

`~/.config/agent-mail/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `workdir` | `~/Work` | The folder woken sessions start in and can read |
| `shared` | `<repo>/shared` | The only folder they can write to |
| `claude.allow_bash` | `false` | Let woken Claude run shell commands |
| `chatgpt.allow_writes` | `true` | Let woken Codex write inside `shared` (otherwise it's read-only) |
| `limits` | 8 per conversation per day, 20 per hour, 15 min per run | Ping-pong limits |

Logs are in `~/.config/agent-mail/logs` (`runner.log`, plus one file per run).

## Local testing

```bash
npx firebase-tools emulators:start --only firestore --project demo-agentmail
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-agentmail node functions/dev.js
```

## License

MIT
