<#
.SYNOPSIS
    Installs Swarm Engine Team CLI (`swarm` and `team` alias) for the current user.
.DESCRIPTION
    Adds the project's bin directory to the current user's PATH environment variable.
    - User PATH only: Requires NO administrator privileges.
    - Zero background activity: NO startup entries, NO scheduled tasks, NO daemons, NO services.
    - Idempotent: Avoids duplicate PATH entries if executed multiple times.
    - Spaces safe: Handles paths containing spaces.
#>

[CmdletBinding()]
param(
    [string]$TargetBinDir = "",
    [string]$CustomUserPath = $null,
    [switch]$PassThru
)

$ErrorActionPreference = "Stop"

# Determine target bin directory (defaults to ../bin relative to this script)
if (-not $TargetBinDir -or $TargetBinDir.Trim() -eq "") {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $TargetBinDir = (Resolve-Path (Join-Path $scriptDir "..\bin")).Path
} else {
    $TargetBinDir = [System.IO.Path]::GetFullPath($TargetBinDir)
}

if (-not (Test-Path $TargetBinDir)) {
    Write-Error "Target bin directory does not exist: $TargetBinDir"
    exit 1
}

Write-Host "Installing Swarm Engine Team CLI..." -ForegroundColor Cyan
Write-Host "Target bin directory: $TargetBinDir"

# Read existing User PATH (either from test parameter or real User environment target)
$isTestMode = ($null -ne $CustomUserPath)
$currentUserPath = if ($isTestMode) {
    $CustomUserPath
} else {
    [Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::User)
}

if ($null -eq $currentUserPath) {
    $currentUserPath = ""
}

# Normalize target path and compare against existing entries
$normalizedTarget = $TargetBinDir.Trim().TrimEnd('\', '/')
$pathEntries = $currentUserPath -split ';' | Where-Object { $_ -and $_.Trim() -ne '' }

$alreadyPresent = $false
foreach ($entry in $pathEntries) {
    if ($entry.Trim().TrimEnd('\', '/') -ieq $normalizedTarget) {
        $alreadyPresent = $true
        break
    }
}

$resultingPath = $currentUserPath

if ($alreadyPresent) {
    Write-Host "Already installed: Target directory is already present in User PATH." -ForegroundColor Yellow
} else {
    # Append to User PATH
    $resultingPath = if ($currentUserPath.Trim().Length -gt 0) {
        "$currentUserPath;$TargetBinDir"
    } else {
        $TargetBinDir
    }

    if (-not $isTestMode) {
        [Environment]::SetEnvironmentVariable("Path", $resultingPath, [System.EnvironmentVariableTarget]::User)
        Set-ItemProperty -Path 'HKCU:\Environment' -Name Path -Value $resultingPath -ErrorAction SilentlyContinue
    }
    Write-Host "Successfully added to User PATH: $TargetBinDir" -ForegroundColor Green
}

# In live mode, also update current session PATH
if (-not $isTestMode) {
    $sessionEntries = $env:Path -split ';' | Where-Object { $_ -and $_.Trim() -ne '' }
    $inSession = $false
    foreach ($entry in $sessionEntries) {
        if ($entry.Trim().TrimEnd('\', '/') -ieq $normalizedTarget) {
            $inSession = $true
            break
        }
    }
    if (-not $inSession) {
        $env:Path = "$env:Path;$TargetBinDir"
    }
}

Write-Host ""
Write-Host "Installation Details:" -ForegroundColor Green
Write-Host "  Commands:        swarm, team"
Write-Host "  Scope:           Current User (no admin rights required)"
Write-Host "  Background/Auto: NONE (no startup tasks, services, or daemons)"
Write-Host "Note: Newly opened terminal windows will automatically recognize 'swarm' and 'team'."

if ($PassThru) {
    return $resultingPath
}
