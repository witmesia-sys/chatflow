/**
 * Motor de Detección de Anomalías y Filtro Inteligente (Smart Guardrails)
 */
const INJECTION_PATTERNS = [
  /ignore (all )?previous instructions/i,
  /olvida (todas )?las instrucciones/i,
  /eres ahora/i,
  /you are now/i,
  /jailbreak/i,
  /dan mode/i,
  /system prompt/i,
  /regala todo/i,
  /todo gratis/i,
  /precios? en 0/i,
  /pago móvil falso/i,
];

const OFFENSIVE_PATTERNS = [
  /\b(estafa|scam|fraude|hack|porno|sexo|drogas?)\b/i,
];

export function evaluateAnomalies(updates = {}, currentBusiness = {}) {
  const flags = [];

  const servicesText = String(updates.services_text || updates.knowledge_text || '');
  if (servicesText) {
    const zeroPriceMatch = servicesText.match(/\$\s*0(\.00?)?\b|\b0\s*\$|\bgratis\b/i);
    if (zeroPriceMatch) {
      flags.push({
        type: 'PRICE_ZERO',
        message: `Se detectó un precio en $0.00 o indicado como "gratis" en los servicios.`,
        severity: 'high'
      });
    }

    const highPriceMatch = servicesText.match(/\$\s*(\d{3,})/g);
    if (highPriceMatch) {
      for (const m of highPriceMatch) {
        const val = parseFloat(m.replace(/\D/g, ''));
        if (val >= 600) {
          flags.push({
            type: 'PRICE_EXTREME',
            message: `Precio inusualmente alto detectado: $${val}. Posible error de tipeo.`,
            severity: 'medium'
          });
          break;
        }
      }
    }
  }

  if (currentBusiness.knowledge_base_length && currentBusiness.knowledge_base_length > 100) {
    if (servicesText.trim().length > 0 && servicesText.trim().length < 15) {
      flags.push({
        type: 'MASSIVE_DELETION',
        message: `El catálogo anterior tenía información completa y ahora se redujo a menos de 15 caracteres. Posible borrado accidental.`,
        severity: 'medium'
      });
    }
  }

  const allText = `${updates.name || ''} ${updates.notes || ''} ${servicesText} ${updates.policies || ''} ${updates.bot_name || ''}`;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(allText)) {
      flags.push({
        type: 'PROMPT_INJECTION',
        message: `Se detectó un texto sospechoso de manipulación o alteración de instrucciones de la IA.`,
        severity: 'high'
      });
      break;
    }
  }

  for (const pattern of OFFENSIVE_PATTERNS) {
    if (pattern.test(allText)) {
      flags.push({
        type: 'INAPPROPRIATE_CONTENT',
        message: `Se detectaron términos restringidos o inapropiados para un catálogo comercial.`,
        severity: 'high'
      });
      break;
    }
  }

  if (updates.owner_phone) {
    const cleanPhone = String(updates.owner_phone).replace(/\D/g, '');
    if (cleanPhone.length < 8 || cleanPhone.length > 15) {
      flags.push({
        type: 'INVALID_PHONE',
        message: `El número de WhatsApp para alertas (${updates.owner_phone}) tiene una longitud anormal (${cleanPhone.length} dígitos).`,
        severity: 'medium'
      });
    }
  }

  return {
    isAnomaly: flags.length > 0,
    hasHighSeverity: flags.some(f => f.severity === 'high'),
    reasons: flags.map(f => f.message),
    flags
  };
}
