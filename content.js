// Right-click unblocker event handlers
let rightClickListeners = [];

function enableRightClickUnblocker() {
  if (rightClickListeners.length > 0) return; // Already running

  const events = ['contextmenu', 'mousedown', 'mouseup', 'selectstart', 'dragstart'];
  
  events.forEach(eventName => {
    const listener = function(e) {
      e.stopPropagation();
    };
    document.addEventListener(eventName, listener, true);
    rightClickListeners.push({ eventName, listener });
  });
}

function disableRightClickUnblocker() {
  rightClickListeners.forEach(({ eventName, listener }) => {
    document.removeEventListener(eventName, listener, true);
  });
  rightClickListeners = [];
}

// Check initial setting from storage
chrome.storage.local.get(['forceRightClick'], (result) => {
  if (result.forceRightClick) {
    enableRightClickUnblocker();
  }
});

// Image extraction logic
function extractImages() {
  const images = new Set();
  const pageUrl = window.location.href;

  function addImage(url, sourceEl) {
    if (!url) return;
    if (url.startsWith('javascript:') || url.startsWith('about:')) return;

    try {
      const absoluteUrl = new URL(url, pageUrl).href;
      
      if (absoluteUrl.startsWith('data:')) {
        if (!absoluteUrl.startsWith('data:image/')) return;
        if (absoluteUrl.length < 150) return;
      }
      
      let width = 0;
      let height = 0;
      let alt = '';
      let tagName = 'css-background';

      if (sourceEl) {
        tagName = sourceEl.tagName.toLowerCase();
        if (sourceEl.tagName === 'IMG') {
          width = sourceEl.naturalWidth || sourceEl.clientWidth || 0;
          height = sourceEl.naturalHeight || sourceEl.clientHeight || 0;
          alt = sourceEl.alt || '';
        } else {
          width = sourceEl.clientWidth || 0;
          height = sourceEl.clientHeight || 0;
        }
      }

      const filename = getCleanFilename(absoluteUrl);

      images.add(JSON.stringify({
        url: absoluteUrl,
        width,
        height,
        alt: alt.trim(),
        tagName,
        filename
      }));
    } catch (e) {}
  }

  // 1. Standard <img> tags
  document.querySelectorAll('img').forEach(img => {
    addImage(img.src, img);
    if (img.srcset) {
      img.srcset.split(',').forEach(srcStr => {
        const url = srcStr.trim().split(/\s+/)[0];
        addImage(url, img);
      });
    }
    const lazyAttrs = ['data-src', 'data-srcset', 'data-original', 'lazy-src', 'data-lazy-src'];
    lazyAttrs.forEach(attr => {
      const val = img.getAttribute(attr);
      if (val) addImage(val, img);
    });
  });

  // 2. CSS background-images
  document.querySelectorAll('*').forEach(el => {
    const skipTags = ['script', 'style', 'noscript', 'link', 'meta', 'head'];
    if (skipTags.includes(el.tagName.toLowerCase())) return;

    const inlineBg = el.style.backgroundImage;
    if (inlineBg && inlineBg !== 'none') {
      const match = inlineBg.match(/url\(['"]?([^'"]+)['"]?\)/);
      if (match) addImage(match[1], el);
    }
    
    try {
      const computedBg = window.getComputedStyle(el).backgroundImage;
      if (computedBg && computedBg !== 'none') {
        const match = computedBg.match(/url\(['"]?([^'"]+)['"]?\)/);
        if (match) addImage(match[1], el);
      }
    } catch (e) {}
  });

  // 3. Picture sources
  document.querySelectorAll('picture source').forEach(source => {
    if (source.srcset) {
      source.srcset.split(',').forEach(srcStr => {
        const url = srcStr.trim().split(/\s+/)[0];
        addImage(url, source);
      });
    }
  });

  // 4. Canvas elements
  document.querySelectorAll('canvas').forEach(canvas => {
    try {
      const dataUrl = canvas.toDataURL('image/png');
      addImage(dataUrl, canvas);
    } catch (e) {}
  });

  // 5. Video posters
  document.querySelectorAll('video').forEach(video => {
    if (video.poster) {
      addImage(video.poster, video);
    }
  });

  return Array.from(images).map(str => JSON.parse(str));
}

// Helper to determine clean filename
function getCleanFilename(url) {
  let filename = 'image';
  if (!url.startsWith('data:')) {
    try {
      const path = new URL(url).pathname;
      const parts = path.split('/');
      const lastPart = parts[parts.length - 1];
      if (lastPart && lastPart.includes('.')) {
        filename = lastPart;
      }
    } catch (e) {}
  } else {
    const mimeMatch = url.match(/^data:(image\/[a-z0-9-+.]+);base64,/);
    if (mimeMatch) {
      const ext = mimeMatch[1].split('/')[1];
      filename = `embedded_image.${ext}`;
    }
  }
  return filename;
}

// -------------------------------------------------------------
// Ctrl+D / Cmd+D Hover Download Shortcut Feature
// -------------------------------------------------------------

let currentHoveredElement = null;

// Track the element currently under the mouse pointer
document.addEventListener('mousemove', (e) => {
  currentHoveredElement = e.target;
});

