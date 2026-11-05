import { Router } from 'express';
import { verifySignature } from '../middleware/verify-signature.js';
import { handleIncomingMessage } from '../services/openai.js';
import { sendWhatsAppMessage, sendWhatsAppButtons } from '../services/whatsapp.js';
import { getBusinessByPhone, upsertContact, getOrCreateConversation, supabase } from '../services/supabase.js';
import { checkHandoffTriggers, triggerHumanHandoff } from '../services/handoff.js';
import { handleOwnerCommand } from '../services/ownerCommands.js';
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
        if (!message) continue;

        let userText = '';
        if (message.type === 'text') {
          userText = message.text?.body?.trim() || '';
        } else if (message.type === 'interactive') {
          userText = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
        } else {
          continue;
        }

        if (!userText) continue;

        const waMessageId   = message.id;
        const fromPhone     = message.from;
        const businessPhone = value.metadata?.display_phone_number;

        logger.info(`Mensaje [${message.type}] de ${fromPhone}: "${userText}"`);

        // 1. Identificar negocio
        const business = await getBusinessByPhone(businessPhone);
        if (!business) {
          logger.warn(`Negocio no encontrado para número ${businessPhone}`);
          continue;
        }

        // 🔒 KILL SWITCH: Verificar estado de suscripción
        if (business.subscription_status === 'suspended') {
          logger.warn(`Negocio ${business.name} SUSPENDIDO — bot bloqueado`);
          await sendWhatsAppMessage(business, fromPhone,
            '⚠️ El servicio de este número no está disponible en este momento. Por favor contacta directamente al negocio.'
          );
          continue;
        }

        // ⚠️ OVERDUE: Bot funciona pero registra alerta
        if (business.subscription_status === 'overdue') {
          logger.warn(`Negocio ${business.name} con pago PENDIENTE — bot activo pero alertado`);
        }

        // 2. Upsert contacto
        const contact = await upsertContact(business.id, fromPhone);

        // 3. Obtener/crear conversación
        const conversation = await getOrCreateConversation(business.id, contact.id, waMessageId);

        // 4. Interceptar Comandos del Dueño por WhatsApp (#bot, #citas, #agotar, #disponible, #bloquear, #ayuda)
        const cleanFrom  = String(fromPhone).replace(/\D/g, '');
        const cleanOwner = String(business.owner_phone || '').replace(/\D/g, '');
        const isOwner    = cleanOwner && (cleanFrom === cleanOwner || cleanFrom.endsWith(cleanOwner) || cleanOwner.endsWith(cleanFrom));

        if (isOwner && (userText.startsWith('#') || userText.startsWith('!'))) {
          logger.info(`Comando de dueño recibido de ${fromPhone}: ${userText}`);
          const ownerReply = await handleOwnerCommand(business, userText.trim());
          if (ownerReply) {
            await sendWhatsAppMessage(business, fromPhone, ownerReply);
            continue;
          }
        }

        // 5. Gestión Inteligente de Modo Humano (Auto-reactivación tras 30 min o saludo)
        if (conversation.status === 'human_takeover') {
          const HANDOFF_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos
          const lastUpdated = new Date(conversation.updated_at || conversation.created_at).getTime();
          const timeSinceUpdate = Date.now() - lastUpdated;
          const isReactivation = userText.toLowerCase().match(/^(#bot|!bot|bot|reactivar|#activar|asistente|hola|buenos d[ií]as|buenas tardes|buenas noches|buenas|hey)/i);

          if (timeSinceUpdate > HANDOFF_TIMEOUT_MS || isReactivation) {
            logger.info(`Reactivando bot automáticamente para conversación ${conversation.id} (${Math.round(timeSinceUpdate / 60000)} min transcurridos)`);
            await supabase
              .from('conversations')
              .update({ status: 'bot_active', alert_level: null, handoff_reason: null, updated_at: new Date().toISOString() })
              .eq('id', conversation.id);
            conversation.status = 'bot_active';
          } else {
            logger.info(`Conversación ${conversation.id} en modo humano (${Math.round(timeSinceUpdate / 60000)} min transcurridos) — bot en pausa`);
            continue;
          }
        }

        // 6. Verificar si el usuario solicita asesor humano
        if (checkHandoffTriggers(userText)) {
          await triggerHumanHandoff(business, conversation, contact, fromPhone);
          continue;
        }

        // 7. Llamar al motor de IA
        const aiResponse = await handleIncomingMessage({
          business,
          contact,
          conversation,
          userText,
          waMessageId,
        });

        // 6. Enviar respuesta al cliente con soporte de Botones Interactivos
        if (aiResponse) {
          const lowerUser = userText.toLowerCase();
          const isGreetingOrGeneral = lowerUser.match(/^(hola|buenas|buen dia|que tal|menu|servicios|precios|info|ayuda)/i);
          const isBookingIntent = lowerUser.includes('agendar') || lowerUser.includes('reservar') || lowerUser.includes('cita');

          if (isGreetingOrGeneral && !isBookingIntent && !aiResponse.includes('COMPROBANTE DE RESERVA')) {
            await sendWhatsAppButtons(
              business,
              fromPhone,
              aiResponse,
              ['📅 Agendar Cita', '✂️ Precios / Servicios', '📍 Ubicación']
            );
          } else {
            await sendWhatsAppMessage(business, fromPhone, aiResponse);
          }
        }
      }
    }
  } catch (err) {
    logger.error('Error procesando webhook:', err.message);
  }
});

export default router;
