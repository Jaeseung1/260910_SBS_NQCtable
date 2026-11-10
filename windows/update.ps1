<#
  통합관제실 근무표 서버 — GitHub 최신 코드로 업데이트

  windows\업데이트.cmd 를 더블클릭하면 이 파일이 실행된다.
    1) 확인: Git·Node.js, 이 폴더가 git clone 으로 받은 폴더인지, 코드 파일을 직접 고친 게 없는지
    2) GitHub 에 새 버전이 있는지 본다. 없으면 서버를 건드리지 않고 끝낸다.
    3) 서버 끄기: 트레이 실행기(windows\tray.ps1)와 그 아래 서버, 명령창에서 켠 node server.js
    4) geunmupyo.db 를 backups\ 에 복사
    5) git pull --ff-only, package-lock.json 이 바뀌었으면 npm ci
    6) 꺼 두었던 방식 그대로 다시 켠다 (트레이 실행기 → 트레이로, 명령창 → 새 명령창으로)

  .env 와 geunmupyo.db 는 git 이 관리하지 않으므로 업데이트해도 그대로 남는다.
  이 파일은 UTF-8(BOM) 이어야 한다 — Windows PowerShell 5.1 은 BOM 없는 파일의 한글을 깨뜨린다.
#>

$ErrorActionPreference = 'Continue'   # git·npm 이 stderr 에 진행 상황을 쓰는 것을 오류로 보지 않는다
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }   # git 의 한글 커밋 메시지

$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root
$TrayScript = Join-Path $PSScriptRoot 'tray.ps1'
$StartVbs = Join-Path $PSScriptRoot 'start.vbs'

function Say([string]$Text) { Write-Host $Text }
function Step([string]$Text) { Write-Host ''; Write-Host $Text -ForegroundColor Cyan }
function Ok([string]$Text) { Write-Host ('  [O] ' + $Text) -ForegroundColor Green }
function Warn([string]$Text) { Write-Host ('  [!] ' + $Text) -ForegroundColor Yellow }
function Fail([string]$Text) {
  Write-Host ''
  Write-Host ('  [X] ' + $Text) -ForegroundColor Red
  exit 1
}

function Get-Port {
  $port = 8000
  $envFile = Join-Path $Root '.env'
  if (Test-Path $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
      if ($line -match '^\s*PORT\s*=\s*"?(\d+)"?\s*$') { $port = [int]$Matches[1] }
    }
  }
  if ($env:PORT -match '^\d+$') { $port = [int]$env:PORT }
  return $port
}
$Port = Get-Port

function Test-Server {
  try {
    # tray.ps1 과 같은 이유로 127.0.0.1 로 묻는다 (localhost 는 IPv6 로 먼저 가서 2초씩 기다린다).
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/lock" -UseBasicParsing -TimeoutSec 2
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Get-TrayProcesses {
  # 이 폴더의 tray.ps1 을 돌리는 powershell 만 고른다 (다른 폴더에 받은 복사본은 건드리지 않는다).
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($TrayScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
}

function Get-PortNodeProcesses {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } |
    Where-Object { $_ -and $_.ProcessName -eq 'node' } |
    Sort-Object Id -Unique
}

function Wait-PortClosed([int]$Seconds = 10) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-PortNodeProcesses)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return (-not (Get-PortNodeProcesses))
}

$script:WasTray = $false
$script:WasConsole = $false

function Stop-AllServers {
  foreach ($proc in @(Get-TrayProcesses)) {
    # 트레이 실행기와 그 아래 cmd·node 를 함께 끈다. 끄지 않으면 서버가 꺼진 걸 보고 옛 코드로 다시 켠다.
    & taskkill.exe /PID $proc.ProcessId /T /F 2>$null | Out-Null
    $script:WasTray = $true
  }
  if ($script:WasTray) { Ok '트레이 실행기를 껐습니다.'; [void](Wait-PortClosed 5) }
  foreach ($proc in @(Get-PortNodeProcesses)) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    $script:WasConsole = $true
  }
  if ($script:WasConsole) { Ok ('포트 {0} 에서 돌던 서버를 껐습니다.' -f $Port) }
  if (-not (Wait-PortClosed 10)) { Fail ('포트 {0} 의 서버가 꺼지지 않습니다. 작업 관리자에서 node.exe 를 끈 뒤 다시 실행해 주세요.' -f $Port) }
  if (-not $script:WasTray -and -not $script:WasConsole) { Say '  켜져 있는 서버가 없습니다.' }
}

function Start-Again {
  if ($script:WasTray) {
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $StartVbs + '"') -WorkingDirectory $Root
    Say '  트레이 실행기를 다시 켰습니다.'
  } elseif ($script:WasConsole) {
    Start-Process -FilePath $env:ComSpec -ArgumentList '/k', 'title 근무표 서버 && node server.js' -WorkingDirectory $Root
    Say '  새 명령창에서 서버를 켰습니다. 그 창은 닫지 마세요.'
  } else {
    Say '  업데이트 전에 서버가 꺼져 있어서 켜지 않았습니다.'
    Say '  켜려면 바탕화면의 "통합관제실 근무표 서버" 아이콘을 누르거나 windows\설치.cmd 를 실행하세요.'
    return
  }
  $deadline = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $deadline) {
    if (Test-Server) { Ok ('서버가 응답합니다: http://localhost:{0}' -f $Port); return }
    Start-Sleep -Milliseconds 500
  }
  Warn '40초 안에 서버가 응답하지 않았습니다. logs\server-*.log 나 서버 창의 메시지를 확인해 주세요.'
}

