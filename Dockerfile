# Dockerfile for IVR Automation Hub Router
FROM node:22-alpine

# Install dependencies
RUN apk add --no-cache curl bash

# Set working directory
WORKDIR /app

# Copy ivr-router application
COPY ivr-router/package*.json ./
COPY ivr-router/ ./

# Install dependencies
RUN npm install --omit=dev

# Documentation only; the listening port comes from PORT at runtime and the
# platform routes to it, so this value does not constrain anything.
EXPOSE 3000

# index.js listens on process.env.PORT (falling back to 3000), so the check has
# to resolve the same value rather than assume 3000 — otherwise setting PORT
# marks a perfectly healthy container unhealthy.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f "http://localhost:${PORT:-3000}/health" || exit 1

# Start the application
CMD ["node", "index.js"]
