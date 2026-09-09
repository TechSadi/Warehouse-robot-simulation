const mongoose = require('mongoose');
// Single source of truth for the status values and the legal moves between
// them - shared with the simulation engine and the REST layer so neither
// can drift into accepting a state the other rejects.
const { STATUSES } = require('../domain/robotLifecycle');

/** A destination cell. The engine plans between whole cells, so a queued
 * task is always integral even though a robot's *position* is not while it
 * is part-way between two of them. */
const destinationSchema = new mongoose.Schema(
  {
    x: { type: Number, required: true, min: 0 },
    y: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

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

    /**
     * The destination this robot is currently driving to, and the ones
     * queued behind it.
     *
     * These used to be reserved-but-unwritten: the schema declared a
     * `taskQueue` of Order references that the running simulation never
     * touched, while the engine kept the real queue of `{x, y}`
     * destinations in memory only. Two things followed from that. The
     * schema described a data model the application did not have - the
     * field was documentation of an intention, not of a fact. And every
     * restart, layout edit or engine-cache eviction silently threw the
     * fleet's work away: robots came back idle with empty queues, and the
     * orders driving those destinations had to be released back to
     * `pending` and re-dispatched from scratch.
     *
     * They are now written from the engine snapshot on every persist, and
     * read back when an engine is built (services/simulationManager.js),
     * so a robot resumes the route it was driving. What is deliberately
     * *not* persisted is the computed A* path: the world may have changed
     * while the process was down, so the destination is replayed and the
     * path is planned fresh against the grid as it is now.
     *
     * They stay simulation-owned - the REST API cannot write them (see
     * domain/robotLifecycle.js and controllers/robot.controller.js).
     */
    currentTask: { type: destinationSchema, default: null },
    taskQueue: { type: [destinationSchema], default: [] },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true}
  }
);

robotSchema.index({ warehouseId: 1, status: 1 });

module.exports = mongoose.model('Robot', robotSchema);
module.exports.STATUSES = STATUSES;
