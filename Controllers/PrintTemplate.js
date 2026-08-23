const crypto = require("crypto");
const pool = require("../DB/postgres");
const { getPrintLogoBucket } = require("../Utils/storage");

const VALID_TYPES = ["sale", "purchase"];

// image/jpeg -> jpg, image/png -> png, etc. — falls back to jpg for
// anything unrecognized rather than rejecting the upload outright;
// Routes/PrintTemplate.js's multer fileFilter already restricts this
// to image/* mimetypes before it gets here.
const EXTENSION_BY_MIMETYPE = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// Best-effort delete of the previous logo object — the bucket is
// public-read (see DEC-011) with no confidentiality concern, so an
// orphaned object left behind on failure is just a few KB of unused
// storage, not worth failing the request over.
async function tryDeleteObject(objectPath) {
  if (!objectPath) return;
  try {
    await getPrintLogoBucket().file(objectPath).delete();
  } catch (error) {
    // Already gone, or bucket/permissions issue — non-fatal either way.
  }
}

// PrintTemplate.LogoURL is a full public URL
// (https://storage.googleapis.com/<bucket>/<objectPath>) — this pulls
// just the object path back out so a later upload/remove can delete
// the previous object. Returns null for anything that doesn't look
// like a URL this app wrote itself (e.g. already null).
function objectPathFromUrl(url, bucketName) {
  if (!url || !bucketName) return null;
  const prefix = `https://storage.googleapis.com/${bucketName}/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

const DEFAULTS = {
  sale: { HeaderNote: "Tax Invoice", FooterMessage: "THANK YOU FOR YOUR BUSINESS" },
  purchase: { HeaderNote: "Purchase Order", FooterMessage: "" },
};

// Settings-style resource, not a list — a business has exactly one row
// per DocumentType ('sale' | 'purchase'), seeded by migration 028 (and
// by register() for new signups — see Controllers/Registration.js).
// GET still returns a sensible default object if a row is somehow
// missing, rather than a 404, so the Setup form always has something
// to render.
module.exports.getPrintTemplate = async (req, res) => {
  try {
    const { documentType } = req.params;
    if (!VALID_TYPES.includes(documentType)) {
      return res.status(400).json({ success: false, message: "documentType must be 'sale' or 'purchase'" });
    }

    const result = await pool.query(
      `SELECT * FROM "PrintTemplate" WHERE "RegistrationID" = $1 AND "DocumentType" = $2`,
      [req.user.RegistrationID, documentType]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        printTemplate: {
          DocumentType: documentType,
          StoreDisplayName: null,
          ShowLogo: true,
          HeaderNote: DEFAULTS[documentType].HeaderNote,
          FooterMessage: DEFAULTS[documentType].FooterMessage,
          ShowSignatureLine: true,
          TermsText: null,
        },
      });
    }

    return res.json({ success: true, printTemplate: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching print template" });
  }
};

// Upsert — PUT, not POST, since there's never a "create a new one",
// only "set this business's template for this document type".
module.exports.updatePrintTemplate = async (req, res) => {
  try {
    const { documentType } = req.params;
    if (!VALID_TYPES.includes(documentType)) {
      return res.status(400).json({ success: false, message: "documentType must be 'sale' or 'purchase'" });
    }

    const { storeDisplayName, showLogo, headerNote, footerMessage, showSignatureLine, termsText } = req.body;

    const result = await pool.query(
      `INSERT INTO "PrintTemplate"
        ("PrintTemplateID", "RegistrationID", "DocumentType", "StoreDisplayName", "ShowLogo",
         "HeaderNote", "FooterMessage", "ShowSignatureLine", "TermsText", "UpdatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT ("RegistrationID", "DocumentType") DO UPDATE SET
         "StoreDisplayName" = EXCLUDED."StoreDisplayName",
         "ShowLogo" = EXCLUDED."ShowLogo",
         "HeaderNote" = EXCLUDED."HeaderNote",
         "FooterMessage" = EXCLUDED."FooterMessage",
         "ShowSignatureLine" = EXCLUDED."ShowSignatureLine",
         "TermsText" = EXCLUDED."TermsText",
         "UpdatedAt" = now()
       RETURNING *`,
      [
        crypto.randomUUID(),
        req.user.RegistrationID,
        documentType,
        storeDisplayName?.trim() || null,
        showLogo != null ? !!showLogo : true,
        (headerNote ?? DEFAULTS[documentType].HeaderNote).trim(),
        (footerMessage ?? DEFAULTS[documentType].FooterMessage).trim(),
        showSignatureLine != null ? !!showSignatureLine : true,
        termsText?.trim() || null,
      ]
    );

    return res.json({ success: true, printTemplate: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error saving print template" });
  }
};

// POST /print-templates/:documentType/logo — multipart upload (see
// Routes/PrintTemplate.js's multer config for the field name/size/type
// restrictions). Separate from updatePrintTemplate on purpose: an
// image upload is its own atomic action in the UI (pick -> upload ->
// see the new thumbnail immediately), not something that should wait
// on the rest of the form's Save button, and it needs a different
// request shape (multipart, not JSON) so it can't just be a field on
// that same PUT.
module.exports.uploadPrintTemplateLogo = async (req, res) => {
  try {
    const { documentType } = req.params;
    if (!VALID_TYPES.includes(documentType)) {
      return res.status(400).json({ success: false, message: "documentType must be 'sale' or 'purchase'" });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No image file uploaded (expected field name 'logo')." });
    }

    const bucket = getPrintLogoBucket();
    const extension = EXTENSION_BY_MIMETYPE[req.file.mimetype] || "jpg";
    const objectPath = `print-logos/${req.user.RegistrationID}/${documentType}-${Date.now()}.${extension}`;

    // Bucket is configured public-read at the bucket/IAM level (see
    // DEC-011's setup runbook) rather than per-object ACLs — those are
    // disabled on buckets with uniform bucket-level access, which is
    // the modern default GCS steers new buckets toward. So this just
    // writes the object; no separate makePublic() call needed or
    // possible.
    await bucket.file(objectPath).save(req.file.buffer, {
      contentType: req.file.mimetype,
      resumable: false,
    });

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${objectPath}`;

    const existing = await pool.query(
      `SELECT "LogoURL" FROM "PrintTemplate" WHERE "RegistrationID" = $1 AND "DocumentType" = $2`,
      [req.user.RegistrationID, documentType]
    );
    const previousUrl = existing.rows[0]?.LogoURL;

    const result = await pool.query(
      `INSERT INTO "PrintTemplate"
        ("PrintTemplateID", "RegistrationID", "DocumentType", "HeaderNote", "FooterMessage", "LogoURL", "UpdatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT ("RegistrationID", "DocumentType") DO UPDATE SET
         "LogoURL" = EXCLUDED."LogoURL",
         "UpdatedAt" = now()
       RETURNING *`,
      [crypto.randomUUID(), req.user.RegistrationID, documentType, DEFAULTS[documentType].HeaderNote, DEFAULTS[documentType].FooterMessage, publicUrl]
    );

    // Clean up the object this row was pointing at before, if any —
    // after the new one is safely saved and the row updated, so a
    // failure here can never leave the row pointing at a deleted file.
    await tryDeleteObject(objectPathFromUrl(previousUrl, bucket.name));

    return res.json({ success: true, printTemplate: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error uploading logo" });
  }
};

// DELETE /print-templates/:documentType/logo — clears LogoURL back to
// null (PrintableDocument.js then falls back to the bundled app logo)
// and deletes the GCS object.
module.exports.removePrintTemplateLogo = async (req, res) => {
  try {
    const { documentType } = req.params;
    if (!VALID_TYPES.includes(documentType)) {
      return res.status(400).json({ success: false, message: "documentType must be 'sale' or 'purchase'" });
    }

    const bucket = getPrintLogoBucket();

    const existing = await pool.query(
      `SELECT "LogoURL" FROM "PrintTemplate" WHERE "RegistrationID" = $1 AND "DocumentType" = $2`,
      [req.user.RegistrationID, documentType]
    );
    const previousUrl = existing.rows[0]?.LogoURL;

    const result = await pool.query(
      `UPDATE "PrintTemplate" SET "LogoURL" = NULL, "UpdatedAt" = now()
       WHERE "RegistrationID" = $1 AND "DocumentType" = $2
       RETURNING *`,
      [req.user.RegistrationID, documentType]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Print template not found." });
    }

    await tryDeleteObject(objectPathFromUrl(previousUrl, bucket.name));

    return res.json({ success: true, printTemplate: result.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error removing logo" });
  }
};