Write-Host ''
Write-Host '  통합관제실 근무표 업데이트' -ForegroundColor White
Write-Host '  ----------------------------------------------'

# ---------------------------------------------------------------- 1. 확인
Step '[1/5] 확인'
if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { Fail 'Git 이 없습니다. PowerShell 에서 winget install Git.Git 로 설치한 뒤 다시 실행해 주세요.' }
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { Fail 'Node.js 가 없습니다. https://nodejs.org 에서 LTS(22.5 이상)를 설치해 주세요.' }
& node.exe -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)"
if ($LASTEXITCODE -ne 0) { Fail ('Node.js 버전이 낮습니다({0}). 22.5 이상이 필요합니다.' -f (& node.exe --version)) }
if (-not (Test-Path (Join-Path $Root '.git'))) { Fail '이 폴더는 git clone 으로 받은 폴더가 아닙니다. ZIP 으로 받았다면 README 의 "업데이트" 안내를 따라 주세요.' }
$dirty = & git.exe -c core.quotepath=false status --porcelain --untracked-files=no
if ($dirty) {
  Write-Host '  직접 고친 코드 파일이 있어 업데이트하지 않았습니다 (서버도 그대로입니다):' -ForegroundColor Yellow
  $dirty | ForEach-Object { Write-Host ('    ' + $_) }
  Fail '고친 내용이 필요 없다면 이 폴더에서 git checkout -- . 을 실행한 뒤 다시 시도해 주세요.'
}
Ok 'Git·Node.js·폴더 확인'

# ---------------------------------------------------------------- 2. 새 버전 확인
Step '[2/5] 새 버전 확인'
& git.exe fetch --quiet
if ($LASTEXITCODE -ne 0) { Fail 'GitHub 에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요. (서버는 그대로입니다)' }
$old = (& git.exe rev-parse --short HEAD).Trim()
$upstream = (& git.exe rev-parse --short '@{u}' 2>$null)
if (-not $upstream) { Fail '이 브랜치는 GitHub 의 어느 브랜치도 따라가지 않습니다. master 브랜치에서 실행해 주세요.' }
$upstream = $upstream.Trim()
& git.exe merge-base --is-ancestor HEAD '@{u}'
if ($LASTEXITCODE -ne 0) { Fail '이 PC 에서 만든 커밋이 있어 자동으로 합칠 수 없습니다. 담당자에게 문의해 주세요. (서버는 그대로입니다)' }
$needPull = ($old -ne $upstream)
$needNpm = -not (Test-Path (Join-Path $Root 'node_modules'))
if (-not $needPull -and -not $needNpm) {
  Ok ('이미 최신 버전입니다 ({0}). 아무것도 바꾸지 않았습니다.' -f $old)
  exit 0
}
if ($needPull) {
  Say '  새로 들어온 변경:'
  & git.exe -c core.quotepath=false log --oneline --no-decorate 'HEAD..@{u}' | ForEach-Object { Say ('    ' + $_) }
}

# ---------------------------------------------------------------- 3. 서버 끄기
Step '[3/5] 서버 끄기'
Stop-AllServers

# ---------------------------------------------------------------- 4. 데이터 백업
Step '[4/5] 근무표 데이터 백업'
$db = Join-Path $Root 'geunmupyo.db'
if (Test-Path -LiteralPath $db) {
  $backupDir = Join-Path $Root 'backups'
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  $backup = Join-Path $backupDir ('geunmupyo_{0}.db' -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
  try {
    Copy-Item -LiteralPath $db -Destination $backup -ErrorAction Stop
    Ok ('backups\{0}' -f (Split-Path -Leaf $backup))
  } catch {
    Start-Again
    Fail ('백업하지 못해 업데이트를 멈췄습니다: ' + $_.Exception.Message)
  }
} else {
  Say '  아직 geunmupyo.db 가 없어 건너뜁니다.'
}

# ---------------------------------------------------------------- 5. 업데이트
Step '[5/5] 업데이트'
if ($needPull) {
  & git.exe -c core.quotepath=false pull --ff-only --quiet
  if ($LASTEXITCODE -ne 0) {
    Warn '최신 코드를 받지 못했습니다. 기존 코드로 서버를 다시 켭니다.'
    Start-Again
    Fail '위 메시지를 확인한 뒤 다시 실행해 주세요.'
  }
  $new = (& git.exe rev-parse --short HEAD).Trim()
  Ok ('{0} → {1}' -f $old, $new)
  & git.exe diff --quiet $old $new -- package.json package-lock.json
  if ($LASTEXITCODE -ne 0) { $needNpm = $true }
}
if ($needNpm) {
  Say '  구성요소를 설치합니다 (인터넷 필요, 1분 정도)...'
  & npm.cmd ci --omit=dev --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) {
    Fail '구성요소를 설치하지 못했습니다. 서버는 꺼져 있습니다. 인터넷 연결을 확인하고 업데이트.cmd 를 다시 실행해 주세요.'
  }
  Ok '구성요소 설치'
}

Write-Host ''
Start-Again
Write-Host ''
Write-Host '  업데이트를 마쳤습니다. 접속해 있던 브라우저 탭은 모두 새로 열어 주세요.' -ForegroundColor Green
exit 0
