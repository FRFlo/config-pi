$ErrorActionPreference = 'Stop'

$installer = if (Get-Command bun -ErrorAction SilentlyContinue) {
    'bun'
} elseif (Get-Command npm -ErrorAction SilentlyContinue) {
    'npm'
} else {
    throw 'Neither bun nor npm was found in PATH.'
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bases = @('extensions', 'git') | ForEach-Object { Join-Path $root $_ }

foreach ($base in $bases) {
    if (-not (Test-Path -LiteralPath $base -PathType Container)) { continue }

    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($base)
    while ($pending.Count -gt 0) {
        $dir = $pending.Pop()
        if (Test-Path -LiteralPath (Join-Path $dir 'package.json') -PathType Leaf) {
            Write-Host "Installing dependencies in $dir using $installer..."
            Push-Location $dir
            try {
                if ($installer -eq 'bun') { & bun i } else { & npm i }
                if ($LASTEXITCODE -ne 0) { throw "Install failed in $dir (exit code $LASTEXITCODE)." }
            } finally {
                Pop-Location
            }
        }

        Get-ChildItem -LiteralPath $dir -Directory -Force |
            Where-Object { $_.Name -ne 'node_modules' } |
            ForEach-Object { $pending.Push($_.FullName) }
    }
}

Write-Host 'All extension dependencies installed.'
