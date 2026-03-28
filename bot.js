const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, REST, Routes, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, AttachmentBuilder } = require('discord.js');
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
const PANEL_URL = process.env.PANEL_URL || 'http://localhost:3000';
const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || 'YOUR_MONGODB_URL';

// ─── MongoDB ──────────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  db = client.db('modbot');
  console.log('✅ MongoDB connecté !');
}
function col(name) { return db.collection(name); }

// ─── Niveaux d'admin ──────────────────────────────────────────────────────────
const ADMIN_LEVELS = {
  1: { name: 'Modérateur', color: 0x57F287, perms: ['warn', 'mute'] },
  2: { name: 'Senior Mod', color: 0xFEE75C, perms: ['warn', 'mute', 'kick'] },
  3: { name: 'Admin', color: 0xED4245, perms: ['warn', 'mute', 'kick', 'ban', 'unban', 'unmute', 'clearwarn'] },
  4: { name: 'Super Admin', color: 0x5865F2, perms: ['warn', 'mute', 'kick', 'ban', 'unban', 'unmute', 'clearwarn', 'manage_staff'] }
};

const AUTO_SANCTIONS = [
  { warns: 3, action: 'mute', duration: 3600000, reason: 'Sanctions automatiques: 3 avertissements' },
  { warns: 5, action: 'kick', reason: 'Sanctions automatiques: 5 avertissements' },
  { warns: 7, action: 'ban', reason: 'Sanctions automatiques: 7 avertissements' }
];

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
  ]
});

// ─── Anti-spam storage (en mémoire) ──────────────────────────────────────────
const spamMap = new Map(); // userId -> { count, lastMessage, timestamps }

// ─── Helper: Log action modération ───────────────────────────────────────────
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
    )
    .setTimestamp()
    .setFooter({ text: `ID: ${action.id}` });
  if (action.duration) embed.addFields({ name: '⏱️ Durée', value: formatDuration(action.duration), inline: true });
  await channel.send({ embeds: [embed] });
}

// ─── Helper: Log événement serveur ───────────────────────────────────────────
async function logEvent(guild, embed) {
  const config = await col('mod_configs').findOne({ guildId: guild.id }) || {};
  const channelId = config.eventLogChannel || config.logChannel;
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;
  await channel.send({ embeds: [embed] }).catch(() => {});
}

function formatDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}min`;
  if (s < 86400) return `${Math.floor(s/3600)}h`;
  return `${Math.floor(s/86400)}j`;
}

// ─── Helper: Add sanction ─────────────────────────────────────────────────────
async function addSanction(guildId, targetId, targetTag, modId, type, reason, duration = null) {
  const count = await col('mod_cases').countDocuments({ guildId });
  const sanction = {
    id: uuidv4().slice(0, 8),
    caseNumber: count + 1,
    guildId, type, targetId, targetTag, modId,
    reason: reason || 'Aucune raison',
    duration, createdAt: new Date().toISOString(), active: true
  };
  await col('mod_cases').insertOne(sanction);
  return sanction;
}

// ─── Helper: Check auto sanctions ────────────────────────────────────────────
async function checkAutoSanctions(guild, member) {
  const activeWarns = await col('mod_cases').countDocuments({ guildId: guild.id, targetId: member.id, type: 'warn', active: true });
  for (const rule of AUTO_SANCTIONS) {
    if (activeWarns === rule.warns) {
      if (rule.action === 'mute') {
        const config = await col('mod_configs').findOne({ guildId: guild.id }) || {};
        if (config.muteRole) {
          await member.roles.add(config.muteRole).catch(() => {});
          const sanction = await addSanction(guild.id, member.id, member.user.tag, client.user.id, 'mute', rule.reason, rule.duration);
          await logAction(guild, { ...sanction, ...rule });
        }
      } else if (rule.action === 'kick') {
        await member.kick(rule.reason).catch(() => {});
        const sanction = await addSanction(guild.id, member.id, member.user.tag, client.user.id, 'kick', rule.reason);
        await logAction(guild, sanction);
      } else if (rule.action === 'ban') {
        await member.ban({ reason: rule.reason }).catch(() => {});
        const sanction = await addSanction(guild.id, member.id, member.user.tag, client.user.id, 'ban', rule.reason);
        await logAction(guild, sanction);
      }
      return { triggered: true, action: rule.action, warns: rule.warns };
    }
  }
  return { triggered: false };
}

// ─── XP System ───────────────────────────────────────────────────────────────
const XP_COOLDOWN = 60000; // 1 minute entre chaque gain XP
const xpCooldowns = new Map();

function getXPForLevel(level) { return 100 * level * level; }
function getLevelFromXP(xp) {
  let level = 0;
  while (xp >= getXPForLevel(level + 1)) level++;
  return level;
}

async function addXP(guildId, userId, username) {
  const now = Date.now();
  const key = `${guildId}-${userId}`;
  if (xpCooldowns.has(key) && now - xpCooldowns.get(key) < XP_COOLDOWN) return null;
  xpCooldowns.set(key, now);

  const xpGain = Math.floor(Math.random() * 15) + 5; // 5-20 XP
  const user = await col('xp_users').findOne({ guildId, userId }) || { guildId, userId, username, xp: 0, level: 0 };
  const oldLevel = user.level || getLevelFromXP(user.xp || 0);
  const newXP = (user.xp || 0) + xpGain;
  const newLevel = getLevelFromXP(newXP);

  await col('xp_users').updateOne({ guildId, userId }, { $set: { guildId, userId, username, xp: newXP, level: newLevel, lastUpdated: new Date().toISOString() } }, { upsert: true });

  if (newLevel > oldLevel) return { levelUp: true, newLevel, oldLevel };
  return { levelUp: false };
}

// ─── Anti-spam ────────────────────────────────────────────────────────────────
async function checkSpam(message) {
  const config = await col('mod_configs').findOne({ guildId: message.guild.id }) || {};
  if (!config.antiSpam) return false;

  // Exclure les bots, admins, modos, et staff Discord
  const member = message.member;
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return false;
  if (member.permissions.has(PermissionFlagsBits.ModerateMembers)) return false;

  // Exclure les membres du staff enregistrés dans la DB
  const staffEntry = await col('mod_staff').findOne({ guildId: message.guild.id, userId: message.author.id });
  if (staffEntry) return false;

  const userId = message.author.id;
  const now = Date.now();
  const userData = spamMap.get(userId) || { timestamps: [], warned: false };

  userData.timestamps = userData.timestamps.filter(t => now - t < 5000);
  userData.timestamps.push(now);
  spamMap.set(userId, userData);

  // Détection liens non autorisés
  const linkRegex = /(https?:\/\/|discord\.gg\/|discord\.com\/invite\/)/gi;
  if (config.antiLinks && linkRegex.test(message.content)) {
    await message.delete().catch(() => {});
    return 'link';
  }

  // Détection mentions abusives
  if (message.mentions.users.size >= 5) {
    await message.delete().catch(() => {});
    return 'mentions';
  }

  // Détection spam (5 messages en 5s)
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

// ─── Slash Commands ───────────────────────────────────────────────────────────
const commands = [
  // Modération
  new SlashCommandBuilder().setName('warn').setDescription('Avertir un membre')
    .addUserOption(o => o.setName('membre').setDescription('Membre à avertir').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false))
    .addStringOption(o => o.setName('mention').setDescription('Message à envoyer au membre').setRequired(false)),

  new SlashCommandBuilder().setName('mute').setDescription('Rendre muet un membre')
    .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true))
    .addStringOption(o => o.setName('duree').setDescription('Durée (ex: 1h, 30min, 1j)').setRequired(false))
    .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false))
    .addStringOption(o => o.setName('mention').setDescription('Message au membre').setRequired(false)),

  new SlashCommandBuilder().setName('unmute').setDescription('Retirer le mute')
    .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true)),

  new SlashCommandBuilder().setName('kick').setDescription('Expulser un membre')
    .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false))
    .addStringOption(o => o.setName('mention').setDescription('Message au membre').setRequired(false)),

  new SlashCommandBuilder().setName('ban').setDescription('Bannir un membre')
    .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false))
    .addStringOption(o => o.setName('mention').setDescription('Message au membre').setRequired(false)),

  new SlashCommandBuilder().setName('unban').setDescription('Débannir un membre')
    .addStringOption(o => o.setName('userid').setDescription('ID du membre').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false)),

  new SlashCommandBuilder().setName('casier').setDescription('Voir le casier judiciaire')
    .addUserOption(o => o.setName('membre').setDescription('Membre (laisser vide = vous)').setRequired(false)),

  new SlashCommandBuilder().setName('mafiche').setDescription('Voir votre propre fiche'),

  new SlashCommandBuilder().setName('clearwarn').setDescription('Effacer des avertissements')
    .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true))
    .addStringOption(o => o.setName('id').setDescription('ID du warn (laisser vide = tout effacer)').setRequired(false)),

  // Config
  new SlashCommandBuilder().setName('modsetup').setDescription('Configurer le bot de modération')
    .addChannelOption(o => o.setName('logs').setDescription('Canal des logs modération').setRequired(true))
    .addChannelOption(o => o.setName('eventlogs').setDescription('Canal des logs événements').setRequired(false))
    .addRoleOption(o => o.setName('mute_role').setDescription('Rôle mute').setRequired(false))
    .addBooleanOption(o => o.setName('antispam').setDescription('Activer l\'anti-spam').setRequired(false))
    .addBooleanOption(o => o.setName('antilinks').setDescription('Bloquer les liens').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('modpanel').setDescription('Lien vers le panel de modération'),

  // Staff
  new SlashCommandBuilder().setName('staffadd').setDescription('Ajouter un membre au staff')
    .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true))
    .addIntegerOption(o => o.setName('niveau').setDescription('Niveau (1-4)').setRequired(true).setMinValue(1).setMaxValue(4))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('staffliste').setDescription('Voir la liste du staff'),

  // Tickets
  new SlashCommandBuilder().setName('ticket').setDescription('Ouvrir un ticket de support'),

  new SlashCommandBuilder().setName('ticketsetup').setDescription('Configurer le système de tickets')
    .addChannelOption(o => o.setName('category').setDescription('Catégorie pour les tickets').setRequired(true))
    .addRoleOption(o => o.setName('staff_role').setDescription('Rôle du staff pour les tickets').setRequired(true))
    .addChannelOption(o => o.setName('logs').setDescription('Canal des logs tickets').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('ticketpanel').setDescription('Envoyer le panel de tickets dans un salon')
    .addChannelOption(o => o.setName('salon').setDescription('Salon où envoyer le panel').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('fermerticket').setDescription('Fermer le ticket actuel'),

  // XP
  new SlashCommandBuilder().setName('niveau').setDescription('Voir votre niveau XP')
    .addUserOption(o => o.setName('membre').setDescription('Membre (laisser vide = vous)').setRequired(false)),

  new SlashCommandBuilder().setName('classement').setDescription('Voir le classement XP du serveur'),

  new SlashCommandBuilder().setName('xpsetup').setDescription('Configurer le système XP')
    .addBooleanOption(o => o.setName('actif').setDescription('Activer/désactiver l\'XP').setRequired(true))
    .addChannelOption(o => o.setName('levelup_channel').setDescription('Canal pour les annonces de level up').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// ─── Register commands ────────────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Commandes enregistrées !');
  } catch (e) { console.error('❌', e); }
}

function parseDuration(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(s|min|h|j)$/);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = { s: 1000, min: 60000, h: 3600000, j: 86400000 }[match[2]];
  return val * unit;
}

// ─── Ticket: Créer un ticket ──────────────────────────────────────────────────
async function createTicket(guild, user, config) {
  const ticketNumber = (await col('tickets').countDocuments({ guildId: guild.id })) + 1;
  const channelName = `ticket-${ticketNumber.toString().padStart(4, '0')}`;

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: config.ticketCategory,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: config.ticketStaffRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
    ]
  });

  const ticket = {
    id: uuidv4().slice(0, 8),
    number: ticketNumber,
    guildId: guild.id,
    userId: user.id,
    userTag: user.tag,
    channelId: channel.id,
    status: 'open',
    createdAt: new Date().toISOString()
  };
  await col('tickets').insertOne(ticket);

  const embed = new EmbedBuilder()
    .setTitle(`🎫 Ticket #${ticketNumber.toString().padStart(4, '0')}`)
    .setColor(0x5865F2)
    .setDescription(`Bonjour <@${user.id}> !\nNotre équipe va vous répondre dès que possible.\n\nPour fermer ce ticket, cliquez sur le bouton ci-dessous.`)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`close_ticket_${ticket.id}`).setLabel('🔒 Fermer le ticket').setStyle(ButtonStyle.Danger)
  );

  await channel.send({ content: `<@${user.id}> <@&${config.ticketStaffRole}>`, embeds: [embed], components: [row] });
  return { channel, ticket };
}

