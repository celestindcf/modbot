// ─── LICENCE CHECKER ─────────────────────────────────────────────────────────
// Copiez ce fichier dans votre projet sous le nom "licenceChecker.js"
// Puis ajoutez dans votre bot.js : const { checkLicence, isPremium } = require('./licenceChecker');

const LICENCE_SERVER_URL = process.env.LICENCE_SERVER_URL || 'http://5.180.34.39:27247';
const API_SECRET = process.env.API_SECRET || 'api-secret-key'; // Doit être identique au serveur de licences
const BOT_NAME = process.env.BOT_NAME || 'modbot'; // 'modbot' ou 'meetingbot'

// Cache pour éviter trop de requêtes
const licenceCache = new Map(); // guildId -> { valid, type, isPremium, cachedAt }
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function checkLicence(guildId) {
  // Vérifier le cache
  const cached = licenceCache.get(guildId);
  if (cached && Date.now() - cached.cachedAt < CACHE_DURATION) {
    return cached;
  }

  try {
    const response = await fetch(`${LICENCE_SERVER_URL}/api/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-secret': API_SECRET
      },
      body: JSON.stringify({ guildId, bot: BOT_NAME })
    });

    if (!response.ok) throw new Error('Licence server error');

    const data = await response.json();
    const result = {
      valid: data.valid,
      type: data.type || 'none',
      isPremium: data.isPremium || false,
      features: data.features || [],
      reason: data.reason || null,
      cachedAt: Date.now()
    };

    licenceCache.set(guildId, result);
    return result;
  } catch (err) {
    console.error(`[LICENCE] Erreur vérification pour ${guildId}:`, err.message);
    // En cas d'erreur réseau, on autorise par défaut pour ne pas bloquer les serveurs légitimes
    return { valid: true, type: 'free', isPremium: false, features: ['basic'], cachedAt: Date.now() };
  }
}

function isPremium(guildId) {
  const cached = licenceCache.get(guildId);
  return cached?.isPremium || false;
}

function hasFeature(guildId, feature) {
  const cached = licenceCache.get(guildId);
  return cached?.features?.includes(feature) || false;
}

function clearCache(guildId) {
  if (guildId) licenceCache.delete(guildId);
  else licenceCache.clear();
}

module.exports = { checkLicence, isPremium, hasFeature, clearCache };

/*
─── COMMENT UTILISER DANS BOT.JS ────────────────────────────────────────────

1. VÉRIFICATION AU DÉMARRAGE D'UNE COMMANDE :

const { checkLicence } = require('./licenceChecker');

// Dans votre handler de commande :
const licence = await checkLicence(guildId);
if (!licence.valid) {
  const reasons = {
    NO_LICENCE: 'Ce serveur n\'a pas de licence. Rejoignez notre Discord pour en obtenir une !',
    BLOCKED: 'La licence de ce serveur a été révoquée.',
    EXPIRED: 'La licence de ce serveur a expiré.'
  };
  await interaction.editReply({ content: `❌ ${reasons[licence.reason] || 'Licence invalide.'}` });
  return;
}

2. VÉRIFICATION D'UNE FONCTIONNALITÉ PREMIUM :

const { checkLicence } = require('./licenceChecker');

// Dans votre handler de commande XP par exemple :
const licence = await checkLicence(guildId);
if (!licence.isPremium) {
  await interaction.editReply({ content: '⭐ Cette fonctionnalité est réservée aux serveurs Premium !\nRejoignez notre Discord pour upgrader.' });
  return;
}

3. VÉRIFICATION AU DÉMARRAGE DU BOT (dans client.once('clientReady')) :

client.once('clientReady', async () => {
  console.log(`🤖 ${client.user.tag} connecté !`);
  
  // Pré-charger les licences de tous les serveurs
  for (const guild of client.guilds.cache.values()) {
    const licence = await checkLicence(guild.id);
    if (!licence.valid) {
      console.log(`⚠️ Serveur sans licence: ${guild.name} (${guild.id})`);
    }
  }
  
  await registerCommands();
});

4. VARIABLES D'ENVIRONNEMENT À AJOUTER DANS RENDER :

LICENCE_SERVER_URL = https://votre-licence-server.onrender.com
API_SECRET = votre-cle-secrete (identique dans les deux bots et le serveur)
BOT_NAME = modbot (ou meetingbot selon le bot)

*/
