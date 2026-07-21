/**
 * Interface appearance: fonts & backgrounds for editor / preview (localStorage).
 */

export const INTERFACE_STORAGE_KEY = 'md-editor-interface';

const FONT_OPTIONS = [
  { value: '', label: 'По умолчанию' },
  { value: 'ui', label: 'Системный UI', css: 'var(--font-ui)' },
  { value: 'mono', label: 'Моноширинный', css: 'var(--font-mono)' },
  { value: 'segoe', label: 'Segoe UI', css: '"Segoe UI", system-ui, sans-serif' },
  { value: 'arial', label: 'Arial', css: 'Arial, Helvetica, sans-serif' },
  { value: 'georgia', label: 'Georgia', css: 'Georgia, "Times New Roman", serif' },
  { value: 'times', label: 'Times New Roman', css: '"Times New Roman", Times, serif' },
  { value: 'verdana', label: 'Verdana', css: 'Verdana, Geneva, sans-serif' },
  { value: 'consolas', label: 'Consolas', css: 'Consolas, "Courier New", monospace' },
  { value: 'cascadia', label: 'Cascadia Code', css: '"Cascadia Code", "JetBrains Mono", Consolas, monospace' },
  { value: 'courier', label: 'Courier New', css: '"Courier New", Courier, monospace' }
];

const CODE_CONTRAST_OPTIONS = [
  { value: 'soft', label: 'Мягкий' },
  { value: 'normal', label: 'Обычный' },
  { value: 'high', label: 'Высокий' },
  { value: 'max', label: 'Максимальный' }
];

/** Caret thickness / shape (native textarea: bar / block / underscore). */
const CARET_WIDTH_OPTIONS = [
  { value: 'thin', label: 'Тонкий (линия)', shape: 'bar', cssWidth: '1px' },
  { value: 'normal', label: 'Обычный', shape: 'bar', cssWidth: '2px' },
  { value: 'thick', label: 'Широкий (блок)', shape: 'block', cssWidth: '0.6ch' },
  { value: 'underscore', label: 'Подчёркивание', shape: 'underscore', cssWidth: '0.12em' }
];

const CARET_BLINK_OPTIONS = [
  { value: 'on', label: 'Моргает' },
  { value: 'slow', label: 'Медленно' },
  { value: 'off', label: 'Без моргания' }
];

export function getDefaultInterfaceSettings() {
  return {
    editor: {
      fontFamily: 'mono',
      fontSize: 13.5,
      color: '',
      background: ''
    },
    preview: {
      fontFamily: 'ui',
      fontSize: 14.5,
      color: '',
      background: ''
    },
    codeContrast: 'normal',
    caret: {
      color: '',
      width: 'normal',
      blink: 'on'
    }
  };
}

function normalizeCodeContrast(value) {
  return CODE_CONTRAST_OPTIONS.some((o) => o.value === value) ? value : 'normal';
}

function normalizeCaret(caret, defaults) {
  const src = caret && typeof caret === 'object' ? caret : {};
  return {
    color: typeof src.color === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(src.color)
      ? src.color
      : '',
    width: CARET_WIDTH_OPTIONS.some((o) => o.value === src.width) ? src.width : defaults.width,
    blink: CARET_BLINK_OPTIONS.some((o) => o.value === src.blink) ? src.blink : defaults.blink
  };
}

function clampFontSize(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(28, Math.max(10, Math.round(n * 10) / 10));
}

function normalizePane(pane, defaults) {
  const src = pane && typeof pane === 'object' ? pane : {};
  const fontFamily = FONT_OPTIONS.some((o) => o.value === src.fontFamily)
    ? src.fontFamily
    : defaults.fontFamily;
  return {
    fontFamily,
    fontSize: clampFontSize(src.fontSize, defaults.fontSize),
    color: typeof src.color === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(src.color)
      ? src.color
      : '',
    background: typeof src.background === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(src.background)
      ? src.background
      : ''
  };
}

