// Colonies — Phase 3 (v2): PLAYED inter-colony tournaments ("faide" / wars).
// A weekly single-elimination bracket where each matchup is a live 24h FEUD:
// members ATTACK an opposing colony member's deck (played on-device vs greedy AI,
// so nobody has to be online at once); each win = 1 war point for their colony.
// When a feud's 24h are up (or both sides used all attacks) the higher score wins
// and advances. Champion + finalist colonies get claimable rewards. Durable via
// store.js (keys tour:cur / tour:last). Rounds activate LAZILY on read (tick) so
// no server-side scheduler is needed on the free tier.
//
// index.js owns sockets + builds each colony's roster/strength from the live
// leaderboard decks; this module is pure logic (time is injected) so it unit-tests
// without a server.
const store = require('./store');

const CUR = 'tour:cur';
const LAST = 'tour:last';
const MAX_ENTRANTS = 16;
const MAX_ATTACKS = 2; // attacks per member per feud
const DAY = 86400000; // a feud lasts at most 24h

const weekId = () => 'w' + Math.floor((Date.now() / 86400000 - 4) / 7);

const REWARDS = { 1: { coins: 300, xp: 200 }, 2: { coins: 150, xp: 100 } };

function freshTournament(week) {
  return {
    week,
    state: 'open', // open -> running -> done
    entrants: [], // {colonyId, name, emoji, strength}
    rosters: {}, // colonyId -> [{uid, name, deck}]
    feuds: {}, // feudId -> Feud
    rounds: [], // [[feudId,...], ...]
    currentRound: 0,
    winner: null,
    rewards: {},
    claimedBy: [],
    startedAt: 0,
  };
}

async function current() {
  const wk = weekId();
  let t = await store.get(CUR);
  if (!t || t.week !== wk) {
    if (t && t.state === 'done') await store.set(LAST, t);
    t = freshTournament(wk);
    await store.set(CUR, t);
  }
  return t;
}
const last = () => store.get(LAST);
const save = (t) => store.set(CUR, t);

