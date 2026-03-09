#!/bin/bash
set -e

cd ~/raspcast

echo "🔄 Pulling latest changes..."
git pull

echo "📦 Installing dependencies..."
bun install

echo "🏗️  Building frontend..."
bun run build

echo "🏗️  Building server..."
cd server && go build -o ../raspcast . && cd ..

echo "🔄 Restarting raspcast..."
sudo systemctl restart raspcast

echo "✅ Raspcast reloaded!"
sudo systemctl status raspcast --no-pager
