// Initialize extension settings on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ forceRightClick: false });
});

// Sanitizes the folder name to prevent illegal filesystem characters
function sanitizeFolderName(title) {
  if (!title) return 'ImageGrabber';
  // Replace illegal characters: \ / : * ? " < > |
  let sanitized = title.replace(/[\\/:*?"<>|]/g, '_').trim();
  // Strip trailing spaces and dots
  sanitized = sanitized.replace(/[\s.]+$/, '');
  return sanitized || 'ImageGrabber';
}

// Orchestrate downloads from background worker to avoid interruptions
// when the popup UI closes.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'downloadImage') {
    const folder = sanitizeFolderName(message.pageTitle);
    chrome.downloads.download({
      url: message.url,
      filename: `${folder}/${message.filename || 'image'}`,
      saveAs: false,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    });
    return true; // Keeps the message channel open for async sendResponse
  }
});
