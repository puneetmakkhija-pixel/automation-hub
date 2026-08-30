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

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "index.js"]
