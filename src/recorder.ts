(() => {
  // This script runs in recorder.html and manages tab audio capture and recording

  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let capturedStream: MediaStream | null = null;
  let targetTabId: number | null = null;
  let screenshotInterval: number | null = null;
  const AUDIO_MIME_TYPE = "audio/webm;codecs=opus";

  const beforeUnloadHandler = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue =
      "Are you sure you want to leave? The recording will be lost.";
  };

  // Utility: Normalize a string for filenames
  function normalizeTitle(title: string): string {
    return title
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
  }

  // Utility: Format timestamp as yyyy.mm.dd.hh.mm
  function getTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}.${pad(now.getHours())}.${pad(now.getMinutes())}`;
  }

  // Utility: Get normalized filename for a tab and extension
  async function getTabFilename(tabId: number, ext: string): Promise<string> {
    const tab = await new Promise<chrome.tabs.Tab | undefined>((resolve) => {
      chrome.tabs.get(tabId, (t) => resolve(t));
    });
    const title = normalizeTitle(tab?.title || "tab");
    const timestamp = getTimestamp();
    return `${title}_${timestamp}.${ext}`;
  }

  // Utility: Download a blob or data URL with a given filename
  function triggerDownload(url: string, filename: string) {
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
    }, 100);
  }

  async function captureScreenshot(): Promise<void> {
    if (!targetTabId) return;
    try {
      // Request screenshot from background
      const screenshot = await new Promise<string>((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: "TAKE_SCREENSHOT", tabId: targetTabId },
          (response) => {
            if (chrome.runtime.lastError || !response || !response.dataUrl) {
              console.error(
                "Screenshot error:",
                chrome.runtime.lastError,
                response,
              );
              reject(
                chrome.runtime.lastError || new Error("No screenshot data"),
              );
            } else {
              resolve(response.dataUrl);
            }
          },
        );
      });
      // Download screenshot immediately
      const filename = await getTabFilename(targetTabId, "png");
      triggerDownload(screenshot, filename);
    } catch (error) {
      console.error("Failed to capture screenshot:", error);
    }
  }

  function startScreenshotCapture(intervalMs?: number): void {
    captureScreenshot();
    screenshotInterval = window.setInterval(
      captureScreenshot,
      intervalMs || 5000,
    );
  }

  function stopScreenshotCapture(): void {
    if (screenshotInterval !== null) {
      clearInterval(screenshotInterval);
      screenshotInterval = null;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
    const statusDiv = document.getElementById("status") as HTMLDivElement;
    chrome.storage.local.get(["activeRecording"], (result) => {
      const active = result.activeRecording;
      if (!active || !active.tabId) {
        statusDiv.textContent = "No target tab specified.";
        return;
      }
      targetTabId = active.tabId;
      const config = active.config || {};
      const captureScreenshots = config.captureScreenshots !== false;
      const captureAudio = config.captureAudio !== false;
      const screenshotIntervalSec = config.screenshotIntervalSec || 5;
      statusDiv.textContent = "Requesting tab audio capture...";
      console.log("Requesting tab capture from background", {
        tabId: targetTabId,
        captureAudio,
      });
      // Request tab capture from background
      chrome.runtime.sendMessage(
        { type: "REQUEST_TAB_CAPTURE", tabId: targetTabId, captureAudio },
        (response) => {
          console.log(
            "Tab capture response from background:",
            response,
            chrome.runtime.lastError,
          );
          if (!response || !response.success) {
            statusDiv.textContent =
              "Tab capture failed: " + (response?.error || "Unknown error");
            console.error(
              "Tab capture failed response:",
              response,
              chrome.runtime.lastError,
            );
            return;
          }
          console.log("Calling chrome.tabCapture.capture", {
            audio: captureAudio,
            video: false,
          });
          chrome.tabCapture.capture(
            {
              audio: captureAudio,
              video: false,
            },
            (stream) => {
              if (chrome.runtime.lastError || (!stream && captureAudio)) {
                statusDiv.textContent =
                  "Tab capture failed: " + chrome.runtime.lastError?.message;
                console.error(
                  "chrome.tabCapture.capture failed:",
                  chrome.runtime.lastError,
                  stream,
                );
                return;
              }

              capturedStream = stream;
              statusDiv.textContent = "Recording...";
              window.addEventListener("beforeunload", beforeUnloadHandler);

              if (captureAudio && stream) {
                mediaRecorder = new MediaRecorder(stream, {
                  mimeType: AUDIO_MIME_TYPE,
                  audioBitsPerSecond: 32000,
                });
                audioChunks = [];
                mediaRecorder.ondataavailable = (event) => {
                  audioChunks.push(event.data);
                };
                mediaRecorder.onstop = () => {
                  window.removeEventListener(
                    "beforeunload",
                    beforeUnloadHandler,
                  );
                  const audioBlob = new Blob(audioChunks, {
                    type: AUDIO_MIME_TYPE,
                  });
                  const url = URL.createObjectURL(audioBlob);
                  // Download audio file with normalized filename
                  getTabFilename(targetTabId!, "webm").then((filename) => {
                    triggerDownload(url, filename);
                    setTimeout(() => {
                      URL.revokeObjectURL(url);
                      // Take a final screenshot before finishing
                      if (captureScreenshots) {
                        captureScreenshot().then(() => {
                          statusDiv.textContent =
                            "Recording stopped and downloaded.";
                          // Notify background to update badge/state
                          if (targetTabId) {
                            chrome.runtime.sendMessage({
                              type: "STOP_RECORDING",
                              tabId: targetTabId,
                            });
                          }
                          window.close();
                        });
                      } else {
                        statusDiv.textContent =
                          "Recording stopped and downloaded.";
                        if (targetTabId) {
                          chrome.runtime.sendMessage({
                            type: "STOP_RECORDING",
                            tabId: targetTabId,
                          });
                        }
                        window.close();
                      }
                    }, 100);
                  });
                };
                mediaRecorder.start();
              } else {
                // No audio, just screenshots
                statusDiv.textContent = "Recording... (screenshots only)";
                if (captureScreenshots) {
                  startScreenshotCapture(screenshotIntervalSec * 1000);
                }
              }

              if (captureScreenshots && captureAudio && stream) {
                startScreenshotCapture(screenshotIntervalSec * 1000);
              }
            },
          );
        },
      );

      stopBtn.addEventListener("click", () => {
        if (mediaRecorder && mediaRecorder.state !== "inactive") {
          stopScreenshotCapture();
          mediaRecorder.stop();
          if (capturedStream) {
            capturedStream.getTracks().forEach((track) => track.stop());
          }
          if (targetTabId) {
            chrome.runtime.sendMessage({
              type: "STOP_RECORDING",
              tabId: targetTabId,
            });
          }
        } else {
          stopScreenshotCapture();
          if (captureScreenshots) {
            captureScreenshot().then(() => {
              statusDiv.textContent = "Recording stopped and downloaded.";
              if (targetTabId) {
                chrome.runtime.sendMessage({
                  type: "STOP_RECORDING",
                  tabId: targetTabId,
                });
              }
              window.close();
            });
          } else {
            statusDiv.textContent = "Recording stopped.";
            if (targetTabId) {
              chrome.runtime.sendMessage({
                type: "STOP_RECORDING",
                tabId: targetTabId,
              });
            }
            window.close();
          }
        }
      });

      // Listen for STOP_RECORDING messages from popup/background
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === "STOP_RECORDING") {
          stopBtn.click();
        }
      });
    });
  });
})();
