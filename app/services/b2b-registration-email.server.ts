import nodemailer from "nodemailer";

export type MailMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};

/** Anything that can deliver a message; a nodemailer transport qualifies. */
export type Mailer = {
  sendMail(message: MailMessage): Promise<unknown>;
};

export type RegistrationEmailDetails = {
  to: string;
  firstName?: string | null;
  /** Name of the company the customer belongs to now (existing or new). */
  companyName: string;
  /** True when registration created the company; false when it joined one. */
  created: boolean;
  shopName: string;
  /** Storefront base URL, e.g. https://example.com. */
  storeUrl: string;
  /** Storefront locale the form was submitted from, e.g. "fr" or "en-US". */
  locale?: string;
};

const EN = {
  subject: (shop: string) => `We received your business registration with ${shop}`,
  greeting: (name: string) => (name ? `Hi ${name},` : "Hi,"),
  intro: (shop: string) =>
    `Thanks for registering with ${shop}. Our team will review your application and email you once your business account is approved.`,
  created: (company: string) =>
    `Your application for the company ${company} is pending approval.`,
  joined: (company: string) =>
    `Your request to join the existing company ${company} is pending approval.`,
  signIn: (email: string) =>
    `Once approved, sign in with ${email} to see your business account and place orders:`,
  button: "Go to my account",
  signOff: "Thank you,",
  approvedSubject: (shop: string) =>
    `Your business account with ${shop} is approved`,
  approvedIntro: (company: string) =>
    `Good news: your business account for ${company} has been approved.`,
  approvedSignIn: (email: string) =>
    `Sign in with ${email} to see your business account and place orders:`,
};

const FR: typeof EN = {
  subject: (shop) => `Nous avons reçu votre inscription professionnelle chez ${shop}`,
  greeting: (name) => (name ? `Bonjour ${name},` : "Bonjour,"),
  intro: (shop) =>
    `Merci de votre inscription chez ${shop}. Notre équipe examinera votre demande et vous écrira dès que votre compte professionnel sera approuvé.`,
  created: (company) =>
    `Votre demande pour l'entreprise ${company} est en attente d'approbation.`,
  joined: (company) =>
    `Votre demande pour rejoindre l'entreprise existante ${company} est en attente d'approbation.`,
  signIn: (email) =>
    `Une fois la demande approuvée, connectez-vous avec ${email} pour accéder à votre compte professionnel et passer commande :`,
  button: "Accéder à mon compte",
  signOff: "Merci,",
  approvedSubject: (shop) =>
    `Votre compte professionnel chez ${shop} est approuvé`,
  approvedIntro: (company) =>
    `Bonne nouvelle : votre compte professionnel pour ${company} a été approuvé.`,
  approvedSignIn: (email) =>
    `Connectez-vous avec ${email} pour accéder à votre compte professionnel et passer commande :`,
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function copyFor(locale: string | undefined): typeof EN {
  return locale?.toLowerCase().startsWith("fr") ? FR : EN;
}

/**
 * Subject and bodies of the email sent when a registration is received; it
 * tells the customer the account is pending approval.
 */
export function buildRegistrationEmail(details: RegistrationEmailDetails): {
  subject: string;
  text: string;
  html: string;
} {
  const copy = copyFor(details.locale);
  return buildEmail(details, {
    subject: copy.subject(details.shopName),
    lines: [
      copy.intro(details.shopName),
      details.created
        ? copy.created(details.companyName)
        : copy.joined(details.companyName),
    ],
    signIn: copy.signIn(details.to),
  });
}

/** Subject and bodies of the email sent when staff approve a registration. */
export function buildApprovalEmail(
  details: Omit<RegistrationEmailDetails, "created">,
): { subject: string; text: string; html: string } {
  const copy = copyFor(details.locale);
  return buildEmail(details, {
    subject: copy.approvedSubject(details.shopName),
    lines: [copy.approvedIntro(details.companyName)],
    signIn: copy.approvedSignIn(details.to),
  });
}

function buildEmail(
  details: Omit<RegistrationEmailDetails, "created">,
  content: { subject: string; lines: string[]; signIn: string },
): { subject: string; text: string; html: string } {
  const copy = copyFor(details.locale);
  const firstName = details.firstName?.trim() ?? "";
  const accountUrl = `${details.storeUrl.replace(/\/+$/, "")}/account`;

  const text = [
    copy.greeting(firstName),
    "",
    ...content.lines,
    "",
    content.signIn,
    accountUrl,
    "",
    copy.signOff,
    details.shopName,
  ].join("\n");

  // Each piece is escaped once here, so names like "Smith & Sons" are safe.
  const h = {
    greeting: escapeHtml(copy.greeting(firstName)),
    body: content.lines.map(escapeHtml).join("<br>"),
    signIn: escapeHtml(content.signIn),
    button: escapeHtml(copy.button),
    accountUrl: escapeHtml(accountUrl),
    signOff: escapeHtml(copy.signOff),
    shopName: escapeHtml(details.shopName),
  };

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#202223;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;">
      <tr>
        <td style="padding:32px;font-size:16px;line-height:1.5;">
          <p style="margin:0 0 16px;">${h.greeting}</p>
          <p style="margin:0 0 16px;">${h.body}</p>
          <p style="margin:0 0 24px;">${h.signIn}</p>
          <p style="margin:0 0 24px;">
            <a href="${h.accountUrl}" style="display:inline-block;padding:12px 20px;background:#202223;color:#ffffff;text-decoration:none;border-radius:6px;">${h.button}</a>
          </p>
          <p style="margin:0;">${h.signOff}<br>${h.shopName}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject: content.subject, text, html };
}

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
};

/**
 * SMTP settings from the environment, or null when sending is not set up
 * (SMTP_HOST unset), in which case registration skips the email.
 */
export function smtpConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;

  const port = Number(env.SMTP_PORT) || 587;
  const user = env.SMTP_USER?.trim() || undefined;
  const from = env.SMTP_FROM?.trim() || user;
  if (!from) {
    throw new Error("Set SMTP_FROM (or SMTP_USER) to send registration emails.");
  }

  return {
    host,
    port,
    // Port 465 is TLS from the start; other ports upgrade with STARTTLS.
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465,
    user,
    pass: env.SMTP_PASS || undefined,
    from,
  };
}

let smtpMailer: { mailer: Mailer; from: string } | null | undefined;

/** The SMTP mailer configured in the environment, created once and reused. */
export function smtpMailerFromEnv(): { mailer: Mailer; from: string } | null {
  if (smtpMailer !== undefined) return smtpMailer;

  const config = smtpConfigFromEnv();
  smtpMailer = config && {
    mailer: nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    }),
    from: config.from,
  };
  return smtpMailer;
}

/** Sends the "registration received" email to the customer. */
export async function sendRegistrationEmail(
  sender: { mailer: Mailer; from: string },
  details: RegistrationEmailDetails,
): Promise<void> {
  await send(sender, details.to, buildRegistrationEmail(details));
}

/** Sends the "account approved" email to the customer. */
export async function sendApprovalEmail(
  sender: { mailer: Mailer; from: string },
  details: Omit<RegistrationEmailDetails, "created">,
): Promise<void> {
  await send(sender, details.to, buildApprovalEmail(details));
}

async function send(
  sender: { mailer: Mailer; from: string },
  to: string,
  { subject, text, html }: { subject: string; text: string; html: string },
): Promise<void> {
  await sender.mailer.sendMail({
    from: sender.from,
    to,
    subject,
    text,
    html,
  });
}
