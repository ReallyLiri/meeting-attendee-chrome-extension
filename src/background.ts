// Handles extension activation, tab audio capture, and communication with content scripts

let recordingTabs: Record<number, boolean> = {};
// Map from recorderTabId to targetTabId
let recorderTabToTargetTab: Record<number, number> = {};

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
    // Use sender.tab for viewport size if available
    const senderTab = sender && sender.tab;
    const width = senderTab?.width;
    const height = senderTab?.height;
    const x = 0;
    const y = 0;
    chrome.debugger.attach(debuggee, "1.3", () => {
      chrome.debugger.sendCommand(debuggee, "Page.enable", {}, () => {
        const params: any = {
          format: "png",
          quality: 100,
          captureBeyondViewport: false,
          fromSurface: true,
        };
        if (width && height) {
          params.clip = { x, y, width, height, scale: 1 };
        }
        chrome.debugger.sendCommand(
          debuggee,
          "Page.captureScreenshot",
          params,
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
  if (
    msg.type === "REGISTER_RECORDER_TAB" &&
    msg.recorderTabId &&
    msg.targetTabId
  ) {
    recorderTabToTargetTab[msg.recorderTabId] = msg.targetTabId;
    console.log(
      `Registered recorder tab ${msg.recorderTabId} for target tab ${msg.targetTabId}`,
    );
    sendResponse({ success: true });
    return true;
  }
});

// Listen for tab removal to handle forced recorder tab closure
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (recorderTabToTargetTab[tabId]) {
    const targetTabId = recorderTabToTargetTab[tabId];
    console.log(
      `Recorder tab ${tabId} closed, stopping recording for target tab ${targetTabId}`,
    );
    recordingTabs[targetTabId] = false;
    updateBadge(targetTabId, false);
    delete recorderTabToTargetTab[tabId];
  }
});
