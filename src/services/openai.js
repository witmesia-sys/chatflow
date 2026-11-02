/**
 * Servicio de IA usando Google Gemini API (SDK oficial).
 * Gemini 1.5 Flash: 1 millón de tokens gratis por día, sin restricciones geo.
 * El servidor corre en EEUU (Render), así que no hay bloqueo desde Venezuela.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getKnowledgeBase, saveMessage, logUsage } from './supabase.js';
import { checkCalendarAvailability, createCalendarEvent } from './calendar.js';
import { logger } from '../utils/logger.js';

const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
// gemini-2.0-flash-exp es el modelo gratuito más estable actualmente
const MODEL  = process.env.AI_MODEL ?? 'gemini-2.0-flash-exp';

// Herramientas en formato Gemini Function Calling
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
Tu misión: responder dudas de forma CONCISA (máximo 2 frases, estilo WhatsApp), guiar activamente al usuario a agendar una cita o reservar un servicio.

TONO: ${tone}

BASE DE CONOCIMIENTO:
${knowledge}

HORARIO DE ATENCIÓN: ${JSON.stringify(business.business_hours ?? 'No especificado')}
ZONA HORARIA: ${business.timezone}

REGLAS (NUNCA las rompas):
1. DOMAIN LOCK: Si preguntan por temas ajenos al negocio, responde: "Estoy aquí exclusivamente para ayudarte con información sobre nuestros servicios y agendar tu cita. ¿En qué puedo ayudarte?"
2. CERO INVENTOS DE PRECIOS: Si preguntan por un precio no registrado, responde: "Prefiero comunicarte con un asesor humano para darte esa cotización exacta." No inventes precios.
3. BREVEDAD: Máximo 2 frases por respuesta.
4. AGENDAMIENTO: Cuando el cliente quiera una cita, usa check_availability para ofrecer exactamente 2 opciones. Luego usa create_appointment para confirmar.`;
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

  try {
    const model = genAI.getGenerativeModel({
      model:            MODEL,
      systemInstruction: systemPrompt,
      tools:            TOOLS,
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

      if (fnCall.name === 'check_availability') {
        toolResult = await checkCalendarAvailability(business, fnCall.args.service, fnCall.args.preferred_date);
      } else if (fnCall.name === 'create_appointment') {
        toolResult = await createCalendarEvent(business, contact, fnCall.args);
      }

      const followUp = await chat.sendMessage([{
        functionResponse: { name: fnCall.name, response: toolResult },
      }]);

      response     = followUp.response.text();
      totalTokens += followUp.response.usageMetadata?.totalTokenCount ?? 0;
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
