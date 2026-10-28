const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, copyFileSync, rmSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const vm = require('node:vm');
const { publicState, validateSave } = require('../security');
const root = path.resolve(__dirname, '..');
const { createScheduleModel } = require('../schedule-model');
function validLeave(state, id) {
  const model = createScheduleModel(state);
  for (let day = 1; day <= 28; day++) {
    const startDate = '2099-01-' + String(day).padStart(2, '0');
    const result = model.buildChain('e1', 'day', new Date(startDate + 'T00:00:00'));
    if (!result.error) return { id, empId: 'e1', type: 'day', startDate, chain: result.chain, status: 'pending', submittedAt: new Date().toISOString() };
  }
  throw new Error('정상 휴가 날짜 없음');
}

const password = 'test-admin-password-only';

function seed() {
  return {
    employees: [{ id: 'e1', name: '직원', phase: 0 }, { id: 'e2', name: '다른 직원', phase: 3 }],
    approvers: [
      { id: 'a1', name: '담당', pin: '123456', email: 'one@example.invalid' },
      { id: 'a2', name: '타 담당', pin: '654321', email: 'two@example.invalid' }
    ],
    requests: [{ id: 'r1', empId: 'e1', startDate: '2026-10-01', chain: [], status: 'pending' }],
    protects: [],
    approvals: [{ id: 'p1', refId: 'r1', type: 'leave', requestedBy: 'e1', approverIds: ['a1'], title: '휴가', summary: '', status: 'pending', decidedBy: null, decidedAt: null, decisionReason: '' }],
    settings: { quotaMax: 3, adminPin: 'old-admin-secret', smtpPass: 'old-smtp-secret', kakaoKey: 'old-kakao-secret' },
    monthlyApprovals: {}, auditLogs: [], scheduleSnapshots: {},
    versions: [{ settings: { adminPin: 'nested-secret' }, approvers: [{ pin: 'nested-pin' }] }]
  };
}
async function fixture(t, initial = seed(), adminPassword = password, extraEnv = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nqc-security-'));
  for (const file of ['server.js', 'excel-export.js', 'db.js', 'security.js', 'schedule-model.js', 'activityLog.js', 'notifier.js', 'digest.js', 'index.html', 'sbs-logo.png']) copyFileSync(path.join(root, file), path.join(dir, file));
  if (initial) {
    const db = new DatabaseSync(path.join(dir, 'geunmupyo.db'));
    db.exec('CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.prepare('INSERT INTO kv_store VALUES (?, ?, ?)').run('schedule_state', JSON.stringify(initial), new Date().toISOString());
    db.close();
  }
  const socket = net.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true,
    env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: adminPassword, SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', NODE_PATH: path.join(root, 'node_modules'), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  t.after(async () => {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let attempt = 0; attempt < 300; attempt++) {
    try { if ((await fetch(base + '/api/state')).ok) break; } catch {}
    if (child.exitCode !== null || attempt === 299) throw new Error(output || 'Server startup failed');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  let token = '', employeeToken = '';
  async function api(url, body, admin = false, headers = {}) {
    const response = await fetch(base + url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { 'X-Admin-Token': token } : {}), 'X-Employee-Token': employeeToken, ...headers },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  }
  async function login() {
    const response = await api('/api/auth/admin', { password });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    token = response.data.token;
  }
  async function loginEmployee(empId, pin) {
    const response = await api('/api/auth/employee', { empId, pin });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    employeeToken = response.data.token;
    return response.data;
  }
  async function state() { return (await api('/api/state')).data.state; }
  async function save(value, admin = false, approverPins = {}, employeePins = {}) {
    const current = (await api('/api/state')).data;
    return api('/api/state', { state: value, approverPins, employeePins, baseRevision: current.revision ?? 0 }, admin);
  }
  return { api, login, loginEmployee, state, save, dir };
}

