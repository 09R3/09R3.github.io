# Claude Instructions for 09R3.github.io

## Version Bumping

**Whenever changes are made to files inside `water-ops-viewer/`**, bump the
patch version in `water-ops-viewer/package.json` before committing.

Use semantic versioning — patch for fixes/small changes, minor for new features:
- Bug fix or tweak → `1.1.0` → `1.1.1`
- New feature → `1.1.0` → `1.2.0`

The version is displayed in the app UI (sidebar footer) and read from
`package.json` via the `/api/version` endpoint — no other files need updating.

## Branch Strategy

- **water-ops-viewer** changes → branch `claude/database-viewer-reports-i8gRu`
- **field-ops** changes → branch `claude/field-operator-form-app-dEwL1`
- Never push directly to `main`
