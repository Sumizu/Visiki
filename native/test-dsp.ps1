$ErrorActionPreference='Stop'
$nativeRoot=$PSScriptRoot
$appRoot=Split-Path -Parent $nativeRoot
$buildRoot=Join-Path $appRoot 'dist-native'
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
$vswhere='C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if(-not(Test-Path -LiteralPath $vswhere)){throw 'DSP fixture requires Visual Studio C++ Build Tools.'}
$installPath=(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if(-not $installPath){throw 'Visual Studio C++ compiler was not found.'}
$vcvars=Join-Path $installPath 'VC\Auxiliary\Build\vcvars64.bat'
$batch=Join-Path $buildRoot 'compile-dsp-fixture.cmd'
$commands=@"
@echo off
call "$vcvars" >nul
if errorlevel 1 exit /b 1
cd /d "$appRoot"
cl /nologo /std:c++17 /EHsc /O2 /W4 /MT /utf-8 "tests\native-dsp-fixture.cpp" /Fo"$buildRoot\native-dsp-fixture.obj" /Fe"$buildRoot\native-dsp-fixture.exe"
exit /b %errorlevel%
"@
[System.IO.File]::WriteAllText($batch,$commands,[System.Text.Encoding]::Default)
& $env:ComSpec /d /c $batch
if($LASTEXITCODE -ne 0){throw 'Native DSP fixture did not compile.'}
& (Join-Path $buildRoot 'native-dsp-fixture.exe')
if($LASTEXITCODE -ne 0){throw 'Native DSP fixture failed.'}
