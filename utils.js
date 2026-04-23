const { Keyboard } = require('@maxhub/max-bot-api');

// Обёртка для безопасной обработки callback'ов
function safeCallbackHandler(handler) {
  return async (ctx) => {
    console.log('🟡 safeCallbackHandler вызван для:', ctx.match?.[0] || ctx.callbackQuery?.data || 'неизвестный action');
    try {
      await handler(ctx);
    } catch (error) {
      console.error('❌ Ошибка в обработчике callback:', error);
      await ctx.answerOnCallback({ notification: 'Произошла ошибка. Попробуйте позже.' });
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
function getMainMenuKeyboard(role) {
  const buttons = [
    [Keyboard.button.callback('🎟️ Афиша мероприятий', 'menu:afisha')],
    [Keyboard.button.callback('🎫 Мои билеты', 'menu:my_tickets')],
    [Keyboard.button.callback('👤 Профиль', 'menu:profile')],
    [Keyboard.button.callback('📋 Помощь', 'menu:help')]
  ];
  // Добавляем кнопку создания мероприятия только для admin
  if (role === 'admin') {
    buttons.splice(1, 0, [Keyboard.button.callback('📝 Создать мероприятие', 'menu:create_event')]);
  }
  return Keyboard.inlineKeyboard(buttons);
}

// Форматирование деталей мероприятия для отображения в сообщении
function formatEventDetails(event) {
  return `
🎉 **${event.title}**

📅 **Дата:** ${event.event_date}
⏰ **Время:** ${event.event_time}
📍 **Место:** ${event.location}
🏷️ **Категория:** ${event.category_name || event.category}
🏛️ **Институт:** ${event.institute_name || 'Все институты'}
👥 **Свободных мест:** ${event.available_seats} / ${event.capacity}

${event.description || ''}
  `.trim();
}

module.exports = {
  safeCallbackHandler,
  isFreshMessage,
  getMainMenuKeyboard,
  formatEventDetails
};