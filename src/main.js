import './style.css';
import 'highlight.js/styles/github-dark.css';
import { marked } from 'marked';
import hljs from 'highlight.js';
import { markdownToDocxBytes } from './exportDocx.js';
import { extractHeadings, insertOrUpdateToc, findTocRange } from './toc.js';

marked.use({
  extensions: [{
    name: 'highlight',
    level: 'inline',
    start(src) { return src.indexOf('=='); },
    tokenizer(src) {
      const match = src.match(/^==([^=]+)==/);
      if (match) {
        return {
          type: 'highlight',
          raw: match[0],
          tokens: this.lexer.inlineTokens(match[1])
        };
      }
    },
    renderer(token) {
      return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
    }
  }],
  renderer: {
    code({ text, lang }) {
      const language = lang?.trim().split(/\s+/)[0] || '';
      let highlighted;
      if (language && hljs.getLanguage(language)) {
        highlighted = hljs.highlight(text, { language }).value;
      } else {
        highlighted = hljs.highlightAuto(text).value;
      }
      return `<pre><code class="language-${language}">${highlighted}</code></pre>`;
    }
  }
});

const DEFAULT_CONTENT = '# Заголовок\n\nНачните писать...';
const DEFAULT_TITLE = 'Новый';
const MAX_HISTORY = 100;
const SESSION_KEY = 'md-editor-session';
const AUTOSAVE_INTERVAL = 3000;

/** @type {{ id: string, title: string, content: string, dirty: boolean, filePath: string|null, fileHandle: FileSystemFileHandle|null, history: object[], redoStack: object[], selectionStart: number, selectionEnd: number, scrollTop: number }[]} */
let tabs = [];
let activeTabId = null;
let autosaveTimer = null;
const tabUsageOrder = [];

function trackTabUsage(id) {
  const idx = tabUsageOrder.indexOf(id);
  if (idx !== -1) tabUsageOrder.splice(idx, 1);
  tabUsageOrder.push(id);
}

const MARKDOWN_ACCEPT = {
  'text/markdown': ['.md', '.markdown', '.mdown'],
  'text/plain': ['.txt']
};

function createTabId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getActiveTab() {
  return tabs.find((tab) => tab.id === activeTabId) || null;
}

function createTabState(content = DEFAULT_CONTENT, title = DEFAULT_TITLE) {
  return {
    id: createTabId(),
    title,
    content,
    dirty: false,
    filePath: null,
    fileHandle: null,
    history: [],
    redoStack: [],
    selectionStart: 0,
    selectionEnd: 0,
    scrollTop: 0
  };
}

/* ——— Session autosave / restore ——— */
function saveSession() {
  const serializable = tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    content: tab.content,
    dirty: tab.dirty,
    filePath: tab.filePath,
    selectionStart: tab.selectionStart,
    selectionEnd: tab.selectionEnd,
    scrollTop: tab.scrollTop
  }));
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ tabs: serializable, activeTabId }));
  } catch {
    // localStorage full — silently ignore
  }
}

function restoreSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data?.tabs?.length) return false;

    tabs = data.tabs.map((saved) => {
      const tab = createTabState(saved.content, saved.title);
      tab.id = saved.id;
      tab.dirty = saved.dirty;
      tab.filePath = saved.filePath;
      tab.selectionStart = saved.selectionStart || 0;
      tab.selectionEnd = saved.selectionEnd || 0;
      tab.scrollTop = saved.scrollTop || 0;
      ensureHistorySeed(tab, tab.content);
      return tab;
    });
    activeTabId = data.activeTabId || tabs[0]?.id || null;
    return true;
  } catch {
    return false;
  }
}

function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    const markdownInput = document.getElementById('markdownInput');
    if (markdownInput) persistActiveTabFromEditor(markdownInput);
    saveSession();
  }, AUTOSAVE_INTERVAL);
}

function isTauriRuntime() {
  return Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
}

async function tauriInvoke(command, args = {}) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}

function basename(pathOrName) {
  if (!pathOrName) return DEFAULT_TITLE;
  const parts = String(pathOrName).split(/[/\\]/);
  return parts[parts.length - 1] || DEFAULT_TITLE;
}

function defaultMarkdownName(tab) {
  if (tab?.title && tab.title !== DEFAULT_TITLE) return tab.title.endsWith('.md') ? tab.title : `${tab.title}.md`;
  return 'document.md';
}

async function ensureFileHandlePermission(handle, mode = 'readwrite') {
  if (!handle?.queryPermission || !handle?.requestPermission) return true;
  const options = { mode };
  if ((await handle.queryPermission(options)) === 'granted') return true;
  return (await handle.requestPermission(options)) === 'granted';
}

async function writeToFileHandle(handle, content) {
  const permitted = await ensureFileHandlePermission(handle, 'readwrite');
  if (!permitted) {
    throw new Error('Нет разрешения на запись в файл');
  }
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

function markTabSaved(tab, { title, filePath, fileHandle } = {}) {
  if (!tab) return;
  tab.dirty = false;
  if (title) tab.title = title;
  if (filePath !== undefined) tab.filePath = filePath;
  if (fileHandle !== undefined) tab.fileHandle = fileHandle;
  renderTabs();
  updateTitle();
  saveSession();
}

function reportFileError(action, error) {
  console.error(action, error);
  const message = error?.message || String(error);
  window.alert(`${action}: ${message}`);
}

function renderPreview(markdownInput, previewOutput) {
  const content = markdownInput.value || '';
  previewOutput.innerHTML = marked.parse(content);
  applyHeadingAnchors(previewOutput, content);
  addCopyButtonsToCodeBlocks(previewOutput);
  enhancePreviewTocLinks(previewOutput);
}

function applyHeadingAnchors(previewOutput, markdown) {
  if (!previewOutput) return;
  const headingEls = previewOutput.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const slugQueue = extractHeadings(markdown, { skipTocBlock: true }).map((item) => item.slug);
  let slugIndex = 0;

  headingEls.forEach((el) => {
    const text = (el.textContent || '').trim();
    if (text === 'Оглавление') {
      el.id = 'оглавление';
      return;
    }
    if (slugIndex < slugQueue.length) {
      el.id = slugQueue[slugIndex];
      slugIndex += 1;
    } else {
      el.id = text.toLowerCase().replace(/\s+/g, '-') || `heading-${slugIndex}`;
    }
  });
}

function enhancePreviewTocLinks(previewOutput) {
  if (!previewOutput) return;
  previewOutput.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (event) => {
      const href = anchor.getAttribute('href') || '';
      const id = decodeURIComponent(href.slice(1));
      if (!id) return;
      const target = previewOutput.querySelector(`#${CSS.escape(id)}`);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.classList.add('toc-target-flash');
      setTimeout(() => target.classList.remove('toc-target-flash'), 1200);
    });
  });
}

function renderOutline(markdownInput) {
  const nav = document.getElementById('outlineNav');
  const empty = document.getElementById('outlineEmpty');
  if (!nav) return;

  const headings = extractHeadings(markdownInput?.value || '', { skipTocBlock: true });
  nav.innerHTML = '';

  if (!headings.length) {
    if (empty) empty.hidden = false;
    nav.hidden = true;
    return;
  }

  if (empty) empty.hidden = true;
  nav.hidden = false;

  const baseLevel = Math.min(...headings.map((item) => item.level));
  const fragment = document.createDocumentFragment();

  headings.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `outline-item outline-level-${item.level}`;
    button.dataset.lineIndex = String(item.lineIndex);
    button.dataset.charOffset = String(item.charOffset);
    button.dataset.slug = item.slug;
    button.dataset.index = String(index);
    button.style.setProperty('--outline-depth', String(item.level - baseLevel));
    button.title = item.text;

    const level = document.createElement('span');
    level.className = 'outline-item-level';
    level.textContent = `H${item.level}`;

    const label = document.createElement('span');
    label.className = 'outline-item-label';
    label.textContent = item.text;

    button.appendChild(level);
    button.appendChild(label);
    fragment.appendChild(button);
  });

  nav.appendChild(fragment);
  updateOutlineActive(markdownInput);
}

function updateOutlineActive(markdownInput) {
  const nav = document.getElementById('outlineNav');
  if (!nav || !markdownInput) return;

  const headings = extractHeadings(markdownInput.value || '', { skipTocBlock: true });
  if (!headings.length) return;

  const cursor = markdownInput.selectionStart ?? 0;
  let activeIndex = 0;
  for (let i = 0; i < headings.length; i += 1) {
    if (headings[i].charOffset <= cursor) activeIndex = i;
    else break;
  }

  nav.querySelectorAll('.outline-item').forEach((item, index) => {
    item.classList.toggle('is-active', index === activeIndex);
  });
}

