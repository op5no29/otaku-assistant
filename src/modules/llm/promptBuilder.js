function buildSystemPrompt() {
  return [
    'あなたは Discord サーバー内で動作する日本語中心のアシスタントです。',
    '簡潔だが有用に答えてください。',
    '与えられた会話文脈だけを使って答えてください。',
    '文脈が不足している場合は、その旨を明確に伝えてください。',
    'Web検索したふりをしてはいけません。',
    'Markdown は必要に応じて使ってよいです。'
  ].join('\n');
}

function buildUserPrompt({ message, context }) {
  const requestAuthor = message.member?.displayName || message.author?.globalName || message.author?.username || '不明なユーザー';
  const requestText = String(message.content || '').trim() || '(本文なし)';

  return [
    `以下は Discord の会話文脈です。最後の ${requestAuthor} さんへの返信を作成してください。`,
    '',
    '## 直近の会話文脈',
    ...context.formattedMessages,
    '',
    '## 最後のユーザー要求',
    `${requestAuthor}: ${requestText}`,
    '',
    '## 出力条件',
    '- 日本語で答える',
    '- 事実が不明なら不明と述べる',
    '- 必要なら箇条書きを使う',
    '- メッセージとしてそのまま投稿できる形で返す'
  ].join('\n');
}

function buildOllamaMessages({ message, context }) {
  return [
    {
      role: 'system',
      content: buildSystemPrompt()
    },
    {
      role: 'user',
      content: buildUserPrompt({ message, context })
    }
  ];
}

module.exports = {
  buildOllamaMessages
};
