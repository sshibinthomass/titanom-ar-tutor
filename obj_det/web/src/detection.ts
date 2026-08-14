import type { Detection } from "./types";

export const FRAME_INTERVAL_MS = 200;

export interface DetectionSummary {
  label: string;
  count: number;
  confidence: number;
}

export function summarizeDetections(
  detections: Detection[],
): DetectionSummary[] {
  const summaries = new Map<string, DetectionSummary>();

  for (const detection of detections) {
    const current = summaries.get(detection.label);
    if (current) {
      current.count += 1;
      current.confidence = Math.max(current.confidence, detection.confidence);
    } else {
      summaries.set(detection.label, {
        label: detection.label,
        count: 1,
        confidence: detection.confidence,
      });
    }
  }

  return [...summaries.values()].sort(
    (left, right) => right.confidence - left.confidence,
  );
}

export function drawDetections(
  canvas: HTMLCanvasElement,
  detections: Detection[],
): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const pixelRatio = window.devicePixelRatio || 1;
  const backingWidth = Math.round(width * pixelRatio);
  const backingHeight = Math.round(height * pixelRatio);

  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }

  const context = canvas.getContext("2d");
  if (!context) return;

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.lineWidth = 2;

  for (const detection of detections) {
    const x = detection.box.x1 * width;
    const y = detection.box.y1 * height;
    const boxWidth = (detection.box.x2 - detection.box.x1) * width;
    const boxHeight = (detection.box.y2 - detection.box.y1) * height;

    context.strokeStyle = "#b7f26c";
    context.strokeRect(x, y, boxWidth, boxHeight);
  }
}
