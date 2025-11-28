// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');

const app = express();

// Middleware
app.use(cors({ origin: true }));
app.use(express.json());

// Env
const {
  MONGODB_URI,
  PORT = 3000,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_GROUP_ID
} = process.env;

// ===== MongoDB connect =====
mongoose
  .connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 })
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ MongoDB connect error:', err));

// ===== Schema & Model =====
const itemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true }, // 例: "食品" / "日用品"
    quantity: { type: Number, required: true, min: 0 },     // 現在残数
    lastUpdated: { type: Date, default: () => new Date() }, // 最終更新日時
    consumptionRate: { type: Number, default: 0 },          // 1日あたりの消費数（推定）
    estimatedDaysLeft: { type: Number, default: null },     // 残り日数（小数あり）
    history: [
      { change: { type: Number, required: true }, timestamp: { type: Date, required: true } }
    ],
    url: { type: String, default: "" }   // 商品リンクを追加
  },
  { timestamps: true }
);

const Item = mongoose.model('Item', itemSchema);

// ===== Helpers =====
function calcDaysBetween(prevDate, currentDate) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.max((currentDate - prevDate) / msPerDay, 0); // 負は0
}

function computeRateAndEtaAfterDecrease(item, change, now) {
  const absConsumed = Math.abs(change);
  const prev = item.history?.length
    ? item.history[item.history.length - 1].timestamp
    : item.lastUpdated || now;

  let daysElapsed = calcDaysBetween(prev, now);
  if (daysElapsed < 1) daysElapsed = 1;

  const rate = absConsumed / daysElapsed;
  const smoothedRate =
    item.consumptionRate > 0 ? item.consumptionRate * 0.5 + rate * 0.5 : rate;

  const eta = smoothedRate > 0 ? item.quantity / smoothedRate : null;
  return { rate: smoothedRate, eta };
}

// ===== LINE Messaging API push =====
async function sendLineNotification(items, category = null) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_GROUP_ID) {
    console.log('LINE env not set, skip notification');
    return;
  }

  let targets = items.filter(i => i.estimatedDaysLeft != null && i.estimatedDaysLeft <= 3);
  if (category) targets = targets.filter(i => i.category === category);

  if (targets.length === 0) {
    console.log('No items need notification');
    return;
  }

  const lines = targets.map(i => {
    const eta = Number(i.estimatedDaysLeft).toFixed(1);
    return `⏳ ${i.name}（${i.category}）：残り約 ${eta} 日${i.url ? `\n👉 購入リンク: ${i.url}` : ""}`;
  });

  const message = `🛎️ 消耗品通知\n${lines.join('\n')}`;

  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: LINE_GROUP_ID, messages: [{ type: 'text', text: message }] }, // ← 修正
      { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
    console.log('📲 LINE push sent');
  } catch (err) {
    console.error('❌ LINE push error:', err?.response?.data || err.message);
  }
}

// ===== Routes =====

// 健康チェック
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'consumables-backend' });
});

// カテゴリー一覧
app.get('/categories', async (_req, res) => {
  try {
    const categories = await Item.distinct('category');
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// アイテム一覧（残数昇順）
app.get('/items', async (req, res) => {
  try {
    const { category } = req.query;
    const filter = category ? { category } : {};
    const items = await Item.find(filter).lean();
    items.sort((a, b) => a.quantity - b.quantity);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

// 新規追加
app.post('/items', async (req, res) => {
  try {
    const { name, quantity, category, url } = req.body;
    if (!name || category == null || quantity == null) {
      return res.status(400).json({ error: 'name, quantity, category are required' });
    }
    const now = new Date();

    const item = await Item.create({
      name: String(name).trim(),
      quantity: Math.max(Number(quantity), 0),
      category: String(category).trim(),
      lastUpdated: now,
      consumptionRate: 0,
      estimatedDaysLeft: null,
      history: [],
      url: url || ""
    });

    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create item' });
  }
});

// 一般更新
app.put('/items/:id', async (req, res) => {
  try {
    const { name, category, url } = req.body;
    const updates = {};
    if (name != null) updates.name = String(name).trim();
    if (category != null) updates.category = String(category).trim();
    if (url != null) updates.url = String(url).trim();
    updates.lastUpdated = new Date();

    const item = await Item.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// 削除
app.delete('/items/:id', async (req, res) => {
  try {
    const del = await Item.findByIdAndDelete(req.params.id);
    if (!del) return res.status(404).json({ error: 'Item not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// 数量更新
app.put('/items/:id/quantity', async (req, res) => {
  try {
    let { change, timestamp } = req.body;
    if (change == null) return res.status(400).json({ error: 'change is required' });
    change = Number(change);
    if (Number.isNaN(change)) return res.status(400).json({ error: 'change must be a number' });

    const now = timestamp ? new Date(timestamp) : new Date();
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    item.quantity = Math.max(item.quantity + change, 0);
    item.lastUpdated = now;
    item.history.push({ change, timestamp: now });

    if (change < 0) {
      const { rate, eta } = computeRateAndEtaAfterDecrease(item, change, now);
      item.consumptionRate = rate;
      item.estimatedDaysLeft = eta;
    } else {
      item.estimatedDaysLeft =
        item.consumptionRate > 0 ? item.quantity / item.consumptionRate : null;
    }

    const saved = await item.save();
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update quantity' });
  }
});

// 手動通知
app.post('/notify', async (req, res) => {
  try {
    const { category } = req.body;
    const items = await Item.find({}).lean();
    await sendLineNotification(items, category);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// ===== Cron: 毎日12:00に残数1以下を通知 =====
cron.schedule('00 3 * * *', async () => {
  try {
    const items = await Item.find({}).lean();
    const targets = items.filter(i => i.quantity <= 1);

    if (targets.length === 0) {
      console.log("No items with quantity <= 1");
      return;
    }

    const lines = targets.map(i =>
      `❌ ${i.name}（${i.category}）：残数 ${i.quantity}${i.url ? `\n👉 購入リンク: ${i.url}` : ""}`
    );

    const message = `🛎️ 消耗品通知（残数1以下）\n${lines.join('\n')}\n\n👉 アプリはこちらから：\nhttps://family-consumables-frontend.onrender.com/`;

    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: LINE_GROUP_ID, messages: [{ type: 'text', text: message }] }, // ← 修正
      { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );

    console.log("📲 LINE push sent (12:00 auto)");
  } catch (err) {
    console.error("❌ Auto notify error:", err?.response?.data || err.message);
  }
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});