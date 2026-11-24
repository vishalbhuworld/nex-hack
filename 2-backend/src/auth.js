const crypto = require("crypto");

const staff = new Map();
const customers = new Map();
const sessions = new Map();
let persistenceDb = null;
let persistenceQueue = Promise.resolve();
const adminId = process.env.DEMO_ADMIN_ID || "admin";
const adminPassword = process.env.DEMO_ADMIN_PASSWORD || "admin123";
const adminSalt = crypto.randomBytes(16);
const adminHash = crypto.scryptSync(adminPassword, adminSalt, 64);

function hashPassword(password, salt = crypto.randomBytes(16)) {
  return {
    salt: salt.toString("hex"),
    hash: crypto.scryptSync(password, salt, 64).toString("hex"),
  };
}

function matches(password, record) {
  const actual = crypto.scryptSync(password, Buffer.from(record.salt, "hex"), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(record.hash, "hex"));
}

async function initializePersistence(db) {
  const [staffSnapshot, customerSnapshot] = await Promise.all([
    db.collection("staffAccounts").get(),
    db.collection("customers").get(),
  ]);
  staff.clear();
  customers.clear();
  staffSnapshot.forEach((document) => {
    const record = document.data();
    if (!record.id || !record.salt || !record.hash) {
      throw new Error(`Invalid staff account record: ${document.id}`);
    }
    staff.set(record.id, record);
  });
  customerSnapshot.forEach((document) => {
    const record = document.data();
    if (!record.email || !Number.isInteger(record.loginCount)) {
      throw new Error(`Invalid customer record: ${document.id}`);
    }
    customers.set(record.email, record);
  });
  persistenceDb = db;
}

async function persistRecord(collection, id, record) {
  if (!persistenceDb) return;
  try {
    const write = persistenceQueue.catch(() => {}).then(() =>
      persistenceDb.collection(collection).doc(id).set(record),
    );
    persistenceQueue = write;
    await write;
  } catch (error) {
    const persistenceError = new Error(`Failed to save ${collection} data: ${error.message}`);
    persistenceError.status = 500;
    throw persistenceError;
  }
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, user);
  return { token, user };
}

async function customerLogin(email) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new Error("Enter a valid email address");
  }
  const normalizedEmail = email.trim().toLowerCase();
  const existing = customers.get(normalizedEmail);
  const customer = {
    email: normalizedEmail,
    firstSeenAt: existing ? existing.firstSeenAt : new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    loginCount: existing ? existing.loginCount + 1 : 1,
  };
  customers.set(normalizedEmail, customer);
  try {
    await persistRecord("customers", normalizedEmail, customer);
  } catch (error) {
    if (existing) customers.set(normalizedEmail, existing);
    else customers.delete(normalizedEmail);
    throw error;
  }
  return createSession({ role: "customer", email: normalizedEmail, name: email.trim() });
}

function adminLogin(id, password) {
  const candidate = Buffer.from(
    crypto.scryptSync(String(password || ""), adminSalt, 64),
  );
  if (id !== adminId || candidate.length !== adminHash.length || !crypto.timingSafeEqual(candidate, adminHash)) {
    throw new Error("Invalid admin ID or password");
  }
  return createSession({ role: "admin", id: adminId, name: "Administrator" });
}

function staffLogin(id, password) {
  const record = staff.get(String(id || "").trim());
  if (!record || !matches(String(password || ""), record)) throw new Error("Invalid staff ID or password");
  return createSession({ role: "staff", id: record.id, name: record.name });
}

async function createStaff({ id, name, password }) {
  const staffId = String(id || "").trim();
  const staffName = String(name || "").trim();
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(staffId)) throw new Error("Staff ID must be 3–32 letters, numbers, _ or -");
  if (!staffName) throw new Error("Staff name is required");
  if (typeof password !== "string" || password.length < 8) throw new Error("Staff password must be at least 8 characters");
  if (staffId === adminId || staff.has(staffId)) throw new Error("That staff ID is already in use");
  const record = { id: staffId, name: staffName, createdAt: new Date().toISOString(), ...hashPassword(password) };
  staff.set(staffId, record);
  try {
    await persistRecord("staffAccounts", staffId, record);
  } catch (error) {
    staff.delete(staffId);
    throw error;
  }
  return { id: staffId, name: staffName };
}

function listStaff() {
  return [...staff.values()].map(({ id, name, createdAt }) => ({ id, name, createdAt }));
}

function listCustomers() {
  return [...customers.values()]
    .map(({ email, firstSeenAt, lastSeenAt, loginCount }) => ({ email, firstSeenAt, lastSeenAt, loginCount }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

function authenticate(req, res, next) {
  const authorization = req.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const user = sessions.get(token);
  if (!user) return res.status(401).json({ error: "Please sign in" });
  req.user = user;
  req.token = token;
  next();
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You do not have permission for this action" });
    }
    next();
  };
}

function logout(token) {
  sessions.delete(token);
}

module.exports = {
  initializePersistence,
  customerLogin,
  adminLogin,
  staffLogin,
  createStaff,
  listStaff,
  listCustomers,
  authenticate,
  allowRoles,
  logout,
};
