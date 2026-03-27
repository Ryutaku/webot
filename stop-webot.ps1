$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

Write-Host "[webot] Stopping existing webot process if running..."

$procs = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object {
    $_.CommandLine -match 'src\\cli\.mjs' -and
    $_.CommandLine -match '\bstart\b' -and (
      $_.CommandLine -match 'webot\.config\.json' -or
      $_.CommandLine -match 'bridge\.config\.json'
    )
  }

if (-not $procs) {
  Write-Host "[webot] No running webot process found."
  exit 0
}

foreach ($proc in $procs) {
  try {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
    Write-Host "[webot] Stopped PID $($proc.ProcessId)"
  } catch {
    Write-Warning "[webot] Failed to stop PID $($proc.ProcessId): $($_.Exception.Message)"
  }
}
