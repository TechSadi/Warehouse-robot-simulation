import { useCallback, useEffect, useRef, useState } from 'react';
import { findRoute } from '../api/client.js';

const MIN_SPEED_MS = 50;
const MAX_SPEED_MS = 1000;
const DEFAULT_SPEED_MS = 300;

/**
 * Milestone 12: drives the AI Visualisation Panel. Picking start/goal is a
 * self-contained interaction mode (`pickMode`) rather than a new entry in
 * useSimulationGrid's TOOLS enum, since it's conceptually different from
 * the grid-editing tools (it selects cells, it never paints them) -
 * AppShell checks `handlePickClick` before falling through to the normal
 * grid-edit click handler.
 *
 * `run()` calls the backend with `trace: true` (see
 * backend/src/engine/pathfinding/astar.js's `findPathWithTrace`) and gets
 * back the full step-by-step recording in one response; everything after
 * that - play/pause/step/speed - is pure client-side scrubbing through the
 * array that's already in memory, no further requests.
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
  const playIntervalRef = useRef(null);

  const pickStart = useCallback(() => setPickMode('start'), []);
  const pickGoal = useCallback(() => setPickMode('goal'), []);
  const cancelPick = useCallback(() => setPickMode(null), []);

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

  const stopPlayback = useCallback(() => {
    setIsPlaying(false);
    if (playIntervalRef.current) {
      clearInterval(playIntervalRef.current);
      playIntervalRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopPlayback();
    setSteps([]);
    setResult(null);
    setStepIndex(-1);
    setRunError(null);
  }, [stopPlayback]);

  const run = useCallback(async () => {
    if (!warehouseId || !start || !goal) return;
    stopPlayback();
    setIsRunning(true);
    setRunError(null);
    try {
      const data = await findRoute(warehouseId, { start, goal, heuristic, allowDiagonal, trace: true });
      setSteps(data.steps || []);
      setResult(data);
      setStepIndex(data.steps && data.steps.length > 0 ? 0 : -1);
    } catch (err) {
      setRunError(err.message);
      setSteps([]);
      setResult(null);
      setStepIndex(-1);
    } finally {
      setIsRunning(false);
    }
  }, [warehouseId, start, goal, heuristic, allowDiagonal, stopPlayback]);

  const stepForward = useCallback(() => {
    stopPlayback();
    setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  }, [steps.length, stopPlayback]);

  const stepBackward = useCallback(() => {
    stopPlayback();
    setStepIndex((i) => Math.max(i - 1, 0));
  }, [stopPlayback]);

  const play = useCallback(() => {
    if (steps.length === 0) return;
    setStepIndex((i) => (i >= steps.length - 1 ? 0 : i)); // restart from the top if already at the end
    setIsPlaying(true);
  }, [steps.length]);

  const pause = useCallback(() => stopPlayback(), [stopPlayback]);

  // Drives auto-playback: advances one step every `speedMs`, stopping
  // itself once it reaches the last recorded step.
  useEffect(() => {
    if (!isPlaying) return undefined;
    const interval = setInterval(() => {
      setStepIndex((i) => {
        if (i >= steps.length - 1) {
          stopPlayback();
          return i;
        }
        return i + 1;
      });
    }, speedMs);
    playIntervalRef.current = interval;
    return () => clearInterval(interval);
  }, [isPlaying, speedMs, steps.length, stopPlayback]);

  // Stop playback and clear any recorded trace if the synced warehouse
  // changes out from under the panel.
  useEffect(() => {
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseId]);

  const currentStep = stepIndex >= 0 && stepIndex < steps.length ? steps[stepIndex] : null;

  return {
    pickMode,
    pickStart,
    pickGoal,
    cancelPick,
    handlePickClick,
    start,
    goal,
    clearStart: () => setStart(null),
    clearGoal: () => setGoal(null),
    heuristic,
    setHeuristic,
    allowDiagonal,
    setAllowDiagonal,
    run,
    isRunning,
    runError,
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
