// Handles audio recording and screenshot capture in the tab

let screenshotInterval: number | undefined;
let config = {
  screenshotIntervalSec: 15,
  saveDirectory: "",
};

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];

chrome.storage.local.get(
  ["config"],
  (result: {
    config?: { screenshotIntervalSec: number; saveDirectory: string };
  }) => {
    if (result.config) {
      config = { ...config, ...result.config };
    }
  },
);

chrome.runtime.onMessage.addListener(
  (
    msg: { type: string; [key: string]: unknown },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    if (msg.type === "START_AUDIO_RECORDING") {
      startAudioRecording(msg);
    }
    if (msg.type === "STOP_AUDIO_RECORDING") {
      stopAudioRecording();
    }
    if (msg.type === "START_SCREENSHOT") {
      startScreenshotInterval();
    }
  },
);

function startAudioRecording(msg?: any) {
  // Use chrome.tabCapture stream, not microphone
  chrome.runtime.sendMessage(
    { type: "GET_TAB_STREAM" },
    (response: unknown) => {
      const stream = (window as any).capturedStream; // This should be set by background
      if (!stream) {
        console.error("No tab audio stream available");
        return;
      }
      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/wav" });
      audioChunks = [];
      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
        if (msg && msg.server && msg.serverUrl) {
          // TODO: Implement streaming to server
          // fetch(msg.serverUrl, { method: 'POST', body: event.data });
        }
      };
      mediaRecorder.onstop = () => {
        if (!(msg && msg.server)) {
          const audioBlob = new Blob(audioChunks, { type: "audio/wav" });
          saveBlobToHost(audioBlob, "audio.wav");
        }
      };
      mediaRecorder.start();
    },
  );
}

function stopAudioRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    mediaRecorder = null;
    audioChunks = [];
  }
}

function startScreenshotInterval() {
  if (screenshotInterval) clearInterval(screenshotInterval);
  screenshotInterval = window.setInterval(() => {
    chrome.runtime.sendMessage({ type: "TAKE_SCREENSHOT" });
  }, config.screenshotIntervalSec * 1000);
}

function saveBlobToHost(blob: Blob, filename: string) {
  // Try to trigger download in the page context
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.style.display = "none";
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}
