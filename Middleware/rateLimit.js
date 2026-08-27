// Middleware/rateLimit.js
//
// Basic brute-force/credential-stuffing protection for the public,
// no-auth-required endpoints (login, register) — every other route
// already requires a valid Bearer token, so those don't need this.
// Firebase's own signInWithPassword has some abuse protection at the
// project level, but that's a generic default, not tuned for this
// app, and register isn't covered by it at all.
//
// Keyed by IP (express-rate-limit's default). If this API ever sits
// behind a proxy/load balancer that doesn't forward the real client
// IP, `app.set("trust proxy", ...)` needs to be configured in
// index.js for this to key correctly — Cloud Run's front end does
// forward the real IP via X-Forwarded-For, so this works as-is there.
const rateLimit = require("express-rate-limit");

// 10 attempts per 15 minutes per IP — generous enough that a real user
// mistyping a password a few times never gets blocked, tight enough to
// make scripted guessing impractical.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts. Try again in a few minutes." },
});

// Registration doesn't need to be as tight (nobody "guesses" their way
// into creating an account), but an unthrottled public POST that
// creates a Firebase user + several DB rows per request is still worth
// capping against abuse/spam.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many signup attempts from this network. Try again later." },
});

module.exports = { loginLimiter, registerLimiter };
