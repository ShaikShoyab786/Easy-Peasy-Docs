import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useSendGuestChatTurn } from "@workspace/api-client-react";
import { ArrowDown, ArrowUp, Check, MessageSquare, Plus, Sparkles, Trash2, X } from "lucide-react";
import { AccountActions } from "./account-portal";

type GuestMessage = { role: "user" | "assistant"; content: string };
type GuestConversation = {
  id: string;
  title: string;
  messages: GuestMessage[];
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = "easy-peasy-docs:guest-conversations:v1";
const MAX_MESSAGES = 32;
const MAX_MESSAGE_CHARS = 6000;
const MAX_TOTAL_CHARS = 20_000;
const TITLE_LENGTH = 40;

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeConversation(): GuestConversation {
  const now = Date.now();
  return { id: makeId(), title: "New conversation", messages: [], createdAt: now, updatedAt: now };
}

function readConversations(): GuestConversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is GuestConversation =>
      !!item && typeof item === "object" &&
      typeof item.id === "string" && typeof item.title === "string" &&
      Array.isArray(item.messages) && item.messages.every((message: unknown) =>
        !!message && typeof message === "object" &&
        ((message as GuestMessage).role === "user" || (message as GuestMessage).role === "assistant") &&
        typeof (message as GuestMessage).content === "string"
      ) &&
      typeof item.createdAt === "number" && typeof item.updatedAt === "number"
    );
  } catch {
    return [];
  }
}

function requestHistory(messages: GuestMessage[]): GuestMessage[] {
  const selected: GuestMessage[] = [];
  let characters = 0;
  for (let index = messages.length - 1; index >= 0 && selected.length < MAX_MESSAGES; index -= 1) {
    const message = messages[index];
    if (message.content.length > MAX_MESSAGE_CHARS || characters + message.content.length > MAX_TOTAL_CHARS) break;
    selected.unshift(message);
    characters += message.content.length;
  }
  return selected;
}

