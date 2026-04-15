import { SignIn } from "@clerk/nextjs";

const clerkAppearance = {
  variables: {
    colorPrimary: "#22d3ee",
    colorBackground: "#0a0f1f",
    colorText: "#f0f4f8",
    colorTextSecondary: "#94a3b8",
    colorTextOnPrimaryBackground: "#060918",
    colorInputBackground: "#0c1024",
    colorInputText: "#f0f4f8",
    colorNeutral: "#f0f4f8",
    colorDanger: "#f87171",
    colorSuccess: "#34d399",
    borderRadius: "0.75rem",
    fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
    fontSize: "0.875rem",
  },
  elements: {
    // Card
    rootBox: "w-full max-w-md",
    cardBox: "shadow-none",
    card: "bg-[#0a0f1f]/95 backdrop-blur-xl border border-[rgba(34,211,238,0.12)] shadow-[0_0_60px_rgba(34,211,238,0.06),0_0_120px_rgba(129,140,248,0.04)] rounded-2xl",
    // Header
    headerTitle: "!text-[#f0f4f8] text-xl font-semibold tracking-wide",
    headerSubtitle: "!text-[#64748b]",
    // Social buttons
    socialButtonsBlockButton: "!bg-[#0c1024] !border-[rgba(148,163,184,0.12)] !text-[#f0f4f8] hover:!bg-[#121830] hover:!border-[rgba(34,211,238,0.2)] transition-all",
    socialButtonsBlockButtonText: "!text-[#f0f4f8] font-medium",
    socialButtonsProviderIcon: "brightness-0 invert opacity-80",
    // Divider
    dividerLine: "!bg-[rgba(148,163,184,0.12)]",
    dividerText: "!text-[#64748b] text-xs",
    // Form fields
    formFieldLabel: "!text-[#94a3b8] text-xs font-medium tracking-wide",
    formFieldInput: "!bg-[#0c1024] !border-[rgba(148,163,184,0.12)] !text-[#f0f4f8] placeholder:!text-[#475569] focus:!border-[#22d3ee] focus:!ring-[rgba(34,211,238,0.2)]",
    formFieldInputShowPasswordButton: "!text-[#94a3b8] hover:!text-[#22d3ee]",
    formFieldAction: "!text-[#22d3ee] hover:!text-[#06b6d4] text-xs",
    formFieldWarningText: "!text-[#fbbf24]",
    formFieldErrorText: "!text-[#f87171]",
    formFieldHintText: "!text-[#64748b]",
    formFieldSuccessText: "!text-[#34d399]",
    // Primary button
    formButtonPrimary: "!bg-gradient-to-r !from-[#22d3ee] !to-[#818cf8] hover:!from-[#06b6d4] hover:!to-[#6366f1] !text-[#060918] font-semibold tracking-wide !shadow-[0_0_20px_rgba(34,211,238,0.25)] hover:!shadow-[0_0_30px_rgba(34,211,238,0.35)] transition-all duration-300 !border-0",
    // Footer
    footer: "!bg-transparent",
    footerAction: "!text-[#64748b]",
    footerActionText: "!text-[#64748b]",
    footerActionLink: "!text-[#22d3ee] hover:!text-[#06b6d4] font-medium",
    footerPages: "!text-[#64748b]",
    footerPagesLink: "!text-[#64748b] hover:!text-[#94a3b8]",
    // Links
    identityPreviewText: "!text-[#f0f4f8]",
    identityPreviewEditButton: "!text-[#22d3ee]",
    // Alert
    alert: "!bg-[#0c1024] !border-[rgba(148,163,184,0.1)] !text-[#f0f4f8]",
    alertText: "!text-[#f0f4f8]",
    // OTP
    otpCodeFieldInput: "!bg-[#0c1024] !border-[rgba(148,163,184,0.15)] !text-[#f0f4f8]",
    // Badge / branding
    badge: "!bg-[#0c1024] !text-[#475569] !border-[rgba(148,163,184,0.08)]",
    // Back
    backLink: "!text-[#94a3b8] hover:!text-[#f0f4f8]",
    formResendCodeLink: "!text-[#22d3ee]",
    // Catch-all for any remaining internal text
    alternativeMethodsBlockButton: "!text-[#94a3b8] !border-[rgba(148,163,184,0.12)]",
    selectButton: "!text-[#f0f4f8] !bg-[#0c1024] !border-[rgba(148,163,184,0.12)]",
    selectOption: "!text-[#f0f4f8] !bg-[#0c1024] hover:!bg-[#121830]",
  },
};

