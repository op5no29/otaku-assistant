function getStatusTagConfig(thread, config) {
  const parentId = String(thread.parentId || '');
  return config.questionForumTags?.[parentId] || null;
}

function areQuestionStatusTagsAlreadyCorrect(thread, status, config) {
  const tagConfig = getStatusTagConfig(thread, config);
  if (!tagConfig?.open || !tagConfig?.resolved) {
    return false;
  }

  const appliedTags = new Set((thread.appliedTags || []).map(String));
  const openTagId = String(tagConfig.open);
  const resolvedTagId = String(tagConfig.resolved);

  if (status === 'resolved') {
    return appliedTags.has(resolvedTagId) && !appliedTags.has(openTagId);
  }

  return appliedTags.has(openTagId) && !appliedTags.has(resolvedTagId);
}

async function applyQuestionStatusTag(thread, status, { config, logger }) {
  const tagConfig = getStatusTagConfig(thread, config);

  if (!tagConfig?.open || !tagConfig?.resolved) {
    logger.warn('Question status tag config not found', {
      threadId: thread.id,
      parentId: String(thread.parentId || ''),
      status
    });
    return thread;
  }

  const removeTagIds = new Set([String(tagConfig.open), String(tagConfig.resolved)]);
  const nextAppliedTags = (thread.appliedTags || [])
    .map(String)
    .filter((tagId) => !removeTagIds.has(tagId));

  const targetTagId = status === 'resolved' ? String(tagConfig.resolved) : String(tagConfig.open);
  if (!nextAppliedTags.includes(targetTagId)) {
    nextAppliedTags.push(targetTagId);
  }

  try {
    const updatedThread = await thread.setAppliedTags(nextAppliedTags, `Question status changed to ${status}`);
    logger.info('Question status tag updated', {
      threadId: thread.id,
      parentId: String(thread.parentId || ''),
      status,
      appliedTags: nextAppliedTags
    });
    return updatedThread;
  } catch (error) {
    logger.warn('Failed to update question status tags', {
      threadId: thread.id,
      parentId: String(thread.parentId || ''),
      status,
      error: error.message
    });
    return thread;
  }
}

module.exports = {
  applyQuestionStatusTag,
  areQuestionStatusTagsAlreadyCorrect
};
