const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function source(name){
  const start = script.indexOf('  function ' + name + '(');
  assert.notEqual(start, -1, name);
  const end = script.indexOf('\n  function ', start + 1);
  return script.slice(start, end < 0 ? undefined : end);
}
const names = ['monthKeyOf', 'monthlySnapshot', 'monthlySnapshotDiff', 'approvedMonthlyVersion',
  'monthlyApprovalError', 'recordMonthlyApproval', 'recordMonthlyVersionChanges', 'currentMonthlyStamp',
  'requestMonthlyApproval', 'applyApprovalDecision', 'decideApproval', 'saveState',
  'renderMonthlyApprovalStatus', 'renderMonthlyVersions', 'renderApprovalBlock', 'escapeAttribute', 'buildExportName', 'saveNotesSection'];
function setup(){
  let count = 0, saves = 0;
  const fields = {
    '#approvalActorSelect': { value: 'boss' }, '#monthlyApprovalStatus': {},
    '#requestMonthlyBtn': {}, '#approvalBlock': {}
  };
  const c = vm.createContext({
    STATE: { monthlyApprovals: {}, versions: [], approvals: [], settings: { stationName: '관제실', notes: '비고', adminPin: 'NEVER_COPY' } },
    staff: [{ id: 'a', name: '직원', startDate: '2099-01-01' }], shift: '일',
    DEFAULT_STATION_NAME: '관제실', STORE_KEY: 'test', alerts: [], actor: { id: 'boss', name: '담당' },
    getCurrentMonthView: () => ({ year: 2099, monthIndex: 0 }),
    getToday: () => new Date('2099-01-01T00:00:00'),
    getActiveStaff: () => c.staff,
    isEmployeeActiveOnDate: (emp, date) => !emp.endDate || date.getDate() <= Number(emp.endDate.slice(-2)),
    getShiftForDate: () => c.shift,
    getApprovalLines: () => [{ title: '담당', name: '' }, { title: '팀장', name: '' }],
    uid: () => 'id' + ++count, $: sel => fields[sel],
    getApprovers: () => [c.actor], approverById: () => c.actor,
    createApproval: value => {
      const approval = { ...value, id: 'request' + ++count, status: 'pending' };
      c.STATE.approvals.push(approval); return approval;
    },
    localStorage: { setItem: () => saves++ }, pushStateToServer(){},
    renderAll(){}, showToast(){}, notifyAll(){}, addAuditLog(){},
    alert: message => c.alerts.push(message), prompt: () => '반려 사유'
  });
  vm.runInContext(names.map(source).join('\n'), c);
  function request(){ c.requestMonthlyApproval(); return c.STATE.approvals.at(-1); }
  function approve(){ const approval = request(); c.decideApproval(approval.id, true); return approval; }
  return { c, fields, request, approve, saves: () => saves };
}

