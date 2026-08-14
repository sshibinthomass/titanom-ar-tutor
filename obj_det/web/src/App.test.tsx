import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "./App";

afterEach(() => {
  cleanup();
  MockWorker.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function cameraDevice(id: string, label: string): MediaDeviceInfo {
  return {
    deviceId: id,
    groupId: "group",
    kind: "videoinput",
    label,
    toJSON: () => ({}),
  };
}

function mediaStream(deviceId: string) {
  const track = {
    stop: vi.fn(),
    getSettings: () => ({ deviceId }),
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

class MockWorker extends EventTarget {
  static instances: MockWorker[] = [];

  postMessage = vi.fn();
  terminate = vi.fn();

  constructor(_url: string | URL, _options?: WorkerOptions) {
    super();
    MockWorker.instances.push(this);
  }
}

describe("App", () => {
  it("renders camera controls and the empty detection state", () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    render(<App />);

    expect(
      screen.getByRole("heading", { name: "See what your camera sees." }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start camera/i })).toBeEnabled();
    expect(screen.getByText("Detections will appear here")).toBeInTheDocument();
  });

  it("shows camera permission failures without starting inference", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValue(new Error("Camera permission denied."));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getUserMedia,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /start camera/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Camera permission denied.",
    );
    expect(screen.getByRole("button", { name: /start camera/i })).toBeEnabled();
    expect(MockWorker.instances).toHaveLength(0);
  });

  it("starts, switches, and stops camera tracks cleanly", async () => {
    const first = mediaStream("camera-one");
    const second = mediaStream("camera-two");
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(first.stream)
      .mockResolvedValueOnce(second.stream);
    const devices = [
      cameraDevice("camera-one", "Front camera"),
      cameraDevice("camera-two", "Desk camera"),
    ];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue(devices),
        getUserMedia,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.stubGlobal("Worker", MockWorker);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /start camera/i }));
    expect(
      await screen.findByRole("button", { name: /stop camera/i }),
    ).toBeEnabled();
    expect(await screen.findByText("Loading model 0%")).toBeInTheDocument();
    expect(MockWorker.instances[0].postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "init",
        inputSize: 416,
        confidenceThreshold: 0.25,
      }),
    );

    fireEvent.change(screen.getByRole("combobox", { name: /camera/i }), {
      target: { value: "camera-two" },
    });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect(first.track.stop).toHaveBeenCalled();
    expect(MockWorker.instances[0].terminate).toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: false,
      video: { deviceId: { exact: "camera-two" } },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /stop camera/i }),
    );
    expect(second.track.stop).toHaveBeenCalled();
    expect(MockWorker.instances[1].terminate).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /start camera/i })).toBeEnabled();
  });
});
