import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import {
  getListConversationMessagesQueryKey,
  getListConversationsQueryKey,
  useDeleteConversation,
  useImportGuestConversation,
  useListConversationMessages,
  useListConversations,
} from "@workspace/api-client-react";
import type { Conversation, GuestChatMessage, Message } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, Clock3, Menu, MessageSquare, Plus, Sparkles, Trash2, X } from "lucide-react";
import { Link } from "wouter";
import { AccountActions } from "./account-actions";
import { requestChatStream } from "./lib/chat-stream";

type Mode = "guest" | "account";
type LocalConversation = {
  id: string;
  title: string;
  messages: GuestChatMessage[];
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = "easy-peasy-docs:guest-conversations:v1";
const GUEST_IMPORT_STORAGE_KEY = "easy-peasy-docs:pending-account-import:v1";
const MAX_MESSAGE_CHARS = 6000;
const MAX_MESSAGES = 32;
const MAX_TOTAL_CHARS = 20_000;
const HISTORY_PAGE_SIZE = 8;

function localId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
        const value = Math.floor(Math.random() * 16);
        return (character === "x" ? value : (value & 0x3) | 0x8).toString(16);
      });
}

function newLocalConversation(): LocalConversation {
  const now = Date.now();
  return { id: localId(), title: "New chat", messages: [], createdAt: now, updatedAt: now };
}

function newAccountDraft(): Conversation {
  const now = new Date().toISOString();
  return { id: localId(), title: "New chat", createdAt: now, updatedAt: now };
}

function readLocalConversations(): LocalConversation[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is LocalConversation => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as LocalConversation;
      return typeof candidate.id === "string" && typeof candidate.title === "string" &&
        typeof candidate.createdAt === "number" && typeof candidate.updatedAt === "number" &&
        Array.isArray(candidate.messages) && candidate.messages.length > 0 && candidate.messages.every((message) =>
          message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string");
    });
  } catch {
    return [];
  }
}

function readPendingGuestImport(): {
  id: string;
  title: string;
  messages: GuestChatMessage[];
} | null {
  const raw = sessionStorage.getItem(GUEST_IMPORT_STORAGE_KEY);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") {
    throw new Error("The conversation could not be prepared for your account.");
  }
  const candidate = value as {
    id?: unknown;
    title?: unknown;
    messages?: unknown;
  };
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.title !== "string" ||
    !Array.isArray(candidate.messages) ||
    candidate.messages.length === 0 ||
    !candidate.messages.every((message) =>
      message &&
      typeof message === "object" &&
      ((message as GuestChatMessage).role === "user" ||
        (message as GuestChatMessage).role === "assistant") &&
      typeof (message as GuestChatMessage).content === "string",
    )
  ) {
    throw new Error("The conversation could not be prepared for your account.");
  }
  return {
    id: candidate.id,
    title: candidate.title,
    messages: candidate.messages as GuestChatMessage[],
  };
}

function makeTitle(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 42 ? `${normalized.slice(0, 41).trimEnd()}…` : normalized || "New chat";
}

