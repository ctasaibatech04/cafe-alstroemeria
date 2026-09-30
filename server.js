require('dotenv').config();
const express = require('express');
const path = require('path');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = 3000;
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(express.json());
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

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

app.get('/api/reservations', async (req, res) => {
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

app.patch('/api/reservations/:id', async (req, res) => {
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
