const { getAuth } = require("../config/firebase");

async function requireAuth(req, res, next) {
  const authorization = req.get("authorization");
  const match = authorization && authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({ error: "A Firebase ID token is required" });
  }

  try {
    req.user = await getAuth().verifyIdToken(match[1]);
    return next();
  } catch (error) {
    if (error.code && error.code.startsWith("auth/")) {
      return res.status(401).json({ error: "Invalid or expired Firebase ID token" });
    }

    return next(error);
  }
}

module.exports = requireAuth;
