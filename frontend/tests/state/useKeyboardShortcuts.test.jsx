import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from '../../src/state/useKeyboardShortcuts.js';
import { TOOLS } from '../../src/state/useSimulationGrid.js';

function press(key, init = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
}

function setup(overrides = {}) {
  const handlers = {
    onSetTool: vi.fn(),
    onEraseSelected: vi.fn(),
    selectedCell: null,
    onDeselect: vi.fn(),
    isRunning: false,
    onStartSimulation: vi.fn(),
    onStopSimulation: vi.fn(),
    canRunSimulation: true,
    pickMode: null,
    onCancelPick: vi.fn(),
    onToggleHelp: vi.fn(),
    ...overrides,
  };
  const hook = renderHook((props) => useKeyboardShortcuts(props), { initialProps: handlers });
  return { handlers, hook };
}

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('maps the number keys to the drawing tools', () => {
    const { handlers } = setup();

    press('1');
    press('3');
    press('6');

    expect(handlers.onSetTool.mock.calls).toEqual([[TOOLS.SELECT], [TOOLS.SHELF], [TOOLS.DOCK]]);
  });

  it('erases the selected cell with Delete or Backspace', () => {
    const { handlers } = setup({ selectedCell: { x: 2, y: 5 } });

    press('Delete');
    press('Backspace');

    expect(handlers.onEraseSelected).toHaveBeenCalledTimes(2);
    expect(handlers.onEraseSelected).toHaveBeenCalledWith(2, 5);
  });

  it('does not erase when nothing is selected', () => {
    const { handlers } = setup({ selectedCell: null });

    press('Delete');

    expect(handlers.onEraseSelected).not.toHaveBeenCalled();
  });

  describe('P toggles the simulation', () => {
    it('starts it when stopped', () => {
      const { handlers } = setup({ isRunning: false });

      press('p');

      expect(handlers.onStartSimulation).toHaveBeenCalledTimes(1);
    });

    it('stops it when running, upper case too', () => {
      const { handlers } = setup({ isRunning: true });

      press('P');

      expect(handlers.onStopSimulation).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the simulation cannot be run', () => {
      const { handlers } = setup({ canRunSimulation: false });

      press('p');

      expect(handlers.onStartSimulation).not.toHaveBeenCalled();
    });
  });

  describe('Escape', () => {
    it('cancels pick mode first', () => {
      const { handlers } = setup({ pickMode: 'start', selectedCell: { x: 1, y: 1 } });

      press('Escape');

      expect(handlers.onCancelPick).toHaveBeenCalledTimes(1);
      expect(handlers.onDeselect).not.toHaveBeenCalled();
    });

    it('deselects the cell when not picking', () => {
      const { handlers } = setup({ pickMode: null, selectedCell: { x: 1, y: 1 } });

      press('Escape');

      expect(handlers.onDeselect).toHaveBeenCalledTimes(1);
    });
  });

  it('toggles the help overlay with ?', () => {
    const { handlers } = setup();

    press('?');

    expect(handlers.onToggleHelp).toHaveBeenCalledTimes(1);
  });

  describe('when a shortcut must not fire', () => {
    it('ignores keys typed into a text field', () => {
      const { handlers } = setup();
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));

      expect(handlers.onSetTool).not.toHaveBeenCalled();
    });

    it('ignores keys typed into a select', () => {
      const { handlers } = setup();
      const select = document.createElement('select');
      document.body.appendChild(select);

      select.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));

      expect(handlers.onSetTool).not.toHaveBeenCalled();
    });

    it('leaves browser and OS shortcuts alone', () => {
      const { handlers } = setup();

      press('1', { ctrlKey: true });
      press('1', { metaKey: true });
      press('p', { ctrlKey: true });

      expect(handlers.onSetTool).not.toHaveBeenCalled();
      expect(handlers.onStartSimulation).not.toHaveBeenCalled();
    });

    it('ignores key repeats, so holding a key does not fire it over and over', () => {
      const { handlers } = setup();

      press('1', { repeat: true });
      press('p', { repeat: true });

      expect(handlers.onSetTool).not.toHaveBeenCalled();
      expect(handlers.onStartSimulation).not.toHaveBeenCalled();
    });
  });

  it('stops listening once unmounted', () => {
    const { handlers, hook } = setup();
    hook.unmount();

    press('1');

    expect(handlers.onSetTool).not.toHaveBeenCalled();
  });
});
