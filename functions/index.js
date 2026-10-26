// Agent Mail: one MCP server that Claude, ChatGPT and Muse all connect to, plus a small API for the
// runner on Rastin's Mac that wakes the local Claude and ChatGPT (Codex) when mail arrives.
import express from 'express';
import { z } from 'zod';
import { initializeApp } from 'firebase-admin/app';
import { onRequest } from 'firebase-functions/v2/https';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as store from './store.js';

initializeApp();

const TEAM = Object.entries(store.SEATS)
  .map(([id, s]) => `- ${s.name} (id "${id}"): ${s.about}`)
  .join('\n');

const INSTRUCTIONS = `Agent Mail connects the three AI teammates who work for Rastin:
${TEAM}

Use it like email between colleagues:
- \`ask\` sends a question and waits up to ~45 seconds for the answer. If the answer is slower, it comes back later in the same conversation.
- \`send\` sends a reply, an update or a request that doesn't need you to wait. Reply inside the same conversation by passing its thread_id.
- \`check_inbox\` shows new mail sent to you. \`wait_for_reply\` waits on one conversation.
- The other side does not see your chat, so make every message self-contained: say what you need, give the context and links, and say what a good answer looks like.
- Don't send thank-yous or "got it" replies. Only reply when you have something to add or were asked a question.
- Never put passwords, API keys or payment details in a message.`;

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const failed = (err) => ({ isError: true, content: [{ type: 'text', text: err.message || String(err) }] });
const seatId = z.enum(Object.keys(store.SEATS));

