// Cat Catch multiplayer server — runs on the user's own PC.
// A lightweight relay + presence + challenge broker. The actual battle logic
// runs on the players' devices (the challenger is the authoritative "host");
// this server just connects friends and forwards their game messages.
//
//   npm install   (once)
//   npm start     (run it whenever you want to play)
//
// Friends on the SAME Wi-Fi connect to ws://<this-pc-LAN-ip>:8765
// (the Android emulator uses ws://10.0.2.2:8765). For play across the internet,
// expose the port with a tunnel (ngrok / Tailscale) — see README.md.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const colonies = require('./colonies');
const tournament = require('./tournament');
const store = require('./store');

const PORT = Number(process.env.PORT) || 8765;
// Protocol version: bump when the wire format changes incompatibly.
// v2 = public profiles (hello carries avatar/bio). Old clients/servers are refused.
const PROTO = 2;
// Shared app key: the official app sends this in `hello.app`; clients that don't
// match are refused (blocks casual clones from parasiting the backend). The key
// lives ONLY in the environment (never hardcoded here, so it can't be lifted from
// source) — set the Render env var APP_KEY to the client's key. When UNSET the
// check is disabled, so local dev + the test bots keep working without it.
const APP_KEY = process.env.APP_KEY || '';
if (!APP_KEY) {
  console.warn('[app-key] APP_KEY env var is not set — client app-key check is DISABLED.');
}

// ---- HTTP: in-app update channel (same port as the ws relay) ----
// GET /version  -> contents of server/version.json ({version, notes})
// GET /cat.apk  -> the latest release APK (Desktop\cat.apk by convention,
//                  falling back to server/cat.apk)
const VERSION_FILE = path.join(__dirname, 'version.json');
const APK_PATHS = [path.join(__dirname, '..', '..', 'cat.apk'), path.join(__dirname, 'cat.apk')];

const httpServer = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && url === '/version') {
    try {
      const body = fs.readFileSync(VERSION_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(body);
    } catch {
      res.writeHead(404);
      return res.end('no version manifest');
    }
  }
  if (req.method === 'GET' && url === '/cat.apk') {
    const apk = APK_PATHS.find((p) => fs.existsSync(p));
    if (!apk) {
      res.writeHead(404);
      return res.end('no apk');
    }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': fs.statSync(apk).size,
      'Content-Disposition': 'attachment; filename="cat.apk"',
    });
    return fs.createReadStream(apk).pipe(res);
  }
  res.writeHead(404);
  res.end('not found');
});

// maxPayload caps a single ws frame at 1 MB — the client never sends more (a
// full score with 12 photo thumbnails is well under that), but it stops a
// malicious ws client from flooding 100 MB frames (the library default) and
// OOM-ing the free-tier instance.
const wss = new WebSocketServer({ server: httpServer, maxPayload: 1024 * 1024 });
httpServer.listen(PORT, '0.0.0.0');

/** lowercased name -> ws (matching is case-insensitive, display keeps casing) */
const clients = new Map();
const keyOf = (name) => String(name || '').trim().toLowerCase();

/** Soft capacity: past this many CONCURRENT players the server tells clients it
 * is "busy" so the app can show a heads-up banner (nobody is refused — this is
 * a friends game, just a courtesy warning on a small free-tier instance).
 * Tunable via the MAX_PLAYERS env var. */
const SOFT_LIMIT = Number(process.env.MAX_PLAYERS) || 40;
let lastBusy = false;
function loadPayload() {
  return { online: clients.size, limit: SOFT_LIMIT, busy: clients.size >= SOFT_LIMIT };
}
/** Push the current load to everyone whenever the busy state flips, so already
 * connected players see the banner appear/disappear live. */
function broadcastLoadIfChanged() {
  const busy = clients.size >= SOFT_LIMIT;
  if (busy === lastBusy) return;
  lastBusy = busy;
  const p = loadPayload();
  for (const c of clients.values()) send(c, 'server-load', p);
}

// ---- Moderation (report a PvP opponent -> the admin reviews -> blocks a card) ----
// The admin unlocks moderation by entering ADMIN_KEY (a secret only they know,
// set as a Render env var — NEVER hard-code it in this public repo) in the app.
// Reports + blocks are in-memory; a delivered block is persisted on the target's
// device so it survives a server restart. If ADMIN_KEY is unset, moderation is
// disabled (report still works, but no one can read reports or issue blocks).
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');
const reports = []; // { reporter, reported, at } — newest last, capped
const blocks = new Map(); // uid -> Set(catId) blocked for that player
const isAdmin = (key) => ADMIN_KEY.length > 0 && String(key || '') === ADMIN_KEY;
function blockedList(uid) {
  const set = blocks.get(String(uid || ''));
  return set ? [...set] : [];
}
/** find the connected socket for a player uid (blocks are keyed by uid) */
function socketByUid(uid) {
  for (const c of clients.values()) if (c.uid && c.uid === uid) return c;
  return null;
}

