import './style.css';
import { version as appVersion } from '../package.json';

const savedTheme = localStorage.getItem('md-editor-theme') || 'dark';
document.body.setAttribute('data-theme', savedTheme);

const versionLabel = `v${appVersion}`;

const versionEl = document.getElementById('appVersion');
if (versionEl) {
  versionEl.textContent = versionLabel;
  versionEl.setAttribute('title', `Версия ${appVersion}`);
}

const versionDetail = document.getElementById('appVersionDetail');
if (versionDetail) {
  versionDetail.textContent = versionLabel;
}

document.title = `О проекте — MD Editor ${versionLabel}`;