// Helper to find image URL from an element (handles overlays, backgrounds, and children)
function findImageFromElement(el) {
  if (!el) return null;

  // 1. Direct Image Element
  if (el.tagName === 'IMG') {
    return el.src;
  }

  // 2. CSS Background Image
  try {
    const inlineBg = el.style.backgroundImage;
    if (inlineBg && inlineBg !== 'none') {
      const match = inlineBg.match(/url\(['"]?([^'"]+)['"]?\)/);
      if (match) return match[1];
    }
    const computedBg = window.getComputedStyle(el).backgroundImage;
    if (computedBg && computedBg !== 'none') {
      const match = computedBg.match(/url\(['"]?([^'"]+)['"]?\)/);
      if (match) return match[1];
    }
  } catch (e) {}

  // 3. Canvas Tag
  if (el.tagName === 'CANVAS') {
    try {
      return el.toDataURL('image/png');
    } catch (e) {}
  }

  // 4. Video Poster Tag
  if (el.tagName === 'VIDEO' && el.poster) {
    return el.poster;
  }

  // 5. Handle transparent overlay case: look for images inside or behind
  const imgChild = el.querySelector('img');
  if (imgChild) return imgChild.src;

  // Check parent background images (up to 3 levels up)
  let parent = el.parentElement;
  for (let i = 0; i < 3 && parent; i++) {
    const parentBg = parent.style.backgroundImage || window.getComputedStyle(parent).backgroundImage;
    if (parentBg && parentBg !== 'none') {
      const match = parentBg.match(/url\(['"]?([^'"]+)['"]?\)/);
      if (match) return match[1];
    }
    parent = parent.parentElement;
  }

  // Check siblings (useful if transparent blocker is placed directly over an img in a common parent container)
  let sibling = el.nextElementSibling;
  while (sibling) {
    if (sibling.tagName === 'IMG') return sibling.src;
    sibling = sibling.nextElementSibling;
  }
  let prevSibling = el.previousElementSibling;
  while (prevSibling) {
    if (prevSibling.tagName === 'IMG') return prevSibling.src;
    prevSibling = prevSibling.previousElementSibling;
  }

  return null;
}

// Show a temporary visual HUD toast in the corner when a download starts
function showDownloadIndicator(url) {
  // Remove existing indicator if present
  const existing = document.getElementById('image-grabber-toast');
  if (existing) existing.remove();

  const filename = getCleanFilename(url);

  const toast = document.createElement('div');
  toast.id = 'image-grabber-toast';
  toast.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px;">
      <span style="font-size:16px;">📥</span>
      <div>
        <div style="font-weight:bold; font-size:12px; color:#00d2ff;">Downloading Image</div>
        <div style="font-size:10px; color:#94a3b8; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${filename}</div>
      </div>
    </div>
  `;

  // Apply premium styling
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    backgroundColor: '#0a0d14',
    color: '#ffffff',
    padding: '12px 18px',
    borderRadius: '10px',
    boxShadow: '0 10px 30px rgba(0, 210, 255, 0.25)',
    border: '1px solid rgba(0, 210, 255, 0.25)',
    zIndex: '999999999',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
    transform: 'translateY(50px) scale(0.9)',
    opacity: '0'
  });

  document.body.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.style.transform = 'translateY(0) scale(1)';
    toast.style.opacity = '1';
  });

  // Animate out after 2.2 seconds
  setTimeout(() => {
    toast.style.transform = 'translateY(20px) scale(0.95)';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2200);
}

// Global hotkey parameters
let shortcutModifier = 'alt'; // default
let shortcutKey = 'p';       // default

// Load configured hotkey settings
chrome.storage.local.get(['shortcutModifier', 'shortcutKey'], (result) => {
  if (result.shortcutModifier !== undefined) shortcutModifier = result.shortcutModifier;
  if (result.shortcutKey !== undefined) shortcutKey = result.shortcutKey;
});

// Update hotkey settings in real time on storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.shortcutModifier) shortcutModifier = changes.shortcutModifier.newValue;
    if (changes.shortcutKey) shortcutKey = changes.shortcutKey.newValue;
  }
});

// Global hotkey listener
document.addEventListener('keydown', (e) => {
  // Validate modifier key
  let modifierMatch = false;
  if (shortcutModifier === 'alt' && e.altKey) modifierMatch = true;
  else if (shortcutModifier === 'ctrl' && e.ctrlKey) modifierMatch = true;
  else if (shortcutModifier === 'shift' && e.shiftKey) modifierMatch = true;
  else if (shortcutModifier === 'meta' && e.metaKey) modifierMatch = true;
  else if (shortcutModifier === 'none' && !e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) modifierMatch = true;

  // Validate character key
  const keyMatch = e.key.toLowerCase() === shortcutKey.toLowerCase();

  if (modifierMatch && keyMatch) {
    const imageUrl = findImageFromElement(currentHoveredElement);
    
    if (imageUrl) {
      e.preventDefault(); // Prevent default browser actions
      
      const filename = getCleanFilename(imageUrl);
      
      // Request download from background script
      chrome.runtime.sendMessage({
        action: 'downloadImage',
        url: imageUrl,
        filename: filename
      }, (response) => {
        if (response && response.success) {
          showDownloadIndicator(imageUrl);
        }
      });
    }
  }
});

// Communication channel with Extension Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getImages') {
    const extracted = extractImages();
    sendResponse({ images: extracted });
  } else if (request.action === 'toggleRightClick') {
    if (request.enabled) {
      enableRightClickUnblocker();
    } else {
      disableRightClickUnblocker();
    }
    sendResponse({ success: true, enabled: request.enabled });
  }
  return true; 
});
