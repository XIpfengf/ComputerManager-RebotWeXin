param(
    [Parameter(Position = 0)]
    [ValidateSet('help', 'status', 'doctor', 'login', 'start', 'stop', 'config', 'setup', 'startup')]
    [string]$Command = 'status',
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CommandArguments
)

$implementationRoot = Join-Path $PSScriptRoot '..\vendor\codex-ilink'
if ($Command -eq 'startup' -and $CommandArguments.Count -eq 1 -and $CommandArguments[0] -eq 'enable') {
    & node --disable-warning=ExperimentalWarning --experimental-strip-types (Join-Path $PSScriptRoot 'register-startup.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Startup registration failed' }
    return
}
Push-Location -LiteralPath $implementationRoot
try {
    & node --disable-warning=ExperimentalWarning --experimental-strip-types src/cli/main.ts $Command @CommandArguments
    if ($LASTEXITCODE -ne 0) { throw "ilink $Command failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}
