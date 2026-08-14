# Titanom Vision

A private, browser-only web app for running YOLO object detection on a live
camera. Camera pixels stay in the browser: they are not uploaded, recorded, or
saved.

## How it works

The app loads a static 416 × 416 YOLO26n ONNX model into a dedicated Web Worker.
ONNX Runtime Web uses WebGPU when the browser and device support it, then falls
back to WebAssembly with SIMD. The camera preview remains independent from
inference, and only one frame is processed at a time at a maximum of five
detections per second.

The first visit downloads a roughly 9.4 MB model and the ONNX Runtime WebAssembly
runtime. Normal browser caching avoids downloading them again while the cached
assets remain available.

## Prerequisites

- Node.js 20 or newer
- A current browser with camera access
- HTTPS in production (`localhost` is accepted during development)

## Development

Install dependencies and start Vite:

```bash
make install
make dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), choose a camera, and press
**Start camera**. No Python process or inference server is required.

## Build and deploy

```bash
make build
```

Deploy `web/dist/` to a static HTTPS host. The host must return these headers for
all application files so the WASM fallback can use multiple CPU threads:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`web/public/_headers` supplies those settings on hosts that support the Netlify
headers-file convention. Equivalent platform configuration is required on other
hosts. All assets are same-origin. Vite's hashed runtime assets are cached as
immutable; the model itself revalidates daily so a rebuilt artifact is not stuck
behind a year-long browser cache.

## Tests

```bash
make test
make build
```

## Rebuilding the browser model

The checked-in ONNX model is ready to use. Rebuilding it is an optional release
task and does not add Python to the deployed application:

```bash
make export-model
```

This creates an isolated `.model-venv`, loads `models/yolo26n.pt`, and replaces
`web/public/models/yolo26n-416-fp32.onnx` with a static batch-1, simplified,
end-to-end ONNX export. FP32 is intentional: the tested COCO8-calibrated INT8
candidate missed detections and did not meet box-parity requirements.

## Browser behavior

- WebGPU is preferred for local GPU acceleration.
- WASM/SIMD is selected automatically when WebGPU is unavailable or fails to
  initialize.
- Detection slows down rather than uploading frames on unsupported or weaker
  devices.
- Inference pauses in background tabs and resumes when the tab becomes visible.

## License

The application and included Ultralytics model must be distributed in accordance
with the applicable AGPL-3.0 obligations. See `web/public/models/NOTICE.txt` and
[Ultralytics licensing](https://www.ultralytics.com/license) before distribution.
