import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GridCanvas from '../../src/components/simulation/GridCanvas.jsx';
import SimulationCanvas from '../../src/components/simulation/SimulationCanvas.jsx';
import ShortcutsHelp from '../../src/components/layout/ShortcutsHelp.jsx';
import { createGrid } from '../../src/engine/grid/gridEngine.js';

const grid = createGrid(10, 12);

const canvasProps = {
  grid,
  selectedCell: null,
  hoveredCell: null,
  isPaintTool: false,
  robots: [],
  heatmap: new Map(),
  heatmapEpoch: 0,
  showHeatmap: false,
  obstacles: [],
  pathVisualization: null,
  onHoverChange: vi.fn(),
  onCellClick: vi.fn(),
  onCellPaint: vi.fn(),
  onCellErase: vi.fn(),
  onZoomChange: vi.fn(),
  onMoveSelection: vi.fn(),
};

describe('grid keyboard access', () => {
  it('is reachable by keyboard at all', async () => {
    const user = userEvent.setup();
    render(<GridCanvas {...canvasProps} />);

    await user.tab();

    expect(document.activeElement.tagName).toBe('CANVAS');
    expect(document.activeElement).toHaveAccessibleName(/arrow keys move the selected cell/i);
  });

  it('moves the selection with the arrow keys', async () => {
    const user = userEvent.setup();
    const onMoveSelection = vi.fn();
    render(<GridCanvas {...canvasProps} onMoveSelection={onMoveSelection} />);
    await user.tab();

    await user.keyboard('{ArrowRight}{ArrowDown}{ArrowLeft}{ArrowUp}');

    expect(onMoveSelection.mock.calls).toEqual([
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ]);
  });

  it('applies the active tool to the selected cell with Enter', async () => {
    const user = userEvent.setup();
    const onCellClick = vi.fn();
    render(<GridCanvas {...canvasProps} selectedCell={{ x: 3, y: 4 }} onCellClick={onCellClick} />);
    await user.tab();

    await user.keyboard('{Enter}');

    expect(onCellClick).toHaveBeenCalledWith(3, 4);
  });

  it('clears the selected cell with Delete', async () => {
    const user = userEvent.setup();
    const onCellErase = vi.fn();
    render(<GridCanvas {...canvasProps} selectedCell={{ x: 3, y: 4 }} onCellErase={onCellErase} />);
    await user.tab();

    await user.keyboard('{Delete}');

    expect(onCellErase).toHaveBeenCalledWith(3, 4);
  });

  it('does nothing on Enter with no cell selected, rather than guessing one', async () => {
    const user = userEvent.setup();
    const onCellClick = vi.fn();
    render(<GridCanvas {...canvasProps} selectedCell={null} onCellClick={onCellClick} />);
    await user.tab();

    await user.keyboard('{Enter}');

    expect(onCellClick).not.toHaveBeenCalled();
  });
});

describe('SimulationCanvas status', () => {
  const props = {
    canvasRef: { current: null },
    ...canvasProps,
    selectedCellType: null,
    setHoveredCell: vi.fn(),
    pickMode: null,
    isRunning: false,
    isStale: false,
  };

  it('describes the grid in text, since a canvas is invisible to a screen reader', () => {
    render(<SimulationCanvas {...props} robots={[{ id: 'r1' }]} obstacles={[{ id: 'o1' }]} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      /12 by 10 cells, 1 robot, 1 dynamic obstacle\. Simulation stopped/
    );
  });

  it('badges data that is no longer live', () => {
    render(<SimulationCanvas {...props} isStale />);

    expect(screen.getByText(/last known positions/i)).toBeInTheDocument();
  });

  it('prompts through the readout while picking a path node', () => {
    render(<SimulationCanvas {...props} pickMode="goal" />);

    expect(screen.getByText(/click a cell to set the goal node/i)).toBeInTheDocument();
  });
});

describe('ShortcutsHelp dialog', () => {
  it('is a modal dialog with a name, and takes focus when it opens', () => {
    render(<ShortcutsHelp onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: /keyboard shortcuts/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /close keyboard shortcuts/i }));
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ShortcutsHelp onClose={onClose} />);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on the backdrop but not on the dialog itself', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<ShortcutsHelp onClose={onClose} />);

    await user.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(container.querySelector('.shortcuts-help__backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the dialog rather than letting focus escape behind it', async () => {
    const user = userEvent.setup();
    render(<ShortcutsHelp onClose={vi.fn()} />);
    const close = screen.getByRole('button', { name: /close keyboard shortcuts/i });

    // The close button is the only focusable control, so a cycle returns to it.
    await user.tab();
    expect(document.activeElement).toBe(close);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(close);
  });

  it('returns focus to whatever opened it', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(<ShortcutsHelp onClose={vi.fn()} />);
    unmount();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('documents the keyboard grid navigation it added', () => {
    render(<ShortcutsHelp onClose={vi.fn()} />);

    expect(screen.getByText(/move the selected cell/i)).toBeInTheDocument();
    expect(screen.getByText(/apply the active tool/i)).toBeInTheDocument();
  });
});
