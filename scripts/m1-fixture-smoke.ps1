# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

[CmdletBinding()]
param(
    [Parameter()]
    [string]$ComposeFile,

    [Parameter()]
    [string]$ProjectName = 'gulogulo-m1-fixture',

    [Parameter()]
    [string]$EnvFile,

    [Parameter()]
    [ValidateRange(15, 900)]
    [int]$StartupTimeoutSeconds = 120,

    [Parameter()]
    [switch]$SkipBuild,

    [Parameter()]
    [switch]$KeepRunning,

    [Parameter()]
    [switch]$RequireMetrics
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedComposeFile = ''
$resolvedEnvFile = ''

function Invoke-Compose {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $commandArguments = @(
        'compose',
        '--project-name',
        $ProjectName,
        '--file',
        $resolvedComposeFile,
        '--profile',
        'fixture'
    )
    if (-not [string]::IsNullOrWhiteSpace($resolvedEnvFile)) {
        $commandArguments += @('--env-file', $resolvedEnvFile)
    }
    $commandArguments += $Arguments

    & docker @commandArguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $renderedArguments = $commandArguments -join ' '
        throw "Docker Compose command failed with exit code ${exitCode}: docker $renderedArguments"
    }
}

function Get-ComposeOutput {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $commandArguments = @(
        'compose',
        '--project-name',
        $ProjectName,
        '--file',
        $resolvedComposeFile,
        '--profile',
        'fixture'
    )
    if (-not [string]::IsNullOrWhiteSpace($resolvedEnvFile)) {
        $commandArguments += @('--env-file', $resolvedEnvFile)
    }
    $commandArguments += $Arguments

    $output = & docker @commandArguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $renderedArguments = $commandArguments -join ' '
        throw "Docker Compose command failed with exit code ${exitCode}: docker $renderedArguments"
    }
    return @($output)
}

function Get-FreeTcpPort {
    $listener = [System.Net.Sockets.TcpListener]::new(
        [System.Net.IPAddress]::Loopback,
        0
    )
    try {
        $listener.Start()
        return $listener.LocalEndpoint.Port
    }
    finally {
        $listener.Stop()
    }
}

function Read-FixtureJson {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required fixture file is missing: $Path"
    }

    $raw = Get-Content -Raw -LiteralPath $Path
    $secretValuePattern = '(?i)"(?:password|passwd|token|apiKey|privateKey|authorization|cookie)"\s*:\s*"[^"]+"'
    if ($raw -match $secretValuePattern) {
        throw "Fixture contains a credential-like value: $Path"
    }

    try {
        return ($raw | ConvertFrom-Json)
    }
    catch {
        throw "Fixture JSON is invalid: $Path. $($_.Exception.Message)"
    }
}

function Assert-Fixtures {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FixtureRoot
    )

    $manifestPath = Join-Path $FixtureRoot 'manifest.json'
    $tenantPath = Join-Path $FixtureRoot 'tenant.json'
    $failurePath = Join-Path $FixtureRoot 'failure-modes.json'

    $manifest = Read-FixtureJson -Path $manifestPath
    $tenant = Read-FixtureJson -Path $tenantPath
    $failureModes = Read-FixtureJson -Path $failurePath

    foreach ($fixture in @($manifest, $tenant, $failureModes)) {
        if ($fixture.schemaVersion -ne 1 -or $fixture.deterministic -ne $true) {
            throw 'All M1 fixtures must declare schemaVersion 1 and deterministic=true.'
        }
        if ($fixture.spdxLicenseIdentifier -ne 'MIT') {
            throw 'All M1 JSON fixtures must declare the MIT SPDX identifier.'
        }
        if ($fixture.author -ne 'Sythos (https://www.sythos.net)') {
            throw 'All M1 JSON fixtures must declare the Sythos author metadata.'
        }
    }

    if ($manifest.fixtureSet -ne 'm1-foundation' -or
        $manifest.tenantFixture -ne 'tenant.json' -or
        $manifest.failureFixture -ne 'failure-modes.json') {
        throw 'M1 fixture manifest references do not match the committed fixture set.'
    }

    if ($tenant.tenant.catchAllEnabled -ne $false -or
        $tenant.tenant.automaticForwardingEnabled -ne $false) {
        throw 'The tenant fixture must keep catch-all and automatic forwarding disabled.'
    }

    if (@($tenant.users).Count -lt 2 -or @($tenant.aliases).Count -lt 1) {
        throw 'The tenant fixture must contain at least two users and one alias.'
    }

    $quotaSum = [int64]($tenant.users | Measure-Object -Property quotaBytes -Sum).Sum
    if ($quotaSum -gt [int64]$tenant.tenant.grossQuotaBytes) {
        throw 'The fixture user quota sum exceeds the tenant gross quota.'
    }

    $caseIds = @($failureModes.cases | ForEach-Object { $_.id })
    $missingCaseIds = @($caseIds | Where-Object { [string]::IsNullOrWhiteSpace($_) })
    if ($caseIds.Count -ne 3 -or $missingCaseIds.Count -gt 0) {
        throw 'The failure-mode fixture must contain three named cases.'
    }

    Write-Host "Validated deterministic fixtures in $FixtureRoot."
}

