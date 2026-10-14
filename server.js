require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = 3000;
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// お店のトップページ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/reserve', async (req, res) => {
  const { name, count, date, time } = req.body;
  console.log(`予約受付: 名前=${name} 人数=${count} 日にち=${date} 時間=${time}`);

  const { error: dbError } = await supabase.from('alstroemeria_reservations').insert({
    name,
    party_size: Number(count),
    reservation_date: date,
    reservation_time: time,
  });

  if (dbError) {
    console.error('予約の保存に失敗しました:', dbError);
    return res.status(500).json({ message: '予約の保存に失敗しました' });
  }

  try {
    await resend.emails.send({
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      subject: '【カフェ・アリストロメリア】新しいご予約が入りました',
      text: `新しいご予約が入りました。\n\n名前: ${name}\n人数: ${count}\n日にち: ${date}\n時間: ${time}`,
    });
  } catch (error) {
    console.error('予約メールの送信に失敗しました:', error);
  }

  res.json({ message: 'ご予約を受け付けました' });
});

// ---- 管理画面のログイン ----
const USERS = {
  // canEdit: 予約の状態や内容を変更できるか（スタッフは一覧を見るだけ）
  tencho: { label: '店長', password: process.env.TENCHO_PASSWARD, canEdit: true },
  staff: { label: 'スタッフ', password: process.env.STAFF_PASSWARD, canEdit: false },
};
const SESSION_COOKIE = 'admin_session';
const SESSION_MAX_AGE = 12 * 60 * 60 * 1000; // 12時間
// ログイン中の人を覚えておく（サーバーを再起動するとログアウトされる）
const sessions = new Map();

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function getSession(req) {
  const token = getCookie(req, SESSION_COOKIE);
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

// パスワードを比べる（かかる時間から中身を推測されないようにハッシュ同士で比べる）
function isSamePassword(input, expected) {
  if (typeof input !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireLoginPage(req, res, next) {
  if (getSession(req)) return next();
  res.redirect('/admin/login');
}

function requireLoginApi(req, res, next) {
  if (getSession(req)) return next();
  res.status(401).json({ message: 'ログインしてください' });
}

// 予約を変更できる人だけ通す（requireLoginApi の後に使う）
function requireEditApi(req, res, next) {
  if (USERS[getSession(req).id].canEdit) return next();
  res.status(403).json({ message: '予約を変更する権限がありません' });
}

app.get('/admin/login', (req, res) => {
  if (getSession(req)) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'admin', 'login.html'));
});

app.post('/admin/login', (req, res) => {
  const { id, password } = req.body || {};
  const user = typeof id === 'string' && Object.hasOwn(USERS, id) ? USERS[id] : null;
  if (!user || !isSamePassword(password, user.password)) {
    return res.redirect('/admin/login?error=1');
  }

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { id, label: user.label, expiresAt: Date.now() + SESSION_MAX_AGE });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE,
  });
  res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => {
  const token = getCookie(req, SESSION_COOKIE);
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE);
  res.redirect('/admin/login');
});

app.get('/admin', requireLoginPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

app.get('/api/me', requireLoginApi, (req, res) => {
  const { id, label } = getSession(req);
  res.json({ id, label, canEdit: USERS[id].canEdit });
});

app.get('/api/reservations', requireLoginApi, async (req, res) => {
  const { data, error } = await supabase
    .from('alstroemeria_reservations')
    .select('id, name, party_size, reservation_date, reservation_time, created_at, status')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('予約一覧の取得に失敗しました:', error);
    return res.status(500).json({ message: '予約一覧の取得に失敗しました' });
  }

  res.json(data);
});

const STATUSES = ['未確認', '確認済み', 'キャンセル'];
// お店のページの予約フォームと同じ選択肢（9:00〜17:30、30分ごと）
const TIMES = Array.from({ length: 18 }, (_, i) => `${9 + Math.floor(i / 2)}:${i % 2 ? '30' : '00'}`);

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// 送られてきた項目だけを確かめて、更新する内容を作る
function buildReservationUpdate(body) {
  const update = {};
  if ('name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 50) return { error: 'お名前は1〜50文字で入力してください' };
    update.name = name;
  }
  if ('party_size' in body) {
    const size = Number(body.party_size);
    if (!Number.isInteger(size) || size < 1 || size > 10) return { error: '人数は1〜10名で指定してください' };
    update.party_size = size;
  }
  if ('reservation_date' in body) {
    if (!isValidDate(body.reservation_date)) return { error: '予約日が正しくありません' };
    update.reservation_date = body.reservation_date;
  }
  if ('reservation_time' in body) {
    if (!TIMES.includes(body.reservation_time)) return { error: '時間が正しくありません' };
    update.reservation_time = body.reservation_time;
  }
  if ('status' in body) {
    if (!STATUSES.includes(body.status)) return { error: '状態の値が正しくありません' };
    update.status = body.status;
  }
  if (Object.keys(update).length === 0) return { error: '変更する項目がありません' };
  return { update };
}

app.patch('/api/reservations/:id', requireLoginApi, requireEditApi, async (req, res) => {
  const { update, error: inputError } = buildReservationUpdate(req.body || {});
  if (inputError) {
    return res.status(400).json({ message: inputError });
  }

  const { data, error } = await supabase
    .from('alstroemeria_reservations')
    .update(update)
    .eq('id', req.params.id)
    .select('id, name, party_size, reservation_date, reservation_time, created_at, status')
    .maybeSingle();

  if (error) {
    console.error('予約の更新に失敗しました:', error);
    return res.status(500).json({ message: '予約の更新に失敗しました' });
  }
  if (!data) {
    return res.status(404).json({ message: '予約が見つかりません' });
  }

  res.json(data);
});

app.listen(PORT, () => {
  console.log(`サーバーを起動しました: http://localhost:${PORT}`);
});
