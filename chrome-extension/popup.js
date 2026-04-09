// Paste & Play — read from clipboard
document.getElementById("paste").addEventListener("click", async () => {
  const hint = document.getElementById("paste-hint");
  try {
    const text = await navigator.clipboard.readText();
    const url = text.trim();
    if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
      chrome.tabs.create({
        url: chrome.runtime.getURL(`player.html?url=${encodeURIComponent(url)}`),
      });
      window.close();
    } else {
      hint.textContent = "No video link in clipboard";
      hint.style.color = "#ef4444";
      setTimeout(() => { hint.textContent = "Play a video link from clipboard"; hint.style.color = ""; }, 2000);
    }
  } catch {
    hint.textContent = "Clipboard access needed";
    hint.style.color = "#f59e0b";
    setTimeout(() => { hint.textContent = "Play a video link from clipboard"; hint.style.color = ""; }, 2000);
  }
});

// Play from Computer
document.getElementById("file").addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("player.html?file"),
  });
  window.close();
});
