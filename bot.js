require('dotenv').config();
const { Bot, Keyboard } = require('@maxhub/max-bot-api');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const XLSX = require('xlsx');
const db = require('./db');
const stateManager = require('./stateManager');
const { safeCallbackHandler, getMainMenuKeyboard, isFreshMessage, formatEventDetails } = require('./utils');
const basicHandlers = require('./handlers/basicHandlers');
const apiRoutes = require('./api/routes');

const INSTITUTES_PER_PAGE = 8;

// Инициализация БД
db.initDb();

// Создаём бота
const botToken = process.env.BOT_TOKEN;
if (!botToken) {
  console.error('❌ BOT_TOKEN не найден в .env');
  process.exit(1);
}

const bot = new Bot(botToken);
global.botInstance = bot; // для использования в API
global.botStartTime = Date.now();

// === Настройка обработчиков бота ===

// Middleware для фильтрации старых событий
bot.use(async (ctx, next) => {
  const updateTimestamp = ctx.update?.created_at || ctx.message?.timestamp || ctx.timestamp;
  if (updateTimestamp && updateTimestamp < (global.botStartTime - 10000)) {
    console.log(`⏩ Пропущено старое событие: ${new Date(updateTimestamp).toISOString()}`);
    return;
  }
  await next();
});
bot.api.setMyCommands([
  {
    name: 'start',
    description: 'Запустить',
  },
  {
    name: 'help',
    description: 'Справка',
  },
  {
    name: 'createevent',
    description: 'Создание мероприятий',
  },
  {
    name: 'profile',
    description: 'Профиль',
  }
  
]);
// Команды
bot.command('start', basicHandlers.handleStartCommand);
bot.command('help', (ctx) => basicHandlers.handleHelp(ctx));
bot.command('createevent', safeCallbackHandler(handleCreateEventCommand));
bot.command('profile', safeCallbackHandler(basicHandlers.handleProfileCommand));

// ===== ОБРАБОТЧИКИ =====
bot.on('bot_started', basicHandlers.handleStartCommand);
// Главное меню: Афиша мероприятий (список с пагинацией)
bot.action('menu:afisha', safeCallbackHandler(async (ctx) => {
  // Прямой вызов – showEventsPage определит, что это callback и обновит сообщение
  return showEventsPage(ctx, 1);
}));
bot.action('menu:create_event', safeCallbackHandler(async (ctx) => {
  await ctx.answerOnCallback({ notification: 'Создание мероприятия...' });
  return handleCreateEventCommand(ctx);
}));
// Пагинация мероприятий – добавлено уведомление
bot.action(/^events:page:(\d+)$/, safeCallbackHandler(async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  return showEventsPage(ctx, page);
}));

// Просмотр деталей мероприятия
bot.action(/^event:view:(\d+):(\d+)$/, safeCallbackHandler(async (ctx) => {
  const eventId = parseInt(ctx.match[1], 10);
  const page = parseInt(ctx.match[2], 10);
  const userId = ctx.user.user_id;
  const event = db.getEventById(eventId);
  if (!event) {
    return ctx.answerOnCallback({ notification: 'Мероприятие не найдено' });
  }

  const details = formatEventDetails(event);
  const buttons = [];

  if (event.available_seats > 0) {
    buttons.push([Keyboard.button.callback('📝 Зарегистрироваться', `event:register:${eventId}`)]);
  } else {
    buttons.push([Keyboard.button.callback('🔴 Мест нет', 'event:noop', { disabled: true })]);
  }

  const user = db.getUser(userId);
  if (user && user.role === 'admin') {
    if (event.organizer_user_id === userId || user.role === 'admin') {
      buttons.push([Keyboard.button.callback('🗑️ Удалить мероприятие', `event:delete:${eventId}`)]);
    }
    buttons.push([Keyboard.button.callback('📊 Статистика', `event:stats:${eventId}`)]);
  }

  buttons.push([Keyboard.button.callback('⬅️ Назад к списку', `events:page:${page}`)]);
  buttons.push([Keyboard.button.callback('🏠 Главное меню', 'menu:main')]);

  const keyboard = Keyboard.inlineKeyboard(buttons);

  // Если вызов произошёл по кнопке – обновляем текущее сообщение
  if (ctx.callbackQuery || ctx.update?.type === 'message_callback') {
    return ctx.answerOnCallback({
      message: { text: details, attachments: [keyboard], format: 'markdown' }
    });
  } else {
    return ctx.reply(details, { attachments: [keyboard], format: 'markdown' });
  }
}));

