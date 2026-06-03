const fs = require('node:fs');
const path = require('node:path');
const { ACCENT_COLORS } = require('../../utils/accentColors');

const DEFAULT_GUIDE_SOURCE_PATH = path.resolve(process.cwd(), 'content', 'entranceGuide.md');

const GUIDE_COLORS = {
  important: ACCENT_COLORS.important,
  normal: ACCENT_COLORS.guide
};

const ROOT_SECTION_DEFINITIONS = [
  {
    key: 'intro',
    title: '案内',
    aliases: [
      '案内',
      'はじめに',
      'はじめにお読みください',
      '全てのチャンネルを表示してください',
      '左上のパソコン映像クラブを押して'
    ]
  },
  {
    key: 'overview',
    title: 'サーバー概要・理念',
    aliases: ['サーバー概要理念', 'パソコン映像クラブについて']
  },
  {
    key: 'map',
    title: 'サーバーマップ',
    aliases: ['サーバーマップ']
  },
  {
    key: 'features',
    title: 'サーバー独自機能の案内',
    aliases: ['サーバー独自機能の案内', 'サーバー独自機能について']
  },
  {
    key: 'vc-profile',
    title: 'VCプロフィール機能と自己紹介のお願い',
    aliases: ['vcプロフィール機能と自己紹介のお願い', 'vcプロフィール機能について']
  },
  {
    key: 'rules',
    title: 'ロール・招待・禁止事項',
    aliases: ['ロール招待禁止事項', 'ロール招待禁止事項について']
  }
];

const GUIDE_CARD_DEFINITIONS = [
  {
    key: 'intro',
    title: 'はじめにこれだけは読んで！！',
    color: GUIDE_COLORS.important,
    sourceKey: 'intro',
    body: ({ rootSection }) => stripLeadingMarkdownHeading(rootSection.body)
  },
  {
    key: 'overview',
    title: 'パソコン映像クラブについて',
    color: GUIDE_COLORS.normal,
    sourceKey: 'overview',
    body: ({ rootSection }) => rootSection.body
  },
  {
    key: 'map-information',
    title: 'サーバーマップ：インフォメーション',
    color: GUIDE_COLORS.normal,
    sourceKey: 'map',
    body: ({ subsections }) =>
      ensureBodyWithFallback(
        stripChannelReferenceBlocks(getSubsectionBody(subsections, ['インフォメーション'])),
        'サーバー参加直後に確認する入口まわりのチャンネルです。案内・お知らせ・自己紹介・welcome をここから確認してください。'
      )
  },
  {
    key: 'map-knowledge',
    title: 'サーバーマップ：知識',
    color: GUIDE_COLORS.normal,
    sourceKey: 'map',
    body: ({ subsections }) =>
      ensureBodyWithFallback(
        stripChannelReferenceBlocks(getSubsectionBody(subsections, ['知識'])),
        '制作に直接関係する技術だけでなく、あとから見返したい知識や発見を集めるカテゴリです。'
      )
  },
  {
    key: 'map-chat',
    title: 'サーバーマップ：雑談',
    color: GUIDE_COLORS.normal,
    sourceKey: 'map',
    body: ({ subsections }) =>
      ensureBodyWithFallback(
        stripChannelReferenceBlocks(getSubsectionBody(subsections, ['雑談'])),
        '雑談・宣伝・ゲームなど、気軽な交流に使うチャンネル群です。'
      )
  },
  {
    key: 'map-categories',
    title: 'サーバーマップ：カテゴリ別トーク',
    color: GUIDE_COLORS.normal,
    sourceKey: 'map',
    body: ({ subsections }) =>
      ensureBodyWithFallback(
        stripChannelReferenceBlocks(getSubsectionBody(subsections, ['カテゴリ別トーク'])),
        '分野ごとにカテゴリが分かれていて、雑談・チュートリアル共有・進捗報告・質問場所が並んでいます。'
      )
  },
  {
    key: 'map-voice',
    title: 'サーバーマップ：通話',
    color: GUIDE_COLORS.normal,
    sourceKey: 'map',
    body: ({ subsections }) =>
      ensureBodyWithFallback(
        stripChannelReferenceBlocks(getSubsectionBody(subsections, ['通話'])),
        '通話カテゴリには VC のほか、聞き専向けや音楽Bot操作用の補助チャンネルがあります。'
      )
  },
  {
    key: 'features-core',
    title: 'サーバー独自機能：タイムライン・つぶやき',
    color: GUIDE_COLORS.normal,
    sourceKey: 'features',
    body: ({ rootSection, subsections }) => mergeBodies([
      rootSection.lead,
      getSubsectionBody(subsections, ['タイムライン']),
      getSubsectionBody(subsections, ['つぶやきフォーラム'])
    ])
  },
  {
    key: 'features-tags',
    title: 'サーバー独自機能：良い映像 / 良い音楽',
    color: GUIDE_COLORS.normal,
    sourceKey: 'features',
    subsectionAliases: ['良い映像・良い音楽タグ']
  },
  {
    key: 'features-questions',
    title: 'サーバー独自機能：質問フォーラム',
    color: GUIDE_COLORS.normal,
    sourceKey: 'features',
    subsectionAliases: ['質問フォーラム']
  },
  {
    key: 'features-anime',
    title: 'サーバー独自機能：アニメ',
    color: GUIDE_COLORS.normal,
    sourceKey: 'features',
    subsectionAliases: ['アニメ機能']
  },
  {
    key: 'vc-profile',
    title: 'VCプロフィール機能と自己紹介のお願い',
    color: GUIDE_COLORS.normal,
    sourceKey: 'vc-profile',
    body: ({ rootSection }) => rootSection.body
  },
  {
    key: 'rules',
    title: 'ロール・招待・禁止事項',
    color: GUIDE_COLORS.normal,
    sourceKey: 'rules',
    body: ({ rootSection }) => rootSection.body
  }
];

