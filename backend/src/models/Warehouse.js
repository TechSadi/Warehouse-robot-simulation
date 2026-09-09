const mongoose = require('mongoose');
const { STRATEGY_KEYS } = require('../engine/scheduling/strategies');
const { OBSTACLE_TYPES } = require('../engine/obstacles/dynamicObstacles');

const CELL_TYPES = ['shelf', 'charging', 'obstacle', 'dock'];

// Mirrors the frontend's serializeGrid() output (rows, cols, sparse cells)
// so a layout exported from the browser can be POSTed here unmodified.
/** A bare grid coordinate, with no cell type - what a dynamic obstacle
 * covers, as opposed to what the static layout *is*. */
const cellPointSchema = new mongoose.Schema(
  {
    x: { type: Number, required: true, min: 0 },
    y: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const cellSchema = new mongoose.Schema(
  {
    x: { type: Number, required: true, min: 0 },
    y: { type: Number, required: true, min: 0 },
    type: { type: String, enum: CELL_TYPES, required: true },
  },
  { _id: false }
);

/**
 * A runtime hazard laid over the static grid: a human worker, a temporary
 * blockage, a broken-down robot, a construction zone.
 *
 * These used to live only in the engine's memory, which made them the one
 * piece of simulation state with no home at all - lost on every restart,
 * every layout edit and every engine-cache eviction, and (as the security
 * notes pointed out) not covered by database-level access control either,
 * only by the ownership check on the routes that reached them. A robot
 * would reroute around a construction zone one minute and drive straight
 * through where it had been the next, because the zone had quietly ceased
 * to exist.
 *
 * They belong to the warehouse, not to the layout: `cells` is not part of
 * the saved floor plan and editing the plan does not touch them. Storing
 * them here rather than in their own collection means the engine load that
 * already reads the warehouse document restores them for free, with no
 * extra query and no second authorization path to get wrong.
 *
 * `remainingSeconds` is *simulation* time, not wall-clock: a timed hazard
 * counts down as ticks advance, so a warehouse that was not running while
 * the process was down comes back with the same time left on the clock it
 * had when it stopped. Anything else would expire hazards during an
 * outage, which is a period in which the simulation by definition did not
 * advance.
 */
const dynamicObstacleSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 80 },
    type: { type: String, enum: OBSTACLE_TYPES, required: true },
    cells: { type: [cellPointSchema], required: true },
    remainingSeconds: { type: Number, default: null, min: 0 },
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
    /**
     * Other people who may reach this warehouse, and how far.
     *
     * Ownership used to be the whole of the authorization model: one user
     * per warehouse, no concept of a team, a viewer or a shared
     * simulation. That is a reasonable default and a poor ceiling - a
     * simulation is a thing you show people, and "send them your password"
     * is the workaround it forced.
     *
     * Two roles, because there are exactly two questions worth asking:
     *
     *   viewer  - may read everything and watch the live simulation. May
     *             not change anything, including starting or stopping it:
     *             a viewer is an audience, and a simulation running is a
     *             change to what everyone else is watching.
     *   editor  - may do everything the owner can except the three things
     *             that are about the warehouse's *existence* rather than
     *             its contents: deleting it, changing its layout, and
     *             changing who else can reach it.
     *
     * There is no `owner` role in this list. The owner is `ownerId`, it is
     * immutable, and it is not something a collaborator can be granted -
     * so no amount of sharing can produce a warehouse with two people who
     * can each remove the other.
     */
    collaborators: {
      type: [
        new mongoose.Schema(
          {
            userId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'User',
              required: true,
            },
            role: { type: String, enum: ['viewer', 'editor'], required: true },
            addedAt: { type: Date, default: Date.now },
            // Recorded rather than derived: an owner can change, and "who
            // let this person in" is the question that matters afterwards.
            addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    isActive: { type: Boolean, default: false },
    // Which of the 5 Milestone 7 strategies orderService.dispatchPendingOrders()
    // uses for this warehouse. Switchable via the existing PUT /:id endpoint -
    // no dedicated route needed for that.
    schedulingStrategy: { type: String, enum: STRATEGY_KEYS, default: 'nearest_robot' },

    // Runtime hazards - see dynamicObstacleSchema above. Written only by
    // the simulation (services/simulationManager.js); the warehouse CRUD
    // DTO does not list this field, so a client can only change it through
    // the obstacle endpoints, which validate bounds and go via the engine.
    dynamicObstacles: { type: [dynamicObstacleSchema], default: [] },
  },
  { timestamps: true }
);

warehouseSchema.index({ ownerId: 1, isActive: 1 });
// Listing "warehouses I can reach" is an $or over ownership and
// membership, and the membership half would otherwise be a collection
// scan on every list request.
warehouseSchema.index({ 'collaborators.userId': 1 });

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
