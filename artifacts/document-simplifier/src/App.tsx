import { useEffect, useRef } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, Show, SignIn, SignUp, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Redirect, Route, Router as WouterRouter, Switch, useLocation } from "wouter";
import { AccountPortal } from "./account-portal";
import { GuestChat } from "./guest-chat";

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

if (!clerkPubKey) throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in the workspace environment.");

function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || "/" : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#345d49",
    colorForeground: "#293a31",
    colorMutedForeground: "#747f75",
    colorDanger: "#9b5140",
    colorBackground: "#fbfaf6",
    colorInput: "#fffefa",
    colorInputForeground: "#293a31",
    colorNeutral: "#dfded3",
    fontFamily: "'DM Sans', sans-serif",
    borderRadius: "14px",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-[#fbfaf6] rounded-2xl w-[440px] max-w-full overflow-hidden",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: { color: "#293a31", fontSize: "25px", fontWeight: "700" },
    headerSubtitle: { color: "#747f75", fontSize: "13px" },
    socialButtonsBlockButtonText: { color: "#293a31", fontWeight: "600" },
    formFieldLabel: { color: "#46564a", fontWeight: "600" },
    footerActionLink: { color: "#345d49", fontWeight: "700" },
    footerActionText: { color: "#747f75" },
    dividerText: { color: "#747f75" },
    identityPreviewEditButton: { color: "#345d49" },
    formFieldSuccessText: { color: "#496b3d" },
    alertText: { color: "#8a4737" },
    logoBox: "mx-auto",
    logoImage: "max-h-12 w-auto",
    socialButtonsBlockButton: "border border-[#dfded3] bg-[#fffefa] hover:bg-[#f3f2eb]",
    formButtonPrimary: "bg-[#345d49] text-white hover:bg-[#294b3a]",
    formFieldInput: "border-[#dfded3] bg-[#fffefa] text-[#293a31]",
    footerAction: "text-[#747f75]",
    dividerLine: "bg-[#e7e5db]",
    alert: "border-[#e3c4b8] bg-[#fff6f2]",
    otpCodeFieldInput: "border-[#dfded3] bg-[#fffefa] text-[#293a31]",
    formFieldRow: "text-[#46564a]",
    main: "text-[#293a31]",
  },
};

function HomeRedirect() {
  return <><Show when="signed-in"><Redirect to="/user-portal" /></Show><Show when="signed-out"><GuestChat /></Show></>;
}

function UserPortalRoute() {
  return <><Show when="signed-in"><AccountPortal /></Show><Show when="signed-out"><Redirect to="/" /></Show></>;
}

function SignInPage() {
  return <div className="auth-page"><div className="auth-context"><span className="auth-mark">EP</span><span>Easy Peasy Docs</span><p>Your own space to ask, explore, and think things through.</p></div><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} appearance={clerkAppearance} /></div>;
}

function SignUpPage() {
  return <div className="auth-page"><div className="auth-context"><span className="auth-mark">EP</span><span>Easy Peasy Docs</span><p>A personal space for your conversations and ideas.</p></div><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} appearance={clerkAppearance} /></div>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (previousUserId.current !== undefined && previousUserId.current !== userId) client.clear();
      previousUserId.current = userId;
    });
    return unsubscribe;
  }, [addListener, client]);
  return null;
}

function ClerkRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: "Welcome back", subtitle: "Sign in to your personal chat space" } },
        signUp: { start: { title: "Create your account", subtitle: "Make a little room for good questions" } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <Switch>
          <Route path="/" component={HomeRedirect} />
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route path="/user-portal" component={UserPortalRoute} />
          <Route component={HomeRedirect} />
        </Switch>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return <WouterRouter base={basePath}><ClerkRoutes /></WouterRouter>;
}

export default App;
