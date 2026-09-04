const crypto = require("crypto");
const pool = require("../DB/postgres");
const { uploadImage, deleteImageByUrl } = require("../Utils/imageUpload");

// Catalogue, flat-Product model (migration 019/020, simplified by 021).
// One row per sellable thing, in the same "Product" table either way:
//   - "style" (anchor) row: ParentProductID IS NULL. Shared identity —
//     Name, category/brand, price block (CostPrice/SellingPrice/MRP
//     only — no margin/MSP/discount fields), and Attributes — the
//     style's attribute schema, e.g.
//     [{ name: "Size", values: ["S","M","L"] }, { name: "Colour", values: ["Red"] }].
//     An empty/absent Attributes list means this row IS also the one
//     sellable SKU (no children) — it gets its own SKU/Barcode.
//   - "variant" (child) row: ParentProductID = the anchor's ProductID.
//     VariantAttributes holds this SKU's specific values, e.g.
//     { "Size": "S", "Colour": "Red" }. VariantName/SKU/Barcode plus
//     its own CostPrice/SellingPrice/MRP price override.
//
// Every attribute is generic — no special-casing of "Size"/"Colour"
// names, no VariantMode enum. Whether a style has variants is derived
// purely from Attributes being a non-empty array.
//
// SKU/Barcode are independently generated per row — there's no shared
// StyleCode prefix anymore (migration 021 dropped it). Both are always
// optional for the person using the app: if left blank, one is
// auto-generated from the product name; a manually-typed value is used
// as-is once checked for uniqueness.
//
// No SizeSet/Colour/Attribute tables — attribute schemas and values are
// just JSON on Product itself.

function slugify(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 8);
}

function randomDigits(n) {
  let out = "";
  for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 10);
  return out;
}

// registrationId scopes the uniqueness check to this business only —
// SKU/Barcode have no DB-level UNIQUE constraint (see DECISIONS.md;
// adding one is a schema change, tracked separately), so this
// check-then-insert is the only thing enforcing it, and it used to
// check across EVERY business in the database. Two unrelated
// businesses couldn't both use "SHIRT-001" even though there's no real
// conflict between them.
async function generateBarcode(client, registrationId) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomDigits(12);
    const existing = await client.query(
      `SELECT 1 FROM "Product" WHERE "Barcode" = $1 AND "RegistrationID" = $2`,
      [code, registrationId]
    );
    if (existing.rows.length === 0) return code;
  }
  return randomDigits(12) + randomDigits(4);
}

