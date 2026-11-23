param(
    [string]$PackageRoot = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

try {
    $rootItem = Get-Item -LiteralPath $PackageRoot
    if (-not $rootItem.PSIsContainer) {
        throw 'PackageRoot must be the extracted Visiki package directory.'
    }

    $root = $rootItem.FullName
    $runtime = Join-Path $root 'runtime\electron\electron.exe'
    $server = Join-Path $root 'app\mcp\server.cjs'
    $endpoint = Join-Path $root 'app\.demo-data\agent-endpoint.json'

    foreach ($requiredFile in @($runtime, $server)) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            throw "Package file not found: $requiredFile. Extract the complete package first."
        }
    }

    $config = [ordered]@{
        mcpServers = [ordered]@{
            visiki = [ordered]@{
                command = $runtime
                args = @($server, '--endpoint-file', $endpoint)
                env = [ordered]@{ ELECTRON_RUN_AS_NODE = '1' }
            }
        }
    }

    # Keep this script ASCII-compatible with Windows PowerShell 5.1.
    $fileName = 'MCP' + [char]0x914D + [char]0x7F6E + '.json'
    $outputPath = Join-Path $root $fileName
    $json = ($config | ConvertTo-Json -Depth 8) + [Environment]::NewLine
    [IO.File]::WriteAllText($outputPath, $json, (New-Object Text.UTF8Encoding($false)))
    Write-Host "MCP configuration saved: $outputPath"
    Write-Host 'Add its visiki entry to your MCP client. Run this script again after moving the package.'
    exit 0
} catch {
    [Console]::Error.WriteLine("Could not generate MCP configuration: $($_.Exception.Message)")
    exit 1
}
