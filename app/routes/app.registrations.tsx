import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  approveRegistration,
  listPendingRegistrations,
  rejectRegistration,
  type PendingRegistration,
} from "../services/b2b-approval.server";

/**
 * Registrations waiting for staff approval. Approving lets the contact order
 * for their company; rejecting takes them off the company.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  return { registrations: await listPendingRegistrations(admin) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const customerId = String(form.get("customerId") ?? "");
  const intent = form.get("intent");
  if (!customerId.startsWith("gid://shopify/Customer/")) {
    return { ok: false as const, error: "Unknown customer." };
  }

  if (intent === "approve") {
    const approvedBy = String(form.get("approvedBy") ?? "").trim();
    if (!approvedBy) {
      return { ok: false as const, error: "Enter your name in “Approved by” first." };
    }
    return {
      ...(await approveRegistration(admin, customerId, approvedBy)),
      intent: "approve" as const,
    };
  }
  if (intent === "reject") {
    return {
      ...(await rejectRegistration(admin, customerId)),
      intent: "reject" as const,
    };
  }
  return { ok: false as const, error: "Unknown action." };
};

const APPROVED_BY_KEY = "b2b-approved-by";

function numericId(gid: string) {
  return gid.split("/").pop() ?? "";
}

function RegistrationRow({
  registration,
  approvedBy,
}: {
  registration: PendingRegistration;
  approvedBy: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle") return;
    if (result.ok) {
      shopify.toast.show(
        "intent" in result && result.intent === "reject"
          ? "Registration rejected"
          : "Registration approved",
      );
    } else {
      shopify.toast.show(result.error, { isError: true, duration: 8000 });
    }
  }, [fetcher.data, fetcher.state, shopify]);

  const submit = (intent: "approve" | "reject") => {
    if (
      intent === "reject" &&
      !window.confirm(
        `Reject ${registration.name}? They will be removed from the company.`,
      )
    ) {
      return;
    }
    fetcher.submit(
      { intent, customerId: registration.customerId, approvedBy },
      { method: "POST" },
    );
  };

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="block" gap="small-300">
          <s-link href={`shopify://admin/customers/${numericId(registration.customerId)}`}>
            {registration.name}
          </s-link>
          <s-text color="subdued">{registration.email}</s-text>
          {registration.note ? (
            <s-text color="subdued">{registration.note}</s-text>
          ) : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="block" gap="small-300">
          {registration.companies.map((company) => (
            <s-stack key={company.id} direction="block" gap="small-300">
              <s-stack direction="inline" gap="small-200">
                <s-link href={`shopify://admin/companies/${numericId(company.id)}`}>
                  {company.name}
                </s-link>
                <s-badge tone={company.contactCount > 1 ? "info" : "warning"}>
                  {company.contactCount > 1 ? "Joining existing" : "New company"}
                </s-badge>
              </s-stack>
              {company.address ? (
                <s-text color="subdued">{company.address}</s-text>
              ) : null}
              {company.phone ? (
                <s-text color="subdued">{company.phone}</s-text>
              ) : null}
            </s-stack>
          ))}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        {new Date(registration.registeredAt).toLocaleDateString()}
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small-200">
          <s-button
            variant="primary"
            disabled={busy || !approvedBy.trim()}
            onClick={() => submit("approve")}
          >
            Approve
          </s-button>
          <s-button
            tone="critical"
            disabled={busy}
            onClick={() => submit("reject")}
          >
            Reject
          </s-button>
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

export default function Registrations() {
  const { registrations } = useLoaderData<typeof loader>();
  const [approvedBy, setApprovedBy] = useState("");

  // Remembered in this browser so staff don't retype their name each time.
  useEffect(() => {
    try {
      setApprovedBy(window.localStorage.getItem(APPROVED_BY_KEY) ?? "");
    } catch {
      // Storage can be blocked; the field just starts empty.
    }
  }, []);

  const changeApprovedBy = (value: string) => {
    setApprovedBy(value);
    try {
      window.localStorage.setItem(APPROVED_BY_KEY, value);
    } catch {
      // Not remembered; nothing else depends on it.
    }
  };

  return (
    <s-page heading="B2B registrations">
      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>
            New B2B registrations wait here until you approve them. Until then
            the customer is listed on the company but can&rsquo;t place orders
            for it. Approving gives them the company&rsquo;s ordering role, sets
            the company&rsquo;s “B2B account status”, “Approved by” and
            “Approved on” fields, and emails the customer.
          </s-paragraph>
          <s-text-field
            label="Approved by"
            details="Saved to the company's “Approved by” field."
            value={approvedBy}
            onInput={(event) =>
              changeApprovedBy(event.currentTarget.value)
            }
          />
        </s-stack>
      </s-section>

      <s-section padding="none" accessibilityLabel="Pending registrations">
        {registrations.length ? (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Customer</s-table-header>
              <s-table-header>Company</s-table-header>
              <s-table-header>Registered</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {registrations.map((registration) => (
                <RegistrationRow
                  key={registration.customerId}
                  registration={registration}
                  approvedBy={approvedBy}
                />
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-box padding="base">
            <s-paragraph>No registrations are waiting for approval.</s-paragraph>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
