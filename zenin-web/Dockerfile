# zenin-web image. Build context is the REPO ROOT, because the demo runs the sibling payday-engine, payday-journey and
# payday-api packages in-process. No npm dependencies: nothing to install.
FROM node:22-alpine
WORKDIR /app

COPY payday-engine ./payday-engine
COPY payday-journey ./payday-journey
COPY payday-api ./payday-api
COPY zenin-web ./zenin-web

ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT:-3000}/healthz" || exit 1

USER node
CMD ["node", "zenin-web/server.js"]
