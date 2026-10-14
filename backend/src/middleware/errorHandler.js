
function errorHandler(err, req, res, next) {
  console.error('[marnet]', req.method, req.path, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Unknown error' });
}

function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

module.exports = { errorHandler, notFound };
