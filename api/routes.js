const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateQRCodeBuffer } = require('../services/qrService');
const { sendTicketConfirmation } = require('../services/notificationService');

// Middleware для валидации initData (упрощённый вариант – в продакшене нужна проверка подписи)
function validateInitData(req, res, next) {
  // В реальном проекте здесь должна быть проверка хэша initData из заголовков или query
  // Пока для демонстрации просто извлекаем userId из тела (предполагаем, что фронт передаёт проверенный userId)
  const { userId } = req.body;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.userId = parseInt(userId, 10);
  next();
}
//Отмена билета
router.post('/tickets/cancel', validateInitData, (req, res) => {
  const { uuid } = req.body;
  if (!uuid) return res.status(400).json({ error: 'UUID билета обязателен' });
  try {
    const result = db.cancelTicket(req.userId, uuid);
    res.json({ success: true, event_id: result.event_id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// Получить список мероприятий с фильтрацией
router.post('/events/list', validateInitData, (req, res) => {
  const { category, institute } = req.body;
  const events = db.getEvents({ category, institute });
  res.json({ events });
});
// Получить профиль текущего пользователя (роль и данные)
router.post('/users/me', validateInitData, (req, res) => {
  const user = db.getUser(req.userId);
  res.json({ user });
});
// Получить детали конкретного мероприятия
router.post('/events/:id', validateInitData, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const event = db.getEventById(eventId);
  if (!event) {
    return res.status(404).json({ error: 'Мероприятие не найдено' });
  }
  // Проверить, зарегистрирован ли текущий пользователь
  const ticket = db.getUserTickets(req.userId).find(t => t.event_id === eventId);
  res.json({ event, isRegistered: !!ticket });
});

// Регистрация на мероприятие
router.post('/tickets/register', validateInitData, async (req, res) => {
  const { eventId } = req.body;
  if (!eventId) {
    return res.status(400).json({ error: 'eventId обязателен' });
  }

  try {
    const { uuid, event } = db.registerForEvent(req.userId, parseInt(eventId, 10));
    
    // Генерируем QR-код
    const qrBuffer = await generateQRCodeBuffer(uuid);
    
    // Отправляем билет через бота (бот должен быть доступен глобально)
    if (global.botInstance) {
      await sendTicketConfirmation(global.botInstance, req.userId, event.title, qrBuffer);
    }

    res.json({ success: true, ticketUuid: uuid });
  } catch (err) {
    console.error('Ошибка регистрации:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Получить билеты пользователя (для мини-приложения)
router.post('/tickets/my', validateInitData, (req, res) => {
  const tickets = db.getUserTickets(req.userId);
  res.json({ tickets });
});

// Сканирование билета (для организатора)
router.post('/scan/validate', validateInitData, (req, res) => {
  const { uuid } = req.body;
  if (!uuid) {
    return res.status(400).json({ error: 'UUID билета обязателен' });
  }

  try {
    const ticket = db.markTicketAsCheckedIn(uuid);
    res.json({
      valid: true,
      student: {
        full_name: ticket.full_name,
        institute: ticket.institute,
        group: ticket.group_name
      },
      event: ticket.event_title,
      message: '✅ Успешная отметка'
    });
  } catch (err) {
    res.json({ valid: false, message: err.message });
  }
});

module.exports = router;