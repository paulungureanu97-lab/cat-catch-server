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
const HIST = 'tour:hist'; // slim summaries of past tournaments (the war chronicle)
const HIST_MAX = 12;
const MAX_ENTRANTS = 16;
const MAX_ATTACKS = 2; // attacks per member per feud
const DAY = 86400000; // a feud lasts at most 24h

const weekId = () => 'w' + Math.floor((Date.now() / 86400000 - 4) / 7);

const REWARDS = { 1: { coins: 300, xp: 200 }, 2: { coins: 150, xp: 100 } };
// Permanent prestige for the all-time colony leaderboard (applied by index.js to
// the durable colony records once a tournament is done). Champion also +1 title.
const GLORY_CHAMP = 100;
const GLORY_FINALIST = 50;
const GLORY_PART = 15; // participation for every real entrant

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

/** Archive a tournament: keep the full object as LAST (claims stay valid from
 * there), append a slim summary to the history chronicle when it finished, and
 * drop its per-feud replay keys (replays only live as long as their war). */
async function archive(t) {
  if (!t) return;
  if (t.state === 'done') {
    await store.set(LAST, t);
    const hist = (await store.get(HIST)) || [];
    hist.push({
      week: t.week,
      at: t.finishedAt || Date.now(),
      entrants: t.entrants.length,
      winner: t.winner ? { name: t.winner.name, emoji: t.winner.emoji } : null,
      second: t.second ? { name: t.second.name, emoji: t.second.emoji } : null,
    });
    while (hist.length > HIST_MAX) hist.shift();
    await store.set(HIST, hist);
  }
  if (t.feuds) {
    for (const fid of Object.keys(t.feuds)) {
      try {
        await store.del(`replays:${t.week}:${fid}`);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

async function current() {
  const wk = weekId();
  let t = await store.get(CUR);
  if (!t || t.week !== wk) {
    if (t) await archive(t);
    t = freshTournament(wk);
    await store.set(CUR, t);
  }
  return t;
}
const last = () => store.get(LAST);
const save = (t) => store.set(CUR, t);
const saveLast = (t) => store.set(LAST, t);
const history = () => store.get(HIST);

/** Roll a fresh tournament as soon as the last one is DONE — no waiting for the
 * Monday flip. The done tournament is archived first, so unclaimed rewards stay
 * claimable from LAST. (Glory stays capped by the per-week dedupe in index.js's
 * applyGlory — rapid re-tournaments can't farm titles.) */
async function startNew(t) {
  if (!t || t.state !== 'done') {
    return { error: t && t.state === 'running' ? 'running' : 'not-done' };
  }
  await archive(t);
  const fresh = freshTournament(weekId());
  await store.set(CUR, fresh);
  return { ok: true, tournament: fresh };
}

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
  // tie vs a BOT -> the real colony wins (bot summed strength is inflated by
  // roster size, so the old higher-seed rule handed every tie to the bot)
  else if (isBot(feud.aId) !== isBot(feud.bId)) winner = isBot(feud.aId) ? feud.bId : feud.aId;
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
  const loserId = finalFeud.winnerId === finalFeud.aId ? finalFeud.bId : finalFeud.aId;
  // bots can't claim, so a bot on the podium would LOCK that reward away —
  // redirect podium places to the best-placed REAL colonies (bracket/winner
  // still show the truth; only the claimable rewards move).
  let first = champId && !isBot(champId) ? champId : null;
  let second = loserId && !isBot(loserId) ? loserId : null;
  if (!first && second) {
    first = second; // real finalist beaten by a bot champion -> takes place 1
    second = null;
  }
  if (!first || !second) {
    // fill remaining podium spots with the real colonies eliminated deepest
    const placed = new Set([first, second].filter(Boolean));
    outer: for (let r = t.rounds.length - 1; r >= 0; r--) {
      for (const fid of t.rounds[r]) {
        const f = t.feuds[fid];
        if (!f) continue;
        for (const cid of [f.aId, f.bId]) {
          if (cid && !isBot(cid) && !placed.has(cid)) {
            if (!first) first = cid;
            else if (!second) second = cid;
            placed.add(cid);
            if (first && second) break outer;
          }
        }
      }
    }
  }
  if (first) t.rewards[first] = { ...REWARDS[1], place: 1 };
  if (second) t.rewards[second] = { ...REWARDS[2], place: 2 };
  // remember the runner-up + finish time for the war chronicle (history)
  t.second = second ? { colonyId: second, name: nameOf(t, second), emoji: emojiOf(t, second) } : null;
  t.finishedAt = Date.now();

  // Permanent glory awards (aligned with the visible podium so the colony shown
  // as place 1 also earns the championship title). Applied ONCE by index.js —
  // it reads t.gloryAwards and flips t.gloryApplied. Every real entrant earns a
  // little participation glory; the podium earns more. Bots (no colony record)
  // are excluded.
  const awards = {};
  for (const cid of Object.keys(t.rosters || {})) {
    if (!isBot(cid)) awards[cid] = { glory: GLORY_PART, titles: 0 };
  }
  if (second && !isBot(second)) awards[second] = { glory: GLORY_FINALIST, titles: 0 };
  if (first && !isBot(first)) awards[first] = { glory: GLORY_CHAMP, titles: 1 };
  t.gloryAwards = awards;
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
function attack(t, feudId, uid, oppName, win, lanes, now, attackerColonyId, replayId) {
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
  const entry = { colonyId: cid, byUid: uid, byName, oppName: String(oppName || '').slice(0, 20), win: w, lanes: lanes | 0, at: now };
  if (replayId) entry.replayId = String(replayId);
  f.log.push(entry);
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
  let activated = [];
  if (done) activated = tick(t, now).activated; // next-round feuds this resolution unlocked
  return {
    ok: true,
    attacksLeft: MAX_ATTACKS - f.attacks[uid],
    resolved: done,
    activated,
    // for the live colony feed pushed by index.js
    colonyId: cid,
    byName,
    aScore: f.aScore,
    bScore: f.bScore,
  };
}

function claim(t, colonyId, uid) {
  if (t.state !== 'done') return { error: 'not-done' };
  const r = t.rewards[colonyId];
  if (!r) return { error: 'no-reward' };
  if (t.claimedBy.includes(uid)) return { error: 'claimed' };
  t.claimedBy.push(uid);
  return { reward: { coins: r.coins, xp: r.xp, place: r.place } };
}

// ---- bot colonies (see bots.js) — a bot has no device to play on, so the server
// SIMULATES its feud attacks here. Real players still battle the bot's decks
// on-device exactly like a human opponent; this only drives the bot's own score. ----

const isBot = (id) => typeof id === 'string' && id.indexOf('bot:') === 0;

/** true when every roster member of `colId` has used all their attacks (or the
 * roster is empty). Same rule as attack()'s early-finish, reused for bot feuds. */
function membersExhausted(t, f, colId) {
  const roster = t.rosters[colId] || [];
  if (!roster.length) return true;
  return roster.every((m) => (f.attacks[m.uid] || 0) >= MAX_ATTACKS);
}

/** Bot win chance per simulated attack, from relative PER-MEMBER strength (total
 * strength is a sum over members, so comparing totals let member COUNT — not deck
 * quality — pin the probability at the ceiling vs small colonies). Centered
 * slightly BELOW 0.5 so an ACTIVE human colony that wins its battles beats the
 * bot, while an ABSENT one still loses to it (keeps stakes real). Tunable. */
function botWinProb(t, botId, oppId) {
  const per = (id) => (strengthOf(t, id) || 1) / Math.max(1, (t.rosters[id] || []).length);
  const bs = per(botId);
  const os = per(oppId);
  const p = 0.45 + 0.4 * ((bs - os) / (bs + os));
  return Math.max(0.2, Math.min(0.62, p));
}

/** Simulate bot-colony attacks in active feuds. A bot PACES its attacks across the
 * 24h window so the score climbs live; a feud where the human side already used
 * every attack — or that is bot-vs-bot — is fast-forwarded and resolved at once so
 * the bracket never stalls. Cascades (via tick) until stable. `rng` is injectable
 * for deterministic tests. Returns true if anything changed. */
function tickBots(t, now, rng) {
  if (t.state !== 'running') return { activated: [], changed: false };
  const r = typeof rng === 'function' ? rng : Math.random;
  const activated = [];
  let any = false;
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 128) {
    changed = false;
    // 1) simulate bot attacks BEFORE resolving deadlines — so an ABSENT human
    //    loses to a bot that accrued points over the window (rather than a 0-0
    //    tie broken by seed) once the feud is read after its deadline.
    for (const id of Object.keys(t.feuds)) {
      const f = t.feuds[id];
      if (f.state !== 'active') continue;
      const aBot = isBot(f.aId);
      const bBot = isBot(f.bId);
      if (!aBot && !bBot) continue;
      for (const side of ['a', 'b']) {
        const cid = side === 'a' ? f.aId : f.bId;
        if (!isBot(cid)) continue;
        const oppId = side === 'a' ? f.bId : f.aId;
        const roster = t.rosters[cid] || [];
        if (!roster.length) continue;
        // FAIRNESS: the bot's attack budget is capped at the OPPONENT side's
        // capacity — raw win-counts are compared at resolve, so a 3-member bot
        // with 6 attacks would structurally bury a solo colony's max 2 wins.
        const oppMembers = Math.max(1, (t.rosters[oppId] || []).length);
        const cap = Math.min(roster.length, oppMembers) * MAX_ATTACKS;
        // fast-forward when there's no human left to wait for (bot-vs-bot, human
        // exhausted, or the deadline passed), else pace by elapsed time
        const fastForward = (aBot && bBot) || membersExhausted(t, f, oppId) || now >= f.deadline;
        const frac = Math.max(0, Math.min(1, (now - (f.deadline - DAY)) / DAY));
        // pace by elapsed time, but with an EARLY FLOOR so the bot lands its
        // first attack ~1h in instead of doing nothing for hours — a paced
        // `floor(frac*cap)` leaves cap-2 bots at 0 until the 12h mark, which
        // reads as "the bots never fight back". (cap >= 2 always, so the +1
        // floor can't exceed cap.)
        const target = fastForward ? cap : Math.max(Math.floor(frac * cap), frac >= 0.04 ? 1 : 0);
        let done = roster.reduce((s, m) => s + Math.min(MAX_ATTACKS, f.attacks[m.uid] || 0), 0);
        const oppRoster = t.rosters[oppId] || [];
        const p = botWinProb(t, cid, oppId);
        while (done < target) {
          const m = roster.find((mm) => (f.attacks[mm.uid] || 0) < MAX_ATTACKS);
          if (!m) break;
          f.attacks[m.uid] = (f.attacks[m.uid] || 0) + 1;
          const win = r() < p;
          const opp = oppRoster.length ? oppRoster[Math.floor(r() * oppRoster.length)] : null;
          f.log.push({ colonyId: cid, byUid: m.uid, byName: m.name, oppName: opp ? opp.name : '—', win, lanes: win ? 2 : 1, at: now, bot: true });
          if (f.log.length > 200) f.log.shift();
          if (win) {
            if (cid === f.aId) f.aScore += 1;
            else f.bScore += 1;
          }
          done += 1;
          changed = true;
          any = true;
        }
      }
      // a bot side is "exhausted" once it reached its (possibly capped) budget:
      // when both sides can do nothing more, close the feud early
      const sideDone = (colId, otherId) => {
        if (!isBot(colId)) return membersExhausted(t, f, colId);
        const cap = Math.min((t.rosters[colId] || []).length, Math.max(1, (t.rosters[otherId] || []).length)) * MAX_ATTACKS;
        const used = (t.rosters[colId] || []).reduce((s, m) => s + Math.min(MAX_ATTACKS, f.attacks[m.uid] || 0), 0);
        return used >= cap;
      };
      if (f.state === 'active' && sideDone(f.aId, f.bId) && sideDone(f.bId, f.aId)) {
        resolveFeud(t, f, now);
        changed = true;
        any = true;
      }
    }
    // 2) resolve deadlines, activate ready feuds, finish the tournament —
    //    COLLECT the activated feud ids (they drive the feud-start notification;
    //    dropping them silenced every bot-driven round advance)
    const res = tick(t, now);
    if (res.activated.length) activated.push(...res.activated);
    if (res.changed) {
      changed = true;
      any = true;
    }
  }
  return { activated: [...new Set(activated)], changed: any };
}

module.exports = { current, last, save, saveLast, join, start, startNew, history, tick, tickBots, isBot, attack, claim, weekId, MAX_ENTRANTS, MAX_ATTACKS, DAY, REWARDS };
