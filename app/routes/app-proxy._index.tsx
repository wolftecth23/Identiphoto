import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { renderB2bRegistrationPage } from "../services/b2b-registration-page.server";
import {
  getRegistrationCustomer,
  type RegistrationCustomer,
} from "../services/b2b-registration.server";

/**
 * Storefront path: /apps/b2b-register (see [app_proxy] in shopify.app.toml).
 *
 * Public B2B registration page, rendered inside the store theme. Guests get a
 * form that creates their customer account; signed-in customers (identified by
 * `logged_in_customer_id`) get a prefilled form, or their business account if
 * they already belong to a company. The form submits to /apps/b2b-register/link.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);

  const customerId = new URL(request.url).searchParams.get(
    "logged_in_customer_id",
  );

  let customer: RegistrationCustomer | null = null;
  if (customerId && admin) {
    try {
      customer = await getRegistrationCustomer(admin, customerId);
    } catch (error) {
      // Still show the form; the customer just won't see prefilled details.
      console.error("B2B registration page customer lookup failed", error);
    }
  }

  return liquid(
    renderB2bRegistrationPage({ signedIn: Boolean(customerId), customer }),
    { headers: { "Cache-Control": "private, no-store" } },
  );
};
