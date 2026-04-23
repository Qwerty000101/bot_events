const { Keyboard } = require('@maxhub/max-bot-api');
const db = require('../db');
const stateManager = require('../stateManager');
const { safeCallbackHandler, formatEventDetails, getMainMenuKeyboard } = require('../utils');

// Пагинация: 5 мероприятий на страницу
const EVENTS_PER_PAGE = 5;

// ========== ПРОСМОТР АФИШИ ==========
async function handleAfishaCommand(ctx) {
  const userId = ctx.user?.user_id;
  if (!userId) return ctx.reply('Ошибка идентификации.');

  const events = db.getEvents(); // все активные
  if (events.length === 0) {
    return ctx.reply('📭 На данный момент нет активных мероприятий.', {
      attachments: [getMainMenuKeyboard()]
    });
  }

  return showEventsPage(ctx, events, 1);
}

// Показ страницы с мероприятиями
function showEventsPage(ctx, events, page) {
  const totalPages = Math.ceil(events.length / EVENTS_PER_PAGE);
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const startIdx = (page - 1) * EVENTS_PER_PAGE;
  const pageEvents = events.slice(startIdx, startIdx + EVENTS_PER_PAGE);

  const buttons = pageEvents.map(ev => [
    Keyboard.button.callback(ev.title, `event:view:${ev.id}`)
  ]);

  // Кнопки навигации
  const navRow = [];
  if (page > 1) navRow.push(Keyboard.button.callback('⬅️ Назад', `afisha:page:${page - 1}`));
  if (page < totalPages) navRow.push(Keyboard.button.callback('Вперёд ➡️', `afisha:page:${page + 1}`));
  if (navRow.length) buttons.push(navRow);

  buttons.push([Keyboard.button.callback('🏠 Главное меню', 'menu:main')]);

  const keyboard = Keyboard.inlineKeyboard(buttons);
  const text = `📋 **Афиша мероприятий** (страница ${page}/${totalPages}):\n\n` +
    pageEvents.map((e, i) => `${i+1}. ${e.title} (${e.event_date})`).join('\n');

  // Если это callback, то редактируем сообщение, иначе отправляем новое
  if (ctx.callbackQuery) {
    return ctx.answerOnCallback({
      message: { text, attachments: [keyboard], format: 'markdown' }
    });
  } else {
    return ctx.reply(text, { attachments: [keyboard], format: 'markdown' });
  }
}

// Callback для перелистывания страниц
const handleAfishaPage = safeCallbackHandler(async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  const events = db.getEvents();
  if (events.length === 0) {
    return ctx.answerOnCallback({
      message: { text: '📭 Мероприятий нет.', attachments: [getMainMenuKeyboard()] }
    });
  }
  return showEventsPage(ctx, events, page);
});

// Просмотр деталей мероприятия
const handleEventView = safeCallbackHandler(async (ctx) => {
  const eventId = parseInt(ctx.match[1], 10);
  const event = db.getEventById(eventId);
  if (!event) {
    return ctx.answerOnCallback({ notification: 'Мероприятие не найдено' });
  }

  const text = formatEventDetails(event);
  const buttons = [];

  // Кнопка регистрации (если есть места)
  if (event.available_seats > 0) {
    buttons.push([Keyboard.button.callback('✅ Зарегистрироваться', `event:register:${event.id}`)]);
  } else {
    buttons.push([Keyboard.button.callback('🔴 Мест нет', 'event:noop', { disabled: true })]);
  }

  buttons.push([Keyboard.button.callback('🔙 Назад к списку', 'afisha:page:1')]);
  buttons.push([Keyboard.button.callback('🏠 Главное меню', 'menu:main')]);

  const keyboard = Keyboard.inlineKeyboard(buttons);
  return ctx.answerOnCallback({
    message: { text, attachments: [keyboard], format: 'markdown' }
  });
});

// Регистрация на мероприятие из бота
const handleEventRegister = safeCallbackHandler(async (ctx) => {
  const userId = ctx.user.user_id;
  const eventId = parseInt(ctx.match[1], 10);

  try {
    const { uuid, event } = db.registerForEvent(userId, eventId);
    
    // Генерируем QR-код и отправляем (потребуется qrService и notificationService)
    const { generateQRCodeBuffer } = require('../services/qrService');
    const { sendTicketConfirmation } = require('../services/notificationService');
    const qrBuffer = await generateQRCodeBuffer(uuid);
    await sendTicketConfirmation(global.botInstance, userId, event.title, qrBuffer);

    await ctx.answerOnCallback({ notification: '✅ Вы успешно зарегистрированы!' });
    // Вернуться к деталям мероприятия
    const updatedEvent = db.getEventById(eventId);
    const text = formatEventDetails(updatedEvent);
    const buttons = [[Keyboard.button.callback('🔙 Назад к списку', 'afisha:page:1')]];
    return ctx.answerOnCallback({
      message: { text, attachments: [Keyboard.inlineKeyboard(buttons)], format: 'markdown' }
    });
  } catch (err) {
    return ctx.answerOnCallback({ notification: `❌ ${err.message}` });
  }
});

