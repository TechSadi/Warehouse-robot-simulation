const request = require('supertest');
const { authed } = require('./helpers/auth');
const app = require('../src/app');

const SOME_ID = '507f1f77bcf86cd799439011';

// These assert the *validation* layer, which runs before the ownership
// lookup - so every request here is authenticated but deliberately never
// reaches a real model. Authorization has its own coverage in
// tests/security/.
describe('request validation', () => {
  it('rejects an invalid Mongo ObjectId in a route param', async () => {
    const res = await authed(request(app).get('/api/robots/not-a-valid-id'));
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.details[0].field).toBe('id');
  });

  it('rejects a robot with a missing name and warehouseId', async () => {
    const res = await authed(request(app).post('/api/robots').send({}));
    expect(res.status).toBe(400);
    const fields = res.body.error.details.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'warehouseId']));
  });

  it('rejects an out-of-range battery value', async () => {
    const res = await authed(
      request(app).post('/api/robots').send({ name: 'R2', warehouseId: SOME_ID, battery: 150 })
    );
    expect(res.status).toBe(400);
    expect(res.body.error.details.some((d) => d.field === 'battery')).toBe(true);
  });

  it('rejects an order with a non-numeric pickup location', async () => {
    const res = await authed(
      request(app).post('/api/orders').send({
        warehouseId: SOME_ID,
        pickupLocation: { x: 'a', y: 1 },
        deliveryLocation: { x: 1, y: 1 },
      })
    );
    expect(res.status).toBe(400);
    expect(res.body.error.details.some((d) => d.field === 'pickupLocation.x')).toBe(true);
  });

  it('rejects an unknown warehouse cell type', async () => {
    const res = await authed(
      request(app).post('/api/warehouses').send({
        name: 'Main Floor',
        rows: 10,
        cols: 10,
        cells: [{ x: 0, y: 0, type: 'not-a-type' }],
      })
    );
    expect(res.status).toBe(400);
    expect(res.body.error.details.some((d) => d.field === 'cells[0].type')).toBe(true);
  });

  it('rejects a log level outside the allowed enum', async () => {
    const res = await authed(
      request(app).post('/api/logs').send({ message: 'hi', level: 'verbose', warehouseId: SOME_ID })
    );
    expect(res.status).toBe(400);
    expect(res.body.error.details.some((d) => d.field === 'level')).toBe(true);
  });
});
