async function sendTicketConfirmation(bot, userId, eventTitle, qrBuffer) {
  try {
    // Сначала отправляем текстовое сообщение
    await bot.api.sendMessageToUser(
      userId,
      `✅ **Вы зарегистрированы!**\n\nМероприятие: *${eventTitle}*\n\nВаш билет во вложении.`,
      { format: 'markdown' }
    );
    // Отправляем QR-код как изображение
    await bot.api.sendPhotoToUser(userId, qrBuffer, { caption: '🎟️ QR-код билета' });
  } catch (err) {
    console.error(`Ошибка отправки билета пользователю ${userId}:`, err);
  }
}

// Здесь будут функции для напоминаний (за 24ч, за 1ч) – реализуются позже через cron

module.exports = { sendTicketConfirmation };