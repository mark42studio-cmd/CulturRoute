import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  console.log('🚀 [Telegram Bot] API 路由被觸發！');

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.log('⚠️ [Telegram Bot] 缺少 Token 或 Chat ID，靜默跳過發送。');
    return NextResponse.json({ success: false, message: 'Credentials missing' });
  }

  try {
    const body = await request.json();
    const { title, location, raw_date, comments } = body;

    const message = `
🔔 <b>【CulturRoute 有新活動投件！】</b>

📌 <b>活動名稱：</b> ${title}
📍 <b>活動地點：</b> ${location}
📅 <b>活動時間：</b> ${raw_date}
📝 <b>備註摘要：</b> ${comments || '無'}
`;

    console.log('📤 [Telegram Bot] 正在發送請求...');
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }),
    });

    const resData = await response.json();
    console.log(`📩 [Telegram Bot] 回傳狀態: ${response.status}`);

    return NextResponse.json({ success: response.ok, data: resData });
  } catch (error) {
    console.error('❌ [Telegram Bot] 後端發送出錯:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
