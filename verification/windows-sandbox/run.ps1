$ErrorActionPreference = 'Stop'
$out = 'C:\AMB-Results'
$steps = @()
New-Item -ItemType Directory -Force -Path $out | Out-Null
function Save-State($state) {
  @{ state=$state; time=(Get-Date).ToString('o'); computer=$env:COMPUTERNAME; user=$env:USERNAME; steps=$script:steps } | ConvertTo-Json -Depth 8 | Set-Content "$out\status.json" -Encoding UTF8
}
function Run-Step($name, $exe, $arguments) {
  Save-State "running:$name"
  $previousPreference=$ErrorActionPreference
  try {
    $ErrorActionPreference='Continue'
    & $exe @arguments 1> "$out\$name.stdout.log" 2> "$out\$name.stderr.log"
    $code=$LASTEXITCODE
  } finally { $ErrorActionPreference=$previousPreference }
  $script:steps += @{name=$name; exitCode=$code}
  Save-State "finished:$name"
  return $code
}
try {
  Save-State 'booted'
  New-Item -ItemType Directory -Force -Path 'C:\AMB-Test' | Out-Null
  & robocopy 'C:\AMB-Input\project' 'C:\AMB-Test\project' /E /XD artifacts /NFL /NDL /NJH /NJS /NP > "$out\copy.log"
  if ($LASTEXITCODE -ge 8) { throw 'Project copy failed' }
  $env:PATH = 'C:\AMB-Input\node;' + $env:PATH
  $node='C:\AMB-Input\node\node.exe'
  $npm='C:\AMB-Input\node\node_modules\npm\bin\npm-cli.js'
  Set-Location 'C:\AMB-Test\project'
  @{os=(Get-CimInstance Win32_OperatingSystem).Caption; version=(Get-CimInstance Win32_OperatingSystem).Version; node=(& $node --version); project=(Get-Location).Path; inputReadOnly=$true; productionCredentialsCopied=$false} | ConvertTo-Json | Set-Content "$out\environment.json"
  if ((Run-Step 'check' $node @($npm,'run','check')) -ne 0) { throw 'Typecheck failed' }
  if ((Run-Step 'build' $node @($npm,'run','build')) -ne 0) { throw 'Build failed' }
  if (Test-Path 'C:\AMB-Electron\electron.exe') {
    & robocopy 'C:\AMB-Electron' 'C:\AMB-Test\project\node_modules\electron\dist' /E /NFL /NDL /NJH /NJS /NP > "$out\electron-copy.log"
    if ($LASTEXITCODE -ge 8) { throw 'Electron runtime copy failed' }
    [System.IO.File]::WriteAllText('C:\AMB-Test\project\node_modules\electron\path.txt','electron.exe',[System.Text.UTF8Encoding]::new($false))
  }
  $pack=Run-Step 'package' $node @($npm,'run','pack:local')
  if ($pack -eq 0) {
    $env:AMB_ARTIFACT_DIR=(Get-ChildItem artifacts -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
  }
  $null=Run-Step 'full-suite' $node @('--test','--test-reporter=tap','dist/test/*.test.js','test/*.test.mjs')
  $null=Run-Step 'desktop-accept' $node @('scripts/desktop-accept.mjs','--report',"$out\desktop-acceptance.json")
  Remove-Item Env:\AMB_ARTIFACT_DIR -ErrorAction SilentlyContinue
  $null=Run-Step 'clean-install' $node @($npm,'ci','--ignore-scripts','--no-audit','--no-fund')
  if ($steps[-1].exitCode -eq 0) { $null=Run-Step 'clean-typecheck' $node @($npm,'run','check') }
  Save-State 'completed'
} catch {
  $_ | Out-String | Set-Content "$out\fatal-error.log"
  Save-State 'failed'
}
