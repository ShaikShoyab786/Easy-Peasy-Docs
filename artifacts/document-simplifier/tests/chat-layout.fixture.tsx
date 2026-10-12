import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { ChatWorkspace } from "../src/chat-workspace";
import "../src/index.css";

const accountConversationId = "33333333-3333-4333-8333-333333333333";
const documentConversationId = "66666666-6666-4666-8666-666666666666";
const params = new URLSearchParams(window.location.search);
const sampleConversation = {
  id: accountConversationId,
  title: "A clear explanation",
  createdAt: "2026-10-08T12:00:00.000Z",
  updatedAt: "2026-10-08T12:00:00.000Z",
};
const documentConversation = {
  id: documentConversationId,
  title: "Chat about Operations policy.pdf",
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
    content: params.get("rich") === "1"
      ? [
          "```typescript",
          "const answer: number = 42;",
          "```",
          "",
          "A [useful link](https://example.com) and ~~old text~~.",
          "",
          "> A quoted idea.",
          "",
          "- parent",
          "  - nested child",
          "",
          "Inline math: $a^2 + b^2 = c^2$.",
        ].join("\n")
      : params.get("table") === "1"
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

type KnowledgeFixtureDocument = {
  id: string;
  conversationId: string | null;
  fileName: string;
  contentType: string;
  byteSize: number;
  isPinned: boolean;
  status: "pending_upload" | "ready";
  createdAt: string;
};

const sampleDocumentContent = "%PDF-1.7\nSample operations policy.\n";
const sampleKnowledgeDocument: KnowledgeFixtureDocument = {
  id: "a3333333-3333-4333-8333-333333333333",
  conversationId: documentConversationId,
  fileName: "Operations policy.pdf",
  contentType: "application/pdf",
  byteSize: new TextEncoder().encode(sampleDocumentContent).byteLength,
  isPinned: false,
  status: "ready",
  createdAt: "2026-10-08T12:00:00.000Z",
};

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

function eventStreamResponse(events: unknown[]) {
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}`, {
    status: 201,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const nativeFetch = window.fetch.bind(window);
const testWindow = window as Window & { __chatTestState?: ChatTestState };
const testState: ChatTestState = { requests: [] };
testWindow.__chatTestState = testState;
let fixtureConversations = params.get("documents") === "1"
  ? [documentConversation, sampleConversation]
  : [sampleConversation];
let fixtureDocuments: KnowledgeFixtureDocument[] = params.get("documents") === "1"
  ? [sampleKnowledgeDocument]
  : [];
const fixtureDocumentBytes = new Map<string, Blob>([
  [sampleKnowledgeDocument.id, new Blob([sampleDocumentContent], { type: sampleKnowledgeDocument.contentType })],
]);
const fixtureMessages = new Map<string, typeof sampleMessages>([
  [accountConversationId, sampleMessages],
  [documentConversationId, [
    {
      id: "77777777-7777-4777-8777-777777777777",
      conversationId: documentConversationId,
      role: "user",
      content: "What does the policy cover?",
      createdAt: "2026-10-08T12:01:00.000Z",
    },
    {
      id: "88888888-8888-4888-8888-888888888888",
      conversationId: documentConversationId,
      role: "assistant",
      content: "The policy covers operational reimbursements.",
      createdAt: "2026-10-08T12:02:00.000Z",
    },
  ]],
]);
let generatedMessageId = 0;
let generatedDocumentId = 0;
let guestRequestCount = 0;
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

  if (pathname === "/api/knowledge-documents" && method === "GET") {
    return Promise.resolve(jsonResponse({ items: fixtureDocuments }));
  }

  const clearDocumentContextMatch = pathname.match(
    /^\/api\/conversations\/([^/]+)\/document-context$/,
  );
  if (clearDocumentContextMatch && method === "DELETE") {
    fixtureDocuments = fixtureDocuments.map((item) =>
      item.conversationId === clearDocumentContextMatch[1]
        ? { ...item, conversationId: null }
        : item,
    );
    return Promise.resolve(new Response(null, { status: 204 }));
  }

  const documentChatMatch = pathname.match(/^\/api\/knowledge-documents\/([^/]+)\/chat$/);
  if (documentChatMatch && method === "POST") {
    const document = fixtureDocuments.find((item) => item.id === documentChatMatch[1]);
    if (!document?.conversationId) {
      return Promise.resolve(jsonResponse({ error: "Document not found." }, 404));
    }
    return Promise.resolve(jsonResponse({ conversationId: document.conversationId }));
  }

  if (pathname === "/api/knowledge-documents/uploads/request-url" && method === "POST") {
    const upload = body as { fileName?: string; byteSize?: number } | undefined;
    if (!upload?.fileName || !upload.byteSize) {
      return Promise.resolve(jsonResponse({ error: "Invalid file metadata." }, 400));
    }
    generatedDocumentId += 1;
    const id = `b3333333-3333-4333-8333-${generatedDocumentId.toString().padStart(12, "0")}`;
    const extension = upload.fileName.split(".").pop()?.toLowerCase();
    const contentType = extension === "txt"
      ? "text/plain"
      : extension === "csv"
        ? "text/csv"
        : "application/pdf";
    const document: KnowledgeFixtureDocument = {
      id,
      fileName: upload.fileName,
      contentType,
      byteSize: upload.byteSize,
      isPinned: false,
      status: "pending_upload",
      conversationId: null,
      createdAt: new Date().toISOString(),
    };
    fixtureDocuments = [document, ...fixtureDocuments];
    return Promise.resolve(jsonResponse({
      document,
      uploadUrl: `https://uploads.test/${id}`,
    }, 201));
  }

  if (new URL(requestUrl, window.location.origin).hostname === "uploads.test" && method === "PUT") {
    const documentId = pathname.slice(1);
    const bytes = init?.body instanceof Blob
      ? init.body
      : new Blob([String(init?.body ?? "")]);
    fixtureDocumentBytes.set(documentId, bytes);
    return Promise.resolve(new Response(null, { status: 200 }));
  }

  const completeDocumentMatch = pathname.match(/^\/api\/knowledge-documents\/([^/]+)\/complete$/);
  if (completeDocumentMatch && method === "POST") {
    const document = fixtureDocuments.find((item) => item.id === completeDocumentMatch[1]);
    if (!document || !fixtureDocumentBytes.has(document.id)) {
      return Promise.resolve(jsonResponse({ error: "Document upload not found." }, 404));
    }
    const readyDocument = { ...document, status: "ready" as const, conversationId: documentConversationId };
    fixtureDocuments = fixtureDocuments.map((item) => item.id === document.id ? readyDocument : item);
    return Promise.resolve(jsonResponse(readyDocument));
  }

  const documentContentMatch = pathname.match(/^\/api\/knowledge-documents\/([^/]+)\/content$/);
  if (documentContentMatch && method === "GET") {
    const document = fixtureDocuments.find((item) => item.id === documentContentMatch[1]);
    const content = fixtureDocumentBytes.get(documentContentMatch[1]);
    if (!document || !content || document.status !== "ready") {
      return Promise.resolve(jsonResponse({ error: "Document not found." }, 404));
    }
    return Promise.resolve(new Response(content, {
      status: 200,
      headers: { "Content-Type": document.contentType },
    }));
  }

  const pinDocumentMatch = pathname.match(/^\/api\/knowledge-documents\/([^/]+)\/pin$/);
  if (pinDocumentMatch && method === "PATCH") {
    const document = fixtureDocuments.find((item) => item.id === pinDocumentMatch[1]);
    const pinBody = body as { isPinned?: boolean } | undefined;
    if (!document || typeof pinBody?.isPinned !== "boolean") {
      return Promise.resolve(jsonResponse({ error: "Document not found." }, 404));
    }
    const updatedDocument = { ...document, isPinned: pinBody.isPinned };
    fixtureDocuments = fixtureDocuments.map((item) => item.id === document.id ? updatedDocument : item);
    return Promise.resolve(jsonResponse(updatedDocument));
  }

  const deleteDocumentMatch = pathname.match(/^\/api\/knowledge-documents\/([^/]+)$/);
  if (deleteDocumentMatch && method === "DELETE") {
    fixtureDocuments = fixtureDocuments.filter((item) => item.id !== deleteDocumentMatch[1]);
    fixtureDocumentBytes.delete(deleteDocumentMatch[1]);
    return Promise.resolve(new Response(null, { status: 204 }));
  }

  const renameMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (renameMatch && method === "PATCH") {
    const renameBody = body as { title?: string } | undefined;
    const renamed = fixtureConversations.find((item) => item.id === renameMatch[1]);
    if (!renamed || !renameBody?.title) return Promise.resolve(jsonResponse({ error: "Conversation not found." }, 404));
    const updated = { ...renamed, title: renameBody.title, updatedAt: new Date().toISOString() };
    fixtureConversations = fixtureConversations.map((item) => item.id === updated.id ? updated : item);
    return Promise.resolve(jsonResponse(updated));
  }

  const messagesMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messagesMatch && method === "GET") {
    return Promise.resolve(jsonResponse({ items: fixtureMessages.get(messagesMatch[1]) ?? [] }));
  }

  if (pathname === "/api/guest-chat" && method === "POST") {
    guestRequestCount += 1;
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
    if (params.get("fail") === "1" && guestRequestCount === 1) {
      return Promise.resolve(eventStreamResponse([
        { type: "delta", content: "A partial answer that should stay visible." },
        { type: "error", error: "The test stream was interrupted." },
      ]));
    }
    if (params.get("slow") === "1") {
      const signal = init?.signal;
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", content: "This text arrived before stop." })}\n\n`));
          const timer = window.setTimeout(() => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", content: `A helpful reply to: ${content}` })}\n\n`));
            controller.close();
          }, 30_000);
          signal?.addEventListener("abort", () => {
            window.clearTimeout(timer);
            controller.error(new DOMException("The stream was aborted.", "AbortError"));
          }, { once: true });
        },
      }), {
        status: 201,
        headers: { "Content-Type": "text/event-stream" },
      }));
    }
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

