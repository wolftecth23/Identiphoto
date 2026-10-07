import { USA_COUNTRY, US_STATES } from "../data/us-address";
import type { RegistrationCustomer } from "./b2b-registration.server";

/** Storefront path of the submit endpoint ([app_proxy] in shopify.app.toml). */
const SUBMIT_PATH = "/apps/b2b-register/link";

const EN = {
  pageTitle: "Business registration",
  pageDescription: "Register your company to set up a business account.",
  signInPrompt: "Already have an account?",
  signIn: "Sign in",
  businessAccountTitle: "Business account",
  status: "Status",
  active: "Active",
  personalInformation: "Personal information",
  companyInformation: "Company information",
  addressInformation: "Address information",
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  remoteAssist: "Allow remote shopping assistance",
  company: "Company",
  phone: "Phone number",
  phoneExt: "Phone extension (optional)",
  streetAddress: "Street address",
  addressLine2: "Address line 2 (optional)",
  addressLine3: "Address line 3 (optional)",
  country: "Country",
  stateProvince: "State/Province",
  statePlaceholder: "Please select a region, state or province.",
  city: "City",
  zip: "ZIP/Postal code",
  submit: "Create an Account",
  submitError: "We could not complete registration. Please try again.",
  success: "Your account and company profile have been saved.",
  successJoinedCompany:
    "Your account has been saved and added to the existing company %companyName%.",
  signInAfterRegister:
    "Sign in with the email you registered to start ordering.",
};

type Copy = typeof EN;

const FR: Copy = {
  pageTitle: "Inscription de l'entreprise",
  pageDescription:
    "Inscrivez votre entreprise pour créer un compte professionnel.",
  signInPrompt: "Vous avez déjà un compte ?",
  signIn: "Se connecter",
  businessAccountTitle: "Compte professionnel",
  status: "Statut",
  active: "Actif",
  personalInformation: "Informations personnelles",
  companyInformation: "Informations sur l'entreprise",
  addressInformation: "Informations d'adresse",
  firstName: "Prénom",
  lastName: "Nom",
  email: "Courriel",
  remoteAssist: "Autoriser l'assistance à distance pour les achats",
  company: "Entreprise",
  phone: "Numéro de téléphone",
  phoneExt: "Poste",
  streetAddress: "Adresse",
  addressLine2: "Complément d'adresse (facultatif)",
  addressLine3: "Complément d'adresse 2 (facultatif)",
  country: "Pays",
  stateProvince: "État/Province",
  statePlaceholder:
    "Veuillez sélectionner une région, un état ou une province.",
  city: "Ville",
  zip: "Code postal",
  submit: "Créer un compte",
  submitError: "Impossible de terminer l'inscription. Réessayez.",
  success: "Votre compte et votre profil entreprise ont été enregistrés.",
  successJoinedCompany:
    "Votre compte a été enregistré et ajouté à l'entreprise existante %companyName%.",
  signInAfterRegister:
    "Connectez-vous avec l'adresse courriel utilisée pour commencer à commander.",
};

