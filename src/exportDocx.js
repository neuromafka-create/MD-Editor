import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun
} from 'docx';
import { marked } from 'marked';

const HEADING_LEVELS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6
};

function inlineToChildren(tokens = [], style = {}) {
  const children = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'escape':
        children.push(new TextRun({ text: token.text || '', ...style }));
        break;
      case 'strong':
        children.push(...inlineToChildren(token.tokens || [], { ...style, bold: true }));
        break;
      case 'em':
        children.push(...inlineToChildren(token.tokens || [], { ...style, italics: true }));
        break;
      case 'del':
        children.push(...inlineToChildren(token.tokens || [], { ...style, strike: true }));
        break;
      case 'codespan':
        children.push(new TextRun({
          text: token.text || '',
          font: 'Consolas',
          ...style
        }));
        break;
      case 'link': {
        const linkChildren = inlineToChildren(token.tokens || [], {
          ...style,
          color: '0563C1',
          underline: {}
        });
        children.push(new ExternalHyperlink({
          children: linkChildren.length
            ? linkChildren
            : [new TextRun({ text: token.href || '', color: '0563C1', underline: {} })],
          link: token.href || ''
        }));
        break;
      }
      case 'image':
        children.push(new TextRun({
          text: token.text ? `[${token.text}]` : '[изображение]',
          italics: true,
          color: '6B7280',
          ...style
        }));
        break;
      case 'br':
        children.push(new TextRun({ break: 1 }));
        break;
      case 'html': {
        const raw = String(token.text || token.raw || '');
        const sup = raw.match(/^<sup>([\s\S]*)<\/sup>$/i);
        const sub = raw.match(/^<sub>([\s\S]*)<\/sub>$/i);
        if (sup) {
          children.push(new TextRun({
            text: sup[1].replace(/<[^>]+>/g, ''),
            superScript: true,
            ...style
          }));
        } else if (sub) {
          children.push(new TextRun({
            text: sub[1].replace(/<[^>]+>/g, ''),
            subScript: true,
            ...style
          }));
        } else {
          children.push(new TextRun({
            text: raw.replace(/<[^>]+>/g, ''),
            ...style
          }));
        }
        break;
      }
      default:
        if (token.tokens) {
          children.push(...inlineToChildren(token.tokens, style));
        } else if (token.text) {
          children.push(new TextRun({ text: token.text, ...style }));
        } else if (token.raw) {
          children.push(new TextRun({ text: token.raw, ...style }));
        }
        break;
    }
  }

  return children;
}

function paragraphFromInline(tokens, options = {}) {
  const children = inlineToChildren(tokens);
  return new Paragraph({
    ...options,
    children: children.length ? children : [new TextRun('')]
  });
}

function codeParagraphs(text) {
  const lines = String(text || '').split('\n');
  return lines.map((line, index) => new Paragraph({
    spacing: { before: index === 0 ? 120 : 0, after: index === lines.length - 1 ? 120 : 0 },
    shading: { fill: 'F3F4F6' },
    children: [new TextRun({
      text: line.length ? line : ' ',
      font: 'Consolas',
      size: 20
    })]
  }));
}

function cellText(cell) {
  if (!cell) return '';
  if (typeof cell === 'string') return cell;
  if (cell.text) return cell.text;
  if (cell.tokens) {
    return cell.tokens.map((token) => token.text || token.raw || '').join('');
  }
  return '';
}

function convertList(token, depth = 0) {
  const paragraphs = [];
  const isOrdered = Boolean(token.ordered);
  const reference = isOrdered ? 'md-ordered' : 'md-bullets';

  for (const item of token.items || []) {
    const itemTokens = item.tokens || [];
    const inlineTokens = [];
    const nestedBlocks = [];

    for (const child of itemTokens) {
      if (child.type === 'paragraph' || child.type === 'text') {
        if (child.tokens) inlineTokens.push(...child.tokens);
        else if (child.text) inlineTokens.push({ type: 'text', text: child.text });
      } else if (child.type === 'list' || child.type === 'code') {
        nestedBlocks.push(child);
      } else if (child.tokens) {
        inlineTokens.push(...child.tokens);
      } else if (child.text) {
        inlineTokens.push({ type: 'text', text: child.text });
      }
    }

    paragraphs.push(paragraphFromInline(inlineTokens, {
      numbering: {
        reference,
        level: Math.min(depth, 4)
      },
      spacing: { after: 60 }
    }));

    for (const nested of nestedBlocks) {
      if (nested.type === 'list') {
        paragraphs.push(...convertList(nested, depth + 1));
      } else if (nested.type === 'code') {
        paragraphs.push(...codeParagraphs(nested.text));
      }
    }
  }

  return paragraphs;
}

