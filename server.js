// =============================================
// SPARKK BACKEND — VPS Edition
// Express server for 89.167.0.115
// =============================================

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ==================== CONFIG ====================

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));

// ==================== CLIENTS ====================

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ==================== MODEL PRICING (USD per million tokens) ====================

const MODEL_PRICING = {
  'claude-sonnet-4-5-20250929': { label: 'Sonnet 4.5', input: 3.0, output: 15.0 },
  'claude-haiku-3-5-20241022': { label: 'Haiku 3.5', input: 0.80, output: 4.0 },
  'claude-opus-4-20250514': { label: 'Opus 4', input: 15.0, output: 75.0 },
};

// ==================== HELPERS ====================

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

async function getSettings() {
  const { data } = await supabase
    .from('settings')
    .select('*')
    .eq('id', 'global')
    .single();
  return data || { profit_margin: 30, eur_rate: 0.92 };
}

function calculateCost(inputTokens, outputTokens, model, settings) {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return { baseCostUSD: 0, baseCostEUR: 0, chargedEUR: 0 };

  const baseCostUSD =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output;

  const baseCostEUR = baseCostUSD * (settings.eur_rate || 0.92);
  const chargedEUR = baseCostEUR * (1 + (settings.profit_margin || 30) / 100);

  return { baseCostUSD, baseCostEUR, chargedEUR };
}

// ==================== AUTH ROUTES ====================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;

    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase(),
        password_hash: hashPassword(password),
        first_name: firstName,
        last_name: lastName,
        credits: 0,
        is_admin: false,
      })
      .select()
      .single();

    if (error) throw error;

    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .eq('password_hash', hashPassword(password))
      .single();

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/auth/me/:userId', async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.params.userId)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ==================== SETTINGS ROUTES ====================

app.get('/api/settings', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { profit_margin, eur_rate } = req.body;
    const { data, error } = await supabase
      .from('settings')
      .update({ profit_margin, eur_rate })
      .eq('id', 'global')
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ==================== ADMIN AUTH MIDDLEWARE ====================

async function requireAdmin(req, res, next) {
  try {
    const adminId = req.headers['x-admin-id'];
    if (!adminId) {
      return res.status(401).json({ error: 'Admin authentication required' });
    }

    const { data: admin } = await supabase
      .from('users')
      .select('id, is_admin')
      .eq('id', adminId)
      .single();

    if (!admin || !admin.is_admin) {
      return res.status(403).json({ error: 'Admin access denied' });
    }

    req.adminUser = admin;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth check failed' });
  }
}

// ==================== ADMIN ROUTES ====================

app.get('/api/admin/students', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, email, first_name, last_name, credits, total_spent, is_admin, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

app.post('/api/admin/topup', requireAdmin, async (req, res) => {
  try {
    const { userId, amount } = req.body;

    const { data: user } = await supabase
      .from('users')
      .select('credits')
      .eq('id', userId)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    const newCredits = parseFloat(user.credits) + parseFloat(amount);

    const { data, error } = await supabase
      .from('users')
      .update({ credits: newCredits })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;

    const { password_hash, ...safeUser } = data;
    res.json({ user: safeUser });
  } catch (err) {
    res.status(500).json({ error: 'Top up failed' });
  }
});

// ==================== GENERATE (Claude API) ====================

function sendSSEError(res, statusCode, errorMessage) {
  if (!res.headersSent) {
    res.writeHead(statusCode, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
  }
  res.write('data: ' + JSON.stringify({ type: 'error', error: errorMessage }) + '\n\n');
  res.end();
}

function sanitizeMessages(messages) {
  const cleaned = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content) && m.content.length > 0
        ? (m.content[0].text || JSON.stringify(m.content))
        : String(m.content || '');

    if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === role) {
      if (role === 'user') {
        cleaned[cleaned.length - 1].content += '\n\n' + content;
      } else {
        cleaned[cleaned.length - 1].content = content;
      }
    } else {
      cleaned.push({ role, content });
    }
  }

  if (cleaned.length === 0 || cleaned[0].role !== 'user') {
    cleaned.unshift({ role: 'user', content: 'Hello' });
  }

  return cleaned;
}

