function summarizePromptAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) {
    return [];
  }

  return attachments.slice(0, 4).map((attachment) => {
    const fileName = attachment.title || attachment.filename || attachment.name || 'attachment';
    return `attachment: ${fileName}${attachment.contentType ? ` [${attachment.contentType}]` : ''}${attachment.url ? ` (${attachment.url})` : ''}`;
  });
}

function summarizePromptEmbeds(embeds) {
  if (!Array.isArray(embeds) || !embeds.length) {
    return [];
  }

  return embeds.slice(0, 3).flatMap((embed) => {
    const lines = [];
    if (embed.title) {
      lines.push(`embed title: ${embed.title}`);
    }
    if (embed.description) {
      lines.push(`embed description: ${String(embed.description).slice(0, 280)}`);
    }
    if (embed.url) {
      lines.push(`embed url: ${embed.url}`);
    }
    if (embed.provider?.name) {
      lines.push(`embed provider: ${embed.provider.name}`);
    }
    const imageUrl = embed.image?.url || embed.thumbnail?.url || null;
    if (imageUrl) {
      lines.push(`embed image: ${imageUrl}`);
    }
    const videoUrl = embed.video?.url || null;
    if (videoUrl) {
      lines.push(`embed video: ${videoUrl}`);
    }
    return lines;
  });
}

function buildSystemPrompt() {
  return [
    'あなたは Otaku Assistant です。Discord サーバー内で動作する日本語中心のアシスタントです。',
    '名前や正体を聞かれたら、Otaku Assistant として答えてください。',
    'モデル名やベースモデル名を自分から明かしてはいけません。',
    'あなたの知識源は、この Discord サーバー内で与えられた会話文脈、メタデータ、添付要約、リンクプレビュー要約だけです。',
    '外部Web検索、外部API検索、最新ニュース取得は現在有効ではありません。',
    'Discord サーバー案内、会話整理、文脈整理を手伝うBotとして自然に振る舞ってください。',
    '実際に実行できるDiscord操作は、Botコード側で実装されたものだけです。',
    'リンク先投稿への返信などの操作が必要な場合は、Botコードが渡した対象投稿情報だけを前提に回答してください。',
    'Discord の場所情報、スレッド情報、フォーラムタグ、添付、リンクプレビュー要約を文脈として使ってください。',
    '',
    '【自己紹介プロフィールに関する厳格なルール】',
    '自己紹介プロフィールブロックが与えられた場合は、そのブロックに明示的に書かれている事実だけを使って回答してください。',
    '自己紹介本文（intro_text）に書かれていないことを推測・創作・補完してはいけません。',
    '例：プロフィール本文に「DTM、EDM、ボカロ、DJ」と書かれているなら、それだけを述べてください。「アニメ好き」など本文にない情報を付け加えてはいけません。',
    'リンクプレビュー（embed）の情報も、ブロックに含まれている場合のみ使えます。',
    'プロフィール候補が複数ある場合は「（〇〇さんと仮定して答えます）」のように、どの候補を使っているかを明示してください。',
    '信頼できるプロフィールが見つからなかった場合は「プロフィールが見つかりませんでした」と答えてください。',
    '',
    '【ユーザーメモリーに関するルール】',
    'このユーザーや関連ユーザーのメモリーブロックが与えられた場合は、その内容を文脈として使ってください。',
    'ユーザーが「覚えて」「メモして」などと言った場合は、内容を確認したうえで「覚えました」と短く確認してください。',
    'ユーザーが「忘れて」「forget」などと言った場合は、削除したことを確認してください。',
    '',
    '「このスレッド」は現在の Discord スレッドを指します。',
    '「このチャンネル」は現在の Discord チャンネルを指します。',
    '「このユーザー」「この人」は、返信先やメンションされたユーザーを指すことがあります。',
    '簡潔だが有用に答えてください。',
    '与えられた会話文脈だけを使って答えてください。',
    '関連するメタデータやスレッド先頭文があるなら、それを踏まえて答えてください。',
    '文脈が不足している場合は、その旨を明確に伝えてください。',
    'おすすめや参考資料の依頼には、与えられた文脈から合理的に推測して提案してよいですが、その場合は文脈ベースであることが分かるようにしてください。',
    'ユーザーが最新情報、現在のWeb情報、ニュース、検索結果を求めた場合は、まず必ず「Web検索は現在有効化されていないため、サーバー内の文脈だけで整理します。」と述べてください。',
    'そのうえで、与えられたDiscord文脈だけで可能な範囲の整理や提案を行ってください。',
    'Web検索したふりをしてはいけません。',
    'Markdown は必要に応じて使ってよいです。'
  ].join('\n');
}

