const mongoose = require('mongoose');
const { STATUSES } = require('../domain/orderLifecycle');

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
    /**
     * The name the robot had when it took this order, copied rather than
     * referenced.
     *
     * `assignedRobot` is a live pointer, and a delivered order outlives the
     * robot that delivered it - so a completed order used to be left
     * naming a document that no longer existed. Populating it returned
     * null and the history simply lost who did the work; that was the
     * documented dangling-reference limitation.
     *
     * Denormalising the name is the right shape for this specific case
     * rather than a general rule: history is a statement about the past,
     * and the whole point of a statement about the past is that it does
     * not change when the present does. Deleting a robot now also clears
     * `assignedRobot` on its finished orders (services/orderService.js),
     * so there is no dangling pointer left - and this field is why nothing
     * is lost when it goes.
     */
    assignedRobotName: { type: String, trim: true, maxlength: 60, default: null },
    assignedAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: true }
);

orderSchema.index({ warehouseId: 1, status: 1 });
// Reliability phase: releasing a deleted robot's work asks "which orders
// is this robot carrying?" (services/orderService.js), and recovery asks
// the same question warehouse-wide. Without this index that is a scan of
// every order in the warehouse, on a path that runs during a delete
// request rather than in the background.
orderSchema.index({ warehouseId: 1, assignedRobot: 1, status: 1 });

module.exports = mongoose.model('Order', orderSchema);
module.exports.STATUSES = STATUSES;
module.exports.PRIORITIES = PRIORITIES;
