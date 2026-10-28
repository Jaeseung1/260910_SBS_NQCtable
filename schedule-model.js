// index.html과 동일한 근무 계산 규칙. 날짜는 시간대 없는 YYYY-MM-DD로 받고,
// 서버의 "오늘"만 한국 시간으로 정한다. 화면과의 동일성은 schedule-validation.test.js에서 검증한다.
function koreaToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit'}).format(now);
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validMonth(value) { return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0,4)) >= 1000; }
function createScheduleModel(raw, today = koreaToday()) {
  const STATE = { ...raw, settings: raw.settings || {}, requests: raw.requests || [], protects: raw.protects || [],
    scheduleRanges: raw.scheduleRanges || [], scheduleOverrides: raw.scheduleOverrides || {}, scheduleSnapshots: raw.scheduleSnapshots || {} };
  const EMPLOYEES = raw.employees || [];
  const ROUTINE_HEADCOUNT = 4, CYCLE = ['일','야','조','O'], ANCHOR = new Date(2026,7,1), DEFAULT_STATION_NAME = '통합관제실';
  function getToday() { return new Date(today + 'T00:00:00'); }
  function isPastDate(date) { return fmt(date) < today; }
  function fmt(date){
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function addDays(date, n){ const d = new Date(date); d.setDate(d.getDate() + n); return d; }

  function empName(id){ return EMPLOYEES.find(e => e.id === id)?.name || id; }

  function dayIndex(date){
    return Math.round((stripTime(date) - ANCHOR) / 86400000);
  }

  function stripTime(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  function getRotationAnchorFor(empId, date){
    const dateValue = fmt(date);
    const candidates = (STATE.rotationAnchors || []).filter(anchor => anchor.empId === empId && anchor.startDate <= dateValue);
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
      return String(a.at) < String(b.at) ? -1 : 1;
    });
    return candidates[candidates.length - 1];
  }

  function baseShift(empId, date){
    const emp = EMPLOYEES.find(e => e.id === empId);
    if (!emp) return '';
    const anchor = getRotationAnchorFor(empId, date);
    if (anchor) {
      const startIdx = CYCLE.indexOf(anchor.startShift);
      if (startIdx >= 0) {
        const offset = Math.round((stripTime(date) - new Date(anchor.startDate + 'T00:00:00')) / 86400000);
        return CYCLE[((startIdx + offset) % 4 + 4) % 4];
      }
    }
    const idx = ((dayIndex(date) + (Number(emp.phase) || 0)) % 4 + 4) % 4;
    return CYCLE[idx];
  }

  function getOrderedEmployeeIds(year, monthIndex){
    const target = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const history = Array.isArray(STATE.employeeOrderHistory) ? STATE.employeeOrderHistory : [];
    let applicable = null;
    history.forEach(entry => {
      if (entry && entry.month <= target && (!applicable || entry.month > applicable.month)) applicable = entry;
    });
    return applicable ? applicable.order : null;
  }

  function getActiveStaff(year, monthIndex){
    const firstDay = new Date(year, monthIndex, 1);
    const lastDay = new Date(year, monthIndex + 1, 0);
    const firstDateStr = fmt(firstDay);
    const lastDateStr = fmt(lastDay);
    const active = EMPLOYEES.filter(emp => {
      const start = emp.startDate || '2026-01-01';
      const end = emp.endDate || null;
      return start <= lastDateStr && (!end || end >= firstDateStr);
    });
    const order = getOrderedEmployeeIds(year, monthIndex);
    if (!order) return active;
    const rank = new Map(order.map((id, index) => [id, index]));
    return active
      .map((emp, index) => ({ emp, index }))
      .sort((a, b) => {
        const ra = rank.has(a.emp.id) ? rank.get(a.emp.id) : Infinity;
        const rb = rank.has(b.emp.id) ? rank.get(b.emp.id) : Infinity;
        return ra !== rb ? ra - rb : a.index - b.index;
      })
      .map(entry => entry.emp);
  }

  function isEmployeeActiveOnDate(emp, date){
    if (!emp) return false;
    const dateValue = fmt(date);
    const start = emp.startDate || '2026-01-01';
    const end = emp.endDate || null;
    return dateValue >= start && (!end || dateValue <= end);
  }

  function shiftKey(empId, date){ return `${fmt(date)}::${empId}`; }

  function dateInRange(dateValue, startDate, endDate){
    return dateValue >= startDate && dateValue <= endDate;
  }

  function getScheduleRange(empId, date){
    const dateValue = fmt(date);
    return STATE.scheduleRanges.find(range => range.empId === empId && dateInRange(dateValue, range.startDate, range.endDate));
  }

  function findChainAssignment(empId, date){
    const key = fmt(date);
    for(const r of STATE.requests){
      if(r.status === 'cancelled') continue;
      for(const ov of r.chain){
        if(ov.date === key && ov.empId === empId) return { shift: ov.shift, at: r.submittedAt };
      }
    }
    return null;
  }

  function calculatedShift(empId, date){
    const assignment = findChainAssignment(empId, date);
    if (assignment) return assignment.shift;
    return baseShift(empId, date);
  }

  function getShiftForDate(empId, date){
    const key = shiftKey(empId, date);
    const range = getScheduleRange(empId, date);
    if (range) return range.value;
    const override = STATE.scheduleOverrides[key];
    if (override) {
      // 수동으로 입력한 근무값과 휴가/대근 배정이 같은 칸에 겹칠 때는 "나중에 내린 결정"이 이긴다.
      // (수동 입력이 항상 이기면, 근무를 손으로 넣은 직원은 휴가를 내도 계속 근무로 표시된다)
      const assignment = findChainAssignment(empId, date);
      if (assignment && String(assignment.at) > String(override.at || '')) return assignment.shift;
      return override.shift;
    }
    if (isPastDate(date) && STATE.scheduleSnapshots[key] !== undefined) return STATE.scheduleSnapshots[key];
    return calculatedShift(empId, date);
  }

  function effectiveShift(empId, date){
    return getShiftForDate(empId, date);
  }

  function isRoutineWorker(emp, date){
    if (!emp) return false;
    const ref = (date instanceof Date && !Number.isNaN(date.getTime())) ? date : getToday();
    const top = getActiveStaff(ref.getFullYear(), ref.getMonth()).slice(0, ROUTINE_HEADCOUNT);
    return top.some(e => e.id === emp.id);
  }

  function isActiveProtection(protection){
    return protection.status !== 'rejected' && protection.status !== 'cancelled';
  }

  function isProtectedOn(empId, date){
    const value = fmt(date);
    return STATE.protects.some(p => p.empId === empId && p.date === value && isActiveProtection(p));
  }

  function findByBaseShift(date, shift, exclude = []){
    const onShift = EMPLOYEES.filter(e => !exclude.includes(e.id) && isEmployeeActiveOnDate(e, date) && effectiveShift(e.id, date) === shift);
    const routine = onShift.filter(e => isRoutineWorker(e, date));
    const available = routine.filter(e => !isProtectedOn(e.id, date));
    return {
      id: available[0]?.id,
      ids: available.map(e => e.id),
      blockedByProtect: routine.filter(e => isProtectedOn(e.id, date)).map(e => e.name),
      skippedNonRoutine: onShift.filter(e => !isRoutineWorker(e, date)).map(e => e.name)
    };
  }

  function substituteNote(result){
    const parts = [];
    if (result.blockedByProtect.length) parts.push(`비번 보장: ${result.blockedByProtect.join(', ')}`);
    if (result.skippedNonRoutine.length) parts.push(`루틴 근무자가 아니어서 제외: ${result.skippedNonRoutine.join(', ')}`);
    return parts.length ? ` (${parts.join(' / ')})` : '';
  }

  function buildChain(empId, type, startDate){
    const employee = EMPLOYEES.find(e => e.id === empId);
    if (!['day', 'set'].includes(type) || Number.isNaN(startDate.getTime())) return { error: '신청 종류와 날짜를 확인해주세요.' };
    if (fmt(startDate) < fmt(getToday())) return { error: '지난 날짜에는 휴가를 신청할 수 없습니다.' };
    if (!employee || !isEmployeeActiveOnDate(employee, startDate)) return { error: '직원의 적용 기간 안에서 신청해주세요.' };
    const d0 = startDate, d1 = addDays(startDate, 1);
    if (type === 'day'){
      if (effectiveShift(empId, d0) !== '일') return { error: '일근인 날짜에만 일근 휴가를 신청할 수 있습니다.' };
      const sub = findByBaseShift(d0, 'O', [empId]);
      if (!sub.id) return { error: '대근 가능한 루틴 근무자가 없습니다.' + substituteNote(sub) + ' 근무표 편집에서 수동으로 지정해주세요.' };
      return { chain: [
        { date: fmt(d0), empId, shift: '휴가', label: '휴가' },
        { date: fmt(d0), empId: sub.id, shift: '대일', label: '대일(일근 대근)' }
      ] };
    }
    if (effectiveShift(empId, d0) !== '야') return { error: '야·조 세트는 야근일부터 신청해주세요.' };
    if (!isEmployeeActiveOnDate(employee, d1) || effectiveShift(empId, d1) !== '조') return { error: '다음 날이 적용 기간 내 조근인 경우에만 야·조 세트 휴가를 신청할 수 있습니다.' };
    const first = findByBaseShift(d0, 'O', [empId]);
    if (!first.id) return { error: '1차 대근 가능한 루틴 근무자가 없습니다.' + substituteNote(first) };
    const unavailable = [];
    // 첫 후보가 둘째 날 배정 불가라면 나머지 후보도 검사한다.
    for (const id of first.ids){
      const candidate = EMPLOYEES.find(e => e.id === id);
      if (!isEmployeeActiveOnDate(candidate, d1) || isProtectedOn(id, d1)){
        unavailable.push(candidate.name + ': 다음 날 적용 기간 밖이거나 비번 보장');
        continue;
      }
      const nextShift = effectiveShift(id, d1);
      // 다음 날 일근은 2차 대근으로 메운다. 다른 근무·휴가·교육은 덮어쓰지 않는다.
      if (!['O', '일'].includes(nextShift)){
        unavailable.push(candidate.name + ': 다음 날 ' + nextShift);
        continue;
      }
      const second = nextShift === '일' ? findByBaseShift(d1, 'O', [empId, id]) : null;
      if (second && !second.id){
        unavailable.push(candidate.name + ': 2차 대근자 없음' + substituteNote(second));
        continue;
      }
      const chain = [
        { date: fmt(d0), empId, shift: '휴가', label: '휴가(야)' },
        { date: fmt(d1), empId, shift: '휴가', label: '휴가(조)' },
        { date: fmt(d0), empId: id, shift: '야', label: '대근 투입(야)' },
        { date: fmt(d1), empId: id, shift: '조', label: '대근 투입(조)' }
      ];
      if (second) chain.push({ date: fmt(d1), empId: second.id, shift: '대일', label: '2차 대근(연쇄)' });
      return { chain };
    }
    return { error: '이틀 모두 배정 가능한 대근 조합이 없습니다. ' + unavailable.join(' / ') + ' 근무표 편집에서 수동으로 지정해주세요.' };
  }

  function protectCountInMonth(empId, y, m){
    return new Set(STATE.protects.filter(p => {
      const d = new Date(p.date + 'T00:00:00');
      return p.empId === empId && d.getFullYear() === y && d.getMonth() === m && isActiveProtection(p);
    }).map(p => p.date)).size;
  }

  function protectionRequestError(empId, date){
    if (Number.isNaN(date.getTime()) || fmt(date) < fmt(getToday())) return '오늘 이후 날짜를 선택해주세요.';
    const employee = EMPLOYEES.find(e => e.id === empId);
    if (!employee || !isEmployeeActiveOnDate(employee, date)) return '직원의 적용 기간 안에서 신청해주세요.';
    if (effectiveShift(empId, date) !== 'O') return '본인이 비번(O)인 날짜만 보장 신청할 수 있습니다.';
    if (isProtectedOn(empId, date)) return '이미 비번 보장을 신청한 날짜입니다.';
    return '';
  }

  function getDefaultApprovalLines(){
    return [
      { title: '담당', name: '' },
      { title: '팀장', name: '' }
    ];
  }

  function normalizeApprovalLines(raw){
    const fallback = getDefaultApprovalLines();
    if (!Array.isArray(raw) || !raw.length) return fallback;
    return fallback.map((item, index) => ({
      title: String(raw[index]?.title ?? item.title).trim() || item.title,
      name: String(raw[index]?.name ?? '').trim()
    }));
  }

  function getApprovalLines(){
    return normalizeApprovalLines(STATE.settings.approvalLines);
  }

  function monthlySnapshot(key){
    const [year, month] = key.split('-').map(Number);
    const days = new Date(year, month, 0).getDate();
    return {
      monthKey: key, stationName: STATE.settings.stationName || DEFAULT_STATION_NAME,
      notes: STATE.settings.notes || '',
      approvalLines: getApprovalLines().map(line => ({ title: line.title, name: line.name })),
      employees: getActiveStaff(year, month - 1).map(emp => ({
        id: emp.id, name: emp.name, startDate: emp.startDate || '', endDate: emp.endDate || '',
        shifts: Array.from({ length: days }, (_, i) => {
          const date = new Date(year, month - 1, i + 1);
          return isEmployeeActiveOnDate(emp, date) ? String(getShiftForDate(emp.id, date) ?? '') : null;
        })
      }))
    };
  }
  return { buildChain, monthlySnapshot, getShiftForDate, protectionRequestError, protectCountInMonth };
}
module.exports = { createScheduleModel, koreaToday, validDate, validMonth };
