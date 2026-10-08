import { useClerk, useUser } from "@clerk/react";
import { Link } from "wouter";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function AccountActions() {
  const { isLoaded, user } = useUser();
  const { signOut } = useClerk();
  if (!isLoaded) return <span className="account-action-loading">Loading account</span>;
  if (!user) {
    return (
      <div className="chat-account-actions">
        <Link href="/sign-in" className="account-signin" data-testid="link-sign-in">Sign in</Link>
        <Link href="/sign-up" className="account-signup" data-testid="link-sign-up">Create account</Link>
      </div>
    );
  }
  return (
    <div className="chat-account-actions">
      <Link href="/user-portal" className="account-user-name" title={user.primaryEmailAddress?.emailAddress ?? undefined} data-testid="link-account">
        {user.firstName || user.primaryEmailAddress?.emailAddress || "Your account"}
      </Link>
      <button type="button" className="account-signout" onClick={() => void signOut({ redirectUrl: basePath || "/" })} data-testid="button-sign-out">Sign out</button>
    </div>
  );
}