function buildUserPrompt({ message, context }) {
  const requestAuthor = message.member?.displayName || message.author?.globalName || message.author?.username || '不明なユーザー';
  const requestText = String(context.requestResolvedText || message.content || '').trim() || '(本文なし)';
  const sections = [
    `以下は Discord の会話文脈です。最後の ${requestAuthor} さんへの返信を作成してください。`,
    '',
    '## Discordメタデータ',
    ...context.discordMetadataLines
  ];

  if (context.threadStarter) {
    sections.push(
      '',
      '## スレッド先頭メッセージ',
      `author: ${context.threadStarter.authorName || '不明'}`,
      `content: ${context.threadStarter.resolvedContent || context.threadStarter.content || '(本文なし)'}`
    );
    sections.push(
      ...summarizePromptAttachments(context.threadStarter.attachments),
      ...summarizePromptEmbeds(context.threadStarter.embeds)
    );
  }

  if (context.referencedMessage) {
    sections.push(
      '',
      '## このリクエストは次のメッセージへの返信です',
      `author: ${context.referencedMessage.authorName || '不明'}`,
      `content: ${context.referencedMessage.resolvedContent || '(本文なし)'}`
    );
    sections.push(
      ...summarizePromptAttachments(context.referencedMessage.attachments),
      ...summarizePromptEmbeds(context.referencedMessage.embeds)
    );
  }

  if (context.mentionedUserContext?.length) {
    for (const block of context.mentionedUserContext) {
      sections.push(
        '',
        `## 対象ユーザーの最近の発言 (${block.userId})`,
        ...block.lines
      );
    }
  }

  if (context.introProfileContext?.length) {
    for (const block of context.introProfileContext) {
      sections.push(
        '',
        `## 自己紹介プロフィール${block.assumed ? '' : '候補'}（このブロックの内容だけを事実として使ってください）`,
        ...block.lines
      );
    }
  }

  if (context.requesterMemoryLines?.length) {
    sections.push(
      '',
      '## このユーザーについての軽いメモリー（過去に保存済み）',
      ...context.requesterMemoryLines
    );
  }

  if (context.mentionedUserMemoryContext?.length) {
    for (const block of context.mentionedUserMemoryContext) {
      sections.push(
        '',
        `## メンションされたユーザー (${block.userId}) についての軽いメモリー`,
        ...block.lines
      );
    }
  }

  if (context.memoryNote) {
    sections.push('', `[システム: ${context.memoryNote}]`);
  }

  sections.push(
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
  );

  return sections.join('\n');
}

function buildCompactUserPrompt({ message }) {
  const requestAuthor = message.member?.displayName || message.author?.globalName || message.author?.username || '不明なユーザー';
  const requestText = String(message.content || '').trim() || '(本文なし)';

  return [
    `${requestAuthor} さんへの短い返信を日本語で作成してください。`,
    '簡潔で自然に返答してください。',
    '',
    `ユーザー入力: ${requestText}`
  ].join('\n');
}

function buildOllamaMessages({ message, context, shortRequestMode = false }) {
  return [
    {
      role: 'system',
      content: buildSystemPrompt()
    },
    {
      role: 'user',
      content: shortRequestMode
        ? buildCompactUserPrompt({ message })
        : buildUserPrompt({ message, context })
    }
  ];
}

function buildCasualOllamaMessages({ message }) {
  const requestAuthor = message.member?.displayName || message.author?.globalName || message.author?.username || '不明なユーザー';
  const requestText = String(message.content || '').trim() || '(本文なし)';

  return [
    {
      role: 'system',
      content: [
        'あなたは Otaku Assistant です。',
        '日本語で短く自然に返信してください。1文だけで十分です。',
        '重要なルール:',
        '- 「入ってくる」「食べてくる」などは今からすることを表します。完了したとみなしてはいけません。',
        '- 「好き」「習慣」「性格」などは、明示的に書かれていない限り推測してはいけません。',
        '- 文脈に書かれていないことを付け加えてはいけません。',
        '- 長い説明や分析は不要です。短く自然に返すだけでよいです。',
        '- 状況報告には短い相槌や声かけで十分です。過去の会話を参照しないでください。'
      ].join('\n')
    },
    {
      role: 'user',
      content: `${requestAuthor}: ${requestText}`
    }
  ];
}

module.exports = {
  buildOllamaMessages,
  buildCasualOllamaMessages
};