function titleFromMessage(message: string) {
  const title = message.replace(/\s+/g, " ").trim();
  return title.length > TITLE_LENGTH ? `${title.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : title;
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function GuestChat() {
  const sendGuestChatTurn = useSendGuestChatTurn();
  const [conversations, setConversations] = useState<GuestConversation[]>(readConversations);
  const [activeId, setActiveId] = useState(() => readConversations()[0]?.id ?? "");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<{ chatId: string; message: string; retryable: boolean } | null>(null);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [sendingIds, setSendingIds] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chats = useMemo(() => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt), [conversations]);
  const activeChat = conversations.find((chat) => chat.id === activeId);
  const isSending = sendingIds.includes(activeId);
  const visibleError = error?.chatId === activeId ? error : null;

  useEffect(() => {
    if (!activeId && conversations.length) setActiveId(conversations[0].id);
    if (!conversations.length) {
      const initial = makeConversation();
      setConversations([initial]);
      setActiveId(initial.id);
    }
  }, [activeId, conversations]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch {
      // The conversation remains available in memory if browser storage is unavailable.
    }
  }, [conversations]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeChat?.messages, isSending]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [draft]);

  function createChat() {
    const next = makeConversation();
    setConversations((current) => [next, ...current]);
    setActiveId(next.id);
    setDraft("");
    setError(null);
    setMobileHistoryOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function deleteChat(id: string) {
    const remaining = conversations.filter((chat) => chat.id !== id);
    setConversations(remaining);
    if (activeId === id) {
      const next = remaining[0] ?? makeConversation();
      if (!remaining.length) setConversations([next]);
      setActiveId(next.id);
      setDraft("");
      setError(null);
    }
  }

  async function sendMessages(chatId: string, messages: GuestMessage[]) {
    setError(null);
    setSendingIds((current) => current.includes(chatId) ? current : [...current, chatId]);
    try {
      const response = await sendGuestChatTurn.mutateAsync({
        data: { messages: requestHistory(messages) },
      });
      const reply = response.content.trim();
      if (!reply) throw new Error("No response came back. Please try again.");
      setConversations((current) => current.map((chat) => chat.id === chatId
        ? { ...chat, messages: [...chat.messages, { role: "assistant", content: reply }], updatedAt: Date.now() }
        : chat));
    } catch (cause) {
      setError({
        chatId,
        message: cause instanceof Error && cause.message ? cause.message : "That message did not send. Please try again.",
        retryable: true,
      });
    } finally {
      setSendingIds((current) => current.filter((id) => id !== chatId));
    }
  }

  function submitMessage(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !activeChat || isSending) return;
    if (content.length > MAX_MESSAGE_CHARS) {
      setError({ chatId: activeChat.id, message: `Keep each message under ${MAX_MESSAGE_CHARS.toLocaleString()} characters.`, retryable: false });
      return;
    }
    const nextMessages = [...activeChat.messages, { role: "user" as const, content }];
    setConversations((current) => current.map((chat) => chat.id === activeChat.id
      ? {
        ...chat,
        title: chat.messages.length ? chat.title : titleFromMessage(content),
        messages: nextMessages,
        updatedAt: Date.now(),
      }
      : chat));
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    void sendMessages(activeChat.id, nextMessages);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function retry() {
    if (!activeChat || isSending) return;
    const messages = activeChat.messages;
    if (messages[messages.length - 1]?.role !== "user") return;
    void sendMessages(activeChat.id, messages);
  }

  const hasMessages = !!activeChat?.messages.length;
  const canSend = !!draft.trim() && !isSending && draft.trim().length <= MAX_MESSAGE_CHARS;

  return (
    <main className="guest-shell">
      <header className="guest-topbar">
        <button type="button" className="guest-brand" onClick={createChat} data-testid="button-guest-home" aria-label="Start a new conversation">
          <span className="guest-brand-mark"><Sparkles size={17} strokeWidth={1.8} /></span>
          <span className="guest-brand-name">easy peasy<span>docs</span></span>
        </button>
        <div className="guest-top-actions">
          <button type="button" className="guest-history-toggle" onClick={() => setMobileHistoryOpen((open) => !open)} data-testid="button-toggle-history" aria-expanded={mobileHistoryOpen}>
            <MessageSquare size={16} /> History
          </button>
          <AccountActions />
        </div>
      </header>

      <div className="guest-layout">
        <aside className={`guest-history ${mobileHistoryOpen ? "is-open" : ""}`} aria-label="Conversation history">
          <div className="guest-history-head">
            <div>
              <span className="guest-overline">YOUR SPACE</span>
              <h2>Conversations</h2>
            </div>
            <button type="button" className="guest-icon-button guest-mobile-close" onClick={() => setMobileHistoryOpen(false)} aria-label="Close conversation history" data-testid="button-close-history"><X size={17} /></button>
            <button type="button" className="guest-new-chat" onClick={createChat} data-testid="button-new-chat"><Plus size={15} /> New chat</button>
          </div>
          <div className="guest-chat-list" data-testid="list-conversations">
            {chats.map((chat) => (
              <div className={`guest-chat-item ${activeId === chat.id ? "is-active" : ""}`} key={chat.id}>
                <button type="button" className="guest-chat-select" onClick={() => {
                  setActiveId(chat.id);
                  setDraft("");
                  setError(null);
                  setMobileHistoryOpen(false);
                }} data-testid={`button-select-chat-${chat.id}`}>
                  <MessageSquare size={15} />
                  <span className="guest-chat-copy">
                    <span className="guest-chat-title">{chat.title}</span>
                    <span className="guest-chat-date">{formatTime(chat.updatedAt)}</span>
                  </span>
                </button>
                <button type="button" className="guest-icon-button guest-delete-chat" aria-label={`Delete ${chat.title}`} onClick={() => deleteChat(chat.id)} data-testid={`button-delete-chat-${chat.id}`}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <div className="guest-history-foot">
            <span className="guest-local-mark"><Check size={12} /></span>
            <span>Saved in this browser</span>
          </div>
        </aside>

        {mobileHistoryOpen && <button type="button" className="guest-scrim" aria-label="Close conversation history" onClick={() => setMobileHistoryOpen(false)} data-testid="button-dismiss-history" />}

        <section className="guest-conversation" aria-label="Guest chat">
          <div className="guest-conversation-head">
            <div className="guest-model-status"><span className="guest-live-dot" /><span>Easy Peasy</span><span className="guest-head-divider">/</span><span className="guest-head-mode">Chat</span></div>
            <div className="guest-current-title" data-testid="text-active-chat-title">{activeChat?.title ?? "New conversation"}</div>
            <button type="button" className="guest-icon-button guest-head-new" onClick={createChat} aria-label="Start a new conversation" data-testid="button-new-chat-mobile"><Plus size={18} /></button>
          </div>

          <div className={`guest-messages ${hasMessages ? "has-messages" : "is-empty"}`} data-testid="content-chat-messages">
            {!hasMessages ? (
              <div className="guest-welcome" data-testid="content-chat-welcome">
                <div className="guest-welcome-icon"><Sparkles size={22} strokeWidth={1.6} /></div>
                <p className="guest-overline">A GOOD PLACE TO START</p>
                <h1>What’s on<br />your mind?</h1>
                <p className="guest-welcome-copy">Ask a question, work through an idea, or start anywhere.</p>
              </div>
            ) : (
              <div className="guest-message-stack">
                {activeChat?.messages.map((message, index) => (
                  <article className={`guest-message guest-message-${message.role}`} key={`${activeChat.id}-${index}`} data-testid={`content-message-${message.role}-${index}`}>
                    {message.role === "assistant" && <div className="guest-assistant-mark"><Sparkles size={14} /></div>}
                    <div className="guest-message-body">
                      <div className="guest-message-role">{message.role === "user" ? "You" : "Easy Peasy"}</div>
                      <p>{message.content}</p>
                    </div>
                  </article>
                ))}
                {isSending && (
                  <div className="guest-message guest-message-assistant" data-testid="status-assistant-typing" role="status">
                    <div className="guest-assistant-mark"><Sparkles size={14} /></div>
                    <div className="guest-message-body"><div className="guest-message-role">Easy Peasy</div><div className="guest-thinking"><i /><i /><i /><span>Thinking</span></div></div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          <div className="guest-composer-area">
            {visibleError && (
              <div className="guest-error" role="alert" data-testid="status-chat-error">
                <span>{visibleError.message}</span>
                {visibleError.retryable && <button type="button" onClick={retry} disabled={isSending} data-testid="button-retry-message">Try again <ArrowDown size={13} /></button>}
                <button type="button" className="guest-error-dismiss" aria-label="Dismiss error" onClick={() => setError(null)} data-testid="button-dismiss-error"><X size={14} /></button>
              </div>
            )}
            <form className="guest-composer" onSubmit={submitMessage}>
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => { setDraft(event.target.value); if (visibleError) setError(null); }}
                onKeyDown={handleComposerKeyDown}
                placeholder="Message Easy Peasy…"
                rows={1}
                maxLength={MAX_MESSAGE_CHARS}
                disabled={isSending}
                aria-label="Write a message"
                data-testid="input-chat-message"
              />
              <div className="guest-composer-bottom">
                <span className="guest-composer-hint">
                  {draft.length > MAX_MESSAGE_CHARS - 500 ? `${draft.length.toLocaleString()} / ${MAX_MESSAGE_CHARS.toLocaleString()}` : "Enter to send · Shift + Enter for a new line"}
                </span>
                <button className="guest-send" type="submit" disabled={!canSend} aria-label="Send message" data-testid="button-send-message">
                  {isSending ? <span className="guest-send-pulse" /> : <ArrowUp size={18} strokeWidth={2.2} />}
                </button>
              </div>
            </form>
            <p className="guest-composer-caption" data-testid="status-chat-ready">A conversation, in your own words.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
