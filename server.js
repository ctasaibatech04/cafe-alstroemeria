require('dotenv').config();
const express = require('express');
const path = require('path');
const { Resend } = require('resend');

const app = express();
const PORT = 3000;
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/reserve', async (req, res) => {
  const { name, count, date, time } = req.body;
  console.log(`予約受付: 名前=${name} 人数=${count} 日にち=${date} 時間=${time}`);

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

app.listen(PORT, () => {
  console.log(`サーバーを起動しました: http://localhost:${PORT}`);
});
