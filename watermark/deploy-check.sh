#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  WaterMark — Safe Deploy (checks connections, builds before swapping)
#  Save next to your deploy.sh, e.g. /opt/appdata/watermark/deploy-check.sh
#  Run with:  bash /opt/appdata/watermark/deploy-check.sh
#
#  1. Checks GitHub, the npm registry and the Node 22 base image (Google's
#     mirror first, then Docker Hub, then Amazon's copy — see BASE_SOURCES).
#     If the base image or npm can't be reached, it offers to build the new
#     code on top of the current image's libraries instead.
#  2. Builds the new image while the old container keeps running.
#  3. Only if the build succeeds: stops the old container and starts the new
#     one. If the new one doesn't reach the database, offers to roll back.
#  The previous image is kept as <image>:previous for rollback.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
# Defaults; anything set in the deploy.sh next to this script overrides them.
APPDATA_DIR="/opt/appdata/watermark"
REPO_URL="https://github.com/09r3/09r3.github.io"
BRANCH="main"
CONTAINER_NAME="watermark"
IMAGE_NAME="watermark"
HOST_PORT=3067                                  # port on the server
UPLOADS_SHARE="/mnt/user/watermark-uploads"     # photo/PDF uploads folder
# Where to get the Node 22 base image, tried in this order. Google's copy of
# Docker Hub first (Docker Hub itself times out from this server).
BASE_SOURCES=("mirror.gcr.io/library/node:22-alpine" "node:22-alpine" "public.ecr.aws/docker/library/node:22-alpine")
NET_TIMEOUT=15                                  # seconds per connection check
PULL_TIMEOUT=180                                # seconds for a base-image pull
HEALTH_WAIT=40                                  # seconds to wait for "Database connected"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/deploy.sh" ]; then
    # Pick up the same folder, names, branch and uploads share as deploy.sh
    eval "$(grep -E '^(APPDATA_DIR|REPO_URL|BRANCH|CONTAINER_NAME|IMAGE_NAME|HOST_PORT|UPLOADS_SHARE)=' "$SCRIPT_DIR/deploy.sh" || true)"
fi

ENV_FILE="$APPDATA_DIR/.env"
SOURCE_DIR="$APPDATA_DIR/_source_check"
# Port the app listens on inside the container: PORT from .env, else server.js's default
CONTAINER_PORT=$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"\r ' || true)
CONTAINER_PORT=${CONTAINER_PORT:-4000}
# How the container is published. Match this to your deploy.sh's PUBLISH_ARGS
# if that sets anything else (a Docker network, extra ports…).
PUBLISH_ARGS=(-p "${HOST_PORT}:${CONTAINER_PORT}")

# ── Helpers ───────────────────────────────────────────────────────────────────
ok()   { echo "      ✓ $*"; }
warn() { echo "      ! $*"; }
fail() { echo ""; echo "  ✗ $*"; echo "    Nothing was changed — the current container is still running."; echo ""; exit 1; }
ask()  { # ask "question" default(y|n) → returns 0 for yes
    local reply prompt="[y/N]"; [ "${2:-n}" = y ] && prompt="[Y/n]"
    read -r -p "      $1 $prompt " reply </dev/tty || reply=""
    reply=${reply:-${2:-n}}
    [[ "$reply" =~ ^[Yy] ]]
}
reachable() { # reachable URL → 0 if the server answered at all (any HTTP code)
    local code
    code=$(curl -sS -m "$NET_TIMEOUT" -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true)
    [ -n "$code" ] && [ "$code" != "000" ]
}
cleanup() { rm -rf "$SOURCE_DIR"; }
trap cleanup EXIT

