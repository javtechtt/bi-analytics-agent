import { SignIn } from "@clerk/nextjs";

const clerkAppearance = {
  variables: {
    colorPrimary: "#22d3ee",
    colorBackground: "#0a0f1f",
    colorText: "#f0f4f8",
    colorTextSecondary: "#94a3b8",
    colorInputBackground: "#0e1428",
    colorInputText: "#f0f4f8",
    colorNeutral: "#94a3b8",
    colorDanger: "#f87171",
    colorSuccess: "#34d399",
    borderRadius: "0.75rem",
    fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
    fontSize: "0.875rem",
  },
  elements: {
    // Card container
    rootBox: "w-full max-w-md",
    card: "bg-[#0a0f1f]/95 backdrop-blur-xl border border-[rgba(34,211,238,0.12)] shadow-[0_0_60px_rgba(34,211,238,0.06),0_0_120px_rgba(129,140,248,0.04)] rounded-2xl",
    // Header
    headerTitle: "text-[#f0f4f8] text-xl font-semibold tracking-wide",
    headerSubtitle: "text-[#94a3b8] text-sm",
    // Social buttons
    socialButtonsBlockButton: "bg-[#0e1428] border border-[rgba(148,163,184,0.1)] text-[#f0f4f8] hover:bg-[#121830] hover:border-[rgba(34,211,238,0.2)] transition-all duration-200",
    socialButtonsBlockButtonText: "text-[#f0f4f8] font-medium",
    socialButtonsProviderIcon: "brightness-0 invert opacity-80",
    // Divider ("or continue with")
    dividerLine: "bg-[rgba(148,163,184,0.1)]",
    dividerText: "text-[#475569] text-xs uppercase tracking-widest",
    // Form fields
    formFieldLabel: "text-[#94a3b8] text-xs font-medium tracking-wide uppercase",
    formFieldInput: "bg-[#0e1428] border-[rgba(148,163,184,0.1)] text-[#f0f4f8] placeholder:text-[#475569] focus:border-[#22d3ee] focus:ring-1 focus:ring-[rgba(34,211,238,0.3)] transition-all duration-200",
    formFieldInputShowPasswordButton: "text-[#94a3b8] hover:text-[#22d3ee]",
    formFieldAction: "text-[#22d3ee] hover:text-[#06b6d4] text-xs",
    formFieldWarningText: "text-[#fbbf24]",
    formFieldErrorText: "text-[#f87171]",
    formFieldHintText: "text-[#475569]",
    formFieldSuccessText: "text-[#34d399]",
    // Primary button
    formButtonPrimary: "bg-gradient-to-r from-[#22d3ee] to-[#818cf8] hover:from-[#06b6d4] hover:to-[#6366f1] text-[#060918] font-semibold tracking-wide shadow-[0_0_20px_rgba(34,211,238,0.2)] hover:shadow-[0_0_30px_rgba(34,211,238,0.3)] transition-all duration-300 border-0",
    // Footer
    footerAction: "text-[#94a3b8]",
    footerActionText: "text-[#94a3b8]",
    footerActionLink: "text-[#22d3ee] hover:text-[#06b6d4] font-medium",
    // Links and text
    identityPreviewText: "text-[#f0f4f8]",
    identityPreviewEditButton: "text-[#22d3ee] hover:text-[#06b6d4]",
    // Alert
    alert: "bg-[#0e1428] border border-[rgba(148,163,184,0.1)] text-[#f0f4f8]",
    alertText: "text-[#f0f4f8]",
    // OTP
    otpCodeFieldInput: "bg-[#0e1428] border-[rgba(148,163,184,0.15)] text-[#f0f4f8] focus:border-[#22d3ee]",
    // Internal elements
    internal: "text-[#94a3b8]",
    badge: "bg-[#121830] text-[#22d3ee] border border-[rgba(34,211,238,0.2)]",
    avatarBox: "border-[rgba(34,211,238,0.2)]",
    // Verification
    formResendCodeLink: "text-[#22d3ee] hover:text-[#06b6d4]",
    // Back button
    backLink: "text-[#94a3b8] hover:text-[#f0f4f8]",
  },
};

export default function SignInPage() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#060918]">
      {/* Ambient glow effects */}
      <div className="pointer-events-none absolute left-1/2 top-1/3 h-[500px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.08)_0%,transparent_70%)]" />
      <div className="pointer-events-none absolute right-1/4 bottom-1/4 h-[400px] w-[400px] rounded-full bg-[radial-gradient(circle,rgba(129,140,248,0.06)_0%,transparent_70%)]" />

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
