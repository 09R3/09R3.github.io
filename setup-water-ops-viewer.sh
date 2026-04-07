#!/usr/bin/env bash
# ─── Water Ops Viewer — Clone & Setup ────────────────────────────────────────
# Run this on any machine to get started:
#
#   curl -fsSL https://raw.githubusercontent.com/09R3/09R3.github.io/main/setup-water-ops-viewer.sh | bash
#
set -e

REPO="https://github.com/09R3/09R3.github.io.git"
BRANCH="main"
DIR="09R3.github.io"
APP_DIR="$DIR/water-ops-viewer"

echo "========================================"
echo "  Water Ops Viewer — Setup"
echo "========================================"
echo ""

# Clone if not already present
if [ -d "$DIR" ]; then
  echo "Repo already exists at ./$DIR — pulling latest..."
  git -C "$DIR" pull origin "$BRANCH"
else
  echo "Cloning repo..."
  git clone --branch "$BRANCH" "$REPO" "$DIR"
fi
echo ""

# Install dependencies
echo "Installing dependencies..."
cd "$APP_DIR"
npm install
echo ""

# Create .env from example if missing
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
  echo ""
  echo "  *** Edit .env before starting the server ***"
  echo "  Required:"
  echo "    AUTH_USER=admin"
  echo "    AUTH_PASS=yourpassword"
  echo "  Optional (auto-connect to DB on startup):"
  echo "    DB_HOST=localhost"
  echo "    DB_PORT=5432"
  echo "    DB_NAME=mydatabase"
  echo "    DB_USER=postgres"
  echo "    DB_PASSWORD=yourdbpassword"
else
  echo ".env already exists — skipping."
fi

echo ""
echo "========================================"
echo "  Setup complete!"
echo ""
echo "  Next steps:"
echo "    1. Edit $APP_DIR/.env with your credentials"
echo "    2. cd $APP_DIR && ./deploy.sh"
echo "========================================"
