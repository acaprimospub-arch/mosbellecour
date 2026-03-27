const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const db = require('./db/database');

// ─── Multer (pièces jointes réservations) ──────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads', 'reservations');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const _multerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const base = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, base);
  }
});
const upload = multer({
  storage: _multerStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 Mo max
  fileFilter: (_req, file, cb) => {
    // Autorise : images, PDF, Word, Excel, texte
    const ok = /^(image\/|application\/pdf|application\/msword|application\/vnd\.|text\/)/.test(file.mimetype);
    cb(null, ok);
  }
});

// ─── Joy.io iCal Sync ──────────────────────────────────────────────────────────
function fetchUrl(url, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'MosPub-Sync/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchUrl(res.headers.location, depth + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Timeout')); });
  });
}

function unfoldIcal(text) {
  // Unfold lines (continuation lines start with space or tab)
  return text.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function getIcalProp(block, key) {
  const re = new RegExp(`^${key}(?:;[^:]*)?:(.+)`, 'm');
  const m = block.match(re);
  if (!m) return '';
  return m[1].trim()
    .replace(/\\n/g, ' ').replace(/\\N/g, ' ')
    .replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseDateTime(dtStr) {
  // DTSTART;TZID=...:20260404T213000 or DTSTART:20260404T213000Z or DTSTART:20260404
  const isUTC = dtStr.endsWith('Z');
  const m = dtStr.replace(/Z$/, '').match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
  if (!m) return { date: '', time: '' };

  // Si heure UTC (suffixe Z), convertir en heure de Paris
  if (isUTC && m[4]) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
    const fmt = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = fmt.formatToParts(d);
    const get = t => parts.find(p => p.type === t)?.value || '';
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      time: `${get('hour')}:${get('minute')}`
    };
  }

  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    time: m[4] ? `${m[4]}:${m[5]}` : ''
  };
}

