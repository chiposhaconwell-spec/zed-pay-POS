import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth } from './src/middleware/auth.ts';
import type { AuthRequest } from './src/middleware/auth.ts';
import { getOrCreateUser, getUsers } from './src/db/users.ts';
import { pushPosSyncToCloudSql, pullPosSyncFromCloudSql } from './src/db/sync.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '25mb' }));

// Health check endpoint for Cloud Run probes
app.get('/liveness', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

const RECEIPTS_DIR = '/tmp/pos_receipts';
try {
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
} catch {}

function pruneOldReceipts() {
  try {
    const entries = fs.readdirSync(RECEIPTS_DIR).map((name) => {
      const full = path.join(RECEIPTS_DIR, name);
      const stat = fs.statSync(full);
      return { name, full, mtimeMs: stat.mtimeMs };
    });
    if (entries.length > 400) {
      entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const old of entries.slice(400)) {
        try { fs.unlinkSync(old.full); } catch {}
      }
    }
  } catch {}
}

// Serve hosted receipt PDF files with inline PDF headers for direct WhatsApp viewing/download
app.get('/api/receipts/:fileName', (req, res) => {
  try {
    const rawName = String(req.params.fileName || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!rawName || !rawName.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'Invalid receipt PDF identifier' });
    }
    const filePath = path.join(RECEIPTS_DIR, rawName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Receipt PDF not found or expired' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${rawName}"`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(filePath);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to read receipt PDF' });
  }
});

