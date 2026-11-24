require("dotenv").config();

const app = require("./app");
const store = require("./store");
const auth = require("./auth");
const { getDb, initializeFirebase } = require("./config/firebase");

const port = Number(process.env.PORT) || 5000;

async function startServer() {
  if (process.env.FIRESTORE_PERSISTENCE === "true") {
    if (!process.env.FIREBASE_PROJECT_ID) {
      throw new Error("FIREBASE_PROJECT_ID is required when Firestore persistence is enabled");
    }
    initializeFirebase();
    const db = getDb();
    await Promise.all([
      store.initializePersistence(db),
      auth.initializePersistence(db),
    ]);
    console.log("Firestore persistence enabled");
  }

  app.listen(port, () => {
    console.log(`API server listening on port ${port}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start API server:", error);
  process.exitCode = 1;
});
