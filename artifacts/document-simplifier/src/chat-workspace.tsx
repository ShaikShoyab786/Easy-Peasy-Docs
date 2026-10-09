import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  getListConversationMessagesQueryKey,
  getListConversationsQueryKey,
  useCreateConversation,
  useDeleteConversation,
  useListConversationMessages,
  useListConversations,
  useSendConversationChatTurn,
  useSendGuestChatTurn,
} from "@workspace/api-client-react";
import type { Conversation, GuestChatMessage, Message } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, Clock3, Menu, MessageSquare, Plus, Sparkles, Trash2, X } from "lucide-react";
import { AccountActions } from "./account-actions";

type Mode = "guest" | "account";
type LocalConversation = {
  id: string;
  title: string;
  messages: GuestChatMessage[];
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = "easy-peasy-docs:guest-conversations:v1";
const MAX_MESSAGE_CHARS = 6000;
const MAX_MESSAGES = 32;
const MAX_TOTAL_CHARS = 20_000;

function localId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function newLocalConversation(): LocalConversation {
  const now = Date.now();
  return { id: localId(), title: "New chat", messages: [], createdAt: now, updatedAt: now };
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
        Array.isArray(candidate.messages) && candidate.messages.every((message) =>
          message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string");
    });
  } catch {
    return [];
  }
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
  const guestMutation = useSendGuestChatTurn();
  const conversationsQuery = useListConversations({ query: { enabled: !isGuest, queryKey: getListConversationsQueryKey() } });
  const createConversation = useCreateConversation();
  const deleteConversation = useDeleteConversation();
  const sendTurn = useSendConversationChatTurn();
  const [guestConversations, setGuestConversations] = useState<LocalConversation[]>(() => {
    const stored = readLocalConversations();
    return stored.length ? stored : [newLocalConversation()];
  });
  const [guestSelectedId, setGuestSelectedId] = useState(() => readLocalConversations()[0]?.id ?? "");
  const [accountSelectedId, setAccountSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const [guestSendingIds, setGuestSendingIds] = useState<string[]>([]);
  const [guestErrors, setGuestErrors] = useState<Record<string, string>>({});
  const [accountError, setAccountError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const accountConversations = conversationsQuery.data?.items ?? [];
  const sortedGuestConversations = useMemo(
    () => [...guestConversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [guestConversations],
  );
  const sortedAccountConversations = useMemo(
    () => [...accountConversations].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [accountConversations],
  );
  const selectedId = isGuest ? guestSelectedId : accountSelectedId;
  const activeGuest = guestConversations.find((chat) => chat.id === guestSelectedId) ?? null;
  const activeAccount = accountConversations.find((chat) => chat.id === accountSelectedId) ?? null;
  const activeAccountId = activeAccount?.id ?? "";
  const accountMessagesQuery = useListConversationMessages(activeAccountId, {
    query: { enabled: !isGuest && !!activeAccountId, queryKey: getListConversationMessagesQueryKey(activeAccountId) },
  });
  const accountMessages = accountMessagesQuery.data?.items ?? [];
  const messages: (GuestChatMessage | Message)[] = isGuest ? (activeGuest?.messages ?? []) : accountMessages;
  const isSending = isGuest ? guestSendingIds.includes(guestSelectedId) : sendTurn.isPending;
  const currentError = isGuest ? guestErrors[guestSelectedId] : accountError;
  const isEmpty = messages.length === 0;
  const sidebarExpanded = isMobileViewport ? mobileSidebarOpen : !desktopSidebarCollapsed;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(guestConversations));
    } catch {
      // Keep the in-memory history usable when browser storage is unavailable.
    }
  }, [guestConversations]);

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
    if (messages.length) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, selectedId, isSending]);

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
      void (async () => {
        try {
          const conversation = await createConversation.mutateAsync({ data: {} });
          await queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
          setAccountSelectedId(conversation.id);
        } catch (error) {
          setWorkspaceError(error instanceof Error ? error.message : "A new chat could not be created. Try again.");
        }
      })();
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
    try {
      const response = await guestMutation.mutateAsync({ data: { messages: requestHistory(history) } });
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
      setGuestSendingIds((ids) => ids.filter((id) => id !== chatId));
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
    try {
      const response = await sendTurn.mutateAsync({ conversationId: activeAccount.id, data: { content } });
      queryClient.setQueryData(getListConversationMessagesQueryKey(activeAccount.id), response);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListConversationMessagesQueryKey(activeAccount.id) }),
        queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() }),
      ]);
      setDraft("");
    } catch (cause) {
      setAccountError(cause instanceof Error && cause.message ? cause.message : "Your message could not be sent. Your draft is still here.");
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
        <button type="button" className="chat-new-button" onClick={makeNewChat} disabled={!isGuest && createConversation.isPending} data-testid="button-new-chat">
          {createConversation.isPending && !isGuest ? <span className="mini-loader" /> : <Plus size={16} />}
          <span>New chat</span>
        </button>
        <div className="chat-history-label"><span>RECENT</span><span>{isGuest ? guestSorted.length : accountSorted.length}</span></div>
        <div className="chat-history-list" data-testid="list-conversations">
          {accountLoading ? (
            <div className="history-skeleton" role="status" aria-label="Loading conversations"><i /><i /><i /></div>
          ) : !isGuest && conversationsQuery.isError ? (
            <div className="history-error" role="alert">
              <span>Chats couldn’t load.</span>
              <button type="button" onClick={() => void conversationsQuery.refetch()}>Try again</button>
            </div>
          ) : (isGuest ? guestSorted : accountSorted).length ? (
            (isGuest ? guestSorted : accountSorted).map((chat) => (
              <div className={`history-row ${chat.id === selectedId ? "is-current" : ""}`} key={chat.id}>
                <button type="button" className="history-select" onClick={() => selectChat(chat.id)} data-testid={`button-select-chat-${chat.id}`}>
                  <MessageSquare size={15} strokeWidth={1.7} />
                  <span className="history-chat-name">{chat.title || "New chat"}</span>
                </button>
                <button type="button" className="history-delete" aria-label={`Delete ${chat.title || "chat"}`} onClick={() => void removeChat(chat)} disabled={deletingId === chat.id} data-testid={`button-delete-chat-${chat.id}`}>
                  {deletingId === chat.id ? <span className="mini-loader" /> : <Trash2 size={14} />}
                </button>
              </div>
            ))
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
              <button type="button" className="welcome-new-button" onClick={makeNewChat} disabled={createConversation.isPending}>
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
              {isSending && <div className="assistant-loading" role="status"><span className="assistant-mark"><Sparkles size={14} /></span><div className="thinking-indicator"><i /><i /><i /><span>Thinking</span></div></div>}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <div className="composer-dock">
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
