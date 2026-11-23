$ErrorActionPreference='Stop'
$nativeRoot=$PSScriptRoot
$appRoot=Split-Path -Parent $nativeRoot
$buildRoot=Join-Path $appRoot 'dist-native'
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
$vswhere='C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if(-not(Test-Path -LiteralPath $vswhere)){throw 'Native build requires Visual Studio C++ Build Tools.'}
$installPath=(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if(-not $installPath){throw 'Visual Studio C++ compiler was not found.'}
$vcvars=Join-Path $installPath 'VC\Auxiliary\Build\vcvars64.bat'
$cmake=(Get-Command cmake.exe -ErrorAction SilentlyContinue).Source
if(-not $cmake){
    $cmake=Join-Path $installPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
}
if(-not(Test-Path -LiteralPath $cmake)){throw 'Native build requires CMake 3.25 or newer.'}
$ninja=(Get-Command ninja.exe -ErrorAction SilentlyContinue).Source
if(-not $ninja){
    $ninja=Join-Path $installPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe'
}
if(Test-Path -LiteralPath $ninja){
    $generator = "-G Ninja `"-DCMAKE_MAKE_PROGRAM=$ninja`""
}else{
    $generator = '-A x64'
}
$objectRoot=Join-Path $buildRoot 'cmake'
$batch=Join-Path $buildRoot 'compile-native.cmd'
$commands=@"
@echo off
chcp 65001 >nul
set VSLANG=1033
call "$vcvars" >nul
if errorlevel 1 exit /b 1
"$cmake" -S "$nativeRoot" -B "$objectRoot" $generator -DCMAKE_BUILD_TYPE=Release "-DVISIKI_NATIVE_OUTPUT=$buildRoot"
if errorlevel 1 exit /b 1
"$cmake" --build "$objectRoot" --config Release --target VisikiAudioHost --clean-first --parallel 4
exit /b %errorlevel%
"@
[System.IO.File]::WriteAllText($batch,$commands,[System.Text.Encoding]::Default)
& $env:ComSpec /d /c $batch
if($LASTEXITCODE -ne 0){throw 'Native audio build failed.'}
$buildNode=$env:VISIKI_BUILD_NODE
if(-not $buildNode){$buildNode=(Get-Command node -ErrorAction Stop).Source}
& $buildNode (Join-Path $nativeRoot 'check-build.cjs') --record
if($LASTEXITCODE -ne 0){throw 'Native audio build fingerprint could not be recorded.'}
