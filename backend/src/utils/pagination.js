const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || DEFAULT_LIMIT));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function buildMeta({ page, limit, total }) {
  return { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

module.exports = { parsePagination, buildMeta };
