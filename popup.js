// State Management
let allImages = [];
let filteredImages = [];
let selectedImages = new Set();
let activeTabId = null;
let activeTabTitle = 'ImageGrabber';

// UI Elements
const rightClickToggle = document.getElementById('rightClickToggle');
const searchInput = document.getElementById('searchInput');
const sizeFilter = document.getElementById('sizeFilter');
const typeFilter = document.getElementById('typeFilter');
const statusText = document.getElementById('statusText');
const selectAllBtn = document.getElementById('selectAllBtn');
const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
const selectCount = document.getElementById('selectCount');
const imageGrid = document.getElementById('imageGrid');
const loadingState = document.getElementById('loadingState');
const emptyState = document.getElementById('emptyState');
const settingsToggleBtn = document.getElementById('settingsToggleBtn');
const settingsPanel = document.getElementById('settingsPanel');
const modifierSelect = document.getElementById('modifierSelect');
const keySelect = document.getElementById('keySelect');

// Modal Elements
const previewModal = document.getElementById('previewModal');
const modalClose = document.getElementById('modalClose');
const modalImage = document.getElementById('modalImage');
const modalFilename = document.getElementById('modalFilename');
const modalDimensions = document.getElementById('modalDimensions');
const modalDownloadBtn = document.getElementById('modalDownloadBtn');
const modalOverlay = document.querySelector('.modal-overlay');

// Initialize Extension Popup
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showEmptyState("No active tab found.");
    return;
  }
  activeTabId = tab.id;
  activeTabTitle = tab.title || 'ImageGrabber';

  // Restrict running on chrome:// pages
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
    showEmptyState("Extension cannot access browser settings pages.");
    return;
  }

  // 2. Load and apply right-click unblocker toggle state
  chrome.storage.local.get(['forceRightClick', 'shortcutModifier', 'shortcutKey'], (result) => {
    rightClickToggle.checked = !!result.forceRightClick;
    
    // Set custom shortcut selections
    if (result.shortcutModifier !== undefined) {
      modifierSelect.value = result.shortcutModifier;
    } else {
      modifierSelect.value = 'alt'; // default
    }
    
    if (result.shortcutKey !== undefined) {
      keySelect.value = result.shortcutKey;
    } else {
      keySelect.value = 'p'; // default
    }
  });

  // 3. Scan page for images
  scanPageImages();

  // 4. Hook up event listeners
  setupEventListeners();
});

// Event Listener Hooks
function setupEventListeners() {
  // Toggle force right-click unblocker
  rightClickToggle.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    chrome.storage.local.set({ forceRightClick: enabled });
    
    // Send status to content script (inject if necessary)
    chrome.tabs.sendMessage(activeTabId, { action: 'toggleRightClick', enabled }, (response) => {
      if (chrome.runtime.lastError) {
        // Content script not loaded yet, inject it
        chrome.scripting.executeScript({
          target: { tabId: activeTabId },
          files: ['content.js']
        }, () => {
          chrome.tabs.sendMessage(activeTabId, { action: 'toggleRightClick', enabled });
        });
      }
    });
  });

  // Toggle settings drawer
  settingsToggleBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
  });

  // Shortcut Modifier Change
  modifierSelect.addEventListener('change', (e) => {
    chrome.storage.local.set({ shortcutModifier: e.target.value });
  });

  // Shortcut Key Change
  keySelect.addEventListener('change', (e) => {
    chrome.storage.local.set({ shortcutKey: e.target.value });
  });

  // Filters & Search
  searchInput.addEventListener('input', applyFilters);
  sizeFilter.addEventListener('change', applyFilters);
  typeFilter.addEventListener('change', applyFilters);

  // Bulk actions
  selectAllBtn.addEventListener('click', toggleSelectAll);
  downloadSelectedBtn.addEventListener('click', downloadSelectedImages);

  // Modal actions
  modalClose.addEventListener('click', hidePreview);
  modalOverlay.addEventListener('click', hidePreview);
  modalDownloadBtn.addEventListener('click', () => {
    const url = modalImage.src;
    const filename = modalFilename.textContent;
    triggerDownload(url, filename);
  });
}

// Request images from content script
function scanPageImages() {
  showLoading();
  
  chrome.tabs.sendMessage(activeTabId, { action: 'getImages' }, (response) => {
    if (chrome.runtime.lastError) {
      // Content script isn't running yet. Inject it programmatically and retry
      chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        files: ['content.js']
      }, () => {
        // Retry fetch
        chrome.tabs.sendMessage(activeTabId, { action: 'getImages' }, (retryResponse) => {
          if (chrome.runtime.lastError || !retryResponse || !retryResponse.images) {
            showEmptyState("Could not scan the page. Make sure the page is fully loaded and refresh.");
          } else {
            processImages(retryResponse.images);
          }
        });
      });
    } else if (response && response.images) {
      processImages(response.images);
    } else {
      showEmptyState("No response from content script.");
    }
  });
}