// Регистрация на мероприятие через бота
bot.action(/^event:register:(\d+)$/, safeCallbackHandler(async (ctx) => {
  const eventId = parseInt(ctx.match[1], 10);
  const userId = ctx.user.user_id;

  await ctx.answerOnCallback({ notification: 'Обрабатываем регистрацию...' });

  try {
    const { uuid, event } = db.registerForEvent(userId, eventId);
    
    const { generateQRCodeBuffer } = require('./services/qrService');
    const { sendTicketConfirmation } = require('./services/notificationService');
    const qrBuffer = await generateQRCodeBuffer(uuid);
    await sendTicketConfirmation(bot, userId, event.title, qrBuffer);

    const keyboard = Keyboard.inlineKeyboard([
      [Keyboard.button.callback('🏠 Главное меню', 'menu:main')]
    ]);
    return ctx.reply(`✅ Регистрация на "${event.title}" подтверждена. QR-код отправлен в этот чат.`, { attachments: [keyboard] });
  } catch (err) {
    return ctx.reply(`❌ Ошибка: ${err.message}`);
  }
}));

// Запрос подтверждения удаления мероприятия
bot.action(/^event:delete:(\d+)$/, safeCallbackHandler(async (ctx) => {
  const eventId = parseInt(ctx.match[1], 10);
  const userId = ctx.user.user_id;
  const event = db.getEventById(eventId);
  if (!event) {
    return ctx.answerOnCallback({ notification: 'Мероприятие не найдено' });
  }

  const user = db.getUser(userId);
  if (!user || (event.organizer_user_id !== userId && user.role !== 'admin')) {
    return ctx.answerOnCallback({ notification: 'У вас нет прав на удаление' });
  }

  const confirmKeyboard = Keyboard.inlineKeyboard([
    [
      Keyboard.button.callback('✅ Да, удалить', `event:delete_confirm:${eventId}`),
      Keyboard.button.callback('❌ Отмена', `event:view:${eventId}`)
    ]
  ]);

  await ctx.answerOnCallback({ notification: 'Подтвердите удаление' });
  return ctx.reply(
    `Вы уверены, что хотите удалить мероприятие ${event.title}?\nЭто действие необратимо.`,
    { format: 'markdown', attachments: [confirmKeyboard] }
  );
}));

bot.action(/^event:delete_confirm:(\d+)$/, safeCallbackHandler(async (ctx) => {
  const eventId = parseInt(ctx.match[1], 10);
  const userId = ctx.user.user_id;

  try {
    const deleted = db.deleteEvent(eventId, userId);
    if (deleted > 0) {
      await ctx.answerOnCallback({ notification: 'Мероприятие удалено' });
      const currentUser = db.getUser(userId);
      const keyboard = Keyboard.inlineKeyboard([
        [Keyboard.button.callback('🏠 Главное меню', 'menu:main')]
      ]);
      return ctx.reply('✅ Мероприятие успешно удалено.', { attachments: [keyboard] });
    } else {
      throw new Error('Не удалось удалить мероприятие');
    }
  } catch (err) {
    return ctx.answerOnCallback({ notification: `❌ ${err.message}` });
  }
}));

