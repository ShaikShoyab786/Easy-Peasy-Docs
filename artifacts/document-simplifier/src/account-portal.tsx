import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useClerk, useUser } from "@clerk/react";
import {
  completeStoredDocumentUpload,
  deleteStoredDocument,
  getGetStoredDocumentFileUrl,
  getListConversationMessagesQueryKey,
  getListConversationsQueryKey,
  getListStoredDocumentsQueryKey,
  listStoredDocuments,
  requestStoredDocumentUpload,
  useCreateConversation,
  useDeleteConversation,
  useListConversationMessages,
  useListConversations,
  useSendConversationChatTurn,
} from "@workspace/api-client-react";
import type { Conversation, Message, StoredDocument } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  ArrowUp, FileText, LoaderCircle, MessageCircle, Plus, Send,
  Trash2, Upload, X,
} from "lucide-react";

const MAX_PDF_BYTES = 12 * 1024 * 1024;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function readableDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "Recently" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function relativeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  return readableDate(value);
}

function messageError(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function AccountActions() {
  const { isLoaded, user } = useUser();
  const { signOut } = useClerk();

  if (!isLoaded) return <span className="mono text-[10px] text-[#899087]">Loading account</span>;
  if (!user) {
    return <div className="flex items-center gap-3">
      <Link href="/sign-in" className="text-[12px] font-semibold text-[#53665a] hover:text-[#1f493b]">Sign in</Link>
      <Link href="/sign-up" className="rounded-full bg-[#245847] px-4 py-2.5 text-[12px] font-bold text-[#f7f6e8] transition hover:bg-[#1d4839]">Create account</Link>
    </div>;
  }

  return <div className="flex items-center gap-3">
    <Link href="/user-portal" className="max-w-[150px] truncate text-[12px] font-semibold text-[#53665a] hover:text-[#1f493b]">
      {user.firstName || user.primaryEmailAddress?.emailAddress || "Account"}
    </Link>
    <button type="button" onClick={() => void signOut({ redirectUrl: basePath || "/" })} className="text-[12px] font-semibold text-[#728077] transition-colors hover:text-[#a14d36]">Sign out</button>
  </div>;
}

export function AccountPortal() {
  const { user } = useUser();
  const queryClient = useQueryClient();
  const conversationsQuery = useListConversations();
  const conversations = conversationsQuery.data?.items ?? [];
  const createConversation = useCreateConversation();
  const deleteConversation = useDeleteConversation();
  const sendTurn = useSendConversationChatTurn();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [documentsError, setDocumentsError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [chatError, setChatError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesQuery = useListConversationMessages(selectedId ?? "", {
    query: {
      enabled: !!selectedId,
      queryKey: getListConversationMessagesQueryKey(selectedId ?? ""),
    },
  });
  const messages = messagesQuery.data?.items ?? [];
  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedId) ?? null,
    [conversations, selectedId],
  );
  const chatBusy = sendTurn.isPending;

  async function refreshDocuments() {
    setDocumentsError("");
    try {
      const response = await queryClient.fetchQuery({
        queryKey: getListStoredDocumentsQueryKey(),
        queryFn: () => listStoredDocuments(),
      });
      setDocuments(response.items);
    } catch (cause) {
      setDocumentsError(messageError(cause, "Your PDFs could not be loaded."));
    } finally {
      setDocumentsLoading(false);
    }
  }

  useEffect(() => { void refreshDocuments(); }, []);
  useEffect(() => {
    if (!selectedId && conversations.length) setSelectedId(conversations[0].id);
  }, [conversations, selectedId]);
  useEffect(() => {
    if (messages.length) messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, selectedId]);

  async function addConversation() {
    setWorkspaceError("");
    try {
      const conversation = await createConversation.mutateAsync({ data: {} });
      await queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
      setSelectedId(conversation.id);
      setDraft("");
      setChatError("");
    } catch (cause) {
      setWorkspaceError(messageError(cause, "A new conversation could not be created. Try again."));
    }
  }

  async function removeConversation(conversation: Conversation) {
    if (!window.confirm("Delete this conversation, its messages, and any PDFs saved to it?")) return;
    setDeletingId(conversation.id);
    setWorkspaceError("");
    try {
      await deleteConversation.mutateAsync({ conversationId: conversation.id });
      const remaining = conversations.filter((item) => item.id !== conversation.id);
      await queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
      if (selectedId === conversation.id) {
        setSelectedId(remaining[0]?.id ?? null);
        setDraft("");
      }
      await refreshDocuments();
    } catch (cause) {
      setWorkspaceError(messageError(cause, "This conversation could not be deleted."));
    } finally {
      setDeletingId(null);
    }
  }

  async function uploadPdf(file?: File) {
    if (!file) return;
    setDocumentsError("");
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setDocumentsError("Choose a PDF file.");
      return;
    }
    if (file.size < 1 || file.size > MAX_PDF_BYTES) {
      setDocumentsError("PDFs must be no larger than 12 MiB.");
      return;
    }
    setUploading(true);
    try {
      const ticket = await requestStoredDocumentUpload({ name: file.name, size: file.size, contentType: "application/pdf" });
      const uploadResponse = await fetch(ticket.uploadURL, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: file });
      if (!uploadResponse.ok) throw new Error("The PDF could not be uploaded. Please try again.");
      await completeStoredDocumentUpload(ticket.documentId);
      await refreshDocuments();
    } catch (cause) {
      setDocumentsError(messageError(cause, "The PDF could not be saved."));
    } finally {
      setUploading(false);
    }
  }

  async function removeDocument(documentId: string) {
    if (!window.confirm("Delete this saved PDF?")) return;
    setDeletingId(documentId);
    setDocumentsError("");
    try {
      await deleteStoredDocument(documentId);
      await refreshDocuments();
    } catch (cause) {
      setDocumentsError(messageError(cause, "The PDF could not be deleted."));
    } finally {
      setDeletingId(null);
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !selectedId || chatBusy) return;
    setChatError("");
    try {
      const result = await sendTurn.mutateAsync({ conversationId: selectedId, data: { content } });
      queryClient.setQueryData(getListConversationMessagesQueryKey(selectedId), result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListConversationMessagesQueryKey(selectedId) }),
        queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() }),
      ]);
      setDraft("");
    } catch (cause) {
      setChatError(messageError(cause, "Your message could not be sent. Your draft is still here."));
    }
  }

  function selectConversation(id: string) {
    if (id === selectedId) return;
    setSelectedId(id);
    setDraft("");
    setChatError("");
  }

  return (
    <div className="workspace-shell min-h-[100dvh] text-[#263d33]">
      <header className="workspace-header">
        <div className="mx-auto flex h-[72px] max-w-[1500px] items-center justify-between gap-4 px-4 sm:px-7">
          <Link href="/" className="flex shrink-0 items-center gap-3">
            <span className="brand-mark"><span>EP</span></span>
            <span className="leading-tight">
              <span className="block text-[14px] font-extrabold tracking-[-.045em] text-[#244739]">Easy Peasy Docs</span>
              <span className="mt-1 hidden text-[9px] uppercase tracking-[.17em] text-[#849188] sm:block">A little more clarity</span>
            </span>
          </Link>
          <AccountActions />
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-3 py-4 sm:px-6 sm:py-6">
        <div className="workspace-frame">
          <aside className="workspace-sidebar">
            <div className="sidebar-intro">
              <div className="eyebrow"><span className="eyebrow-dash" /> YOUR DESK</div>
              <h1 className="serif mt-3 text-[31px] leading-[1.05] tracking-[-.055em] text-[#28483a] sm:text-[36px]">Make sense<br className="hidden sm:block" /> of the fine print.</h1>
              <p className="mt-3 max-w-[270px] text-[12px] leading-[1.65] text-[#76847a]">A place to untangle company policies and keep the useful bits close.</p>
            </div>

            {workspaceError && <div role="alert" className="mx-4 mb-3 rounded-xl border border-[#e8c7b8] bg-[#fff4ed] px-3 py-2.5 text-[11px] leading-relaxed text-[#92503a]">{workspaceError}</div>}
            <section aria-label="Saved conversations" className="conversation-section">
              <div className="section-heading">
                <div>
                  <h2 className="text-[12px] font-bold text-[#42594a]">Conversations</h2>
                  <p className="mt-1 text-[10px] text-[#919a8d]">Your saved chats</p>
                </div>
                <button type="button" onClick={() => void addConversation()} disabled={createConversation.isPending} className="new-chat-button" data-testid="button-new-conversation">
                  {createConversation.isPending ? <LoaderCircle className="animate-spin" size={14} /> : <Plus size={14} />}
                  <span>New chat</span>
                </button>
              </div>
              <div className="conversation-list">
                {conversationsQuery.isLoading ? (
                  <div className="space-y-3 px-4 py-4" role="status" aria-label="Loading conversations">
                    <div className="skeleton-line w-4/5" /><div className="skeleton-line w-3/5" /><div className="skeleton-line w-2/3" />
                  </div>
                ) : conversationsQuery.isError ? (
                  <div className="px-4 py-5 text-[11px] text-[#90503d]">
                    <p>Conversations didn’t load.</p>
                    <button type="button" onClick={() => void conversationsQuery.refetch()} className="mt-2 font-bold underline underline-offset-2">Try again</button>
                  </div>
                ) : conversations.length ? conversations.map((conversation) => (
                  <div className={`conversation-row ${selectedId === conversation.id ? "is-selected" : ""}`} key={conversation.id}>
                    <button type="button" onClick={() => selectConversation(conversation.id)} className="conversation-select" data-testid={`button-open-conversation-${conversation.id}`}>
                      <span className="conversation-glyph"><MessageCircle size={15} strokeWidth={1.7} /></span>
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-[12px] font-semibold text-[#43574a]">{conversation.title || "New conversation"}</span>
                        <span className="mt-1 block text-[10px] text-[#9aa196]">{relativeDate(conversation.updatedAt)}</span>
                      </span>
                    </button>
                    <button type="button" aria-label={`Delete ${conversation.title}`} onClick={() => void removeConversation(conversation)} disabled={deletingId === conversation.id} className="conversation-delete" data-testid={`button-delete-conversation-${conversation.id}`}>
                      {deletingId === conversation.id ? <LoaderCircle size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    </button>
                  </div>
                )) : (
                  <div className="sidebar-empty">
                    <span className="empty-orbit"><MessageCircle size={18} /></span>
                    <p className="text-[11px] font-semibold text-[#657668]">No conversations yet</p>
                    <p className="mt-1 text-[10px] leading-relaxed text-[#969f94]">Start a chat whenever a policy needs a second look.</p>
                  </div>
                )}
              </div>
            </section>

            <section className="pdf-section" aria-label="Saved PDFs">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <h2 className="text-[12px] font-bold text-[#42594a]">Saved PDFs</h2>
                  <p className="mt-1 text-[10px] text-[#919a8d]">Your saved files</p>
                </div>
                <div className="flex items-center gap-2">
                  <Link href="/documents" className="review-pdf-link" data-testid="link-review-pdf">Review a PDF</Link>
                  <label className={`upload-button ${uploading ? "is-busy" : ""}`}>
                    {uploading ? <LoaderCircle className="animate-spin" size={13} /> : <Upload size={13} />}
                    <span>{uploading ? "Saving" : "Upload"}</span>
                    <input type="file" accept="application/pdf,.pdf" disabled={uploading} className="sr-only" data-testid="input-upload-pdf" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void uploadPdf(file); }} />
                  </label>
                </div>
              </div>
              {documentsError && <div role="alert" className="mx-4 mb-2 rounded-lg border border-[#e8c7b8] bg-[#fff4ed] px-3 py-2 text-[10px] text-[#92503a]">{documentsError}</div>}
              {documentsLoading ? <div className="space-y-2 px-4 py-3" role="status" aria-label="Loading PDFs"><div className="skeleton-line w-4/5" /><div className="skeleton-line w-3/5" /></div> :
                documents.length ? <ul className="pdf-list">{documents.map((document) => <li key={document.id} className="pdf-row">
                  <span className="pdf-icon"><FileText size={14} /></span>
                  <span className="min-w-0 flex-1">
                    {document.status === "ready" ? <a href={getGetStoredDocumentFileUrl(document.id)} target="_blank" rel="noreferrer" className="block truncate text-[11px] font-semibold text-[#526557] hover:text-[#1f493b]" data-testid={`link-open-pdf-${document.id}`}>{document.fileName}</a> : <span className="block truncate text-[11px] font-semibold text-[#778278]">{document.fileName}</span>}
                    <span className="mt-1 block text-[9px] text-[#9aa196]">{document.status === "ready" ? `${(document.byteSize / (1024 * 1024)).toFixed(1)} MB · ${readableDate(document.createdAt)}` : document.status.replace("_", " ")}</span>
                  </span>
                  <button type="button" aria-label={`Delete ${document.fileName}`} onClick={() => void removeDocument(document.id)} disabled={deletingId === document.id} className="pdf-delete" data-testid={`button-delete-pdf-${document.id}`}>
                    {deletingId === document.id ? <LoaderCircle size={13} className="animate-spin" /> : <X size={14} />}
                  </button>
                </li>)}</ul> : <div className="px-4 pb-4 pt-1 text-[10px] leading-relaxed text-[#929c91]">PDFs you upload will be saved here.</div>}
            </section>
            <div className="sidebar-foot"><span className="foot-seal">EP</span><span>Plain words. Better understanding.</span></div>
          </aside>

          <section className="chat-panel" aria-label="Conversation">
            {selectedConversation ? <>
              <div className="chat-topbar">
                <div className="min-w-0">
                  <div className="eyebrow chat-kicker"><span className="eyebrow-dash" /> YOUR CONVERSATION</div>
                  <h2 className="mt-1 truncate text-[16px] font-bold tracking-[-.03em] text-[#334d3d] sm:text-[18px]" data-testid="text-conversation-title">{selectedConversation.title || "New conversation"}</h2>
                </div>
              </div>
              <div className="messages-area" data-testid="list-messages">
                {messagesQuery.isLoading ? (
                  <div className="mx-auto flex w-full max-w-[680px] flex-col gap-5 px-5 py-9" role="status" aria-label="Loading messages">
                    <div className="skeleton-bubble assistant-skeleton" /><div className="skeleton-bubble user-skeleton" /><div className="skeleton-bubble assistant-skeleton" />
                  </div>
                ) : messagesQuery.isError ? (
                  <div className="chat-state">
                    <div className="state-icon state-error"><ArrowUp size={17} /></div>
                    <h3>We couldn’t open this chat.</h3>
                    <p>Your conversation is still saved. Try loading it again.</p>
                    <button type="button" onClick={() => void messagesQuery.refetch()} className="state-retry">Reload messages</button>
                  </div>
                ) : messages.length ? (
                  <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 py-8 sm:px-8 sm:py-10">
                    {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
                    {chatBusy && <div className="assistant-working"><span className="typing-dots"><i /><i /><i /></span><span>Finding the clear version</span></div>}
                  </div>
                ) : (
                  <div className="chat-state">
                    <div className="state-illustration" aria-hidden="true">
                      <span className="paper-shape"><i /><i /><i /></span>
                      <span className="paper-spark">+</span>
                    </div>
                    <span className="mono mt-2 text-[9px] uppercase tracking-[.17em] text-[#93a08b]">A fresh page</span>
                    <h3>What would you like to make sense of?</h3>
                    <p>Paste a passage from a policy or ask about wording that could use a plain-language explanation.</p>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
              <div className="composer-wrap">
                {chatError && <div role="alert" className="composer-error"><span>{chatError}</span><button type="button" onClick={() => setChatError("")} aria-label="Dismiss message error"><X size={14} /></button></div>}
                <form onSubmit={(event) => void submitMessage(event)} className="composer" data-testid="form-send-message">
                  <textarea value={draft} onChange={(event) => setDraft(event.target.value.slice(0, 6000))} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} maxLength={6000} rows={2} placeholder="Ask a question or paste a passage to explain…" aria-label="Your message" disabled={chatBusy} data-testid="input-chat-message" />
                  <div className="composer-bottom">
                    <span className="composer-hint">Clear answers, in ordinary language</span>
                    <div className="flex items-center gap-3">
                      <span className="mono hidden text-[9px] tabular-nums text-[#a0a99e] sm:inline">{draft.length.toLocaleString()} / 6,000</span>
                      <button type="submit" disabled={!draft.trim() || chatBusy} className="send-button" data-testid="button-send-message" aria-label="Send message">
                        {chatBusy ? <LoaderCircle size={16} className="animate-spin" /> : <Send size={15} />}
                        <span className="hidden sm:inline">{chatBusy ? "Sending" : "Send"}</span>
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            </> : (
              <div className="no-chat">
                <div className="no-chat-art"><MessageCircle size={24} strokeWidth={1.3} /><span /></div>
                <span className="mono mt-5 text-[9px] uppercase tracking-[.18em] text-[#98a08f]">YOUR SPACE, YOUR PACE</span>
                <h2>Start with one small question.</h2>
                <p>Create a conversation to talk through the policies and documents on your mind.</p>
                <button type="button" onClick={() => void addConversation()} disabled={createConversation.isPending} className="no-chat-cta" data-testid="button-start-conversation">
                  {createConversation.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <Plus size={15} />}
                  Start a conversation
                </button>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <article className={`message-row ${isUser ? "message-user" : "message-assistant"}`} data-testid={`message-${message.id}`}>
      {!isUser && <span className="assistant-avatar">EP</span>}
      <div className="min-w-0">
        <div className={`message-label ${isUser ? "text-right" : ""}`}>{isUser ? "You" : "Easy Peasy"}</div>
        <div className={`message-bubble ${isUser ? "user-bubble" : "assistant-bubble"}`}>
          <p>{message.content}</p>
        </div>
      </div>
    </article>
  );
}