async function generateSkuCode(client, namePrefix, suffix, registrationId) {
  const base = suffix ? `${namePrefix}-${slugify(suffix)}` : namePrefix;
  let code = base;
  let attempt = 0;
  while (attempt < 8) {
    const existing = await client.query(
      `SELECT 1 FROM "Product" WHERE "SKU" = $1 AND "RegistrationID" = $2`,
      [code, registrationId]
    );
    if (existing.rows.length === 0) return code;
    attempt += 1;
    code = `${base}-${randomDigits(2)}`;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}

function toNullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// Cleans up a client-supplied attribute list into
// [{ name, values: [non-empty trimmed strings] }, ...], dropping any
// attribute left with zero values (an attribute the owner defined but
// never gave a value to doesn't multiply into the cross-product —
// matches the reference screenshot's empty "colour" row).
function normalizeAttributes(attributes) {
  if (!Array.isArray(attributes)) return [];
  return attributes
    .map(a => ({
      name: String(a?.name || "").trim(),
      values: Array.isArray(a?.values) ? [...new Set(a.values.map(v => String(v).trim()).filter(Boolean))] : [],
    }))
    .filter(a => a.name && a.values.length > 0);
}

// Delta sync — returns every row (anchors AND their variant children)
// visible at this store; the mobile app groups children under their
// ParentProductID for the list view. Same visibility rule as before: a
// row is visible if it's a store-specific row for this store, or a
// shared row for the business.
// Turns a unique-index violation from migration 036 into the same
// friendly message the pre-INSERT check produces.
//
// That check (a SELECT before the INSERT) is a check-then-act race:
// two concurrent creates both see no conflict and both proceed. The
// index is what actually guarantees uniqueness, so this is the path
// that matters — the pre-check just produces a nicer message in the
// common, uncontended case.
//
// Returns null when the error isn't one of ours, so the caller falls
// through to its normal 500.
function duplicateFieldMessage(error) {
  if (error?.code !== "23505") return null;
  if (error.constraint === "idx_product_sku_unique") {
    return "That SKU is already used by another product.";
  }
  if (error.constraint === "idx_product_barcode_unique") {
    return "That barcode is already used by another product.";
  }
  return null;
}

module.exports.getProducts = async (req, res) => {
  try {
    const { storeId, updatedSince } = req.query;
console.log(storeId)
    if (!storeId) {
      return res.status(400).json({ success: false, message: "storeId is required" });
    }

    const params = [storeId, req.user.RegistrationID];
    // LEFT JOIN, not INNER — most rows won't have an InStock row yet
    // (it's only created once posiverse-engine reacts to a
    // PurchaseCreated event for that product at this store), and a
    // product with no purchases yet should still show up, just at 0.
    let query = `
      SELECT p.*, COALESCE(i."InStockQty", 0) AS "InStockQty"
      FROM "Product" p
      LEFT JOIN "InStock" i ON i."ProductID" = p."ProductID" AND i."StoreID" = $1
      WHERE p."IsActive" = true
        AND p."RegistrationID" = $2
        AND (p."StoreID" = $1 OR p."IsShared" = true)
    `;

    if (updatedSince) {
      params.push(updatedSince);
      query += ` AND p."UpdatedAt" > $${params.length}`;
    }

    query += ` ORDER BY p."UpdatedAt" ASC`;

    const result = await pool.query(query, params);

    return res.json({ success: true, products: result.rows, syncedAt: new Date().toISOString() });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching products" });
  }
};

// A style's detail + its variant children (empty array if the style has
// no Attributes, since the anchor row is the only SKU in that case).
// storeId (query param, optional) brings in each row's real InStockQty
// via the same LEFT JOIN getProducts already uses — omitted/unmatched
// rows just default to 0 via COALESCE, same as the list endpoint.
module.exports.getProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { storeId } = req.query;

    const result = await pool.query(
      `SELECT p.*, COALESCE(i."InStockQty", 0) AS "InStockQty"
       FROM "Product" p
       LEFT JOIN "InStock" i ON i."ProductID" = p."ProductID" AND i."StoreID" = $3
       WHERE p."RegistrationID" = $1 AND (p."ProductID" = $2 OR p."ParentProductID" = $2)
       ORDER BY p."CreatedAt" ASC`,
      [req.user.RegistrationID, id, storeId || null]
    );

    const product = result.rows.find(r => r.ProductID === id);
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    const variants = result.rows.filter(r => r.ParentProductID === id);

    return res.json({ success: true, product, variants });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error fetching product" });
  }
};

