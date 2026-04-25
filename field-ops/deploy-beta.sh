#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Field Ops Beta — Unraid Deploy Script
#  Save this file to: /mnt/user/appdata/field-ops-beta/deploy-beta.sh
#  Run with:  bash /mnt/user/appdata/field-ops-beta/deploy-beta.sh
#
#  Shares the same PostgreSQL database as the production instance (field-ops).
#  Use a different SESSION_SECRET in .env if you want session isolation.
# ─────────────────────────────────────────────────────────────────────────────

set -e

# ── Config (edit these if needed) ────────────────────────────────────────────
APPDATA_DIR="/mnt/user/appdata/field-ops-beta"
REPO_URL="https://github.com/09r3/09r3.github.io"
BRANCH="claude/field-operator-form-app-dEwL1"   # beta / staging branch
CONTAINER_NAME="field-ops-beta"
IMAGE_NAME="field-ops-beta"
HOST_PORT=3066          # port exposed on Unraid (production uses 3067)
CONTAINER_PORT=4000     # port inside the container (matches PORT in .env)
UPLOADS_SHARE="/mnt/user/field-ops-uploads"     # Unraid share for photo/PDF uploads
# ─────────────────────────────────────────────────────────────────────────────

ENV_FILE="$APPDATA_DIR/.env"
SOURCE_DIR="$APPDATA_DIR/_source"

echo ""
echo "══════════════════════════════════════════"
echo "  Field Ops Beta Deploy"
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
# PostgreSQL connection — use the same credentials as your production instance.
# IMPORTANT — if Postgres runs on the SAME Unraid machine, do NOT use "localhost".
# Use your server's LAN IP (e.g. 192.168.1.100) or 172.17.0.1 (Docker bridge default).
DB_HOST=192.168.1.100
DB_PORT=5432
DB_NAME=your_database
DB_USER=your_username
DB_PASSWORD=your_password
PORT=4000

# Optional: use a different secret here to keep beta sessions separate from prod.
# SESSION_SECRET=change_me_beta
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

echo "      Fetching latest icons (Marv-s-site)..."
git clone --depth 1 --quiet https://github.com/09R3/Marv-s-site.git \
    "$SOURCE_DIR/field-ops/public/marv-site" \
    || echo "      Warning: could not fetch icons — Marv-s-site clone failed."

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
mkdir -p "$UPLOADS_SHARE"
docker run \
    --detach \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --publish "${HOST_PORT}:${CONTAINER_PORT}" \
    --env-file "$ENV_FILE" \
    --volume "${UPLOADS_SHARE}:/app/uploads" \
    "$IMAGE_NAME" \
    >/dev/null

# ── Done ──────────────────────────────────────────────────────────────────────
HOST_IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "  ┌──────────────────────────────────────────────────┐"
echo "  │  ✓  Field Ops Beta is running!                  │"
echo "  │                                                  │"
echo "  │  http://${HOST_IP}:${HOST_PORT}"
echo "  │                                                  │"
echo "  │  To view logs:                                   │"
echo "  │  docker logs -f $CONTAINER_NAME                 │"
echo "  └──────────────────────────────────────────────────┘"
echo ""
