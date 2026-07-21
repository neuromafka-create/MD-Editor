/**
 * Customizable toolbar layout: reorder buttons & place dividers (localStorage).
 * Uses Pointer Events (not HTML5 DnD) — native <button draggable> is unreliable in Chromium.
 */

export const TOOLBAR_STORAGE_KEY = 'md-editor-toolbar-layout';
export const DIVIDER_TOKEN = '|';

/** Default order matches the built-in toolbar in index.html */
export const DEFAULT_TOOLBAR_LAYOUT = [
  'newIconButton',
  'openIconButton',
  'saveIconButton',
  'saveAsIconButton',
  DIVIDER_TOKEN,
  'undoButton',
  'redoButton',
  'cutButton',
  'copyButton',
  'pasteButton',
  DIVIDER_TOKEN,
  'boldButton',
  'italicButton',
  'strikethroughButton',
  'highlightButton',
  'inlineCodeButton',
  DIVIDER_TOKEN,
  'superscriptButton',
  'subscriptButton',
  DIVIDER_TOKEN,
  'heading1Button',
  'heading2Button',
  'heading3Button',
  'heading4Button',
  DIVIDER_TOKEN,
  'unorderedListButton',
  'orderedListButton',
  'taskListButton',
  DIVIDER_TOKEN,
  'quoteButton',
  'codeButton',
  'hrButton',
  'imageButton',
  'linkButton'
];

const DRAG_THRESHOLD_PX = 4;

function createDivider() {
  const el = document.createElement('span');
  el.className = 'toolbar-divider';
  el.setAttribute('data-toolbar-divider', '');
  el.setAttribute('aria-hidden', 'true');
  el.title = 'Разделитель';
  return el;
}

export function serializeToolbar(toolbar) {
  if (!toolbar) return [...DEFAULT_TOOLBAR_LAYOUT];
  return [...toolbar.children].map((el) => {
    if (el.hasAttribute('data-toolbar-divider') || el.classList.contains('toolbar-divider')) {
      return DIVIDER_TOKEN;
    }
    return el.id || null;
  }).filter(Boolean);
}

export function loadToolbarLayout() {
  try {
    const raw = localStorage.getItem(TOOLBAR_STORAGE_KEY);
    if (!raw) return [...DEFAULT_TOOLBAR_LAYOUT];
    const data = JSON.parse(raw);
    if (!Array.isArray(data) || !data.length) return [...DEFAULT_TOOLBAR_LAYOUT];
    return data.filter((item) => item === DIVIDER_TOKEN || typeof item === 'string');
  } catch {
    return [...DEFAULT_TOOLBAR_LAYOUT];
  }
}

