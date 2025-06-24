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
});