/** push a colony update to every online member (so the tree refreshes live) */
function pushColony(colony) {
  if (!colony) return;
  for (const m of colony.members) {
    const s = socketByUid(m.uid);
    if (s) send(s, 'colony-mine', { colony });
  }
}

// ---- Chat: colony broadcast + friend DMs, with a small durable ring buffer ----
// Lazy in-memory cache (loaded from store on first access), capped per thread and
// mirrored to store.js so offline members/friends catch up on reconnect.
const COL_CHAT_MAX = 50;
const DM_CHAT_MAX = 30;
const colChatCache = new Map(); // colonyId -> msgs[]
const dmChatCache = new Map(); // pairKey -> msgs[]
const dmPair = (a, b) => [keyOf(a), keyOf(b)].sort().join('|');

async function getColChat(id) {
  if (colChatCache.has(id)) return colChatCache.get(id);
  let msgs = [];
  try {
    const v = await store.get(`chat:col:${id}`);
    if (Array.isArray(v)) msgs = v;
  } catch {
    /* ignore */
  }
  colChatCache.set(id, msgs);
  return msgs;
}
async function getDmChat(key) {
  if (dmChatCache.has(key)) return dmChatCache.get(key);
  let msgs = [];
  try {
    const v = await store.get(`chat:dm:${key}`);
    if (Array.isArray(v)) msgs = v;
  } catch {
    /* ignore */
  }
  dmChatCache.set(key, msgs);
  return msgs;
}
function pushMsg(msgs, m, max) {
  msgs.push(m);
  if (msgs.length > max) msgs.splice(0, msgs.length - max);
}
// simple per-socket token bucket: at most 6 chat/dm messages per 4s
function chatAllowed(ws) {
  const now = Date.now();
  if (!ws._chat || now - ws._chat.t > 4000) ws._chat = { t: now, n: 0 };
  ws._chat.n += 1;
  return ws._chat.n <= 6;
}

/** A colony's tournament strength = sum of members' best-deck power (fallback to
 * their trophies, then a small floor by size), plus its strongest member as the
 * "champion" shown in the bracket. Uses the live leaderboard decks in lbScores. */
function deckPower(deck) {
  return Array.isArray(deck) ? deck.reduce((s, c) => s + ((c && c.power) | 0), 0) : 0;
}
function colonyStrength(colony) {
  let total = 0;
  let trophies = 0;
  let champion = { name: '', power: 0 };
  for (const m of colony.members) {
    const e = lbScores.get(keyOf(m.name || ''));
    const p = e ? deckPower(e.deck) : 0;
    const val = p > 0 ? p : e ? e.trophies | 0 : 0;
    total += val;
    trophies += e ? Math.max(0, e.trophies | 0) : 0;
    if (val > champion.power) champion = { name: m.name || '', power: val };
  }
  if (total <= 0) total = colony.members.length * 10; // floor so a colony still beats a bye
  return { strength: total, trophies, champion };
}

/** A colony's tournament roster: each member with their champion deck (from the
 * live leaderboard) so opponents can be BATTLED on-device. Decks carry no photos
 * (opponents render rarity art), so this stays small. */
function colonyRoster(colony) {
  return colony.members.map((m) => {
    const e = lbScores.get(keyOf(m.name || ''));
    const deck = e && Array.isArray(e.deck) ? e.deck.map((c) => ({ ...c, photo: undefined })) : [];
    return { uid: m.uid, name: m.name || '', deck };
  });
}

/** push the current tournament to every online member of an entrant colony.
 * NOTE: no `last` field here — an explicit last:null would wipe the client's
 * cached previous-week archive on every push. */
async function pushTournament(t) {
  if (!t || !Array.isArray(t.entrants)) return;
  for (const ent of t.entrants) {
    const c = await colonies.get(ent.colonyId);
    if (!c) continue;
    for (const m of c.members) {
      const s = socketByUid(m.uid);
      if (s) send(s, 'tour-info', { tournament: t, maxAttacks: tournament.MAX_ATTACKS });
    }
  }
}

// All tournament state lives in ONE durable key, so concurrent attacks/joins do
// read-modify-write over async store ops and would clobber each other (lost
// updates — worse over Upstash's network). Serialize every tournament mutation
// through a promise chain so they apply one-at-a-time.
let tourChain = Promise.resolve();
function withTourLock(fn) {
  const run = tourChain.then(fn, fn);
  tourChain = run.catch(() => {});
  return run;
}

