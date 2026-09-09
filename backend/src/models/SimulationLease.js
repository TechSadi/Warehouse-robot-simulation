const mongoose = require('mongoose');

/**
 * Which backend instance currently owns a warehouse's simulation.
 *
 * The engine cache, the tick loops and the warehouse lock are all
 * in-memory and per-process, which is correct and cheap for one instance
 * and silently wrong for two: each would build its own engines, run its
 * own interval, and take its own lock for the same warehouse, so the two
 * would tick the same fleet independently and write over each other's
 * robot snapshots. Nothing in the data model noticed, because both were
 * doing exactly what a single instance does.
 *
 * A lease makes ownership explicit and, crucially, external - it lives in
 * the one place both instances can see. The unique index on `warehouseId`
 * is what does the actual work: two instances racing to claim the same
 * warehouse are two upserts on one unique key, and exactly one of them
 * wins. The loser does not tick.
 *
 * Leases expire rather than being released reliably, because the failure
 * this has to survive is an instance dying without getting to clean up.
 * The holder renews on every tick; once renewals stop, the lease lapses
 * after `expiresAt` and another instance may claim it. That means a
 * warehouse can be unattended for up to one TTL after a crash, which is
 * the right trade: the alternative to a bounded gap is two writers.
 */
const simulationLeaseSchema = new mongoose.Schema(
  {
    warehouseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Warehouse',
      required: true,
      unique: true,
    },
    /** Identifies the process, not the machine - two instances on one host
     * must still be distinguishable. See services/instanceLease.js. */
    instanceId: { type: String, required: true, maxlength: 200 },
    expiresAt: { type: Date, required: true },
    renewedAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// A TTL index in addition to the `expiresAt` comparisons the service makes
// itself. The comparisons are what enforce correctness - Mongo's TTL
// monitor runs about once a minute, which is far too coarse to gate a
// simulation on - so this exists purely to stop abandoned rows
// accumulating for warehouses nobody ever runs again.
simulationLeaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('SimulationLease', simulationLeaseSchema);