// Статистика мероприятия
bot.action(/^event:stats:(\d+)$/, safeCallbackHandler(async (ctx) => {
  const eventId = parseInt(ctx.match[1], 10);
  const userId = ctx.user.user_id;
  
  try {
    const stats = db.getEventStats(eventId, userId);
    const message = `📊 Статистика мероприятия\n\n` +
      `Зарегистрировалось: ${stats.registered}\n` +
      `Зарегистрировалось и пришло: ${stats.checked_in}\n` +
      `Всего мест: ${stats.total_seats} (свободно: ${stats.available_seats})`;
    
    const keyboard = Keyboard.inlineKeyboard([
      [Keyboard.button.callback('📋 Список участников', `event:participants:${eventId}`)],
      [Keyboard.button.callback('📥 Экспорт в XLSX', `event:export_xlsx:${eventId}`)],
      [Keyboard.button.callback('🔙 К мероприятию', `event:view:${eventId}`)],
      [Keyboard.button.callback('🏠 Главное меню', 'menu:main')]
    ]);
    
    await ctx.answerOnCallback({ notification: 'Статистика загружена' });
    return ctx.reply(message, { format: 'markdown', attachments: [keyboard] });
  } catch (err) {
    return ctx.answerOnCallback({ notification: `❌ ${err.message}` });
  }
}));

// Список участников мероприятия
bot.action(/^event:participants:(\d+)$/, safeCallbackHandler(async (ctx) => {
  const eventId = parseInt(ctx.match[1], 10);
  const userId = ctx.user.user_id;
  
  try {
    const participants = db.getEventParticipants(eventId, userId);
    if (participants.length === 0) {
      return ctx.answerOnCallback({ notification: 'Нет участников' });
    }
    
    const list = participants.map(p => {
      const statusEmoji = p.status === 'registered' ? '🟢' : '✅';
      const statusText = p.status === 'registered' ? 'Зарегистрировался' : 'Зарегистрировался и пришёл';
      return `${statusEmoji} ${p.full_name} (${p.institute_name || '-'}, ${p.group_name || '-'}) — ${statusText}`;
    }).join('\n');
    
    const message = `📋 Участники мероприятия\n\n${list}`;
    const keyboard = Keyboard.inlineKeyboard([
      [Keyboard.button.callback('🔙 К статистике', `event:stats:${eventId}`)],
      [Keyboard.button.callback('🏠 Главное меню', 'menu:main')]
    ]);
    
    await ctx.answerOnCallback({ notification: 'Список загружен' });
    return ctx.reply(message, { format: 'markdown', attachments: [keyboard] });
  } catch (err) {
    return ctx.answerOnCallback({ notification: `❌ ${err.message}` });
  }
}));

// Экспорт списка участников в XLSX
bot.action(/^event:export_xlsx:(\d+)$/, safeCallbackHandler(async (ctx) => {
  const eventId = parseInt(ctx.match[1], 10);
  const userId = ctx.user.user_id;
  
  try {
    const participants = db.getEventParticipants(eventId, userId);
    if (participants.length === 0) {
      return ctx.answerOnCallback({ notification: 'Нет участников для экспорта' });
    }
    
    const data = participants.map(p => ({
      'ФИО': p.full_name,
      'Институт': p.institute_name || '-',
      'Группа': p.group_name || '-',
      'Статус': p.status === 'registered' ? 'Зарегистрировался' : 'Зарегистрировался и пришёл',
      'Время отметки': p.checked_in_at || '-'
    }));
    
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Участники');
    
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    await ctx.answerOnCallback({ notification: 'Формируем файл...' });
    const fileAttachment = await ctx.api.uploadFile({ source: buffer });
    
    await ctx.reply('📥 Список участников', {
      format: 'markdown',
      attachments: [fileAttachment.toJson()]
    });
    
  } catch (err) {
    console.error('Ошибка экспорта:', err);
    return ctx.answerOnCallback({ notification: `❌ ${err.message}` });
  }
}));

// Возврат в главное меню
bot.action('menu:main', safeCallbackHandler(async (ctx) => {
  // Не вызываем предварительный answerOnCallback, handleStartCommand сам решит
  return basicHandlers.handleStartCommand(ctx);
}));

