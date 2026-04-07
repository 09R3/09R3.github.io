#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Field Ops — Unraid Deploy Script
#  Save this file to: /mnt/user/appdata/field-ops/deploy.sh
#  Run with:  bash /mnt/user/appdata/field-ops/deploy.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

# ── Config (edit these if needed) ────────────────────────────────────────────
APPDATA_DIR="/mnt/user/appdata/field-ops"
REPO_URL="https://github.com/09r3/09r3.github.io"
BRANCH="main"
CONTAINER_NAME="field-ops"
IMAGE_NAME="field-ops"
HOST_PORT=3067          # port exposed on Unraid
CONTAINER_PORT=4000     # port inside the container (matches PORT in .env)
# ─────────────────────────────────────────────────────────────────────────────

ENV_FILE="$APPDATA_DIR/.env"
SOURCE_DIR="$APPDATA_DIR/_source"

echo ""
echo "══════════════════════════════════════════"
echo "  Field Ops Deploy"
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

    # Grab just the .env.example from the repo without cloning everything
    curl -fsSL \
        "https://raw.githubusercontent.com/09r3/$BRANCH/field-ops/.env.example" \
        -o "$ENV_FILE" 2>/dev/null \
    || {
        # Fallback: write a minimal template if curl fails
        cat > "$ENV_FILE" <<'EOF'
# PostgreSQL connection
# IMPORTANT — if Postgres runs on the SAME Unraid machine, do NOT use "localhost".
# Use your server's LAN IP (e.g. 192.168.1.100) or 172.17.0.1 (Docker bridge default).
DB_HOST=192.168.1.100
DB_PORT=5432
DB_NAME=your_database
DB_USER=your_username
DB_PASSWORD=your_password
PORT=4000
EOF
    }

    echo ""
    echo "  ┌─────────────────────────────────────────────────┐"
    echo "  │  ACTION REQUIRED                                │"
    echo "  │  Edit your database credentials:               │"
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

# ── 4. Pull latest source (sparse clone — only field-ops/ subdir) ─────────────
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
git sparse-checkout set field-ops
cd "$APPDATA_DIR"

echo "      Done."

# ── 5. Build Docker image ─────────────────────────────────────────────────────
echo "[3/5] Building Docker image..."
docker build \
    --tag "$IMAGE_NAME" \
    --quiet \
    "$SOURCE_DIR/field-ops"
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
echo "  │  ✓  Field Ops is running!                       │"
echo "  │                                                  │"
echo "  │  http://${HOST_IP}:${HOST_PORT}"
echo "  │                                                  │"
echo "  │  To view logs:                                   │"
echo "  │  docker logs -f $CONTAINER_NAME                 │"
echo "  └──────────────────────────────────────────────────┘"
echo ""
