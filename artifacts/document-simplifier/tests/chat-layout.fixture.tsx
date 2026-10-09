import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { ChatWorkspace } from "../src/chat-workspace";
import "../src/index.css";

const accountConversationId = "33333333-3333-4333-8333-333333333333";
const sampleConversation = {
  id: accountConversationId,
  title: "A clear explanation",
  createdAt: "2026-10-08T12:00:00.000Z",
  updatedAt: "2026-10-08T12:00:00.000Z",
};
const sampleMessages = [
  {
    id: "44444444-4444-4444-8444-444444444444",
    conversationId: accountConversationId,
    role: "user",
    content: "Why do planets orbit the Sun?",
    createdAt: "2026-10-08T12:01:00.000Z",
  },
  {
    id: "55555555-5555-4555-8555-555555555555",
    conversationId: accountConversationId,
    role: "assistant",
    content: "Planets follow a clear path: **gravity** keeps them moving around the Sun.",
    createdAt: "2026-10-08T12:02:00.000Z",
  },
];

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const requestUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const { pathname } = new URL(requestUrl, window.location.origin);

  if (pathname === "/api/conversations" && (!init?.method || init.method === "GET")) {
    return Promise.resolve(jsonResponse({ items: [sampleConversation] }));
  }

  if (pathname === `/api/conversations/${accountConversationId}/messages`) {
    return Promise.resolve(jsonResponse({ items: sampleMessages }));
  }

  return nativeFetch(input, init);
};

const mode = new URLSearchParams(window.location.search).get("mode") === "account"
  ? "account"
  : "guest";
if (mode === "guest") {
  localStorage.setItem(
    "easy-peasy-docs:guest-conversations:v1",
    JSON.stringify([
      {
        id: "guest-layout-conversation",
        title: "A clear explanation",
        messages: sampleMessages.map(({ role, content }) => ({ role, content })),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]),
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Router>
      <ChatWorkspace mode={mode} />
    </Router>
  </QueryClientProvider>,
);
