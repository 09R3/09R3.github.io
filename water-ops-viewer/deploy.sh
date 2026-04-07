#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Water Ops Viewer — Unraid Deploy Script
#  Save this file to: /mnt/user/appdata/water-ops-viewer/deploy.sh
#  Run with:  bash /mnt/user/appdata/water-ops-viewer/deploy.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

# ── Config (edit these if needed) ────────────────────────────────────────────
APPDATA_DIR="/mnt/user/appdata/water-ops-viewer"
REPO_URL="https://github.com/09r3/09r3.github.io"
BRANCH="claude/database-viewer-reports-i8gRu"
CONTAINER_NAME="water-ops-viewer"
IMAGE_NAME="water-ops-viewer"
HOST_PORT=3068          # port exposed on Unraid
CONTAINER_PORT=3000     # port inside the container (matches PORT in .env)
# ─────────────────────────────────────────────────────────────────────────────

ENV_FILE="$APPDATA_DIR/.env"
SOURCE_DIR="$APPDATA_DIR/_source"

echo ""
echo "══════════════════════════════════════════"
echo "  Water Ops Viewer Deploy"
echo "  Branch : $BRANCH"
echo "  Port   : $HOST_PORT"
echo "══════════════════════════════════════════"
echo ""

# ── 1. Create appdata dir if needed ──────────────────────────────────────────
mkdir -p "$APPDATA_DIR"
cd "$APPDATA_DIR"

# ── 2. First-run: create .env from template and exit ─────────────────────────
if [ ! -f "$ENV_FILE" ]; then
    echo "[1/5] No .env found — creating from template..."

    cat > "$ENV_FILE" <<'EOF'
# PostgreSQL connection
# IMPORTANT — if Postgres runs on the SAME Unraid machine, do NOT use "localhost".
# Use your server's LAN IP (e.g. 192.168.1.100) or 172.17.0.1 (Docker bridge default).
DB_HOST=192.168.1.100
DB_PORT=5432
DB_NAME=your_database
DB_USER=your_username
DB_PASSWORD=your_password

# Server port (must match CONTAINER_PORT in this script)
PORT=3000

# App login credentials (protects the web UI)
AUTH_USER=admin
AUTH_PASS=changeme
EOF

    echo ""
    echo "  ┌─────────────────────────────────────────────────┐"
    echo "  │  ACTION REQUIRED                                │"
    echo "  │  Edit your credentials:                         │"
    echo "  │  $ENV_FILE"
    echo "  │  Then re-run this script.                       │"
    echo "  └─────────────────────────────────────────────────┘"
    echo ""
    exit 0
fi

# ── 3. Stop and remove existing container ────────────────────────────────────
echo "[1/5] Stopping old container (if running)..."
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    docker stop "$CONTAINER_NAME" >/dev/null && docker rm "$CONTAINER_NAME" >/dev/null
    echo "      Stopped and removed."
else
    echo "      No existing container found."
fi

# ── 4. Pull latest source (sparse clone — only water-ops-viewer/ subdir) ─────
echo "[2/5] Downloading latest code from GitHub..."
rm -rf "$SOURCE_DIR"

git clone \
    --depth 1 \
    --branch "$BRANCH" \
    --filter=blob:none \
    --sparse \
    --quiet \
    "$REPO_URL" \
    "$SOURCE_DIR"

cd "$SOURCE_DIR"
git sparse-checkout set water-ops-viewer
cd "$APPDATA_DIR"

echo "      Done."

# ── 5. Build Docker image ─────────────────────────────────────────────────────
echo "[3/5] Building Docker image..."
docker build \
    --tag "$IMAGE_NAME" \
    --quiet \
    "$SOURCE_DIR/water-ops-viewer"
echo "      Built."

# ── 6. Clean up source clone ──────────────────────────────────────────────────
echo "[4/5] Cleaning up source files..."
rm -rf "$SOURCE_DIR"
echo "      Done."

# ── 7. Run the container ──────────────────────────────────────────────────────
echo "[5/5] Starting container..."
docker run \
    --detach \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --publish "${HOST_PORT}:${CONTAINER_PORT}" \
    --env-file "$ENV_FILE" \
    "$IMAGE_NAME" \
    >/dev/null

# ── Done ──────────────────────────────────────────────────────────────────────
HOST_IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "  ┌──────────────────────────────────────────────────┐"
echo "  │  ✓  Water Ops Viewer is running!                │"
echo "  │                                                  │"
echo "  │  http://${HOST_IP}:${HOST_PORT}"
echo "  │                                                  │"
echo "  │  To view logs:                                   │"
echo "  │  docker logs -f $CONTAINER_NAME                 │"
echo "  └──────────────────────────────────────────────────┘"
echo ""
