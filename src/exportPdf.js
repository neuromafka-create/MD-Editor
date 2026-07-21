import html2pdf from 'html2pdf.js';

/** Print-friendly CSS for the off-screen export container. */
const PDF_EXPORT_STYLES = `
  .md-pdf-export {
    box-sizing: border-box;
    width: 190mm;
    max-width: 190mm;
    padding: 0;
    margin: 0;
    color: #1a1a1a;
    background: #ffffff;
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    font-size: 11pt;
    line-height: 1.55;
    text-align: left;
  }
  .md-pdf-export *,
  .md-pdf-export *::before,
  .md-pdf-export *::after {
    box-sizing: border-box;
  }
  .md-pdf-export h1,
  .md-pdf-export h2,
  .md-pdf-export h3,
  .md-pdf-export h4,
  .md-pdf-export h5,
  .md-pdf-export h6 {
    line-height: 1.3;
    font-weight: 700;
    color: #111;
    margin: 1.2em 0 0.45em;
    page-break-after: avoid;
    break-after: avoid;
  }
  .md-pdf-export h1 { font-size: 1.75em; border-bottom: 1px solid #ddd; padding-bottom: 0.25em; }
  .md-pdf-export h2 { font-size: 1.4em; border-bottom: 1px solid #eee; padding-bottom: 0.2em; }
  .md-pdf-export h3 { font-size: 1.2em; }
  .md-pdf-export h4 { font-size: 1.05em; color: #333; }
  .md-pdf-export p { margin: 0.65em 0; }
  .md-pdf-export a { color: #0563c1; text-decoration: underline; }
  .md-pdf-export ul,
  .md-pdf-export ol { margin: 0.5em 0; padding-left: 1.5em; }
  .md-pdf-export li { margin: 0.25em 0; }
  .md-pdf-export blockquote {
    margin: 0.8em 0;
    padding: 0.4em 0 0.4em 1em;
    border-left: 4px solid #cbd5e1;
    color: #475569;
    background: #f8fafc;
  }
  .md-pdf-export hr {
    border: 0;
    border-top: 1px solid #ddd;
    margin: 1.2em 0;
  }
  .md-pdf-export img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 0.8em 0;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .md-pdf-export code {
    font-family: Consolas, "Cascadia Mono", "Courier New", monospace;
    font-size: 0.9em;
    background: #f1f5f9;
    color: #0f172a;
    padding: 0.12em 0.35em;
    border-radius: 4px;
  }
  .md-pdf-export pre {
    margin: 0.85em 0;
    padding: 12px 14px;
    overflow: hidden;
    border-radius: 6px;
    background: #0f172a;
    color: #e2e8f0;
    border: 1px solid #1e293b;
    page-break-inside: avoid;
    break-inside: avoid;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .md-pdf-export pre code {
    display: block;
    padding: 0;
    background: transparent;
    color: inherit;
    font-size: 0.85em;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .md-pdf-export table {
    width: 100%;
    border-collapse: collapse;
    margin: 0.9em 0;
    font-size: 0.95em;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .md-pdf-export th,
  .md-pdf-export td {
    border: 1px solid #cbd5e1;
    padding: 6px 10px;
    text-align: left;
    vertical-align: top;
  }
  .md-pdf-export th {
    background: #f1f5f9;
    font-weight: 600;
  }
  .md-pdf-export tr:nth-child(even) td {
    background: #f8fafc;
  }
  .md-pdf-export mark {
    background: #fef08a;
    color: inherit;
    padding: 0.05em 0.2em;
    border-radius: 2px;
  }
  .md-pdf-export sup,
  .md-pdf-export sub {
    font-size: 0.75em;
  }
  .md-pdf-export .table-wrapper,
  .md-pdf-export .copy-table-button,
  .md-pdf-export .copy-code-button {
    display: contents;
  }
  .md-pdf-export .copy-table-button,
  .md-pdf-export .copy-code-button {
    display: none !important;
  }
`;

/**
 * Convert HTML body (already rendered markdown) to PDF bytes.
 * @param {string} htmlBody
 * @param {{ title?: string }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function htmlToPdfBytes(htmlBody, options = {}) {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = [
    'position: fixed',
    'left: -10000px',
    'top: 0',
    'width: 210mm',
    'padding: 12mm 10mm',
    'background: #ffffff',
    'z-index: -1',
    'pointer-events: none',
    'opacity: 1'
  ].join(';');

  const style = document.createElement('style');
  style.textContent = PDF_EXPORT_STYLES;

  const content = document.createElement('div');
  content.className = 'md-pdf-export';
  content.innerHTML = htmlBody || '<p></p>';

  host.appendChild(style);
  host.appendChild(content);
  document.body.appendChild(host);

  // Wait for images so html2canvas captures them
  await waitForImages(content);

  try {
    const opt = {
      margin: [12, 10, 12, 10],
      filename: `${options.title || 'document'}.pdf`,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        logging: false,
        windowWidth: content.scrollWidth || 794
      },
      jsPDF: {
        unit: 'mm',
        format: 'a4',
        orientation: 'portrait'
      },
      pagebreak: { mode: ['css', 'legacy'] }
    };

    let result;
    try {
      result = await html2pdf().set(opt).from(content).outputPdf('arraybuffer');
    } catch {
      result = await html2pdf().set(opt).from(content).outputPdf('blob');
    }

    if (result instanceof ArrayBuffer) {
      return new Uint8Array(result);
    }
    if (result instanceof Uint8Array) {
      return result;
    }
    if (result instanceof Blob) {
      return new Uint8Array(await result.arrayBuffer());
    }
    throw new Error('html2pdf вернул неожиданный формат');
  } finally {
    host.remove();
  }
}

/**
 * @param {HTMLElement} root
 * @returns {Promise<void>}
 */
function waitForImages(root) {
  const images = [...root.querySelectorAll('img')];
  if (!images.length) return Promise.resolve();

  return Promise.all(
    images.map(
      (img) =>
        new Promise((resolve) => {
          if (img.complete && img.naturalWidth > 0) {
            resolve();
            return;
          }
          const done = () => resolve();
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
          // Safety timeout
          setTimeout(done, 4000);
        })
    )
  ).then(() => undefined);
}
