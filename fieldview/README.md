# Water Ops Viewer

A self-hosted web app to browse PostgreSQL databases and export reports.

## Features
- Browse all tables and views with pagination
- Filter & search rows
- Sort columns
- Custom SQL editor (Ctrl+Enter to run)
- Export to **CSV**, **Excel (.xlsx)**, and **PDF**
- Password-protected login (session expires after 8 hours)

## Setup

### 1. Install dependencies
```bash
cd water-ops-viewer
npm install
```

### 2. Configure credentials
```bash
cp .env.example .env
```
Edit `.env` with your settings:
```env
# App login (protects the web UI)
AUTH_USER=admin
AUTH_PASS=your_secure_password

# Optional: auto-connect to PostgreSQL on startup
DB_HOST=localhost
DB_PORT=5432
DB_NAME=your_database
DB_USER=your_pg_user
DB_PASSWORD=your_pg_password

PORT=3000
```

> **Tip:** If you leave `DB_*` vars unset, you can enter the connection details in the UI on each start.

### 3. Start the server
```bash
npm start
# or for auto-reload during development:
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

1. **Sign in** with your `AUTH_USER`/`AUTH_PASS` credentials
2. **Connect** to your PostgreSQL database (or it auto-connects if `.env` is set)
3. **Browse** tables from the left sidebar
4. **Filter** rows using the search bar
5. **Sort** by clicking any column header
6. **Export** the current table or query result using the CSV / Excel / PDF buttons
7. **SQL Editor** — click "⌨ SQL Editor" in the sidebar, write queries, press Ctrl+Enter

## Security Notes
- Bind to `localhost` only (default) — do **not** expose port 3000 to the internet
- Use a strong `AUTH_PASS` in your `.env` file
- Sessions expire after 8 hours of inactivity
