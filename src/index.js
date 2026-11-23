import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import webhookRouter from './routes/webhook.js';
import portalRouter from './routes/portal.js';
import { logger } from './utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// Servir archivos estáticos (incluye carpeta public/uploads para imágenes de catálogo)
app.use(express.static(join(__dirname, '..', 'public')));

// Raw body para validación HMAC de Meta (debe ir ANTES del json middleware)
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '25mb' }));

app.use('/webhook', webhookRouter);
app.use('/', portalRouter);

// Ruta raíz amigable para evitar "Cannot GET /" al abrir en navegador
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>ChatFlow AI — Webhook Engine</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 32px; max-width: 480px; width: 90%; text-align: center; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
    h1 { font-size: 24px; margin-bottom: 8px; color: #38bdf8; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.5; margin-bottom: 24px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid rgba(34,197,94,0.3); padding: 6px 14px; border-radius: 9999px; font-size: 12px; font-weight: 600; margin-bottom: 20px; }
    .btn { display: block; background: #2563eb; color: #fff; text-decoration: none; padding: 12px 20px; border-radius: 10px; font-weight: 600; font-size: 14px; transition: background 0.2s; margin-bottom: 12px; }
    .btn:hover { background: #1d4ed8; }
    .btn-secondary { background: #334155; color: #e2e8f0; }
    .btn-secondary:hover { background: #475569; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">🟢 Servidor Activo (Puerto ${PORT})</div>
    <h1>🤖 ChatFlow AI Engine</h1>
    <p>Este es el motor que procesa los mensajes de WhatsApp y la Inteligencia Artificial. Para administrar clientes, precios y ver métricas, usa el Panel Maestro:</p>
    <a href="http://localhost:4000" class="btn">🎛️ Abrir Panel Maestro (Puerto 4000)</a>
    <a href="/health" class="btn btn-secondary">🩺 Ver Estado del Servidor (/health)</a>
  </div>
</body>
</html>`);
});

app.get('/health', (_, res) => res.json({
  status: 'ok',
  ts: new Date().toISOString(),
  env: {
    supabase:  !!process.env.SUPABASE_URL,
    openai:    !!process.env.OPENAI_API_KEY,
    whatsapp:  !!process.env.WHATSAPP_ACCESS_TOKEN,
  }
}));

app.listen(PORT, () => {
  logger.info(`ChatFlow AI Webhook corriendo en http://localhost:${PORT}`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
});
