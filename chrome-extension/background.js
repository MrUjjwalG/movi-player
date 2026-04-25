// Context menu: "Open with Movi Player" on links and on <video> elements
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "open-with-movi",
    title: "Open with Movi Player",
    contexts: ["link", "video"],
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== "open-with-movi") return;
  // For <video> right-click, Chrome sets info.srcUrl to the media URL.
  // For <a> right-click, info.linkUrl has the link URL.
  const url = info.srcUrl || info.linkUrl;
  if (!url) return;
  const playerUrl = chrome.runtime.getURL(
    `player.html?url=${encodeURIComponent(url)}`
  );
  chrome.tabs.create({ url: playerUrl });
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.action === "openPlayer") {
    const playerUrl = chrome.runtime.getURL(
      `player.html?url=${encodeURIComponent(message.url)}`
    );
    if (message.replaceTab && sender.tab?.id != null) {
      chrome.tabs.update(sender.tab.id, { url: playerUrl });
    } else {
      chrome.tabs.create({ url: playerUrl });
    }
  }
});
