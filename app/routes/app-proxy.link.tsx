import type { ActionFunctionArgs } from "react-router";
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
 * Submit endpoint for the theme app extension's B2B registration form. The
 * form posts same-origin through the app proxy, so Shopify signs the request
 * and adds `logged_in_customer_id` when the customer is signed in.
 */

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export const loader = async () => {
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
  try {
    ({ admin } = await authenticate.public.appProxy(request));
  } catch (error) {
    if (error instanceof Response) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Invalid app proxy request. Submit the form from your storefront so Shopify can sign the request.",
        },
        error.status,
      );
    }
    throw error;
  }

  const url = new URL(request.url);

  if (!admin) {
    console.error(
      `B2B registration: no offline session stored for ${url.searchParams.get("shop")}`,
    );
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

  const customerId = url.searchParams.get("logged_in_customer_id");

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
