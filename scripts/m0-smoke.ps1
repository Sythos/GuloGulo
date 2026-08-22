# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
# Author: Sythos (https://www.sythos.net)

[CmdletBinding()]
param(
    [Parameter()]
    [string]$ComposeFile,

    [Parameter()]
    [string]$ProjectName = 'gulogulo-m0-smoke',

    [Parameter()]
    [string]$EnvFile,

    [Parameter()]
    [ValidateRange(15, 900)]
    [int]$StartupTimeoutSeconds = 120,

    [Parameter()]
    [switch]$SkipBuild,

    [Parameter()]
    [switch]$KeepRunning
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Compose {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $commandArguments = @('compose', '--project-name', $ProjectName, '--file', $resolvedComposeFile)
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

    $commandArguments = @('compose', '--project-name', $ProjectName, '--file', $resolvedComposeFile)
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

function Get-RunningContainerStatuses {
    $containerIds = @(Get-ComposeOutput -Arguments @('ps', '-q') |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_.ToString().Trim() })

    $statuses = @()
    foreach ($containerId in $containerIds) {
        $inspection = & docker inspect --format '{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $containerId
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            throw "Docker inspect failed with exit code $exitCode for container $containerId."
        }

        $parts = $inspection.ToString() -split '\|', 3
        if ($parts.Count -ne 3) {
            throw "Unexpected Docker inspect output for container $containerId."
        }

        $statuses += [pscustomobject]@{
            Container = $parts[0].Trim().TrimStart('/')
            State     = $parts[1].Trim()
            Health    = $parts[2].Trim()
        }
    }
    return $statuses
}

function Write-ComposeFailureContext {
    try {
        Write-Host 'Docker Compose status:'
        $statusArguments = @('compose', '--project-name', $ProjectName, '--file', $resolvedComposeFile)
        if (-not [string]::IsNullOrWhiteSpace($resolvedEnvFile)) {
            $statusArguments += @('--env-file', $resolvedEnvFile)
        }
        $statusArguments += @('ps', '-a')
        & docker @statusArguments
        Write-Host 'Docker Compose logs:'
        $logArguments = @('compose', '--project-name', $ProjectName, '--file', $resolvedComposeFile)
        if (-not [string]::IsNullOrWhiteSpace($resolvedEnvFile)) {
            $logArguments += @('--env-file', $resolvedEnvFile)
        }
        $logArguments += @('logs', '--no-color', '--tail', '100', 'gulogulo')
        & docker @logArguments
    }
    catch {
        Write-Warning "Unable to collect Docker Compose status: $($_.Exception.Message)"
    }
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI is required for the M0 smoke checks.'
}

$dockerVersion = & docker version --format '{{.Server.Version}}' 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($dockerVersion)) {
    throw 'The Docker daemon is unavailable. Start Docker before running the M0 smoke checks.'
}

if ([string]::IsNullOrWhiteSpace($ProjectName) -or $ProjectName -notmatch '^[a-z0-9][a-z0-9_-]*$') {
    throw 'ProjectName must contain only lowercase ASCII letters, numbers, hyphens, and underscores.'
}

if ([string]::IsNullOrWhiteSpace($ComposeFile)) {
    $composeCandidates = @('compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml')
    foreach ($candidate in $composeCandidates) {
        $candidatePath = Join-Path $repositoryRoot $candidate
        if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
            $ComposeFile = $candidatePath
            break
        }
    }
}

if ([string]::IsNullOrWhiteSpace($ComposeFile)) {
    throw 'No Compose file found. Expected compose.yaml, compose.yml, docker-compose.yml, or docker-compose.yaml.'
}

$resolvedComposeFile = (Resolve-Path -LiteralPath $ComposeFile).Path
if (-not [string]::IsNullOrWhiteSpace($EnvFile)) {
    $resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile).Path
}
else {
    $exampleEnvFile = Join-Path $repositoryRoot '.env.example'
    if (Test-Path -LiteralPath $exampleEnvFile -PathType Leaf) {
        $resolvedEnvFile = (Resolve-Path -LiteralPath $exampleEnvFile).Path
    }
    else {
        $resolvedEnvFile = ''
    }
}

Write-Host "Running Gulo Gulo M0 Docker smoke checks with project '$ProjectName'."
Write-Host "Compose file: $resolvedComposeFile"
if (-not [string]::IsNullOrWhiteSpace($resolvedEnvFile)) {
    Write-Host "Environment file: $resolvedEnvFile"
}
else {
    Write-Host 'Environment file: none'
}

$cleanupNeeded = $false
try {
    Write-Host 'Checking Docker Compose configuration.'
    Invoke-Compose -Arguments @('config', '--quiet')

    if (-not $SkipBuild) {
        Write-Host 'Building Compose services.'
        Invoke-Compose -Arguments @('build', '--pull')
    }
    else {
        Write-Host 'Skipping image build by request.'
    }

    Write-Host 'Starting Compose services.'
    Invoke-Compose -Arguments @('up', '--detach', '--remove-orphans')
    $cleanupNeeded = $true

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    $healthy = $false
    $lastStatuses = @()

    do {
        $lastStatuses = @(Get-RunningContainerStatuses)
        if ($lastStatuses.Count -gt 0) {
            $healthy = $true
            foreach ($status in $lastStatuses) {
                if ($status.State -ne 'running' -or $status.Health -ne 'healthy') {
                    $healthy = $false
                    break
                }
            }
        }

        if ($healthy) {
            break
        }

        if ([DateTimeOffset]::UtcNow -ge $deadline) {
            break
        }

        Start-Sleep -Seconds 2
    } while ($true)

    if (-not $healthy) {
        Write-ComposeFailureContext
        if ($lastStatuses.Count -eq 0) {
            throw "No running Compose containers became healthy within $StartupTimeoutSeconds seconds."
        }

        $summary = $lastStatuses | ForEach-Object {
            "$($_.Container): state=$($_.State), health=$($_.Health)"
        }
        throw "Compose health checks did not pass within $StartupTimeoutSeconds seconds. $($summary -join '; ')"
    }

    foreach ($status in $lastStatuses) {
        Write-Host "Healthy: $($status.Container)"
    }
    Write-Host 'M0 Docker smoke checks passed.'
}
finally {
    if ($cleanupNeeded -and -not $KeepRunning) {
        Write-Host 'Stopping the smoke-test Compose project.'
        try {
            Invoke-Compose -Arguments @('down', '--remove-orphans')
        }
        catch {
            Write-Warning "Docker Compose cleanup failed: $($_.Exception.Message)"
        }
    }
    elseif ($cleanupNeeded) {
        Write-Host "Compose project left running because KeepRunning was requested."
    }
}
