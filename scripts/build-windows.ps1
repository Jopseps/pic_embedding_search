# One-command release build on Windows, from a fresh clone:
#
#   scripts\build-windows.cmd                     check, install, test, package, collect
#   scripts\build-windows.cmd -SkipTests          straight to packaging
#   scripts\build-windows.cmd --bundles nsis      anything unrecognised goes to `tauri build`
#
# Steps: prerequisites -> npm ci -> tests -> scripts/package.mjs -> release\.
#
# The .cmd launcher exists so a double-click or a plain cmd prompt works under
# the default execution policy. This file must stay pure ASCII: Windows
# PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI, and one em dash in a
# string would come out as mojibake.
#
# The packaging itself is package.mjs, not this file: it fetches the pinned uv
# and applies the tauri.bundle.conf.json overlay. Tauri downloads NSIS itself.
#
# Sidecar tests run in sidecar\.venv-build with CPU torch, exactly as CI does.
# Never in sidecar\.venv: syncing the cpu group there would swap out the dev
# environment's CUDA torch, and the next `tauri dev` would re-download 3 GB.
#
# No param() block on purpose: PowerShell would try to bind `--bundles` as a
# parameter name and fail, so the arguments are read from $args by hand.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

$root = Split-Path -Parent $PSScriptRoot

$skipTests = $false
$skipInstall = $false
$extra = @()
foreach($arg in $args){
    $a = [string]$arg
    if($a -eq "-SkipTests" -or $a -eq "--skip-tests"){
        $skipTests = $true
    }elseif($a -eq "-SkipInstall" -or $a -eq "--skip-install"){
        $skipInstall = $true
    }elseif($a -eq "-h" -or $a -eq "--help" -or $a -eq "-Help"){
        Get-Content $PSCommandPath -TotalCount 8 | ForEach-Object { $_ -replace "^# ?", "" }
        exit 0
    }else{
        $extra += $a
    }
}

function Write-Step([string]$text){
    Write-Host ""
    Write-Host "==> $text" -ForegroundColor Cyan
}

function Write-Warn([string]$text){
    Write-Host "warning: $text" -ForegroundColor Yellow
}

function Test-Command([string]$name){
    return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

# $ErrorActionPreference does not cover native programs: a failing npm or uv
# only sets $LASTEXITCODE, and the script would carry on regardless.
function Invoke-Native([string]$file, [string[]]$arguments){
    & $file @arguments
    if($LASTEXITCODE -ne 0){
        throw "$file $($arguments -join ' ') exited with $LASTEXITCODE"
    }
}

function Test-WebView2{
    $id = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    $keys = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$id",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$id",
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$id"
    )
    foreach($key in $keys){
        $item = Get-ItemProperty -Path $key -Name pv -ErrorAction SilentlyContinue
        if($null -ne $item -and $item.pv -and $item.pv -ne "0.0.0.0"){
            return $true
        }
    }
    return $false
}

