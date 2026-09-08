/**
 * Mass assignment.
 *
 * Every case here sends a legitimate request with one extra field bolted
 * on - the field a client is not supposed to control. The assertion is
 * never just "the response was an error": it is that the value never
 * reached the database call, because a 200 that silently ignored the field
 * and a 200 that wrote it look identical from the outside.
 */
const request = require('supertest');
const { mockQuery } = require('../helpers/mockQuery');
const { authed, mockOwnership, makeWarehouse, USER_A_ID, USER_B_ID } = require('../helpers/auth');

const WAREHOUSE_A = '507f1f77bcf86cd799439011';
const ROBOT_A = '507f1f77bcf86cd799439021';
const ORDER_A = '507f1f77bcf86cd799439022';

jest.mock('../../src/models/Warehouse', () =>
  Object.assign(
    {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findOneAndDelete: jest.fn(),
      countDocuments: jest.fn(),
      activate: jest.fn(),
    },
    { CELL_TYPES: ['shelf', 'charging', 'obstacle', 'dock'] }
  )
);
jest.mock('../../src/models/Robot', () =>
  Object.assign(
    {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      countDocuments: jest.fn(),
    },
    { STATUSES: ['idle', 'moving', 'charging', 'error'] }
  )
);
jest.mock('../../src/models/Order', () => {
  const { STATUSES } = jest.requireActual('../../src/domain/orderLifecycle');
  return Object.assign(
    {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      countDocuments: jest.fn(),
    },
    { STATUSES, PRIORITIES: ['low', 'normal', 'high', 'urgent'] }
  );
});
jest.mock('../../src/models/Statistics', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  findByIdAndDelete: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../../src/models/Log', () =>
  Object.assign(
    {
      find: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      findByIdAndDelete: jest.fn(),
      countDocuments: jest.fn(),
    },
    { LEVELS: ['info', 'warn', 'error'] }
  )
);
jest.mock('../../src/services/simulationManager', () => ({
  getEngine: jest.fn().mockResolvedValue(null),
  getOrderCoordinator: jest.fn().mockResolvedValue(null),
  persistRobot: jest.fn().mockResolvedValue(),
  invalidate: jest.fn(),
  addRobotToCachedEngine: jest.fn(),
}));

const Warehouse = require('../../src/models/Warehouse');
const Robot = require('../../src/models/Robot');
const Order = require('../../src/models/Order');
const Statistics = require('../../src/models/Statistics');
const Log = require('../../src/models/Log');
const app = require('../../src/app');

beforeEach(() => {
  jest.clearAllMocks();
  mockOwnership(Warehouse, { warehouse: makeWarehouse(WAREHOUSE_A, USER_A_ID, { rows: 20, cols: 20 }) });
  Warehouse.find.mockReturnValue(mockQuery([{ _id: WAREHOUSE_A }]));
  Robot.findById.mockResolvedValue({ _id: ROBOT_A, name: 'R1', warehouseId: WAREHOUSE_A });
  Order.findById.mockResolvedValue({
    _id: ORDER_A,
    warehouseId: WAREHOUSE_A,
    status: 'pending',
    pickupLocation: { x: 1, y: 1 },
    deliveryLocation: { x: 2, y: 2 },
  });
});

describe('warehouse ownership cannot be assigned by the client', () => {
  it('takes ownerId from the session, not the body', async () => {
    Warehouse.create.mockResolvedValue({ _id: WAREHOUSE_A });

    await authed(
      request(app)
        .post('/api/warehouses')
        .send({ name: 'W', rows: 10, cols: 10, ownerId: USER_B_ID, _id: 'chosen-id', isActive: true })
    );

    const created = Warehouse.create.mock.calls[0][0];
    expect(created.ownerId).toBe(USER_A_ID);
    expect(created._id).toBeUndefined();
    // Activation has its own endpoint because it has side effects on the
    // caller's other warehouses; it is not a writable field.
    expect(created.isActive).toBeUndefined();
  });

  it('ignores an ownerId in an update (no transferring a warehouse to yourself)', async () => {
    Warehouse.findOneAndUpdate.mockResolvedValue({ _id: WAREHOUSE_A, name: 'W' });

    await authed(
      request(app).put(`/api/warehouses/${WAREHOUSE_A}`).send({ name: 'W', ownerId: USER_B_ID })
    );

    const [filter, update] = Warehouse.findOneAndUpdate.mock.calls[0];
    expect(update.$set.ownerId).toBeUndefined();
    // The filter itself is owner-scoped, so even a bypass of the DTO could
    // not write across accounts.
    expect(filter.ownerId).toBe(USER_A_ID);
  });
});

