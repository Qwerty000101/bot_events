const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const db = new Database('ncfu_events.db');

function initDb() {
  console.log('🗃️ Инициализация базы данных...');

  // Таблица пользователей
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      full_name TEXT,
      institute TEXT,
      group_name TEXT,
      role TEXT DEFAULT 'student', -- student, moderator, admin
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Мероприятия
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT,                -- sport, science, culture
      institute_filter TEXT,         -- null или ID института
      location TEXT,
      geo_coords TEXT,               -- "lat,lng"
      event_date DATE NOT NULL,
      event_time TIME NOT NULL,
      capacity INTEGER NOT NULL,
      available_seats INTEGER NOT NULL,
      organizer_user_id INTEGER,
      status TEXT DEFAULT 'active',  -- active, cancelled, finished
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (organizer_user_id) REFERENCES users(user_id)
    )
  `);
    db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL
  )
`);
// Таблица институтов
db.exec(`
  CREATE TABLE IF NOT EXISTS institutes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL
  )
`);

// Предзаполняем, если пусто
const instCount = db.prepare('SELECT COUNT(*) as cnt FROM institutes').get().cnt;
if (instCount === 0) {
  const insert = db.prepare('INSERT INTO institutes (key, name) VALUES (?, ?)');
  const institutesList = [
    ['humanitarian', 'Гуманитарный институт'],
    ['oil_gas', 'Институт нефти и газа'],
    ['it_telecom', 'Институт информационных технологий и телекоммуникаций'],
    ['engineering', 'Институт перспективной инженерии'],
    ['math_natural', 'Институт математики и естественных наук'],
    ['living_systems', 'Институт живых систем'],
    ['economics_management', 'Институт экономики и управления'],
    ['education_social', 'Институт образования и социальных наук'],
    ['law', 'Юридический институт'],
    ['medical_bio', 'Медико-биологический факультет'],
    ['international', 'Факультет международных отношений'],
    ['food_bio', 'Факультет пищевой инженерии и биотехнологий'],
    ['pyatigorsk', 'Пятигорский институт (филиал) СКФУ'],
    ['nevinnomyssk', 'Невинномысский технологический институт (филиал) СКФУ']
  ];
  for (const [key, name] of institutesList) {
    insert.run(key, name);
  }
}
// Предзаполняем категории, если таблица пуста
const count = db.prepare('SELECT COUNT(*) as cnt FROM categories').get().cnt;
if (count === 0) {
  const insert = db.prepare('INSERT INTO categories (key, name) VALUES (?, ?)');
  insert.run('science', 'Наука');
  insert.run('sport', 'Спорт');
  insert.run('culture', 'Культура');
  insert.run('olymp', 'Олимпиада');
  insert.run('other', 'Другое');
  console.log('✅ Категории добавлены');
}
  // Билеты (регистрации)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      event_id INTEGER NOT NULL,
      status TEXT DEFAULT 'registered', -- registered, checked_in, cancelled
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      checked_in_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(user_id),
      FOREIGN KEY (event_id) REFERENCES events(id)
    )
  `);

  // Модераторы мероприятий (связь many-to-many)
  db.exec(`
    CREATE TABLE IF NOT EXISTS moderators (
      user_id INTEGER NOT NULL,
      event_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, event_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id),
      FOREIGN KEY (event_id) REFERENCES events(id)
    )
  `);

  // Отзывы
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_id INTEGER NOT NULL,
      rating INTEGER CHECK(rating >= 1 AND rating <= 5),
      text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(user_id),
      FOREIGN KEY (event_id) REFERENCES events(id)
    )
  `);

  console.log('✅ База данных готова');
}

// ========== Методы для работы с пользователями ==========
function getUser(userId) {
  const stmt = db.prepare(`
    SELECT u.*, i.name as institute_name
    FROM users u
    LEFT JOIN institutes i ON u.institute = i.key
    WHERE u.user_id = ?
  `);
  return stmt.get(userId);
}

