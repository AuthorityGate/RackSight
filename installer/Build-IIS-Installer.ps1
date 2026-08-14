#Requires -Version 5.1
[CmdletBinding()]
param([string]$OutputPath,[string]$Version='1.1.8',[string]$CertificateThumbprint='787D83F3BFFD136E8D2F8AD3261FD15D393FAC7A')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
if(-not $OutputPath){$OutputPath=Join-Path $root 'release-iis'}
if(Test-Path $OutputPath){Remove-Item $OutputPath -Recurse -Force}
$stage=Join-Path $OutputPath 'stage';New-Item $stage -ItemType Directory -Force|Out-Null
foreach($item in @('server.js','public','package.json','package-lock.json','node_modules','docs','LICENSE')){Copy-Item (Join-Path $root $item) (Join-Path $stage $item) -Recurse -Force}
$nodeRuntime=(Get-Command node.exe -ErrorAction Stop).Source
Copy-Item $nodeRuntime (Join-Path $stage 'node.exe') -Force
$zip=Join-Path $OutputPath 'payload.zip';Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory($stage,$zip,'Optimal',$false)
$installer=Get-Content (Join-Path $PSScriptRoot 'Install-IIS-Package.ps1') -Raw
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($installer))
$source=@"
using System;using System.Diagnostics;using System.IO;using System.Reflection;using System.Security.Principal;
class RackSightIISInstaller{[STAThread]static void Main(string[] args){bool silent=Array.Exists(args,a=>a.Equals("/silent",StringComparison.OrdinalIgnoreCase)||a.Equals("/quiet",StringComparison.OrdinalIgnoreCase));if(!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)){var elevated=Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,silent?"/silent":""){Verb="runas",UseShellExecute=true});elevated.WaitForExit();Environment.ExitCode=elevated.ExitCode;return;}string z=Path.Combine(Path.GetTempPath(),"RackSight-IIS-"+Guid.NewGuid().ToString("N")+".zip");using(Stream s=Assembly.GetExecutingAssembly().GetManifestResourceStream("RackSightPayload"))using(FileStream f=File.Create(z))s.CopyTo(f);var i=new ProcessStartInfo("powershell.exe","-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"){UseShellExecute=false,CreateNoWindow=silent};i.EnvironmentVariables["AUTHORITYGATE_RACKSIGHT_PAYLOAD"]=z;i.EnvironmentVariables["AUTHORITYGATE_RACKSIGHT_SILENT"]=silent?"1":"0";i.EnvironmentVariables["AUTHORITYGATE_SETUP_SOURCE"]=Process.GetCurrentProcess().MainModule.FileName;i.EnvironmentVariables["AUTHORITYGATE_SETUP_VERSION"]="$Version";var p=Process.Start(i);p.WaitForExit();Environment.ExitCode=p.ExitCode;if(File.Exists(z))File.Delete(z);}}
"@
$cs=Join-Path $OutputPath 'installer.cs';Set-Content $cs $source -Encoding UTF8
$exe=Join-Path $OutputPath "RackSight-IIS-Server-$Version.exe"
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /platform:x64 /resource:"$zip,RackSightPayload" /out:$exe $cs
if($LASTEXITCODE-ne 0){throw 'RackSight IIS installer compilation failed.'}
$signTool=Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Filter signtool.exe -Recurse|Where-Object FullName -Match '\\x64\\signtool.exe$'|Sort-Object FullName -Descending|Select-Object -First 1 -ExpandProperty FullName
& $signTool sign /sha1 $CertificateThumbprint /fd SHA256 /tr http://timestamp.globalsign.com/tsa/r6advanced1 /td SHA256 $exe
if($LASTEXITCODE-ne 0-or(Get-AuthenticodeSignature $exe).Status-ne 'Valid'){throw 'RackSight IIS signing or verification failed.'}
Remove-Item $stage,$zip,$cs -Recurse -Force
Write-Host "Built and signed: $exe" -ForegroundColor Green
