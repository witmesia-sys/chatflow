/**
 * Servicio de IA usando Groq API (compatible con OpenAI).
 * Groq no tiene restricciones geográficas — funciona desde Venezuela.
 * Modelo: llama-3.3-70b-versatile con soporte de function calling.
 */
import OpenAI from 'openai';
import { getKnowledgeBase, saveMessage, logUsage } from './supabase.js';
import { checkCalendarAvailability, createCalendarEvent } from './calendar.js';
import { logger } from '../utils/logger.js';

// Cliente OpenAI apuntando al endpoint de Groq
const groq = new OpenAI({
  apiKey:  process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

const MODEL = process.env.AI_MODEL ?? 'llama-3.3-70b-versatile';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'check_availability',
      description: 'Consulta los próximos slots disponibles en Google Calendar del negocio',
      parameters: {
        type: 'object',
        properties: {
          service:        { type: 'string', description: 'Nombre del servicio solicitado' },
          preferred_date: { type: 'string', description: 'Fecha preferida en ISO 8601 (opcional)' },
        },
        required: ['service'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_appointment',
      description: 'Crea una cita en Google Calendar y la registra en la base de datos',
      parameters: {
        type: 'object',
        properties: {
          contact_name:  { type: 'string', description: 'Nombre completo del cliente' },
          contact_phone: { type: 'string', description: 'Teléfono del cliente' },
          service:       { type: 'string', description: 'Nombre del servicio' },
          datetime_iso:  { type: 'string', description: 'Fecha y hora exacta en ISO 8601' },
        },
        required: ['contact_name', 'service', 'datetime_iso'],
      },
    },
  },
];

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
  // Guardar mensaje del usuario
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

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user',   content: userText },
  ];

  let response    = null;
  let totalTokens = 0;

  try {
    const completion = await groq.chat.completions.create({
      model:       MODEL,
      messages,
      tools:       TOOLS,
      tool_choice: 'auto',
      max_tokens:  300,
      temperature: 0.4,
    });

    const choice = completion.choices[0];
    totalTokens  = completion.usage?.total_tokens ?? 0;

    if (choice.finish_reason === 'tool_calls') {
      const toolCall = choice.message.tool_calls[0];
      const args     = JSON.parse(toolCall.function.arguments);
      let toolResult = {};

      if (toolCall.function.name === 'check_availability') {
        toolResult = await checkCalendarAvailability(business, args.service, args.preferred_date);
      } else if (toolCall.function.name === 'create_appointment') {
        toolResult = await createCalendarEvent(business, contact, args);
      }

      const followUp = await groq.chat.completions.create({
        model:    MODEL,
        messages: [
          ...messages,
          choice.message,
          { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(toolResult) },
        ],
        max_tokens:  200,
        temperature: 0.4,
      });

      response     = followUp.choices[0].message.content;
      totalTokens += followUp.usage?.total_tokens ?? 0;
    } else {
      response = choice.message.content;
    }
  } catch (err) {
    logger.error('Error en Groq AI:', err.message);
    response = 'En este momento tengo un inconveniente técnico. Por favor intenta en unos minutos o escribe "humano" para hablar con un asesor.';
  }

  // Guardar respuesta del asistente
  await saveMessage({
    conversationId: conversation.id,
    businessId:     business.id,
    role:           'assistant',
    content:        response,
  });

  await logUsage(business.id, 'ai_call', totalTokens);

  return response;
}
