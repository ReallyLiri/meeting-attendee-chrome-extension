// Handles options page logic for configuring screenshot interval and save directory

document.addEventListener('DOMContentLoaded', () => {
  const intervalInput = document.getElementById('screenshotInterval') as HTMLInputElement;
  const directoryInput = document.getElementById('saveDirectory') as HTMLInputElement;
  const serverCheckbox = document.getElementById('serverCheckbox') as HTMLInputElement;
  const serverUrlInput = document.getElementById('serverUrl') as HTMLInputElement;
  const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;

  chrome.storage.local.get(['config'], (result) => {
    if (result.config) {
      intervalInput.value = result.config.screenshotIntervalSec || 15;
      directoryInput.value = result.config.saveDirectory || '';
      serverCheckbox.checked = !!result.config.server;
      serverUrlInput.value = result.config.serverUrl || '';
    }
  });

  saveBtn.addEventListener('click', () => {
    const config = {
      screenshotIntervalSec: parseInt(intervalInput.value, 10),
      saveDirectory: directoryInput.value,
      server: serverCheckbox.checked,
      serverUrl: serverUrlInput.value,
    };
    chrome.runtime.sendMessage({ type: 'UPDATE_CONFIG', config }, (response) => {
      if (response.success) {
        alert('Configuration saved!');
      }
    });
  });
});
