# payday-api image. Build context is the REPO ROOT, because the service imports the sibling
# payday-engine and payday-journey packages (see payday-api/railway.toml).
FROM node:22-alpine
WORKDIR /app

COPY payday-engine ./payday-engine
COPY payday-journey ./payday-journey
COPY payday-api/package*.json ./payday-api/
RUN npm --prefix payday-api ci --omit=dev
COPY payday-api ./payday-api

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT:-3000}/healthz" || exit 1

CMD ["node", "payday-api/server.js"]
