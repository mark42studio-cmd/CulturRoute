import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.log('⚠️ [Telegram Bot] 缺少環境變數設定，拒絕發送。');
    return NextResponse.json({ success: false, message: 'Credentials missing' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { type, title, location, raw_date, comments, issue_type, description } = body;

    let message = '';

    if (type === 'repair') {
      message = `
🛠️ <b>【CulturRoute 平台有新報修通報！】</b>

📌 <b>報修項目/活動：</b> ${title || '未提供'}
⚠️ <b>問題類型：</b> ${issue_type || '未分類'}
📝 <b>狀況詳細說明：</b> ${description || '無詳細說明'}
`;
    } else {
      message = `
🔔 <b>【CulturRoute 有新活動投件！】</b>

📌 <b>活動名稱：</b> ${title}
📍 <b>活動地點：</b> ${location}
📅 <b>活動時間：</b> ${raw_date}
📝 <b>備註摘要：</b> ${comments || '無'}
`;
    }

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
    return NextResponse.json({ success: response.ok, data: resData }, { status: response.ok ? 200 : 400 });
  } catch (error) {
    console.error('❌ [Telegram Bot] 後端發送出錯:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
