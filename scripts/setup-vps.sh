#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Script de configuration initiale du VPS Hostinger
# À exécuter UNE SEULE FOIS en SSH : bash setup-vps.sh
# ─────────────────────────────────────────────────────────────

set -e

echo "=== 1. Mise à jour du système ==="
apt-get update && apt-get upgrade -y

echo "=== 2. Installation de Node.js v24 ==="
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
node -v && npm -v

echo "=== 3. Installation de PM2 ==="
npm install -g pm2

echo "=== 4. Installation de Nginx ==="
apt-get install -y nginx

echo "=== 5. Installation de Git ==="
apt-get install -y git

echo "=== 6. Création du dossier de l'app ==="
mkdir -p /var/www/mos

echo "=== 7. Configuration Nginx ==="
cat > /etc/nginx/sites-available/mos << 'EOF'
server {
    listen 80;
    server_name _;

    # Taille max upload (ex: PDF planning)
    client_max_body_size 20M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;

        # WebSocket (Socket.io)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 86400;
    }
}
EOF

ln -sf /etc/nginx/sites-available/mos /etc/nginx/sites-enabled/mos
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "=== 8. PM2 au démarrage du serveur ==="
pm2 startup systemd -u root --hp /root | tail -1 | bash

echo ""
echo "✅ Setup terminé !"
echo ""
echo "Prochaine étape : cloner le repo et démarrer l'app"
echo "  cd /var/www/mos"
echo "  git clone TON_REPO_GITHUB ."
echo "  npm install --production"
echo "  pm2 start ecosystem.config.js"
echo "  pm2 save"
