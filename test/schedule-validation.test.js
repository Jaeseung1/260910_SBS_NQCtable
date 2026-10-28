const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createScheduleModel,validDate,koreaToday}=require('../schedule-model');
const {validateSave}=require('../security');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
function source(name){
  const start=html.indexOf('  function '+name+'('),lineEnd=html.indexOf('\n',start);
  assert.ok(start>=0,name);
  return html.slice(start,html.slice(start,lineEnd).trimEnd().endsWith('}')?lineEnd:html.indexOf('\n  }',start)+4);
}
const names=['fmt','addDays','empName','dayIndex','stripTime','getRotationAnchorFor','baseShift','getOrderedEmployeeIds','getActiveStaff','isEmployeeActiveOnDate','shiftKey','dateInRange','getScheduleRange','findChainAssignment','calculatedShift','getShiftForDate','effectiveShift','isRoutineWorker','isActiveProtection','isProtectedOn','findByBaseShift','substituteNote','buildChain','protectCountInMonth','protectionRequestError','getDefaultApprovalLines','normalizeApprovalLines','getApprovalLines','monthlySnapshot'];
function seed(){return {
  employees:['a','b','c','d','new'].map((id,i)=>({id,name:id,phase:i%4,startDate:'2026-01-01'})),
  approvers:[],requests:[],protects:[],approvals:[],excuses:[],settings:{quotaMax:3,notes:'비고'},
  rotationAnchors:[],scheduleRanges:[],scheduleOverrides:{},scheduleSnapshots:{},employeeOrderHistory:[],monthlyApprovals:{},versions:[]
};}
function browser(state,today){
  const c=vm.createContext({STATE:structuredClone(state),EMPLOYEES:state.employees,Date,ROUTINE_HEADCOUNT:4,CYCLE:['일','야','조','O'],ANCHOR:new Date(2026,7,1),DEFAULT_STATION_NAME:'통합관제실',getToday:()=>new Date(today+'T00:00:00'),isPastDate:d=>d<new Date(today+'T00:00:00')});
  vm.runInContext(names.map(source).join('\n'),c);return c;
}
const plain=x=>JSON.parse(JSON.stringify(x));
test('서버 계산은 수동 근무·적응기간·로테이션·월별 순서·과거 스냅샷까지 화면과 일치한다',()=>{
  const state=seed();
  state.employees[4].startDate='2028-02-15';state.employees[3].endDate='2028-02-20';
  state.employeeOrderHistory=[{month:'2028-02',order:['b','a','new','c','d']}];
  state.rotationAnchors=[{id:'anchor',empId:'new',startDate:'2028-02-18',startShift:'야',at:'2028-01-01'}];
  state.scheduleOverrides={'2028-02-15::new':{shift:'일',at:'2027-12-01'},'2028-02-16::new':{shift:'일',at:'2027-12-01'}};
  state.scheduleRanges=[{id:'range',empId:'b',startDate:'2028-02-10',endDate:'2028-02-12',value:'교육'}];
  state.scheduleSnapshots={'2028-02-01::a':'출장'};
  state.requests=[{id:'old',empId:'a',status:'confirmed',submittedAt:'2028-01-01',chain:[{empId:'a',date:'2028-02-03',shift:'휴가',label:'휴가'}]}];
  const today='2028-02-02',model=createScheduleModel(state,today),client=browser(state,today);
  for(const key of ['2028-01','2028-02','2028-03'])assert.deepEqual(model.monthlySnapshot(key),plain(client.monthlySnapshot(key)));
  for(let d=2;d<=29;d++)for(const e of state.employees)for(const type of ['day','set']){
    const date=new Date(2028,1,d);
    assert.deepEqual(model.buildChain(e.id,type,date),plain(client.buildChain(e.id,type,date)));
  }
});
test('수동으로 지정한 야·조 세트와 월 경계 2차 대근이 서버 검증을 통과한다',()=>{
  const state=seed();state.employees=state.employees.slice(0,4);
  const shifts={a:['야','조'],b:['O','일'],c:['일','O'],d:['조','야']};
  for(const [id,pair] of Object.entries(shifts))pair.forEach((shift,i)=>{state.scheduleOverrides[(i?'2099-02-01':'2099-01-31')+'::'+id]={shift,at:'2020-01-01T00:00:00.000Z'};});
  const model=createScheduleModel(state),chain=model.buildChain('a','set',new Date('2099-01-31T00:00:00')).chain;
  assert.equal(chain.length,5);assert.equal(chain[4].empId,'c');assert.equal(chain[4].shift,'대일');
  const next=structuredClone(state);next.requests.push({id:'leave',empId:'a',type:'set',startDate:'2099-01-31',chain,submittedAt:new Date().toISOString(),status:'confirmed'});
  assert.doesNotThrow(()=>validateSave(state,next,false,'a'));
  for(const change of [s=>{s.protects=[{id:'off',empId:'b',date:'2099-02-01',status:'approved'}];},s=>{s.employees[1].endDate='2099-01-31';},s=>{s.scheduleOverrides['2099-02-01::c'].shift='교육';}]){
    const bad=structuredClone(state);change(bad);const submitted={...bad,requests:next.requests};assert.throws(()=>validateSave(bad,submitted,false,'a'));
  }
});
test('잘못된 날짜·지난 날짜와 중복 신청은 차단하고 취소된 신청 기록은 유지한다',()=>{
  assert.equal(validDate('2099-02-30'),false);assert.equal(validDate('2028-02-29'),true);
  assert.equal(koreaToday(new Date('2026-10-27T16:00:00Z')),'2026-10-28');
  const state=seed(),model=createScheduleModel(state);
  assert.ok(model.buildChain('a','day',new Date('2020-01-01T00:00:00')).error);
  state.requests=[{id:'cancelled',empId:'a',status:'cancelled',chain:[]}];
  const next=structuredClone(state);next.settings.quotaMax=2;
  assert.deepEqual(validateSave(state,next,true).requests,state.requests);
});
test('직원 순서 필드 없는 기존 DB를 읽어 빈 목록으로 정규화해도 저장된다',()=>{
  const old=seed();delete old.employeeOrderHistory;
  assert.doesNotThrow(()=>validateSave(old,{...old,employeeOrderHistory:[]},false,'a'));
});
test('기존 휴가 순서를 바꿔 적용 우선순위를 조작할 수 없다',()=>{
  const old=seed();old.requests=[{id:'one',status:'cancelled',chain:[]},{id:'two',status:'confirmed',chain:[]}];
  assert.throws(()=>validateSave(old,{...old,requests:[...old.requests].reverse()},false,'a'),/순서/);
});
