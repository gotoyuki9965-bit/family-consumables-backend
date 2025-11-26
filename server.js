const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 5000;

// 環境変数からLINEチャネルアクセストークンを取得
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

app.use(cors());
app.use(express.json());

// 仮データ（あとでDBに置き換え可能）
let items = [
  { name: "牛乳", days: 0 },
  { name: "バター", days: 2 },
  { name: "歯磨き粉", days: 5 },
];

// Webhookエンドポイント
app.post("/webhook", (req, res) => {
  console.log("Webhookイベント:", JSON.stringify(req.body, null, 2));
  res.sendStatus(200); // LINEに「受け取ったよ」と返す
});

// 通知API（フロントから呼び出し）
app.post("/notify", async (req, res) => {
  const { category } = req.body;

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
      : items[0].name;

  const message = `🛎️ 消耗品通知\nカテゴリー「${category}」\n${subject}\n\n${summary}`;

  // LINE送信
  await sendLine(message);

  res.json({ success: true, message });
});

// 毎日17:00に通知（テスト用）
cron.schedule("0 17 * * *", () => {
  console.log("⏰ 毎日17:00に通知を送信します");
});

// LINE送信関数
async function sendLine(message) {
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/push",
      {
        // TODO: Webhookイベントから取得した userId / groupId に差し替える
        to: "U38d7b8626a9bf23e45f487d9aa3995f0",
        messages: [{ type: "text", text: message }],
      },
      {
        headers: {
          Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("📲 LINE通知送信完了");
  } catch (err) {
    console.error("❌ LINE通知エラー:", err.response?.data || err.message);
  }
}

app.listen(PORT, () => {
  console.log(`通知サーバー起動中 http://localhost:${PORT}`);
});