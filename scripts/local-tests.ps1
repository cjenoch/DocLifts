#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('up', 'status', 'stop', 'gate', 'lint', 'server', 'client', 'e2e')]
    [string]$Action = 'gate',
    [string[]]$TestFilter = @()
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$compose = Join-Path $repo 'compose.test.yml'
$state = Join-Path $env:LOCALAPPDATA 'DocLifts/local-tests'
New-Item -ItemType Directory -Force -Path $state | Out-Null

function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed (exit $LASTEXITCODE)" }
}
function Invoke-Compose {
    Invoke-Docker compose --project-name doclifts-local-test --project-directory $repo -f $compose @args
}

# Shared across checkouts, so a second Codex chat cannot replace an active run's
# source or reset its database. Never borrow a production Docker context.
$endpoint = & docker context inspect --format '{{.Endpoints.docker.Host}}'
if ($LASTEXITCODE -ne 0 -or $env:DOCKER_HOST -or $endpoint -notmatch '^npipe://') {
    throw 'Select the local Docker Desktop context and unset DOCKER_HOST first.'
}
try {
    $lock = [IO.File]::Open((Join-Path $state 'stack.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
    throw 'Another local-tests.ps1 command is using the test stack. Wait for it to finish.'
}
$snapshot = $null
try {
    if ($Action -eq 'status') { Invoke-Compose ps; return }
    if ($Action -eq 'stop') { Invoke-Compose stop; return }
    Invoke-Compose up -d --wait --build
    if ($Action -eq 'up') { Invoke-Compose ps; return }

    $snapshot = Join-Path $state ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $snapshot | Out-Null
    # Include working-tree edits and nonignored new files; never ship the host
    # dependency tree, .git, .env files, private keys, or deleted tracked paths.
    $files = & git -C $repo -c core.quotepath=false ls-files --cached --others --exclude-standard
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate checkout files' }
    $files = @($files | Sort-Object -Unique | Where-Object {
        ($_ -eq '.env.example' -or $_ -notmatch '(^|/)\.env[^/]*$') -and
        $_ -notmatch '(^|/)(node_modules|\.git)(/|$)' -and
        $_ -notmatch '\.(pem|key|crt)$' -and (Test-Path -LiteralPath (Join-Path $repo $_))
    })
    foreach ($file in $files) {
        if ($file -match '[\r\n]' -or $file.StartsWith('-') -or $file.StartsWith('"')) {
            throw "Unsupported snapshot filename: $file"
        }
        $entry = Get-Item -LiteralPath (Join-Path $repo $file)
        # OneDrive uses reparse points for ordinary hydrated files too.
        if ($entry.PSIsContainer -or $entry.LinkType -in @('SymbolicLink', 'Junction')) {
            throw "Snapshot requires a regular file: $file"
        }
    }
    $manifest = Join-Path $snapshot 'files.txt'
    [IO.File]::WriteAllLines($manifest, $files, [Text.UTF8Encoding]::new($false))
    $archive = Join-Path $snapshot 'source.tar'
    & tar -cf $archive -C $repo -T $manifest
    if ($LASTEXITCODE -ne 0) { throw 'Source snapshot failed' }
    $sha = & git -C $repo rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Cannot identify checkout revision' }
    # Bundle a root commit of HEAD's tree. This works with shallow checkouts
    # too, without copying host configuration/hooks or fetching old history.
    # The temporary bare repo reads shared objects but writes only to itself.
    $baselineRepo = Join-Path $snapshot 'baseline.git'
    & git clone --quiet --bare --shared -- $repo $baselineRepo
    if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare checkout baseline' }
    $baselineCommit = & git -C $baselineRepo -c user.name='Local test snapshot' -c user.email='snapshot@doclifts.invalid' commit-tree 'HEAD^{tree}' -m 'Committed tree for local tests'
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create checkout baseline' }
    & git -C $baselineRepo update-ref refs/heads/local-test-baseline $baselineCommit
    if ($LASTEXITCODE -ne 0) { throw 'Cannot name checkout baseline' }
    $bundle = Join-Path $snapshot 'baseline.bundle'
    & git -C $baselineRepo bundle create --quiet $bundle refs/heads/local-test-baseline
    if ($LASTEXITCODE -ne 0) { throw 'Cannot bundle checkout baseline' }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    Write-Host "Checkout HEAD: $sha; working-tree snapshot SHA256: $hash"
    $runner = & docker compose --project-name doclifts-local-test -f $compose ps -q runner
    if ($LASTEXITCODE -ne 0 -or -not $runner) { throw 'Test runner is not available' }
    $runId = Split-Path -Leaf $snapshot
    $containerArchive = "/tmp/doclifts-run-$runId.tar"
    $containerBundle = "/tmp/doclifts-run-$runId.bundle"
    $containerHelper = "/tmp/doclifts-run-$runId.sh"
    Invoke-Docker cp $archive "${runner}:$containerArchive"
    Invoke-Docker cp $bundle "${runner}:$containerBundle"
    Invoke-Docker cp (Join-Path $PSScriptRoot 'local-test-gate.sh') "${runner}:$containerHelper"
    # Git checkout line endings must not affect the Linux helper.
    Invoke-Docker exec $runner sed -i 's/\r$//' $containerHelper
    Invoke-Docker exec -e "DOCLIFTS_BUILD_SHA=local-$($sha.Substring(0,12))-$($hash.Substring(0,12))" $runner bash $containerHelper $containerArchive $Action @TestFilter
} finally {
    if ($snapshot) {
        # Exact directory created above, inside our named state directory.
        $resolved = [IO.Path]::GetFullPath($snapshot)
        if (-not $resolved.StartsWith([IO.Path]::GetFullPath($state) + [IO.Path]::DirectorySeparatorChar)) {
            throw 'Unexpected snapshot cleanup path'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    $lock.Dispose()
}
