import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { getProvincesForCountry } from "../services/b2b-localization.server";
import {
  ProtectedCustomerDataAccessError,
  parseB2bRegistrationPayload,
  protectedCustomerDataHelpMessage,
  registerB2bCustomer,
} from "../services/b2b-registration.server";

function jsonBody(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function shopHostnameFromDest(dest: unknown): string | null {
  if (typeof dest !== "string" || !dest.trim()) return null;
  try {
    const url = dest.startsWith("http") ? dest : `https://${dest}`;
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function customerIdFromSessionSub(sub: unknown): string | null {
  if (typeof sub !== "string") return null;
  const match = sub.match(/Customer\/(\d+)/);
  return match?.[1] ?? null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    const { cors } = await authenticate.public.customerAccount(request);
    return cors(new Response(null, { status: 204 }));
  }

  if (request.method !== "GET") {
    return jsonBody({ ok: false, error: "Use POST to submit registration." }, 405);
  }

  const { sessionToken, cors } = await authenticate.public.customerAccount(
    request,
  );

  const shop = shopHostnameFromDest(sessionToken.dest);
  if (!shop) {
    return cors(
      jsonBody({ ok: false, error: "Invalid session token shop." }, 401),
    );
  }

  const countryCode = new URL(request.url).searchParams
    .get("countryCode")
    ?.trim();
  if (!countryCode) {
    return cors(
      jsonBody(
        {
          ok: false,
          error: "Pass countryCode query parameter to load states/provinces.",
        },
        400,
      ),
    );
  }

  let session;
  try {
    ({ session } = await unauthenticated.admin(shop));
  } catch {
    return cors(
      jsonBody(
        {
          ok: false,
          error: "Install this app on the store to load address regions.",
        },
        401,
      ),
    );
  }

  try {
    const provinces = await getProvincesForCountry(session, countryCode);
    return cors(jsonBody({ ok: true, provinces }));
  } catch (error) {
    console.error("B2B localization lookup failed", error);
    const message =
      error instanceof Error ? error.message : "Could not load regions.";
    return cors(jsonBody({ ok: false, error: message }, 500));
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(
    request,
  );

  const shop = shopHostnameFromDest(sessionToken.dest);
  if (!shop) {
    return cors(
      jsonBody({ ok: false, error: "Invalid session token shop." }, 401),
    );
  }

  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch {
    return cors(
      jsonBody(
        {
          ok: false,
          error: "Install this app on the store to complete registration.",
        },
        401,
      ),
    );
  }

  const customerId = customerIdFromSessionSub(sessionToken.sub);
  if (!customerId) {
    return cors(
      jsonBody(
        {
          ok: false,
          error: "Sign in to your customer account before submitting.",
        },
        401,
      ),
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return cors(jsonBody({ ok: false, error: "Invalid JSON body." }, 400));
  }

  const payload = parseB2bRegistrationPayload(body);
  if (!payload) {
    return cors(
      jsonBody(
        {
          ok: false,
          error:
            "Missing required fields: companyName, address1, city, countryCode, zip.",
        },
        400,
      ),
    );
  }

  try {
    const result = await registerB2bCustomer(admin, customerId, payload);

    if (!result.ok) {
      return cors(jsonBody(result, 422));
    }

    return cors(jsonBody(result));
  } catch (error) {
    console.error("B2B registration (customer account) failed", error);
    if (error instanceof ProtectedCustomerDataAccessError) {
      return cors(
        jsonBody(
          {
            ok: false,
            code: "PROTECTED_CUSTOMER_DATA_REQUIRED",
            error: protectedCustomerDataHelpMessage(),
            helpUrl:
              "https://shopify.dev/docs/apps/launch/protected-customer-data",
          },
          403,
        ),
      );
    }
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected error during registration.";
    return cors(jsonBody({ ok: false, error: message }, 500));
  }
};
