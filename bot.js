const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, REST, Routes, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, AttachmentBuilder, StringSelectMenuBuilder, AuditLogEvent } = require('discord.js');
const { checkLicence } = require('./licenceChecker');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN';
const CLIENT_ID = process.env.CLIENT_ID || 'YOUR_CLIENT_ID';
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
const PANEL_URL = process.env.PANEL_URL || 'http://localhost:1000';
const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || 'YOUR_MONGODB_URL';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ACTIVITY_WEBHOOK = 'https://discord.com/api/webhooks/1489280601683922954/hD3sNwiIflznrj5fU1RxKbbf55IZIDqJnJN4JImpK1RCbq0aiudZ5bQD9tRcXDR7itu8';

// ─── MongoDB ──────────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  const mongoClient = new MongoClient(MONGO_URL);
  await mongoClient.connect();
  db = mongoClient.db('modbot');
  console.log('✅ MongoDB connecté !');
}
function col(name) { return db.collection(name); }

// ─── Admin Levels ─────────────────────────────────────────────────────────────
const ADMIN_LEVELS = {
  1: { name: 'Modérateur', color: 0x57F287, perms: ['warn', 'mute'] },
  2: { name: 'Senior Mod', color: 0xFEE75C, perms: ['warn', 'mute', 'kick'] },
  3: { name: 'Admin', color: 0xED4245, perms: ['warn', 'mute', 'kick', 'ban', 'unban', 'unmute', 'clearwarn'] },
  4: { name: 'Super Admin', color: 0x5865F2, perms: ['warn', 'mute', 'kick', 'ban', 'unban', 'unmute', 'clearwarn', 'manage_staff'] }
};
const AUTO_SANCTIONS = [
  { warns: 3, action: 'mute', duration: 3600000, reason: 'Auto: 3 warns' },
  { warns: 5, action: 'kick', reason: 'Auto: 5 warns' },
  { warns: 7, action: 'ban', reason: 'Auto: 7 warns' }
];

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildInvites,
  ]
});

// ─── In-Memory Maps ───────────────────────────────────────────────────────────
const spamMap = new Map();
const selfbotMap = new Map(); // userId -> { timestamps: [] }
const joinMap = new Map(); // guildId -> { timestamps: [] }
const captchaMap = new Map(); // userId -> { code, guildId, roleId }
const xpCooldowns = new Map();
const coinCooldowns = new Map();
const aiRateLimitMap = new Map(); // Pour limiter les appels IA
const faqCache = new Map(); // Cache pour les réponses FAQ

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}min`;
  if (s < 86400) return `${Math.floor(s/3600)}h`;
  return `${Math.floor(s/86400)}j`;
}
function parseDuration(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(s|min|h|j)$/);
  if (!match) return null;
  const val = parseInt(match[1]);
  return val * { s: 1000, min: 60000, h: 3600000, j: 86400000 }[match[2]];
}
function getXPForLevel(level) { return 100 * level * level; }
function getLevelFromXP(xp) { let l = 0; while (xp >= getXPForLevel(l + 1)) l++; return l; }

async function logAction(guild, action) {
  const config = await col('mod_configs').findOne({ guildId: guild.id }) || {};
  if (!config.logChannel) return;
  const channel = guild.channels.cache.get(config.logChannel);
  if (!channel) return;
  const colors = { warn: 0xFEE75C, mute: 0xEB459E, kick: 0xED4245, ban: 0x000000, unban: 0x57F287, unmute: 0x57F287 };
  const icons = { warn: '⚠️', mute: '🔇', kick: '👢', ban: '🔨', unban: '✅', unmute: '🔊' };
  const embed = new EmbedBuilder()
    .setTitle(`${icons[action.type] || '📋'} ${action.type.toUpperCase()}`)
    .setColor(colors[action.type] || 0x5865F2)
    .addFields(
      { name: '👤 Membre', value: `<@${action.targetId}> (${action.targetTag})`, inline: true },
      { name: '🛡️ Modérateur', value: `<@${action.modId}>`, inline: true },
      { name: '📝 Raison', value: action.reason || 'Aucune raison', inline: false }
    ).setTimestamp().setFooter({ text: `ID: ${action.id}` });
  if (action.duration) embed.addFields({ name: '⏱️ Durée', value: formatDuration(action.duration), inline: true });
  await channel.send({ embeds: [embed] });
}

async function logEvent(guild, embed, isPremiumOnly = false) {
  if (isPremiumOnly) {
    const lic = await checkLicence(guild.id);
    if (!lic.isPremium) return;
  }
  const config = await col('mod_configs').findOne({ guildId: guild.id }) || {};
  const channelId = config.eventLogChannel || config.logChannel;
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;
  await channel.send({ embeds: [embed] }).catch(() => {});
}

async function addSanction(guildId, targetId, targetTag, modId, type, reason, duration = null) {
  const count = await col('mod_cases').countDocuments({ guildId });
  const sanction = { id: uuidv4().slice(0, 8), caseNumber: count + 1, guildId, type, targetId, targetTag, modId, reason: reason || 'Aucune raison', duration, createdAt: new Date().toISOString(), active: true };
  await col('mod_cases').insertOne(sanction);
  return sanction;
}

async function checkAutoSanctions(guild, member) {
  const activeWarns = await col('mod_cases').countDocuments({ guildId: guild.id, targetId: member.id, type: 'warn', active: true });
  for (const rule of AUTO_SANCTIONS) {
    if (activeWarns === rule.warns) {
      const config = await col('mod_configs').findOne({ guildId: guild.id }) || {};
      if (rule.action === 'mute') {
        if (config.muteRole) await member.roles.add(config.muteRole).catch(() => {});
        else await member.timeout(rule.duration, rule.reason).catch(() => {});
        const s = await addSanction(guild.id, member.id, member.user.tag, client.user.id, 'mute', rule.reason, rule.duration);
        await logAction(guild, s);
      } else if (rule.action === 'kick') {
        await member.kick(rule.reason).catch(() => {});
        await logAction(guild, await addSanction(guild.id, member.id, member.user.tag, client.user.id, 'kick', rule.reason));
      } else if (rule.action === 'ban') {
        await member.ban({ reason: rule.reason }).catch(() => {});
        await logAction(guild, await addSanction(guild.id, member.id, member.user.tag, client.user.id, 'ban', rule.reason));
      }
      return { triggered: true, action: rule.action, warns: rule.warns };
    }
  }
  return { triggered: false };
}

// ─── XP System ────────────────────────────────────────────────────────────────
async function addXP(guildId, userId, username) {
  const now = Date.now();
  const key = `${guildId}-${userId}`;
  if (xpCooldowns.has(key) && now - xpCooldowns.get(key) < 60000) return null;
  xpCooldowns.set(key, now);
  const xpGain = Math.floor(Math.random() * 15) + 5;
  const user = await col('xp_users').findOne({ guildId, userId }) || { xp: 0 };
  const newXP = (user.xp || 0) + xpGain;
  const oldLevel = getLevelFromXP(user.xp || 0);
  const newLevel = getLevelFromXP(newXP);
  await col('xp_users').updateOne({ guildId, userId }, { $set: { guildId, userId, username, xp: newXP, level: newLevel, lastUpdated: new Date().toISOString() } }, { upsert: true });
  return newLevel > oldLevel ? { levelUp: true, newLevel } : { levelUp: false };
}

// ─── Coins System ─────────────────────────────────────────────────────────────
async function addCoins(guildId, userId, username, amount) {
  await col('economy').updateOne({ guildId, userId }, { $inc: { coins: amount }, $set: { username, lastUpdated: new Date().toISOString() }, $setOnInsert: { guildId, userId, createdAt: new Date().toISOString() } }, { upsert: true });
}
async function getCoins(guildId, userId) {
  const doc = await col('economy').findOne({ guildId, userId });
  return doc?.coins || 0;
}
async function removeCoins(guildId, userId, amount) {
  const coins = await getCoins(guildId, userId);
  if (coins < amount) return false;
  await col('economy').updateOne({ guildId, userId }, { $inc: { coins: -amount } });
  return true;
}

// ─── Anti-Spam ────────────────────────────────────────────────────────────────
async function checkSpam(message) {
  const config = await col('mod_configs').findOne({ guildId: message.guild.id }) || {};
  if (!config.antiSpam) return false;
  const userId = message.author.id;
  const now = Date.now();
  const userData = spamMap.get(userId) || { timestamps: [], warned: false };
  userData.timestamps = userData.timestamps.filter(t => now - t < 5000);
  userData.timestamps.push(now);
  spamMap.set(userId, userData);
  const linkRegex = /(https?:\/\/|discord\.gg\/|discord\.com\/invite\/)/gi;
  if (config.antiLinks && linkRegex.test(message.content) && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
    await message.delete().catch(() => {});
    return 'link';
  }
  if (message.mentions.users.size >= 5) { await message.delete().catch(() => {}); return 'mentions'; }
  if (userData.timestamps.length >= 5) {
    await message.delete().catch(() => {});
    if (!userData.warned) {
      userData.warned = true;
      spamMap.set(userId, userData);
      setTimeout(() => { const d = spamMap.get(userId); if (d) { d.warned = false; spamMap.set(userId, d); } }, 10000);
      return 'spam';
    }
  }
  return false;
}

// ─── PREMIUM: Self-Bot Detection ──────────────────────────────────────────────
async function checkSelfBot(message) {
  if (message.author.bot) return false;
  const userId = message.author.id;
  const now = Date.now();
  const data = selfbotMap.get(userId) || { timestamps: [] };
  data.timestamps = data.timestamps.filter(t => now - t < 2000);
  data.timestamps.push(now);
  selfbotMap.set(userId, data);
  if (data.timestamps.length >= 8) {
    selfbotMap.delete(userId);
    return true;
  }
  return false;
}

// ─── PREMIUM: Auto-Lockdown ───────────────────────────────────────────────────
const lockdownActive = new Map();
async function checkJoinFlood(guild, member) {
  const now = Date.now();
  const data = joinMap.get(guild.id) || { timestamps: [] };
  data.timestamps = data.timestamps.filter(t => now - t < 10000);
  data.timestamps.push(now);
  joinMap.set(guild.id, data);
  if (data.timestamps.length >= 50 && !lockdownActive.get(guild.id)) {
    lockdownActive.set(guild.id, true);
    const config = await col('mod_configs').findOne({ guildId: guild.id }) || {};
    const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
    for (const [, ch] of textChannels) {
      await ch.permissionOverwrites.edit(guild.id, { SendMessages: false }).catch(() => {});
    }
    const embed = new EmbedBuilder().setTitle('🔒 AUTO-LOCKDOWN ACTIVÉ').setColor(0xED4245)
      .setDescription('50+ membres ont rejoint en moins de 10 secondes. Tous les salons ont été verrouillés.\nUtilisez `/lockdown off` pour déverrouiller.')
      .setTimestamp();
    if (config.logChannel) { const lc = guild.channels.cache.get(config.logChannel); if (lc) await lc.send({ embeds: [embed] }); }
    await sendActivityWebhook(`🔒 **AUTO-LOCKDOWN** sur **${guild.name}** (${guild.id}) — 50+ joins en 10s`);
  }
}

// ─── PREMIUM: Webhook activité ────────────────────────────────────────────────
async function sendActivityWebhook(content) {
  try {
    await fetch(ACTIVITY_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, username: 'ModBot Activity' }) });
  } catch {}
}

// ─── PREMIUM: IA (Groq API - Gratuit 14 400 req/jour) ─────────────────────────
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// Fonction pour vérifier si l'IA est disponible
function isAIAvailable() {
  const disabledUntil = aiRateLimitMap.get('disabled_until');
  if (disabledUntil && Date.now() < disabledUntil) {
    return false;
  }
  return true;
}

async function callAI(prompt, systemPrompt = '') {
  if (!GROQ_API_KEY) { 
    console.log('[IA] GROQ_API_KEY non configurée'); 
    return null; 
  }
  
  // Vérifier si l'IA est temporairement désactivée
  if (!isAIAvailable()) {
    console.log('[IA] IA temporairement désactivée (quota)');
    return null;
  }
  
  // Rate limiting local (30 requêtes par minute maximum)
  const now = Date.now();
  const rateKey = 'groq_requests';
  const requests = aiRateLimitMap.get(rateKey) || [];
  const recentRequests = requests.filter(t => now - t < 60000);
  
  if (recentRequests.length >= 30) {
    console.log('[IA] Rate limit local Groq atteint, attente...');
    return null;
  }
  
  recentRequests.push(now);
  aiRateLimitMap.set(rateKey, recentRequests);
  
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt || 'Tu es un assistant de modération Discord.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 500,
        temperature: 0.3
      })
    });
    
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[IA] Erreur Groq:', res.status, JSON.stringify(err));
      
      // Gestion spécifique des erreurs de quota
      if (res.status === 429) {
        console.log('[IA] Quota Groq dépassé, désactivation temporaire pour 5 minutes');
        aiRateLimitMap.set('disabled_until', now + 300000);
        return null;
      }
      
      return null;
    }
    
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) { 
      console.error('[IA] Pas de texte dans la réponse Groq:', JSON.stringify(data)); 
      return null; 
    }
    return text;
  } catch (e) {
    console.error('[IA] Exception callAI:', e.message);
    return null;
  }
}

async function checkAIModeration(message, config) {
  if (!config.aiModeration || !GROQ_API_KEY) return false;
  if (!isAIAvailable()) return false;
  if (message.content.length < 20) return false;
  
  try {
    const response = await callAI(
      `Analyse ce message Discord et dis si c'est du harcèlement, une insulte déguisée, du contenu toxique ou de la discrimination. Réponds UNIQUEMENT par OUI ou NON, rien d'autre.\n\nMessage à analyser: "${message.content.slice(0, 200)}"`
    );
    if (!response) return false;
    return response.trim().toUpperCase().startsWith('OUI');
  } catch { return false; }
}

// ─── PREMIUM: Captcha ─────────────────────────────────────────────────────────
function generateCaptchaCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── PREMIUM: Welcome messages aléatoires ────────────────────────────────────
const DEFAULT_WELCOME_MESSAGES = [
  'Bienvenue {user} sur **{server}** ! 🎉 Nous sommes maintenant **{count}** membres !',
  '✨ {user} vient de rejoindre **{server}** ! Contenu les accueillir chaleureusement !',
  '🚀 Un nouveau membre est arrivé ! Bienvenue {user} dans **{server}** !',
  '👋 Hey {user} ! Tu rejoins une communauté de **{count}** membres sur **{server}** !',
  '🌟 {user} a rejoint le serveur ! Bienvenue dans **{server}** !'
];

// ─── Ticket: Create ───────────────────────────────────────────────────────────
async function createTicket(guild, user, config, ticketType = null) {
  const ticketNumber = (await col('tickets').countDocuments({ guildId: guild.id })) + 1;
  const typeSlug = ticketType ? ticketType.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 15) : 'ticket';
  const channelName = `${typeSlug}-${ticketNumber.toString().padStart(4, '0')}`;
  const ticketTypes = config.ticketTypes || [];
  const typeConfig = ticketTypes.find(t => t.label === ticketType) || {};
  const categoryId = typeConfig.categoryId || config.ticketCategory;
  const channel = await guild.channels.create({
    name: channelName, type: ChannelType.GuildText, parent: categoryId,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: config.ticketStaffRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
    ]
  });
  const ticket = { id: uuidv4().slice(0, 8), number: ticketNumber, guildId: guild.id, userId: user.id, userTag: user.tag, channelId: channel.id, type: ticketType || 'Support', status: 'open', createdAt: new Date().toISOString() };
  await col('tickets').insertOne(ticket);
  const welcomeMsg = typeConfig.welcomeMessage || config.ticketWelcomeMessage || `Bonjour <@${user.id}> !\nNotre équipe va vous répondre dès que possible.`;
  const welcomeColor = typeConfig.color ? parseInt(typeConfig.color.replace('#', ''), 16) : 0x5865F2;
  const embed = new EmbedBuilder()
    .setTitle(`${typeConfig.emoji || '🎫'} ${ticketType || 'Support'} — Ticket #${ticketNumber.toString().padStart(4, '0')}`)
    .setColor(welcomeColor).setDescription(welcomeMsg.replace('{user}', `<@${user.id}>`)).setTimestamp();
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`close_ticket_${ticket.id}`).setLabel('🔒 Fermer le ticket').setStyle(ButtonStyle.Danger));
  await channel.send({ content: `<@${user.id}> <@&${config.ticketStaffRole}>`, embeds: [embed], components: [row] });
  const dmMsg = typeConfig.dmMessage || config.ticketDmMessage;
  if (dmMsg) { try { await user.send({ embeds: [new EmbedBuilder().setTitle(`${typeConfig.emoji||'🎫'} Ticket ouvert — ${guild.name}`).setColor(welcomeColor).setDescription(dmMsg.replace('{user}',user.username).replace('{type}',ticketType||'Support').replace('{number}',`#${ticketNumber.toString().padStart(4,'0')}`).replace('{channel}',`<#${channel.id}>`)).setTimestamp()] }); } catch {} }
  return { channel, ticket };
}