function createOrUpdateUser(userId, data) {
  const existing = getUser(userId);
  if (!existing) {
    const stmt = db.prepare(`
      INSERT INTO users (user_id, full_name, institute, group_name, role)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      userId,
      data.full_name || null,
      data.institute || null,
      data.group_name || null,
      data.role || 'student'
    );
  } else {
    const stmt = db.prepare(`
      UPDATE users SET full_name = ?, institute = ?, group_name = ?, role = ? WHERE user_id = ?
    `);
    stmt.run(
      data.full_name || existing.full_name,
      data.institute || existing.institute,
      data.group_name || existing.group_name,
      data.role || existing.role,
      userId
    );
  }
  return getUser(userId);
}

// ========== Методы для мероприятий ==========
function getEvents(filters = {}) {
  let query = `
    SELECT e.*, c.name as category_name, i.name as institute_name
    FROM events e
    LEFT JOIN categories c ON e.category = c.key
    LEFT JOIN institutes i ON e.institute_filter = i.key
    WHERE e.status = ?
  `;
  const params = ['active'];
  if (filters.category) {
    query += ' AND e.category = ?';
    params.push(filters.category);
  }
  if (filters.institute) {
    query += ' AND (e.institute_filter = ? OR e.institute_filter IS NULL)';
    params.push(filters.institute);
  }
  query += ' ORDER BY e.event_date ASC, e.event_time ASC';
  const stmt = db.prepare(query);
  return stmt.all(...params);
}

function getEventById(eventId) {
  const stmt = db.prepare(`
    SELECT e.*, c.name as category_name, i.name as institute_name
    FROM events e
    LEFT JOIN categories c ON e.category = c.key
    LEFT JOIN institutes i ON e.institute_filter = i.key
    WHERE e.id = ?
  `);
  return stmt.get(eventId);
}

function createEvent(data) {
  const stmt = db.prepare(`
    INSERT INTO events (title, description, category, institute_filter, location, geo_coords,
                        event_date, event_time, capacity, available_seats, organizer_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    data.title, data.description, data.category, data.institute_filter,
    data.location, data.geo_coords, data.event_date, data.event_time,
    data.capacity, data.capacity, data.organizer_user_id
  );
  return result.lastInsertRowid;
}

// ========== Методы для билетов ==========
function registerForEvent(userId, eventId) {
  // Проверяем наличие мест
  const event = getEventById(eventId);
  if (!event || event.available_seats <= 0) {
    throw new Error('Нет свободных мест');
  }

  // Проверяем, не зарегистрирован ли уже
  const checkStmt = db.prepare('SELECT id FROM tickets WHERE user_id = ? AND event_id = ? AND status != ?');
  const existing = checkStmt.get(userId, eventId, 'cancelled');
  if (existing) {
    throw new Error('Вы уже зарегистрированы');
  }

  const uuid = uuidv4();
  const ticketStmt = db.prepare(`
    INSERT INTO tickets (uuid, user_id, event_id, status) VALUES (?, ?, ?, ?)
  `);
  ticketStmt.run(uuid, userId, eventId, 'registered');

  // Уменьшаем количество доступных мест
  const updateStmt = db.prepare('UPDATE events SET available_seats = available_seats - 1 WHERE id = ?');
  updateStmt.run(eventId);

  return { uuid, event };
}

function getTicketByUUID(uuid) {
  const stmt = db.prepare(`
    SELECT t.*,
           u.full_name,
           u.group_name,
           i.name as institute_name,
           e.title as event_title,
           e.event_date,
           e.event_time
    FROM tickets t
    JOIN users u ON t.user_id = u.user_id
    JOIN events e ON t.event_id = e.id
    LEFT JOIN institutes i ON u.institute = i.key
    WHERE t.uuid = ?
  `);
  return stmt.get(uuid);
}

function getUserTickets(userId) {
  const stmt = db.prepare(`
    SELECT t.uuid, t.status, t.created_at, t.checked_in_at,
           e.id as event_id, e.title, e.event_date, e.event_time, e.location
    FROM tickets t
    JOIN events e ON t.event_id = e.id
    WHERE t.user_id = ? AND t.status != 'cancelled'
    ORDER BY e.event_date DESC, e.event_time DESC
  `);
  return stmt.all(userId);
}

function markTicketAsCheckedIn(uuid) {
  const ticket = getTicketByUUID(uuid);
  if (!ticket) throw new Error('Билет не найден');
  if (ticket.status === 'checked_in') throw new Error('Билет уже использован');
  if (ticket.status === 'cancelled') throw new Error('Регистрация отменена');

  const stmt = db.prepare(`
    UPDATE tickets SET status = 'checked_in', checked_in_at = CURRENT_TIMESTAMP WHERE uuid = ?
  `);
  stmt.run(uuid);
  return ticket;
}

function updateUserRole(userId, role) {
  const stmt = db.prepare('UPDATE users SET role = ? WHERE user_id = ?');
  return stmt.run(role, userId);
}

// Отмена билета (только для владельца)
function cancelTicket(userId, uuid) {
  const ticket = getTicketByUUID(uuid);
  if (!ticket || ticket.user_id !== userId) {
    throw new Error('Билет не найден или не принадлежит вам');
  }
  if (ticket.status === 'cancelled') {
    throw new Error('Билет уже отменён');
  }

  const updateTicketStmt = db.prepare(`UPDATE tickets SET status = 'cancelled' WHERE uuid = ?`);
  updateTicketStmt.run(uuid);

  // Возвращаем место только если билет был активен (не отмечен)
  if (ticket.status === 'registered') {
    const updateEventStmt = db.prepare(`UPDATE events SET available_seats = available_seats + 1 WHERE id = ?`);
    updateEventStmt.run(ticket.event_id);
  }

  return { event_id: ticket.event_id, changes: 1, previousStatus: ticket.status };
}
// Обновление профиля пользователя (ФИО, институт, группа, роль)
function updateUserProfile(userId, data) {
  const fields = [];
  const values = [];
  
  if (data.full_name !== undefined) { fields.push('full_name = ?'); values.push(data.full_name); }
  if (data.institute !== undefined) { fields.push('institute = ?'); values.push(data.institute); }
  if (data.group_name !== undefined) { fields.push('group_name = ?'); values.push(data.group_name); }
  if (data.role !== undefined) { fields.push('role = ?'); values.push(data.role); }
  
  if (fields.length === 0) return { changes: 0 };
  
  const query = `UPDATE users SET ${fields.join(', ')} WHERE user_id = ?`;
  values.push(userId);
  const stmt = db.prepare(query);
  return stmt.run(...values);
}
// Удаление мероприятия (только для организатора или admin)
function deleteEvent(eventId, userId) {
  // Получаем мероприятие
  const event = getEventById(eventId);
  if (!event) {
    throw new Error('Мероприятие не найдено');
  }

  // Проверяем права: организатор или admin
  const user = getUser(userId);
  if (!user) {
    throw new Error('Пользователь не найден');
  }
  if (event.organizer_user_id !== userId && user.role !== 'admin') {
    throw new Error('У вас нет прав на удаление этого мероприятия');
  }

  // Удаляем связанные билет
  db.prepare('DELETE FROM tickets WHERE event_id = ?').run(eventId);
  // Удаляем связи модераторов
  db.prepare('DELETE FROM moderators WHERE event_id = ?').run(eventId);
  // Удаляем отзывы
  db.prepare('DELETE FROM feedback WHERE event_id = ?').run(eventId);
  // Удаляем само мероприятие
  const stmt = db.prepare('DELETE FROM events WHERE id = ?');
  const result = stmt.run(eventId);
  return result.changes;
}
// Статистика мероприятия для организатора
function getEventStats(eventId, userId) {
  const event = getEventById(eventId);
  if (!event) throw new Error('Мероприятие не найдено');
  
  // Проверяем права
  const user = getUser(userId);
  if (!user) throw new Error('Пользователь не найден');
  if (event.organizer_user_id !== userId && user.role !== 'admin') {
    throw new Error('Нет доступа к статистике');
  }
  
  const stats = {
    total_seats: event.capacity,
    available_seats: event.available_seats,
    registered: 0,
    checked_in: 0
  };
  
  const registeredResult = db.prepare(
    'SELECT COUNT(*) as count FROM tickets WHERE event_id = ? AND status = ?'
  ).get(eventId, 'registered');
  stats.registered = registeredResult.count;
  
  const checkedResult = db.prepare(
    'SELECT COUNT(*) as count FROM tickets WHERE event_id = ? AND status = ?'
  ).get(eventId, 'checked_in');
  stats.checked_in = checkedResult.count;
  
  return stats;
}

// Список участников мероприятия с их статусами
function getEventParticipants(eventId, userId) {
  const event = getEventById(eventId);
  if (!event) throw new Error('Мероприятие не найдено');
  
  const user = getUser(userId);
  if (!user) throw new Error('Пользователь не найден');
  if (event.organizer_user_id !== userId && user.role !== 'admin') {
    throw new Error('Нет доступа к списку участников');
  }
  
  const stmt = db.prepare(`
    SELECT u.full_name, u.group_name, i.name as institute_name,
           t.status, t.uuid, t.checked_in_at
    FROM tickets t
    JOIN users u ON t.user_id = u.user_id
    LEFT JOIN institutes i ON u.institute = i.key
    WHERE t.event_id = ? AND t.status != 'cancelled'
    ORDER BY t.status, u.full_name
  `);
  return stmt.all(eventId);
}

// Получить все категории
function getCategories() {
  return db.prepare('SELECT key, name FROM categories ORDER BY name').all();
}

// Получить название категории по ключу
function getCategoryName(key) {
  const row = db.prepare('SELECT name FROM categories WHERE key = ?').get(key);
  return row ? row.name : key;
}

function getInstitutes() {
  return db.prepare('SELECT key, name FROM institutes ORDER BY name').all();
}

function getInstituteName(key) {
  const row = db.prepare('SELECT name FROM institutes WHERE key = ?').get(key);
  return row ? row.name : key || '—';
}
function updateEvent(eventId, data) {
  const fields = [];
  const values = [];
  if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title); }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
  if (data.category !== undefined) { fields.push('category = ?'); values.push(data.category); }
  if (data.institute_filter !== undefined) { fields.push('institute_filter = ?'); values.push(data.institute_filter); }
  if (data.location !== undefined) { fields.push('location = ?'); values.push(data.location); }
  if (data.event_date !== undefined) { fields.push('event_date = ?'); values.push(data.event_date); }
  if (data.event_time !== undefined) { fields.push('event_time = ?'); values.push(data.event_time); }
  if (data.capacity !== undefined) {
    const current = getEventById(eventId);
    if (current) {
      const diff = data.capacity - current.capacity;
      if (diff < 0 && current.available_seats + diff < 0) throw new Error('Нельзя уменьшить места ниже числа зарегистрированных');
      fields.push('available_seats = available_seats + ?, capacity = ?');
      values.push(diff, data.capacity);
    } else {
      fields.push('capacity = ?');
      values.push(data.capacity);
    }
  }
  if (fields.length === 0) return;
  const query = `UPDATE events SET ${fields.join(', ')} WHERE id = ?`;
  values.push(eventId);
  db.prepare(query).run(...values);
}
module.exports = {
  initDb,
  getUser,
  createOrUpdateUser,
  getEvents,
  getEventById,
  createEvent,
  registerForEvent,
  getTicketByUUID,
  getUserTickets,
  markTicketAsCheckedIn,
  updateUserRole,
  cancelTicket,
  updateUserProfile,
  deleteEvent,
  getEventStats,
  getEventParticipants,
  getCategories, 
  getCategoryName,
  getInstitutes,
  getInstituteName,
  updateEvent
};
