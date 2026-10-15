import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  turnstileConfigFromEnv,
  verifyTurnstile,
  type TurnstileConfig,
} from "./b2b-turnstile.server";

const config: TurnstileConfig = { siteKey: "site-1", secretKey: "secret-1" };

/** Fake fetch answering Cloudflare's siteverify endpoint. */
function fakeCloudflare(answer: { status?: number; body?: unknown; fail?: boolean }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (answer.fail) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("Cloudflare Turnstile (client issue #4)", () => {
  test("keys come from the environment; both are needed", () => {
    assert.equal(turnstileConfigFromEnv({}), null);
    assert.deepEqual(
      turnstileConfigFromEnv({ TURNSTILE_SITE_KEY: "s", TURNSTILE_SECRET_KEY: "k" }),
      { siteKey: "s", secretKey: "k" },
    );
    // A secret alone would reject everyone, so it counts as off.
    assert.equal(turnstileConfigFromEnv({ TURNSTILE_SECRET_KEY: "k" }), null);
    assert.equal(turnstileConfigFromEnv({ TURNSTILE_SITE_KEY: "s" }), null);
  });

  test("a valid token passes; the secret and token go to siteverify", async () => {
    const { calls, fetchImpl } = fakeCloudflare({
      body: { success: true, action: "b2b-register", "error-codes": [] },
    });
    assert.deepEqual(await verifyTurnstile(config, "token-1", fetchImpl), { ok: true });

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    const form = new URLSearchParams(String(calls[0].init.body));
    assert.equal(form.get("secret"), "secret-1");
    assert.equal(form.get("response"), "token-1");
  });

  test("an invalid or reused token is refused", async () => {
    const { fetchImpl } = fakeCloudflare({
      body: { success: false, "error-codes": ["timeout-or-duplicate"] },
    });
    assert.deepEqual(await verifyTurnstile(config, "token-1", fetchImpl), {
      ok: false,
      errorCodes: ["timeout-or-duplicate"],
    });
  });

  test("a missing token is refused without asking Cloudflare", async () => {
    const { calls, fetchImpl } = fakeCloudflare({ body: { success: true } });
    assert.deepEqual(await verifyTurnstile(config, "", fetchImpl), {
      ok: false,
      errorCodes: ["missing-input-response"],
    });
    assert.equal(calls.length, 0);
  });

  test("a token made for another form's action is refused", async () => {
    const { fetchImpl } = fakeCloudflare({
      body: { success: true, action: "newsletter" },
    });
    assert.deepEqual(await verifyTurnstile(config, "token-1", fetchImpl), {
      ok: false,
      errorCodes: ["action-mismatch"],
    });
  });

  test("Cloudflare down -> the registration goes ahead", async () => {
    const offline = fakeCloudflare({ fail: true });
    assert.deepEqual(await verifyTurnstile(config, "token-1", offline.fetchImpl), {
      ok: true,
    });

    const erroring = fakeCloudflare({ status: 503 });
    assert.deepEqual(await verifyTurnstile(config, "token-1", erroring.fetchImpl), {
      ok: true,
    });
  });
});
