// Amblox 서버: 로그인/회원가입, 친구, 상점, 퀴즈, 온라인 게임 방
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const db = require('./server/db');
const quiz = require('./server/quiz');
const rooms = require('./server/rooms');
const DEFS = require('./public/shared/defs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
rooms.init(io);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ───────── 접속 중인 사람 관리 ─────────
const online = new Map(); // userId -> Set(socketId)
function isOnline(id) { return online.has(id); }
function pushToUser(id, ev, data) {
  const set = online.get(id);
  if (set) for (const sid of set) io.to(sid).emit(ev, data);
}
function pushMe(u) { pushToUser(u.id, 'me', db.publicMe(u)); }
function friendView(u) {
  return u.friends.map((fid) => {
    const f = db.getUser(fid);
    if (!f) return null;
    return { id: f.id, nick: f.nick, color: f.color, online: isOnline(f.id), playing: rooms.statusOf(f.id) };
  }).filter(Boolean);
}
function pushFriends(u) {
  pushToUser(u.id, 'friends', {
    friends: friendView(u),
    requests: u.requests.map((rid) => { const r = db.getUser(rid); return r ? { id: r.id, nick: r.nick } : null; }).filter(Boolean),
  });
}
function notifyFriendsOf(u) { for (const fid of u.friends) { const f = db.getUser(fid); if (f) pushFriends(f); } }

// ───────── 로그인 / 회원가입 ─────────
function auth(req, res, next) {
  const u = db.userByToken(req.headers['x-token']);
  if (!u) return res.status(401).json({ error: '다시 로그인 해주세요' });
  req.user = u;
  next();
}

app.post('/api/signup', (req, res) => {
  const { id, password, nick } = req.body || {};
  if (!/^[a-zA-Z0-9_]{4,24}$/.test(id || '')) return res.json({ error: '아이디는 영어/숫자 4~24글자로 만들어 주세요' });
  if (!password || password.length < 4) return res.json({ error: '비밀번호는 4글자 이상이어야 해요' });
  const n = String(nick || '').trim();
  if (n.length < 1 || n.length > 10) return res.json({ error: '닉네임은 1~10글자로 해주세요' });
  const u = db.createUser(id, password, n);
  if (!u) return res.json({ error: '이미 있는 아이디예요' });
  res.json({ token: db.createSession(u.id), me: db.publicMe(u) });
});

app.post('/api/login', (req, res) => {
  const { id, password } = req.body || {};
  const u = db.checkLogin(id, password || '');
  if (!u) return res.json({ error: '아이디 또는 비밀번호가 틀렸어요' });
  res.json({ token: db.createSession(u.id), me: db.publicMe(u) });
});

app.post('/api/logout', (req, res) => { db.deleteSession(req.headers['x-token']); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ me: db.publicMe(req.user) }));

app.post('/api/color', auth, (req, res) => {
  const i = (db.COLORS.indexOf(req.user.color) + 1) % db.COLORS.length;
  req.user.color = db.COLORS[i];
  db.save();
  pushMe(req.user);
  res.json({ ok: true });
});

// ───────── 상점 ─────────
app.post('/api/shop/buy', auth, (req, res) => {
  const { cat, item } = req.body || {};
  const table = cat === 'tower' ? DEFS.TOWER_WEAPONS : cat === 'rivals' ? DEFS.RIVAL_WEAPONS : null;
  const w = table && table[item];
  if (!w) return res.json({ error: '없는 물건이에요' });
  const u = req.user;
  if (u.weapons[cat].includes(item)) return res.json({ error: '이미 가지고 있어요' });
  if (u.ambox < w.price) return res.json({ error: `Ambox가 ${w.price - u.ambox}개 더 필요해요` });
  u.ambox -= w.price;
  u.weapons[cat].push(item);
  db.save();
  pushMe(u);
  res.json({ ok: true, me: db.publicMe(u) });
});

