const TOC_START = '<!-- TOC -->';
const TOC_END = '<!-- /TOC -->';
const TOC_TITLE = 'Оглавление';

/**
 * GitHub-like slug for heading anchors.
 * @param {string} text
 * @returns {string}
 */
export function slugifyHeading(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'section';
}

/**
 * Extract ATX headings from markdown, skipping fenced code blocks and existing TOC block.
 * @param {string} markdown
 * @param {{ skipTocBlock?: boolean }} [options]
 * @returns {{ level: number, text: string, lineIndex: number, charOffset: number, slug: string }[]}
 */
export function extractHeadings(markdown, { skipTocBlock = true } = {}) {
  const text = markdown || '';
  const lines = text.split('\n');
  const headings = [];
  const usedSlugs = new Map();
  let inFence = false;
  let inToc = false;
  let offset = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (skipTocBlock) {
      if (trimmed === TOC_START) {
        inToc = true;
        offset += line.length + 1;
        continue;
      }
      if (inToc) {
        if (trimmed === TOC_END) inToc = false;
        offset += line.length + 1;
        continue;
      }
    }

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      offset += line.length + 1;
      continue;
    }

    if (!inFence) {
      const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (match) {
        const title = match[2].replace(/\s+#+\s*$/, '').trim();
        if (title === TOC_TITLE) {
          offset += line.length + 1;
          continue;
        }

        const baseSlug = slugifyHeading(title);
        const count = usedSlugs.get(baseSlug) || 0;
        usedSlugs.set(baseSlug, count + 1);
        const slug = count === 0 ? baseSlug : `${baseSlug}-${count}`;

        headings.push({
          level: match[1].length,
          text: title,
          lineIndex: i,
          charOffset: offset,
          slug
        });
      }
    }

    offset += line.length + 1;
  }

  return headings;
}

/**
 * Build markdown TOC block with HTML comment markers.
 * @param {string} markdown
 * @param {{ minLevel?: number, maxLevel?: number, title?: string }} [options]
 * @returns {string}
 */
export function buildTocBlock(markdown, {
  minLevel = 1,
  maxLevel = 4,
  title = TOC_TITLE
} = {}) {
  const headings = extractHeadings(markdown, { skipTocBlock: true })
    .filter((item) => item.level >= minLevel && item.level <= maxLevel);

  const lines = [TOC_START, `## ${title}`, ''];

  if (!headings.length) {
    lines.push('_В документе пока нет заголовков._');
  } else {
    const baseLevel = Math.min(...headings.map((item) => item.level));
    for (const item of headings) {
      const depth = Math.max(0, item.level - baseLevel);
      const indent = '  '.repeat(depth);
      const label = item.text.replace(/\[/g, '\\[').replace(/]/g, '\\]');
      lines.push(`${indent}- [${label}](#${item.slug})`);
    }
  }

  lines.push('');
  lines.push(TOC_END);
  return lines.join('\n');
}

/**
 * Insert TOC at start or replace existing TOC block.
 * @param {string} markdown
 * @returns {{ content: string, updated: boolean, start: number, end: number }}
 */
export function insertOrUpdateToc(markdown) {
  const text = markdown || '';
  const block = buildTocBlock(text);
  const startIdx = text.indexOf(TOC_START);
  const endIdx = text.indexOf(TOC_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    let replaceEnd = endIdx + TOC_END.length;
    while (text[replaceEnd] === '\n') replaceEnd += 1;
    const content = `${text.slice(0, startIdx)}${block}\n\n${text.slice(replaceEnd)}`;
    return {
      content,
      updated: true,
      start: startIdx,
      end: startIdx + block.length
    };
  }

  let insertAt = 0;
  if (text.startsWith('---\n')) {
    const fmEnd = text.indexOf('\n---\n', 4);
    if (fmEnd !== -1) insertAt = fmEnd + 5;
  }

  const prefix = text.slice(0, insertAt).replace(/\n*$/, '');
  const suffix = text.slice(insertAt).replace(/^\n*/, '');
  const content = prefix
    ? `${prefix}\n\n${block}\n\n${suffix}`
    : `${block}\n\n${suffix}`;

  return {
    content,
    updated: false,
    start: content.indexOf(TOC_START),
    end: content.indexOf(TOC_END) + TOC_END.length
  };
}

export function findTocRange(markdown) {
  const text = markdown || '';
  const start = text.indexOf(TOC_START);
  const endMarker = text.indexOf(TOC_END);
  if (start === -1 || endMarker === -1 || endMarker < start) return null;
  return { start, end: endMarker + TOC_END.length };
}

export { TOC_START, TOC_END, TOC_TITLE };