// Process and resolve sizes of fetched images
async function processImages(images) {
  allImages = images;
  
  if (allImages.length === 0) {
    showEmptyState();
    return;
  }

  // Render initial list immediately
  applyFilters();
  
  // Resolve image dimensions in the background
  allImages.forEach(img => {
    if (img.width === 0 || img.height === 0) {
      const temp = new Image();
      temp.onload = () => {
        img.width = temp.naturalWidth;
        img.height = temp.naturalHeight;
        // Re-apply filter/render to update details in the UI
        updateGridImageDetails(img.url, img.width, img.height);
      };
      temp.src = img.url;
    }
  });
}

// Filter and Search Logic
function applyFilters() {
  const query = searchInput.value.toLowerCase();
  const minSize = parseInt(sizeFilter.value, 10);
  const type = typeFilter.value;

  filteredImages = allImages.filter(img => {
    // 1. Search Query Match (alt text or URL)
    const matchesSearch = img.url.toLowerCase().includes(query) || (img.alt && img.alt.toLowerCase().includes(query));
    if (!matchesSearch) return false;

    // 2. Size Filter Match
    // If dimensions aren't resolved yet, let it pass through (resolved dynamically later)
    if (minSize > 0 && img.width > 0 && img.height > 0) {
      if (img.width < minSize && img.height < minSize) return false;
    }

    // 3. Format/Type Filter Match
    if (type !== 'all') {
      if (type === 'data') {
        if (!img.url.startsWith('data:')) return false;
      } else {
        if (img.url.startsWith('data:')) return false;
        
        // Match extension
        let fileExt = '';
        try {
          const pathname = new URL(img.url).pathname;
          fileExt = pathname.substring(pathname.lastIndexOf('.') + 1).toLowerCase();
        } catch (e) {}

        if (type === 'jpg') {
          if (fileExt !== 'jpg' && fileExt !== 'jpeg') return false;
        } else {
          if (fileExt !== type) return false;
        }
      }
    }

    return true;
  });

  renderGrid();
}

// Render the grid elements
function renderGrid() {
  imageGrid.innerHTML = '';
  
  if (filteredImages.length === 0) {
    imageGrid.classList.add('hidden');
    emptyState.classList.remove('hidden');
    loadingState.classList.add('hidden');
    statusText.textContent = '0 images found';
    updateSelectionUI();
    return;
  }

  emptyState.classList.add('hidden');
  loadingState.classList.add('hidden');
  imageGrid.classList.remove('hidden');
  
  statusText.textContent = `${filteredImages.length} images found`;

  // Render cards
  filteredImages.forEach(img => {
    const card = document.createElement('div');
    card.className = `image-card ${selectedImages.has(img.url) ? 'selected' : ''}`;
    card.dataset.url = img.url;

    // Checkbox overlay
    const checkbox = document.createElement('div');
    checkbox.className = 'card-checkbox';
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation(); // Avoid opening preview
      toggleCardSelection(card, img.url);
    });
    card.appendChild(checkbox);

    // Image tag
    const imageEl = document.createElement('img');
    imageEl.src = img.url;
    imageEl.loading = 'lazy';
    // Fallback if load fails
    imageEl.onerror = () => {
      imageEl.src = 'icons/icon128.png'; // Show logo placeholder
      imageEl.style.opacity = '0.3';
    };
    card.appendChild(imageEl);

    // Info overlay on hover
    const overlay = document.createElement('div');
    overlay.className = 'card-overlay';
    
    const dims = document.createElement('div');
    dims.className = 'card-dims';
    dims.id = `dims-${btoa(img.url).replace(/=/g, '')}`; // ID safe string
    dims.textContent = img.width && img.height ? `${img.width}x${img.height}` : 'Resolving size...';
    overlay.appendChild(dims);

    const typeText = document.createElement('div');
    typeText.className = 'card-type';
    typeText.textContent = getImageExtensionLabel(img.url);
    overlay.appendChild(typeText);

    card.appendChild(overlay);

    // Click handler to preview image
    card.addEventListener('click', (e) => {
      // If user clicked inside the checkbox, do nothing
      if (e.target.closest('.card-checkbox')) return;
      showPreview(img);
    });

    imageGrid.appendChild(card);
  });

  updateSelectionUI();
}