export default function SignInPage() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#060918]">
      {/* Ambient glow effects */}
      <div className="pointer-events-none absolute left-1/2 top-1/3 h-[500px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.08)_0%,transparent_70%)]" />
      <div className="pointer-events-none absolute right-1/4 bottom-1/4 h-[400px] w-[400px] rounded-full bg-[radial-gradient(circle,rgba(129,140,248,0.06)_0%,transparent_70%)]" />

      {/* Global overrides for Clerk elements that don't have named element keys */}
      <style>{`
        .cl-internal-b3fm6y,
        .cl-footerPages,
        .cl-footer span,
        .cl-footer a,
        .cl-dividerText,
        .cl-headerSubtitle,
        .cl-alternativeMethods span,
        .cl-identityPreview__buttonArrow,
        .cl-formFieldLabel,
        .cl-selectButton__countryCode span {
          color: #64748b !important;
        }
        .cl-footer a:hover {
          color: #94a3b8 !important;
        }
        .cl-internal-b3fm6y a {
          color: #475569 !important;
        }
        .cl-card {
          background: rgba(10, 15, 31, 0.95) !important;
        }
        .cl-formFieldInput {
          background: #0c1024 !important;
          border-color: rgba(148, 163, 184, 0.12) !important;
          color: #f0f4f8 !important;
        }
        .cl-formFieldInput::placeholder {
          color: #475569 !important;
        }
        .cl-formFieldInput:focus {
          border-color: #22d3ee !important;
          box-shadow: 0 0 0 1px rgba(34, 211, 238, 0.2) !important;
        }
        .cl-socialButtonsBlockButton {
          background: #0c1024 !important;
          border-color: rgba(148, 163, 184, 0.12) !important;
        }
        .cl-socialButtonsBlockButton:hover {
          background: #121830 !important;
          border-color: rgba(34, 211, 238, 0.2) !important;
        }
        .cl-dividerLine {
          background: rgba(148, 163, 184, 0.1) !important;
        }
        .cl-footerActionLink {
          color: #22d3ee !important;
        }
        .cl-footerActionLink:hover {
          color: #06b6d4 !important;
        }
        /* Hide "Secured by Clerk" and "Development mode" — use wildcard
           to catch Clerk's hashed internal class names across versions */
        [class*="cl-internal"] {
          display: none !important;
        }
        /* Make the entire card + footer background uniform */
        .cl-cardBox,
        .cl-card,
        .cl-footer,
        .cl-card > div:last-child {
          background: transparent !important;
          box-shadow: none !important;
        }
      `}</style>

      <div className="relative z-10">
        {/* Logo / Brand */}
        <div className="mb-8 flex flex-col items-center gap-2">
          <div className="flex items-center gap-2">
            <div className="h-2.5 w-2.5 rounded-full bg-[#22d3ee] shadow-[0_0_12px_rgba(34,211,238,0.5)]" />
            <h1 className="text-lg font-semibold tracking-widest text-[#f0f4f8]">
              BI ANALYST
            </h1>
          </div>
          <p className="text-xs tracking-wide text-[#475569]">
            AI-powered business intelligence
          </p>
        </div>

        <SignIn appearance={clerkAppearance} />
      </div>
    </div>
  );
}
