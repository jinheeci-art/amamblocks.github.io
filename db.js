// 아주 간단한 JSON 파일 데이터베이스 (data/db.json)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'db.json');
let data = { users: {}, sessions: {} };

try {
  if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error('db.json 을 읽지 못했어요. 새로 시작합니다.', e.message);
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(data));
    fs.renameSync(FILE + '.tmp', FILE);
  }, 300);
}

function hash(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }

const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#9775fa', '#f783ac', '#20c997'];

function createUser(id, pw, nick) {
  id = id.toLowerCase();
  if (data.users[id]) return null;
  const salt = crypto.randomBytes(16).toString('hex');
  data.users[id] = {
    id, nick, salt, pass: hash(pw, salt),
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    ambox: 0, quizProgress: 0,
    stats: { solved: 0, correct: 0, wins: 0 },
    weapons: { tower: [], rivals: ['water'] },
    pokemon: {},
    friends: [], requests: [],
    created: Date.now(),
  };
  save();
  return data.users[id];
}

function checkLogin(id, pw) {
  const u = data.users[(id || '').toLowerCase()];
  if (!u) return null;
  const a = Buffer.from(hash(pw, u.salt), 'hex'), b = Buffer.from(u.pass, 'hex');
  return crypto.timingSafeEqual(a, b) ? u : null;
}

function createSession(id) {
  const token = crypto.randomBytes(24).toString('hex');
  data.sessions[token] = { id, t: Date.now() };
  save();
  return token;
}
function deleteSession(token) { delete data.sessions[token]; save(); }
function userByToken(token) {
  const s = token && data.sessions[token];
  return s ? data.users[s.id] || null : null;
}
function getUser(id) { return data.users[(id || '').toLowerCase()] || null; }

// ───────── 관리자 ─────────
// 주인 관리자: admins.txt (한 줄에 아이디 하나) 또는 환경 변수 ADMIN_IDS=아이디1,아이디2
//   → 이벤트를 열고, 공동 관리자를 추가/삭제할 수 있어요.
// 공동 관리자: 주인 관리자가 화면에서 아이디로 추가 (data/db.json 에 저장)
//   → 이벤트를 열고 닫을 수 있어요.
function ownerIds() {
  const ids = (process.env.ADMIN_IDS || '').split(',');
  try { ids.push(...fs.readFileSync(path.join(__dirname, '..', 'admins.txt'), 'utf8').split(/\r?\n/)); } catch (e) { /* 파일 없음 */ }
  return ids.map((x) => x.trim().toLowerCase()).filter((x) => x && !x.startsWith('#'));
}
function coAdminIds() { return data.coAdmins || (data.coAdmins = []); }
function isOwner(u) { return !!u && ownerIds().includes(u.id); }
function isAdmin(u) { return !!u && (isOwner(u) || coAdminIds().includes(u.id)); }
function addCoAdmin(id) {
  id = id.toLowerCase();
  if (!coAdminIds().includes(id)) { data.coAdmins.push(id); save(); }
}
function removeCoAdmin(id) { data.coAdmins = coAdminIds().filter((x) => x !== id.toLowerCase()); save(); }

// ───────── 이벤트 ─────────
function getEvent() {
  const ev = data.event;
  if (!ev) return null;
  if (ev.until && Date.now() > ev.until) { data.event = null; save(); return null; }
  return ev;
}
function setEvent(ev) { data.event = ev; save(); }

// 클라이언트에 보내도 되는 정보만
function publicMe(u) {
  const ev = getEvent();
  return {
    id: u.id, nick: u.nick, color: u.color, ambox: u.ambox, quizProgress: u.quizProgress,
    stats: u.stats, weapons: u.weapons, pokemon: u.pokemon,
    admin: isAdmin(u), owner: isOwner(u), giftClaimed: !!(ev && u.gifts && u.gifts[ev.id]),
  };
}

module.exports = { save, createUser, checkLogin, createSession, deleteSession, userByToken, getUser, publicMe, COLORS, isAdmin, isOwner, ownerIds, coAdminIds, addCoAdmin, removeCoAdmin, getEvent, setEvent };
