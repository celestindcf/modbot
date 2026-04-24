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
const selfbotMap = new Map();
const joinMap = new Map();
const captchaMap = new Map();
const xpCooldowns = new Map();
const coinCooldowns = new Map();
const aiRateLimitMap = new Map();
const faqCache = new Map();
const suspiciousActions = new Map(); // Anti-Nuke

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

// ─── PREMIUM: IA (Groq API) ───────────────────────────────────────────────────
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

function isAIAvailable() {
  const disabledUntil = aiRateLimitMap.get('disabled_until');
  if (disabledUntil && Date.now() < disabledUntil) return false;
  return true;
}

async function callAI(prompt, systemPrompt = '') {
  if (!GROQ_API_KEY) { console.log('[IA] GROQ_API_KEY non configurée'); return null; }
  if (!isAIAvailable()) { console.log('[IA] IA temporairement désactivée (quota)'); return null; }
  
  const now = Date.now();
  const rateKey = 'groq_requests';
  const requests = aiRateLimitMap.get(rateKey) || [];
  const recentRequests = requests.filter(t => now - t < 60000);
  if (recentRequests.length >= 30) { console.log('[IA] Rate limit local Groq atteint'); return null; }
  recentRequests.push(now);
  aiRateLimitMap.set(rateKey, recentRequests);
  
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'system', content: systemPrompt || 'Tu es un assistant de modération Discord.' }, { role: 'user', content: prompt }], max_tokens: 500, temperature: 0.3 })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[IA] Erreur Groq:', res.status, JSON.stringify(err));
      if (res.status === 429) { console.log('[IA] Quota Groq dépassé, désactivation 5 minutes'); aiRateLimitMap.set('disabled_until', now + 300000); }
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) { console.error('[IA] Exception callAI:', e.message); return null; }
}

async function checkAIModeration(message, config) {
  if (!config.aiModeration || !GROQ_API_KEY || !isAIAvailable() || message.content.length < 20) return false;
  try {
    const response = await callAI(`Analyse ce message Discord et dis si c'est du harcèlement, une insulte déguisée, du contenu toxique ou de la discrimination. Réponds UNIQUEMENT par OUI ou NON.\n\nMessage: "${message.content.slice(0, 200)}"`);
    return response ? response.trim().toUpperCase().startsWith('OUI') : false;
  } catch { return false; }
}

// ─── PREMIUM: Captcha ─────────────────────────────────────────────────────────
function generateCaptchaCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── PREMIUM: Welcome messages ─────────────────────────────────────────────────
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
  await channel.delete().catch(() => {});
}

