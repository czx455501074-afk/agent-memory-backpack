#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'

Write-Host "=== Agent Memory Backpack Plugin Verification ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/4] Check plugin installation..." -ForegroundColor Yellow
$installed = dsh plugin --profile desktop list 2>&1 | Out-String
if ($installed -match 'dsh-agent-memory-backpack') {
    Write-Host "  OK: Plugin installed to desktop profile" -ForegroundColor Green
} else {
    Write-Host "  FAIL: Plugin not installed" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "[2/4] Check AMB core..." -ForegroundColor Yellow
# Derived from this script's own location, so the check works from any clone.
Push-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
$doctor = node dist/src/cli.js doctor --offline 2>&1 | Out-String
Pop-Location

if ($doctor -match 'pass=') {
    Write-Host "  OK: AMB core is running" -ForegroundColor Green
} else {
    Write-Host "  WARN: AMB core may have issues" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[3/4] Check DSH session logs..." -ForegroundColor Yellow
$profileDir = $env:DSH_PROFILE_DIR
if (-not $profileDir) {
    $profileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
}

$sessionsDir = Join-Path $profileDir "sessions"
if (-not (Test-Path $sessionsDir)) {
    Write-Host "  WARN: Sessions directory does not exist" -ForegroundColor Yellow
    Write-Host "        Create a session in DSH and send a message" -ForegroundColor Yellow
    exit 0
}

$logs = Get-ChildItem $sessionsDir -Recurse -Filter "*.jsonl" -ErrorAction SilentlyContinue | 
    Sort-Object LastWriteTime -Descending

if ($logs.Count -eq 0) {
    Write-Host "  WARN: No session logs found" -ForegroundColor Yellow
    Write-Host "        Create a session in DSH and send a message" -ForegroundColor Yellow
    exit 0
}

$latest = $logs[0]
Write-Host "  Found session log: $($latest.Name)" -ForegroundColor Gray
Write-Host "  Last modified: $($latest.LastWriteTime)" -ForegroundColor Gray
Write-Host "  Size: $($latest.Length) bytes" -ForegroundColor Gray

Write-Host ""
Write-Host "[4/4] Check plugin tools..." -ForegroundColor Yellow

if ($latest.Length -eq 0) {
    Write-Host "  WARN: Log file is empty" -ForegroundColor Yellow
    exit 0
}

$content = Get-Content $latest.FullName -Raw -ErrorAction SilentlyContinue
$ambMatches = [regex]::Matches($content, '"name"\s*:\s*"(amb_[^"]+)"')
$uniqueTools = $ambMatches | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique | Sort-Object

if ($uniqueTools.Count -eq 0) {
    Write-Host "  FAIL: No amb_ tools found" -ForegroundColor Red
    Write-Host ""
    Write-Host "Possible reasons:" -ForegroundColor Yellow
    Write-Host "  1. DSH not restarted (plugin needs restart to load)" -ForegroundColor Gray
    Write-Host "  2. Session created before plugin install (try new session)" -ForegroundColor Gray
    Write-Host "  3. Plugin failed to load (check DSH startup logs)" -ForegroundColor Gray
    exit 1
}

Write-Host "  OK: Found $($uniqueTools.Count) AMB tools:" -ForegroundColor Green
$uniqueTools | ForEach-Object { Write-Host "    - $_" -ForegroundColor Gray }

$expected = @(
    'amb_inspect_archive', 'amb_knowledge_history', 'amb_prepare', 'amb_read_knowledge',
    'amb_read_stage', 'amb_search_workflows', 'amb_self_check', 'amb_structure_skill',
    'amb_submit_experience', 'amb_supersede_experience', 'amb_unstructured_skills'
)

$missing = $expected | Where-Object { $uniqueTools -notcontains $_ }
if ($missing.Count -eq 0) {
    Write-Host ""
    Write-Host "SUCCESS: All 11 tools loaded correctly!" -ForegroundColor Green
    exit 0
} else {
    Write-Host ""
    Write-Host "  WARN: Missing tools:" -ForegroundColor Yellow
    $missing | ForEach-Object { Write-Host "    - $_" -ForegroundColor Gray }
    exit 1
}
