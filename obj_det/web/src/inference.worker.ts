/// <reference lib="webworker" />

import * as ort from "onnxruntime-web/webgpu";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";

import {
  calculateLetterbox,
  parseYoloOutput,
  pixelsToChwFloat,
} from "./inference";
import type {
  DetectWorkerRequest,
  InferenceProvider,
  InferenceWorkerMessage,
  InferenceWorkerRequest,
} from "./types";

const worker = self as DedicatedWorkerGlobalScope;

let modelBytes: Uint8Array | null = null;
let session: ort.InferenceSession | null = null;
let provider: InferenceProvider | null = null;
let inputSize = 416;
let confidenceThreshold = 0.25;
let canvas: OffscreenCanvas | null = null;

function send(message: InferenceWorkerMessage): void {
  worker.postMessage(message);
}

async function fetchModel(modelUrl: string): Promise<Uint8Array> {
  const response = await fetch(modelUrl);
  if (!response.ok) {
    throw new Error(`Could not load the local model (${response.status}).`);
  }

  const totalHeader = response.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : null;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    send({ type: "loading", loaded: bytes.byteLength, total });
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    send({ type: "loading", loaded, total });
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function createSession(
  executionProvider: InferenceProvider,
): Promise<ort.InferenceSession> {
  if (!modelBytes) throw new Error("The local model has not loaded.");
  return ort.InferenceSession.create(modelBytes, {
    executionProviders: [executionProvider],
    graphOptimizationLevel: "all",
  });
}

async function selectProvider(): Promise<void> {
  let canUseWebGpu = false;
  const gpu = (
    worker.navigator as WorkerNavigator & {
      gpu?: { requestAdapter: () => Promise<unknown | null> };
    }
  ).gpu;
  if (gpu) {
    try {
      canUseWebGpu = (await gpu.requestAdapter()) !== null;
    } catch (error) {
      console.warn("A WebGPU adapter could not be requested.", error);
    }
  }
  if (canUseWebGpu) {
    try {
      session = await createSession("webgpu");
      provider = "webgpu";
    } catch (error) {
      console.warn("WebGPU initialization failed; using WASM instead.", error);
    }
  }

  if (!session) {
    session = await createSession("wasm");
    provider = "wasm";
  }

  if (!provider) throw new Error("No local inference provider is available.");
  send({ type: "ready", provider });
}

async function fallBackToWasm(): Promise<void> {
  if (provider !== "webgpu") throw new Error("Local inference failed.");
  await session?.release();
  session = null;
  provider = null;
  session = await createSession("wasm");
  provider = "wasm";
  send({ type: "ready", provider });
}

function preprocessFrame(request: DetectWorkerRequest): {
  tensor: ort.Tensor;
  transform: ReturnType<typeof calculateLetterbox>;
} {
  canvas ??= new OffscreenCanvas(inputSize, inputSize);
  if (canvas.width !== inputSize || canvas.height !== inputSize) {
    canvas.width = inputSize;
    canvas.height = inputSize;
  }

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Browser canvas processing is unavailable.");

  const transform = calculateLetterbox(
    request.source_width,
    request.source_height,
    inputSize,
  );
  context.fillStyle = "rgb(114, 114, 114)";
  context.fillRect(0, 0, inputSize, inputSize);
  context.drawImage(
    request.bitmap,
    transform.padX,
    transform.padY,
    transform.resizedWidth,
    transform.resizedHeight,
  );
  const pixels = context.getImageData(0, 0, inputSize, inputSize).data;
  return {
    tensor: new ort.Tensor(
      "float32",
      pixelsToChwFloat(pixels, inputSize, inputSize),
      [1, 3, inputSize, inputSize],
    ),
    transform,
  };
}

async function detect(request: DetectWorkerRequest): Promise<void> {
  if (!session || !provider) {
    request.bitmap.close();
    throw new Error("The local model is not ready.");
  }

  const preprocessingStarted = performance.now();
  const { tensor, transform } = preprocessFrame(request);
  request.bitmap.close();
  const preprocessingMs = performance.now() - preprocessingStarted;

  const inferenceStarted = performance.now();
  let outputs: ort.InferenceSession.OnnxValueMapType;
  try {
    outputs = await session.run({ images: tensor });
  } catch (error) {
    if (provider !== "webgpu") throw error;
    console.warn("WebGPU inference failed; retrying with WASM.", error);
    await fallBackToWasm();
    outputs = await session.run({ images: tensor });
  }
  const inferenceMs = performance.now() - inferenceStarted;
  const output = outputs.output0;
  if (!output || !(output.data instanceof Float32Array)) {
    throw new Error("The model returned an unexpected output tensor.");
  }

  send({
    type: "result",
    frame_id: request.frame_id,
    provider,
    preprocessing_ms: preprocessingMs,
    inference_ms: inferenceMs,
    detections: parseYoloOutput(
      output.data,
      transform,
      request.source_width,
      request.source_height,
      confidenceThreshold,
    ),
  });
}

ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
ort.env.wasm.numThreads = worker.crossOriginIsolated
  ? Math.min(4, Math.max(1, Math.ceil((worker.navigator.hardwareConcurrency || 1) / 2)))
  : 1;

worker.addEventListener("message", (event: MessageEvent<InferenceWorkerRequest>) => {
  const request = event.data;
  if (request.type === "init") {
    inputSize = request.inputSize;
    confidenceThreshold = request.confidenceThreshold;
    void (async () => {
      try {
        modelBytes = await fetchModel(request.modelUrl);
        await selectProvider();
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "Could not initialize local inference.",
          fatal: true,
        });
      }
    })();
    return;
  }

  void detect(request).catch((error) => {
    send({
      type: "error",
      message: error instanceof Error ? error.message : "Local inference failed.",
      fatal: true,
    });
  });
});

export {};
