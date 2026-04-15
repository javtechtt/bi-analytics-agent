import { auth, currentUser } from "@clerk/nextjs/server";

/** Get the authenticated user ID or throw 401. Use in API routes. */
export async function requireAuth(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

/** Get the authenticated user ID, returning null if unauthenticated. */
export async function getAuthUserId(): Promise<string | null> {
  const { userId } = await auth();
  return userId;
}

/** Get user profile from Clerk (for syncing to Supabase). */
export async function getAuthUser() {
  const user = await currentUser();
  if (!user) return null;
  return {
    id: user.id,
    email: user.primaryEmailAddress?.emailAddress ?? null,
    displayName: user.fullName ?? user.firstName ?? "User",
    avatarUrl: user.imageUrl ?? null,
  };
}
