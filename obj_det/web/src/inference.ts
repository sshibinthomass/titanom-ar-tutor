import type { Detection } from "./types";

export const MODEL_INPUT_SIZE = 416;
export const CONFIDENCE_THRESHOLD = 0.25;
export const MODEL_URL = `${import.meta.env.BASE_URL}models/yolo26n-416-fp32.onnx`;

export const COCO_LABELS = [
  "person",
  "bicycle",
  "car",
  "motorcycle",
  "airplane",
  "bus",
  "train",
  "truck",
  "boat",
  "traffic light",
  "fire hydrant",
  "stop sign",
  "parking meter",
  "bench",
  "bird",
  "cat",
  "dog",
  "horse",
  "sheep",
  "cow",
  "elephant",
  "bear",
  "zebra",
  "giraffe",
  "backpack",
  "umbrella",
  "handbag",
  "tie",
  "suitcase",
  "frisbee",
  "skis",
  "snowboard",
  "sports ball",
  "kite",
  "baseball bat",
  "baseball glove",
  "skateboard",
  "surfboard",
  "tennis racket",
  "bottle",
  "wine glass",
  "cup",
  "fork",
  "knife",
  "spoon",
  "bowl",
  "banana",
  "apple",
  "sandwich",
  "orange",
  "broccoli",
  "carrot",
  "hot dog",
  "pizza",
  "donut",
  "cake",
  "chair",
  "couch",
  "potted plant",
  "bed",
  "dining table",
  "toilet",
  "tv",
  "laptop",
  "mouse",
  "remote",
  "keyboard",
  "cell phone",
  "microwave",
  "oven",
  "toaster",
  "sink",
  "refrigerator",
  "book",
  "clock",
  "vase",
  "scissors",
  "teddy bear",
  "hair drier",
  "toothbrush",
] as const;

export interface LetterboxTransform {
  scale: number;
  resizedWidth: number;
  resizedHeight: number;
  padX: number;
  padY: number;
}

export function calculateLetterbox(
  sourceWidth: number,
  sourceHeight: number,
  inputSize = MODEL_INPUT_SIZE,
): LetterboxTransform {
  if (sourceWidth <= 0 || sourceHeight <= 0 || inputSize <= 0) {
    throw new Error("Frame dimensions must be positive.");
  }

  const scale = Math.min(inputSize / sourceWidth, inputSize / sourceHeight);
  const resizedWidth = Math.round(sourceWidth * scale);
  const resizedHeight = Math.round(sourceHeight * scale);

  return {
    scale,
    resizedWidth,
    resizedHeight,
    padX: Math.floor((inputSize - resizedWidth) / 2),
    padY: Math.floor((inputSize - resizedHeight) / 2),
  };
}

export function pixelsToChwFloat(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  const pixelCount = width * height;
  if (pixels.length !== pixelCount * 4) {
    throw new Error("Expected RGBA pixels for the full model input.");
  }

  const tensor = new Float32Array(pixelCount * 3);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const rgbaOffset = pixel * 4;
    tensor[pixel] = pixels[rgbaOffset] / 255;
    tensor[pixelCount + pixel] = pixels[rgbaOffset + 1] / 255;
    tensor[pixelCount * 2 + pixel] = pixels[rgbaOffset + 2] / 255;
  }
  return tensor;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

export function parseYoloOutput(
  output: Float32Array,
  transform: LetterboxTransform,
  sourceWidth: number,
  sourceHeight: number,
  confidenceThreshold = CONFIDENCE_THRESHOLD,
): Detection[] {
  if (output.length % 6 !== 0) {
    throw new Error("Unexpected YOLO output shape.");
  }

  const detections: Detection[] = [];
  for (let index = 0; index < output.length; index += 6) {
    const confidence = output[index + 4];
    const classId = Math.round(output[index + 5]);
    const label = COCO_LABELS[classId];
    if (confidence < confidenceThreshold || label === undefined) continue;

    const x1 = clamp(
      (output[index] - transform.padX) / transform.scale / sourceWidth,
    );
    const y1 = clamp(
      (output[index + 1] - transform.padY) / transform.scale / sourceHeight,
    );
    const x2 = clamp(
      (output[index + 2] - transform.padX) / transform.scale / sourceWidth,
    );
    const y2 = clamp(
      (output[index + 3] - transform.padY) / transform.scale / sourceHeight,
    );
    if (x2 <= x1 || y2 <= y1) continue;

    detections.push({
      class_id: classId,
      label,
      confidence,
      box: { x1, y1, x2, y2 },
    });
  }

  return detections.sort((left, right) => right.confidence - left.confidence);
}
