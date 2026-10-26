// Firestore-backed mailbox. Everything the MCP tools and the runner API do goes through here.
import { createHash, randomBytes } from 'node:crypto';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

export const SEATS = {
  claude: {
    name: 'Claude',
    about: "Anthropic's Claude. Runs on Rastin's Mac with his files, and answers on its own within a few minutes while the Mac is on.",
  },
  chatgpt: {
    name: 'ChatGPT',
    about: "OpenAI's ChatGPT. Answers on Rastin's Mac as Codex (with his files) within a few minutes while the Mac is on, or from Rastin's ChatGPT chat when he is using it.",
  },
  muse: {
    name: 'Muse',
    about: "Meta's Muse agent (Limoo). Runs in Meta's cloud with Rastin's Facebook, Instagram, Marketplace, Gmail and a web browser. It checks its mail on a schedule, so answers can take a while.",
  },
};

const MAX_TEXT = 20000;
const SENDS_PER_HOUR = 60;

let db;
function fs() {
  db ??= getFirestore(process.env.AGENTMAIL_DB || 'agentmail');
  return db;
}

// SEAT_TOKENS is "label:seat:sha256,label:seat:sha256". Only hashes ever reach the server.
export function seatForToken(token) {
  if (!token) return null;
  const hash = createHash('sha256').update(token).digest('hex');
  for (const entry of (process.env.SEAT_TOKENS || '').split(',')) {
    const [label, seat, h] = entry.trim().split(':');
    if (h && h === hash && SEATS[seat]) return { seat, label };
  }
  return null;
}

const newId = (prefix) => prefix + randomBytes(5).toString('hex');
const iso = (t) => (t instanceof Timestamp ? t.toDate().toISOString() : t ?? null);

function checkSeat(to, from) {
  if (!SEATS[to]) throw new Error(`Unknown teammate "${to}". Use one of: ${Object.keys(SEATS).join(', ')}.`);
  if (to === from) throw new Error("You can't message yourself.");
}

function view(doc) {
  const m = doc.data();
  return {
    id: doc.id,
    thread_id: m.thread,
    from: m.from,
    to: m.to,
    text: m.text,
    expects_reply: !!m.expects_reply,
    kind: m.kind || 'message',
    sent_at: iso(m.created_at),
  };
}

async function rateLimit(seat) {
  const ref = fs().collection('seats').doc(seat);
  const hour = new Date().toISOString().slice(0, 13);
  await fs().runTransaction(async (tx) => {
    const s = (await tx.get(ref)).data() || {};
    const count = s.send_hour === hour ? s.send_count || 0 : 0;
    if (count >= SENDS_PER_HOUR) throw new Error(`${SEATS[seat].name} has sent ${SENDS_PER_HOUR} messages this hour. Wait for the next hour.`);
    tx.set(ref, { send_hour: hour, send_count: count + 1 }, { merge: true });
  });
}

// run = the runner's id for a headless session, so replies can wake that same session later.
export async function send({ from, to, text, threadId, expectsReply, run, via = null, kind = 'message' }) {
  checkSeat(to, from);
  text = String(text || '').trim();
  if (!text) throw new Error('The message is empty.');
  if (text.length > MAX_TEXT) throw new Error(`Keep messages under ${MAX_TEXT} characters (this one is ${text.length}).`);
  if (kind === 'message') await rateLimit(from);

  const threads = fs().collection('threads');
  let thread = threadId;
  if (thread) {
    const t = await threads.doc(thread).get();
    if (!t.exists) throw new Error(`No conversation with id ${thread}.`);
    if (kind === 'message' && !t.data().participants.includes(from)) throw new Error(`You aren't part of conversation ${thread}.`);
    await t.ref.update({
      participants: FieldValue.arrayUnion(from, to),
      updated_at: FieldValue.serverTimestamp(),
      count: FieldValue.increment(1),
    });
  } else {
    thread = newId('t_');
    await threads.doc(thread).set({
      subject: text.replace(/\s+/g, ' ').slice(0, 80),
      participants: [from, to],
      started_by: from,
      origin_run: run || null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      count: 1,
    });
  }

  const ref = fs().collection('messages').doc(newId('m_'));
  await ref.set({
    thread,
    from,
    to,
    text,
    expects_reply: !!expectsReply,
    kind,
    run: run || null,
    via,
    status: 'new',
    created_at: FieldValue.serverTimestamp(),
  });
  return { message_id: ref.id, thread_id: thread };
}

async function newFor(seat, threadId) {
  let q = fs().collection('messages').where('to', '==', seat).where('status', '==', 'new');
  if (threadId) q = q.where('thread', '==', threadId);
  const snap = await q.get();
  return snap.docs.sort((a, b) => a.data().created_at?.toMillis() - b.data().created_at?.toMillis());
}

