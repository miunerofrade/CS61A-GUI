param(
    [string]$Version = "1.0.0"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseRoot = Join-Path $projectRoot "release"
$buildRoot = Join-Path $releaseRoot "build"
$workRoot = Join-Path $releaseRoot "work"
$packageDir = Join-Path $buildRoot "CS61A-GUI"
$archiveName = "CS61A-GUI-Windows-x64-v$Version.zip"
$archivePath = Join-Path $releaseRoot $archiveName
$hashPath = "$archivePath.sha256"
$pythonVersion = "3.12.10"
$pythonArchive = Join-Path $releaseRoot "python-embed.zip"

if (-not $releaseRoot.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release path escaped the project root."
}

if (Test-Path -LiteralPath $releaseRoot) {
    Remove-Item -LiteralPath $releaseRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $releaseRoot | Out-Null

Push-Location $projectRoot
try {
    npm --prefix frontend ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }

    $previousRuntime = $env:VITE_RUNTIME_MODE
    $env:VITE_RUNTIME_MODE = "desktop"
    try {
        npm --prefix frontend run build
        if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }
    }
    finally {
        if ($null -eq $previousRuntime) {
            Remove-Item Env:VITE_RUNTIME_MODE -ErrorAction SilentlyContinue
        }
        else {
            $env:VITE_RUNTIME_MODE = $previousRuntime
        }
    }

    uv run --with pyinstaller pyinstaller `
        --noconfirm `
        --clean `
        --onedir `
        --name CS61A-GUI `
        --paths backend `
        --add-data "$projectRoot/frontend/dist;frontend/dist" `
        --distpath $buildRoot `
        --workpath $workRoot `
        --specpath $releaseRoot `
        launcher.py
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed." }

    Copy-Item -LiteralPath (Join-Path $projectRoot "LOCAL-README.md") `
        -Destination (Join-Path $packageDir "使用说明.md")

    Invoke-WebRequest `
        -Uri "https://www.python.org/ftp/python/$pythonVersion/python-$pythonVersion-embed-amd64.zip" `
        -OutFile $pythonArchive
    $pythonDir = Join-Path $packageDir "python"
    New-Item -ItemType Directory -Path $pythonDir | Out-Null
    Expand-Archive -LiteralPath $pythonArchive -DestinationPath $pythonDir

    Compress-Archive -LiteralPath $packageDir -DestinationPath $archivePath -Force

    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath $hashPath -Value "$hash *$archiveName" -Encoding ascii

    Write-Host "Created $archivePath"
    Write-Host "SHA-256: $hash"
}
finally {
    Pop-Location
}
