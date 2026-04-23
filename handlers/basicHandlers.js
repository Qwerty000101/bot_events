const { Keyboard } = require('@maxhub/max-bot-api');
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

  let user = db.getUser(userId);
  if (!user) {
    // Сначала спрашиваем статус
    stateManager.setUserState(userId, { step: 'waiting_role' });
    const roleKeyboard = Keyboard.inlineKeyboard([
      [Keyboard.button.callback('👨‍🎓 Студент', 'reg_role:student')],
      [Keyboard.button.callback('👑 Администратор', 'reg_role:admin')]
    ]);
    return ctx.reply(
      '👋 Добро пожаловать в систему мероприятий СКФУ!\n\nДля начала выберите ваш **статус**:',
      { attachments: [roleKeyboard] }
    );
  }

  // Пользователь уже зарегистрирован – показываем меню с учётом роли
  const welcomeText = `👋 С возвращением, ${user.full_name || 'студент'}!\n\n` +
    `Выберите действие в меню ниже:`;

  return ctx.reply(welcomeText, {
    format: 'markdown',
    attachments: [getMainMenuKeyboard(user.role)]
  });
}

// Callback выбора роли при первичной регистрации
async function handleRegRoleSelect(ctx) {
  console.log('🟢 handleRegRoleSelect вызван, match:', ctx.match);
  const userId = ctx.user?.user_id;
  let state = stateManager.getUserState(userId);
  console.log('📌 state:', state);
  if (!state || state.step !== 'waiting_role') {
    console.warn('⚠️ Состояние не waiting_role');
    return ctx.answerOnCallback({ notification: 'Сессия устарела. Введите /start заново.' });
  }

  const role = ctx.match[1];
  console.log('🎭 Выбрана роль:', role);
  await ctx.answerOnCallback({ notification: role === 'student' ? 'Студент' : 'Преподаватель' });

  state.role = role;
  state.step = 'waiting_full_name';
  stateManager.setUserState(userId, state);

  return ctx.reply('Введите ваше **ФИО**:', { format: 'markdown' });
}

// Обработка текстовых сообщений для первичного заполнения профиля
async function handleProfileInput(ctx) {
  const userId = ctx.user?.user_id;
  if (!userId || !stateManager.hasUserState(userId)) return false;

  const state = stateManager.getUserState(userId);
  const text = ctx.message?.body?.text?.trim();
  if (!text) return false;

  switch (state.step) {
    case 'waiting_full_name':
      state.full_name = text;
      state.step = 'waiting_institute';
      stateManager.setUserState(userId, state);
      return ctx.reply('📚 Укажите ваш **институт** (например, ИИТ, ИЭИ, ЮИ и т.д.):', { format: 'markdown' });

    case 'waiting_institute':
      state.institute = text;
      if (state.role === 'admin') {
        // Преподаватель: сохраняем без группы
        db.createOrUpdateUser(userId, {
          full_name: state.full_name,
          institute: state.institute,
          group_name: null,
          role: 'admin'
        });
        stateManager.deleteUserState(userId);
        // После сохранения получаем пользователя для определения роли в меню
        const teacherUser = db.getUser(userId);
        return ctx.reply('✅ Регистрация завершена! Теперь вы можете создавать мероприятия.', {
          format: 'markdown',
          attachments: [getMainMenuKeyboard(teacherUser.role)]
        });
      } else {
        // Студент: запрашиваем группу
        state.step = 'waiting_group';
        stateManager.setUserState(userId, state);
        return ctx.reply('👥 Укажите вашу **группу** (например, ИВТ-21-1):', { format: 'markdown' });
      }

    case 'waiting_group':
      const group = text;
      db.createOrUpdateUser(userId, {
        full_name: state.full_name,
        institute: state.institute,
        group_name: group,
        role: 'student'
      });
      stateManager.deleteUserState(userId);
      const studentUser = db.getUser(userId);
      await ctx.reply('✅ Регистрация завершена! Теперь вы можете записываться на мероприятия.', {
        format: 'markdown',
        attachments: [getMainMenuKeyboard(studentUser.role)]
      });
      return true;

    default:
      return false;
  }
}