function join(t, entrant) {
  if (t.state !== 'open') return { error: 'closed' };
  if (!entrant || !entrant.colonyId) return { error: 'bad' };
  const slim = {
    colonyId: entrant.colonyId,
    name: entrant.name,
    emoji: entrant.emoji,
    strength: entrant.strength,
    trophies: entrant.trophies | 0,
  };
  const i = t.entrants.findIndex((e) => e.colonyId === entrant.colonyId);
  if (i >= 0) {
    t.entrants[i] = slim;
    t.rosters[entrant.colonyId] = entrant.roster || [];
    return { ok: true, refreshed: true };
  }
  if (t.entrants.length >= MAX_ENTRANTS) return { error: 'full' };
  t.entrants.push(slim);
  t.rosters[entrant.colonyId] = entrant.roster || [];
  return { ok: true };
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
const strengthOf = (t, id) => (t.entrants.find((e) => e.colonyId === id) || {}).strength || 0;
const nameOf = (t, id) => (t.entrants.find((e) => e.colonyId === id) || {}).name || '—';
const emojiOf = (t, id) => (t.entrants.find((e) => e.colonyId === id) || {}).emoji || '';

function newFeud(id, round) {
  return {
    id,
    round,
    aId: null,
    bId: null,
    aName: '—',
    bName: '—',
    aEmoji: '',
    bEmoji: '',
    deadline: 0,
    aScore: 0,
    bScore: 0,
    log: [], // {colonyId, byUid, byName, oppName, win, lanes, at}
    attacks: {}, // uid -> count
    state: 'pending', // pending -> active -> done
    winnerId: null,
  };
}
function setSide(t, feud, side, colonyId) {
  if (side === 'a') {
    feud.aId = colonyId;
    feud.aName = nameOf(t, colonyId);
    feud.aEmoji = emojiOf(t, colonyId);
  } else {
    feud.bId = colonyId;
    feud.bName = nameOf(t, colonyId);
    feud.bEmoji = emojiOf(t, colonyId);
  }
}
function activate(feud, now) {
  feud.state = 'active';
  feud.deadline = now + DAY;
}
/** send a resolved feud's winner up to its parent slot in the next round */
function propagate(t, feud) {
  const nextRound = feud.round + 1;
  if (nextRound >= t.rounds.length) return; // that was the final
  const childIdx = t.rounds[feud.round].indexOf(feud.id);
  const parentId = t.rounds[nextRound][childIdx >> 1];
  const parent = t.feuds[parentId];
  setSide(t, parent, childIdx % 2 === 0 ? 'a' : 'b', feud.winnerId);
}
function resolveFeud(t, feud, now) {
  if (feud.state === 'done') return;
  let winner;
  if (feud.aScore !== feud.bScore) winner = feud.aScore > feud.bScore ? feud.aId : feud.bId;
  else winner = strengthOf(t, feud.aId) >= strengthOf(t, feud.bId) ? feud.aId : feud.bId; // tie -> higher seed
  feud.winnerId = winner;
  feud.state = 'done';
  propagate(t, feud);
}

/** Seed the bracket, snapshot rosters, activate round 0. Needs >= 2 entrants.
 * FAIR MATCHMAKING: colonies are sorted by TROPHIES (fallback strength) and
 * paired ADJACENT (1st vs 2nd, 3rd vs 4th, ...) so every feud is between
 * colonies of similar level — the old 1-vs-N seeding pitted the strongest
 * against the weakest in round 1. Byes go to the top seeds. */
function start(t, now) {
  if (t.state !== 'open') return { error: 'closed' };
  if (t.entrants.length < 2) return { error: 'not-enough' };
  const seeded = [...t.entrants]
    .sort((a, b) => (b.trophies | 0) - (a.trophies | 0) || b.strength - a.strength)
    .map((e) => e.colonyId);
  const size = nextPow2(seeded.length);
  const numByes = size - seeded.length;
  // byed pairs first (top seeds skip round 0), then the rest paired adjacent —
  // this also guarantees no (bye vs bye) pair, which would hang the bracket
  const slots = [];
  for (let i = 0; i < numByes; i++) slots.push(seeded[i], null);
  for (let i = numByes; i < seeded.length; i++) slots.push(seeded[i]);
  const roundCount = Math.log2(size);
  // pre-create every feud slot in every round
  t.rounds = [];
  t.feuds = {};
  for (let r = 0; r < roundCount; r++) {
    const count = size >> (r + 1);
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = `${r}-${i}`;
      ids.push(id);
      t.feuds[id] = newFeud(id, r);
    }
    t.rounds.push(ids);
  }
  // fill round 0 from the seeded slots
  for (let i = 0; i < t.rounds[0].length; i++) {
    const feud = t.feuds[t.rounds[0][i]];
    const aId = slots[i * 2];
    const bId = slots[i * 2 + 1];
    if (aId) setSide(t, feud, 'a', aId);
    if (bId) setSide(t, feud, 'b', bId);
    if (aId && bId) activate(feud, now);
    else if (aId && !bId) {
      // bye: auto-advance the present side
      feud.winnerId = aId;
      feud.state = 'done';
      propagate(t, feud);
    }
  }
  t.state = 'running';
  t.startedAt = now;
  tick(t, now); // in case a whole round was byes
  return { ok: true, activated: t.rounds[0].filter((id) => t.feuds[id].state === 'active') };
}

/** Lazily resolve expired feuds and activate ready next-round feuds. Returns the
 * feud ids that BECAME active this tick (for notifications) plus a `changed`
 * flag — TRUE whenever ANY state mutated (a feud resolved by deadline, the
 * tournament finished, ...). Callers MUST persist when changed even if nothing
 * activated: a final that expires by its deadline mutates state->done with
 * activated=[] — dropping that save left rewards permanently unclaimable. */
