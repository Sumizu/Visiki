param(
    [Parameter(Mandatory=$true)][string]$ReleaseRoot,
    [string]$SourceProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$NodeExecutable = 'node'
)
$ErrorActionPreference = 'Stop'
function Get-NativeAudioHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
$projectDirectory = [IO.Path]::GetFullPath($SourceProjectRoot).TrimEnd('\')
$releaseDirectory = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\')
if ($releaseDirectory.Equals($projectDirectory, [StringComparison]::OrdinalIgnoreCase) -or
    $releaseDirectory.StartsWith($projectDirectory + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $projectDirectory.StartsWith($releaseDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The release staging directory must be separate from the source project.'
}
if (-not (Test-Path -LiteralPath $releaseDirectory -PathType Container)) { throw 'Create the clean release staging directory first.' }
if (Test-Path -LiteralPath (Join-Path $releaseDirectory 'app\.demo-data')) { throw 'Refuse to update a release directory containing personal data.' }
& $NodeExecutable (Join-Path $projectDirectory 'native\check-build.cjs') --check
if ($LASTEXITCODE -ne 0) { throw 'Build the current native audio host before assembling a release.' }

$files = [ordered]@{
    'app/dist-native/VisikiAudioHost.exe' = 'dist-native/VisikiAudioHost.exe'
    'app/dist-native/build-info.json' = 'dist-native/build-info.json'
    'licenses/native-audio/miniaudio-LICENSE.txt' = 'native/vendor/miniaudio/LICENSE'
    'licenses/native-audio/json-LICENSE.MIT' = 'native/vendor/json/LICENSE.MIT'
    'licenses/native-audio/libebur128-COPYING.txt' = 'native/vendor/libebur128/COPYING'
    'licenses/native-audio/libebur128-queue.h' = 'native/vendor/libebur128/ebur128/queue/sys/queue.h'
    'licenses/native-audio/steinberg-vst3-sdk-LICENSE.txt' = 'native/vendor/vst3sdk/LICENSE.txt'
    'licenses/native-audio/sources.json' = 'native/vendor/sources.json'
    'licenses/native-audio/THIRD_PARTY_NOTICES.md' = 'native/vendor/THIRD_PARTY_NOTICES.md'
}
# Use the source tree, never dist-native: this excludes object files, compiler
# command files and fixture executables from both runtime and source materials.
foreach ($file in (Get-ChildItem -LiteralPath (Join-Path $projectDirectory 'native') -File -Recurse)) {
    if ($file.Extension -in @('.exe','.obj','.pdb','.ilk','.log','.cmd')) { continue }
    $relative = $file.FullName.Substring($projectDirectory.Length + 1).Replace('\','/')
    $files['source/' + $relative] = $relative
}
foreach ($relative in $files.Values) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory $relative) -PathType Leaf)) { throw "Missing native audio release input: $relative" }
}
foreach ($destinationRelative in $files.Keys) {
    $relative = $files[$destinationRelative]
    $destination = Join-Path $releaseDirectory $destinationRelative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectDirectory $relative) -Destination $destination -Force
    if ((Get-NativeAudioHash $destination) -ne
        (Get-NativeAudioHash (Join-Path $projectDirectory $relative))) { throw "Native audio release copy changed: $relative" }
}
$build = Get-Content -LiteralPath (Join-Path $projectDirectory 'dist-native\build-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
[PSCustomObject]@{
    engine = 'Visiki Native DSP'
    executable = 'app/dist-native/VisikiAudioHost.exe'
    platform = $build.platform
    arch = $build.arch
    binarySha256 = $build.binarySha256
    sourceSha256 = $build.sourceSha256
    filesCopied = $files.Count
    compilerNeededAtRuntime = $false
} | ConvertTo-Json
