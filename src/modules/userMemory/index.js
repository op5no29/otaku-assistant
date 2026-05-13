const SENSITIVE_PATTERN = /健康|病気|診断|宗教|信仰|政治|性的指向|sexuality|セクシュアリティ|住所|犯罪|刑事|自殺|死にたい/u;

const MEMORY_SAVE_PATTERN = /覚えて|メモして|今後は|remember|note\s+that/iu;
const MEMORY_DELETE_PATTERN = /忘れて|forget|メモ消して/iu;

const VALID_MEMORY_KEYS = ['aliases', 'interests', 'projects', 'preferences', 'bot_usage_context', 'notes'];

function isSensitiveContent(text) {
  return SENSITIVE_PATTERN.test(String(text || ''));
}

function detectMemoryRequest(content) {
  const text = String(content || '');
  if (MEMORY_SAVE_PATTERN.test(text)) {
    return 'save';
  }

  if (MEMORY_DELETE_PATTERN.test(text)) {
    return 'delete';
  }

  return null;
}

function inferMemoryKey(text) {
  const t = String(text || '');
  if (/好き|嫌い|趣味|興味|はまって|ハマって/u.test(t)) {
    return 'interests';
  }

  if (/プロジェクト|制作|開発|作ってる|制作中/u.test(t)) {
    return 'projects';
  }

  if (/方針|スタイル|好みの|使いたくない|入れない|設定/u.test(t)) {
    return 'preferences';
  }

  if (/呼んで|名前|ニックネーム|alias/iu.test(t)) {
    return 'aliases';
  }

  return 'notes';
}

function extractMemoryText(rawText) {
  return String(rawText || '')
    .replace(/^(覚えて|メモして|今後は|remember|note\s+that)[、,，\s]*/iu, '')
    .trim();
}

function getUserMemories(client, guildId, userId) {
  return client.db.userMemories.listByUser(guildId, userId);
}

function saveUserMemory(client, guildId, userId, memoryKey, memoryText, source = 'explicit_user_request') {
  const key = VALID_MEMORY_KEYS.includes(memoryKey) ? memoryKey : 'notes';

  if (isSensitiveContent(memoryText)) {
    client.logger.info('User memory write skipped due to sensitive content', {
      guildId,
      userId,
      memoryKey: key
    });
    return false;
  }

  client.db.userMemories.upsert({ guildId, userId, memoryKey: key, memoryText, source });
  client.logger.info('User memory saved', { guildId, userId, memoryKey: key, source });
  return true;
}

function deleteUserMemory(client, guildId, userId, memoryKey) {
  client.db.userMemories.deleteByKey(guildId, userId, memoryKey);
  client.logger.info('User memory deleted', { guildId, userId, memoryKey });
}

function deleteAllUserMemories(client, guildId, userId) {
  client.db.userMemories.deleteAllByUser(guildId, userId);
  client.logger.info('User memory cleared all', { guildId, userId });
}

function formatUserMemoriesForPrompt(memories) {
  if (!Array.isArray(memories) || !memories.length) {
    return [];
  }

  return memories.map((m) => `- [${m.memoryKey}] ${m.memoryText}`);
}

module.exports = {
  detectMemoryRequest,
  inferMemoryKey,
  extractMemoryText,
  isSensitiveContent,
  getUserMemories,
  saveUserMemory,
  deleteUserMemory,
  deleteAllUserMemories,
  formatUserMemoriesForPrompt
};