async function closeTicket(guild, channel, closedBy, ticketId) {
  const ticket = await col('tickets').findOne({ id: ticketId, guildId: guild.id });
  if (!ticket || ticket.status === 'closed') return;
  const messages = await channel.messages.fetch({ limit: 100 });
  const transcript = messages.reverse().map(m => `[${new Date(m.createdTimestamp).toLocaleString('fr-FR')}] ${m.author.tag}: ${m.content}`).join('\n');
  const attachment = new AttachmentBuilder(Buffer.from(transcript, 'utf-8'), { name: `ticket-${ticket.number}-transcript.txt` });
  await col('tickets').updateOne({ id: ticketId }, { $set: { status: 'closed', closedBy: closedBy.id, closedAt: new Date().toISOString() } });
  const config = await col('mod_configs').findOne({ guildId: guild.id }) || {};
  if (config.ticketLogChannel) {
    const logChannel = guild.channels.cache.get(config.ticketLogChannel);
    if (logChannel) await logChannel.send({ embeds: [new EmbedBuilder().setTitle(`🔒 Ticket #${ticket.number.toString().padStart(4,'0')} fermé`).setColor(0xED4245).addFields({ name: '👤 Ouvert par', value: `<@${ticket.userId}>`, inline: true }, { name: '🔒 Fermé par', value: `<@${closedBy.id}>`, inline: true }, { name: '📅 Durée', value: formatDuration(Date.now() - new Date(ticket.createdAt).getTime()), inline: true }).setTimestamp()], files: [attachment] });
  }
  const ticketUser = await guild.members.fetch(ticket.userId).catch(() => null);
  if (ticketUser) await ticketUser.user.send({ embeds: [new EmbedBuilder().setTitle(`🔒 Votre ticket a été fermé — ${guild.name}`).setColor(0xED4245).setDescription(`Ticket #${ticket.number.toString().padStart(4,'0')} fermé. Merci !`)], files: [attachment] }).catch(() => {});
  await channel.delete().catch(() => {});
}

// ─── Slash Commands ───────────────────────────────────────────────────────────
const commands = [
  // Modération
  new SlashCommandBuilder().setName('warn').setDescription('Avertir un membre').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)).addStringOption(o=>o.setName('raison').setDescription('Raison')).addStringOption(o=>o.setName('mention').setDescription('Message au membre')),
  new SlashCommandBuilder().setName('mute').setDescription('Muter un membre').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)).addStringOption(o=>o.setName('duree').setDescription('Durée (1h, 30min...)')).addStringOption(o=>o.setName('raison').setDescription('Raison')).addStringOption(o=>o.setName('mention').setDescription('Message au membre')),
  new SlashCommandBuilder().setName('unmute').setDescription('Démuter un membre').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)),
  new SlashCommandBuilder().setName('kick').setDescription('Expulser un membre').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)).addStringOption(o=>o.setName('raison').setDescription('Raison')).addStringOption(o=>o.setName('mention').setDescription('Message au membre')),
  new SlashCommandBuilder().setName('ban').setDescription('Bannir un membre').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)).addStringOption(o=>o.setName('raison').setDescription('Raison')).addStringOption(o=>o.setName('mention').setDescription('Message au membre')),
  new SlashCommandBuilder().setName('unban').setDescription('Débannir').addStringOption(o=>o.setName('userid').setDescription('ID Discord').setRequired(true)).addStringOption(o=>o.setName('raison').setDescription('Raison')),
  new SlashCommandBuilder().setName('casier').setDescription('Casier judiciaire').addUserOption(o=>o.setName('membre').setDescription('Membre')),
  new SlashCommandBuilder().setName('mafiche').setDescription('Votre fiche'),
  new SlashCommandBuilder().setName('clearwarn').setDescription('Effacer warns').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)).addStringOption(o=>o.setName('id').setDescription('ID warn')),
  // Config
  new SlashCommandBuilder().setName('modsetup').setDescription('Configurer le bot')
    .addChannelOption(o=>o.setName('logs').setDescription('Canal logs mod').setRequired(true))
    .addChannelOption(o=>o.setName('eventlogs').setDescription('Canal logs événements'))
    .addRoleOption(o=>o.setName('mute_role').setDescription('Rôle mute'))
    .addBooleanOption(o=>o.setName('antispam').setDescription('Anti-spam'))
    .addBooleanOption(o=>o.setName('antilinks').setDescription('Anti-liens'))
    .addBooleanOption(o=>o.setName('ai_moderation').setDescription('[PREMIUM] Modération IA'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('modpanel').setDescription('Lien du panel'),
  // Staff
  new SlashCommandBuilder().setName('staffadd').setDescription('Ajouter un staff').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)).addIntegerOption(o=>o.setName('niveau').setDescription('Niveau 1-4').setRequired(true).setMinValue(1).setMaxValue(4)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('staffliste').setDescription('Liste du staff'),
  // Tickets
  new SlashCommandBuilder().setName('ticket').setDescription('Ouvrir un ticket'),
  new SlashCommandBuilder().setName('ticketsetup').setDescription('Configurer tickets').addChannelOption(o=>o.setName('category').setDescription('Catégorie').setRequired(true)).addRoleOption(o=>o.setName('staff_role').setDescription('Rôle staff').setRequired(true)).addChannelOption(o=>o.setName('logs').setDescription('Canal logs')).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('ticketpanel').setDescription('Envoyer panel tickets').addChannelOption(o=>o.setName('salon').setDescription('Salon').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('fermerticket').setDescription('Fermer ce ticket'),
  // XP
  new SlashCommandBuilder().setName('niveau').setDescription('Voir niveau XP').addUserOption(o=>o.setName('membre').setDescription('Membre')),
  new SlashCommandBuilder().setName('classement').setDescription('Classement XP'),
  new SlashCommandBuilder().setName('xpsetup').setDescription('Config XP').addBooleanOption(o=>o.setName('actif').setDescription('Activer').setRequired(true)).addChannelOption(o=>o.setName('levelup_channel').setDescription('Canal level up')).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  // PREMIUM: Security
  new SlashCommandBuilder().setName('captchasetup').setDescription('[PREMIUM] Configurer le captcha').addRoleOption(o=>o.setName('role').setDescription('Rôle donné après vérification').setRequired(true)).addChannelOption(o=>o.setName('salon').setDescription('Salon de vérification').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('lockdown').setDescription('[PREMIUM] Verrouiller/déverrouiller les salons').addStringOption(o=>o.setName('action').setDescription('on/off').setRequired(true).addChoices({name:'🔒 Activer',value:'on'},{name:'🔓 Désactiver',value:'off'})).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  // PREMIUM: Welcome
  new SlashCommandBuilder().setName('welcomesetup').setDescription('[PREMIUM] Configurer les messages de bienvenue').addChannelOption(o=>o.setName('salon').setDescription('Salon bienvenue').setRequired(true)).addBooleanOption(o=>o.setName('actif').setDescription('Activer').setRequired(true)).addStringOption(o=>o.setName('message').setDescription('Message custom (variables: {user}, {server}, {count})')).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('leavesetup').setDescription('[PREMIUM] Configurer les messages de départ').addChannelOption(o=>o.setName('salon').setDescription('Salon départ').setRequired(true)).addBooleanOption(o=>o.setName('actif').setDescription('Activer').setRequired(true)).addStringOption(o=>o.setName('message').setDescription('Message custom')).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  // PREMIUM: IA
  new SlashCommandBuilder().setName('resume').setDescription('[PREMIUM] Résumer les derniers messages').addIntegerOption(o=>o.setName('nombre').setDescription('Nombre de messages (max 100)').setMinValue(10).setMaxValue(100)),
  new SlashCommandBuilder().setName('faq').setDescription('[PREMIUM] Configurer la FAQ du serveur pour le support auto').addStringOption(o=>o.setName('question').setDescription('Question').setRequired(true)).addStringOption(o=>o.setName('reponse').setDescription('Réponse').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('iastatus').setDescription('[PREMIUM] Vérifier le statut de l\'IA Gemini'),
  // PREMIUM: Économie
  new SlashCommandBuilder().setName('solde').setDescription('Voir votre solde de coins').addUserOption(o=>o.setName('membre').setDescription('Membre')),
  new SlashCommandBuilder().setName('classementcoins').setDescription('[PREMIUM] Classement des coins'),
  new SlashCommandBuilder().setName('shop').setDescription('[PREMIUM] Boutique du serveur'),
  new SlashCommandBuilder().setName('acheter').setDescription('[PREMIUM] Acheter un article').addStringOption(o=>o.setName('id').setDescription('ID de l\'article').setRequired(true)),
  new SlashCommandBuilder().setName('donner').setDescription('[PREMIUM] Donner des coins').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)).addIntegerOption(o=>o.setName('montant').setDescription('Montant').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('shopsetup').setDescription('[PREMIUM] Gérer la boutique').addSubcommand(s=>s.setName('ajouter').setDescription('Ajouter un article').addStringOption(o=>o.setName('nom').setDescription('Nom').setRequired(true)).addIntegerOption(o=>o.setName('prix').setDescription('Prix en coins').setRequired(true).setMinValue(1)).addStringOption(o=>o.setName('type').setDescription('Type').setRequired(true).addChoices({name:'Rôle',value:'role'},{name:'Licence Premium',value:'premium'})).addRoleOption(o=>o.setName('role').setDescription('Rôle à donner (si type=rôle)'))).addSubcommand(s=>s.setName('supprimer').setDescription('Supprimer un article').addStringOption(o=>o.setName('id').setDescription('ID article').setRequired(true))).addSubcommand(s=>s.setName('liste').setDescription('Voir les articles')).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  // Casino
  new SlashCommandBuilder().setName('casino').setDescription('[PREMIUM] Jeux de casino'),
  new SlashCommandBuilder().setName('slots').setDescription('[PREMIUM] Machine à sous').addIntegerOption(o=>o.setName('mise').setDescription('Mise en coins').setRequired(true).setMinValue(10)),
  new SlashCommandBuilder().setName('blackjack').setDescription('[PREMIUM] Jouer au blackjack').addIntegerOption(o=>o.setName('mise').setDescription('Mise en coins').setRequired(true).setMinValue(10)),
  new SlashCommandBuilder().setName('coinflip').setDescription('[PREMIUM] Pile ou face').addIntegerOption(o=>o.setName('mise').setDescription('Mise en coins').setRequired(true).setMinValue(10)).addStringOption(o=>o.setName('choix').setDescription('Pile ou Face').setRequired(true).addChoices({name:'🪙 Pile',value:'pile'},{name:'🦅 Face',value:'face'})),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Commandes enregistrées !');
  } catch (e) { console.error('❌', e); }
}

// ─── Bot Events ───────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`🤖 ${client.user.tag} connecté !`);
  await registerCommands();
  // Webhook activité au démarrage
  for (const [, guild] of client.guilds.cache) {
    await sendActivityWebhook(`✅ **ModBot** actif sur **${guild.name}** (\`${guild.id}\`) — ${guild.memberCount} membres`);
  }
});

