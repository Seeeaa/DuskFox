# 准备一个独立的 QQ 测试实例（只改副本，不动已安装的 QQ 与本机大号）。
# 用法示例：
#   powershell -ExecutionPolicy Bypass -File tools\prepare-qq-test.ps1 -Source "C:\Program Files\Tencent\QQNT" -Target "D:\QQNT-test"
param(
  [Parameter(Mandatory = $true)] [string] $Source,
  [Parameter(Mandatory = $true)] [string] $Target,
  [string] $BridgeRoot = (Join-Path (Split-Path $PSScriptRoot -Parent) "runtime\bridge")
)

$ErrorActionPreference = "Stop"
$Source = (Resolve-Path $Source).Path.TrimEnd('\')
$Target = [System.IO.Path]::GetFullPath($Target).TrimEnd('\')

if ($Target -eq $Source) { throw "Target 不能等于 Source：这会修改已安装的 QQ" }
if (Test-Path $Target) { throw "目标已存在：$Target（请先确认是否为可复用的测试副本）" }
foreach ($required in @("QQ.exe", "resources\app\package.json", "resources\app\wrapper.node")) {
  if (-not (Test-Path (Join-Path $Source $required))) { throw "源目录缺少 $required，确认这是 QQNT 安装目录" }
}

Write-Host "复制 QQ 到测试目录（只读源，不改源）..."
robocopy $Source $Target /E /NJH /NJS /NFL /NDL /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }

$appDir = Join-Path $Target "resources\app"
$pkgPath = Join-Path $appDir "package.json"
Copy-Item $pkgPath "$pkgPath.original" -Force

foreach ($file in @("entry.cjs", "server.mjs", "native-kernel.cjs", "sim-kernel.mjs", "event-stream.mjs", "capabilities.mjs", "login-pump.mjs")) {
  $from = Join-Path $BridgeRoot $file
  if (-not (Test-Path $from)) { throw "缺少运行时文件：$from" }
  Copy-Item $from (Join-Path $appDir $file) -Force
}

foreach ($directory in @("kernel", "routes")) {
  Copy-Item -LiteralPath (Join-Path $BridgeRoot $directory) -Destination $appDir -Recurse -Force
}

$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.main = "./entry.cjs"
$pkg | ConvertTo-Json -Depth 20 | Set-Content $pkgPath -Encoding UTF8

$launcher = Join-Path $Target "start-duskfox-test.cmd"
@'
@echo off
setlocal
set QQ_BRIDGE_PASSWORD_LOGIN=1
set QQ_BRIDGE_IMAGE_SEND=1
set QQ_NATIVE_UI_PORT=16082
set QQ_NATIVE_UI_HOST=127.0.0.1
start "" "%~dp0QQ.exe"
endlocal
'@ | Set-Content $launcher -Encoding ASCII

Write-Host ""
Write-Host "完成。只改动了副本：$Target"
Write-Host "  package.json 已备份为 package.json.original，main -> ./entry.cjs"
Write-Host "  启动脚本：$launcher"
Write-Host "  桥接口：http://127.0.0.1:16082（令牌在 %USERPROFILE%\.qq-native-bridge\admin.token）"
Write-Host ""
Write-Host "注意："
Write-Host "  1. 启动后需要在该实例里用密码登录测试号；可能触发设备验证，控制台会显示具体错误。"
Write-Host "  2. 这不是本机已安装的 QQ，主号不会被影响；但两个 QQ 实例会同时占用桌面，属正常现象。"
Write-Host "  3. 卸载/清理 = 直接删除 $Target。"