// Мои билеты – список кнопок
bot.action('menu:my_tickets', safeCallbackHandler(async (ctx) => {
  await ctx.answerOnCallback({ notification: 'Загружаем билеты...' });
  const tickets = db.getUserTickets(ctx.user.user_id);
  
  if (tickets.length === 0) {
    const user = db.getUser(ctx.user.user_id);
    return ctx.reply('У вас пока нет активных билетов.', { attachments: [getMainMenuKeyboard(user?.role)] });
  }

  const buttons = tickets.map(ticket => {
    const label = `${ticket.title} (${ticket.event_date})`;
    return [Keyboard.button.callback(label, `ticket:view:${ticket.uuid}`)];
  });

  buttons.push([Keyboard.button.callback('⬅️ Назад', 'menu:main')]);

  const keyboard = Keyboard.inlineKeyboard(buttons);
  return ctx.reply('🎫 Ваши билеты:\n\nВыберите билет для просмотра:', {
    format: 'markdown',
    attachments: [keyboard]
  });
}));

// Просмотр деталей билета
bot.action(/^ticket:view:(.+)$/, safeCallbackHandler(async (ctx) => {
  const uuid = ctx.match[1];
  const userId = ctx.user.user_id;
  
  const tickets = db.getUserTickets(userId);
  const ticket = tickets.find(t => t.uuid === uuid);
  if (!ticket) {
    return ctx.answerOnCallback({ notification: 'Билет не найден' });
  }

  const statusEmoji = ticket.status === 'registered' ? '🟢' : '✅';
  const statusText = ticket.status === 'registered' ? 'Активен' : 'Отмечен';
  
  const message = `
🎫 Билет на мероприятие

Название: ${ticket.title}
Дата: ${ticket.event_date}
Время: ${ticket.event_time}
Место: ${ticket.location}
Статус: ${statusEmoji} ${statusText}
UUID: \`${ticket.uuid}\`
  `.trim();

  const keyboard = Keyboard.inlineKeyboard([
    [Keyboard.button.callback('📷 Получить QR-код', `ticket:qr:${uuid}`)],
    [Keyboard.button.callback('🗑️ Удалить билет', `ticket:delete:${uuid}`)],
    [Keyboard.button.callback('⬅️ Назад к списку', 'menu:my_tickets')],
    [Keyboard.button.callback('🏠 Главное меню', 'menu:main')]
  ]);

  await ctx.answerOnCallback({ notification: 'Информация о билете' });
  return ctx.reply(message, { format: 'markdown', attachments: [keyboard] });
}));

// Получить QR-код повторно
bot.action(/^ticket:qr:(.+)$/, safeCallbackHandler(async (ctx) => {
    const uuid = ctx.match[1];
    const userId = ctx.user.user_id;
    const ticket = db.getTicketByUUID(uuid);
    if (!ticket || ticket.user_id !== userId) {
        return ctx.answerOnCallback({ notification: 'Билет не найден' });
    }
    if (ticket.status !== 'registered') {
        return ctx.answerOnCallback({ notification: 'Билет уже использован или отменён' });
    }
    await ctx.answerOnCallback({ notification: 'Генерируем QR-код...' });
    
    const { generateQRCodeBuffer } = require('./services/qrService');
    const { sendTicketConfirmation } = require('./services/notificationService');
    const qrBuffer = await generateQRCodeBuffer(uuid);
    await sendTicketConfirmation(bot, userId, ticket.event_title, qrBuffer);
}));

// Удаление билета – запрос подтверждения
bot.action(/^ticket:delete:(.+)$/, safeCallbackHandler(async (ctx) => {
  const uuid = ctx.match[1];
  const userId = ctx.user.user_id;
  
  const ticket = db.getTicketByUUID(uuid);
  if (!ticket || ticket.user_id !== userId) {
    return ctx.answerOnCallback({ notification: 'Билет не найден' });
  }
  
  const confirmKeyboard = Keyboard.inlineKeyboard([
    [
      Keyboard.button.callback('✅ Да', `ticket:delete_confirm:${uuid}`),
      Keyboard.button.callback('❌ Нет', `ticket:view:${uuid}`)
    ]
  ]);
  
  await ctx.answerOnCallback({ notification: 'Подтвердите удаление билета' });
  return ctx.reply(`Вы уверены, что хотите удалить билет на мероприятие ${ticket.event_title}?`, {
    format: 'markdown',
    attachments: [confirmKeyboard]
  });
}));