client.on('guildCreate', async guild => {
  await sendActivityWebhook(`➕ **ModBot** ajouté sur **${guild.name}** (\`${guild.id}\`) — ${guild.memberCount} membres`);
});
client.on('guildDelete', async guild => {
  await sendActivityWebhook(`➖ **ModBot** retiré de **${guild.name}** (\`${guild.id}\`)`);
});

// ─── Member Join ──────────────────────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  const { guild } = member;
  const licence = await checkLicence(guild.id);
  const config = await col('mod_configs').findOne({ guildId: guild.id }) || {};

  // Log de base (tous)
  await logEvent(guild, new EmbedBuilder().setTitle('👋 Nouveau membre').setColor(0x57F287).setThumbnail(member.user.displayAvatarURL()).addFields({ name: '👤 Membre', value: `<@${member.id}> (${member.user.tag})`, inline: true }, { name: '📅 Compte créé', value: `<t:${Math.floor(member.user.createdTimestamp/1000)}:R>`, inline: true }, { name: '👥 Total', value: `${guild.memberCount}`, inline: true }).setTimestamp());

  if (licence.isPremium) {
    // Auto-lockdown check
    await checkJoinFlood(guild, member);

    // Captcha
    if (config.captchaEnabled && config.captchaChannel && config.captchaRole) {
      const code = generateCaptchaCode();
      captchaMap.set(member.id, { code, guildId: guild.id, roleId: config.captchaRole });
      // Retirer tous les rôles sauf @everyone et donner accès uniquement au salon captcha
      const captchaChannel = guild.channels.cache.get(config.captchaChannel);
      if (captchaChannel) {
        const embed = new EmbedBuilder().setTitle('🔐 Vérification requise').setColor(0x5865F2)
          .setDescription(`Bienvenue sur **${guild.name}** !\nPour accéder au serveur, tapez le code ci-dessous dans ce salon.`)
          .addFields({ name: '🔑 Votre code', value: `\`\`\`${code}\`\`\`` })
          .setFooter({ text: 'Ce code expire dans 5 minutes' }).setTimestamp();
        await captchaChannel.send({ content: `<@${member.id}>`, embeds: [embed] });
        setTimeout(() => { if (captchaMap.has(member.id)) { captchaMap.delete(member.id); member.kick('Captcha non complété').catch(() => {}); } }, 5 * 60 * 1000);
      }
      return;
    }

    // Welcome message aléatoire
    if (config.welcomeEnabled && config.welcomeChannel) {
      const channel = guild.channels.cache.get(config.welcomeChannel);
      if (channel) {
        const messages = config.welcomeMessages?.length ? config.welcomeMessages : DEFAULT_WELCOME_MESSAGES;
        let msg = messages[Math.floor(Math.random() * messages.length)];
        msg = msg.replace('{user}', member.toString()).replace('{server}', guild.name).replace('{count}', guild.memberCount.toString());
        const embed = new EmbedBuilder().setTitle('✨ Bienvenue !').setColor(config.welcomeColor || 0x57F287).setDescription(msg).setThumbnail(member.user.displayAvatarURL()).setTimestamp();
        await channel.send({ embeds: [embed] });
      }
    }
  }
});

// ─── Member Leave ─────────────────────────────────────────────────────────────
client.on('guildMemberRemove', async member => {
  const { guild } = member;
  const licence = await checkLicence(guild.id);
  const config = await col('mod_configs').findOne({ guildId: guild.id }) || {};
  await logEvent(guild, new EmbedBuilder().setTitle('🚪 Membre parti').setColor(0xED4245).setThumbnail(member.user.displayAvatarURL()).addFields({ name: '👤 Membre', value: `${member.user.tag}`, inline: true }, { name: '👥 Membres', value: `${guild.memberCount}`, inline: true }).setTimestamp());
  if (licence.isPremium && config.leaveEnabled && config.leaveChannel) {
    const channel = guild.channels.cache.get(config.leaveChannel);
    if (channel) {
      let msg = config.leaveMessage || '{user} nous a quitté. Il reste {count} membres.';
      msg = msg.replace('{user}', member.user.username).replace('{server}', guild.name).replace('{count}', guild.memberCount.toString());
      await channel.send({ embeds: [new EmbedBuilder().setTitle('👋 Au revoir').setColor(0xFF4757).setDescription(msg).setThumbnail(member.user.displayAvatarURL()).setTimestamp()] });
    }
  }
});

// ─── Message Delete (with image - PREMIUM) ───────────────────────────────────
client.on('messageDelete', async message => {
  if (!message.guild || message.author?.bot) return;
  const licence = await checkLicence(message.guild.id);
  const embed = new EmbedBuilder().setTitle('🗑️ Message supprimé').setColor(0xED4245)
    .addFields(
      { name: '👤 Auteur', value: `<@${message.author?.id}> (${message.author?.tag})`, inline: true },
      { name: '📍 Salon', value: `<#${message.channel.id}>`, inline: true },
      { name: '💬 Message', value: message.content?.slice(0, 1024) || '*Contenu inconnu*' }
    ).setTimestamp();

  const files = [];

  // Images (PREMIUM) — affichage en embed + fichier joint
  if (licence.isPremium && message.attachments.size > 0) {
    const images = message.attachments.filter(a => a.contentType?.startsWith('image/'));
    const others = message.attachments.filter(a => !a.contentType?.startsWith('image/'));

    if (images.size > 0) {
      // Première image en thumbnail dans l'embed
      const firstImg = images.first();
      embed.setImage(firstImg.proxyURL || firstImg.url);
      embed.addFields({ name: '🖼️ Image(s) supprimée(s)', value: images.map(a => `[${a.name}](${a.url})`).join('\n').slice(0, 400) });
    }
    if (others.size > 0) {
      embed.addFields({ name: '📎 Fichier(s)', value: others.map(a => a.name).join(', ').slice(0, 200) });
    }
  }

  const config = await col('mod_configs').findOne({ guildId: message.guild.id }) || {};
  const channelId = config.eventLogChannel || config.logChannel;
  if (!channelId) return;
  const logChannel = message.guild.channels.cache.get(channelId);
  if (!logChannel) return;
  await logChannel.send({ embeds: [embed], files }).catch(() => {});
});

// ─── Message Update ───────────────────────────────────────────────────────────
client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot) return;
  if (oldMessage.content === newMessage.content) return;
  await logEvent(newMessage.guild, new EmbedBuilder().setTitle('✏️ Message modifié').setColor(0xFEE75C).addFields({ name: '👤 Auteur', value: `<@${newMessage.author?.id}>`, inline: true }, { name: '📍 Salon', value: `<#${newMessage.channel.id}>`, inline: true }, { name: '📝 Avant', value: oldMessage.content?.slice(0, 512) || '*Inconnu*' }, { name: '📝 Après', value: newMessage.content?.slice(0, 512) || '*Inconnu*' }).setTimestamp());
});

// ─── Voice State ──────────────────────────────────────────────────────────────
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!newState.guild) return;
  let embed;
  if (!oldState.channel && newState.channel) embed = new EmbedBuilder().setTitle('🎤 Rejoint vocal').setColor(0x57F287).addFields({ name: '👤', value: `<@${newState.member.id}>`, inline: true }, { name: '🔊', value: newState.channel.name, inline: true }).setTimestamp();
  else if (oldState.channel && !newState.channel) embed = new EmbedBuilder().setTitle('🔇 Quitté vocal').setColor(0xED4245).addFields({ name: '👤', value: `<@${oldState.member.id}>`, inline: true }, { name: '🔊', value: oldState.channel.name, inline: true }).setTimestamp();
  if (embed) await logEvent(newState.guild, embed);
});

// ─── PREMIUM: Role Update Logs ────────────────────────────────────────────────
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const licence = await checkLicence(newMember.guild.id);
  if (!licence.isPremium) return;

  // Historique pseudo
  if (oldMember.nickname !== newMember.nickname || oldMember.user.username !== newMember.user.username) {
    await col('nickname_history').insertOne({ guildId: newMember.guild.id, userId: newMember.id, oldName: oldMember.nickname || oldMember.user.username, newName: newMember.nickname || newMember.user.username, changedAt: new Date().toISOString() });
  }

  // Logs de rôles
  const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
  const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id));
  if (addedRoles.size > 0 || removedRoles.size > 0) {
    const embed = new EmbedBuilder().setTitle('🎭 Modification de rôle').setColor(0xA29BFE).addFields({ name: '👤 Membre', value: `<@${newMember.id}>`, inline: true });
    if (addedRoles.size) embed.addFields({ name: '✅ Rôles ajoutés', value: addedRoles.map(r => `<@&${r.id}>`).join(', '), inline: true });
    if (removedRoles.size) embed.addFields({ name: '❌ Rôles retirés', value: removedRoles.map(r => `<@&${r.id}>`).join(', '), inline: true });
    embed.setTimestamp();
    await logEvent(newMember.guild, embed, true);
  }
});

