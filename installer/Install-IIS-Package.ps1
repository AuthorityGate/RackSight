$ErrorActionPreference = 'Stop'
$payload = $env:AUTHORITYGATE_RACKSIGHT_PAYLOAD
if (-not (Test-Path $payload)) { throw 'The embedded RackSight IIS payload could not be opened.' }
$installRoot = Join-Path $env:ProgramFiles 'AuthorityGate\RackSight-Web'
$dataRoot = Join-Path $env:ProgramData 'AuthorityGate\RackSight'
if (Test-Path $installRoot) { Remove-Item $installRoot -Recurse -Force }
New-Item $installRoot,$dataRoot -ItemType Directory -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($payload,$installRoot)

$launcher = @"
@echo off
set HOST=127.0.0.1
set PORT=3000
set RACKSIGHT_DATA_DIR=$dataRoot
cd /d "$installRoot"
node.exe server.js
"@
Set-Content (Join-Path $installRoot 'Start-RackSight-IIS.cmd') $launcher -Encoding ASCII

$startMenu = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'AuthorityGate\RackSight IIS Server'
New-Item $startMenu -ItemType Directory -Force | Out-Null
$shell = New-Object -ComObject WScript.Shell
$docs = $shell.CreateShortcut((Join-Path $startMenu 'RackSight IIS Installation Guide.lnk'))
$docs.TargetPath = Join-Path $installRoot 'docs\INSTALL-IIS.md'
$docs.Save()
$server = $shell.CreateShortcut((Join-Path $startMenu 'Run RackSight Server.lnk'))
$server.TargetPath = Join-Path $installRoot 'Start-RackSight-IIS.cmd'
$server.WorkingDirectory = $installRoot
$server.Save()
Start-Process (Join-Path $installRoot 'docs\INSTALL-IIS.md')