export function saveToolbarLayout(layout) {
  try {
    localStorage.setItem(TOOLBAR_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // quota
  }
}

/**
 * Reorder toolbar children to match layout. Unknown ids ignored; missing buttons appended at end.
 * @param {HTMLElement} toolbar
 * @param {string[]} layout
 */
export function applyToolbarLayout(toolbar, layout) {
  if (!toolbar) return;

  const buttons = new Map();
  [...toolbar.querySelectorAll('button.toolbar-icon-button[id]')].forEach((btn) => {
    buttons.set(btn.id, btn);
  });

  [...toolbar.querySelectorAll('[data-toolbar-divider], .toolbar-divider')].forEach((d) => d.remove());

  const used = new Set();
  const frag = document.createDocumentFragment();
  const items = Array.isArray(layout) && layout.length ? layout : DEFAULT_TOOLBAR_LAYOUT;

  items.forEach((key) => {
    if (key === DIVIDER_TOKEN) {
      frag.appendChild(createDivider());
      return;
    }
    const btn = buttons.get(key);
    if (btn) {
      frag.appendChild(btn);
      used.add(key);
    }
  });

  const missing = [...buttons.keys()].filter((id) => !used.has(id));
  if (missing.length) {
    if (frag.lastChild && !frag.lastChild.classList?.contains('toolbar-divider')) {
      frag.appendChild(createDivider());
    }
    missing.forEach((id) => frag.appendChild(buttons.get(id)));
  }

  toolbar.appendChild(frag);
}

/**
 * @param {{ toolbar: HTMLElement, openButton?: HTMLElement|null, onModeChange?: (on: boolean) => void }} opts
 */
export function initToolbarCustomization({ toolbar, openButton, onModeChange }) {
  if (!toolbar) {
    return { enter: () => {}, exit: () => {}, isActive: () => false };
  }

  let customizeMode = false;
  let banner = null;

  /** @type {{ el: HTMLElement, startX: number, startY: number, pointerId: number, moved: boolean, ghost: HTMLElement|null } | null} */
  let drag = null;

  applyToolbarLayout(toolbar, loadToolbarLayout());

  function persist() {
    saveToolbarLayout(serializeToolbar(toolbar));
  }

  function ensureBanner() {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'toolbarCustomizeBanner';
    banner.className = 'toolbar-customize-banner';
    banner.hidden = true;
    banner.innerHTML = `
      <span class="toolbar-customize-text">
        <strong>Настройка панели</strong> — перетащите кнопки и разделители.
        Двойной клик по разделителю — удалить.
      </span>
      <div class="toolbar-customize-actions">
        <button type="button" class="btn-ghost" data-toolbar-add-divider>+ Разделитель</button>
        <button type="button" class="btn-ghost" data-toolbar-reset>Сбросить</button>
        <button type="button" class="btn-ghost" data-toolbar-done>Готово</button>
      </div>
    `;
    const topbar = toolbar.closest('.topbar') || toolbar.parentElement;
    topbar?.insertAdjacentElement('afterend', banner);

    banner.querySelector('[data-toolbar-add-divider]')?.addEventListener('click', () => {
      const div = createDivider();
      toolbar.appendChild(div);
      if (customizeMode) makeItemInteractive(div);
      persist();
    });

    banner.querySelector('[data-toolbar-reset]')?.addEventListener('click', () => {
      applyToolbarLayout(toolbar, DEFAULT_TOOLBAR_LAYOUT);
      saveToolbarLayout([...DEFAULT_TOOLBAR_LAYOUT]);
      if (customizeMode) setCustomizeChrome(true);
    });

    banner.querySelector('[data-toolbar-done]')?.addEventListener('click', () => exit());
    return banner;
  }

  function clearDropMarkers() {
    toolbar.querySelectorAll('.toolbar-drop-before, .toolbar-drop-after').forEach((el) => {
      el.classList.remove('toolbar-drop-before', 'toolbar-drop-after');
    });
  }

  function makeItemInteractive(el) {
    el.setAttribute('data-toolbar-draggable', 'true');
    if (el.hasAttribute('data-toolbar-divider')) {
      el.classList.add('toolbar-divider-editable');
      el.title = 'Перетащите · двойной клик — удалить';
    }
  }

  function stripItemInteractive(el) {
    el.removeAttribute('data-toolbar-draggable');
    el.classList.remove('toolbar-divider-editable', 'is-dragging');
    el.style.removeProperty('opacity');
    if (el.hasAttribute('data-toolbar-divider')) {
      el.title = '';
    }
  }

  function setCustomizeChrome(on) {
    toolbar.classList.toggle('is-customizing', on);
    document.body.classList.toggle('toolbar-customize-mode', on);
    [...toolbar.children].forEach((el) => {
      if (on) makeItemInteractive(el);
      else stripItemInteractive(el);
    });
    const b = ensureBanner();
    b.hidden = !on;
  }

  function enter() {
    if (customizeMode) return;
    customizeMode = true;
    setCustomizeChrome(true);
    onModeChange?.(true);
  }

  function exit() {
    if (!customizeMode) return;
    endDrag(true);
    customizeMode = false;
    clearDropMarkers();
    setCustomizeChrome(false);
    persist();
    onModeChange?.(false);
  }

  function getInsertTarget(clientX) {
    const items = [...toolbar.children].filter((el) => el !== drag?.el);
    if (!items.length) return { element: null, place: 'after' };

    let best = null;
    let bestDist = Infinity;
    items.forEach((child) => {
      const box = child.getBoundingClientRect();
      const mid = box.left + box.width / 2;
      const dist = Math.abs(clientX - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = { element: child, place: clientX < mid ? 'before' : 'after' };
      }
    });
    return best || { element: null, place: 'after' };
  }

  function moveDraggedBefore(target, place) {
    if (!drag?.el) return;
    if (!target) {
      toolbar.appendChild(drag.el);
      return;
    }
    if (place === 'before') {
      toolbar.insertBefore(drag.el, target);
    } else {
      toolbar.insertBefore(drag.el, target.nextSibling);
    }
  }

  function createGhost(el, clientX, clientY) {
    const rect = el.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    ghost.classList.add('toolbar-drag-ghost');
    ghost.removeAttribute('id');
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = `${clientX - rect.width / 2}px`;
    ghost.style.top = `${clientY - rect.height / 2}px`;
    document.body.appendChild(ghost);
    return ghost;
  }

  function updateGhost(clientX, clientY) {
    if (!drag?.ghost) return;
    const w = drag.ghost.offsetWidth;
    const h = drag.ghost.offsetHeight;
    drag.ghost.style.left = `${clientX - w / 2}px`;
    drag.ghost.style.top = `${clientY - h / 2}px`;
  }

  function endDrag(cancelled = false) {
    if (!drag) return;
    const { el, ghost, pointerId } = drag;
    try {
      toolbar.releasePointerCapture?.(pointerId);
    } catch {
      // ignore
    }
    el.classList.remove('is-dragging');
    el.style.removeProperty('opacity');
    ghost?.remove();
    clearDropMarkers();
    drag = null;
    if (!cancelled && customizeMode) persist();
  }

  function onPointerDown(e) {
    if (!customizeMode || e.button !== 0) return;
    const item = e.target.closest('[data-toolbar-draggable="true"]');
    if (!item || !toolbar.contains(item)) return;

    // Don't start drag from nested interactive that isn't the item itself — still ok for icons inside button
    e.preventDefault();
    e.stopPropagation();

    drag = {
      el: item,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      moved: false,
      ghost: null
    };

    try {
      toolbar.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      drag.el.classList.add('is-dragging');
      drag.el.style.opacity = '0.35';
      drag.ghost = createGhost(drag.el, e.clientX, e.clientY);
    }

    e.preventDefault();
    updateGhost(e.clientX, e.clientY);
    clearDropMarkers();
    const { element, place } = getInsertTarget(e.clientX);
    if (element && element !== drag.el) {
      element.classList.add(place === 'before' ? 'toolbar-drop-before' : 'toolbar-drop-after');
      moveDraggedBefore(element, place);
    }
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const wasMoved = drag.moved;
    endDrag(false);
    // Suppress the synthetic click after a real drag
    if (wasMoved) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  toolbar.addEventListener('pointerdown', onPointerDown);
  toolbar.addEventListener('pointermove', onPointerMove);
  toolbar.addEventListener('pointerup', onPointerUp);
  toolbar.addEventListener('pointercancel', () => endDrag(true));

  toolbar.addEventListener('dblclick', (e) => {
    if (!customizeMode) return;
    const div = e.target.closest('[data-toolbar-divider]');
    if (div && toolbar.contains(div)) {
      div.remove();
      persist();
    }
  });

  // Block toolbar button actions while customizing (capture phase)
  toolbar.addEventListener('click', (e) => {
    if (!customizeMode) return;
    const btn = e.target.closest('button');
    if (btn && toolbar.contains(btn)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // Prevent native image/text drag inside buttons
  toolbar.addEventListener('dragstart', (e) => {
    if (customizeMode) e.preventDefault();
  });

  openButton?.addEventListener('click', () => {
    enter();
  });

  return {
    enter,
    exit,
    isActive: () => customizeMode,
    applyStored: () => applyToolbarLayout(toolbar, loadToolbarLayout())
  };
}