function convertTokens(tokens, paragraphOptions = {}) {
  const children = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break;
      case 'heading':
        children.push(paragraphFromInline(token.tokens || [{ type: 'text', text: token.text || '' }], {
          heading: HEADING_LEVELS[token.depth] || HeadingLevel.HEADING_1,
          spacing: { before: 200, after: 120 },
          ...paragraphOptions
        }));
        break;
      case 'paragraph':
        children.push(paragraphFromInline(token.tokens || [{ type: 'text', text: token.text || '' }], {
          spacing: { after: 120 },
          ...paragraphOptions
        }));
        break;
      case 'list':
        children.push(...convertList(token));
        break;
      case 'code':
        children.push(...codeParagraphs(token.text));
        break;
      case 'blockquote':
        children.push(...convertTokens(token.tokens || [], {
          border: {
            left: {
              style: BorderStyle.SINGLE,
              size: 24,
              color: '9CA3AF',
              space: 8
            }
          },
          indent: { left: 360 },
          spacing: { after: 80 }
        }));
        break;
      case 'hr':
        children.push(new Paragraph({
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: 12,
              color: 'D1D5DB',
              space: 1
            }
          },
          spacing: { before: 120, after: 120 },
          children: []
        }));
        break;
      case 'html': {
        const text = String(token.text || token.raw || '').replace(/<[^>]+>/g, '').trim();
        if (text) {
          children.push(new Paragraph({
            children: [new TextRun(text)],
            spacing: { after: 120 },
            ...paragraphOptions
          }));
        }
        break;
      }
      case 'table': {
        if (token.header?.length) {
          children.push(new Paragraph({
            children: [new TextRun({
              text: token.header.map(cellText).join(' | '),
              bold: true,
              font: 'Consolas',
              size: 20
            })],
            spacing: { after: 40 },
            ...paragraphOptions
          }));
        }
        for (const row of token.rows || []) {
          children.push(new Paragraph({
            children: [new TextRun({
              text: row.map(cellText).join(' | '),
              font: 'Consolas',
              size: 20
            })],
            spacing: { after: 40 },
            ...paragraphOptions
          }));
        }
        break;
      }
      default:
        if (token.tokens) {
          children.push(...convertTokens(token.tokens, paragraphOptions));
        } else if (token.text) {
          children.push(new Paragraph({
            children: [new TextRun(token.text)],
            spacing: { after: 120 },
            ...paragraphOptions
          }));
        }
        break;
    }
  }

  return children;
}

function buildNumberingConfig() {
  const bulletLevels = Array.from({ length: 5 }, (_, level) => ({
    level,
    format: LevelFormat.BULLET,
    text: '•',
    alignment: AlignmentType.LEFT,
    style: {
      paragraph: {
        indent: { left: 720 + level * 360, hanging: 360 }
      }
    }
  }));

  const orderedLevels = Array.from({ length: 5 }, (_, level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: {
      paragraph: {
        indent: { left: 720 + level * 360, hanging: 360 }
      }
    }
  }));

  return [
    { reference: 'md-bullets', levels: bulletLevels },
    { reference: 'md-ordered', levels: orderedLevels }
  ];
}

/**
 * Convert markdown string to a DOCX file as Uint8Array.
 * @param {string} markdown
 * @param {{ title?: string }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function markdownToDocxBytes(markdown, options = {}) {
  const tokens = marked.lexer(markdown || '');
  let children = convertTokens(tokens);

  if (!children.length) {
    children = [new Paragraph({ children: [new TextRun('')] })];
  }

  const doc = new Document({
    creator: 'MD Editor',
    title: options.title || 'Document',
    numbering: {
      config: buildNumberingConfig()
    },
    sections: [{
      properties: {},
      children
    }]
  });

  // Browser-safe path (Vite / Tauri webview)
  if (typeof Packer.toBlob === 'function') {
    const blob = await Packer.toBlob(doc);
    return new Uint8Array(await blob.arrayBuffer());
  }

  const buffer = await Packer.toBuffer(doc);
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}
