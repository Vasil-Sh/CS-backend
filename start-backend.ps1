# Launcher for the MatchIQ backend — sets env from backend/.env and runs tsx.
$ErrorActionPreference = 'Stop'
Set-Location 'D:\github\mathciq\backend'

# Load .env into the process environment (so dotenv and anything else see them).
foreach ($line in Get-Content '.env') {
  $line = $line.Trim()
  if (-not $line -or $line.StartsWith('#')) { continue }
  $parts = $line -split '=', 2
  if ($parts.Count -eq 2) {
    [Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
  }
}

npx tsx src/index.ts
