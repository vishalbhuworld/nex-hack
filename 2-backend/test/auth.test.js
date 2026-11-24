const test = require("node:test");
const assert = require("node:assert/strict");
const auth = require("../src/auth");

function createFakeFirestore() {
  const collections = new Map();
  const records = (name) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  return {
    collection(name) {
      return {
        doc(id) {
          return {
            async set(data) {
              records(name).set(id, JSON.parse(JSON.stringify(data)));
            },
          };
        },
        async get() {
          const collectionRecords = records(name);
          return {
            forEach(callback) {
              collectionRecords.forEach((data, id) => callback({
                id,
                data: () => data,
              }));
            },
          };
        },
      };
    },
    records,
  };
}

test("staff accounts and customer profiles persist in separate Firestore collections", async () => {
  const fakeFirestore = createFakeFirestore();
  await auth.initializePersistence(fakeFirestore);

  await auth.createStaff({ id: "staff-firestore", name: "Persistent Staff", password: "test-password-123" });
  await auth.customerLogin("persisted-customer@example.com");

  const staffRecord = fakeFirestore.records("staffAccounts").get("staff-firestore");
  assert.ok(staffRecord.hash);
  assert.notEqual(staffRecord.hash, "test-password-123");
  assert.equal(fakeFirestore.records("customers").get("persisted-customer@example.com").loginCount, 1);

  await auth.initializePersistence(fakeFirestore);
  assert.equal((await auth.staffLogin("staff-firestore", "test-password-123")).user.role, "staff");
  await auth.customerLogin("persisted-customer@example.com");
  assert.equal(fakeFirestore.records("customers").get("persisted-customer@example.com").loginCount, 2);
});
