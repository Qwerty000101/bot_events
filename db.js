const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const db = new Database('ncfu_events.db');

function initDb() {
  console.log('🗃️ Инициализация базы данных...');

  // Таблица пользователей (расширенная информация)
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
  const stmt = db.prepare('SELECT * FROM users WHERE user_id = ?');
  return stmt.get(userId);
}

function createOrUpdateUser(userId, data) {
  const existing = getUser(userId);
  if (!existing) {
    const stmt = db.prepare(`
      INSERT INTO users (user_id, full_name, institute, group_name)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(userId, data.full_name || null, data.institute || null, data.group_name || null);
  } else {
    const stmt = db.prepare(`
      UPDATE users SET full_name = ?, institute = ?, group_name = ? WHERE user_id = ?
    `);
    stmt.run(data.full_name || existing.full_name, data.institute || existing.institute,
             data.group_name || existing.group_name, userId);
  }
  return getUser(userId);
}

// ========== Методы для мероприятий ==========
function getEvents(filters = {}) {
  let query = 'SELECT * FROM events WHERE status = ?';
  const params = ['active'];
  if (filters.category) {
    query += ' AND category = ?';
    params.push(filters.category);
  }
  if (filters.institute) {
    query += ' AND (institute_filter IS NULL OR institute_filter = ?)';
    params.push(filters.institute);
  }
  query += ' ORDER BY event_date ASC, event_time ASC';
  const stmt = db.prepare(query);
  return stmt.all(...params);
}

function getEventById(eventId) {
  const stmt = db.prepare('SELECT * FROM events WHERE id = ?');
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
    SELECT t.*, u.full_name, u.institute, u.group_name, e.title as event_title, e.event_date, e.event_time
    FROM tickets t
    JOIN users u ON t.user_id = u.user_id
    JOIN events e ON t.event_id = e.id
    WHERE t.uuid = ?
  `);
  return stmt.get(uuid);
}

function getUserTickets(userId) {
  const stmt = db.prepare(`
    SELECT t.uuid, t.status, t.created_at, t.checked_in_at,
           e.title, e.event_date, e.event_time, e.location
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

// ========== Экспорт ==========
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
  markTicketAsCheckedIn
};