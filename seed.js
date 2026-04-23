// seed.js – наполнение базы тестовыми данными
const db = require('./db');

console.log('🌱 Начинаем заполнение базы...');

// 1. Создаём или обновляем тестового пользователя (ID 123456)
db.createOrUpdateUser(123456, {
  full_name: 'Организатор Тестовый',
  institute: 'ИИТ',
  group_name: 'ПМИ-21-1'
});
console.log('✅ Пользователь 123456 готов');

// (Опционально) Назначить роль moderator – если в db.js есть метод updateUserRole.
// Если метода нет, можно выполнить прямой запрос, раскомментировав строки ниже.
/*
const Database = require('better-sqlite3');
const dbRaw = new Database('ncfu_events.db');
dbRaw.prepare('UPDATE users SET role = ? WHERE user_id = ?').run('moderator', 123456);
console.log('✅ Роль "moderator" установлена для пользователя 123456');
*/

// 2. Массив мероприятий
const events = [
  {
    title: 'Хакатон MAX 2026',
    description: 'Создайте своё мини-приложение за 48 часов. Призы и подарки!',
    category: 'science',
    institute_filter: null,
    location: 'Коворкинг "Точка кипения", 2 этаж',
    geo_coords: null,
    event_date: '2026-05-15',
    event_time: '10:00',
    capacity: 30,
    organizer_user_id: 123456
  },
  {
    title: 'Спортивный фестиваль СКФУ',
    description: 'Соревнования по волейболу, баскетболу и мини-футболу',
    category: 'sport',
    institute_filter: 'ИФКСиТ',
    location: 'Спорткомплекс СКФУ',
    geo_coords: null,
    event_date: '2026-05-20',
    event_time: '14:00',
    capacity: 50,
    organizer_user_id: 123456
  },
  {
    title: 'Культурный вечер "Голос университета"',
    description: 'Концерт творческих коллективов СКФУ',
    category: 'culture',
    institute_filter: null,
    location: 'Актовый зал главного корпуса',
    geo_coords: null,
    event_date: '2026-05-25',
    event_time: '18:00',
    capacity: 100,
    organizer_user_id: 123456
  },
  {
    title: 'Лекция по искусственному интеллекту',
    description: 'Приглашённый эксперт из Яндекса расскажет о современных трендах',
    category: 'science',
    institute_filter: 'ИИТ',
    location: 'Аудитория 305, корпус 9',
    geo_coords: null,
    event_date: '2026-05-18',
    event_time: '12:00',
    capacity: 40,
    organizer_user_id: 123456
  }
];

// 3. Добавляем мероприятия в цикле
for (const eventData of events) {
  try {
    const id = db.createEvent(eventData);
    console.log(`✅ Мероприятие: "${eventData.title}" (ID: ${id})`);
  } catch (error) {
    console.error(`❌ Ошибка добавления "${eventData.title}":`, error.message);
  }
}

console.log('🏁 Готово! Теперь в мини-приложении появятся тестовые события.');