test('legacy secrets migrate to salted hashes; API and static paths do not disclose them', async t => {
  const f = await fixture(t);
  const response = await f.api('/api/state');
  const text = JSON.stringify(response.data);
  for (const secret of ['123456', '654321', 'old-admin-secret', 'old-smtp-secret', 'old-kakao-secret', 'nested-secret', 'nested-pin']) assert.ok(!text.includes(secret), secret);
  assert.equal(response.data.state.approvers[0].pinConfigured, true);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const db = new DatabaseSync(path.join(f.dir, 'geunmupyo.db'));
  const row = db.prepare('SELECT * FROM approval_credentials WHERE id=?').get('a1');
  assert.equal(row.hash.length, 64);
  assert.notEqual(row.hash, '123456');
  const stored = db.prepare('SELECT value FROM kv_store').get().value;
  assert.ok(!stored.includes('nested-pin'));
  db.close();
  for (const url of ['/geunmupyo.db', '/.env', '/security.js', '/server.js', '/package.json', '/%67eunmupyo.db']) assert.equal((await f.api(url)).status, 404, url);
  const page = await f.api('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src-attr 'none'/);
});

test('approval requires assigned actor AND correct PIN; decisions are atomic and cannot be replayed', async t => {
  const f = await fixture(t);
  const decide = (overrides = {}) => f.api('/api/approvals/decision', { id: 'p1', approverId: 'a1', pin: '123456', approved: true, ...overrides });
  assert.equal((await decide({ approverId: 'a2', pin: '654321' })).status, 403);
  assert.equal((await decide({ pin: 'bad' })).status, 401);
  assert.equal((await decide({ approved: false, reason: '' })).status, 400);
  const results = await Promise.all([decide(), decide()]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const state = await f.state();
  assert.equal(state.approvals[0].decidedBy, 'a1');
  assert.equal(state.approvals[0].status, 'approved');
  assert.equal(state.requests[0].status, 'confirmed');
  assert.ok(state.approvals[0].decidedAt);
  assert.equal(state.auditLogs.filter(a => a.details?.approvalId === 'p1').length, 1);
});

test('state API refuses forged results, deleted history and replaced approval targets even for admins', async t => {
  const f = await fixture(t);
  await f.login();
  for (const mutate of [
    s => { s.approvals[0].status = 'approved'; },
    s => { s.approvals[0].approverIds = ['a2']; },
    s => { s.approvals = []; },
    s => { s.requests[0].status = 'confirmed'; },
    s => { s.requests = []; },
    s => { s.monthlyApprovals['2026-10'] = { approverId: 'a1' }; }
  ]) {
    const state = await f.state(); mutate(state);
    assert.equal((await f.save(state, true)).status, 409);
  }
  assert.equal((await f.state()).requests[0].status, 'pending');
});

test('configuration and PIN changes need administrator auth; PIN changes roll back with an invalid save', async t => {
  const f = await fixture(t);
  const original = await f.state();
  assert.equal((await f.save({ ...original, settings: { quotaMax: 10 } })).status, 403);
  assert.equal((await f.save(original, false, { a1: '999999' })).status, 403);
  await f.login();
  const removed = structuredClone(original);
  removed.approvers = removed.approvers.filter(a => a.id !== 'a1');
  assert.equal((await f.save(removed, true)).status, 409);
  assert.equal((await f.save({ ...original, settings: { quotaMax: 4 } }, true)).status, 200);
  const state = await f.state();
  state.approvers.push({ id: 'a3', name: 'new', pinConfigured: true });
  assert.equal((await f.save(state, true, { a1: '999999', a3: 'short' })).status, 400);
  assert.equal((await f.api('/api/approvals/decision', { id: 'p1', approverId: 'a1', pin: '123456', approved: false, reason: '다른 일정' })).status, 200);
  assert.equal((await f.state()).requests[0].status, 'cancelled');
});

test('first save requires configured admin; password attempts and cross-site writes are rejected', async t => {
  const f = await fixture(t, null);
  const state = seed(); state.approvers = []; state.approvals = []; state.requests = []; state.versions = [];
  assert.equal((await f.save(state)).status, 403);
  for (let i = 0; i < 5; i++) assert.equal((await f.api('/api/auth/admin', { password: 'wrong' })).status, 401);
  assert.equal((await f.api('/api/auth/admin', { password })).status, 429);
  assert.equal((await f.api('/api/state', { state }, false, { Origin: 'https://other.invalid' })).status, 403);
});

test('unconfigured admin fails closed, while valid initialization stores public data only', async t => {
  const missing = await fixture(t, null, '');
  assert.equal((await missing.api('/api/auth/admin', { password })).status, 503);
  const f = await fixture(t, null);
  await f.login();
  const state = seed(); state.approvals = []; state.requests = []; state.versions = [];
  state.approvers = state.approvers.map(a => ({ ...publicState(a), pinConfigured: true }));
  assert.equal((await f.save(state, true, { a1: '123456', a2: '654321' })).status, 200);
  assert.ok(!JSON.stringify(await f.state()).includes('123456'));
});

test('new leave requests stay pending, quota is checked by server and targets cannot be forged', async t => {
  const f = await fixture(t);
  await f.login();
  await f.save(await f.state(), true, {}, { e1: 'employee-test-pin-1' });
  await f.loginEmployee('e1', 'employee-test-pin-1');
  const state = await f.state();
  state.requests.push(validLeave(state, 'r2'));
  state.approvals.push({ id: 'p2', refId: 'r2', type: 'leave', requestedBy: 'e1', approverIds: ['a1', 'a2'], status: 'pending' });
  assert.equal((await f.save(state)).status, 200);
  const forged = await f.state();
  forged.requests.push({ id: 'r3', empId: 'e1', startDate: '2026-10-04', chain: [], status: 'confirmed' });
  assert.equal((await f.save(forged)).status, 403);
  const quota = await f.state();
  quota.protects = Array.from({length:28}, (_,i) => '2099-02-' + String(i+1).padStart(2,'0')).filter(date => createScheduleModel(quota).getShiftForDate('e1', new Date(date + 'T00:00:00')) === 'O').slice(0,4).map((date,i) => ({id:'off'+i,empId:'e1',date,status:'approved',needsApproval:false}));
  assert.equal((await f.save(quota)).status, 403);
  const wrong = await f.state();
  wrong.approvals.push({ id: 'month', refId: '2026-10', type: 'monthly', requestedBy: null, approverIds: ['a1'], status: 'pending', scheduleSnapshot: createScheduleModel(wrong).monthlySnapshot('2026-10'), baseVersionId: null });
  assert.equal((await f.save(wrong)).status, 400);
  // 다른 사람 명의로는(로그인은 유지된 채) 신청을 추가할 수 없다. 다른 조건은 모두 유효하게
  // 채워서(정상 상태·연결된 승인 요청) 이 실패가 오직 본인 명의 검사 때문임을 확인한다.
  const impersonate = await f.state();
  impersonate.requests.push({ id: 'r4', empId: 'e2', startDate: '2026-10-05', chain: [], status: 'pending' });
  impersonate.approvals.push({ id: 'p4', refId: 'r4', type: 'leave', requestedBy: 'e2', approverIds: ['a1', 'a2'], status: 'pending' });
  assert.equal((await f.save(impersonate)).status, 403);
});

test('monthly and excess protection decisions update the linked record', async t => {
  const state = seed();
  state.protects.push({ id: 'off1', empId: 'e1', date: '2026-10-05', status: 'pending', needsApproval: true });
  state.approvals.push({ id: 'off-approval', type: 'protect', refId: 'off1', requestedBy: 'e1', approverIds: ['a1'], status: 'pending' });
  state.approvals.push({ id: 'month', type: 'monthly', refId: '2026-10', requestedBy: null, approverIds: ['a1', 'a2'], status: 'pending', scheduleSnapshot: createScheduleModel(state).monthlySnapshot('2026-10'), baseVersionId: null });
  const f = await fixture(t, state);
  for (const id of ['off-approval', 'month']) assert.equal((await f.api('/api/approvals/decision', { id, approverId: 'a1', pin: '123456', approved: true })).status, 200);
  const saved = await f.state();
  assert.equal(saved.protects[0].status, 'approved');
  assert.equal(saved.monthlyApprovals['2026-10'].approverId, 'a1');
});

test('approving a monthly request with a schedule snapshot stores a versioned confirmation', async t => {
  const state = seed();
  const snapshot = createScheduleModel(state).monthlySnapshot('2026-10');
  state.approvals.push({ id: 'month1', type: 'monthly', refId: '2026-10', requestedBy: null, approverIds: ['a1', 'a2'], status: 'pending', scheduleSnapshot: snapshot, baseVersionId: null });
  const f = await fixture(t, state);
  assert.equal((await f.api('/api/approvals/decision', { id: 'month1', approverId: 'a1', pin: '123456', approved: true })).status, 200);
  await f.login();
  const saved = await f.state();
  const version = saved.versions.find(v => v.kind === 'monthly-approved' && v.monthKey === '2026-10');
  assert.equal(version.number, 1);
  assert.equal(version.approverId, 'a1');
  assert.deepEqual(version.snapshot, snapshot);
  assert.equal(saved.monthlyApprovals['2026-10'].versionId, version.id);
  assert.equal(saved.monthlyApprovals['2026-10'].number, 1);
  // 재확정 요청을 반려하면 이전 확정본과 도장은 그대로 남는다.
  state.approvals.push({ id: 'month2', type: 'monthly', refId: '2026-10', requestedBy: null, approverIds: ['a1', 'a2'], status: 'pending', scheduleSnapshot: snapshot, baseVersionId: version.id });
  await f.save({ ...saved, approvals: [...saved.approvals, state.approvals.at(-1)] }, true);
  assert.equal((await f.api('/api/approvals/decision', { id: 'month2', approverId: 'a1', pin: '123456', approved: false, reason: '재확인 필요' })).status, 200);
  const afterReject = await f.state();
  assert.equal(afterReject.monthlyApprovals['2026-10'].versionId, version.id);
  assert.equal(afterReject.versions.filter(v => v.kind === 'monthly-approved').length, 1);
  // 같은 표를 다시 확정하면 이전 확정본을 덮어쓰지 않고 새 버전을 추가한다.
  const secondSnapshot = { ...snapshot, notes: '변경됨' };
  state.approvals.push({ id: 'month3', type: 'monthly', refId: '2026-10', requestedBy: null, approverIds: ['a1', 'a2'], status: 'pending', scheduleSnapshot: secondSnapshot, baseVersionId: version.id });
  await f.save({ ...afterReject, settings: {...afterReject.settings, notes: '변경됨'}, approvals: [...afterReject.approvals, state.approvals.at(-1)] }, true);
  assert.equal((await f.api('/api/approvals/decision', { id: 'month3', approverId: 'a2', pin: '654321', approved: true })).status, 200);
  const afterSecondApproval = await f.state();
  const versions = afterSecondApproval.versions.filter(v => v.kind === 'monthly-approved');
  assert.equal(versions.length, 2);
  assert.equal(versions[1].number, 2);
  assert.equal(afterSecondApproval.monthlyApprovals['2026-10'].number, 2);
  assert.equal(versions[0].snapshot.notes, '');
});

test('existing version history cannot be edited or removed through the generic save endpoint', async t => {
  const state = seed();
  state.versions = [{ id: 'v1', kind: 'monthly-approved', monthKey: '2026-10', number: 1, snapshot: { notes: 'first' } }];
  const f = await fixture(t, state);
  const current = await f.api('/api/state');
  // 새 이력을 뒤에 추가하는 것은 관리자 인증 없이도 허용된다.
  const appended = { ...current.data.state, versions: [...state.versions, { id: 'v2', kind: 'monthly-change', changes: [] }] };
  assert.equal((await f.save(appended, false)).status, 200);
  // 기존 항목을 고치거나 지우는 것은 관리자라도 거부된다.
  const tampered = { ...current.data.state, versions: [{ id: 'v1', kind: 'monthly-approved', monthKey: '2026-10', number: 1, snapshot: { notes: 'forged' } }] };
  assert.equal((await f.save(tampered, true)).status, 409);
  const removed = { ...current.data.state, versions: [] };
  assert.equal((await f.save(removed, true)).status, 409);
});

test('notification recipients/content are taken from stored approval, not client-supplied addresses', async t => {
  const f = await fixture(t);
  const response = await f.api('/api/notify', { approval: { id: 'p1', title: 'FORGED' }, approvers: [{ email: 'forged@example.invalid' }] });
  assert.equal(response.status, 200);
  assert.ok(!JSON.stringify(response.data).includes('forged@example.invalid'));
  assert.match(JSON.stringify(response.data), /one@example.invalid/);
  assert.equal((await f.api('/api/notify', { approval: { id: 'p1' } })).status, 429);
  assert.equal((await f.api('/api/notify', { approval: { id: '' } })).status, 400);
});

test('UI compiles and renders untrusted approval strings as text without inline handlers', () => {
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  assert.ok(!html.includes('onclick='));
  const payload = '<img src=x onerror="alert(1)">\\\'';
  const nodes = { '#approvalActorSelect': { value: '' }, '#approvalList': {}, '#approvalHistory': {}, '#approverList': {} };
  const approval = { id: 'id', status: 'pending', type: 'leave', title: payload, summary: payload, approverIds: ['a'], requestedAt: new Date().toISOString() };
  const actors = [{ id: 'a', name: payload, email: payload }];
  const context = vm.createContext({ $: selector => nodes[selector], STATE: { approvals: [approval] }, getApprovers: () => actors, pendingApprovals: () => [approval], approverName: () => payload, APPROVAL_TYPE_LABEL: { leave: '휴가' } });
  const escape = script.slice(script.indexOf('  function escapeAttribute'), script.indexOf('  function isStandardShift'));
  const render = script.slice(script.indexOf('  function renderApprovalInbox'), script.indexOf('  function addApprover'));
  vm.runInContext(escape + render + '\nrenderApprovalInbox();renderApproverAdmin();', context);
  for (const node of Object.values(nodes)) if (node.innerHTML) {
    assert.ok(!node.innerHTML.includes('<img'), node.innerHTML);
    assert.ok(node.innerHTML.includes('&lt;img'));
  }
});

test('validation rejects duplicate IDs, prototype keys and deeply nested payloads', () => {
  const old = publicState(seed()), state = structuredClone(old);
  state.approvers.push(state.approvers[0]);
  assert.throws(() => validateSave(old, state, true), /ID/);
  assert.throws(() => validateSave(old, JSON.parse('{"__proto__":{"polluted":true}}'), true), /입력 키/);
  let deep = {}; for (let i = 0; i < 30; i++) deep = { deep };
  assert.throws(() => validateSave(old, deep, true), /깊/);
});

test('editing lock keeps admin and employee from editing at the same time', async t => {
  const f = await fixture(t);
  await f.login();
  const acquired = await f.api('/api/lock/acquire', {}, true);
  assert.equal(acquired.status, 200);
  assert.equal(acquired.data.holderName, '관리자');
  assert.equal((await f.api('/api/lock')).data.locked, true);

  // 관리자 인증으로 직원 PIN을 등록해야 직원 로그인을 테스트할 수 있다.
  await f.save(await f.state(), true, {}, { e1: '123456' });
  await f.loginEmployee('e1', '123456');

  const blocked = await f.api('/api/lock/acquire', {});
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /관리자/);

  // 같은 관리자가 다시 요청하는 건 충돌이 아니다(재접속/하트비트 대용).
  assert.equal((await f.api('/api/lock/acquire', {}, true)).status, 200);
  assert.equal((await f.api('/api/lock/heartbeat', {}, true)).status, 200);

  const released = await f.api('/api/lock/release', {}, true);
  assert.equal(released.status, 200);
  assert.equal((await f.api('/api/lock')).data.locked, false);

  const employeeAcquired = await f.api('/api/lock/acquire', {});
  assert.equal(employeeAcquired.status, 200);
  assert.equal(employeeAcquired.data.holderName, '직원');
  assert.equal((await f.api('/api/lock/acquire', {}, true)).status, 409, '이번엔 직원이 잡고 있으니 관리자가 막혀야 한다');
});

test('DEFAULT_APPROVER_* env vars seed a fallback approver so approvals never drop to zero', async t => {
  const f = await fixture(t, { ...seed(), approvers: [] }, password, {
    DEFAULT_APPROVER_NAME: '자동담당', DEFAULT_APPROVER_EMAIL: 'auto@example.invalid', DEFAULT_APPROVER_PIN: 'auto-pin-123456'
  });
  const state = await f.state();
  assert.equal(state.approvers.length, 1);
  assert.equal(state.approvers[0].id, 'default_approver');
  assert.equal(state.approvers[0].name, '자동담당');
  assert.equal(state.approvers[0].email, 'auto@example.invalid');
  assert.equal(state.approvers[0].pinConfigured, true);
  // 관리자 인증이면 이 자동 담당자의 PIN 없이도 승인 처리가 된다.
  await f.login();
  const request = validLeave(await f.state(), 'ra');
  const approval = { id: 'pa', refId: 'ra', type: 'leave', requestedBy: 'e1', approverIds: ['default_approver'], status: 'pending' };
  const next = await f.state();
  next.requests.push(request); next.approvals.push(approval);
  assert.equal((await f.save(next, true)).status, 200);
  const decided = await f.api('/api/approvals/decision', { id: 'pa', approverId: 'default_approver', pin: '', approved: true, reason: '' }, true);
  assert.equal(decided.status, 200, JSON.stringify(decided.data));
});

test('activity log writes human-readable txt lines for submissions, decisions and self-cancels', async t => {
  const f = await fixture(t);
  await f.login();
  await f.save(await f.state(), true, {}, { e1: 'employee-test-pin-1' });
  await f.loginEmployee('e1', 'employee-test-pin-1');

  const state = await f.state();
  const leave = validLeave(state, 'r9');
  state.requests.push(leave);
  state.approvals.push({ id: 'p9', refId: 'r9', type: 'leave', requestedBy: 'e1', approverIds: ['a1', 'a2'], status: 'pending' });
  state.excuses = [{ id: 'x9', empId: 'e1', date: '2026-10-03', reason: '몸이 안 좋습니다' }];
  assert.equal((await f.save(state)).status, 200);

  const decision = await f.api('/api/approvals/decision', { id: 'p9', approverId: 'a1', pin: '123456', approved: false, reason: '인원 부족' });
  assert.equal(decision.status, 200);

  // r1은 seed()에 있는 e1 소유의 대기 중 신청이라 본인 취소가 가능하다.
  assert.equal((await f.api('/api/requests/cancel', { kind: 'request', id: 'r1' })).status, 200);

  const logDir = path.join(f.dir, 'logs');
  const files = readdirSync(logDir);
  assert.equal(files.length, 1, '오늘 날짜 파일 하나에 전부 기록되어야 한다');
  const content = readFileSync(path.join(logDir, files[0]), 'utf8');
  assert.ok(content.includes('휴가 신청 — 직원 / ' + leave.startDate + ' (일근) / 승인 대기'));
  assert.match(content, /대근 불가 사유 — 직원 \/ 2026-10-03: 몸이 안 좋습니다/);
  assert.match(content, /휴가 신청 반려 — 대상: 직원 \/ 처리자: 담당 \/ 사유: 인원 부족/);
  assert.match(content, /휴가 신청 본인 취소 — 직원 \/ 2026-10-01/);
});

test('editing lock auto-releases after the heartbeat times out', async t => {
  // scrypt 기반 로그인 자체가 수백 ms 걸리므로, 준비 단계(직원 PIN 등록+로그인)가 끝나기 전에
  // 타임아웃이 지나버리지 않도록 넉넉한 값을 쓴다.
  const f = await fixture(t, seed(), password, { LOCK_TIMEOUT_MS: '3000' });
  await f.login();
  assert.equal((await f.api('/api/lock/acquire', {}, true)).status, 200);
  await f.save(await f.state(), true, {}, { e1: '123456' });
  await f.loginEmployee('e1', '123456');
  assert.equal((await f.api('/api/lock/acquire', {})).status, 409, '아직 하트비트 타임아웃 전이라 직원은 막혀야 한다');
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal((await f.api('/api/lock')).data.locked, false, '하트비트가 끊긴 지 오래됐으면 자동 해제되어야 한다');
  assert.equal((await f.api('/api/lock/acquire', {})).status, 200, '해제된 뒤에는 직원도 새로 잠글 수 있어야 한다');
});

test('직원이 보낸 타인 근무 변경·누락된 대근·직원 순서 우회는 저장되지 않는다', async t => {
  const f = await fixture(t);
  await f.login();
  await f.save(await f.state(), true, {}, {e1:'employee-pin'});
  await f.loginEmployee('e1','employee-pin');
  const old = await f.state();
  for (const change of [r => {r.chain[1].shift='휴가';}, r => {r.chain.pop();}, r => {r.chain[1].empId='e1';}]) {
    const next=structuredClone(old), request=validLeave(next,'new_leave'); change(request);
    next.requests.push(request);
    next.approvals.push({id:'new_approval',type:'leave',refId:request.id,requestedBy:'e1',status:'pending',approverIds:['a1','a2']});
    assert.equal((await f.save(next)).status,409);
    assert.deepEqual(await f.state(),old);
  }
  assert.equal((await f.save({...old,employeeOrderHistory:[{month:'2099-01',order:['e2','e1']}]})).status,403);
});

test('현재 표와 다른 월 확정 요청·조작한 확정본 추가는 거절한다', async t => {
  const f=await fixture(t), old=await f.state();
  const snapshot=createScheduleModel(old).monthlySnapshot('2099-01');
  snapshot.employees[0].shifts[0]='위조';
  const approval={id:'month_new',type:'monthly',refId:'2099-01',requestedBy:null,status:'pending',approverIds:['a1','a2'],scheduleSnapshot:snapshot,baseVersionId:null};
  assert.equal((await f.save({...old,approvals:[...old.approvals,approval]})).status,409);
  assert.equal((await f.save({...old,versions:[...old.versions,{id:'fake',kind:'monthly-approved',monthKey:'2099-01',number:1,snapshot}]})).status,403);
  assert.deepEqual(await f.state(),old);
});

test('다른 PC가 해당 월을 바꾼 뒤의 승인은 거절하고 반려는 허용한다', async t => {
  const f=await fixture(t); await f.login();
  const old=await f.state();
  const approval={id:'month_new',type:'monthly',refId:'2099-01',requestedBy:null,status:'pending',approverIds:['a1','a2'],scheduleSnapshot:createScheduleModel(old).monthlySnapshot('2099-01'),baseVersionId:null};
  assert.equal((await f.save({...old,approvals:[...old.approvals,approval]})).status,200);
  const changed=await f.state();changed.scheduleOverrides={'2099-01-01::e1':{shift:'교육',at:new Date().toISOString()}};
  assert.equal((await f.save(changed,true)).status,200);
  const before=await f.state();
  assert.equal((await f.api('/api/approvals/decision',{id:approval.id,approverId:'a1',pin:'123456',approved:true})).status,409);
  assert.deepEqual(await f.state(),before);
  assert.equal((await f.api('/api/approvals/decision',{id:approval.id,approverId:'a1',pin:'123456',approved:false,reason:'변경된 표로 재요청'})).status,200);
});

test('다른 월 수정이나 알림 추가만으로 월 확정을 막지 않는다', async t => {
  const f=await fixture(t);await f.login();
  const old=await f.state(), snapshot=createScheduleModel(old).monthlySnapshot('2099-01');
  const approval={id:'month_new',type:'monthly',refId:'2099-01',requestedBy:null,status:'pending',approverIds:['a1','a2'],scheduleSnapshot:snapshot,baseVersionId:null};
  assert.equal((await f.save({...old,approvals:[...old.approvals,approval]})).status,200);
  const changed=await f.state();changed.notifications=[{id:'notice',title:'안내'}];
  changed.scheduleOverrides={'2099-02-01::e1':{shift:'교육',at:new Date().toISOString()}};
  assert.equal((await f.save(changed,true)).status,200);
  assert.equal((await f.api('/api/approvals/decision',{id:approval.id,approverId:'a1',pin:'123456',approved:true})).status,200);
  assert.deepEqual((await f.state()).versions.at(-1).snapshot,snapshot);
});

test('스냅샷 없는 과거 대기 요청은 보존하며 반려 후 재요청하게 한다', async t => {
  const initial=seed();initial.monthlyApprovals={'2025-01':{approverName:'과거담당',at:'2025-01-01T00:00:00Z'}};
  initial.approvals.push({id:'legacy_month',type:'monthly',refId:'2026-10',requestedBy:null,status:'pending',approverIds:['a1']});
  const f=await fixture(t,initial), before=await f.state();
  assert.equal((await f.api('/api/approvals/decision',{id:'legacy_month',approverId:'a1',pin:'123456',approved:true})).status,409);
  assert.deepEqual(await f.state(),before);
  assert.equal((await f.api('/api/approvals/decision',{id:'legacy_month',approverId:'a1',pin:'123456',approved:false,reason:'새 요청 필요'})).status,200);
  assert.deepEqual((await f.state()).monthlyApprovals,initial.monthlyApprovals);
});

test('반려·취소는 한도에서 제외하고 기존 중복 날짜는 한 번만 센다', async t => {
  const initial=seed();initial.settings.quotaMax=2;
  const dates=Array.from({length:28},(_,i)=>'2099-02-'+String(i+1).padStart(2,'0')).filter(d=>createScheduleModel(initial).getShiftForDate('e1',new Date(d+'T00:00:00'))==='O');
  initial.protects=[
    {id:'one',empId:'e1',date:dates[0],status:'approved',needsApproval:false},
    {id:'duplicate',empId:'e1',date:dates[0],status:'approved',needsApproval:false},
    {id:'rejected',empId:'e1',date:dates[1],status:'rejected',needsApproval:true},
    {id:'cancelled',empId:'e1',date:dates[2],status:'cancelled',needsApproval:false}
  ];
  const f=await fixture(t,initial);await f.login();
  await f.save(await f.state(),true,{}, {e1:'employee-pin'});await f.loginEmployee('e1','employee-pin');
  const next=await f.state();next.protects.push({id:'second',empId:'e1',date:dates[1],status:'approved',needsApproval:false});
  assert.equal((await f.save(next)).status,200);
  assert.deepEqual((await f.state()).protects.slice(0,4),initial.protects);
  const duplicate=await f.state();duplicate.protects.push({id:'dup_new',empId:'e1',date:dates[0],status:'pending',needsApproval:true,reason:'중복'});
  assert.equal((await f.save(duplicate)).status,400);
  const overflow=await f.state();overflow.protects.push({id:'third',empId:'e1',date:dates[2],status:'pending',needsApproval:true,reason:'가족 일정'});
  overflow.approvals.push({id:'third_approval',type:'protect',refId:'third',requestedBy:'e1',status:'pending',approverIds:['a1','a2']});
  assert.equal((await f.save(overflow)).status,200);
});

test('무인증·다른 세션의 잠금 해제와 잠금 중 저장·취소·승인을 막는다', async t => {
  const f=await fixture(t);await f.login();
  await f.save(await f.state(),true,{}, {e1:'employee-pin'});
  await f.api('/api/lock/acquire',{},true);
  await f.api('/api/lock/release',{});
  assert.equal((await f.api('/api/lock')).data.locked,true);
  await f.api('/api/lock/release',{adminToken:'invalid'});
  assert.equal((await f.api('/api/lock')).data.locked,true);
  const secondAdmin=await f.api('/api/auth/admin',{password});
  assert.equal((await f.api('/api/lock/acquire',{},false,{'X-Admin-Token':secondAdmin.data.token})).status,409);
  await f.api('/api/lock/release',{},false,{'X-Admin-Token':secondAdmin.data.token});
  assert.equal((await f.api('/api/lock')).data.locked,true);
  await f.loginEmployee('e1','employee-pin');
  assert.equal((await f.save(await f.state())).status,423);
  assert.equal((await f.api('/api/requests/cancel',{kind:'request',id:'r1'})).status,423);
  assert.equal((await f.api('/api/approvals/decision',{id:'p1',approverId:'a1',pin:'123456',approved:true})).status,423);
  await f.api('/api/lock/release',{},true);
  assert.equal((await f.api('/api/lock/acquire',{})).status,200);
  assert.equal((await f.api('/api/requests/cancel',{kind:'request',id:'r1'})).status,200);
});

test('페이지 종료의 body 토큰은 본인 세션 잠금만 해제한다', async t => {
  const f=await fixture(t);
  const login=await f.api('/api/auth/admin',{password});
  const headers={'X-Admin-Token':login.data.token};
  assert.equal((await f.api('/api/lock/acquire',{},false,headers)).status,200);
  await f.api('/api/lock/release',{adminToken:login.data.token});
  assert.equal((await f.api('/api/lock')).data.locked,false);
});
