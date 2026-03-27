// ─── API helper ────────────────────────────────────────────────────────────────
const api = {
  async get(url) {
    const r = await fetch(url);
    if (r.status === 401) { window.location.href = '/'; return null; }
    return r.json();
  },
  async post(url, body) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (r.status === 401) { window.location.href = '/'; return null; }
      try { return await r.json(); } catch { return { ok: false, error: `Erreur serveur (${r.status})` }; }
    } catch(e) { return { ok: false, error: e.message }; }
  },
  async put(url, body) {
    try {
      const r = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (r.status === 401) { window.location.href = '/'; return null; }
      try { return await r.json(); } catch { return { ok: false, error: `Erreur serveur (${r.status})` }; }
    } catch(e) { return { ok: false, error: e.message }; }
  },
  async delete(url) {
    const r = await fetch(url, { method: 'DELETE' });
    if (r.status === 401) { window.location.href = '/'; return null; }
    return r.json();
  }
};

// ─── Toast notifications ───────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  t.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
  container.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ─── Nav builder ───────────────────────────────────────────────────────────────
async function buildNav(activePage) {
  const user = await api.get('/api/auth/me');
  if (!user) return;
  window.__mosUser = user;   // disponible globalement sur toutes les pages

  const nav = document.getElementById('nav');
  if (!nav) return;

  // ── Liens avec icônes séparées pour la bottom nav mobile ──
  const adminLinks = [
    { href: '/admin/dashboard.html',    label: '📊 Dashboard',     mobileLabel: 'Dashboard',   icon: '📊', key: 'dashboard' },
    { href: '/admin/manager.html',      label: '📋 Manager',        mobileLabel: 'Manager',     icon: '📋', key: 'manager' },
    { href: '/staff/reservations.html', label: '📋 Réservations',   mobileLabel: 'Résas',       icon: '📋', key: 'reservations' },
    { href: '/staff/tables.html',       label: '🍽️ Salle',          mobileLabel: 'Salle',       icon: '🍽️', key: 'tables' },
    { href: '/admin/email.html',        label: '📧 Email',             mobileLabel: 'Email',      icon: '📧',   key: 'email' },
    { href: '/resa/devis.html',         label: '📝 Devis',             mobileLabel: 'Devis',      icon: '📝',   key: 'resa-devis' },
    { href: '/staff/planning.html',     label: '📅 Planning',           mobileLabel: 'Planning',   icon: '📅',   key: 'planning' },
  ];
  const managerMidiLinks = [
    { href: '/admin/dashboard.html',    label: '📊 Dashboard',     mobileLabel: 'Dashboard',   icon: '📊', key: 'dashboard' },
    { href: '/staff/taches.html',       label: '✅ Mes Tâches',     mobileLabel: 'Tâches',      icon: '✅', key: 'taches' },
    { href: '/staff/reservations.html', label: '📋 Réservations',   mobileLabel: 'Résas',       icon: '📋', key: 'reservations' },
    { href: '/staff/tables.html',       label: '🍽️ Plan de Salle',  mobileLabel: 'Salle',       icon: '🍽️', key: 'tables' },
  ];
  const managerSoirLinks = [
    { href: '/admin/dashboard.html',    label: '📊 Dashboard',     mobileLabel: 'Dashboard',   icon: '📊', key: 'dashboard' },
    { href: '/staff/taches.html',       label: '🌙 Mes Tâches',    mobileLabel: 'Tâches',      icon: '🌙', key: 'taches' },
    { href: '/staff/reservations.html', label: '📋 Réservations',   mobileLabel: 'Résas',       icon: '📋', key: 'reservations' },
    { href: '/staff/tables.html',       label: '🍽️ Plan de Salle',  mobileLabel: 'Salle',       icon: '🍽️', key: 'tables' },
    { href: '/staff/planning.html',     label: '📅 Planning',         mobileLabel: 'Planning',    icon: '📅', key: 'planning' },
  ];
  const staffMidiLinks = [
    { href: '/staff/taches.html',       label: '✅ Mes Tâches',     mobileLabel: 'Tâches',      icon: '✅', key: 'taches' },
    { href: '/staff/reservations.html', label: '📋 Réservations',   mobileLabel: 'Résas',       icon: '📋', key: 'reservations' },
    { href: '/staff/tables.html',       label: '🍽️ Plan de Salle',  mobileLabel: 'Salle',       icon: '🍽️', key: 'tables' },
    { href: '/staff/planning.html',     label: '📅 Planning',        mobileLabel: 'Planning',    icon: '📅', key: 'planning' },
  ];
  const staffSoirLinks = [
    { href: '/staff/taches.html',       label: '🌙 Mes Tâches',    mobileLabel: 'Tâches',      icon: '🌙', key: 'taches' },
    { href: '/staff/reservations.html', label: '📋 Réservations',   mobileLabel: 'Résas',       icon: '📋', key: 'reservations' },
    { href: '/staff/tables.html',       label: '🍽️ Plan de Salle',  mobileLabel: 'Salle',       icon: '🍽️', key: 'tables' },
    { href: '/staff/planning.html',     label: '📅 Planning',        mobileLabel: 'Planning',    icon: '📅', key: 'planning' },
  ];
  const marketingLinks = [
    { href: '/marketing/dashboard.html',     label: '📊 Dashboard',      mobileLabel: 'Dashboard', icon: '📊', key: 'marketing-dashboard' },
    { href: '/marketing/reservations.html',  label: '📋 Réservations',   mobileLabel: 'Résas',     icon: '📋', key: 'marketing-reservations' },
    { href: '/admin/joy.html',               label: '🔗 Joy.io',          mobileLabel: 'Joy',       icon: '🔗', key: 'joy' },
    { href: '/admin/manager.html',           label: '📋 Manager',         mobileLabel: 'Manager',   icon: '📋', key: 'manager' },
    { href: '/resa/devis.html',              label: '📝 Devis',            mobileLabel: 'Devis',     icon: '📝', key: 'resa-devis' },
    { href: '/staff/planning.html',          label: '📅 Planning',          mobileLabel: 'Planning',  icon: '📅', key: 'planning' },
  ];
  const resaLinks = [
    { href: '/resa/dashboard.html',  label: '📊 Dashboard',  mobileLabel: 'Dashboard', icon: '📊', key: 'resa-dashboard' },
    { href: '/resa/gestion.html',    label: '📋 Gestion',    mobileLabel: 'Gestion',   icon: '📋', key: 'resa-gestion'   },
    { href: '/resa/suivi.html',      label: '📈 Suivi',      mobileLabel: 'Suivi',     icon: '📈', key: 'resa-suivi'     },
    { href: '/resa/devis.html',      label: '📝 Devis',      mobileLabel: 'Devis',     icon: '📝', key: 'resa-devis'     },
    { href: '/staff/planning.html',  label: '📅 Planning',   mobileLabel: 'Planning',  icon: '📅', key: 'planning'       },
  ];

  const links = user.role === 'admin'                               ? adminLinks
    : user.shift === 'resa'                                         ? resaLinks
    : user.shift === 'marketing'                                    ? marketingLinks
    : user.role === 'manager' && user.shift === 'midi'              ? managerMidiLinks
    : user.role === 'manager' && user.shift === 'soir'              ? managerSoirLinks
    : user.shift === 'midi'                                         ? staffMidiLinks
    :                                                                 staffSoirLinks;

  // ── Top nav (desktop) ──
  nav.innerHTML = `
    <a href="/" class="nav-logo">
      <img src="/images/logo.png" alt="MOS" class="nav-logo-img" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
      <span class="nav-logo-text" style="display:none;">MOS</span>
    </a>
    <div class="nav-links">
      ${links.map(l => `<a href="${l.href}" class="nav-link ${l.key === activePage ? 'active' : ''}">${l.label}</a>`).join('')}
    </div>
    <div class="nav-right">
      <span class="nav-user">${user.name}</span>
      <button class="btn-logout" onclick="logout()">Déco.</button>
    </div>
  `;

  // ── Bottom nav (mobile) — max 5 items ──
  const mobileLinks = links.slice(0, 5);
  const bottomNav = document.createElement('nav');
  bottomNav.className = 'bottom-nav';
  bottomNav.innerHTML = `
    <div class="bottom-nav-inner">
      ${mobileLinks.map(l => `
        <a href="${l.href}" class="bottom-nav-item ${l.key === activePage ? 'active' : ''}">
          <div class="bottom-nav-icon">${l.icon}</div>
          <div class="bottom-nav-label">${l.mobileLabel}</div>
        </a>
      `).join('')}
    </div>
  `;
  document.body.appendChild(bottomNav);
}

async function logout() {
  await api.post('/api/auth/logout', {});
  window.location.href = '/';
}

// ─── Date helpers ──────────────────────────────────────────────────────────────
function today() {
  return new Date().toISOString().split('T')[0];
}
function formatDate(d) {
  return new Date(d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
function formatTime(t) {
  return t;
}
function formatDateTime(dt) {
  if (!dt) return '';
  const d = new Date(dt);
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// ─── Modal helpers ─────────────────────────────────────────────────────────────
function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
}
function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
}
function closeOnOverlay(event, id) {
  if (event.target.id === id) hideModal(id);
}

// ─── Alert sound ───────────────────────────────────────────────────────────────
function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 150, 300].forEach(delay => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0, ctx.currentTime + delay / 1000);
      gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + delay / 1000 + 0.05);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + delay / 1000 + 0.3);
      osc.start(ctx.currentTime + delay / 1000);
      osc.stop(ctx.currentTime + delay / 1000 + 0.35);
    });
  } catch (e) {}
}