async function generateHandler(req, res) {
  try {
    const { userId, messages, model } = req.body;

    if (!userId || !messages || !model) {
      return sendSSEError(res, 400, 'Missing required fields');
    }

    if (!MODEL_PRICING[model]) {
      return sendSSEError(res, 400, 'Invalid model');
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return sendSSEError(res, 400, 'Messages must be a non-empty array');
    }

    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (!user) return sendSSEError(res, 404, 'User not found');

    if (parseFloat(user.credits) < 0.01 && !user.is_admin) {
      return sendSSEError(res, 402, 'Insufficient credits');
    }

    const settings = await getSettings();
    const cleanedMessages = sanitizeMessages(messages);

    const systemPrompt = `You are Sparkk, an AI app builder. When the user describes what they want to build, generate a COMPLETE, self-contained HTML file with inline CSS and JavaScript.

Rules:
- Output ONLY the HTML code, nothing else — no markdown, no backticks, no explanation
- Make it visually polished with modern CSS (gradients, shadows, animations)
- Use a dark theme by default (#0a0a0a background, white text)
- Make it fully responsive and interactive
- Include all JavaScript inline in <script> tags
- Include all CSS inline in <style> tags
- The HTML must work standalone when opened in a browser
- If the user asks to modify existing code, output the COMPLETE modified HTML file`;

    const response = await anthropic.messages.create({
      model: model,
      max_tokens: 16000,
      system: systemPrompt,
      messages: cleanedMessages,
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const content = response.content;

    const { baseCostEUR, chargedEUR } = calculateCost(
      inputTokens,
      outputTokens,
      model,
      settings
    );

    const newCredits = Math.max(0, parseFloat(user.credits) - chargedEUR);
    await supabase
      .from('users')
      .update({ credits: newCredits })
      .eq('id', userId);

    await supabase.rpc('increment_spent', {
      user_id: userId,
      amount: chargedEUR,
    });

    const lastContent = messages[messages.length - 1]?.content;
    const promptPreview = typeof lastContent === 'string'
      ? lastContent.slice(0, 100)
      : '';

    await supabase.from('usage_logs').insert({
      user_id: userId,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      base_cost_eur: baseCostEUR,
      charged_eur: chargedEUR,
      prompt_preview: promptPreview,
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const text = content[0].text;
    res.write('data: ' + JSON.stringify({ type: 'chunk', text: text }) + '\n\n');
    res.write('data: ' + JSON.stringify({
      type: 'done',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        base_cost_eur: baseCostEUR,
        charged_eur: chargedEUR,
        remaining_credits: newCredits,
      },
    }) + '\n\n');
    res.end();
  } catch (err) {
    console.error('Generate error:', err);
    const message = err?.error?.message || err?.message || 'Generation failed';
    sendSSEError(res, 500, message);
  }
}

app.post('/api/generate', generateHandler);
app.post('/api/stream', generateHandler);

// ==================== CHAT HISTORY ROUTES ====================

app.get('/api/chats/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chats')
      .select('id, title, model, message_count, total_cost, updated_at, created_at')
      .eq('user_id', req.params.userId)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch chats' });
  }
});

app.get('/api/chat/:chatId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chats')
      .select('*')
      .eq('id', req.params.chatId)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch chat' });
  }
});

app.post('/api/chats', async (req, res) => {
  try {
    const { id, userId, title, model, messages, generatedCode, totalCost, messageCount } = req.body;

    const chatData = {
      user_id: userId,
      title,
      model,
      messages: typeof messages === 'string' ? messages : JSON.stringify(messages),
      generated_code: generatedCode || '',
      total_cost: totalCost || 0,
      message_count: messageCount || 0,
      updated_at: new Date().toISOString(),
    };

    if (id) {
      const { data, error } = await supabase
        .from('chats')
        .update(chatData)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      res.json(data);
    } else {
      const { data, error } = await supabase
        .from('chats')
        .insert(chatData)
        .select()
        .single();

      if (error) throw error;
      res.json(data);
    }
  } catch (err) {
    console.error('Save chat error:', err);
    res.status(500).json({ error: 'Failed to save chat' });
  }
});