// ───────── 친구 (아이디로 추가) ─────────
app.post('/api/friends/request', auth, (req, res) => {
  const u = req.user;
  const t = db.getUser(req.body && req.body.id);
  if (!t) return res.json({ error: '그런 아이디는 없어요' });
  if (t.id === u.id) return res.json({ error: '나 자신은 친구로 추가할 수 없어요' });
  if (u.friends.includes(t.id)) return res.json({ error: '이미 친구예요' });
  if (u.requests.includes(t.id)) { // 상대가 먼저 신청했으면 바로 친구!
    u.requests = u.requests.filter((x) => x !== t.id);
    u.friends.push(t.id); t.friends.push(u.id);
    db.save(); pushFriends(u); pushFriends(t);
    return res.json({ ok: true, msg: `${t.nick} 님과 친구가 되었어요!` });
  }
  if (!t.requests.includes(u.id)) t.requests.push(u.id);
  db.save(); pushFriends(t);
  pushToUser(t.id, 'toast', `${u.nick}(${u.id}) 님이 친구 신청을 보냈어요!`);
  res.json({ ok: true, msg: '친구 신청을 보냈어요!' });
});

app.post('/api/friends/respond', auth, (req, res) => {
  const u = req.user;
  const { id, accept } = req.body || {};
  const t = db.getUser(id);
  u.requests = u.requests.filter((x) => x !== (id || '').toLowerCase());
  if (t && accept && !u.friends.includes(t.id)) {
    u.friends.push(t.id);
    if (!t.friends.includes(u.id)) t.friends.push(u.id);
    pushFriends(t);
    pushToUser(t.id, 'toast', `${u.nick} 님이 친구 신청을 받았어요!`);
  }
  db.save(); pushFriends(u);
  res.json({ ok: true });
});

app.post('/api/friends/remove', auth, (req, res) => {
  const u = req.user;
  const t = db.getUser(req.body && req.body.id);
  if (t) { t.friends = t.friends.filter((x) => x !== u.id); pushFriends(t); }
  u.friends = u.friends.filter((x) => x !== (req.body.id || '').toLowerCase());
  db.save(); pushFriends(u);
  res.json({ ok: true });
});

// ───────── 이벤트 (관리자만 열고 닫을 수 있어요) ─────────
function adminOnly(req, res, next) {
  if (!db.isAdmin(req.user)) return res.status(403).json({ error: '관리자만 이벤트를 열 수 있어요' });
  next();
}
function ownerOnly(req, res, next) {
  if (!db.isOwner(req.user)) return res.status(403).json({ error: '주인 관리자만 공동 관리자를 정할 수 있어요' });
  next();
}

// 관리자 목록 (관리자라면 누구나 볼 수 있어요)
function adminList() {
  const view = (id, role) => { const x = db.getUser(id); return { id, nick: x ? x.nick : '(아직 가입 안 함)', role }; };
  return [...db.ownerIds().map((id) => view(id, 'owner')), ...db.coAdminIds().map((id) => view(id, 'co'))];
}
app.get('/api/admin/admins', auth, adminOnly, (req, res) => res.json({ admins: adminList() }));

app.post('/api/admin/admins', auth, ownerOnly, (req, res) => {
  const t = db.getUser(req.body && req.body.id);
  if (!t) return res.json({ error: '그런 아이디는 없어요 (먼저 회원가입해야 해요)' });
  if (db.isAdmin(t)) return res.json({ error: '이미 관리자예요' });
  db.addCoAdmin(t.id);
  pushMe(t);
  pushToUser(t.id, 'toast', `👑 ${req.user.nick} 님이 나를 이벤트 공동 관리자로 정했어요!`);
  res.json({ ok: true, msg: `${t.nick} 님이 공동 관리자가 되었어요!`, admins: adminList() });
});

app.post('/api/admin/admins/remove', auth, ownerOnly, (req, res) => {
  const id = String((req.body && req.body.id) || '').toLowerCase();
  db.removeCoAdmin(id);
  const t = db.getUser(id);
  if (t) pushMe(t);
  res.json({ ok: true, admins: adminList() });
});

function broadcastEvent() {
  io.emit('event', db.getEvent());
  for (const id of online.keys()) { const x = db.getUser(id); if (x) pushMe(x); }
}