function jumpToHeading(markdownInput, previewOutput, heading) {
  if (!markdownInput || !heading) return;

  const text = markdownInput.value || '';
  const lineStart = heading.charOffset;
  const lineEnd = text.indexOf('\n', lineStart);
  const end = lineEnd === -1 ? text.length : lineEnd;

  markdownInput.focus();
  markdownInput.setSelectionRange(lineStart, end);

  // Approximate line height used by editor
  const lineHeight = 22;
  const targetScroll = Math.max(0, heading.lineIndex * lineHeight - markdownInput.clientHeight / 3);
  markdownInput.scrollTop = targetScroll;

  const lineNumbers = document.getElementById('lineNumbers');
  if (lineNumbers) lineNumbers.scrollTop = markdownInput.scrollTop;

  updateLineNumbers(markdownInput);
  updateCursorPosition(markdownInput);
  updateFormatToolbar(markdownInput);
  updateOutlineActive(markdownInput);

  if (previewOutput && heading.slug) {
    const target = previewOutput.querySelector(`#${CSS.escape(heading.slug)}`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.classList.add('toc-target-flash');
      setTimeout(() => target.classList.remove('toc-target-flash'), 1200);
    }
  }
}

function applyTocToDocument(markdownInput, previewOutput, { onlyUpdate = false } = {}) {
  if (!markdownInput) return;
  const current = markdownInput.value || '';
  const existing = findTocRange(current);

  if (onlyUpdate && !existing) {
    window.alert('Блок оглавления не найден. Сначала нажмите «Вставить».');
    return;
  }

  recordHistory(markdownInput);
  const result = insertOrUpdateToc(current);
  markdownInput.value = result.content;
  markdownInput.setSelectionRange(result.start, result.start);
  afterEdit(markdownInput, previewOutput);
  renderOutline(markdownInput);
  markdownInput.focus();
}

function setOutlineVisible(visible) {
  const layout = document.getElementById('editorLayout');
  const toggle = document.getElementById('outlineToggle');
  if (!layout) return;
  layout.classList.toggle('outline-collapsed', !visible);
  localStorage.setItem('md-editor-outline', visible ? '1' : '0');
  if (toggle) {
    toggle.classList.toggle('is-active', visible);
    toggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
  }
}

const SPLIT_STORAGE_KEY = 'md-editor-split';
const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;
const SPLIT_DEFAULT = 0.5;

function clampSplitRatio(ratio) {
  const value = Number(ratio);
  if (!Number.isFinite(value)) return SPLIT_DEFAULT;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
}

function isVerticalSplitLayout() {
  return window.matchMedia('(max-width: 960px)').matches;
}

function applySplitRatio(ratio) {
  const splitPanes = document.getElementById('splitPanes');
  const gutter = document.getElementById('splitGutter');
  if (!splitPanes) return;

  const safe = clampSplitRatio(ratio);
  const editorShare = safe;
  const previewShare = 1 - safe;

  splitPanes.style.setProperty('--split-editor', String(editorShare));
  splitPanes.style.setProperty('--split-preview', String(previewShare));

  if (gutter) {
    gutter.setAttribute('aria-valuenow', String(Math.round(safe * 100)));
    gutter.setAttribute(
      'aria-orientation',
      isVerticalSplitLayout() ? 'horizontal' : 'vertical'
    );
  }
}

function saveSplitRatio(ratio) {
  localStorage.setItem(SPLIT_STORAGE_KEY, String(clampSplitRatio(ratio)));
}

function loadSplitRatio() {
  return clampSplitRatio(localStorage.getItem(SPLIT_STORAGE_KEY) ?? SPLIT_DEFAULT);
}

function initSplitPane() {
  const splitPanes = document.getElementById('splitPanes');
  const gutter = document.getElementById('splitGutter');
  if (!splitPanes || !gutter) return;

  let ratio = loadSplitRatio();
  applySplitRatio(ratio);

  const stopDrag = (event) => {
    if (gutter.hasPointerCapture?.(event.pointerId)) {
      try {
        gutter.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    }
    gutter.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing-split');
    saveSplitRatio(ratio);
  };

  gutter.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const vertical = isVerticalSplitLayout();
    const rect = splitPanes.getBoundingClientRect();
    const size = vertical ? rect.height : rect.width;
    if (size <= 0) return;

    const startPos = vertical ? event.clientY : event.clientX;
    const startRatio = ratio;

    gutter.classList.add('is-dragging');
    document.body.classList.add('is-resizing-split');
    gutter.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      const currentPos = vertical ? moveEvent.clientY : moveEvent.clientX;
      const delta = currentPos - startPos;
      ratio = clampSplitRatio(startRatio + delta / size);
      applySplitRatio(ratio);
    };

    const onUp = (upEvent) => {
      gutter.removeEventListener('pointermove', onMove);
      gutter.removeEventListener('pointerup', onUp);
      gutter.removeEventListener('pointercancel', onUp);
      stopDrag(upEvent);
    };

    gutter.addEventListener('pointermove', onMove);
    gutter.addEventListener('pointerup', onUp);
    gutter.addEventListener('pointercancel', onUp);
  });

  gutter.addEventListener('dblclick', () => {
    ratio = SPLIT_DEFAULT;
    applySplitRatio(ratio);
    saveSplitRatio(ratio);
  });

  gutter.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    let next = ratio;
    const vertical = isVerticalSplitLayout();

    if (event.key === 'ArrowLeft' || (vertical && event.key === 'ArrowUp')) {
      next = ratio - step;
    } else if (event.key === 'ArrowRight' || (vertical && event.key === 'ArrowDown')) {
      next = ratio + step;
    } else if (event.key === 'Home') {
      next = SPLIT_MIN;
    } else if (event.key === 'End') {
      next = SPLIT_MAX;
    } else if (event.key === 'Enter' || event.key === ' ') {
      next = SPLIT_DEFAULT;
    } else {
      return;
    }

    event.preventDefault();
    ratio = clampSplitRatio(next);
    applySplitRatio(ratio);
    saveSplitRatio(ratio);
  });

  window.addEventListener('resize', () => {
    applySplitRatio(ratio);
  });
}

function addCopyButtonsToCodeBlocks(previewOutput) {
  if (!previewOutput) return;
  const codeBlocks = previewOutput.querySelectorAll('pre');
  codeBlocks.forEach((pre) => {
    const code = pre.querySelector('code');
    if (code && !pre.querySelector('.code-lang-label')) {
      const cls = code.className || '';
      const match = cls.match(/language-(\S+)/);
      if (match) {
        const label = document.createElement('span');
        label.className = 'code-lang-label';
        label.textContent = match[1];
        pre.appendChild(label);
      }
    }
    if (!pre.querySelector('.copy-code-button')) {
      pre.classList.add('has-copy-button');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy-code-button';
      button.textContent = 'Copy';
      pre.insertBefore(button, pre.firstChild);
    }
  });
}

async function copyTextToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const success = document.execCommand('copy');
  document.body.removeChild(textarea);
  return success;
}

function updateTitle() {
  const tab = getActiveTab();
  const title = tab?.title || DEFAULT_TITLE;
  const dirtyMark = tab?.dirty ? ' •' : '';
  document.title = `MD Editor — ${title}${dirtyMark}`;
}

function applyTheme(theme, themeToggle) {
  document.body.setAttribute('data-theme', theme);
  localStorage.setItem('md-editor-theme', theme);
  if (themeToggle) {
    themeToggle.textContent = theme === 'light' ? 'Тёмная' : 'Светлая';
    themeToggle.title = theme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему';
  }
}

function snapshotEditor(markdownInput) {
  return {
    value: markdownInput.value,
    selectionStart: markdownInput.selectionStart,
    selectionEnd: markdownInput.selectionEnd
  };
}

function recordHistory(markdownInput) {
  const tab = getActiveTab();
  if (!tab) return;
  const state = snapshotEditor(markdownInput);
  const last = tab.history[tab.history.length - 1];
  if (!last || last.value !== state.value) {
    tab.history.push(state);
    if (tab.history.length > MAX_HISTORY) tab.history.shift();
  }
  tab.redoStack.length = 0;
}

function markDirty(markdownInput) {
  const tab = getActiveTab();
  if (!tab) return;
  tab.content = markdownInput.value;
  if (!tab.dirty) {
    tab.dirty = true;
    renderTabs();
    updateTitle();
  }
  scheduleAutosave();
}

function refreshEditorUi(markdownInput, previewOutput) {
  renderPreview(markdownInput, previewOutput);
  updateEditorStats(markdownInput);
  updateLineNumbers(markdownInput);
  updateCursorPosition(markdownInput);
  updateFormatToolbar(markdownInput);
  renderOutline(markdownInput);
}

function getLineBounds(text, pos) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
  let lineEnd = text.indexOf('\n', pos);
  if (lineEnd === -1) lineEnd = text.length;
  return {
    lineStart,
    lineEnd,
    line: text.slice(lineStart, lineEnd)
  };
}

function isInsideCodeFence(text, pos) {
  let inFence = false;
  let offset = 0;
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const trimmed = line.trimStart();
    const isFence = trimmed.startsWith('```') || trimmed.startsWith('~~~');

    if (isFence) {
      if (pos >= lineStart && pos <= lineEnd + (i < lines.length - 1 ? 1 : 0)) {
        return true;
      }
      inFence = !inFence;
    } else if (inFence && pos >= lineStart && pos <= lineEnd) {
      return true;
    }

    offset = lineEnd + 1;
  }

  return false;
}

