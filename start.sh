#!/bin/bash
set -e

# Navigate to the service directory
cd ivr-router

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  npm ci
fi

# Start the service
node index.js