app.post('/api/admin/event', auth, adminOnly, (req, res) => {
  const { key, hours, double, gift, msg } = req.body || {};
  if (!DEFS.EVENTS[key]) return res.json({ error: '없는 이벤트예요' });
  const h = Math.max(0, Math.min(24 * 31, Number(hours) || 0));
  db.setEvent({
    key, id: key + '-' + Date.now(), by: req.user.nick, start: Date.now(),
    until: h ? Date.now() + h * 3600 * 1000 : null,
    double: !!double, gift: Math.max(0, Math.min(20, Math.floor(Number(gift) || 0))),
    msg: String(msg || '').trim().slice(0, 80),
  });
  broadcastEvent();
  io.emit('toast', `${DEFS.EVENTS[key].emoji} ${DEFS.EVENTS[key].name} 이벤트가 시작됐어요! (by ${req.user.nick})`);
  res.json({ ok: true, event: db.getEvent() });
});

app.post('/api/admin/event/stop', auth, adminOnly, (req, res) => {
  db.setEvent(null);
  broadcastEvent();
  res.json({ ok: true });
});

// 이벤트 선물 받기 (이벤트마다 한 번)
app.post('/api/event/gift', auth, (req, res) => {
  const ev = db.getEvent();
  if (!ev || !ev.gift) return res.json({ error: '지금은 받을 선물이 없어요' });
  const u = req.user;
  u.gifts = u.gifts || {};
  if (u.gifts[ev.id]) return res.json({ error: '이미 선물을 받았어요' });
  u.gifts[ev.id] = true;
  u.ambox += ev.gift;
  db.save();
  pushMe(u);
  res.json({ ok: true, msg: `🎁 이벤트 선물로 Ambox ${ev.gift}개를 받았어요!` });
});

// 이벤트 시간이 끝나면 모두에게 알려주기
let lastEventId = null;
setInterval(() => {
  const ev = db.getEvent();
  const id = ev ? ev.id : null;
  if (id !== lastEventId) { lastEventId = id; broadcastEvent(); }
}, 15000);

// ───────── 실시간 연결 (Socket.io) ─────────
io.use((socket, next) => {
  const u = db.userByToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!u) return next(new Error('unauthorized'));
  socket.user = u;
  next();
});

io.on('connection', (socket) => {
  const u = socket.user;
  if (!online.has(u.id)) online.set(u.id, new Set());
  online.get(u.id).add(socket.id);
  pushMe(u); pushFriends(u); notifyFriendsOf(u);
  socket.emit('counts', rooms.counts());
  socket.emit('event', db.getEvent());

  socket.on('quiz:get', (d, cb) => {
    if (typeof cb === 'function') cb(quiz.newQuestion(u.id, d && d.purpose));
  });
  socket.on('quiz:answer', (d, cb) => {
    const r = quiz.answer(u.id, d && d.id, d && d.choice);
    if (typeof cb === 'function') cb(r);
    if (!r.ok) return;
    pushMe(u);
    if (r.earned) pushToUser(u.id, 'toast', `🎉 영어 문제 10개 정답! Ambox ${r.earned}개를 받았어요!`);
    rooms.quizResult(u.id, r.correct, r.purpose);
  });

  socket.on('room:join', (d, cb) => {
    const r = rooms.join(socket, u, d && d.game, d && d.roomId);
    if (typeof cb === 'function') cb(r);
    notifyFriendsOf(u);
  });
  socket.on('room:leave', () => { rooms.leave(socket, u.id); notifyFriendsOf(u); });
  socket.on('g', (m) => { if (m && typeof m.t === 'string') rooms.message(u.id, socket.id, m.t, m.d); });

  socket.on('disconnect', () => {
    rooms.leave(socket, u.id);
    const set = online.get(u.id);
    if (set) { set.delete(socket.id); if (set.size === 0) online.delete(u.id); }
    notifyFriendsOf(u);
  });
});

// 게임별 접속자 수를 가끔 알려주기
setInterval(() => io.emit('counts', rooms.counts()), 3000);

// 게임 모듈에서 Ambox/포켓몬 등이 바뀌었을 때 쓰는 도우미
global.AMBLOX = { pushMe, pushToUser, db };

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Amblox 서버 실행 중!  http://localhost:${PORT}`));
