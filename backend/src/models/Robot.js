const mongoose = require('mongoose');

const STATUSES = ['idle', 'moving', 'charging', 'error'];

// Movement/task-queue behavior lands in Milestone 5 (Robot Engine); this
// schema just needs to hold the fields that milestone will read and write,
// so the two milestones don't have to renegotiate the data model later.
const robotSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Robot name is required'],
      trim: true,
      minlength: 1,
      maxlength: 60,
    },
    warehouseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Warehouse',
      required: [true, 'A robot must belong to a warehouse'],
    },
    position: {
      x: { type: Number, default: 0, min: 0 },
      y: { type: Number, default: 0, min: 0 },
    },
    rotation: { type: Number, default: 0, min: 0, max: 360 },
    speed: { type: Number, default: 1, min: 0 },
    battery: { type: Number, default: 100, min: 0, max: 100 },
    status: { type: String, enum: STATUSES, default: 'idle' },
    errorReason: { type: String, default: null },
    // Reserved for Order Management (Milestone 6) to assign real orders.
    // The Robot Engine's own task queue (Milestone 5) works in terms of
    // plain {x, y} destinations kept in memory during simulation, and
    // isn't persisted here - see backend/src/engine/robots/robotEngine.js.
    taskQueue: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
  },
  { timestamps: true }
);

robotSchema.index({ warehouseId: 1, status: 1 });

module.exports = mongoose.model('Robot', robotSchema);
module.exports.STATUSES = STATUSES;
