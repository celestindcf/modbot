# 🛡️ ModBot — Bot Discord de Modération

Bot de modération complet avec panel web, casier judiciaire et système de niveaux d'admin.

---

## ✨ Commandes

| Commande | Description | Niveau requis |
|---|---|---|
| `/warn @membre raison mention` | Avertir un membre | Niv. 1+ |
| `/mute @membre durée raison mention` | Rendre muet | Niv. 1+ |
| `/unmute @membre` | Retirer le mute | Niv. 1+ |
| `/kick @membre raison mention` | Expulser | Niv. 2+ |
| `/ban @membre raison mention` | Bannir | Niv. 3+ |
| `/unban userid raison` | Débannir | Niv. 3+ |
| `/casier @membre` | Voir le casier | Tous |
| `/mafiche` | Voir sa propre fiche | Tous |
| `/clearwarn @membre id` | Effacer des warns | Niv. 3+ |
| `/staffadd @membre niveau` | Ajouter au staff | Admin Discord |
| `/staffliste` | Voir le staff | Tous |
| `/modsetup` | Configurer le bot | Admin Discord |
| `/modpanel` | Lien vers le panel | Tous |

---

## 🏅 Niveaux d'admin

| Niveau | Nom | Permissions |
|---|---|---|
| 1 | Modérateur | warn, mute |
| 2 | Senior Mod | warn, mute, kick |
| 3 | Admin | warn, mute, kick, ban, unban, clearwarn |
| 4 | Super Admin | Tous les droits + gestion staff |

---

## 🤖 Sanctions automatiques

| Warns actifs | Action automatique |
|---|---|
| 3 warns | Mute 1h |
| 5 warns | Kick |
| 7 warns | Ban |

---

## 🚀 Installation

### 1. Variables d'environnement (.env)
```env
BOT_TOKEN=ton_token_discord
CLIENT_ID=ton_client_id
JWT_SECRET=phrase_secrete_aleatoire
PANEL_URL=https://ton-url.railway.app
PORT=3000
```

### 2. Lancer
```bash
npm install
npm start
```

### 3. Configurer sur Discord
```
/modsetup logs:#mod-logs mute_role:@Muted
```

### 4. Ajouter le premier staff
```
/staffadd @toi niveau:4
```

---

## 🖥️ Panel Web

Accès : `https://ton-url.railway.app/?guild=GUILD_ID`

- **Dashboard** : stats et dernières sanctions
- **Sanctions** : historique complet avec filtres
- **Membres** : fiches individuelles avec casier
- **Staff** : gestion des niveaux
- **Comptes** : gestion des accès panel
