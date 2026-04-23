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
// Создание мероприятия (только для администраторов)
router.post('/events/create', validateInitData, (req, res) => {
  const { title, description, category, institute_filter, event_date, event_time, location, capacity } = req.body;
  
  const user = db.getUser(req.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Только администраторы могут создавать мероприятия' });
  }

  if (!title || !event_date || !event_time || !capacity) {
    return res.status(400).json({ error: 'Название, дата, время и количество мест обязательны' });
  }

  try {
    const eventId = db.createEvent({
      title,
      description: description || '',
      category: category || 'other',
      institute_filter: institute_filter || null,   // <-- используем institute_filter
      location: location || '',
      event_date,
      event_time,
      capacity: parseInt(capacity, 10),
      organizer_user_id: req.userId
    });
    res.json({ success: true, eventId });
  } catch (err) {
    console.error('Ошибка создания мероприятия:', err.message);
    res.status(400).json({ error: err.message });
  }
});
// Получить список мероприятий с фильтрацией
router.post('/events/list', validateInitData, (req, res) => {
  const { category, institute } = req.body;
  const events = db.getEvents({ category, institute });
  res.json({ events });
});
router.post('/categories', validateInitData, (req, res) => {
  const categories = db.getCategories();
  res.json({ categories });
});
//Получение института
router.post('/institutes', validateInitData, (req, res) => {
  const institutes = db.getInstitutes();
  res.json({ institutes });
});
// Получить профиль текущего пользователя (роль и данные)
router.post('/users/me', validateInitData, (req, res) => {
  const user = db.getUser(req.userId);
  res.json({ user });
});
// Удаление мероприятия (только для администраторов)
router.post('/events/delete', validateInitData, (req, res) => {
  console.log('--- DELETE EVENT REQUEST ---');
  console.log('req.body:', req.body);
  const numericId = parseInt(req.body.id, 10);
  console.log('numericId:', numericId, 'userId:', req.userId);
  
  if (isNaN(numericId)) {
    console.log('ERROR: numericId is NaN');
    return res.status(400).json({ error: 'Неверный ID мероприятия' });
  }
  
  const user = db.getUser(req.userId);
  console.log('user role:', user?.role);
  if (!user || user.role !== 'admin') {
    console.log('ERROR: user is not admin');
    return res.status(403).json({ error: 'Только администраторы могут удалять мероприятия' });
  }
  
  try {
    console.log('Calling db.deleteEvent with', numericId, req.userId);
    db.deleteEvent(numericId, req.userId);
    console.log('Delete successful');
    res.json({ success: true });
  } catch (err) {
    console.log('ERROR in deleteEvent:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Обновление мероприятия (только для администраторов)
router.post('/events/update', validateInitData, (req, res) => {
  console.log('--- UPDATE EVENT REQUEST ---');
  console.log('req.body:', req.body);
  const numericId = parseInt(req.body.id, 10);
  console.log('numericId:', numericId, 'userId:', req.userId);
  
  if (isNaN(numericId)) {
    console.log('ERROR: numericId is NaN');
    return res.status(400).json({ error: 'Неверный ID мероприятия' });
  }
  
  const user = db.getUser(req.userId);
  console.log('user role:', user?.role);
  if (!user || user.role !== 'admin') {
    console.log('ERROR: user is not admin');
    return res.status(403).json({ error: 'Только администраторы могут редактировать мероприятия' });
  }
  
  try {
    console.log('Calling db.updateEvent with', numericId);
    db.updateEvent(numericId, {
      title: req.body.title,
      description: req.body.description || '',
      category: req.body.category || 'other',
      institute_filter: req.body.institute_filter || null,
      location: req.body.location || '',
      event_date: req.body.event_date,
      event_time: req.body.event_time,
      capacity: parseInt(req.body.capacity, 10)
    });
    console.log('Update successful');
    res.json({ success: true });
  } catch (err) {
    console.log('ERROR in updateEvent:', err.message);
    res.status(400).json({ error: err.message });
  }
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
        institute: ticket.institute_name,
        group: ticket.group_name
      },
      event: ticket.event_title,
      message: '✅ Успешная отметка'
    });
  } catch (err) {
    res.json({ valid: false, message: err.message });
  }
});
// Обновление профиля пользователя
router.post('/users/update', validateInitData, (req, res) => {
  const { full_name, institute, group_name, role } = req.body;
  try {
    db.updateUserProfile(req.userId, { full_name, institute, group_name, role });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


module.exports = router;