function parseIcalEvents(raw) {
  const text = unfoldIcal(raw);
  const events = [];
  const blocks = text.split(/BEGIN:VEVENT/i);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split(/END:VEVENT/i)[0];
    const uid         = getIcalProp(block, 'UID');
    const summary     = getIcalProp(block, 'SUMMARY');
    const description = getIcalProp(block, 'DESCRIPTION');
    const location    = getIcalProp(block, 'LOCATION');
    const dtStartRaw  = getIcalProp(block, 'DTSTART');
    const dtEndRaw    = getIcalProp(block, 'DTEND');
    const icalStatus  = getIcalProp(block, 'STATUS');

    if (!uid) continue;

    const { date, time: timeStart } = parseDateTime(dtStartRaw);
    const { time: timeEnd }         = parseDateTime(dtEndRaw);

    // Extract participants — plusieurs formats Joy.io possibles
    const combined = summary + ' ' + description;
    // Format A : mot AVANT le nombre → "Participants: 30", "Convives : 30", "Nb personnes: 30"
    const partBefore = combined.match(
      /(?:participant|personne|convive|couvert|pax|place|nb|nombre|guest|invit[eé]?|person)\w*\s*[:=.]\s*(\d+)/i
    );
    // Format B : nombre AVANT le mot → "30 personnes", "30 pax", "30 convives"
    const partAfter = combined.match(
      /(\d+)\s*(?:participant|personne|pers(?:\.|s\b|\b)|convive|couvert|pax|place|invit|person)/i
    );
    // Format C : nombre entre tirets dans le SUMMARY → "Dupont - 30 - Grande Salle"
    const partSummary = summary.match(/(?:^|\s-\s)(\d{1,3})\s*(?:-|$|\s)/);
    const participants = partBefore  ? parseInt(partBefore[1])
                       : partAfter   ? parseInt(partAfter[1])
                       : partSummary ? parseInt(partSummary[1])
                       : 0;
    // Extract customer name : "Nom Prénom - N" → prendre tout avant le dernier " - N"
    let customerName = summary;
    const nomMatch = description.match(/nom\s*[:]\s*([^\n\\,]+)/i);
    if (nomMatch) {
      customerName = nomMatch[1].trim();
    } else if (summary.includes(' - ')) {
      customerName = summary.replace(/\s+-\s+\d+\s*$/, '').trim();
    }

    // Extract space : Joy.io format réel = "Réservation confirmée [ESPACE] +33..."
    let spaceRaw = location || '';
    if (!spaceRaw) {
      const spaceFromConfirm = description.match(/r[eé]servation\s+confirm[eé]e\s+(.*?)\s*\+33/i);
      if (spaceFromConfirm) spaceRaw = spaceFromConfirm[1].trim();
    }
    if (!spaceRaw) {
      const labeled = description.match(/(?:espace|salle|space|lieu)\s*[:]\s*([^\n\\,]+)/i);
      if (labeled) spaceRaw = labeled[1].trim();
    }
    // Mapping des espaces Joy.io → noms internes du bar
    const spaceMap = {
      'coin canap': 'Petite mezzanine',
      'etage':      'Mezzanine',
      'étage':      'Mezzanine',
    };
    const spaceKey = spaceRaw.toLowerCase().trim();
    let space = spaceRaw;
    for (const [k, v] of Object.entries(spaceMap)) {
      if (spaceKey.includes(k)) { space = v; break; }
    }

    // Extract phone : Joy.io le place directement sans label ex: +33607124124
    const labeledPhone = description.match(
      /(?:t[eé]l(?:[eé]phone)?|phone|portable|mobile|mob|contact|num[eé]ro)\s*[:=.]?\s*((?:\+33[\s.\-]?|0)[1-9](?:[\s.\-]?\d){8})/i
    );
    const barePhone = description.match(/((?:\+33[\s.\-]?|0)[1-9](?:[\s.\-]?\d){8})/);
    const phone = labeledPhone ? labeledPhone[1].trim() : (barePhone ? barePhone[1].trim() : null);

    // Extract notes : supprime le boilerplate Joy.io, garde uniquement le contenu utile
    // (prix/devis, demandes spéciales, toute info non standard)
    let notes = null;
    const notesRaw = description
      .replace(/r[eé]servation\s+confirm[eé]e/gi, '')
      .replace(new RegExp((space || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '')
      .replace(/((?:\+33[\s.\-]?|0)[1-9](?:[\s.\-]?\d){8})/g, '')
      .replace(/pour\s+modifier\s+ou\s+supprimer\s*(cette\s+)?r[eé]s[ae][^\n]*/gi, '')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (notesRaw.length >= 5) notes = notesRaw.substring(0, 300);

    const status = (icalStatus || '').toLowerCase() === 'cancelled' ? 'cancelled' : 'confirmed';

    events.push({ joy_uid: uid, customer_name: customerName, participants, date, time_start: timeStart, time_end: timeEnd, space, raw_summary: summary, raw_description: description, status, phone, notes });
  }
  return events;
}

async function syncJoyEvents() {
  const url = db.getSetting('joy_ical_url');
  if (!url) return { synced: 0, error: 'URL iCal non configurée' };
  try {
    const raw = await fetchUrl(url);
    const events = parseIcalEvents(raw);

    // Phase 1 : nettoyage préventif des doublons existants en base
    db.cleanupJoyReservationDuplicates();

    // Phase 2 : upsert de chaque événement + sa résa
    let synced = 0;
    const syncedJoyIds = [];
    for (const ev of events) {
      const joyId = db.upsertJoyEvent(ev);
      if (joyId) {
        db.upsertReservationFromJoy(joyId, ev);
        syncedJoyIds.push(joyId);
      }
      synced++;
    }

    // Phase 3 : supprime les résas Joy qui n'existent plus dans l'iCal actuel
    // (gère le cas où Joy.io change les UIDs entre deux exports)
    if (syncedJoyIds.length > 0) {
      db.cleanupStaleJoyReservations(syncedJoyIds);
    }

    db.setSetting('joy_last_sync', new Date().toISOString());
    console.log(`[Joy.io] ✅ ${synced} événements synchronisés`);
    // Notifie tous les clients connectés pour qu'ils rechargent les résas
    if (typeof io !== 'undefined') io.emit('joy:synced', { synced, total: events.length });
    return { synced, total: events.length };
  } catch (err) {
    console.error('[Joy.io] ❌ Erreur sync:', err.message);
    return { error: err.message };
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'mos-pub-merciere-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── Middleware ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  res.status(401).json({ error: 'Non authentifié' });
}
function requireAdmin(req, res, next) {
  if (req.session.userId && req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Accès refusé' });
}
function requireAdminOrManager(req, res, next) {
  if (req.session.userId && (req.session.role === 'admin' || req.session.role === 'manager')) return next();
  res.status(403).json({ error: 'Accès refusé' });
}

// ─── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body;
  const user = db.getUserByPin(pin);
  if (!user || !user.active) return res.status(401).json({ error: 'Code PIN incorrect' });
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.shift = user.shift;
  req.session.name = user.name;
  res.json({ id: user.id, name: user.name, role: user.role, shift: user.shift });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Session invalide' });
  res.json({ id: user.id, name: user.name, role: user.role, shift: user.shift });
});

// ─── Tasks ─────────────────────────────────────────────────────────────────────
app.get('/api/tasks', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const domain = req.session.shift === 'cuisine' ? 'cuisine' : 'salle';
  res.json(db.getTasksWithCompletions(today, req.session.userId, domain));
});

app.post('/api/tasks/:id/complete', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  db.completeTask(req.params.id, req.session.userId, today);
  io.emit('task:updated', {
    taskId: parseInt(req.params.id),
    userId: req.session.userId,
    userName: req.session.name,
    completed: true,
    date: today
  });
  res.json({ ok: true });
});

