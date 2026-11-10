@echo off
chcp 65001 >nul
rem 통합관제실 근무표 서버 — GitHub 최신 코드로 업데이트 (더블클릭)
rem 실제 작업은 update.ps1 이 한다. git pull 이 이 파일을 바꿔도 cmd 가 엉뚱한 줄을 읽지 않도록
rem 실행·멈춤·끝내기를 마지막 한 줄에 모아 둔다 (cmd 는 줄 단위로 파일을 다시 읽는다).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" & echo. & pause & exit /b
