import { useCallback, useEffect, useRef, useState } from 'react';
import { findRoute } from '../api/client.js';
import { describeError } from '../api/errors.js';

const MIN_SPEED_MS = 50;
const MAX_SPEED_MS = 1000;
const DEFAULT_SPEED_MS = 300;

/**
 * Drives the AI Visualisation Panel.
 *
 * Picking start/goal is a self-contained interaction mode (`pickMode`)
 * rather than a new entry in useSimulationGrid's TOOLS enum, since it is
 * conceptually different from the grid-editing tools (it selects cells, it
 * never paints them) - AppShell checks `handlePickClick` before falling
 * through to the normal grid-edit click handler.
 *
 * `run()` calls the backend with `trace: true` (see
 * backend/src/engine/pathfinding/astar.js's `findPathWithTrace`) and gets
 * back the full step-by-step recording in one response; everything after
 * that - play/pause/step/speed - is pure client-side scrubbing through the
 * array that is already in memory, no further requests.
 */
export function usePathVisualization(warehouseId) {
  const [pickMode, setPickMode] = useState(null); // null | 'start' | 'goal'
  const [start, setStart] = useState(null);
  const [goal, setGoal] = useState(null);
  const [heuristic, setHeuristic] = useState('manhattan');
  const [allowDiagonal, setAllowDiagonal] = useState(false);

  const [steps, setSteps] = useState([]);
  const [result, setResult] = useState(null);
  const [stepIndex, setStepIndex] = useState(-1);
  const [isRunning, setIsRunning] = useState(false); // fetching the trace
  const [runError, setRunError] = useState(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState(DEFAULT_SPEED_MS);

  /** Guards against a slow trace for one warehouse landing after the user
   * has switched to another, or after they pressed Clear. */
  const runSeq = useRef(0);

  const pickStart = useCallback(() => setPickMode('start'), []);
  const pickGoal = useCallback(() => setPickMode('goal'), []);
  const cancelPick = useCallback(() => setPickMode(null), []);
  const clearStart = useCallback(() => setStart(null), []);
  const clearGoal = useCallback(() => setGoal(null), []);
  const dismissRunError = useCallback(() => setRunError(null), []);

  /** AppShell calls this first on every canvas click; a true return means
   * the click was consumed by picking start/goal and should not also be
   * treated as a grid-edit click. */
  const handlePickClick = useCallback(
    (x, y) => {
      if (pickMode === 'start') {
        setStart({ x, y });
        setPickMode(null);
        return true;
      }
      if (pickMode === 'goal') {
        setGoal({ x, y });
        setPickMode(null);
        return true;
      }
      return false;
    },
    [pickMode]
  );

  const pause = useCallback(() => setIsPlaying(false), []);

  const reset = useCallback(() => {
    runSeq.current += 1;
    setIsPlaying(false);
    setSteps([]);
    setResult(null);
    setStepIndex(-1);
    setRunError(null);
  }, []);

  const run = useCallback(async () => {
    if (!warehouseId || !start || !goal) return;
    runSeq.current += 1;
    const seq = runSeq.current;
    setIsPlaying(false);
    setIsRunning(true);
    setRunError(null);
    try {
      const data = await findRoute(warehouseId, { start, goal, heuristic, allowDiagonal, trace: true });
      if (seq !== runSeq.current) return;
      setSteps(data.steps || []);
      setResult(data);
      setStepIndex(data.steps && data.steps.length > 0 ? 0 : -1);
    } catch (err) {
      if (seq !== runSeq.current) return;
      setRunError(describeError(err));
      setSteps([]);
      setResult(null);
      setStepIndex(-1);
    } finally {
      if (seq === runSeq.current) setIsRunning(false);
    }
  }, [warehouseId, start, goal, heuristic, allowDiagonal]);

  const stepForward = useCallback(() => {
    setIsPlaying(false);
    setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  }, [steps.length]);

  const stepBackward = useCallback(() => {
    setIsPlaying(false);
    setStepIndex((i) => Math.max(i - 1, 0));
  }, []);

  const play = useCallback(() => {
    if (steps.length === 0) return;
    // Restart from the top if already parked at the end, so Play always
    // plays something rather than silently doing nothing.
    setStepIndex((i) => (i >= steps.length - 1 ? 0 : i));
    setIsPlaying(true);
  }, [steps.length]);

  /**
   * Auto-playback: advances one step every `speedMs`, stopping at the last
   * recorded step.
   *
   * The stop used to happen *inside* the `setStepIndex` updater, which made
   * a state updater impure - React may call it more than once for a single
   * update (it does, under StrictMode), so the stop fired twice and any
   * future logic there would have run twice too. The updater now only
   * computes the next index; the effect below reacts to reaching the end.
   */
  useEffect(() => {
    if (!isPlaying || steps.length === 0) return undefined;
    const interval = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, steps.length - 1));
    }, speedMs);
    return () => clearInterval(interval);
  }, [isPlaying, speedMs, steps.length]);

  useEffect(() => {
    if (isPlaying && steps.length > 0 && stepIndex >= steps.length - 1) setIsPlaying(false);
  }, [isPlaying, stepIndex, steps.length]);

  // Stop playback and clear any recorded trace if the synced warehouse
  // changes out from under the panel - the trace describes a grid that is
  // no longer on screen.
  useEffect(() => {
    reset();
  }, [warehouseId, reset]);

  const currentStep = stepIndex >= 0 && stepIndex < steps.length ? steps[stepIndex] : null;

  return {
    pickMode,
    pickStart,
    pickGoal,
    cancelPick,
    handlePickClick,
    start,
    goal,
    clearStart,
    clearGoal,
    heuristic,
    setHeuristic,
    allowDiagonal,
    setAllowDiagonal,
    run,
    isRunning,
    runError,
    dismissRunError,
    reset,
    steps,
    result,
    currentStep,
    stepIndex,
    totalSteps: steps.length,
    stepForward,
    stepBackward,
    play,
    pause,
    isPlaying,
    speedMs,
    setSpeedMs,
    minSpeedMs: MIN_SPEED_MS,
    maxSpeedMs: MAX_SPEED_MS,
  };
}
