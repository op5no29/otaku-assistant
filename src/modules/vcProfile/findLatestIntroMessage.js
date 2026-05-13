async function findLatestIntroMessage(introChannel, userId, maxBatches = 10) {
  if (!introChannel?.isTextBased?.()) {
    return null;
  }

  let before;

  for (let index = 0; index < maxBatches; index += 1) {
    const batch = await introChannel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    });

    if (!batch.size) {
      return null;
    }

    const matched = batch.find((message) => message.author?.id === userId);
    if (matched) {
      return matched;
    }

    before = batch.last()?.id;
    if (!before) {
      return null;
    }
  }

  return null;
}

module.exports = {
  findLatestIntroMessage
};