// ─── Message Create ───────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  const config = await col('mod_configs').findOne({ guildId: message.guild.id }) || {};
  const licence = await checkLicence(message.guild.id);

  // Captcha check (PREMIUM)
  if (licence.isPremium && captchaMap.has(message.author.id)) {
    const captcha = captchaMap.get(message.author.id);
    if (captcha.guildId === message.guild.id) {
      if (message.content.trim().toUpperCase() === captcha.code) {
        captchaMap.delete(message.author.id);
        await message.member.roles.add(captcha.roleId).catch(() => {});
        const successMsg = await message.reply('✅ Vérification réussie ! Bienvenue !');
        setTimeout(() => successMsg.delete().catch(() => {}), 5000);
        await message.delete().catch(() => {});
      } else {
        const failMsg = await message.reply('❌ Code incorrect. Réessayez !');
        setTimeout(() => failMsg.delete().catch(() => {}), 3000);
        await message.delete().catch(() => {});
      }
      return;
    }
  }

  // Self-bot detection (PREMIUM)
  if (licence.isPremium && !message.author.bot) {
    const isSelfBot = await checkSelfBot(message);
    if (isSelfBot) {
      await message.member.kick('Self-bot détecté').catch(() => {});
      await logEvent(message.guild, new EmbedBuilder().setTitle('🤖 Self-Bot détecté et expulsé').setColor(0xED4245).addFields({ name: '👤 Membre', value: `${message.author.tag} (${message.author.id})` }).setTimestamp(), true);
      return;
    }
  }

  // Auto-mod IA (PREMIUM)
  if (licence.isPremium && config.aiModeration) {
    const toxic = await checkAIModeration(message, config);
    if (toxic) {
      await message.delete().catch(() => {});
      const warn = await message.channel.send({ content: `<@${message.author.id}> ⚠️ Message supprimé par l'IA de modération.` });
      setTimeout(() => warn.delete().catch(() => {}), 5000);
      const sanction = await addSanction(message.guild.id, message.author.id, message.author.tag, client.user.id, 'warn', 'Auto-mod IA: contenu toxique détecté');
      await logAction(message.guild, sanction);
      await checkAutoSanctions(message.guild, message.member);
      return;
    }
  }

    // Support Auto FAQ (PREMIUM)
  if (licence.isPremium && config.faqEnabled) {
    const faqs = await col('faq').find({ guildId: message.guild.id }).toArray();
    if (faqs.length > 0 && GROQ_API_KEY) {  // ← Changé GEMINI_API_KEY → GROQ_API_KEY
      // Vérifier si l'IA est disponible
      if (!isAIAvailable()) return; // ← Ajouté
      
      const faqText = faqs.map(f => `Q: ${f.question}\nR: ${f.answer}`).join('\n\n');
      const answer = await callAI(
        `Tu es un bot de support Discord. Un membre a envoyé ce message: "${message.content.slice(0, 300)}"\n\nVoici la FAQ du serveur:\n${faqText}\n\nSi ce message est une question à laquelle la FAQ répond, donne la réponse de façon naturelle et courte. Sinon, réponds uniquement le mot AUCUNE.`,
        'Tu es un assistant de support Discord. Réponds uniquement si la FAQ contient une réponse pertinente. Sois naturel et concis.'
      );
      if (answer && !answer.trim().toUpperCase().startsWith('AUCUNE') && answer.trim().length > 5) {
        const replyMsg = await message.reply({ content: `🤖 **Support Auto:** ${answer.slice(0, 1900)}`, allowedMentions: { repliedUser: false } });
        setTimeout(() => replyMsg.delete().catch(() => {}), 30000);
      }
    }
  }
  
  // Anti-spam
  const spamType = await checkSpam(message);
  if (spamType) {
    const msgs = { spam: '🚫 Stop le spam !', link: '🚫 Liens non autorisés !', mentions: '🚫 Trop de mentions !' };
    const warn = await message.channel.send({ content: `<@${message.author.id}> ${msgs[spamType]}` });
    setTimeout(() => warn.delete().catch(() => {}), 5000);
    const s = await addSanction(message.guild.id, message.author.id, message.author.tag, client.user.id, 'warn', `Auto-mod: ${spamType}`);
    await logAction(message.guild, s);
    await checkAutoSanctions(message.guild, message.member);
    return;
  }

  // XP
  if (config.xpEnabled) {
    const result = await addXP(message.guild.id, message.author.id, message.author.username);
    if (result?.levelUp) {
      const ch = config.levelUpChannel ? message.guild.channels.cache.get(config.levelUpChannel) : message.channel;
      if (ch) await ch.send({ embeds: [new EmbedBuilder().setTitle('🎉 Level Up !').setColor(0xFFD700).setDescription(`Félicitations <@${message.author.id}> ! Niveau **${result.newLevel}** ! 🚀`).setThumbnail(message.author.displayAvatarURL()).setTimestamp()] });
    }
  }

  // Coins (PREMIUM)
  if (licence.isPremium) {
    const coinKey = `${message.guild.id}-${message.author.id}`;
    const now = Date.now();
    if (!coinCooldowns.has(coinKey) || now - coinCooldowns.get(coinKey) > 60000) {
      coinCooldowns.set(coinKey, now);
      const gain = Math.floor(Math.random() * 5) + 1;
      await addCoins(message.guild.id, message.author.id, message.author.username, gain);
    }
  }
});

// ─── PREMIUM: Invitation Logs ─────────────────────────────────────────────────
const inviteCache = new Map();
client.on('guildCreate', async guild => { const invites = await guild.invites.fetch().catch(() => null); if (invites) inviteCache.set(guild.id, invites); });
client.on('inviteCreate', async invite => { const invites = await invite.guild.invites.fetch().catch(() => null); if (invites) inviteCache.set(invite.guild.id, invites); });
client.on('inviteDelete', async invite => { const invites = await invite.guild.invites.fetch().catch(() => null); if (invites) inviteCache.set(invite.guild.id, invites); });
client.on('guildMemberAdd', async member => {
  const licence = await checkLicence(member.guild.id);
  if (!licence.isPremium) return;
  try {
    const newInvites = await member.guild.invites.fetch();
    const oldInvites = inviteCache.get(member.guild.id);
    inviteCache.set(member.guild.id, newInvites);
    if (!oldInvites) return;
    const usedInvite = newInvites.find(i => { const old = oldInvites.get(i.code); return old && i.uses > old.uses; });
    if (usedInvite) {
      const embed = new EmbedBuilder().setTitle('📨 Log d\'invitation').setColor(0xA29BFE)
        .addFields({ name: '👤 Membre rejoint', value: `<@${member.id}>`, inline: true }, { name: '🔗 Invitation de', value: `<@${usedInvite.inviter?.id}> (\`${usedInvite.code}\`)`, inline: true }, { name: '📊 Utilisations', value: `${usedInvite.uses}`, inline: true })
        .setTimestamp();
      await logEvent(member.guild, embed, true);
    }
  } catch {}
});

// ─── Interactions ─────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  const guildId = interaction.guildId;
  const licence = await checkLicence(guildId);

  if (!licence.valid) {
    const reasons = { NO_LICENCE: "Ce serveur n'a pas de licence. Rejoignez notre Discord !", BLOCKED: "La licence de ce serveur a été révoquée.", EXPIRED: "La licence de ce serveur a expiré." };
    return await interaction.reply({ embeds: [new EmbedBuilder().setTitle('❌ Licence requise').setColor(0xED4245).setDescription(reasons[licence.reason] || 'Licence invalide.').setFooter({ text: "Contactez l'admin pour obtenir un accès." })], ephemeral: true });
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith('close_ticket_')) {
      const ticketId = interaction.customId.replace('close_ticket_', '');
      await interaction.reply({ content: '🔒 Fermeture...', ephemeral: true });
      await closeTicket(interaction.guild, interaction.channel, interaction.user, ticketId);
      return;
    }
    if (interaction.customId === 'open_ticket') {
      const config = await col('mod_configs').findOne({ guildId: interaction.guild.id }) || {};
      if (!config.ticketCategory || !config.ticketStaffRole) return interaction.reply({ content: '❌ Tickets non configurés.', ephemeral: true });
      const existing = await col('tickets').findOne({ guildId: interaction.guild.id, userId: interaction.user.id, status: 'open' });
      if (existing) return interaction.reply({ content: `❌ Ticket déjà ouvert : <#${existing.channelId}>`, ephemeral: true });
      const ticketTypes = config.ticketTypes || [];
      if (!ticketTypes.length) {
        await interaction.reply({ content: '🎫 Création...', ephemeral: true });
        const { channel } = await createTicket(interaction.guild, interaction.user, config, null);
        return interaction.editReply({ content: `✅ Ticket créé : <#${channel.id}>` });
      }
      const select = new StringSelectMenuBuilder().setCustomId('select_ticket_type').setPlaceholder('Choisissez le type...').addOptions(ticketTypes.map(t => ({ label: t.label, description: t.description || `Ouvrir un ticket ${t.label}`, value: t.label, emoji: t.emoji || '🎫' })));
      return interaction.reply({ content: '📋 **Quel type de ticket ?**', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
    }
    // Casino boutons
    if (interaction.customId.startsWith('bj_')) {
      await handleBlackjackButton(interaction);
      return;
    }
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'select_ticket_type') {
    const ticketType = interaction.values[0];
    const config = await col('mod_configs').findOne({ guildId: interaction.guild.id }) || {};
    await interaction.update({ content: '🎫 Création...', components: [] });
    const { channel } = await createTicket(interaction.guild, interaction.user, config, ticketType);
    return interaction.editReply({ content: `✅ Ticket **${ticketType}** créé : <#${channel.id}>`, components: [] });
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    const ephemeralCmds = ['modsetup', 'modpanel', 'mafiche', 'clearwarn', 'ticketsetup', 'xpsetup', 'fermerticket', 'captchasetup', 'welcomesetup', 'leavesetup', 'lockdown', 'faq', 'shopsetup'];
    await interaction.deferReply({ ephemeral: ephemeralCmds.includes(interaction.commandName) });
    await handleCommand(interaction, licence);
  } catch (err) { console.error(err); if (interaction.deferred) await interaction.editReply({ content: '❌ Erreur.' }); }
});

