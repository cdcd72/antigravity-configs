[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('User', 'Project')]
    [string] $Scope,

    [switch] $WhatIf,
    [switch] $Force,
    [switch] $Diff,
    [switch] $Uninstall,

    # -Scope User: override the target %USERPROFILE%\.gemini\config
    [string] $UserScopePath,

    # -Scope Project: the repo whose .agents/ should receive the project-scope template
    [string] $TargetRepo
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent -Path $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent -Path $scriptRoot

$manifestFileName = '.agy-scope-sync.json'
$backupDirName = '.agy-scope-backups'

$selectedModes = @(@($WhatIf.IsPresent, $Diff.IsPresent, $Uninstall.IsPresent) | Where-Object { $_ })
if ($selectedModes.Count -gt 1) {
    throw 'WhatIf, Diff, and Uninstall are mutually exclusive.'
}

if ($Scope -eq 'User') {
    $sourceAgyPath = Join-Path -Path $repoRoot -ChildPath 'user\.agents'
    $managedFiles = @(
        'GEMINI.md',
        'hooks.json',
        'hooks\block-dangerous.js',
        'agents\generic-test-quality-reviewer\agent.md'
    )

    if ([string]::IsNullOrWhiteSpace($UserScopePath)) {
        if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
            throw 'USERPROFILE is not set; cannot resolve the Antigravity User Scope path.'
        }
        $UserScopePath = Join-Path -Path $env:USERPROFILE -ChildPath '.gemini\config'
    }
    $targetAgyPath = [System.IO.Path]::GetFullPath($UserScopePath)
}
else {
    $sourceAgyPath = Join-Path -Path $repoRoot -ChildPath 'project\.agents'
    $managedFiles = @(
        'hooks.json',
        'hooks\format-lint.js'
    )

    if ([string]::IsNullOrWhiteSpace($TargetRepo)) {
        throw '-Scope Project requires -TargetRepo <path to the repo whose .agents/ should be updated>.'
    }
    $resolvedRepo = [System.IO.Path]::GetFullPath($TargetRepo)
    if (-not (Test-Path -LiteralPath $resolvedRepo -PathType Container)) {
        throw "TargetRepo does not exist: $resolvedRepo"
    }
    $targetAgyPath = Join-Path -Path $resolvedRepo -ChildPath '.agents'
}

if (-not (Test-Path -LiteralPath $sourceAgyPath -PathType Container)) {
    throw "Source directory was not found: $sourceAgyPath"
}

function Test-BytesEqual {
    param([byte[]] $FirstBytes, [byte[]] $SecondBytes)
    if ($FirstBytes.Length -ne $SecondBytes.Length) { return $false }
    for ($index = 0; $index -lt $FirstBytes.Length; $index++) {
        if ($FirstBytes[$index] -ne $SecondBytes[$index]) { return $false }
    }
    return $true
}

function Get-BytesSha256 {
    param([byte[]] $Bytes)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-DesiredFileBytes {
    param([string] $RelativePath)

    $sourceFilePath = Join-Path -Path $sourceAgyPath -ChildPath $RelativePath
    return [System.IO.File]::ReadAllBytes($sourceFilePath)
}

function Read-Manifest {
    $manifestPath = Join-Path -Path $targetAgyPath -ChildPath $manifestFileName
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }
    return (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json)
}

