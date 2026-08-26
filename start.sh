#!/bin/bash
set -e

# Navigate to the service directory
cd ivr-router

# Start the service
# Dependencies are already installed during Docker build stage
exec node index.js