// ─── Ticket: Fermer un ticket ─────────────────────────────────────────────────
async function closeTicket(guild, channel, closedBy, ticketId) {
  const ticket = await col('tickets').findOne({ id: ticketId, guildId: guild.id });
  if (!ticket || ticket.status === 'closed') return;

  // Générer transcription
  const messages = await channel.messages.fetch({ limit: 100 });
  const transcript = messages.reverse().map(m => `[${new Date(m.createdTimestamp).toLocaleString('fr-FR')}] ${m.author.tag}: ${m.content}`).join('\n');
  const transcriptBuffer = Buffer.from(transcript, 'utf-8');
  const attachment = new AttachmentBuilder(transcriptBuffer, { name: `ticket-${ticket.number}-transcript.txt` });

  await col('tickets').updateOne({ id: ticketId }, { $set: { status: 'closed', closedBy: closedBy.id, closedAt: new Date().toISOString() } });

  // Log
  const config = await col('mod_configs').findOne({ guildId: guild.id }) || {};
  if (config.ticketLogChannel) {
    const logChannel = guild.channels.cache.get(config.ticketLogChannel);
    if (logChannel) {
      const logEmbed = new EmbedBuilder()
        .setTitle(`🔒 Ticket #${ticket.number.toString().padStart(4, '0')} fermé`)
        .setColor(0xED4245)
        .addFields(
          { name: '👤 Ouvert par', value: `<@${ticket.userId}>`, inline: true },
          { name: '🔒 Fermé par', value: `<@${closedBy.id}>`, inline: true },
          { name: '📅 Durée', value: formatDuration(Date.now() - new Date(ticket.createdAt).getTime()), inline: true }
        )
        .setTimestamp();
      await logChannel.send({ embeds: [logEmbed], files: [attachment] });
    }
  }

  // DM à l'auteur
  const ticketUser = await guild.members.fetch(ticket.userId).catch(() => null);
  if (ticketUser) {
    const dmEmbed = new EmbedBuilder()
      .setTitle(`🔒 Votre ticket a été fermé — ${guild.name}`)
      .setColor(0xED4245)
      .setDescription(`Votre ticket #${ticket.number.toString().padStart(4, '0')} a été fermé.\nMerci d'avoir contacté le support !`);
    await ticketUser.user.send({ embeds: [dmEmbed], files: [attachment] }).catch(() => {});
  }

  await channel.delete().catch(() => {});
}

// ─── Bot Events ───────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`🤖 ${client.user.tag} connecté !`);
  await registerCommands();
});

// ─── Membre rejoint ───────────────────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  const embed = new EmbedBuilder()
    .setTitle('👋 Nouveau membre')
    .setColor(0x57F287)
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: '👤 Membre', value: `<@${member.id}> (${member.user.tag})`, inline: true },
      { name: '📅 Compte créé', value: `<t:${Math.floor(member.user.createdTimestamp/1000)}:R>`, inline: true },
      { name: '👥 Membres', value: `${member.guild.memberCount}`, inline: true }
    )
    .setTimestamp();
  await logEvent(member.guild, embed);
});

// ─── Membre part ──────────────────────────────────────────────────────────────
client.on('guildMemberRemove', async member => {
  const embed = new EmbedBuilder()
    .setTitle('🚪 Membre parti')
    .setColor(0xED4245)
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: '👤 Membre', value: `${member.user.tag}`, inline: true },
      { name: '📅 Arrivé', value: member.joinedAt ? `<t:${Math.floor(member.joinedTimestamp/1000)}:R>` : 'Inconnu', inline: true },
      { name: '👥 Membres', value: `${member.guild.memberCount}`, inline: true }
    )
    .setTimestamp();
  await logEvent(member.guild, embed);
});

// ─── Message supprimé ─────────────────────────────────────────────────────────
client.on('messageDelete', async message => {
  if (!message.guild || message.author?.bot) return;
  const embed = new EmbedBuilder()
    .setTitle('🗑️ Message supprimé')
    .setColor(0xED4245)
    .addFields(
      { name: '👤 Auteur', value: `<@${message.author?.id}> (${message.author?.tag})`, inline: true },
      { name: '📍 Salon', value: `<#${message.channel.id}>`, inline: true },
      { name: '💬 Message', value: message.content?.slice(0, 1024) || '*Contenu inconnu*', inline: false }
    )
    .setTimestamp();
  await logEvent(message.guild, embed);
});

