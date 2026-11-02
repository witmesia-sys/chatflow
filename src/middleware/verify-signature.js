import crypto from 'crypto';

/**
 * Valida la firma HMAC-SHA256 que Meta adjunta en cada POST al webhook.
 * Rechaza cualquier petición que no provenga de Meta.
 *
 * Cabecera verificada: X-Hub-Signature-256: sha256=<hex>
 */
export function verifySignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];

  if (!signature) {
    return res.status(401).json({ error: 'Missing X-Hub-Signature-256 header' });
  }

  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(req.body)
    .digest('hex');

  // Comparación segura (evita timing attacks)
  const sigBuffer      = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}