// Подтверждение удаления билета
bot.action(/^ticket:delete_confirm:(.+)$/, safeCallbackHandler(async (ctx) => {
  const uuid = ctx.match[1];
  const userId = ctx.user.user_id;
  
  try {
    db.cancelTicket(userId, uuid);
    await ctx.answerOnCallback({ notification: 'Билет удалён' });
    
    const user = db.getUser(userId);
    const keyboard = Keyboard.inlineKeyboard([
      [Keyboard.button.callback('⬅️ К списку билетов', 'menu:my_tickets')],
      [Keyboard.button.callback('🏠 Главное меню', 'menu:main')]
    ]);
    return ctx.reply('✅ Билет успешно удалён.', { attachments: [keyboard] });
  } catch (err) {
    return ctx.answerOnCallback({ notification: `❌ ${err.message}` });
  }
}));

// ===== ПРОФИЛЬ =====
bot.action('menu:profile', safeCallbackHandler(basicHandlers.handleProfileCommand));
bot.action('profile:edit', safeCallbackHandler(basicHandlers.handleProfileEdit));
bot.action(/^profile_edit_role:(.+)$/, safeCallbackHandler(basicHandlers.handleProfileEditRoleSelect));
bot.action(/^profile_role:(.+)$/, safeCallbackHandler(basicHandlers.handleProfileRoleSelect));
bot.action('profile:cancel', safeCallbackHandler(basicHandlers.handleProfileCancel));
bot.action(/^reg_role:(.+)$/, safeCallbackHandler(basicHandlers.handleRegRoleSelect));
bot.action('menu:help', safeCallbackHandler(basicHandlers.handleHelp));

// ===== СОЗДАНИЕ МЕРОПРИЯТИЯ (ДИАЛОГ) =====
async function handleCreateEventCommand(ctx) {
  const userId = ctx.user?.user_id;
  if (!userId) return ctx.reply('Ошибка идентификации.');

  const user = db.getUser(userId);
  if (!user || user.role !== 'admin') {
    return ctx.reply('⛔ Только администраторы могут создавать мероприятия.');
  }

  stateManager.setUserState(userId, {
    step: 'event_title',
    tempEvent: {}
  });

  const keyboard = Keyboard.inlineKeyboard([
    [Keyboard.button.callback('❌ Отменить', 'event:cancel')]
  ]);

  return ctx.reply(
    '📝 Создание нового мероприятия\n\nВведите название мероприятия:',
    { format: 'markdown', attachments: [keyboard] }
  );
}
// Пагинация страниц выбора института
bot.action(/^institute_page:(.+):(\d+)$/, safeCallbackHandler(async (ctx) => {
  const stateStep = ctx.match[1];
  const page = parseInt(ctx.match[2], 10);
  const userId = ctx.user.user_id;
  const state = stateManager.getUserState(userId);
  if (!state || state.step !== stateStep) {
    return ctx.answerOnCallback({ notification: 'Сессия устарела' });
  }
  await ctx.answerOnCallback({ notification: `Страница ${page}` });
  if (stateStep === 'event_institute') {
    return showInstitutePageForEvent(ctx, userId, page);
  } else {
    return basicHandlers.showInstitutePage(ctx, userId, page, stateStep);
  }
}));

