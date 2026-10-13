import { useEffect, useRef, useState } from "react";
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
  listRecentDecisions,
  rejectRegistration,
  type Registration,
} from "../services/b2b-approval.server";

/**
 * The app's home page: B2B registrations waiting for staff approval, and the
 * latest decisions. Approving lets the contact order for their company;
 * rejecting takes them off the company.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const [pending, recent] = await Promise.all([
    listPendingRegistrations(admin),
    listRecentDecisions(admin),
  ]);
  return { pending, recent };
};

type ActionResult =
  | { ok: true; intent: "approve" | "reject"; emailSent?: boolean }
  | { ok: false; error: string };

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const customerId = String(form.get("customerId") ?? "");
  const intent = form.get("intent");
  if (!customerId.startsWith("gid://shopify/Customer/")) {
    return { ok: false, error: "Unknown customer." };
  }

  if (intent === "approve") {
    const approvedBy = String(form.get("approvedBy") ?? "").trim();
    if (!approvedBy) {
      return { ok: false, error: "Enter your name in “Approved by” first." };
    }
    const result = await approveRegistration(admin, customerId, approvedBy);
    return result.ok
      ? { ok: true, intent: "approve", emailSent: result.emailSent }
      : result;
  }
  if (intent === "reject") {
    const result = await rejectRegistration(admin, customerId);
    return result.ok ? { ok: true, intent: "reject" } : result;
  }
  return { ok: false, error: "Unknown action." };
};

const APPROVED_BY_KEY = "b2b-approved-by";

function numericId(gid: string) {
  return gid.split("/").pop() ?? "";
}

/** Fixed format and time zone, so the server and browser render the same text. */
const dateFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

function formatDate(iso: string) {
  return dateFormat.format(new Date(iso));
}

/** "New company" when the registrant created it, else "Joining existing company". */
function requestType(registration: Registration) {
  const joining = registration.companies.some((company) => company.contactCount > 1);
  return joining
    ? { label: "Joining existing company", tone: "info" as const }
    : { label: "New company", tone: "warning" as const };
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <s-stack direction="inline" gap="small-200">
      <s-text type="strong">{label}:</s-text>
      <s-text>{children}</s-text>
    </s-stack>
  );
}

function PendingCard({
  registration,
  approvedBy,
  onMissingName,
  onReviewed,
}: {
  registration: Registration;
  approvedBy: string;
  onMissingName: () => void;
  onReviewed: (registration: Registration, status: "approved" | "rejected") => void;
}) {
  const fetcher = useFetcher<ActionResult>({ key: registration.customerId });
  const shopify = useAppBridge();
  const [confirmingReject, setConfirmingReject] = useState(false);
  const submitting = fetcher.state !== "idle";
  const submittingIntent = submitting ? fetcher.formData?.get("intent") : null;
  const result = fetcher.state === "idle" ? fetcher.data : undefined;

  useEffect(() => {
    if (!result) return;
    if (result.ok) {
      shopify.toast.show(
        result.intent === "approve"
          ? `${registration.name} approved${result.emailSent ? " and emailed" : ""}`
          : `${registration.name} rejected`,
      );
      onReviewed(registration, result.intent === "approve" ? "approved" : "rejected");
    } else {
      shopify.toast.show("Could not complete the action", { isError: true });
    }
    // Only react to a new result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const send = (intent: "approve" | "reject") => {
    if (intent === "approve" && !approvedBy.trim()) {
      onMissingName();
      return;
    }
    setConfirmingReject(false);
    fetcher.submit(
      { intent, customerId: registration.customerId, approvedBy },
      { method: "POST" },
    );
  };

  const type = requestType(registration);

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-heading>{registration.name}</s-heading>
          <s-badge tone={type.tone}>{type.label}</s-badge>
        </s-stack>

        <s-stack direction="block" gap="small-200">
          <Detail label="Email">{registration.email}</Detail>
          {registration.companies.map((company) => (
            <s-stack key={company.id} direction="block" gap="small-200">
              <s-stack direction="inline" gap="small-200">
                <s-text type="strong">Company:</s-text>
                <s-link href={`shopify://admin/companies/${numericId(company.id)}`}>
                  {company.name}
                </s-link>
                {company.contactCount > 1 ? (
                  <s-text color="subdued">
                    ({company.contactCount - 1} other contact
                    {company.contactCount > 2 ? "s" : ""})
                  </s-text>
                ) : null}
              </s-stack>
              {company.address ? <Detail label="Address">{company.address}</Detail> : null}
              {company.phone ? <Detail label="Phone">{company.phone}</Detail> : null}
            </s-stack>
          ))}
          {registration.note ? <Detail label="Note">{registration.note}</Detail> : null}
          <Detail label="Registered">{formatDate(registration.registeredAt)}</Detail>
          <s-link href={`shopify://admin/customers/${numericId(registration.customerId)}`}>
            Open customer in Shopify
          </s-link>
        </s-stack>

        {result && !result.ok ? (
          <s-banner tone="critical" heading="Could not complete the action">
            {result.error}
          </s-banner>
        ) : null}

        {confirmingReject ? (
          <s-banner tone="warning" heading={`Reject ${registration.name}?`}>
            <s-stack direction="block" gap="base">
              <s-paragraph>
                They&rsquo;ll be removed from the company and won&rsquo;t be able to
                order for it. Their customer account stays, and no email is sent.
              </s-paragraph>
              <s-stack direction="inline" gap="small-200">
                <s-button
                  tone="critical"
                  variant="primary"
                  onClick={() => send("reject")}
                >
                  Yes, reject
                </s-button>
                <s-button onClick={() => setConfirmingReject(false)}>Cancel</s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        ) : (
          <s-stack direction="inline" gap="small-200">
            {/* React 18 writes `disabled={false}` as disabled="false", which
                still disables a web component, so these are only spread in. */}
            <s-button
              variant="primary"
              onClick={() => send("approve")}
              {...(submittingIntent === "approve" ? { loading: true } : {})}
              {...(submitting ? { disabled: true } : {})}
            >
              Approve
            </s-button>
            <s-button
              tone="critical"
              onClick={() => setConfirmingReject(true)}
              {...(submittingIntent === "reject" ? { loading: true } : {})}
              {...(submitting ? { disabled: true } : {})}
            >
              Reject
            </s-button>
          </s-stack>
        )}
      </s-stack>
    </s-box>
  );
}

