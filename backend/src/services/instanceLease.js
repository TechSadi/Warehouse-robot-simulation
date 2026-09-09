const os = require('os');
const crypto = require('crypto');
const mongoose = require('mongoose');
const SimulationLease = require('../models/SimulationLease');
const env = require('../config/env');

/**
 * Warehouse-to-instance affinity for the simulation tick loop.
 *
 * This is the answer to the "single process" limitation: the engines are
 * still per-process and still in-memory - sharing those would be a
 * different and much larger system - but *which* process is allowed to
 * advance a given warehouse is now decided in the database rather than
 * assumed. Two instances running against one database no longer produce
 * two simulations of the same warehouse; the second one declines to tick
 * and says so.
 *
 * Deliberately scoped to *ticking*, not to reading. Loading an engine to
 * answer a query is harmless from a second instance - it reads the same
 * documents and reaches the same state. What must not happen twice is
 * advancing time and writing the result back, and that is exactly what a
 * tick loop does.
 *
 * Degrades to the old behaviour rather than failing closed when there is
 * no database to coordinate through (local development without Mongo, the
 * test suite, or an explicitly single-instance deployment): with one
 * process there is nothing to coordinate, and refusing to simulate because
 * a lease could not be written would turn a non-problem into an outage.
 */

/** Identifies this process for the life of it. Hostname alone is not
 * enough - two instances on one host is the ordinary shape of a container
 * deployment - so it carries the pid and a random suffix as well. */
const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

/** Warehouses this process believes it currently holds, and when each
 * lease is next due for renewal. Renewing on every single tick would put a
 * database round trip on the 2Hz path for no benefit; renewing at a third
 * of the TTL leaves two whole renewal opportunities before a lease could
 * lapse. @type {Map<string, number>} */
const renewDueAt = new Map();

function leasingActive() {
  // readyState 1 is "connected". Anything else and there is no shared
  // store to coordinate through, so there is nothing to coordinate.
  return env.simulation.leasesEnabled && mongoose.connection.readyState === 1;
}

function ttlMs() {
  return env.simulation.leaseTtlSeconds * 1000;
}

/**
 * Claims or renews this warehouse's lease.
 *
 * Returns `{ held: true }` if this process may tick the warehouse, or
 * `{ held: false, heldBy }` if another instance owns it.
 *
 * The claim is a single conditional upsert, which is what makes it safe
 * under a race: the filter matches only a lease this process already holds
 * or one that has expired, so a live lease belonging to someone else
 * matches nothing, the upsert tries to insert, and the unique index on
 * `warehouseId` rejects it. A duplicate-key error here is therefore not a
 * failure - it is the answer.
 */
async function acquire(warehouseId) {
  if (!leasingActive()) return { held: true, leasing: false };

  const key = String(warehouseId);
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs());

  try {
    await SimulationLease.findOneAndUpdate(
      {
        warehouseId,
        $or: [{ instanceId: INSTANCE_ID }, { expiresAt: { $lte: new Date(now) } }],
      },
      { $set: { instanceId: INSTANCE_ID, expiresAt, renewedAt: new Date(now) } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    renewDueAt.set(key, now + ttlMs() / 3);
    return { held: true, leasing: true };
  } catch (err) {
    if (isDuplicateKey(err)) {
      renewDueAt.delete(key);
      const existing = await SimulationLease.findOne({ warehouseId }).select('instanceId expiresAt');
      return { held: false, leasing: true, heldBy: existing?.instanceId || 'another instance' };
    }
    // Any other database failure: the shared store is unreachable or
    // unhappy. Ticking on is the lesser harm - the alternative is that a
    // transient Mongo blip silently stops every running simulation.
    console.error(`[lease] could not acquire warehouse ${key}:`, err.message);
    return { held: true, leasing: false, degraded: true };
  }
}

/**
 * The per-tick check. Cheap by design: it only touches the database when a
 * renewal is actually due, so the common case is a map lookup.
 */
async function ensure(warehouseId) {
  if (!leasingActive()) return { held: true, leasing: false };
  const key = String(warehouseId);
  const due = renewDueAt.get(key);
  if (due !== undefined && Date.now() < due) return { held: true, leasing: true };
  return acquire(warehouseId);
}

/** Gives up a lease immediately, so another instance can pick the
 * warehouse up without waiting out the TTL. Best-effort: the TTL is what
 * guarantees release, this only makes the common case fast. */
async function release(warehouseId) {
  const key = String(warehouseId);
  renewDueAt.delete(key);
  if (!leasingActive()) return;
  try {
    await SimulationLease.deleteOne({ warehouseId, instanceId: INSTANCE_ID });
  } catch (err) {
    console.error(`[lease] could not release warehouse ${key}:`, err.message);
  }
}

/** Releases everything this process holds - called on shutdown. */
async function releaseAll() {
  const keys = [...renewDueAt.keys()];
  renewDueAt.clear();
  if (!leasingActive() || keys.length === 0) return;
  try {
    await SimulationLease.deleteMany({ instanceId: INSTANCE_ID });
  } catch (err) {
    console.error('[lease] could not release leases on shutdown:', err.message);
  }
}

function isDuplicateKey(err) {
  return err?.code === 11000 || err?.code === 11001 || err?.codeName === 'DuplicateKey';
}

/** Test-only: forgets what this process thinks it holds. */
function _reset() {
  renewDueAt.clear();
}

module.exports = { INSTANCE_ID, acquire, ensure, release, releaseAll, _reset };