function buildServer(seat, run) {
  const me = store.SEATS[seat].name;
  const server = new McpServer({ name: 'agent-mail', version: '1.0.0' }, { instructions: `You are ${me} (id "${seat}").\n\n${INSTRUCTIONS}` });
  const safely = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return failed(err);
    }
  };

  const noAnswer = async (to, threadId) => {
    const other = (await store.whoIsHere()).find((s) => s.id === to);
    return run
      ? `No answer yet (${other.name} ${other.status}). You will be woken up in this same session when the answer arrives in conversation ${threadId}, so you can finish your turn now.`
      : `No answer yet (${other.name} ${other.status}). Call wait_for_reply with thread_id "${threadId}" later, or check_inbox.`;
  };

  server.registerTool(
    'who_is_here',
    {
      title: 'Who is here',
      description: 'List your teammates on Agent Mail, what each one can do, and whether they are answering right now.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safely(async () => text({ you: seat, team: await store.whoIsHere() })),
  );

  server.registerTool(
    'ask',
    {
      title: 'Ask a teammate',
      description: 'Send a message that needs an answer and wait up to ~45 seconds for it. Use thread_id to ask inside an existing conversation.',
      inputSchema: {
        to: seatId.describe('Who to ask: claude, chatgpt or muse.'),
        message: z.string().describe('The full, self-contained question or request.'),
        thread_id: z.string().optional().describe('Continue this conversation instead of starting a new one.'),
        wait_seconds: z.number().int().min(0).max(50).optional().describe('How long to wait for the answer. Default 45.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safely(async ({ to, message, thread_id, wait_seconds }) => {
      const sent = await store.send({ from: seat, to, text: message, threadId: thread_id, expectsReply: true, run });
      const replies = await store.waitForReply(seat, sent.thread_id, { seconds: wait_seconds ?? 45, interactive: !run });
      if (replies.length) return text({ thread_id: sent.thread_id, replies });
      return text({ thread_id: sent.thread_id, replies: [], note: await noAnswer(to, sent.thread_id) });
    }),
  );

  server.registerTool(
    'send',
    {
      title: 'Send a message',
      description: "Send a reply, update or request without waiting. Pass thread_id to reply inside a conversation. Set expects_reply when you need an answer back.",
      inputSchema: {
        to: seatId.describe('Who it is for: claude, chatgpt or muse.'),
        message: z.string().describe('The full, self-contained message.'),
        thread_id: z.string().optional().describe('The conversation to reply in. Leave empty to start a new one.'),
        expects_reply: z.boolean().optional().describe('True if you need an answer. Default false.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safely(async ({ to, message, thread_id, expects_reply }) => {
      const sent = await store.send({ from: seat, to, text: message, threadId: thread_id, expectsReply: !!expects_reply, run });
      if (expects_reply && !run) await store.holdThread(seat, sent.thread_id);
      return text({ ...sent, delivered: true });
    }),
  );

  server.registerTool(
    'check_inbox',
    {
      title: 'Check inbox',
      description: 'Get the new messages sent to you (oldest first) and mark them read. Each one has a thread_id to reply in.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safely(async ({ limit }) => {
      const messages = await store.checkInbox(seat, { limit });
      return text(messages.length ? { messages } : { messages: [], note: 'No new mail.' });
    }),
  );

  server.registerTool(
    'wait_for_reply',
    {
      title: 'Wait for a reply',
      description: 'Wait up to ~45 seconds for new messages to you in one conversation.',
      inputSchema: {
        thread_id: z.string(),
        wait_seconds: z.number().int().min(0).max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safely(async ({ thread_id, wait_seconds }) => {
      const replies = await store.waitForReply(seat, thread_id, { seconds: wait_seconds ?? 45, interactive: !run });
      return text(replies.length ? { thread_id, replies } : { thread_id, replies: [], note: 'Nothing new yet.' });
    }),
  );

  server.registerTool(
    'read_thread',
    {
      title: 'Read a conversation',
      description: 'Read the whole history of one conversation you are part of.',
      inputSchema: { thread_id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safely(async ({ thread_id }) => text(await store.readThread(seat, thread_id))),
  );

  return server;
}

export const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => (req.body === undefined ? express.json({ limit: '1mb' })(req, res, next) : next()));

// Google's front end rejects Authorization headers that aren't Google tokens, so ours travels in
// X-Agent-Mail-Token (or in the URL path for apps that can't set headers).
const headerToken = (req) => req.get('x-agent-mail-token') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

async function mcp(req, res) {
  const who = store.seatForToken(req.params.token || headerToken(req));
  if (!who) return res.status(401).json({ error: 'Unknown or missing token.' });
  if (req.method !== 'POST') {
    return res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  }
  const run = req.get('x-agent-mail-run') || null;
  const server = buildServer(who.seat, run);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('mcp error', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error.' }, id: null });
  }
}

app.all('/mcp', mcp);
app.all('/mcp/:token', mcp);

// Runner API: only the runner on Rastin's Mac uses these, with the local seats' tokens.
const api = express.Router();
api.use((req, res, next) => {
  const who = store.seatForToken(headerToken(req));
  if (!who) return res.status(401).json({ error: 'Unknown or missing token.' });
  req.seat = who.seat;
  next();
});
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
};
api.post('/pending', handle((req) => store.takePending(req.seat, { graceSeconds: req.body?.grace_seconds ?? 15, heartbeat: req.body?.heartbeat !== false })));
api.get('/thread/:id', handle((req) => store.readThread(req.seat, req.params.id)));
api.post('/send', handle((req) => {
  const { to, text: body, thread_id, expects_reply, kind } = req.body || {};
  return store.send({
    from: req.seat,
    to,
    text: body,
    threadId: thread_id,
    expectsReply: !!expects_reply,
    run: req.get('x-agent-mail-run') || null,
    kind: kind === 'system' ? 'system' : 'message',
  });
}));
app.use('/api', api);

app.get('/', (req, res) => res.type('text').send('Agent Mail is running. Connect an MCP client to /mcp/<your token>.'));

export const agentmail = onRequest(
  { region: 'us-central1', timeoutSeconds: 120, memory: '256MiB', maxInstances: 5, invoker: 'public' },
  app,
);
