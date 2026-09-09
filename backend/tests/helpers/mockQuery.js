/**
 * Controllers call `Model.find(filter).sort(...).skip(...).limit(...)` and
 * then `await` the result - Mongoose's Query is chainable and thenable.
 * This fakes just enough of that shape for tests, without needing a real
 * database connection.
 */
function mockQuery(resolvedValue) {
  const query = {
    sort: jest.fn(() => query),
    skip: jest.fn(() => query),
    limit: jest.fn(() => query),
    // The ownership middleware narrows its warehouse lookup with
    // `.select('_id')` - see middleware/authorize.js.
    select: jest.fn(() => query),
    lean: jest.fn(() => query),
    then: (onFulfilled, onRejected) => Promise.resolve(resolvedValue).then(onFulfilled, onRejected),
    catch: (onRejected) => Promise.resolve(resolvedValue).catch(onRejected),
  };
  return query;
}

module.exports = { mockQuery };
