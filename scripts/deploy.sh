#!/usr/bin/env bash
set -euo pipefail

# Deploy script for OpenClaw on production server
cd /opt/openclaw

echo "Pulling latest changes..."
git pull origin main

echo "Installing dependencies..."
pnpm install --frozen-lockfile

echo "Building..."
pnpm build

echo "Restarting gateway..."
pm2 restart openclaw 2>/dev/null || pm2 start dist/index.js --name openclaw -- gateway --verbose
pm2 save

echo "Deploy complete!"
pm2 status openclaw
