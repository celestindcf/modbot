const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');

// ─── WANTED SYSTEM ─────────────────────────────────────────────────────────
module.exports = function(client, db) {
  const col = (name) => db.collection(name);
  
  // Commande Slash à ajouter dans le tableau commands du bot.js :
  // new SlashCommandBuilder().setName('wanted').setDescription('[ADMIN] Gérer les avis de recherche')
  //   .addSubcommand(s => s.setName('add').setDescription('Ajouter un avis de recherche')
  //     .addUserOption(o => o.setName('membre').setDescription('Membre recherché').setRequired(true))
  //     .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(true))
  //     .addStringOption(o => o.setName('danger').setDescription('Niveau de danger').setRequired(true).addChoices(
  //       {name:'🔴 Dangereux',value:'high'},{name:'🟠 Suspect',value:'medium'},{name:'🟡 Surveillance',value:'low'})))
  //   .addSubcommand(s => s.setName('remove').setDescription('Retirer un avis de recherche')
  //     .addStringOption(o => o.setName('id').setDescription('ID de l\'avis').setRequired(true)))
  //   .addSubcommand(s => s.setName('list').setDescription('Voir la liste des avis de recherche'))
  //   .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  return {
    name: 'wanted',
    
    // Ajouter un avis de recherche
    async addWanted(guildId, targetId, targetTag, reason, danger, addedBy) {
      const wanted = {
        id: require('uuid').v4().slice(0, 8),
        guildId,
        targetId,
        targetTag,
        reason,
        danger,
        addedBy,
        status: 'active',
        createdAt: new Date().toISOString()
      };
      await col('wanted_list').insertOne(wanted);
      return wanted;
    },
    
    // Retirer un avis de recherche
    async removeWanted(guildId, wantedId) {
      await col('wanted_list').updateOne(
        { guildId, id: wantedId },
        { $set: { status: 'removed', removedAt: new Date().toISOString() } }
      );
    },
    
    // Vérifier si un membre est recherché
    async checkWanted(guildId, userId) {
      return await col('wanted_list').findOne({ guildId, targetId: userId, status: 'active' });
    },
    
    // Liste des avis de recherche
    async listWanted(guildId) {
      return await col('wanted_list').find({ guildId, status: 'active' }).toArray();
    },
    
    // Surveiller les nouveaux membres
    async monitorNewMember(member) {
      const wanted = await this.checkWanted(member.guild.id, member.id);
      
      if (wanted) {
        const dangerEmojis = { high: '🔴', medium: '🟠', low: '🟡' };
        const dangerLabels = { high: 'Dangereux', medium: 'Suspect', low: 'Surveillance' };
        
        // Logger dans le salon de logs
        const config = await col('mod_configs').findOne({ guildId: member.guild.id }) || {};
        const logChannel = member.guild.channels.cache.get(config.logChannel);
        
        if (logChannel) {
          await logChannel.send({
            embeds: [new EmbedBuilder()
              .setTitle('🚨 AVIS DE RECHERCHE — MEMBRE DÉTECTÉ')
              .setColor(0xFF0000)
              .setDescription(`**${member.user.tag}** (${member.user.id}) correspond à un avis de recherche !`)
              .addFields(
                { name: '⚠️ Danger', value: `${dangerEmojis[wanted.danger]} ${dangerLabels[wanted.danger]}`, inline: true },
                { name: '📝 Raison', value: wanted.reason, inline: false },
                { name: '👤 Ajouté par', value: `<@${wanted.addedBy}>`, inline: true },
                { name: '📅 Depuis le', value: new Date(wanted.createdAt).toLocaleDateString('fr-FR'), inline: true }
              )
            ]
          });
        }
        
        // Notifier les admins
        const staff = await col('mod_staff').find({ guildId: member.guild.id, niveau: { $gte: 3 } }).toArray();
        for (const s of staff) {
          try {
            const admin = await client.users.fetch(s.userId);
            await admin.send({
              embeds: [new EmbedBuilder()
                .setTitle('🚨 AVIS DE RECHERCHE')
                .setColor(0xFF0000)
                .setDescription(`**${member.user.tag}** a rejoint **${member.guild.name}**`)
                .addFields({ name: '📝 Raison', value: wanted.reason })
              ]
            });
          } catch {}
        }
        
        return wanted;
      }
      return null;
    },
    
    // Gérer les commandes slash
    async handleCommand(interaction) {
      const { options, guildId, user, guild } = interaction;
      const sub = options.getSubcommand();
      
      if (sub === 'add') {
        const target = options.getUser('membre');
        const reason = options.getString('raison');
        const danger = options.getString('danger');
        
        const wanted = await this.addWanted(guildId, target.id, target.tag, reason, danger, user.id);
        
        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setTitle('🚨 Avis de recherche créé')
            .setColor(0xFF0000)
            .setDescription(`**${target.tag}** est maintenant recherché sur ce serveur.`)
            .addFields(
              { name: '⚠️ Danger', value: danger, inline: true },
              { name: '📝 Raison', value: reason, inline: true },
              { name: '🆔 ID', value: wanted.id, inline: true }
            )
          ]
        });
      }
      
      if (sub === 'remove') {
        const id = options.getString('id');
        await this.removeWanted(guildId, id);
        await interaction.editReply({ content: `✅ Avis de recherche \`${id}\` retiré.` });
      }
      
      if (sub === 'list') {
        const list = await this.listWanted(guildId);
        
        if (list.length === 0) {
          return interaction.editReply({ content: '✅ Aucun avis de recherche actif.' });
        }
        
        const embed = new EmbedBuilder()
          .setTitle('📜 Avis de recherche actifs')
          .setColor(0xFF0000);
        
        list.forEach(w => {
          embed.addFields({
            name: `${w.targetTag} (${w.targetId})`,
            value: `⚠️ ${w.danger} | 📝 ${w.reason}\n🆔 \`${w.id}\``
          });
        });
        
        await interaction.editReply({ embeds: [embed] });
      }
    }
  };
};
