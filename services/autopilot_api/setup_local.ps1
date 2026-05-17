$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

if (-not (Test-Path ".venv")) {
  python -m venv .venv
}

.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements-local.txt

Write-Host ""
Write-Host "Local Autopilot API setup complete."
Write-Host "Run it with:"
Write-Host "  .\run_local.ps1"