// Creates a style (anchor row) plus every variant (child row) its
// attribute cross-product describes, in one transaction.
//
// attributes: [{ name, values: [...] }, ...] — the style's attribute
// schema (e.g. Size: S/M/L, Colour: Red/Blue). Attributes with no
// values are ignored (don't multiply into variants).
//
// entries shape (only meaningful when there are attributes — a 'none'
// mode style needs no entries at all, it's created directly from
// sku/barcode/pricing on the request body):
//   [{ attributeValues: { <attrName>: <value>, ... }, sku?, costPrice?, sellingPrice?, mrp? }, ...]
//
// Per-entry pricing fields are all optional — anything omitted falls
// back to the style-level Basics price (Cost/Selling/MRP), which itself
// defaults to 0/null when left blank. autoGenerateSku (default true)
// controls whether a manually-typed `sku` on an entry is honored — if
// it's off but the SKU field was left blank, or if the typed SKU is
// already taken, this still falls back to auto-generating one rather
// than blocking the save. sku/barcode on the top-level request body
// work the same way for a 'none' mode style's own SKU/Barcode.
module.exports.createProduct = async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      id,
      storeId,
      isShared,
      name,
      sku,
      barcode,
      categoryId,
      brandId,
      productType,
      inventoryType,
      attributes,
      autoGenerateSku,
      costPrice,
      mrp,
      sellingPrice,
      taxId,
      taxInclusive,
      unit,
      entries,
    } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }

    // Cost/MRP/selling price are all optional at creation time — a
    // style can be catalogued before its pricing is finalized. Only
    // validate sellingPrice's shape when one was actually provided.
    let sellingPriceNum = 0;
    if (sellingPrice !== undefined && sellingPrice !== null && sellingPrice !== "") {
      sellingPriceNum = Number(sellingPrice);
      if (!Number.isFinite(sellingPriceNum) || sellingPriceNum < 0) {
        return res.status(400).json({ success: false, message: "sellingPrice must be a non-negative number" });
      }
    }

    const attrList = normalizeAttributes(attributes);
    const hasVariants = attrList.length > 0;
    const finalProductType = ["goods", "service"].includes(productType) ? productType : "goods";
    const finalInventoryType = ["fifo", "variant"].includes(inventoryType) ? inventoryType : (hasVariants ? "variant" : "fifo");
    const finalAutoGenerateSku = autoGenerateSku !== false;
    const entryList = Array.isArray(entries) ? entries : [];

    if (hasVariants && entryList.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Pick at least one attribute value for this product",
      });
    }

    await client.query("BEGIN");

    const anchorId = id || crypto.randomUUID();
    const registrationId = req.user.RegistrationID;
    const nameSlug = slugify(name) || "PRD";
    const costPriceNum = toNullableNumber(costPrice);
    const mrpNum = toNullableNumber(mrp);
    const attributesJson = attrList.length > 0 ? JSON.stringify(attrList) : null;

    // The anchor row IS the sellable SKU when there are no variants —
    // give it its own SKU/Barcode directly in that case. Both are
    // optional: a manually-typed value is honored (once checked for
    // uniqueness), otherwise one is auto-generated.
    let anchorSku = null;
    let anchorBarcode = null;
    if (!hasVariants) {
      if (sku && String(sku).trim()) {
        const manualSku = String(sku).trim();
        const dupe = await client.query(
          `SELECT 1 FROM "Product" WHERE "SKU" = $1 AND "RegistrationID" = $2`,
          [manualSku, registrationId]
        );
        anchorSku = dupe.rows.length === 0 ? manualSku : null;
      }
      if (!anchorSku) anchorSku = await generateSkuCode(client, nameSlug, null, registrationId);

      if (barcode && String(barcode).trim()) {
        const manualBarcode = String(barcode).trim();
        const dupeBarcode = await client.query(
          `SELECT 1 FROM "Product" WHERE "Barcode" = $1 AND "RegistrationID" = $2`,
          [manualBarcode, registrationId]
        );
        anchorBarcode = dupeBarcode.rows.length === 0 ? manualBarcode : null;
      }
      if (!anchorBarcode) anchorBarcode = await generateBarcode(client, registrationId);
    }

    const anchorResult = await client.query(
      `INSERT INTO "Product"
        ("ProductID", "RegistrationID", "StoreID", "IsShared", "ProductType", "ParentProductID",
         "InventoryType", "Attributes", "AutoGenerateSku", "SKU", "Barcode",
         "CategoryID", "BrandID",
         "Name", "Unit", "CostPrice", "SellingPrice", "MRP", "TaxID", "TaxInclusive", "IsActive")
       VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,true)
       RETURNING *`,
      [
        anchorId,
        registrationId,
        storeId ?? null,
        isShared ?? false,
        finalProductType,
        finalInventoryType,
        attributesJson,
        finalAutoGenerateSku,
        anchorSku,
        anchorBarcode,
        categoryId ?? null,
        brandId ?? null,
        name,
        unit ?? "pcs",
        costPriceNum,
        sellingPriceNum,
        mrpNum,
        taxId ?? null,
        !!taxInclusive,
      ]
    );

    const createdVariants = [];
    if (hasVariants) {
      for (const cell of entryList) {
        const attributeValues = cell.attributeValues && typeof cell.attributeValues === "object" ? cell.attributeValues : {};
        const variantName = Object.values(attributeValues).filter(Boolean).join(" / ") || null;
        const variantAttributesJson = Object.keys(attributeValues).length > 0 ? JSON.stringify(attributeValues) : null;

        const suffix = Object.values(attributeValues).filter(Boolean).join("-") || null;
        let skuCode = null;
        if (!finalAutoGenerateSku && cell.sku && String(cell.sku).trim()) {
          const manualSku = String(cell.sku).trim();
          const dupe = await client.query(
            `SELECT 1 FROM "Product" WHERE "SKU" = $1 AND "RegistrationID" = $2`,
            [manualSku, registrationId]
          );
          skuCode = dupe.rows.length === 0 ? manualSku : null;
        }
        if (!skuCode) skuCode = await generateSkuCode(client, nameSlug, suffix, registrationId);
        const variantBarcode = await generateBarcode(client, registrationId);

        const variantCostPrice = toNullableNumber(cell.costPrice) ?? costPriceNum;
        const variantSellingPrice = toNullableNumber(cell.sellingPrice) ?? sellingPriceNum;
        const variantMrp = toNullableNumber(cell.mrp) ?? mrpNum;

        const variantResult = await client.query(
          `INSERT INTO "Product"
            ("ProductID", "RegistrationID", "StoreID", "IsShared", "ProductType", "ParentProductID",
             "InventoryType", "VariantAttributes", "VariantName",
             "SKU", "Barcode",
             "CategoryID", "BrandID",
             "Name", "Unit", "CostPrice", "SellingPrice", "MRP", "TaxID", "TaxInclusive", "IsActive")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,true)
           RETURNING *`,
          [
            crypto.randomUUID(),
            registrationId,
            storeId ?? null,
            isShared ?? false,
            finalProductType,
            anchorId,
            finalInventoryType,
            variantAttributesJson,
            variantName,
            skuCode,
            variantBarcode,
            categoryId ?? null,
            brandId ?? null,
            `${name}${variantName ? ` - ${variantName}` : ""}`,
            unit ?? "pcs",
            variantCostPrice,
            variantSellingPrice,
            variantMrp,
            taxId ?? null,
            !!taxInclusive,
          ]
        );
        createdVariants.push(variantResult.rows[0]);
      }
    }

    await client.query("COMMIT");

    return res.json({ success: true, product: anchorResult.rows[0], variants: createdVariants });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    const duplicate = duplicateFieldMessage(error);
    if (duplicate) return res.status(400).json({ success: false, message: duplicate });

    return res.status(500).json({ success: false, message: "Error creating product" });
  } finally {
    client.release();
  }
};

