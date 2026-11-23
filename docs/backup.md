# Database backups

Every night at 03:17 (Kyiv) the **DB backup** workflow dumps the production Postgres, compresses and
encrypts it (gpg, AES-256) and keeps it 30 days as an artifact of that workflow run.
The repository is public, so the dump is only ever stored encrypted.

## Setup (once)

1. Railway → the Postgres service → **Connect** → copy the **Public Network** connection URL.
2. GitHub → this repo → Settings → Secrets and variables → Actions → **New repository secret**:
   - `BACKUP_DATABASE_URL` — the URL from step 1;
   - `BACKUP_PASSPHRASE` — a long random passphrase. Keep it in your password manager: without it the backups cannot be opened.
3. Actions → **DB backup** → **Run workflow** to check: the run should end green with an artifact `matchiq-YYYY-MM-DD.sql.gz.gpg`.

Without the two secrets the workflow is skipped with a warning (no failure).

## Restore

```bash
# download the artifact from the workflow run (zip), unzip it, then:
gpg --decrypt matchiq-2026-11-24.sql.gz.gpg | gunzip > matchiq.sql
psql "$TARGET_DATABASE_URL" -f matchiq.sql      # into an EMPTY database
```

Restore into a fresh database first and check it before pointing the backend at it.
