const { PubSub } = require("@google-cloud/pubsub");

// On Cloud Run this authenticates automatically via the service's own
// identity (Application Default Credentials) — no key file needed,
// same as everything else in this app that talks to GCP. Locally,
// either run `gcloud auth application-default login` once, or set
// GOOGLE_APPLICATION_CREDENTIALS to a downloaded service account key
// before running the outbox publish route.
//
// PUBSUB_PROJECT_ID only needs setting if it differs from whatever
// project Application Default Credentials would infer on its own
// (it usually doesn't on Cloud Run, so this is mainly a local-dev
// escape hatch).
const pubsub = new PubSub(process.env.PUBSUB_PROJECT_ID ? { projectId: process.env.PUBSUB_PROJECT_ID } : undefined);

module.exports = pubsub;