/** notify online members of both colonies in the given feuds that a war started */
async function pushFeudStart(t, feudIds) {
  if (!t || !Array.isArray(feudIds)) return;
  for (const fid of feudIds) {
    const f = t.feuds[fid];
    if (!f || !f.aId || !f.bId) continue;
    for (const [cid, oppName] of [[f.aId, f.bName], [f.bId, f.aName]]) {
      const c = await colonies.get(cid);
      if (!c) continue;
      for (const m of c.members) {
        const s = socketByUid(m.uid);
        if (s) send(s, 'feud-start', { colony: c.name, opponent: oppName, feudId: fid });
      }
    }
  }
}

/** Weekly leaderboard (in-memory — repopulated by clients pushing `score` on
 * connect, so free-tier spin-downs only lose players until they reconnect).
 * Weeks flip on Monday 00:00 UTC. */
const weekKey = () => 'w' + Math.floor((Date.now() / 86400000 - 4) / 7);
let lbWeek = weekKey();
const lbScores = new Map(); // keyOf(name) -> { name, uid, trophies, cats, deck, at }
function lbCheck() {
  const wk = weekKey();
  if (wk !== lbWeek) {
    lbWeek = wk;
    lbScores.clear();
    persistLb(); // start the new week durably (an empty board for the new key)
  }
}

// A player's public deck is stored in memory and served to anyone who opens
// their card, so bound it hard: at most 12 cards, drop any photo over ~90KB
// base64, and keep only the fields the client actually reads. Prevents a
// modified client from parking hundreds of MB of base64 in the leaderboard.
const MAX_CARD_PHOTO = 92_000;
function sanitizeDeck(deck) {
  if (!Array.isArray(deck)) return [];
  return deck.slice(0, 12).map((c) => {
    const card = {
      id: String((c && c.id) || '').slice(0, 48),
      name: String((c && c.name) || '').slice(0, 24),
      rarity: String((c && c.rarity) || 'common').slice(0, 12),
      cost: (c && c.cost) | 0,
      power: (c && c.power) | 0,
      tribe: String((c && c.tribe) || '').slice(0, 24),
      ability: String((c && c.ability) || '').slice(0, 48),
      cutout: !!(c && c.cutout),
      gear: Array.isArray(c && c.gear) ? c.gear.slice(0, 3).map((g) => String(g).slice(0, 32)) : [],
    };
    if (c && typeof c.photo === 'string' && c.photo.length <= MAX_CARD_PHOTO) card.photo = c.photo;
    return card;
  });
}

// ---- Durable snapshots of the in-memory social state ----
// The leaderboard, moderation blocks and reports normally live only in memory
// (fast), but on the Render free tier the instance sleeps after ~15 min idle
// and loses them — so player rankings would vanish until everyone reconnects.
// We mirror a SLIM copy to the durable store (Upstash when configured, else the
// in-memory fallback for local dev) and reload it on boot. Per-card PHOTOS are
// deliberately NOT persisted (they blow past Upstash's 1MB/request limit and
// bloat the free DB) — they repopulate cheaply when each player reconnects and
// re-pushes their score. Writes are debounced so a burst of score pushes = one
// write, keeping us well under the free tier's monthly command budget.
const LB_KEY = 'lb:v1'; // { week, scores: [slimEntry...] }
const BLOCKS_KEY = 'mod:blocks:v1'; // { uid: [catId...] }
const REPORTS_KEY = 'mod:reports:v1'; // [ {reporter, reported, at} ]

function slimEntry(e) {
  // keep everything the client reads EXCEPT the heavy per-card photos
  return {
    name: e.name,
    uid: e.uid,
    trophies: e.trophies,
    cats: e.cats,
    avatar: e.avatar,
    bio: e.bio,
    level: e.level,
    at: e.at,
    deck: Array.isArray(e.deck) ? e.deck.map((c) => ({ ...c, photo: undefined })) : [],
  };
}

// coalesce a burst of mutations into a single durable write after `ms` of quiet
function debounced(fn, ms) {
  let timer = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      Promise.resolve(fn()).catch(() => {});
    }, ms);
  };
}

const persistLb = debounced(
  () => store.set(LB_KEY, { week: lbWeek, scores: [...lbScores.values()].map(slimEntry) }),
  4000,
);
const persistBlocks = debounced(() => {
  const obj = {};
  for (const [uid, set] of blocks) obj[uid] = [...set];
  return store.set(BLOCKS_KEY, obj);
}, 2000);
const persistReports = debounced(() => store.set(REPORTS_KEY, reports.slice(-200)), 2000);