function displayDate(value: number | string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function requestHistory(messages: GuestChatMessage[]) {
  const selected: GuestChatMessage[] = [];
  let size = 0;
  for (let index = messages.length - 1; index >= 0 && selected.length < MAX_MESSAGES; index -= 1) {
    const message = messages[index];
    if (message.content.length > MAX_MESSAGE_CHARS || size + message.content.length > MAX_TOTAL_CHARS) break;
    selected.unshift(message);
    size += message.content.length;
  }
  return selected;
}

export function ChatWorkspace({ mode }: { mode: Mode }) {
  const isGuest = mode === "guest";
  const queryClient = useQueryClient();
  const conversationsQuery = useListConversations({ query: { enabled: !isGuest, queryKey: getListConversationsQueryKey() } });
  const deleteConversation = useDeleteConversation();
  const guestImportMutation = useImportGuestConversation();
  const [guestConversations, setGuestConversations] = useState<LocalConversation[]>(() => {
    const stored = readLocalConversations();
    return stored.length ? stored : [newLocalConversation()];
  });
  const [guestSelectedId, setGuestSelectedId] = useState(() => readLocalConversations()[0]?.id ?? "");
  const [accountSelectedId, setAccountSelectedId] = useState<string | null>(null);
  const [accountDraft, setAccountDraft] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const [visibleHistoryCount, setVisibleHistoryCount] = useState(HISTORY_PAGE_SIZE);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const [guestSendingIds, setGuestSendingIds] = useState<string[]>([]);
  const [guestStreamReplies, setGuestStreamReplies] = useState<Record<string, string>>({});
  const [accountPendingTurn, setAccountPendingTurn] = useState<{
    conversationId: string;
    content: string;
    reply: string;
  } | null>(null);
  const [guestErrors, setGuestErrors] = useState<Record<string, string>>({});
  const [accountError, setAccountError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [guestImportError, setGuestImportError] = useState("");
  const [isImportingGuest, setIsImportingGuest] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const guestControllersRef = useRef(new Map<string, AbortController>());
  const accountControllerRef = useRef<AbortController | null>(null);
  const guestImportAttemptedRef = useRef(false);

  const accountConversations = conversationsQuery.data?.items ?? [];
  const sortedGuestConversations = useMemo(
    () => guestConversations
      .filter((chat) => chat.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [guestConversations],
  );
  const sortedAccountConversations = useMemo(
    () => [...accountConversations].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [accountConversations],
  );
  const selectedId = isGuest ? guestSelectedId : accountSelectedId;
  const activeGuest = guestConversations.find((chat) => chat.id === guestSelectedId) ?? null;
  const activeAccount = accountConversations.find((chat) => chat.id === accountSelectedId) ??
    (accountDraft?.id === accountSelectedId ? accountDraft : null);
  const activeAccountId = activeAccount?.id ?? "";
  const isAccountDraft = !isGuest &&
    !!activeAccount &&
    !accountConversations.some((chat) => chat.id === activeAccount.id);
  const accountMessagesQuery = useListConversationMessages(activeAccountId, {
    query: { enabled: !isGuest && !!activeAccountId && !isAccountDraft, queryKey: getListConversationMessagesQueryKey(activeAccountId) },
  });
  const accountMessages = accountMessagesQuery.data?.items ?? [];
  const messages: (GuestChatMessage | Message)[] = isGuest
    ? (activeGuest?.messages ?? [])
    : isAccountDraft ? [] : accountMessages;
  const isSending = isGuest ? guestSendingIds.includes(guestSelectedId) : accountPendingTurn !== null;
  const currentError = isGuest ? guestErrors[guestSelectedId] : accountError;
  const isEmpty = messages.length === 0 && !(accountPendingTurn?.conversationId === activeAccountId);
  const sidebarExpanded = isMobileViewport ? mobileSidebarOpen : !desktopSidebarCollapsed;
  const streamingText = isGuest
    ? guestStreamReplies[guestSelectedId] ?? ""
    : accountPendingTurn?.conversationId === activeAccountId
      ? accountPendingTurn.reply
      : "";

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(guestConversations.filter((chat) => chat.messages.length > 0)),
      );
    } catch {
      // Keep the in-memory history usable when browser storage is unavailable.
    }
  }, [guestConversations]);

  async function importPendingGuestConversation() {
    setGuestImportError("");
    setIsImportingGuest(true);
    try {
      const pending = readPendingGuestImport();
      if (!pending) return;
      const conversation = await guestImportMutation.mutateAsync({ data: pending });
      queryClient.setQueryData(
        getListConversationsQueryKey(),
        (current: { items: Conversation[] } | undefined) => ({
          items: [
            conversation,
            ...(current?.items ?? []).filter((item) => item.id !== conversation.id),
          ],
        }),
      );
      try {
        sessionStorage.removeItem(GUEST_IMPORT_STORAGE_KEY);
      } catch {
        // The server import is idempotent if session storage cannot be cleared.
      }
      setAccountDraft(null);
      setAccountSelectedId(conversation.id);
      await queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
    } catch (error) {
      setGuestImportError(
        error instanceof Error && error.message
          ? error.message
          : "This conversation could not be copied to your account.",
      );
    } finally {
      setIsImportingGuest(false);
    }
  }

  useEffect(() => {
    if (isGuest || guestImportAttemptedRef.current) return;
    try {
      if (!sessionStorage.getItem(GUEST_IMPORT_STORAGE_KEY)) return;
    } catch {
      setGuestImportError("This conversation could not be copied to your account.");
      return;
    }
    guestImportAttemptedRef.current = true;
    void importPendingGuestConversation();
  }, [isGuest]);

  useEffect(() => () => {
    guestControllersRef.current.forEach((controller) => controller.abort());
    accountControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const updateViewport = () => {
      setIsMobileViewport(media.matches);
      setMobileSidebarOpen(false);
    };
    updateViewport();
    media.addEventListener("change", updateViewport);
    return () => media.removeEventListener("change", updateViewport);
  }, []);

  useEffect(() => {
    if (isGuest && !guestConversations.some((chat) => chat.id === guestSelectedId)) {
      setGuestSelectedId(guestConversations[0]?.id ?? "");
    }
  }, [isGuest, guestConversations, guestSelectedId]);

  useEffect(() => {
    if (!isGuest && !accountSelectedId && accountConversations.length) {
      setAccountSelectedId(accountConversations[0].id);
    }
  }, [isGuest, accountSelectedId, accountConversations]);

  useEffect(() => {
    if (messages.length || accountPendingTurn?.conversationId === activeAccountId) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages.length, selectedId, isSending, streamingText, accountPendingTurn, activeAccountId]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [draft]);

  function makeNewChat() {
    setWorkspaceError("");
    setAccountError("");
    if (isGuest) {
      const next = newLocalConversation();
      setGuestConversations((items) => [next, ...items]);
      setGuestSelectedId(next.id);
    } else {
      const next = newAccountDraft();
      setAccountDraft(next);
      setAccountSelectedId(next.id);
    }
    setDraft("");
    setMobileSidebarOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function toggleSidebar() {
    if (isMobileViewport) {
      setMobileSidebarOpen((open) => !open);
      return;
    }
    setDesktopSidebarCollapsed((collapsed) => !collapsed);
  }

  async function removeChat(chat: LocalConversation | Conversation) {
    if (isGuest) {
      const guestChat = chat as LocalConversation;
      setGuestConversations((items) => items.filter((item) => item.id !== guestChat.id));
      if (guestSelectedId === guestChat.id) {
        const next = sortedGuestConversations.find((item) => item.id !== guestChat.id) ?? newLocalConversation();
        setGuestConversations((items) => items.some((item) => item.id === next.id) ? items : [next, ...items]);
        setGuestSelectedId(next.id);
        setDraft("");
      }
      return;
    }
    const conversation = chat as Conversation;
    if (!window.confirm("Delete this conversation and its messages?")) return;
    setDeletingId(conversation.id);
    setWorkspaceError("");
    try {
      await deleteConversation.mutateAsync({ conversationId: conversation.id });
      const remaining = accountConversations.filter((item) => item.id !== conversation.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() }),
        queryClient.removeQueries({ queryKey: getListConversationMessagesQueryKey(conversation.id) }),
      ]);
      if (accountSelectedId === conversation.id) {
        setAccountSelectedId(remaining[0]?.id ?? null);
        setDraft("");
      }
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "This chat could not be deleted.");
    } finally {
      setDeletingId("");
    }
  }

  async function sendGuest(chatId: string, history: GuestChatMessage[]) {
    setGuestErrors((errors) => ({ ...errors, [chatId]: "" }));
    setGuestSendingIds((ids) => ids.includes(chatId) ? ids : [...ids, chatId]);
    const controller = new AbortController();
    guestControllersRef.current.set(chatId, controller);
    setGuestStreamReplies((replies) => ({ ...replies, [chatId]: "" }));
    try {
      const response = await requestChatStream(
        "/api/guest-chat",
        { messages: requestHistory(history) },
        (delta) => setGuestStreamReplies((replies) => ({
          ...replies,
          [chatId]: (replies[chatId] ?? "") + delta,
        })),
        controller.signal,
      );
      const content = response.content.trim();
      if (!content) throw new Error("No response came back. Please try again.");
      setGuestConversations((items) => items.map((chat) => chat.id === chatId
        ? { ...chat, messages: [...chat.messages, { role: "assistant", content }], updatedAt: Date.now() }
        : chat));
    } catch (cause) {
      const latestUserText = history[history.length - 1]?.role === "user" ? history[history.length - 1].content : "";
      setGuestErrors((errors) => ({ ...errors, [chatId]: cause instanceof Error && cause.message ? cause.message : "That message did not send. Please try again." }));
      if (chatId === guestSelectedId) setDraft((current) => current || latestUserText);
    } finally {
      if (guestControllersRef.current.get(chatId) === controller) {
        guestControllersRef.current.delete(chatId);
      }
      setGuestStreamReplies((replies) => {
        const next = { ...replies };
        delete next[chatId];
        return next;
      });
      setGuestSendingIds((ids) => ids.filter((id) => id !== chatId));
    }
  }

  function prepareGuestAccountFlow(event: MouseEvent<HTMLAnchorElement>) {
    if (!activeGuest) {
      event.preventDefault();
      setWorkspaceError("This conversation could not be prepared for your account.");
      return;
    }
    try {
      sessionStorage.setItem(
        GUEST_IMPORT_STORAGE_KEY,
        JSON.stringify({
          id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(activeGuest.id)
            ? activeGuest.id
            : localId(),
          title: activeGuest.title,
          messages: activeGuest.messages,
        }),
      );
    } catch {
      event.preventDefault();
      setWorkspaceError("This conversation could not be prepared for your account.");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || isSending || content.length > MAX_MESSAGE_CHARS) return;
    if (isGuest) {
      if (!activeGuest) return;
      const nextMessages: GuestChatMessage[] = [...activeGuest.messages, { role: "user", content }];
      setGuestConversations((items) => items.map((chat) => chat.id === activeGuest.id
        ? { ...chat, title: chat.messages.length ? chat.title : makeTitle(content), messages: nextMessages, updatedAt: Date.now() }
        : chat));
      setDraft("");
      void sendGuest(activeGuest.id, nextMessages);
      return;
    }
    if (!activeAccount) {
      setWorkspaceError("Start a new chat before sending a message.");
      return;
    }
    setAccountError("");
    const controller = new AbortController();
    accountControllerRef.current = controller;
    setAccountPendingTurn({ conversationId: activeAccount.id, content, reply: "" });
    try {
      const response = await requestChatStream(
        `/api/conversations/${activeAccount.id}/chat`,
        { content, createIfMissing: isAccountDraft },
        (delta) => setAccountPendingTurn((turn) =>
          turn?.conversationId === activeAccount.id
            ? { ...turn, reply: turn.reply + delta }
            : turn),
        controller.signal,
      );
      if (!Array.isArray(response.items) || response.items.length < 2) {
        throw new Error("The completed reply could not be loaded. Please try again.");
      }
      queryClient.setQueryData(getListConversationMessagesQueryKey(activeAccount.id), {
        items: response.items as Message[],
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListConversationMessagesQueryKey(activeAccount.id) }),
        queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() }),
      ]);
      if (isAccountDraft) setAccountDraft(null);
      setDraft("");
    } catch (cause) {
      setAccountError(cause instanceof Error && cause.message ? cause.message : "Your message could not be sent. Your draft is still here.");
      void queryClient.invalidateQueries({
        queryKey: getListConversationMessagesQueryKey(activeAccount.id),
      });
    } finally {
      if (accountControllerRef.current === controller) {
        accountControllerRef.current = null;
      }
      setAccountPendingTurn(null);
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function selectChat(id: string) {
    if (isGuest) {
      setGuestSelectedId(id);
      setGuestErrors((errors) => ({ ...errors, [id]: "" }));
    } else {
      setAccountSelectedId(id);
      setAccountError("");
    }
    setDraft("");
    setMobileSidebarOpen(false);
  }

  const guestSorted = sortedGuestConversations;
  const accountSorted = sortedAccountConversations;
  const accountLoading = !isGuest && conversationsQuery.isLoading;
  const activeTitle = isGuest ? activeGuest?.title : activeAccount?.title;
  const guestUserMessageCount = activeGuest?.messages.filter((message) => message.role === "user").length ?? 0;
  const historyItems = isGuest ? guestSorted : accountSorted;

  return (
    <main className={`chat-app ${mobileSidebarOpen ? "sidebar-open" : ""} ${desktopSidebarCollapsed && !isMobileViewport ? "sidebar-collapsed" : ""}`}>
      <aside
        id="chat-sidebar"
        className="chat-sidebar"
        aria-label="Chat navigation"
        aria-hidden={!sidebarExpanded}
        inert={!sidebarExpanded}
      >
        <div className="chat-brand-row">
          <button type="button" className="chat-brand" onClick={makeNewChat} aria-label="Easy Peasy Docs home" data-testid="button-brand-home">
            <span className="chat-brand-icon"><Sparkles size={17} strokeWidth={1.7} /></span>
            <span>Easy Peasy <b>Docs</b></span>
          </button>
          <button type="button" className="chat-sidebar-close" onClick={() => setMobileSidebarOpen(false)} aria-label="Close sidebar"><X size={17} /></button>
        </div>
        <button type="button" className="chat-new-button" onClick={makeNewChat} data-testid="button-new-chat">
          <Plus size={16} />
          <span>New chat</span>
        </button>
        <div className="chat-history-label"><span>RECENT</span><span>{historyItems.length}</span></div>
        <div className="chat-history-list" data-testid="list-conversations">
          {accountLoading ? (
            <div className="history-skeleton" role="status" aria-label="Loading conversations"><i /><i /><i /></div>
          ) : !isGuest && conversationsQuery.isError ? (
            <div className="history-error" role="alert">
              <span>Chats couldn’t load.</span>
              <button type="button" onClick={() => void conversationsQuery.refetch()}>Try again</button>
            </div>
          ) : historyItems.length ? (
            <>
              {historyItems.slice(0, visibleHistoryCount).map((chat) => (
                <div className={`history-row ${chat.id === selectedId ? "is-current" : ""}`} key={chat.id}>
                  <button type="button" className="history-select" onClick={() => selectChat(chat.id)} data-testid={`button-select-chat-${chat.id}`}>
                    <MessageSquare size={15} strokeWidth={1.7} />
                    <span className="history-chat-name">{chat.title || "New chat"}</span>
                  </button>
                  <button type="button" className="history-delete" aria-label={`Delete ${chat.title || "chat"}`} onClick={() => void removeChat(chat)} disabled={deletingId === chat.id} data-testid={`button-delete-chat-${chat.id}`}>
                    {deletingId === chat.id ? <span className="mini-loader" /> : <Trash2 size={14} />}
                  </button>
                </div>
              ))}
              {historyItems.length > visibleHistoryCount && (
                <button
                  type="button"
                  className="history-see-more"
                  onClick={() => setVisibleHistoryCount((count) => count + HISTORY_PAGE_SIZE)}
                  data-testid="button-see-more-history"
                >
                  See more
                </button>
              )}
            </>
          ) : (
            <div className="history-blank">
              <Clock3 size={16} />
              <p>No chats yet</p>
              <span>Start a new conversation when you’re ready.</span>
            </div>
          )}
        </div>
        {(workspaceError || (!isGuest && conversationsQuery.isError)) && workspaceError && <div className="workspace-alert" role="alert">{workspaceError}</div>}
        <div className="chat-sidebar-bottom">
          {isGuest ? <div className="local-save"><Check size={13} /><span>History saved in this browser</span></div> : <div className="account-save"><span className="account-avatar">EP</span><span>Personal space</span></div>}
          <AccountActions />
        </div>
      </aside>
      {mobileSidebarOpen && <button type="button" className="chat-scrim" aria-label="Close navigation" onClick={() => setMobileSidebarOpen(false)} />}

      <section className="chat-main" aria-label="Conversation">
        <header className="chat-topbar">
          <button
            type="button"
            className="sidebar-toggle-button"
            onClick={toggleSidebar}
            aria-label={isMobileViewport
              ? mobileSidebarOpen ? "Close chat navigation" : "Open chat navigation"
              : desktopSidebarCollapsed ? "Expand chat sidebar" : "Collapse chat sidebar"}
            aria-controls="chat-sidebar"
            aria-expanded={sidebarExpanded}
            data-testid="button-toggle-sidebar"
          >
            <Menu size={19} />
          </button>
          <div className="chat-top-title">
            <span className="chat-presence"><span /> Easy Peasy</span>
            <span className="top-title-divider">/</span>
            <span className="top-chat-title">{activeTitle || "New chat"}</span>
          </div>
          <button type="button" className="top-new-button" onClick={makeNewChat} aria-label="Start a new chat" data-testid="button-new-chat-top"><Plus size={17} /></button>
        </header>

        <div className={`chat-scroll-area ${isEmpty ? "is-empty" : ""}`} data-testid="content-chat-messages">
          {!isGuest && !activeAccount && !accountLoading ? (
            <div className="chat-welcome" data-testid="content-chat-welcome">
              <div className="welcome-mark"><Sparkles size={19} strokeWidth={1.65} /></div>
              <p className="welcome-kicker">A SPACE TO THINK</p>
              <h1>What’s on<br />your mind?</h1>
              <p className="welcome-subtitle">Ask a question, work through an idea, or start anywhere.</p>
              <button type="button" className="welcome-new-button" onClick={makeNewChat}>
                <Plus size={15} /> Start a new chat
              </button>
            </div>
          ) : !isGuest && accountMessagesQuery.isError && !accountMessagesQuery.data ? (
            <div className="chat-fetch-error" role="alert">
              <p>This chat couldn’t be opened.</p>
              <span>Your conversation is still saved.</span>
              <button type="button" onClick={() => void accountMessagesQuery.refetch()}>Reload messages</button>
            </div>
          ) : accountLoading || (!isGuest && accountMessagesQuery.isLoading) ? (
            <div className="messages-loading" role="status" aria-label="Loading chat messages"><i /><i /><i /></div>
          ) : isEmpty ? (
            <div className="chat-welcome" data-testid="content-chat-welcome">
              <div className="welcome-mark"><Sparkles size={19} strokeWidth={1.65} /></div>
              <p className="welcome-kicker">A SPACE TO THINK</p>
              <h1>What’s on<br />your mind?</h1>
              <p className="welcome-subtitle">Ask a question, work through an idea, or start anywhere.</p>
            </div>
          ) : (
            <div className="message-thread">
              {messages.map((message, index) => (
                <MessageView key={"id" in message ? message.id : `${selectedId}-${index}`} message={message} index={index} />
              ))}
              {isGuest && guestSendingIds.includes(guestSelectedId) && guestStreamReplies[guestSelectedId] && (
                <MessageView
                  key={`${guestSelectedId}-streaming`}
                  message={{ role: "assistant", content: guestStreamReplies[guestSelectedId] }}
                  index={messages.length}
                />
              )}
              {!isGuest && accountPendingTurn?.conversationId === activeAccountId && (
                <>
                  <MessageView
                    key={`${activeAccountId}-pending-user`}
                    message={{ role: "user", content: accountPendingTurn.content }}
                    index={messages.length}
                  />
                  {accountPendingTurn.reply ? (
                    <MessageView
                      key={`${activeAccountId}-streaming`}
                      message={{ role: "assistant", content: accountPendingTurn.reply }}
                      index={messages.length + 1}
                    />
                  ) : (
                    <div className="assistant-loading" role="status"><span className="assistant-mark"><Sparkles size={14} /></span><div className="thinking-indicator"><i /><i /><i /><span>Thinking</span></div></div>
                  )}
                </>
              )}
              {isGuest && isSending && !guestStreamReplies[guestSelectedId] && (
                <div className="assistant-loading" role="status"><span className="assistant-mark"><Sparkles size={14} /></span><div className="thinking-indicator"><i /><i /><i /><span>Thinking</span></div></div>
              )}
              {isGuest && guestUserMessageCount >= 3 && !isSending && (
                <section className="guest-account-prompt" aria-label="Keep this conversation in your account" data-testid="guest-account-prompt">
                  <div>
                    <strong>Keep this conversation in your account</strong>
                    <span>Sign in or create an account to copy this chat.</span>
                  </div>
                  <div className="guest-account-prompt-actions">
                    <Link href="/sign-in" onClick={prepareGuestAccountFlow} data-testid="link-import-sign-in">Sign in</Link>
                    <Link href="/sign-up" onClick={prepareGuestAccountFlow} data-testid="link-import-sign-up">Create account</Link>
                  </div>
                </section>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <div className="composer-dock">
          {guestImportError && <div className="chat-error" role="alert" data-testid="status-import-error">
            <span>{guestImportError}</span>
            <button type="button" onClick={() => void importPendingGuestConversation()} disabled={isImportingGuest} data-testid="button-retry-import">
              {isImportingGuest ? <span className="mini-loader" /> : "Try again"}
            </button>
            <button type="button" aria-label="Dismiss import error" onClick={() => setGuestImportError("")}><X size={14} /></button>
          </div>}
          {currentError && <div className="chat-error" role="alert" data-testid="status-chat-error">
            <span>{currentError}</span>
            {isGuest && activeGuest?.messages.at(-1)?.role === "user" && <button type="button" onClick={() => void sendGuest(activeGuest.id, activeGuest.messages)} disabled={isSending} data-testid="button-retry-message">Try again</button>}
            <button type="button" aria-label="Dismiss error" onClick={() => isGuest ? setGuestErrors((errors) => ({ ...errors, [guestSelectedId]: "" })) : setAccountError("")}><X size={14} /></button>
          </div>}
          <form className="message-composer" onSubmit={(event) => void submit(event)} data-testid="form-chat-composer">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value.slice(0, MAX_MESSAGE_CHARS));
                if (isGuest) setGuestErrors((errors) => ({ ...errors, [guestSelectedId]: "" }));
                else setAccountError("");
              }}
              onKeyDown={onComposerKeyDown}
              rows={1}
              maxLength={MAX_MESSAGE_CHARS}
              placeholder="Message Easy Peasy..."
              aria-label="Write a message"
              disabled={isSending || (!isGuest && !activeAccount)}
              data-testid="input-chat-message"
            />
            <div className="composer-controls">
              <span>{draft.length > MAX_MESSAGE_CHARS - 500 ? `${draft.length.toLocaleString()} / ${MAX_MESSAGE_CHARS.toLocaleString()}` : "Enter to send · Shift + Enter for a new line"}</span>
              <button type="submit" disabled={!draft.trim() || isSending || (!isGuest && !activeAccount)} aria-label="Send message" data-testid="button-send-message">
                {isSending ? <span className="send-loader" /> : <ArrowUp size={18} strokeWidth={2.2} />}
              </button>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}

function MessageView({ message, index }: { message: GuestChatMessage | Message; index: number }) {
  const isUser = message.role === "user";
  return (
    <article className={`thread-message ${isUser ? "thread-user" : "thread-assistant"}`} data-testid={`content-message-${message.role}-${index}`}>
      {!isUser && <span className="assistant-mark"><Sparkles size={14} strokeWidth={1.8} /></span>}
      <div className="thread-content">
        <div className="thread-role">{isUser ? "You" : "Easy Peasy"}</div>
        <div className="thread-text">{isUser ? <p>{message.content}</p> : <SafeMarkdown content={message.content} />}</div>
      </div>
    </article>
  );
}

function inlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const tokenPattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const inner = token.slice(token.startsWith("**") || token.startsWith("__") ? 2 : 1, - (token.startsWith("**") || token.startsWith("__") ? 2 : 1));
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith("**") || token.startsWith("__")) nodes.push(<strong key={key}>{inner}</strong>);
    else if (token.startsWith("`")) nodes.push(<code key={key}>{inner}</code>);
    else nodes.push(<em key={key}>{inner}</em>);
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function SafeMarkdown({ content }: { content: string }) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(<p key={`p-${blocks.length}`}>{paragraph.map((line, index) => <span key={index}>{index > 0 && <br />}{inlineMarkdown(line, `p-${blocks.length}-${index}`)}</span>)}</p>);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (!list) return;
    const ListTag = list.ordered ? "ol" : "ul";
    blocks.push(<ListTag key={`list-${blocks.length}`}>{list.items.map((item, index) => <li key={index}>{inlineMarkdown(item, `list-${blocks.length}-${index}`)}</li>)}</ListTag>);
    list = null;
  };
  lines.forEach((line) => {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (!line.trim()) { flushParagraph(); flushList(); return; }
    if (heading) {
      flushParagraph(); flushList();
      const Heading = `h${heading[1].length}` as "h1" | "h2" | "h3";
      blocks.push(<Heading key={`h-${blocks.length}`}>{inlineMarkdown(heading[2], `h-${blocks.length}`)}</Heading>);
      return;
    }
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = !!ordered;
      const item = (bullet ?? ordered)![1];
      if (!list || list.ordered !== isOrdered) { flushList(); list = { ordered: isOrdered, items: [] }; }
      list.items.push(item);
      return;
    }
    flushList();
    paragraph.push(line);
  });
  flushParagraph();
  flushList();
  return <div className="safe-markdown">{blocks}</div>;
}
