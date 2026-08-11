import { THEME } from '../../theme.js';

export const CELL_TYPES = {
  EMPTY: 'empty',
  SHELF: 'shelf',
  CHARGING: 'charging',
  OBSTACLE: 'obstacle',
  DOCK: 'dock',
};

// `walkable` isn't used yet - it's here now because the A* engine
// (Milestone 4) and robot movement (Milestone 5) will need it, and it
// belongs with the rest of a cell type's definition rather than bolted on
// later.
//
// Charging stations and docks are walkable: a robot has to be able to
// physically occupy one to use it. Shelves and obstacles are the only real
// physical barriers.
export const CELL_TYPE_META = {
  [CELL_TYPES.SHELF]: { label: 'Shelf', color: THEME.amber, walkable: false },
  [CELL_TYPES.CHARGING]: { label: 'Charging Station', color: THEME.success, walkable: true },
  [CELL_TYPES.OBSTACLE]: { label: 'Obstacle', color: THEME.danger, walkable: false },
  [CELL_TYPES.DOCK]: { label: 'Dock', color: THEME.cyan, walkable: true },
};

// The object types a person can paint onto the grid (excludes EMPTY, which
// is represented by the absence of a cell rather than a paintable type).
export const PLACEABLE_TYPES = [
  CELL_TYPES.SHELF,
  CELL_TYPES.CHARGING,
  CELL_TYPES.OBSTACLE,
  CELL_TYPES.DOCK,
];

export function cellLabel(type) {
  if (type === CELL_TYPES.EMPTY) return 'Empty';
  return CELL_TYPE_META[type]?.label || 'Unknown';
}

export function cellColor(type) {
  return CELL_TYPE_META[type]?.color || null;
}
