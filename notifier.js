// 승인 요청 알림 발송 (Phase 3)
//
// 1차/신뢰 채널: 사내메일(SMTP)  — 설정되어 있으면 항상 발송한다.
// 보조 채널: 카카오톡           — 이 PC에 로그인된 KakaoTalk 데스크톱 클라이언트를
//                                자동화해서 보낸다. 실패해도 메일 발송에는 영향이 없다.
//
// 설정이 비어 있으면 발송을 건너뛰고 콘솔에만 남긴다(개발 중에도 서버가 죽지 않도록).

const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  // nodemailer 미설치 시에도 서버는 뜨게 둔다 (npm install 후 메일 기능 활성화)
}

const KAKAO_SCRIPT = path.join(__dirname, 'kakao-notify.ps1');

// 사내망의 다른 PC가 접속할 수 있는 이 서버의 주소. .env의 APP_BASE_URL이 우선.
function getBaseUrl() {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const port = Number(process.env.PORT) || 8000;
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return `http://${net.address}:${port}`;
    }
  }
  return `http://localhost:${port}`;
}

let transporter = null;
function getTransporter() {
  if (transporter !== null) return transporter;
  if (!nodemailer || !process.env.SMTP_HOST) {
    transporter = false;
    return transporter;
  }
  const options = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 25,
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true'
  };
  // 사내망 내부 발신만 허용하는 릴레이는 인증이 없는 경우가 많다.
  if (process.env.SMTP_USER) {
    options.auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' };
  }
  transporter = nodemailer.createTransport(options);
  return transporter;
}

async function sendMail(to, subject, text) {
  const tx = getTransporter();
  if (!tx) return { channel: 'email', to, ok: false, skipped: 'SMTP 설정 없음(.env의 SMTP_HOST)' };
  try {
    await tx.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER || 'noreply@localhost',
      to,
      subject,
      text
    });
    return { channel: 'email', to, ok: true };
  } catch (err) {
    return { channel: 'email', to, ok: false, error: String(err.message || err) };
  }
}

function sendKakao(chatName, message) {
  return new Promise((resolve) => {
    if (String(process.env.KAKAO_AUTOMATION || '').toLowerCase() !== 'true') {
      return resolve({ channel: 'kakao', to: chatName, ok: false, skipped: 'KAKAO_AUTOMATION 미활성' });
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', KAKAO_SCRIPT, '-ChatName', chatName, '-Message', message],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) return resolve({ channel: 'kakao', to: chatName, ok: false, error: String(stderr || err.message).trim() });
        resolve({ channel: 'kakao', to: chatName, ok: true, detail: String(stdout).trim() });
      }
    );
  });
}

function buildMessage(approval) {
  const isApproval = !!approval.id && approval.type !== 'info';
  const who = approval.requestedByName ? `신청자: ${approval.requestedByName}\n` : '';
  const head = isApproval ? '[통합관제실 근무표] 승인 요청' : '[통합관제실 근무표] 알림';
  const tail = isApproval
    ? `아래 주소에서 승인/반려를 처리해주세요.\n${getBaseUrl()}/?approve=${encodeURIComponent(approval.id)}\n`
    : `근무표 확인: ${getBaseUrl()}\n`;
  const body = `${head}\n\n${approval.title}\n\n${who}${approval.summary || ''}\n\n${tail}`;
  return {
    subject: isApproval ? `[근무표 승인요청] ${approval.title}` : `[근무표 알림] ${approval.title}`,
    body
  };
}

async function notifyApprovers(approval, approvers) {
  const { subject, body } = buildMessage(approval);
  const results = [];
  for (const approver of approvers) {
    if (approver.email) {
      results.push(await sendMail(approver.email, subject, body));
    } else {
      results.push({ channel: 'email', to: approver.name, ok: false, skipped: '이메일 미등록' });
    }
    if (approver.kakaoChatName) {
      results.push(await sendKakao(approver.kakaoChatName, body));
    }
  }
  results.forEach(r => {
    const status = r.ok ? '발송' : (r.skipped ? `건너뜀(${r.skipped})` : `실패(${r.error})`);
    console.log(`[알림] ${r.channel} → ${r.to}: ${status}`);
  });
  return results;
}

module.exports = { notifyApprovers, getBaseUrl };
