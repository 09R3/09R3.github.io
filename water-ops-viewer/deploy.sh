#!/usr/bin/env bash
# ─── Water Ops Viewer — Deploy / Start Script ───────────────────────────────
set -e
cd "$(dirname "$0")"

echo "========================================"
echo "  Water Ops Viewer"
echo "========================================"
echo ""

# Install / update dependencies
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
  echo ""
fi

# Warn if .env is missing
if [ ! -f .env ]; then
  echo "WARNING: .env file not found."
  echo "  Create a .env file with the following variables:"
  echo "    AUTH_USER=admin"
  echo "    AUTH_PASS=yourpassword"
  echo "    PORT=3000"
  echo "  (Optional auto-connect on startup:)"
  echo "    DB_HOST=localhost"
  echo "    DB_PORT=5432"
  echo "    DB_NAME=mydatabase"
  echo "    DB_USER=postgres"
  echo "    DB_PASSWORD=yourdbpassword"
  echo ""
fi

echo "Starting server..."
echo "Open your browser to http://localhost:${PORT:-3000}"
echo ""
echo "Press Ctrl+C to stop."
echo ""

node server.js
