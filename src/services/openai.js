/**
 * Servicio de IA usando Google Gemini API (SDK oficial).
 * Gemini 1.5 Flash: 1 millón de tokens gratis por día, sin restricciones geo.
 * El servidor corre en EEUU (Render), así que no hay bloqueo desde Venezuela.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getKnowledgeBase, saveMessage, logUsage, supabase } from './supabase.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { checkCalendarAvailability, createCalendarEvent } from './calendar.js';
import { logger } from '../utils/logger.js';

const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
// gemini-2.0-flash-exp es el modelo gratuito más estable actualmente
const MODEL  = process.env.AI_MODEL ?? 'gemini-2.0-flash-exp';

// Herramienta nativa de emisión de ticket y alerta al dueño
const BOOKING_TOOL = [{
  functionDeclarations: [
    {
      name: 'register_and_confirm_booking',
      description: 'Genera el comprobante/ticket oficial de la reserva y notifica al dueño del negocio cuando el cliente ya ha confirmado el servicio, su nombre y la hora acordada.',
      parameters: {
        type: 'OBJECT',
        properties: {
          client_name:   { type: 'STRING', description: 'Nombre completo o nombre del cliente' },
          service_name:  { type: 'STRING', description: 'Nombre del servicio solicitado (ej. Corte clásico, Degradado, etc.)' },
          price:         { type: 'STRING', description: 'Precio del servicio si se conoce (ej. $10)' },
          datetime_text: { type: 'STRING', description: 'Fecha y hora pactada (ej. Mañana a las 10:00 AM)' }
        },
        required: ['client_name', 'service_name', 'datetime_text']
      }
    }
  ]
}];

// Herramientas de Google Calendar (opcionales si GCal está configurado)
const TOOLS = [{
  functionDeclarations: [
    {
      name: 'check_availability',
      description: 'Consulta los próximos slots disponibles en Google Calendar del negocio',
      parameters: {
        type: 'OBJECT',
        properties: {
          service:        { type: 'STRING', description: 'Nombre del servicio solicitado' },
          preferred_date: { type: 'STRING', description: 'Fecha preferida ISO 8601 (opcional)' },
        },
        required: ['service'],
      },
    },
    {
      name: 'create_appointment',
      description: 'Crea una cita en Google Calendar y la registra en la base de datos',
      parameters: {
        type: 'OBJECT',
        properties: {
          contact_name:  { type: 'STRING', description: 'Nombre completo del cliente' },
          contact_phone: { type: 'STRING', description: 'Teléfono del cliente' },
          service:       { type: 'STRING', description: 'Nombre del servicio' },
          datetime_iso:  { type: 'STRING', description: 'Fecha y hora exacta en ISO 8601' },
        },
        required: ['contact_name', 'service', 'datetime_iso'],
      },
    },
  ],
}];

function buildSystemPrompt(business, knowledgeChunks) {
  const toneMap = {
    professional: 'Sé profesional, formal y preciso.',
    friendly:     'Sé amigable, cálido y usa emojis con moderación 😊.',
    sales:        'Sé persuasivo y orientado a la acción. Siempre invita a reservar.',
    formal:       'Sé formal, respetuoso y usa lenguaje de negocios.',
  };
  const tone      = toneMap[business.ai_tone] ?? toneMap.friendly;
  const knowledge = knowledgeChunks.length > 0
    ? knowledgeChunks.map(k => `[${k.content_type}] ${k.title ?? ''}: ${k.content}`).join('\n')
    : 'No hay información cargada aún. Pide al usuario que contacte directamente al negocio para más detalles.';

  return `Eres el asistente virtual oficial de "${business.name}".
Tu misión: responder de forma CONCISA, natural y humana (máximo 2 a 3 frases, estilo WhatsApp), guiando al cliente a resolver dudas y agendar su cita.

TONO: ${tone}

BASE DE CONOCIMIENTO (SERVICIOS Y PRECIOS):
${knowledge}

HORARIO DE ATENCIÓN: ${JSON.stringify(business.business_hours ?? 'Lunes a Sábado de 9:00 am a 8:00 pm')}
ZONA HORARIA: ${business.timezone}

REGLAS ESTRICTAS DE CONVERSACIÓN:
1. NO REPETIR SALUDOS: Si la conversación ya empezó o el cliente ya saludó antes, NUNCA vuelvas a decir "¡Hola!", "Buen día" ni "Buenas noches". Ve directo a responder lo que pide.
2. DOMAIN LOCK: Si preguntan por temas ajenos al negocio, responde: "Estoy aquí exclusivamente para ayudarte con información sobre nuestros servicios y citas en ${business.name}. ¿En qué te puedo colaborar?"
3. CERO INVENTOS DE PRECIOS: Si preguntan por un precio o servicio no registrado en la base de conocimiento, responde: "Prefiero comunicarte con un asesor para darte esa cotización exacta." No inventes precios.
4. BREVEDAD: Máximo 2 o 3 frases por mensaje. Estilo WhatsApp ágil.
5. PROTOCOLO DE AGENDAMIENTO Y EMISIÓN DE TICKET:
   - Cuando el cliente indique que quiere reservar o mencione un día u hora (ej. "mañana a las 10am"), valida el horario de atención y pregúntale su nombre completo si aún no lo sabes.
   - En el instante en que tengas: 1) El servicio elegido, 2) La fecha y hora pactada, y 3) El nombre del cliente, DEBES EJECUTAR INMEDIATAMENTE la herramienta "register_and_confirm_booking" con esos datos para emitir el ticket formal y alertar al dueño.`;
}

export async function handleIncomingMessage({ business, contact, conversation, userText, waMessageId }) {
  await saveMessage({
    conversationId: conversation.id,
    businessId:     business.id,
    role:           'user',
    content:        userText,
    waMessageId,
  });

  const knowledgeChunks = await getKnowledgeBase(business.id);
  const systemPrompt    = buildSystemPrompt(business, knowledgeChunks);
  const history         = (conversation.context_window ?? []).slice(-10);

  // Convertir historial al formato Gemini (roles: user/model)
  const geminiHistory = history.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  let response    = null;
  let totalTokens = 0;

  const isGCalActive = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_ID !== 'PENDIENTE';
  const activeTools  = isGCalActive ? [...TOOLS, ...BOOKING_TOOL] : BOOKING_TOOL;

  try {
    const model = genAI.getGenerativeModel({
      model:             MODEL,
      systemInstruction: systemPrompt,
      tools:             activeTools,
    });

    const chat   = model.startChat({ history: geminiHistory });
    const result = await chat.sendMessage(userText);
    const resp   = result.response;

    totalTokens = resp.usageMetadata?.totalTokenCount ?? 0;

    // Verificar si hay function calls
    const fnCall = resp.functionCalls()?.[0];

    if (fnCall) {
      logger.info(`Tool call: ${fnCall.name}`, fnCall.args);
      let toolResult = {};

      if (fnCall.name === 'register_and_confirm_booking') {
        const { client_name, service_name, price, datetime_text } = fnCall.args;
        const ticketCode = 'CF-' + Math.floor(1000 + Math.random() * 9000);

        // 1. Comprobante digital para el cliente
        const customerTicket = `🎟️ *COMPROBANTE DE RESERVA #${ticketCode}*
━━━━━━━━━━━━━━━━━━━━━
💈 *Negocio:* ${business.name}
✂️ *Servicio:* ${service_name} ${price ? `(${price})` : ''}
📅 *Fecha/Hora:* ${datetime_text}
👤 *Cliente:* ${client_name}
📍 *Lugar:* ${business.address ?? 'C.C. Las Estrellas, Local 4'}
━━━━━━━━━━━━━━━━━━━━━
⚠️ _Tolerancia de 15 minutos. Si necesitas cancelar o reprogramar, avísanos por este chat._`;

        // 2. Alerta inmediata al WhatsApp del dueño
        const ownerAlert = `🔔 *¡NUEVA CITA REGISTRADA POR EL BOT!*
━━━━━━━━━━━━━━━━━━━━━
💈 *Negocio:* ${business.name}
👤 *Cliente:* ${client_name}
📱 *WhatsApp Cliente:* +${contact.phone}
✂️ *Servicio:* ${service_name} ${price ? `(${price})` : ''}
⏰ *Fecha y Hora:* ${datetime_text}
🎟️ *Ticket:* #${ticketCode}
━━━━━━━━━━━━━━━━━━━━━
_Notificación enviada automáticamente a tu WhatsApp_`;

        if (business.owner_phone) {
          try {
            await sendWhatsAppMessage(business, business.owner_phone, ownerAlert);
            logger.info(`Alerta enviada al dueño: ${business.owner_phone}`);
          } catch (e) {
            logger.warn(`No se pudo enviar alerta al dueño: ${e.message}`);
          }
        }

        // 3. Registrar en Supabase
        try {
          await supabase.rpc('create_appointment', {
            p_business_id:     business.id,
            p_contact_id:      contact.id,
            p_service_name:    service_name,
            p_start_time:      new Date().toISOString(),
            p_end_time:        new Date(Date.now() + 3600000).toISOString(),
            p_idempotency_key: `booking-${ticketCode}-${Date.now()}`,
          });
          if (client_name) {
            await supabase.from('contacts').update({ name: client_name }).eq('id', contact.id);
          }
        } catch (e) {
          logger.warn(`Error registrando cita en DB: ${e.message}`);
        }

        toolResult = {
          success: true,
          ticket_code: ticketCode,
          confirmation_text: customerTicket,
        };

        const followUp = await chat.sendMessage([{
          functionResponse: {
            name: fnCall.name,
            response: { name: fnCall.name, content: toolResult },
          },
        }]);

        let followText = '';
        try {
          followText = followUp.response.text();
        } catch (e) {
          followText = `¡Listo ${client_name}! Tu turno ha quedado reservado exitosamente.`;
        }

        response = followText.includes(ticketCode)
          ? followText
          : `${followText}\n\n${customerTicket}`;

        totalTokens += followUp.response.usageMetadata?.totalTokenCount ?? 0;
      } else if (fnCall.name === 'check_availability') {
        toolResult = await checkCalendarAvailability(business, fnCall.args.service, fnCall.args.preferred_date);
        const followUp = await chat.sendMessage([{
          functionResponse: { name: fnCall.name, response: { name: fnCall.name, content: toolResult } },
        }]);
        response     = followUp.response.text();
        totalTokens += followUp.response.usageMetadata?.totalTokenCount ?? 0;
      } else if (fnCall.name === 'create_appointment') {
        toolResult = await createCalendarEvent(business, contact, fnCall.args);
        const followUp = await chat.sendMessage([{
          functionResponse: { name: fnCall.name, response: { name: fnCall.name, content: toolResult } },
        }]);
        response     = followUp.response.text();
        totalTokens += followUp.response.usageMetadata?.totalTokenCount ?? 0;
      }
    } else {
      response = resp.text();
    }
  } catch (err) {
    logger.error('Error en Gemini AI:', err.message);
    response = 'En este momento tengo un inconveniente técnico. Por favor intenta en unos minutos o escribe "humano" para hablar con un asesor.';
  }

  await saveMessage({
    conversationId: conversation.id,
    businessId:     business.id,
    role:           'assistant',
    content:        response,
  });

  await logUsage(business.id, 'ai_call', totalTokens);
  return response;
}
