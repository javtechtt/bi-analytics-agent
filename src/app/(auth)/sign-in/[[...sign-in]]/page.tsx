import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#060918]">
      <SignIn
        appearance={{
          variables: {
            colorPrimary: "#22d3ee",
            colorBackground: "#0c1024",
            colorText: "#f0f4f8",
            colorInputBackground: "#121830",
            colorInputText: "#f0f4f8",
            colorTextSecondary: "#94a3b8",
            borderRadius: "0.75rem",
          },
          elements: {
            card: "shadow-2xl border border-[rgba(148,163,184,0.08)]",
            headerTitle: "text-[#f0f4f8]",
            headerSubtitle: "text-[#94a3b8]",
            socialButtonsBlockButton: "border-[rgba(148,163,184,0.12)] bg-[#121830] text-[#f0f4f8] hover:bg-[#1a2340]",
            formFieldInput: "border-[rgba(148,163,184,0.12)]",
            footerActionLink: "text-[#22d3ee] hover:text-[#06b6d4]",
          },
        }}
      />
    </div>
  );
}
