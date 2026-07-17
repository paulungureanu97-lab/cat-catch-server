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

// ---- Phase 2: weekly colony missions + rewards ----
// Collective goals the whole colony chips away at together (every member's
// catches/wins count into the SAME progress bar). When a mission is complete
// each member can claim its reward ONCE (coins + xp applied on their device).
// Missions rotate weekly (Mon 00:00 UTC), deterministically per colony+week so
// every member — and the server across a restart — sees the identical set.
const MISSION_POOL = [
  { type: 'catch', goal: 40, coins: 60, xp: 40 },
  { type: 'win', goal: 25, coins: 90, xp: 55 },
  { type: 'battle', goal: 40, coins: 55, xp: 40 },
  { type: 'rare', goal: 12, coins: 100, xp: 60 },
  { type: 'perfect', goal: 20, coins: 75, xp: 45 },
  { type: 'care', goal: 30, coins: 70, xp: 45 },
  { type: 'catch', goal: 70, coins: 110, xp: 65 },
  { type: 'win', goal: 45, coins: 150, xp: 90 },
];
const MISSION_COUNT = 3;
const weekId = () => 'w' + Math.floor((Date.now() / 86400000 - 4) / 7);
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
/** Ensure the colony has this week's missions; returns true if it regenerated. */
function ensureMissions(c) {
  if (!c) return false;
  const wk = weekId();
  if (c.missionWeek === wk && Array.isArray(c.missions) && c.missions.length) return false;
  const start = hashStr(c.id + wk) % MISSION_POOL.length;
  c.missionWeek = wk;
  c.missions = Array.from({ length: MISSION_COUNT }, (_, i) => {
    const m = MISSION_POOL[(start + i) % MISSION_POOL.length];
    return { id: `${wk}_${i}`, type: m.type, goal: m.goal, coins: m.coins, xp: m.xp, progress: 0, claimedBy: [] };
  });
  if (typeof c.missionsDone !== 'number') c.missionsDone = 0; // all-time completed (colony progression)
  return true;
}
/** Add collective progress to every active mission of `type`. Returns true if any moved. */
function addProgress(c, type, amount) {
  ensureMissions(c);
  let changed = false;
  const amt = Math.max(1, Math.min(100, amount | 0));
  for (const m of c.missions) {
    if (m.type === type && m.progress < m.goal) {
      m.progress = Math.min(m.goal, m.progress + amt);
      changed = true;
    }
  }
  return changed;
}
/** One member claims a completed mission's reward (once). */
function claimMission(c, uid, mid) {
  ensureMissions(c);
  const m = c.missions.find((x) => x.id === mid);
  if (!m) return { error: 'no-mission' };
  if (m.progress < m.goal) return { error: 'incomplete' };
  if (!c.members.some((x) => x.uid === uid)) return { error: 'not-member' };
  if (m.claimedBy.includes(uid)) return { error: 'claimed' };
  m.claimedBy.push(uid);
  if (m.claimedBy.length === 1) c.missionsDone = (c.missionsDone || 0) + 1; // first claim = colony completed it
  return { reward: { coins: m.coins, xp: m.xp } };
}

// ---- Phase 4: colony research (shared bank -> economy perks) ----
// Members donate their coins into the colony BANK; a leader/elder spends the bank
// to level up economy PERKS that benefit every member (applied CLIENT-side to
// battle/tower/ghost rewards). Coins are client-side (not server-authoritative)
// so the bank is self-reported — bounded per contribution; the perks are shared
// so there's no incentive to cheat (same trust model as the leaderboard).
const PERK_IDS = ['coins', 'xp', 'drop'];
const PERK_MAX = 5;
const perkCost = (level) => 500 * (level + 1); // 500,1000,1500,2000,2500 -> 7500 to max one
const MAX_CONTRIB = 100000; // per contribution message

