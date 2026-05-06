const statusEl = document.getElementById("status");

function setStatus(text, className) {
  statusEl.textContent = text;
  statusEl.className = className || "";
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "progress") {
    if (message.phase === "nested") {
      setStatus(
        `Fetching nested replies… ${message.processed}/${message.totalParents} threads (${message.totalReplies} total)`,
        "progress"
      );
    } else {
      setStatus(
        `Fetching root comments… page ${message.page}, ${message.totalReplies} replies`,
        "progress"
      );
    }
  } else if (message.action === "complete") {
    setStatus(
      `Exported ${message.replyCount} replies to ${message.filename}`,
      "success"
    );
  } else if (message.action === "error") {
    setStatus(message.message, "error");
  }
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab || !tab.url) {
    setStatus("Cannot access current tab.", "error");
    return;
  }
  const match = tab.url.match(/\/chat\/\d+\/post\/([0-9a-f-]{36})/i);
  if (!match) {
    setStatus("Navigate to a Substack chat thread first.", "error");
    return;
  }
  const postId = match[1];
  setStatus("Starting export…", "progress");
  chrome.runtime.sendMessage({ action: "export", postId });
});
