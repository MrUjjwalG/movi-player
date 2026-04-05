// Play URL
document.getElementById("play").addEventListener("click", () => {
  const url = document.getElementById("url").value.trim();
  if (url) {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`player.html?url=${encodeURIComponent(url)}`),
    });
    window.close();
  }
});

document.getElementById("url").addEventListener("keypress", (e) => {
  if (e.key === "Enter") document.getElementById("play").click();
});

// Open local file — opens player page where user picks file
document.getElementById("file").addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("player.html?file"),
  });
  window.close();
});

// Auto-focus URL input
document.getElementById("url").focus();
