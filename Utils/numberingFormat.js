// Builds a TransactionNo from a TransactionType's NumberingFormat jsonb
// (an ordered array of segments: { Option, Separator, Value }) plus the
// per-transaction context (store code, cash register code, running
// number). Shared by every controller that posts a transaction
// (Purchase today, Sale/Inventory once they exist) so the format a
// business configures in Module Configuration actually takes effect
// everywhere, not just in one place.
//
// Segment shape:
//   Option:    "FIXED" | "STORE_CODE" | "CASH_REGISTER_CODE" | "RUNNING_NUMBER"
//   Value:     for FIXED, the literal text; for RUNNING_NUMBER, the zero-pad
//              width (defaults to 6); unused otherwise.
//   Separator: appended immediately after this segment's own text (e.g. "-", "/").
//
// An empty/missing NumberingFormat falls back to a simple
// "<CODE>-000001" shape so a business that hasn't configured anything
// yet still gets a sane, unique-looking number.
//
// The running number is guaranteed to appear even if nobody explicitly
// added a RUNNING_NUMBER segment while configuring the format (e.g.
// "PE/01/01/" with no fourth segment) — without it every transaction
// would render the exact same string, which defeats the entire point
// of a numbering format. If the configured segments already include
// one, it's used as-is (so custom padding/position still works); if
// not, one is appended at the end automatically.
function formatTransactionNumber(numberingFormat, { code, storeCode, cashRegisterCode, runningNumber }) {
  const segments = Array.isArray(numberingFormat) ? numberingFormat : [];

  // Nobody has configured anything at all — use the pretty fallback,
  // not the auto-appended-segment path below (which would otherwise
  // never be reachable, since appending a segment always makes the
  // array non-empty).
  if (segments.length === 0) {
    return `${code || "TXN"}-${String(runningNumber).padStart(6, "0")}`;
  }

  const hasRunningNumber = segments.some(s => s?.Option === "RUNNING_NUMBER");
  const effectiveSegments = hasRunningNumber ? segments : [...segments, { Option: "RUNNING_NUMBER", Value: "", Separator: "" }];

  return effectiveSegments
    .map(segment => {
      const separator = segment?.Separator || "";
      let piece = "";
      switch (segment?.Option) {
        case "STORE_CODE":
          piece = storeCode || "";
          break;
        case "CASH_REGISTER_CODE":
          piece = cashRegisterCode || "";
          break;
        case "RUNNING_NUMBER": {
          const padWidth = Number(segment?.Value) || 6;
          piece = String(runningNumber).padStart(padWidth, "0");
          break;
        }
        case "FIXED":
        default:
          piece = segment?.Value || "";
          break;
      }
      return piece + separator;
    })
    .join("");
}

module.exports = { formatTransactionNumber };
