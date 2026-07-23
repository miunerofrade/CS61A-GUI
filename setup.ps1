$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

Write-Host "正在准备 Python 环境..." -ForegroundColor Cyan
uv sync --extra dev

Write-Host "正在准备前端..." -ForegroundColor Cyan
Push-Location -LiteralPath "frontend"
try {
    npm ci --no-audit --no-fund
    npm run build
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "安装完成。运行 .\start.ps1 启动 61A Workspace。" -ForegroundColor Green
