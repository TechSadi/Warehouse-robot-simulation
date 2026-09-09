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
    // The root of this app's whole authorization model: every robot,
    // order, obstacle, statistic and log reaches its owner through the
    // warehouse it belongs to (see middleware/authorize.js). Set from the
    // authenticated session on create and never from the request body -
    // a client-settable ownerId would let anyone hand themselves someone
    // else's warehouse, or plant one in another user's account.
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A warehouse must have an owner'],
      immutable: true,
      index: true,
    },
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

warehouseSchema.index({ ownerId: 1, isActive: 1 });

/**
 * Marks this warehouse active and deactivates every *other warehouse of
 * the same owner*.
 *
 * Previously this deactivated every warehouse in the collection, which in
 * a single-user deployment was merely "one active layout at a time" but in
 * a multi-user one is a cross-tenant write: activating your warehouse
 * silently switched off everybody else's. `ownerId` is required rather
 * than optional so a caller cannot re-acquire the old behaviour by
 * omitting it.
 */
warehouseSchema.statics.activate = async function activate(id, ownerId) {
  if (!ownerId) throw new Error('Warehouse.activate requires an ownerId');
  const warehouse = await this.findOne({ _id: id, ownerId });
  if (!warehouse) return null;
  await this.updateMany({ ownerId, _id: { $ne: id } }, { $set: { isActive: false } });
  warehouse.isActive = true;
  await warehouse.save();
  return warehouse;
};

module.exports = mongoose.model('Warehouse', warehouseSchema);
module.exports.CELL_TYPES = CELL_TYPES;
