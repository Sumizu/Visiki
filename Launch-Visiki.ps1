$ErrorActionPreference = 'Stop'
$launcherPath = $PSCommandPath
$appDirectory = Split-Path -Parent $launcherPath
$releaseDirectory = Split-Path -Parent $appDirectory
$portable = (Split-Path -Leaf $appDirectory) -ieq 'app'
$entryPoint = Join-Path $appDirectory 'electron\main.cjs'
$launcherLog = Join-Path $env:TEMP ('Visiki-launcher-' + $PID + '.log')
try {
    if ($portable) {
        $electronExecutable = Join-Path $releaseDirectory 'runtime\electron\electron.exe'
        $ffmpegExecutable = Join-Path $releaseDirectory 'runtime\ffmpeg\ffmpeg.exe'
        $requiredFiles = @($electronExecutable, $ffmpegExecutable, $entryPoint,
            (Join-Path $appDirectory 'dist\index.html'), (Join-Path $appDirectory 'dist-server\server.cjs'))
        $missingFiles = @($requiredFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
        if ($missingFiles.Count) { throw ('发布包文件不完整。请完整解压 ZIP 后再启动，不要在压缩包内直接运行。缺少：' + [Environment]::NewLine + ($missingFiles -join [Environment]::NewLine)) }
        $dataDirectory = Join-Path $appDirectory '.demo-data'
        try {
            [System.IO.Directory]::CreateDirectory((Join-Path $dataDirectory 'logs')) | Out-Null
            $writeProbe = Join-Path $dataDirectory ('.write-check-' + $PID)
            [System.IO.File]::WriteAllText($writeProbe, 'ok')
            Remove-Item -LiteralPath $writeProbe
        } catch { throw ('无法在应用目录保存工程和设置。请把整个文件夹移动到可写的位置（如桌面或个人磁盘目录），避免 Program Files、只读目录和压缩包内部。' + [Environment]::NewLine + $_.Exception.Message) }
        $launcherLog = Join-Path $dataDirectory 'logs\launcher.log'
        $env:FFMPEG_PATH = $ffmpegExecutable
        $env:VISIKI_DATA_DIR = $dataDirectory
        Remove-Item Env:PORT -ErrorAction SilentlyContinue
        Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    } else {
        $electronExecutable = Join-Path $appDirectory 'node_modules\electron\dist\electron.exe'
        if (-not (Test-Path -LiteralPath $electronExecutable)) { throw 'Electron 运行依赖缺失，请先在 demo 目录执行 npm install --legacy-peer-deps。' }
        if (-not (Test-Path -LiteralPath (Join-Path $appDirectory 'dist\index.html'))) { throw '构建结果缺失，请先执行 npm run build。' }
        if (-not (Test-Path -LiteralPath (Join-Path $appDirectory 'dist-server\server.cjs'))) { throw '本地服务构建缺失，请先执行 npm run build。' }
        if (-not $env:FFMPEG_PATH) {
            $ffmpegCommand = Get-Command ffmpeg -ErrorAction SilentlyContinue
            if ($ffmpegCommand) { $env:FFMPEG_PATH = $ffmpegCommand.Source }
        }
    }
    # Keep a branded entry beside the launcher, never on the user's desktop.
    # Rebuild its absolute paths after the portable folder has moved.
    try {
        $iconPath = Join-Path $appDirectory 'dist\branding\visiki.ico'
        if (Test-Path -LiteralPath $iconPath -PathType Leaf) {
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut((Join-Path $releaseDirectory 'Visiki.lnk'))
            $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'
            $shortcut.WorkingDirectory = $appDirectory
            $shortcut.IconLocation = $iconPath + ',0'
            $shortcut.Description = 'Visiki · 音乐视频编辑器'
            $shortcut.WindowStyle = 7
            $shortcut.Save()
        }
    } catch {
        try { [System.IO.File]::AppendAllText($launcherLog, ('[{0:o}] Shortcut: {1}{2}' -f (Get-Date), $_.Exception.Message, [Environment]::NewLine)) } catch {}
    }
    # Electron owns an interactive window; hiding its process can hide the window.
    Remove-Item Env:VISIKI_SMOKE -ErrorAction SilentlyContinue
    Remove-Item Env:ECHO_SMOKE -ErrorAction SilentlyContinue
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    if ($portable) {
        $launch = Start-Process -FilePath $electronExecutable -ArgumentList @('"' + $entryPoint + '"') -WorkingDirectory $appDirectory -WindowStyle Normal -PassThru
        [System.IO.File]::AppendAllText($launcherLog, ('[{0:o}] Started PID {1}: {2}{3}' -f (Get-Date), $launch.Id, $entryPoint, [Environment]::NewLine))
    } else {
        Start-Process -FilePath $electronExecutable -ArgumentList @('"' + $entryPoint + '"') -WorkingDirectory $appDirectory -WindowStyle Normal
    }
} catch {
    $failure = $_.Exception.Message
    try { [System.IO.File]::AppendAllText($launcherLog, ('[{0:o}] {1}{2}' -f (Get-Date), $_.ToString(), [Environment]::NewLine)) } catch {}
    Write-Host ('Visiki启动失败：' + $failure) -ForegroundColor Red
    Write-Host ('日志：' + $launcherLog)
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show(($failure + [Environment]::NewLine + [Environment]::NewLine + '日志：' + $launcherLog), 'Visiki启动失败', 'OK', 'Error') | Out-Null
    } catch {}
    exit 1
}
