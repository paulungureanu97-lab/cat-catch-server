// server/botReplay.js — real, watchable replays for BOT feud attacks.
//
// Bot attacks used to be pure bookkeeping (a win-probability roll), so the war
// log had nothing to rewatch. This module actually PLAYS the battle with a
// faithful replica of the on-device engine (greedy AI both sides, the tribe
// ring, the per-cost power cap, all 14 reveal abilities + the end-of-turn GROW
// tick, per-lane reveal order) and records per-turn board snapshots in the
// EXACT FeudReplay shape the client already renders (net.ts / replay.tsx) —
// so existing 1.62+ apps can watch bot attacks with zero client changes.
//
// The credited outcome stays botWinProb's roll (the carefully-tuned fairness
// budget): we re-simulate up to MAX_TRIES times until a match agrees with it,
// and SKIP the replay when none does (an improbable upset with no honest
// footage beats fabricated footage). Pure logic + injectable rng → testable.

const LANES = 3;
const MAX_TURNS = 6;
const START_HAND = 3;
const LANE_CAP = 4;
const DECK_SIZE = 12;
const TRIBE_EDGE = 2;
const MAX_TRIES = 20;

// mirrors src/game/battle/tribes.ts BEATS ring + src/game/power.ts cap
const BEATS = { Hunter: 'Sleepy', Sleepy: 'Mischief', Mischief: 'Regal', Regal: 'Chonky', Chonky: 'Feral', Feral: 'Hunter' };
const GROW = 'At the end of each turn: +1 Power.';
const cappedPower = (p, cost) => Math.min(p, 25 + 10 * (cost | 0));
const hasEdge = (card, enemies) => enemies.some((e) => BEATS[card.tribe] === e.tribe);
const laneScore = (mine, enemies) =>
  mine.reduce((s, c) => s + cappedPower(c.power, c.cost) + (hasEdge(c, enemies) ? TRIBE_EDGE : 0), 0);
const totPower = (cards) => cards.reduce((s, c) => s + c.power, 0);

// the always-unlocked early worlds — a plausible stage for a bot's battle
const REPLAY_MAPS = ['garden', 'forest', 'savanna', 'rooftop', 'alley', 'arena', 'castle'];

