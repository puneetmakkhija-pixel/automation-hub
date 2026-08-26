#!/bin/bash
set -e

# Navigate to the service directory
cd ivr-router

# Start the service (dependencies already installed during Docker build)
node index.js