// Store receipt PDF and optionally deliver directly as a PDF document via WhatsApp Business Cloud API
app.post('/api/whatsapp/send-pdf', async (req, res) => {
  try {
    const { phone, filename, pdfBase64, caption } = req.body || {};
    const digitsOnly = String(phone || '').replace(/\D/g, '');
    if (!digitsOnly || digitsOnly.length < 7) {
      return res.status(400).json({ error: 'Valid customer WhatsApp phone number is required' });
    }
    if (!pdfBase64 || typeof pdfBase64 !== 'string') {
      return res.status(400).json({ error: 'Missing compiled PDF receipt payload' });
    }

    const cleanBase64 = pdfBase64.includes(',') ? pdfBase64.split(',')[1] : pdfBase64;
    const pdfBuffer = Buffer.from(cleanBase64, 'base64');
    if (!pdfBuffer.length) {
      return res.status(400).json({ error: 'Empty receipt PDF buffer' });
    }

    const baseSafeName = String(filename || `receipt-${Date.now()}.pdf`)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/\.pdf$/i, '');
    const uniqueToken = `${baseSafeName}-${Date.now().toString(36)}.pdf`;
    fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RECEIPTS_DIR, uniqueToken), pdfBuffer);
    pruneOldReceipts();

    const envAppUrl = process.env.APP_URL && !process.env.APP_URL.includes('MY_APP_URL')
      ? process.env.APP_URL.replace(/\/$/, '')
      : '';
    const forwardedProto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim();
    const proto = forwardedProto || req.protocol || 'https';
    const host = req.get('host');
    const origin = envAppUrl || (host ? `${proto}://${host}` : '');
    const pdfUrl = `${origin}/api/receipts/${uniqueToken}`;

    const waToken = (process.env.WHATSAPP_CLOUD_TOKEN || '').trim();
    const waPhoneId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();

    if (waToken && waPhoneId) {
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', 'application/pdf');
      form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), `${baseSafeName}.pdf`);

      const mediaResp = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(waPhoneId)}/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waToken}` },
        body: form,
      });

      const mediaData: any = await mediaResp.json().catch(() => ({}));
      if (mediaResp.ok && mediaData?.id) {
        const msgResp = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(waPhoneId)}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${waToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: digitsOnly,
            type: 'document',
            document: {
              id: mediaData.id,
              filename: `${baseSafeName}.pdf`,
              caption: caption || `Official PDF Receipt: ${baseSafeName}.pdf`,
            },
          }),
        });
        const msgData: any = await msgResp.json().catch(() => ({}));
        if (msgResp.ok && Array.isArray(msgData?.messages) && msgData.messages.length > 0) {
          return res.json({
            sentDirectly: true,
            messageId: msgData.messages[0].id,
            normalizedPhone: digitsOnly,
            pdfUrl,
            filename: `${baseSafeName}.pdf`,
          });
        }
        console.warn('WhatsApp Cloud API message dispatch failed:', msgData?.error || msgData);
      } else {
        console.warn('WhatsApp Cloud API media upload failed:', mediaData?.error || mediaData);
      }
    }

    return res.json({
      sentDirectly: false,
      normalizedPhone: digitsOnly,
      pdfUrl,
      filename: `${baseSafeName}.pdf`,
    });
  } catch (error: any) {
    console.error('WhatsApp PDF dispatch error:', error);
    return res.status(500).json({ error: error?.message || 'Failed to prepare WhatsApp PDF receipt' });
  }
});

// API: Push full POS database state to Cloud SQL
app.post('/api/sync/push', async (req, res) => {
  try {
    const { businessId, businessName, ownerEmail, tables, settings } = req.body || {};
    if (!tables || typeof tables !== 'object') {
      return res.status(400).json({ error: 'Missing tables payload for synchronization' });
    }
    const result = await pushPosSyncToCloudSql({
      businessId: businessId || '__global__',
      businessName,
      ownerEmail,
      tables,
      settings,
    });
    res.json(result);
  } catch (error: any) {
    console.warn('Cloud SQL push sync unavailable:', error?.message || 'Unknown error');
    res.status(503).json({ error: error?.message || 'Failed to push sync state to Cloud SQL' });
  }
});

// API: Pull full POS database state from Cloud SQL
app.get('/api/sync/pull', async (req, res) => {
  try {
    const businessId = typeof req.query.businessId === 'string' ? req.query.businessId : undefined;
    const email = typeof req.query.email === 'string' ? req.query.email : undefined;
    const result = await pullPosSyncFromCloudSql(businessId, email);
    res.json(result);
  } catch (error: any) {
    console.warn('Cloud SQL pull sync unavailable:', error?.message || 'Unknown error');
    res.status(503).json({ error: error?.message || 'Failed to pull sync state from Cloud SQL' });
  }
});

// API: Check Cloud SQL synchronization status and available business accounts
app.get('/api/sync/status', async (_req, res) => {
  try {
    const result = await pullPosSyncFromCloudSql();
    res.json({
      online: true,
      hasCloudData: result.found,
      updatedAt: result.updatedAt || null,
      availableBusinesses: result.availableBusinesses || [],
    });
  } catch (error: any) {
    res.status(200).json({
      online: false,
      hasCloudData: false,
      error: error.message || 'Cloud SQL unavailable',
    });
  }
});

// API: Sync authenticated user to Cloud SQL database
app.post('/api/auth/sync', requireAuth, async (req: AuthRequest, res) => {
  try {
    const uid = req.user?.uid;
    const email = req.user?.email || 'unknown@pos.app';
    const name = (req.user as any)?.name || undefined;

    if (!uid) {
      return res.status(400).json({ error: 'Missing UID in authenticated token' });
    }

    const user = await getOrCreateUser(uid, email, name);
    res.json({ success: true, user });
  } catch (error: any) {
    console.error('Error syncing user to Cloud SQL:', error);
    res.status(500).json({ error: error.message || 'Failed to sync user' });
  }
});

// API: Retrieve users list from Cloud SQL
app.get('/api/users', requireAuth, async (_req: AuthRequest, res) => {
  try {
    const users = await getUsers();
    res.json(users);
  } catch (error: any) {
    console.error('Failed to fetch users:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch users' });
  }
});

// API: Relay VSDC Smart Invoice requests from browser to configured VSDC API endpoint
app.post('/api/zra/forward', async (req, res) => {
  try {
    const { targetUrl, payload } = req.body || {};
    if (!targetUrl || typeof targetUrl !== 'string' || !/^https?:\/\//i.test(targetUrl.trim())) {
      return res.status(400).json({ error: 'Invalid targetUrl: must start with http:// or https://' });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      const upstream = await fetch(targetUrl.trim(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });

      const rawText = await upstream.text();
      let parsed: any = null;
      try {
        parsed = rawText ? JSON.parse(rawText) : {};
      } catch {
        parsed = { rawText };
      }
      return res.status(upstream.status).json(parsed);
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err: any) {
    return res.status(502).json({
      networkError: true,
      error: err?.name === 'AbortError'
        ? 'VSDC request timed out after 12s'
        : (err?.message || 'Unable to connect to VSDC endpoint'),
    });
  }
});

// Setup Vite middleware in dev or static serving in production
async function startServer() {
  const distPath = path.resolve(__dirname, 'dist');
  const distIndexHtml = path.resolve(distPath, 'index.html');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(distIndexHtml);

  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(distIndexHtml);
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT} [${isProd ? 'production' : 'development'}]`);
  });
}

startServer();
