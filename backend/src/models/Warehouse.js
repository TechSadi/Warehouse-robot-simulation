const mongoose = require('mongoose');
const { STRATEGY_KEYS } = require('../engine/scheduling/strategies');

const CELL_TYPES = ['shelf', 'charging', 'obstacle', 'dock'];

// Mirrors the frontend's serializeGrid() output (rows, cols, sparse cells)
// so a layout exported from the browser can be POSTed here unmodified.
const cellSchema = new mongoose.Schema(
  {
    x: { type: Number, required: true, min: 0 },
    y: { type: Number, required: true, min: 0 },
    type: { type: String, enum: CELL_TYPES, required: true },
  },
  { _id: false }
);

const warehouseSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Warehouse name is required'],
      trim: true,
      minlength: 1,
      maxlength: 80,
    },
    rows: { type: Number, required: true, min: 5, max: 80 },
    cols: { type: Number, required: true, min: 5, max: 80 },
    cells: {
      type: [cellSchema],
      default: [],
      validate: {
        validator(cells) {
          return cells.every((c) => c.x < this.cols && c.y < this.rows);
        },
        message: 'One or more cells fall outside the warehouse bounds.',
      },
    },
    isActive: { type: Boolean, default: false },
    // Which of the 5 Milestone 7 strategies orderService.dispatchPendingOrders()
    // uses for this warehouse. Switchable via the existing PUT /:id endpoint -
    // no dedicated route needed for that.
    schedulingStrategy: { type: String, enum: STRATEGY_KEYS, default: 'nearest_robot' },
  },
  { timestamps: true }
);

warehouseSchema.index({ isActive: 1 });

/** Marks this warehouse active and deactivates every other one. */
warehouseSchema.statics.activate = async function activate(id) {
  const warehouse = await this.findById(id);
  if (!warehouse) return null;
  await this.updateMany({ _id: { $ne: id } }, { $set: { isActive: false } });
  warehouse.isActive = true;
  await warehouse.save();
  return warehouse;
};

module.exports = mongoose.model('Warehouse', warehouseSchema);
module.exports.CELL_TYPES = CELL_TYPES;