// ─── Command Handler ──────────────────────────────────────────────────────────
async function handleCommand(interaction, licence) {
  const { commandName, options, guildId, user, guild } = interaction;

  // Helper: vérifier premium
  async function requirePremium() {
    if (!licence.isPremium) {
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('⭐ Fonctionnalité Premium').setColor(0xFFD700).setDescription('Cette fonctionnalité est réservée aux serveurs Premium.\nRejoignez notre Discord pour upgrader !').setFooter({ text: 'NCL Bot Suite' })] });
      return false;
    }
    return true;
  }

  // ── modsetup ──
  if (commandName === 'modsetup') {
    const logsChannel = options.getChannel('logs');
    const eventLogsChannel = options.getChannel('eventlogs');
    const muteRole = options.getRole('mute_role');
    const antiSpam = options.getBoolean('antispam');
    const antiLinks = options.getBoolean('antilinks');
    const aiMod = options.getBoolean('ai_moderation');
    await col('mod_configs').updateOne({ guildId }, { $set: { guildId, logChannel: logsChannel.id, eventLogChannel: eventLogsChannel?.id || logsChannel.id, muteRole: muteRole?.id || null, antiSpam: antiSpam ?? false, antiLinks: antiLinks ?? false, aiModeration: licence.isPremium ? (aiMod ?? false) : false, setupBy: user.id, setupAt: new Date().toISOString() } }, { upsert: true });
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('⚙️ Modération configurée').setColor(0x57F287).addFields({ name: '📋 Logs mod', value: `<#${logsChannel.id}>`, inline: true }, { name: '🔇 Mute', value: muteRole ? `<@&${muteRole.id}>` : 'Non défini', inline: true }, { name: '🛡️ Anti-spam', value: antiSpam ? '✅' : '❌', inline: true }, { name: '🤖 IA Mod', value: licence.isPremium && aiMod ? '✅ Premium' : '❌', inline: true })] });
    return;
  }

  // ── modpanel ──
  if (commandName === 'modpanel') {
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🛡️ Panel de Modération').setColor(0x5865F2).setDescription(`🔗 **[Ouvrir le panel](${PANEL_URL}/?guild=${guildId})**`).addFields({ name: '🔑 Accès', value: 'Connectez-vous avec votre compte staff.' })] });
    return;
  }

  // ── staffadd ──
  if (commandName === 'staffadd') {
    const target = options.getUser('membre');
    const niveau = options.getInteger('niveau');
    await col('mod_staff').updateOne({ guildId, userId: target.id }, { $set: { guildId, userId: target.id, tag: target.tag, niveau, addedBy: user.id, addedAt: new Date().toISOString() } }, { upsert: true });
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('👥 Staff mis à jour').setColor(ADMIN_LEVELS[niveau].color).addFields({ name: '👤 Membre', value: `<@${target.id}>`, inline: true }, { name: '🏅 Niveau', value: `${niveau} — ${ADMIN_LEVELS[niveau].name}`, inline: true })] });
    return;
  }

  // ── staffliste ──
  if (commandName === 'staffliste') {
    const staff = await col('mod_staff').find({ guildId }).sort({ niveau: -1 }).toArray();
    if (!staff.length) { await interaction.editReply({ content: '❌ Aucun staff.' }); return; }
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('👥 Staff').setColor(0x5865F2).setDescription(staff.map(s => `**[Niv.${s.niveau}] ${ADMIN_LEVELS[s.niveau].name}** — <@${s.userId}>`).join('\n'))] });
    return;
  }

  // ── warn ──
  if (commandName === 'warn') {
    const target = options.getMember('membre');
    const raison = options.getString('raison') || 'Aucune raison';
    const mention = options.getString('mention');
    const sanction = await addSanction(guildId, target.id, target.user.tag, user.id, 'warn', raison);
    await logAction(guild, sanction);
    try { const dm = new EmbedBuilder().setTitle(`⚠️ Avertissement — ${guild.name}`).setColor(0xFEE75C).addFields({ name: '📝 Raison', value: raison }); if (mention) dm.addFields({ name: '💬 Message', value: mention }); await target.user.send({ embeds: [dm] }).catch(() => {}); } catch {}
    const auto = await checkAutoSanctions(guild, target);
    const embed = new EmbedBuilder().setTitle('⚠️ Avertissement').setColor(0xFEE75C).addFields({ name: '👤 Membre', value: `<@${target.id}>`, inline: true }, { name: '📝 Raison', value: raison, inline: true }, { name: '🆔 Case', value: `#${sanction.caseNumber}`, inline: true });
    if (auto.triggered) embed.addFields({ name: '🤖 Auto', value: `${auto.warns} warns → ${auto.action}` });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── mute ──
  if (commandName === 'mute') {
    const target = options.getMember('membre');
    const duration = parseDuration(options.getString('duree'));
    const raison = options.getString('raison') || 'Aucune raison';
    const mention = options.getString('mention');
    const config = await col('mod_configs').findOne({ guildId }) || {};
    if (config.muteRole) await target.roles.add(config.muteRole).catch(() => {});
    else await target.timeout(duration || 3600000, raison).catch(() => {});
    const sanction = await addSanction(guildId, target.id, target.user.tag, user.id, 'mute', raison, duration);
    await logAction(guild, sanction);
    if (mention) { try { await target.user.send({ embeds: [new EmbedBuilder().setTitle(`🔇 Mute — ${guild.name}`).setColor(0xEB459E).addFields({ name: '💬', value: mention }, { name: '📝', value: raison })] }).catch(() => {}); } catch {} }
    if (duration) setTimeout(async () => { if (config.muteRole) { const m = await guild.members.fetch(target.id).catch(() => null); if (m) await m.roles.remove(config.muteRole).catch(() => {}); } await col('mod_cases').updateOne({ id: sanction.id }, { $set: { active: false } }); }, duration);
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🔇 Mute').setColor(0xEB459E).addFields({ name: '👤', value: `<@${target.id}>`, inline: true }, { name: '⏱️', value: duration ? formatDuration(duration) : 'Indéfini', inline: true }, { name: '📝', value: raison })] });
    return;
  }

  // ── unmute ──
  if (commandName === 'unmute') {
    const target = options.getMember('membre');
    const config = await col('mod_configs').findOne({ guildId }) || {};
    if (config.muteRole) await target.roles.remove(config.muteRole).catch(() => {});
    await target.timeout(null).catch(() => {});
    await col('mod_cases').updateMany({ guildId, targetId: target.id, type: 'mute' }, { $set: { active: false } });
    await logAction(guild, await addSanction(guildId, target.id, target.user.tag, user.id, 'unmute', 'Unmute manuel'));
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🔊 Unmute').setColor(0x57F287).setDescription(`<@${target.id}> a été unmute.`)] });
    return;
  }

  // ── kick ──
  if (commandName === 'kick') {
    const target = options.getMember('membre');
    const raison = options.getString('raison') || 'Aucune raison';
    const mention = options.getString('mention');
    if (mention) { try { await target.user.send({ embeds: [new EmbedBuilder().setTitle(`👢 Kick — ${guild.name}`).setColor(0xED4245).addFields({ name: '📝', value: raison }, { name: '💬', value: mention })] }).catch(() => {}); } catch {} }
    await target.kick(raison);
    await logAction(guild, await addSanction(guildId, target.id, target.user.tag, user.id, 'kick', raison));
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('👢 Kick').setColor(0xED4245).addFields({ name: '👤', value: target.user.tag, inline: true }, { name: '📝', value: raison, inline: true })] });
    return;
  }

  // ── ban ──
  if (commandName === 'ban') {
    const target = options.getMember('membre');
    const raison = options.getString('raison') || 'Aucune raison';
    const mention = options.getString('mention');
    if (mention) { try { await target.user.send({ embeds: [new EmbedBuilder().setTitle(`🔨 Ban — ${guild.name}`).setColor(0x000000).addFields({ name: '📝', value: raison }, { name: '💬', value: mention })] }).catch(() => {}); } catch {} }
    await target.ban({ reason: raison });
    await logAction(guild, await addSanction(guildId, target.id, target.user.tag, user.id, 'ban', raison));
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🔨 Ban').setColor(0x000000).addFields({ name: '👤', value: target.user.tag, inline: true }, { name: '📝', value: raison, inline: true })] });
    return;
  }

  // ── unban ──
  if (commandName === 'unban') {
    const userId = options.getString('userid');
    const raison = options.getString('raison') || 'Aucune raison';
    await guild.members.unban(userId, raison).catch(() => {});
    await logAction(guild, await addSanction(guildId, userId, userId, user.id, 'unban', raison));
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('✅ Unban').setColor(0x57F287).setDescription(`\`${userId}\` a été débanni.`)] });
    return;
  }

  // ── casier ──
  if (commandName === 'casier') {
    const target = options.getUser('membre') || user;
    const cases = await col('mod_cases').find({ guildId, targetId: target.id }).sort({ createdAt: -1 }).toArray();
    const counts = { warn: 0, mute: 0, kick: 0, ban: 0 };
    cases.forEach(c => { if (counts[c.type] !== undefined) counts[c.type]++; });
    const embed = new EmbedBuilder().setTitle(`📋 Casier — ${target.tag}`).setColor(0x5865F2).setThumbnail(target.displayAvatarURL()).addFields({ name: '⚠️ Warns', value: `${counts.warn}`, inline: true }, { name: '🔇 Mutes', value: `${counts.mute}`, inline: true }, { name: '👢 Kicks', value: `${counts.kick}`, inline: true }, { name: '🔨 Bans', value: `${counts.ban}`, inline: true }, { name: '📊 Total', value: `${cases.length}`, inline: true });
    const recent = cases.slice(0, 5);
    if (recent.length) { const icons = { warn: '⚠️', mute: '🔇', kick: '👢', ban: '🔨', unban: '✅', unmute: '🔊' }; embed.addFields({ name: '📜 Récent', value: recent.map(c => `${icons[c.type]} **#${c.caseNumber}** — ${c.reason} <t:${Math.floor(new Date(c.createdAt).getTime()/1000)}:R>`).join('\n') }); }
    await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Panel').setStyle(ButtonStyle.Link).setURL(`${PANEL_URL}/?guild=${guildId}&user=${target.id}`))] });
    return;
  }

  // ── mafiche ──
  if (commandName === 'mafiche') {
    const cases = await col('mod_cases').find({ guildId, targetId: user.id }).toArray();
    const counts = { warn: 0, mute: 0, kick: 0, ban: 0 };
    cases.forEach(c => { if (counts[c.type] !== undefined) counts[c.type]++; });
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`📋 Votre Fiche — ${guild.name}`).setColor(0x5865F2).setThumbnail(user.displayAvatarURL()).addFields({ name: '⚠️', value: `${counts.warn}`, inline: true }, { name: '🔇', value: `${counts.mute}`, inline: true }, { name: '👢', value: `${counts.kick}`, inline: true }, { name: '🔨', value: `${counts.ban}`, inline: true })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Fiche complète').setStyle(ButtonStyle.Link).setURL(`${PANEL_URL}/fiche?guild=${guildId}&user=${user.id}`))] });
    return;
  }

  // ── clearwarn ──
  if (commandName === 'clearwarn') {
    const target = options.getUser('membre');
    const warnId = options.getString('id');
    if (warnId) { await col('mod_cases').updateOne({ id: warnId, targetId: target.id, type: 'warn' }, { $set: { active: false } }); await interaction.editReply({ content: `✅ Warn \`${warnId}\` effacé.` }); }
    else { await col('mod_cases').updateMany({ guildId, targetId: target.id, type: 'warn' }, { $set: { active: false } }); await interaction.editReply({ content: `✅ Tous les warns de <@${target.id}> effacés.` }); }
    return;
  }

  // ── ticketsetup ──
  if (commandName === 'ticketsetup') {
    const category = options.getChannel('category');
    const staffRole = options.getRole('staff_role');
    const logsChannel = options.getChannel('logs');
    await col('mod_configs').updateOne({ guildId }, { $set: { ticketCategory: category.id, ticketStaffRole: staffRole.id, ticketLogChannel: logsChannel?.id || null } }, { upsert: true });
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🎫 Tickets configurés').setColor(0x57F287).addFields({ name: '📁', value: category.name, inline: true }, { name: '👥', value: `<@&${staffRole.id}>`, inline: true })] });
    return;
  }

  // ── ticketpanel ──
  if (commandName === 'ticketpanel') {
    const salon = options.getChannel('salon');
    await salon.send({ embeds: [new EmbedBuilder().setTitle('🎫 Support').setColor(0x5865F2).setDescription('Besoin d\'aide ? Ouvre un ticket ci-dessous.')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('🎫 Ouvrir un ticket').setStyle(ButtonStyle.Primary))] });
    await interaction.editReply({ content: `✅ Panel envoyé dans <#${salon.id}>` });
    return;
  }

  // ── ticket ──
  if (commandName === 'ticket') {
    const config = await col('mod_configs').findOne({ guildId }) || {};
    if (!config.ticketCategory || !config.ticketStaffRole) { await interaction.editReply({ content: '❌ Tickets non configurés.' }); return; }
    const existing = await col('tickets').findOne({ guildId, userId: user.id, status: 'open' });
    if (existing) { await interaction.editReply({ content: `❌ Ticket déjà ouvert : <#${existing.channelId}>` }); return; }
    const { channel } = await createTicket(guild, user, config);
    await interaction.editReply({ content: `✅ Ticket créé : <#${channel.id}>` });
    return;
  }

  // ── fermerticket ──
  if (commandName === 'fermerticket') {
    const ticket = await col('tickets').findOne({ guildId, channelId: interaction.channel.id, status: 'open' });
    if (!ticket) { await interaction.editReply({ content: '❌ Pas un ticket ouvert.' }); return; }
    await interaction.editReply({ content: '🔒 Fermeture...' });
    await closeTicket(guild, interaction.channel, user, ticket.id);
    return;
  }

  // ── xpsetup ──
  if (commandName === 'xpsetup') {
    const actif = options.getBoolean('actif');
    const ch = options.getChannel('levelup_channel');
    await col('mod_configs').updateOne({ guildId }, { $set: { xpEnabled: actif, levelUpChannel: ch?.id || null } }, { upsert: true });
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('⭐ XP configuré').setColor(0xFFD700).addFields({ name: 'XP', value: actif ? '✅' : '❌', inline: true }, { name: 'Level-up', value: ch ? `<#${ch.id}>` : 'Salon actuel', inline: true })] });
    return;
  }

  // ── niveau ──
  if (commandName === 'niveau') {
    const target = options.getUser('membre') || user;
    const xpData = await col('xp_users').findOne({ guildId, userId: target.id });
    if (!xpData) { await interaction.editReply({ content: `❌ <@${target.id}> n'a pas d'XP.` }); return; }
    const level = getLevelFromXP(xpData.xp);
    const clxp = getXPForLevel(level), nlxp = getXPForLevel(level + 1);
    const prog = Math.floor(((xpData.xp - clxp) / (nlxp - clxp)) * 20);
    const rank = await col('xp_users').countDocuments({ guildId, xp: { $gt: xpData.xp } }) + 1;
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`⭐ Niveau — ${target.username}`).setColor(0xFFD700).setThumbnail(target.displayAvatarURL()).addFields({ name: '🏆 Niveau', value: `${level}`, inline: true }, { name: '⭐ XP', value: `${xpData.xp}`, inline: true }, { name: '🏅 Rang', value: `#${rank}`, inline: true }, { name: `📊 Vers niv.${level+1}`, value: `\`${'█'.repeat(prog)}${'░'.repeat(20-prog)}\` ${xpData.xp - clxp}/${nlxp - clxp} XP` })] });
    return;
  }

  // ── classement ──
  if (commandName === 'classement') {
    const top = await col('xp_users').find({ guildId }).sort({ xp: -1 }).limit(10).toArray();
    if (!top.length) { await interaction.editReply({ content: '❌ Aucun XP.' }); return; }
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🏆 Classement XP').setColor(0xFFD700).setDescription(top.map((u, i) => `${['🥇','🥈','🥉'][i]||`**${i+1}.**`} <@${u.userId}> — Niv.**${getLevelFromXP(u.xp)}** (${u.xp} XP)`).join('\n'))] });
    return;
  }

  // ── PREMIUM: captchasetup ──
  if (commandName === 'captchasetup') {
    if (!await requirePremium()) return;
    const role = options.getRole('role');
    const salon = options.getChannel('salon');
    await col('mod_configs').updateOne({ guildId }, { $set: { captchaEnabled: true, captchaRole: role.id, captchaChannel: salon.id } }, { upsert: true });
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🔐 Captcha configuré').setColor(0x57F287).addFields({ name: '🎭 Rôle', value: `<@&${role.id}>`, inline: true }, { name: '📍 Salon', value: `<#${salon.id}>`, inline: true })] });
    return;
  }

  // ── PREMIUM: lockdown ──
  if (commandName === 'lockdown') {
    if (!await requirePremium()) return;
    const action = options.getString('action');
    const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText && !c.isThread());
    if (action === 'on') {
      lockdownActive.set(guildId, true);
      let count = 0;
      for (const [, ch] of textChannels) {
        try {
          await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
          count++;
        } catch {}
      }
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🔒 Lockdown activé').setColor(0xED4245).setDescription(`${count} salons verrouillés. Personne ne peut écrire.`).setTimestamp()] });
    } else {
      lockdownActive.delete(guildId);
      let count = 0;
      for (const [, ch] of textChannels) {
        try {
          // Remove the SendMessages overwrite (reset to default)
          const existing = ch.permissionOverwrites.cache.get(guild.roles.everyone.id);
          if (existing) await existing.delete();
          count++;
        } catch {}
      }
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🔓 Lockdown désactivé').setColor(0x57F287).setDescription('Tous les salons sont déverrouillés.')] });
    }
    return;
  }

  // ── PREMIUM: welcomesetup ──
  if (commandName === 'welcomesetup') {
    if (!await requirePremium()) return;
    const salon = options.getChannel('salon');
    const actif = options.getBoolean('actif');
    const message = options.getString('message');
    await col('mod_configs').updateOne({ guildId }, { $set: { welcomeEnabled: actif, welcomeChannel: salon.id, welcomeMessage: message || null } }, { upsert: true });
    await interaction.editReply({ content: `✅ Messages de bienvenue ${actif ? 'activés' : 'désactivés'} dans <#${salon.id}>` });
    return;
  }

  // ── PREMIUM: leavesetup ──
  if (commandName === 'leavesetup') {
    if (!await requirePremium()) return;
    const salon = options.getChannel('salon');
    const actif = options.getBoolean('actif');
    const message = options.getString('message');
    await col('mod_configs').updateOne({ guildId }, { $set: { leaveEnabled: actif, leaveChannel: salon.id, leaveMessage: message || null } }, { upsert: true });
    await interaction.editReply({ content: `✅ Messages de départ ${actif ? 'activés' : 'désactivés'} dans <#${salon.id}>` });
    return;
  }

   // ── PREMIUM: resume ──
  if (commandName === 'resume') {
    if (!await requirePremium()) return;
    if (!GEMINI_API_KEY) { 
      await interaction.editReply({ content: '❌ Clé API Gemini non configurée. Ajoutez GEMINI_API_KEY dans les variables Render.' }); 
      return; 
    }
    
    if (!isAIAvailable()) {
      const timeLeft = Math.ceil((aiRateLimitMap.get('disabled_until') - Date.now()) / 60000);
      await interaction.editReply({ 
        content: `❌ L'IA est temporairement indisponible (quota dépassé). Réessayez dans ${timeLeft} minutes.` 
      });
      return;
    }
    
    const nombre = options.getInteger('nombre') || 50;
    const messages = await interaction.channel.messages.fetch({ limit: nombre });
    const text = messages.reverse().filter(m => !m.author.bot && m.content.length > 5).map(m => `${m.author.username}: ${m.content}`).join('\n');
    
    if (!text.trim() || text.length < 50) { 
      await interaction.editReply({ content: '❌ Pas assez de messages à résumer (minimum 50 caractères de texte).' }); 
      return; 
    }
    
    const resume = await callAI(
      `Voici une conversation Discord. Résume les points importants en français, de façon claire et structurée (maximum 600 mots). Mets en avant les sujets discutés, les décisions prises et les points importants.\n\n${text.slice(0, 8000)}`,
      'Tu es un assistant de modération Discord. Résume les conversations de façon concise et utile pour le staff.'
    );
    
    if (!resume) {
      await interaction.editReply({ content: '❌ Impossible de générer un résumé. Vérifiez que GEMINI_API_KEY est bien configurée dans Render ou réessayez plus tard (quota peut-être dépassé).' });
      return;
    }
    
    const desc = resume.length > 4000 ? resume.slice(0, 3997) + '...' : resume;
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`📋 Résumé — ${nombre} derniers messages`).setColor(0x5352ed).setDescription(desc).setTimestamp().setFooter({ text: `Généré par Gemini AI` })] });
    return;
  }

  // ── PREMIUM: faq ──
  if (commandName === 'faq') {
    if (!await requirePremium()) return;
    const question = options.getString('question');
    const reponse = options.getString('reponse');
    await col('faq').insertOne({ guildId, question, answer: reponse, createdBy: user.id, createdAt: new Date().toISOString() });
    await col('mod_configs').updateOne({ guildId }, { $set: { faqEnabled: true } }, { upsert: true });
    await interaction.editReply({ content: `✅ FAQ ajoutée ! Q: "${question}"` });
    return;
  }

  // ── PREMIUM: iastatus ──