// Выбор конкретного института (универсальный)
bot.action(/^institute_select:(.+):(.+)$/, safeCallbackHandler(async (ctx) => {
  const stateStep = ctx.match[1];
  const instituteKey = ctx.match[2];
  const userId = ctx.user.user_id;
  const state = stateManager.getUserState(userId);
  if (!state || state.step !== stateStep) {
    return ctx.answerOnCallback({ notification: 'Сессия устарела' });
  }
  state.institute = instituteKey === 'none' ? null : instituteKey;
  await ctx.answerOnCallback({ notification: 'Институт выбран' });

  switch (stateStep) {
    case 'waiting_institute_select':
      if (state.role === 'admin') {
        db.createOrUpdateUser(userId, {
          full_name: state.full_name,
          institute: state.institute,
          group_name: null,
          role: 'admin'
        });
        stateManager.deleteUserState(userId);
        const adminUser = db.getUser(userId);
        return ctx.reply('✅ Регистрация завершена!', {
          format: 'markdown',
          attachments: [getMainMenuKeyboard(adminUser.role)]
        });
      } else {
        state.step = 'waiting_group';
        stateManager.setUserState(userId, state);
        return ctx.reply('👥 Укажите вашу группу:', { format: 'markdown' });
      }

    case 'profile_edit_institute_select':
      const updatedUser = {...state.tempProfile, institute: state.institute};
      state.tempProfile = updatedUser;
      if (state.tempProfile.role === 'admin') {
        db.updateUserProfile(userId, {
          full_name: state.tempProfile.full_name,
          institute: state.tempProfile.institute,
          group_name: null,
          role: state.tempProfile.role
        });
        stateManager.deleteUserState(userId);
        await ctx.reply('✅ Профиль обновлён!');
        return basicHandlers.handleProfileCommand(ctx);
      } else {
        state.step = 'profile_edit_group';
        stateManager.setUserState(userId, state);
        return ctx.reply('Введите группу:', { format: 'markdown' });
      }

    case 'event_institute':
      state.tempEvent.institute_filter = state.institute;
      state.step = 'event_date';
      stateManager.setUserState(userId, state);
      const cancelKeyboard = Keyboard.inlineKeyboard([
        [Keyboard.button.callback('❌ Отменить', 'event:cancel')]
      ]);
      return ctx.reply('📅 Введите дату в формате ГГГГ-ММ-ДД:', { attachments: [cancelKeyboard] });

    default:
      return ctx.answerOnCallback({ notification: 'Ошибка контекста' });
  }
}));
// Отмена создания
bot.action('event:cancel', safeCallbackHandler(async (ctx) => {
  const userId = ctx.user?.user_id;
  if (userId) stateManager.deleteUserState(userId);
  await ctx.answerOnCallback({ notification: 'Создание отменено' });
  const user = db.getUser(userId);
  return ctx.reply('❌ Создание мероприятия отменено.', { attachments: [getMainMenuKeyboard(user?.role)] });
}));

// Обработка текстовых сообщений
bot.on('message_created', async (ctx, next) => {
  if (!ctx.user) return next();
  
  if (!isFreshMessage(ctx, global.botStartTime)) return next();

  const userId = ctx.user.user_id;
  const state = stateManager.getUserState(userId);

  // 1. Редактирование профиля
  const profileEditHandled = await basicHandlers.handleProfileEditInput(ctx);
  if (profileEditHandled) return;

  // 2. Создание мероприятия
  if (state && state.step && state.step.startsWith('event_')) {
    return handleEventCreationInput(ctx, state);
  }

  // 3. Первичное заполнение профиля
  const profileHandled = await basicHandlers.handleProfileInput(ctx);
  if (profileHandled) return;

  // 4. Неизвестная команда
  await basicHandlers.handleUnknownCommand(ctx);
  await next();
});

