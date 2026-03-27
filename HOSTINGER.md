# Déploiement sur Hostinger VPS

## Plan recommandé
**Hostinger VPS KVM 1** (~5€/mois) — Ubuntu 22.04 ou 24.04

---

## 🚀 Workflow quotidien (modifier depuis Claude)

1. Claude modifie les fichiers localement
2. `git add . && git commit -m "..." && git push`
3. GitHub Actions se déclenche automatiquement
4. Le VPS reçoit les modifications et redémarre l'app (~30 secondes)

---

## 📋 Mise en place (une seule fois)

### Étape 1 — Créer un repo GitHub

```bash
cd "/Users/arthurcapri/Documents/Maker of Simplicity"
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TON_COMPTE/mos-pub.git
git push -u origin main
```

### Étape 2 — Configurer le VPS

Connecte-toi en SSH depuis ton terminal :
```bash
ssh root@TON_IP_HOSTINGER
```

Télécharge et exécute le script de setup :
```bash
curl -o setup.sh https://raw.githubusercontent.com/TON_COMPTE/mos-pub/main/scripts/setup-vps.sh
bash setup.sh
```

### Étape 3 — Cloner le projet sur le VPS

```bash
cd /var/www/mos
git clone https://github.com/TON_COMPTE/mos-pub.git .
npm install --production
pm2 start ecosystem.config.js
pm2 save
```

L'app tourne maintenant sur `http://TON_IP_HOSTINGER`

### Étape 4 — Configurer les Secrets GitHub Actions

Dans ton repo GitHub → **Settings → Secrets → Actions** → ajoute :

| Nom du secret | Valeur |
|---|---|
| `VPS_HOST` | L'IP de ton VPS Hostinger |
| `VPS_USER` | `root` |
| `VPS_PASSWORD` | Ton mot de passe VPS |

À partir de là, chaque `git push` redéploie automatiquement.

### Étape 5 (optionnel) — Domaine personnalisé

Si tu as un domaine (ex: `mospub.com`) :
1. Dans Hostinger → DNS → ajoute un `A record` pointant vers l'IP du VPS
2. Installe SSL gratuit :
```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d mospub.com
```

---

## 🔧 Commandes utiles (en SSH sur le VPS)

```bash
pm2 status              # État de l'app
pm2 logs mos-pub        # Voir les logs en temps réel
pm2 restart mos-pub     # Redémarrer manuellement
pm2 stop mos-pub        # Arrêter

# Mettre à jour manuellement sans GitHub Actions
cd /var/www/mos && git pull && npm install --production && pm2 restart mos-pub
```

## 💾 Backup de la base de données

```bash
# Depuis ton Mac, copier la DB en local
scp root@TON_IP:/var/www/mos/db/mos.db ./backup-$(date +%Y%m%d).db
```

---

## ⚠️ Important

- La base de données `mos.db` **n'est pas** dans git (normal, c'est voulu)
- Elle se crée automatiquement au premier démarrage sur le VPS
- Si tu veux transférer la DB de ton Mac vers le VPS :
```bash
scp "/Users/arthurcapri/Documents/Maker of Simplicity/db/mos.db" root@TON_IP:/var/www/mos/db/mos.db
```
