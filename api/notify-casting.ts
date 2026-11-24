export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const {
    nombre,
    apellidos,
    edad,
    estatura,
    whatsapp,
    instagram,
    talento,
    genero,
    formacionArtistica,
    nivelEnsenanza,
    website,
  } = body;

  if (typeof website === 'string' && website.trim().length > 0) {
    return res.status(200).json({ success: true });
  }

  if (!nombre || !whatsapp) {
    return res.status(400).json({ error: 'Faltan campos requeridos de la postulación.' });
  }

  const numericAge = Number(edad);
  if (!Number.isNaN(numericAge) && numericAge > 0 && numericAge < 17) {
    return res.status(400).json({ error: 'La edad mínima para postularse es de 17 años.' });
  }

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

  const fullName = `${nombre}${apellidos ? ` ${apellidos}` : ''}`;
  const tutorLine =
    numericAge === 17 ? `\n⚠️ <b>Nota:</b> Tiene 17 años (debe asistir con tutor)` : '';
  const isDancer = talento === 'bailarin';
  const headerLabel = isDancer
    ? '💃 Nuevo/a Bailarín/a — Casting Planet Talent'
    : '🎬 Nueva postulante — Casting Planet Talent';
  const dancerExtraLines = isDancer
    ? `\n🎭 <b>Talento:</b> Bailarín/a${genero ? ` (${escapeHTML(genero)})` : ''}${
        formacionArtistica ? `\n🎓 <b>Formación:</b> ${escapeHTML(formacionArtistica)}` : ''
      }${nivelEnsenanza ? `\n📚 <b>Nivel:</b> ${escapeHTML(nivelEnsenanza)}` : ''}`
    : '';

  const telegramMessage = `<b>${headerLabel}</b>

👤 <b>Nombre:</b> ${escapeHTML(fullName)}${dancerExtraLines}
🎂 <b>Edad:</b> ${escapeHTML(edad)} años
📏 <b>Estatura:</b> ${escapeHTML(estatura)} cm
📱 <b>WhatsApp:</b> ${escapeHTML(whatsapp)}
📸 <b>Instagram:</b> ${escapeHTML(instagram || 'No especificado')}${tutorLine}`;

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
      return res.status(502).json({ error: 'Failed to send Telegram casting notification' });
    }
    return res.status(200).json({ success: true });
  } catch {
    return res.status(500).json({ error: 'Failed to send casting notification' });
  }
}
