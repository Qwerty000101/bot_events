async function sendTicketConfirmation(bot, userId, eventTitle, qrBuffer) {
    try {
        // Используем bot.api.uploadImage с буфером
        const attachment = await bot.api.uploadImage({ 
            source: qrBuffer, // Передаём Buffer напрямую
            filename: `qr_${Date.now()}.png`
        });
        
        const imagePayload = attachment.toJson();

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
        await bot.api.sendMessageToUser(
            userId,
            `✅ **Вы зарегистрированы!**\nМероприятие: *${eventTitle}*\n\n⚠️ QR-код не удалось загрузить. Попробуйте получить его снова из меню «Мои билеты».`,
            { format: 'markdown' }
        );
    }
}
module.exports = { sendTicketConfirmation };