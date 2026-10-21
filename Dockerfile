# The Beauty Alley — single image, two apps.
#
# One container serves both the built frontend and the Express API on port 4000
# with SERVE_APP=true. That is deliberate: one origin means no CORS, no
# VITE_API_URL to keep in sync, and no way for a redeploy to leave the frontend
# pointing at a stale API host.
#
#   docker build -t beauty-alley .
#   docker run --env-file backend/.env.local -e SERVE_APP=true -p 4000:4000 beauty-alley
#
# Build arguments:
#   VITE_API_URL  leave empty for the single-origin setup. Set it only if you
#                 intend to serve the frontend from a different host; it is
#                 baked in at build time and cannot be changed at runtime.

# ---------------------------------------------------------------- frontend
FROM node:20-alpine AS frontend
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ----------------------------------------------------------------- backend
FROM node:20-alpine AS backend
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci

COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# ----------------------------------------------------------------- runtime
FROM node:20-alpine AS runtime

# tini reaps zombies and forwards signals, so SIGTERM reaches node and the
# graceful shutdown in src/index.ts actually runs.
RUN apk add --no-cache tini

WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    SERVE_APP=true

# The app resolves the frontend as `<repo>/dist` from `<repo>/backend/dist`,
# so the two trees must keep that relationship inside the image.
COPY --from=backend  /app/backend/node_modules ./backend/node_modules
COPY --from=backend  /app/backend/dist         ./backend/dist
COPY --from=backend  /app/backend/package.json ./backend/package.json
COPY --from=frontend /app/dist                 ./dist

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

EXPOSE 4000

# Liveness only - no I/O, so a slow database cannot cause a restart loop.
# Readiness is /health and is for the orchestrator's routing decision.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# local.ts, not index.ts: index.ts is the Vercel entry and only exports the
# app. It has no `listen`, so running it here would start nothing and the
# container would exit cleanly - the worst kind of failure to debug.
CMD ["node", "backend/dist/local.js"]