/**
 * True if [start, end) is enclosed by a pair of `marker` delimiters
 * that do not themselves cross a blank line for multi-line safety.
 */
function isWrappedByMarker(text, start, end, marker) {
  if (!marker) return false;

  const immediateBefore = text.slice(Math.max(0, start - marker.length), start);
  const immediateAfter = text.slice(end, end + marker.length);
  if (immediateBefore === marker && immediateAfter === marker) {
    return true;
  }

  let from = 0;
  while (from < start) {
    const openIdx = text.indexOf(marker, from);
    if (openIdx === -1 || openIdx >= start) break;

    // Skip if this is part of a longer run of the same character (e.g. *** for **)
    const nextChar = text[openIdx + marker.length];
    if (marker.length === 1 && nextChar === marker) {
      from = openIdx + 1;
      continue;
    }

    const closeIdx = text.indexOf(marker, openIdx + marker.length);
    if (closeIdx === -1) break;

    const closeNext = text[closeIdx + marker.length];
    if (marker.length === 1 && closeNext === marker) {
      from = openIdx + 1;
      continue;
    }

    if (openIdx < start && closeIdx >= end) {
      const between = text.slice(openIdx + marker.length, closeIdx);
      // Inline markers should not span multiple paragraphs
      if (!between.includes('\n\n')) {
        return true;
      }
    }

    from = openIdx + 1;
  }

  return false;
}

function isWrappedByBold(text, start, end) {
  return isWrappedByMarker(text, start, end, '**') || isWrappedByMarker(text, start, end, '__');
}

function isWrappedByItalic(text, start, end) {
  // Prefer dedicated single-marker italics; avoid counting bold ** as italic
  if (isWrappedByMarker(text, start, end, '*') || isWrappedByMarker(text, start, end, '_')) {
    return true;
  }
  // Inside bold+italic ***text*** — still treat as italic-ish if * wrapping exists
  return false;
}

function isInsideInlineCode(text, start, end) {
  // Triple backticks are code fences — handled separately
  if (isInsideCodeFence(text, start)) return false;

  let from = 0;
  while (from < start) {
    const openIdx = text.indexOf('`', from);
    if (openIdx === -1 || openIdx >= start) break;

    // Skip fence-like runs
    if (text.startsWith('```', openIdx)) {
      from = openIdx + 3;
      continue;
    }

    const closeIdx = text.indexOf('`', openIdx + 1);
    if (closeIdx === -1) break;
    if (text.startsWith('```', closeIdx)) {
      from = openIdx + 1;
      continue;
    }

    if (openIdx < start && closeIdx >= end) {
      const between = text.slice(openIdx + 1, closeIdx);
      if (!between.includes('\n')) {
        return true;
      }
    }
    from = openIdx + 1;
  }
  return false;
}

function isInsideLinkOrImage(text, start, end) {
  // Match [label](url) or ![alt](url) spanning the caret/selection
  const windowStart = Math.max(0, start - 400);
  const windowEnd = Math.min(text.length, end + 400);
  const slice = text.slice(windowStart, windowEnd);
  const offset = windowStart;
  const pattern = /(!?\[[^\]]*]\([^)]*\))/g;
  let match = pattern.exec(slice);
  let image = false;
  let link = false;

  while (match) {
    const matchStart = offset + match.index;
    const matchEnd = matchStart + match[0].length;
    if (matchStart <= start && matchEnd >= end) {
      if (match[0].startsWith('!')) image = true;
      else link = true;
    }
    match = pattern.exec(slice);
  }

  return { link, image };
}