class FixtureXMLHttpRequest {
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = "";
  private method = "GET";
  private url = "";
  private requestHeaders: Record<string, string> = {};
  private responseHeaders = new Headers();

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }
  getResponseHeader(name: string) {
    return this.responseHeaders.get(name);
  }
  send(body?: XMLHttpRequestBodyInit | Document | null) {
    const total = body instanceof FormData ? body.entries().next().done === false ? 1024 : 1 : 1;
    const delayedUpload = body instanceof FormData &&
      new URLSearchParams(window.location.search).get("slowUpload") === "1";
    this.upload.onprogress?.(new ProgressEvent("progress", {
      lengthComputable: true,
      loaded: delayedUpload ? Math.floor(total / 2) : total,
      total,
    }));
    const completeRequest = () => {
      void window.fetch(this.url, {
        method: this.method,
        headers: this.requestHeaders,
        body: body as BodyInit | null | undefined,
      }).then(async (response) => {
        this.status = response.status;
        this.responseHeaders = response.headers;
        this.responseText = await response.text();
        this.onprogress?.();
        this.onload?.();
      }).catch(() => this.onerror?.());
    };
    if (delayedUpload) window.setTimeout(completeRequest, 450);
    else completeRequest();
  }
  abort() {
    this.onabort?.();
  }
}
window.XMLHttpRequest = FixtureXMLHttpRequest as unknown as typeof XMLHttpRequest;

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
