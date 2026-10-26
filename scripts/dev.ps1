# Development run: builds the engine, starts Vite with hot reload and opens the Electron shell on it.
#   pwsh scripts/dev.ps1            # Electron + Vite
#   pwsh scripts/dev.ps1 -Browser   # engine + Vite only; open the printed URL in a browser
param([switch]$Browser)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

dotnet build "$root/engine/Kod.slnx" -nologo -v:q
if ($LASTEXITCODE -ne 0) { throw 'Engine build failed' }

foreach ($dir in 'ui', 'desktop') {
  if (-not (Test-Path "$root/$dir/node_modules")) { Push-Location "$root/$dir"; npm install; Pop-Location }
}

$vite = Start-Process -FilePath 'npm' -ArgumentList 'run', 'dev' -WorkingDirectory "$root/ui" -PassThru -NoNewWindow
try {
  if ($Browser) {
    $exe = Join-Path $root 'engine/src/Kod.Engine/bin/Debug/net10.0/Kod.Engine'
    $token = [guid]::NewGuid().ToString('N')
    Write-Host "Open http://localhost:5173/?engine=47123&token=$token"
    & $exe --port 47123 --token $token --dev
  } else {
    $env:KOD_DEV_URL = 'http://localhost:5173'
    Push-Location "$root/desktop"
    npm start
    Pop-Location
  }
} finally {
  Stop-Process -Id $vite.Id -ErrorAction SilentlyContinue
}
