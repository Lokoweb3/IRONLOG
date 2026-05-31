# ---------------------------------------------------------------------------
#  Production image: build the frontend, then run Express which serves it.
#  Used by Fly.io (and works for any container host).
# ---------------------------------------------------------------------------
FROM node:22-slim

# better-sqlite3 may compile a native binding; these are here as a fallback if
# no prebuilt binary matches the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Litestream — continuous SQLite replication to object storage (backups).
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.deb /tmp/litestream.deb
RUN dpkg -i /tmp/litestream.deb && rm /tmp/litestream.deb

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci

# Build the frontend. VITE_GOOGLE_CLIENT_ID is PUBLIC (it ends up in the JS
# bundle either way), so we pass it as a build arg, not a secret.
COPY . .
ARG VITE_GOOGLE_CLIENT_ID
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/app.db
EXPOSE 8080

# Litestream config + resilient entrypoint (runs the app under Litestream when
# bucket secrets exist, else runs it directly). Strip any CRLF from run.sh.
COPY litestream.yml /etc/litestream.yml
RUN sed -i 's/\r$//' scripts/run.sh && chmod +x scripts/run.sh

CMD ["/app/scripts/run.sh"]
