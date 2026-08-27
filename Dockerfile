# Multi-stage Dockerfile for IVR Router service
FROM node:22-alpine

# Install build dependencies needed for native modules
RUN apk add --no-cache --virtual .build-deps python3 make g++ cairo-dev jpeg-dev pango-dev giflib-dev

# Set working directory
WORKDIR /app

# Clear npm cache before install (force fresh resolution)
RUN npm cache clean --force

# Copy package files
COPY ivr-router/package.json ivr-router/package-lock.json* ./

# Install dependencies with clean cache
RUN npm ci --omit=dev --legacy-peer-deps

# Remove build dependencies to keep image small
RUN apk del .build-deps

# Copy application code
COPY ivr-router/ ./

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start application
CMD ["node", "index.js"]
