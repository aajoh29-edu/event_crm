$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

if (-not (Test-Path ".venv")) {
  Write-Host "Virtual environment not found. Running setup first..."
  .\setup_local.ps1
}

$env:PYTHONPATH = (Get-Location).Path
.\.venv\Scripts\python.exe -m uvicorn app.local_main:app --host 127.0.0.1 --port 8080 --reload
