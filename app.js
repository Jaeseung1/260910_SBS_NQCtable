const monthName = '8월';
const year = 2026;
const staff = ['김민재', '박상우', '최지훈', '한예나'];
const shiftOrder = ['일', '야', '조', '비'];
const daysInMonth = 31;

const scheduleMap = {};
const leaveRequests = [];
const notifications = [];

function rotateArray(items, offset) {
  return items.map((_, index) => items[(index + offset) % items.length]);
}

function buildScheduleMap() {
  for (let day = 1; day <= daysInMonth; day += 1) {
    const rotated = rotateArray(staff, (day - 1) % staff.length);
    const assignment = {
      일: rotated[0],
      야: rotated[1],
      조: rotated[2],
      비: rotated[3],
    };
    scheduleMap[day] = assignment;
  }
}

function addNotification(title, message, type = 'info') {
  notifications.unshift({ title, message, type, createdAt: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) });
}

function renderNotificationList() {
  const container = document.getElementById('notificationList');
  container.innerHTML = notifications.length
    ? notifications.slice(0, 6).map((notice) => `
      <div class="notice-item">
        <span class="type ${notice.type}">${notice.type === 'alert' ? '알림' : notice.type === 'confirm' ? '확정' : '정보'}</span>
        <div>
          <strong>${notice.title}</strong>
          <p>${notice.message}</p>
        </div>
      </div>
    `).join('')
    : '<div class="notice-item"><span class="type info">정보</span><div><strong>대기 중</strong><p>발송된 알림이 없습니다.</p></div></div>';
}

function renderRequestList() {
  const container = document.getElementById('requestList');
  container.innerHTML = leaveRequests.length
    ? leaveRequests.map((req) => `
      <div class="request-item">
        <span class="type ${req.status === '확정' ? 'confirm' : req.type === 'leave' ? 'leave' : 'alert'}">${req.status}</span>
        <div>
          <strong>${req.employee} · ${req.dateLabel}</strong>
          <p>${req.typeLabel} · ${req.note || '사유 미입력'}</p>
        </div>
      </div>
    `).join('')
    : '<div class="request-item"><span class="type info">대기</span><div><strong>신청 내역 없음</strong><p>직원 휴가 또는 대근 신청을 등록해 주세요.</p></div></div>';
}

function getDateLabel(dateValue) {
  const [yearPart, monthPart, dayPart] = dateValue.split('-');
  return `${Number(yearPart)}년 ${Number(monthPart)}월 ${Number(dayPart)}일`;
}

function findStandbyForDate(date, shiftType) {
  const day = Number(date.split('-')[2]);
  const active = scheduleMap[day];
  if (!active) return null;

  const inhibitors = new Set(['일', '야', '조', '비']);
  inhibitors.delete(shiftType);

  if (shiftType === '일') {
    return Object.entries(active).find(([key, value]) => key === '비' && value)?.[1] || null;
  }

  if (shiftType === '야' || shiftType === '조') {
    return active.비 || null;
  }

  return null;
}

function handleRequestSubmission(event) {
  event.preventDefault();

  const requester = document.getElementById('requester').value;
  const requestDate = document.getElementById('requestDate').value;
  const requestType = document.getElementById('requestType').value;
  const note = document.getElementById('requestNote').value.trim();

  if (!requester || !requestDate || !requestType) return;

  const dateLabel = getDateLabel(requestDate);
  const baseRequest = {
    employee: requester,
    date: requestDate,
    dateLabel,
    note,
    status: '검토 중',
    type: requestType,
  };

  if (requestType === 'day') {
    const substitute = findStandbyForDate(requestDate, '일');
    baseRequest.typeLabel = '일근 휴가 신청';
    baseRequest.status = '확정';
    addNotification('일근 휴가 확정', `${requester}님이 ${dateLabel} 일근 휴가를 신청해 ${substitute || '비번자'}에게 대근이 배정됩니다.`, 'confirm');
    leaveRequests.unshift({ ...baseRequest, typeLabel: '일근 휴가', note: note || '일근 휴가 승인' });
  }

  if (requestType === 'night-duty') {
    const substitute = findStandbyForDate(requestDate, '야');
    baseRequest.typeLabel = '야/조근 휴가 신청';
    baseRequest.status = '확정';
    addNotification('야/조근 세트 휴가 확정', `${requester}님이 ${dateLabel} 야/조근 휴가를 신청해 ${substitute || '비번자'}가 야조근 투입으로 대근 처리됩니다.`, 'confirm');
    leaveRequests.unshift({ ...baseRequest, typeLabel: '야/조근 휴가', note: note || '야/조근 세트 휴가' });
  }

  if (requestType === 'reserve') {
    baseRequest.typeLabel = '비번 보장 신청';
    baseRequest.status = '보류';
    addNotification('비번 보장 신청 접수', `${requester}님이 ${dateLabel} 비번 보장 신청을 제출했습니다. 월 2~3회 한도 내 기준을 검토 중입니다.`, 'alert');
    leaveRequests.unshift({ ...baseRequest, typeLabel: '비번 보장', note: note || '사유 미기재' });
  }

  if (requestType === 'substitute') {
    const target = scheduleMap[Number(requestDate.split('-')[2])]?.비 || '비번자';
    baseRequest.typeLabel = '대근 신청';
    baseRequest.status = '대기';
    addNotification('대근 신청 접수', `${requester}님이 ${dateLabel} 대근 신청을 요청했습니다. ${target}에게 알림이 발송됩니다.`, 'alert');
    leaveRequests.unshift({ ...baseRequest, typeLabel: '대근 신청', note: note || '대근 요청' });
  }

  renderRequestList();
  renderNotificationList();
  document.getElementById('leaveForm').reset();
}

