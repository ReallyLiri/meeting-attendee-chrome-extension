(() => {
  // This script runs in recorder.html and manages tab audio capture and recording

  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let capturedStream: MediaStream | null = null;
  let targetTabId: number | null = null;
  let screenshotInterval: number | null = null;
  let screenshots: { timestamp: number; data: string }[] = [];
  const AUDIO_MIME_TYPE = "audio/webm;codecs=opus";

  const beforeUnloadHandler = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue =
      "Are you sure you want to leave? The recording will be lost.";
  };

  function getQueryParam(name: string): string | null {
    const url = new URL(window.location.href);
    return url.searchParams.get(name);
  }

  function getBoolQueryParam(name: string, defaultValue: boolean): boolean {
    const val = getQueryParam(name);
    if (val === null) return defaultValue;
    return val === "1" || val.toLowerCase() === "true";
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
      console.log("Screenshot captured", screenshot.slice(0, 30));
      screenshots.push({
        timestamp: Date.now(),
        data: screenshot,
      });
      console.log("Screenshots array length:", screenshots.length);
    } catch (error) {
      console.error("Failed to capture screenshot:", error);
    }
  }

  function downloadScreenshots(): Promise<void> {
    console.log("Downloading screenshots, count:", screenshots.length);
    if (screenshots.length === 0) {
      alert("No screenshots captured.");
      return Promise.resolve();
    }
    const zip = new JSZip();
    screenshots.forEach((screenshot, index) => {
      // Convert base64 to blob
      const imageData = screenshot.data.replace(/^data:image\/png;base64,/, "");
      zip.file(`screenshot_${screenshot.timestamp}.png`, imageData, {
        base64: true,
      });
    });

    return zip.generateAsync({ type: "blob" }).then((content: Blob) => {
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      a.style.display = "none";
      a.href = url;
      a.download = "screenshots.zip";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    });
  }

  function startScreenshotCapture(): void {
    // Take initial screenshot
    captureScreenshot();

    // Set up interval (default to 5 seconds if not specified)
    const intervalMs = Number(getQueryParam("screenshotInterval")) || 5000;
    screenshotInterval = window.setInterval(captureScreenshot, intervalMs);
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
    const liveAudio = document.getElementById("liveAudio") as HTMLAudioElement;
    targetTabId = Number(getQueryParam("tabId"));
    const captureScreenshots = getBoolQueryParam("captureScreenshots", true);
    const captureAudio = getBoolQueryParam("captureAudio", true);
    if (!targetTabId) {
      statusDiv.textContent = "No target tab specified.";
      return;
    }
    statusDiv.textContent = "Requesting tab audio capture...";
    liveAudio.autoplay = true;
    liveAudio.muted = false;
    liveAudio.style.display = "none";
    chrome.tabCapture.capture(
      {
        audio: captureAudio,
        video: false,
      },
      (stream) => {
        if (chrome.runtime.lastError || (!stream && captureAudio)) {
          statusDiv.textContent =
            "Tab capture failed: " + chrome.runtime.lastError?.message;
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
            window.removeEventListener("beforeunload", beforeUnloadHandler);
            const audioBlob = new Blob(audioChunks, { type: AUDIO_MIME_TYPE });
            const url = URL.createObjectURL(audioBlob);
            const a = document.createElement("a");
            a.style.display = "none";
            a.href = url;
            a.download = "tab-audio.webm";
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
              // Take a final screenshot before downloading
              if (captureScreenshots) {
                captureScreenshot().then(() => {
                  downloadScreenshots().then(() => {
                    statusDiv.textContent = "Recording stopped and downloaded.";
                    // Notify background to update badge/state
                    if (targetTabId) {
                      chrome.runtime.sendMessage({
                        type: "STOP_RECORDING",
                        tabId: targetTabId,
                      });
                    }
                    window.close();
                  });
                });
              } else {
                statusDiv.textContent = "Recording stopped and downloaded.";
                if (targetTabId) {
                  chrome.runtime.sendMessage({
                    type: "STOP_RECORDING",
                    tabId: targetTabId,
                  });
                }
                window.close();
              }
            }, 100);
          };
          mediaRecorder.start();
        } else {
          // No audio, just screenshots
          statusDiv.textContent = "Recording... (screenshots only)";
          // Take screenshots if enabled
          if (captureScreenshots) {
            startScreenshotCapture();
          }
        }

        // Start screenshot capture after audio recording starts (if enabled)
        if (captureScreenshots && captureAudio && stream) {
          startScreenshotCapture();
        }
      },
    );

    stopBtn.addEventListener("click", () => {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        stopScreenshotCapture();
        mediaRecorder.stop();
        if (capturedStream) {
          capturedStream.getTracks().forEach((track) => track.stop());
        }
        // Notify background to update badge/state
        if (targetTabId) {
          chrome.runtime.sendMessage({
            type: "STOP_RECORDING",
            tabId: targetTabId,
          });
        }
      } else {
        // No audio, just screenshots
        stopScreenshotCapture();
        // Take a final screenshot before downloading
        if (captureScreenshots) {
          captureScreenshot().then(() => {
            downloadScreenshots().then(() => {
              statusDiv.textContent = "Recording stopped and downloaded.";
              if (targetTabId) {
                chrome.runtime.sendMessage({
                  type: "STOP_RECORDING",
                  tabId: targetTabId,
                });
              }
              window.close();
            });
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
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "STOP_RECORDING") {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        stopScreenshotCapture();
        mediaRecorder.stop();
        if (capturedStream) {
          capturedStream.getTracks().forEach((track) => track.stop());
        }
        // Notify background to update badge/state
        if (targetTabId) {
          chrome.runtime.sendMessage({
            type: "STOP_RECORDING",
            tabId: targetTabId,
          });
        }
      }
    }
  });
})();
