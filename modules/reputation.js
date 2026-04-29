const { EmbedBuilder } = require('discord.js');

module.exports = function(client, db) {
  const col = (name) => db.collection(name);
  
  // Commandes Slash à ajouter :
  // new SlashCommandBuilder().setName('rep').setDescription('Donner de la réputation à un membre')
  //   .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true))
  //   .addStringOption(o => o.setName('type').setDescription('Type').setRequired(true).addChoices(
  //     {name:'✅ Positif',value:'pos'},{name:'❌ Négatif',value:'neg'}))
  //   .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false))
  // new SlashCommandBuilder().setName('toprep').setDescription('Top réputation')

  return {
    name: 'reputation',
    
    // Donner de la réputation
    async giveRep(guildId, fromId, toId, type, reason = '') {
      // Vérifier que l'utilisateur ne se rep pas lui-même
      if (fromId === toId) return { error: '❌ Tu ne peux pas te donner de réputation à toi-même.' };
      
      // Vérifier le cooldown (1 rep par jour)
      const today = new Date().toISOString().split('T')[0];
      const existing = await col('reputation_logs').findOne({
        guildId,
        fromId,
        date: today
      });
      
      if (existing) {
        return { error: '❌ Tu as déjà donné une réputation aujourd\'hui. Reviens demain !' };
      }
      
      const points = type === 'pos' ? 1 : -1;
      
      // Mettre à jour la réputation du membre
      await col('reputation').updateOne(
        { guildId, userId: toId },
        { 
          $inc: { points },
          $set: { lastUpdated: new Date().toISOString() },
          $setOnInsert: { guildId, userId: toId, createdAt: new Date().toISOString() }
        },
        { upsert: true }
      );
      
      // Logger
      await col('reputation_logs').insertOne({
        guildId,
        fromId,
        toId,
        type,
        points,
        reason,
        date: today,
        createdAt: new Date().toISOString()
      });
      
      // Vérifier les paliers de réputation et attribuer des rôles
      const userRep = await col('reputation').findOne({ guildId, userId: toId });
      const totalPoints = userRep?.points || 0;
      
      const config = await col('mod_configs').findOne({ guildId }) || {};
      
      // Rôles automatiques selon la réputation
      const repRoles = {
        50: config.repRole50,
        25: config.repRole25,
        10: config.repRole10,
        '-10': config.repRoleNeg10,
        '-25': config.repRoleNeg25
      };
      
      // Cette partie nécessite le guild object, donc à gérer dans le handler principal
      
      return { success: true, points: totalPoints, type };
    },
    
    // Obtenir la réputation d'un membre
    async getRep(guildId, userId) {
      const rep = await col('reputation').findOne({ guildId, userId });
      const rank = await col('reputation').countDocuments({ guildId, points: { $gt: rep?.points || 0 } }) + 1;
      
      return {
        points: rep?.points || 0,
        rank
      };
    },
    
    // Top réputation
    async getTopRep(guildId, limit = 10) {
      return await col('reputation').find({ guildId })
        .sort({ points: -1 })
        .limit(limit)
        .toArray();
    },
    
    // Gérer les commandes slash
    async handleCommand(interaction) {
      const { commandName, options, guild, user } = interaction;
      
      if (commandName === 'rep') {
        const target = options.getUser('membre');
        const type = options.getString('type');
        const reason = options.getString('raison') || '';
        
        const result = await this.giveRep(guild.id, user.id, target.id, type, reason);
        
        if (result.error) {
          return interaction.editReply({ content: result.error });
        }
        
        const emoji = type === 'pos' ? '✅' : '❌';
        const label = type === 'pos' ? 'positive' : 'négative';
        
        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setTitle(`${emoji} Réputation ${label}`)
            .setColor(type === 'pos' ? 0x57F287 : 0xED4245)
            .setDescription(`Tu as donné une réputation ${label} à **${target.username}**.\nSa réputation totale : **${result.points}** points`)
            .setFooter({ text: 'Reviens demain pour donner une autre réputation !' })
          ]
        });
      }
      
      if (commandName === 'toprep') {
        const top = await this.getTopRep(guild.id);
        
        if (top.length === 0) {
          return interaction.editReply({ content: '❌ Aucune réputation pour le moment.' });
        }
        
        const medals = ['🥇', '🥈', '🥉'];
        const embed = new EmbedBuilder()
          .setTitle('🏆 Top Réputation')
          .setColor(0xFFD700);
        
        top.forEach((u, i) => {
          embed.addFields({
            name: `${medals[i] || `#${i + 1}`} <@${u.userId}>`,
            value: `**${u.points}** points`,
          });
        });
        
        await interaction.editReply({ embeds: [embed] });
      }
    }
  };
};