// Edits a style's anchor row (Basics — including SKU/Barcode when the
// style has no variants — and existing variant rows' attribute
// values/SKU are never touched here) and, optionally, adds brand-new
// variant rows via `newEntries` — the one thing the locking rule still
// allows once a style has variants ("adding new attribute values ->
// allowed", renaming/removing existing ones is not). Any attribute
// value used in newEntries that the style's Attributes schema doesn't
// already know about gets merged in, so it shows as "already known"
// (locked) the next time this style is edited.
//
// newEntries shape matches createProduct's entries:
//   [{ attributeValues: { <attrName>: <value>, ... }, sku?, costPrice?, sellingPrice?, mrp? }, ...]
module.exports.updateProduct = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      name,
      sku,
      barcode,
      categoryId,
      brandId,
      productType,
      costPrice,
      mrp,
      sellingPrice,
      taxId,
      taxInclusive,
      isShared,
      newEntries,
    } = req.body;

    const existingResult = await client.query(
      `SELECT * FROM "Product" WHERE "ProductID" = $1 AND "RegistrationID" = $2`,
      [id, req.user.RegistrationID]
    );
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    const existing = existingResult.rows[0];

    if (sellingPrice !== undefined && sellingPrice !== null) {
      const sellingPriceNum = Number(sellingPrice);
      if (!Number.isFinite(sellingPriceNum) || sellingPriceNum < 0) {
        return res.status(400).json({ success: false, message: "sellingPrice must be a non-negative number" });
      }
    }

    // SKU/Barcode stay optional here too — only re-checked for
    // uniqueness when actually changed to a new, non-blank value.
    let finalSku = existing.SKU;
    if (sku !== undefined) {
      const trimmedSku = sku ? String(sku).trim() : null;
      if (trimmedSku && trimmedSku !== existing.SKU) {
        const dupe = await client.query(
          `SELECT 1 FROM "Product" WHERE "SKU" = $1 AND "ProductID" != $2 AND "RegistrationID" = $3`,
          [trimmedSku, id, req.user.RegistrationID]
        );
        if (dupe.rows.length > 0) {
          return res.status(400).json({ success: false, message: "That SKU is already used by another product." });
        }
      }
      finalSku = trimmedSku;
    }
    let finalBarcode = existing.Barcode;
    if (barcode !== undefined) {
      const trimmedBarcode = barcode ? String(barcode).trim() : null;
      if (trimmedBarcode && trimmedBarcode !== existing.Barcode) {
        const dupeBarcode = await client.query(
          `SELECT 1 FROM "Product" WHERE "Barcode" = $1 AND "ProductID" != $2 AND "RegistrationID" = $3`,
          [trimmedBarcode, id, req.user.RegistrationID]
        );
        if (dupeBarcode.rows.length > 0) {
          return res.status(400).json({ success: false, message: "That barcode is already used by another product." });
        }
      }
      finalBarcode = trimmedBarcode;
    }

    await client.query("BEGIN");

    const finalProductType = ["goods", "service"].includes(productType) ? productType : existing.ProductType;

    const finalTaxId = taxId ?? existing.TaxID;
    const finalTaxInclusive = taxInclusive !== undefined ? !!taxInclusive : existing.TaxInclusive;

    const result = await client.query(
      `UPDATE "Product" SET
        "Name" = COALESCE($1, "Name"),
        "SKU" = $2,
        "Barcode" = $3,
        "CategoryID" = $4,
        "BrandID" = $5,
        "ProductType" = $6,
        "CostPrice" = $7,
        "MRP" = $8,
        "SellingPrice" = COALESCE($9, "SellingPrice"),
        "TaxID" = $10,
        "TaxInclusive" = $11,
        "IsShared" = COALESCE($12, "IsShared"),
        "UpdatedAt" = now()
       WHERE "ProductID" = $13
       RETURNING *`,
      [
        name ?? null,
        finalSku,
        finalBarcode,
        categoryId ?? existing.CategoryID,
        brandId ?? existing.BrandID,
        finalProductType,
        toNullableNumber(costPrice) ?? existing.CostPrice,
        toNullableNumber(mrp) ?? existing.MRP,
        sellingPrice !== undefined && sellingPrice !== null ? Number(sellingPrice) : null,
        finalTaxId,
        finalTaxInclusive,
        isShared ?? null,
        id,
      ]
    );
    const updated = result.rows[0];

    // Tax is a style-wide setting (one Tax dropdown on the Basics form,
    // not a per-variant field) — createProduct already applies it to
    // every variant it creates at once. Existing variants, created
    // before this edit, were never touched by the UPDATE above (it only
    // targets this anchor row's own ProductID), so without this they'd
    // keep whatever TaxID/TaxInclusive they had at creation time —
    // which is exactly the bug where mapping a Tax onto an existing
    // variant product doesn't carry through to Purchase Entry, since
    // Purchase Entry always references a variant's own ProductID, not
    // the anchor's.
    if (finalTaxId !== existing.TaxID || finalTaxInclusive !== existing.TaxInclusive) {
      await client.query(
        `UPDATE "Product" SET "TaxID" = $1, "TaxInclusive" = $2, "UpdatedAt" = now()
         WHERE "ParentProductID" = $3 AND "IsActive" = true`,
        [finalTaxId, finalTaxInclusive, id]
      );
    }

    const addedVariants = [];
    let attributesChanged = false;
    const attrList = Array.isArray(updated.Attributes) ? updated.Attributes.map(a => ({ name: a.name, values: [...(a.values || [])] })) : [];
    const attrIndexByLowerName = {};
    attrList.forEach((a, idx) => { attrIndexByLowerName[a.name.toLowerCase()] = idx; });

    if (Array.isArray(newEntries) && newEntries.length > 0 && Array.isArray(updated.Attributes) && updated.Attributes.length > 0) {
      for (const cell of newEntries) {
        const attributeValues = cell.attributeValues && typeof cell.attributeValues === "object" ? cell.attributeValues : {};
        if (Object.keys(attributeValues).length === 0) continue;

        // Merge any not-yet-known attribute values into the style's
        // Attributes schema so they show as "already known" next time.
        Object.entries(attributeValues).forEach(([attrName, value]) => {
          if (!value) return;
          const key = attrName.toLowerCase();
          let idx = attrIndexByLowerName[key];
          if (idx === undefined) {
            attrList.push({ name: attrName, values: [value] });
            attrIndexByLowerName[key] = attrList.length - 1;
            attributesChanged = true;
          } else if (!attrList[idx].values.includes(value)) {
            attrList[idx].values.push(value);
            attributesChanged = true;
          }
        });

        const variantAttributesJson = JSON.stringify(attributeValues);

        // Dupe check is pure jsonb equality now — legacy rows created
        // before migration 020 (VariantAttributes NULL, only
        // SizeLabel/ColourName populated) are no longer matched here,
        // so a newEntries cell that duplicates one of those old rows'
        // attribute values won't be caught. See DECISIONS.md.
        const dupe = await client.query(
          `SELECT 1 FROM "Product" WHERE "ParentProductID" = $1 AND "IsActive" = true AND "VariantAttributes" = $2::jsonb`,
          [id, variantAttributesJson]
        );
        if (dupe.rows.length > 0) continue;

        const suffix = Object.values(attributeValues).filter(Boolean).join("-") || null;
        let skuCode = null;
        if (updated.AutoGenerateSku === false && cell.sku && String(cell.sku).trim()) {
          const manualSku = String(cell.sku).trim();
          const skuDupe = await client.query(
            `SELECT 1 FROM "Product" WHERE "SKU" = $1 AND "RegistrationID" = $2`,
            [manualSku, req.user.RegistrationID]
          );
          skuCode = skuDupe.rows.length === 0 ? manualSku : null;
        }
        if (!skuCode) skuCode = await generateSkuCode(client, slugify(updated.Name) || "PRD", suffix, req.user.RegistrationID);
        const variantBarcode = await generateBarcode(client, req.user.RegistrationID);
        const variantName = Object.values(attributeValues).filter(Boolean).join(" / ") || null;

        const variantCostPrice = toNullableNumber(cell.costPrice) ?? updated.CostPrice;
        const variantSellingPrice = toNullableNumber(cell.sellingPrice) ?? updated.SellingPrice;
        const variantMrp = toNullableNumber(cell.mrp) ?? updated.MRP;

        const variantResult = await client.query(
          `INSERT INTO "Product"
            ("ProductID", "RegistrationID", "StoreID", "IsShared", "ProductType", "ParentProductID",
             "InventoryType", "VariantAttributes", "VariantName",
             "SKU", "Barcode",
             "CategoryID", "BrandID",
             "Name", "Unit", "CostPrice", "SellingPrice", "MRP", "TaxID", "TaxInclusive", "IsActive")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,true)
           RETURNING *`,
          [
            crypto.randomUUID(),
            req.user.RegistrationID,
            updated.StoreID,
            updated.IsShared,
            updated.ProductType,
            id,
            updated.InventoryType,
            variantAttributesJson,
            variantName,
            skuCode,
            variantBarcode,
            updated.CategoryID,
            updated.BrandID,
            `${updated.Name}${variantName ? ` - ${variantName}` : ""}`,
            updated.Unit,
            variantCostPrice,
            variantSellingPrice,
            variantMrp,
            updated.TaxID,
            updated.TaxInclusive,
          ]
        );
        addedVariants.push(variantResult.rows[0]);
      }

      if (attributesChanged) {
        await client.query(`UPDATE "Product" SET "Attributes" = $1::jsonb WHERE "ProductID" = $2`, [JSON.stringify(attrList), id]);
        updated.Attributes = attrList;
      }
    }

    await client.query("COMMIT");

    return res.json({ success: true, product: updated, addedVariants });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    const duplicate = duplicateFieldMessage(error);
    if (duplicate) return res.status(400).json({ success: false, message: duplicate });

    return res.status(500).json({ success: false, message: "Error updating product" });
  } finally {
    client.release();
  }
};

