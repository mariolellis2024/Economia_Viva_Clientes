const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Middleware
app.use(express.json());

// Named routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'quiz-1000-empresas.html')));
app.get('/results', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.use(express.static(path.join(__dirname)));

// --- Init DB ---
async function initDB(retries = 10) {
  const sql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8');
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query(sql);
      console.log('✅ Database initialized');
      return;
    } catch (err) {
      console.error(`❌ DB init attempt ${i}/${retries}:`, err.message);
      if (i < retries) await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error('❌ Could not connect to DB after all retries');
}

// --- Auth middleware for admin routes ---
function requireAdmin(req, res, next) {
  const password = req.headers['x-admin-password'] || req.query.password;
  const adminPwd = process.env.ADMIN_PASSWORD;
  if (!adminPwd || password !== adminPwd) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Routes ---

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Submit quiz
app.post('/api/quiz', async (req, res) => {
  try {
    const { name, whatsapp, instagram, answers } = req.body;

    if (!name || !whatsapp || !instagram) {
      return res.status(400).json({ error: 'Nome, WhatsApp e Instagram são obrigatórios.' });
    }

    const result = await pool.query(
      `INSERT INTO quiz_leads (name, whatsapp, instagram, q1, q2, q3, q4, q5, q6, q7)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, created_at`,
      [
        name, whatsapp, instagram,
        answers?.q1 || null,
        answers?.q2 || null,
        answers?.q3 || null,
        answers?.q4 || null,
        answers?.q5 || null,
        answers?.q6 || null,
        answers?.q7 || null,
      ]
    );

    console.log(`📋 New lead: ${name} (ID: ${result.rows[0].id})`);
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('❌ Error saving lead:', err.message);
    res.status(500).json({ error: 'Erro ao salvar. Tente novamente.' });
  }
});

// Get all leads (admin)
app.get('/api/leads', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM quiz_leads ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching leads:', err.message);
    res.status(500).json({ error: 'Erro ao buscar leads.' });
  }
});

// Stats (admin)
app.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) as count FROM quiz_leads');
    const today = await pool.query(
      "SELECT COUNT(*) as count FROM quiz_leads WHERE created_at >= CURRENT_DATE"
    );
    const thisWeek = await pool.query(
      "SELECT COUNT(*) as count FROM quiz_leads WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'"
    );

    // Most common answers per question
    const breakdown = {};
    for (let i = 1; i <= 7; i++) {
      const col = `q${i}`;
      const r = await pool.query(
        `SELECT ${col} as answer, COUNT(*) as count FROM quiz_leads WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY count DESC LIMIT 5`
      );
      breakdown[col] = r.rows;
    }

    res.json({
      total: parseInt(total.rows[0].count),
      today: parseInt(today.rows[0].count),
      thisWeek: parseInt(thisWeek.rows[0].count),
      breakdown,
    });
  } catch (err) {
    console.error('❌ Error fetching stats:', err.message);
    res.status(500).json({ error: 'Erro ao buscar estatísticas.' });
  }
});

// --- Settings (admin) ---
app.get('/api/settings', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM settings');
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar configurações.' });
  }
});

app.put('/api/settings', requireAdmin, async (req, res) => {
  try {
    const entries = Object.entries(req.body);
    for (const [key, value] of entries) {
      await pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, String(value)]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar configurações.' });
  }
});

// --- Public tracking config (only pixel ID + GA, NEVER the API token) ---
app.get('/api/tracking', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('meta_pixel_id', 'ga_measurement_id')"
    );
    const config = {};
    result.rows.forEach(r => { config[r.key] = r.value; });
    res.json(config);
  } catch (err) {
    res.json({});
  }
});

// --- Server-side Meta Conversions API ---
app.post('/api/track', async (req, res) => {
  try {
    const { event_name, user_data } = req.body;
    // Get token and pixel ID from DB
    const result = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('meta_pixel_id', 'meta_api_token')"
    );
    const cfg = {};
    result.rows.forEach(r => { cfg[r.key] = r.value; });

    if (!cfg.meta_pixel_id || !cfg.meta_api_token) {
      return res.json({ skipped: true, reason: 'Pixel or token not configured' });
    }

    const payload = {
      data: [{
        event_name: event_name || 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        user_data: {
          ph: user_data?.phone ? [user_data.phone] : undefined,
          fn: user_data?.name ? [user_data.name.toLowerCase()] : undefined,
        },
      }],
      access_token: cfg.meta_api_token,
    };

    const fbRes = await fetch(
      `https://graph.facebook.com/v19.0/${cfg.meta_pixel_id}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    const fbData = await fbRes.json();
    console.log('📊 Meta CAPI:', event_name, fbData);
    res.json({ success: true, fb: fbData });
  } catch (err) {
    console.error('❌ Meta CAPI error:', err.message);
    res.json({ error: err.message });
  }
});

// --- Start ---
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});
