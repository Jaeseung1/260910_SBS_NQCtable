// Windows 트레이 실행기(windows/) 점검.
// 실제로 서버를 띄우지는 않는다 — 실행기는 프로젝트 폴더의 geunmupyo.db 를 쓰기 때문이다.
// 깨지기 쉬운 것만 지킨다: 인코딩(BOM·ASCII), 줄바꿈, PowerShell 문법.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'windows');
const read = name => readFileSync(path.join(dir, name));

test('tray.ps1 은 UTF-8 BOM 으로 시작한다 (Windows PowerShell 5.1 이 한글을 깨뜨리지 않게)', () => {
  const bytes = read('tray.ps1');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('start.vbs 는 ASCII 로만 쓴다 (wscript 는 시스템 코드 페이지로 읽는다)', () => {
  assert.ok([...read('start.vbs')].every(byte => byte < 0x80));
});

test('설치·제거 cmd 는 BOM 이 없다 (첫 줄 @echo off 가 깨진다)', () => {
  for (const name of ['설치.cmd', '제거.cmd']) {
    const bytes = read(name);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], name);
    assert.match(bytes.toString('utf8'), /^@echo off/, name);
  }
});

test('상태 확인은 127.0.0.1 로 한다 (localhost 는 IPv6 로 먼저 가서 2초씩 기다린다)', () => {
  const source = read('tray.ps1').toString('utf8');
  assert.match(source, /http:\/\/127\.0\.0\.1:\$Port\/api\/lock/);
});

test('tray.ps1 은 PowerShell 문법 오류가 없다', { skip: process.platform !== 'win32' && 'Windows 에서만' }, () => {
  const file = path.join(dir, 'tray.ps1').replace(/'/g, "''");
  const script = "$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('" + file + "',[ref]$t,[ref]$e);" +
    "if($e.Count){$e|ForEach-Object{$_.ToString()};exit 1}";
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' });
});
