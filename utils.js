const { Keyboard } = require('@maxhub/max-bot-api');

// Обёртка для безопасной обработки callback'ов
function safeCallbackHandler(handler) {
  return async (ctx) => {
    try {
      await handler(ctx);
    } catch (error) {
      console.error('❌ Ошибка в обработчике callback:', error);
      await ctx.answerOnCallback({
        notification: 'Произошла ошибка. Попробуйте позже.'
      });
    }
  };
}

// Проверка, что сообщение не старое (защита от повторной обработки)
function isFreshMessage(ctx, botStartTime) {
  const timestamp = ctx.message?.timestamp || ctx.timestamp;
  if (!timestamp) return true;
  return timestamp >= (botStartTime - 10000);
}

// Создание инлайн-клавиатуры главного меню
function getMainMenuKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('🎟️ Афиша мероприятий', 'menu:afisha')],
    [Keyboard.button.callback('🎫 Мои билеты', 'menu:my_tickets')],
    [Keyboard.button.callback('📋 Помощь', 'menu:help')]
  ]);
}

module.exports = {
  safeCallbackHandler,
  isFreshMessage,
  getMainMenuKeyboard
};