function shuffle(arr, rand) {
  const r = [...arr];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

function toCard(c, owner) {
  return {
    name: String((c && c.name) || '—').slice(0, 16),
    rarity: String((c && c.rarity) || 'common').slice(0, 10),
    cost: (c && c.cost) | 0,
    power: (c && c.power) | 0,
    tribe: String((c && c.tribe) || '').slice(0, 12),
    ability: String((c && c.ability) || ''),
    owner,
    revealed: false,
  };
}

// mirrors src/game/battle/abilities.ts applyReveal 1:1
function applyReveal(card, lanes, laneIdx) {
  const lane = lanes[laneIdx];
  const mine = card.owner === 'me' ? lane.me : lane.foe;
  const enemy = card.owner === 'me' ? lane.foe : lane.me;
  const allies = mine.filter((c) => c !== card);
  switch (card.ability) {
    case 'When played: +1 Power for each ally sharing a tribe.':
      card.power += allies.filter((a) => a.tribe === card.tribe).length;
      break;
    case 'Reveals first — your other cats here get +1 Power.':
    case 'When played: +1 Power to your other cats here.':
      allies.forEach((a) => (a.power += 1));
      break;
    case 'Copies the highest Power among your other cats here.': {
      const max = allies.reduce((m, a) => Math.max(m, a.power), 0);
      if (max > 0) card.power = max;
      break;
    }
    case 'When played: -2 Power to the strongest enemy here.': {
      if (enemy.length) {
        const top = enemy.reduce((a, b) => (b.power > a.power ? b : a));
        top.power = Math.max(0, top.power - 2);
      }
      break;
    }
    case 'When played: +3 Power if you are losing this lane.':
      if (totPower(enemy) > totPower(mine)) card.power += 3;
      break;
    case 'When played: +1 Power per empty slot in this lane.':
      card.power += Math.max(0, LANE_CAP - mine.length);
      break;
    case 'Doubles its Power if it is your only cat here.':
      if (allies.length === 0) card.power *= 2;
      break;
    case 'When played: +1 Power to your cats in the other lanes.':
      lanes.forEach((l, i) => {
        if (i === laneIdx) return;
        (card.owner === 'me' ? l.me : l.foe).forEach((a) => (a.power += 1));
      });
      break;
    case 'Steals 1 Power from the weakest enemy here.': {
      if (enemy.length) {
        const weak = enemy.reduce((a, b) => (b.power < a.power ? b : a));
        if (weak.power > 0) {
          weak.power -= 1;
          card.power += 1;
        }
      }
      break;
    }
    case 'When played: +2 Power if an ally here shares its tribe.':
      if (allies.some((a) => a.tribe === card.tribe)) card.power += 2;
      break;
    case 'When played: -1 Power to every enemy here.':
      enemy.forEach((e) => {
        e.power = Math.max(1, e.power - 1);
      });
      break;
    case 'When played: +4 Power if this lane is full.':
      if (mine.length >= LANE_CAP) card.power += 4;
      break;
    default:
      break;
  }
}

// mirrors engine.greedyPlay: highest affordable power into the most-behind lane
function greedyPlay(lanes, hand, side, energy) {
  const other = side === 'me' ? 'foe' : 'me';
  for (;;) {
    const affordable = hand.filter((c) => c.cost <= energy).sort((a, b) => b.power - a.power);
    if (affordable.length === 0) break;
    const open = [0, 1, 2].filter((i) => lanes[i][side].length < LANE_CAP);
    if (open.length === 0) break;
    const card = affordable[0];
    open.sort(
      (i, j) =>
        laneScore(lanes[i][side].concat(card), lanes[i][other]) - laneScore(lanes[i][other], lanes[i][side]) -
        (laneScore(lanes[j][side].concat(card), lanes[j][other]) - laneScore(lanes[j][other], lanes[j][side])),
    );
    const laneIdx = open[0];
    hand.splice(hand.indexOf(card), 1);
    lanes[laneIdx][side].push(card);
    energy -= card.cost;
  }
}

const snapCard = (c) => ({ name: c.name, rarity: c.rarity, tribe: c.tribe, power: c.power, cost: c.cost });

/** One full 6-turn match, attacker ('me') vs defender ('foe'), recording a
 * per-turn snapshot AFTER each turn (the client's snapshotTurn shape). */
function simulate(atkDeckSer, defDeckSer, rand) {
  const myDeck = shuffle((atkDeckSer || []).slice(0, DECK_SIZE).map((c) => toCard(c, 'me')), rand);
  const foeDeck = shuffle((defDeckSer || []).slice(0, DECK_SIZE).map((c) => toCard(c, 'foe')), rand);
  const lanes = Array.from({ length: LANES }, () => ({ me: [], foe: [] }));
  const myHand = [];
  const foeHand = [];
  const turns = [];
  const draw = (deck, hand, n) => {
    for (let i = 0; i < n && deck.length; i++) hand.push(deck.shift());
  };
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    draw(myDeck, myHand, turn === 1 ? START_HAND : 1);
    draw(foeDeck, foeHand, turn === 1 ? START_HAND : 1);
    greedyPlay(lanes, myHand, 'me', turn);
    greedyPlay(lanes, foeHand, 'foe', turn);
    // reveal lane by lane, attacker's cards before the defender's (engine order)
    for (let li = 0; li < LANES; li++) {
      const lane = lanes[li];
      [...lane.me, ...lane.foe]
        .filter((c) => !c.revealed)
        .forEach((c) => {
          applyReveal(c, lanes, li);
          c.revealed = true;
        });
    }
    for (const lane of lanes) for (const c of [...lane.me, ...lane.foe]) if (c.ability === GROW && c.revealed) c.power += 1;
    turns.push({
      lanes: lanes.map((l) => ({ me: l.me.map(snapCard), foe: l.foe.map(snapCard) })),
      scores: lanes.map((l) => [laneScore(l.me, l.foe), laneScore(l.foe, l.me)]),
    });
  }
  let myLanes = 0;
  let foeLanes = 0;
  let myTotal = 0;
  let foeTotal = 0;
  for (const lane of lanes) {
    const mp = laneScore(lane.me, lane.foe);
    const fp = laneScore(lane.foe, lane.me);
    myTotal += mp;
    foeTotal += fp;
    if (mp > fp) myLanes += 1;
    else if (fp > mp) foeLanes += 1;
  }
  const win = myLanes > foeLanes || (myLanes === foeLanes && myTotal > foeTotal);
  return { win, lanes: myLanes, turns };
}

/**
 * Build a watchable FeudReplay for a bot attack whose credited outcome is
 * `wantWin`. Re-simulates until a match agrees (≤ MAX_TRIES); returns
 * { data, lanes } or null when no honest footage matches the roll.
 * `seed` varies the map + sims deterministically per attack when rng is seeded.
 */
function buildBotReplay(byName, oppName, atkDeck, defDeck, wantWin, rng, seed, at) {
  if (!Array.isArray(atkDeck) || !atkDeck.length || !Array.isArray(defDeck) || !defDeck.length) return null;
  const r = typeof rng === 'function' ? rng : Math.random;
  for (let i = 0; i < MAX_TRIES; i++) {
    const res = simulate(atkDeck, defDeck, r);
    if (res.win === !!wantWin) {
      return {
        lanes: res.lanes,
        data: {
          v: 1,
          by: String(byName || '').slice(0, 20),
          opp: String(oppName || '').slice(0, 20),
          win: !!wantWin,
          lanes: res.lanes,
          at: at || Date.now(),
          map: REPLAY_MAPS[Math.abs(seed | 0) % REPLAY_MAPS.length],
          turns: res.turns,
        },
      };
    }
  }
  return null;
}

module.exports = { simulate, buildBotReplay, MAX_TRIES, REPLAY_MAPS };
