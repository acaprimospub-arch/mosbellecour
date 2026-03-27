const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'mos.db'));
db.exec('PRAGMA journal_mode = WAL');

// ─── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pin TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'staff',
    shift TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    section TEXT,
    subsection TEXT,
    description TEXT NOT NULL,
    task_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS task_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    completed_at TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(task_id, user_id, date),
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS floor_tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    zone TEXT NOT NULL DEFAULT 'salle_bas',
    x REAL DEFAULT 50,
    y REAL DEFAULT 50,
    width REAL DEFAULT 65,
    height REAL DEFAULT 65,
    shape TEXT DEFAULT 'square',
    capacity INTEGER DEFAULT 2,
    is_decoration INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id INTEGER,
    customer_name TEXT NOT NULL,
    phone TEXT,
    party_size INTEGER DEFAULT 2,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    notes TEXT,
    status TEXT DEFAULT 'confirmed',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (table_id) REFERENCES floor_tables(id)
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_number INTEGER NOT NULL,
    year INTEGER NOT NULL,
    week_start TEXT NOT NULL,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(week_number, year)
  );

  CREATE TABLE IF NOT EXISTS schedule_shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    day_date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(schedule_id, user_id, day_date)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS hr_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    duration_min INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS joy_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    joy_uid TEXT UNIQUE NOT NULL,
    customer_name TEXT,
    participants INTEGER DEFAULT 0,
    date TEXT,
    time_start TEXT,
    time_end TEXT,
    space TEXT,
    raw_summary TEXT,
    raw_description TEXT,
    status TEXT DEFAULT 'confirmed',
    last_sync TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

// ─── Migrations colonnes (BDs existantes) ──────────────────────────────────────
try { db.exec("ALTER TABLE floor_tables ADD COLUMN zone TEXT DEFAULT 'salle_bas'"); } catch(e) {}
try { db.exec("ALTER TABLE floor_tables ADD COLUMN is_decoration INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN email TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE joy_events ADD COLUMN assigned_tables TEXT DEFAULT '[]'"); } catch(e) {}
try { db.exec("ALTER TABLE reservations ADD COLUMN joy_event_id INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE reservations ADD COLUMN space TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE reservations ADD COLUMN table_ids TEXT DEFAULT '[]'"); } catch(e) {}
// Migration : on peuple table_ids depuis table_id pour les lignes existantes
try { db.exec("UPDATE reservations SET table_ids = json_array(table_id) WHERE table_id IS NOT NULL AND (table_ids IS NULL OR table_ids = '[]')"); } catch(e) {}
try { db.exec("ALTER TABLE tasks ADD COLUMN domain TEXT DEFAULT 'salle'"); } catch(e) {}
try { db.exec("ALTER TABLE reservations ADD COLUMN admin_notes TEXT"); } catch(e) {}

// ─── Table messages d'équipe ───────────────────────────────────────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shift_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_shift TEXT NOT NULL,
      date TEXT NOT NULL,
      message TEXT NOT NULL,
      author_id INTEGER,
      author_name TEXT,
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      UNIQUE(from_shift, date)
    )
  `);
} catch(e) {}


// ─── Nettoyage doublons Joy au démarrage ───────────────────────────────────────
// Supprime les résas Joy en double (garde celle avec table assignée ou la plus récente)
db.exec(`
  DELETE FROM reservations
  WHERE joy_event_id IS NOT NULL
  AND id NOT IN (
    SELECT COALESCE(
      (SELECT id FROM reservations r2 WHERE r2.joy_event_id = r1.joy_event_id AND r2.table_id IS NOT NULL ORDER BY r2.id DESC LIMIT 1),
      (SELECT id FROM reservations r2 WHERE r2.joy_event_id = r1.joy_event_id ORDER BY r2.id DESC LIMIT 1)
    )
    FROM reservations r1
    WHERE r1.joy_event_id IS NOT NULL
    GROUP BY r1.joy_event_id
  )
`);
// Supprime les doublons de joy_events par fingerprint (même nom+date+heure, UID différent)
db.exec(`
  DELETE FROM joy_events
  WHERE id NOT IN (
    SELECT MIN(id) FROM joy_events
    GROUP BY customer_name, date, time_start
  )
