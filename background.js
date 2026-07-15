// Initialize extension settings on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ forceRightClick: false });
});

// Orchestrate downloads from background worker to avoid interruptions
// when the popup UI closes.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'downloadImage') {
    chrome.downloads.download({
      url: message.url,
      filename: `ImageGrabber/${message.filename || 'image'}`,
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
