/**
 * Check for updates via GitHub Releases and install Windows NSIS setup (desktop).
 */

import { version as appVersion } from '../package.json';

export const GITHUB_OWNER = 'neuromafka-create';
export const GITHUB_REPO = 'MD-Editor';
export const RELEASES_LATEST_API =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
export const RELEASES_PAGE =
  `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

const LAST_CHECK_KEY = 'md-editor-update-last-check';
const AUTO_CHECK_KEY = 'md-editor-update-auto'; // '0' = off, otherwise on
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
export function compareSemver(a, b) {
  const parse = (v) =>
    String(v || '0')
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((part) => {
        const n = parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });

  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * @param {any} release GitHub release JSON
 * @returns {string|null}
 */
export function pickWindowsInstallerUrl(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const preferred = assets.find((a) =>
    /x64-setup\.exe$/i.test(a.name || '') || /_x64-setup\.exe$/i.test(a.name || '')
  );
  if (preferred?.browser_download_url) return preferred.browser_download_url;

  const anySetup = assets.find((a) => /setup\.exe$/i.test(a.name || ''));
  if (anySetup?.browser_download_url) return anySetup.browser_download_url;

  const anyExe = assets.find((a) => /\.exe$/i.test(a.name || ''));
  return anyExe?.browser_download_url || null;
}

/**
 * @returns {Promise<{
 *   currentVersion: string,
 *   latestVersion: string,
 *   hasUpdate: boolean,
 *   releaseName: string,
 *   releaseNotes: string,
 *   htmlUrl: string,
 *   installerUrl: string|null,
 *   publishedAt: string|null
 * }>}
 */
export async function checkForUpdates() {
  const response = await fetch(RELEASES_LATEST_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'MD-Editor-Updater'
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub API: HTTP ${response.status}`);
  }

  const release = await response.json();
  const latestVersion = String(release.tag_name || release.name || '').replace(/^v/i, '');
  if (!latestVersion) {
    throw new Error('Не удалось определить версию релиза');
  }

  const currentVersion = String(appVersion).replace(/^v/i, '');
  const hasUpdate = compareSemver(latestVersion, currentVersion) > 0;

  return {
    currentVersion,
    latestVersion,
    hasUpdate,
    releaseName: release.name || `v${latestVersion}`,
    releaseNotes: String(release.body || '').trim(),
    htmlUrl: release.html_url || RELEASES_PAGE,
    installerUrl: pickWindowsInstallerUrl(release),
    publishedAt: release.published_at || null
  };
}

export function isAutoCheckEnabled() {
  return localStorage.getItem(AUTO_CHECK_KEY) !== '0';
}

export function setAutoCheckEnabled(enabled) {
  localStorage.setItem(AUTO_CHECK_KEY, enabled ? '1' : '0');
}

