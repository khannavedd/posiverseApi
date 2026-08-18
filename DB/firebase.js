const { initializeApp, cert, applicationDefault } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

// The service account JSON file is gitignored/dockerignored on purpose
// and never makes it into a deployed container or the CI build
// context — so nothing here can be a plain top-level require() of it
// (that unconditionally throws "Cannot find module" the moment it's
// missing, crashing the whole process at startup, same failure class
// as the earlier Cloud SQL connect-outside-try-catch crash).
//
// Credential resolution order:
//  1. FIREBASE_SERVICE_ACCOUNT env var (set on Cloud Run / in CI) —
//     the full service account JSON as a string, same value that's in
//     .env locally. This is the only path that works in the deployed
//     container.
//  2. The local key file — local dev only, when the file exists on
//     disk but the env var isn't set.
//  3. Application Default Credentials — last-resort fallback; works
//     automatically on GCP as long as the Cloud Run service's runtime
//     service account has Firebase Admin access.
function loadCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
  }
  try {
    return cert(require("./posiverse-app-firebase-adminsdk-fbsvc-46518010c9.json"));
  } catch (error) {
    return applicationDefault();
  }
}

const app = initializeApp({
  credential: loadCredential(),
});

const auth = getAuth(app);

module.exports = { auth };