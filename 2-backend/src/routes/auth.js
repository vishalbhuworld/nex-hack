const express = require("express");
const auth = require("../auth");

const router = express.Router();

function login(handler) {
  return async (req, res, next) => {
    try {
      res.json(await handler(req.body));
    } catch (error) {
      if (!error.status) error.status = 401;
      next(error);
    }
  };
}

router.post("/customer", login(({ email }) => auth.customerLogin(email)));
router.post("/admin", login(({ id, password }) => auth.adminLogin(id, password)));
router.post("/staff/login", login(({ id, password }) => auth.staffLogin(id, password)));
router.get("/me", auth.authenticate, (req, res) => res.json({ user: req.user }));
router.post("/logout", auth.authenticate, (req, res) => {
  auth.logout(req.token);
  res.json({ ok: true });
});
router.get("/staff", auth.authenticate, auth.allowRoles("admin"), (_req, res) => {
  res.json({ staff: auth.listStaff() });
});
router.get("/directory", auth.authenticate, auth.allowRoles("admin"), (_req, res) => {
  const staff = auth.listStaff();
  const customers = auth.listCustomers();
  res.json({
    counts: { staff: staff.length, customers: customers.length },
    staff,
    customers,
  });
});
router.post("/staff", auth.authenticate, auth.allowRoles("admin"), (req, res, next) => {
  auth.createStaff(req.body)
    .then((staff) => res.status(201).json({ staff }))
    .catch((error) => {
      if (!error.status) error.status = 400;
      next(error);
    });
});

module.exports = router;
