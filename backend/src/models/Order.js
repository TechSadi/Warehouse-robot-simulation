const mongoose = require('mongoose');

const STATUSES = ['pending', 'assigned', 'picked_up', 'delivered', 'cancelled'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

const pointSchema = new mongoose.Schema(
  {
    x: { type: Number, required: true, min: 0 },
    y: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    warehouseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Warehouse',
      required: [true, 'An order must belong to a warehouse'],
    },
    pickupLocation: { type: pointSchema, required: true },
    deliveryLocation: { type: pointSchema, required: true },
    status: { type: String, enum: STATUSES, default: 'pending' },
    priority: { type: String, enum: PRIORITIES, default: 'normal' },
    assignedRobot: { type: mongoose.Schema.Types.ObjectId, ref: 'Robot', default: null },
    assignedAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: true }
);

orderSchema.index({ warehouseId: 1, status: 1 });

module.exports = mongoose.model('Order', orderSchema);
module.exports.STATUSES = STATUSES;
module.exports.PRIORITIES = PRIORITIES;
