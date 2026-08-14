import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  drawDetections,
  FRAME_INTERVAL_MS,
  summarizeDetections,
} from "./detection";
import {
  CONFIDENCE_THRESHOLD,
  MODEL_INPUT_SIZE,
  MODEL_URL,
} from "./inference";
import type {
  Detection,
  InferenceWorkerMessage,
  InferenceWorkerRequest,
} from "./types";

type CameraState = "idle" | "starting" | "active" | "error";
type InferenceState =
  | "idle"
  | "loading"
  | "webgpu"
  | "wasm"
  | "error";

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const sessionRef = useRef(0);
  const frameIdRef = useRef(0);
  const lastResultFrameRef = useRef(0);
  const frameStartedAtRef = useRef(0);
  const frameInFlightRef = useRef(false);
  const inferenceReadyRef = useRef(false);
  const captureTimerRef = useRef<number | null>(null);
  const videoFrameCallbackRef = useRef<number | null>(null);

  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [inferenceState, setInferenceState] =
    useState<InferenceState>("idle");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [detections, setDetections] = useState<Detection[]>([]);
  const [inferenceMs, setInferenceMs] = useState<number | null>(null);
  const [modelProgress, setModelProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState("16 / 9");

  const detectionSummary = useMemo(
    () => summarizeDetections(detections),
    [detections],
  );

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const availableDevices = await navigator.mediaDevices.enumerateDevices();
    setDevices(availableDevices.filter((device) => device.kind === "videoinput"));
  }, []);

  const cancelScheduledCapture = useCallback(() => {
    if (captureTimerRef.current !== null) {
      window.clearTimeout(captureTimerRef.current);
      captureTimerRef.current = null;
    }
    const video = videoRef.current;
    if (
      videoFrameCallbackRef.current !== null &&
      video?.cancelVideoFrameCallback
    ) {
      video.cancelVideoFrameCallback(videoFrameCallbackRef.current);
      videoFrameCallbackRef.current = null;
    }
  }, []);

  const scheduleNextFrame = useCallback(
    function schedule(session: number, delay = 0): void {
      cancelScheduledCapture();
      captureTimerRef.current = window.setTimeout(() => {
        captureTimerRef.current = null;
        if (
          sessionRef.current !== session ||
          !inferenceReadyRef.current ||
          frameInFlightRef.current
        ) {
          return;
        }
        if (document.hidden) {
          schedule(session, 500);
          return;
        }

        const video = videoRef.current;
        const worker = workerRef.current;
        if (!video || !worker) return;

        const capture = async () => {
          videoFrameCallbackRef.current = null;
          if (sessionRef.current !== session) return;
          if (
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
            !video.videoWidth ||
            !video.videoHeight
          ) {
            schedule(session, 100);
            return;
          }

          frameInFlightRef.current = true;
          frameStartedAtRef.current = performance.now();
          const frameId = ++frameIdRef.current;
          try {
            const bitmap = await createImageBitmap(video);
            if (sessionRef.current !== session) {
              bitmap.close();
              return;
            }
            const message: InferenceWorkerRequest = {
              type: "detect",
              frame_id: frameId,
              bitmap,
              source_width: video.videoWidth,
              source_height: video.videoHeight,
            };
            worker.postMessage(message, [bitmap]);
          } catch (caughtError) {
            frameInFlightRef.current = false;
            setError(
              caughtError instanceof Error
                ? caughtError.message
                : "Could not capture a camera frame.",
            );
            schedule(session, FRAME_INTERVAL_MS);
          }
        };

        if (video.requestVideoFrameCallback) {
          videoFrameCallbackRef.current = video.requestVideoFrameCallback(() => {
            void capture();
          });
        } else {
          void capture();
        }
      }, delay);
    },
    [cancelScheduledCapture],
  );

  const stopResources = useCallback(() => {
    sessionRef.current += 1;
    cancelScheduledCapture();
    workerRef.current?.terminate();
    workerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    frameInFlightRef.current = false;
    inferenceReadyRef.current = false;
    setCameraState("idle");
    setInferenceState("idle");
    setDetections([]);
    setInferenceMs(null);
    setModelProgress(null);
  }, [cancelScheduledCapture]);

  const startInference = useCallback(
    (session: number) => {
      if (typeof Worker === "undefined") {
        setInferenceState("error");
        setError("Local inference workers are not supported by this browser.");
        return;
      }

      setInferenceState("loading");
      setModelProgress(0);
      inferenceReadyRef.current = false;

      const worker = new Worker(new URL("./inference.worker.ts", import.meta.url), {
        type: "module",
      });
      workerRef.current = worker;

      worker.addEventListener(
        "message",
        (event: MessageEvent<InferenceWorkerMessage>) => {
          if (sessionRef.current !== session) return;
          const message = event.data;

          if (message.type === "loading") {
            setModelProgress(
              message.total && message.total > 0
                ? Math.min(100, Math.round((message.loaded / message.total) * 100))
                : null,
            );
            return;
          }

          if (message.type === "ready") {
            inferenceReadyRef.current = true;
            setInferenceState(message.provider);
            setModelProgress(100);
            setError(null);
            if (!frameInFlightRef.current) scheduleNextFrame(session);
            return;
          }

          if (message.type === "result") {
            frameInFlightRef.current = false;
            if (message.frame_id >= lastResultFrameRef.current) {
              lastResultFrameRef.current = message.frame_id;
              setDetections(message.detections);
              setInferenceMs(message.inference_ms);
              setInferenceState(message.provider);
              setError(null);
            }
            const elapsed = performance.now() - frameStartedAtRef.current;
            scheduleNextFrame(
              session,
              Math.max(0, FRAME_INTERVAL_MS - elapsed),
            );
            return;
          }

          frameInFlightRef.current = false;
          setError(message.message);
          if (message.fatal) {
            inferenceReadyRef.current = false;
            setInferenceState("error");
          } else {
            scheduleNextFrame(session, FRAME_INTERVAL_MS);
          }
        },
      );

      worker.addEventListener("error", () => {
        if (sessionRef.current !== session) return;
        frameInFlightRef.current = false;
        inferenceReadyRef.current = false;
        setInferenceState("error");
        setError("The local inference worker stopped unexpectedly.");
      });

      const initMessage: InferenceWorkerRequest = {
        type: "init",
        modelUrl: MODEL_URL,
        inputSize: MODEL_INPUT_SIZE,
        confidenceThreshold: CONFIDENCE_THRESHOLD,
      };
      worker.postMessage(initMessage);
    },
    [scheduleNextFrame],
  );

  const startCamera = useCallback(
    async (deviceId = selectedDeviceId) => {
      stopResources();
      const session = sessionRef.current;
      setCameraState("starting");
      setError(null);

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera access is not supported by this browser.");
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: deviceId
            ? { deviceId: { exact: deviceId } }
            : {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: "environment",
              },
        });

        if (sessionRef.current !== session) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) throw new Error("Camera preview is unavailable.");
        video.srcObject = stream;
        await video.play();
        if (video.videoWidth && video.videoHeight) {
          setAspectRatio(`${video.videoWidth} / ${video.videoHeight}`);
        }

        const activeDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId;
        if (activeDeviceId) setSelectedDeviceId(activeDeviceId);
        await refreshDevices();
        setCameraState("active");
        startInference(session);
      } catch (caughtError) {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setCameraState("error");
        setInferenceState("idle");
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Could not start the camera.",
        );
      }
    },
    [refreshDevices, selectedDeviceId, startInference, stopResources],
  );

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener("devicechange", refreshDevices);
      stopResources();
    };
  }, [refreshDevices, stopResources]);

  useEffect(() => {
    const resume = () => {
      if (
        !document.hidden &&
        cameraState === "active" &&
        inferenceReadyRef.current &&
        !frameInFlightRef.current
      ) {
        scheduleNextFrame(sessionRef.current);
      }
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, [cameraState, scheduleNextFrame]);

  useEffect(() => {
    const overlay = overlayRef.current;
    const stage = stageRef.current;
    if (!overlay || !stage) return;

    const render = () => drawDetections(overlay, detections);
    render();
    const observer = new ResizeObserver(render);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [detections, aspectRatio]);

  const changeCamera = (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    if (cameraState === "active") void startCamera(deviceId);
  };

  const inferenceLabel: Record<InferenceState, string> = {
    idle: "Local model idle",
    loading:
      modelProgress === null ? "Loading local model" : `Loading model ${modelProgress}%`,
    webgpu: "Local GPU",
    wasm: "Local CPU",
    error: "Inference unavailable",
  };
  const statusClass =
    inferenceState === "webgpu" || inferenceState === "wasm"
      ? "live"
      : inferenceState === "loading"
        ? "loading"
        : inferenceState;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Titanom Vision home">
          <span className="brand-mark" aria-hidden="true" />
          TITANOM <span>VISION</span>
        </a>
        <div className={`status-chip status-${statusClass}`}>
          <span className="status-dot" aria-hidden="true" />
          {inferenceLabel[inferenceState]}
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">ON-DEVICE OBJECT DETECTION</p>
          <h1>See what your camera sees.</h1>
        </div>
        <p className="hero-copy">
          Frames are analyzed inside this browser. Camera pixels are never
          uploaded, recorded, or saved.
        </p>
      </section>

      <section className="workspace">
        <div className="camera-panel">
          <div
            className="camera-stage"
            ref={stageRef}
            style={{ aspectRatio }}
          >
            <video ref={videoRef} muted playsInline aria-label="Live camera feed" />
            <canvas ref={overlayRef} aria-hidden="true" />
            {cameraState !== "active" && (
              <div className="camera-placeholder">
                <div className="viewfinder" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <p>
                  {cameraState === "starting"
                    ? "Starting camera…"
                    : "Camera preview is off"}
                </p>
                <small>Choose a camera and start when you’re ready.</small>
              </div>
            )}
          </div>

          <div className="camera-controls">
            <label>
              <span>Camera</span>
              <select
                value={selectedDeviceId}
                onChange={(event) => changeCamera(event.target.value)}
                disabled={cameraState === "starting"}
              >
                {devices.length === 0 && <option value="">Default camera</option>}
                {devices.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>

            {cameraState === "active" ? (
              <button className="button button-stop" onClick={stopResources}>
                <span className="stop-icon" aria-hidden="true" /> Stop camera
              </button>
            ) : (
              <button
                className="button button-start"
                onClick={() => void startCamera()}
                disabled={cameraState === "starting"}
              >
                <span className="play-icon" aria-hidden="true" />
                {cameraState === "starting" ? "Starting…" : "Start camera"}
              </button>
            )}
          </div>

          {inferenceState === "wasm" && !error && (
            <div className="performance-note" role="status">
              WebGPU is unavailable. Detection is running locally at reduced speed.
            </div>
          )}
          {error && <div className="error-banner" role="alert">{error}</div>}
        </div>

        <aside className="detections-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">CURRENT FRAME</p>
              <h2>Detected objects</h2>
            </div>
            {inferenceMs !== null && <span>{Math.round(inferenceMs)} ms</span>}
          </div>

          {detectionSummary.length > 0 ? (
            <ul className="detection-list">
              {detectionSummary.map((item) => (
                <li key={item.label}>
                  <div className="object-count">{item.count}</div>
                  <div className="object-name">
                    <strong>{item.label}</strong>
                    <span>highest confidence</span>
                  </div>
                  <div className="confidence">
                    {Math.round(item.confidence * 100)}%
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-state">
              <div className="scan-line" aria-hidden="true" />
              <p>
                {inferenceState === "loading"
                  ? "Loading the local model…"
                  : cameraState === "active"
                    ? "Looking for objects…"
                    : "Detections will appear here"}
              </p>
              <small>Local detections update at up to five frames per second.</small>
            </div>
          )}

          <div className="privacy-note">
            <span aria-hidden="true">●</span>
            <div>
              <strong>On-device and private</strong>
              <p>Camera pixels never leave this browser.</p>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}