async function markRead(docs, status = 'read') {
  if (!docs.length) return;
  const batch = fs().batch();
  for (const d of docs) batch.update(d.ref, { status, read_at: FieldValue.serverTimestamp() });
  await batch.commit();
}

// Which app last reached the server for a seat (e.g. chatgpt-web vs chatgpt-local).
export async function seen(seat, label) {
  await fs().collection('seats').doc(seat).set({ seen: { [label]: FieldValue.serverTimestamp() } }, { merge: true });
}

export async function touch(seat, field) {
  await fs().collection('seats').doc(seat).set({ [field]: FieldValue.serverTimestamp() }, { merge: true });
}

// An interactive caller (a chat app, or Claude while Rastin is talking to it) is waiting on this
// thread, so the runner must not wake a headless copy of the same seat to answer it.
export async function holdThread(seat, threadId, seconds = 15 * 60) {
  await fs().collection('holds').doc(`${seat}_${threadId}`).set({
    seat,
    thread: threadId,
    until: Timestamp.fromMillis(Date.now() + seconds * 1000),
  });
}

export async function checkInbox(seat, { limit = 20 } = {}) {
  await touch(seat, 'checked_at');
  const docs = (await newFor(seat)).slice(0, limit);
  await markRead(docs);
  return docs.map(view);
}

export async function waitForReply(seat, threadId, { seconds = 45, interactive = true } = {}) {
  const t = await fs().collection('threads').doc(threadId).get();
  if (!t.exists) throw new Error(`No conversation with id ${threadId}.`);
  if (!t.data().participants.includes(seat)) throw new Error(`You aren't part of conversation ${threadId}.`);
  if (interactive) await holdThread(seat, threadId, 15 * 60);
  const deadline = Date.now() + Math.min(Math.max(seconds, 0), 50) * 1000;
  for (;;) {
    const docs = await newFor(seat, threadId);
    if (docs.length || Date.now() >= deadline) {
      await markRead(docs);
      return docs.map(view);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function readThread(seat, threadId, { limit = 50 } = {}) {
  const t = await fs().collection('threads').doc(threadId).get();
  if (!t.exists) throw new Error(`No conversation with id ${threadId}.`);
  const th = t.data();
  if (seat && !th.participants.includes(seat)) throw new Error(`You aren't part of conversation ${threadId}.`);
  const snap = await fs().collection('messages').where('thread', '==', threadId).get();
  const msgs = snap.docs
    .sort((a, b) => a.data().created_at?.toMillis() - b.data().created_at?.toMillis())
    .slice(-limit)
    .map((d) => ({ ...view(d), run: d.data().run || null, via: d.data().via || null }));
  return {
    thread_id: threadId,
    subject: th.subject,
    participants: th.participants,
    started_by: th.started_by,
    origin_run: th.origin_run || null,
    messages: msgs,
  };
}

export async function whoIsHere() {
  const snap = await fs().collection('seats').get();
  const state = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
  const now = Date.now();
  return Object.entries(SEATS).map(([seat, s]) => {
    const st = state[seat] || {};
    const runner = st.runner_at?.toMillis();
    const checked = st.checked_at?.toMillis();
    let status;
    if (runner && now - runner < 3 * 60 * 1000) status = 'on call: answers automatically within a few minutes';
    else if (seat === 'muse') status = checked ? `checks mail on a schedule; last checked ${iso(st.checked_at)}` : 'has not checked mail yet';
    else status = "offline: Rastin's Mac is off or asleep. Mail waits until it is back";
    const apps = Object.fromEntries(Object.entries(st.seen || {}).map(([label, t]) => [label, iso(t)]));
    return { id: seat, name: s.name, about: s.about, status, apps_last_seen: apps };
  });
}

// Runner: new mail for a seat that has sat for `graceSeconds` with nobody holding the thread.
// Returned messages are marked delivered so they are handed out once.
export async function takePending(seat, { graceSeconds = 15, heartbeat = true } = {}) {
  if (heartbeat) await touch(seat, 'runner_at');
  const cutoff = Date.now() - graceSeconds * 1000;
  const docs = (await newFor(seat)).filter((d) => {
    const m = d.data();
    return m.kind !== 'system' && m.from !== seat && m.created_at && m.created_at.toMillis() <= cutoff;
  });
  if (!docs.length) return [];
  const holds = await fs().collection('holds').where('seat', '==', seat).get();
  const held = new Set(holds.docs.filter((h) => h.data().until.toMillis() > Date.now()).map((h) => h.data().thread));
  const ready = docs.filter((d) => !held.has(d.data().thread));
  await markRead(ready, 'delivered');
  const out = [];
  for (const d of ready) {
    const t = (await fs().collection('threads').doc(d.data().thread).get()).data();
    out.push({ ...view(d), thread_origin_run: t?.origin_run || null, thread_started_by: t?.started_by || null });
  }
  return out;
}