function detectActiveFormats(markdownInput) {
  const text = markdownInput.value || '';
  const start = markdownInput.selectionStart ?? 0;
  const end = markdownInput.selectionEnd ?? start;
  const caret = start;
  const { line } = getLineBounds(text, caret);

  const headingMatch = line.match(/^(#{1,6})\s+/);
  const heading = headingMatch ? headingMatch[1].length : 0;

  const unorderedList = /^\s*[-*+]\s+/.test(line);
  const orderedList = /^\s*\d+\.\s+/.test(line);
  const quote = /^\s*>\s?/.test(line);
  const hr = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
  const codeBlock = isInsideCodeFence(text, caret);

  const rangeStart = Math.min(start, end);
  const rangeEnd = Math.max(start, end);

  // For empty selection, treat a single caret position
  const probeEnd = rangeStart === rangeEnd ? rangeStart : rangeEnd;

  const bold = !codeBlock && isWrappedByBold(text, rangeStart, probeEnd);
  const italic = !codeBlock && isWrappedByItalic(text, rangeStart, probeEnd);
  const inlineCode = !codeBlock && isInsideInlineCode(text, rangeStart, probeEnd);
  const superscript = !codeBlock && isInsideHtmlTag(text, rangeStart, probeEnd, 'sup');
  const subscript = !codeBlock && isInsideHtmlTag(text, rangeStart, probeEnd, 'sub');
  const { link, image } = codeBlock
    ? { link: false, image: false }
    : isInsideLinkOrImage(text, rangeStart, probeEnd);

  return {
    bold,
    italic,
    inlineCode,
    superscript,
    subscript,
    heading,
    unorderedList: unorderedList && !orderedList,
    orderedList,
    quote,
    codeBlock,
    link,
    image,
    hr
  };
}

function setButtonActive(button, active) {
  if (!button) return;
  button.classList.toggle('is-active', Boolean(active));
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
}

function updateFormatToolbar(markdownInput) {
  if (!markdownInput) return;
  const formats = detectActiveFormats(markdownInput);

  setButtonActive(document.getElementById('boldButton'), formats.bold);
  setButtonActive(document.getElementById('italicButton'), formats.italic);
  setButtonActive(document.getElementById('inlineCodeButton'), formats.inlineCode);
  setButtonActive(document.getElementById('superscriptButton'), formats.superscript);
  setButtonActive(document.getElementById('subscriptButton'), formats.subscript);
  setButtonActive(document.getElementById('heading1Button'), formats.heading === 1);
  setButtonActive(document.getElementById('heading2Button'), formats.heading === 2);
  setButtonActive(document.getElementById('heading3Button'), formats.heading === 3);
  setButtonActive(document.getElementById('heading4Button'), formats.heading === 4);
  setButtonActive(document.getElementById('unorderedListButton'), formats.unorderedList);
  setButtonActive(document.getElementById('orderedListButton'), formats.orderedList);
  setButtonActive(document.getElementById('quoteButton'), formats.quote);
  setButtonActive(document.getElementById('codeButton'), formats.codeBlock);
  setButtonActive(document.getElementById('hrButton'), formats.hr);
  setButtonActive(document.getElementById('linkButton'), formats.link);
  setButtonActive(document.getElementById('imageButton'), formats.image);
}

function restoreHistory(markdownInput, previewOutput, state) {
  markdownInput.value = state.value;
  markdownInput.setSelectionRange(state.selectionStart, state.selectionEnd);
  markDirty(markdownInput);
  refreshEditorUi(markdownInput, previewOutput);
  markdownInput.focus();
}

function undoEdit(markdownInput, previewOutput) {
  const tab = getActiveTab();
  if (!tab || tab.history.length < 2) return;
  const current = tab.history.pop();
  tab.redoStack.push(current);
  const previous = tab.history[tab.history.length - 1];
  restoreHistory(markdownInput, previewOutput, previous);
  tab.content = markdownInput.value;
}

function redoEdit(markdownInput, previewOutput) {
  const tab = getActiveTab();
  if (!tab || !tab.redoStack.length) return;
  const next = tab.redoStack.pop();
  tab.history.push(next);
  restoreHistory(markdownInput, previewOutput, next);
  tab.content = markdownInput.value;
}

function getSelectionData(markdownInput) {
  const start = markdownInput.selectionStart;
  const end = markdownInput.selectionEnd;
  const value = markdownInput.value;
  return {
    start,
    end,
    before: value.slice(0, start),
    selected: value.slice(start, end),
    after: value.slice(end)
  };
}

function pushHistoryState(markdownInput) {
  const tab = getActiveTab();
  if (!tab) return;
  const state = snapshotEditor(markdownInput);
  const last = tab.history[tab.history.length - 1];
  if (!last || last.value !== state.value) {
    tab.history.push(state);
    if (tab.history.length > MAX_HISTORY) tab.history.shift();
  }
}

function afterEdit(markdownInput, previewOutput) {
  markDirty(markdownInput);
  pushHistoryState(markdownInput);
  refreshEditorUi(markdownInput, previewOutput);
}

function replaceSelection(markdownInput, previewOutput, beforeText, afterText, placeholder = 'текст') {
  recordHistory(markdownInput);
  const { start, before, selected, after } = getSelectionData(markdownInput);
  const text = selected || placeholder;
  markdownInput.value = `${before}${beforeText}${text}${afterText}${after}`;
  const selectionStart = start + beforeText.length;
  const selectionEnd = selectionStart + text.length;
  markdownInput.setSelectionRange(selectionStart, selectionEnd);
  afterEdit(markdownInput, previewOutput);
  markdownInput.focus();
}

function applyInlineFormat(markdownInput, previewOutput, marker, placeholder = 'текст') {
  recordHistory(markdownInput);
  const { start, end, before, selected, after } = getSelectionData(markdownInput);
  const value = markdownInput.value;
  const m = marker.length;
  const selStart = Math.min(start, end);
  const selEnd = Math.max(start, end);
  const ch = marker[0]; // '*' or '`' or '~' or '='

  // Search backwards from selStart: find opening marker
  let openIdx = -1;
  for (let i = selStart - 1; i >= m - 1; i--) {
    if (value.slice(i - m + 1, i + 1) === marker) {
      // Not part of a longer run of the same char
      if (value[i - m] !== ch && value[i + 1] !== ch) {
        openIdx = i - m + 1;
        break;
      }
    }
  }

  // Search forwards from selEnd: find closing marker
  let closeIdx = -1;
  if (openIdx !== -1) {
    for (let i = selEnd; i <= value.length - m; i++) {
      if (value.slice(i, i + m) === marker) {
        if (value[i - 1] !== ch && value[i + m] !== ch) {
          closeIdx = i;
          break;
        }
      }
    }
  }

  if (openIdx !== -1 && closeIdx !== -1) {
    // Toggle OFF: remove markers
    const inner = value.slice(openIdx + m, closeIdx);
    markdownInput.value = value.slice(0, openIdx) + inner + value.slice(closeIdx + m);
    markdownInput.setSelectionRange(selStart, selEnd);
  } else {
    // Toggle ON: wrap with marker
    const text = selected || placeholder;
    markdownInput.value = `${before}${marker}${text}${marker}${after}`;
    const selectionStart = start + m;
    const selectionEnd = selectionStart + text.length;
    markdownInput.setSelectionRange(selectionStart, selectionEnd);
  }
  afterEdit(markdownInput, previewOutput);
  markdownInput.focus();
}

function applyInlineCode(markdownInput, previewOutput) {
  recordHistory(markdownInput);
  const { start, end, before, selected, after } = getSelectionData(markdownInput);
  const marker = '`';
  const value = markdownInput.value;
  const m = marker.length;
  const ch = marker[0];
  const selStart = Math.min(start, end);
  const selEnd = Math.max(start, end);

  let openIdx = -1;
  for (let i = selStart - 1; i >= m - 1; i--) {
    if (value.slice(i - m + 1, i + 1) === marker) {
      if (value[i - m] !== ch && value[i + 1] !== ch) {
        openIdx = i - m + 1;
        break;
      }
    }
  }

  let closeIdx = -1;
  if (openIdx !== -1) {
    for (let i = selEnd; i <= value.length - m; i++) {
      if (value.slice(i, i + m) === marker) {
        if (value[i - 1] !== ch && value[i + m] !== ch) {
          closeIdx = i;
          break;
        }
      }
    }
  }

  if (openIdx !== -1 && closeIdx !== -1) {
    const inner = value.slice(openIdx + m, closeIdx);
    markdownInput.value = value.slice(0, openIdx) + inner + value.slice(closeIdx + m);
    markdownInput.setSelectionRange(selStart, selEnd);
  } else {
    const text = selected || 'код';
    markdownInput.value = `${before}${marker}${text}${marker}${after}`;
    markdownInput.setSelectionRange(start + m, start + m + text.length);
  }
  afterEdit(markdownInput, previewOutput);
  markdownInput.focus();
}

function applySuperscript(markdownInput, previewOutput) {
  replaceSelection(markdownInput, previewOutput, '<sup>', '</sup>', 'текст');
}

function applySubscript(markdownInput, previewOutput) {
  replaceSelection(markdownInput, previewOutput, '<sub>', '</sub>', 'текст');
}

function applyStrikethrough(markdownInput, previewOutput) {
  recordHistory(markdownInput);
  const { start, end, before, selected, after } = getSelectionData(markdownInput);
  const marker = '~~';
  const value = markdownInput.value;
  const m = marker.length;
  const ch = marker[0];
  const selStart = Math.min(start, end);
  const selEnd = Math.max(start, end);

  let openIdx = -1;
  for (let i = selStart - 1; i >= m - 1; i--) {
    if (value.slice(i - m + 1, i + 1) === marker) {
      if (value[i - m] !== ch && value[i + 1] !== ch) {
        openIdx = i - m + 1;
        break;
      }
    }
  }

  let closeIdx = -1;
  if (openIdx !== -1) {
    for (let i = selEnd; i <= value.length - m; i++) {
      if (value.slice(i, i + m) === marker) {
        if (value[i - 1] !== ch && value[i + m] !== ch) {
          closeIdx = i;
          break;
        }
      }
    }
  }

  if (openIdx !== -1 && closeIdx !== -1) {
    const inner = value.slice(openIdx + m, closeIdx);
    markdownInput.value = value.slice(0, openIdx) + inner + value.slice(closeIdx + m);
    markdownInput.setSelectionRange(selStart, selEnd);
  } else {
    const text = selected || 'текст';
    markdownInput.value = `${before}${marker}${text}${marker}${after}`;
    markdownInput.setSelectionRange(start + m, start + m + text.length);
  }
  afterEdit(markdownInput, previewOutput);
  markdownInput.focus();
}

function applyHighlight(markdownInput, previewOutput) {
  recordHistory(markdownInput);
  const { start, end, before, selected, after } = getSelectionData(markdownInput);
  const marker = '==';
  const value = markdownInput.value;
  const m = marker.length;
  const ch = marker[0];
  const selStart = Math.min(start, end);
  const selEnd = Math.max(start, end);

  let openIdx = -1;
  for (let i = selStart - 1; i >= m - 1; i--) {
    if (value.slice(i - m + 1, i + 1) === marker) {
      if (value[i - m] !== ch && value[i + 1] !== ch) {
        openIdx = i - m + 1;
        break;
      }
    }
  }

  let closeIdx = -1;
  if (openIdx !== -1) {
    for (let i = selEnd; i <= value.length - m; i++) {
      if (value.slice(i, i + m) === marker) {
        if (value[i - 1] !== ch && value[i + m] !== ch) {
          closeIdx = i;
          break;
        }
      }
    }
  }

  if (openIdx !== -1 && closeIdx !== -1) {
    const inner = value.slice(openIdx + m, closeIdx);
    markdownInput.value = value.slice(0, openIdx) + inner + value.slice(closeIdx + m);
    markdownInput.setSelectionRange(selStart, selEnd);
  } else {
    const text = selected || 'текст';
    markdownInput.value = `${before}${marker}${text}${marker}${after}`;
    markdownInput.setSelectionRange(start + m, start + m + text.length);
  }
  afterEdit(markdownInput, previewOutput);
  markdownInput.focus();
}

function applyTaskList(markdownInput, previewOutput) {
  recordHistory(markdownInput);
  const { start, before, selected, after } = getSelectionData(markdownInput);
  const content = selected || 'задача';
  const lines = content.split('\n');
  const formatted = lines.map((line) => `- [ ] ${line.replace(/^[-*]\s*\[.\]\s*/, '')}`).join('\n');
  markdownInput.value = `${before}${formatted}${after}`;
  markdownInput.setSelectionRange(start, start + formatted.length);
  afterEdit(markdownInput, previewOutput);
  markdownInput.focus();
}

function isInsideHtmlTag(text, start, end, tagName) {
  const open = `<${tagName}>`;
  const close = `</${tagName}>`;
  const openLower = open.toLowerCase();
  const closeLower = close.toLowerCase();
  const lower = text.toLowerCase();

  // Selection already wrapped: <sup>|text|</sup>
  const before = text.slice(Math.max(0, start - open.length), start);
  const after = text.slice(end, end + close.length);
  if (before.toLowerCase() === openLower && after.toLowerCase() === closeLower) {
    return true;
  }

  let from = 0;
  while (from < text.length) {
    const openIdx = lower.indexOf(openLower, from);
    if (openIdx === -1) break;
    const contentStart = openIdx + openLower.length;
    const closeIdx = lower.indexOf(closeLower, contentStart);
    if (closeIdx === -1) break;

    // Caret/selection inside the tag contents
    if (start >= contentStart && end <= closeIdx) {
      return true;
    }

    from = openIdx + 1;
  }

  return false;
}

function getCurrentLineIndex(markdownInput) {
  const cursorPos = markdownInput.selectionStart;
  const beforeCursor = markdownInput.value.slice(0, cursorPos);
  return beforeCursor.split('\n').length - 1;
}

function getCursorColumn(markdownInput) {
  const cursorPos = markdownInput.selectionStart;
  const beforeCursor = markdownInput.value.slice(0, cursorPos);
  const lineStart = beforeCursor.lastIndexOf('\n') + 1;
  return cursorPos - lineStart + 1;
}

function updateCursorPosition(markdownInput) {
  const cursorPosition = document.getElementById('cursorPosition');
  if (!cursorPosition) return;
  const line = getCurrentLineIndex(markdownInput) + 1;
  const column = getCursorColumn(markdownInput);
  cursorPosition.textContent = `Строка ${line}, позиция ${column}`;
}

function updateLineNumbers(markdownInput) {
  const lineNumbers = document.getElementById('lineNumbers');
  if (!lineNumbers) return;
  const lines = markdownInput.value.split('\n');
  const currentLine = getCurrentLineIndex(markdownInput);
  lineNumbers.innerHTML = lines
    .map((_, index) => `<span class="line-number${index === currentLine ? ' active' : ''}">${index + 1}</span>`)
    .join('');
}

async function copySelection(markdownInput) {
  const { selected } = getSelectionData(markdownInput);
  const text = selected || markdownInput.value;
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const start = markdownInput.selectionStart;
  const end = markdownInput.selectionEnd;
  markdownInput.select();
  document.execCommand('copy');
  markdownInput.setSelectionRange(start, end);
}

async function cutSelection(markdownInput) {
  const { start, end, before, selected, after } = getSelectionData(markdownInput);
  const text = selected || '';
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    markdownInput.setSelectionRange(start, end);
    document.execCommand('cut');
  }
  recordHistory(markdownInput);
  markdownInput.value = `${before}${after}`;
  markdownInput.setSelectionRange(start, start);
}

async function pasteClipboard(markdownInput, previewOutput) {
  let clipboardText = '';
  if (navigator.clipboard?.readText) {
    clipboardText = await navigator.clipboard.readText();
  } else {
    markdownInput.focus();
    document.execCommand('paste');
    return;
  }
  if (clipboardText == null) return;
  recordHistory(markdownInput);
  const { start, before, after } = getSelectionData(markdownInput);
  markdownInput.value = `${before}${clipboardText}${after}`;
  const pos = start + clipboardText.length;
  markdownInput.setSelectionRange(pos, pos);
  afterEdit(markdownInput, previewOutput);
}

function applyLinePrefix(markdownInput, previewOutput, prefix) {
  recordHistory(markdownInput);
  const { start, before, selected, after } = getSelectionData(markdownInput);
  const content = selected || 'текст';
  const lines = content.split('\n');
  const formatted = lines.map((line) => (line.startsWith(prefix) ? line : `${prefix}${line}`)).join('\n');
  markdownInput.value = `${before}${formatted}${after}`;
  markdownInput.setSelectionRange(start, start + formatted.length);
  afterEdit(markdownInput, previewOutput);
  markdownInput.focus();
}

function insertHorizontalRule(markdownInput, previewOutput) {
  recordHistory(markdownInput);
  const { start, before, selected, after } = getSelectionData(markdownInput);
  const content = selected || '';
  const rule = '---';
  markdownInput.value = `${before}${content ? `${content}\n\n${rule}` : `${rule}\n`}${after}`;
  const pos = start + (content ? content.length + 2 + rule.length : rule.length);
  markdownInput.setSelectionRange(pos, pos);
  afterEdit(markdownInput, previewOutput);
  markdownInput.focus();
}

function applyOrderedList(markdownInput, previewOutput) {
  recordHistory(markdownInput);
  const { start, before, selected, after } = getSelectionData(markdownInput);
  const content = selected || 'текст';
  const lines = content.split('\n');
  const formatted = lines.map((line, index) => `${index + 1}. ${line.replace(/^\s*\d+\.\s*/, '')}`).join('\n');
  markdownInput.value = `${before}${formatted}${after}`;
  markdownInput.setSelectionRange(start, start + formatted.length);
  afterEdit(markdownInput, previewOutput);
  markdownInput.focus();
}

function applyCodeBlock(markdownInput, previewOutput) {
  recordHistory(markdownInput);
  const { start, before, selected, after } = getSelectionData(markdownInput);
  const content = selected || 'код';
  const formatted = `\`\`\`\n${content}\n\`\`\``;
  markdownInput.value = `${before}${formatted}${after}`;
  markdownInput.setSelectionRange(start + 4, start + 4 + content.length);
  afterEdit(markdownInput, previewOutput);
  markdownInput.focus();
}

function insertImage(markdownInput, previewOutput) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result || '';
      const alt = file.name ? file.name.replace(/\.[^/.]+$/, '') : 'image';
      const { start, before, selected, after } = getSelectionData(markdownInput);
      const altText = selected || alt;
      const formatted = `![${altText}](${dataUrl})`;
      recordHistory(markdownInput);
      markdownInput.value = `${before}${formatted}${after}`;
      const pos = before.length + formatted.length;
      markdownInput.setSelectionRange(pos, pos);
      afterEdit(markdownInput, previewOutput);
      markdownInput.focus();
    };
    reader.readAsDataURL(file);
    if (input.parentNode) document.body.removeChild(input);
  }, { once: true });
  document.body.appendChild(input);
  input.click();
}

