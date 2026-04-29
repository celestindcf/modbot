const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } = require('discord.js');

module.exports = function(client, db) {
  const col = (name) => db.collection(name);
  
  // Commande Slash à ajouter :
  // new SlashCommandBuilder().setName('proces').setDescription('[ADMIN] Ouvrir un procès communautaire')
  //   .addUserOption(o => o.setName('accuse').setDescription('Membre accusé').setRequired(true))
  //   .addStringOption(o => o.setName('accusation').setDescription('Accusation').setRequired(true))
  //   .addIntegerOption(o => o.setName('duree').setDescription('Durée en heures').setRequired(true).setMinValue(1).setMaxValue(72))
  //   .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  return {
    name: 'tribunal',
    
    // Créer un procès
    async createTrial(guild, accuserId, accuserTag, accusation, durationHours, createdBy, juryRoleId) {
      // Créer un salon temporaire
      const trialChannel = await guild.channels.create({
        name: `⚖️-proces-${accuserTag.split('#')[0]}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: juryRoleId || guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          { id: accuserId, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] }
        ]
      });
      
      const endTime = new Date(Date.now() + durationHours * 3600000);
      
      const trial = {
        id: require('uuid').v4().slice(0, 8),
        guildId: guild.id,
        channelId: trialChannel.id,
        accuserId,
        accuserTag,
        accusation,
        duration: durationHours,
        endTime: endTime.toISOString(),
        createdBy,
        status: 'active',
        votes: { bannir: 0, pardonner: 0, abstention: 0 },
        voters: [],
        createdAt: new Date().toISOString()
      };
      
      await col('trials').insertOne(trial);
      
      // Annonce du procès
      const embed = new EmbedBuilder()
        .setTitle('⚖️ PROCÈS COMMUNAUTAIRE')
        .setColor(0xFF9F43)
        .setDescription(`**Accusé :** <@${accuserId}>\n**Accusation :** ${accusation}`)
        .addFields(
          { name: '⏰ Fin du procès', value: `<t:${Math.floor(endTime.getTime() / 1000)}:R>`, inline: true },
          { name: '👨‍⚖️ Jury', value: 'Tous les membres peuvent voter', inline: true },
          { name: '📋 Comment voter', value: 'Cliquez sur les boutons ci-dessous', inline: false }
        );
      
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setCustomId(`trial_ban_${trial.id}`).setLabel('🔨 Bannir').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`trial_pardon_${trial.id}`).setLabel('🕊️ Pardonner').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`trial_abstain_${trial.id}`).setLabel('🤷 Abstention').setStyle(ButtonStyle.Secondary)
        );
      
      await trialChannel.send({ content: `<@&${juryRoleId || ''}> Un procès vient d'être ouvert !`, embeds: [embed], components: [row] });
      
      // Fermer automatiquement le procès
      setTimeout(async () => {
        await this.closeTrial(guild, trial.id);
      }, durationHours * 3600000);
      
      return { trial, channel: trialChannel };
    },
    
    // Voter dans un procès
    async vote(trialId, userId, vote) {
      const trial = await col('trials').findOne({ id: trialId, status: 'active' });
      if (!trial) return { error: 'Procès introuvable ou terminé.' };
      
      // Vérifier que l'utilisateur n'a pas déjà voté
      if (trial.voters.includes(userId)) {
        return { error: 'Tu as déjà voté dans ce procès.' };
      }
      
      const update = { $inc: {}, $push: { voters: userId } };
      
      if (vote === 'ban') update.$inc['votes.bannir'] = 1;
      else if (vote === 'pardon') update.$inc['votes.pardonner'] = 1;
      else update.$inc['votes.abstention'] = 1;
      
      await col('trials').updateOne({ id: trialId }, update);
      
      return { success: true };
    },
    
    // Fermer un procès
    async closeTrial(guild, trialId) {
      const trial = await col('trials').findOne({ id: trialId, status: 'active' });
      if (!trial) return;
      
      await col('trials').updateOne(
        { id: trialId },
        { $set: { status: 'closed', closedAt: new Date().toISOString() } }
      );
      
      const channel = guild.channels.cache.get(trial.channelId);
      if (!channel) return;
      
      // Calculer le résultat
      const total = trial.votes.bannir + trial.votes.pardonner + trial.votes.abstention;
      const banPercent = total > 0 ? Math.round((trial.votes.bannir / total) * 100) : 0;
      const pardonPercent = total > 0 ? Math.round((trial.votes.pardonner / total) * 100) : 0;
      
      const resultEmbed = new EmbedBuilder()
        .setTitle('⚖️ VERDICT')
        .setColor(banPercent >= 50 ? 0xED4245 : 0x57F287)
        .setDescription(`Le procès de <@${trial.accuserId}> est terminé.`)
        .addFields(
          { name: '🔨 Bannir', value: `${trial.votes.bannir} votes (${banPercent}%)`, inline: true },
          { name: '🕊️ Pardonner', value: `${trial.votes.pardonner} votes (${pardonPercent}%)`, inline: true },
          { name: '🤷 Abstention', value: `${trial.votes.abstention} votes`, inline: true }
        );
      
      // Appliquer la sanction
      if (banPercent >= 50) {
        const member = await guild.members.fetch(trial.accuserId).catch(() => null);
        if (member) await member.ban({ reason: `Verdict du tribunal : ${trial.accusation}` }).catch(() => {});
        resultEmbed.addFields({ name: '📋 Verdict', value: '**BANNI** par la communauté 🔨' });
      } else {
        resultEmbed.addFields({ name: '📋 Verdict', value: '**PARDONNÉ** par la communauté 🕊️' });
      }
      
      await channel.send({ embeds: [resultEmbed] });
      
      // Supprimer le salon après 1 heure
      setTimeout(() => channel.delete().catch(() => {}), 3600000);
      
      return trial;
    },
    
    // Gérer les commandes slash et les boutons
    async handleCommand(interaction) {
      const { options, guild, user } = interaction;
      
      const accuse = options.getUser('accuse');
      const accusation = options.getString('accusation');
      const duree = options.getInteger('duree');
      
      const config = await col('mod_configs').findOne({ guildId: guild.id }) || {};
      const juryRoleId = config.juryRoleId || null;
      
      const { trial, channel } = await this.createTrial(
        guild, accuse.id, accuse.tag, accusation, duree, user.id, juryRoleId
      );
      
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle('✅ Procès ouvert !')
          .setColor(0x57F287)
          .setDescription(`Le procès de **${accuse.tag}** est ouvert dans <#${channel.id}>.\nFin : <t:${Math.floor(new Date(trial.endTime).getTime() / 1000)}:R>`)
        ]
      });
    },
    
    // Gérer les boutons de vote
    async handleButton(interaction) {
      const customId = interaction.customId;
      
      if (customId.startsWith('trial_')) {
        const parts = customId.split('_');
        const vote = parts[1]; // ban, pardon, or abstain
        const trialId = parts[2];
        
        const result = await this.vote(trialId, interaction.user.id, vote);
        
        if (result.error) {
          return interaction.reply({ content: result.error, flags: 64 });
        }
        
        await interaction.reply({ 
          content: '✅ Ton vote a été enregistré !', 
          flags: 64 
        });
      }
    }
  };
};
