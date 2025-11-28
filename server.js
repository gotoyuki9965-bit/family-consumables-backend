// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Env
const {
  MONGODB_URI,
  PORT = 3000,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_USER_ID // 送信先ユーザーID（Messaging APIのpush用）
} = process.env;

// MongoDB connect
mongoose
  .connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 })
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connect error:', err));

// Schema
const itemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, required: true }, // 例: "食品" / "日用品"
  quantity: { type: Number, required: true, min: 0 }, // 現在残数
  lastUpdated: { type: Date, default: () => new Date() }, // 最終更新日時
  consumptionRate: { type: Number, default: 0 }, // 1日あたりの消費数
  estimatedDaysLeft: { type: Number, default: null }, // 残り日数（小数あり）
  history: [
    {
      change: { type: Number, required: true }, // +購入 / -消費
      timestamp: { type: Date, required: true }
    }
  ]
}, { timestamps: true });

const Item = mongoose.model('Item', itemSchema);

// Helpers
function calcDaysBetween(prevDate, currentDate) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.max( (currentDate - prevDate) / msPerDay, 0 ); // 負は0
}

function formatDays(n) {
  if (n == null) return '-';
  // 小数1桁で表示しやすく
  return Number(n).toFixed(1);
}

function computeRateAndEtaAfterDecrease(item, change, now) {
  // changeは負数（消費）
  const absConsumed = Math.abs(change);

  // 基準となる前回更新日時（最後のhistoryがあればそれ、なければlastUpdated）
  const prev = item.history?.length
    ? item.history[item.history.length - 1].timestamp
    : item.lastUpdated || now;

  let daysElapsed = calcDaysBetween(prev, now);
  if (daysElapsed < 1) {
    // 同日更新等で0除算を避けるための最小日数
    daysElapsed = 1;
  }

  const rate = absConsumed / daysElapsed; // 1日あたりの消費量
  // 既存のrateとの平滑化（任意）：直近を優先しつつ、急変をなだらかに
  const smoothedRate = item.consumptionRate > 0
    ? (item.consumptionRate * 0.5 + rate * 0.5)
    : rate;

  const eta = smoothedRate > 0 ? item.quantity / smoothedRate : null;

  return { rate: smoothedRate, eta };
}

function colorByEta(eta) {
  if (eta == null) return 'blue';
  if (eta <= 0) return 'red';
  if (eta <= 3) return 'orange';
  return 'blue';
}

// LINE Messaging API push
async function sendLineNotification(items) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_USER_ID) {
    console.log('LINE env not set, skip notification');
    return;
  }

  // 対象（残り3日以内）
  const targets = items.filter(i => i.estimatedDaysLeft != null && i.estimatedDaysLeft <= 3);

  if (targets.length === 0) {
    console.log('No items need notification');
    return;
  }

  const lines = targets.map(i => {
    const eta = Number(i.estimatedDaysLeft).toFixed(1);
    const color = colorByEta(i.estimatedDaysLeft);
    const emoji =
      color === 'red' ? '❌' :
      color === 'orange' ? '⏳' : '✅';
    return `${emoji} ${i.name}（${i.category}）：残り約 ${eta} 日`;
  });

  const message = `今日の消耗品状況（残り3日以内）：\n` + lines.join('\n');

  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      {
        to: LINE_USER_ID,
        messages: [{ type: 'text', text: message }]
      },
      { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
    console.log('LINE push sent');
  } catch (err) {
    console.error('LINE push error:', err?.response?.data || err.message);
  }
}

// Routes

// GET items（残量が少ない順で並べ替え、カテゴリー絞り込み）
app.get('/items', async (req, res) => {
  try {
    const { category } = req.query;
    const filter = category ? { category } : {};
    const items = await Item.find(filter).lean();

    // 残量少ない順：ETAがあるものをETA昇順、ETAなしは末尾
    const withEta = [];
    const noEta = [];
    for (const i of items) {
      if (i.estimatedDaysLeft == null) noEta.push(i);
      else withEta.push(i);
    }
    withEta.sort((a, b) => a.estimatedDaysLeft - b.estimatedDaysLeft);

    res.json([...withEta, ...noEta]);
  } catch (err) {
    console.error('GET /items error', err);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

// POST item（新規追加：名前・個数・カテゴリー）
app.post('/items', async (req, res) => {
  try {
    const { name, quantity, category } = req.body;
    if (!name || category == null || quantity == null) {
      return res.status(400).json({ error: 'name, quantity, category are required' });
    }
    const now = new Date();

    const item = await Item.create({
      name,
      quantity: Math.max(Number(quantity), 0),
      category,
      lastUpdated: now,
      consumptionRate: 0,
      estimatedDaysLeft: null,
      history: []
    });

    res.status(201).json(item);
  } catch (err) {
    console.error('POST /items error', err);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

// PUT item（一般更新：名前・カテゴリー変更など）
app.put('/items/:id', async (req, res) => {
  try {
    const { name, category } = req.body;
    const updates = {};
    if (name != null) updates.name = name;
    if (category != null) updates.category = category;
    updates.lastUpdated = new Date();

    const item = await Item.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
  } catch (err) {
    console.error('PUT /items/:id error', err);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// DELETE item（削除）
app.delete('/items/:id', async (req, res) => {
  try {
    const del = await Item.findByIdAndDelete(req.params.id);
    if (!del) return res.status(404).json({ error: 'Item not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /items/:id error', err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// PUT quantity（＋／－で在庫更新＆消耗スピード・残り日数計算）
app.put('/items/:id/quantity', async (req, res) => {
  try {
    let { change, timestamp } = req.body;
    if (change == null) {
      return res.status(400).json({ error: 'change is required (e.g., +2 or -1)' });
    }
    change = Number(change);
    const now = timestamp ? new Date(timestamp) : new Date();

    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // 更新
    item.quantity = Math.max(item.quantity + change, 0);
    item.lastUpdated = now;
    item.history.push({ change, timestamp: now });

    // 消費時のみ、レート・ETAを更新
    if (change < 0) {
      const { rate, eta } = computeRateAndEtaAfterDecrease(item, change, now);
      item.consumptionRate = rate;
      item.estimatedDaysLeft = eta;
    } else {
      // 購入時：レートは維持、ETAは再計算（在庫が増えた分だけ延長）
      if (item.consumptionRate > 0) {
        item.estimatedDaysLeft = item.quantity / item.consumptionRate;
      } else {
        item.estimatedDaysLeft = null;
      }
    }

    const saved = await item.save();
    res.json(saved);
  } catch (err) {
    console.error('PUT /items/:id/quantity error', err);
    res.status(500).json({ error: 'Failed to update quantity' });
  }
});

// POST notify（18時通知の手動トリガー or スケジュール実行用）
app.post('/notify', async (req, res) => {
  try {
    const items = await Item.find({}).lean();
    await sendLineNotification(items);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /notify error', err);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'consumables-backend' });
});

// Start
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});