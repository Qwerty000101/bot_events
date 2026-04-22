require('dotenv').config();
const { Bot } = require('@maxhub/max-bot-api');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const db = require('./db');
const stateManager = require('./stateManager');
const { safeCallbackHandler, getMainMenuKeyboard, isFreshMessage } = require('./utils');
const basicHandlers = require('./handlers/basicHandlers');
const apiRoutes = require('./api/routes');

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

// Команды
bot.command('start', basicHandlers.handleStartCommand);
bot.command('help', (ctx) => basicHandlers.handleHelp(ctx));

// Обработка callback'ов
bot.action('menu:afisha', safeCallbackHandler(async (ctx) => {
  await ctx.answerOnCallback({ notification: 'Открываем афишу...' });
  // Здесь будет ссылка на мини-приложение (URL Web App)
  // Пока заглушка:
  return ctx.reply('🎟️ Афиша мероприятий (мини-приложение будет доступно по ссылке).');
}));

bot.action('menu:my_tickets', safeCallbackHandler(async (ctx) => {
  await ctx.answerOnCallback({ notification: 'Загружаем билеты...' });
  const tickets = db.getUserTickets(ctx.user.user_id);
  if (tickets.length === 0) {
    return ctx.reply('У вас пока нет активных билетов.', { attachments: [getMainMenuKeyboard()] });
  }
  let text = '🎫 **Ваши билеты:**\n\n';
  tickets.forEach((t, i) => {
    text += `${i+1}. *${t.title}* (${t.event_date} ${t.event_time})\n   Статус: ${t.status === 'registered' ? '🟢 Активен' : '✅ Отмечен'}\n\n`;
  });
  return ctx.reply(text, { format: 'markdown', attachments: [getMainMenuKeyboard()] });
}));

bot.action('menu:help', safeCallbackHandler(basicHandlers.handleHelp));

// Обработка текстовых сообщений (в том числе для заполнения профиля)
bot.on('message_created', async (ctx, next) => {
  if (!ctx.user) return next();
  
  // Проверка на старые сообщения
  if (!isFreshMessage(ctx, global.botStartTime)) return next();

  // Сначала пробуем обработать ввод профиля
  const profileHandled = await basicHandlers.handleProfileInput(ctx);
  if (profileHandled) return;

  // Если не обработано – неизвестная команда
  await basicHandlers.handleUnknownCommand(ctx);
  await next();
});

// === Запуск Express API ===
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/api', apiRoutes);

const API_PORT = process.env.API_PORT || 3000;
app.listen(API_PORT, () => {
  console.log(`🌐 API сервер запущен на порту ${API_PORT}`);
});

// === Запуск бота ===
bot.start().then(() => {
  console.log('🤖 Бот запущен!');
}).catch(err => {
  console.error('❌ Ошибка запуска бота:', err);
  process.exit(1);
});

// === Планировщик напоминаний (пример) ===
// cron.schedule('0 * * * *', () => { ... }); // будет добавлено позже

// Обработка завершения
process.once('SIGINT', () => {
  console.log('🛑 Завершение работы...');
  bot.stop();
  process.exit(0);
});