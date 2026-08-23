const { Storage } = require("@google-cloud/storage");

// Same Application Default Credentials pattern as Utils/pubsub.js — on
// Cloud Run this authenticates automatically via the service's own
// identity, no key file needed. Locally, either run
// `gcloud auth application-default login` once, or set
// GOOGLE_APPLICATION_CREDENTIALS to a downloaded service account key.
//
// STORAGE_PROJECT_ID only needs setting if it differs from whatever
// project Application Default Credentials would infer on its own
// (it usually doesn't on Cloud Run) — same escape hatch pubsub.js has.
const storage = new Storage(process.env.STORAGE_PROJECT_ID ? { projectId: process.env.STORAGE_PROJECT_ID } : undefined);

// PRINT_LOGO_BUCKET must be created + made accessible by hand first —
// see DEC-011 and the setup runbook it points to. No default bucket
// name here on purpose: GCS bucket names are globally unique across
// every GCP project on Earth, so a hardcoded default would just be
// wrong for anyone else who ever reads this file.
function getPrintLogoBucket() {
  const bucketName = process.env.PRINT_LOGO_BUCKET;
  if (!bucketName) {
    throw new Error("PRINT_LOGO_BUCKET environment variable is not set.");
  }
  return storage.bucket(bucketName);
}

module.exports = { storage, getPrintLogoBucket };
