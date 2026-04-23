async function sendTicketConfirmation(bot, userId, eventTitle, qrBuffer) {
    try {
        // 1. Загружаем изображение на серверы MAX
        // Используем bot.api.uploadImage с буфером
        const attachment = await bot.api.uploadImage({ 
            source: qrBuffer, // Передаём Buffer напрямую
            filename: `qr_${Date.now()}.png`
        });
        
        // 2. Получаем токен из ответа (attachment.toJson() вернёт нужный формат)
        const imagePayload = attachment.toJson();
        
        // 3. Отправляем сообщение с вложением
        await bot.api.sendMessageToUser(
            userId,
            `✅ **Вы зарегистрированы!**
Мероприятие: *${eventTitle}*`,
            {
                format: 'markdown',
                attachments: [imagePayload] 
            }
        );
    } catch (err) {
        console.error(`❌ Ошибка отправки билета пользователю ${userId}:`, err);
        // Дополнительно можно отправить текстовое уведомление, если изображение не прошло
        await bot.api.sendMessageToUser(
            userId,
            `✅ **Вы зарегистрированы!**\nМероприятие: *${eventTitle}*\n\n⚠️ QR-код не удалось загрузить. Попробуйте получить его снова из меню «Мои билеты».`,
            { format: 'markdown' }
        );
    }
}
module.exports = { sendTicketConfirmation };