// Resolves which TransactionType a document is being created under.
//
// THIS IS A SECURITY BOUNDARY. Before DEC-027 the controllers looked up
// a hardcoded Code ('SALE' / 'PURCHASE'), so the client had no say and
// nothing could be forged. Now the client names a transactionTypeId,
// which means it must be proven to be:
//
//   1. THIS business's       — otherwise a caller can reference another
//                              tenant's type, and every document they
//                              create is filed under it. The FK only
//                              proves the row exists somewhere, not that
//                              it belongs to them. Same class of bug as
//                              the productId/taxId scoping already fixed
//                              in computeItems().
//   2. ACTIVE                — a deactivated type shouldn't accept new
//                              documents.
//   3. THE RIGHT MODULE      — otherwise a sale can be posted through
//                              /inventory (and vice versa), which would
//                              move stock the wrong way and land the row
//                              in the wrong table entirely.
//
// Omitting transactionTypeId falls back to `fallbackCode`, preserving
// the old behaviour exactly. That is what lets this ship before the app
// is updated: an older client sends nothing and still gets SALE or
// PURCHASE, a newer one names the type it means.
//
// Returns { transactionType } or { error, status }. Callers roll back
// their own transaction — this never throws for an expected failure.
async function resolveTransactionType(client, { registrationId, transactionTypeId, fallbackCode, module: expectedModule }) {
  if (transactionTypeId) {
    const result = await client.query(
      `SELECT * FROM "TransactionType"
       WHERE "TransactionTypeID" = $1 AND "RegistrationID" = $2 AND "IsActive" = true`,
      [transactionTypeId, registrationId]
    );

    // Deliberately the same message whether the type belongs to someone
    // else, is inactive, or doesn't exist. Distinguishing them tells a
    // caller whether an id they guessed is real, which is a slow
    // enumeration oracle across tenants.
    if (result.rows.length === 0) {
      return { error: "That transaction type isn't available", status: 400 };
    }

    const transactionType = result.rows[0];

    if (expectedModule && transactionType.Module !== expectedModule) {
      return {
        error: `"${transactionType.Name}" is a ${transactionType.Module} type and can't be used here`,
        status: 400,
      };
    }

    return { transactionType };
  }

  const fallback = await client.query(
    `SELECT * FROM "TransactionType"
     WHERE "RegistrationID" = $1 AND "Code" = $2 AND "IsActive" = true`,
    [registrationId, fallbackCode]
  );
  if (fallback.rows.length === 0) {
    return { error: `${fallbackCode} transaction type isn't set up for this business`, status: 400 };
  }
  return { transactionType: fallback.rows[0] };
}

// Enforces the type's own rules server-side. The app hides fields based
// on these same flags, but hiding a field is a convenience, not a
// guarantee — anything not checked here can be sent by any client.
//
// Only requirements are enforced. A flag being false means "don't ask
// for it", not "reject it if present": a business that turns off
// CalculateTax and then edits an old document that has tax on it should
// not be blocked from saving.
function assertTypeRules(transactionType, { vendorId, customerId }) {
  if (transactionType.VendorMandatory && !vendorId) {
    return { error: `${transactionType.Name} needs a vendor` };
  }
  if (transactionType.CustomerMandatory && !customerId) {
    return { error: `${transactionType.Name} needs a customer` };
  }
  return null;
}

module.exports = { resolveTransactionType, assertTypeRules };
