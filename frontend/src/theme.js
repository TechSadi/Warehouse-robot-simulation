// Keep these in sync with the :root custom properties in src/index.css.
// Canvas drawing needs literal color strings, not CSS variables, so this is
// the single JS-side source of truth other modules should import from
// rather than hard-coding hex values inline.
export const THEME = {
  bgVoid: '#0b0e11',
  bgPanel: '#12161b',
  line: '#232a32',
  lineBright: '#333c47',
  amber: '#f5a623',
  cyan: '#3ddad7',
  danger: '#e5484d',
  success: '#4ade80',
  textPrimary: '#e8ecef',
  textSecondary: '#a8b1bc',
  textMuted: '#656f7b',
};