if (commandName === 'iastatus') {
  if (!await requirePremium()) return;
  
  const available = isAIAvailable();
  const disabledUntil = aiRateLimitMap.get('disabled_until');
  const timeLeft = disabledUntil ? Math.max(0, Math.floor((disabledUntil - Date.now()) / 1000)) : 0;
  const recentRequests = (aiRateLimitMap.get('groq_requests') || []).filter(t => Date.now() - t < 60000).length;
  
  const embed = new EmbedBuilder()
    .setTitle('🤖 Statut IA (Groq)')
    .setColor(available ? 0x57F287 : 0xED4245)
    .addFields(
      { name: '📊 Status', value: available ? '✅ Disponible' : '❌ Indisponible', inline: true },
      { name: '🔑 API Key', value: GROQ_API_KEY ? '✅ Configurée' : '❌ Manquante', inline: true },
      { name: '📈 Requêtes/min', value: `${recentRequests}/30`, inline: true },
      { name: '🧠 Modèle', value: 'Llama 3.3 70B', inline: true }
    );
  
  if (!available && timeLeft > 0) {
    embed.addFields({ name: '⏰ Disponible dans', value: `${Math.ceil(timeLeft / 60)} minutes` });
  }
  
  await interaction.editReply({ embeds: [embed] });
  return;
}
  
  // ── PREMIUM: solde ──
  if (commandName === 'solde') {
    const target = options.getUser('membre') || user;
    const coins = await getCoins(guildId, target.id);
    const rank = await col('economy').countDocuments({ guildId, coins: { $gt: coins } }) + 1;
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`🪙 Solde — ${target.username}`).setColor(0xFFD700).addFields({ name: '💰 Coins', value: `**${coins}** 🪙`, inline: true }, { name: '🏅 Rang', value: `#${rank}`, inline: true })] });
    return;
  }

  // ── PREMIUM: classementcoins ──
  if (commandName === 'classementcoins') {
    if (!await requirePremium()) return;
    const top = await col('economy').find({ guildId }).sort({ coins: -1 }).limit(10).toArray();
    if (!top.length) { await interaction.editReply({ content: '❌ Aucune donnée.' }); return; }
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🏆 Classement Coins').setColor(0xFFD700).setDescription(top.map((u, i) => `${['🥇','🥈','🥉'][i]||`**${i+1}.**`} <@${u.userId}> — **${u.coins}** 🪙`).join('\n'))] });
    return;
  }

  // ── PREMIUM: donner ──
  if (commandName === 'donner') {
    if (!await requirePremium()) return;
    const target = options.getUser('membre');
    const montant = options.getInteger('montant');
    const success = await removeCoins(guildId, user.id, montant);
    if (!success) { await interaction.editReply({ content: '❌ Solde insuffisant !' }); return; }
    await addCoins(guildId, target.id, target.username, montant);
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('💸 Transfert effectué').setColor(0x57F287).addFields({ name: 'De', value: `<@${user.id}>`, inline: true }, { name: 'À', value: `<@${target.id}>`, inline: true }, { name: 'Montant', value: `**${montant}** 🪙`, inline: true })] });
    return;
  }

  // ── PREMIUM: shopsetup ──
  if (commandName === 'shopsetup') {
    if (!await requirePremium()) return;
    const sub = options.getSubcommand();
    if (sub === 'ajouter') {
      const nom = options.getString('nom');
      const prix = options.getInteger('prix');
      const type = options.getString('type');
      const role = options.getRole('role');
      const item = { id: uuidv4().slice(0, 8), guildId, nom, prix, type, roleId: role?.id || null, createdAt: new Date().toISOString() };
      await col('shop').insertOne(item);
      await interaction.editReply({ content: `✅ Article **${nom}** ajouté pour **${prix}** 🪙` });
    } else if (sub === 'supprimer') {
      const id = options.getString('id');
      await col('shop').deleteOne({ guildId, id });
      await interaction.editReply({ content: `✅ Article \`${id}\` supprimé.` });
    } else if (sub === 'liste') {
      const items = await col('shop').find({ guildId }).toArray();
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🏪 Articles de la boutique').setColor(0x5865F2).setDescription(items.length ? items.map(i => `\`${i.id}\` **${i.nom}** — ${i.prix} 🪙 (${i.type})`).join('\n') : 'Aucun article')] });
    }
    return;
  }

  // ── PREMIUM: shop ──
  if (commandName === 'shop') {
    if (!await requirePremium()) return;
    const items = await col('shop').find({ guildId }).toArray();
    if (!items.length) { await interaction.editReply({ content: '❌ La boutique est vide.' }); return; }
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🏪 Boutique').setColor(0xFFD700).setDescription(items.map(i => `**${i.nom}** — ${i.prix} 🪙\n> ID: \`${i.id}\` | Type: ${i.type}`).join('\n\n'))] });
    return;
  }

  // ── PREMIUM: acheter ──
  if (commandName === 'acheter') {
    if (!await requirePremium()) return;
    const id = options.getString('id');
    const item = await col('shop').findOne({ guildId, id });
    if (!item) { await interaction.editReply({ content: '❌ Article introuvable.' }); return; }
    const success = await removeCoins(guildId, user.id, item.prix);
    if (!success) { await interaction.editReply({ content: `❌ Solde insuffisant ! Tu as besoin de **${item.prix}** 🪙.` }); return; }

    if (item.type === 'role' && item.roleId) {
      await interaction.member.roles.add(item.roleId).catch(() => {});
    } else if (item.type === 'premium') {
      // Acheter une licence premium avec des coins — contacter le serveur de licences
      await interaction.editReply({ content: `✅ Achat de **${item.nom}** réussi ! Un admin va activer votre licence premium manuellement. Merci !` });
      return;
    }
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('✅ Achat réussi !').setColor(0x57F287).addFields({ name: '🛒 Article', value: item.nom, inline: true }, { name: '💰 Prix', value: `${item.prix} 🪙`, inline: true })] });
    return;
  }

  // ── PREMIUM: slots ──
  if (commandName === 'slots') {
    if (!await requirePremium()) return;
    const mise = options.getInteger('mise');
    const solde = await getCoins(guildId, user.id);
    if (solde < mise) { await interaction.editReply({ content: `❌ Solde insuffisant ! Tu as **${solde}** 🪙.` }); return; }
    await removeCoins(guildId, user.id, mise);
    const symboles = ['🍒', '🍋', '🍊', '🍇', '⭐', '💎', '7️⃣'];
    const s1 = symboles[Math.floor(Math.random() * symboles.length)];
    const s2 = symboles[Math.floor(Math.random() * symboles.length)];
    const s3 = symboles[Math.floor(Math.random() * symboles.length)];
    let gain = 0, msg = '';
    if (s1 === s2 && s2 === s3) {
      if (s1 === '💎') gain = mise * 10;
      else if (s1 === '7️⃣') gain = mise * 7;
      else gain = mise * 3;
      msg = `🎉 JACKPOT ! Vous gagnez **${gain}** 🪙 !`;
    } else if (s1 === s2 || s2 === s3 || s1 === s3) {
      gain = Math.floor(mise * 1.5);
      msg = `✨ Deux identiques ! Vous gagnez **${gain}** 🪙 !`;
    } else { msg = `😔 Perdu ! Vous perdez **${mise}** 🪙.`; }
    if (gain > 0) await addCoins(guildId, user.id, user.username, gain);
    const newSolde = await getCoins(guildId, user.id);
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🎰 Machine à sous').setColor(gain > 0 ? 0x57F287 : 0xED4245).setDescription(`## ${s1} | ${s2} | ${s3}\n\n${msg}`).addFields({ name: '💰 Nouveau solde', value: `${newSolde} 🪙` }).setTimestamp()] });
    return;
  }

  // ── PREMIUM: coinflip ──
  if (commandName === 'coinflip') {
    if (!await requirePremium()) return;
    const mise = options.getInteger('mise');
    const choix = options.getString('choix');
    const solde = await getCoins(guildId, user.id);
    if (solde < mise) { await interaction.editReply({ content: `❌ Solde insuffisant !` }); return; }
    await removeCoins(guildId, user.id, mise);
    const resultat = Math.random() < 0.5 ? 'pile' : 'face';
    const win = resultat === choix;
    if (win) await addCoins(guildId, user.id, user.username, mise * 2);
    const newSolde = await getCoins(guildId, user.id);
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🪙 Pile ou Face').setColor(win ? 0x57F287 : 0xED4245).setDescription(`Résultat: **${resultat === 'pile' ? '🪙 Pile' : '🦅 Face'}**\n\n${win ? `🎉 Gagné ! +${mise} 🪙` : `😔 Perdu ! -${mise} 🪙`}`).addFields({ name: '💰 Nouveau solde', value: `${newSolde} 🪙` })] });
    return;
  }

  // ── PREMIUM: blackjack ──
  if (commandName === 'blackjack') {
    if (!await requirePremium()) return;
    const mise = options.getInteger('mise');
    const solde = await getCoins(guildId, user.id);
    if (solde < mise) { await interaction.editReply({ content: '❌ Solde insuffisant !' }); return; }
    await removeCoins(guildId, user.id, mise);
    const deck = ['A','2','3','4','5','6','7','8','9','10','V','D','R'];
    const cardValue = c => c === 'A' ? 11 : ['V','D','R'].includes(c) ? 10 : parseInt(c);
    const handValue = hand => { let v = hand.reduce((s, c) => s + cardValue(c), 0); let aces = hand.filter(c => c === 'A').length; while (v > 21 && aces > 0) { v -= 10; aces--; } return v; };
    const draw = () => deck[Math.floor(Math.random() * deck.length)];
    const playerHand = [draw(), draw()];
    const dealerHand = [draw(), draw()];
    const bjSession = { playerHand, dealerHand, mise, userId: user.id, guildId, ended: false };
    const sessionId = uuidv4().slice(0, 8);
    await col('bj_sessions').insertOne({ ...bjSession, id: sessionId, createdAt: new Date().toISOString() });
    const embed = new EmbedBuilder().setTitle('🃏 Blackjack').setColor(0x2d3436)
      .addFields({ name: '👤 Vos cartes', value: `${playerHand.join(' ')} = **${handValue(playerHand)}**`, inline: true }, { name: '🤖 Dealer', value: `${dealerHand[0]} ?`, inline: true }, { name: '💰 Mise', value: `${mise} 🪙`, inline: true });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bj_hit_${sessionId}`).setLabel('🃏 Tirer').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`bj_stand_${sessionId}`).setLabel('✋ Rester').setStyle(ButtonStyle.Secondary)
    );
    if (handValue(playerHand) === 21) {
      await addCoins(guildId, user.id, user.username, Math.floor(mise * 2.5));
      embed.setDescription('🎉 **BLACKJACK !** Vous gagnez x2.5 !').setColor(0xFFD700);
      await interaction.editReply({ embeds: [embed] });
    } else {
      await interaction.editReply({ embeds: [embed], components: [row] });
    }
    return;
  }
}

// ─── Blackjack Button Handler ─────────────────────────────────────────────────
async function handleBlackjackButton(interaction) {
  const parts = interaction.customId.split('_');
  const action = parts[1]; // hit or stand
  const sessionId = parts[2];
  const session = await col('bj_sessions').findOne({ id: sessionId });
  if (!session || session.ended || session.userId !== interaction.user.id) {
    return interaction.reply({ content: '❌ Session invalide.', ephemeral: true });
  }
  const deck = ['A','2','3','4','5','6','7','8','9','10','V','D','R'];
  const cardValue = c => c === 'A' ? 11 : ['V','D','R'].includes(c) ? 10 : parseInt(c);
  const handValue = hand => { let v = hand.reduce((s, c) => s + cardValue(c), 0); let aces = hand.filter(c => c === 'A').length; while (v > 21 && aces > 0) { v -= 10; aces--; } return v; };
  const draw = () => deck[Math.floor(Math.random() * deck.length)];
  let { playerHand, dealerHand, mise } = session;

  if (action === 'hit') {
    playerHand.push(draw());
    const pv = handValue(playerHand);
    if (pv > 21) {
      await col('bj_sessions').updateOne({ id: sessionId }, { $set: { ended: true } });
      return interaction.update({ embeds: [new EmbedBuilder().setTitle('🃏 Blackjack — Perdu !').setColor(0xED4245).addFields({ name: '👤 Vos cartes', value: `${playerHand.join(' ')} = **${pv}**` }, { name: '💀 Bust !', value: `Vous perdez **${mise}** 🪙.` })], components: [] });
    }
    await col('bj_sessions').updateOne({ id: sessionId }, { $set: { playerHand } });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bj_hit_${sessionId}`).setLabel('🃏 Tirer').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`bj_stand_${sessionId}`).setLabel('✋ Rester').setStyle(ButtonStyle.Secondary)
    );
    return interaction.update({ embeds: [new EmbedBuilder().setTitle('🃏 Blackjack').setColor(0x2d3436).addFields({ name: '👤 Vos cartes', value: `${playerHand.join(' ')} = **${pv}**`, inline: true }, { name: '🤖 Dealer', value: `${dealerHand[0]} ?`, inline: true })], components: [row] });
  }

  if (action === 'stand') {
    while (handValue(dealerHand) < 17) dealerHand.push(draw());
    const pv = handValue(playerHand), dv = handValue(dealerHand);
    await col('bj_sessions').updateOne({ id: sessionId }, { $set: { ended: true } });
    let result, gain = 0, color;
    if (dv > 21 || pv > dv) { result = `🎉 Gagné ! +${mise} 🪙`; gain = mise * 2; color = 0x57F287; }
    else if (pv === dv) { result = `🤝 Égalité ! Mise remboursée.`; gain = mise; color = 0xFEE75C; }
    else { result = `😔 Perdu ! -${mise} 🪙`; color = 0xED4245; }
    if (gain > 0) await addCoins(session.guildId, session.userId, interaction.user.username, gain);
    const newSolde = await getCoins(session.guildId, session.userId);
    return interaction.update({ embeds: [new EmbedBuilder().setTitle('🃏 Blackjack — Résultat').setColor(color).addFields({ name: '👤 Vos cartes', value: `${playerHand.join(' ')} = **${pv}**`, inline: true }, { name: '🤖 Dealer', value: `${dealerHand.join(' ')} = **${dv}**`, inline: true }, { name: '📊 Résultat', value: result }, { name: '💰 Nouveau solde', value: `${newSolde} 🪙` })], components: [] });
  }
}

