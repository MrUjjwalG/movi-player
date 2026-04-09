// Context menu: "Open with Movi Player" on all links
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "open-with-movi",
    title: "Open with Movi Player",
    contexts: ["link"],
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "open-with-movi" && info.linkUrl) {
    const playerUrl = chrome.runtime.getURL(
      `player.html?url=${encodeURIComponent(info.linkUrl)}`
    );
    chrome.tabs.create({ url: playerUrl });
  }
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "openPlayer") {
    const playerUrl = chrome.runtime.getURL(
      `player.html?url=${encodeURIComponent(message.url)}`
    );
    chrome.tabs.create({ url: playerUrl });
  }
});