function applyHeading(markdownInput, previewOutput, level) {
  const prefix = '#'.repeat(level) + ' ';
  applyLinePrefix(markdownInput, previewOutput, prefix);
}

function insertLink(markdownInput, previewOutput) {
  const { start, before, selected, after } = getSelectionData(markdownInput);
  const text = selected || 'текст ссылки';
  const url = window.prompt('Вставьте URL', 'https://');
  if (!url) return;
  recordHistory(markdownInput);
  const formatted = `[${text}](${url})`;
  markdownInput.value = `${before}${formatted}${after}`;
  markdownInput.setSelectionRange(start + 1, start + 1 + text.length);
  afterEdit(markdownInput, previewOutput);
  markdownInput.focus();
}

function getTextStats(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const chars = text.length;
  return { words, chars };
}

function updateEditorStats(markdownInput) {
  const stats = getTextStats(markdownInput.value);
  const wordCount = document.getElementById('wordCount');
  const charCount = document.getElementById('charCount');
  if (wordCount) wordCount.textContent = `${stats.words} слов`;
  if (charCount) charCount.textContent = `${stats.chars} символов`;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 500);
}

function downloadFile(content, fileName, mimeType) {
  downloadBlob(new Blob([content], { type: mimeType }), fileName);
}

async function saveBinaryExport(bytes, fileName, {
  mimeType = 'application/octet-stream',
  filterName = 'File',
  extensions = ['bin'],
  dialogTitle = 'Сохранить файл',
  pickerTypes = null
} = {}) {
  if (isTauriRuntime()) {
    await tauriInvoke('save_bytes_file_as', {
      bytes: Array.from(bytes),
      defaultName: fileName,
      filterName,
      extensions,
      title: dialogTitle
    });
    return;
  }

  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: pickerTypes || [{
          description: filterName,
          accept: { [mimeType]: extensions.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`)) }
        }]
      });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
      throw error;
    }
  }

  downloadBlob(new Blob([bytes], { type: mimeType }), fileName);
}

function persistActiveTabFromEditor(markdownInput) {
  const tab = getActiveTab();
  if (!tab) return;
  tab.content = markdownInput.value;
  tab.selectionStart = markdownInput.selectionStart;
  tab.selectionEnd = markdownInput.selectionEnd;
  tab.scrollTop = markdownInput.scrollTop;
}

function renderTabs() {
  const tabList = document.getElementById('tabList');
  if (!tabList) return;
  tabList.innerHTML = '';

  tabs.forEach((tab) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `tab${tab.id === activeTabId ? ' active' : ''}${tab.dirty ? ' dirty' : ''}`;
    element.setAttribute('role', 'tab');
    element.setAttribute('aria-selected', tab.id === activeTabId ? 'true' : 'false');
    element.title = tab.title;

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title;

    const dirtyMark = document.createElement('span');
    dirtyMark.className = 'tab-dirty-mark';
    dirtyMark.setAttribute('aria-hidden', 'true');
    dirtyMark.title = 'Есть несохранённые изменения';

    if (tab.dirty) {
      element.setAttribute('aria-label', `${tab.title} (не сохранено)`);
    }

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.setAttribute('role', 'button');
    close.setAttribute('aria-label', `Закрыть ${tab.title}`);
    close.tabIndex = 0;
    close.textContent = '×';

    element.appendChild(title);
    element.appendChild(dirtyMark);
    element.appendChild(close);

    element.addEventListener('click', (event) => {
      if (event.target === close || close.contains(event.target)) return;
      activateTab(tab.id);
      trackTabUsage(tab.id);
    });

    const closeTab = (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeTabById(tab.id);
    };
    close.addEventListener('click', closeTab);
    close.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') closeTab(event);
    });

    tabList.appendChild(element);
  });
}

function loadTabIntoEditor(tab, markdownInput, previewOutput) {
  markdownInput.value = tab.content;
  markdownInput.setSelectionRange(tab.selectionStart, tab.selectionEnd);
  markdownInput.scrollTop = tab.scrollTop;
  const lineNumbers = document.getElementById('lineNumbers');
  if (lineNumbers) lineNumbers.scrollTop = tab.scrollTop;
  refreshEditorUi(markdownInput, previewOutput);
  updateTitle();
  updateSearchMatchInfo(markdownInput);
}

function activateTab(id) {
  const markdownInput = document.getElementById('markdownInput');
  const previewOutput = document.getElementById('previewOutput');
  if (!markdownInput || !previewOutput) return;

  if (activeTabId && activeTabId !== id) {
    persistActiveTabFromEditor(markdownInput);
  }

  const tab = tabs.find((item) => item.id === id);
  if (!tab) return;

  activeTabId = id;
  renderTabs();
  loadTabIntoEditor(tab, markdownInput, previewOutput);
  markdownInput.focus();
}

function ensureHistorySeed(tab, content) {
  if (!tab.history.length) {
    tab.history.push({
      value: content,
      selectionStart: 0,
      selectionEnd: 0
    });
  }
}

function openNewTab(
  content = DEFAULT_CONTENT,
  title = DEFAULT_TITLE,
  { dirty = false, filePath = null, fileHandle = null } = {}
) {
  const markdownInput = document.getElementById('markdownInput');
  if (markdownInput && activeTabId) {
    persistActiveTabFromEditor(markdownInput);
  }

  const tab = createTabState(content, title);
  tab.dirty = dirty;
  tab.filePath = filePath;
  tab.fileHandle = fileHandle;
  ensureHistorySeed(tab, content);
  tabs.push(tab);
  activeTabId = tab.id;
  trackTabUsage(tab.id);
  renderTabs();

  const previewOutput = document.getElementById('previewOutput');
  if (markdownInput && previewOutput) {
    loadTabIntoEditor(tab, markdownInput, previewOutput);
    markdownInput.focus();
  }
  return tab;
}

function closeTabById(id) {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return;

  const tab = tabs[index];
  if (tab.dirty) {
    const ok = window.confirm(`Закрыть «${tab.title}» без сохранения?`);
    if (!ok) return;
  }

  const wasActive = activeTabId === id;
  tabs.splice(index, 1);

  if (!tabs.length) {
    openNewTab();
    return;
  }

  if (wasActive) {
    const next = tabs[Math.min(index, tabs.length - 1)];
    activeTabId = next.id;
    renderTabs();
    const markdownInput = document.getElementById('markdownInput');
    const previewOutput = document.getElementById('previewOutput');
    if (markdownInput && previewOutput) {
      loadTabIntoEditor(next, markdownInput, previewOutput);
    }
  } else {
    renderTabs();
  }
}

async function openFileWithLegacyPicker() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.mdown,.txt';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.top = '0';
    input.addEventListener('change', async () => {
      const file = input.files?.[0] || null;
      if (input.parentNode) document.body.removeChild(input);
      resolve(file);
    }, { once: true });
    input.addEventListener('cancel', () => {
      if (input.parentNode) document.body.removeChild(input);
      resolve(null);
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

async function openFile() {
  try {
    if (isTauriRuntime()) {
      const result = await tauriInvoke('open_markdown_file');
      if (!result) return;
      openNewTab(result.content, basename(result.path), {
        dirty: false,
        filePath: result.path,
        fileHandle: null
      });
      return;
    }

    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{ description: 'Markdown', accept: MARKDOWN_ACCEPT }],
          excludeAcceptAllOption: false
        });
        const permitted = await ensureFileHandlePermission(handle, 'readwrite');
        if (!permitted) {
          throw new Error('Нет разрешения на доступ к файлу');
        }
        const file = await handle.getFile();
        const text = await file.text();
        openNewTab(text, handle.name || file.name || 'document.md', {
          dirty: false,
          filePath: null,
          fileHandle: handle
        });
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
        throw error;
      }
    }

    const file = await openFileWithLegacyPicker();
    if (!file) return;
    const text = await file.text();
    openNewTab(text, file.name || 'document.md', { dirty: false });
  } catch (error) {
    reportFileError('Не удалось открыть файл', error);
  }
}

async function saveFileAs(markdownInput) {
  const tab = getActiveTab();
  if (!tab) return false;
  persistActiveTabFromEditor(markdownInput);
  const content = markdownInput.value;
  const suggestedName = defaultMarkdownName(tab);

  try {
    if (isTauriRuntime()) {
      const path = await tauriInvoke('save_markdown_file_as', {
        content,
        defaultName: suggestedName
      });
      if (!path) return false;
      markTabSaved(tab, {
        title: basename(path),
        filePath: path,
        fileHandle: null
      });
      return true;
    }

    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: 'Markdown', accept: MARKDOWN_ACCEPT }]
        });
        await writeToFileHandle(handle, content);
        markTabSaved(tab, {
          title: handle.name || suggestedName,
          filePath: null,
          fileHandle: handle
        });
        return true;
      } catch (error) {
        if (error?.name === 'AbortError') return false;
        throw error;
      }
    }

    // Fallback: браузер без File System Access API
    downloadFile(content, suggestedName, 'text/markdown;charset=utf-8');
    markTabSaved(tab, { title: suggestedName });
    return true;
  } catch (error) {
    reportFileError('Не удалось сохранить файл', error);
    return false;
  }
}

async function saveFile(markdownInput) {
  const tab = getActiveTab();
  if (!tab) return false;
  persistActiveTabFromEditor(markdownInput);
  const content = markdownInput.value;

  try {
    // Обычное сохранение: перезапись уже привязанного файла без диалога
    if (isTauriRuntime() && tab.filePath) {
      await tauriInvoke('write_markdown_file', { path: tab.filePath, content });
      markTabSaved(tab);
      return true;
    }

    if (tab.fileHandle) {
      await writeToFileHandle(tab.fileHandle, content);
      markTabSaved(tab);
      return true;
    }

    // Новый/несвязанный документ → «Сохранить как…»
    return saveFileAs(markdownInput);
  } catch (error) {
    // Если handle/path недоступны — предложить сохранить как
    if (tab.fileHandle || tab.filePath) {
      const retry = window.confirm('Не удалось перезаписать файл. Сохранить как…?');
      if (retry) return saveFileAs(markdownInput);
    }
    reportFileError('Не удалось сохранить файл', error);
    return false;
  }
}

function exportBaseName(tab) {
  if (tab?.title && tab.title !== DEFAULT_TITLE) {
    return tab.title.replace(/\.[^/.]+$/, '');
  }
  return 'document';
}

async function exportHtml(markdownInput) {
  const tab = getActiveTab();
  if (!tab) return;
  persistActiveTabFromEditor(markdownInput);
  const fileName = `${exportBaseName(tab)}.html`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${tab.title || 'MD Editor'}</title></head><body>${marked.parse(markdownInput.value || '')}</body></html>`;

  try {
    if (isTauriRuntime()) {
      await tauriInvoke('save_html_file_as', {
        content: html,
        defaultName: fileName
      });
      return;
    }

    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: 'HTML', accept: { 'text/html': ['.html'] } }]
        });
        await writeToFileHandle(handle, html);
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
        throw error;
      }
    }

    downloadFile(html, fileName, 'text/html;charset=utf-8');
  } catch (error) {
    reportFileError('Не удалось экспортировать HTML', error);
  }
}

