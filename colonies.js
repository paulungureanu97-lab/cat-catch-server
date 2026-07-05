// Colonies (clans) — Phase 1: create / join / leave / profile / roles / members.
// Durable via store.js (Upstash in prod, in-memory locally). A player belongs to
// at most one colony. Roles: leader > elder > member. Missions/tournaments come
// in later phases.
const store = require('./store');

const COL = (id) => `col:${id}`; // colony record
const PCOL = (uid) => `pcol:${uid}`; // which colony a player is in
const COLS = 'cols'; // set of all colony ids

const MAX_CAP = 20; // hard ceiling on members-per-colony
const clampMax = (n) => Math.max(2, Math.min(MAX_CAP, (n | 0) || 10));
const clean = (s, n) => String(s || '').trim().slice(0, n);

let seq = 0;
function newId() {
  seq = (seq + 1) % 100000;
  return 'c_' + Date.now().toString(36) + seq.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function summary(c) {
  return { id: c.id, name: c.name, emoji: c.emoji, bio: c.bio, members: c.members.length, max: c.max };
}
function roleOf(c, uid) {
  return c.members.find((m) => m.uid === uid)?.role || null;
}
const canManage = (c, uid) => ['leader', 'elder'].includes(roleOf(c, uid)); // kick/invite
const isLeader = (c, uid) => roleOf(c, uid) === 'leader';

async function get(id) {
  return id ? store.get(COL(id)) : null;
}
async function myColonyId(uid) {
  return store.get(PCOL(uid));
}
/** The full colony a player is in, or null. */
async function myColony(uid) {
  const id = await myColonyId(uid);
  return id ? get(id) : null;
}

async function create(uid, playerName, playerAvatar, { name, emoji, bio, max }) {
  if (!uid) return { error: 'no-uid' };
  if (await myColonyId(uid)) return { error: 'already-in' };
  const nm = clean(name, 24);
  if (nm.length < 2) return { error: 'bad-name' };
  const id = newId();
  const colony = {
    id,
    name: nm,
    emoji: clean(emoji, 4) || '🐾',
    bio: clean(bio, 120),
    max: clampMax(max),
    createdAt: Date.now(),
    members: [{ uid, name: clean(playerName, 20), avatar: clean(playerAvatar, 8), role: 'leader', at: Date.now() }],
  };
  return { colony, id };
}

async function join(uid, id, name, avatar) {
  if (!uid) return { error: 'no-uid' };
  if (await myColonyId(uid)) return { error: 'already-in' };
  const c = await get(id);
  if (!c) return { error: 'not-found' };
  if (c.members.length >= c.max) return { error: 'full' };
  if (!c.members.some((m) => m.uid === uid)) {
    c.members.push({ uid, name: clean(name, 20), avatar: clean(avatar, 8), role: 'member', at: Date.now() });
  }
  return { colony: c };
}

/** Remove a member; returns { colony|null (null=disbanded), leaderTransferred }. */
function removeMember(c, uid) {
  const wasLeader = roleOf(c, uid) === 'leader';
  c.members = c.members.filter((m) => m.uid !== uid);
  if (c.members.length === 0) return { colony: null };
  if (wasLeader && !c.members.some((m) => m.role === 'leader')) {
    // promote the longest-standing remaining member (elder first)
    const next =
      [...c.members].sort((a, b) => a.at - b.at).find((m) => m.role === 'elder') ||
      [...c.members].sort((a, b) => a.at - b.at)[0];
    next.role = 'leader';
  }
  return { colony: c };
}

module.exports = {
  COL,
  PCOL,
  COLS,
  summary,
  roleOf,
  canManage,
  isLeader,
  get,
  myColony,
  myColonyId,
  create,
  join,
  removeMember,
  clean,
  clampMax,
  async list(limit = 50) {
    const ids = await store.smembers(COLS);
    const out = [];
    for (const id of ids.slice(0, limit)) {
      const c = await get(id);
      if (c) out.push(summary(c));
    }
    out.sort((a, b) => b.members - a.members);
    return out;
  },
  // persistence helpers (index.js orchestrates delivery to sockets)
  async save(c) {
    await store.set(COL(c.id), c);
  },
  async setMember(uid, id) {
    await store.set(PCOL(uid), id);
  },
  async clearMember(uid) {
    await store.del(PCOL(uid));
  },
  async register(id) {
    await store.sadd(COLS, id);
  },
  async disband(id) {
    await store.del(COL(id));
    await store.srem(COLS, id);
  },
};
