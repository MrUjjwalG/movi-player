// Context menu: "Open with Movi Player" on any link
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "open-with-movi",
    title: "Open with Movi Player",
    contexts: ["link"],
    targetUrlPatterns: [
      "*://*/*.mp4*",
      "*://*/*.mkv*",
      "*://*/*.webm*",
      "*://*/*.mov*",
      "*://*/*.avi*",
      "*://*/*.ts*",
      "*://*/*.m3u8*",
      "*://*/*.flv*",
      "*://*/*.m4v*",
      "*://*/*.ogv*",
      "*://*/*.wmv*",
    ],
  });

  // Also add for all links (user can try any URL)
  chrome.contextMenus.create({
    id: "try-with-movi",
    title: "Try with Movi Player",
    contexts: ["link"],
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "open-with-movi" || info.menuItemId === "try-with-movi") {
    const videoUrl = info.linkUrl;
    if (videoUrl) {
      // Open player in new tab
      const playerUrl = chrome.runtime.getURL(
        `player.html?url=${encodeURIComponent(videoUrl)}`
      );
      chrome.tabs.create({ url: playerUrl });
    }
  }
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "openPlayer") {
    const playerUrl = chrome.runtime.getURL(
      `player.html?url=${encodeURIComponent(message.url)}`
    );
    chrome.tabs.create({ url: playerUrl });
  }
});