async function exportDocx(markdownInput) {
  const tab = getActiveTab();
  if (!tab) return;
  persistActiveTabFromEditor(markdownInput);
  const fileName = `${exportBaseName(tab)}.docx`;

  try {
    const bytes = await markdownToDocxBytes(markdownInput.value || '', {
      title: tab.title || 'Document'
    });
    await saveBinaryExport(bytes, fileName, {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filterName: 'Word Document',
      extensions: ['docx'],
      dialogTitle: 'Экспортировать в DOCX',
      pickerTypes: [{
        description: 'Word Document',
        accept: {
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
        }
      }]
    });
  } catch (error) {
    reportFileError('Не удалось экспортировать DOCX', error);
  }
}

function countMatches(text, query) {
  if (!query) return 0;
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(query, from);
    if (index === -1) break;
    count += 1;
    from = index + Math.max(query.length, 1);
  }
  return count;
}

function updateSearchMatchInfo(markdownInput) {
  const info = document.getElementById('searchMatchInfo');
  const searchInput = document.getElementById('searchInput');
  if (!info || !searchInput) return;
  const query = searchInput.value;
  if (!query) {
    info.textContent = '';
    return;
  }
  const total = countMatches(markdownInput.value, query);
  if (!total) {
    info.textContent = '0 / 0';
    return;
  }

  const cursor = markdownInput.selectionStart;
  let current = 0;
  let from = 0;
  let matchIndex = 0;
  while (from <= markdownInput.value.length) {
    const index = markdownInput.value.indexOf(query, from);
    if (index === -1) break;
    matchIndex += 1;
    if (index <= cursor && cursor <= index + query.length) {
      current = matchIndex;
      break;
    }
    if (index >= cursor && !current) {
      current = matchIndex;
      break;
    }
    from = index + Math.max(query.length, 1);
  }
  if (!current) current = total;
  info.textContent = `${current} / ${total}`;
}

