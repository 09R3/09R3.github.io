# Claude Instructions for 09R3.github.io

## Project Context

### Field Ops (`field-ops/`)
A mobile-friendly form app used by field operators to take readings and report
issues found in the field. Readings are saved into a PostgreSQL database.

### Water Ops Viewer (`water-ops-viewer/`)
A database viewer used to access, organize, sort, and analyze the data entered
by field operators. Includes report generation and CSV/Excel/PDF export.

---

## Ports & Deployments

| App | Branch | Appdata Path | Port |
|-----|--------|-------------|------|
| field-ops | `main` | `/mnt/user/appdata/field-ops` | 3067 |
| field-ops | beta (`claude/field-operator-form-app-dEwL1`) | `/mnt/user/appdata/field-ops-beta` | 3066 |
| water-ops-viewer | `main` | `/mnt/user/appdata/water-ops-viewer` | 3069 |
| water-ops-viewer | beta (`claude/database-viewer-reports-i8gRu`) | `/mnt/user/appdata/water-ops-viewer-beta` | 3068 |

---

## Branch Strategy

- **water-ops-viewer** changes → branch `claude/database-viewer-reports-i8gRu`
- **field-ops** changes → branch `claude/field-operator-form-app-dEwL1`
- Beta branches map to the `claude/` feature branches above
- Never push directly to `main`

---

## Version Bumping

**Whenever changes are made to files inside `water-ops-viewer/`**, bump the
patch version in `water-ops-viewer/package.json` before committing.

Use semantic versioning — patch for fixes/small changes, minor for new features:
- Bug fix or tweak → `1.1.0` → `1.1.1`
- New feature → `1.1.0` → `1.2.0`

The version is displayed in the app UI (sidebar footer) and read from
`package.json` via the `/api/version` endpoint — no other files need updating.