`);

// ─── Seed Joy iCal URL ─────────────────────────────────────────────────────────
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('joy_ical_url', 'https://prvt.re/jQTqzg')").run();

// ─── Seed équipe ───────────────────────────────────────────────────────────────
const _seedUsers = [
  { name: 'Arthur', pin: '7404', role: 'admin', shift: null },
];
const _insertUser = db.prepare('INSERT OR IGNORE INTO users (name, pin, role, shift) VALUES (?, ?, ?, ?)');
for (const u of _seedUsers) _insertUser.run(u.name, u.pin, u.role, u.shift);
// Désactiver les anciens comptes test génériques
db.prepare("UPDATE users SET active = 0 WHERE pin IN ('0000','1234','11111')").run();

// ─── Seed tasks ────────────────────────────────────────────────────────────────
if (db.prepare('SELECT COUNT(*) as c FROM tasks').get().c === 0) {
  const insertTask = db.prepare(
    'INSERT INTO tasks (category, section, subsection, description, task_order) VALUES (?, ?, ?, ?, ?)'
  );

  db.exec('BEGIN');
  const seedList = [
    // ── MATIN - Bar ──
    ['matin', 'Bar', 'Mise en place machine à café', 'Allumer la machine, recharge lait, café, thé, chocolat, sirop & chantilly', 0],
    ['matin', 'Bar', 'Mise en place machine à café', 'Nettoyer la machine à café (pause tasse, porte frigo, dessus de la machine)', 0],
    ['matin', 'Bar', 'Mise en place plonge', 'Allumer la plonge et regarder le bon fonctionnement', 0],
    ['matin', 'Bar', 'Mise en place station cocktail', 'Installer les becs verseurs (ciel de bar & speed rack)', 0],
    ['matin', 'Bar', 'Mise en place station cocktail', 'Faire le plein de sucre de cannes', 0],
    ['matin', 'Bar', 'Mise en place station cocktail', 'Faire le plein de paille (petite & grande)', 0],
    ['matin', 'Bar', 'Mise en place station cocktail', 'Faire le plein de glaçon et glace pilée', 0],
    ['matin', 'Bar', 'Mise en place station cocktail', 'Remplir les sirops', 0],
    ['matin', 'Bar', 'Mise en place de la préparation bar', 'Couper les agrumes et la menthe dans les quantités énoncées', 0],
    ['matin', 'Bar', 'Mise en place de la préparation bar', 'Aller chercher les cookies avec les cuisiniers', 0],
    ['matin', 'Bar', 'Mise en place de la préparation bar', 'Préparation salade de fruit', 0],
    ['matin', 'Bar', 'Mise en place de la préparation bar', 'Les Dim/Mar/Ven : faire la commande des fruits & menthes auprès de la cuisine', 0],
    ['matin', 'Bar', 'Mise en place de la préparation bar', 'Découpe des fruits et mise en place dans le déshydrateur', 0],
    ['matin', 'Bar', 'Nettoyage des surfaces de travail', 'Nettoyer les inox du bar (surface de travail et façade)', 0],
    ['matin', 'Bar', 'Nettoyage des surfaces de travail', 'Faire les vides', 0],
    ['matin', 'Bar', 'Plat du jour et quantité', 'Demander les informations concernant les produits du moment aux chefs ainsi que les quantités', 0],
    ['matin', 'Bar', 'Plat du jour et quantité', 'Entrer les quantités sur caisse', 0],
    // ── MATIN - Salle ──
    ['matin', 'Salle', 'Lumière et bâches', 'Allumer les lumières et descendre les bâches', 0],
    ['matin', 'Salle', 'Mise en place de la salle', 'Descendre les chaises/bancs et installer les tables', 0],
    ['matin', 'Salle', 'Mise en place de la salle', 'Nettoyer les tables et les chaises', 0],
    ['matin', 'Salle', 'Mise en place pour service de midi', 'Nettoyage des couverts au vinaigre', 0],
    ['matin', 'Salle', 'Mise en place pour service de midi', 'Dresser les tables', 0],
    ['matin', 'Salle', 'Mise en place pour service de midi', 'Mettre les cartes boissons sur tables', 0],
    ['matin', 'Salle', 'Mise en place pour service de midi', 'Préparation des pots de sauce', 0],
    ['matin', 'Salle', 'Mise en place pour service de midi', 'Couper le pain', 0],
    ['matin', 'Salle', 'Mise en place pour service de midi', 'Plier le linge', 0],
    ['matin', 'Salle', 'Mise en place pour service de midi', 'Allumer la musique et les écrans', 0],
    ['matin', 'Salle', 'Mise en place pour service de midi', 'Mise en place toilettes (papier, savon, hygiène)', 0],
    // ── MATIN - Terrasse ──
    ['matin', 'Terrasse', 'Nettoyage de la terrasse', "Passer un coup de balais + seau d'eau si nécessaire", 0],
    ['matin', 'Terrasse', 'Mise en place de la terrasse', 'Installer chaises + tables', 0],
    ['matin', 'Terrasse', 'Mise en place de la terrasse', 'Nettoyage chaises + tables', 0],
    ['matin', 'Terrasse', 'Mise en place de la terrasse', 'Mise en place des cendriers propres sur table', 0],
    ['matin', 'Terrasse', 'Mise en place de la terrasse', 'Mettre les panneaux extérieurs', 0],
    ['matin', 'Terrasse', 'Mise en place de la terrasse', 'Porte menu propre aux entrées', 0],
    ['matin', 'Terrasse', 'Dresser la terrasse', 'Dresser les tables', 0],
    ['matin', 'Terrasse', 'Dresser la terrasse', 'Ajouter les verres à vin', 0],
    ['matin', 'Terrasse', 'Dresser la terrasse', 'Ajouter les pots de fleurs', 0],
    // ── PASSATION - Bar ──
    ['passation', 'Bar', 'Passation machine à café', 'Vérifier les stocks de café, sucre, thé, chocolat, lait (recharger si besoin)', 0],
    ['passation', 'Bar', 'Passation machine à café', 'Nettoyer la machine à café (pause tasse, porte frigo, dessus de la machine)', 0],
    ['passation', 'Bar', 'Mise en place station cocktail', 'Faire le plein de sucre de cannes', 0],
    ['passation', 'Bar', 'Mise en place station cocktail', 'Faire le plein de paille (petite & grande)', 0],
    ['passation', 'Bar', 'Mise en place station cocktail', 'Faire le plein de glaçon et glace pilée', 0],
    ['passation', 'Bar', 'Mise en place station cocktail', 'Remplir les sirops', 0],
    ['passation', 'Bar', 'Stock de produit bar', 'Vérification des stocks agrumes et herbes (basilic et menthe) (recharger si besoin)', 0],
    ['passation', 'Bar', 'Nettoyage des surfaces de travail', 'Changer poubelle', 0],
    ['passation', 'Bar', 'Nettoyage des surfaces de travail', 'Nettoyer les inox du bar (surface de travail et façade)', 0],
    ['passation', 'Bar', 'Re-cave', 'Faire la liste des produits à remonter pour le service du soir', 0],
    ['passation', 'Bar', 'Re-cave', "Vérifier que l'ensemble a bien été remonté", 0],
    // ── PASSATION - Salle ──
    ['passation', 'Salle', 'Mise en place de la salle', 'Nettoyer les tables et les chaises', 0],
    ['passation', 'Salle', 'Mise en place pour service du soir', 'Nettoyage des couverts au vinaigre', 0],
    ['passation', 'Salle', 'Mise en place pour service du soir', 'Dé-dresser les tables', 0],
    ['passation', 'Salle', 'Mise en place pour service du soir', 'Préparation des pots de sauce', 0],
    ['passation', 'Salle', 'Mise en place pour service du soir', 'Couper le pain', 0],
    ['passation', 'Salle', 'Mise en place pour service du soir', 'Lancer la machine à linge', 0],
    ['passation', 'Salle', 'Mise en place pour service du soir', 'Vérification des toilettes (papier, savon, hygiène)', 0],
    // ── PASSATION - Terrasse ──
    ['passation', 'Terrasse', 'Mise en place de la terrasse', 'Installer chaises + tables', 0],
    ['passation', 'Terrasse', 'Mise en place de la terrasse', 'Nettoyage chaises + tables', 0],
    ['passation', 'Terrasse', 'Mise en place de la terrasse', 'Mise en place des cendriers propres sur table', 0],
    ['passation', 'Terrasse', 'Mise en place de la terrasse', 'Rentrer les portes menu & les pots de plantes & les barrières', 0],
    ['passation', 'Terrasse', 'Dresser la terrasse', 'Dresser les tables', 0],
    ['passation', 'Terrasse', 'Dresser la terrasse', 'Ajouter les verres à vin', 0],
    ['passation', 'Terrasse', 'Dresser la terrasse', 'Ajouter les pots de fleurs', 0],

    // ── SOIR - Fermeture Bar ──
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Conserver et/ou jeter les garnitures fraiches', 0],
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Nettoyer le matériel de bar', 0],
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Enlever et rincer les becs verseurs', 0],
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Nettoyer les tapis de bar', 0],
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Vider et nettoyer les bacs à glace', 0],
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Ranger et réapprovisionner les condiments', 0],
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Remplir les sirops', 0],
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Remplir les pailles', 0],

    ['soir', 'Fermeture Bar', 'Tireuses à bière', 'Rincer et essuyer les becs de tirage', 0],
    ['soir', 'Fermeture Bar', 'Tireuses à bière', 'Nettoyer les grilles de récupération', 0],
    ['soir', 'Fermeture Bar', 'Tireuses à bière', 'Nettoyer les surfaces', 0],
    ['soir', 'Fermeture Bar', 'Tireuses à bière', 'Nettoyer la facade des tireuses', 0],
    ['soir', 'Fermeture Bar', 'Tireuses à bière', 'Ranger les sirops', 0],

    ['soir', 'Fermeture Bar', 'Remontée de cave', 'Vérifier les dates de consommation de l\'ensemble des produits (1x/semaine)', 0],
    ['soir', 'Fermeture Bar', 'Remontée de cave', 'Réapprovisionner les frigos à softs', 0],
    ['soir', 'Fermeture Bar', 'Remontée de cave', 'Réapprovisionner les vins et alcools', 0],
    ['soir', 'Fermeture Bar', 'Remontée de cave', 'Réapprovisionner les sirops et purées', 0],
    ['soir', 'Fermeture Bar', 'Remontée de cave', 'Ranger les caisses de bouteilles vides', 0],
    ['soir', 'Fermeture Bar', 'Remontée de cave', 'Ranger les fûts vides', 0],
    ['soir', 'Fermeture Bar', 'Remontée de cave', 'Compter les fûts la veille de la commande', 0],

    ['soir', 'Fermeture Bar', 'Nettoyage bar', 'Nettoyer la machine à café', 0],
    ['soir', 'Fermeture Bar', 'Nettoyage bar', 'Nettoyer les surfaces autour du bar', 0],
    ['soir', 'Fermeture Bar', 'Nettoyage bar', 'Nettoyer la plonge', 0],
    ['soir', 'Fermeture Bar', 'Nettoyage bar', 'Nettoyer les vitres des frigos', 0],
    ['soir', 'Fermeture Bar', 'Nettoyage bar', 'Vider la poubelle', 0],
    ['soir', 'Fermeture Bar', 'Nettoyage bar', 'Poser du débouchant dans les écoulements (2x/mois)', 0],

    // ── SOIR - Fermeture Salle ──
    ['soir', 'Fermeture Salle', 'Mobilier', 'Débarrasser les tables', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Ranger les cartes', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Nettoyer les tables et les chaises', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Réordonner les tables en fonction du plan de salle', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Ranger la zone des couverts', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Vider la poubelle proche de la cuisine', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Éteindre les projecteurs et les télévisions', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Couper les systèmes de ventilation', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Éteindre les enseignes lumineuses', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Sortir les poubelles en fonction du planning', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Nettoyer les supports de cartes (1x/semaine)', 0],

    ['soir', 'Fermeture Salle', 'Toilettes', 'Nettoyer les urinoirs et les cuvettes', 0],
    ['soir', 'Fermeture Salle', 'Toilettes', 'Nettoyer les lavabos et les meubles', 0],
    ['soir', 'Fermeture Salle', 'Toilettes', 'Recharger le papier toilettes et les savons', 0],
    ['soir', 'Fermeture Salle', 'Toilettes', 'Vider et nettoyer les sèches-mains', 0],
    ['soir', 'Fermeture Salle', 'Toilettes', 'Nettoyer le filtre des sèches-mains (1x/semaine)', 0],
    ['soir', 'Fermeture Salle', 'Toilettes', 'Vider les poubelles', 0],
    ['soir', 'Fermeture Salle', 'Toilettes', 'Poser du débouchant dans toutes les toilettes (2x/mois)', 0],

    // ── SOIR - Fermeture Terrasse ──
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Débarrasser les tables', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Ranger les cartes', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Ranger les décorations', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Débarrasser et nettoyer les cendriers', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Nettoyer les tables et les chaises', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Rentrer les tables et chaises', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Rentrer les panneaux', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Balayer la terrasse', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Fermer les bâches', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Éteindre les éclairages extérieurs', 0],

    // ── SOIR - Fermeture Bâtiment ──
    ['soir', 'Fermeture Bâtiment', 'Fermeture bâtiment', 'Vérifier les portes et fenêtres', 0],
    ['soir', 'Fermeture Bâtiment', 'Fermeture bâtiment', 'Éteindre la musique', 0],
    ['soir', 'Fermeture Bâtiment', 'Fermeture bâtiment', 'Éteindre les lumières', 0],
    ['soir', 'Fermeture Bâtiment', 'Fermeture bâtiment', 'Activer l\'alarme', 0],
  ];
  seedList.forEach((t, i) => insertTask.run(t[0], t[1], t[2], t[3], i));
  db.exec('COMMIT');
}

// ─── Migration : Tâches SOIR (pour les DBs existantes sans ces tâches) ────────
if (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE category = 'soir'").get().c === 0) {
  const insertSoir = db.prepare(
    'INSERT INTO tasks (category, section, subsection, description, task_order) VALUES (?, ?, ?, ?, ?)'
  );
  const soirTasks = [
    // ── SOIR - Fermeture Bar ──
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Conserver et/ou jeter les garnitures fraiches', 0],
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Nettoyer le matériel de bar', 0],
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Enlever et rincer les becs verseurs', 0],
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Nettoyer les tapis de bar', 0],
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Vider et nettoyer les bacs à glace', 0],
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Ranger et réapprovisionner les condiments', 0],
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Remplir les sirops', 0],
    ['soir', 'Fermeture Bar', 'Stations cocktails', 'Remplir les pailles', 0],
    ['soir', 'Fermeture Bar', 'Tireuses à bière', 'Rincer et essuyer les becs de tirage', 0],
    ['soir', 'Fermeture Bar', 'Tireuses à bière', 'Nettoyer les grilles de récupération', 0],
    ['soir', 'Fermeture Bar', 'Tireuses à bière', 'Nettoyer les surfaces', 0],
    ['soir', 'Fermeture Bar', 'Tireuses à bière', 'Nettoyer la facade des tireuses', 0],
    ['soir', 'Fermeture Bar', 'Tireuses à bière', 'Ranger les sirops', 0],
    ['soir', 'Fermeture Bar', 'Remontée de cave', "Vérifier les dates de consommation de l'ensemble des produits (1x/semaine)", 0],
    ['soir', 'Fermeture Bar', 'Remontée de cave', 'Réapprovisionner les frigos à softs', 0],
    ['soir', 'Fermeture Bar', 'Remontée de cave', 'Réapprovisionner les vins et alcools', 0],
    ['soir', 'Fermeture Bar', 'Remontée de cave', 'Réapprovisionner les sirops et purées', 0],
    ['soir', 'Fermeture Bar', 'Remontée de cave', 'Ranger les caisses de bouteilles vides', 0],
    ['soir', 'Fermeture Bar', 'Remontée de cave', 'Ranger les fûts vides', 0],
    ['soir', 'Fermeture Bar', 'Remontée de cave', 'Compter les fûts la veille de la commande', 0],
    ['soir', 'Fermeture Bar', 'Nettoyage bar', 'Nettoyer la machine à café', 0],
    ['soir', 'Fermeture Bar', 'Nettoyage bar', 'Nettoyer les surfaces autour du bar', 0],
    ['soir', 'Fermeture Bar', 'Nettoyage bar', 'Nettoyer la plonge', 0],
    ['soir', 'Fermeture Bar', 'Nettoyage bar', 'Nettoyer les vitres des frigos', 0],
    ['soir', 'Fermeture Bar', 'Nettoyage bar', 'Vider la poubelle', 0],
    ['soir', 'Fermeture Bar', 'Nettoyage bar', 'Poser du débouchant dans les écoulements (2x/mois)', 0],
    // ── SOIR - Fermeture Salle ──
    ['soir', 'Fermeture Salle', 'Mobilier', 'Débarrasser les tables', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Ranger les cartes', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Nettoyer les tables et les chaises', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Réordonner les tables en fonction du plan de salle', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Ranger la zone des couverts', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Vider la poubelle proche de la cuisine', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Éteindre les projecteurs et les télévisions', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Couper les systèmes de ventilation', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Éteindre les enseignes lumineuses', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Sortir les poubelles en fonction du planning', 0],
    ['soir', 'Fermeture Salle', 'Mobilier', 'Nettoyer les supports de cartes (1x/semaine)', 0],
    ['soir', 'Fermeture Salle', 'Toilettes', 'Nettoyer les urinoirs et les cuvettes', 0],
    ['soir', 'Fermeture Salle', 'Toilettes', 'Nettoyer les lavabos et les meubles', 0],
    ['soir', 'Fermeture Salle', 'Toilettes', 'Recharger le papier toilettes et les savons', 0],
    ['soir', 'Fermeture Salle', 'Toilettes', 'Vider et nettoyer les sèches-mains', 0],
    ['soir', 'Fermeture Salle', 'Toilettes', 'Nettoyer le filtre des sèches-mains (1x/semaine)', 0],
    ['soir', 'Fermeture Salle', 'Toilettes', 'Vider les poubelles', 0],
    ['soir', 'Fermeture Salle', 'Toilettes', 'Poser du débouchant dans toutes les toilettes (2x/mois)', 0],
    // ── SOIR - Fermeture Terrasse ──
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Débarrasser les tables', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Ranger les cartes', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Ranger les décorations', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Débarrasser et nettoyer les cendriers', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Nettoyer les tables et les chaises', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Rentrer les tables et chaises', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Rentrer les panneaux', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Balayer la terrasse', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Fermer les bâches', 0],
    ['soir', 'Fermeture Terrasse', 'Fermeture terrasse', 'Éteindre les éclairages extérieurs', 0],
    // ── SOIR - Fermeture Bâtiment ──
    ['soir', 'Fermeture Bâtiment', 'Fermeture bâtiment', 'Vérifier les portes et fenêtres', 0],
    ['soir', 'Fermeture Bâtiment', 'Fermeture bâtiment', 'Éteindre la musique', 0],
    ['soir', 'Fermeture Bâtiment', 'Fermeture bâtiment', 'Éteindre les lumières', 0],
    ["soir", 'Fermeture Bâtiment', 'Fermeture bâtiment', "Activer l'alarme", 0],
  ];
  db.exec('BEGIN');
  soirTasks.forEach((t, i) => insertSoir.run(t[0], t[1], t[2], t[3], i));
  db.exec('COMMIT');
  console.log(`✅ Migration : ${soirTasks.length} tâches FERMETURE ajoutées`);
}


// ─── Seed floor plan ───────────────────────────────────────────────────────────
if (db.prepare('SELECT COUNT(*) as c FROM floor_tables').get().c === 0) {
  const ins = db.prepare(
    'INSERT INTO floor_tables (name, zone, x, y, width, height, shape, capacity, is_decoration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  const tbls = [
    // ── SALLE BAS ── [name, zone, x, y, w, h, shape, cap, deco]
    ['45','salle_bas',250,100,65,65,'square',2,0],
    ['43','salle_bas',320,100,65,65,'square',2,0],
    ['40','salle_bas',400,100,100,65,'square',4,0],
    ['44','salle_bas',250,170,65,65,'square',2,0],
    ['42','salle_bas',320,170,65,65,'square',2,0],
    ['06','salle_bas',220,250,65,65,'square',2,0],
    ['07','salle_bas',290,250,65,65,'square',2,0],
    ['08','salle_bas',360,250,65,65,'square',2,0],
    ['05','salle_bas',145,285,65,65,'square',2,0],
    ['04','salle_bas',100,355,65,65,'square',2,0],
    ['03','salle_bas',100,425,65,65,'square',2,0],
    ['02','salle_bas',100,495,65,65,'square',2,0],
    ['01','salle_bas',100,555,65,65,'square',1,0],
    ['09','salle_bas',340,355,80,80,'round',4,0],
    ['10','salle_bas',230,440,80,80,'round',4,0],
    ['12','salle_bas',480,330,65,80,'square',4,0],
    ['14','salle_bas',480,415,65,80,'square',4,0],
    ['11','salle_bas',215,540,130,65,'square',8,0],
    ['15','salle_bas',420,535,100,65,'square',4,0],
    ['35','salle_bas',780,110,78,65,'square',4,0],
    ['33','salle_bas',855,110,78,65,'square',4,0],
    ['31','salle_bas',935,110,78,65,'square',4,0],
    ['34','salle_bas',780,180,78,65,'square',4,0],
    ['32','salle_bas',855,180,78,65,'square',4,0],
    ['30','salle_bas',935,180,78,65,'square',4,0],
    ['29','salle_bas',1010,295,80,80,'round',4,0],
    ['27','salle_bas',955,370,65,65,'square',2,0],
    ['28','salle_bas',1025,370,65,65,'square',2,0],
    ['25','salle_bas',955,440,65,65,'square',2,0],
    ['26','salle_bas',1025,440,65,65,'square',2,0],
    ['21','salle_bas',740,465,65,65,'square',2,0],
    ['23','salle_bas',865,465,65,65,'square',2,0],
    ['20','salle_bas',740,535,65,65,'square',2,0],
    ['22','salle_bas',865,535,65,65,'square',2,0],
    ['24','salle_bas',1005,530,80,80,'round',4,0],
    // Décorations Salle Bas
    ['BAR',     'salle_bas',610,260,320,175,'square',0,1],
    ['ENTRÉE 1','salle_bas',615,535,100,65,'square',0,1],
    ['ENTRÉE 2','salle_bas',1020,200,65,80,'square',0,1],

    // ── ÉTAGE ──
    ['163','etage',100,145,65,95,'square',2,0],
    ['101','etage',230,135,65,65,'square',2,0],
    ['102','etage',300,135,65,65,'square',2,0],
    ['103','etage',390,135,65,65,'square',2,0],
    ['104','etage',460,135,65,65,'square',2,0],
    ['105','etage',545,135,65,65,'square',2,0],
    ['106','etage',615,135,65,65,'square',2,0],
    ['107','etage',705,135,65,65,'square',2,0],
    ['108','etage',775,135,65,65,'square',2,0],
    ['110','etage',870,165,65,65,'square',2,0],
    ['111','etage',870,235,65,65,'square',2,0],
    ['112','etage',870,305,65,65,'square',2,0],
    ['113','etage',870,375,65,65,'square',2,0],
    ['114','etage',870,445,65,65,'square',2,0],
    ['162','etage',100,245,65,85,'square',2,0],
    ['161','etage',100,360,65,85,'square',2,0],
    ['160','etage',100,475,65,85,'square',2,0],
    ['151','etage',243,300,85,85,'round',5,0],
    ['150','etage',513,445,85,85,'round',5,0],
    ['120','etage',435,215,65,65,'square',2,0],
    ['121','etage',435,285,65,65,'square',2,0],
    ['122','etage',435,355,65,65,'square',2,0],
    ['123','etage',435,425,65,65,'square',2,0],
    ['124','etage',616,230,65,175,'square',8,0],
    ['130','etage',278,428,65,65,'square',2,0],
    ['131','etage',278,498,65,65,'square',2,0],
    ['132','etage',705,445,65,65,'square',2,0],
    ['133','etage',705,515,65,65,'square',2,0],
    ['140','etage',428,540,65,65,'square',2,0],
    ['141','etage',576,540,65,65,'square',2,0],
    // Décoration Étage
    ['ESCALIER','etage',775,480,100,100,'square',0,1],

    // ── COIN CANAPÉ ──
    ['201','coin_canap',320,285,85,85,'round',2,0],
    ['202','coin_canap',720,285,85,85,'round',2,0],
    // Canapés (décorations)
    ['CANAPÉ','coin_canap',175,240,65,165,'square',0,1],
    ['CANAPÉ','coin_canap',305,165,65,100,'square',0,1],
    ['CANAPÉ','coin_canap',450,235,65,155,'square',0,1],
    ['CANAPÉ','coin_canap',575,235,65,155,'square',0,1],
    ['CANAPÉ','coin_canap',715,165,65,100,'square',0,1],
    ['CANAPÉ','coin_canap',850,240,65,165,'square',0,1],
    ['CANAPÉ','coin_canap',305,420,65,80,'square',0,1],
    ['CANAPÉ','coin_canap',715,440,65,80,'square',0,1],
  ];

  // TERRASSE — table 300
  tbls.push(['300','terrasse',660,110,200,60,'square',6,0]);

  // TERRASSE — grille droite (310-354) : 5 lignes × 5 colonnes
  [[310,311,312,313,314],[320,321,322,323,324],[330,331,332,333,334],
   [340,341,342,343,344],[350,351,352,353,354]].forEach((row,ri) =>
    row.forEach((n,ci) => tbls.push([String(n),'terrasse',730+ci*65,230+ri*65,60,60,'square',2,0]))
  );

  // TERRASSE — grille milieu (430→400) : 3 lignes × 4 colonnes
  [[430,420,410,400],[431,421,411,401],[432,422,412,402]].forEach((row,ri) =>
    row.forEach((n,ci) => tbls.push([String(n),'terrasse',480+ci*65,360+ri*65,60,60,'square',2,0]))
  );

  // TERRASSE — grille gauche (550→500) : 3 lignes × 6 colonnes
  [[550,540,530,520,510,500],[551,541,531,521,511,501],[552,542,532,522,512,502]].forEach((row,ri) =>
    row.forEach((n,ci) => tbls.push([String(n),'terrasse',95+ci*65,360+ri*65,60,60,'square',2,0]))
  );

  db.exec('BEGIN');
  tbls.forEach(t => ins.run(t[0],t[1],t[2],t[3],t[4],t[5],t[6],t[7],t[8]));
  db.exec('COMMIT');
}

// ─── Users ─────────────────────────────────────────────────────────────────────
function getUserByPin(pin) {
  return db.prepare('SELECT * FROM users WHERE pin = ? AND active = 1').get(pin);
}
function getUserById(id) {
  return db.prepare('SELECT id, name, pin, role, shift, active, created_at FROM users WHERE id = ?').get(id);
}
function getAllUsers() {
  return db.prepare('SELECT id, name, pin, role, shift, active, created_at FROM users ORDER BY role DESC, name').all();
}
function createUser({ name, pin, role, shift, email }) {
  return db.prepare('INSERT INTO users (name, pin, role, shift, email) VALUES (?, ?, ?, ?, ?)').run(name, pin, role || 'staff', shift || null, email || null).lastInsertRowid;
}
function updateUser(id, data) {
  const fields = ['name', 'pin', 'role', 'shift', 'active', 'email'];
  const updates = fields.filter(f => data[f] !== undefined).map(f => `${f} = ?`);
  const values = fields.filter(f => data[f] !== undefined).map(f => data[f]);
  if (!updates.length) return;
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values, id);
}
function deleteUser(id) {
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
}

// ─── Tasks ─────────────────────────────────────────────────────────────────────
function getTasksWithCompletions(date, userId, domain = 'salle') {
  return db.prepare(`
    SELECT t.*,
           COUNT(tc.id) as completion_count,
           GROUP_CONCAT(u.name, ', ') as completers,
           MAX(CASE WHEN tc.user_id = ? THEN 1 ELSE 0 END) as my_completed,
           MAX(CASE WHEN tc.user_id = ? THEN tc.id ELSE NULL END) as my_completion_id
    FROM tasks t
    LEFT JOIN task_completions tc ON t.id = tc.task_id AND tc.date = ?
    LEFT JOIN users u ON tc.user_id = u.id
    WHERE t.active = 1 AND t.domain = ?
    GROUP BY t.id
    ORDER BY t.category, t.section, t.task_order, t.id
  `).all(userId, userId, date, domain);
}
function getTaskById(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}
function getAllTasks() {
  return db.prepare('SELECT * FROM tasks WHERE active = 1 ORDER BY category, section, task_order, id').all();
}
function completeTask(taskId, userId, date) {
  db.prepare('INSERT OR IGNORE INTO task_completions (task_id, user_id, date) VALUES (?, ?, ?)').run(taskId, userId, date);
}
function uncompleteTask(taskId, userId, date) {
  db.prepare('DELETE FROM task_completions WHERE task_id = ? AND user_id = ? AND date = ?').run(taskId, userId, date);
}
function createTask({ category, section, subsection, description, task_order, domain }) {
  return db.prepare('INSERT INTO tasks (category, section, subsection, description, task_order, domain) VALUES (?, ?, ?, ?, ?, ?)').run(category, section, subsection, description, task_order || 0, domain || 'salle').lastInsertRowid;
}
function updateTask(id, data) {
  const fields = ['category', 'section', 'subsection', 'description', 'task_order', 'active', 'domain'];
  const updates = fields.filter(f => data[f] !== undefined).map(f => `${f} = ?`);
  const values = fields.filter(f => data[f] !== undefined).map(f => data[f]);
  if (!updates.length) return;
  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values, id);
}
function deactivateTask(id) {
  db.prepare('UPDATE tasks SET active = 0 WHERE id = ?').run(id);
}

// ─── Floor Tables ──────────────────────────────────────────────────────────────
function getTables() {
  return db.prepare('SELECT * FROM floor_tables WHERE active = 1 ORDER BY zone, is_decoration, CAST(name AS INTEGER), name').all();
}
function getTableById(id) {
  return db.prepare('SELECT * FROM floor_tables WHERE id = ?').get(id);
}
function createTable({ name, zone, x, y, width, height, shape, capacity, is_decoration }) {
  return db.prepare('INSERT INTO floor_tables (name, zone, x, y, width, height, shape, capacity, is_decoration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(name, zone ?? 'salle_bas', x ?? 50, y ?? 50, width ?? 65, height ?? 65, shape ?? 'square', capacity ?? 2, is_decoration ?? 0).lastInsertRowid;
}
function updateTable(id, data) {
  const fields = ['name', 'zone', 'x', 'y', 'width', 'height', 'shape', 'capacity', 'is_decoration'];
  const updates = fields.filter(f => data[f] !== undefined).map(f => `${f} = ?`);
  const values = fields.filter(f => data[f] !== undefined).map(f => data[f]);
  if (!updates.length) return;
  db.prepare(`UPDATE floor_tables SET ${updates.join(', ')} WHERE id = ?`).run(...values, id);
}
function deleteTable(id) {
  db.prepare('UPDATE floor_tables SET active = 0 WHERE id = ?').run(id);
}

// ─── Reservations ──────────────────────────────────────────────────────────────

// Enrichit une ligne DB avec table_ids (array) et table_names (array de noms)
function _enrichRes(r) {
  if (!r) return r;
  let ids = [];
  try { ids = JSON.parse(r.table_ids || '[]'); } catch(e) {}
  if (ids.length === 0 && r.table_id) ids = [r.table_id]; // backward compat
  const names = ids.map(tid => db.prepare('SELECT name FROM floor_tables WHERE id = ?').get(tid)?.name).filter(Boolean);
  return { ...r, table_ids: ids, table_names: names, table_name: names[0] || null };
}

function getReservationsByDate(date) {
  return db.prepare(`
    SELECT r.*, COUNT(a.id) as attach_count
    FROM reservations r
    LEFT JOIN reservation_attachments a ON a.reservation_id = r.id
    WHERE r.date = ?
    GROUP BY r.id
    ORDER BY r.time
  `).all(date).map(_enrichRes);
}
function getReservationById(id) {
  return _enrichRes(db.prepare(`SELECT r.* FROM reservations r WHERE r.id = ?`).get(id));
}
function createReservation({ table_ids, table_id, customer_name, phone, party_size, date, time, notes }) {
  const ids = Array.isArray(table_ids) ? table_ids : (table_id ? [table_id] : []);
  const firstId = ids[0] ?? null;
  return db.prepare(
    'INSERT INTO reservations (table_id, table_ids, customer_name, phone, party_size, date, time, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(firstId, JSON.stringify(ids), customer_name, phone ?? null, party_size ?? 2, date, time, notes ?? null).lastInsertRowid;
}
function updateReservation(id, data) {
  // Normalise table_ids ↔ table_id
  let d = { ...data };
  // Si on annule la réservation → libérer les tables
  if (d.status === 'cancelled') {
    d.table_id  = null;
    d.table_ids = '[]';
  } else if (d.table_ids !== undefined) {
    const ids = Array.isArray(d.table_ids) ? d.table_ids : [];
    d.table_id  = ids[0] ?? null;
    d.table_ids = JSON.stringify(ids);
  } else if (d.table_id !== undefined) {
    d.table_ids = JSON.stringify(d.table_id ? [d.table_id] : []);
  }
  const fields = ['table_id', 'table_ids', 'customer_name', 'phone', 'party_size', 'date', 'time', 'notes', 'admin_notes', 'status', 'space'];
  const updates = fields.filter(f => d[f] !== undefined).map(f => `${f} = ?`);
  const values  = fields.filter(f => d[f] !== undefined).map(f => d[f]);
  if (!updates.length) return;
  db.prepare(`UPDATE reservations SET ${updates.join(', ')} WHERE id = ?`).run(...values, id);
}
function deleteReservation(id) {
  db.prepare('DELETE FROM reservations WHERE id = ?').run(id);
}
function getReservationsByRange(from, to) {
  return db.prepare(`
    SELECT r.*, COUNT(a.id) as attach_count
    FROM reservations r
    LEFT JOIN reservation_attachments a ON a.reservation_id = r.id
    WHERE r.date BETWEEN ? AND ?
    GROUP BY r.id
    ORDER BY r.date, r.time
  `).all(from, to).map(_enrichRes);
}
function getUpcomingReservationStats() {
  const today = new Date().toISOString().split('T')[0];
  const week  = new Date(); week.setDate(week.getDate() + 6);  const month = new Date(); month.setDate(month.getDate() + 29);
  const weekEnd  = week.toISOString().split('T')[0];
  const monthEnd = month.toISOString().split('T')[0];
  return {
    today:     db.prepare("SELECT COUNT(*) as c, SUM(party_size) as p FROM reservations WHERE date = ? AND status != 'cancelled'").get(today),
    week:      db.prepare("SELECT COUNT(*) as c, SUM(party_size) as p FROM reservations WHERE date BETWEEN ? AND ? AND status != 'cancelled'").get(today, weekEnd),
    month:     db.prepare("SELECT COUNT(*) as c, SUM(party_size) as p FROM reservations WHERE date BETWEEN ? AND ? AND status != 'cancelled'").get(today, monthEnd),
    viaJoy:    db.prepare("SELECT COUNT(*) as c FROM reservations WHERE date >= ? AND joy_event_id IS NOT NULL AND status != 'cancelled'").get(today),
    bySpace:   db.prepare("SELECT COALESCE(space,'—') as space, COUNT(*) as c FROM reservations WHERE date BETWEEN ? AND ? AND status != 'cancelled' GROUP BY space ORDER BY c DESC").all(today, weekEnd),
  };
}

// ─── Stats & Logs ──────────────────────────────────────────────────────────────
function getStats(from, to) {
  const dateCondition = from && to ? 'AND tc.date BETWEEN ? AND ?' : '';
  const params = from && to ? [from, to] : [];

  const byUser = db.prepare(`
    SELECT u.id, u.name, u.shift,
           COUNT(tc.id) as total_completions,
           COUNT(DISTINCT tc.date) as days_worked
    FROM users u
    LEFT JOIN task_completions tc ON u.id = tc.user_id ${dateCondition}
    WHERE u.role = 'staff' AND u.active = 1
    GROUP BY u.id
    ORDER BY total_completions DESC
  `).all(...params);

  const topTasks = db.prepare(`
    SELECT t.description, t.category, t.section,
           COUNT(tc.id) as completions
    FROM task_completions tc
    JOIN tasks t ON tc.task_id = t.id
    ${from && to ? 'WHERE tc.date BETWEEN ? AND ?' : ''}
    GROUP BY tc.task_id
    ORDER BY completions DESC
    LIMIT 10
  `).all(...params);

  const byCategory = db.prepare(`
    SELECT t.category,
           COUNT(tc.id) as completions,
           COUNT(DISTINCT tc.date) as days
    FROM task_completions tc
    JOIN tasks t ON tc.task_id = t.id
    ${from && to ? 'WHERE tc.date BETWEEN ? AND ?' : ''}
    GROUP BY t.category
  `).all(...params);

  const dailyActivity = db.prepare(`
    SELECT tc.date, COUNT(*) as completions, COUNT(DISTINCT tc.user_id) as staff_active
    FROM task_completions tc
    ${from && to ? 'WHERE tc.date BETWEEN ? AND ?' : ''}
    GROUP BY tc.date
    ORDER BY tc.date DESC
    LIMIT 30
  `).all(...params);

  return { byUser, topTasks, byCategory, dailyActivity };
}

function getDailyLog(date) {
  return db.prepare(`
    SELECT tc.*, t.description, t.category, t.section, t.subsection, u.name as user_name
    FROM task_completions tc
    JOIN tasks t ON tc.task_id = t.id
    JOIN users u ON tc.user_id = u.id
    WHERE tc.date = ?
    ORDER BY tc.completed_at DESC
  `).all(date);
}

function getDashboardData(date) {
  // Tâches par catégorie avec nb complétées (unique par tâche, pas par user)
  const tasksByCategory = db.prepare(`
    SELECT t.category,
           COUNT(DISTINCT t.id) as total,
           COUNT(DISTINCT tc.task_id) as done_tasks
    FROM tasks t
    LEFT JOIN task_completions tc ON t.id = tc.task_id AND tc.date = ?
    WHERE t.active = 1
    GROUP BY t.category
    ORDER BY t.category
  `).all(date);

  // Par personne : nb de tâches cochées
  const byPerson = db.prepare(`
    SELECT u.id, u.name, u.shift, u.role,
           COUNT(tc.id) as task_count
    FROM users u
    LEFT JOIN task_completions tc ON u.id = tc.user_id AND tc.date = ?
    WHERE u.active = 1 AND u.role IN ('staff', 'manager')
    GROUP BY u.id
    ORDER BY task_count DESC, u.name
  `).all(date);

  // Réservations du jour
  const reservations = db.prepare(`
    SELECT r.*, ft.name as table_name
    FROM reservations r
    LEFT JOIN floor_tables ft ON r.table_id = ft.id
    WHERE r.date = ?
    ORDER BY r.time
  `).all(date);

  return { tasksByCategory, byPerson, reservations };
}


// ─── Reservation Stats ─────────────────────────────────────────────────────────
function getReservationStats(from, to) {
  const condition = from && to ? 'WHERE date BETWEEN ? AND ?' : 'WHERE 1=1';
  const params    = from && to ? [from, to] : [];

  // Totaux généraux
  const overview = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(party_size) as total_pax,
      ROUND(AVG(party_size), 1) as avg_pax,
      SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) as nb_confirmed,
      SUM(CASE WHEN status='arrived'   THEN 1 ELSE 0 END) as nb_arrived,
      SUM(CASE WHEN status='no_show'   THEN 1 ELSE 0 END) as nb_no_show,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as nb_cancelled,
      SUM(CASE WHEN joy_event_id IS NOT NULL THEN 1 ELSE 0 END) as nb_joy,
      SUM(CASE WHEN joy_event_id IS NULL THEN 1 ELSE 0 END) as nb_manual
    FROM reservations ${condition}
  `).get(...params);

  // Par jour de la semaine (0=dim, 1=lun ... 6=sam)
  const byWeekday = db.prepare(`
    SELECT strftime('%w', date) as dow,
           COUNT(*) as total,
           SUM(CASE WHEN status='arrived' THEN 1 ELSE 0 END) as arrived
    FROM reservations ${condition}
    GROUP BY dow ORDER BY dow
  `).all(...params);

  // Par heure de réservation
  const byHour = db.prepare(`
    SELECT CAST(substr(time, 1, 2) AS INTEGER) as hour,
           COUNT(*) as total,
           SUM(party_size) as pax
    FROM reservations ${condition}
    GROUP BY hour ORDER BY hour
  `).all(...params);

  // Par espace (space = salle, etage, terrasse, etc.)
  const bySpace = db.prepare(`
    SELECT COALESCE(space, 'Non précisé') as space,
           COUNT(*) as total,
           SUM(party_size) as pax
    FROM reservations ${condition}
    GROUP BY space ORDER BY total DESC
  `).all(...params);

  // Tendance journalière
  const dailyTrend = db.prepare(`
    SELECT date,
           COUNT(*) as total,
           SUM(CASE WHEN status='arrived' THEN 1 ELSE 0 END) as arrived,
           SUM(CASE WHEN status='no_show' THEN 1 ELSE 0 END) as no_show,
           SUM(party_size) as pax
    FROM reservations ${condition}
    GROUP BY date ORDER BY date
  `).all(...params);

  return { overview, byWeekday, byHour, bySpace, dailyTrend };
}

