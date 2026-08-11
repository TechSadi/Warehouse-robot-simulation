import './ShortcutsHelp.css';

const SHORTCUTS = [
  { keys: ['1'], description: 'Select tool' },
  { keys: ['2'], description: 'Eraser tool' },
  { keys: ['3'], description: 'Shelf tool' },
  { keys: ['4'], description: 'Charging station tool' },
  { keys: ['5'], description: 'Obstacle tool' },
  { keys: ['6'], description: 'Dock tool' },
  { keys: ['Delete', 'Backspace'], description: 'Erase the selected cell' },
  { keys: ['P'], description: 'Start / stop the live simulation' },
  { keys: ['Esc'], description: 'Cancel picking a start/goal node, or deselect the cell' },
  { keys: ['?'], description: 'Toggle this help' },
];

export default function ShortcutsHelp({ onClose }) {
  return (
    <div className="shortcuts-help__backdrop" onClick={onClose}>
      <div className="shortcuts-help" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="shortcuts-help__header">
          <p className="eyebrow">Keyboard Shortcuts</p>
          <button type="button" className="shortcuts-help__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="shortcuts-help__list">
          {SHORTCUTS.map((s) => (
            <div className="shortcuts-help__row" key={s.description}>
              <div className="shortcuts-help__keys">
                {s.keys.map((k) => (
                  <kbd className="shortcuts-help__key" key={k}>
                    {k}
                  </kbd>
                ))}
              </div>
              <span className="shortcuts-help__desc">{s.description}</span>
            </div>
          ))}
        </div>
        <p className="shortcuts-help__note">Shortcuts are ignored while typing in a text field.</p>
      </div>
    </div>
  );
}
