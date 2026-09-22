# SPDX-License-Identifier: MIT
# 在线音源真机冒烟：协议层（health/sources）+ 业务层（每源搜索→取流→下载前
# 64KB 校验音频魔数）。进程层不归这里管——调用方先启动 vmusicd。
#
# Usage:
#   powershell -File scripts/smoke-online.ps1 -Base http://127.0.0.1:18080 -Token <token>
#   powershell -File scripts/smoke-online.ps1 -Base http://127.0.0.1:18080 -Token <token> -Sources netease,qq
#
# 退出码：0 全部通过；1 有任何一源失败（没有可播结果也算失败，绝不假装成功）。

param(
    [Parameter(Mandatory = $true)][string]$Base,
    [Parameter(Mandatory = $true)][string]$Token,
    [string[]]$Sources = @('netease', 'qq', 'kugou'),
    [string]$Keyword = '海阔天空'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$H = @{ Authorization = "Bearer $Token" }
$failures = New-Object System.Collections.Generic.List[string]

function Get-Json($url) {
    Invoke-RestMethod -Uri $url -Headers $H -UseBasicParsing
}

Write-Host "==> health"
$health = Get-Json "$Base/v1/health"
if (-not $health.version) { throw "health 失败" }
Write-Host "    version=$($health.version) protocol=$($health.protocol_version)"

Write-Host "==> sources"
$sourcesResp = Get-Json "$Base/v1/online/sources"
$byId = @{}
foreach ($s in $sourcesResp.sources) {
    $byId[$s.id] = $s
    Write-Host ("    {0,-9} signedIn={1,-5} caps={2}" -f $s.id, $s.signed_in, ($s.caps -join ','))
}

# 各平台 CDN 的防盗链要求不同：网易要自家 Referer，酷狗要自家，QQ 直链不带。
$referers = @{
    netease = 'https://music.163.com/'
    qq      = $null
    kugou   = 'https://www.kugou.com/'
}

# MP3: "ID3" 起头或 0xFFE 同步字；M4A: 第 4 字节起 "ftyp"；FLAC: "fLaC"。
function Test-AudioMagic([byte[]]$b) {
    if ($b.Length -lt 4) { return $false }
    if ($b[0] -eq 0x49 -and $b[1] -eq 0x44 -and $b[2] -eq 0x33) { return $true }  # ID3
    if ($b[0] -eq 0x66 -and $b[1] -eq 0x4C -and $b[2] -eq 0x61 -and $b[3] -eq 0x43) { return $true } # fLaC
    if (($b[0] -band 0xFF) -eq 0xFF -and ($b[1] -band 0xE0) -eq 0xE0) { return $true } # MP3 sync
    $head = [Text.Encoding]::ASCII.GetString($b, 0, [Math]::Min(12, $b.Length))
    return $head.Contains('ftyp')
}

foreach ($src in $Sources) {
    Write-Host ""
    Write-Host "==> $src 搜索「$Keyword」"
    if (-not $byId.ContainsKey($src)) {
        Write-Warning "$src 不在 sources 列表中"
        $failures.Add("${src}: 服务未提供该音源") | Out-Null
        continue
    }
    try {
        $q = [Uri]::EscapeDataString($Keyword)
        $page = Get-Json "$Base/v1/online/search?source=$src&q=$q&limit=10"
        $candidates = @($page.tracks | Where-Object { $_.playable } | Select-Object -First 5)
        if ($candidates.Count -eq 0) {
            $failures.Add("${src}: 搜索返回 $($page.tracks.Count) 条但无一可播（VIP/灰色应如实标记）") | Out-Null
            Write-Warning "$src 无可播结果"
            continue
        }

        # 搜索的 playable 只是提示：个别曲目取流时上游仍可能以版权/登录为由
        # 拒绝（这是诚实的能力失败）。逐个尝试候选，全部取不到才算该源失败。
        $st = $null
        $t = $null
        $resolveErrors = New-Object System.Collections.Generic.List[string]
        foreach ($cand in $candidates) {
            try {
                Write-Host "    取流 id=$($cand.id) $($cand.title)"
                $info = Get-Json "$Base/v1/online/stream?source=$src&id=$($cand.id)"
                if ($info.url) { $st = $info; $t = $cand; break }
                $resolveErrors.Add("$($cand.id): stream 未返回 url") | Out-Null
            } catch {
                $resolveErrors.Add("$($cand.id): $($_.Exception.Message)") | Out-Null
            }
        }
        if (-not $st) {
            $failures.Add("${src}: $($candidates.Count) 个可播候选取流全部被上游拒绝：$($resolveErrors -join ' | ')") | Out-Null
            Write-Warning "$src 无可用直链（可能需要登录）"
            continue
        }

        # 只下载前 64KB 做魔数校验，不拉整首歌。
        $req = [Net.HttpWebRequest]::Create($st.url)
        $req.Method = 'GET'
        $req.AddRange(0, 65535)
        $referer = $referers[$src]
        if ($referer) { $req.Referer = $referer }
        $req.Timeout = 20000
        $resp = $req.GetResponse()
        try {
            $stream = $resp.GetResponseStream()
            $buf = New-Object byte[] 65536
            $total = 0
            while ($total -lt $buf.Length) {
                $read = $stream.Read($buf, $total, $buf.Length - $total)
                if ($read -le 0) { break }
                $total += $read
            }
            $got = New-Object byte[] $total
            [Array]::Copy($buf, $got, $total)
        } finally {
            $resp.Close()
        }
        if (-not (Test-AudioMagic $got)) {
            $hex = ($got[0..([Math]::Min(7, $got.Length - 1))] | ForEach-Object { $_.ToString('x2') }) -join ' '
            throw "下载内容不是音频（首字节: $hex），可能是错误页/加密内容"
        }
        $rate = if ($st.bitrate) { " $([math]::Round($st.bitrate / 1000.0))kbps" } else { '' }
        Write-Host "    $src OK ($($got.Length) bytes$rate)" -ForegroundColor Green
    } catch {
        $failures.Add("${src}: $($_.Exception.Message)") | Out-Null
        Write-Warning "$src 失败：$($_.Exception.Message)"
    }
}

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "冒烟未通过（$($failures.Count)/$($Sources.Count) 源失败）：" -ForegroundColor Red
    foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
    exit 1
}
Write-Host "在线音源冒烟全部通过（$($Sources.Count) 源）" -ForegroundColor Green