app.delete('/api/tasks/:id/complete', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  db.uncompleteTask(req.params.id, req.session.userId, today);
  io.emit('task:updated', {
    taskId: parseInt(req.params.id),
    userId: req.session.userId,
    userName: req.session.name,
    completed: false,
    date: today
  });
  res.json({ ok: true });
});

// Admin task management
app.get('/api/admin/tasks', requireAdmin, (req, res) => {
  res.json(db.getAllTasks());
});

app.post('/api/admin/tasks', requireAdmin, (req, res) => {
  const id = db.createTask(req.body);
  res.json(db.getTaskById(id));
});

app.put('/api/admin/tasks/:id', requireAdmin, (req, res) => {
  db.updateTask(req.params.id, req.body);
  res.json(db.getTaskById(req.params.id));
});

app.delete('/api/admin/tasks/:id', requireAdmin, (req, res) => {
  db.deactivateTask(req.params.id);
  res.json({ ok: true });
});


// ─── Tables (floor plan) ───────────────────────────────────────────────────────
app.get('/api/tables', requireAuth, (req, res) => {
  res.json(db.getTables());
});

app.post('/api/tables', requireAdminOrManager, (req, res) => {
  const id = db.createTable(req.body);
  const table = db.getTableById(id);
  io.emit('table:created', table);
  res.json(table);
});

app.put('/api/tables/:id', requireAdminOrManager, (req, res) => {
  db.updateTable(req.params.id, req.body);
  const table = db.getTableById(req.params.id);
  io.emit('table:updated', table);
  res.json(table);
});

app.delete('/api/tables/:id', requireAdminOrManager, (req, res) => {
  db.deleteTable(req.params.id);
  io.emit('table:deleted', { id: parseInt(req.params.id) });
  res.json({ ok: true });
});

// ─── Reservations ──────────────────────────────────────────────────────────────
app.get('/api/reservations', requireAuth, (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  res.json(db.getReservationsByDate(date));
});

app.post('/api/reservations', requireAuth, (req, res) => {
  const id = db.createReservation(req.body);
  const r = db.getReservationById(id);
  io.emit('reservation:updated', r);
  res.json(r);
});

app.put('/api/reservations/:id', requireAuth, (req, res) => {
  // admin_notes réservé aux admins et managers
  const body = { ...req.body };
  if (req.session.role !== 'admin' && req.session.role !== 'manager') delete body.admin_notes;
  db.updateReservation(req.params.id, body);
  const r = db.getReservationById(req.params.id);
  io.emit('reservation:updated', r);
  if (req.body.status === 'arrived') {
    io.emit('alert:cancel', { reservationId: parseInt(req.params.id) });
  }
  res.json(r);
});

app.delete('/api/reservations/:id', requireAuth, (req, res) => {
  const r = db.getReservationById(req.params.id);
  // Supprimer aussi les fichiers liés
  const atts = db.getReservationAttachments(req.params.id);
  atts.forEach(a => { try { fs.unlinkSync(path.join(UPLOADS_DIR, a.filename)); } catch(e) {} });
  db.deleteReservation(req.params.id);
  io.emit('reservation:deleted', { id: parseInt(req.params.id), table_id: r?.table_id });
  res.json({ ok: true });
});

// ─── Pièces jointes réservations ───────────────────────────────────────────────
app.get('/api/reservations/:id/attachments', requireAuth, (req, res) => {
  res.json(db.getReservationAttachments(req.params.id));
});

app.post('/api/reservations/:id/attachments', requireAdminOrManager, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant ou type non autorisé (max 10 Mo)' });
  const id = db.addReservationAttachment({
    reservation_id: req.params.id,
    filename:       req.file.filename,
    original_name:  req.file.originalname,
    mimetype:       req.file.mimetype,
    size:           req.file.size,
    uploaded_by:    req.session.userId,
  });
  res.json(db.getAttachmentById(id));
});

app.get('/api/attachments/:id/file', requireAuth, (req, res) => {
  const att = db.getAttachmentById(req.params.id);
  if (!att) return res.status(404).json({ error: 'Fichier introuvable' });
  const filePath = path.join(UPLOADS_DIR, att.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Fichier introuvable sur le disque' });
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.original_name)}"`);
  res.sendFile(filePath);
});

app.delete('/api/attachments/:id', requireAdminOrManager, (req, res) => {
  const att = db.getAttachmentById(req.params.id);
  if (!att) return res.status(404).json({ error: 'Introuvable' });
  try { fs.unlinkSync(path.join(UPLOADS_DIR, att.filename)); } catch(e) {}
  db.deleteAttachment(req.params.id);
  res.json({ ok: true });
});

// ─── Shift Messages ─────────────────────────────────────────────────────────────
app.get('/api/shift-messages', requireAuth, (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  res.json(db.getShiftMessages(date));
});

