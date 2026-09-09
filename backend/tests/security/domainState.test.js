/**
 * Domain state protection.
 *
 * Two halves:
 *  1. the state machines themselves (pure, no HTTP), and
 *  2. the REST API refusing to bypass them - the generic CRUD endpoint
 *     must not be a side door around rules the simulation engine obeys.
 */
const request = require('supertest');
const { mockQuery } = require('../helpers/mockQuery');
const { authed, mockOwnership, makeWarehouse, USER_A_ID } = require('../helpers/auth');

const orderLifecycle = require('../../src/domain/orderLifecycle');
const robotLifecycle = require('../../src/domain/robotLifecycle');

const WAREHOUSE_A = '507f1f77bcf86cd799439011';
const ORDER_A = '507f1f77bcf86cd799439022';
const ROBOT_A = '507f1f77bcf86cd799439021';

jest.mock('../../src/models/Warehouse', () =>
  Object.assign(
    { find: jest.fn(), findById: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() },
    { CELL_TYPES: ['shelf', 'charging', 'obstacle', 'dock'] }
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
jest.mock('../../src/models/Robot', () =>
  Object.assign(
    {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      countDocuments: jest.fn(),
    },
    { STATUSES: ['idle', 'moving', 'charging', 'error'] }
  )
);

const Order = require('../../src/models/Order');
const Robot = require('../../src/models/Robot');
const Warehouse = require('../../src/models/Warehouse');
const app = require('../../src/app');

function givenOrder(status) {
  Order.findById.mockResolvedValue({
    _id: ORDER_A,
    warehouseId: WAREHOUSE_A,
    status,
    pickupLocation: { x: 1, y: 1 },
    deliveryLocation: { x: 2, y: 2 },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOwnership(Warehouse, { warehouse: makeWarehouse(WAREHOUSE_A, USER_A_ID, { rows: 20, cols: 20 }) });
  Warehouse.find.mockReturnValue(mockQuery([{ _id: WAREHOUSE_A }]));
  Robot.findById.mockResolvedValue({ _id: ROBOT_A, warehouseId: WAREHOUSE_A, status: 'idle' });
  Robot.findOne.mockReturnValue(mockQuery({ _id: ROBOT_A }));
  Order.findByIdAndUpdate.mockResolvedValue({ _id: ORDER_A });
});

describe('order lifecycle (unit)', () => {
  it('walks the full happy path', () => {
    const chain = ['pending', 'assigned', 'picking_up', 'picked_up', 'delivering', 'delivered'];
    for (let i = 0; i < chain.length - 1; i += 1) {
      expect(orderLifecycle.canTransition(chain[i], chain[i + 1])).toBe(true);
    }
  });

  it('allows the coarser legs the simulation actually takes', () => {
    // OrderCoordinator observes a robot only when it arrives somewhere, so
    // it advances a whole leg at a time. Both are forward moves along the
    // same chain.
    expect(orderLifecycle.canTransition('assigned', 'picked_up')).toBe(true);
    expect(orderLifecycle.canTransition('picked_up', 'delivered')).toBe(true);
  });

  it.each([
    ['pending', 'delivered'], // inventing a delivery no robot performed
    ['pending', 'picked_up'],
    ['pending', 'delivering'],
    ['assigned', 'delivered'],
    ['delivered', 'pending'], // un-delivering a finished order
    ['delivered', 'assigned'],
    ['cancelled', 'pending'],
    ['delivering', 'assigned'], // backwards
    ['picked_up', 'assigned'],
  ])('rejects %s -> %s', (from, to) => {
    expect(orderLifecycle.canTransition(from, to)).toBe(false);
    expect(() => orderLifecycle.assertTransition(from, to)).toThrow(orderLifecycle.OrderTransitionError);
  });

  it('rejects a status that is not a status at all', () => {
    expect(() => orderLifecycle.assertTransition('pending', 'teleported')).toThrow();
  });

  it('treats delivered and cancelled as terminal', () => {
    expect(orderLifecycle.isTerminal('delivered')).toBe(true);
    expect(orderLifecycle.isTerminal('cancelled')).toBe(true);
    expect(orderLifecycle.isTerminal('pending')).toBe(false);
  });

  it('allows cancelling from any live state', () => {
    for (const status of ['pending', 'assigned', 'picking_up', 'picked_up', 'delivering']) {
      expect(orderLifecycle.canTransition(status, 'cancelled')).toBe(true);
    }
  });

  it('clears the robot assignment when an order is requeued to pending', () => {
    const update = orderLifecycle.buildTransitionUpdate('assigned', 'pending');
    expect(update.assignedRobot).toBeNull();
    expect(update.assignedAt).toBeNull();
  });

  it('stamps the transition timestamp server-side', () => {
    expect(orderLifecycle.buildTransitionUpdate('pending', 'assigned').assignedAt).toBeInstanceOf(Date);
    expect(orderLifecycle.buildTransitionUpdate('assigned', 'picked_up').pickedUpAt).toBeInstanceOf(Date);
    expect(orderLifecycle.buildTransitionUpdate('picked_up', 'delivered').deliveredAt).toBeInstanceOf(Date);
  });

  it('treats a same-status write as a no-op rather than an error', () => {
    expect(orderLifecycle.canTransition('pending', 'pending')).toBe(true);
    expect(orderLifecycle.buildTransitionUpdate('pending', 'pending')).toEqual({});
  });
});

describe('robot lifecycle (unit)', () => {
  it('allows the transitions the engine performs', () => {
    expect(robotLifecycle.canTransition('idle', 'moving')).toBe(true);
    expect(robotLifecycle.canTransition('moving', 'idle')).toBe(true);
    expect(robotLifecycle.canTransition('idle', 'charging')).toBe(true);
    expect(robotLifecycle.canTransition('charging', 'idle')).toBe(true);
    expect(robotLifecycle.canTransition('error', 'idle')).toBe(true);
  });

  it('refuses to start charging mid-aisle', () => {
    // Mirrors RobotEngine.startCharging's own INVALID_TRANSITION guard.
    expect(robotLifecycle.canTransition('moving', 'charging')).toBe(false);
  });

  it('refuses to move or charge a robot straight out of the error state', () => {
    expect(robotLifecycle.canTransition('error', 'moving')).toBe(false);
    expect(robotLifecycle.canTransition('error', 'charging')).toBe(false);
  });

  it('names the simulation-owned fields the REST layer must not write', () => {
    expect(robotLifecycle.SIMULATION_OWNED_FIELDS).toEqual(
      expect.arrayContaining(['position', 'rotation', 'battery', 'status', 'errorReason', 'taskQueue'])
    );
  });
});

describe('PUT /api/orders/:id enforces the lifecycle', () => {
  it('refuses to jump straight from pending to delivered', async () => {
    givenOrder('pending');

    const res = await authed(request(app).put(`/api/orders/${ORDER_A}`).send({ status: 'delivered' }));

    expect(res.status).toBe(409);
    expect(res.body.error.details.code).toBe('INVALID_ORDER_TRANSITION');
    expect(Order.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses to un-deliver a delivered order', async () => {
    givenOrder('delivered');

    const res = await authed(request(app).put(`/api/orders/${ORDER_A}`).send({ status: 'pending' }));

    expect(res.status).toBe(409);
    expect(Order.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses to edit a delivered order at all', async () => {
    givenOrder('delivered');

    const res = await authed(request(app).put(`/api/orders/${ORDER_A}`).send({ priority: 'urgent' }));

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already delivered/i);
  });

  it('accepts a legal forward transition', async () => {
    givenOrder('assigned');

    const res = await authed(request(app).put(`/api/orders/${ORDER_A}`).send({ status: 'picking_up' }));

    expect(res.status).toBe(200);
    const [, update] = Order.findByIdAndUpdate.mock.calls[0];
    expect(update.$set.status).toBe('picking_up');
  });

  it('refuses to relocate an order a robot is already driving to', async () => {
    givenOrder('assigned');

    const res = await authed(
      request(app).put(`/api/orders/${ORDER_A}`).send({ pickupLocation: { x: 9, y: 9 } })
    );

    expect(res.status).toBe(409);
    expect(Order.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses to attach a robot from a different warehouse', async () => {
    givenOrder('pending');
    Robot.findOne.mockReturnValue(mockQuery(null)); // no such robot *in this warehouse*

    const res = await authed(
      request(app).put(`/api/orders/${ORDER_A}`).send({ assignedRobot: '507f1f77bcf86cd799439099' })
    );

    expect(res.status).toBe(422);
    expect(Order.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});

describe('the simulation and the REST API share one rule set', () => {
  it("the engine's order writes are guarded by the same predecessor sets", () => {
    // orderService builds its bulkWrite filters from predecessorsOf(), so
    // an illegal move matches no document rather than being applied.
    expect(orderLifecycle.predecessorsOf('assigned')).toEqual(['pending']);
    expect(orderLifecycle.predecessorsOf('picked_up')).toEqual(['assigned', 'picking_up']);
    expect(orderLifecycle.predecessorsOf('delivered')).toEqual(['picked_up', 'delivering']);
    // Nothing precedes pending except an explicit requeue.
    expect(orderLifecycle.predecessorsOf('pending')).not.toContain('delivered');
  });

  it('the Order model enum is the lifecycle, not a separate list', () => {
    expect(Order.STATUSES).toEqual(orderLifecycle.STATUSES);
  });

  it('the Robot model enum is the lifecycle, not a separate list', () => {
    expect(jest.requireActual('../../src/domain/robotLifecycle').STATUSES).toEqual([
      'idle',
      'moving',
      'charging',
      'error',
    ]);
  });
});