async function handleEventCreationInput(ctx, state) {
  const userId = ctx.user.user_id;
  const text = ctx.message?.body?.text?.trim();
  if (!text) return;

  if (text.toLowerCase() === '/quit') {
    stateManager.deleteUserState(userId);
    const user = db.getUser(userId);
    return ctx.reply('❌ Создание мероприятия отменено.', { attachments: [getMainMenuKeyboard(user?.role)] });
  }

  const cancelKeyboard = Keyboard.inlineKeyboard([
    [Keyboard.button.callback('❌ Отменить', 'event:cancel')]
  ]);

  switch (state.step) {
    case 'event_title':
      state.tempEvent.title = text;
      state.step = 'event_description';
      stateManager.setUserState(userId, state);
      return ctx.reply('📄 Введите описание мероприятия:', { format: 'markdown', attachments: [cancelKeyboard] });

    case 'event_description':
      state.tempEvent.description = text;
      state.step = 'event_category';
      stateManager.setUserState(userId, state);
      const categories = db.getCategories();
      const catButtons = categories.map(c => [
          Keyboard.button.callback(c.name, `event_cat:${c.key}`)
      ]);
      catButtons.push([Keyboard.button.callback('❌ Отменить', 'event:cancel')]);
      const catKeyboard = Keyboard.inlineKeyboard(catButtons);
      return ctx.reply('🏷️ Выберите категорию:', { attachments: [catKeyboard] });
        state.tempEvent.description = text;
        state.step = 'event_institute';
        stateManager.setUserState(userId, state);
        return showInstitutePageForEvent(ctx, userId, 1);
    case 'event_date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return ctx.reply('❌ Неверный формат. Введите дату в формате ГГГГ-ММ-ДД (например, 2026-05-20):', { attachments: [cancelKeyboard] });
      }
      state.tempEvent.event_date = text;
      state.step = 'event_time';
      stateManager.setUserState(userId, state);
      return ctx.reply('⏰ Введите время в формате ЧЧ:ММ (например, 14:00):', { attachments: [cancelKeyboard] });

    case 'event_time':
      if (!/^\d{2}:\d{2}$/.test(text)) {
        return ctx.reply('❌ Неверный формат. Введите время в формате ЧЧ:ММ:', { attachments: [cancelKeyboard] });
      }
      state.tempEvent.event_time = text;
      state.step = 'event_location';
      stateManager.setUserState(userId, state);
      return ctx.reply('📍 Введите место проведения:', { attachments: [cancelKeyboard] });

    case 'event_location':
      state.tempEvent.location = text;
      state.step = 'event_capacity';
      stateManager.setUserState(userId, state);
      return ctx.reply('👥 Введите количество мест:', { attachments: [cancelKeyboard] });

    case 'event_capacity':
      const capacity = parseInt(text, 10);
      if (isNaN(capacity) || capacity <= 0) {
        return ctx.reply('❌ Введите целое положительное число.', { attachments: [cancelKeyboard] });
      }
      state.tempEvent.capacity = capacity;
      
      try {
        const eventId = db.createEvent({
          ...state.tempEvent,
          organizer_user_id: userId,
          geo_coords: null
        });
        stateManager.deleteUserState(userId);
        
        const successKeyboard = Keyboard.inlineKeyboard([
          [Keyboard.button.callback('🏠 Главное меню', 'menu:main')]
        ]);
        return ctx.reply(`✅ Мероприятие "${state.tempEvent.title}" успешно создано! (ID: ${eventId})`, 
          { format: 'markdown', attachments: [successKeyboard] });
      } catch (err) {
        console.error('Ошибка создания мероприятия:', err);
        stateManager.deleteUserState(userId);
        const user = db.getUser(userId);
        return ctx.reply(`❌ Ошибка при создании: ${err.message}`, { attachments: [getMainMenuKeyboard(user?.role)] });
      }

    default:
      return;
  }
}

// Обработка выбора категории через callback
bot.action(/^event_cat:(.+)$/, safeCallbackHandler(async (ctx) => {
  const userId = ctx.user?.user_id;
  const state = stateManager.getUserState(userId);
  if (!state || state.step !== 'event_category') {
    return ctx.answerOnCallback({ notification: 'Сессия устарела' });
  }

  const category = ctx.match[1];
  state.tempEvent.category = category;
  state.step = 'event_institute';
  stateManager.setUserState(userId, state);

  await ctx.answerOnCallback({ notification: `Категория: ${category}` });
  return showInstitutePageForEvent(ctx, userId, 1);
}));

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
async function showInstitutePageForEvent(ctx, userId, page) {
  const institutes = db.getInstitutes();
  const totalPages = Math.ceil(institutes.length / INSTITUTES_PER_PAGE);
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;
  const start = (page - 1) * INSTITUTES_PER_PAGE;
  const pageItems = institutes.slice(start, start + INSTITUTES_PER_PAGE);

  const buttons = pageItems.map(inst => [
    Keyboard.button.callback(inst.name, `institute_select:event_institute:${inst.key}`)
  ]);

  const navRow = [];
  if (page > 1) navRow.push(Keyboard.button.callback('⬅️ Назад', `institute_page:event_institute:${page - 1}`));
  if (page < totalPages) navRow.push(Keyboard.button.callback('Вперёд ➡️', `institute_page:event_institute:${page + 1}`));
  if (navRow.length) buttons.push(navRow);

  buttons.push([Keyboard.button.callback('Все институты', `institute_select:event_institute:none`)]);

  const keyboard = Keyboard.inlineKeyboard(buttons);
  return ctx.reply('🏛️ Выберите институт, к которому относится мероприятие:', { attachments: [keyboard] });
}