app.delete('/api/chat/:chatId', async (req, res) => {
  try {
    await supabase.from('versions').delete().eq('chat_id', req.params.chatId);

    const { error } = await supabase
      .from('chats')
      .delete()
      .eq('id', req.params.chatId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});

// ==================== VERSION HISTORY ROUTES ====================

app.get('/api/versions/:chatId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('versions')
      .select('*')
      .eq('chat_id', req.params.chatId)
      .order('version_number', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch versions' });
  }
});

app.post('/api/versions', async (req, res) => {
  try {
    const { chatId, userId, versionNumber, code, prompt } = req.body;

    const { data, error } = await supabase
      .from('versions')
      .insert({
        chat_id: chatId,
        user_id: userId,
        version_number: versionNumber,
        code,
        prompt,
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save version' });
  }
});

// ==================== SPORTS ADMIN ROUTES ====================

// --- Sports ---
app.get('/api/admin/sports', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sports')
      .select('*')
      .order('name', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sports' });
  }
});

app.post('/api/admin/sports', requireAdmin, async (req, res) => {
  try {
    const { name, description, icon } = req.body;
    if (!name) return res.status(400).json({ error: 'Sport name is required' });

    const { data, error } = await supabase
      .from('sports')
      .insert({ name, description: description || '', icon: icon || '' })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create sport' });
  }
});

app.put('/api/admin/sports/:id', requireAdmin, async (req, res) => {
  try {
    const { name, description, icon } = req.body;
    const { data, error } = await supabase
      .from('sports')
      .update({ name, description, icon })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update sport' });
  }
});

app.delete('/api/admin/sports/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('sports').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete sport' });
  }
});

// --- Leagues ---
app.get('/api/admin/leagues', requireAdmin, async (req, res) => {
  try {
    let query = supabase.from('leagues').select('*, sports(name)');
    if (req.query.sport_id) query = query.eq('sport_id', req.query.sport_id);
    const { data, error } = await query.order('name', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leagues' });
  }
});

app.post('/api/admin/leagues', requireAdmin, async (req, res) => {
  try {
    const { name, sport_id, country, season, logo_url } = req.body;
    if (!name || !sport_id) return res.status(400).json({ error: 'Name and sport_id are required' });

    const { data, error } = await supabase
      .from('leagues')
      .insert({ name, sport_id, country: country || '', season: season || '', logo_url: logo_url || '' })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create league' });
  }
});

app.put('/api/admin/leagues/:id', requireAdmin, async (req, res) => {
  try {
    const { name, sport_id, country, season, logo_url } = req.body;
    const { data, error } = await supabase
      .from('leagues')
      .update({ name, sport_id, country, season, logo_url })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update league' });
  }
});

app.delete('/api/admin/leagues/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('leagues').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete league' });
  }
});

// --- Teams ---
app.get('/api/admin/teams', requireAdmin, async (req, res) => {
  try {
    let query = supabase.from('teams').select('*, leagues(name), sports(name)');
    if (req.query.league_id) query = query.eq('league_id', req.query.league_id);
    if (req.query.sport_id) query = query.eq('sport_id', req.query.sport_id);
    const { data, error } = await query.order('name', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

app.post('/api/admin/teams', requireAdmin, async (req, res) => {
  try {
    const { name, sport_id, league_id, logo_url, city, country } = req.body;
    if (!name || !sport_id) return res.status(400).json({ error: 'Name and sport_id are required' });

    const { data, error } = await supabase
      .from('teams')
      .insert({ name, sport_id, league_id: league_id || null, logo_url: logo_url || '', city: city || '', country: country || '' })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create team' });
  }
});

app.put('/api/admin/teams/:id', requireAdmin, async (req, res) => {
  try {
    const { name, sport_id, league_id, logo_url, city, country } = req.body;
    const { data, error } = await supabase
      .from('teams')
      .update({ name, sport_id, league_id, logo_url, city, country })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update team' });
  }
});

app.delete('/api/admin/teams/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('teams').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete team' });
  }
});