async function loadState() {
  try {
    const lb = await store.get(LB_KEY);
    // only restore if it's still the SAME week (else the board reset while we slept)
    if (lb && lb.week === weekKey() && Array.isArray(lb.scores)) {
      lbWeek = lb.week;
      for (const e of lb.scores) if (e && e.name) lbScores.set(keyOf(e.name), e);
    }
  } catch {
    /* ignore */
  }
  try {
    const b = await store.get(BLOCKS_KEY);
    if (b && typeof b === 'object') {
      for (const uid of Object.keys(b)) if (Array.isArray(b[uid])) blocks.set(uid, new Set(b[uid]));
    }
  } catch {
    /* ignore */
  }
  try {
    const r = await store.get(REPORTS_KEY);
    if (Array.isArray(r)) reports.push(...r.slice(-200));
  } catch {
    /* ignore */
  }
  if (store.durable) {
    console.log(
      `[store] state restored — leaderboard:${lbScores.size} blocks:${blocks.size} reports:${reports.length}`,
    );
  }
}
loadState();

function send(ws, type, payload = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify({ type, ...payload }));
  } catch {
    /* ignore */
  }
}

function publicProfile(ws) {
  return { avatar: ws.avatar || '', bio: ws.bio || '' };
}

function notifyWatchers(nameKey, online) {
  const who = clients.get(nameKey);
  for (const ws of clients.values()) {
    if (ws.watching && ws.watching.has(nameKey)) {
      send(ws, online ? 'friend-online' : 'friend-offline', {
        // reply with the spelling THIS watcher used, so their list matches
        name: ws.watching.get(nameKey),
        ...(online && who ? publicProfile(who) : {}),
      });
    }
  }
}

