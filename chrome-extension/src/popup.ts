// Handles popup UI logic for starting/stopping recording

document.addEventListener("DOMContentLoaded", () => {
  const recordBtn = document.getElementById("recordBtn") as HTMLButtonElement;
  let isRecording = false;
  let currentTabId: number | null = null;

  function updateButton() {
    chrome.tabs.query(
      { active: true, currentWindow: true },
      (tabs: chrome.tabs.Tab[]) => {
        if (tabs[0].id) {
          currentTabId = tabs[0].id;
          // Ask background for current recording state
          chrome.runtime.sendMessage(
            { type: "GET_RECORDING_STATE", tabId: currentTabId },
            (response: { recording?: boolean }) => {
              isRecording = !!(response && response.recording);
              recordBtn.textContent = isRecording
                ? "Stop Recording"
                : "Start Recording";
            },
          );
        }
      },
    );
  }

  recordBtn.addEventListener("click", () => {
    if (currentTabId == null) return;
    if (isRecording) {
      // Tell background to stop recording and update badge
      chrome.runtime.sendMessage(
        { type: "STOP_RECORDING", tabId: currentTabId },
        () => {
          chrome.storage.local.remove("activeRecording", () => {
            updateButton();
          });
        },
      );
    } else {
      // Get config from storage (default to screenshots/audio enabled, 5s interval)
      chrome.storage.local.get(
        {
          config: {
            captureScreenshots: true,
            captureAudio: true,
            screenshotIntervalSec: 30,
            audioBatchIntervalSec: 60,
            streamToServer: true,
            serverUrl: "http://localhost:8017",
          },
        },
        (result: {
          config?: {
            captureScreenshots?: boolean;
            captureAudio?: boolean;
            screenshotIntervalSec?: number;
            audioBatchIntervalSec?: number;
            streamToServer?: boolean;
            serverUrl?: string;
          };
        }) => {
          const config = result.config || {};
          chrome.storage.local.set(
            { activeRecording: { tabId: currentTabId, config } },
            () => {
              const recorderUrl = chrome.runtime.getURL(
                `recorder.html?tabId=${currentTabId}` +
                  `&screenshotInterval=${config.screenshotIntervalSec}` +
                  `&captureScreenshots=${config.captureScreenshots ? "1" : "0"}` +
                  `&captureAudio=${config.captureAudio ? "1" : "0"}` +
                  `&streamToServer=${config.streamToServer ? "1" : "0"}` +
                  `&serverUrl=${encodeURIComponent(config.serverUrl || "http://localhost:8017")}`,
              );
              // Tell background to start recording and update badge
              chrome.runtime.sendMessage(
                { type: "START_RECORDING", tabId: currentTabId },
                () => {
                  chrome.tabs.create(
                    {
                      url: recorderUrl,
                      active: false,
                    },
                    (tab: chrome.tabs.Tab) => {
                      if (tab && tab.id) {
                        // Register the recorder tab with the background script
                        chrome.runtime.sendMessage({
                          type: "REGISTER_RECORDER_TAB",
                          recorderTabId: tab.id,
                          targetTabId: currentTabId,
                        });
                      }
                      updateButton();
                    },
                  );
                },
              );
            },
          );
        },
      );
    }
  });

  updateButton();
});
