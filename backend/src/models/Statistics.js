const mongoose = require('mongoose');

// A point-in-time snapshot of fleet metrics. Append-only by design: nothing
// in this app should ever edit history, only add to it, so there's
// deliberately no update endpoint for this collection (see statistics
// routes/controller).
const statisticsSchema = new mongoose.Schema(
  {
    warehouseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Warehouse',
      required: [true, 'A statistics snapshot must belong to a warehouse'],
    },
    recordedAt: { type: Date, default: Date.now },
    metrics: {
      activeRobots: { type: Number, default: 0, min: 0 },
      idleRobots: { type: Number, default: 0, min: 0 },
      pendingOrders: { type: Number, default: 0, min: 0 },
      completedOrders: { type: Number, default: 0, min: 0 },
      avgBattery: { type: Number, default: 0, min: 0, max: 100 },
      deliveriesPerHour: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

statisticsSchema.index({ warehouseId: 1, recordedAt: -1 });

module.exports = mongoose.model('Statistics', statisticsSchema);
