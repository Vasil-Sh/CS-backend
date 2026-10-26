# run-scrapling.ps1
#
# Wrapper for the Scrapling scraper. Loads backend/.env (so TIPSGG_PROXIES and
# friends reach the Python process), then runs the venv Python scraper for the
# requested target and writes output to a timestamped log under .cache/logs.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-scrapling.ps1 -Target hltv
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-scrapling.ps1 -Target tipsgg
#
# Targets: all | tipsgg | dota2 | cs2 | hltv

param(
  [ValidateSet('all', 'tipsgg', 'dota2', 'cs2', 'hltv')]
  [string]$Target = 'all',
  [switch]$NoCoeffs
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Split-Path -Parent (Split-Path -Parent $ScriptDir)   # .../backend
$VenvPython = Join-Path $ScriptDir '.venv\Scripts\python.exe'
$Scraper = Join-Path $ScriptDir 'scrapling_scrape.py'

# ── Load backend/.env into the process environment (only keys we need) ──────
# Python reads os.environ["TIPSGG_PROXIES"]; Task Scheduler doesn't source .env,
# so we do it here. Non-secret passthrough: we re-export every KEY=VALUE line.
$envFile = Join-Path $BackendDir '.env'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $key = $Matches[1]
      $val = $Matches[2].Trim().Trim('"').Trim("'")
      if ($key) {
        [Environment]::SetEnvironmentVariable($key, $val, 'Process')
      }
    }
  }
}

if (-not (Test-Path $VenvPython)) {
  Write-Error "Scrapling venv not found at: $VenvPython`nRun setup first (see scripts/scrapling/README.md)."
  exit 1
}

# ── Log to .cache/logs ───────────────────────────────────────────────────────
$logDir = Join-Path $BackendDir '.cache\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ('scrapling_{0}_{1}.log' -f $Target, (Get-Date -Format 'yyyyMMdd_HHmmss'))

$pyArgs = @($Scraper, $Target)
if ($NoCoeffs) { $pyArgs += '--no-coeffs' }

Write-Host "[scrapling] target=$Target log=$log"
& $VenvPython @pyArgs *>&1 | Tee-Object -FilePath $log
exit $LASTEXITCODE
