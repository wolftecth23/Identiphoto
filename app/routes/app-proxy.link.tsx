import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  parseB2bRegistrationPayload,
  ProtectedCustomerDataAccessError,
  protectedCustomerDataHelpMessage,
  registerB2bCustomer,
} from "../services/b2b-registration.server";

/**
 * Storefront path: /apps/b2b-register/link (see [app_proxy] in shopify.app.toml).
 *
 * Called from two places:
 * - The customer account UI extension. It runs in a web worker with a null
 *   origin, so every response needs CORS headers, and Shopify does not set
 *   `logged_in_customer_id` — the customer comes from the session token in the
 *   body instead. The extension sends `Content-Type: text/plain` and no custom
 *   headers so the browser skips the CORS preflight.
 * - A theme/storefront form, which relies on `logged_in_customer_id`.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "7200",
};

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function hostname(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(value.startsWith("http") ? value : `https://${value}`)
      .hostname;
  } catch {
    return null;
  }
}

/**
 * Verifies a customer account session token (signature + expiry) and returns
 * its claims, or null when it is invalid.
 */
async function verifyCustomerAccountToken(request: Request, token: string) {
  try {
    const { sessionToken } = await authenticate.public.customerAccount(
      new Request(request.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    return sessionToken;
  } catch {
    return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  return jsonResponse(
    { ok: false, error: "Use POST to submit B2B registration." },
    405,
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  let admin;
  let shop: string | undefined;
  try {
    const context = await authenticate.public.appProxy(request);
    admin = context.admin;
    shop = context.session?.shop;
  } catch (error) {
    if (error instanceof Response) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Invalid app proxy request. Submit the form from your storefront or customer account so Shopify can sign the request.",
        },
        error.status,
      );
    }
    throw error;
  }

  if (!admin) {
    return jsonResponse(
      {
        ok: false,
        error: "Install this app on the store to complete B2B registration.",
      },
      401,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body." }, 400);
  }

  let customerId = new URL(request.url).searchParams.get(
    "logged_in_customer_id",
  );

  const rawToken =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).sessionToken
      : undefined;

  if (typeof rawToken === "string" && rawToken) {
    const sessionToken = await verifyCustomerAccountToken(request, rawToken);
    if (!sessionToken || hostname(sessionToken.dest) !== shop) {
      return jsonResponse(
        {
          ok: false,
          error: "Your session has expired. Refresh the page and try again.",
        },
        401,
      );
    }

    customerId = sessionToken.sub?.match(/Customer\/(\d+)/)?.[1] ?? null;
    if (!customerId) {
      return jsonResponse(
        {
          ok: false,
          error: "Sign in to your customer account before submitting.",
        },
        401,
      );
    }
  }

  const payload = parseB2bRegistrationPayload(body);
  if (!payload) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Missing required fields: companyName, address1, city, countryCode, zip.",
      },
      400,
    );
  }

  try {
    const result = await registerB2bCustomer(admin, customerId, payload);

    if (!result.ok) {
      return jsonResponse(result, 422);
    }

    return jsonResponse(result);
  } catch (error) {
    console.error("B2B registration failed", error);
    if (error instanceof ProtectedCustomerDataAccessError) {
      return jsonResponse(
        {
          ok: false,
          code: "PROTECTED_CUSTOMER_DATA_REQUIRED",
          error: protectedCustomerDataHelpMessage(),
          helpUrl: "https://shopify.dev/docs/apps/launch/protected-customer-data",
        },
        403,
      );
    }
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected error during registration.";
    return jsonResponse({ ok: false, error: message }, 500);
  }
};