function findNext(markdownInput, { wrap = true } = {}) {
  const searchInput = document.getElementById('searchInput');
  if (!searchInput) return false;
  const query = searchInput.value;
  if (!query) return false;

  const text = markdownInput.value;
  const from = markdownInput.selectionEnd;
  let index = text.indexOf(query, from);
  if (index === -1 && wrap) {
    index = text.indexOf(query, 0);
  }
  if (index === -1) {
    updateSearchMatchInfo(markdownInput);
    return false;
  }

  markdownInput.focus();
  markdownInput.setSelectionRange(index, index + query.length);
  const lineHeight = 22;
  const line = text.slice(0, index).split('\n').length - 1;
  markdownInput.scrollTop = Math.max(0, line * lineHeight - markdownInput.clientHeight / 2);
  updateLineNumbers(markdownInput);
  updateCursorPosition(markdownInput);
  updateFormatToolbar(markdownInput);
  updateSearchMatchInfo(markdownInput);
  return true;
}

function replaceOne(markdownInput, previewOutput) {
  const searchInput = document.getElementById('searchInput');
  const replaceInput = document.getElementById('replaceInput');
  if (!searchInput || !replaceInput) return;

  const query = searchInput.value;
  if (!query) return;

  const { start, end, before, selected, after } = getSelectionData(markdownInput);
  if (selected === query) {
    recordHistory(markdownInput);
    markdownInput.value = `${before}${replaceInput.value}${after}`;
    const pos = start + replaceInput.value.length;
    markdownInput.setSelectionRange(pos, pos);
    afterEdit(markdownInput, previewOutput);
    findNext(markdownInput);
    return;
  }

  if (findNext(markdownInput)) {
    // next match selected; user can press replace again
  }
}

function replaceAll(markdownInput, previewOutput) {
  const searchInput = document.getElementById('searchInput');
  const replaceInput = document.getElementById('replaceInput');
  if (!searchInput || !replaceInput) return;

  const query = searchInput.value;
  if (!query) return;

  const text = markdownInput.value;
  if (!text.includes(query)) {
    updateSearchMatchInfo(markdownInput);
    return;
  }

  recordHistory(markdownInput);
  const replacement = replaceInput.value;
  markdownInput.value = text.split(query).join(replacement);
  const pos = Math.min(markdownInput.selectionStart, markdownInput.value.length);
  markdownInput.setSelectionRange(pos, pos);
  afterEdit(markdownInput, previewOutput);
  updateSearchMatchInfo(markdownInput);
  markdownInput.focus();
}

