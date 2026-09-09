#!/usr/bin/env node
/**
 * Assigns an owner to warehouses created before the security phase.
 *
 * `Warehouse.ownerId` is now required and is the root of the whole
 * authorization model (middleware/authorize.js). Documents written before
 * this phase have no `ownerId`, so they match no ownership query: they are
 * invisible to every user and cannot be read, edited, or deleted through
 * the API. Nothing is lost - the documents are untouched in the collection
 * - but somebody has to say whose they are, and that is not a decision
 * this code can make on its own.
 *
 * Deliberately conservative:
 *   - dry run unless you pass --apply, so the default outcome is a report
 *   - only ever sets `ownerId` on documents that have none; it never
 *     reassigns an owned warehouse, and never touches robots, orders,
 *     statistics or logs (those inherit ownership through the warehouse)
 *   - never deletes or restructures anything
 *
 * Usage:
 *   node scripts/backfill-ownership.js --email you@example.com
 *   node scripts/backfill-ownership.js --email you@example.com --apply
 *
 * Take a database snapshot before running with --apply. On Atlas that is
 * one click; on a self-hosted deployment, `mongodump`.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const env = require('../src/config/env');
const User = require('../src/models/User');
const Warehouse = require('../src/models/Warehouse');

function parseArgs(argv) {
  const args = { apply: false, email: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--email') args.email = argv[i + 1];
  }
  return args;
}

async function main() {
  const { apply, email } = parseArgs(process.argv);

  if (!email) {
    console.error('Usage: node scripts/backfill-ownership.js --email <owner@example.com> [--apply]');
    console.error('\nThe named account must already exist - register it through the app first.');
    process.exit(1);
  }

  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 10000 });
  console.log(`[backfill] connected to ${mongoose.connection.name}`);

  const owner = await User.findOne({ email: email.toLowerCase() });
  if (!owner) {
    console.error(`[backfill] No account found for ${email}. Register it through the app first.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // `$exists: false` and an explicit null are both "unowned" - a document
  // written before the field existed, and one written with the field
  // cleared, respectively.
  const filter = { $or: [{ ownerId: { $exists: false } }, { ownerId: null }] };
  const orphans = await Warehouse.find(filter).select('_id name createdAt');

  console.log(`\n[backfill] ${orphans.length} warehouse(s) without an owner:`);
  for (const w of orphans) {
    console.log(`  - ${w._id}  ${w.name || '(unnamed)'}`);
  }

  if (orphans.length === 0) {
    console.log('\n[backfill] Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  if (!apply) {
    console.log(
      `\n[backfill] DRY RUN - nothing was written. Re-run with --apply to assign these to ${owner.email}.`
    );
    await mongoose.disconnect();
    return;
  }

  const result = await Warehouse.updateMany(filter, { $set: { ownerId: owner._id } });
  console.log(`\n[backfill] Assigned ${result.modifiedCount} warehouse(s) to ${owner.email}.`);
  console.log('[backfill] Their robots, orders, statistics and logs follow automatically -');
  console.log('[backfill] ownership is resolved through the warehouse, not stored on each child.');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[backfill] failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