// Update specific image dimension text in grid when natural size is resolved
function updateGridImageDetails(url, width, height) {
  const safeId = `dims-${btoa(url).replace(/=/g, '')}`;
  const dimEl = document.getElementById(safeId);
  if (dimEl) {
    dimEl.textContent = `${width}x${height}`;
  }
}

// Toggle individual image selection
function toggleCardSelection(card, url) {
  if (selectedImages.has(url)) {
    selectedImages.delete(url);
    card.classList.remove('selected');
  } else {
    selectedImages.add(url);
    card.classList.add('selected');
  }
  updateSelectionUI();
}

// Toggle Selection of All Filtered Images
function toggleSelectAll() {
  const allFilteredSelected = filteredImages.every(img => selectedImages.has(img.url));

  if (allFilteredSelected) {
    // Deselect all filtered images
    filteredImages.forEach(img => selectedImages.delete(img.url));
  } else {
    // Select all filtered images
    filteredImages.forEach(img => selectedImages.add(img.url));
  }
  
  // Re-render to update classes
  renderGrid();
}

// Update counters and button states
function updateSelectionUI() {
  // Sync selected list with currently visible (filtered) images
  // to avoid downloading non-visible items accidentally
  const visibleSelectedCount = filteredImages.filter(img => selectedImages.has(img.url)).length;
  
  selectCount.textContent = visibleSelectedCount;
  downloadSelectedBtn.disabled = visibleSelectedCount === 0;

  if (filteredImages.length > 0 && visibleSelectedCount === filteredImages.length) {
    selectAllBtn.textContent = 'Deselect All';
  } else {
    selectAllBtn.textContent = 'Select All';
  }
}

// Preview Modal Control
function showPreview(img) {
  modalImage.src = img.url;
  modalFilename.textContent = img.filename;
  modalDimensions.textContent = img.width && img.height ? `${img.width} x ${img.height} px` : 'Resolving size...';
  
  // Update dimensions if not loaded yet
  if (!img.width || !img.height) {
    const temp = new Image();
    temp.onload = () => {
      modalDimensions.textContent = `${temp.naturalWidth} x ${temp.naturalHeight} px`;
    };
    temp.src = img.url;
  }
  
  previewModal.classList.remove('hidden');
}

function hidePreview() {
  previewModal.classList.add('hidden');
  modalImage.src = '';
}

// Download Triggering
function triggerDownload(url, filename) {
  chrome.runtime.sendMessage({
    action: 'downloadImage',
    url: url,
    filename: filename,
    pageTitle: activeTabTitle
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError);
    } else if (response && !response.success) {
      console.error("Download failed:", response.error);
    }
  });
}

// Bulk downloads with a slight throttle/delay to prevent chrome throttling
async function downloadSelectedImages() {
  const imagesToDownload = filteredImages.filter(img => selectedImages.has(img.url));
  if (imagesToDownload.length === 0) return;

  statusText.textContent = `Downloading 0/${imagesToDownload.length}...`;
  downloadSelectedBtn.disabled = true;

  for (let i = 0; i < imagesToDownload.length; i++) {
    const img = imagesToDownload[i];
    statusText.textContent = `Downloading ${i + 1}/${imagesToDownload.length}...`;
    triggerDownload(img.url, img.filename);
    
    // Throttle sequential downloads by 150ms
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  statusText.textContent = `Successfully triggered ${imagesToDownload.length} downloads`;
  // Reset selection
  selectedImages.clear();
  renderGrid();
}

// Helper: Get visual type label
function getImageExtensionLabel(url) {
  if (url.startsWith('data:')) {
    const mimeMatch = url.match(/^data:(image\/[a-z0-9-+.]+);base64,/);
    if (mimeMatch) {
      return mimeMatch[1].split('/')[1].toUpperCase();
    }
    return 'DATA';
  }
  
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.substring(pathname.lastIndexOf('.') + 1).toLowerCase();
    if (ext && ext.length <= 4) return ext.toUpperCase();
  } catch (e) {}
  
  return 'IMG';
}

// Helper: Show/Hide Loading/Empty UI states
function showLoading() {
  loadingState.classList.remove('hidden');
  emptyState.classList.add('hidden');
  imageGrid.classList.add('hidden');
  statusText.textContent = 'Scanning...';
}

function showEmptyState(message = '') {
  loadingState.classList.add('hidden');
  imageGrid.classList.add('hidden');
  emptyState.classList.remove('hidden');
  if (message) {
    document.querySelector('.empty-desc').textContent = message;
  }
  statusText.textContent = '0 images found';
}
