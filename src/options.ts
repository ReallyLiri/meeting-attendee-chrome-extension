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
  const serverCheckbox = document.getElementById(
    "serverCheckbox",
  ) as HTMLInputElement;
  const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;

  function updateIntervalEnabled() {
    intervalInput.disabled = !captureScreenshotsCheckbox.checked;
  }

  chrome.storage.local.get(["config"], (result) => {
    if (result.config) {
      captureScreenshotsCheckbox.checked =
        result.config.captureScreenshots !== false;
      captureAudioCheckbox.checked = result.config.captureAudio !== false;
      intervalInput.value = result.config.screenshotIntervalSec || 15;
      serverCheckbox.checked = !!result.config.server;
    } else {
      captureScreenshotsCheckbox.checked = true;
      captureAudioCheckbox.checked = true;
    }
    updateIntervalEnabled();
  });

  captureScreenshotsCheckbox.addEventListener("change", updateIntervalEnabled);

  saveBtn.addEventListener("click", () => {
    const config = {
      captureScreenshots: captureScreenshotsCheckbox.checked,
      captureAudio: captureAudioCheckbox.checked,
      screenshotIntervalSec: parseInt(intervalInput.value, 10),
      server: serverCheckbox.checked,
    };
    chrome.runtime.sendMessage(
      { type: "UPDATE_CONFIG", config },
      (response) => {
        if (response.success) {
          alert("Configuration saved!");
        }
      },
    );
  });
});