function Main{
    Set-Location $root

    # -- prerequisites --------------------------------------------------------

    Write-Step "Checking prerequisites"
    $missing = @()

    if(Test-Command node){
        $major = [int](& node -p "process.versions.node.split('.')[0]")
        if($major -lt 22){
            $missing += "Node 22+ (found $(& node -v)) - winget install OpenJS.NodeJS.LTS"
        }
    }else{
        $missing += "Node 22+ - winget install OpenJS.NodeJS.LTS"
    }
    if(-not (Test-Command npm)){
        $missing += "npm - ships with Node"
    }

    $triple = $null
    if((Test-Command cargo) -and (Test-Command rustc)){
        $line = & rustc -vV | Where-Object { $_ -like "host:*" }
        $triple = ([string]$line).Substring(5).Trim()
        # fetch-uv.mjs maps only the msvc triples, and Tauri wants MSVC anyway.
        if($triple -notlike "*-pc-windows-msvc"){
            $missing += "Rust MSVC toolchain (host is $triple) - rustup default stable-msvc"
        }
    }else{
        $missing += "Rust stable - winget install Rustlang.Rustup"
    }

    $vcComponent = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
    if($null -ne $triple -and $triple -like "aarch64-*"){
        $vcComponent = "Microsoft.VisualStudio.Component.VC.Tools.ARM64"
    }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    $vcPath = $null
    if(Test-Path $vswhere){
        $vcPath = & $vswhere -latest -products * -requires $vcComponent -property installationPath
    }
    if(-not $vcPath){
        $missing += "MSVC C++ build tools - winget install Microsoft.VisualStudio.2022.BuildTools --override `"--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended`""
    }

    if(-not (Test-Command uv)){
        $missing += "uv - winget install astral-sh.uv"
    }

    if($missing.Count -gt 0){
        Write-Host "missing:" -ForegroundColor Red
        foreach($m in $missing){
            Write-Host "  - $m"
        }
        Write-Host ""
        Write-Host "Open a new terminal after installing, so PATH picks them up."
        exit 1
    }

    # Needed to run the app, not to build it: the installer fetches it itself.
    if(-not (Test-WebView2)){
        Write-Warn "WebView2 runtime not found; the built app will not start here until it is installed. winget install Microsoft.EdgeWebView2Runtime"
    }
    if(-not (Test-Command tesseract)){
        Write-Warn "tesseract is not on PATH; the OCR tests will skip. winget install UB-Mannheim.TesseractOCR"
    }
    Write-Host "node $(& node -v), $(& rustc --version), $(& uv --version)"

    $version = (Get-Content (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json).version
    Write-Host "building PicSearch $version"

    # -- dependencies ---------------------------------------------------------

    if(-not $skipInstall){
        Write-Step "Installing npm dependencies"
        Invoke-Native npm @("ci")
    }elseif(-not (Test-Path (Join-Path $root "node_modules"))){
        throw "-SkipInstall given but node_modules\ does not exist"
    }

    # -- tests ----------------------------------------------------------------

    if(-not $skipTests){
        Write-Step "Frontend: typecheck + vitest"
        Invoke-Native npm @("run", "typecheck")
        Invoke-Native npm @("test")

        Write-Step "Sidecar: ruff + pytest (CPU torch, sidecar\.venv-build)"
        $savedEnv = $env:UV_PROJECT_ENVIRONMENT
        $savedNoSync = $env:UV_NO_SYNC
        Push-Location (Join-Path $root "sidecar")
        try{
            $env:UV_PROJECT_ENVIRONMENT = Join-Path $root "sidecar\.venv-build"
            $env:UV_NO_SYNC = "1"
            Invoke-Native uv @("sync", "--frozen", "--no-default-groups", "--group", "dev", "--group", "cpu")
            Invoke-Native uv @("run", "--no-sync", "ruff", "check", ".")
            Invoke-Native uv @("run", "--no-sync", "pytest", "-q")
        }finally{
            Pop-Location
            $env:UV_PROJECT_ENVIRONMENT = $savedEnv
            $env:UV_NO_SYNC = $savedNoSync
        }
    }

    # -- package --------------------------------------------------------------

    Write-Step "Packaging"
    $start = Get-Date
    Invoke-Native node (@((Join-Path $root "scripts\package.mjs")) + $extra)

    # -- collect --------------------------------------------------------------

    Write-Step "Collecting into release\"
    $bundle = Join-Path $root "src-tauri\target\release\bundle"
    $release = Join-Path $root "release"
    if(Test-Path $release){
        Remove-Item $release -Recurse -Force
    }
    New-Item -ItemType Directory -Path $release | Out-Null

    # Built this run and for this version only: bundle\ keeps every earlier build.
    $built = @(Get-ChildItem -Path (Join-Path $bundle "nsis"), (Join-Path $bundle "msi") -File -ErrorAction SilentlyContinue |
        Where-Object {
            $_.LastWriteTime -ge $start -and
            $_.Name -like "*_${version}_*" -and
            ($_.Extension -eq ".exe" -or $_.Extension -eq ".msi")
        })
    if($built.Count -eq 0){
        throw "tauri build finished but no installer for $version was written under $bundle"
    }

    # sha256sum's format, so `sha256sum -c SHA256SUMS` checks it on Linux too.
    $sums = ""
    foreach($file in $built){
        Copy-Item $file.FullName $release
        $hash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $sums += "$hash  $($file.Name)`n"
    }
    [System.IO.File]::WriteAllText((Join-Path $release "SHA256SUMS"), $sums)

    Write-Host ""
    Get-ChildItem $release | Format-Table Name, @{ Label = "MB"; Expression = { [math]::Round($_.Length / 1MB, 1) } } -AutoSize
}

try{
    Main
}catch{
    Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
