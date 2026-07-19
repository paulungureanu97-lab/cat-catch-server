// server/bots.js — synthetic "bot" colonies so a colony feud (Phase-3 war) can
// ALWAYS run, even with very few real colonies (the cold-start problem: with 1–2
// real colonies the bracket is all byes and the war branch never develops).
//
// A bot colony is injected into the bracket at START (it tops the field up to a
// power-of-two, replacing byes). Its members carry generated decks that real
// players BATTLE on-device exactly like a human opponent (same SerCard shape as a
// leaderboard deck), and the bot's OWN attacks are simulated server-side by
// tournament.tickBots so the feud has two-sided tension. Bots never persist across
// weeks (a fresh weekly tournament regenerates them) and are never joinable.
//
// Pure logic + injectable rng → unit-testable without a server.

// mirrors of the app's constants (server is plain JS, can't import the TS game):
// src/game/achievements.ts ALL_TRIBES, src/game/catFactory.ts ABILITIES, DECK_SIZE=12
const TRIBES = ['Chonky', 'Feral', 'Regal', 'Sleepy', 'Mischief', 'Hunter'];
const ABILITIES = [
  'When played: +1 Power for each ally sharing a tribe.',
  'Reveals first — your other cats here get +1 Power.',
  'Copies the highest Power among your other cats here.',
  'When played: -2 Power to the strongest enemy here.',
  'When played: +3 Power if you are losing this lane.',
  'When played: +1 Power per empty slot in this lane.',
  'Doubles its Power if it is your only cat here.',
  'When played: +1 Power to your cats in the other lanes.',
  'When played: +1 Power to your other cats here.',
  'Steals 1 Power from the weakest enemy here.',
];
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'mythic'];
const DECK_SIZE = 12;

// themed pools so a bot colony reads like a real rival clan (26 identities —
// enough for a full 16-bracket without repeats, with variety week to week)
const COLONY_NAMES = [
  'Artigli Selvatici', "Branco d'Ombra", 'Zanne di Luna', 'Clan Rissa', 'Furie Randagie',
  'Vecchi Mici', 'Guardia Notturna', 'Predoni Felini', 'Baffi di Ferro', 'Ombre Feroci',
  'Gatti di Strada', 'Legione Micia', 'Grinfie Rosse', 'Spettri Pelosi', 'Tigri di Vicolo',
  'Cuccioli Ribelli',
  // 1.70.0 — 10 more rival clans so brackets feel like a living world
  'Sette Vite', 'Corte dei Randagi', 'Fauci del Tramonto', 'Micio Vendicatori',
  'Artiglio Dorato', 'Branco della Nebbia', 'Sentinelle del Tetto', 'Croccantini Cattivi',
  'Dinastia Soriana', 'Ultimi Graffi',
];
const COLONY_EMOJIS = ['😼', '🐾', '🦁', '🐆', '🐈‍⬛', '⚔️', '🔥', '🌑', '🗡️', '🐅', '💥', '🏴', '🌙', '👺', '🌋', '🛡️', '🏆', '🌫️', '🏙️', '😾', '👑', '🪓'];
const MEMBER_NAMES = [
  'Grinza', 'Zanna', 'Artiglio', 'Fumo', 'Brace', 'Cenere', 'Ombra', 'Ringhio',
  'Baffo', 'Scheggia', 'Furia', 'Notte', 'Lampo', 'Tuono', 'Rombo', 'Graffio',
  'Sibilo', 'Vespro', 'Ruggine', 'Tempesta', 'Spina', 'Gelo', 'Vampa', 'Randagio',
];
// per-colony personality: some clans are pushovers, some are terrors — a flat
// multiplier on the field's average card power (index-stable within a week)
const STRENGTH_PERSONALITY = [1.0, 0.85, 1.12, 0.92, 1.05, 0.8, 1.18, 0.95, 1.08, 0.88, 1.15, 0.9, 1.02, 0.82, 1.1, 0.97];

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
function isBot(id) {
  return typeof id === 'string' && id.indexOf('bot:') === 0;
}
const pick = (arr, r) => arr[Math.floor(r() * arr.length)];

/** A believable 12-card deck whose card power sits around `level` (the real
 * field's average card power), so on-device battles vs it are fair. */
