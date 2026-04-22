const QRCode = require('qrcode');

async function generateQRCodeBuffer(uuid) {
  try {
    // Генерируем data URL (можно отправить как фото)
    const dataUrl = await QRCode.toDataURL(uuid, {
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
    // Для отправки через API бота преобразуем dataUrl в Buffer
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    return Buffer.from(base64Data, 'base64');
  } catch (err) {
    console.error('Ошибка генерации QR:', err);
    throw err;
  }
}

module.exports = { generateQRCodeBuffer };