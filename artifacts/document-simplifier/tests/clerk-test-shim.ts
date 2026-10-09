export function ClerkProvider() {
  return null;
}

export function Show() {
  return null;
}

export function SignIn() {
  return null;
}

export function SignUp() {
  return null;
}

export function useUser() {
  return {
    isLoaded: true,
    user: {
      firstName: "Casey",
      primaryEmailAddress: { emailAddress: "casey@example.test" },
    },
  };
}

export function useClerk() {
  return { signOut: async () => undefined };
}