// ─── Message modifié ──────────────────────────────────────────────────────────
client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot) return;
  if (oldMessage.content === newMessage.content) return;
  const embed = new EmbedBuilder()
    .setTitle('✏️ Message modifié')
    .setColor(0xFEE75C)
    .addFields(
      { name: '👤 Auteur', value: `<@${newMessage.author?.id}>`, inline: true },
      { name: '📍 Salon', value: `<#${newMessage.channel.id}>`, inline: true },
      { name: '📝 Avant', value: oldMessage.content?.slice(0, 512) || '*Inconnu*', inline: false },
      { name: '📝 Après', value: newMessage.content?.slice(0, 512) || '*Inconnu*', inline: false }
    )
    .setTimestamp();
  await logEvent(newMessage.guild, embed);
});

// ─── Vocal join/leave ─────────────────────────────────────────────────────────
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!newState.guild) return;
  let embed;
  if (!oldState.channel && newState.channel) {
    embed = new EmbedBuilder().setTitle('🎤 Rejoint un vocal').setColor(0x57F287)
      .addFields({ name: '👤 Membre', value: `<@${newState.member.id}>`, inline: true }, { name: '🔊 Salon', value: newState.channel.name, inline: true }).setTimestamp();
  } else if (oldState.channel && !newState.channel) {
    embed = new EmbedBuilder().setTitle('🔇 Quitté un vocal').setColor(0xED4245)
      .addFields({ name: '👤 Membre', value: `<@${oldState.member.id}>`, inline: true }, { name: '🔊 Salon', value: oldState.channel.name, inline: true }).setTimestamp();
  } else if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
    embed = new EmbedBuilder().setTitle('🔄 Changement de vocal').setColor(0xFEE75C)
      .addFields({ name: '👤 Membre', value: `<@${newState.member.id}>`, inline: true }, { name: '⬅️ Avant', value: oldState.channel.name, inline: true }, { name: '➡️ Après', value: newState.channel.name, inline: true }).setTimestamp();
  }
  if (embed) await logEvent(newState.guild, embed);
});

// ─── Messages: XP + Anti-spam ─────────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;

  // Anti-spam
  const spamType = await checkSpam(message);
  if (spamType) {
    const spamMessages = {
      spam: '🚫 Stop le spam !',
      link: '🚫 Les liens ne sont pas autorisés !',
      mentions: '🚫 Trop de mentions !'
    };
    const warn = await message.channel.send({ content: `<@${message.author.id}> ${spamMessages[spamType]}` });
    setTimeout(() => warn.delete().catch(() => {}), 5000);

    // Auto-warn
    const guild = message.guild;
    const sanction = await addSanction(guild.id, message.author.id, message.author.tag, client.user.id, 'warn', `Auto-mod: ${spamType}`);
    await logAction(guild, sanction);
    await checkAutoSanctions(guild, message.member);
    return;
  }

  // XP
  const config = await col('mod_configs').findOne({ guildId: message.guild.id }) || {};
  if (config.xpEnabled) {
    const result = await addXP(message.guild.id, message.author.id, message.author.username);
    if (result?.levelUp) {
      const levelUpChannelId = config.levelUpChannel;
      const channel = levelUpChannelId ? message.guild.channels.cache.get(levelUpChannelId) : message.channel;
      if (channel) {
        const embed = new EmbedBuilder()
          .setTitle('🎉 Level Up !')
          .setColor(0xFFD700)
          .setDescription(`Félicitations <@${message.author.id}> ! Tu es passé au niveau **${result.newLevel}** ! 🚀`)
          .setThumbnail(message.author.displayAvatarURL())
          .setTimestamp();
        await channel.send({ embeds: [embed] });
      }
    }
  }
});

// ─── Interactions ─────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  // Bouton fermeture ticket
  if (interaction.isButton() && interaction.customId.startsWith('close_ticket_')) {
    const ticketId = interaction.customId.replace('close_ticket_', '');
    await interaction.reply({ content: '🔒 Fermeture du ticket...', ephemeral: true });
    await closeTicket(interaction.guild, interaction.channel, interaction.user, ticketId);
    return;
  }

  // Bouton ouvrir ticket depuis panel
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    const config = await col('mod_configs').findOne({ guildId: interaction.guild.id }) || {};
    if (!config.ticketCategory || !config.ticketStaffRole) {
      return interaction.reply({ content: '❌ Le système de tickets n\'est pas configuré. Utilisez `/ticketsetup`', ephemeral: true });
    }
    const existingTicket = await col('tickets').findOne({ guildId: interaction.guild.id, userId: interaction.user.id, status: 'open' });
    if (existingTicket) {
      return interaction.reply({ content: `❌ Vous avez déjà un ticket ouvert : <#${existingTicket.channelId}>`, ephemeral: true });
    }
    await interaction.reply({ content: '🎫 Création de votre ticket...', ephemeral: true });
    const { channel } = await createTicket(interaction.guild, interaction.user, config);
    await interaction.editReply({ content: `✅ Votre ticket a été créé : <#${channel.id}>` });
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    const ephemeralCmds = ['modsetup', 'modpanel', 'mafiche', 'clearwarn', 'ticketsetup', 'xpsetup', 'fermerticket'];
    const isEphemeral = ephemeralCmds.includes(interaction.commandName);
    await interaction.deferReply({ ephemeral: isEphemeral });
    await handleCommand(interaction);
  } catch (err) {
    console.error(err);
    const msg = { content: '❌ Une erreur est survenue.' };
    if (interaction.replied || interaction.deferred) await interaction.editReply(msg);
  }
});

