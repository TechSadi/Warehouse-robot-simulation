// Mirrors frontend/src/engine/grid/cellTypes.js's CELL_TYPE_META.walkable
// values. Duplicated rather than shared because the frontend and backend
// are separate npm packages with no shared workspace set up yet; if that
// changes, this is the file to delete in favor of an import.
//
// Charging stations and docks are walkable: a robot has to be able to
// physically occupy one to use it.
const WALKABLE = {
  shelf: false,
  charging: true,
  obstacle: false,
  dock: true,
};

function isTypeWalkable(type) {
  if (!type) return true; // empty cell
  return WALKABLE[type] !== false;
}

module.exports = { WALKABLE, isTypeWalkable };