function splitGuideSections(markdown) {
  const normalized = String(markdown || '').replace(/\r\n/g, '\n');
  const matches = [...normalized.matchAll(/^#\s+(.+)\n/gm)];
  const sections = [];

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const title = current[1].trim();
    const start = current.index + current[0].length;
    const end = next ? next.index : normalized.length;
    const body = normalized.slice(start, end).trim();
    sections.push({ title, body });
  }

  return sections;
}

function splitSubsections(body) {
  const normalized = String(body || '').replace(/\r\n/g, '\n');
  const matches = [...normalized.matchAll(/^##\s+(.+)\n/gm)];
  const leadEnd = matches[0] ? matches[0].index : normalized.length;
  const lead = normalized.slice(0, leadEnd).trim();
  const sections = [];

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const title = current[1].trim();
    const start = current.index + current[0].length;
    const end = next ? next.index : normalized.length;
    const subsectionBody = normalized.slice(start, end).trim();
    sections.push({ title, body: subsectionBody });
  }

  return { lead, sections };
}

function normalizeHeading(input) {
  return String(input || '')
    .normalize('NFKC')
    .replace(/^[\p{Z}\s\p{P}\p{S}]+/gu, '')
    .replace(/[「」『』（）()]/g, '')
    .replace(/\s+/gu, '')
    .trim()
    .toLowerCase();
}

function stripSectionWrapperFences(body) {
  const trimmed = String(body || '').trim();
  const lines = trimmed.split('\n');

  if (lines.length < 2) {
    return trimmed;
  }

  const firstLine = lines[0].trim();
  const lastLine = lines.at(-1).trim();

  if (/^```[a-zA-Z0-9_-]*$/.test(firstLine) && lastLine === '```') {
    return lines.slice(1, -1).join('\n').trim();
  }

  return trimmed;
}

function cleanDisplayedBody(body) {
  return stripSectionWrapperFences(body)
    .split('\n')
    .filter((line) => !/^---+$/.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripLeadingMarkdownHeading(body) {
  const normalized = String(body || '').replace(/\r\n/g, '\n');
  return cleanDisplayedBody(normalized.replace(/^##\s+/m, ''));
}

function mergeBodies(parts) {
  return cleanDisplayedBody(
    parts
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join('\n\n')
  );
}

function ensureBodyWithFallback(body, fallback) {
  const cleaned = cleanDisplayedBody(body);
  return cleaned || fallback;
}

function stripChannelReferenceBlocks(body) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  let skipDescriptionBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      skipDescriptionBlock = false;
      kept.push('');
      continue;
    }

    if (/^<#\d+>(\s*\/\s*<#\d+>)*$/.test(trimmed)) {
      skipDescriptionBlock = true;
      continue;
    }

    if (/^-\s+.*<#\d+>/.test(trimmed)) {
      continue;
    }

    if (skipDescriptionBlock) {
      continue;
    }

    kept.push(line);
  }

  return kept.join('\n');
}

function buildMissingSectionError(definition, sections) {
  const headings = sections.map((section) => `- ${section.title}`).join('\n') || '- (見出しなし)';
  return new Error(
    `${definition.title}セクションが見つかりませんでした。\n検出された見出し:\n${headings}`
  );
}

function findSectionByAlias(definition, sections, usedTitles) {
  const aliases = definition.aliases || [definition.title];

  for (const section of sections) {
    if (usedTitles.has(section.title)) {
      continue;
    }

    const normalizedTitle = normalizeHeading(section.title);
    const matchesAlias = aliases.some((alias) => {
      const normalizedAlias = normalizeHeading(alias);
      return normalizedTitle === normalizedAlias || normalizedTitle.includes(normalizedAlias);
    });

    if (matchesAlias) {
      return section;
    }
  }

  return null;
}

function loadRootSections(sourcePath = DEFAULT_GUIDE_SOURCE_PATH) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Entrance guide markdown not found: ${sourcePath}`);
  }

  const raw = fs.readFileSync(sourcePath, 'utf8');
  const parsedSections = splitGuideSections(raw);
  const usedTitles = new Set();
  const orderedFallback = parsedSections.slice(0, ROOT_SECTION_DEFINITIONS.length);

  return ROOT_SECTION_DEFINITIONS.map((definition) => {
    let matchedSection = findSectionByAlias(definition, parsedSections, usedTitles);

    if (!matchedSection) {
      matchedSection = orderedFallback.find((section) => !usedTitles.has(section.title)) || null;
    }

    if (!matchedSection) {
      throw buildMissingSectionError(definition, parsedSections);
    }

    usedTitles.add(matchedSection.title);

    const cleanedBody = cleanDisplayedBody(matchedSection.body);
    const { lead, sections } = splitSubsections(cleanedBody);

    return {
      ...definition,
      title: matchedSection.title,
      body: cleanedBody,
      lead: cleanDisplayedBody(lead),
      subsections: sections.map((section) => ({
        title: section.title,
        body: cleanDisplayedBody(section.body)
      }))
    };
  });
}

function getSubsectionBody(subsections, aliases) {
  const matched = findSubsection(subsections, aliases);
  return matched?.body || '';
}

function findSubsection(subsections, aliases = []) {
  for (const subsection of subsections) {
    const normalizedTitle = normalizeHeading(subsection.title);
    const matches = aliases.some((alias) => {
      const normalizedAlias = normalizeHeading(alias);
      return normalizedTitle === normalizedAlias || normalizedTitle.includes(normalizedAlias);
    });

    if (matches) {
      return subsection;
    }
  }

  return null;
}

function loadEntranceGuideCards(sourcePath = DEFAULT_GUIDE_SOURCE_PATH) {
  const rootSections = loadRootSections(sourcePath);
  const sectionMap = new Map(rootSections.map((section) => [section.key, section]));

  return GUIDE_CARD_DEFINITIONS.map((definition) => {
    const rootSection = sectionMap.get(definition.sourceKey);

    if (!rootSection) {
      throw new Error(`Guide source section not resolved: ${definition.sourceKey}`);
    }

    let body = '';

    if (typeof definition.body === 'function') {
      body = definition.body({ rootSection, subsections: rootSection.subsections });
    } else if (definition.subsectionAliases?.length) {
      const subsection = findSubsection(rootSection.subsections, definition.subsectionAliases);

      if (!subsection) {
        const headings = rootSection.subsections.map((entry) => `- ${entry.title}`).join('\n') || '- (小見出しなし)';
        throw new Error(
          `${definition.title}に対応する小見出しが見つかりませんでした。\n親セクション: ${rootSection.title}\n検出された小見出し:\n${headings}`
        );
      }

      body = subsection.body;
    } else {
      body = rootSection.body;
    }

    return {
      key: definition.key,
      title: definition.title,
      accentColor: definition.color,
      body: cleanDisplayedBody(body)
    };
  });
}

module.exports = {
  DEFAULT_GUIDE_SOURCE_PATH,
  GUIDE_COLORS,
  loadEntranceGuideCards
};