// ─── Express API ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token invalide' }); }
}

app.post('/api/auth/register', async (req, res) => {
  const { username, password, guildId } = req.body;
  if (!username || !password || !guildId) return res.status(400).json({ error: 'Champs manquants' });
  const existing = await col('mod_users').findOne({ guildId, username });
  if (existing) return res.status(409).json({ error: 'Utilisateur existant' });
  const count = await col('mod_users').countDocuments({ guildId });
  const hashedPwd = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username, password: hashedPwd, guildId, role: count === 0 ? 'superadmin' : 'staff', adminLevel: count === 0 ? 4 : 1, createdAt: new Date().toISOString() };
  await col('mod_users').insertOne(user);
  const token = jwt.sign({ id: user.id, username, guildId, role: user.role, adminLevel: user.adminLevel }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username, role: user.role, adminLevel: user.adminLevel } });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password, guildId } = req.body;
  const user = await col('mod_users').findOne({ guildId, username });
  if (!user || !await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Identifiants incorrects' });
  const token = jwt.sign({ id: user.id, username, guildId, role: user.role, adminLevel: user.adminLevel }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username, role: user.role, adminLevel: user.adminLevel } });
});

app.get('/api/cases', authMiddleware, async (req, res) => res.json(await col('mod_cases').find({ guildId: req.user.guildId }).sort({ createdAt: -1 }).toArray()));