function Get-ContainerStatus {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ServiceName
    )

    $containerIds = @(Get-ComposeOutput -Arguments @('ps', '-q', $ServiceName) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_.ToString().Trim() })
    if ($containerIds.Count -eq 0) {
        return $null
    }

    $inspection = & docker inspect --format '{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $containerIds[0]
    if ($LASTEXITCODE -ne 0) {
        throw "Docker inspect failed for service $ServiceName."
    }

    $parts = $inspection.ToString() -split '\|', 3
    if ($parts.Count -ne 3) {
        throw "Unexpected Docker inspect output for service $ServiceName."
    }

    return [pscustomobject]@{
        Container = $parts[0].Trim().TrimStart('/')
        State = $parts[1].Trim()
        Health = $parts[2].Trim()
    }
}

function Write-ComposeFailureContext {
    try {
        Write-Host 'Docker Compose status:'
        Get-ComposeOutput -Arguments @('ps', '-a') | ForEach-Object { Write-Host $_ }
        Write-Host 'Docker Compose logs:'
        Get-ComposeOutput -Arguments @('logs', '--no-color', '--tail', '100', 'gulogulo') | ForEach-Object { Write-Host $_ }
    }
    catch {
        Write-Warning "Unable to collect Docker Compose failure context: $($_.Exception.Message)"
    }
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$fixtureRoot = Join-Path $repositoryRoot 'test\fixtures'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI is required for the M1 fixture smoke checks.'
}

$dockerVersion = & docker version --format '{{.Server.Version}}' 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($dockerVersion)) {
    throw 'The Docker daemon is unavailable. Start Docker before running the M1 fixture smoke checks.'
}

if ([string]::IsNullOrWhiteSpace($ProjectName) -or $ProjectName -notmatch '^[a-z0-9][a-z0-9_-]*$') {
    throw 'ProjectName must contain only lowercase ASCII letters, numbers, hyphens, and underscores.'
}

if ([string]::IsNullOrWhiteSpace($ComposeFile)) {
    $ComposeFile = Join-Path $repositoryRoot 'compose.yaml'
}
if (-not (Test-Path -LiteralPath $ComposeFile -PathType Leaf)) {
    throw "Compose file not found: $ComposeFile"
}
$resolvedComposeFile = (Resolve-Path -LiteralPath $ComposeFile).Path

if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $repositoryRoot '.env.example'
}
if (Test-Path -LiteralPath $EnvFile -PathType Leaf) {
    $resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile).Path
}

Assert-Fixtures -FixtureRoot $fixtureRoot

$fixturePort = Get-FreeTcpPort
$fixtureEnvironment = [ordered]@{
    APP_ENV = 'fixture'
    GULOGULO_ENV = 'fixture'
    GULOGULO_FIXTURE_MODE = 'true'
    GULOGULO_FIXTURE_MANIFEST = '/app/test/fixtures/manifest.json'
    LDAP_ENABLED = 'false'
    POSTGRES_ENABLED = 'false'
    LDAP_BIND_SECRET_REF = ''
    POSTGRES_PASSWORD_SECRET_REF = ''
    GULOGULO_VOLUME_PREFIX = $ProjectName
    GULOGULO_HTTP_PORT = [string]$fixturePort
}
$previousEnvironment = @{}
$cleanupNeeded = $false

