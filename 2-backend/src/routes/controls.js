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

router.get("/store-reliability", auth.authenticate, auth.allowRoles("admin", "staff"), (_req, res, next) => {
  try {
    const snapshot = store.getSnapshot();

    const scores = snapshot.stores.map(s => {
      const items = snapshot.orders.flatMap(o =>
        o.items.filter(i => i.storeId === s.id)
      );

      const successful = items.filter(i =>
        i.status === "dispatched"
      ).length;

      const failed = new Set(snapshot.issues
        .filter(i => i.storeId === s.id)
        .flatMap(i => i.affectedItems)
        .map(i => i.itemId)
        .filter(Boolean)).size;

      const total = successful + failed;

      return {
        storeId: s.id,
        name: s.name,
        available: s.available,
        successful,
        failed,
        score: total ? Math.round(successful / total * 100) : null
      };
    });

    res.json({ scores });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
