// Colonies — Phase 3: inter-colony tournaments (weekly single-elimination bracket).
// Durable via store.js. Colonies JOIN during the open week; a leader STARTS it,
// which seeds a bracket from the entrants (sorted by colony strength, padded to a
// power of two with byes) and resolves every round DETERMINISTICALLY from each
// colony's strength + a seeded jitter (so there are upsets, but it's reproducible
// and needs nobody online). Winner + finalist colonies get claimable rewards.
//
// index.js owns the socket layer and computes each entrant's `strength`/`champion`
// (it has the live leaderboard decks); this module is pure tournament logic so it's
// unit-testable without a server.
const store = require('./store');

const CUR = 'tour:cur'; // the active/most-recent tournament
const LAST = 'tour:last'; // the previous finished tournament (for "last winner")
const MAX_ENTRANTS = 16;

const weekId = () => 'w' + Math.floor((Date.now() / 86400000 - 4) / 7);
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296; // 0..1
}

// reward table by final placement
const REWARDS = {
  1: { coins: 300, xp: 200 },
  2: { coins: 150, xp: 100 },
};

function freshTournament(week) {
  return { week, state: 'open', entrants: [], bracket: [], winner: null, rewards: {}, claimedBy: [], startedAt: 0 };
}

/** Get the current tournament, rolling a new OPEN one when the week flips. */
async function current() {
  const wk = weekId();
  let t = await store.get(CUR);
  if (!t || t.week !== wk) {
    if (t && t.state === 'done') await store.set(LAST, t); // keep last week's result
    t = freshTournament(wk);
    await store.set(CUR, t);
  }
  return t;
}
async function last() {
  return store.get(LAST);
}
async function save(t) {
  await store.set(CUR, t);
}

/** Add (or refresh) a colony entrant while the tournament is OPEN. */
function join(t, entrant) {
  if (t.state !== 'open') return { error: 'closed' };
  if (!entrant || !entrant.colonyId) return { error: 'bad' };
  const i = t.entrants.findIndex((e) => e.colonyId === entrant.colonyId);
  if (i >= 0) {
    t.entrants[i] = { ...t.entrants[i], ...entrant }; // refresh strength/champion
    return { ok: true, refreshed: true };
  }
  if (t.entrants.length >= MAX_ENTRANTS) return { error: 'full' };
  t.entrants.push(entrant);
  return { ok: true };
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Resolve one match deterministically from strength + seeded jitter. Returns a
 * match record with flavor scores (0..3 "lanes" won). Byes auto-advance. */
function simMatch(a, b, salt) {
  if (a && a.bye) return mk(a, b, 0, 3, b);
  if (b && b.bye) return mk(a, b, 3, 0, a);
  const ja = a.strength * (0.8 + 0.4 * hashStr(salt + a.colonyId + b.colonyId));
  const jb = b.strength * (0.8 + 0.4 * hashStr(salt + b.colonyId + a.colonyId));
  const winner = ja >= jb ? a : b;
  // map the margin to a 3-lane scoreline for flavor
  const ratio = ja + jb > 0 ? Math.abs(ja - jb) / (ja + jb) : 0;
  const margin = ratio > 0.35 ? 3 : ratio > 0.15 ? 2 : 1;
  const win = 3;
  const lose = win - margin;
  return ja >= jb ? mk(a, b, win, lose, winner) : mk(a, b, lose, win, winner);
}
function mk(a, b, aScore, bScore, winner) {
  return {
    aId: a ? a.colonyId : null,
    bId: b ? b.colonyId : null,
    aName: a ? a.name : '—',
    bName: b ? b.name : '—',
    aEmoji: a ? a.emoji : '',
    bEmoji: b ? b.emoji : '',
    aScore,
    bScore,
    winnerId: winner ? winner.colonyId : null,
  };
}

/** Seed + simulate the whole bracket. Needs >= 2 entrants. */
function start(t) {
  if (t.state !== 'open') return { error: 'closed' };
  if (t.entrants.length < 2) return { error: 'not-enough' };
  const salt = t.week + ':';
  // seed strongest-first, then pad to a power of two with byes
  const seeded = [...t.entrants].sort((x, y) => y.strength - x.strength);
  const size = nextPow2(seeded.length);
  while (seeded.length < size) seeded.push({ colonyId: `bye${seeded.length}`, name: '—', emoji: '', strength: -1, bye: true });
  // standard 1 vs N seeding order
  let order = [0];
  while (order.length < size) {
    const n = order.length * 2;
    const next = [];
    for (const s of order) {
      next.push(s);
      next.push(n - 1 - s);
    }
    order = next;
  }
  let round = order.map((idx) => seeded[idx]);
  const bracket = [];
  while (round.length > 1) {
    const matches = [];
    const winners = [];
    for (let i = 0; i < round.length; i += 2) {
      const m = simMatch(round[i], round[i + 1], salt + bracket.length + '_' + i + '_');
      matches.push(m);
      winners.push(m.winnerId === (round[i] && round[i].colonyId) ? round[i] : round[i + 1]);
    }
    bracket.push(matches);
    round = winners;
  }
  const champ = round[0];
  t.bracket = bracket;
  t.winner = champ ? { colonyId: champ.colonyId, name: champ.name, emoji: champ.emoji } : null;
  t.state = 'done';
  t.startedAt = Date.now();
  // rewards: winner + the finalist it beat in the last round
  t.rewards = {};
  if (champ) t.rewards[champ.colonyId] = { ...REWARDS[1], place: 1 };
  const finalMatches = bracket[bracket.length - 1] || [];
  const finalMatch = finalMatches[0];
  if (finalMatch) {
    const loserId = finalMatch.winnerId === finalMatch.aId ? finalMatch.bId : finalMatch.aId;
    if (loserId && !String(loserId).startsWith('bye')) t.rewards[loserId] = { ...REWARDS[2], place: 2 };
  }
  return { ok: true };
}

/** A member of a placed colony claims its reward once. */
function claim(t, colonyId, uid) {
  if (t.state !== 'done') return { error: 'not-done' };
  const r = t.rewards[colonyId];
  if (!r) return { error: 'no-reward' };
  if (t.claimedBy.includes(uid)) return { error: 'claimed' };
  t.claimedBy.push(uid);
  return { reward: { coins: r.coins, xp: r.xp, place: r.place } };
}

module.exports = { current, last, save, join, start, claim, weekId, MAX_ENTRANTS, REWARDS };