app.post('/api/shift-messages', requireAuth, (req, res) => {
  const { message } = req.body;
  // date for midi→soir : today; date for soir→matin : today (matin reads it as "yesterday")
  const date = new Date().toISOString().split('T')[0];
  const from_shift = (req.session.shift === 'soir') ? 'soir' : 'midi';
  const msg = db.upsertShiftMessage({ from_shift, date, message, author_id: req.session.userId, author_name: req.session.name });
  io.emit('shift-message:updated', { from_shift, date, msg });
  res.json(msg);
});

// ─── Admin: Staff ──────────────────────────────────────────────────────────────
app.get('/api/admin/staff', requireAdmin, (req, res) => {
  res.json(db.getAllUsers());
});

app.post('/api/admin/staff', requireAdmin, (req, res) => {
  const { pin } = req.body;
  if (db.getUserByPin(pin)) return res.status(400).json({ error: 'Ce PIN est déjà utilisé' });
  const id = db.createUser(req.body);
  res.json(db.getUserById(id));
});

app.put('/api/admin/staff/:id', requireAdmin, (req, res) => {
  db.updateUser(req.params.id, req.body);
  res.json(db.getUserById(req.params.id));
});

app.delete('/api/admin/staff/:id', requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.session.userId) {
    return res.status(400).json({ error: 'Impossible de supprimer son propre compte' });
  }
  db.deleteUser(req.params.id);
  res.json({ ok: true });
});

// ─── Admin: Stats & Logs ───────────────────────────────────────────────────────
app.get('/api/admin/stats', requireAdminOrManager, (req, res) => {
  const { from, to } = req.query;
  res.json(db.getStats(from, to));
});

app.get('/api/admin/daily-log', requireAdminOrManager, (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  res.json(db.getDailyLog(date));
});

app.get('/api/admin/dashboard', requireAdminOrManager, (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  res.json(db.getDashboardData(date));
});

app.get('/api/admin/reservation-stats', requireAdminOrManager, (req, res) => {
  const { from, to } = req.query;
  res.json(db.getReservationStats(from, to));
});

app.get('/api/reservations/range', requireAdminOrManager, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from et to requis' });
  res.json(db.getReservationsByRange(from, to));
});

app.get('/api/marketing/stats', requireAdminOrManager, (req, res) => {
  res.json(db.getUpcomingReservationStats());
});


// ─── 15-minute alert system ────────────────────────────────────────────────────
const alertedReservations = new Set();

// ─── Joy.io Routes ─────────────────────────────────────────────────────────────
app.get('/api/joy/events', requireAuth, (req, res) => {
  const { date, upcoming } = req.query;
  const events = db.getJoyEvents({ date, upcoming: upcoming === '1', all: !date && !upcoming });
  res.json(events.map(ev => ({ ...ev, assigned_tables: JSON.parse(ev.assigned_tables || '[]') })));
});

app.post('/api/joy/assign-table', requireAdminOrManager, (req, res) => {
  const { table_id, joy_event_id } = req.body;
  if (!table_id && table_id !== 0) return res.status(400).json({ error: 'table_id manquant' });
  db.assignTableToJoyEvent(table_id, joy_event_id || null);
  io.emit('joy:updated');
  res.json({ ok: true });
});

app.post('/api/joy/sync', requireAdminOrManager, async (req, res) => {
  const result = await syncJoyEvents();
  res.json(result);
});

app.get('/api/joy/config', requireAdminOrManager, (req, res) => {
  res.json({
    url: db.getSetting('joy_ical_url') || '',
    lastSync: db.getSetting('joy_last_sync') || null
  });
});

app.put('/api/joy/config', requireAdmin, (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });
  db.setSetting('joy_ical_url', url);
  res.json({ ok: true });
});

app.delete('/api/joy/events/:id', requireAdminOrManager, (req, res) => {
  db.deleteJoyEvent(req.params.id);
  res.json({ ok: true });
});

// ─── Email Planning Cuisine ────────────────────────────────────────────────────
const PLANNING_RECIPIENT = 'pverdier.mospub@gmail.com';
const DAYS_LABEL = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi','Dimanche'];

function _getMonday(dateStr) {
  const d = new Date(dateStr); const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().split('T')[0];
}
function _addDays(dateStr, n) {
  const d = new Date(dateStr); d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}
function _minsBetween(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.slice(0,5).split(':').map(Number);
  const [eh, em] = end.slice(0,5).split(':').map(Number);
  return Math.max(0, (eh*60+em) - (sh*60+sm));
}
function _fmtH(mins) {
  if (!mins) return '—';
  const h = Math.floor(mins/60), m = mins%60;
  return h > 0 ? (m > 0 ? `${h}h${String(m).padStart(2,'0')}` : `${h}h`) : `${m}min`;
}

