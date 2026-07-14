module.exports = {
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) {
      const { handleTimelineRestorationInteraction } = require('../modules/timelineRestoration');
      try {
        const handledTimelineRestoration = await handleTimelineRestorationInteraction(interaction);
        if (handledTimelineRestoration) {
          return;
        }
      } catch (error) {
        interaction.client.logger.error('Timeline restoration component interaction failed', {
          interactionId: interaction.id,
          customId: interaction.customId || null,
          error: error.message
        });
      }

      const { handleVcSummaryInteraction } = require('../modules/vcSessionSummary');
      try {
        const handledVcSummary = await handleVcSummaryInteraction(interaction);
        if (handledVcSummary) {
          return;
        }
      } catch (error) {
        interaction.client.logger.error('VC summary component interaction failed', {
          interactionId: interaction.id,
          customId: interaction.customId || null,
          error: error.message
        });
      }

      const { handleQuestionRolePromptInteraction } = require('../modules/timelineRelay');
      try {
        const handledQuestionRolePrompt = await handleQuestionRolePromptInteraction(interaction);
        if (handledQuestionRolePrompt) {
          return;
        }
      } catch (error) {
        interaction.client.logger.error('Question role prompt interaction failed', {
          interactionId: interaction.id,
          customId: interaction.customId || null,
          error: error.message
        });
      }

      const { handleAnnictInteraction } = require('../modules/annictUserIntegration');
      try {
        const handledAnnict = await handleAnnictInteraction(interaction);
        if (handledAnnict) {
          return;
        }
      } catch (error) {
        interaction.client.logger.error('Annict user integration interaction failed', {
          interactionId: interaction.id,
          customId: interaction.customId || null,
          error: error.message
        });
      }

      const animeCommand = interaction.client.commands.get('anime');
      if (animeCommand?.handleComponentInteraction) {
        try {
          const handled = await animeCommand.handleComponentInteraction(interaction);
          if (handled) {
            return;
          }
        } catch (error) {
          interaction.client.logger.error('Anime component interaction failed', {
            interactionId: interaction.id,
            customId: interaction.customId || null,
            error: error.message
          });
        }
      }
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