app.post('/api/cases', authMiddleware, async (req, res) => {
  const { guildId, username } = req.user;
  const { targetId, targetTag, type, reason } = req.body;
  if (!targetId || !type) return res.status(400).json({ error: 'Champs manquants' });
  const sanction = await addSanction(guildId, targetId, targetTag || targetId, username, type, reason || 'Via panel');
  const guild = client.guilds.cache.get(guildId);
  if (guild) {
    await logAction(guild, sanction);
    try { const member = await guild.members.fetch(targetId).catch(() => null); if (member) { const config = await col('mod_configs').findOne({ guildId }) || {}; if (type === 'mute' && config.muteRole) await member.roles.add(config.muteRole).catch(() => {}); if (type === 'mute' && !config.muteRole) await member.timeout(3600000, reason).catch(() => {}); if (type === 'kick') await member.kick(reason || 'Via panel').catch(() => {}); if (type === 'ban') await member.ban({ reason: reason || 'Via panel' }).catch(() => {}); if (type === 'warn') await checkAutoSanctions(guild, member); } } catch {}
  }
  res.json(sanction);
});

app.get('/api/cases/user/:userId', authMiddleware, async (req, res) => res.json(await col('mod_cases').find({ guildId: req.user.guildId, targetId: req.params.userId }).toArray()));
app.delete('/api/cases/:id', authMiddleware, async (req, res) => { const result = await col('mod_cases').updateOne({ id: req.params.id, guildId: req.user.guildId }, { $set: { active: false } }); if (result.matchedCount === 0) return res.status(404).json({ error: 'Introuvable' }); res.json({ success: true }); });
app.get('/api/staff', authMiddleware, async (req, res) => res.json(await col('mod_staff').find({ guildId: req.user.guildId }).toArray()));
app.post('/api/staff', authMiddleware, async (req, res) => { if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Niveau insuffisant' }); const { guildId } = req.user; const { userId, tag, niveau } = req.body; const member = { userId, tag, niveau, guildId, addedBy: req.user.username, addedAt: new Date().toISOString() }; await col('mod_staff').updateOne({ guildId, userId }, { $set: member }, { upsert: true }); res.json(member); });
app.get('/api/tickets', authMiddleware, async (req, res) => res.json(await col('tickets').find({ guildId: req.user.guildId }).sort({ createdAt: -1 }).toArray()));
app.get('/api/xp', authMiddleware, async (req, res) => res.json(await col('xp_users').find({ guildId: req.user.guildId }).sort({ xp: -1 }).limit(50).toArray()));
app.get('/api/economy', authMiddleware, async (req, res) => res.json(await col('economy').find({ guildId: req.user.guildId }).sort({ coins: -1 }).limit(50).toArray()));
app.get('/api/shop', authMiddleware, async (req, res) => res.json(await col('shop').find({ guildId: req.user.guildId }).toArray()));
app.get('/api/users', authMiddleware, async (req, res) => { const users = await col('mod_users').find({ guildId: req.user.guildId }).toArray(); res.json(users.map(u => ({ id: u.id, username: u.username, role: u.role, adminLevel: u.adminLevel, createdAt: u.createdAt }))); });
app.patch('/api/users/:id/level', authMiddleware, async (req, res) => { if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Niveau insuffisant' }); await col('mod_users').updateOne({ id: req.params.id, guildId: req.user.guildId }, { $set: { adminLevel: req.body.adminLevel } }); res.json({ success: true }); });
app.get('/api/public/fiche/:guildId/:userId', async (req, res) => { const cases = await col('mod_cases').find({ guildId: req.params.guildId, targetId: req.params.userId }).toArray(); const counts = { warn: 0, mute: 0, kick: 0, ban: 0 }; cases.forEach(c => { if (counts[c.type] !== undefined) counts[c.type]++; }); res.json({ cases: cases.filter(c => c.type !== 'unban' && c.type !== 'unmute'), counts }); });
app.post('/api/config', authMiddleware, async (req, res) => { await col('mod_configs').updateOne({ guildId: req.user.guildId }, { $set: { guildId: req.user.guildId, ...req.body } }, { upsert: true }); res.json({ success: true }); });
app.get('/api/ticket-config', authMiddleware, async (req, res) => { const config = await col('mod_configs').findOne({ guildId: req.user.guildId }) || {}; res.json({ ticketTypes: config.ticketTypes || [], ticketWelcomeMessage: config.ticketWelcomeMessage || '', ticketDmMessage: config.ticketDmMessage || '' }); });
app.post('/api/ticket-config', authMiddleware, async (req, res) => { if (req.user.adminLevel < 3) return res.status(403).json({ error: 'Niveau insuffisant' }); const { ticketTypes, ticketWelcomeMessage, ticketDmMessage } = req.body; await col('mod_configs').updateOne({ guildId: req.user.guildId }, { $set: { ticketTypes, ticketWelcomeMessage, ticketDmMessage } }, { upsert: true }); res.json({ success: true }); });

// Shop price update (super admin only)
app.patch('/api/shop/:id', authMiddleware, async (req, res) => { if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Réservé aux Super Admins' }); await col('shop').updateOne({ id: req.params.id, guildId: req.user.guildId }, { $set: req.body }); res.json({ success: true }); });
app.delete('/api/shop/:id', authMiddleware, async (req, res) => { if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Réservé aux Super Admins' }); await col('shop').deleteOne({ id: req.params.id, guildId: req.user.guildId }); res.json({ success: true }); });

// Give coins (admin)
app.post('/api/economy/give', authMiddleware, async (req, res) => { if (req.user.adminLevel < 3) return res.status(403).json({ error: 'Niveau insuffisant' }); const { userId, amount } = req.body; await addCoins(req.user.guildId, userId, '', amount); res.json({ success: true }); });

app.get('/api/guild/:guildId', (req, res) => { const guild = client.guilds.cache.get(req.params.guildId); if (!guild) return res.status(404).json({ error: 'Serveur introuvable' }); res.json({ id: guild.id, name: guild.name, icon: guild.iconURL(), memberCount: guild.memberCount }); });

app.post('/api/send-credentials', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Niveau insuffisant' });
  const { userId, username, password, level, guildId, panelUrl } = req.body;
  const NAMES = { 1: 'Modérateur', 2: 'Senior Mod', 3: 'Admin', 4: 'Super Admin' };
  try {
    const discordUser = await client.users.fetch(userId);
    await discordUser.send({ embeds: [new EmbedBuilder().setTitle('🛡️ Accès au Panel').setColor(0x5865F2).addFields({ name: '👤 Identifiant', value: `\`${username}\``, inline: true }, { name: '🔑 Mot de passe', value: `\`${password}\``, inline: true }, { name: '🏅 Niveau', value: `${level} — ${NAMES[level] || 'Staff'}`, inline: true }, { name: '🔗 Panel', value: `${panelUrl}/?guild=${guildId}` }).setFooter({ text: '⚠️ Ne partagez pas vos identifiants.' }).setTimestamp()] });
    res.json({ success: true });
  } catch { res.status(400).json({ error: 'MP impossible (DMs fermés ?)' }); }
});

// Licence check endpoint (pour le panel)
app.get('/api/licence', authMiddleware, async (req, res) => {
  const lic = await checkLicence(req.user.guildId);
  res.json(lic);
});


// ─── Premium Config (Welcome/Leave/FAQ) ──────────────────────────────────────
app.get('/api/premium-config', authMiddleware, async (req, res) => {
  const config = await col('mod_configs').findOne({ guildId: req.user.guildId }) || {};
  res.json({
    welcomeEnabled: config.welcomeEnabled || false,
    welcomeChannel: config.welcomeChannel || '',
    welcomeMessage: config.welcomeMessage || '',
    welcomeMessages: config.welcomeMessages || [],
    leaveEnabled: config.leaveEnabled || false,
    leaveChannel: config.leaveChannel || '',
    leaveMessage: config.leaveMessage || '',
    captchaEnabled: config.captchaEnabled || false,
    captchaChannel: config.captchaChannel || '',
    captchaRole: config.captchaRole || '',
    aiModeration: config.aiModeration || false,
    faqEnabled: config.faqEnabled || false,
  });
});

app.post('/api/premium-config', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 3) return res.status(403).json({ error: 'Niveau insuffisant' });
  const { guildId } = req.user;
  const { welcomeEnabled, welcomeChannel, welcomeMessage, welcomeMessages, leaveEnabled, leaveChannel, leaveMessage, captchaEnabled, captchaChannel, captchaRole, aiModeration, faqEnabled } = req.body;
  await col('mod_configs').updateOne({ guildId }, { $set: { welcomeEnabled, welcomeChannel, welcomeMessage, welcomeMessages, leaveEnabled, leaveChannel, leaveMessage, captchaEnabled, captchaChannel, captchaRole, aiModeration, faqEnabled } }, { upsert: true });
  res.json({ success: true });
});

// ─── Bot Identity (PREMIUM) ───────────────────────────────────────────────────
app.post('/api/bot-identity', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Niveau insuffisant' });
  const { guildId } = req.user;
  const { nickname, avatarUrl, bio } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Serveur introuvable' });
    const me = guild.members.me || await guild.members.fetch(client.user.id);
    if (nickname !== undefined) await me.setNickname(nickname || null).catch(() => {});
    if (avatarUrl) {
      await client.user.setAvatar(avatarUrl).catch(() => {});
    }
    if (bio !== undefined) {
      await client.user.edit({ bio: bio || '' }).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── FAQ Management ───────────────────────────────────────────────────────────
app.get('/api/faq', authMiddleware, async (req, res) => {
  res.json(await col('faq').find({ guildId: req.user.guildId }).toArray());
});
app.post('/api/faq', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 3) return res.status(403).json({ error: 'Niveau insuffisant' });
  const { question, answer } = req.body;
  const item = { id: require('uuid').v4().slice(0, 8), guildId: req.user.guildId, question, answer, createdBy: req.user.username, createdAt: new Date().toISOString() };
  await col('faq').insertOne(item);
  await col('mod_configs').updateOne({ guildId: req.user.guildId }, { $set: { faqEnabled: true } }, { upsert: true });
  res.json(item);
});
app.delete('/api/faq/:id', authMiddleware, async (req, res) => {
  await col('faq').deleteOne({ id: req.params.id, guildId: req.user.guildId });
  res.json({ success: true });
});

// ─── Economy Admin ────────────────────────────────────────────────────────────
app.post('/api/economy/give', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 3) return res.status(403).json({ error: 'Niveau insuffisant' });
  const { userId, amount } = req.body;
  await addCoins(req.user.guildId, userId, '', parseInt(amount));
  res.json({ success: true });
});
app.post('/api/economy/remove', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 3) return res.status(403).json({ error: 'Niveau insuffisant' });
  const { userId, amount } = req.body;
  const ok = await removeCoins(req.user.guildId, userId, parseInt(amount));
  res.json({ success: ok, error: ok ? null : 'Solde insuffisant' });
});

// ─── Shop Management ──────────────────────────────────────────────────────────
app.post('/api/shop', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Réservé aux Super Admins' });
  const { nom, prix, type, roleId, description } = req.body;
  const item = { id: require('uuid').v4().slice(0, 8), guildId: req.user.guildId, nom, prix: parseInt(prix), type, roleId: roleId || null, description: description || '', createdAt: new Date().toISOString() };
  await col('shop').insertOne(item);
  res.json(item);
});
app.patch('/api/shop/:id', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Réservé aux Super Admins' });
  await col('shop').updateOne({ id: req.params.id, guildId: req.user.guildId }, { $set: req.body });
  res.json({ success: true });
});
app.delete('/api/shop/:id', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Réservé aux Super Admins' });
  await col('shop').deleteOne({ id: req.params.id, guildId: req.user.guildId });
  res.json({ success: true });
});

// ─── Licence status ───────────────────────────────────────────────────────────
app.get('/api/licence', authMiddleware, async (req, res) => {
  const lic = await checkLicence(req.user.guildId);
  res.json(lic);
});

// ─── Nickname history ─────────────────────────────────────────────────────────
app.get('/api/nickname-history/:userId', authMiddleware, async (req, res) => {
  res.json(await col('nickname_history').find({ guildId: req.user.guildId, userId: req.params.userId }).sort({ changedAt: -1 }).limit(20).toArray());
});

// ─── Catch-all → index.html ───────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await connectDB();
  app.listen(PORT, () => console.log(`🌐 Panel: http://localhost:${PORT}`));
  client.login(BOT_TOKEN);
}
start();