wss.on('connection', (ws) => {
  ws.name = null;
  ws.watching = new Set();
  ws.opponent = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello': {
        if ((Number(msg.proto) || 1) < PROTO) {
          return send(ws, 'hello-error', { reason: 'old-client', proto: PROTO });
        }
        // reject anything that isn't the official app (or an old app version that
        // predates the app-key). Same 'old-client' reason -> client shows "update".
        if (APP_KEY && String(msg.app || '') !== APP_KEY) {
          return send(ws, 'hello-error', { reason: 'old-client', proto: PROTO });
        }
        const name = String(msg.name || '').trim().slice(0, 20);
        if (!name) return send(ws, 'hello-error', { reason: 'empty-name' });
        const key = keyOf(name);
        const uid = String(msg.uid || '').slice(0, 40);
        const existing = clients.get(key);
        if (existing && existing !== ws) {
          // Same per-install uid (or a stale pre-uid registration, e.g. the
          // ghost socket left behind by the app the player just updated away
          // from) -> it's the SAME player reconnecting: kick the old socket.
          // A DIFFERENT uid is genuinely another player -> name stays taken.
          if ((uid && existing.uid === uid) || !existing.uid) {
            clients.delete(key);
            try {
              existing.close();
            } catch {
              /* ignore */
            }
          } else {
            return send(ws, 'hello-error', { reason: 'name-taken' });
          }
        }
        ws.name = name;
        ws.key = key;
        ws.uid = uid;
        ws.avatar = String(msg.avatar || '').slice(0, 8);
        ws.bio = String(msg.bio || '').slice(0, 80);
        clients.set(key, ws);
        send(ws, 'hello-ok', { name, proto: PROTO });
        // deliver any moderation blocks the admin issued for this player while
        // they were away (their device persists them from here on)
        if (uid && blocks.has(uid)) send(ws, 'blocked', { cats: blockedList(uid) });
        // tell the client which colony it belongs to (if any); roll its weekly
        // missions over if a new week started while it was dormant
        if (uid) {
          colonies
            .myColony(uid)
            .then(async (c) => {
              if (c && colonies.ensureMissions(c)) await colonies.save(c);
              send(ws, 'colony-mine', { colony: c || null });
            })
            .catch(() => {});
        }
        send(ws, 'server-load', loadPayload()); // tell the newcomer the current load
        broadcastLoadIfChanged(); // if this connection tipped us over, warn everyone
        notifyWatchers(key, true);
        break;
      }

      case 'watch': {
        // Map(lowercased key -> the spelling this client used); cap the friend
        // list so a client can't grow an unbounded Map on the server
        const names = Array.isArray(msg.names) ? msg.names.slice(0, 200) : [];
        ws.watching = new Map(names.map((n) => [keyOf(n), String(n).slice(0, 20)]));
        const online = [];
        const profiles = {};
        for (const [k, spelled] of ws.watching) {
          const c = clients.get(k);
          if (c) {
            online.push(spelled);
            profiles[spelled] = publicProfile(c);
          }
        }
        send(ws, 'presence', { online, profiles });
        break;
      }

      case 'added': {
        // someone put a friend in their list: tell the friend, so the app on
        // the other side can auto-add back (friendship becomes mutual)
        const target = clients.get(keyOf(msg.to));
        if (target && target !== ws) {
          send(target, 'added-you', { from: ws.name, ...publicProfile(ws) });
        }
        break;
      }

      case 'challenge': {
        const target = clients.get(keyOf(msg.to));
        if (target && target !== ws) {
          // remember the mode (pvp | coop) so match-start can carry it to both
          target.pendingMode = msg.mode || 'pvp';
          send(target, 'challenged', { from: ws.name, mode: target.pendingMode });
        } else send(ws, 'challenge-failed', { to: msg.to, reason: 'offline' });
        break;
      }

      case 'challenge-cancel': {
        const target = clients.get(keyOf(msg.to));
        if (target) send(target, 'challenge-cancelled', { from: ws.name });
        break;
      }

      case 'accept': {
        // msg.from is the challenger -> they become host, this client is guest
        const host = clients.get(keyOf(msg.from));
        if (!host) return send(ws, 'opponent-left', {});
        host.opponent = ws.key;
        ws.opponent = host.key;
        const mode = ws.pendingMode || 'pvp';
        send(host, 'match-start', { role: 'host', opponent: ws.name, mode });
        send(ws, 'match-start', { role: 'guest', opponent: host.name, mode });
        break;
      }

      case 'decline': {
        const host = clients.get(keyOf(msg.from));
        if (host) send(host, 'declined', { from: ws.name });
        break;
      }

      case 'relay': {
        // forward an in-match game message to the current opponent
        const opp = clients.get(ws.opponent);
        if (opp) send(opp, 'relay', { data: msg.data });
        break;
      }

      case 'wave': {
        // a friendly hello relayed to an online friend
        const target = clients.get(keyOf(msg.to));
        if (target && target !== ws) {
          send(target, 'waved', { from: ws.name });
        }
        break;
      }

      case 'gift': {
        // forward a gift (coins / catnip lure) to a friend if they're online
        const target = clients.get(keyOf(msg.to));
        if (target && target !== ws) {
          send(target, 'gifted', { from: ws.name, item: msg.item, amount: msg.amount });
        } else {
          send(ws, 'gift-failed', { to: msg.to });
        }
        break;
      }

      case 'trade': {
        // cat-trading handshake: relay the payload (offer / answer / confirm /
        // cancel — the clients own the semantics) to the named friend
        const target = clients.get(keyOf(msg.to));
        if (target && target !== ws) {
          send(target, 'trade', { from: ws.name, data: msg.data });
        } else {
          send(ws, 'trade-failed', { to: msg.to });
        }
        break;
      }

      case 'score': {
        // weekly leaderboard: clients push their TOTAL trophies/cats on connect
        // (and before requesting the board), so the in-memory board repopulates
        // by itself after a free-tier spin-down. Since 1.13.0 the entry also
        // carries the public player card (avatar/bio/level + battle deck) so
        // anyone can open a player's profile from the leaderboard.
        lbCheck();
        if (ws.name) {
          lbScores.set(keyOf(ws.name), {
            name: ws.name,
            uid: ws.uid || '',
            trophies: Math.max(0, msg.trophies | 0),
            cats: Math.max(0, msg.cats | 0),
            avatar: String(msg.avatar || '').slice(0, 8),
            bio: String(msg.bio || '').slice(0, 80),
            level: Math.max(0, msg.level | 0),
            deck: sanitizeDeck(msg.deck),
            at: Date.now(),
          });
          persistLb(); // mirror the ranking durably so it survives a spin-down
        }
        break;
      }

      case 'leaderboard': {
        lbCheck();
        // slim rows only — decks are fetched per-player via `player-info`
        const entries = [...lbScores.values()]
          .sort((a, b) => b.trophies - a.trophies || b.cats - a.cats)
          .slice(0, 50)
          .map(({ name, trophies, cats }) => ({ name, trophies, cats }));
        send(ws, 'leaderboard', { week: lbWeek, entries });
        break;
      }

      case 'player-info': {
        // full public card of one leaderboard player (works while the server
        // remembers them — they repopulate on their next connect)
        lbCheck();
        const e = lbScores.get(keyOf(msg.name));
        if (e) send(ws, 'player-info', { found: true, ...e });
        else send(ws, 'player-info', { found: false, name: msg.name });
        break;
      }

      case 'report': {
        // any player can report an opponent after a PvP match (reason is always
        // "non-cat card" for now). Stored for the admin + logged to the console
        // so it's visible in the Render logs too.
        const reported = String(msg.reported || '').slice(0, 20);
        if (ws.name && reported && keyOf(reported) !== ws.key) {
          reports.push({ reporter: ws.name, reported, at: Date.now() });
          if (reports.length > 200) reports.shift();
          persistReports();
          console.log(`[REPORT] ${ws.name} reported ${reported}`);
        }
        break;
      }

      case 'admin-reports': {
        // admin reads the report queue (newest first)
        if (!isAdmin(msg.key)) return send(ws, 'admin-error', { reason: 'auth' });
        send(ws, 'admin-reports', { reports: [...reports].reverse().slice(0, 100) });
        break;
      }

      case 'admin-block':
      case 'admin-unblock': {
        // admin blocks/unblocks ONE card (by cat id) for a player (by uid). The
        // target's client persists it; we also push the fresh list if they're on.
        if (!isAdmin(msg.key)) return send(ws, 'admin-error', { reason: 'auth' });
        const uid = String(msg.uid || '');
        const cat = String(msg.cat || '').slice(0, 48);
        if (!uid || !cat) return send(ws, 'admin-error', { reason: 'bad-args' });
        let set = blocks.get(uid);
        if (!set) {
          set = new Set();
          blocks.set(uid, set);
        }
        if (msg.type === 'admin-block') set.add(cat);
        else set.delete(cat);
        const list = blockedList(uid);
        persistBlocks(); // keep moderation blocks across a server restart
        const target = socketByUid(uid);
        if (target) send(target, 'blocked', { cats: list });
        send(ws, 'admin-ok', { uid, cats: list });
        break;
      }

      // ---- Colonies (clans) — Phase 1 ----
      case 'colony-list': {
        colonies
          .list()
          .then((items) => send(ws, 'colony-list', { items }))
          .catch(() => send(ws, 'colony-list', { items: [] }));
        break;
      }

      case 'colony-create': {
        (async () => {
          if (!ws.uid) return send(ws, 'colony-error', { reason: 'no-uid' });
          const r = await colonies.create(ws.uid, ws.name, ws.avatar, {
            name: msg.name,
            emoji: msg.emoji,
            bio: msg.bio,
            max: msg.max,
          });
          if (r.error) return send(ws, 'colony-error', { reason: r.error });
          await colonies.save(r.colony);
          await colonies.register(r.id);
          await colonies.setMember(ws.uid, r.id);
          send(ws, 'colony-mine', { colony: r.colony });
        })().catch(() => send(ws, 'colony-error', { reason: 'error' }));
        break;
      }

      case 'colony-join': {
        (async () => {
          if (!ws.uid) return send(ws, 'colony-error', { reason: 'no-uid' });
          const r = await colonies.join(ws.uid, String(msg.id || ''), ws.name, ws.avatar);
          if (r.error) return send(ws, 'colony-error', { reason: r.error });
          await colonies.save(r.colony);
          await colonies.setMember(ws.uid, r.colony.id);
          pushColony(r.colony);
        })().catch(() => send(ws, 'colony-error', { reason: 'error' }));
        break;
      }

      case 'colony-leave': {
        (async () => {
          const c = await colonies.myColony(ws.uid);
          await colonies.clearMember(ws.uid);
          send(ws, 'colony-mine', { colony: null });
          if (!c) return;
          const { colony } = colonies.removeMember(c, ws.uid);
          if (!colony) return colonies.disband(c.id);
          await colonies.save(colony);
          pushColony(colony);
        })().catch(() => {});
        break;
      }

      case 'colony-kick': {
        (async () => {
          const c = await colonies.myColony(ws.uid);
          if (!c || !colonies.canManage(c, ws.uid)) return send(ws, 'colony-error', { reason: 'auth' });
          const target = String(msg.uid || '');
          // the target must STILL be a member — kicking someone who already left
          // would clearMember() their pointer to whatever NEW colony they joined
          if (!c.members.some((m) => m.uid === target)) {
            return send(ws, 'colony-error', { reason: 'bad-target' });
          }
          if (target === ws.uid || colonies.roleOf(c, target) === 'leader') {
            return send(ws, 'colony-error', { reason: 'bad-target' });
          }
          const { colony } = colonies.removeMember(c, target);
          await colonies.clearMember(target);
          const ts = socketByUid(target);
          if (ts) {
            send(ts, 'colony-kicked', { name: c.name });
            send(ts, 'colony-mine', { colony: null });
          }
          if (colony) {
            await colonies.save(colony);
            pushColony(colony);
          } else {
            await colonies.disband(c.id);
          }
        })().catch(() => {});
        break;
      }

      case 'colony-role': {
        (async () => {
          const c = await colonies.myColony(ws.uid);
          if (!c || !colonies.isLeader(c, ws.uid)) return send(ws, 'colony-error', { reason: 'auth' });
          const target = String(msg.uid || '');
          const role = msg.role === 'elder' ? 'elder' : 'member';
          const m = c.members.find((x) => x.uid === target);
          if (!m || target === ws.uid || m.role === 'leader') return send(ws, 'colony-error', { reason: 'bad-target' });
          m.role = role;
          await colonies.save(c);
          pushColony(c);
        })().catch(() => {});
        break;
      }

      case 'colony-progress': {
        // a member's catch/win/etc. feeds the colony's collective missions
        (async () => {
          if (!ws.uid) return;
          const c = await colonies.myColony(ws.uid);
          if (!c) return;
          const rolled = colonies.ensureMissions(c);
          const moved = colonies.addProgress(c, String(msg.pt || '').slice(0, 16), msg.amount | 0 || 1);
          if (rolled || moved) {
            await colonies.save(c);
            pushColony(c);
          }
        })().catch(() => {});
        break;
      }

      case 'colony-claim': {
        // a member claims a completed mission's reward (once per member)
        (async () => {
          if (!ws.uid) return;
          const c = await colonies.myColony(ws.uid);
          if (!c) return send(ws, 'colony-error', { reason: 'not-in' });
          const r = colonies.claimMission(c, ws.uid, String(msg.mid || ''));
          if (r.error) return send(ws, 'colony-error', { reason: r.error });
          await colonies.save(c);
          send(ws, 'colony-reward', { coins: r.reward.coins, xp: r.reward.xp });
          pushColony(c);
        })().catch(() => {});
        break;
      }

      case 'colony-edit': {
        (async () => {
          const c = await colonies.myColony(ws.uid);
          if (!c || !colonies.isLeader(c, ws.uid)) return send(ws, 'colony-error', { reason: 'auth' });
          if (msg.emoji != null) c.emoji = colonies.clean(msg.emoji, 4) || c.emoji;
          if (msg.bio != null) c.bio = colonies.clean(msg.bio, 120);
          if (msg.max != null) c.max = Math.max(c.members.length, colonies.clampMax(msg.max));
          await colonies.save(c);
          pushColony(c);
        })().catch(() => {});
        break;
      }

      // ---- Chat: colony group chat + friend DMs ----
      case 'colony-chat': {
        (async () => {
          if (!ws.uid || !chatAllowed(ws)) return;
          const text = String(msg.text || '').trim().slice(0, 300);
          if (!text) return;
          const c = await colonies.myColony(ws.uid);
          if (!c) return;
          const m = { uid: ws.uid, name: ws.name, avatar: ws.avatar || '', text, at: Date.now() };
          const hist = await getColChat(c.id);
          pushMsg(hist, m, COL_CHAT_MAX);
          store.set(`chat:col:${c.id}`, hist).catch(() => {});
          for (const mem of c.members) {
            const s = socketByUid(mem.uid);
            if (s) send(s, 'colony-msg', m); // includes the sender -> their thread updates
          }
        })().catch(() => {});
        break;
      }

      case 'colony-chat-fetch': {
        (async () => {
          if (!ws.uid) return;
          const c = await colonies.myColony(ws.uid);
          if (!c) return;
          send(ws, 'colony-chat-history', { messages: await getColChat(c.id) });
        })().catch(() => {});
        break;
      }

      case 'dm': {
        (async () => {
          if (!ws.name || !chatAllowed(ws)) return;
          const to = String(msg.to || '').trim().slice(0, 20);
          const text = String(msg.text || '').trim().slice(0, 300);
          if (!to || !text) return;
          const m = { from: ws.name, to, text, at: Date.now() };
          const key = dmPair(ws.name, to);
          const hist = await getDmChat(key);
          pushMsg(hist, m, DM_CHAT_MAX);
          store.set(`chat:dm:${key}`, hist).catch(() => {});
          const target = clients.get(keyOf(to));
          if (target && target !== ws) send(target, 'dm', m);
          send(ws, 'dm', m); // echo to sender so their own thread updates
        })().catch(() => {});
        break;
      }

      case 'dm-fetch': {
        (async () => {
          if (!ws.name) return;
          const to = String(msg.to || '').trim().slice(0, 20);
          if (!to) return;
          send(ws, 'dm-history', { with: to, messages: await getDmChat(dmPair(ws.name, to)) });
        })().catch(() => {});
        break;
      }

      // ---- Colony tournaments — Phase 3 (played feuds/wars) ----
      case 'tour-info': {
        withTourLock(async () => {
          const t = await tournament.current();
          // lazily resolve expired feuds / activate ready rounds on every read.
          // Save on ANY mutation — a deadline-expired final flips the tournament
          // to done with nothing newly activated, and losing that save made the
          // rewards permanently unclaimable (claim re-reads the stored object).
          const { activated, changed } = tournament.tick(t, Date.now());
          if (activated.length || changed) {
            await tournament.save(t);
            await pushFeudStart(t, activated);
            await pushTournament(t);
          }
          const lt = await tournament.last();
          send(ws, 'tour-info', { tournament: t, last: lt || null, maxAttacks: tournament.MAX_ATTACKS });
        }).catch(() => {});
        break;
      }

      case 'tour-join': {
        withTourLock(async () => {
          if (!ws.uid) return send(ws, 'tour-error', { reason: 'no-uid' });
          const c = await colonies.myColony(ws.uid);
          if (!c) return send(ws, 'tour-error', { reason: 'not-in' });
          if (!colonies.canManage(c, ws.uid)) return send(ws, 'tour-error', { reason: 'auth' });
          const t = await tournament.current();
          const { strength, trophies } = colonyStrength(c);
          const r = tournament.join(t, { colonyId: c.id, name: c.name, emoji: c.emoji, strength, trophies, roster: colonyRoster(c) });
          if (r.error) return send(ws, 'tour-error', { reason: r.error });
          await tournament.save(t);
          await pushTournament(t);
          send(ws, 'tour-info', { tournament: t, maxAttacks: tournament.MAX_ATTACKS });
        }).catch(() => send(ws, 'tour-error', { reason: 'error' }));
        break;
      }

      case 'tour-start': {
        withTourLock(async () => {
          if (!ws.uid) return send(ws, 'tour-error', { reason: 'no-uid' });
          const c = await colonies.myColony(ws.uid);
          if (!c || !colonies.canManage(c, ws.uid)) return send(ws, 'tour-error', { reason: 'auth' });
          const t = await tournament.current();
          if (!t.entrants.some((e) => e.colonyId === c.id)) return send(ws, 'tour-error', { reason: 'not-entrant' });
          const r = tournament.start(t, Date.now());
          if (r.error) return send(ws, 'tour-error', { reason: r.error });
          await tournament.save(t);
          await pushFeudStart(t, r.activated || []);
          await pushTournament(t);
        }).catch(() => send(ws, 'tour-error', { reason: 'error' }));
        break;
      }

      case 'tour-attack': {
        // a member reports a played feud battle (win/loss + lanes won)
        withTourLock(async () => {
          if (!ws.uid) return send(ws, 'tour-error', { reason: 'no-uid' });
          const c = await colonies.myColony(ws.uid); // current membership check
          const t = await tournament.current();
          const now = Date.now();
          // resolve any expiry FIRST so a post-deadline attack is refused cleanly
          const pre = tournament.tick(t, now);
          const r = tournament.attack(t, String(msg.feudId || ''), ws.uid, msg.oppName, !!msg.win, msg.lanes | 0, now, c ? c.id : null);
          if (r.error) {
            if (pre.activated.length || pre.changed) {
              await tournament.save(t);
              await pushTournament(t);
            }
            return send(ws, 'tour-error', { reason: r.error });
          }
          await tournament.save(t);
          await pushFeudStart(t, pre.activated);
          await pushTournament(t);
        }).catch(() => send(ws, 'tour-error', { reason: 'error' }));
        break;
      }

      case 'tour-claim': {
        withTourLock(async () => {
          if (!ws.uid) return send(ws, 'tour-error', { reason: 'no-uid' });
          const c = await colonies.myColony(ws.uid);
          if (!c) return send(ws, 'tour-error', { reason: 'not-in' });
          const t = await tournament.current();
          // tick first: the final may have expired since the last read — without
          // this the stored state can still say 'running' and claim fails forever
          const pre = tournament.tick(t, Date.now());
          const r = tournament.claim(t, c.id, ws.uid);
          if (r.error) {
            if (pre.activated.length || pre.changed) await tournament.save(t);
            return send(ws, 'tour-error', { reason: r.error });
          }
          await tournament.save(t);
          send(ws, 'tour-reward', { coins: r.reward.coins, xp: r.reward.xp, place: r.reward.place });
          send(ws, 'tour-info', { tournament: t, maxAttacks: tournament.MAX_ATTACKS });
        }).catch(() => send(ws, 'tour-error', { reason: 'error' }));
        break;
      }

      case 'leave-match': {
        const opp = clients.get(ws.opponent);
        if (opp) {
          send(opp, 'opponent-left', {});
          opp.opponent = null;
        }
        ws.opponent = null;
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    // only unregister if the map still points at THIS socket — a kicked ghost
    // (uid takeover on reconnect) must not wipe the replacing player's entry
    if (ws.key && clients.get(ws.key) === ws) {
      clients.delete(ws.key);
      notifyWatchers(ws.key, false);
      broadcastLoadIfChanged(); // dropping below the limit clears everyone's banner
    }
    const opp = clients.get(ws.opponent);
    if (opp) {
      send(opp, 'opponent-left', {});
      opp.opponent = null;
    }
  });
});

console.log(`🐱 Cat Catch server running on ws://0.0.0.0:${PORT}`);
console.log('   Emulator:  ws://10.0.2.2:' + PORT);
console.log('   Same Wi-Fi: ws://<your-PC-LAN-ip>:' + PORT + '  (run `ipconfig` to find it)');
