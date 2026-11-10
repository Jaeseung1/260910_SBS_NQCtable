@echo off
chcp 65001 >nul
setlocal
rem 통합관제실 근무표 서버 — 사무실 공용 PC 설치 (처음 한 번, 더블클릭)
rem  1) Node.js 확인  2) 구성요소 설치  3) .env 준비
rem  4) 바탕화면·자동 실행 바로가기 만들기  5) 트레이 실행기 띄우기
cd /d "%~dp0.."

echo.
echo  통합관제실 근무표 서버 설치
echo  ----------------------------------------------

where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js 가 없습니다.
  echo      https://nodejs.org 에서 LTS 버전^(22.5 이상^)을 설치한 뒤 다시 실행해 주세요.
  goto :fail
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)"
if errorlevel 1 (
  echo  [X] Node.js 버전이 낮습니다. 22.5 이상이 필요합니다.
  node --version
  goto :fail
)
echo  [O] Node.js 확인

if not exist node_modules (
  echo  [ ] 구성요소를 설치합니다 ^(인터넷 필요, 1분 정도^)...
  call npm ci --omit=dev
  if errorlevel 1 goto :fail
)
echo  [O] 구성요소 확인

if not exist .env (
  copy /y .env.example .env >nul
  echo  [!] .env 를 만들었습니다. 메모장으로 열어 ADMIN_PASSWORD 를 꼭 채워 주세요.
) else (
  echo  [O] .env 확인
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tray.ps1" -Install
if errorlevel 1 goto :fail

echo.
echo  설치를 마쳤습니다.
echo   - 작업표시줄 오른쪽 트레이의 "근" 아이콘이 서버 상태입니다 ^(초록 = 실행 중^).
echo   - 아이콘을 두 번 누르면 상태 창이 열립니다 ^(접속 주소 복사, 다시 시작, 로그^).
echo   - 이 PC 에 로그인하면 저절로 켜집니다. 끄려면 상태 창에서 체크를 풀거나 제거.cmd 를 실행하세요.
echo.
pause
exit /b 0

:fail
echo.
echo  설치하지 못했습니다. 위 메시지를 확인해 주세요.
pause
exit /b 1
