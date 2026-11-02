import { Router } from 'express';
import { verifySignature } from '../middleware/verify-signature.js';
import { handleIncomingMessage } from '../services/openai.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import { getBusinessByPhone, upsertContact, getOrCreateConversation } from '../services/supabase.js';
import { checkHandoffTriggers, triggerHumanHandoff } from '../services/handoff.js';
import { logger } from '../utils/logger.js';

const router = Router();

// ── GET: Verificación del Webhook (Meta llama esto al registrar)
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('Webhook verificado por Meta ✅');
    return res.status(200).send(challenge);
  }
  logger.warn('Verificación fallida — token incorrecto');
  return res.sendStatus(403);
});

// ── POST: Recepción de mensajes entrantes
router.post('/', verifySignature, async (req, res) => {
  // Responder 200 de inmediato para que Meta no reintente
  res.sendStatus(200);

  try {
    const body = JSON.parse(req.body.toString());
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;

        const value   = change.value;
        const message = value?.messages?.[0];
        if (!message || message.type !== 'text') continue;

        const waMessageId   = message.id;
        const fromPhone     = message.from;
        const businessPhone = value.metadata?.display_phone_number;
        const userText      = message.text.body.trim();

        logger.info(`Mensaje de ${fromPhone}: "${userText}"`);

        // 1. Identificar negocio
        const business = await getBusinessByPhone(businessPhone);
        if (!business) {
          logger.warn(`Negocio no encontrado para número ${businessPhone}`);
          continue;
        }

        // 2. Upsert contacto
        const contact = await upsertContact(business.id, fromPhone);

        // 3. Obtener/crear conversación
        const conversation = await getOrCreateConversation(business.id, contact.id, waMessageId);

        // Si está en modo humano, el bot no responde
        if (conversation.status === 'human_takeover') {
          logger.info(`Conversación ${conversation.id} en modo humano — bot pausado`);
          continue;
        }

        // 4. Verificar si el usuario pide hablar con un humano
        if (checkHandoffTriggers(userText)) {
          await triggerHumanHandoff(business, conversation, contact, fromPhone);
          continue;
        }

        // 5. Fallback de latencia: si la IA tarda más de 4.5s, avisa al usuario
        const fallbackTimer = setTimeout(async () => {
          try {
            await sendWhatsAppMessage(business, fromPhone,
              '¡Hola! Dame un segundo, estoy consultando la agenda para darte la mejor opción... ⏳'
            );
          } catch (e) { /* no crítico */ }
        }, 4500);

        // 6. Llamar al motor de IA
        const aiResponse = await handleIncomingMessage({
          business,
          contact,
          conversation,
          userText,
          waMessageId,
        });

        clearTimeout(fallbackTimer);

        // 7. Enviar respuesta al cliente
        if (aiResponse) {
          await sendWhatsAppMessage(business, fromPhone, aiResponse);
        }
      }
    }
  } catch (err) {
    logger.error('Error procesando webhook:', err.message);
  }
});

export default router;