// Обработка неизвестных команд
async function handleUnknownCommand(ctx) {
  if (!isFreshMessage(ctx, global.botStartTime)) return;
  const text = ctx.message?.body?.text;
  if (!text || text.startsWith('/')) return;

  if (ctx.user?.user_id && stateManager.hasUserState(ctx.user.user_id)) {
    return false;
  }

  // Попытаемся получить роль пользователя, если он есть в базе
  let role = null;
  if (ctx.user?.user_id) {
    const user = db.getUser(ctx.user.user_id);
    role = user?.role;
  }

  return ctx.reply(
    '❓ Неизвестная команда. Используйте кнопки меню или /help для списка возможностей.',
    { attachments: [getMainMenuKeyboard(role)] }
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

  // В справке не отображаем кнопку создания (меню без роли)
  const keyboard = getMainMenuKeyboard();

  if (isCallback) {
    await ctx.answerOnCallback({ notification: 'Справка открыта' });
    return ctx.reply(helpText, { format: 'markdown', attachments: [keyboard] });
  } else {
    return ctx.reply(helpText, { format: 'markdown', attachments: [keyboard] });
  }
}

// Показ профиля
async function handleProfileCommand(ctx) {
  const userId = ctx.user?.user_id;
  if (!userId) return ctx.reply('Ошибка идентификации.');

  const user = db.getUser(userId);
  if (!user) {
    return ctx.reply('Вы ещё не зарегистрированы. Используйте /start.');
  }

  const roleText = user.role === 'admin' ? 'Администратор' : 'Студент';
  const text = `👤 **Ваш профиль**

**ФИО:** ${user.full_name || 'не указано'}
**Институт:** ${user.institute || 'не указан'}
**Группа:** ${user.group_name || 'не указана'}
**Статус:** ${roleText}
  `;

  const keyboard = Keyboard.inlineKeyboard([
    [Keyboard.button.callback('✏️ Редактировать профиль', 'profile:edit')],
    [Keyboard.button.callback('🏠 Главное меню', 'menu:main')]
  ]);

  if (ctx.callbackQuery) {
    await ctx.answerOnCallback({ notification: 'Профиль загружен' });
    return ctx.reply(text, { format: 'markdown', attachments: [keyboard] });
  } else {
    return ctx.reply(text, { format: 'markdown', attachments: [keyboard] });
  }
}

// Начало редактирования профиля
async function handleProfileEdit(ctx) {
  const userId = ctx.user?.user_id;
  if (!userId) return ctx.answerOnCallback({ notification: 'Ошибка' });

  const user = db.getUser(userId);
  if (!user) return ctx.answerOnCallback({ notification: 'Пользователь не найден' });

  // Начинаем с выбора роли
  stateManager.setUserState(userId, {
    step: 'profile_edit_role',
    tempProfile: { ...user }
  });

  await ctx.answerOnCallback({ notification: 'Редактирование профиля' });
  const roleKeyboard = Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Студент', 'profile_edit_role:student')],
    [Keyboard.button.callback('Администратор', 'profile_edit_role:admin')],
    [Keyboard.button.callback('❌ Отменить', 'profile:cancel')]
  ]);
  return ctx.reply('Выберите **статус**:', { attachments: [roleKeyboard] });
}

// Callback для выбора роли на первом шаге редактирования
async function handleProfileEditRoleSelect(ctx) {
  const userId = ctx.user?.user_id;
  const state = stateManager.getUserState(userId);
  if (!state || state.step !== 'profile_edit_role') {
    return ctx.answerOnCallback({ notification: 'Сессия устарела' });
  }

  const role = ctx.match[1];
  state.tempProfile.role = role;
  state.step = 'profile_edit_full_name';
  stateManager.setUserState(userId, state);

  await ctx.answerOnCallback({ notification: role === 'student' ? 'Студент' : 'Преподаватель' });
  return ctx.reply(
    `Введите новое **ФИО** (текущее: ${state.tempProfile.full_name || 'не указано'}):\n\n_Введите /quit для отмены._`,
    { format: 'markdown' }
  );
}

// Обработка ввода при редактировании профиля
async function handleProfileEditInput(ctx) {
  const userId = ctx.user?.user_id;
  if (!userId || !stateManager.hasUserState(userId)) return false;

  const state = stateManager.getUserState(userId);
  if (!state.step.startsWith('profile_edit_')) return false;

  const text = ctx.message?.body?.text?.trim();
  if (!text) return false;

  if (text.toLowerCase() === '/quit') {
    stateManager.deleteUserState(userId);
    return ctx.reply('❌ Редактирование отменено.', { attachments: [getMainMenuKeyboard()] }); // без роли, но OK
  }

  switch (state.step) {
    case 'profile_edit_full_name':
      state.tempProfile.full_name = text;
      state.step = 'profile_edit_institute';
      stateManager.setUserState(userId, state);
      return ctx.reply('Введите **институт** (например, ИИТ):', { format: 'markdown' });

    case 'profile_edit_institute':
      state.tempProfile.institute = text;
      if (state.tempProfile.role === 'admin') {
        // Преподаватель: сохраняем без группы
        db.updateUserProfile(userId, {
          full_name: state.tempProfile.full_name,
          institute: state.tempProfile.institute,
          group_name: null,
          role: state.tempProfile.role
        });
        stateManager.deleteUserState(userId);
        await ctx.reply('✅ Профиль обновлён!');
        return handleProfileCommand(ctx);
      } else {
        // Студент: запрашиваем группу
        state.step = 'profile_edit_group';
        stateManager.setUserState(userId, state);
        return ctx.reply('Введите **группу** (например, ИВТ-21-1):', { format: 'markdown' });
      }

    case 'profile_edit_group':
      state.tempProfile.group_name = text;
      // Сохраняем студента
      db.updateUserProfile(userId, {
        full_name: state.tempProfile.full_name,
        institute: state.tempProfile.institute,
        group_name: state.tempProfile.group_name,
        role: state.tempProfile.role
      });
      stateManager.deleteUserState(userId);
      await ctx.reply('✅ Профиль обновлён!');
      return handleProfileCommand(ctx);

    default:
      return false;
  }
}

// Отмена редактирования
async function handleProfileCancel(ctx) {
  const userId = ctx.user?.user_id;
  if (userId) stateManager.deleteUserState(userId);
  await ctx.answerOnCallback({ notification: 'Редактирование отменено' });
  return handleProfileCommand(ctx);
}

module.exports = {
  handleStartCommand,
  handleProfileInput,
  handleRegRoleSelect,
  handleUnknownCommand,
  handleHelp,
  handleProfileCommand,
  handleProfileEdit,
  handleProfileEditInput,
  handleProfileEditRoleSelect,
  handleProfileCancel
};