// --- Players ---
app.get('/api/admin/players', requireAdmin, async (req, res) => {
  try {
    let query = supabase.from('players').select('*, teams(name)');
    if (req.query.team_id) query = query.eq('team_id', req.query.team_id);
    if (req.query.sport_id) query = query.eq('sport_id', req.query.sport_id);
    const { data, error } = await query.order('last_name', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

app.post('/api/admin/players', requireAdmin, async (req, res) => {
  try {
    const { first_name, last_name, sport_id, team_id, position, jersey_number, date_of_birth, nationality, photo_url } = req.body;
    if (!first_name || !last_name || !sport_id) return res.status(400).json({ error: 'first_name, last_name, and sport_id are required' });

    const { data, error } = await supabase
      .from('players')
      .insert({
        first_name, last_name, sport_id,
        team_id: team_id || null,
        position: position || '',
        jersey_number: jersey_number || null,
        date_of_birth: date_of_birth || null,
        nationality: nationality || '',
        photo_url: photo_url || '',
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create player' });
  }
});

app.put('/api/admin/players/:id', requireAdmin, async (req, res) => {
  try {
    const { first_name, last_name, sport_id, team_id, position, jersey_number, date_of_birth, nationality, photo_url } = req.body;
    const { data, error } = await supabase
      .from('players')
      .update({ first_name, last_name, sport_id, team_id, position, jersey_number, date_of_birth, nationality, photo_url })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update player' });
  }
});

app.delete('/api/admin/players/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('players').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete player' });
  }
});

// --- Matches ---
app.get('/api/admin/matches', requireAdmin, async (req, res) => {
  try {
    let query = supabase.from('matches').select('*, home_team:teams!matches_home_team_id_fkey(name), away_team:teams!matches_away_team_id_fkey(name), leagues(name), sports(name)');
    if (req.query.league_id) query = query.eq('league_id', req.query.league_id);
    if (req.query.sport_id) query = query.eq('sport_id', req.query.sport_id);
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data, error } = await query.order('match_date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

app.post('/api/admin/matches', requireAdmin, async (req, res) => {
  try {
    const { sport_id, league_id, home_team_id, away_team_id, match_date, venue, status } = req.body;
    if (!sport_id || !home_team_id || !away_team_id || !match_date) {
      return res.status(400).json({ error: 'sport_id, home_team_id, away_team_id, and match_date are required' });
    }

    const { data, error } = await supabase
      .from('matches')
      .insert({
        sport_id, league_id: league_id || null,
        home_team_id, away_team_id,
        match_date, venue: venue || '',
        status: status || 'scheduled',
        home_score: 0, away_score: 0,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create match' });
  }
});

app.put('/api/admin/matches/:id', requireAdmin, async (req, res) => {
  try {
    const { sport_id, league_id, home_team_id, away_team_id, match_date, venue, status, home_score, away_score } = req.body;
    const { data, error } = await supabase
      .from('matches')
      .update({ sport_id, league_id, home_team_id, away_team_id, match_date, venue, status, home_score, away_score })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update match' });
  }
});

app.delete('/api/admin/matches/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('matches').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete match' });
  }
});

// --- Standings (read + recalculate) ---
app.get('/api/admin/standings', requireAdmin, async (req, res) => {
  try {
    let query = supabase.from('standings').select('*, teams(name), leagues(name)');
    if (req.query.league_id) query = query.eq('league_id', req.query.league_id);
    const { data, error } = await query.order('points', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch standings' });
  }
});

app.post('/api/admin/standings', requireAdmin, async (req, res) => {
  try {
    const { team_id, league_id, played, won, drawn, lost, goals_for, goals_against, points } = req.body;
    if (!team_id || !league_id) return res.status(400).json({ error: 'team_id and league_id are required' });

    const { data, error } = await supabase
      .from('standings')
      .upsert({
        team_id, league_id,
        played: played || 0, won: won || 0, drawn: drawn || 0, lost: lost || 0,
        goals_for: goals_for || 0, goals_against: goals_against || 0,
        points: points || 0,
      }, { onConflict: 'team_id,league_id' })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update standings' });
  }
});

// --- Dashboard Stats ---
app.get('/api/admin/sports-stats', requireAdmin, async (req, res) => {
  try {
    const [sports, leagues, teams, players, matches] = await Promise.all([
      supabase.from('sports').select('id', { count: 'exact', head: true }),
      supabase.from('leagues').select('id', { count: 'exact', head: true }),
      supabase.from('teams').select('id', { count: 'exact', head: true }),
      supabase.from('players').select('id', { count: 'exact', head: true }),
      supabase.from('matches').select('id', { count: 'exact', head: true }),
    ]);

    res.json({
      sports_count: sports.count || 0,
      leagues_count: leagues.count || 0,
      teams_count: teams.count || 0,
      players_count: players.count || 0,
      matches_count: matches.count || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ==================== HEALTH CHECK ====================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'sparkk-backend',
    timestamp: new Date().toISOString(),
    models: Object.keys(MODEL_PRICING).map(k => ({
      id: k,
      label: MODEL_PRICING[k].label,
    })),
  });
});

// ==================== WEBSOCKET ====================

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      ws.send(JSON.stringify({ type: 'ack', received: msg.type }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: e.message }));
    }
  });
  ws.on('close', () => console.log('WebSocket client disconnected'));
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sparkk backend running on port ${PORT}`);
    console.log(`   Health: http://89.167.0.115:${PORT}/api/health`);
    console.log(`   Models: ${Object.values(MODEL_PRICING).map(m => m.label).join(', ')}`);
  });
}

module.exports = { app, server, sanitizeMessages, calculateCost, hashPassword };
