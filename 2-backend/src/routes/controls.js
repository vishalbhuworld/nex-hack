const express = require("express");
const store = require("../store");
const auth = require("../auth");

const router = express.Router();

router.post("/reset", auth.allowRoles("admin"), async (_req, res, next) => {
  try {
    const snapshot = store.reset();
    await store.flush();
    res.json(snapshot);
  } catch (error) {
    next(error);
  }
});
router.post("/concurrency-demo", auth.allowRoles("admin"), async (_req, res, next) => {
  try {
    res.json(await store.runConcurrencyDemo());
  } catch (error) {
    next(error);
  }
});

module.exports = router;
