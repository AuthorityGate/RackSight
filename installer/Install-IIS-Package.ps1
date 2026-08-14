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

$installedSetup = Join-Path $installRoot 'RackSight-IIS-Setup.exe'
Copy-Item $env:AUTHORITYGATE_SETUP_SOURCE $installedSetup -Force
$uninstaller = Join-Path $installRoot 'Uninstall.cmd'
$uninstallScript = @"
@echo off
set "INSTALL_ROOT=$installRoot"
set "START_MENU=$startMenu"
if exist "%START_MENU%" rmdir /s /q "%START_MENU%"
reg delete "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AuthorityGate RackSight IIS Server" /f >nul 2>&1
start "" /b cmd /c "ping 127.0.0.1 -n 3 > nul & rmdir /s /q \"%INSTALL_ROOT%\""
"@
Set-Content $uninstaller $uninstallScript -Encoding ASCII
$uninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AuthorityGate RackSight IIS Server'
New-Item $uninstallKey -Force | Out-Null
Set-ItemProperty $uninstallKey DisplayName 'AuthorityGate RackSight IIS Server'
Set-ItemProperty $uninstallKey DisplayVersion $env:AUTHORITYGATE_SETUP_VERSION
Set-ItemProperty $uninstallKey Publisher 'AuthorityGate Inc.'
Set-ItemProperty $uninstallKey InstallLocation $installRoot
Set-ItemProperty $uninstallKey UninstallString ('"' + $uninstaller + '"')
Set-ItemProperty $uninstallKey QuietUninstallString ('"' + $uninstaller + '" /silent')
Set-ItemProperty $uninstallKey NoModify 1
Set-ItemProperty $uninstallKey NoRepair 1
Set-ItemProperty $uninstallKey EstimatedSize ([int]((Get-ChildItem $installRoot -Recurse -File | Measure-Object Length -Sum).Sum / 1KB))

if ($env:AUTHORITYGATE_RACKSIGHT_SILENT -ne '1') { Start-Process (Join-Path $installRoot 'docs\INSTALL-IIS.md') }
