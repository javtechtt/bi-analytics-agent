import { WorkspaceProvider } from "@/components/WorkspaceProvider";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <WorkspaceProvider>{children}</WorkspaceProvider>;
}
