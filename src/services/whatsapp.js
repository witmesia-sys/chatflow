import axios from 'axios';
import { logger } from '../utils/logger.js';

const META_API_BASE = 'https://graph.facebook.com/v21.0';

export async function sendWhatsAppMessage(business, toPhone, text) {
  // Usa el token del negocio (columna o notes) si está disponible, si no cae al token del .env
  const noteToken = business.notes?.match(/wa_token:\s*([^\s;]+)/i)?.[1]?.trim();
  const token   = business._wa_token || business.wa_token || noteToken || process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = (business.whatsapp_phone_id && String(business.whatsapp_phone_id).trim()) || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const cleanTo = String(toPhone).replace(/\D/g, '');

  try {
    const res = await axios.post(
      `${META_API_BASE}/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:                cleanTo,
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
      logger.error(`🚨 [WHATSAPP_TOKEN_EXPIRED] El token de Meta WhatsApp ha expirado (Código ${errorData?.code || 190}). Mensaje para ${cleanTo} no enviado.`);
    } else {
      logger.error(`🚨 [WHATSAPP_SEND_ERROR]`, errorData || err.message);
    }
    throw err;
  }
}

/**
 * Enviar botones interactivos de WhatsApp (hasta 3 botones de respuesta rápida)
 */
export async function sendWhatsAppButtons(business, toPhone, bodyText, buttons = [], headerText = '', footerText = '') {
  const noteToken = business.notes?.match(/wa_token:\s*([^\s;]+)/i)?.[1]?.trim();
  const token   = business._wa_token || business.wa_token || noteToken || process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = (business.whatsapp_phone_id && String(business.whatsapp_phone_id).trim()) || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const cleanTo = String(toPhone).replace(/\D/g, '');

  if (!buttons || buttons.length === 0) {
    return sendWhatsAppMessage(business, cleanTo, bodyText);
  }

  const buttonElements = buttons.slice(0, 3).map((b, i) => {
    const title = typeof b === 'string' ? b : (b.title || `Opción ${i + 1}`);
    const id = typeof b === 'object' && b.id ? b.id : `btn_${i + 1}`;
    return {
      type: 'reply',
      reply: {
        id: id.substring(0, 256),
        title: title.trim().substring(0, 20),
      }
    };
  });

  const interactive = {
    type: 'button',
    body: { text: bodyText },
    action: { buttons: buttonElements }
  };
  if (headerText) interactive.header = { type: 'text', text: headerText.substring(0, 60) };
  if (footerText) interactive.footer = { text: footerText.substring(0, 60) };

  try {
    const res = await axios.post(
      `${META_API_BASE}/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:                cleanTo,
        type:              'interactive',
        interactive,
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
    logger.warn('Fallo envío interactivo con botones, enviando texto regular:', err.response?.data?.error || err.message);
    return sendWhatsAppMessage(business, cleanTo, bodyText);
  }
}

/**
 * Enviar menú desplegable de lista interactiva (List Messages)
 */
export async function sendWhatsAppList(business, toPhone, bodyText, buttonTitle = 'Ver Opciones', sections = [], headerText = '', footerText = '') {
  const noteToken = business.notes?.match(/wa_token:\s*([^\s;]+)/i)?.[1]?.trim();
  const token   = business._wa_token || business.wa_token || noteToken || process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = (business.whatsapp_phone_id && String(business.whatsapp_phone_id).trim()) || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const cleanTo = String(toPhone).replace(/\D/g, '');

  const interactive = {
    type: 'list',
    body: { text: bodyText },
    action: {
      button: buttonTitle.substring(0, 20),
      sections
    }
  };
  if (headerText) interactive.header = { type: 'text', text: headerText.substring(0, 60) };
  if (footerText) interactive.footer = { text: footerText.substring(0, 60) };

  try {
    const res = await axios.post(
      `${META_API_BASE}/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:                cleanTo,
        type:              'interactive',
        interactive,
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
    logger.warn('Fallo envío de lista interactiva, enviando texto regular:', err.response?.data?.error || err.message);
    return sendWhatsAppMessage(business, cleanTo, bodyText);
  }
}
