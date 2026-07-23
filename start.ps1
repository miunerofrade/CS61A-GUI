$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath ".venv")) {
    Write-Host "尚未安装依赖，请先运行 .\setup.ps1" -ForegroundColor Yellow
    exit 1
}
if (-not (Test-Path -LiteralPath "frontend\dist\index.html")) {
    Write-Host "前端尚未构建，请先运行 .\setup.ps1" -ForegroundColor Yellow
    exit 1
}
uv run cs61a-gui
