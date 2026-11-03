import axios from 'axios';
import { logger } from '../utils/logger.js';

const META_API_BASE = 'https://graph.facebook.com/v21.0';

export async function sendWhatsAppMessage(business, toPhone, text) {
  // Usa el token del negocio si está disponible, si no cae al token del .env
  const token   = business._wa_token ?? process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = business.whatsapp_phone_id ?? process.env.WHATSAPP_PHONE_NUMBER_ID;

  try {
    const res = await axios.post(
      `${META_API_BASE}/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:                toPhone,
        type:              'text',
        text:              { preview_url: false, body: text },
      },
      {
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const errorData = err.response?.data?.error;
    if (status === 401 || errorData?.code === 190) {
      logger.error(`🚨 [WHATSAPP_TOKEN_EXPIRED] El token de Meta WhatsApp ha expirado (Código ${errorData?.code || 190}). Mensaje para ${toPhone} no enviado.`);
    } else {
      logger.error(`🚨 [WHATSAPP_SEND_ERROR]`, errorData || err.message);
    }
    throw err;
  }
}
