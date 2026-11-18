<#
.SYNOPSIS
    Uninstalls Swarm Engine Team CLI from the current user's PATH.
.DESCRIPTION
    Removes the project's bin directory from the current user's PATH environment variable.
    - Removes only what install.ps1 added, and nothing else.
    - Prints what was removed.
    - Safe: Does not modify any other paths or system variables.
#>

[CmdletBinding()]
param(
    [string]$TargetBinDir = "",
    [string]$CustomUserPath = $null,
    [switch]$PassThru
)

$ErrorActionPreference = "Stop"

if (-not $TargetBinDir -or $TargetBinDir.Trim() -eq "") {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $TargetBinDir = (Resolve-Path (Join-Path $scriptDir "..\bin")).Path
} else {
    $TargetBinDir = [System.IO.Path]::GetFullPath($TargetBinDir)
}

$normalizedTarget = $TargetBinDir.Trim().TrimEnd('\', '/')
Write-Host "Uninstalling Swarm Engine Team CLI..." -ForegroundColor Cyan
Write-Host "Target bin directory: $TargetBinDir"

$isTestMode = ($null -ne $CustomUserPath)
$currentUserPath = if ($isTestMode) {
    $CustomUserPath
} else {
    [Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::User)
}

if ($null -eq $currentUserPath) {
    $currentUserPath = ""
}

$pathEntries = $currentUserPath -split ';' | Where-Object { $_ -and $_.Trim() -ne '' }
$removed = @()
$remaining = @()

foreach ($entry in $pathEntries) {
    if ($entry.Trim().TrimEnd('\', '/') -ieq $normalizedTarget) {
        $removed += $entry
    } else {
        $remaining += $entry
    }
}

$resultingPath = $remaining -join ';'

if ($removed.Count -gt 0) {
    if (-not $isTestMode) {
        [Environment]::SetEnvironmentVariable("Path", $resultingPath, [System.EnvironmentVariableTarget]::User)
        Set-ItemProperty -Path 'HKCU:\Environment' -Name Path -Value $resultingPath -ErrorAction SilentlyContinue
    }
    Write-Host "Successfully removed from User PATH:" -ForegroundColor Green
    foreach ($r in $removed) {
        Write-Host "  - $r" -ForegroundColor Yellow
    }
} else {
    Write-Host "Nothing removed: Target directory was not found in User PATH." -ForegroundColor Yellow
}

# In live mode, remove from current session $env:Path as well
if (-not $isTestMode) {
    $sessionRemaining = ($env:Path -split ';' | Where-Object { $_ -and $_.Trim().TrimEnd('\', '/') -ine $normalizedTarget })
    $env:Path = $sessionRemaining -join ';'
}

Write-Host "Uninstallation complete." -ForegroundColor Green

if ($PassThru) {
    return $resultingPath
}
