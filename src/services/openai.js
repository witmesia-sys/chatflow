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
Tu misión: responder de forma CONCISA, natural y humana (máximo 2 a 3 frases, estilo WhatsApp), guiando al cliente a resolver dudas y reservar.

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
5. AGENDAMIENTO: Cuando el cliente quiera reservar o diga "para mañana", "el viernes", etc.:
   - Valida que esté dentro de nuestro HORARIO DE ATENCIÓN.
   - Pregunta la hora preferida y su nombre completo si no lo sabes todavía.
   - Una vez te dé la hora y nombre, confirma la cita con calidez.`;
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

  try {
    const modelOptions = {
      model:             MODEL,
      systemInstruction: systemPrompt,
    };
    if (isGCalActive) {
      modelOptions.tools = TOOLS;
    }

    const model  = genAI.getGenerativeModel(modelOptions);
    const chat   = model.startChat({ history: geminiHistory });
    const result = await chat.sendMessage(userText);
    const resp   = result.response;

    totalTokens = resp.usageMetadata?.totalTokenCount ?? 0;

    // Verificar si hay function calls (solo si Google Calendar está configurado)
    const fnCall = resp.functionCalls()?.[0];

    if (fnCall && isGCalActive) {
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