try {
    foreach ($key in $fixtureEnvironment.Keys) {
        $previousEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, [string]$fixtureEnvironment[$key], 'Process')
    }

    Write-Host "Running Gulo Gulo M1 fixture smoke checks with project '$ProjectName'."
    Write-Host "Compose file: $resolvedComposeFile"
    Write-Host "Fixture profile: fixture (local and test profiles are available for direct Compose use)"
    Write-Host "Ephemeral host port reserved for the runtime: $fixturePort"

    Write-Host 'Checking the Compose model and profile configuration.'
    Invoke-Compose -Arguments @('config', '--quiet')

    if (-not $SkipBuild) {
        Write-Host 'Building the fixture image with a refreshed Ubuntu base.'
        Invoke-Compose -Arguments @('build', '--pull', 'gulogulo')
    }
    else {
        Write-Host 'Skipping image build by request.'
    }

    Write-Host 'Running the deterministic fixture validator in the fixture profile.'
    Get-ComposeOutput -Arguments @('run', '--rm', '--no-deps', 'gulogulo-fixture') |
        ForEach-Object { Write-Host $_ }

    Write-Host 'Starting the isolated runtime service.'
    Invoke-Compose -Arguments @('up', '--detach', '--remove-orphans', 'gulogulo')
    $cleanupNeeded = $true

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    $status = $null
    do {
        $status = Get-ContainerStatus -ServiceName 'gulogulo'
        if ($null -ne $status -and $status.State -eq 'running' -and $status.Health -eq 'healthy') {
            break
        }
        if ([DateTimeOffset]::UtcNow -ge $deadline) {
            break
        }
        Start-Sleep -Seconds 2
    } while ($true)

    if ($null -eq $status -or $status.State -ne 'running' -or $status.Health -ne 'healthy') {
        Write-ComposeFailureContext
        if ($null -eq $status) {
            throw "The runtime container did not start within $StartupTimeoutSeconds seconds."
        }
        throw "The runtime container did not become healthy within $StartupTimeoutSeconds seconds: state=$($status.State), health=$($status.Health)."
    }
    Write-Host "Healthy: $($status.Container)"

    $requireMetricsLiteral = if ($RequireMetrics) { 'true' } else { 'false' }
    $probeScript = @'
const base = 'http://127.0.0.1:' + (process.env.PORT || 8080);
const requireMetrics = __REQUIRE_METRICS__;

async function readJson(path) {
  const response = await fetch(base + path);
  if (response.status !== 200) {
    throw new Error(path + ' returned HTTP ' + response.status);
  }
  const payload = await response.json();
  if (!payload || typeof payload.status !== 'string') {
    throw new Error(path + ' did not return the JSON health contract');
  }
  process.stdout.write(path + ':ok\n');
}

await readJson('/health/live');
await readJson('/health/ready');

const metrics = await fetch(base + '/metrics');
if (metrics.status === 404) {
  if (requireMetrics) {
    throw new Error('/metrics is required by this gate but is not implemented');
  }
  process.stdout.write('/metrics:deferred\n');
} else if (metrics.status !== 200) {
  throw new Error('/metrics returned HTTP ' + metrics.status);
} else {
  const body = await metrics.text();
  if (body.trim().length === 0) {
    throw new Error('/metrics returned an empty body');
  }
  process.stdout.write('/metrics:ok\n');
}
'@.Replace('__REQUIRE_METRICS__', $requireMetricsLiteral)

    Write-Host 'Probing liveness, readiness, and the metrics contract inside the container.'
    Get-ComposeOutput -Arguments @(
        'exec',
        '-T',
        'gulogulo',
        'node',
        '--input-type=module',
        '-e',
        $probeScript
    ) | ForEach-Object { Write-Host $_ }

    Write-Host 'M1 fixture, health, and metrics smoke checks passed.'
}
finally {
    if ($cleanupNeeded -and -not $KeepRunning) {
        Write-Host 'Tearing down the isolated fixture Compose project and volumes.'
        try {
            Invoke-Compose -Arguments @('down', '--volumes', '--remove-orphans')
        }
        catch {
            Write-Warning "Fixture Compose cleanup failed: $($_.Exception.Message)"
        }
    }
    elseif ($cleanupNeeded) {
        Write-Host 'Fixture Compose project left running because KeepRunning was requested.'
    }

    foreach ($key in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($key, $previousEnvironment[$key], 'Process')
    }
}
