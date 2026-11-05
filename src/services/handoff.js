import { supabase } from './supabase.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { logger } from '../utils/logger.js';

const HANDOFF_TRIGGERS = [
  'humano', 'persona', 'hablar con el dueño', 'hablar con alguien',
  'reclamo', 'estafa', 'queja', 'gerente', 'responsable', 'asesor',
  'hablar con alguien', 'operador', 'representante',
];

export function checkHandoffTriggers(text) {
  const lower = text.toLowerCase();
  return HANDOFF_TRIGGERS.some(trigger => lower.includes(trigger));
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
      })
      .eq('id', conversation.id);

    // 2. Informar al cliente
    await sendWhatsAppMessage(
      business,
      fromPhone,
      '¡Perfecto! Te estoy conectando con un asesor humano ahora mismo. En breve alguien de nuestro equipo te atenderá. 🙏'
    );

    // 3. Notificar al dueño del negocio
    if (business.owner_phone) {
      const cleanOwner = String(business.owner_phone).replace(/\D/g, '');
      await sendWhatsAppMessage(
        business,
        cleanOwner,
        `🚨 *ALERTA ChatFlow AI*\n\nEl cliente *${contact.full_name ?? contact.phone}* necesita atención humana.\n📱 Número: +${contact.phone}\n\nResponde directamente por WhatsApp.`
      );
    }

    logger.warn(`Handoff activado — conversación ${conversation.id}, contacto ${contact.phone}`);
  } catch (err) {
    logger.error('Error en handoff:', err.message);
  }
}
