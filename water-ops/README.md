# WaterOps Field App

iPad/iPhone PWA for daily water operations data entry. Works offline — readings queue locally and sync to PostgreSQL when the network is back.

## Setup

### 1. Install Node.js dependencies
```
cd waterops-app
npm install
```

### 2. Configure database connection
```
cp .env.example .env
# Edit .env with your PostgreSQL credentials
```
`.env` example:
```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=waterops
DB_USER=your_user
DB_PASSWORD=your_password
PORT=3000
HOST=0.0.0.0
```

### 3. Start the server
```
npm start
```

### 4. Install on iPad
1. Connect the iPad to the **same Wi-Fi network** as the server machine.
2. Find the server machine's local IP address:
   - Windows: `ipconfig` → look for IPv4 Address (e.g., `192.168.1.50`)
3. Open Safari on the iPad and go to: `http://192.168.1.50:3000`
4. Tap the **Share** button → **Add to Home Screen** → **Add**
5. The app now appears on the home screen and works offline.

> **Note:** Safari requires HTTPS for full service worker support in some modes. For local LAN-only use, HTTP works for installation. If you need full offline PWA behavior, see the SSL section below.

## Docker Deployment (recommended)

### 1. Pull from GitHub
```
git clone https://github.com/09R3/09R3.github.io.git
```
Or if already cloned:
```
git pull origin main
```

### 2. Copy water-ops to AppData
```
xcopy /E /I 09R3.github.io\water-ops %APPDATA%\water-ops
```

### 3. Configure credentials (first time only)
```
cd %APPDATA%\water-ops
copy .env.example .env
```
Edit `.env` with your PostgreSQL credentials.

### 4. Start the container in the background
```
docker compose up -d --build
```

The app runs at `http://localhost:3067` (or `http://<machine-IP>:3067` from the iPad).

To stop: `docker compose down`
To view logs: `docker compose logs -f`

> **Note:** DB settings changed via the app UI are written back to `.env` on the host (via
> the volume mount) and will persist across container restarts.

---

## Reading Types Supported

| Type | Table | Formula Shown |
|------|-------|---------------|
| Pump Hours | `readings_pump_hours` | Run hours (current − previous) |
| PGE Meter | `readings_pge_meters` | kWh used |
| Power Monitor | `readings_power_monitors` | kWh used |
| Compressor Hours | `readings_compressor_hours` | Run hours |
| Well Operational | `readings_well` | AF used, avg CFS |
| Well Static | `readings_kf_monthly` | Depth change |
| Canal | `readings_canal` | AF since last read |
| Pond | `pond_readings` | Net CFS (in − out) |
| Vehicle | `readings_vehicle_monthly` | Miles or hours since last |

## Offline Behavior
- Asset lists (sites, wells, etc.) are cached in the browser after first load.
- Last 5 readings for each asset are cached after first view.
- Readings saved while offline are stored in IndexedDB and show a ⏳ badge.
- When the network returns, the app auto-syncs pending readings every 30 seconds.
- Tap **Sync** on the menu to force an immediate sync.

## CSV Export
GET any reading history as CSV:
```
http://<server-ip>:3000/api/export/pump-hours?from=2025-01-01&to=2025-03-31
```
Available types: `pge`, `power-monitor`, `pump-hours`, `compressor-hours`, `well-static`, `well-operational`, `canal`, `pond`, `vehicle`

## Optional: Run on startup (Windows)
To start the server automatically when the PC boots:
1. Create a batch file `start-waterops.bat`:
   ```
   cd C:\path\to\waterops-app
   node server.js
   ```
2. Add a shortcut to this file in `shell:startup` (Win+R → type `shell:startup`).

## Optional: HTTPS for full PWA support
For full service worker offline support on iOS Safari, run behind a local SSL proxy (e.g., Caddy or nginx with a self-signed cert), or use a service like `local-ssl-proxy`:
```
npm install -g local-ssl-proxy
local-ssl-proxy --source 3443 --target 3000
```
Then access via `https://192.168.1.50:3443` — accept the self-signed cert warning once on the iPad.
