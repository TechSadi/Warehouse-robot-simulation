/**
 * A stand-in for `CanvasRenderingContext2D` that remembers what it was
 * asked to do.
 *
 * jsdom does not implement a 2D context, and the project's stub in
 * `tests/setup.js` answers every drawing call with a no-op - which is
 * exactly right for component tests that only care that mounting a canvas
 * does not throw, and useless for checking what was drawn.
 *
 * This records instead. Each call becomes `{ method, args, state }`, where
 * `state` is a snapshot of the drawing state *at the moment of the call* -
 * fill style, stroke style, line width, alpha. That last part is what
 * makes the recording worth anything: canvas is a stateful API, so
 * `fillRect` on its own says nothing about what colour the rectangle was.
 *
 * It does not rasterise, and it makes no attempt to. The claim it supports
 * is "the right drawing commands were issued with the right arguments in
 * the right order", not "the resulting image looks correct" - which is a
 * screenshot-diffing problem and stays out of reach here.
 */
export function createRecordingContext() {
  const calls = [];
  const state = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  };

  /** The stateful properties, captured per call - see the note above. */
  const snapshot = () => ({
    fillStyle: state.fillStyle,
    strokeStyle: state.strokeStyle,
    lineWidth: state.lineWidth,
    globalAlpha: state.globalAlpha,
  });

  const METHODS = [
    'setTransform',
    'save',
    'restore',
    'translate',
    'scale',
    'rotate',
    'beginPath',
    'closePath',
    'moveTo',
    'lineTo',
    'arc',
    'rect',
    'clip',
    'fill',
    'stroke',
    'fillRect',
    'strokeRect',
    'clearRect',
    'fillText',
    'strokeText',
    'measureText',
  ];

  const ctx = {};
  for (const method of METHODS) {
    ctx[method] = (...args) => {
      calls.push({ method, args, state: snapshot() });
      if (method === 'measureText') return { width: 0 };
      return undefined;
    };
  }

  // The stateful properties are real accessors rather than plain fields,
  // so reading one back mid-draw behaves the way the real API does -
  // `drawRobot` reads `ctx.lineWidth` after setting it, to size the battery
  // ring against it.
  for (const key of Object.keys(state)) {
    Object.defineProperty(ctx, key, {
      get: () => state[key],
      set: (value) => {
        state[key] = value;
      },
      enumerable: true,
      configurable: true,
    });
  }

  ctx.__calls = calls;

  /** Every call to `method`, in order. */
  ctx.__callsTo = (method) => calls.filter((c) => c.method === method);

  /** The index of the first call to `method`, or -1. Layer order is
   * checked by comparing these. */
  ctx.__firstIndexOf = (method, predicate = () => true) =>
    calls.findIndex((c) => c.method === method && predicate(c));

  /** Every distinct fill/stroke colour actually used. */
  ctx.__colorsUsed = () =>
    new Set(
      calls
        .filter((c) => c.method.startsWith('fill') || c.method.startsWith('stroke'))
        .flatMap((c) => [c.state.fillStyle, c.state.strokeStyle])
    );

  ctx.__reset = () => {
    calls.length = 0;
  };

  return ctx;
}
