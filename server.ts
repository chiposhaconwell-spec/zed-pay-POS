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
    console.error('Error pushing POS state to Cloud SQL:', error);
    res.status(500).json({ error: error.message || 'Failed to push sync state to Cloud SQL' });
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
    console.error('Error pulling POS state from Cloud SQL:', error);
    res.status(500).json({ error: error.message || 'Failed to pull sync state from Cloud SQL' });
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
