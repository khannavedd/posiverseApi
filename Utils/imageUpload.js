const { getPrintLogoBucket } = require("./storage");

// Shared image upload/replace/delete for anything that owns a single
// picture — the print-template logo, a product, a category.
//
// WHY IT IS SHARED. uploadPrintTemplateLogo already did all of this
// inline. Copying that into Product and Category would have meant three
// places to keep the extension map, the object naming, the public-URL
// construction and the delete-the-old-one step in step, and the third
// copy is where they start to drift.
//
// BUCKET. Deliberately the same bucket as the logo, via the existing
// PRINT_LOGO_BUCKET env var, rather than a new one. A second bucket
// would mean more infrastructure to create, make public, and grant
// access to before any of this works — for no benefit, since objects
// are separated by path prefix anyway. The variable name is now a
// little narrow for what it holds; renaming it is a deploy-time
// breaking change and not worth it.
const EXTENSION_BY_MIMETYPE = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
};

// Objects are namespaced by registration so one business can never
// overwrite another's, and by prefix so they are browsable in the GCS
// console. Date.now() makes each upload a NEW object rather than
// overwriting in place: a CDN or an <Image> cache that already has the
// old URL keeps serving the old bytes, so replacing an image in place
// looks like nothing happened.
function objectPathFor({ prefix, registrationId, ownerId, extension }) {
  return `${prefix}/${registrationId}/${ownerId}-${Date.now()}.${extension}`;
}

async function uploadImage({ file, prefix, registrationId, ownerId }) {
  const bucket = getPrintLogoBucket();
  const extension = EXTENSION_BY_MIMETYPE[file.mimetype] || "jpg";
  const objectPath = objectPathFor({ prefix, registrationId, ownerId, extension });

  // Bucket is public-read at the bucket/IAM level (uniform bucket-level
  // access), so no per-object makePublic() — that call is not available
  // on such buckets and would throw.
  await bucket.file(objectPath).save(file.buffer, {
    contentType: file.mimetype,
    resumable: false,
  });

  return `https://storage.googleapis.com/${bucket.name}/${objectPath}`;
}

// Best-effort. A failure here must NOT fail the request: the new image
// is already saved and the database already points at it, so throwing
// would report failure for an operation that actually succeeded and
// tempt the caller into retrying an upload that does not need retrying.
// The cost of getting this wrong is an orphaned object, which is
// cheap; the cost of the alternative is a confused shopkeeper.
async function deleteImageByUrl(url) {
  if (!url) return;
  try {
    const bucket = getPrintLogoBucket();
    const prefix = `https://storage.googleapis.com/${bucket.name}/`;
    if (!url.startsWith(prefix)) return; // not ours — leave it alone
    await bucket.file(url.slice(prefix.length)).delete({ ignoreNotFound: true });
  } catch (error) {
    console.error("Failed to delete old image (continuing):", error?.message);
  }
}

module.exports = { uploadImage, deleteImageByUrl, EXTENSION_BY_MIMETYPE };
