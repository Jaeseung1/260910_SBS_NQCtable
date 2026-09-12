// SQLite 저장소. Node.js 내장 node:sqlite 모듈을 사용해 별도 네이티브 빌드 없이 동작한다.
// (Node 22.5+ 필요. package.json의 engines 참고)
//
// Phase 1 범위: 근무표 전체 상태(STATE)를 JSON 하나로 kv_store에 저장/조회한다.
// 이는 기존 localStorage(ncq_schedule_v1)를 그대로 서버로 옮긴 것과 같아서,
// index.html의 기존 로직(2000줄 이상)을 건드리지 않고도 여러 브라우저가 같은
// 데이터를 공유하게 해준다. approvers/approvals 같은 정규화된 테이블은
// Phase 2에서 추가한다.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'geunmupyo.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const STATE_KEY = 'schedule_state';

function getState() {
  const row = db.prepare('SELECT value, updated_at FROM kv_store WHERE key = ?').get(STATE_KEY);
  if (!row) return null;
  try {
    return { state: JSON.parse(row.value), updatedAt: row.updated_at };
  } catch (e) {
    // A damaged DB must not be mistaken for an empty, newly initialized store.
    throw new Error('저장된 근무표 JSON을 읽을 수 없습니다.', { cause: e });
  }
}

const upsertStmt = db.prepare(`
  INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

function setState(stateObj) {
  const updatedAt = new Date().toISOString();
  upsertStmt.run(STATE_KEY, JSON.stringify(stateObj), updatedAt);
  return updatedAt;
}

module.exports = { db, getState, setState };
