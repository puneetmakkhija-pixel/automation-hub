# Multi-stage Dockerfile for IVR Router service
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY ivr-router/package.json ivr-router/package-lock.json* ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application code
COPY ivr-router/ ./

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start application
CMD ["node", "index.js"]