echo ""
echo "══════════════════════════════════════════"
echo "  WaterMark Safe Deploy"
echo "  Branch    : $BRANCH"
echo "  Container : $CONTAINER_NAME  (image $IMAGE_NAME)"
echo "  Port      : $HOST_PORT → $CONTAINER_PORT"
echo "  Env file  : $ENV_FILE"
echo "  Uploads   : $UPLOADS_SHARE"
echo "══════════════════════════════════════════"
echo ""
[ -f "$ENV_FILE" ] || fail "No .env at $ENV_FILE — run deploy.sh once to create it."
ask "Continue with these settings?" y || fail "Cancelled."

# ── 1. Connection checks ──────────────────────────────────────────────────────
echo ""
echo "[1/5] Checking connections..."
reachable "https://github.com" && ok "GitHub" || fail "Can't reach GitHub — the new code can't be downloaded."

NPM_OK=0
reachable "https://registry.npmjs.org/" && { ok "npm registry (libraries)"; NPM_OK=1; } || warn "npm registry unreachable"

# Base image: the first source in BASE_SOURCES that pulls, else any of them
# already on this server. The build is told which one via --build-arg.
src_name() { case "$1" in *.*/*) echo "${1%%/*}" ;; *) echo "Docker Hub" ;; esac; }
BASE_OK=0
BASE_REF=""
for src in "${BASE_SOURCES[@]}"; do
    if timeout "$PULL_TIMEOUT" docker pull -q "$src" >/dev/null 2>&1; then
        ok "Base image from $(src_name "$src")"; BASE_OK=1; BASE_REF="$src"; break
    else
        warn "$(src_name "$src") unreachable"
    fi
done
if [ $BASE_OK -eq 0 ]; then
    for src in "${BASE_SOURCES[@]}"; do
        if docker image inspect "$src" >/dev/null 2>&1; then
            ok "Using the copy of $src already on this server"; BASE_OK=2; BASE_REF="$src"; break
        fi
    done
fi

# The image the running container uses (falls back to the image tag)
CURRENT_IMAGE=$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)
[ -n "$CURRENT_IMAGE" ] || CURRENT_IMAGE=$(docker image inspect --format '{{.Id}}' "$IMAGE_NAME" 2>/dev/null || true)

MODE=full
if [ $BASE_OK -eq 0 ] || [ $NPM_OK -eq 0 ]; then
    echo ""
    warn "A full build needs both the base image and the npm registry."
    [ -n "$CURRENT_IMAGE" ] || fail "There's no current image to reuse libraries from."
    echo "      The new code can be built on top of the current image instead,"
    echo "      keeping its Node version and libraries (nothing is downloaded but the code)."
    ask "Use the current libraries?" n || fail "Cancelled."
    MODE=reuse
fi

# ── 2. Download the code ──────────────────────────────────────────────────────
echo ""
echo "[2/5] Downloading latest code from GitHub ($BRANCH)..."
rm -rf "$SOURCE_DIR"
git clone --quiet --depth 1 --branch "$BRANCH" --no-tags --sparse "$REPO_URL" "$SOURCE_DIR" \
    || fail "git clone failed."
git -C "$SOURCE_DIR" sparse-checkout set watermark
git clone --quiet --depth 1 --no-tags https://github.com/09R3/Marv-s-site.git \
    "$SOURCE_DIR/watermark/public/marv-site" \
    || warn "Could not fetch icons (Marv-s-site) — building without them."
BUILD_DIR="$SOURCE_DIR/watermark"
NEW_VERSION=$(grep -o "v [0-9]*\.[0-9]*" "$BUILD_DIR/public/index.html" | head -1 || true)
ok "Code ${NEW_VERSION:-downloaded}"

if [ "$MODE" = reuse ]; then
    # Only safe if the libraries haven't changed since the current image was built
    NEW_SUM=$(md5sum < "$BUILD_DIR/package-lock.json" | cut -d' ' -f1)
    OLD_SUM=$(docker run --rm --entrypoint cat "$CURRENT_IMAGE" /app/package-lock.json 2>/dev/null | md5sum | cut -d' ' -f1)
    if [ "$NEW_SUM" = "$OLD_SUM" ]; then
        ok "Libraries unchanged since the current image — safe to reuse"
    else
        fail "This version needs different libraries than the current image has. Wait until the npm registry and base image can be reached."
    fi
fi

# ── 3. Build (old container keeps running) ────────────────────────────────────
echo ""
echo "[3/5] Building the new image (the current container keeps running)..."
docker tag "$CURRENT_IMAGE" "$IMAGE_NAME:previous" 2>/dev/null || true
if [ "$MODE" = full ]; then
    # The base image is on this server now; the classic builder uses that copy
    # as-is (the newer builder would check with the registry again).
    DOCKER_BUILDKIT=0 docker build --quiet --build-arg "BASE_IMAGE=$BASE_REF" \
        --tag "$IMAGE_NAME:new" "$BUILD_DIR" >/dev/null || fail "Build failed." 
else
    cat > "$BUILD_DIR/Dockerfile.reuse" <<EOF
FROM $IMAGE_NAME:previous
WORKDIR /app
COPY server.js scada-config.json ./
COPY public/ ./public/
CMD ["node", "server.js"]
EOF
    DOCKER_BUILDKIT=0 docker build --quiet --tag "$IMAGE_NAME:new" -f "$BUILD_DIR/Dockerfile.reuse" "$BUILD_DIR" >/dev/null \
        || fail "Build failed."
fi
ok "Built $IMAGE_NAME:new"

# ── 4. Swap containers ────────────────────────────────────────────────────────
start_container() { # start_container IMAGE
    mkdir -p "$UPLOADS_SHARE"
    docker run --detach --name "$CONTAINER_NAME" --restart unless-stopped \
        "${PUBLISH_ARGS[@]}" \
        --env-file "$ENV_FILE" \
        --volume "${UPLOADS_SHARE}:/app/uploads" \
        "$1" >/dev/null
}
wait_healthy() { # 0 when the log says the database connected
    local i
    for ((i = 0; i < HEALTH_WAIT; i += 2)); do
        sleep 2
        docker logs "$CONTAINER_NAME" 2>&1 | grep -q "Database connected" && return 0
        docker logs "$CONTAINER_NAME" 2>&1 | grep -q "DB connection failed" && return 1
        [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null)" = true ] || return 1
    done
    return 1
}

echo ""
echo "[4/5] Swapping to the new container..."
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker tag "$IMAGE_NAME:new" "$IMAGE_NAME"
start_container "$IMAGE_NAME"
if wait_healthy; then
    ok "New container is up and connected to the database"
else
    warn "The new container didn't connect to the database. Last log lines:"
    docker logs --tail 15 "$CONTAINER_NAME" 2>&1 | sed 's/^/        /'
    if docker image inspect "$IMAGE_NAME:previous" >/dev/null 2>&1 && ask "Roll back to the previous version?" y; then
        docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
        docker tag "$IMAGE_NAME:previous" "$IMAGE_NAME"
        start_container "$IMAGE_NAME"
        wait_healthy && ok "Rolled back — previous version is running" \
                     || warn "Previous version started but hasn't connected either — check the database / .env."
        exit 1
    fi
fi

# ── 5. Tidy up ────────────────────────────────────────────────────────────────
echo ""
echo "[5/5] Cleaning up..."
docker rmi "$IMAGE_NAME:new" >/dev/null 2>&1 || true   # just the extra tag; the image stays as $IMAGE_NAME
ok "Done. Previous version kept as $IMAGE_NAME:previous"

HOST_IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "  ┌──────────────────────────────────────────────────┐"
echo "  │  ✓  WaterMark ${NEW_VERSION:-} is running"
echo "  │     http://${HOST_IP}:${HOST_PORT}"
echo "  │                                                  │"
echo "  │  Logs:      docker logs -f $CONTAINER_NAME"
echo "  │  Roll back: docker rm -f $CONTAINER_NAME, then start"
echo "  │             $IMAGE_NAME:previous with the same options"
echo "  └──────────────────────────────────────────────────┘"
echo ""
