import { supabase } from './supabase.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { logger } from '../utils/logger.js';

const HANDOFF_REGEXES = [
  /\b(humano|humana)\b/i,
  /\bhablar con (un|una|el|la|alguien)?\s*(persona|humano|dueño|dueña|asesor|gerente|responsable|encargado)/i,
  /\b(atenci[oó]n (al cliente|personalizada|humana))\b/i,
  /\b(asesor human[oa]|agente human[oa]|persona real)\b/i,
  /\b(pasar|p[aá]same|comunicar|comun[ií]came|transferir|conectar)\s*(con|a)?\s*(un|una|el|la)?\s*(asesor|humano|persona|operador|dueño|dueña)/i,
  /\b(operador|representante|gerente)\b/i,
  /\b(reclamo|estafa|queja formal)\b/i,
  /^(asesor|persona|ayuda humana)$/i
];

export function checkHandoffTriggers(text) {
  if (!text) return false;
  const lower = text.trim();
  return HANDOFF_REGEXES.some(regex => regex.test(lower));
}

export async function triggerHumanHandoff(business, conversation, contact, fromPhone) {
  try {
    // 1. Pausar el bot para este chat
    await supabase
      .from('conversations')
      .update({
        status:         'human_takeover',
        alert_level:    'red',
        handoff_reason: 'trigger_keyword',
        updated_at:     new Date().toISOString(),
      })
      .eq('id', conversation.id);

    // 2. Informar al cliente
    await sendWhatsAppMessage(
      business,
      fromPhone,
      '¡Perfecto! Te estoy conectando con un asesor humano ahora mismo. En breve alguien de nuestro equipo te atenderá. 🙏\n\n_(Para reactivar al asistente virtual en cualquier momento, escribe *#bot*)_'
    );

    // 3. Notificar al dueño del negocio (solo si es un número distinto al del cliente)
    if (business.owner_phone) {
      const cleanOwner = String(business.owner_phone).replace(/\D/g, '');
      const cleanFrom  = String(fromPhone).replace(/\D/g, '');
      if (cleanOwner && cleanOwner !== cleanFrom) {
        await sendWhatsAppMessage(
          business,
          cleanOwner,
          `🚨 *ALERTA ChatFlow AI*\n\nEl cliente *${contact.full_name ?? contact.phone}* necesita atención humana.\n📱 Número: +${contact.phone}\n\nResponde directamente por WhatsApp.`
        );
      }
    }

    logger.warn(`Handoff activado — conversación ${conversation.id}, contacto ${contact.phone}`);
  } catch (err) {
    logger.error('Error en handoff:', err.message);
  }
}
