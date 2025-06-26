(() => {
  // This script runs in recorder.html and manages tab audio capture and recording

  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let capturedStream: MediaStream | null = null;
  let targetTabId: number | null = null;
  let screenshotInterval: number | null = null;
  let audioBatchInterval: number | null = null;
  let audioBatchIntervalSec: number = 300; // default 5*60 seconds
  const AUDIO_MIME_TYPE = "audio/webm;codecs=opus";
  let tabTitleNormalized: string | null = null;

  function getQueryParam(name: string): string | null {
    const url = new URL(window.location.href);
    return url.searchParams.get(name);
  }
  const streamToServer = getQueryParam("streamToServer") === "1";
  const serverUrl = getQueryParam("serverUrl") || "http://localhost:8017";
  let sessionId: string | null = null;

  async function serverStartSession(title: string): Promise<string | null> {
    try {
      const resp = await fetch(`${serverUrl}/sessions/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.session_id || null;
      }
    } catch (e) {
      const statusDiv = document.getElementById("status");
      if (statusDiv)
        statusDiv.textContent = `Error: Could not connect to server (${e instanceof Error ? e.message : String(e)})`;
    }
    return null;
  }
  async function serverEndSession(sessionId: string) {
    try {
      await fetch(`${serverUrl}/sessions/${sessionId}/end`, {
        method: "POST",
      });
    } catch (e) {
      const statusDiv = document.getElementById("status");
      if (statusDiv)
        statusDiv.textContent = `Error: Could not end session on server (${e instanceof Error ? e.message : String(e)})`;
    }
  }
  async function serverSendScreenshot(sessionId: string, dataUrl: string) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const form = new FormData();
      form.append("file", blob, "screenshot.png");
      await fetch(`${serverUrl}/sessions/${sessionId}/screenshot`, {
        method: "POST",
        body: form,
        headers: { mime_type: blob.type },
      });
    } catch (e) {
      const statusDiv = document.getElementById("status");
      if (statusDiv)
        statusDiv.textContent = `Error: Could not send screenshot to server (${e instanceof Error ? e.message : String(e)})`;
    }
  }
  async function serverSendAudio(sessionId: string, audioBlob: Blob) {
    try {
      const form = new FormData();
      form.append("file", audioBlob, "audio.webm");
      await fetch(`${serverUrl}/sessions/${sessionId}/chunk`, {
        method: "POST",
        body: form,
        headers: { mime_type: audioBlob.type },
      });
    } catch (e) {
      const statusDiv = document.getElementById("status");
      if (statusDiv)
        statusDiv.textContent = `Error: Could not send audio to server (${e instanceof Error ? e.message : String(e)})`;
    }
  }

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
  function getTabFilename(ext: string): string {
    if (!tabTitleNormalized) throw new Error("Tab title not initialized");
    const timestamp = getTimestamp();
    return `${tabTitleNormalized}_${timestamp}.${ext}`;
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
      const screenshot = await new Promise<string>((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: "TAKE_SCREENSHOT", tabId: targetTabId },
          (response) => {
            if (chrome.runtime.lastError || !response || !response.dataUrl) {
              reject(
                chrome.runtime.lastError || new Error("No screenshot data"),
              );
            } else {
              resolve(response.dataUrl);
            }
          },
        );
      });
      if (streamToServer && sessionId) {
        await serverSendScreenshot(sessionId, screenshot);
      } else {
        const filename = getTabFilename("png");
        triggerDownload(screenshot, filename);
      }
    } catch (error) {
      const statusDiv = document.getElementById("status");
      if (statusDiv)
        statusDiv.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
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

  function startAudioBatching() {
    if (audioBatchInterval) clearInterval(audioBatchInterval);
    audioBatchInterval = window.setInterval(async () => {
      if (audioChunks.length > 0 && targetTabId) {
        const batch = audioChunks.splice(0, audioChunks.length);
        const audioBlob = new Blob(batch, { type: AUDIO_MIME_TYPE });
        if (streamToServer && sessionId) {
          await serverSendAudio(sessionId, audioBlob);
        } else {
          const url = URL.createObjectURL(audioBlob);
          const filename = getTabFilename("webm");
          triggerDownload(url, filename);
          setTimeout(() => URL.revokeObjectURL(url), 100);
        }
      }
    }, audioBatchIntervalSec * 1000);
  }

  function stopAudioBatching() {
    if (audioBatchInterval) {
      clearInterval(audioBatchInterval);
      audioBatchInterval = null;
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
    const statusDiv = document.getElementById("status") as HTMLDivElement;
    chrome.storage.local.get(
      ["activeRecording"],
      (result: {
        activeRecording?: {
          tabId?: number;
          config?: {
            captureScreenshots?: boolean;
            captureAudio?: boolean;
            screenshotIntervalSec?: number;
            audioBatchIntervalSec?: number;
          };
        };
      }) => {
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
        audioBatchIntervalSec = config.audioBatchIntervalSec || 300;
        statusDiv.textContent = "Requesting tab audio capture...";
        console.log("Requesting tab capture from background", {
          tabId: targetTabId,
          captureAudio,
        });
        chrome.tabs.get(Number(targetTabId), async (tab: chrome.tabs.Tab) => {
          tabTitleNormalized = normalizeTitle(tab?.title || "tab");
          let localStreamToServer = streamToServer;
          if (localStreamToServer) {
            sessionId = await serverStartSession(tab?.title || "tab");
            if (!sessionId) {
              statusDiv.textContent =
                "Server unavailable, falling back to local recording.";
              localStreamToServer = false;
            }
          }
          chrome.runtime.sendMessage(
            { type: "REQUEST_TAB_CAPTURE", tabId: targetTabId, captureAudio },
            (response: { success?: boolean; error?: string }) => {
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
                (stream: MediaStream | null) => {
                  if (chrome.runtime.lastError || (!stream && captureAudio)) {
                    statusDiv.textContent =
                      "Tab capture failed: " +
                      chrome.runtime.lastError?.message;
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
                    mediaRecorder.onstop = async () => {
                      window.removeEventListener(
                        "beforeunload",
                        beforeUnloadHandler,
                      );
                      stopAudioBatching();
                      if (audioChunks.length > 0 && targetTabId) {
                        const audioBlob = new Blob(audioChunks, {
                          type: AUDIO_MIME_TYPE,
                        });
                        if (localStreamToServer && sessionId) {
                          await serverSendAudio(sessionId, audioBlob);
                        } else {
                          const url = URL.createObjectURL(audioBlob);
                          const filename = getTabFilename("webm");
                          triggerDownload(url, filename);
                          audioChunks = [];
                        }
                      }
                      if (captureScreenshots) {
                        await captureScreenshotWithMode(
                          localStreamToServer,
                          sessionId,
                        );
                      }
                      if (localStreamToServer && sessionId) {
                        await serverEndSession(sessionId);
                        statusDiv.textContent =
                          "Recording stopped and sent to server.";
                      } else {
                        statusDiv.textContent =
                          "Recording stopped and downloaded.";
                      }
                      if (targetTabId) {
                        chrome.runtime.sendMessage({
                          type: "STOP_RECORDING",
                          tabId: targetTabId,
                        });
                      }
                      window.close();
                    };
                    mediaRecorder.start();
                    startAudioBatchingWithMode(localStreamToServer, sessionId);
                  } else {
                    statusDiv.textContent = "Recording... (screenshots only)";
                    if (captureScreenshots) {
                      startScreenshotCaptureWithMode(
                        screenshotIntervalSec * 1000,
                        localStreamToServer,
                        sessionId,
                      );
                    }
                  }

                  if (captureScreenshots && captureAudio && stream) {
                    startScreenshotCaptureWithMode(
                      screenshotIntervalSec * 1000,
                      localStreamToServer,
                      sessionId,
                    );
                  }
                },
              );
            },
          );
        });

        stopBtn.addEventListener("click", async () => {
          stopScreenshotCapture();
          if (mediaRecorder && mediaRecorder.state !== "inactive") {
            mediaRecorder.stop();
            if (capturedStream) {
              capturedStream.getTracks().forEach((track) => track.stop());
            }
          } else {
            if (captureScreenshots) {
              await captureScreenshotWithMode(false, null);
            }
            if (streamToServer && sessionId) {
              await serverEndSession(sessionId);
              statusDiv.textContent = "Recording stopped and sent to server.";
            } else {
              statusDiv.textContent = "Recording stopped and downloaded.";
            }
            if (targetTabId) {
              chrome.runtime.sendMessage({
                type: "STOP_RECORDING",
                tabId: targetTabId,
              });
            }
            window.close();
          }
        });

        // Listen for STOP_RECORDING messages from popup/background
        chrome.runtime.onMessage.addListener(
          (
            msg: { type: string },
            sender: chrome.runtime.MessageSender,
            sendResponse: (response?: unknown) => void,
          ) => {
            if (msg.type === "STOP_RECORDING") {
              stopBtn.click();
            }
          },
        );
      },
    );
  });

  // Add new helper functions for screenshot/audio batching with mode
  function startScreenshotCaptureWithMode(
    intervalMs: number,
    toServer: boolean,
    sessionId: string | null,
  ) {
    stopScreenshotCapture();
    const capture = async () => {
      if (toServer && sessionId) {
        await serverSendScreenshot(sessionId, await getScreenshotDataUrl());
      } else {
        const filename = getTabFilename("png");
        triggerDownload(await getScreenshotDataUrl(), filename);
      }
    };
    capture();
    screenshotInterval = window.setInterval(capture, intervalMs);
  }

  async function captureScreenshotWithMode(
    toServer: boolean,
    sessionId: string | null,
  ) {
    if (toServer && sessionId) {
      await serverSendScreenshot(sessionId, await getScreenshotDataUrl());
    } else {
      const filename = getTabFilename("png");
      triggerDownload(await getScreenshotDataUrl(), filename);
    }
  }

  function startAudioBatchingWithMode(
    toServer: boolean,
    sessionId: string | null,
  ) {
    if (audioBatchInterval) clearInterval(audioBatchInterval);
    audioBatchInterval = window.setInterval(async () => {
      if (audioChunks.length > 0 && targetTabId) {
        const batch = audioChunks.splice(0, audioChunks.length);
        const audioBlob = new Blob(batch, { type: AUDIO_MIME_TYPE });
        if (toServer && sessionId) {
          await serverSendAudio(sessionId, audioBlob);
        } else {
          const url = URL.createObjectURL(audioBlob);
          const filename = getTabFilename("webm");
          triggerDownload(url, filename);
          setTimeout(() => URL.revokeObjectURL(url), 100);
        }
      }
    }, audioBatchIntervalSec * 1000);
  }

  async function getScreenshotDataUrl(): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      if (!targetTabId) return reject("No target tab");
      chrome.runtime.sendMessage(
        { type: "TAKE_SCREENSHOT", tabId: targetTabId },
        (response) => {
          if (chrome.runtime.lastError || !response || !response.dataUrl) {
            reject(chrome.runtime.lastError || new Error("No screenshot data"));
          } else {
            resolve(response.dataUrl);
          }
        },
      );
    });
  }
})();
