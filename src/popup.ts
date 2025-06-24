// Handles popup UI logic for starting/stopping recording

document.addEventListener("DOMContentLoaded", () => {
  const recordBtn = document.getElementById("recordBtn") as HTMLButtonElement;
  let isRecording = false;
  let currentTabId: number | null = null;

  function updateButton() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0].id) {
        currentTabId = tabs[0].id;
        // Ask background for current recording state
        chrome.runtime.sendMessage(
          { type: "GET_RECORDING_STATE", tabId: currentTabId },
          (response) => {
            isRecording = !!(response && response.recording);
            recordBtn.textContent = isRecording
              ? "Stop Recording"
              : "Start Recording";
          },
        );
      }
    });
  }

  recordBtn.addEventListener("click", () => {
    if (currentTabId == null) return;
    if (isRecording) {
      // Tell background to stop recording and update badge
      chrome.runtime.sendMessage(
        { type: "STOP_RECORDING", tabId: currentTabId },
        () => {
          updateButton();
        },
      );
    } else {
      // Get screenshot interval from storage (default to 5 seconds)
      chrome.storage.sync.get({ screenshotInterval: 5000 }, (result) => {
        const recorderUrl = chrome.runtime.getURL(
          `recorder.html?tabId=${currentTabId}&screenshotInterval=${result.screenshotInterval}`,
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
              () => {
                updateButton();
              },
            );
          },
        );
      });
    }
  });

  updateButton();
});