function seedDemoData() {
  const demo = [
    { employee: '김민재', date: '2026-08-06', type: 'day', note: '가족 행사' },
    { employee: '박상우', date: '2026-08-12', type: 'night-duty', note: '야/조근 세트' },
    { employee: '최지훈', date: '2026-08-18', type: 'reserve', note: '비번 보장 계획' },
    { employee: '한예나', date: '2026-08-28', type: 'substitute', note: '대근 요청' }
  ];

  demo.forEach((item) => {
    const typeMap = {
      day: '일근 휴가',
      'night-duty': '야/조근 휴가',
      reserve: '비번 보장',
      substitute: '대근 신청',
    };

    leaveRequests.unshift({
      employee: item.employee,
      date: item.date,
      dateLabel: getDateLabel(item.date),
      typeLabel: typeMap[item.type],
      note: item.note,
      status: item.type === 'day' || item.type === 'night-duty' ? '확정' : item.type === 'reserve' ? '보류' : '대기',
      type: item.type,
    });

    if (item.type === 'day') {
      addNotification('일근 대근 확정', `${item.employee}님 휴가로 인한 대근이 ${findStandbyForDate(item.date, '일') || '비번자'}에게 자동 배정되었습니다.`, 'confirm');
    }
    if (item.type === 'night-duty') {
      addNotification('야/조근 대근 투입', `${item.employee}님 야/조근 세트 휴가로 ${findStandbyForDate(item.date, '야') || '비번자'}가 야조근을 수행합니다.`, 'confirm');
    }
    if (item.type === 'reserve') {
      addNotification('비번 보장 계획 접수', `${item.employee}님이 ${getDateLabel(item.date)} 비번 보장 신청을 제출했습니다.`, 'alert');
    }
    if (item.type === 'substitute') {
      addNotification('대근 알림 생성', `${item.employee}님의 대근 요청이 ${scheduleMap[Number(item.date.split('-')[2])]?.비 || '비번자'}에게 전달되었습니다.`, 'alert');
    }
  });

  renderRequestList();
  renderNotificationList();
}

function renderScheduleTable() {
  const table = document.getElementById('scheduleTable');
  const header = ['일', '야', '조', '비'];
  const grid = ['<div class="schedule-grid">'];

  grid.push('<div class="grid-header">일</div>');
  header.forEach((shift) => grid.push(`<div class="grid-header">${shift}</div>`));

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dayAssignments = scheduleMap[day];
    grid.push(`<div class="grid-cell"><span class="date-label">${day}</span></div>`);
    shiftOrder.forEach((shift) => {
      const person = dayAssignments[shift];
      const className = shift === '일' ? 'day' : shift === '야' ? 'night' : shift === '조' ? 'duty' : 'off';
      grid.push(`<div class="grid-cell"><span class="day-badge ${className}">${person}</span></div>`);
    });
  }

  grid.push('</div>');
  table.innerHTML = grid.join('');
}

function populateStaffOptions() {
  const select = document.getElementById('requester');
  select.innerHTML = staff.map((name) => `<option value="${name}">${name}</option>`).join('');
}

function setDefaultDate() {
  const input = document.getElementById('requestDate');
  const today = new Date(year, 7, 1);
  input.min = `${year}-08-01`;
  input.max = `${year}-08-31`;
  input.value = `${year}-08-01`;
}

function initialize() {
  buildScheduleMap();
  populateStaffOptions();
  setDefaultDate();
  renderScheduleTable();

  addNotification('근무표 기준 시작', '8월 NC 근무자는 기본 패턴인 일/야/조/비를 유지하며, 휴가 계획은 25일 00시 전 선제 확정 규칙을 적용합니다.', 'info');
  addNotification('대근 규칙 적용', '일근 휴가와 야/조근 휴가를 세트로 처리하며, 비번자에게 자동으로 대근 알림이 전송됩니다.', 'info');
  renderNotificationList();
  renderRequestList();

  document.getElementById('leaveForm').addEventListener('submit', handleRequestSubmission);
  document.getElementById('seedDemoBtn').addEventListener('click', seedDemoData);

  const standbyCount = document.getElementById('standbyCount');
  standbyCount.textContent = `${Math.max(3, notifications.length)}건`;
}

initialize();
