import { useEffect } from 'react';
import { TOOLS } from './useSimulationGrid.js';

const TOOL_KEYS = {
  1: TOOLS.SELECT,
  2: TOOLS.ERASER,
  3: TOOLS.SHELF,
  4: TOOLS.CHARGING,
  5: TOOLS.OBSTACLE,
  6: TOOLS.DOCK,
};

function isTypingTarget(target) {
  const tag = target?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable;
}

/**
 * Milestone 13: global keyboard shortcuts for the grid-editing tools,
 * erasing the selected cell, starting/stopping the live simulation, and
 * canceling the AI Visualisation Panel's pick mode. Ignored entirely while
 * the focus is on a text input/textarea/select (e.g. the layout name
 * field, row/col resize inputs) so typing a name that happens to contain
 * "1" or a "p" doesn't accidentally switch tools or toggle the simulation.
 *
 * Milestone 14 correction: this originally bound start/stop to Space, which
 * turned out to collide with GridCanvas's pre-existing hold-Space-to-pan
 * behavior (Milestone 2/10) - holding Space to pan would also repeatedly
 * fire this handler on every OS key-repeat event, toggling the simulation
 * on and off while someone was just trying to look around the grid. Two
 * fixes: rebound to `P` (a key nothing else claims), and every shortcut
 * here now ignores repeat events on principle, not just this one - holding
 * "1" down, for instance, has no reason to call onSetTool over and over.
 */
export function useKeyboardShortcuts({
  onSetTool,
  onEraseSelected,
  selectedCell,
  onDeselect,
  isRunning,
  onStartSimulation,
  onStopSimulation,
  canRunSimulation,
  pickMode,
  onCancelPick,
  onToggleHelp,
}) {
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.repeat) return; // holding a key down shouldn't repeat its action
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser/OS shortcuts alone

      const tool = TOOL_KEYS[e.key];
      if (tool) {
        onSetTool(tool);
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedCell) {
        e.preventDefault();
        onEraseSelected(selectedCell.x, selectedCell.y);
        return;
      }

      if (e.key === 'p' || e.key === 'P') {
        if (!canRunSimulation) return;
        e.preventDefault();
        if (isRunning) onStopSimulation();
        else onStartSimulation();
        return;
      }

      if (e.key === 'Escape') {
        if (pickMode) onCancelPick();
        else if (selectedCell) onDeselect();
        return;
      }

      if (e.key === '?') {
        onToggleHelp();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    onSetTool,
    onEraseSelected,
    selectedCell,
    onDeselect,
    isRunning,
    onStartSimulation,
    onStopSimulation,
    canRunSimulation,
    pickMode,
    onCancelPick,
    onToggleHelp,
  ]);
}
