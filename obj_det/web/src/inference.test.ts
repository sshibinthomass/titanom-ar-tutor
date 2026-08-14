import { describe, expect, it } from "vitest";

import {
  calculateLetterbox,
  parseYoloOutput,
  pixelsToChwFloat,
} from "./inference";

describe("calculateLetterbox", () => {
  it("centers a landscape frame vertically", () => {
    expect(calculateLetterbox(1280, 720, 416)).toEqual({
      scale: 0.325,
      resizedWidth: 416,
      resizedHeight: 234,
      padX: 0,
      padY: 91,
    });
  });

  it("centers a portrait frame horizontally", () => {
    expect(calculateLetterbox(720, 1280, 416)).toEqual({
      scale: 0.325,
      resizedWidth: 234,
      resizedHeight: 416,
      padX: 91,
      padY: 0,
    });
  });

  it("rejects invalid frame dimensions", () => {
    expect(() => calculateLetterbox(0, 720)).toThrow(
      "Frame dimensions must be positive.",
    );
  });
});

describe("pixelsToChwFloat", () => {
  it("converts RGBA pixels to normalized planar RGB", () => {
    const pixels = new Uint8ClampedArray([
      255, 128, 0, 255,
      0, 64, 255, 255,
    ]);

    expect([...pixelsToChwFloat(pixels, 2, 1)]).toEqual([
      1,
      0,
      expect.closeTo(128 / 255),
      expect.closeTo(64 / 255),
      0,
      1,
    ]);
  });
});

describe("parseYoloOutput", () => {
  it("filters low-confidence rows and reverses letterboxing", () => {
    const transform = calculateLetterbox(1280, 720, 416);
    const output = new Float32Array([
      32.5,
      123.5,
      130,
      208,
      0.9,
      0,
      0,
      0,
      10,
      10,
      0.1,
      2,
    ]);

    expect(parseYoloOutput(output, transform, 1280, 720)).toEqual([
      {
        class_id: 0,
        label: "person",
        confidence: expect.closeTo(0.9),
        box: {
          x1: expect.closeTo(0.078125),
          y1: expect.closeTo(0.1388889),
          x2: expect.closeTo(0.3125),
          y2: expect.closeTo(0.5),
        },
      },
    ]);
  });

  it("clamps boxes and discards invalid classes and geometry", () => {
    const transform = calculateLetterbox(416, 416, 416);
    const output = new Float32Array([
      -10, -20, 500, 450, 0.8, 2,
      10, 10, 20, 20, 0.9, 999,
      30, 30, 20, 20, 0.9, 0,
    ]);

    expect(parseYoloOutput(output, transform, 416, 416)).toEqual([
      {
        class_id: 2,
        label: "car",
        confidence: expect.closeTo(0.8),
        box: { x1: 0, y1: 0, x2: 1, y2: 1 },
      },
    ]);
  });
});
