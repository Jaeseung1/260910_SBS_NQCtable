@echo off
chcp 65001 >nul
rem 자동 실행·바탕화면 바로가기를 지운다. 근무표 데이터(geunmupyo.db)와 .env 는 그대로 둔다.
rem 실행 중인 서버는 트레이 아이콘 메뉴의 [종료] 로 끈다.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tray.ps1" -Uninstall
echo.
echo  자동 실행을 껐습니다. 지금 켜져 있는 서버는 트레이 아이콘 → [종료] 로 끌 수 있습니다.
pause
