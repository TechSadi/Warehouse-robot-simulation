import { useEffect, useId, useRef } from 'react';
import './ShortcutsHelp.css';

const SHORTCUTS = [
  { keys: ['1'], description: 'Select tool' },
  { keys: ['2'], description: 'Eraser tool' },
  { keys: ['3'], description: 'Shelf tool' },
  { keys: ['4'], description: 'Charging station tool' },
  { keys: ['5'], description: 'Obstacle tool' },
  { keys: ['6'], description: 'Dock tool' },
  { keys: ['↑', '↓', '←', '→'], description: 'Move the selected cell (with the grid focused)' },
  { keys: ['Enter'], description: 'Apply the active tool to the selected cell' },
  { keys: ['Delete', 'Backspace'], description: 'Erase the selected cell' },
  { keys: ['Space'], description: 'Hold to pan the grid' },
  { keys: ['P'], description: 'Start / stop the live simulation' },
  { keys: ['Esc'], description: 'Cancel picking a start/goal node, or deselect the cell' },
  { keys: ['?'], description: 'Toggle this help' },
];

/**
 * A real modal dialog rather than a styled div.
 *
 * It previously had `role="dialog"` but none of what makes a dialog usable:
 * focus stayed behind it (so a keyboard user tabbed through the dashboard
 * underneath, invisibly), Escape did nothing, and closing it left focus
 * nowhere. `aria-modal` alone would have been a claim the component did not
 * honour - the focus handling below is what makes it true.
 */
export default function ShortcutsHelp({ onClose }) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    closeRef.current?.focus();

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      // Keep Tab inside the dialog. Without this, tabbing walks into the
      // dashboard behind the backdrop, where the user cannot see what has
      // focus.
      const focusable = dialogRef.current?.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Return focus where it came from, so closing the dialog does not
      // dump the user back at the top of the document.
      previouslyFocused.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="shortcuts-help__backdrop" onClick={onClose}>
      <div
        className="shortcuts-help"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="shortcuts-help__header">
          <h2 className="eyebrow" id={titleId}>
            Keyboard Shortcuts
          </h2>
          <button
            type="button"
            className="shortcuts-help__close"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            ref={closeRef}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <dl className="shortcuts-help__list">
          {SHORTCUTS.map((shortcut) => (
            <div className="shortcuts-help__row" key={shortcut.description}>
              <dt className="shortcuts-help__keys">
                {shortcut.keys.map((key) => (
                  <kbd className="shortcuts-help__key" key={key}>
                    {key}
                  </kbd>
                ))}
              </dt>
              <dd className="shortcuts-help__desc">{shortcut.description}</dd>
            </div>
          ))}
        </dl>
        <p className="shortcuts-help__note">Shortcuts are ignored while typing in a text field.</p>
      </div>
    </div>
  );
}
