# Deploying IRONLOG on a VPS

> The live app runs on Fly.io with CI/CD (see the README). This guide is the
> self-host alternative: **Node app behind Nginx (or Caddy) with HTTPS.**

## a. Get the code + deps on the server

```bash
git clone <your repo> ironlog && cd ironlog
npm ci
cp .env.example .env   # then edit it with prod values
npm run build
```

Make sure `.env` has your real `GOOGLE_CLIENT_ID`, `VITE_GOOGLE_CLIENT_ID`,
`SESSION_SECRET`, and `PORT`. **Rebuild (`npm run build`) any time you change
`VITE_GOOGLE_CLIENT_ID`**, since it's baked into the frontend bundle.

## b. Keep it running with a process manager (PM2)

```bash
npm install -g pm2
pm2 start "npm start" --name ironlog
pm2 save
pm2 startup            # follow the printed command so it survives reboots
```

(Alternatively, a systemd unit running `npm start` with `EnvironmentFile=/path/.env`.)

## c. Reverse proxy + HTTPS

**Option A — Caddy (automatic HTTPS):** `/etc/caddy/Caddyfile`

```
YOURDOMAIN {
    reverse_proxy localhost:8080
}
```

```bash
sudo systemctl reload caddy
```

**Option B — Nginx + Certbot:** `/etc/nginx/sites-available/ironlog`

```nginx
server {
    server_name YOURDOMAIN;
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ironlog /etc/nginx/sites-enabled/
sudo certbot --nginx -d YOURDOMAIN   # provisions HTTPS automatically
sudo systemctl reload nginx
```

The app sets `app.set("trust proxy", 1)` so it trusts `X-Forwarded-Proto` from your
proxy — important for the `Secure` cookie to work correctly behind TLS termination.

## d. Final Google console check

Confirm `https://YOURDOMAIN` is in **Authorized JavaScript origins**, and that your
OAuth consent screen is either **published** or lists every tester under **Test users**.
