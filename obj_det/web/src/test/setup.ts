import "@testing-library/jest-dom/vitest";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => ({
    setTransform() {},
    clearRect() {},
    strokeRect() {},
    fillRect() {},
    fillText() {},
    measureText: () => ({ width: 80 }),
  }),
});