// ─── Slash Commands ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('warn').setDescription('Avertir un membre').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)).addStringOption(o=>o.setName('raison').setDescription('Raison')).addStringOption(o=>o.setName('mention').setDescription('Message au membre')),
  new SlashCommandBuilder().setName('mute').setDescription('Muter un membre').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)).addStringOption(o=>o.setName('duree').setDescription('Durée (1h, 30min...)')).addStringOption(o=>o.setName('raison').setDescription('Raison')).addStringOption(o=>o.setName('mention').setDescription('Message au membre')),
  new SlashCommandBuilder().setName('unmute').setDescription('Démuter un membre').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)),
  new SlashCommandBuilder().setName('kick').setDescription('Expulser un membre').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)).addStringOption(o=>o.setName('raison').setDescription('Raison')).addStringOption(o=>o.setName('mention').setDescription('Message au membre')),
  new SlashCommandBuilder().setName('ban').setDescription('Bannir un membre').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)).addStringOption(o=>o.setName('raison').setDescription('Raison')).addStringOption(o=>o.setName('mention').setDescription('Message au membre')),
  new SlashCommandBuilder().setName('unban').setDescription('Débannir').addStringOption(o=>o.setName('userid').setDescription('ID Discord').setRequired(true)).addStringOption(o=>o.setName('raison').setDescription('Raison')),
  new SlashCommandBuilder().setName('casier').setDescription('Casier judiciaire').addUserOption(o=>o.setName('membre').setDescription('Membre')),
  new SlashCommandBuilder().setName('mafiche').setDescription('Votre fiche'),
  new SlashCommandBuilder().setName('clearwarn').setDescription('Effacer warns').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)).addStringOption(o=>o.setName('id').setDescription('ID warn')),
  new SlashCommandBuilder().setName('modsetup').setDescription('Configurer le bot').addChannelOption(o=>o.setName('logs').setDescription('Canal logs mod').setRequired(true)).addChannelOption(o=>o.setName('eventlogs').setDescription('Canal logs événements')).addRoleOption(o=>o.setName('mute_role').setDescription('Rôle mute')).addBooleanOption(o=>o.setName('antispam').setDescription('Anti-spam')).addBooleanOption(o=>o.setName('antilinks').setDescription('Anti-liens')).addBooleanOption(o=>o.setName('ai_moderation').setDescription('[PREMIUM] Modération IA')).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('modpanel').setDescription('Lien du panel'),
  new SlashCommandBuilder().setName('staffadd').setDescription('Ajouter un staff').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)).addIntegerOption(o=>o.setName('niveau').setDescription('Niveau 1-4').setRequired(true).setMinValue(1).setMaxValue(4)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('staffliste').setDescription('Liste du staff'),
  new SlashCommandBuilder().setName('ticket').setDescription('Ouvrir un ticket'),
  new SlashCommandBuilder().setName('ticketsetup').setDescription('Configurer tickets').addChannelOption(o=>o.setName('category').setDescription('Catégorie').setRequired(true)).addRoleOption(o=>o.setName('staff_role').setDescription('Rôle staff').setRequired(true)).addChannelOption(o=>o.setName('logs').setDescription('Canal logs')).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('ticketpanel').setDescription('Envoyer panel tickets').addChannelOption(o=>o.setName('salon').setDescription('Salon').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('fermerticket').setDescription('Fermer ce ticket'),
  new SlashCommandBuilder().setName('niveau').setDescription('Voir niveau XP').addUserOption(o=>o.setName('membre').setDescription('Membre')),
  new SlashCommandBuilder().setName('classement').setDescription('Classement XP'),
  new SlashCommandBuilder().setName('xpsetup').setDescription('Config XP').addBooleanOption(o=>o.setName('actif').setDescription('Activer').setRequired(true)).addChannelOption(o=>o.setName('levelup_channel').setDescription('Canal level up')).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('captchasetup').setDescription('[PREMIUM] Configurer le captcha').addRoleOption(o=>o.setName('role').setDescription('Rôle donné après vérification').setRequired(true)).addChannelOption(o=>o.setName('salon').setDescription('Salon de vérification').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('lockdown').setDescription('[PREMIUM] Verrouiller/déverrouiller les salons').addStringOption(o=>o.setName('action').setDescription('on/off').setRequired(true).addChoices({name:'🔒 Activer',value:'on'},{name:'🔓 Désactiver',value:'off'})).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('welcomesetup').setDescription('[PREMIUM] Configurer les messages de bienvenue').addChannelOption(o=>o.setName('salon').setDescription('Salon bienvenue').setRequired(true)).addBooleanOption(o=>o.setName('actif').setDescription('Activer').setRequired(true)).addStringOption(o=>o.setName('message').setDescription('Message custom')).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('leavesetup').setDescription('[PREMIUM] Configurer les messages de départ').addChannelOption(o=>o.setName('salon').setDescription('Salon départ').setRequired(true)).addBooleanOption(o=>o.setName('actif').setDescription('Activer').setRequired(true)).addStringOption(o=>o.setName('message').setDescription('Message custom')).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('resume').setDescription('[PREMIUM] Résumer les derniers messages').addIntegerOption(o=>o.setName('nombre').setDescription('Nombre de messages (max 100)').setMinValue(10).setMaxValue(100)),
  new SlashCommandBuilder().setName('faq').setDescription('[PREMIUM] Configurer la FAQ').addStringOption(o=>o.setName('question').setDescription('Question').setRequired(true)).addStringOption(o=>o.setName('reponse').setDescription('Réponse').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('iastatus').setDescription('[PREMIUM] Vérifier le statut de l\'IA'),
  new SlashCommandBuilder().setName('solde').setDescription('Voir votre solde de coins').addUserOption(o=>o.setName('membre').setDescription('Membre')),
  new SlashCommandBuilder().setName('classementcoins').setDescription('[PREMIUM] Classement des coins'),
  new SlashCommandBuilder().setName('shop').setDescription('[PREMIUM] Boutique du serveur'),
  new SlashCommandBuilder().setName('acheter').setDescription('[PREMIUM] Acheter un article').addStringOption(o=>o.setName('id').setDescription('ID de l\'article').setRequired(true)),
  new SlashCommandBuilder().setName('donner').setDescription('[PREMIUM] Donner des coins').addUserOption(o=>o.setName('membre').setDescription('Membre').setRequired(true)).addIntegerOption(o=>o.setName('montant').setDescription('Montant').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('shopsetup').setDescription('[PREMIUM] Gérer la boutique').addSubcommand(s=>s.setName('ajouter').setDescription('Ajouter un article').addStringOption(o=>o.setName('nom').setDescription('Nom').setRequired(true)).addIntegerOption(o=>o.setName('prix').setDescription('Prix en coins').setRequired(true).setMinValue(1)).addStringOption(o=>o.setName('type').setDescription('Type').setRequired(true).addChoices({name:'Rôle',value:'role'},{name:'Licence Premium',value:'premium'})).addRoleOption(o=>o.setName('role').setDescription('Rôle à donner (si type=rôle)'))).addSubcommand(s=>s.setName('supprimer').setDescription('Supprimer un article').addStringOption(o=>o.setName('id').setDescription('ID article').setRequired(true))).addSubcommand(s=>s.setName('liste').setDescription('Voir les articles')).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
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
  for (const [, guild] of client.guilds.cache) {
    await sendActivity