function ensurePerks(c) {
  if (!c) return false;
  let changed = false;
  if (typeof c.bank !== 'number') {
    c.bank = 0;
    changed = true;
  }
  if (!c.perks || typeof c.perks !== 'object') {
    c.perks = { coins: 0, xp: 0, drop: 0 };
    changed = true;
  } else {
    for (const p of PERK_IDS)
      if (typeof c.perks[p] !== 'number') {
        c.perks[p] = 0;
        changed = true;
      }
  }
  return changed;
}
/** A member donates coins into the shared bank (client already checked it can pay). */
function contribute(c, uid, amount) {
  ensurePerks(c);
  if (!c.members.some((m) => m.uid === uid)) return { error: 'not-member' };
  const amt = Math.max(1, Math.min(MAX_CONTRIB, amount | 0));
  c.bank += amt;
  return { ok: true, amount: amt, bank: c.bank };
}
/** A leader/elder spends the bank to level up a perk. */
function research(c, uid, perkId) {
  ensurePerks(c);
  if (!PERK_IDS.includes(perkId)) return { error: 'bad-perk' };
  if (!['leader', 'elder'].includes(roleOf(c, uid))) return { error: 'auth' };
  const level = c.perks[perkId] | 0;
  if (level >= PERK_MAX) return { error: 'maxed' };
  const cost = perkCost(level);
  if (c.bank < cost) return { error: 'poor' };
  c.bank -= cost;
  c.perks[perkId] = level + 1;
  return { ok: true, perk: perkId, level: c.perks[perkId], bank: c.bank };
}

// ---- Phase 4b: card requests / donations ----
// A member posts ONE open request ("I need a card", optional tribe wish); a
// colony-mate fulfils it by DONATING one of their spare cats (given away, not
// copied). Delivery is async via a durable per-uid mailbox (index.js) so the
// recipient gets it even if offline. Requests live on the colony object.
const REQUEST_COOLDOWN = 20 * 60000; // 20 min between a member's requests

function ensureRequests(c) {
  if (!c) return false;
  if (!c.requests || typeof c.requests !== 'object') {
    c.requests = {};
    return true;
  }
  return false;
}
/** Post/refresh a member's open request. Rate-limited per member. */
function postRequest(c, uid, name, tribe, now) {
  ensureRequests(c);
  if (!c.members.some((m) => m.uid === uid)) return { error: 'not-member' };
  const cur = c.requests[uid];
  if (cur && now - (cur.at || 0) < REQUEST_COOLDOWN) return { error: 'cooldown' };
  c.requests[uid] = { name: clean(name, 20), tribe: clean(tribe, 12), at: now };
  return { ok: true };
}
function clearRequest(c, uid) {
  ensureRequests(c);
  if (c.requests[uid]) {
    delete c.requests[uid];
    return true;
  }
  return false;
}

// ---- Phase 6: weekly colony RAID BOSS (co-op PvE) ---------------------------
// A shared-HP boss the whole colony chips at with their decks. Damage pools;
// when HP hits 0 the boss is defeated and members who contributed can each claim
// a reward (base + a share-scaled bonus). Resets weekly like missions.
const BOSS_HP_BASE = 4000;
const BOSS_HP_PER_MEMBER = 5000;
const BOSS_HP_PER_WIN = 3000; // each all-time defeat makes the NEXT boss this much tougher
const BOSS_ATTACK_CAP = 700; // max damage credited per single attack (anti-cheat)
const BOSS_REWARD_COINS = 250; // base coins per contributing member on defeat
const BOSS_REWARD_XP = 150;
const BOSS_TOP_BONUS = 500; // extra coins pooled by contribution share
const BOSS_REWARD_PER_WIN = 25; // extra base coins per boss level (tougher boss pays more)
const BOSS_XP_PER_WIN = 15;
const BOSS_FLOOR = 8; // buildTowerDeck difficulty the client fights (mirrored client-side)

// HP scales with BOTH the colony size AND how many times the colony has already
// slain the boss (a permanent, all-time progression → each kill raises the bar).
const bossMaxHp = (members, wins) =>
  BOSS_HP_BASE + BOSS_HP_PER_MEMBER * Math.max(1, members) + BOSS_HP_PER_WIN * Math.max(0, wins | 0);
/** damage a single reported battle deals (server-computed from win/lanes, capped) */
const bossDamage = (win, lanes) => (win ? Math.min(BOSS_ATTACK_CAP, 300 + Math.max(0, Math.min(3, lanes | 0)) * 130) : 60);

/** Ensure this week's boss exists (HP locked at week start). Returns true if reset.
 * `c.bossWins` = all-time kills, never reset — it drives the HP/level ramp. */
