import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { ChatWorkspace } from "../src/chat-workspace";
import "../src/index.css";

const accountConversationId = "33333333-3333-4333-8333-333333333333";
const params = new URLSearchParams(window.location.search);
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
    content: params.get("table") === "1"
      ? [
          "**Simple Table Summary of CMEP Scheme**",
          "",
          "| Particular | Manufacturing Sector | Knowledge Economy (IT/AI/etc.) |",
          "| :--- | :---: | ---: |",
          "| Maximum Project Cost | **Up to ₹75 Lakh** | Up to ₹50 Lakh |",
          "| Example | `input|output` | left\\|right |",
        ].join("\n")
      : "Planets follow a clear path: **gravity** keeps them moving around the Sun.",
    createdAt: "2026-10-08T12:02:00.000Z",
  },
];

type ChatTestState = {
  requests: { path: string; method: string; body: unknown }[];
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function streamResponse(event: unknown) {
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    status: 201,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const nativeFetch = window.fetch.bind(window);
const testWindow = window as Window & { __chatTestState?: ChatTestState };
const testState: ChatTestState = { requests: [] };
testWindow.__chatTestState = testState;
let fixtureConversations = [sampleConversation];
const fixtureMessages = new Map<string, typeof sampleMessages>([
  [accountConversationId, sampleMessages],
]);
let generatedMessageId = 0;
window.fetch = (input, init) => {
  const requestUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const { pathname } = new URL(requestUrl, window.location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  let body: unknown;
  if (typeof init?.body === "string") {
    body = JSON.parse(init.body) as unknown;
  } else if (init?.body instanceof FormData) {
    const multipartBody: Record<string, unknown> = {};
    const files: { name: string; type: string; size: number }[] = [];
    for (const [key, value] of init.body.entries()) {
      if (value instanceof File) {
        files.push({ name: value.name, type: value.type, size: value.size });
      } else {
        multipartBody[key] = value;
      }
    }
    if (files.length) multipartBody.files = files;
    body = multipartBody;
  }
  testState.requests.push({ path: pathname, method, body });

  if (pathname === "/api/conversations" && method === "GET") {
    return Promise.resolve(jsonResponse({ items: fixtureConversations }));
  }

  const messagesMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messagesMatch && method === "GET") {
    return Promise.resolve(jsonResponse({ items: fixtureMessages.get(messagesMatch[1]) ?? [] }));
  }

  if (pathname === "/api/guest-chat" && method === "POST") {
    const guestBody = body as { messages?: { content: string }[] | string } | undefined;
    let messages = guestBody?.messages;
    if (typeof messages === "string") {
      try {
        messages = JSON.parse(messages) as { content: string }[];
      } catch {
        messages = [];
      }
    }
    const content = Array.isArray(messages) ? messages.at(-1)?.content ?? "" : "";
    return Promise.resolve(streamResponse({
      type: "done",
      content: `A helpful reply to: ${content}`,
    }));
  }

  if (pathname === "/api/conversations/import-guest" && method === "POST") {
    const transfer = body as {
      id: string;
      title: string;
      messages: { role: "user" | "assistant"; content: string }[];
    };
    const now = new Date().toISOString();
    const conversation = {
      id: transfer.id,
      title: transfer.title,
      createdAt: now,
      updatedAt: now,
    };
    fixtureConversations = [
      conversation,
      ...fixtureConversations.filter((item) => item.id !== conversation.id),
    ];
    const items = transfer.messages.map((message, index) => {
      generatedMessageId += 1;
      return {
        id: `cccccccc-cccc-4ccc-8ccc-${generatedMessageId.toString().padStart(12, "0")}`,
        conversationId: transfer.id,
        role: message.role,
        content: message.content,
        createdAt: new Date(Date.now() + index).toISOString(),
      };
    });
    fixtureMessages.set(transfer.id, items);
    return Promise.resolve(jsonResponse(conversation, 201));
  }

  const chatMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/chat$/);
  if (chatMatch && method === "POST") {
    const conversationId = chatMatch[1];
    const chatBody = body as {
      content: string;
      createIfMissing?: boolean | string;
    };
    const now = new Date().toISOString();
    if (
      (chatBody.createIfMissing === true || chatBody.createIfMissing === "true") &&
      !fixtureConversations.some((conversation) => conversation.id === conversationId)
    ) {
      fixtureConversations = [
        {
          id: conversationId,
          title: chatBody.content.slice(0, 42),
          createdAt: now,
          updatedAt: now,
        },
        ...fixtureConversations,
      ];
    }
    generatedMessageId += 1;
    const messageSuffix = generatedMessageId.toString().padStart(12, "0");
    const items = [
      {
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${messageSuffix}`,
        conversationId,
        role: "user",
        content: chatBody.content,
        createdAt: now,
      },
      {
        id: `bbbbbbbb-bbbb-4bbb-8bbb-${messageSuffix}`,
        conversationId,
        role: "assistant",
        content: `A helpful reply to: ${chatBody.content}`,
        createdAt: now,
      },
    ];
    fixtureMessages.set(conversationId, [
      ...(fixtureMessages.get(conversationId) ?? []),
      ...items,
    ]);
    return Promise.resolve(streamResponse({
      type: "done",
      content: items[1].content,
      items,
    }));
  }

  return nativeFetch(input, init);
};

const mode = new URLSearchParams(window.location.search).get("mode") === "account"
  ? "account"
  : "guest";
const historyCount = Number(params.get("history") ?? "0");
if (mode === "guest" && params.get("empty") !== "1") {
  const guestItems = historyCount > 1
    ? Array.from({ length: historyCount }, (_, index) => ({
        id: `77777777-7777-4777-8777-${index.toString().padStart(12, "0")}`,
        title: `Conversation ${index + 1}`,
        messages: sampleMessages.map(({ role, content }) => ({ role, content })),
        createdAt: Date.now() - index * 60_000,
        updatedAt: Date.now() - index * 60_000,
      }))
    : [
        {
          id: "66666666-6666-4666-8666-666666666666",
          title: "A clear explanation",
          messages: sampleMessages.map(({ role, content }) => ({ role, content })),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];
  localStorage.setItem(
    "easy-peasy-docs:guest-conversations:v1",
    JSON.stringify(guestItems),
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
