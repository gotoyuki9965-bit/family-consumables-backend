const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const mongoose = require("mongoose");

const app = express();
const PORT = process.env.PORT || 5000;

// 環境変数からLINEチャネルアクセストークンとMongoDB URIを取得
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const MONGO_URI = process.env.MONGO_URI;

// Webhookログで取得したグループIDをここに設定
const GROUP_ID = "Cbb622c8f631b41b84eb6217977e6dd48";

app.use(cors());
app.use(express.json());

// ===== MongoDB接続 =====
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log("✅ MongoDB接続成功"))
.catch(err => console.error("❌ MongoDB接続エラー:", err));

// ===== スキーマ & モデル =====
const itemSchema = new mongoose.Schema({
  name: String,
  days: Number,
  category: String,
});
const Item = mongoose.model("Item", itemSchema);

// ===== Webhookエンドポイント =====
app.post("/webhook", (req, res) => {
  console.log("Webhookイベント:", JSON.stringify(req.body, null, 2));
  res.sendStatus(200); // LINEに「受け取ったよ」と返す
});

// ===== 通知API（フロントから呼び出し） =====
app.post("/notify", async (req, res) => {
  const { category } = req.body;

  const items = await Item.find();

  const summary = items
    .map((item) =>
      item.days === 0
        ? `${item.name}：在庫切れ`
        : `${item.name}：あと${item.days}日`
    )
    .join("\n");

  const subject =
    items.length > 1
      ? `${items[0].name}ほか${items.length - 1}件`
      : items[0]?.name || "アイテムなし";

  const message = `🛎️ 消耗品通知\nカテゴリー「${category}」\n${subject}\n\n${summary}`;

  await sendLine(message);
  res.json({ success: true, message });
});

// ===== 毎日17:00に通知 =====
cron.schedule("0 17 * * *", async () => {
  console.log("⏰ 毎日17:00に通知を送信します");
  await sendLine("⏰ 毎日17:00の定期通知です");
});

// ===== LINE送信関数 =====
async function sendLine(message) {
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/push",
      {
        to: GROUP_ID,
        messages: [{ type: "text", text: message }],
      },
      {
        headers: {
          Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("📲 グループ通知送信完了");
  } catch (err) {
    console.error("❌ LINE通知エラー:", err.response?.data || err.message);
  }
}

// ===== APIエンドポイント =====
// 動作確認用
app.get("/", (req, res) => {
  res.send("Backend is running ✅");
});

// アイテム一覧
app.get("/items", async (req, res) => {
  const items = await Item.find();
  res.json(items);
});

// アイテム追加
app.post("/items", async (req, res) => {
  const newItem = new Item(req.body);
  await newItem.save();
  res.json(newItem);
});

// アイテム更新
app.put("/items/:id", async (req, res) => {
  const updated = await Item.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(updated);
});

// アイテム削除
app.delete("/items/:id", async (req, res) => {
  await Item.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ===== サーバー起動 =====
app.listen(PORT, () => {
  console.log(`通知サーバー起動中 http://localhost:${PORT}`);
});