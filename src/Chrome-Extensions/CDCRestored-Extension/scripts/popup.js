// popup.js

let activeTabId;

// When the popup opens, find the current tab and wire up buttons
document.addEventListener('DOMContentLoaded', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]) return;
    activeTabId = tabs[0].id;

    // Domain check (optional)
    const url = tabs[0].url;
    if (!url.startsWith('https://www.restoredcdc.org') &&
        !url.startsWith('https://restoredcdc.org')) {
      document.getElementById('error').textContent =
        'This extension only works on restoredcdc.org';
      ['splitBtn','removeBtn','full','left','right']
        .forEach(id => document.getElementById(id).disabled = true);
      return;
    }

    // Split / Remove buttons
    document.getElementById('splitBtn').addEventListener('click', () => {
      chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        func: splitScreen
      });
    });
    document.getElementById('removeBtn').addEventListener('click', () => {
      chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        func: removeSplit
      });
    });

    // Snapshot buttons
    document.getElementById('full').addEventListener('click', () => capture('full'));
    document.getElementById('left').addEventListener('click', () => capture('left'));
    document.getElementById('right').addEventListener('click', () => capture('right'));
  });
});

// ——————————————
// Content‑script functions
// (these run inside the page when injected)
// ——————————————
function splitScreen() {
  if (document.getElementById('splitContainer')) return;
  const headHTML = document.head.innerHTML;
  const match = headHTML.match(/https:\/\/www\.cdc\.gov\/[^\s"'<>]+/i);
  if (!match) {
    alert('No CDC URL found in <head>.');
    return;
  }
  const initialCDCUrl = match[0];

  // build the split container
  const container = document.createElement('div');
  container.id = 'splitContainer';
  Object.assign(container.style, { display:'flex', height:'100vh', margin:0, padding:0 });

  const leftPanel = document.createElement('iframe');
  leftPanel.id = 'leftPanel';
  Object.assign(leftPanel.style, { width:'50%', height:'100%', borderRight:'1px solid #ccc' });
  leftPanel.src = location.href;

  const rightPanel = document.createElement('iframe');
  rightPanel.id = 'rightPanel';
  Object.assign(rightPanel.style, { width:'50%', height:'100%', border:'none' });
  rightPanel.src = initialCDCUrl;

  document.body.innerHTML = '';
  document.body.appendChild(container);
  container.appendChild(leftPanel);
  container.appendChild(rightPanel);

  // update rightPanel whenever leftPanel navigates
  leftPanel.addEventListener('load', () => {
    try {
      const leftDoc = leftPanel.contentDocument;
      const newMatch = leftDoc.head.innerHTML.match(/https:\/\/www\.cdc\.gov\/[^\s"'<>]+/i);
      if (newMatch) {
        rightPanel.src = newMatch[0];
      }
    } catch (e) {
      console.error('Cannot access left iframe:', e);
    }
  });
}

function removeSplit() {
  const leftPanel = document.getElementById('leftPanel');
  if (leftPanel && leftPanel.contentWindow) {
    window.location.href = leftPanel.contentWindow.location.href;
  } else {
    location.reload();
  }
}

// ——————————————
// Popup functions for snapshot & download
// ——————————————

/**
 * Ask the page for the current URL of an iframe (or fallback to the original tab URL).
 */
function getPanelUrl(panelId) {
  return new Promise((resolve, reject) => {
    if (!panelId) {
      // full snapshot: just use the tab's URL
      return chrome.tabs.get(activeTabId, tab => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(tab.url);
      });
    }
    chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: (id) => {
        const iframe = document.getElementById(id);
        try {
          return iframe.contentWindow.location.href;
        } catch {
          return iframe.src;
        }
      },
      args: [panelId],
    }, results => {
      if (chrome.runtime.lastError || !results || !results[0]) {
        return reject(chrome.runtime.lastError);
      }
      resolve(results[0].result);
    });
  });
}

async function capture(type) {
  const panelId = type === 'full' ? null : (type === 'left' ? 'leftPanel' : 'rightPanel');
  let rawUrl;
  try {
    rawUrl = await getPanelUrl(panelId);
  } catch (e) {
    console.warn('Could not fetch panel URL, falling back:', e);
    rawUrl = '';
  }

  chrome.tabs.captureVisibleTab(null, { format: 'png' }, dataUrl => {
    if (chrome.runtime.lastError) {
      console.error('Capture failed:', chrome.runtime.lastError);
      return;
    }
    processImage(dataUrl, type, rawUrl);
  });
}

function processImage(dataUrl, type, rawUrl) {
  const img = new Image();
  img.onload = () => {
    const fullW = img.width, fullH = img.height;
    let sx=0, sy=0, sw=fullW, sh=fullH;
    if (type === 'left' || type === 'right') {
      const half = Math.floor(fullW/2);
      sx = (type==='right') ? half : 0;
      sw = half;
    }
    const canvas = document.createElement('canvas');
    canvas.width = sw; canvas.height = sh;
    canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

    const safe = sanitizeUrl(rawUrl);
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const fname = `CompareCDC_${type}_${ts}_${safe}.png`;
    downloadImage(canvas.toDataURL('image/png'), fname);
  };
  img.src = dataUrl;
}

function downloadImage(dataUrl, filename) {
  fetch(dataUrl).then(r => r.blob()).then(blob => {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename }, id => {
      if (chrome.runtime.lastError) {
        console.error('Download error:', chrome.runtime.lastError);
      }
      URL.revokeObjectURL(url);
    });
  });
}

function sanitizeUrl(rawUrl = '', maxLen = 200) {
  try {
    const u = new URL(rawUrl);
    let base = u.hostname + (u.pathname !== '/' ? u.pathname : '');
    base = base.replace(/[^a-zA-Z0-9]/g,'_')
               .replace(/_+/g,'_')
               .replace(/^_|_$/g,'');
    return base.substring(0, maxLen) || 'url';
  } catch {
    const cleaned = String(rawUrl)
      .replace(/[^a-zA-Z0-9]/g,'_')
      .replace(/_+/g,'_')
      .substring(0, maxLen);
    return cleaned || 'url';
  }
}
