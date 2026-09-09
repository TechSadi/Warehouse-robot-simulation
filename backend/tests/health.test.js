const request = require('supertest');
const app = require('../src/app');

describe('GET /api/health', () => {
  it('returns 200 with service status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.service).toBe('warehouse-robot-simulation-backend');
    expect(res.body.data.status).toBe('ok');
  });

  it('discloses nothing beyond liveness to an anonymous caller', () => {
    // Uptime dates a deployment, and a database state flipping to
    // `disconnected` says exactly when the service is least able to defend
    // itself. Neither is something a platform health check needs.
    return request(app)
      .get('/api/health')
      .then((res) => {
        expect(res.body.data).not.toHaveProperty('database');
        expect(res.body.data).not.toHaveProperty('uptimeSeconds');
      });
  });

  it('requires a session for the operational detail', async () => {
    const res = await request(app).get('/api/health/details');
    expect(res.status).toBe(401);
  });
});

describe('unmatched routes', () => {
  it('returns a formatted 404 for unknown API routes', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toMatch(/Route not found/);
  });
});

describe('security middleware', () => {
  it('sets Helmet security headers', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-dns-prefetch-control']).toBeDefined();
  });
});
