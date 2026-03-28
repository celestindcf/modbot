const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, REST, Routes, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');

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
// 1 = Modérateur, 2 = Senior Mod, 3 = Admin, 4 = Super Admin
const ADMIN_LEVELS = {
  1: { name: 'Modérateur', color: 0x57F287, perms: ['warn', 'mute'] },
  2: { name: 'Senior Mod', color: 0xFEE75C, perms: ['warn', 'mute', 'kick'] },
  3: { name: 'Admin', color: 0xED4245, perms: ['warn', 'mute', 'kick', 'ban', 'unban', 'unmute', 'clearwarn'] },
  4: { name: 'Super Admin', color: 0x5865F2, perms: ['warn', 'mute', 'kick', 'ban', 'unban', 'unmute', 'clearwarn', 'manage_staff'] }
};

// Sanctions auto: 3 warns = mute, 5 warns = kick, 7 warns = ban
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
  ]
});

// ─── Helper: Log action ───────────────────────────────────────────────────────
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

// ─── Slash Commands ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Avertir un membre')
    .addUserOption(o => o.setName('membre').setDescription('Membre à avertir').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false))
    .addStringOption(o => o.setName('mention').setDescription('Message à envoyer au membre').setRequired(false)),

  new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Rendre muet un membre')
    .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true))
    .addStringOption(o => o.setName('duree').setDescription('Durée (ex: 1h, 30min, 1j)').setRequired(false))
    .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false))
    .addStringOption(o => o.setName('mention').setDescription('Message au membre').setRequired(false)),

  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Retirer le mute')
    .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true)),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Expulser un membre')
    .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false))
    .addStringOption(o => o.setName('mention').setDescription('Message au membre').setRequired(false)),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Bannir un membre')
    .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false))
    .addStringOption(o => o.setName('mention').setDescription('Message au membre').setRequired(false)),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Débannir un membre')
    .addStringOption(o => o.setName('userid').setDescription('ID du membre').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false)),

  new SlashCommandBuilder()
    .setName('casier')
    .setDescription('Voir le casier judiciaire')
    .addUserOption(o => o.setName('membre').setDescription('Membre (laisser vide = vous)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('mafiche')
    .setDescription('Voir votre propre fiche'),

  new SlashCommandBuilder()
    .setName('clearwarn')
    .setDescription('Effacer des avertissements')
    .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true))
    .addStringOption(o => o.setName('id').setDescription('ID du warn (laisser vide = tout effacer)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('modsetup')
    .setDescription('Configurer le bot de modération')
    .addChannelOption(o => o.setName('logs').setDescription('Canal des logs').setRequired(true))
    .addRoleOption(o => o.setName('mute_role').setDescription('Rôle mute').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('modpanel')
    .setDescription('Lien vers le panel de modération'),

  new SlashCommandBuilder()
    .setName('staffadd')
    .setDescription('Ajouter un membre au staff')
    .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true))
    .addIntegerOption(o => o.setName('niveau').setDescription('Niveau (1-4)').setRequired(true).setMinValue(1).setMaxValue(4))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('staffliste')
    .setDescription('Voir la liste du staff'),
];

// ─── Register commands ────────────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Commandes enregistrées !');
  } catch (e) { console.error('❌', e); }
}

// ─── Parse duration ───────────────────────────────────────────────────────────
function parseDuration(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(s|min|h|j)$/);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = { s: 1000, min: 60000, h: 3600000, j: 86400000 }[match[2]];
  return val * unit;
}

// ─── Bot Events ───────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`🤖 ${client.user.tag} connecté !`);
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    // Commandes éphémères
    const ephemeralCmds = ['modsetup', 'modpanel', 'mafiche', 'clearwarn'];
    const isEphemeral = ephemeralCmds.includes(interaction.commandName);
    await interaction.deferReply({ ephemeral: isEphemeral });
    await handleCommand(interaction);
  } catch (err) {
    console.error(err);
    const msg = { content: '❌ Une erreur est survenue.' };
    if (interaction.replied || interaction.deferred) await interaction.editReply(msg);
    else await interaction.editReply({ ...msg});
  }
});

