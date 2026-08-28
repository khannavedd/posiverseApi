// Publishing an event is NOT part of the transaction that produced it.
//
// Every write handler in this codebase COMMITs and then publishes to
// Pub/Sub so posiverse-engine can apply the downstream effects (InStock,
// Vendor.DueAmount, Customer.OutstandingBalance). Until now that publish
// sat inside the same `try` that guards the transaction, so a Pub/Sub
// outage was caught by the transaction's own `catch` — which ran
// ROLLBACK on an already-committed transaction and returned a 500.
//
// The result was the worst possible outcome: a real, committed sale with
// a consumed invoice number, reported to the cashier as a failure. The
// natural response is to ring it up again, producing a genuine duplicate
// — and the duplicate DOES deduct stock while the original never did.
//
// This helper makes that impossible to reintroduce. It swallows publish
// failures deliberately, because by the time it runs the write is
// already durable: the honest answer to the caller is "saved", not
// "failed". What is lost is the downstream sync, which is a smaller and
// different problem — so it returns false and logs loudly rather than
// pretending nothing happened.
//
// KNOWN GAP (deliberate, see DEC-019): a failed publish is not retried.
// The event is gone and that document's stock/balance effects never
// apply. Making delivery durable means reinstating a transactional
// outbox, which migration 018 explicitly removed — reversing that is an
// architecture decision for the owner, not something to slip in here.
// Until then this at least surfaces the failure instead of converting it
// into a duplicate sale.
async function publishAfterCommit(publishFn, context) {
  try {
    await publishFn();
    return true;
  } catch (error) {
    console.error(
      `PUBLISH FAILED after commit — ${context}. The record IS saved; its ` +
        `downstream stock/balance sync did NOT run and will not be retried.`,
      error
    );
    return false;
  }
}

module.exports = { publishAfterCommit };
