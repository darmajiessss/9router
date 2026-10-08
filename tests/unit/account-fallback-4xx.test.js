// Regression: an unmatched 4xx (a request-scoped failure) used to hit the
// transient-cooldown default, which locked the account for 30s and — with a
// single connection — answered every other request in that window with a copy of
// the first error. A 400 "maximum context length" from one session therefore
// looked like the same failure in unrelated sessions.
import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("checkFallbackError — request-scoped vs account-scoped failures", () => {
  it("does not cool the account down for a 400 caused by the request", () => {
    const result = checkFallbackError(400, JSON.stringify({
      error: {
        message: "This model's maximum context length is 1048576 tokens. However, you requested 1186139 tokens",
        type: "invalid_request_error",
      },
    }));

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });

  it("still falls back for account-scoped statuses", () => {
    for (const status of [401, 402, 403, 404, 410, 429]) {
      expect(checkFallbackError(status, "nope").shouldFallback).toBe(true);
    }
  });

  it("still honours rate-limit / quota wording on any 4xx", () => {
    expect(checkFallbackError(400, "rate limit reached").shouldFallback).toBe(true);
    expect(checkFallbackError(422, "quota exceeded").shouldFallback).toBe(true);
  });

  it("keeps the transient cooldown for unmatched server errors", () => {
    const result = checkFallbackError(503, "upstream exploded");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it("falls back with a long rest for retired models (410 Gone / end of life)", () => {
    const eolBody = JSON.stringify({
      type: "about:blank",
      title: "Gone",
      status: 410,
      detail: "The model 'minimaxai/minimax-m3' has reached its end of life on 2026-09-09T09:00:00Z and is no longer available.",
    });

    // exact 410 body from nvidia upstream
    const byStatus = checkFallbackError(410, eolBody);
    expect(byStatus.shouldFallback).toBe(true);
    expect(byStatus.cooldownMs).toBe(30 * 24 * 60 * 60 * 1000);

    // EOL wording alone also rests, whatever the status
    const byText = checkFallbackError(400, "model has reached its end of life");
    expect(byText.shouldFallback).toBe(true);
    expect(byText.cooldownMs).toBe(30 * 24 * 60 * 60 * 1000);

    // bare 410 without EOL wording still falls back (status rule)
    const bare = checkFallbackError(410, "gone");
    expect(bare.shouldFallback).toBe(true);
    expect(bare.cooldownMs).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
