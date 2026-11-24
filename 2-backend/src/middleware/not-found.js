function notFound(req, res, _next) {
  res.status(404).json({
    error: "Not found",
    path: req.originalUrl,
  });
}

module.exports = notFound;