export function loadInterfaceSettings() {
  const defaults = getDefaultInterfaceSettings();
  try {
    const raw = localStorage.getItem(INTERFACE_STORAGE_KEY);
    if (!raw) return defaults;
    const data = JSON.parse(raw);
    return {
      editor: normalizePane(data.editor, defaults.editor),
      preview: normalizePane(data.preview, defaults.preview),
      codeContrast: normalizeCodeContrast(data.codeContrast ?? defaults.codeContrast),
      caret: normalizeCaret(data.caret, defaults.caret)
    };
  } catch {
    return defaults;
  }
}

export function saveInterfaceSettings(settings) {
  const defaults = getDefaultInterfaceSettings();
  const normalized = {
    editor: normalizePane(settings.editor, defaults.editor),
    preview: normalizePane(settings.preview, defaults.preview),
    codeContrast: normalizeCodeContrast(settings.codeContrast ?? defaults.codeContrast),
    caret: normalizeCaret(settings.caret, defaults.caret)
  };
  try {
    localStorage.setItem(INTERFACE_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // quota
  }
  return normalized;
}

function fontCss(key) {
  const opt = FONT_OPTIONS.find((o) => o.value === key);
  return opt?.css || '';
}

/**
 * Apply settings as CSS custom properties on documentElement.
 * Empty color/background → remove override (theme defaults).
 */
export function applyInterfaceSettings(settings) {
  const root = document.documentElement;
  const s = settings || loadInterfaceSettings();

  const editorFont = fontCss(s.editor.fontFamily);
  if (editorFont) root.style.setProperty('--editor-font-family', editorFont);
  else root.style.removeProperty('--editor-font-family');

  root.style.setProperty('--editor-font-size', `${s.editor.fontSize}px`);

  if (s.editor.color) root.style.setProperty('--editor-color', s.editor.color);
  else root.style.removeProperty('--editor-color');

  if (s.editor.background) root.style.setProperty('--editor-bg', s.editor.background);
  else root.style.removeProperty('--editor-bg');

  const previewFont = fontCss(s.preview.fontFamily);
  if (previewFont) root.style.setProperty('--preview-font-family', previewFont);
  else root.style.removeProperty('--preview-font-family');

  root.style.setProperty('--preview-font-size', `${s.preview.fontSize}px`);

  if (s.preview.color) root.style.setProperty('--preview-color', s.preview.color);
  else root.style.removeProperty('--preview-color');

  if (s.preview.background) root.style.setProperty('--preview-bg', s.preview.background);
  else root.style.removeProperty('--preview-bg');

  const contrast = normalizeCodeContrast(s.codeContrast);
  document.body?.setAttribute('data-code-contrast', contrast);

  const caret = normalizeCaret(s.caret, getDefaultInterfaceSettings().caret);
  const widthOpt = CARET_WIDTH_OPTIONS.find((o) => o.value === caret.width) || CARET_WIDTH_OPTIONS[1];

  if (caret.color) root.style.setProperty('--editor-caret-color', caret.color);
  else root.style.removeProperty('--editor-caret-color');

  root.style.setProperty('--editor-caret-shape', widthOpt.shape);
  root.style.setProperty('--editor-caret-width', widthOpt.cssWidth);

  document.body?.setAttribute('data-caret-width', caret.width);
  document.body?.setAttribute('data-caret-blink', caret.blink);
}

function fontSelectHtml(id, selected) {
  return FONT_OPTIONS.map((opt) => {
    const sel = opt.value === selected ? ' selected' : '';
    return `<option value="${opt.value}"${sel}>${opt.label}</option>`;
  }).join('');
}

function paneFields(prefix, pane, title) {
  const colorDefault = !pane.color;
  const bgDefault = !pane.background;
  return `
    <section class="iface-pane" data-pane="${prefix}">
      <h3 class="iface-pane-title">${title}</h3>
      <label class="iface-field">
        <span>Семейство шрифта</span>
        <select id="${prefix}FontFamily" data-field="fontFamily">
          ${fontSelectHtml(`${prefix}FontFamily`, pane.fontFamily)}
        </select>
      </label>
      <label class="iface-field">
        <span>Размер (px)</span>
        <input id="${prefix}FontSize" data-field="fontSize" type="number" min="10" max="28" step="0.5" value="${pane.fontSize}" />
      </label>
      <div class="iface-field iface-color-field">
        <span>Цвет текста</span>
        <div class="iface-color-row">
          <label class="iface-check">
            <input type="checkbox" id="${prefix}ColorDefault" data-field="colorDefault" ${colorDefault ? 'checked' : ''} />
            Как в теме
          </label>
          <input id="${prefix}Color" data-field="color" type="color" value="${pane.color || '#e8eef6'}" ${colorDefault ? 'disabled' : ''} />
        </div>
      </div>
      <div class="iface-field iface-color-field">
        <span>Фон</span>
        <div class="iface-color-row">
          <label class="iface-check">
            <input type="checkbox" id="${prefix}BgDefault" data-field="bgDefault" ${bgDefault ? 'checked' : ''} />
            Как в теме
          </label>
          <input id="${prefix}Bg" data-field="background" type="color" value="${pane.background || '#0f141b'}" ${bgDefault ? 'disabled' : ''} />
        </div>
      </div>
    </section>
  `;
}

/**
 * Wire the interface settings dialog (once).
 * @param {{ dialog: HTMLElement, openButton: HTMLElement|null, onCloseOther?: () => void }} opts
 */
export function initInterfaceSettingsDialog({ dialog, openButton, onCloseOther }) {
  if (!dialog) {
    return {
      open: () => {},
      close: () => {},
      applyStored: () => applyInterfaceSettings(loadInterfaceSettings())
    };
  }

  const body = dialog.querySelector('.modal-body');
  let settings = loadInterfaceSettings();

  function renderForm() {
    if (!body) return;
    const contrast = normalizeCodeContrast(settings.codeContrast);
    const contrastOptions = CODE_CONTRAST_OPTIONS.map((opt) => {
      const sel = opt.value === contrast ? ' selected' : '';
      return `<option value="${opt.value}"${sel}>${opt.label}</option>`;
    }).join('');

    const caret = normalizeCaret(settings.caret, getDefaultInterfaceSettings().caret);
    const caretWidthOpts = CARET_WIDTH_OPTIONS.map((opt) => {
      const sel = opt.value === caret.width ? ' selected' : '';
      return `<option value="${opt.value}"${sel}>${opt.label}</option>`;
    }).join('');
    const caretBlinkOpts = CARET_BLINK_OPTIONS.map((opt) => {
      const sel = opt.value === caret.blink ? ' selected' : '';
      return `<option value="${opt.value}"${sel}>${opt.label}</option>`;
    }).join('');
    const caretColorDefault = !caret.color;

    body.innerHTML = `
      <p class="iface-intro">Шрифты, фоны, курсор редактора и контраст кода. Цвета «как в теме» — из светлой/тёмной темы. Сохраняется в <code>localStorage</code>.</p>
      <div class="iface-grid">
        ${paneFields('editor', settings.editor, 'Редактор')}
        ${paneFields('preview', settings.preview, 'Предпросмотр')}
      </div>
      <section class="iface-pane iface-pane-full">
        <h3 class="iface-pane-title">Курсор редактора</h3>
        <div class="iface-grid iface-grid-3">
          <div class="iface-field iface-color-field">
            <span>Цвет</span>
            <div class="iface-color-row">
              <label class="iface-check">
                <input type="checkbox" id="caretColorDefault" data-field="caretColorDefault" ${caretColorDefault ? 'checked' : ''} />
                Акцент темы
              </label>
              <input id="caretColor" data-field="caretColor" type="color" value="${caret.color || '#3b82f6'}" ${caretColorDefault ? 'disabled' : ''} />
            </div>
          </div>
          <label class="iface-field">
            <span>Ширина / форма</span>
            <select id="caretWidth" data-field="caretWidth">
              ${caretWidthOpts}
            </select>
          </label>
          <label class="iface-field">
            <span>Моргание</span>
            <select id="caretBlink" data-field="caretBlink">
              ${caretBlinkOpts}
            </select>
          </label>
        </div>
        <p class="iface-hint">Кликните в поле ниже, чтобы проверить курсор. «Широкий» — форма block; «без моргания» и «медленно» зависят от поддержки браузера (<code>caret-animation</code>).</p>
        <textarea class="iface-caret-sample" spellcheck="false" rows="2" aria-label="Пробный ввод для курсора">Проверьте курсор здесь…</textarea>
      </section>
      <section class="iface-pane iface-pane-full">
        <h3 class="iface-pane-title">Код в предпросмотре</h3>
        <label class="iface-field">
          <span>Контраст блоков кода</span>
          <select id="codeContrast" data-field="codeContrast">
            ${contrastOptions}
          </select>
        </label>
        <p class="iface-hint">Влияет на фон блоков <code>pre</code>, инлайн-код и насыщенность подсветки syntax highlight.</p>
        <pre class="iface-code-sample" aria-hidden="true"><code class="hljs language-js"><span class="hljs-keyword">const</span> hi = <span class="hljs-string">'code'</span>;
<span class="hljs-comment">// preview</span>
<span class="hljs-title function_">console</span>.<span class="hljs-title function_">log</span>(hi);</code></pre>
      </section>
    `;
    bindForm();
  }

  function readForm() {
    const readPane = (prefix) => {
      const fontFamily = dialog.querySelector(`#${prefix}FontFamily`)?.value ?? '';
      const fontSize = dialog.querySelector(`#${prefix}FontSize`)?.value;
      const colorDefault = dialog.querySelector(`#${prefix}ColorDefault`)?.checked;
      const bgDefault = dialog.querySelector(`#${prefix}BgDefault`)?.checked;
      const color = dialog.querySelector(`#${prefix}Color`)?.value || '';
      const background = dialog.querySelector(`#${prefix}Bg`)?.value || '';
      return {
        fontFamily,
        fontSize,
        color: colorDefault ? '' : color,
        background: bgDefault ? '' : background
      };
    };
    const caretColorDefault = dialog.querySelector('#caretColorDefault')?.checked;
    return {
      editor: readPane('editor'),
      preview: readPane('preview'),
      codeContrast: dialog.querySelector('#codeContrast')?.value || 'normal',
      caret: {
        color: caretColorDefault ? '' : (dialog.querySelector('#caretColor')?.value || ''),
        width: dialog.querySelector('#caretWidth')?.value || 'normal',
        blink: dialog.querySelector('#caretBlink')?.value || 'on'
      }
    };
  }

  function applyFromForm() {
    settings = saveInterfaceSettings(readForm());
    applyInterfaceSettings(settings);
  }

  function bindForm() {
    dialog.querySelectorAll('[data-field]').forEach((el) => {
      const eventName = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(eventName, () => {
        if (el.dataset.field === 'colorDefault') {
          const colorInput = dialog.querySelector(`#${el.id.replace('ColorDefault', 'Color')}`);
          if (colorInput) colorInput.disabled = el.checked;
        }
        if (el.dataset.field === 'bgDefault') {
          const bgInput = dialog.querySelector(`#${el.id.replace('BgDefault', 'Bg')}`);
          if (bgInput) bgInput.disabled = el.checked;
        }
        if (el.dataset.field === 'caretColorDefault') {
          const colorInput = dialog.querySelector('#caretColor');
          if (colorInput) colorInput.disabled = el.checked;
        }
        applyFromForm();
      });
    });
  }

  function open() {
    onCloseOther?.();
    settings = loadInterfaceSettings();
    renderForm();
    dialog.hidden = false;
    document.body.classList.add('modal-open');
    dialog.querySelector('.modal-close')?.focus?.();
  }

  function close() {
    if (dialog.hidden) return;
    dialog.hidden = true;
    if (!document.querySelector('.modal:not([hidden])')) {
      document.body.classList.remove('modal-open');
    }
  }

  function reset() {
    settings = getDefaultInterfaceSettings();
    saveInterfaceSettings(settings);
    applyInterfaceSettings(settings);
    renderForm();
  }

  openButton?.addEventListener('click', () => open());

  dialog.querySelectorAll('[data-interface-close]').forEach((el) => {
    el.addEventListener('click', () => close());
  });

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });

  dialog.querySelector('[data-interface-reset]')?.addEventListener('click', () => reset());

  applyInterfaceSettings(settings);

  return { open, close, applyStored: () => applyInterfaceSettings(loadInterfaceSettings()) };
}
