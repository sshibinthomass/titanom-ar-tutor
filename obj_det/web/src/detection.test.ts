import { describe, expect, it, vi } from "vitest";

import {
  drawDetections,
  summarizeDetections,
} from "./detection";

describe("summarizeDetections", () => {
  it("groups labels, counts instances, and retains peak confidence", () => {
    const detections = [
      {
        class_id: 0,
        label: "person",
        confidence: 0.8,
        box: { x1: 0, y1: 0, x2: 1, y2: 1 },
      },
      {
        class_id: 0,
        label: "person",
        confidence: 0.95,
        box: { x1: 0, y1: 0, x2: 1, y2: 1 },
      },
      {
        class_id: 2,
        label: "car",
        confidence: 0.72,
        box: { x1: 0, y1: 0, x2: 1, y2: 1 },
      },
    ];

    expect(summarizeDetections(detections)).toEqual([
      { label: "person", count: 2, confidence: 0.95 },
      { label: "car", count: 1, confidence: 0.72 },
    ]);
  });
});

describe("drawDetections", () => {
  it("draws bounding boxes without labels or confidence text", () => {
    const canvas = document.createElement("canvas");
    const strokeRect = vi.fn();
    const fillRect = vi.fn();
    const fillText = vi.fn();

    Object.defineProperties(canvas, {
      clientWidth: { value: 200 },
      clientHeight: { value: 100 },
      getContext: {
        value: () => ({
          setTransform() {},
          clearRect() {},
          strokeRect,
          fillRect,
          fillText,
        }),
      },
    });

    drawDetections(canvas, [
      {
        class_id: 0,
        label: "person",
        confidence: 0.95,
        box: { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6 },
      },
    ]);

    expect(strokeRect).toHaveBeenCalledWith(20, 20, 80, 40);
    expect(fillRect).not.toHaveBeenCalled();
    expect(fillText).not.toHaveBeenCalled();
  });
});
