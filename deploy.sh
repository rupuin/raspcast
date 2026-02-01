#!/bin/bash
set -e

cd ~/raspcast

echo "🔄 Pulling latest changes..."
git pull

echo "🔄 Restarting raspcast..."
sudo systemctl restart raspcast

echo "✅ Raspcast reloaded!"
sudo systemctl status raspcast --no-pager
