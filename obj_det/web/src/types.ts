export interface Detection {
  class_id: number;
  label: string;
  confidence: number;
  box: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
}

export type InferenceProvider = "webgpu" | "wasm";

export interface InitWorkerRequest {
  type: "init";
  modelUrl: string;
  inputSize: number;
  confidenceThreshold: number;
}

export interface DetectWorkerRequest {
  type: "detect";
  frame_id: number;
  bitmap: ImageBitmap;
  source_width: number;
  source_height: number;
}

export type InferenceWorkerRequest = InitWorkerRequest | DetectWorkerRequest;

export interface LoadingWorkerMessage {
  type: "loading";
  loaded: number;
  total: number | null;
}

export interface ReadyWorkerMessage {
  type: "ready";
  provider: InferenceProvider;
}

export interface DetectionWorkerMessage {
  type: "result";
  frame_id: number;
  provider: InferenceProvider;
  preprocessing_ms: number;
  inference_ms: number;
  detections: Detection[];
}

export interface InferenceErrorMessage {
  type: "error";
  message: string;
  fatal: boolean;
}

export type InferenceWorkerMessage =
  | LoadingWorkerMessage
  | ReadyWorkerMessage
  | DetectionWorkerMessage
  | InferenceErrorMessage;
