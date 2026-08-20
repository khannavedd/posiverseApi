const crypto = require("crypto");
const pool = require("../DB/postgres");

const VALID_TYPES = ["sale", "purchase"];

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
