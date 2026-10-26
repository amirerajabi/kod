# Release build: publishes the engine (self-contained, for the current OS), builds the UI and packages the app
# with electron-builder into desktop/dist.
#   pwsh scripts/build.ps1             # installer
#   pwsh scripts/build.ps1 -Dir        # unpacked app folder only
param([switch]$Dir)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$rid = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'win-x64' } elseif ($IsMacOS) { if ((uname -m) -eq 'arm64') { 'osx-arm64' } else { 'osx-x64' } } else { 'linux-x64' }

Remove-Item "$root/engine/publish" -Recurse -Force -ErrorAction SilentlyContinue
dotnet publish "$root/engine/src/Kod.Engine/Kod.Engine.csproj" -c Release -r $rid --self-contained false -o "$root/engine/publish" -nologo
if ($LASTEXITCODE -ne 0) { throw 'Engine publish failed' }

Push-Location "$root/ui"; npm ci; if ($LASTEXITCODE -ne 0) { throw 'UI install failed' }; npm run build; if ($LASTEXITCODE -ne 0) { throw 'UI build failed' }; Pop-Location
Push-Location "$root/desktop"; npm ci; if ($LASTEXITCODE -ne 0) { throw 'Desktop install failed' }; if ($Dir) { npm run dist:dir } else { npm run dist }; if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }; Pop-Location
Write-Host "Done: $root/desktop/dist"
