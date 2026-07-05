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

const PORT = Number(process.env.PORT) || 8765;
// Protocol version: bump when the wire format changes incompatibly.
// v2 = public profiles (hello carries avatar/bio). Old clients/servers are refused.
const PROTO = 2;

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

/** Weekly leaderboard (in-memory — repopulated by clients pushing `score` on
 * connect, so free-tier spin-downs only lose players until they reconnect).
 * Weeks flip on Monday 00:00 UTC. */
const weekKey = () => 'w' + Math.floor((Date.now() / 86400000 - 4) / 7);
let lbWeek = weekKey();
const lbScores = new Map(); // keyOf(name) -> { name, trophies, cats, at }
function lbCheck() {
  const wk = weekKey();
  if (wk !== lbWeek) {
    lbWeek = wk;
    lbScores.clear();
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
            trophies: Math.max(0, msg.trophies | 0),
            cats: Math.max(0, msg.cats | 0),
            avatar: String(msg.avatar || '').slice(0, 8),
            bio: String(msg.bio || '').slice(0, 80),
            level: Math.max(0, msg.level | 0),
            deck: sanitizeDeck(msg.deck),
            at: Date.now(),
          });
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
