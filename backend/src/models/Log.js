const mongoose = require('mongoose');

const LEVELS = ['info', 'warn', 'error'];

const logSchema = new mongoose.Schema(
  {
    level: { type: String, enum: LEVELS, default: 'info' },
    source: { type: String, trim: true, maxlength: 60, default: 'system' },
    message: {
      type: String,
      required: [true, 'Log message is required'],
      trim: true,
      maxlength: 500,
    },
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

logSchema.index({ createdAt: -1 });
logSchema.index({ level: 1, source: 1 });
// Milestone 14: the Logs panel (Milestone 13) filters by warehouseId and
// sorts by recency - neither existing index covers that combination, so
// that query fell back to scanning every log for this collection instead
// of narrowing via an index first.
logSchema.index({ warehouseId: 1, createdAt: -1 });

module.exports = mongoose.model('Log', logSchema);
module.exports.LEVELS = LEVELS;
