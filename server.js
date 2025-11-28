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
  LINE_USER_ID
} = process.env;

// MongoDB connect
mongoose
  .connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 })
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ MongoDB connect error:', err));

// Schema
const itemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, required: true },
  quantity: { type: Number, required: true, min: 0 },
  lastUpdated: { type: Date, default: () => new Date() },
  consumptionRate: { type: Number, default: 0 },
  estimatedDaysLeft: { type: Number, default: null },
  history: [
    {
      change: { type: Number, required: true },
      timestamp: { type: Date, required: true }
    }
  ]
}, { timestamps: true });

const Item = mongoose.model('Item', itemSchema);

// Helpers
function calcDaysBetween(prevDate, currentDate) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.max((currentDate - prevDate) / msPerDay, 0);
}

function computeRateAndEtaAfterDecrease(item, change, now) {
  const absConsumed = Math.abs(change);
  const prev = item.history?.length
    ? item.history[item.history.length - 1].timestamp
    : item.lastUpdated || now;

  let daysElapsed = calcDaysBetween(prev, now);
  if (daysElapsed < 1) daysElapsed = 1;

  const rate = absConsumed / daysElapsed;
  const smoothedRate = item.consumptionRate > 0
    ? (item.consumptionRate * 0.5 + rate * 0.5)
    : rate;

  const eta = smoothedRate > 0 ? item.quantity / smoothedRate : null;
  return { rate: smoothedRate, eta };
}

// LINE通知
async function sendLineNotification(items, category = null) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_USER_ID) {
    console.log('LINE env not set, skip notification');
    return;
  }

  let targets = items.filter(i => i.estimatedDaysLeft != null && i.estimatedDaysLeft <= 3);
  if (category) {
    targets = targets.filter(i => i.category === category);
  }

  if (targets.length === 0) {
    console.log('No items need notification');
    return;
  }

  const lines = targets.map(i => {
    const eta = Number(i.estimatedDaysLeft).toFixed(1);
    const emoji = i.estimatedDaysLeft <= 0 ? '❌' : i.estimatedDaysLeft <= 3 ? '⏳' : '✅';
    return `${emoji} ${i.name}（${i.category}）：残り約 ${eta} 日`;
  });

  const message = `🛎️ 消耗品通知\n${lines.join('\n')}`;

  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: LINE_USER_ID, messages: [{ type: 'text', text: message }] },
      { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
    console.log('📲 LINE push sent');
  } catch (err) {
    console.error('❌ LINE push error:', err?.response?.data || err.message);
  }
}

// Routes
app.get('/items', async (req, res) => {
  try {
    const { category } = req.query;
    const filter = category ? { category } : {};
    const items = await Item.find(filter).lean();

    const withEta = items.filter(i => i.estimatedDaysLeft != null);
    const noEta = items.filter(i => i.estimatedDaysLeft == null);
    withEta.sort((a, b) => a.estimatedDaysLeft - b.estimatedDaysLeft);

    res.json([...withEta, ...noEta]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

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
    res.status(500).json({ error: 'Failed to create item' });
  }
});

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
    res.status(500).json({ error: 'Failed to update item' });
  }
});

app.delete('/items/:id', async (req, res) => {
  try {
    const del = await Item.findByIdAndDelete(req.params.id);
    if (!del) return res.status(404).json({ error: 'Item not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

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

    item.quantity = Math.max(item.quantity + change, 0);
    item.lastUpdated = now;
    item.history.push({ change, timestamp: now });

    if (change < 0) {
      const { rate, eta } = computeRateAndEtaAfterDecrease(item, change, now);
      item.consumptionRate = rate;
      item.estimatedDaysLeft = eta;
    } else {
      if (item.consumptionRate > 0) {
        item.estimatedDaysLeft = item.quantity / item.consumptionRate;
      } else {
        item.estimatedDaysLeft = null;
      }
    }

    const saved = await item.save();
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update quantity' });
  }
});

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

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'consumables-backend' });
});

// Start
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});