function tick(t, now) {
  if (t.state !== 'running') return { activated: [], changed: false };
  const activated = [];
  let mutated = false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of Object.keys(t.feuds)) {
      const f = t.feuds[id];
      if (f.state === 'active' && now >= f.deadline) {
        resolveFeud(t, f, now);
        changed = true;
        mutated = true;
      }
    }
    // activate any pending feud whose both sides are now known
    for (const id of Object.keys(t.feuds)) {
      const f = t.feuds[id];
      if (f.state === 'pending' && f.aId && f.bId) {
        activate(f, now);
        activated.push(id);
        changed = true;
        mutated = true;
      }
    }
  }
  // tournament complete?
  const finalId = t.rounds[t.rounds.length - 1][0];
  const finalFeud = t.feuds[finalId];
  if (finalFeud && finalFeud.state === 'done' && t.state === 'running') {
    finishTournament(t, finalFeud);
    mutated = true;
  }
  return { activated, changed: mutated };
}

function finishTournament(t, finalFeud) {
  t.state = 'done';
  const champId = finalFeud.winnerId;
  t.winner = champId ? { colonyId: champId, name: nameOf(t, champId), emoji: emojiOf(t, champId) } : null;
  t.rewards = {};
  if (champId) t.rewards[champId] = { ...REWARDS[1], place: 1 };
  const loserId = finalFeud.winnerId === finalFeud.aId ? finalFeud.bId : finalFeud.aId;
  if (loserId) t.rewards[loserId] = { ...REWARDS[2], place: 2 };
}

/** Which colony (a or b) a uid belongs to in a feud, or null. */
function sideColony(t, feud, uid) {
  for (const cid of [feud.aId, feud.bId]) {
    if (cid && (t.rosters[cid] || []).some((m) => m.uid === uid)) return cid;
  }
  return null;
}

/** A member plays one attack in an active feud. `win` + `lanes` come from the
 * on-device battle result. `attackerColonyId` (optional) is the attacker's
 * CURRENT colony — when provided it must match their roster side, so someone
 * who left (or defected to the enemy colony) can no longer score for the old
 * roster snapshot. */
function attack(t, feudId, uid, oppName, win, lanes, now, attackerColonyId) {
  const f = t.feuds[feudId];
  if (!f) return { error: 'no-feud' };
  if (f.state !== 'active') return { error: 'not-active' };
  if (now >= f.deadline) return { error: 'expired' };
  const cid = sideColony(t, f, uid);
  if (!cid) return { error: 'not-in-feud' };
  if (attackerColonyId !== undefined && attackerColonyId !== cid) return { error: 'not-in-feud' };
  if ((f.attacks[uid] || 0) >= MAX_ATTACKS) return { error: 'no-attacks' };
  f.attacks[uid] = (f.attacks[uid] || 0) + 1;
  const w = !!win;
  const byName = (t.rosters[cid] || []).find((m) => m.uid === uid)?.name || '';
  f.log.push({ colonyId: cid, byUid: uid, byName, oppName: String(oppName || '').slice(0, 20), win: w, lanes: lanes | 0, at: now });
  if (f.log.length > 200) f.log.shift();
  if (w) {
    if (cid === f.aId) f.aScore += 1;
    else f.bScore += 1;
  }
  // early finish if BOTH sides have used every possible attack
  const usedAll = (colId) => {
    const roster = t.rosters[colId] || [];
    if (roster.length === 0) return true;
    return roster.every((m) => (f.attacks[m.uid] || 0) >= MAX_ATTACKS);
  };
  if (usedAll(f.aId) && usedAll(f.bId)) resolveFeud(t, f, now);
  const done = f.state === 'done';
  if (done) tick(t, now);
  return { ok: true, attacksLeft: MAX_ATTACKS - f.attacks[uid], resolved: done };
}

function claim(t, colonyId, uid) {
  if (t.state !== 'done') return { error: 'not-done' };
  const r = t.rewards[colonyId];
  if (!r) return { error: 'no-reward' };
  if (t.claimedBy.includes(uid)) return { error: 'claimed' };
  t.claimedBy.push(uid);
  return { reward: { coins: r.coins, xp: r.xp, place: r.place } };
}

module.exports = { current, last, save, join, start, tick, attack, claim, weekId, MAX_ENTRANTS, MAX_ATTACKS, DAY, REWARDS };