window.addEventListener('DOMContentLoaded', () => {
  const markdownInput = document.getElementById('markdownInput');
  const previewOutput = document.getElementById('previewOutput');
  const themeToggle = document.getElementById('themeToggle');
  const undoButton = document.getElementById('undoButton');
  const redoButton = document.getElementById('redoButton');
  const boldButton = document.getElementById('boldButton');
  const italicButton = document.getElementById('italicButton');
  const inlineCodeButton = document.getElementById('inlineCodeButton');
  const superscriptButton = document.getElementById('superscriptButton');
  const subscriptButton = document.getElementById('subscriptButton');
  const heading1Button = document.getElementById('heading1Button');
  const heading2Button = document.getElementById('heading2Button');
  const heading3Button = document.getElementById('heading3Button');
  const heading4Button = document.getElementById('heading4Button');
  const unorderedListButton = document.getElementById('unorderedListButton');
  const orderedListButton = document.getElementById('orderedListButton');
  const quoteButton = document.getElementById('quoteButton');
  const codeButton = document.getElementById('codeButton');
  const hrButton = document.getElementById('hrButton');
  const copyButton = document.getElementById('copyButton');
  const cutButton = document.getElementById('cutButton');
  const pasteButton = document.getElementById('pasteButton');
  const imageButton = document.getElementById('imageButton');
  const linkButton = document.getElementById('linkButton');
  const newButton = document.getElementById('newButton');
  const openButton = document.getElementById('openButton');
  const saveButton = document.getElementById('saveButton');
  const saveAsButton = document.getElementById('saveAsButton');
  const exportButton = document.getElementById('exportButton');
  const exportDocxButton = document.getElementById('exportDocxButton');
  const outlineToggle = document.getElementById('outlineToggle');
  const insertTocButton = document.getElementById('insertTocButton');
  const refreshTocButton = document.getElementById('refreshTocButton');
  const outlineNav = document.getElementById('outlineNav');
  const searchInput = document.getElementById('searchInput');
  const replaceInput = document.getElementById('replaceInput');
  const findNextButton = document.getElementById('findNextButton');
  const replaceOneButton = document.getElementById('replaceOneButton');
  const replaceAllButton = document.getElementById('replaceAllButton');

  if (!markdownInput || !previewOutput) return;

  const savedTheme = localStorage.getItem('md-editor-theme') || 'dark';
  applyTheme(savedTheme, themeToggle);

  const outlineVisible = localStorage.getItem('md-editor-outline') !== '0';
  setOutlineVisible(outlineVisible);
  initSplitPane();

  const restored = restoreSession();
  if (restored) {
    renderTabs();
    const active = getActiveTab();
    if (active && markdownInput && previewOutput) {
      loadTabIntoEditor(active, markdownInput, previewOutput);
      trackTabUsage(active.id);
    }
  } else {
    openNewTab();
  }

  window.addEventListener('beforeunload', (event) => {
    const markdownInput = document.getElementById('markdownInput');
    if (markdownInput) persistActiveTabFromEditor(markdownInput);
    saveSession();
    const hasDirty = tabs.some((tab) => tab.dirty);
    if (hasDirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const nextTheme = document.body.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(nextTheme, themeToggle);
    });
  }

  if (undoButton) undoButton.addEventListener('click', () => undoEdit(markdownInput, previewOutput));
  if (redoButton) redoButton.addEventListener('click', () => redoEdit(markdownInput, previewOutput));
  if (boldButton) boldButton.addEventListener('click', () => applyInlineFormat(markdownInput, previewOutput, '**', 'жирный текст'));
  if (italicButton) italicButton.addEventListener('click', () => applyInlineFormat(markdownInput, previewOutput, '*', 'курсив'));
  if (inlineCodeButton) inlineCodeButton.addEventListener('click', () => applyInlineCode(markdownInput, previewOutput));
  if (superscriptButton) superscriptButton.addEventListener('click', () => applySuperscript(markdownInput, previewOutput));
  if (subscriptButton) subscriptButton.addEventListener('click', () => applySubscript(markdownInput, previewOutput));
  if (heading1Button) heading1Button.addEventListener('click', () => applyHeading(markdownInput, previewOutput, 1));
  if (heading2Button) heading2Button.addEventListener('click', () => applyHeading(markdownInput, previewOutput, 2));
  if (heading3Button) heading3Button.addEventListener('click', () => applyHeading(markdownInput, previewOutput, 3));
  if (heading4Button) heading4Button.addEventListener('click', () => applyHeading(markdownInput, previewOutput, 4));
  if (cutButton) {
    cutButton.addEventListener('click', async () => {
      await cutSelection(markdownInput);
      afterEdit(markdownInput, previewOutput);
    });
  }
  if (copyButton) copyButton.addEventListener('click', async () => await copySelection(markdownInput));
  if (pasteButton) pasteButton.addEventListener('click', async () => await pasteClipboard(markdownInput, previewOutput));
  if (unorderedListButton) unorderedListButton.addEventListener('click', () => applyLinePrefix(markdownInput, previewOutput, '- '));
  if (orderedListButton) orderedListButton.addEventListener('click', () => applyOrderedList(markdownInput, previewOutput));
  if (quoteButton) quoteButton.addEventListener('click', () => applyLinePrefix(markdownInput, previewOutput, '> '));
  if (codeButton) codeButton.addEventListener('click', () => applyCodeBlock(markdownInput, previewOutput));
  if (hrButton) hrButton.addEventListener('click', () => insertHorizontalRule(markdownInput, previewOutput));
  if (imageButton) imageButton.addEventListener('click', () => insertImage(markdownInput, previewOutput));
  if (linkButton) linkButton.addEventListener('click', () => insertLink(markdownInput, previewOutput));
  if (document.getElementById('strikethroughButton')) {
    document.getElementById('strikethroughButton').addEventListener('click', () => applyStrikethrough(markdownInput, previewOutput));
  }
  if (document.getElementById('highlightButton')) {
    document.getElementById('highlightButton').addEventListener('click', () => applyHighlight(markdownInput, previewOutput));
  }
  if (document.getElementById('taskListButton')) {
    document.getElementById('taskListButton').addEventListener('click', () => applyTaskList(markdownInput, previewOutput));
  }

  /* ——— View mode toggle ——— */
  const viewModes = ['both', 'editor-only', 'preview-only'];
  let viewModeIndex = 0;
  const viewModeToggle = document.getElementById('viewModeToggle');
  const splitPanes = document.getElementById('splitPanes');

  function applyViewMode() {
    if (!splitPanes) return;
    splitPanes.classList.remove('view-editor-only', 'view-preview-only');
    const mode = viewModes[viewModeIndex];
    if (mode === 'editor-only') splitPanes.classList.add('view-editor-only');
    else if (mode === 'preview-only') splitPanes.classList.add('view-preview-only');
    if (viewModeToggle) {
      const labels = { 'both': 'Вид', 'editor-only': 'Только ред.', 'preview-only': 'Только прев.' };
      viewModeToggle.textContent = labels[mode] || 'Вид';
    }
    localStorage.setItem('md-editor-view-mode', String(viewModeIndex));
  }

  if (viewModeToggle) {
    viewModeToggle.addEventListener('click', () => {
      viewModeIndex = (viewModeIndex + 1) % viewModes.length;
      applyViewMode();
    });
  }
  const savedViewMode = parseInt(localStorage.getItem('md-editor-view-mode') || '0', 10);
  if (savedViewMode >= 0 && savedViewMode < viewModes.length) viewModeIndex = savedViewMode;
  applyViewMode();

  /* ——— Fullscreen ——— */
  const fullscreenButton = document.getElementById('fullscreenButton');
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      document.body.classList.add('is-fullscreen');
    } else {
      document.exitFullscreen().catch(() => {});
      document.body.classList.remove('is-fullscreen');
    }
  }
  if (fullscreenButton) fullscreenButton.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) document.body.classList.remove('is-fullscreen');
  });

  /* ——— Auto-close brackets and quotes ——— */
  const AUTO_CLOSE_MAP = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
  markdownInput.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const close = AUTO_CLOSE_MAP[event.key];
    if (!close) return;
    const { start, end, selected } = getSelectionData(markdownInput);
    if (selected) return;
    event.preventDefault();
    markdownInput.value = markdownInput.value.slice(0, start) + event.key + close + markdownInput.value.slice(end);
    markdownInput.setSelectionRange(start + 1, start + 1);
    scheduleAutosave();
  });

  /* ——— Ctrl+Tab: MRU tab switching ——— */
  const originalActivateTab = activateTab;

  if (newButton) newButton.addEventListener('click', () => openNewTab());
  if (openButton) openButton.addEventListener('click', () => openFile());
  if (saveButton) saveButton.addEventListener('click', () => saveFile(markdownInput));
  if (saveAsButton) saveAsButton.addEventListener('click', () => saveFileAs(markdownInput));
  if (exportButton) exportButton.addEventListener('click', () => exportHtml(markdownInput));
  if (exportDocxButton) exportDocxButton.addEventListener('click', () => exportDocx(markdownInput));

  if (outlineToggle) {
    outlineToggle.addEventListener('click', () => {
      const layout = document.getElementById('editorLayout');
      const next = layout?.classList.contains('outline-collapsed');
      setOutlineVisible(Boolean(next));
    });
  }
  if (insertTocButton) {
    insertTocButton.addEventListener('click', () => {
      applyTocToDocument(markdownInput, previewOutput, { onlyUpdate: false });
    });
  }
  if (refreshTocButton) {
    refreshTocButton.addEventListener('click', () => {
      applyTocToDocument(markdownInput, previewOutput, { onlyUpdate: true });
    });
  }
  if (outlineNav) {
    outlineNav.addEventListener('click', (event) => {
      const item = event.target.closest('.outline-item');
      if (!item) return;
      const lineIndex = Number(item.dataset.lineIndex);
      const headings = extractHeadings(markdownInput.value || '', { skipTocBlock: true });
      const heading = headings.find((entry) => entry.lineIndex === lineIndex);
      if (heading) jumpToHeading(markdownInput, previewOutput, heading);
    });
  }

  if (findNextButton) findNextButton.addEventListener('click', () => findNext(markdownInput));
  if (replaceOneButton) replaceOneButton.addEventListener('click', () => replaceOne(markdownInput, previewOutput));
  if (replaceAllButton) replaceAllButton.addEventListener('click', () => replaceAll(markdownInput, previewOutput));

  if (searchInput) {
    searchInput.addEventListener('input', () => updateSearchMatchInfo(markdownInput));
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        findNext(markdownInput);
      }
    });
  }
  if (replaceInput) {
    replaceInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        replaceOne(markdownInput, previewOutput);
      }
    });
  }

  if (previewOutput) {
    previewOutput.addEventListener('click', async (event) => {
      const button = event.target.closest('.copy-code-button');
      if (!(button instanceof HTMLButtonElement)) return;
      const pre = button.closest('pre');
      if (!pre) return;
      const code = pre.querySelector('code');
      if (!code) return;
      const success = await copyTextToClipboard(code.innerText);
      button.textContent = success ? 'Copied' : 'Copy';
      if (success) {
        setTimeout(() => {
          button.textContent = 'Copy';
        }, 1200);
      }
    });
  }

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const inSearchField = target === searchInput || target === replaceInput;

    /* ——— Ctrl+Tab: MRU tab switching ——— */
    if ((event.ctrlKey || event.metaKey) && event.code === 'Tab' && !inSearchField) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (tabs.length > 1) {
        const currentIdx = tabUsageOrder.indexOf(activeTabId);
        const nextIdx = event.shiftKey
          ? (currentIdx - 1 + tabUsageOrder.length) % tabUsageOrder.length
          : (currentIdx + 1) % tabUsageOrder.length;
        const nextId = tabUsageOrder[nextIdx];
        if (nextId && nextId !== activeTabId) {
          if (activeTabId) persistActiveTabFromEditor(markdownInput);
          activateTab(nextId);
          trackTabUsage(nextId);
        }
      }
      return;
    }

    if (!event.ctrlKey && !event.metaKey) return;
    const code = event.code;

    /* ——— Ctrl+N: new tab (prevent browser new window) ——— */
    if (code === 'KeyN' && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openNewTab();
      return;
    }
    /* ——— Ctrl+Shift+N / Ctrl+Shift+T: prevent browser behavior ——— */
    if (code === 'KeyN' && event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (code === 'KeyT' && event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (code === 'KeyB' && !inSearchField) {
      event.preventDefault();
      applyInlineFormat(markdownInput, previewOutput, '**', 'жирный текст');
    }
    if (code === 'KeyI' && !inSearchField) {
      event.preventDefault();
      applyInlineFormat(markdownInput, previewOutput, '*', 'курсив');
    }
    if (code === 'KeyS') {
      event.preventDefault();
      if (event.shiftKey) {
        saveFileAs(markdownInput);
      } else {
        saveFile(markdownInput);
      }
    }
    if (code === 'KeyF') {
      event.preventDefault();
      searchInput?.focus();
      searchInput?.select();
    }
    if (code === 'KeyH') {
      event.preventDefault();
      replaceInput?.focus();
      replaceInput?.select();
    }
    if (code === 'KeyT') {
      event.preventDefault();
      openNewTab();
    }
    if (code === 'KeyW') {
      event.preventDefault();
      if (activeTabId) closeTabById(activeTabId);
    }
    if (code === 'KeyZ' && !event.shiftKey && !inSearchField) {
      event.preventDefault();
      undoEdit(markdownInput, previewOutput);
    }
    if ((code === 'KeyY' || (code === 'KeyZ' && event.shiftKey)) && !inSearchField) {
      event.preventDefault();
      redoEdit(markdownInput, previewOutput);
    }
    /* Strikethrough: Ctrl+Shift+X */
    if (code === 'KeyX' && event.shiftKey && !inSearchField) {
      event.preventDefault();
      applyStrikethrough(markdownInput, previewOutput);
    }
    /* Highlight: Ctrl+Shift+H */
    if (code === 'KeyH' && event.shiftKey && !inSearchField) {
      event.preventDefault();
      applyHighlight(markdownInput, previewOutput);
    }
    /* F11: fullscreen */
    if (code === 'F11') {
      event.preventDefault();
      toggleFullscreen();
    }
  }, { capture: true });

  const refreshCursorLine = () => {
    updateLineNumbers(markdownInput);
    updateCursorPosition(markdownInput);
    updateFormatToolbar(markdownInput);
    updateOutlineActive(markdownInput);
  };

  markdownInput.addEventListener('input', () => {
    recordHistory(markdownInput);
    afterEdit(markdownInput, previewOutput);
    updateSearchMatchInfo(markdownInput);
  });

  markdownInput.addEventListener('click', refreshCursorLine);
  markdownInput.addEventListener('keyup', () => {
    refreshCursorLine();
    updateSearchMatchInfo(markdownInput);
  });
  markdownInput.addEventListener('mouseup', refreshCursorLine);
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === markdownInput) {
      refreshCursorLine();
      updateSearchMatchInfo(markdownInput);
    }
  });

  markdownInput.addEventListener('scroll', () => {
    const lineNumbers = document.getElementById('lineNumbers');
    if (lineNumbers) lineNumbers.scrollTop = markdownInput.scrollTop;
    const tab = getActiveTab();
    if (tab) tab.scrollTop = markdownInput.scrollTop;
  });
});