// ─── Settings ──────────────────────────────────────────────────────────────────
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ─── RH — Retards & Heures Supplémentaires ─────────────────────────────────────
function createHrEvent({ user_id, date, type, duration_min, note, created_by }) {
  return db.prepare(
    'INSERT INTO hr_events (user_id, date, type, duration_min, note, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(user_id, date, type, duration_min || 0, note || null, created_by || null).lastInsertRowid;
}

function getHrEvents({ userId, from, to, type } = {}) {
  let q = `
    SELECT h.*, u.name as user_name, u.shift, m.name as created_by_name
    FROM hr_events h
    JOIN users u ON h.user_id = u.id
    LEFT JOIN users m ON h.created_by = m.id
    WHERE 1=1
  `;
  const params = [];
  if (userId) { q += ' AND h.user_id = ?'; params.push(userId); }
  if (from)   { q += ' AND h.date >= ?';   params.push(from); }
  if (to)     { q += ' AND h.date <= ?';   params.push(to); }
  if (type)   { q += ' AND h.type = ?';    params.push(type); }
  q += ' ORDER BY h.date DESC, h.created_at DESC';
  return db.prepare(q).all(...params);
}

function deleteHrEvent(id) {
  db.prepare('DELETE FROM hr_events WHERE id = ?').run(id);
}

function getHrSummaryForUser(userId, from, to) {
  return db.prepare(`
    SELECT type, SUM(duration_min) as total_min, COUNT(*) as count
    FROM hr_events
    WHERE user_id = ? AND date BETWEEN ? AND ?
    GROUP BY type
  `).all(userId, from, to);
}

// ─── Joy.io Events ─────────────────────────────────────────────────────────────
function upsertJoyEvent({ joy_uid, customer_name, participants, date, time_start, time_end, space, raw_summary, raw_description, status }) {
  const fields = [
    customer_name || '', participants || 0, date || '', time_start || '',
    time_end || '', space || '', raw_summary || '', raw_description || '',
    status || 'confirmed', joy_uid
  ];

  // 1. Cherche par UID exact (cas normal)
  const byUid = db.prepare('SELECT id FROM joy_events WHERE joy_uid = ?').get(joy_uid);
  if (byUid) {
    db.prepare(`UPDATE joy_events SET customer_name=?,participants=?,date=?,time_start=?,time_end=?,space=?,raw_summary=?,raw_description=?,status=?,joy_uid=?,last_sync=datetime('now','localtime') WHERE id=?`)
      .run(...fields, byUid.id);
    return byUid.id;
  }

  // 2. Joy.io change parfois l'UID → cherche par fingerprint (nom + date + heure)
  if (customer_name && date && time_start) {
    const byContent = db.prepare(
      'SELECT id FROM joy_events WHERE customer_name = ? AND date = ? AND time_start = ?'
    ).get(customer_name, date, time_start);
    if (byContent) {
      db.prepare(`UPDATE joy_events SET customer_name=?,participants=?,date=?,time_start=?,time_end=?,space=?,raw_summary=?,raw_description=?,status=?,joy_uid=?,last_sync=datetime('now','localtime') WHERE id=?`)
        .run(...fields, byContent.id);
      return byContent.id;
    }
  }

  // 3. Nouvel événement
  db.prepare(`
    INSERT INTO joy_events (joy_uid, customer_name, participants, date, time_start, time_end, space, raw_summary, raw_description, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(joy_uid, customer_name || '', participants || 0, date || '', time_start || '', time_end || '', space || '', raw_summary || '', raw_description || '', status || 'confirmed');
  return db.prepare('SELECT id FROM joy_events WHERE joy_uid = ?').get(joy_uid)?.id || null;
}

function upsertReservationFromJoy(joyEventId, { customer_name, participants, date, time_start, status, phone, notes, space }) {
  const partySize  = participants > 0 ? participants : 2;
  const time       = time_start || '00:00';
  const resStatus  = status === 'cancelled' ? 'cancelled' : 'confirmed';

  // Récupère la meilleure ligne existante (avec table assignée ou statut manuel staff)
  const best = db.prepare(`
    SELECT table_id, status FROM reservations WHERE joy_event_id = ?
    ORDER BY (table_id IS NOT NULL) DESC, (status IN ('arrived','no_show','cancelled')) DESC
    LIMIT 1
  `).get(joyEventId);

  // Supprime TOUTES les lignes pour ce joy_event_id (élimine les doublons)
  db.prepare('DELETE FROM reservations WHERE joy_event_id = ?').run(joyEventId);

  // Conserve le statut manuel si le staff a marqué arrivé/no-show (sauf si Joy annule)
  // Si Joy annule → toujours cancelled, peu importe le statut précédent
  const prevStatus  = best?.status || 'confirmed';
  const finalStatus = resStatus === 'cancelled' ? 'cancelled'
    : (best && ['arrived', 'no_show'].includes(prevStatus) ? prevStatus : resStatus);

  // Si annulée → libérer les tables, sinon conserver l'assignation précédente
  const finalTableId  = finalStatus === 'cancelled' ? null : (best?.table_id || null);
  const finalTableIds = finalStatus === 'cancelled' ? '[]'
    : (finalTableId ? JSON.stringify([finalTableId]) : '[]');

  // Note automatique si Joy annule une résa qui ne l'était pas encore
  const wasCancelled = prevStatus === 'cancelled';
  const joyAdminNote = (finalStatus === 'cancelled' && !wasCancelled)
    ? `❌ Annulée par le client (Joy.io — ${new Date().toLocaleDateString('fr-FR')})`
    : (best?.admin_notes || null);

  // Insère une ligne propre avec l'espace réservé et les notes clients
  db.prepare(`
    INSERT INTO reservations (table_id, table_ids, customer_name, party_size, date, time, status, phone, notes, admin_notes, joy_event_id, space)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(finalTableId, finalTableIds, customer_name || '', partySize, date || '', time, finalStatus, phone || null, notes || null, joyAdminNote, joyEventId, space || null);
}

function cleanupJoyReservationDuplicates() {
  // Supprime les doublons globaux (même joy_event_id, plusieurs lignes) — garde le MIN(id)
  db.prepare(`
    DELETE FROM reservations
    WHERE joy_event_id IS NOT NULL
    AND id NOT IN (
      SELECT MIN(id) FROM reservations WHERE joy_event_id IS NOT NULL GROUP BY joy_event_id
    )
  `).run();
}

function cleanupStaleJoyReservations(validJoyIds) {
  // Les résas Joy FUTURES absentes du flux iCal actuel → marquées annulées (pas supprimées)
  // Joy.io peut soit envoyer STATUS:CANCELLED, soit retirer l'événement du flux
  // Dans les deux cas on veut afficher la résa comme annulée, pas la faire disparaître
  if (!validJoyIds.length) return;
  const today = new Date().toISOString().split('T')[0];
  const ph = validJoyIds.map(() => '?').join(',');
  const cancelNote = `❌ Annulée par le client (Joy.io — ${new Date().toLocaleDateString('fr-FR')})`;
  db.prepare(`
    UPDATE reservations
    SET status = 'cancelled', table_id = NULL, table_ids = '[]',
        admin_notes = CASE WHEN (admin_notes IS NULL OR admin_notes = '') THEN ? ELSE admin_notes END
    WHERE joy_event_id IS NOT NULL
      AND date >= ?
      AND joy_event_id NOT IN (${ph})
      AND status NOT IN ('arrived', 'no_show', 'cancelled')
  `).run(cancelNote, today, ...validJoyIds);
}

function getJoyEvents({ date, upcoming, all: showAll } = {}) {
  const today = new Date().toISOString().split('T')[0];
  if (date) {
    return db.prepare("SELECT * FROM joy_events WHERE date = ? ORDER BY time_start").all(date);
  }
  if (upcoming || showAll) {
    return db.prepare("SELECT * FROM joy_events WHERE date >= ? ORDER BY date, time_start").all(today);
  }
  return db.prepare("SELECT * FROM joy_events ORDER BY date DESC, time_start LIMIT 100").all();
}

function deleteJoyEvent(id) {
  db.prepare('DELETE FROM joy_events WHERE id = ?').run(id);
}

function assignTableToJoyEvent(tableId, joyEventId) {
  // Retire cette table de tous les événements Joy
  const all = db.prepare('SELECT id, assigned_tables FROM joy_events').all();
  for (const ev of all) {
    const tids = JSON.parse(ev.assigned_tables || '[]').filter(id => id !== tableId);
    db.prepare('UPDATE joy_events SET assigned_tables = ? WHERE id = ?').run(JSON.stringify(tids), ev.id);
  }
  // Ajoute au nouvel événement si fourni
  if (joyEventId) {
    const ev = db.prepare('SELECT assigned_tables FROM joy_events WHERE id = ?').get(joyEventId);
    if (ev) {
      const tids = JSON.parse(ev.assigned_tables || '[]');
      if (!tids.includes(tableId)) tids.push(tableId);
      db.prepare('UPDATE joy_events SET assigned_tables = ? WHERE id = ?').run(JSON.stringify(tids), joyEventId);
    }
  }
}

// ─── Shift Messages ─────────────────────────────────────────────────────────────
function getShiftMessages(date) {
  // midi→soir : message du midi pour le soir d'aujourd'hui
  // soir→matin : message du soir d'hier pour le matin d'aujourd'hui
  const prev = new Date(date);
  prev.setDate(prev.getDate() - 1);
  const prevDate = prev.toISOString().split('T')[0];
  return {
    midiToSoir: db.prepare("SELECT * FROM shift_messages WHERE from_shift='midi' AND date=?").get(date) || null,
    soirToMatin: db.prepare("SELECT * FROM shift_messages WHERE from_shift='soir' AND date=?").get(prevDate) || null,
  };
}
function upsertShiftMessage({ from_shift, date, message, author_id, author_name }) {
  db.prepare(`
    INSERT INTO shift_messages (from_shift, date, message, author_id, author_name, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(from_shift, date) DO UPDATE SET
      message = excluded.message,
      author_id = excluded.author_id,
      author_name = excluded.author_name,
      updated_at = datetime('now', 'localtime')
  `).run(from_shift, date, message, author_id, author_name);
  return db.prepare("SELECT * FROM shift_messages WHERE from_shift=? AND date=?").get(from_shift, date);
}


// ─── Reservation Attachments ───────────────────────────────────────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reservation_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mimetype TEXT,
      size INTEGER DEFAULT 0,
      uploaded_by INTEGER,
      uploaded_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )
  `);
} catch(e) {}

function addReservationAttachment({ reservation_id, filename, original_name, mimetype, size, uploaded_by }) {
  return db.prepare(
    'INSERT INTO reservation_attachments (reservation_id, filename, original_name, mimetype, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(reservation_id, filename, original_name, mimetype || null, size || 0, uploaded_by || null).lastInsertRowid;
}

function getReservationAttachments(reservation_id) {
  return db.prepare(`
    SELECT ra.*, u.name as uploader_name
    FROM reservation_attachments ra
    LEFT JOIN users u ON ra.uploaded_by = u.id
    WHERE ra.reservation_id = ?
    ORDER BY ra.uploaded_at ASC
  `).all(reservation_id);
}

function getAttachmentById(id) {
  return db.prepare('SELECT * FROM reservation_attachments WHERE id = ?').get(id);
}

function deleteAttachment(id) {
  db.prepare('DELETE FROM reservation_attachments WHERE id = ?').run(id);
}

// ─── Demandes de congés ────────────────────────────────────────────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conge_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      motif TEXT,
      status TEXT DEFAULT 'pending',
      requested_at TEXT DEFAULT (datetime('now', 'localtime')),
      reviewed_at TEXT,
      reviewed_by TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
} catch(e) {}

function createCongeRequest({ user_id, user_name, date_from, date_to, motif }) {
  return db.prepare(
    'INSERT INTO conge_requests (user_id, user_name, date_from, date_to, motif) VALUES (?, ?, ?, ?, ?)'
  ).run(user_id, user_name, date_from, date_to, motif || null).lastInsertRowid;
}

function getCongeRequestsByUser(user_id) {
  return db.prepare(
    'SELECT * FROM conge_requests WHERE user_id = ? ORDER BY requested_at DESC'
  ).all(user_id);
}

function getAllCongeRequests() {
  return db.prepare(
    'SELECT * FROM conge_requests ORDER BY requested_at DESC'
  ).all();
}

function updateCongeRequestStatus(id, status, reviewed_by) {
  db.prepare(
    `UPDATE conge_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now','localtime') WHERE id = ?`
  ).run(status, reviewed_by, id);
}


module.exports = {
  getUserByPin, getUserById, getAllUsers, createUser, updateUser, deleteUser,
  getTasksWithCompletions, getTaskById, getAllTasks, completeTask, uncompleteTask, createTask, updateTask, deactivateTask,
  getTables, getTableById, createTable, updateTable, deleteTable,
  getReservationsByDate, getReservationById, createReservation, updateReservation, deleteReservation,
  getReservationsByRange, getUpcomingReservationStats,
  getStats, getDailyLog, getDashboardData, getReservationStats,
  createHrEvent, getHrEvents, deleteHrEvent, getHrSummaryForUser,
  getSetting, setSetting,
  upsertJoyEvent, upsertReservationFromJoy, cleanupJoyReservationDuplicates, cleanupStaleJoyReservations,
  getJoyEvents, deleteJoyEvent, assignTableToJoyEvent,
  getShiftMessages, upsertShiftMessage,
  addReservationAttachment, getReservationAttachments, getAttachmentById, deleteAttachment,
  createCongeRequest, getCongeRequestsByUser, getAllCongeRequests, updateCongeRequestStatus,
};
