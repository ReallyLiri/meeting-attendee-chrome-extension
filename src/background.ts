// Handles extension activation, tab audio capture, and communication with content scripts

let recordingTabs: Record<number, boolean> = {};

function updateBadge(tabId: number, recording: boolean) {
  console.log(`updateBadge: tabId=${tabId}, recording=${recording}`);
  chrome.action.setBadgeText({ tabId, text: recording ? "REC" : "" });
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: recording ? "#d00" : "#000",
  });
}

// Listen for configuration changes from options page
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("background received message", msg);
  if (msg.type === "UPDATE_CONFIG") {
    chrome.storage.local.set({ config: msg.config }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
  if (msg.type === "START_RECORDING" && msg.tabId) {
    console.log(`START_RECORDING for tabId=${msg.tabId}`);
    recordingTabs[msg.tabId] = true;
    updateBadge(msg.tabId, true);
    sendResponse({ recording: true });
    return true;
  }
  if (msg.type === "STOP_RECORDING" && msg.tabId) {
    console.log(`STOP_RECORDING for tabId=${msg.tabId}`);
    recordingTabs[msg.tabId] = false;
    updateBadge(msg.tabId, false);
    sendResponse({ recording: false });
    return true;
  }
  if (msg.type === "GET_RECORDING_STATE" && msg.tabId) {
    console.log(
      `GET_RECORDING_STATE for tabId=${msg.tabId}, state=${!!recordingTabs[msg.tabId]}`,
    );
    sendResponse({ recording: !!recordingTabs[msg.tabId] });
    return true;
  }
  if (msg.type === "TAKE_SCREENSHOT" && msg.tabId) {
    console.log(`TAKE_SCREENSHOT for tabId=${msg.tabId}`);
    const debuggee = { tabId: msg.tabId };
    chrome.debugger.attach(debuggee, "1.3", () => {
      chrome.debugger.sendCommand(debuggee, "Page.enable", {}, () => {
        chrome.debugger.sendCommand(
          debuggee,
          "Page.captureScreenshot",
          {
            format: "png",
            quality: 100,
            captureBeyondViewport: true,
            fromSurface: true,
          },
          (result) => {
            chrome.debugger.detach(debuggee, () => {
              const data = (result as { data?: string }).data;
              if (data) {
                sendResponse({ dataUrl: "data:image/png;base64," + data });
              } else {
                sendResponse({ error: "Failed to capture screenshot" });
              }
            });
          },
        );
      });
    });
    return true; // Keep the message channel open for async response
  }
});
