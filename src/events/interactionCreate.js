module.exports = {
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const executionKey = interaction.id;
    const recentExecutions = interaction.client.recentInteractionExecutions;

    if (recentExecutions.has(executionKey)) {
      interaction.client.logger.warn('Duplicate interaction execution skipped', {
        interactionId: interaction.id,
        commandName: interaction.commandName,
        processPid: process.pid,
        handlerLabel: 'interactionCreate:dedupe'
      });
      return;
    }

    recentExecutions.set(executionKey, Date.now());
    setTimeout(() => {
      recentExecutions.delete(executionKey);
    }, 10 * 60 * 1000).unref();

    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
      return;
    }

    try {
      interaction.client.logger.info('Command execution started', {
        interactionId: interaction.id,
        commandName: interaction.commandName,
        processPid: process.pid,
        handlerLabel: 'interactionCreate:execute'
      });
      await command.execute(interaction);
      interaction.client.logger.info('Command execution finished', {
        interactionId: interaction.id,
        commandName: interaction.commandName,
        processPid: process.pid,
        handlerLabel: 'interactionCreate:execute'
      });
    } catch (error) {
      interaction.client.logger.error('Command execution failed', {
        interactionId: interaction.id,
        commandName: interaction.commandName,
        processPid: process.pid,
        error: error.message
      });

      const payload = {
        content: 'コマンドの実行中にエラーが発生しました。時間をおいてもう一度お試しください。',
        ephemeral: true
      };

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload.content).catch(async () => {
          await interaction.followUp(payload).catch(() => null);
        });
        return;
      }

      await interaction.reply(payload).catch(() => null);
    }
  }
};