// ========== СОЗДАНИЕ МЕРОПРИЯТИЯ (для организаторов) ==========
async function handleCreateEventCommand(ctx) {
  const userId = ctx.user?.user_id;
  if (!userId) return ctx.reply('Ошибка идентификации.');

  const user = db.getUser(userId);
  if (!user || (user.role !== 'admin' && user.role !== 'moderator')) {
    return ctx.reply('⛔ У вас нет прав для создания мероприятий.');
  }

  // Запускаем пошаговый ввод
  stateManager.setUserState(userId, {
    step: 'event_title',
    tempEvent: {}
  });

  return ctx.reply(
    '📝 **Создание нового мероприятия**\n\nВведите название мероприятия:',
    { format: 'markdown' }
  );
}

// Обработка текстового ввода при создании мероприятия
async function handleEventCreationInput(ctx) {
  const userId = ctx.user?.user_id;
  if (!userId || !stateManager.hasUserState(userId)) return false;

  const state = stateManager.getUserState(userId);
  if (!state.step.startsWith('event_')) return false; // не наш процесс

  const text = ctx.message?.body?.text?.trim();
  if (!text) return false;

  switch (state.step) {
    case 'event_title':
      state.tempEvent.title = text;
      state.step = 'event_description';
      stateManager.setUserState(userId, state);
      return ctx.reply('Введите описание мероприятия:', { format: 'markdown' });

    case 'event_description':
      state.tempEvent.description = text;
      state.step = 'event_category';
      stateManager.setUserState(userId, state);
      const catKeyboard = Keyboard.inlineKeyboard([
        [Keyboard.button.callback('Спорт', 'event_cat:sport')],
        [Keyboard.button.callback('Наука', 'event_cat:science')],
        [Keyboard.button.callback('Культура', 'event_cat:culture')]
      ]);
      return ctx.reply('Выберите категорию:', { attachments: [catKeyboard] });

    case 'event_location':
      state.tempEvent.location = text;
      state.step = 'event_date';
      stateManager.setUserState(userId, state);
      return ctx.reply('Введите дату в формате ГГГГ-ММ-ДД (например, 2026-05-20):', { format: 'markdown' });

    case 'event_date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return ctx.reply('❌ Неверный формат. Введите дату как ГГГГ-ММ-ДД:');
      }
      state.tempEvent.event_date = text;
      state.step = 'event_time';
      stateManager.setUserState(userId, state);
      return ctx.reply('Введите время в формате ЧЧ:ММ (например, 14:00):', { format: 'markdown' });

    case 'event_time':
      if (!/^\d{2}:\d{2}$/.test(text)) {
        return ctx.reply('❌ Неверный формат. Введите время как ЧЧ:ММ:');
      }
      state.tempEvent.event_time = text;
      state.step = 'event_capacity';
      stateManager.setUserState(userId, state);
      return ctx.reply('Введите количество мест (целое число):', { format: 'markdown' });

    case 'event_capacity':
      const capacity = parseInt(text, 10);
      if (isNaN(capacity) || capacity <= 0) {
        return ctx.reply('❌ Введите положительное число.');
      }
      state.tempEvent.capacity = capacity;
      // Все данные собраны – создаём мероприятие
      try {
        const eventData = {
          ...state.tempEvent,
          institute_filter: null,
          geo_coords: null,
          organizer_user_id: userId
        };
        const eventId = db.createEvent(eventData);
        stateManager.deleteUserState(userId);
        await ctx.reply(`✅ Мероприятие "${state.tempEvent.title}" успешно создано! (ID: ${eventId})`, {
          attachments: [getMainMenuKeyboard()]
        });
      } catch (err) {
        stateManager.deleteUserState(userId);
        await ctx.reply(`❌ Ошибка при создании: ${err.message}`);
      }
      return true;

    default:
      return false;
  }
}

// Callback для выбора категории
const handleEventCategorySelect = safeCallbackHandler(async (ctx) => {
  const userId = ctx.user.user_id;
  const state = stateManager.getUserState(userId);
  if (!state || !state.step.startsWith('event_')) {
    return ctx.answerOnCallback({ notification: 'Сессия истекла' });
  }

  const category = ctx.match[1]; // sport, science, culture
  state.tempEvent.category = category;
  state.step = 'event_location';
  stateManager.setUserState(userId, state);

  await ctx.answerOnCallback({ notification: `Категория: ${category}` });
  return ctx.reply('Введите место проведения (адрес или аудитория):', { format: 'markdown' });
});

// Экспорт
module.exports = {
  handleAfishaCommand,
  handleAfishaPage,
  handleEventView,
  handleEventRegister,
  handleCreateEventCommand,
  handleEventCreationInput,
  handleEventCategorySelect
};