function showEventsPage(ctx, page = 1, filters = {}) {
  const events = db.getEvents(filters);
  const ITEMS_PER_PAGE = 5;
  const totalPages = Math.ceil(events.length / ITEMS_PER_PAGE);
  const start = (page - 1) * ITEMS_PER_PAGE;
  const pageEvents = events.slice(start, start + ITEMS_PER_PAGE);

  const userId = ctx.user?.user_id;
  const user = userId ? db.getUser(userId) : null;
  const menuKeyboard = getMainMenuKeyboard(user?.role);

  // Определяем, пришёл ли запрос от callback (нажатие на инлайн-кнопку)
  const isCallback = !!(ctx.callbackQuery || ctx.update?.type === 'message_callback');

  // Пустая афиша
  if (pageEvents.length === 0) {
    const text = '📭 Мероприятий не найдено.';
    if (isCallback) {
      return ctx.answerOnCallback({
        message: { text, attachments: [menuKeyboard], format: 'markdown' }
      });
    } else {
      return ctx.reply(text, { attachments: [menuKeyboard], format: 'markdown' });
    }
  }

  // Собираем клавиатуру с мероприятиями и навигацией
  const buttons = pageEvents.map(ev => [
    Keyboard.button.callback(`${ev.title} (${ev.event_date})`, `event:view:${ev.id}:${page}`)
  ]);
  const navRow = [];
  if (page > 1) navRow.push(Keyboard.button.callback('⬅️ Назад', `events:page:${page - 1}`));
  if (page < totalPages) navRow.push(Keyboard.button.callback('Вперёд ➡️', `events:page:${page + 1}`));
  if (navRow.length > 0) buttons.push(navRow);
  buttons.push([Keyboard.button.callback('🏠 Главное меню', 'menu:main')]);

  const keyboard = Keyboard.inlineKeyboard(buttons);
  const message = `📋 Афиша мероприятий (страница ${page}/${totalPages}):`;

  if (isCallback) {
    // Обновляем сообщение, к которому привязана нажатая кнопка
    return ctx.answerOnCallback({
      message: { text: message, attachments: [keyboard], format: 'markdown' }
    });
  } else {
    // Если вызов не из callback (например, команда), создаём новое сообщение
    return ctx.reply(message, { attachments: [keyboard], format: 'markdown' });
  }
}

// === Запуск Express API ===
const app = express();

app.use((req, res, next) => {
    console.log('🌍 Запрос:', req.method, req.url);
    next();
});
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use('/api', apiRoutes);

const API_PORT = process.env.API_PORT || 3000;
app.listen(API_PORT, () => {
  console.log(`🌐 API сервер запущен на порту ${API_PORT}`);
});
bot.action('test_debug', async (ctx) => {
  console.log('✅ test_debug сработал!');
  await ctx.answerOnCallback({ notification: 'OK' });
});
// === Запуск бота ===
bot.start().then(() => {
  console.log('🤖 Бот запущен!');
}).catch(err => {
  console.error('❌ Ошибка запуска бота:', err);
  process.exit(1);
});

// Обработка завершения
process.once('SIGINT', () => {
  console.log('🛑 Завершение работы...');
  bot.stop();
  process.exit(0);
});