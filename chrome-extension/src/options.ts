// Handles options page logic for configuring screenshot interval and save directory

document.addEventListener("DOMContentLoaded", () => {
  const captureScreenshotsCheckbox = document.getElementById(
    "captureScreenshots",
  ) as HTMLInputElement;
  const captureAudioCheckbox = document.getElementById(
    "captureAudio",
  ) as HTMLInputElement;
  const intervalInput = document.getElementById(
    "screenshotInterval",
  ) as HTMLInputElement;
  const audioBatchInput = document.getElementById(
    "audioBatchInterval",
  ) as HTMLInputElement;
  const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
  const streamToServerCheckbox = document.getElementById(
    "streamToServer",
  ) as HTMLInputElement;
  const serverUrlInput = document.getElementById(
    "serverUrl",
  ) as HTMLInputElement;

  function updateIntervalEnabled() {
    intervalInput.disabled = !captureScreenshotsCheckbox.checked;
  }

  function updateAudioBatchEnabled() {
    audioBatchInput.disabled = !captureAudioCheckbox.checked;
  }

  function updateServerUrlEnabled() {
    serverUrlInput.disabled = !streamToServerCheckbox.checked;
  }

  chrome.storage.local.get(
    ["config"],
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
      if (result.config) {
        captureScreenshotsCheckbox.checked =
          result.config.captureScreenshots !== false;
        captureAudioCheckbox.checked = result.config.captureAudio !== false;
        intervalInput.value = (
          result.config.screenshotIntervalSec || 30
        ).toString();
        audioBatchInput.value = (
          result.config.audioBatchIntervalSec || 60
        ).toString();
        streamToServerCheckbox.checked = result.config.streamToServer !== false;
        serverUrlInput.value =
          result.config.serverUrl || "http://localhost:8017";
      } else {
        captureScreenshotsCheckbox.checked = true;
        captureAudioCheckbox.checked = true;
        intervalInput.value = "30";
        audioBatchInput.value = "60";
        streamToServerCheckbox.checked = true;
        serverUrlInput.value = "http://localhost:8017";
      }
      updateIntervalEnabled();
      updateAudioBatchEnabled();
      updateServerUrlEnabled();
    },
  );

  captureScreenshotsCheckbox.addEventListener("change", updateIntervalEnabled);
  captureAudioCheckbox.addEventListener("change", updateAudioBatchEnabled);
  streamToServerCheckbox.addEventListener("change", updateServerUrlEnabled);

  saveBtn.addEventListener("click", () => {
    const config = {
      captureScreenshots: captureScreenshotsCheckbox.checked,
      captureAudio: captureAudioCheckbox.checked,
      screenshotIntervalSec: parseInt(intervalInput.value, 10),
      audioBatchIntervalSec: parseInt(audioBatchInput.value, 10),
      streamToServer: streamToServerCheckbox.checked,
      serverUrl: serverUrlInput.value,
    };
    chrome.runtime.sendMessage(
      { type: "UPDATE_CONFIG", config },
      (response: { success: boolean }) => {
        if (response.success) {
          alert("Configuration saved!");
        }
      },
    );
  });
});