test('application script compiles and history panel stays out of PDF captures', () => {
  new vm.Script(script);
  assert.match(html, /id="monthlyVersionPanel" data-html2canvas-ignore="true"/);
});
test('approval request captures a detached display snapshot without credentials', () => {
  const f = setup(), approval = f.request();
  assert.equal(approval.scheduleSnapshot.employees[0].shifts.length, 31);
  assert.equal(approval.scheduleSnapshot.employees[0].shifts[0], '일');
  assert.ok(!JSON.stringify(approval.scheduleSnapshot).includes('NEVER_COPY'));
  f.c.shift = '휴가'; f.c.staff[0].name = '수정됨';
  assert.equal(approval.scheduleSnapshot.employees[0].name, '직원');
  assert.equal(approval.scheduleSnapshot.employees[0].shifts[0], '일');
});
test('approved version and stamp reference exactly the requested snapshot', () => {
  const f = setup(), approval = f.approve();
  const version = f.c.approvedMonthlyVersion('2099-01');
  assert.equal(approval.status, 'approved');
  assert.equal(version.number, 1);
  assert.equal(version.approvalId, approval.id);
  assert.equal(f.c.currentMonthlyStamp('2099-01').versionId, version.id);
  approval.scheduleSnapshot.notes = 'later mutation';
  assert.equal(version.snapshot.notes, '비고');
});
test('changed pending request cannot be approved or create an approval stamp', () => {
  const f = setup(), approval = f.request();
  f.c.shift = '교육';
  f.c.decideApproval(approval.id, true);
  assert.equal(approval.status, 'pending');
  assert.equal(f.c.STATE.versions.length, 0);
  assert.equal(f.c.STATE.monthlyApprovals['2099-01'], undefined);
  assert.match(f.c.alerts[0], /이후 근무표가 변경/);
});
test('pending duplicate and unchanged reapproval requests are not created', () => {
  const f = setup(); const approval = f.request(); f.request();
  assert.equal(f.c.STATE.approvals.length, 1);
  f.c.decideApproval(approval.id, true); f.request();
  assert.equal(f.c.STATE.approvals.length, 1);
});
test('changes after approval invalidate live stamp and log once per changed save', () => {
  const f = setup(); f.approve();
  f.c.shift = '교육'; f.c.saveState(); f.c.saveState();
  assert.equal(f.c.currentMonthlyStamp('2099-01'), null);
  const changes = f.c.STATE.versions.filter(v => v.kind === 'monthly-change');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changes.length, 31);
  assert.equal(f.c.approvedMonthlyVersion('2099-01').snapshot.employees[0].shifts[0], '일');
  f.c.renderMonthlyApprovalStatus(); f.c.renderApprovalBlock();
  assert.match(f.fields['#monthlyApprovalStatus'].textContent, /再확정|재확정 필요/);
  assert.equal(f.fields['#requestMonthlyBtn'].disabled, false);
  assert.match(f.fields['#approvalBlock'].innerHTML, /재확정 필요/);
});
test('restoring the original values preserves change history and restores matching status', () => {
  const f = setup(); f.approve();
  f.c.STATE.settings.notes = '변경'; f.c.saveState();
  f.c.STATE.settings.notes = '비고'; f.c.saveState();
  assert.equal(f.c.STATE.versions.filter(v => v.kind === 'monthly-change').length, 2);
  assert.ok(f.c.currentMonthlyStamp('2099-01'));
});
test('rejected reapproval keeps v1; approved reapproval creates v2 without overwriting v1', () => {
  const f = setup(); f.approve(); f.c.shift = '교육'; f.c.saveState();
  let approval = f.request(); f.c.decideApproval(approval.id, false);
  assert.equal(f.c.approvedMonthlyVersion('2099-01').number, 1);
  approval = f.request(); f.c.decideApproval(approval.id, true);
  const versions = f.c.STATE.versions.filter(v => v.kind === 'monthly-approved');
  assert.equal(versions.length, 2);
  assert.equal(versions[0].snapshot.employees[0].shifts[0], '일');
  assert.equal(versions[1].snapshot.employees[0].shifts[0], '교육');
  assert.equal(f.c.currentMonthlyStamp('2099-01').number, 2);
});
test('legacy stamps and pending requests are not fabricated into historical snapshots', () => {
  const f = setup();
  f.c.STATE.monthlyApprovals['2099-01'] = { approverName: '과거 담당', at: '2098-12-01' };
  f.c.saveState();
  assert.equal(f.c.STATE.versions.length, 0);
  assert.equal(f.c.currentMonthlyStamp('2099-01'), null);
  f.c.renderMonthlyApprovalStatus();
  assert.match(f.fields['#monthlyApprovalStatus'].textContent, /당시 확정본이 없습니다/);
  const old = { id: 'old', type: 'monthly', refId: '2099-01', status: 'pending' };
  f.c.STATE.approvals.push(old); f.c.decideApproval('old', true);
  assert.equal(old.status, 'pending');
  f.c.decideApproval('old', false);
  assert.equal(f.c.STATE.monthlyApprovals['2099-01'].approverName, '과거 담당');
});
test('snapshot covers leap months, inactive days, employee additions/removals and metadata', () => {
  const f = setup();
  f.c.staff[0].endDate = '2104-02-15';
  const snapshot = f.c.monthlySnapshot('2104-02');
  assert.equal(snapshot.employees[0].shifts.length, 29);
  assert.equal(snapshot.employees[0].shifts[15], null);
  f.c.staff = [{ id: 'b', name: '새 직원' }];
  f.c.STATE.settings.notes = '변경';
  const diff = f.c.monthlySnapshotDiff(snapshot, f.c.monthlySnapshot('2104-02'));
  assert.ok(diff.some(v => v.label === '비고'));
  assert.equal(diff.filter(v => v.label.startsWith('직원 구성')).length, 2);
});
test('snapshot comparison remains valid after a JSON save and reload', () => {
  const f = setup(); f.approve(); f.c.saveState();
  f.c.STATE = JSON.parse(JSON.stringify(f.c.STATE));
  assert.ok(f.c.currentMonthlyStamp('2099-01'));
  f.c.saveState();
  assert.equal(f.c.STATE.versions.length, 1);
});
test('PDF filename reflects actual approval rather than the calendar deadline', () => {
  const f = setup();
  assert.match(f.c.buildExportName('PDF'), /미확정/);
  f.approve();
  assert.match(f.c.buildExportName('PDF'), /확정v1/);
  f.c.shift = '교육';
  assert.match(f.c.buildExportName('PDF'), /재확정필요/);
});
test('saving notes refreshes status and removes the current-table approval stamp immediately', () => {
  const f = setup(); f.approve();
  f.fields['#scheduleNotesInput'] = { value: '변경된 비고' };
  f.c.saveNotesSection();
  assert.match(f.fields['#monthlyApprovalStatus'].textContent, /재확정 필요/);
  assert.match(f.fields['#approvalBlock'].innerHTML, /재확정 필요/);
});
test('stored snapshot text is escaped in the history viewer', () => {
  const f = setup(); f.c.staff[0].name = '<img src=x onerror=alert(1)>';
  f.approve();
  const select = { value: '', addEventListener() {} };
  f.fields['#monthlyVersionContent'] = { querySelector: () => select };
  f.c.renderMonthlyVersions('2099-01');
  assert.ok(!f.fields['#monthlyVersionContent'].innerHTML.includes('<img'));
  assert.match(f.fields['#monthlyVersionContent'].innerHTML, /&lt;img/);
});