// Soft delete — deactivating a style (anchor) row also deactivates its
// variant children, so nothing orphaned stays visible in the catalogue.
// Deleting a single variant row directly just deactivates that row.
module.exports.deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE "Product" SET "IsActive" = false, "UpdatedAt" = now()
       WHERE "ProductID" = $1 AND "RegistrationID" = $2
       RETURNING "ProductID"`,
      [id, req.user.RegistrationID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    await pool.query(
      `UPDATE "Product" SET "IsActive" = false, "UpdatedAt" = now()
       WHERE "ParentProductID" = $1 AND "RegistrationID" = $2`,
      [id, req.user.RegistrationID]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error deleting product" });
  }
};

// ---------------------------------------------------------------------
// Product image
//
// Ownership is verified against RegistrationID BEFORE anything is
// written to the bucket, so a crafted id cannot make this app store a
// file on another business's behalf.
// ---------------------------------------------------------------------
module.exports.uploadProductImage = async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No image file uploaded (expected field name 'image')." });
    }

    const existing = await pool.query(
      `SELECT "ImageURL" FROM "Product" WHERE "ProductID" = $1 AND "RegistrationID" = $2`,
      [id, req.user.RegistrationID]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const imageUrl = await uploadImage({
      file: req.file,
      prefix: "products",
      registrationId: req.user.RegistrationID,
      ownerId: id,
    });

    await pool.query(
      `UPDATE "Product" SET "ImageURL" = $1 WHERE "ProductID" = $2 AND "RegistrationID" = $3`,
      [imageUrl, id, req.user.RegistrationID]
    );

    // After the row points at the new image, never before — if this
    // throws, the worst case is an orphaned object, not a row pointing
    // at a file that no longer exists.
    await deleteImageByUrl(existing.rows[0].ImageURL);

    return res.json({ success: true, imageUrl });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Couldn't upload the image" });
  }
};

module.exports.removeProductImage = async (req, res) => {
  try {
    const { id } = req.params;
    // Read then update, deliberately NOT a RETURNING subquery: a
    // subquery in RETURNING re-reads the table under the statement's
    // own snapshot, so whether it yields the old or new value is
    // fragile. Two plain statements say exactly what they mean.
    const existing = await pool.query(
      `SELECT "ImageURL" FROM "Product" WHERE "ProductID" = $1 AND "RegistrationID" = $2`,
      [id, req.user.RegistrationID]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    await pool.query(
      `UPDATE "Product" SET "ImageURL" = NULL WHERE "ProductID" = $1 AND "RegistrationID" = $2`,
      [id, req.user.RegistrationID]
    );
    await deleteImageByUrl(existing.rows[0].ImageURL);
    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Couldn't remove the image" });
  }
};
