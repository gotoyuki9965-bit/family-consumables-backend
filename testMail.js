const nodemailer = require("nodemailer");

async function main() {
  try {
    let transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "goto.yuki.9965@gmail.com",
        pass: "dnbarcvzfckjuiqw", // Gmailのアプリパスワードを必ず使う
      },
    });

    let info = await transporter.sendMail({
      from: '"テスト送信" <goto.yuki.9965@gmail.com>',
      to: "goto.yuki.9965@gmail.com",
      subject: "テストメール",
      text: "これはテスト送信です。",
    });

    console.log("📧 メール送信完了:", info.messageId);
  } catch (err) {
    console.error("❌ メール送信エラー:", err);
  }
}

main();