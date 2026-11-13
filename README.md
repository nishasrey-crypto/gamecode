# HAMMER HALL

A browser auction game for up to 8 owners. Play solo against bots, or create a custom room and share a six-digit code with friends.

- 120 Cr purse, exactly 15 players per squad
- Team review after every two completed players
- Unsold-player second round
- 3D hall, voice narration, personal monitors
- One file (`server.js`), Node 18+, **no npm dependencies**

All player names and statistics are fictional.

## Run locally

```bash
node server.js
```

Open http://localhost:3000

## Deploy (recommended: Render)

This game keeps rooms in memory and uses live streams (Server-Sent Events), so it needs **one always-running Node process**. Serverless platforms (Vercel, Netlify Functions, EdgeOne Pages Functions) will not work.

1. Push this repo to GitHub.
2. On https://render.com choose **New + > Web Service** and select the repo (or use **Blueprint** to read `render.yaml`).
3. Settings:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `node server.js`
   - Health check path: `/health`
4. Open the address Render gives you. Check `/health` shows `ok`.

Free plans sleep when idle and restarts clear all rooms. Use an always-on plan for real games.

Other hosts that work: Railway, Fly.io (single instance), any VPS with `pm2 start server.js`.

## Put it behind your own domain (EdgeOne or any CDN)

Point your domain at the running server. In the CDN rules for `/`, `/api/*` and `/events`:

- Cache: bypass / no cache
- Do not buffer responses (the game streams live updates)

If streaming misbehaves behind the CDN, serve the game from a subdomain that goes straight to the origin.

### Nginx

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

## Environment variables (all optional)

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on. Default `3000`. Hosts like Render set this for you. |
| `ALLOWED_ORIGIN` | Only if your web page is on a different domain from this server, e.g. `https://yoursite.com`. |
| `API_BASE` | Only in that same case: where this server lives, e.g. `https://play.yoursite.com`. |

If the server serves the page itself, leave both empty.

## How to play

1. Enter a franchise name (2 to 22 characters).
2. **Play Solo** starts at once with seven bots.
3. **Create Room** shows a six-digit code. Friends choose **Join Room** and enter it, then press Ready. Only the creator can start.
4. Bid with the button or the Space bar. Your safe maximum bid keeps enough purse for the squad slots you still need.
5. After the auction, each owner is Qualified (15 players within 120 Cr) or Disqualified.

## Troubleshooting

- **"Server returned an unexpected response"**: the page is not talking to this Node server. Open `/health` on your server address; it must say `ok`.
- **Bids or timers look frozen**: a proxy is buffering the stream. Turn buffering and caching off for `/events`.
- **Rooms disappear**: the process restarted, or more than one instance is running. Run exactly one.
- **No 3D view**: the Three.js CDN did not load. The room and bidding controls still work.

## Limits

Rooms live in memory, so restarting the server clears them. Scaling beyond one instance would need a shared store, which this project does not include.
