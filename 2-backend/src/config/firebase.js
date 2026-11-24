const { applicationDefault, getApp, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth: getFirebaseAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

function initializeFirebase() {
  if (getApps().length > 0) {
    return getApp();
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const options = {
    credential: applicationDefault(),
  };

  if (projectId) {
    options.projectId = projectId;
  }

  return initializeApp(options);
}

function getAuth() {
  return getFirebaseAuth(getApp());
}

function getDb() {
  return getFirestore(getApp());
}

module.exports = { getAuth, getDb, initializeFirebase };