function ensureBoss(c) {
  if (!c) return false;
  if (typeof c.bossWins !== 'number') c.bossWins = 0; // migrate older colonies
  const wk = weekId();
  if (c.boss && c.boss.week === wk) return false;
  const hp = bossMaxHp(c.members.length, c.bossWins);
  // level = kills so far + 1 (this week's boss is the (bossWins+1)th the clan faces)
  c.boss = { week: wk, maxHp: hp, hp, contrib: {}, defeated: false, claimedBy: [], level: c.bossWins + 1 };
  return true;
}
/** A member reports a battle vs the boss; server credits capped damage. */
function attackBoss(c, uid, win, lanes) {
  ensureBoss(c);
  if (!c.members.some((m) => m.uid === uid)) return { error: 'not-member' };
  const b = c.boss;
  if (b.defeated) return { error: 'defeated' };
  const dmg = bossDamage(win, lanes);
  b.hp = Math.max(0, b.hp - dmg);
  b.contrib[uid] = (b.contrib[uid] || 0) + dmg;
  if (b.hp <= 0 && !b.defeated) {
    b.defeated = true;
    c.bossWins = (c.bossWins | 0) + 1; // permanent kill count → next week's boss is tougher
  }
  return { ok: true, dmg, hp: b.hp, maxHp: b.maxHp, defeated: b.defeated };
}
/** Claim the on-defeat reward once (only if you contributed damage). */
function claimBossReward(c, uid) {
  ensureBoss(c);
  const b = c.boss;
  if (!b.defeated) return { error: 'alive' };
  if (!c.members.some((m) => m.uid === uid)) return { error: 'not-member' };
  if ((b.contrib[uid] || 0) <= 0) return { error: 'no-contrib' };
  if (b.claimedBy.includes(uid)) return { error: 'claimed' };
  const share = b.maxHp > 0 ? (b.contrib[uid] || 0) / b.maxHp : 0;
  // tougher (higher-level) bosses pay more. level = kills already banked (this
  // boss is the level-th; the level-1 wins before it earn the per-win bump).
  const lvlBonus = Math.max(0, (b.level | 0) - 1);
  const coins = BOSS_REWARD_COINS + BOSS_REWARD_PER_WIN * lvlBonus + Math.round(BOSS_TOP_BONUS * Math.min(1, share));
  const xp = BOSS_REWARD_XP + BOSS_XP_PER_WIN * lvlBonus;
  b.claimedBy.push(uid);
  return { ok: true, coins, xp };
}

/** Permanent prestige accumulators (all-time; survive week rollovers, never reset).
 * `glory` = points earned from tournament placement; `titles` = tournaments won. */
function ensureGlory(c) {
  if (!c) return false;
  let changed = false;
  if (typeof c.glory !== 'number') {
    c.glory = 0;
    changed = true;
  }
  if (typeof c.titles !== 'number') {
    c.titles = 0;
    changed = true;
  }
  return changed;
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
  ensureMissions(colony); // seed this week's missions on creation
  ensurePerks(colony); // seed the empty research bank/perks
  ensureGlory(colony); // seed permanent glory/titles at 0
  ensureBoss(colony); // seed this week's raid boss
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
  ensureMissions,
  addProgress,
  claimMission,
  ensurePerks,
  contribute,
  research,
  PERK_IDS,
  PERK_MAX,
  perkCost,
  ensureRequests,
  postRequest,
  clearRequest,
  ensureGlory,
  ensureBoss,
  attackBoss,
  claimBossReward,
  BOSS_FLOOR,
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
  /** All-time colony ranking by titles then glory. Reads every colony (fine at
   * a friends scale); returns slim rows for the client board. */
  async leaderboard(limit = 20) {
    const ids = await store.smembers(COLS);
    const cols = [];
    for (const id of ids) {
      const c = await get(id);
      if (!c) continue;
      ensureGlory(c);
      cols.push(c);
    }
    cols.sort(
      (a, b) => b.titles - a.titles || b.glory - a.glory || b.members.length - a.members.length,
    );
    return cols.slice(0, limit).map((c) => ({
      id: c.id,
      name: c.name,
      emoji: c.emoji,
      glory: c.glory,
      titles: c.titles,
      members: c.members.length,
    }));
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