function Write-Manifest {
    param([object[]] $Entries)
    $manifestPath = Join-Path -Path $targetAgyPath -ChildPath $manifestFileName
    $manifest = [ordered]@{
        version = 1
        scope = $Scope
        source = (Resolve-Path -LiteralPath $sourceAgyPath).Path
        files = $Entries
    }
    $json = $manifest | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

function Backup-ExistingFile {
    param([string] $TargetFilePath, [string] $RelativePath)
    $backupFolder = Join-Path -Path (Join-Path -Path $targetAgyPath -ChildPath $backupDirName) -ChildPath (Get-Date -Format 'yyyyMMdd-HHmmss')
    $backupFilePath = Join-Path -Path $backupFolder -ChildPath $RelativePath
    $backupDirectory = Split-Path -Parent -Path $backupFilePath
    if (-not (Test-Path -LiteralPath $backupDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    }
    Copy-Item -LiteralPath $TargetFilePath -Destination $backupFilePath -Force
    Write-Output "Backed up: $RelativePath -> $backupFilePath"
}

if ($Diff) {
    foreach ($relativePath in $managedFiles) {
        $targetFilePath = Join-Path -Path $targetAgyPath -ChildPath $relativePath
        if (-not (Test-Path -LiteralPath $targetFilePath -PathType Leaf)) {
            Write-Output "Missing: $relativePath"
        }
        elseif (Test-BytesEqual -FirstBytes (Get-DesiredFileBytes -RelativePath $relativePath) -SecondBytes ([System.IO.File]::ReadAllBytes($targetFilePath))) {
            Write-Output "Unchanged: $relativePath"
        }
        else {
            Write-Output "Different: $relativePath"
        }
    }
    return
}

if ($Uninstall) {
    $manifest = Read-Manifest
    if ($null -eq $manifest) {
        Write-Output 'No sync manifest found; nothing was removed.'
        return
    }
    foreach ($manifestEntry in @($manifest.files)) {
        $relativePath = [string] $manifestEntry.path
        $targetFilePath = Join-Path -Path $targetAgyPath -ChildPath $relativePath
        if (-not (Test-Path -LiteralPath $targetFilePath -PathType Leaf)) {
            Write-Output "Skipped (missing): $relativePath"
            continue
        }
        $currentHash = Get-BytesSha256 -Bytes ([System.IO.File]::ReadAllBytes($targetFilePath))
        if ($currentHash -eq [string] $manifestEntry.sha256) {
            Remove-Item -LiteralPath $targetFilePath -Force
            Write-Output "Removed: $relativePath"
        }
        else {
            Write-Warning "Kept modified file: $relativePath"
        }
    }
    Remove-Item -LiteralPath (Join-Path -Path $targetAgyPath -ChildPath $manifestFileName) -Force
    return
}

if (-not $WhatIf -and -not (Test-Path -LiteralPath $targetAgyPath -PathType Container)) {
    New-Item -ItemType Directory -Path $targetAgyPath -Force | Out-Null
}

foreach ($relativePath in $managedFiles) {
    $sourceFilePath = Join-Path -Path $sourceAgyPath -ChildPath $relativePath
    if (-not (Test-Path -LiteralPath $sourceFilePath -PathType Leaf)) {
        throw "Managed source file was not found: $sourceFilePath"
    }

    $targetFilePath = Join-Path -Path $targetAgyPath -ChildPath $relativePath
    $targetDirectory = Split-Path -Parent -Path $targetFilePath
    $desiredBytes = Get-DesiredFileBytes -RelativePath $relativePath

    $targetBytes = $null
    if (Test-Path -LiteralPath $targetFilePath -PathType Leaf) {
        $targetBytes = [System.IO.File]::ReadAllBytes($targetFilePath)
    }

    if ($null -ne $targetBytes -and (Test-BytesEqual -FirstBytes $desiredBytes -SecondBytes $targetBytes)) {
        Write-Output "Skipped (unchanged): $relativePath"
        continue
    }

    if ($WhatIf) {
        if ($null -eq $targetBytes) {
            Write-Output "Would sync: $relativePath"
        }
        elseif ($Force) {
            Write-Output "Would back up and sync: $relativePath"
        }
        else {
            Write-Output "Would skip conflict (use -Force): $relativePath"
        }
        continue
    }

    if ($null -ne $targetBytes) {
        if (-not $Force) {
            Write-Output "Skipped (different; use -Force): $relativePath"
            continue
        }
        Backup-ExistingFile -TargetFilePath $targetFilePath -RelativePath $relativePath
    }

    if (-not (Test-Path -LiteralPath $targetDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    }
    [System.IO.File]::WriteAllBytes($targetFilePath, $desiredBytes)
    Write-Output "Synced: $relativePath"
}

if ($WhatIf) { return }

$manifestEntries = @()
foreach ($relativePath in $managedFiles) {
    $targetFilePath = Join-Path -Path $targetAgyPath -ChildPath $relativePath
    if (-not (Test-Path -LiteralPath $targetFilePath -PathType Leaf)) {
        Write-Warning "Not synced (left out of manifest): $relativePath"
        continue
    }
    $manifestEntries += [pscustomobject]@{
        path = $relativePath
        sha256 = Get-BytesSha256 -Bytes ([System.IO.File]::ReadAllBytes($targetFilePath))
    }
}
Write-Manifest -Entries $manifestEntries

Write-Verbose "Scope:  $Scope"
Write-Verbose "Source: $sourceAgyPath"
Write-Verbose "Target: $targetAgyPath"