async function generatePlanningExcel(weekStart) {
  const weekEnd = _addDays(weekStart, 6);
  const { users, shifts } = db.getCuisinePlanning(weekStart);
  const events = db.getTimeEventsRange(weekStart, weekEnd);
  const dayDates = Array.from({length:7}, (_,i) => _addDays(weekStart, i));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mos Bellecour';

  // ── Sheet 1 : Planning ──────────────────────────────────────────────────────
  const ws = wb.addWorksheet('Planning');

  const C = {
    DARK:   'FF1A3A4A', GOLD:  'FFCDA443', GOLD_L: 'FFF9F1DC',
    GREEN_L:'FFE8F5E9', RED_L: 'FFFCE8E8', GREY_L: 'FFF5F5F5',
    WHITE:  'FFFFFFFF', TEXT_M:'FF888888', GREEN_D:'FF2E7D32', RED_D:'FFD32F2F',
  };

  const border = (color='FFD0D0D0') => (['top','bottom','left','right'].reduce((o,s)=>({...o,[s]:{style:'thin',color:{argb:color}}}),{}));

  // Titre
  ws.mergeCells('A1:J1');
  const s = new Date(weekStart), e = new Date(weekEnd);
  const fmt = d => `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
  ws.getCell('A1').value = `Planning Cuisine — Semaine du ${fmt(s)} au ${fmt(e)}`;
  ws.getCell('A1').font  = { bold:true, size:13, color:{argb:C.DARK} };
  ws.getCell('A1').fill  = { type:'pattern', pattern:'solid', fgColor:{argb:'FFFFF8E7'} };
  ws.getCell('A1').alignment = { horizontal:'center', vertical:'middle' };
  ws.getRow(1).height = 32;
  ws.getRow(2).height = 6;

  // En-têtes (ligne 3)
  const hdr = ws.getRow(3);
  hdr.height = 42;
  const hdrVals = ['Nom', ...dayDates.map((dd,i) => {
    const d = new Date(dd);
    return `${DAYS_LABEL[i]}\n${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}`;
  }), 'Total\nHeures', 'H. Supp'];
  hdrVals.forEach((v,i) => {
    const c = hdr.getCell(i+1);
    c.value = v;
    c.font  = { bold:true, color:{argb:C.WHITE}, size:10 };
    c.fill  = { type:'pattern', pattern:'solid', fgColor:{argb:C.DARK} };
    c.alignment = { horizontal:'center', vertical:'middle', wrapText:true };
    c.border = border(C.GOLD);
  });
  hdr.getCell(1).alignment = { horizontal:'left', vertical:'middle', wrapText:true };

  // Données
  users.forEach((u, idx) => {
    const row = ws.getRow(4 + idx);
    row.height = 26;

    // Nom
    const nc = row.getCell(1);
    nc.value = u.name;
    nc.font  = { bold:true, size:10 };
    nc.fill  = { type:'pattern', pattern:'solid', fgColor:{argb: idx%2===0 ? C.WHITE : 'FFF8F8F8'} };
    nc.alignment = { vertical:'middle' };
    nc.border = border();

    // Jours
    let totalMins = 0;
    dayDates.forEach((dd, i) => {
      const cell  = row.getCell(i+2);
      const shift = shifts.find(s => s.user_id===u.id && s.day_date===dd);
      if (!shift) {
        cell.value = '—';
        cell.fill  = { type:'pattern', pattern:'solid', fgColor:{argb:C.GREY_L} };
        cell.font  = { color:{argb:C.TEXT_M}, size:10 };
      } else if (shift.is_off) {
        cell.value = 'Repos';
        cell.fill  = { type:'pattern', pattern:'solid', fgColor:{argb:C.RED_L} };
        cell.font  = { bold:true, color:{argb:C.RED_D}, size:10 };
      } else {
        const st = shift.start_time?.slice(0,5)||'?', en = shift.end_time?.slice(0,5)||'?';
        cell.value = `${st} → ${en}`;
        cell.fill  = { type:'pattern', pattern:'solid', fgColor:{argb:C.GREEN_L} };
        cell.font  = { bold:true, color:{argb:C.GREEN_D}, size:10 };
        totalMins += _minsBetween(shift.start_time, shift.end_time);
      }
      cell.alignment = { horizontal:'center', vertical:'middle' };
      cell.border = border();
    });

    // Total heures
    const tc = row.getCell(9);
    tc.value = _fmtH(totalMins);
    tc.font  = { bold:true, color:{argb:C.DARK}, size:11 };
    tc.fill  = { type:'pattern', pattern:'solid', fgColor:{argb:C.GOLD_L} };
    tc.alignment = { horizontal:'center', vertical:'middle' };
    tc.border = border(C.GOLD);

    // Heures supp
    const suppMins = events.filter(ev=>ev.user_id===u.id&&ev.type==='supp').reduce((s,ev)=>s+(ev.minutes||0),0);
    const sc = row.getCell(10);
    if (suppMins > 0) {
      sc.value = `+${_fmtH(suppMins)}`;
      sc.font  = { bold:true, color:{argb:C.GREEN_D}, size:10 };
      sc.fill  = { type:'pattern', pattern:'solid', fgColor:{argb:C.GREEN_L} };
    } else {
      sc.value = '—';
      sc.font  = { color:{argb:C.TEXT_M}, size:10 };
    }
    sc.alignment = { horizontal:'center', vertical:'middle' };
    sc.border = border();
  });

  // Largeurs colonnes
  ws.getColumn(1).width = 16;
  for (let i=2; i<=8; i++) ws.getColumn(i).width = 13;
  ws.getColumn(9).width  = 12;
  ws.getColumn(10).width = 10;

  // ── Sheet 2 : Signalements ──────────────────────────────────────────────────
  const ws2 = wb.addWorksheet('Signalements');
  ws2.getRow(1).height = 28;
  const hdr2 = ['Nom', 'Date', 'Type', 'Durée', 'Note'];
  hdr2.forEach((v,i) => {
    const c = ws2.getRow(1).getCell(i+1);
    c.value = v; c.font = { bold:true, color:{argb:C.WHITE} };
    c.fill  = { type:'pattern', pattern:'solid', fgColor:{argb:C.DARK} };
    c.alignment = { horizontal:'center', vertical:'middle' };
    c.border = border(C.GOLD);
  });
  ws2.getColumn(1).width = 16; ws2.getColumn(2).width = 12; ws2.getColumn(3).width = 14;
  ws2.getColumn(4).width = 10; ws2.getColumn(5).width = 30;

  if (events.length === 0) {
    ws2.getRow(2).getCell(1).value = 'Aucun signalement cette semaine';
    ws2.getRow(2).getCell(1).font = { italic:true, color:{argb:C.TEXT_M} };
  } else {
    events.forEach((ev, i) => {
      const row = ws2.getRow(i+2);
      row.height = 22;
      const typeLabel = ev.type === 'retard' ? '⏰ Retard' : '➕ H. Supp';
      const bg = ev.type === 'retard' ? C.RED_L : C.GREEN_L;
      const fg = ev.type === 'retard' ? C.RED_D  : C.GREEN_D;
      [ev.user_name, ev.date, typeLabel, `${ev.minutes} min`, ev.note||''].forEach((v,j)=>{
        const c = row.getCell(j+1);
        c.value = v;
        c.font  = { size:10, color: j===2 ? {argb:fg} : {argb:C.DARK} };
        c.fill  = { type:'pattern', pattern:'solid', fgColor:{argb: j===2 ? bg : (i%2===0?C.WHITE:'FFF8F8F8')} };
        c.alignment = { vertical:'middle', horizontal: j>=2 ? 'center' : 'left' };
        c.border = border();
      });
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  return buf;
}

function createMailTransporter() {
  const user = db.getSetting('email_smtp_user');
  const pass = db.getSetting('email_smtp_pass');
  if (!user || !pass) return null;
  return nodemailer.createTransport({ host:'smtp.gmail.com', port:587, secure:false, auth:{ user, pass } });
}

async function sendWeeklyPlanningEmail(weekStart) {
  const transporter = createMailTransporter();
  if (!transporter) {
    console.log('[Email] ⚠️  Config SMTP absente — configurez email_smtp_user/pass dans les réglages admin');
    return { ok:false, error:'SMTP non configuré' };
  }
  try {
    const buf = await generatePlanningExcel(weekStart);
    const s = new Date(weekStart), e = new Date(_addDays(weekStart,6));
    const fmt = d => d.toLocaleDateString('fr-FR');
    const weekLabel = `${fmt(s)} → ${fmt(e)}`;
    const sender = db.getSetting('email_smtp_user');

    await transporter.sendMail({
      from: `"Mos Bellecour" <${sender}>`,
      to:   PLANNING_RECIPIENT,
      subject: `📅 Planning Cuisine — Semaine du ${weekLabel}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:500px">
        <h2 style="color:#1a3a4a">📅 Planning Cuisine</h2>
        <p>Bonjour,</p>
        <p>Veuillez trouver en pièce jointe le planning cuisine de la semaine du <strong>${weekLabel}</strong>, avec le total des heures et les signalements.</p>
        <p style="color:#888;font-size:12px">— Mos Bellecour</p>
      </div>`,
      attachments: [{
        filename: `Planning-Cuisine-${weekStart}.xlsx`,
        content:  buf,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }],
    });
    db.setSetting('email_planning_last_sent', weekStart);
    console.log(`[Email] ✅ Planning envoyé à ${PLANNING_RECIPIENT} pour la semaine du ${weekStart}`);
    return { ok:true };
  } catch(err) {
    console.error('[Email] ❌', err.message);
    return { ok:false, error:err.message };
  }
}

// Cron : chaque lundi entre 8h et 10h (vérifié toutes les 15 min)
setInterval(async () => {
  const now = new Date();
  if (now.getDay() !== 1) return;                               // pas lundi
  if (now.getHours() < 8 || now.getHours() >= 10) return;      // hors fenêtre
  const monday = now.toISOString().split('T')[0];
  if (db.getSetting('email_planning_last_sent') === monday) return; // déjà envoyé
  console.log('[Email] 📅 Lundi matin — envoi automatique du planning');
  await sendWeeklyPlanningEmail(monday);
}, 15 * 60 * 1000);

// Routes admin email config
app.get('/api/admin/email-config', requireAdmin, (req, res) => {
  const user = db.getSetting('email_smtp_user') || '';
  const pass = db.getSetting('email_smtp_pass') || '';
  res.json({ user, configured: !!(user && pass), lastSent: db.getSetting('email_planning_last_sent') });
});
app.put('/api/admin/email-config', requireAdmin, (req, res) => {
  const { user, pass } = req.body;
  if (user) db.setSetting('email_smtp_user', user.trim());
  if (pass) db.setSetting('email_smtp_pass', pass.trim());
  res.json({ ok:true });
});
app.post('/api/admin/email-test', requireAdmin, async (req, res) => {
  const monday = _getMonday(new Date().toISOString().split('T')[0]);
  const result = await sendWeeklyPlanningEmail(monday);
  res.json(result);
});

// ─── Génération PDF demande de congés ──────────────────────────────────────────
function generateCongePDF({ userName, requestedAt, dateFrom, dateTo, motif, signatureDataUrl }) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fmtDate = d => new Date(d).toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
    const primary = '#CDA443';
    const dark    = '#1a3a4a';

    // ── En-tête ──
    doc.rect(0, 0, doc.page.width, 80).fill(dark);
    doc.fillColor('#ffffff').fontSize(20).font('Helvetica-Bold')
       .text('MOS PUB MERCIÈRE', 50, 28);
    doc.fillColor(primary).fontSize(11).font('Helvetica')
       .text('Demande de congés', 50, 52);

    // ── Titre ──
    doc.fillColor(dark).fontSize(16).font('Helvetica-Bold')
       .text('DEMANDE DE CONGÉS', 50, 110);
    doc.moveTo(50, 132).lineTo(545, 132).strokeColor(primary).lineWidth(2).stroke();

    // ── Champs ──
    const rows = [
      ['Employé(e)',          userName],
      ['Date de la demande',  requestedAt],
      ['Début souhaité',      fmtDate(dateFrom)],
      ['Fin souhaitée',       fmtDate(dateTo)],
    ];
    if (motif) rows.push(['Motif', motif]);

    let y = 150;
    rows.forEach(([label, value], i) => {
      if (i % 2 === 0) doc.rect(50, y, 495, 28).fill('#f5f7fa');
      doc.fillColor('#666666').fontSize(10).font('Helvetica').text(label, 60, y + 9);
      doc.fillColor(dark).fontSize(11).font('Helvetica-Bold').text(value, 220, y + 9);
      y += 28;
    });

    // ── Signature ──
    y += 20;
    doc.fillColor(dark).fontSize(11).font('Helvetica-Bold').text('Signature :', 50, y);
    y += 20;

    if (signatureDataUrl) {
      try {
        const b64 = signatureDataUrl.replace(/^data:image\/\w+;base64,/, '');
        const imgBuf = Buffer.from(b64, 'base64');
        doc.rect(50, y, 300, 100).strokeColor('#cccccc').lineWidth(1).stroke();
        doc.image(imgBuf, 55, y + 5, { width: 290, height: 90, fit: [290, 90] });
      } catch(e) {
        doc.fillColor('#aaa').fontSize(10).text('[Signature non disponible]', 60, y + 40);
      }
    }

    // ── Pied de page ──
    doc.fillColor('#aaaaaa').fontSize(9).font('Helvetica')
       .text('Document généré automatiquement — Mos Bellecour', 50, 760, { align: 'center' });

    doc.end();
  });
}

// ─── Demandes de congés ────────────────────────────────────────────────────────
app.post('/api/staff/conge-request', requireAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo, motif, signature } = req.body;
    const userId   = req.session.userId;
    const userName = req.session.name;
    if (!dateFrom || !dateTo) return res.status(400).json({ error: 'Dates manquantes' });

    // Sauvegarder en base
    let requestId = null;
    try {
      requestId = db.createCongeRequest({ user_id: userId, user_name: userName, date_from: dateFrom, date_to: dateTo, motif });
    } catch(e) {
      console.error('[Congé] DB error:', e.message);
      return res.status(500).json({ error: 'Erreur base de données: ' + e.message });
    }

    // Répondre immédiatement — email/PDF en arrière-plan
    res.json({ ok: true, id: requestId });

    // Générer le PDF + envoyer l'email en async (non-bloquant)
    setImmediate(async () => {
      const todayFr = new Date().toLocaleDateString('fr-FR');
      let pdfBuf = null;
      try {
        pdfBuf = await generateCongePDF({
          userName: userName, requestedAt: todayFr,
          dateFrom, dateTo, motif, signatureDataUrl: signature,
        });
      } catch(e) { console.error('[Congé] PDF error:', e.message); }

      const transporter = createMailTransporter();
      if (!transporter) { console.log('[Congé] SMTP non configuré'); return; }

      const fmtShort = d => new Date(d).toLocaleDateString('fr-FR');
      try {
        const sender = db.getSetting('email_smtp_user');
        const mailOpts = {
          from: `"Mos Bellecour" <${sender}>`,
          to:   PLANNING_RECIPIENT,
          subject: `📋 Demande de congés — ${userName}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:500px;padding:20px">
            <h2 style="color:#1a3a4a">📋 Demande de congés</h2>
            <p><strong>${userName}</strong> a soumis une demande de congés.</p>
            <p>📅 Du <strong>${fmtShort(dateFrom)}</strong> au <strong>${fmtShort(dateTo)}</strong></p>
            ${motif ? `<p>Motif : ${motif}</p>` : ''}
            <p style="color:#888;font-size:12px">Voir le détail et la signature dans le PDF ci-joint.</p>
            <p style="color:#aaa;font-size:11px;margin-top:20px">— Mos Bellecour</p>
          </div>`,
        };
        if (pdfBuf) {
          mailOpts.attachments = [{
            filename: `Conge-${userName.replace(/\s+/g,'-')}-${dateFrom}.pdf`,
            content:  pdfBuf,
            contentType: 'application/pdf',
          }];
        }
        await transporter.sendMail(mailOpts);
        console.log(`[Congé] ✅ Email envoyé pour ${user.name}`);
      } catch(err) {
        console.error('[Congé] ❌ Email:', err.message);
      }
    });

  } catch(e) {
    console.error('[Congé] ❌ Route error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get('/api/staff/conge-requests', requireAuth, (req, res) => {
  res.json(db.getCongeRequestsByUser(req.session.user.id));
});

app.get('/api/admin/conge-requests', requireAdminOrManager, (req, res) => {
  res.json(db.getAllCongeRequests());
});

app.put('/api/admin/conge-requests/:id', requireAdminOrManager, (req, res) => {
  const { status } = req.body;
  if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  db.updateCongeRequestStatus(req.params.id, status, req.session.name);
  res.json({ ok: true });
});

// ─── Webhook déploiement automatique ───────────────────────────────────────────
const DEPLOY_TOKEN = process.env.DEPLOY_TOKEN || 'mos-deploy-secret';
app.post('/webhook/deploy', express.json(), (req, res) => {
  const token = req.headers['x-deploy-token'] || req.query.token;
  if (token !== DEPLOY_TOKEN) {
    return res.status(403).json({ error: 'Token invalide' });
  }
  res.json({ ok: true, message: 'Déploiement en cours…' });
  console.log('[Deploy] 🚀 Webhook reçu — git pull + pm2 restart');
  exec(
    'cd /var/www/mos && git pull origin main && pm2 restart mos-pub',
    (err, stdout, stderr) => {
      if (err) console.error('[Deploy] ❌', err.message);
      else console.log('[Deploy] ✅\n', stdout);
    }
  );
});

// Auto-sync Joy.io au démarrage puis toutes les 2 min
setTimeout(syncJoyEvents, 8000);
setInterval(syncJoyEvents, 2 * 60 * 1000);

setInterval(() => {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const reservations = db.getReservationsByDate(today);

  reservations.forEach(r => {
    if (r.status !== 'confirmed' || alertedReservations.has(r.id)) return;
    const [rHour, rMin] = r.time.split(':').map(Number);
    const alertTime = new Date(now);
    alertTime.setHours(rHour, rMin + 15, 0, 0);
    if (now >= alertTime) {
      alertedReservations.add(r.id);
      io.emit('alert:no_show', {
        reservationId: r.id,
        tableId: r.table_id,
        tableName: r.table_name,
        customerName: r.customer_name,
        partySize: r.party_size,
        time: r.time,
        message: `⚠️ ${r.customer_name} (${r.party_size} pers.) — Table ${r.table_name || r.table_id} — Pas d'arrivée depuis ${r.time}`
      });
    }
  });
}, 30000); // Check every 30 seconds

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n🍺 Maker of Simplicity — Mos Bellecour');
  console.log(`📡 Serveur démarré sur http://localhost:${PORT}`);
  console.log('🔑 PIN Admin par défaut : 0000\n');
});
