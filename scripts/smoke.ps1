# SPDX-License-Identifier: MIT
# End-to-end smoke test for Windows.
#
# Usage: pwsh -File scripts/smoke.ps1 [-Port 7899]

param([int]$Port = 7899)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $env:TEMP ("vmusic-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $data | Out-Null

$proc = $null
try {
    Write-Host "==> building"
    cargo build --manifest-path (Join-Path $root Cargo.toml) --bin hertz-studio
    if ($LASTEXITCODE -ne 0) { throw "build failed" }

    Write-Host "==> starting on port $Port"
    $proc = Start-Process -FilePath (Join-Path $root "target/debug/hertz-studio.exe") `
        -ArgumentList "--port", $Port, "--data-dir", $data `
        -PassThru -WindowStyle Hidden

    Write-Host "==> waiting for health"
    $ok = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/v1/health" -UseBasicParsing
            if ($r.StatusCode -eq 200) { $ok = $true; break }
        } catch { }
    }
    if (-not $ok) { throw "service did not become healthy" }

    $health = Invoke-RestMethod "http://127.0.0.1:$Port/v1/health"
    Write-Host "==> health: $($health.version) protocol $($health.protocol_version)"

    Write-Host "==> unauthenticated request must be rejected"
    try {
        Invoke-WebRequest "http://127.0.0.1:$Port/v1/tracks" -UseBasicParsing | Out-Null
        throw "expected 401"
    } catch {
        if (-not $_.Exception.Message.Contains("401")) { throw }
    }

    $token = (Get-Content (Join-Path $data token) -Raw).Trim()
    $headers = @{ Authorization = "Bearer $token" }

    Write-Host "==> authenticated requests"
    Invoke-RestMethod "http://127.0.0.1:$Port/v1/tracks" -Headers $headers | Out-Null
    Invoke-RestMethod "http://127.0.0.1:$Port/v1/state" -Headers $headers | Out-Null
    Invoke-RestMethod "http://127.0.0.1:$Port/v1/player/pause" -Method Post -Headers $headers | Out-Null
    Invoke-RestMethod "http://127.0.0.1:$Port/v1/playlists" -Headers $headers | Out-Null

    if (-not (Test-Path (Join-Path $data vmusicd.json))) { throw "missing discovery file" }

    $ui = Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing
    if (-not $ui.Content.Contains("mmusic")) { throw "ui did not render" }

    Write-Host ""
    Write-Host "smoke test passed" -ForegroundColor Green
}
finally {
    if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
}
