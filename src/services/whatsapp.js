import axios from 'axios';

const META_API_BASE = 'https://graph.facebook.com/v21.0';

export async function sendWhatsAppMessage(business, toPhone, text) {
  // Usa el token del negocio si está disponible, si no cae al token del .env
  const token   = business._wa_token ?? process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = business.whatsapp_phone_id ?? process.env.WHATSAPP_PHONE_NUMBER_ID;

  await axios.post(
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
}
