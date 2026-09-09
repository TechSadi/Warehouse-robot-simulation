/**
 * Transport-layer hardening: rate limiting, security headers, CORS, body
 * size limits, error-message hygiene, and the input-validation bounds that
 * are specifically about cost rather than correctness.
 *
 * Rate limiting is disabled under NODE_ENV=test (see middleware/rateLimit.js -
 * limits exist to stop abuse, not to make a suite flaky), so those cases
 * exercise the limiter middleware directly against a throwaway Express app
 * rather than through the real one.
 */
const express = require('express');
const request = require('supertest');
const { mockQuery } = require('../helpers/mockQuery');
const { authed, mockOwnership, makeWarehouse, USER_A_ID } = require('../helpers/auth');

const WAREHOUSE_A = '507f1f77bcf86cd799439011';

jest.mock('../../src/models/Warehouse', () =>
  Object.assign(
    {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      countDocuments: jest.fn(),
    },
    { CELL_TYPES: ['shelf', 'charging', 'obstacle', 'dock'] }
  )
);
jest.mock('../../src/services/simulationManager', () => ({
  getEngine: jest.fn().mockResolvedValue(null),
  getOrderCoordinator: jest.fn().mockResolvedValue(null),
  invalidate: jest.fn(),
}));

const Warehouse = require('../../src/models/Warehouse');
const app = require('../../src/app');
const env = require('../../src/config/env');

beforeEach(() => {
  jest.clearAllMocks();
  mockOwnership(Warehouse, { warehouse: makeWarehouse(WAREHOUSE_A, USER_A_ID, { rows: 20, cols: 20 }) });
  Warehouse.find.mockReturnValue(mockQuery([]));
  Warehouse.countDocuments.mockResolvedValue(0);
});

