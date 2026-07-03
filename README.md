# Cat Catch — server multiplayer (cloud)

Relay/presence/sfide per Cat Catch, protocollo v2. Nessun database: tutto in memoria.

## Deploy su Render (gratis)
1. Accedi su https://render.com (Sign in with GitHub)
2. New → Web Service → scegli questo repo → Deploy (il file `render.yaml` fa il resto)
3. L'URL sarà `wss://<nome-servizio>.onrender.com` — mettilo nel campo server dell'app

Nota: il piano gratuito va in sospensione dopo ~15 minuti di inattività; l'app lo
risveglia da sola alla connessione (il primo collegamento può richiedere ~30-60s).
