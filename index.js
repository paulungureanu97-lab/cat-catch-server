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

const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, '0.0.0.0');

/** name -> ws */
const clients = new Map();

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

function notifyWatchers(name, online) {
  const who = clients.get(name);
  for (const ws of clients.values()) {
    if (ws.watching && ws.watching.has(name)) {
      send(ws, online ? 'friend-online' : 'friend-offline', {
        name,
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
        if (clients.has(name) && clients.get(name) !== ws) {
          return send(ws, 'hello-error', { reason: 'name-taken' });
        }
        ws.name = name;
        ws.avatar = String(msg.avatar || '').slice(0, 8);
        ws.bio = String(msg.bio || '').slice(0, 80);
        clients.set(name, ws);
        send(ws, 'hello-ok', { name, proto: PROTO });
        notifyWatchers(name, true);
        break;
      }

      case 'watch': {
        ws.watching = new Set((msg.names || []).map((n) => String(n)));
        const online = [...ws.watching].filter((n) => clients.has(n));
        const profiles = {};
        for (const n of online) profiles[n] = publicProfile(clients.get(n));
        send(ws, 'presence', { online, profiles });
        break;
      }

      case 'challenge': {
        const target = clients.get(msg.to);
        if (target && target.name !== ws.name) send(target, 'challenged', { from: ws.name });
        else send(ws, 'challenge-failed', { to: msg.to, reason: 'offline' });
        break;
      }

      case 'challenge-cancel': {
        const target = clients.get(msg.to);
        if (target) send(target, 'challenge-cancelled', { from: ws.name });
        break;
      }

      case 'accept': {
        // msg.from is the challenger -> they become host, this client is guest
        const host = clients.get(msg.from);
        if (!host) return send(ws, 'opponent-left', {});
        host.opponent = ws.name;
        ws.opponent = msg.from;
        send(host, 'match-start', { role: 'host', opponent: ws.name });
        send(ws, 'match-start', { role: 'guest', opponent: msg.from });
        break;
      }

      case 'decline': {
        const host = clients.get(msg.from);
        if (host) send(host, 'declined', { from: ws.name });
        break;
      }

      case 'relay': {
        // forward an in-match game message to the current opponent
        const opp = clients.get(ws.opponent);
        if (opp) send(opp, 'relay', { data: msg.data });
        break;
      }

      case 'gift': {
        // forward a gift (coins / catnip lure) to a friend if they're online
        const target = clients.get(msg.to);
        if (target && target.name !== ws.name) {
          send(target, 'gifted', { from: ws.name, item: msg.item, amount: msg.amount });
        } else {
          send(ws, 'gift-failed', { to: msg.to });
        }
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
    if (ws.name) {
      clients.delete(ws.name);
      notifyWatchers(ws.name, false);
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
