export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { nombre, modelos, fecha } = req.body || {};
  const telegramBotToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const telegramChatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!telegramBotToken || !telegramChatId) {
    return res.status(200).json({ success: true, skipped: true });
  }

  const escapeHTML = (str: unknown) =>
    String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const telegramMessage = `<b>🔔 Nueva solicitud de booking</b>

👤 <b>Cliente:</b> ${escapeHTML(nombre)}
📱 <b>Modelos:</b> ${escapeHTML(modelos)}
📅 <b>Fecha del evento:</b> ${escapeHTML(fecha)}

Revisa el panel de administración para más detalles`;

  try {
    const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: telegramMessage,
        parse_mode: 'HTML',
      }),
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Failed to send Telegram notification' });
    }
    return res.status(200).json({ success: true });
  } catch {
    return res.status(500).json({ error: 'Failed to send notification' });
  }
}
