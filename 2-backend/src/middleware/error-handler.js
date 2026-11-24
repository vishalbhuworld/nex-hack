function errorHandler(err, _req, res, _next) {
  const status = Number(err.status) || 500;

  if (status >= 500) {
    console.error(err);
  }

  res.status(status).json({
    error: status >= 500 ? "Internal server error" : err.message,
  });
}

module.exports = errorHandler;