export default function Registrations() {
  const { pending, recent } = useLoaderData<typeof loader>();
  const [approvedBy, setApprovedBy] = useState("");
  const [nameMissing, setNameMissing] = useState(false);
  const nameSection = useRef<HTMLDivElement>(null);
  // Decisions made on this page. Shown right away, because Shopify's customer
  // search can take a few seconds to reflect the new tags.
  const [reviewed, setReviewed] = useState<
    { registration: Registration; status: "approved" | "rejected" }[]
  >([]);

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
    if (value.trim()) setNameMissing(false);
    try {
      window.localStorage.setItem(APPROVED_BY_KEY, value);
    } catch {
      // Not remembered; nothing else depends on it.
    }
  };

  const reviewedIds = new Set(reviewed.map((entry) => entry.registration.customerId));
  const waiting = pending.filter((entry) => !reviewedIds.has(entry.customerId));
  const decisions = [
    ...reviewed.map(({ registration, status }) => ({ ...registration, status })),
    ...recent.filter((entry) => !reviewedIds.has(entry.customerId)),
  ].slice(0, 10);

  return (
    <s-page heading="B2B registrations">
      <s-section heading="How approval works">
        <s-ordered-list>
          <s-list-item>
            A business registers on your store. Their customer account and company
            are created, and they appear below as <s-text type="strong">waiting for approval</s-text>.
            Until you approve them they can sign in, but can&rsquo;t place business orders.
          </s-list-item>
          <s-list-item>
            Check their details and collect what you need (account forms, credit
            check, shipping account, tax-exempt certificate).
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Approve</s-text> to let them order for the company. The
            company&rsquo;s “B2B account status”, “Approved by” and “Approved on” fields are
            filled in and the customer is emailed. <s-text type="strong">Reject</s-text> to
            remove them from the company.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section heading="Your name">
        <div ref={nameSection}>
          <s-text-field
            label="Approved by"
            details="Saved in the company's “Approved by” field when you approve someone."
            value={approvedBy}
            onInput={(event) => changeApprovedBy(event.currentTarget.value)}
            {...(nameMissing
              ? { error: "Enter your name before approving a registration." }
              : {})}
          />
        </div>
      </s-section>

      <s-section heading={`Waiting for approval (${waiting.length})`}>
        {waiting.length ? (
          <s-stack direction="block" gap="base">
            {waiting.map((registration) => (
              <PendingCard
                key={registration.customerId}
                registration={registration}
                approvedBy={approvedBy}
                onMissingName={() => {
                  setNameMissing(true);
                  nameSection.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
                onReviewed={(entry, status) =>
                  setReviewed((current) => [{ registration: entry, status }, ...current])
                }
              />
            ))}
          </s-stack>
        ) : (
          <s-paragraph>
            Nothing is waiting for approval. New registrations from the store appear
            here.
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Recently reviewed">
        {decisions.length ? (
          <s-stack direction="block" gap="small-200">
            {decisions.map((entry) => (
              <s-stack
                key={entry.customerId}
                direction="inline"
                gap="small-200"
                alignItems="center"
              >
                <s-badge tone={entry.status === "approved" ? "success" : "critical"}>
                  {entry.status === "approved" ? "Approved" : "Rejected"}
                </s-badge>
                <s-link href={`shopify://admin/customers/${numericId(entry.customerId)}`}>
                  {entry.name}
                </s-link>
                <s-text color="subdued">
                  {entry.companies.map((company) => company.name).join(", ") ||
                    "No company"}
                </s-text>
              </s-stack>
            ))}
          </s-stack>
        ) : (
          <s-paragraph>No registrations have been approved or rejected yet.</s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
