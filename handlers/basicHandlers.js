const db = require('../db');
const { getMainMenuKeyboard, isFreshMessage } = require('../utils');
const stateManager = require('../stateManager');

// /start
async function handleStartCommand(ctx) {
  if (!isFreshMessage(ctx, global.botStartTime)) return;

  const userId = ctx.user?.user_id;
  if (!userId) {
    return ctx.reply('Ошибка идентификации.');
  }

  // Проверяем, есть ли пользователь в базе
  let user = db.getUser(userId);
  if (!user) {
    // Запрашиваем ФИО
    stateManager.setUserState(userId, { step: 'waiting_full_name' });
    return ctx.reply(
      '👋 Добро пожаловать в систему мероприятий СКФУ!\n\nДля начала укажите, пожалуйста, ваше **ФИО**:',
      { format: 'markdown' }
    );
  }

  // Пользователь уже зарегистрирован – показываем главное меню
  const welcomeText = `👋 С возвращением, ${user.full_name || 'студент'}!\n\n` +
    `Выберите действие в меню ниже:`;

  return ctx.reply(welcomeText, {
    format: 'markdown',
    attachments: [getMainMenuKeyboard()]
  });
}

// Обработка текстовых сообщений для заполнения профиля
async function handleProfileInput(ctx) {
  const userId = ctx.user?.user_id;
  if (!userId || !stateManager.hasUserState(userId)) return false;

  const state = stateManager.getUserState(userId);
  const text = ctx.message?.body?.text?.trim();
  if (!text) return false;

  if (state.step === 'waiting_full_name') {
    state.full_name = text;
    state.step = 'waiting_institute';
    stateManager.setUserState(userId, state);
    return ctx.reply('📚 Укажите ваш **институт** (например, ИИТ, ИЭИ, ЮИ и т.д.):', { format: 'markdown' });
  }

  if (state.step === 'waiting_institute') {
    state.institute = text;
    state.step = 'waiting_group';
    stateManager.setUserState(userId, state);
    return ctx.reply('👥 Укажите вашу **группу** (например, ИВТ-21-1):', { format: 'markdown' });
  }

  if (state.step === 'waiting_group') {
    const group = text;
    // Сохраняем пользователя
    db.createOrUpdateUser(userId, {
      full_name: state.full_name,
      institute: state.institute,
      group_name: group
    });
    stateManager.deleteUserState(userId);

    await ctx.reply('✅ Регистрация завершена! Теперь вы можете записываться на мероприятия.', {
      format: 'markdown',
      attachments: [getMainMenuKeyboard()]
    });
  }
  return true;
}

// Обработка неизвестных команд
async function handleUnknownCommand(ctx) {
  if (!isFreshMessage(ctx, global.botStartTime)) return;
  const text = ctx.message?.body?.text;
  if (!text || text.startsWith('/')) return;

  // Если пользователь в процессе ввода профиля – обработаем там
  if (ctx.user?.user_id && stateManager.hasUserState(ctx.user.user_id)) {
    return false;
  }

  // Иначе показываем подсказку
  return ctx.reply(
    '❓ Неизвестная команда. Используйте кнопки меню или /help для списка возможностей.',
    { attachments: [getMainMenuKeyboard()] }
  );
}

// /help и callback menu:help
async function handleHelp(ctx) {
  const isCallback = !!ctx.callbackQuery;
  const helpText = `
📌 **Справка по боту СКФУ События**

**Основные команды:**
/start – Главное меню
/help – Эта справка

**Возможности:**
• Просмотр афиши мероприятий
• Регистрация на события
• Получение электронного билета с QR-кодом
• Сканирование билетов (для организаторов)
• Экспорт отчётов о посещаемости

По кнопке «Афиша» откроется мини-приложение с полным списком событий.
  `.trim();

  const keyboard = getMainMenuKeyboard();

  if (isCallback) {
    await ctx.answerOnCallback({ notification: 'Справка открыта' });
    return ctx.reply(helpText, { format: 'markdown', attachments: [keyboard] });
  } else {
    return ctx.reply(helpText, { format: 'markdown', attachments: [keyboard] });
  }
}

module.exports = {
  handleStartCommand,
  handleProfileInput,
  handleUnknownCommand,
  handleHelp
};