function makeDeck(level, rng) {
  const r = typeof rng === 'function' ? rng : Math.random;
  const deck = [];
  for (let i = 0; i < DECK_SIZE; i++) {
    const roll = r();
    const rarity = roll < 0.5 ? 'common' : roll < 0.8 ? 'uncommon' : roll < 0.93 ? 'rare' : roll < 0.99 ? 'epic' : 'mythic';
    const tier = RARITIES.indexOf(rarity);
    const power = Math.max(1, Math.round(level + tier + (r() * 4 - 1.8)));
    const cost = Math.max(1, Math.min(7, Math.round(1 + tier * 1.2 + r() * 2)));
    deck.push({
      name: pick(MEMBER_NAMES, r),
      rarity,
      cost,
      power,
      tribe: pick(TRIBES, r),
      ability: pick(ABILITIES, r),
    });
  }
  return deck;
}

/** One bot colony: an entrant (bracket seed) + a roster of members with decks. */
function makeBotColony(week, index, opts, rng) {
  const r = typeof rng === 'function' ? rng : Math.random;
  const o = opts || {};
  // personality multiplier → easy prey AND scary contenders in the same bracket
  const personality = STRENGTH_PERSONALITY[index % STRENGTH_PERSONALITY.length];
  const level = Math.max(3, Math.round((o.level || 9) * personality));
  const trophies = Math.max(0, Math.round(((o.trophies || 0) + (r() * 240 - 120)) * personality));
  const members = 2 + Math.floor(r() * 3); // 2-4 members (capacity still capped in feuds)
  const roster = [];
  for (let i = 0; i < members; i++) {
    roster.push({
      uid: `bot:${week}:${index}:m${i}`,
      name: `${MEMBER_NAMES[(index * 3 + i) % MEMBER_NAMES.length]} ${i + 1}`,
      deck: makeDeck(level, r),
      bot: true,
    });
  }
  const strength = roster.reduce((s, m) => s + m.deck.reduce((a, c) => a + (c.power | 0), 0), 0);
  return {
    entrant: {
      colonyId: `bot:${week}:${index}`,
      name: COLONY_NAMES[index % COLONY_NAMES.length],
      emoji: COLONY_EMOJIS[index % COLONY_EMOJIS.length],
      strength,
      trophies,
      bot: true,
    },
    roster,
  };
}

/** Inject bot colonies into an OPEN tournament so the field reaches a power-of-two
 * (never byes) with at least 2 entrants. Idempotent — only tops up what's missing.
 * Bots are scaled to the real field's median trophies + average card power so the
 * bracket stays fair. Returns the number of bots added. Never creates a pure-bot
 * tournament (needs >= 1 real colony). */
function padWithBots(t, rng, minField) {
  const r = typeof rng === 'function' ? rng : Math.random;
  const reals = t.entrants.filter((e) => !isBot(e.colonyId));
  if (reals.length === 0) return 0;
  const existingBots = t.entrants.filter((e) => isBot(e.colonyId)).length;
  // 1.70.0: the live server pads to a FULL 16-bracket (4 rounds, ~15 rival
  // clans with 1 real colony) so wars feel like a living world — bot-vs-bot
  // feuds fast-forward instantly, the real colony fights one feud per round.
  // Tests pass a small minField to keep their tight fixtures.
  const floor = Math.max(2, minField == null ? 16 : minField | 0);
  const field = Math.min(16, Math.max(nextPow2(Math.max(2, reals.length)), floor));
  const need = Math.max(0, field - reals.length - existingBots);
  if (need <= 0) return 0;

  const trophiesArr = reals.map((e) => e.trophies | 0).sort((a, b) => a - b);
  const medianTr = trophiesArr[Math.floor(trophiesArr.length / 2)] || 0;
  let sum = 0;
  let cnt = 0;
  for (const e of reals) {
    for (const m of t.rosters[e.colonyId] || []) {
      for (const c of m.deck || []) {
        sum += c.power | 0;
        cnt += 1;
      }
    }
  }
  const avgPower = cnt > 0 ? sum / cnt : 9;

  for (let i = 0; i < need; i++) {
    const idx = existingBots + i;
    const bot = makeBotColony(t.week, idx, { level: avgPower, trophies: medianTr }, r);
    t.entrants.push(bot.entrant);
    t.rosters[bot.entrant.colonyId] = bot.roster;
  }
  return need;
}

module.exports = { isBot, nextPow2, makeDeck, makeBotColony, padWithBots, TRIBES, ABILITIES, MEMBER_NAMES };
