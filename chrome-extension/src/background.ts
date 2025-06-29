// Handles extension activation, tab audio capture, and communication with content scripts

let recordingTabs: Record<number, boolean> = {};
// Map from recorderTabId to targetTabId
let recorderTabToTargetTab: Record<number, number> = {};
// Track which tabs have the debugger attached
let debuggerAttachedTabs: Record<number, boolean> = {};

function updateBadge(tabId: number, recording: boolean) {
  console.log(`updateBadge: tabId=${tabId}, recording=${recording}`);
  chrome.action.setBadgeText({ tabId, text: recording ? "REC" : "" });
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: recording ? "#d00" : "#000",
  });
}

interface Message {
  type: string;
  tabId?: number;
  config?: unknown;
  recorderTabId?: number;
  targetTabId?: number;
  captureAudio?: boolean;
}

// Listen for configuration changes from options page
chrome.runtime.onMessage.addListener(
  (
    msg: Message,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
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
      // Attach debugger if not already attached
      if (typeof msg.tabId === "number" && !debuggerAttachedTabs[msg.tabId]) {
        chrome.debugger.attach({ tabId: msg.tabId }, "1.3", () => {
          debuggerAttachedTabs[msg.tabId!] = true;
        });
      }
      sendResponse({ recording: true });
      return true;
    }
    if (msg.type === "STOP_RECORDING" && msg.tabId) {
      console.log(`STOP_RECORDING for tabId=${msg.tabId}`);
      recordingTabs[msg.tabId] = false;
      updateBadge(msg.tabId, false);
      // Detach debugger if attached
      if (typeof msg.tabId === "number" && debuggerAttachedTabs[msg.tabId]) {
        chrome.debugger.detach({ tabId: msg.tabId }, () => {
          debuggerAttachedTabs[msg.tabId!] = false;
        });
      }
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
      const senderTab = sender && sender.tab;
      const width = senderTab?.width;
      const height = senderTab?.height;
      const x = 0;
      const y = 0;
      function doCapture() {
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
              const data = (result as { data?: string })?.data;
              if (data) {
                sendResponse({ dataUrl: "data:image/png;base64," + data });
              } else {
                sendResponse({ error: "Failed to capture screenshot" });
              }
            },
          );
        });
      }
      if (debuggerAttachedTabs[msg.tabId]) {
        doCapture();
      } else {
        chrome.debugger.attach(debuggee, "1.3", () => {
          debuggerAttachedTabs[msg.tabId!] = true;
          doCapture();
        });
      }
      return true;
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
    if (msg.type === "REQUEST_TAB_CAPTURE" && msg.tabId) {
      console.log(
        "REQUEST_TAB_CAPTURE received for tabId=",
        msg.tabId,
        "captureAudio=",
        msg.captureAudio,
      );
      // This is just an ack for the recorder page, actual capture is done in the page context
      sendResponse({ success: true });
      return true;
    }
  },
);

// Listen for tab removal to handle forced recorder tab closure
chrome.tabs.onRemoved.addListener(
  (tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => {
    if (recorderTabToTargetTab[tabId]) {
      const targetTabId = recorderTabToTargetTab[tabId];
      console.log(
        `Recorder tab ${tabId} closed, stopping recording for target tab ${targetTabId}`,
      );
      recordingTabs[targetTabId] = false;
      updateBadge(targetTabId, false);
      delete recorderTabToTargetTab[tabId];
    }
  },
);

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== undefined) {
    debuggerAttachedTabs[source.tabId] = false;
    console.warn(`Debugger detached from tab ${source.tabId}: ${reason}`);
  }
});