// ─── Command Handler ──────────────────────────────────────────────────────────
async function handleCommand(interaction) {
  const { commandName, options, guildId, user, guild, member } = interaction;

  // ── modsetup ──
  if (commandName === 'modsetup') {
    const logsChannel = options.getChannel('logs');
    const eventLogsChannel = options.getChannel('eventlogs');
    const muteRole = options.getRole('mute_role');
    const antiSpam = options.getBoolean('antispam');
    const antiLinks = options.getBoolean('antilinks');

    await col('mod_configs').updateOne({ guildId }, { $set: {
      guildId, logChannel: logsChannel.id,
      eventLogChannel: eventLogsChannel?.id || logsChannel.id,
      muteRole: muteRole?.id || null,
      antiSpam: antiSpam ?? false,
      antiLinks: antiLinks ?? false,
      setupBy: user.id, setupAt: new Date().toISOString()
    }}, { upsert: true });

    const embed = new EmbedBuilder()
      .setTitle('⚙️ Modération configurée')
      .setColor(0x57F287)
      .addFields(
        { name: '📋 Logs mod', value: `<#${logsChannel.id}>`, inline: true },
        { name: '📋 Logs événements', value: eventLogsChannel ? `<#${eventLogsChannel.id}>` : `<#${logsChannel.id}>`, inline: true },
        { name: '🔇 Rôle mute', value: muteRole ? `<@&${muteRole.id}>` : 'Non défini', inline: true },
        { name: '🛡️ Anti-spam', value: antiSpam ? '✅ Activé' : '❌ Désactivé', inline: true },
        { name: '🔗 Anti-liens', value: antiLinks ? '✅ Activé' : '❌ Désactivé', inline: true }
      );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── modpanel ──
  if (commandName === 'modpanel') {
    const embed = new EmbedBuilder()
      .setTitle('🛡️ Panel de Modération')
      .setColor(0x5865F2)
      .setDescription(`🔗 **[Ouvrir le panel](${PANEL_URL}/?guild=${guildId})**`)
      .addFields({ name: '🔑 Accès', value: 'Connectez-vous avec votre compte staff.' });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── staffadd ──
  if (commandName === 'staffadd') {
    const target = options.getUser('membre');
    const niveau = options.getInteger('niveau');
    const staffMember = { userId: target.id, tag: target.tag, niveau, addedBy: user.id, addedAt: new Date().toISOString() };
    await col('mod_staff').updateOne({ guildId, userId: target.id }, { $set: { guildId, ...staffMember } }, { upsert: true });
    const embed = new EmbedBuilder()
      .setTitle('👥 Staff mis à jour')
      .setColor(ADMIN_LEVELS[niveau].color)
      .addFields(
        { name: '👤 Membre', value: `<@${target.id}>`, inline: true },
        { name: '🏅 Niveau', value: `${niveau} — ${ADMIN_LEVELS[niveau].name}`, inline: true }
      );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── staffliste ──
  if (commandName === 'staffliste') {
    const guildStaff = await col('mod_staff').find({ guildId }).sort({ niveau: -1 }).toArray();
    if (!guildStaff.length) { await interaction.editReply({ content: '❌ Aucun staff configuré.' }); return; }
    const embed = new EmbedBuilder()
      .setTitle('👥 Liste du Staff')
      .setColor(0x5865F2)
      .setDescription(guildStaff.map(s => `**[Niv.${s.niveau}] ${ADMIN_LEVELS[s.niveau].name}** — <@${s.userId}>`).join('\n'));
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── warn ──
  if (commandName === 'warn') {
    const target = options.getMember('membre');
    const raison = options.getString('raison') || 'Aucune raison';
    const mention = options.getString('mention');
    const sanction = await addSanction(guildId, target.id, target.user.tag, user.id, 'warn', raison);
    await logAction(guild, sanction);
    try {
      const dmEmbed = new EmbedBuilder().setTitle(`⚠️ Avertissement — ${guild.name}`).setColor(0xFEE75C)
        .addFields({ name: '📝 Raison', value: raison }, { name: '🛡️ Modérateur', value: user.tag });
      if (mention) dmEmbed.addFields({ name: '💬 Message', value: mention });
      await target.user.send({ embeds: [dmEmbed] }).catch(() => {});
    } catch {}
    const auto = await checkAutoSanctions(guild, target);
    const embed = new EmbedBuilder().setTitle('⚠️ Avertissement').setColor(0xFEE75C)
      .addFields(
        { name: '👤 Membre', value: `<@${target.id}>`, inline: true },
        { name: '📝 Raison', value: raison, inline: true },
        { name: '🆔 Case', value: `#${sanction.caseNumber}`, inline: true }
      );
    if (auto.triggered) embed.addFields({ name: '🤖 Sanction auto', value: `${auto.warns} warns → ${auto.action}` });
    if (mention) embed.addFields({ name: '💬 Message envoyé', value: mention });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── mute ──
  if (commandName === 'mute') {
    const target = options.getMember('membre');
    const dureeStr = options.getString('duree');
    const raison = options.getString('raison') || 'Aucune raison';
    const mention = options.getString('mention');
    const duration = parseDuration(dureeStr);
    const config = await col('mod_configs').findOne({ guildId }) || {};
    if (config.muteRole) { await target.roles.add(config.muteRole).catch(() => {}); }
    else { await target.timeout(duration || 3600000, raison).catch(() => {}); }
    const sanction = await addSanction(guildId, target.id, target.user.tag, user.id, 'mute', raison, duration);
    await logAction(guild, sanction);
    if (mention) { try { const dmEmbed = new EmbedBuilder().setTitle(`🔇 Mute — ${guild.name}`).setColor(0xEB459E).addFields({ name: '💬 Message', value: mention }, { name: '📝 Raison', value: raison }); await target.user.send({ embeds: [dmEmbed] }).catch(() => {}); } catch {} }
    if (duration) { setTimeout(async () => { if (config.muteRole) { const m = await guild.members.fetch(target.id).catch(() => null); if (m) await m.roles.remove(config.muteRole).catch(() => {}); } await col('mod_cases').updateOne({ id: sanction.id }, { $set: { active: false } }); }, duration); }
    const embed = new EmbedBuilder().setTitle('🔇 Mute').setColor(0xEB459E)
      .addFields({ name: '👤 Membre', value: `<@${target.id}>`, inline: true }, { name: '⏱️ Durée', value: duration ? formatDuration(duration) : 'Indéfini', inline: true }, { name: '📝 Raison', value: raison });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── unmute ──
  if (commandName === 'unmute') {
    const target = options.getMember('membre');
    const config = await col('mod_configs').findOne({ guildId }) || {};
    if (config.muteRole) await target.roles.remove(config.muteRole).catch(() => {});
    await target.timeout(null).catch(() => {});
    await col('mod_cases').updateMany({ guildId, targetId: target.id, type: 'mute' }, { $set: { active: false } });
    const sanction = await addSanction(guildId, target.id, target.user.tag, user.id, 'unmute', 'Unmute manuel');
    await logAction(guild, sanction);
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🔊 Unmute').setColor(0x57F287).setDescription(`<@${target.id}> a été unmute.`)] });
    return;
  }

  // ── kick ──
  if (commandName === 'kick') {
    const target = options.getMember('membre');
    const raison = options.getString('raison') || 'Aucune raison';
    const mention = options.getString('mention');
    if (mention) { try { const dmEmbed = new EmbedBuilder().setTitle(`👢 Kick — ${guild.name}`).setColor(0xED4245).addFields({ name: '📝 Raison', value: raison }, { name: '💬 Message', value: mention }); await target.user.send({ embeds: [dmEmbed] }).catch(() => {}); } catch {} }
    await target.kick(raison);
    const sanction = await addSanction(guildId, target.id, target.user.tag, user.id, 'kick', raison);
    await logAction(guild, sanction);
    const embed = new EmbedBuilder().setTitle('👢 Kick').setColor(0xED4245).addFields({ name: '👤 Membre', value: `${target.user.tag}`, inline: true }, { name: '📝 Raison', value: raison, inline: true });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── ban ──
  if (commandName === 'ban') {
    const target = options.getMember('membre');
    const raison = options.getString('raison') || 'Aucune raison';
    const mention = options.getString('mention');
    if (mention) { try { const dmEmbed = new EmbedBuilder().setTitle(`🔨 Ban — ${guild.name}`).setColor(0x000000).addFields({ name: '📝 Raison', value: raison }, { name: '💬 Message', value: mention }); await target.user.send({ embeds: [dmEmbed] }).catch(() => {}); } catch {} }
    await target.ban({ reason: raison });
    const sanction = await addSanction(guildId, target.id, target.user.tag, user.id, 'ban', raison);
    await logAction(guild, sanction);
    const embed = new EmbedBuilder().setTitle('🔨 Ban').setColor(0x000000).addFields({ name: '👤 Membre', value: `${target.user.tag}`, inline: true }, { name: '📝 Raison', value: raison, inline: true });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── unban ──
  if (commandName === 'unban') {
    const userId = options.getString('userid');
    const raison = options.getString('raison') || 'Aucune raison';
    await guild.members.unban(userId, raison).catch(() => {});
    const sanction = await addSanction(guildId, userId, userId, user.id, 'unban', raison);
    await logAction(guild, sanction);
    await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('✅ Unban').setColor(0x57F287).setDescription(`\`${userId}\` a été débanni.`)] });
    return;
  }

  // ── casier ──
  if (commandName === 'casier') {
    const target = options.getUser('membre') || user;
    const userCases = await col('mod_cases').find({ guildId, targetId: target.id }).sort({ createdAt: -1 }).toArray();
    const counts = { warn: 0, mute: 0, kick: 0, ban: 0 };
    userCases.forEach(c => { if (counts[c.type] !== undefined) counts[c.type]++; });
    const embed = new EmbedBuilder().setTitle(`📋 Casier — ${target.tag}`).setColor(0x5865F2).setThumbnail(target.displayAvatarURL())
      .addFields({ name: '⚠️ Warns', value: `${counts.warn}`, inline: true }, { name: '🔇 Mutes', value: `${counts.mute}`, inline: true }, { name: '👢 Kicks', value: `${counts.kick}`, inline: true }, { name: '🔨 Bans', value: `${counts.ban}`, inline: true }, { name: '📊 Total', value: `${userCases.length} sanction(s)`, inline: true });
    const recent = userCases.slice(0, 5);
    if (recent.length) {
      const icons = { warn: '⚠️', mute: '🔇', kick: '👢', ban: '🔨', unban: '✅', unmute: '🔊' };
      embed.addFields({ name: '📜 Historique récent', value: recent.map(c => `${icons[c.type]} **#${c.caseNumber}** ${c.type.toUpperCase()} — ${c.reason} <t:${Math.floor(new Date(c.createdAt).getTime()/1000)}:R>`).join('\n') });
    }
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Voir le panel').setStyle(ButtonStyle.Link).setURL(`${PANEL_URL}/?guild=${guildId}&user=${target.id}`));
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  // ── mafiche ──
  if (commandName === 'mafiche') {
    const userCases = await col('mod_cases').find({ guildId, targetId: user.id }).toArray();
    const counts = { warn: 0, mute: 0, kick: 0, ban: 0 };
    userCases.forEach(c => { if (counts[c.type] !== undefined) counts[c.type]++; });
    const embed = new EmbedBuilder().setTitle(`📋 Votre Fiche — ${guild.name}`).setColor(0x5865F2).setThumbnail(user.displayAvatarURL())
      .addFields({ name: '⚠️ Avertissements', value: `${counts.warn}`, inline: true }, { name: '🔇 Mutes', value: `${counts.mute}`, inline: true }, { name: '👢 Kicks', value: `${counts.kick}`, inline: true }, { name: '🔨 Bans', value: `${counts.ban}`, inline: true });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Voir ma fiche complète').setStyle(ButtonStyle.Link).setURL(`${PANEL_URL}/fiche?guild=${guildId}&user=${user.id}`));
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  // ── clearwarn ──
  if (commandName === 'clearwarn') {
    const target = options.getUser('membre');
    const warnId = options.getString('id');
    if (warnId) { await col('mod_cases').updateOne({ id: warnId, targetId: target.id, type: 'warn' }, { $set: { active: false } }); await interaction.editReply({ content: `✅ Warn \`${warnId}\` effacé.` }); }
    else { await col('mod_cases').updateMany({ guildId, targetId: target.id, type: 'warn' }, { $set: { active: false } }); await interaction.editReply({ content: `✅ Tous les warns de <@${target.id}> ont été effacés.` }); }
    return;
  }

  // ── ticketsetup ──
  if (commandName === 'ticketsetup') {
    const category = options.getChannel('category');
    const staffRole = options.getRole('staff_role');
    const logsChannel = options.getChannel('logs');
    await col('mod_configs').updateOne({ guildId }, { $set: { ticketCategory: category.id, ticketStaffRole: staffRole.id, ticketLogChannel: logsChannel?.id || null } }, { upsert: true });
    const embed = new EmbedBuilder().setTitle('🎫 Tickets configurés').setColor(0x57F287)
      .addFields({ name: '📁 Catégorie', value: category.name, inline: true }, { name: '👥 Rôle staff', value: `<@&${staffRole.id}>`, inline: true }, { name: '📋 Logs', value: logsChannel ? `<#${logsChannel.id}>` : 'Non défini', inline: true });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── ticketpanel ──
  if (commandName === 'ticketpanel') {
    const salon = options.getChannel('salon');
    const embed = new EmbedBuilder().setTitle('🎫 Support').setColor(0x5865F2)
      .setDescription('Besoin d\'aide ? Ouvre un ticket en cliquant sur le bouton ci-dessous.\nNotre équipe répondra dès que possible !');
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('🎫 Ouvrir un ticket').setStyle(ButtonStyle.Primary));
    await salon.send({ embeds: [embed], components: [row] });
    await interaction.editReply({ content: `✅ Panel envoyé dans <#${salon.id}>` });
    return;
  }

  // ── ticket ──
  if (commandName === 'ticket') {
    const config = await col('mod_configs').findOne({ guildId }) || {};
    if (!config.ticketCategory || !config.ticketStaffRole) { await interaction.editReply({ content: '❌ Le système de tickets n\'est pas configuré. Utilisez `/ticketsetup`' }); return; }
    const existingTicket = await col('tickets').findOne({ guildId, userId: user.id, status: 'open' });
    if (existingTicket) { await interaction.editReply({ content: `❌ Vous avez déjà un ticket ouvert : <#${existingTicket.channelId}>` }); return; }
    const { channel } = await createTicket(guild, user, config);
    await interaction.editReply({ content: `✅ Votre ticket a été créé : <#${channel.id}>` });
    return;
  }

  // ── fermerticket ──
  if (commandName === 'fermerticket') {
    const ticket = await col('tickets').findOne({ guildId, channelId: interaction.channel.id, status: 'open' });
    if (!ticket) { await interaction.editReply({ content: '❌ Ce salon n\'est pas un ticket ouvert.' }); return; }
    await interaction.editReply({ content: '🔒 Fermeture du ticket...' });
    await closeTicket(guild, interaction.channel, user, ticket.id);
    return;
  }

  // ── xpsetup ──
  if (commandName === 'xpsetup') {
    const actif = options.getBoolean('actif');
    const levelUpChannel = options.getChannel('levelup_channel');
    await col('mod_configs').updateOne({ guildId }, { $set: { xpEnabled: actif, levelUpChannel: levelUpChannel?.id || null } }, { upsert: true });
    const embed = new EmbedBuilder().setTitle('⭐ XP configuré').setColor(0xFFD700)
      .addFields({ name: 'Système XP', value: actif ? '✅ Activé' : '❌ Désactivé', inline: true }, { name: 'Canal level up', value: levelUpChannel ? `<#${levelUpChannel.id}>` : 'Salon actuel', inline: true });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── niveau ──
  if (commandName === 'niveau') {
    const target = options.getUser('membre') || user;
    const xpData = await col('xp_users').findOne({ guildId, userId: target.id });
    if (!xpData) { await interaction.editReply({ content: `❌ <@${target.id}> n'a pas encore d'XP.` }); return; }
    const level = getLevelFromXP(xpData.xp);
    const currentLevelXP = getXPForLevel(level);
    const nextLevelXP = getXPForLevel(level + 1);
    const progress = Math.floor(((xpData.xp - currentLevelXP) / (nextLevelXP - currentLevelXP)) * 20);
    const progressBar = '█'.repeat(progress) + '░'.repeat(20 - progress);

    // Classement
    const rank = await col('xp_users').countDocuments({ guildId, xp: { $gt: xpData.xp } }) + 1;

    const embed = new EmbedBuilder().setTitle(`⭐ Niveau — ${target.username}`).setColor(0xFFD700).setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: '🏆 Niveau', value: `${level}`, inline: true },
        { name: '⭐ XP Total', value: `${xpData.xp}`, inline: true },
        { name: '🏅 Classement', value: `#${rank}`, inline: true },
        { name: `📊 Progression vers le niveau ${level + 1}`, value: `\`${progressBar}\` ${xpData.xp - currentLevelXP}/${nextLevelXP - currentLevelXP} XP` }
      );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── classement ──
  if (commandName === 'classement') {
    const top = await col('xp_users').find({ guildId }).sort({ xp: -1 }).limit(10).toArray();
    if (!top.length) { await interaction.editReply({ content: '❌ Aucun membre n\'a d\'XP pour l\'instant.' }); return; }
    const medals = ['🥇', '🥈', '🥉'];
    const embed = new EmbedBuilder().setTitle('🏆 Classement XP').setColor(0xFFD700)
      .setDescription(top.map((u, i) => `${medals[i] || `**${i+1}.**`} <@${u.userId}> — Niv. **${getLevelFromXP(u.xp)}** (${u.xp} XP)`).join('\n'));
    await interaction.editReply({ embeds: [embed] });
    return;
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

app.get('/api/cases', authMiddleware, async (req, res) => {
  const { guildId } = req.user;
  res.json(await col('mod_cases').find({ guildId }).sort({ createdAt: -1 }).toArray());
});

app.post('/api/cases', authMiddleware, async (req, res) => {
  const { guildId, username } = req.user;
  const { targetId, targetTag, type, reason } = req.body;
  if (!targetId || !type) return res.status(400).json({ error: 'Champs manquants' });
  const sanction = await addSanction(guildId, targetId, targetTag || targetId, username, type, reason || 'Sanction via panel');
  const guild = client.guilds.cache.get(guildId);
  if (guild) {
    await logAction(guild, sanction);
    try {
      const member = await guild.members.fetch(targetId).catch(() => null);
      if (member) {
        const config = await col('mod_configs').findOne({ guildId }) || {};
        if (type === 'mute' && config.muteRole) await member.roles.add(config.muteRole).catch(() => {});
        if (type === 'mute' && !config.muteRole) await member.timeout(3600000, reason).catch(() => {});
        if (type === 'kick') await member.kick(reason || 'Sanction via panel').catch(() => {});
        if (type === 'ban') await member.ban({ reason: reason || 'Sanction via panel' }).catch(() => {});
        if (type === 'warn') await checkAutoSanctions(guild, member);
      }
    } catch {}
  }
  res.json(sanction);
});

app.get('/api/cases/user/:userId', authMiddleware, async (req, res) => {
  const { guildId } = req.user;
  res.json(await col('mod_cases').find({ guildId, targetId: req.params.userId }).toArray());
});

app.delete('/api/cases/:id', authMiddleware, async (req, res) => {
  const { guildId } = req.user;
  const result = await col('mod_cases').updateOne({ id: req.params.id, guildId }, { $set: { active: false } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Case introuvable' });
  res.json({ success: true });
});

app.get('/api/staff', authMiddleware, async (req, res) => {
  res.json(await col('mod_staff').find({ guildId: req.user.guildId }).toArray());
});

app.post('/api/staff', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Niveau insuffisant' });
  const { guildId } = req.user;
  const { userId, tag, niveau } = req.body;
  const member = { userId, tag, niveau, guildId, addedBy: req.user.username, addedAt: new Date().toISOString() };
  await col('mod_staff').updateOne({ guildId, userId }, { $set: member }, { upsert: true });
  res.json(member);
});

app.get('/api/tickets', authMiddleware, async (req, res) => {
  res.json(await col('tickets').find({ guildId: req.user.guildId }).sort({ createdAt: -1 }).toArray());
});

app.get('/api/xp', authMiddleware, async (req, res) => {
  res.json(await col('xp_users').find({ guildId: req.user.guildId }).sort({ xp: -1 }).limit(50).toArray());
});

app.get('/api/users', authMiddleware, async (req, res) => {
  const users = await col('mod_users').find({ guildId: req.user.guildId }).toArray();
  res.json(users.map(u => ({ id: u.id, username: u.username, role: u.role, adminLevel: u.adminLevel, createdAt: u.createdAt })));
});

app.patch('/api/users/:id/level', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Niveau insuffisant' });
  await col('mod_users').updateOne({ id: req.params.id, guildId: req.user.guildId }, { $set: { adminLevel: req.body.adminLevel } });
  res.json({ success: true });
});

app.get('/api/public/fiche/:guildId/:userId', async (req, res) => {
  const userCases = await col('mod_cases').find({ guildId: req.params.guildId, targetId: req.params.userId }).toArray();
  const counts = { warn: 0, mute: 0, kick: 0, ban: 0 };
  userCases.forEach(c => { if (counts[c.type] !== undefined) counts[c.type]++; });
  res.json({ cases: userCases.filter(c => c.type !== 'unban' && c.type !== 'unmute'), counts });
});

app.post('/api/config', authMiddleware, async (req, res) => {
  await col('mod_configs').updateOne({ guildId: req.user.guildId }, { $set: { guildId: req.user.guildId, ...req.body } }, { upsert: true });
  res.json({ success: true });
});

app.get('/api/guild/:guildId', (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: 'Serveur introuvable' });
  res.json({ id: guild.id, name: guild.name, icon: guild.iconURL(), memberCount: guild.memberCount });
});

// ─── Envoyer identifiants en MP ───────────────────────────────────────────────
app.post('/api/send-credentials', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Niveau insuffisant' });
  const { userId, username, password, level, guildId, panelUrl } = req.body;
  const ADMIN_LEVELS_NAMES = { 1: 'Modérateur', 2: 'Senior Mod', 3: 'Admin', 4: 'Super Admin' };
  try {
    const user = await client.users.fetch(userId);
    const embed = new EmbedBuilder()
      .setTitle('🛡️ Accès au Panel de Modération')
      .setColor(0x5865F2)
      .setDescription('Un accès au panel de modération a été créé pour vous.')
      .addFields(
        { name: '👤 Nom d\'utilisateur', value: `\`${username}\``, inline: true },
        { name: '🔑 Mot de passe', value: `\`${password}\``, inline: true },
        { name: '🏅 Niveau', value: `${level} — ${ADMIN_LEVELS_NAMES[level] || 'Staff'}`, inline: true },
        { name: '🔗 Lien du panel', value: `${panelUrl}/?guild=${guildId}` }
      )
      .setFooter({ text: '⚠️ Ne partagez jamais vos identifiants.' })
      .setTimestamp();
    await user.send({ embeds: [embed] });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: 'Impossible d\'envoyer le MP (DMs fermés ?)' });
  }
});

// ─── Catch-all → index.html (pour /fiche, /panel etc.) ───────────────────────
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
