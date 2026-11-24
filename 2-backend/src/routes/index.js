const express = require("express");
const healthRoute = require("./health");
const orderRoute = require("./orders");
const controlRoute = require("./controls");
const authRoute = require("./auth");
const auth = require("../auth");

const router = express.Router();

router.use("/health", healthRoute);
router.use("/auth", authRoute);
router.use("/orders", orderRoute);
router.use("/controls", auth.authenticate, auth.allowRoles("admin", "staff"), controlRoute);

module.exports = router;
