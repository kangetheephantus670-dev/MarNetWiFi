// The real error always goes to the server logs. What the caller gets
// back is deliberately generic — this mirrors the client portal's own
// "Unknown error. Please try again." copy, so a failure never hints at
// what's misconfigured or how the system works internally.
function errorHandler(err, req, res, next) {
  console.error('[marnet]', req.method, req.path, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Unknown error' });
}

function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

module.exports = { errorHandler, notFound };
