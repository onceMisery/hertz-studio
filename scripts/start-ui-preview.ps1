# HertzStudio 中文 UI 副本的独立启动入口。
[CmdletBinding()]
param(
    [ValidateSet('Desktop', 'Browser')]
    [string]$Mode = 'Desktop',
    [ValidateRange(1, 65535)]
    [int]$Port = 18797,
    [string]$Bind = '127.0.0.1',
    [string]$DataDir,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$hertzPreviewRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$hertzRuntimeDir = Join-Path $hertzPreviewRoot 'output\ui-preview'
$hertzDataDir = if ([string]::IsNullOrWhiteSpace($DataDir)) { Join-Path $hertzPreviewRoot 'data\ui-preview' }
    elseif ([System.IO.Path]::IsPathRooted($DataDir)) { [System.IO.Path]::GetFullPath($DataDir) }
    else { [System.IO.Path]::GetFullPath((Join-Path $hertzPreviewRoot $DataDir)) }
$hertzDiscoveryPath = Join-Path $hertzDataDir 'vmusicd.json'
$hertzStdoutPath = Join-Path $hertzRuntimeDir 'service.log'
$hertzStderrPath = Join-Path $hertzRuntimeDir 'service.err'
$hertzBinaryPath = Join-Path $hertzRuntimeDir 'hertz-studio.exe'

if (-not (Test-Path -LiteralPath $hertzBinaryPath -PathType Leaf)) {
    $hertzBinaryPath = Join-Path $hertzPreviewRoot 'target\debug\hertz-studio.exe'
}
if (-not (Test-Path -LiteralPath $hertzBinaryPath -PathType Leaf)) {
    throw '尚未构建预览。请在副本目录运行 cargo build --locked -p hertz-studio --features full,native-window。'
}
[void](New-Item -ItemType Directory -Path $hertzRuntimeDir -Force)
[void](New-Item -ItemType Directory -Path $hertzDataDir -Force)

function Read-HertzPreview {
    if (-not (Test-Path -LiteralPath $hertzDiscoveryPath -PathType Leaf)) { return $null }
    try {
        $hertzDiscovery = Get-Content -LiteralPath $hertzDiscoveryPath -Raw | ConvertFrom-Json
        $hertzBase = 'http://127.0.0.1:{0}' -f $hertzDiscovery.port
        $hertzHeaders = @{ Authorization = 'Bearer ' + $hertzDiscovery.token }
        $hertzHealth = Invoke-RestMethod -Uri ($hertzBase + '/v1/health') -Headers $hertzHeaders -TimeoutSec 2
        if ($hertzHealth.backend -ne 'cpal') { throw '运行中的预览没有使用真实音频后端。' }
        return @{ Discovery = $hertzDiscovery; Base = $hertzBase; Headers = $hertzHeaders }
    } catch { return $null }
}

function Open-HertzPreviewBrowser($State) {
    # 一次性访问票据只交给浏览器，不输出令牌或带凭据的地址。
    $hertzTicket = Invoke-RestMethod -Method Post -Uri ($State.Base + '/v1/auth/ticket') -Headers $State.Headers -ContentType 'application/json' -Body '{"uses":1,"ttl_ms":60000}'
    $hertzEntry = $State.Base + '/?ticket=' + [Uri]::EscapeDataString($hertzTicket.ticket)
    Start-Process -FilePath $hertzEntry
}

function Open-HertzPreviewWindow($State) {
    $hertzSocket = [System.Net.Sockets.TcpClient]::new()
    try {
        if (-not $hertzSocket.ConnectAsync('127.0.0.1', [int]$State.Discovery.port + 1).Wait(1000)) { return $false }
        $hertzFocusBytes = [System.Text.Encoding]::UTF8.GetBytes("focus`n")
        $hertzSocket.GetStream().Write($hertzFocusBytes, 0, $hertzFocusBytes.Length)
        return $true
    } catch { return $false }
    finally { $hertzSocket.Dispose() }
}

$hertzExisting = Read-HertzPreview
if ($null -ne $hertzExisting) {
    if ($Mode -eq 'Browser' -and -not $NoOpen) { Open-HertzPreviewBrowser $hertzExisting }
    if ($Mode -eq 'Desktop' -and -not $NoOpen) {
        if (-not (Open-HertzPreviewWindow $hertzExisting)) { Write-Host '当前为网页服务。先从界面退出服务，再启动桌面预览。' }
    }
    Write-Host ('预览已在运行，端口 {0}。桌面窗口可从 HertzStudio 托盘图标打开。' -f $hertzExisting.Discovery.port)
    exit 0
}

$hertzArgs = @('--bind', $Bind, '--port', [string]$Port, '--data-dir', ('"{0}"' -f $hertzDataDir))
if ($Mode -eq 'Desktop' -and -not $NoOpen) { $hertzArgs += '--window' }
$hertzPreviousBackend = $env:VMUSIC_BACKEND
try {
    $env:VMUSIC_BACKEND = 'cpal'
    $hertzChild = Start-Process -FilePath $hertzBinaryPath -ArgumentList $hertzArgs -WorkingDirectory $hertzPreviewRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $hertzStdoutPath -RedirectStandardError $hertzStderrPath
} finally {
    if ($null -eq $hertzPreviousBackend) { Remove-Item Env:\VMUSIC_BACKEND -ErrorAction SilentlyContinue }
    else { $env:VMUSIC_BACKEND = $hertzPreviousBackend }
}

$hertzDeadline = [DateTime]::UtcNow.AddSeconds(30)
$hertzReady = $null
while ([DateTime]::UtcNow -lt $hertzDeadline) {
    $hertzChild.Refresh()
    if ($hertzChild.HasExited) { throw ('启动失败。请查看 {0}。' -f $hertzStderrPath) }
    $hertzReady = Read-HertzPreview
    if ($null -ne $hertzReady -and $hertzReady.Discovery.pid -eq $hertzChild.Id) { break }
    Start-Sleep -Milliseconds 200
}
if ($null -eq $hertzReady -or $hertzReady.Discovery.pid -ne $hertzChild.Id) {
    throw ('预览启动超时。请查看 {0}。' -f $hertzStderrPath)
}
if ($Mode -eq 'Browser' -and -not $NoOpen) { Open-HertzPreviewBrowser $hertzReady }
Write-Host ('HertzStudio 中文 UI 预览已启动，端口 {0}，真实音频后端 cpal。' -f $hertzReady.Discovery.port)
Write-Host ('音乐目录、歌单和设置保存到 {0}。' -f $hertzDataDir)