// ─── Command Handler ──────────────────────────────────────────────────────────
async function handleCommand(interaction) {
  const { commandName, options, guildId, user, guild, member } = interaction;

  // ── modsetup ──
  if (commandName === 'modsetup') {
    const logsChannel = options.getChannel('logs');
    const muteRole = options.getRole('mute_role');
    await col('mod_configs').updateOne({ guildId }, { $set: {
      guildId, logChannel: logsChannel.id,
      muteRole: muteRole?.id || null,
      setupBy: user.id, setupAt: new Date().toISOString()
    }}, { upsert: true });

    const embed = new EmbedBuilder()
      .setTitle('⚙️ Modération configurée')
      .setColor(0x57F287)
      .addFields(
        { name: '📋 Canal logs', value: `<#${logsChannel.id}>`, inline: true },
        { name: '🔇 Rôle mute', value: muteRole ? `<@&${muteRole.id}>` : 'Non défini', inline: true }
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
    await interaction.editReply({ embeds: [embed]});
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
    if (!guildStaff.length) {
      await interaction.editReply({ content: '❌ Aucun staff configuré.' });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle('👥 Liste du Staff')
      .setColor(0x5865F2)
      .setDescription(guildStaff.map(s => {
        const lvl = ADMIN_LEVELS[s.niveau];
        return `**[Niv.${s.niveau}] ${lvl.name}** — <@${s.userId}>`;
      }).join('\n'));
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
      const dmEmbed = new EmbedBuilder()
        .setTitle(`⚠️ Avertissement — ${guild.name}`)
        .setColor(0xFEE75C)
        .addFields(
          { name: '📝 Raison', value: raison },
          { name: '🛡️ Modérateur', value: user.tag }
        );
      if (mention) dmEmbed.addFields({ name: '💬 Message', value: mention });
      await target.user.send({ embeds: [dmEmbed] }).catch(() => {});
    } catch {}

    const auto = await checkAutoSanctions(guild, target);

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Avertissement')
      .setColor(0xFEE75C)
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

    if (config.muteRole) {
      await target.roles.add(config.muteRole).catch(() => {});
    } else {
      await target.timeout(duration || 3600000, raison).catch(() => {});
    }

    const sanction = await addSanction(guildId, target.id, target.user.tag, user.id, 'mute', raison, duration);
    await logAction(guild, sanction);

    if (mention) {
      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle(`🔇 Mute — ${guild.name}`)
          .setColor(0xEB459E)
          .addFields({ name: '💬 Message', value: mention }, { name: '📝 Raison', value: raison });
        await target.user.send({ embeds: [dmEmbed] }).catch(() => {});
      } catch {}
    }

    if (duration) {
      setTimeout(async () => {
        if (config.muteRole) {
          const m = await guild.members.fetch(target.id).catch(() => null);
          if (m) await m.roles.remove(config.muteRole).catch(() => {});
        }
        await col('mod_cases').updateOne({ id: sanction.id }, { $set: { active: false } });
      }, duration);
    }

    const embed = new EmbedBuilder()
      .setTitle('🔇 Mute')
      .setColor(0xEB459E)
      .addFields(
        { name: '👤 Membre', value: `<@${target.id}>`, inline: true },
        { name: '⏱️ Durée', value: duration ? formatDuration(duration) : 'Indéfini', inline: true },
        { name: '📝 Raison', value: raison }
      );
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

    if (mention) {
      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle(`👢 Kick — ${guild.name}`)
          .setColor(0xED4245)
          .addFields({ name: '📝 Raison', value: raison }, { name: '💬 Message', value: mention });
        await target.user.send({ embeds: [dmEmbed] }).catch(() => {});
      } catch {}
    }

    await target.kick(raison);
    const sanction = await addSanction(guildId, target.id, target.user.tag, user.id, 'kick', raison);
    await logAction(guild, sanction);

    const embed = new EmbedBuilder()
      .setTitle('👢 Kick')
      .setColor(0xED4245)
      .addFields(
        { name: '👤 Membre', value: `${target.user.tag}`, inline: true },
        { name: '📝 Raison', value: raison, inline: true }
      );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── ban ──
  if (commandName === 'ban') {
    const target = options.getMember('membre');
    const raison = options.getString('raison') || 'Aucune raison';
    const mention = options.getString('mention');

    if (mention) {
      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle(`🔨 Ban — ${guild.name}`)
          .setColor(0x000000)
          .addFields({ name: '📝 Raison', value: raison }, { name: '💬 Message', value: mention });
        await target.user.send({ embeds: [dmEmbed] }).catch(() => {});
      } catch {}
    }

    await target.ban({ reason: raison });
    const sanction = await addSanction(guildId, target.id, target.user.tag, user.id, 'ban', raison);
    await logAction(guild, sanction);

    const embed = new EmbedBuilder()
      .setTitle('🔨 Ban')
      .setColor(0x000000)
      .addFields(
        { name: '👤 Membre', value: `${target.user.tag}`, inline: true },
        { name: '📝 Raison', value: raison, inline: true }
      );
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

    const embed = new EmbedBuilder()
      .setTitle(`📋 Casier — ${target.tag}`)
      .setColor(0x5865F2)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: '⚠️ Warns', value: `${counts.warn}`, inline: true },
        { name: '🔇 Mutes', value: `${counts.mute}`, inline: true },
        { name: '👢 Kicks', value: `${counts.kick}`, inline: true },
        { name: '🔨 Bans', value: `${counts.ban}`, inline: true },
        { name: '📊 Total', value: `${userCases.length} sanction(s)`, inline: true }
      );

    const recent = userCases.slice(0, 5);
    if (recent.length) {
      const icons = { warn: '⚠️', mute: '🔇', kick: '👢', ban: '🔨', unban: '✅', unmute: '🔊' };
      embed.addFields({
        name: '📜 Historique récent',
        value: recent.map(c => `${icons[c.type]} **#${c.caseNumber}** ${c.type.toUpperCase()} — ${c.reason} <t:${Math.floor(new Date(c.createdAt).getTime()/1000)}:R>`).join('\n')
      });
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Voir le panel').setStyle(ButtonStyle.Link).setURL(`${PANEL_URL}/?guild=${guildId}&user=${target.id}`)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  // ── mafiche ──
  if (commandName === 'mafiche') {
    const userCases = await col('mod_cases').find({ guildId, targetId: user.id }).toArray();
    const counts = { warn: 0, mute: 0, kick: 0, ban: 0 };
    userCases.forEach(c => { if (counts[c.type] !== undefined) counts[c.type]++; });

    const embed = new EmbedBuilder()
      .setTitle(`📋 Votre Fiche — ${guild.name}`)
      .setColor(0x5865F2)
      .setThumbnail(user.displayAvatarURL())
      .setDescription('Voici un résumé de votre historique sur ce serveur.')
      .addFields(
        { name: '⚠️ Avertissements', value: `${counts.warn}`, inline: true },
        { name: '🔇 Mutes', value: `${counts.mute}`, inline: true },
        { name: '👢 Kicks', value: `${counts.kick}`, inline: true },
        { name: '🔨 Bans', value: `${counts.ban}`, inline: true }
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Voir ma fiche complète').setStyle(ButtonStyle.Link).setURL(`${PANEL_URL}/fiche?guild=${guildId}&user=${user.id}`)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  // ── clearwarn ──
  if (commandName === 'clearwarn') {
    const target = options.getUser('membre');
    const warnId = options.getString('id');
    if (warnId) {
      await col('mod_cases').updateOne({ id: warnId, targetId: target.id, type: 'warn' }, { $set: { active: false } });
      await interaction.editReply({ content: `✅ Warn \`${warnId}\` effacé.` });
    } else {
      await col('mod_cases').updateMany({ guildId, targetId: target.id, type: 'warn' }, { $set: { active: false } });
      await interaction.editReply({ content: `✅ Tous les warns de <@${target.id}> ont été effacés.` });
    }
    return;
  }
}

// ─── Express API ──────────────────────────────────────────────────────────────
const app = express();
const path = require('path');
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token invalide' }); }
}

// Auth
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

// Cases
app.get('/api/cases', authMiddleware, (req, res) => {
  const { guildId } = req.user;
  const cases = loadDB('mod_cases');
  res.json(cases[guildId] || []);
});

app.post('/api/cases', authMiddleware, async (req, res) => {
  const { guildId, username } = req.user;
  const { targetId, targetTag, type, reason } = req.body;
  if (!targetId || !type) return res.status(400).json({ error: 'Champs manquants' });

  const sanction = await addSanction(guildId, targetId, targetTag || targetId, username, type, reason || 'Sanction via panel');

  // Log dans Discord si possible
  const guild = client.guilds.cache.get(guildId);
  if (guild) {
    await logAction(guild, sanction);
    // Appliquer la sanction sur Discord si possible
    try {
      const member = await guild.members.fetch(targetId).catch(() => null);
      if (member) {
        const config = await col('mod_configs').findOne({ guildId }) || {};
        if (type === 'mute' && config.muteRole) await member.roles.add(config.muteRole).catch(() => {});
        if (type === 'mute' && !config.muteRole) await member.timeout(3600000, reason).catch(() => {});
        if (type === 'kick') await member.kick(reason || 'Sanction via panel').catch(() => {});
        if (type === 'ban') await member.ban({ reason: reason || 'Sanction via panel' }).catch(() => {});
        const colors = { warn: 0xFEE75C, mute: 0xEB459E, kick: 0xED4245, ban: 0x000000 };
        const icons = { warn: '⚠️', mute: '🔇', kick: '👢', ban: '🔨' };
        const dmEmbed = new EmbedBuilder()
          .setTitle(`${icons[type] || '📋'} Sanction — ${guild.name}`)
          .setColor(colors[type] || 0x5865F2)
          .addFields(
            { name: '📝 Raison', value: reason || 'Aucune raison' },
            { name: '🛡️ Modérateur', value: username }
          );
        await member.user.send({ embeds: [dmEmbed] }).catch(() => {});
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

// Staff
app.get('/api/staff', authMiddleware, async (req, res) => {
  const { guildId } = req.user;
  res.json(await col('mod_staff').find({ guildId }).toArray());
});

app.post('/api/staff', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Niveau insuffisant' });
  const { guildId } = req.user;
  const { userId, tag, niveau } = req.body;
  const member = { userId, tag, niveau, guildId, addedBy: req.user.username, addedAt: new Date().toISOString() };
  await col('mod_staff').updateOne({ guildId, userId }, { $set: member }, { upsert: true });
  res.json(member);
});

app.patch('/api/staff/:userId', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Niveau insuffisant' });
  const { guildId } = req.user;
  await col('mod_staff').updateOne({ guildId, userId: req.params.userId }, { $set: { niveau: req.body.niveau } });
  res.json({ success: true });
});

// Users
app.get('/api/users', authMiddleware, async (req, res) => {
  const { guildId } = req.user;
  const users = await col('mod_users').find({ guildId }).toArray();
  res.json(users.map(u => ({ id: u.id, username: u.username, role: u.role, adminLevel: u.adminLevel, createdAt: u.createdAt })));
});

app.patch('/api/users/:id/level', authMiddleware, async (req, res) => {
  if (req.user.adminLevel < 4) return res.status(403).json({ error: 'Niveau insuffisant' });
  const { guildId } = req.user;
  await col('mod_users').updateOne({ id: req.params.id, guildId }, { $set: { adminLevel: req.body.adminLevel } });
  res.json({ success: true });
});

// Public fiche
app.get('/api/public/fiche/:guildId/:userId', async (req, res) => {
  const userCases = await col('mod_cases').find({ guildId: req.params.guildId, targetId: req.params.userId }).toArray();
  const counts = { warn: 0, mute: 0, kick: 0, ban: 0 };
  userCases.forEach(c => { if (counts[c.type] !== undefined) counts[c.type]++; });
  res.json({ cases: userCases.filter(c => c.type !== 'unban' && c.type !== 'unmute'), counts });
});

// modsetup
app.post('/api/config', authMiddleware, async (req, res) => {
  const { guildId } = req.user;
  await col('mod_configs').updateOne({ guildId }, { $set: { guildId, ...req.body } }, { upsert: true });
  res.json({ success: true });
});

// Guild info
app.get('/api/guild/:guildId', (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: 'Serveur introuvable' });
  res.json({ id: guild.id, name: guild.name, icon: guild.iconURL(), memberCount: guild.memberCount });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await connectDB();
  app.listen(PORT, () => console.log(`🌐 Panel: http://localhost:${PORT}`));
  client.login(BOT_TOKEN);
}
start();