/**
 * Escapes text for HTML. Braces are escaped too: the response is rendered as
 * Liquid, so customer data must never form `{{` or `{%`.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

/** JSON safe to embed in a <script> tag inside a Liquid response. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\{(?=[{%])/g, "\\u007b");
}

type PageOptions = {
  signedIn: boolean;
  customer: RegistrationCustomer | null;
};

function textField(
  copy: Copy,
  options: {
    name: string;
    label: keyof Copy;
    type?: string;
    autocomplete?: string;
    value?: string;
    required?: boolean;
  },
): string {
  const id = `b2b-register-${options.name}`;
  return `
    <div class="b2b-register__field">
      <label for="${id}">${escapeHtml(copy[options.label])}</label>
      <input id="${id}" name="${options.name}" type="${options.type ?? "text"}"${
        options.autocomplete ? ` autocomplete="${options.autocomplete}"` : ""
      } value="${escapeHtml(options.value ?? "")}"${
        options.required ? " required" : ""
      }>
    </div>`;
}

function businessAccount(copy: Copy, companyName: string): string {
  return `
    <h2 class="b2b-register__heading">${escapeHtml(copy.businessAccountTitle)}</h2>
    <dl class="b2b-register__card b2b-register__summary">
      <div><dt>${escapeHtml(copy.company)}</dt><dd data-b2b-register-company>${escapeHtml(companyName)}</dd></div>
      <div><dt>${escapeHtml(copy.status)}</dt><dd><span class="b2b-register__badge">${escapeHtml(copy.active)}</span></dd></div>
    </dl>`;
}

function registrationForm(copy: Copy, { signedIn, customer }: PageOptions) {
  const provinceCode = customer?.provinceCode ?? "";
  const stateOptions = US_STATES.map(
    (state) =>
      `<option value="${state.code}"${state.code === provinceCode ? " selected" : ""}>${escapeHtml(state.name)}</option>`,
  ).join("");

  return `
    <form class="b2b-register__card" data-b2b-register-form>
      <fieldset>
        <legend>${escapeHtml(copy.personalInformation)}</legend>
        <div class="b2b-register__grid">
          ${textField(copy, { name: "firstName", label: "firstName", autocomplete: "given-name", value: customer?.firstName, required: true })}
          ${textField(copy, { name: "lastName", label: "lastName", autocomplete: "family-name", value: customer?.lastName, required: true })}
        </div>
        ${
          // Signed-in customers are identified by the app proxy, so only
          // guests enter an email for their new account.
          signedIn
            ? ""
            : textField(copy, { name: "email", label: "email", type: "email", autocomplete: "email", required: true })
        }
        <label class="b2b-register__checkbox">
          <input type="checkbox" name="remoteAssist">
          ${escapeHtml(copy.remoteAssist)}
        </label>
      </fieldset>

      <fieldset>
        <legend>${escapeHtml(copy.companyInformation)}</legend>
        ${textField(copy, { name: "companyName", label: "company", autocomplete: "organization", required: true })}
        <div class="b2b-register__grid b2b-register__grid--phone">
          ${textField(copy, { name: "phone", label: "phone", type: "tel", autocomplete: "tel", required: true })}
          ${textField(copy, { name: "phoneExt", label: "phoneExt" })}
        </div>
      </fieldset>

      <fieldset>
        <legend>${escapeHtml(copy.addressInformation)}</legend>
        ${textField(copy, { name: "address1", label: "streetAddress", autocomplete: "address-line1", required: true })}
        <div class="b2b-register__grid">
          ${textField(copy, { name: "address2", label: "addressLine2", autocomplete: "address-line2" })}
          ${textField(copy, { name: "address3", label: "addressLine3", autocomplete: "address-line3" })}
          <div class="b2b-register__field">
            <label for="b2b-register-country">${escapeHtml(copy.country)}</label>
            <select id="b2b-register-country" disabled>
              <option value="${USA_COUNTRY.isoCode}">${escapeHtml(USA_COUNTRY.name)}</option>
            </select>
          </div>
          <div class="b2b-register__field">
            <label for="b2b-register-provinceCode">${escapeHtml(copy.stateProvince)}</label>
            <select id="b2b-register-provinceCode" name="provinceCode">
              <option value="">${escapeHtml(copy.statePlaceholder)}</option>
              ${stateOptions}
            </select>
          </div>
          ${textField(copy, { name: "city", label: "city", autocomplete: "address-level2", required: true })}
          ${textField(copy, { name: "zip", label: "zip", autocomplete: "postal-code", required: true })}
        </div>
      </fieldset>

      <button type="submit" class="button button--primary">${escapeHtml(copy.submit)}</button>
    </form>`;
}

function localizedPage(copy: Copy, options: PageOptions): string {
  const companyName = options.customer?.companyName;
  const messages = {
    submitError: copy.submitError,
    success: copy.success,
    successJoinedCompany: copy.successJoinedCompany,
  };

  // Customers already linked to a company see their business account instead.
  if (companyName) {
    return `
      <div class="b2b-register">
        <h1>${escapeHtml(copy.pageTitle)}</h1>
        ${businessAccount(copy, companyName)}
      </div>`;
  }

  return `
    <div class="b2b-register" data-b2b-register data-signed-in="${options.signedIn}">
      <script type="application/json" data-b2b-register-messages>${scriptJson(messages)}</script>
      <h1>${escapeHtml(copy.pageTitle)}</h1>
      <p class="b2b-register__subdued">${escapeHtml(copy.pageDescription)}</p>
      ${
        options.signedIn
          ? ""
          : `<p>${escapeHtml(copy.signInPrompt)} <a href="{{ routes.account_login_url }}">${escapeHtml(copy.signIn)}</a></p>`
      }
      <div class="b2b-register__banner" role="alert" data-b2b-register-banner hidden></div>
      ${registrationForm(copy, options)}
      <div data-b2b-register-success hidden>
        ${businessAccount(copy, "")}
        ${
          options.signedIn
            ? ""
            : `<p>${escapeHtml(copy.signInAfterRegister)} <a href="{{ routes.account_login_url }}">${escapeHtml(copy.signIn)}</a></p>`
        }
      </div>
    </div>`;
}

const STYLES = `
<style>
  .b2b-register { max-width: 72rem; margin: 0 auto; padding: 3rem 1.5rem; }
  .b2b-register [hidden] { display: none !important; }
  .b2b-register h1 { margin: 0 0 0.5rem; }
  .b2b-register__subdued { opacity: 0.75; margin-top: 0; }
  .b2b-register__heading { margin: 2rem 0 1rem; }
  .b2b-register__card { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 0.75rem; padding: 2rem; }
  .b2b-register form { display: grid; gap: 2rem; }
  .b2b-register fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: 1.25rem; }
  .b2b-register fieldset + fieldset { border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); padding-top: 2rem; }
  .b2b-register legend { font-weight: 600; font-size: 1.15em; padding: 0; margin-bottom: 1.25rem; }
  .b2b-register__grid { display: grid; gap: 1.25rem; grid-template-columns: 1fr; }
  .b2b-register__field { display: grid; gap: 0.4rem; }
  .b2b-register__field input, .b2b-register__field select { width: 100%; box-sizing: border-box; min-height: 4.4rem; padding: 0.8rem 1.2rem; font: inherit; color: inherit; background: transparent; border: 1px solid color-mix(in srgb, currentColor 40%, transparent); border-radius: 0.5rem; }
  .b2b-register__field select option { color: initial; }
  .b2b-register__field select:disabled { opacity: 0.6; }
  .b2b-register__checkbox { display: flex; gap: 0.75rem; align-items: center; }
  .b2b-register button[type="submit"] { justify-self: start; }
  .b2b-register button[aria-busy="true"] { opacity: 0.6; cursor: progress; }
  .b2b-register__banner { border-radius: 0.5rem; padding: 1.2rem 1.5rem; margin: 1.5rem 0; }
  .b2b-register__banner[data-tone="critical"] { background: color-mix(in srgb, #d72c0d 12%, transparent); border: 1px solid color-mix(in srgb, #d72c0d 50%, transparent); }
  .b2b-register__banner[data-tone="success"] { background: color-mix(in srgb, #008060 12%, transparent); border: 1px solid color-mix(in srgb, #008060 50%, transparent); }
  .b2b-register__summary { margin: 0; display: grid; gap: 1.25rem; }
  .b2b-register__summary div { display: flex; justify-content: space-between; gap: 1rem; }
  .b2b-register__summary div + div { border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); padding-top: 1.25rem; }
  .b2b-register__summary dt { opacity: 0.75; }
  .b2b-register__summary dd { margin: 0; }
  .b2b-register__badge { border-radius: 999px; padding: 0.2rem 0.9rem; background: color-mix(in srgb, currentColor 10%, transparent); }
  @media (min-width: 750px) {
    .b2b-register__grid { grid-template-columns: 1fr 1fr; }
    .b2b-register__grid--phone { grid-template-columns: 2fr 1fr; }
  }
</style>`;

// Plain JS for the storefront. It must not contain `{{` or `{%`, because the
// whole response is rendered as Liquid.
const SCRIPT = `
<script>
  (function () {
    var root = document.querySelector("[data-b2b-register]");
    if (!root) return;
    var form = root.querySelector("[data-b2b-register-form]");
    var banner = root.querySelector("[data-b2b-register-banner]");
    var success = root.querySelector("[data-b2b-register-success]");
    var button = form.querySelector('button[type="submit"]');
    var messages = JSON.parse(root.querySelector("[data-b2b-register-messages]").textContent);

    function showBanner(tone, message) {
      banner.dataset.tone = tone;
      banner.textContent = message;
      banner.hidden = false;
      banner.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      banner.hidden = true;

      var data = new FormData(form);
      var value = function (name) { return String(data.get(name) || "").trim(); };
      var phone = value("phone");
      var phoneExt = value("phoneExt");
      var payload = {
        firstName: value("firstName"),
        lastName: value("lastName"),
        email: value("email"),
        companyName: value("companyName"),
        phone: phoneExt ? phone + " ext. " + phoneExt : phone,
        address1: value("address1"),
        address2: [value("address2"), value("address3")].filter(Boolean).join(", "),
        city: value("city"),
        provinceCode: value("provinceCode"),
        countryCode: ${JSON.stringify(USA_COUNTRY.isoCode)},
        zip: value("zip"),
        remoteShoppingAssistance: data.has("remoteAssist"),
      };

      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        var response = await fetch(${JSON.stringify(SUBMIT_PATH)}, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
          credentials: "same-origin",
        });
        var result = null;
        try { result = await response.json(); } catch (error) { result = null; }

        if (response.ok && result && result.ok) {
          var companyName = result.companyName || payload.companyName;
          form.hidden = true;
          success.querySelector("[data-b2b-register-company]").textContent = companyName;
          success.hidden = false;
          showBanner(
            "success",
            result.created === false && result.companyName
              ? messages.successJoinedCompany.replace("%companyName%", result.companyName)
              : messages.success
          );
          return;
        }

        var details = (result && result.userErrors ? result.userErrors : [])
          .map(function (entry) { return entry.message; });
        showBanner(
          "critical",
          [(result && result.error) || messages.submitError].concat(details).join(" ")
        );
      } catch (error) {
        console.error(error);
        showBanner("critical", messages.submitError);
      } finally {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    });
  })();
</script>`;

/**
 * Liquid for the storefront registration page at /apps/b2b-register. Shopify
 * renders it inside the theme layout, so the store header and footer show.
 */
export function renderB2bRegistrationPage(options: PageOptions): string {
  return `${STYLES}
{%- assign b2b_register_lang = request.locale.iso_code | slice: 0, 2 -%}
{%- if b2b_register_lang == 'fr' -%}
${localizedPage(FR, options)}
{%- else -%}
${localizedPage(EN, options)}
{%- endif -%}
${SCRIPT}`;
}