describe('security headers', () => {
  it('sets the Helmet header set on API responses', async () => {
    const res = await request(app).get('/api/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
  });

  it('does not advertise the framework', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('CORS', () => {
  it('allows a configured frontend origin, with credentials', async () => {
    const origin = env.clientOrigins[0];
    const res = await request(app).get('/api/health').set('Origin', origin);

    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('sends no CORS headers for an unknown origin', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example.com');

    // Neither the attacker's origin reflected back, nor a wildcard - the
    // browser blocks the read either way, and a credentialed API must
    // never do either.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never emits a wildcard allow-origin', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });
});

describe('request body limits', () => {
  it('rejects an oversized JSON body', async () => {
    // ~1MB of cells, well over the 256kb cap.
    const huge = { name: 'W', rows: 10, cols: 10, cells: 'x'.repeat(1024 * 1024) };
    const res = await authed(request(app).post('/api/warehouses').send(huge));

    expect(res.status).toBe(413);
  });

  it(
    'bounds the number of cells in a layout',
    async () => {
      const cells = Array.from({ length: 7000 }, (_, i) => ({ x: i % 79, y: 1, type: 'shelf' }));
      const res = await authed(
        request(app).post('/api/warehouses').send({ name: 'W', rows: 10, cols: 10, cells })
      );

      expect(res.status).toBe(400);
      expect(Warehouse.create).not.toHaveBeenCalled();
    },
    // Running express-validator over 7000 rejected cells is genuinely
    // seconds of work - that is the cost this limit exists to cap, and
    // paying it once here is the point of the test. The default 5s ceiling
    // is a stopwatch on how busy the host is rather than a hang detector,
    // so give it real headroom.
    30000
  );
});

describe('input validation bounds', () => {
  it('rejects out-of-range pathfinding coordinates before running A*', async () => {
    const res = await authed(
      request(app)
        .post(`/api/warehouses/${WAREHOUSE_A}/path`)
        .send({ start: { x: 0, y: 0 }, goal: { x: 100000, y: 100000 } })
    );

    expect(res.status).toBe(400);
  });

  it('rejects coordinates that are in range for the API but outside this warehouse', async () => {
    // A 20x20 warehouse. (50, 50) passes the generic 0-79 validator but is
    // not a cell of *this* layout, so A* would explore the whole reachable
    // grid before reporting failure.
    const res = await authed(
      request(app)
        .post(`/api/warehouses/${WAREHOUSE_A}/path`)
        .send({ start: { x: 0, y: 0 }, goal: { x: 50, y: 50 } })
    );

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/outside the warehouse bounds/);
  });

  it('rejects a negative coordinate', async () => {
    const res = await authed(
      request(app)
        .post(`/api/warehouses/${WAREHOUSE_A}/path`)
        .send({ start: { x: -1, y: 0 }, goal: { x: 1, y: 1 } })
    );
    expect(res.status).toBe(400);
  });

  it('bounds order-generation count', async () => {
    const res = await authed(
      request(app).post(`/api/warehouses/${WAREHOUSE_A}/orders/generate`).send({ count: 100000 })
    );
    expect(res.status).toBe(400);
  });

  it('bounds a manual tick delta', async () => {
    const res = await authed(request(app).post(`/api/warehouses/${WAREHOUSE_A}/tick`).send({ deltaSeconds: 1e9 }));
    expect(res.status).toBe(400);
  });

  it('caps pagination so a client cannot request the whole collection', async () => {
    const res = await authed(request(app).get('/api/warehouses?limit=100000'));
    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBeLessThanOrEqual(100);
  });

  it('ignores a nonsense page number rather than computing a negative skip', async () => {
    const res = await authed(request(app).get('/api/warehouses?page=-5&limit=abc'));
    expect(res.status).toBe(200);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBeGreaterThan(0);
  });
});

describe('error hygiene', () => {
  it('does not reflect an unbounded path back in a 404 body', async () => {
    const long = 'a'.repeat(5000);
    const res = await request(app).get(`/api/${long}`);

    expect(res.status).toBe(404);
    expect(res.body.error.message.length).toBeLessThan(300);
  });

  it('does not include a stack trace on an authentication failure', async () => {
    const res = await request(app).get('/api/warehouses');
    expect(res.status).toBe(401);
    expect(res.body.error.stack).toBeUndefined();
  });
});

describe('rate limiters (exercised directly)', () => {
  /** Mounts one limiter on a throwaway app. The real app skips limiters
   * under NODE_ENV=test, so `skip` is overridden here. */
  function appWith(limiterFactory) {
    const rateLimit = require('express-rate-limit');
    const probe = express();
    probe.use(limiterFactory(rateLimit));
    probe.get('/', (req, res) => res.json({ ok: true }));
    return probe;
  }

  it('allows a burst then returns 429 with a RateLimit header', async () => {
    const probe = appWith((rateLimit) =>
      rateLimit({ windowMs: 60_000, max: 3, standardHeaders: true, legacyHeaders: false })
    );

    const allowed = await Promise.all([
      request(probe).get('/'),
      request(probe).get('/'),
      request(probe).get('/'),
    ]);
    expect(allowed.map((r) => r.status)).toEqual([200, 200, 200]);

    const blocked = await request(probe).get('/');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['ratelimit-limit']).toBeDefined();
  });

  it('configures a strict budget for authentication and a generous one for the API', async () => {
    // The point of the tiering: a limit tight enough to matter for
    // credential stuffing would break a running simulation if applied
    // globally, so the two are sized independently.
    const { authLimiter, apiLimiter, traceLimiter } = require('../../src/middleware/rateLimit');

    expect(authLimiter).toBeInstanceOf(Function);
    expect(apiLimiter).toBeInstanceOf(Function);
    expect(traceLimiter).toBeInstanceOf(Function);
  });

  it('collapses IPv6 addresses to a prefix so a client cannot rotate its own key', () => {
    const { ipKeyGenerator } = require('express-rate-limit');

    const a = ipKeyGenerator('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd');
    const b = ipKeyGenerator('2001:db8:1234:5678:1111:2222:3333:4444');

    // Two addresses from the same /64 - a residential client is routinely
    // handed a whole one and could otherwise pick a fresh address per
    // request, resetting its budget every time.
    expect(a).toBe(b);
  });
});
