function updateResolvedState(db, threadId, resolvedAt = new Date()) {
  if (resolvedAt) {
    db.questions.markResolved(threadId, resolvedAt);
    return;
  }

  db.questions.clearResolved(threadId);
}

module.exports = {
  updateResolvedState
};
