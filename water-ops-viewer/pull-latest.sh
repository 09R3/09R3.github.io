#!/usr/bin/env bash
# ─── Water Ops Viewer — Pull Latest Updates ──────────────────────────────────
set -e
cd "$(dirname "$0")/.."   # go to repo root

echo "========================================"
echo "  Water Ops Viewer — Pull Latest"
echo "========================================"
echo ""

# Show current branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Current branch: $BRANCH"
echo ""

# Pull latest from origin
echo "Fetching latest changes..."
git pull origin "$BRANCH"
echo ""

# Re-install dependencies in case package.json changed
echo "Checking dependencies..."
cd water-ops-viewer
npm install
echo ""

echo "========================================"
echo "  Up to date! Run ./deploy.sh to start."
echo "========================================"
