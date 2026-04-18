<#
.SYNOPSIS
  One-shot setup for the manavarya-bot reviewer on a Windows laptop.

.DESCRIPTION
  Installs Ollama + Node 20, pulls the qwen2.5-coder:7b model, and registers
  a self-hosted GitHub Actions runner for the bot-manavarya account with the
  'ollama' label, running as a Windows service so it survives reboots.

.USAGE
  1. Open PowerShell as Administrator.
  2. Allow the script to run this session only:
        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  3. Run:
        .\setup-laptop.ps1

  You'll be prompted for the GitHub runner token. Get it from:
      https://github.com/bot-manavarya  ->  Settings  ->  Actions
      ->  Runners  ->  New self-hosted runner  ->  copy the token
      shown in the "Configure" section (starts with A...).
#>

param(
  [string]$Model       = 'qwen2.5-coder:7b',
  [string]$RunnerLabel = 'ollama',
  [string]$RunnerUrl   = 'https://github.com/bot-manavarya',
  [string]$RunnerDir   = "$env:USERPROFILE\actions-runner",
  [string]$RunnerVer   = '2.319.1'
)

$ErrorActionPreference = 'Stop'
function Log($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }

# --- 0. Admin check -----------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Please run this script from an elevated PowerShell (Run as Administrator).'
}

# --- 1. winget check ----------------------------------------------------------
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw 'winget is not available. Install "App Installer" from the Microsoft Store, then rerun.'
}

# --- 2. Install Ollama --------------------------------------------------------
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Log 'Installing Ollama...'
  winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path','User')
} else {
  Log 'Ollama already installed.'
}

# --- 3. Install Node 20 -------------------------------------------------------
$needNode = $true
if (Get-Command node -ErrorAction SilentlyContinue) {
  $v = (node -v) -replace '^v',''
  if ([int]($v.Split('.')[0]) -ge 20) { $needNode = $false }
}
if ($needNode) {
  Log 'Installing Node.js 20 LTS...'
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path','User')
} else {
  Log 'Node 20+ already installed.'
}

# --- 4. Start Ollama + pull model --------------------------------------------
Log 'Ensuring Ollama server is running...'
$svc = Get-Service -Name 'Ollama' -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Running') {
  Start-Service -Name 'Ollama'
} elseif (-not $svc) {
  if (-not (Get-Process -Name ollama -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden
  }
}

# Wait for the API to respond
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  try {
    Invoke-RestMethod -Uri 'http://localhost:11434/api/tags' -TimeoutSec 2 | Out-Null
    break
  } catch { Start-Sleep -Milliseconds 500 }
}

Log "Pulling model $Model (this can take a few minutes the first time)..."
ollama pull $Model

# --- 5. Download & configure the runner --------------------------------------
if (Test-Path (Join-Path $RunnerDir 'config.cmd')) {
  Log "Runner already exists at $RunnerDir, skipping download."
} else {
  Log "Downloading GitHub Actions runner v$RunnerVer..."
  New-Item -ItemType Directory -Force -Path $RunnerDir | Out-Null
  $zip = Join-Path $env:TEMP "actions-runner-$RunnerVer.zip"
  $url = "https://github.com/actions/runner/releases/download/v$RunnerVer/actions-runner-win-x64-$RunnerVer.zip"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $RunnerDir -Force
  Remove-Item $zip
}

Push-Location $RunnerDir
try {
  if (Test-Path '.runner') {
    Log 'Runner already configured, skipping config.cmd.'
  } else {
    Write-Host ''
    Write-Host 'Now open this page in your browser:' -ForegroundColor Green
    Write-Host "  $RunnerUrl/settings/actions/runners/new?arch=x64&os=win" -ForegroundColor Green
    Write-Host 'Copy the token shown under "Configure" (a long string starting with A...).' -ForegroundColor Green
    $tok = Read-Host -AsSecureString 'Paste runner token'
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($tok))

    $name = "$env:COMPUTERNAME-ollama"
    .\config.cmd --unattended `
                 --url $RunnerUrl `
                 --token $plain `
                 --name $name `
                 --labels $RunnerLabel `
                 --work _work `
                 --replace
  }

  Log 'Installing runner as a Windows service...'
  .\svc.cmd install
  .\svc.cmd start
}
finally { Pop-Location }

# --- 6. Final checks ----------------------------------------------------------
Log 'Verifying...'
try {
  $tags = Invoke-RestMethod -Uri 'http://localhost:11434/api/tags'
  $has  = $tags.models | Where-Object { $_.name -like "$Model*" }
  if (-not $has) { Warn "Model $Model not listed by Ollama. Run: ollama pull $Model" }
  else           { Log  "Ollama OK. Model $Model installed." }
} catch {
  Warn 'Could not reach Ollama at http://localhost:11434. Start it and rerun the check.'
}

$svc = Get-Service | Where-Object { $_.Name -like 'actions.runner.*' } | Select-Object -First 1
if ($svc) {
  Log "Runner service: $($svc.Name) -> $($svc.Status)"
} else {
  Warn 'Runner service not found. Check the output above for errors.'
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host 'Next:' -ForegroundColor Green
Write-Host '  1. Verify the runner shows "Idle" at:' -ForegroundColor Green
Write-Host "     $RunnerUrl/settings/actions/runners" -ForegroundColor Green
Write-Host '  2. Open a PR on any Manavarya09 repo that has the manavarya-bot workflow.' -ForegroundColor Green
Write-Host '  3. Watch the PR Checks tab for the review.' -ForegroundColor Green