export function shouldAutoCheckNow() {
  if (!isAutoCheckEnabled()) return false;
  try {
    const raw = localStorage.getItem(LAST_CHECK_KEY);
    if (!raw) return true;
    const last = Number(raw);
    if (!Number.isFinite(last)) return true;
    return Date.now() - last >= CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

export function markAutoCheckDone() {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    // ignore
  }
}

/**
 * @param {{
 *   dialog: HTMLElement|null,
 *   openButton?: HTMLElement|null,
 *   isTauri: boolean,
 *   tauriInvoke: (cmd: string, args?: object) => Promise<any>,
 *   onCloseOther?: () => void
 * }} opts
 */
export function initUpdateDialog({ dialog, openButton, isTauri, tauriInvoke, onCloseOther }) {
  if (!dialog) {
    return {
      open: async () => {},
      close: () => {},
      runSilentCheck: async () => {}
    };
  }

  const statusEl = dialog.querySelector('[data-update-status]');
  const detailEl = dialog.querySelector('[data-update-detail]');
  const notesEl = dialog.querySelector('[data-update-notes]');
  const installBtn = dialog.querySelector('[data-update-install]');
  const openBtn = dialog.querySelector('[data-update-open]');
  const autoCheckInput = dialog.querySelector('[data-update-auto]');
  let latestInfo = null;
  let busy = false;

  function setStatus(text, kind = '') {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
  }

  function setBusy(value) {
    busy = value;
    if (installBtn) installBtn.disabled = value || !latestInfo?.hasUpdate;
    if (openBtn) openBtn.disabled = value;
  }

  function renderResult(info) {
    latestInfo = info;
    if (detailEl) {
      detailEl.innerHTML = `
        <p><strong>Текущая:</strong> v${info.currentVersion}</p>
        <p><strong>Последняя на GitHub:</strong> v${info.latestVersion}</p>
      `;
    }
    if (notesEl) {
      if (info.releaseNotes) {
        notesEl.hidden = false;
        notesEl.textContent = info.releaseNotes.slice(0, 2500);
      } else {
        notesEl.hidden = true;
        notesEl.textContent = '';
      }
    }
    if (info.hasUpdate) {
      setStatus(`Доступна версия v${info.latestVersion}`, 'update');
      if (installBtn) {
        installBtn.hidden = !(isTauri && info.installerUrl);
        installBtn.disabled = false;
        installBtn.textContent = 'Скачать и установить';
      }
      if (openBtn) {
        openBtn.hidden = false;
        openBtn.disabled = false;
      }
    } else {
      setStatus('У вас актуальная версия', 'ok');
      if (installBtn) installBtn.hidden = true;
      if (openBtn) {
        openBtn.hidden = false;
        openBtn.disabled = false;
        openBtn.textContent = 'Открыть релизы на GitHub';
      }
    }
  }

  async function runCheck() {
    setBusy(true);
    setStatus('Проверка обновлений…', 'pending');
    if (detailEl) detailEl.innerHTML = '';
    if (notesEl) {
      notesEl.hidden = true;
      notesEl.textContent = '';
    }
    if (installBtn) installBtn.hidden = true;
    try {
      const info = await checkForUpdates();
      renderResult(info);
      markAutoCheckDone();
      return info;
    } catch (error) {
      latestInfo = null;
      setStatus(`Ошибка проверки: ${error?.message || error}`, 'error');
      if (installBtn) installBtn.hidden = true;
      if (openBtn) {
        openBtn.hidden = false;
        openBtn.disabled = false;
        openBtn.textContent = 'Открыть релизы на GitHub';
      }
      throw error;
    } finally {
      setBusy(false);
    }
  }

  function open() {
    onCloseOther?.();
    if (autoCheckInput) autoCheckInput.checked = isAutoCheckEnabled();
    dialog.hidden = false;
    document.body.classList.add('modal-open');
    dialog.querySelector('.modal-close')?.focus?.();
    void runCheck();
  }

  function close() {
    if (dialog.hidden) return;
    dialog.hidden = true;
    if (!document.querySelector('.modal:not([hidden])')) {
      document.body.classList.remove('modal-open');
    }
  }

  async function openUrl(url) {
    if (!url) return;
    if (isTauri) {
      await tauriInvoke('open_external_url', { url });
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  openButton?.addEventListener('click', () => open());

  dialog.querySelectorAll('[data-update-close]').forEach((el) => {
    el.addEventListener('click', () => close());
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });

  autoCheckInput?.addEventListener('change', () => {
    setAutoCheckEnabled(Boolean(autoCheckInput.checked));
  });

  dialog.querySelector('[data-update-recheck]')?.addEventListener('click', () => {
    if (!busy) void runCheck();
  });

  openBtn?.addEventListener('click', () => {
    const url = latestInfo?.htmlUrl || RELEASES_PAGE;
    void openUrl(url);
  });

  installBtn?.addEventListener('click', async () => {
    if (!isTauri || !latestInfo?.installerUrl || busy) return;
    setBusy(true);
    setStatus('Скачивание установщика…', 'pending');
    try {
      const path = await tauriInvoke('download_and_run_installer', {
        url: latestInfo.installerUrl
      });
      setStatus(
        `Установщик запущен${path ? ` (${path})` : ''}. Завершите установку в мастере, затем перезапустите MD Editor.`,
        'ok'
      );
    } catch (error) {
      setStatus(`Не удалось установить: ${error?.message || error}`, 'error');
      // Fallback: open browser download / release page
      try {
        await openUrl(latestInfo.installerUrl || latestInfo.htmlUrl || RELEASES_PAGE);
      } catch {
        // ignore
      }
    } finally {
      setBusy(false);
    }
  });

  async function runSilentCheck() {
    if (!isTauri || !shouldAutoCheckNow()) return null;
    try {
      const info = await checkForUpdates();
      markAutoCheckDone();
      if (info.hasUpdate) {
        open();
        renderResult(info);
      }
      return info;
    } catch {
      // silent fail on auto-check
      markAutoCheckDone();
      return null;
    }
  }

  return { open, close, runSilentCheck, runCheck };
}
