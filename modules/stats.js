const { EmbedBuilder } = require('discord.js');

module.exports = function(client, db) {
  const col = (name) => db.collection(name);
  
  // Commande Slash à ajouter :
  // new SlashCommandBuilder().setName('statsmod').setDescription('Voir les statistiques de modération')
  //   .addStringOption(o => o.setName('periode').setDescription('Période').setRequired(false).addChoices(
  //     {name:'Cette semaine',value:'week'},{name:'Ce mois',value:'month'},{name:'Tout',value:'all'}))
  // new SlashCommandBuilder().setName('statschannel').setDescription('[ADMIN] Configurer le salon des stats')
  //   .addChannelOption(o => o.setName('salon').setDescription('Salon').setRequired(true))
  //   .addBooleanOption(o => o.setName('actif').setDescription('Activer').setRequired(true))
  //   .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  function getStartDate(period) {
    const now = new Date();
    if (period === 'week') {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(now.setDate(diff));
      monday.setHours(0, 0, 0, 0);
      return monday.toISOString();
    } else if (period === 'month') {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      return firstDay.toISOString();
    }
    return '2020-01-01'; // Tout
  }

  return {
    name: 'stats',
    
    // Obtenir les statistiques
    async getStats(guildId, period = 'week') {
      const startDate = getStartDate(period);
      
      const cases = await col('mod_cases').find({
        guildId,
        createdAt: { $gte: startDate }
      }).toArray();
      
      const counts = { warn: 0, mute: 0, kick: 0, ban: 0, unban: 0, total: 0 };
      cases.forEach(c => {
        if (counts[c.type] !== undefined) counts[c.type]++;
        counts.total++;
      });
      
      // Top modérateurs
      const modCounts = {};
      cases.forEach(c => {
        modCounts[c.modId] = (modCounts[c.modId] || 0) + 1;
      });
      
      const topMods = Object.entries(modCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      
      // Membres les plus sanctionnés
      const targetCounts = {};
      cases.forEach(c => {
        if (!targetCounts[c.targetId]) targetCounts[c.targetId] = { tag: c.targetTag, count: 0 };
        targetCounts[c.targetId].count++;
      });
      
      const topTargets = Object.entries(targetCounts)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5);
      
      // Membres les plus sages (XP élevé, 0 warns)
      const xpUsers = await col('xp_users').find({ guildId }).sort({ xp: -1 }).limit(20).toArray();
      const wiseMembers = [];
      
      for (const u of xpUsers) {
        const warnings = await col('mod_cases').countDocuments({
          guildId,
          targetId: u.userId,
          type: 'warn',
          createdAt: { $gte: startDate }
        });
        
        if (warnings === 0 && wiseMembers.length < 3) {
          wiseMembers.push(u);
        }
      }
      
      return { counts, topMods, topTargets, wiseMembers, total: cases.length };
    },
    
    // Poster les stats dans un salon
    async postStats(guild, channelId, period = 'week') {
      const stats = await this.getStats(guild.id, period);
      const channel = guild.channels.cache.get(channelId);
      if (!channel) return;
      
      const periodLabels = { week: 'cette semaine', month: 'ce mois', all: 'depuis le début' };
      
      const embed = new EmbedBuilder()
        .setTitle(`📊 Rapport de Modération — ${periodLabels[period]}`)
        .setColor(0x5865F2)
        .addFields(
          { name: '⚠️ Warns', value: `${stats.counts.warn}`, inline: true },
          { name: '🔇 Mutes', value: `${stats.counts.mute}`, inline: true },
          { name: '👢 Kicks', value: `${stats.counts.kick}`, inline: true },
          { name: '🔨 Bans', value: `${stats.counts.ban}`, inline: true },
          { name: '✅ Unbans', value: `${stats.counts.unban}`, inline: true },
          { name: '📊 Total', value: `${stats.total}`, inline: true }
        );
      
      if (stats.topMods.length > 0) {
        embed.addFields({
          name: '🏆 Top Modérateurs',
          value: stats.topMods.map(([id, count], i) => `${['🥇','🥈','🥉','4️⃣','5️⃣'][i]} <@${id}> — ${count} sanctions`).join('\n')
        });
      }
      
      if (stats.topTargets.length > 0) {
        embed.addFields({
          name: '⚠️ Membres les plus sanctionnés',
          value: stats.topTargets.map(([id, data], i) => `${i + 1}. ${data.tag} — ${data.count} sanctions`).join('\n')
        });
      }
      
      if (stats.wiseMembers.length > 0) {
        embed.addFields({
          name: '🌟 Membres les plus sages (XP élevé, 0 warns)',
          value: stats.wiseMembers.map((u, i) => `${['🥇','🥈','🥉'][i]} **${u.username}** — Niv.${u.level || 0}`).join('\n')
        });
      }
      
      embed.setTimestamp();
      
      await channel.send({ embeds: [embed] });
      return stats;
    },
    
    // Gérer les commandes slash
    async handleCommand(interaction) {
      const { commandName, options, guild } = interaction;
      
      if (commandName === 'statsmod') {
        const period = options.getString('periode') || 'week';
        const stats = await this.getStats(guild.id, period);
        
        const periodLabels = { week: 'cette semaine', month: 'ce mois', all: 'depuis le début' };
        
        const embed = new EmbedBuilder()
          .setTitle(`📊 Statistiques de Modération — ${periodLabels[period]}`)
          .setColor(0x5865F2)
          .addFields(
            { name: '⚠️ Warns', value: `${stats.counts.warn}`, inline: true },
            { name: '🔇 Mutes', value: `${stats.counts.mute}`, inline: true },
            { name: '👢 Kicks', value: `${stats.counts.kick}`, inline: true },
            { name: '🔨 Bans', value: `${stats.counts.ban}`, inline: true },
            { name: '📊 Total', value: `${stats.total}`, inline: true }
          );
        
        if (stats.topMods.length > 0) {
          embed.addFields({
            name: '🏆 Top Modérateurs',
            value: stats.topMods.map(([id, count], i) => `${['🥇','🥈','🥉'][i] || `#${i+1}`} <@${id}> — ${count} sanctions`).join('\n')
          });
        }
        
        if (stats.wiseMembers.length > 0) {
          embed.addFields({
            name: '🌟 Membres les plus sages',
            value: stats.wiseMembers.map((u, i) => `${['🥇','🥈','🥉'][i]} **${u.username}**`).join('\n')
          });
        }
        
        await interaction.editReply({ embeds: [embed] });
      }
      
      if (commandName === 'statschannel') {
        const channel = options.getChannel('salon');
        const actif = options.getBoolean('actif');
        
        await col('mod_configs').updateOne(
          { guildId: guild.id },
          { $set: { statsChannel: actif ? channel.id : null, statsEnabled: actif } },
          { upsert: true }
        );
        
        await interaction.editReply({ 
          content: `✅ Statistiques ${actif ? 'activées' : 'désactivées'} dans <#${channel.id}>` 
        });
        
        // Poster immédiatement les stats
        if (actif) {
          await this.postStats(guild, channel.id);
        }
      }
    },
    
    // Post automatique hebdomadaire
    async autoPostWeekly(client) {
      for (const [, guild] of client.guilds.cache) {
        const config = await col('mod_configs').findOne({ guildId: guild.id }) || {};
        if (config.statsEnabled && config.statsChannel) {
          await this.postStats(guild, config.statsChannel, 'week').catch(() => {});
        }
      }
    }
  };
};
