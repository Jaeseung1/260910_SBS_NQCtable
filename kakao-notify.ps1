# KakaoTalk 데스크톱 클라이언트로 특정 상대에게 메시지를 보낸다.
#
# 전제 조건
#  - 이 PC에 KakaoTalk PC 버전이 설치되어 있고 로그인된 상태로 실행 중일 것
#  - 받는 사람이 그 계정의 카카오톡 친구로 등록되어 있을 것
#  - -ChatName 은 카카오톡 친구 목록에 보이는 이름과 정확히 같을 것
#
# 주의: 카카오가 공식 지원하는 방법이 아니라 창을 직접 조작하는 방식이라,
# 카카오톡 업데이트로 창 구조가 바뀌면 동작하지 않을 수 있다. 그래서 근무표
# 시스템은 이 경로가 실패해도 사내메일로 승인 요청이 전달되도록 되어 있다.
#
# 사용: powershell -File kakao-notify.ps1 -ChatName "홍길동" -Message "내용"

param(
  [Parameter(Mandatory = $true)][string]$ChatName,
  [Parameter(Mandatory = $true)][string]$Message
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
}
"@

function Focus-Window([IntPtr]$handle) {
  if ([Win32]::IsIconic($handle)) { [Win32]::ShowWindow($handle, 9) | Out-Null }  # 9 = SW_RESTORE
  [Win32]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 400
}

# 1) 카카오톡 메인 창을 찾는다
$main = [Win32]::FindWindow("EVA_Window_Dblclk", $null)
if ($main -eq [IntPtr]::Zero) {
  Write-Error "KakaoTalk 창을 찾지 못했습니다. 카카오톡 PC 버전이 실행 중이고 로그인되어 있는지 확인하세요."
  exit 1
}

Add-Type -AssemblyName System.Windows.Forms

# 2) 메인 창에서 친구 검색 → 상대 선택 → 채팅창 열기
Focus-Window $main
[System.Windows.Forms.SendKeys]::SendWait("^f")          # 검색창 열기
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("^a{BACKSPACE}") # 이전 검색어 지우기
Start-Sleep -Milliseconds 200

# SendKeys 특수문자(+ ^ % ~ ( ) { } [ ])는 이스케이프해야 그대로 입력된다
function Escape-SendKeys([string]$text) {
  return ($text -replace '([+^%~(){}\[\]])', '{$1}')
}

[System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys $ChatName))
Start-Sleep -Milliseconds 900
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")      # 검색 결과 첫 번째 선택
Start-Sleep -Milliseconds 900

# 3) 열린 채팅창을 찾는다 (채팅창 제목 = 상대 이름)
$chat = [Win32]::FindWindow($null, $ChatName)
if ($chat -eq [IntPtr]::Zero) {
  Write-Error "'$ChatName' 채팅창을 열지 못했습니다. 카카오톡 친구 목록에 같은 이름으로 등록되어 있는지 확인하세요."
  exit 2
}
Focus-Window $chat

# 4) 메시지를 클립보드로 붙여넣고 전송
#    (SendKeys로 한글을 직접 치면 IME 때문에 깨질 수 있어 클립보드를 쓴다)
$previousClipboard = $null
try { $previousClipboard = Get-Clipboard -Raw } catch { }

Set-Clipboard -Value $Message
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 300

if ($null -ne $previousClipboard) {
  try { Set-Clipboard -Value $previousClipboard } catch { }
}

Write-Output "sent to $ChatName"
exit 0