describe('robot simulation state cannot be assigned by the client', () => {
  it('rejects a status write through the generic update route', async () => {
    const res = await authed(request(app).put(`/api/robots/${ROBOT_A}`).send({ name: 'R1', status: 'idle' }));

    expect(res.status).toBe(422);
    expect(res.body.error.details.fields).toContain('status');
    expect(Robot.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects refilling a battery through the generic update route', async () => {
    const res = await authed(request(app).put(`/api/robots/${ROBOT_A}`).send({ battery: 100 }));
    expect(res.status).toBe(422);
    expect(Robot.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects teleporting a robot by writing its position', async () => {
    const res = await authed(
      request(app).put(`/api/robots/${ROBOT_A}`).send({ position: { x: 99, y: 99 } })
    );
    expect(res.status).toBe(422);
    expect(Robot.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects clearing an errorReason without going through the engine', async () => {
    const res = await authed(request(app).put(`/api/robots/${ROBOT_A}`).send({ errorReason: null }));
    expect(res.status).toBe(422);
  });

  it('rejects re-parenting a robot into a different warehouse', async () => {
    Robot.findByIdAndUpdate.mockResolvedValue({ _id: ROBOT_A, warehouseId: WAREHOUSE_A });

    await authed(
      request(app).put(`/api/robots/${ROBOT_A}`).send({ name: 'R1', warehouseId: '507f1f77bcf86cd799439099' })
    );

    const [, update] = Robot.findByIdAndUpdate.mock.calls[0];
    expect(update.$set.warehouseId).toBeUndefined();
  });

  it('rejects a status on create, but allows initial placement', async () => {
    const rejected = await authed(
      request(app).post('/api/robots').send({ name: 'R', warehouseId: WAREHOUSE_A, status: 'charging' })
    );
    expect(rejected.status).toBe(422);
    expect(Robot.create).not.toHaveBeenCalled();

    Robot.create.mockResolvedValue({ _id: ROBOT_A, warehouseId: WAREHOUSE_A });
    const allowed = await authed(
      request(app)
        .post('/api/robots')
        .send({ name: 'R', warehouseId: WAREHOUSE_A, position: { x: 3, y: 4 }, battery: 55 })
    );
    expect(allowed.status).toBe(201);
    expect(Robot.create.mock.calls[0][0]).toMatchObject({ position: { x: 3, y: 4 }, battery: 55 });
  });
});

describe('order server-owned fields cannot be assigned by the client', () => {
  it('rejects a status on create - every order starts pending', async () => {
    const res = await authed(
      request(app).post('/api/orders').send({
        warehouseId: WAREHOUSE_A,
        pickupLocation: { x: 1, y: 1 },
        deliveryLocation: { x: 2, y: 2 },
        status: 'delivered',
      })
    );

    expect(res.status).toBe(422);
    expect(Order.create).not.toHaveBeenCalled();
  });

  it('rejects a client-supplied assignedRobot on create', async () => {
    const res = await authed(
      request(app).post('/api/orders').send({
        warehouseId: WAREHOUSE_A,
        pickupLocation: { x: 1, y: 1 },
        deliveryLocation: { x: 2, y: 2 },
        assignedRobot: ROBOT_A,
      })
    );

    expect(res.status).toBe(422);
    expect(Order.create).not.toHaveBeenCalled();
  });

  it.each(['assignedAt', 'pickedUpAt', 'deliveredAt', 'createdAt'])(
    'rejects a client-supplied %s on update',
    async (field) => {
      const res = await authed(
        request(app).put(`/api/orders/${ORDER_A}`).send({ [field]: '2020-01-01T00:00:00.000Z' })
      );

      expect(res.status).toBe(422);
      expect(Order.findByIdAndUpdate).not.toHaveBeenCalled();
    }
  );

  it('rejects moving an order into a different warehouse', async () => {
    const res = await authed(
      request(app).put(`/api/orders/${ORDER_A}`).send({ warehouseId: '507f1f77bcf86cd799439099' })
    );
    expect(res.status).toBe(422);
  });
});

describe('statistics and logs', () => {
  it('rejects a client-chosen recordedAt on a statistics snapshot', async () => {
    const res = await authed(
      request(app)
        .post('/api/statistics')
        .send({ warehouseId: WAREHOUSE_A, recordedAt: '2020-01-01T00:00:00.000Z', metrics: {} })
    );
    expect(res.status).toBe(422);
    expect(Statistics.create).not.toHaveBeenCalled();
  });

  it('drops unknown metric keys rather than writing them', async () => {
    Statistics.create.mockResolvedValue({ _id: 's1' });

    await authed(
      request(app)
        .post('/api/statistics')
        .send({ warehouseId: WAREHOUSE_A, metrics: { activeRobots: 2, injectedKey: 'anything' } })
    );

    const created = Statistics.create.mock.calls[0][0];
    expect(created.metrics.activeRobots).toBe(2);
    expect(created.metrics.injectedKey).toBeUndefined();
  });

  it('rejects a client-chosen log source (forging the audit trail)', async () => {
    const res = await authed(
      request(app)
        .post('/api/logs')
        .send({ message: 'all fine here', warehouseId: WAREHOUSE_A, source: 'robot-engine' })
    );
    expect(res.status).toBe(422);
    expect(Log.create).not.toHaveBeenCalled();
  });

  it('rejects a client-supplied log meta blob', async () => {
    const res = await authed(
      request(app)
        .post('/api/logs')
        .send({ message: 'x', warehouseId: WAREHOUSE_A, meta: { anything: 'goes' } })
    );
    expect(res.status).toBe(422);
    expect(Log.create).not.toHaveBeenCalled();
  });
});

describe('Mongo operator injection', () => {
  it('strips $-prefixed keys from a request body before it reaches a model', async () => {
    Warehouse.create.mockResolvedValue({ _id: WAREHOUSE_A });

    await authed(
      request(app)
        .post('/api/warehouses')
        .send({ name: 'W', rows: 10, cols: 10, $set: { ownerId: USER_B_ID } })
    );

    const created = Warehouse.create.mock.calls[0][0];
    expect(created.$set).toBeUndefined();
    expect(created.ownerId).toBe(USER_A_ID);
  });

  it('never lets an operator object from the query string reach a filter', async () => {
    Warehouse.find.mockReturnValue(mockQuery([]));
    Warehouse.countDocuments.mockResolvedValue(0);

    // `?isActive[$ne]=false` parses to `{ isActive: { $ne: 'false' } }`.
    // Sanitisation strips the `$ne` key, leaving a value the validator
    // then rejects - so the request is refused outright and no query runs.
    const res = await authed(request(app).get('/api/warehouses?isActive[$ne]=false'));

    expect(res.status).toBe(400);
    expect(Warehouse.find).not.toHaveBeenCalled();
  });

  it('strips $-prefixed and dotted keys anywhere in a nested structure', () => {
    const { sanitize, hasMongoOperators } = require('../../src/middleware/dto');

    const hostile = {
      email: { $gt: '' },
      nested: [{ 'a.b': 1, ok: 2 }],
      deep: { level: { $where: 'sleep(5000)' } },
    };

    expect(hasMongoOperators(hostile)).toBe(true);
    sanitize(hostile);

    expect(hostile.email.$gt).toBeUndefined();
    expect(hostile.nested[0]['a.b']).toBeUndefined();
    expect(hostile.nested[0].ok).toBe(2); // benign keys survive
    expect(hostile.deep.level.$where).toBeUndefined();
    expect(hasMongoOperators(hostile)).toBe(false);
  });
});
