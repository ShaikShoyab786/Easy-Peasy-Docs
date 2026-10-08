import { useCallback, useEffect, useState } from "react";
import { useClerk, useUser } from "@clerk/react";
import {
  createConversation,
  completeStoredDocumentUpload,
  deleteConversation,
  deleteStoredDocument,
  getGetStoredDocumentFileUrl,
  listConversations,
  listStoredDocuments,
  requestStoredDocumentUpload,
} from "@workspace/api-client-react";
import type { Conversation, StoredDocument } from "@workspace/api-client-react";
import { Link } from "wouter";
import { FileText, LoaderCircle, Plus, Trash2, Upload } from "lucide-react";

const MAX_PDF_BYTES = 12 * 1024 * 1024;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function readableDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "Recently" : date.toLocaleDateString();
}

export function AccountActions() {
  const { isLoaded, user } = useUser();
  const { signOut } = useClerk();

  if (!isLoaded) {
    return <span className="mono text-[10px] text-[#899087]">Loading account</span>;
  }

  if (!user) {
    return (
      <div className="flex items-center gap-3">
        <Link
          href="/sign-in"
          className="text-[11px] font-semibold text-[#526258] hover:text-[#29483d]"
        >
          Sign in
        </Link>
        <Link
          href="/sign-up"
          className="rounded-full bg-[#29483d] px-3.5 py-2 text-[11px] font-semibold text-white transition hover:bg-[#203a31]"
        >
          Create account
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Link
        href="/user-portal"
        className="max-w-[130px] truncate text-[11px] font-semibold text-[#526258] hover:text-[#29483d]"
      >
        {user.firstName || user.primaryEmailAddress?.emailAddress || "Account"}
      </Link>
      <button
        type="button"
        onClick={() => void signOut({ redirectUrl: basePath || "/" })}
        className="text-[11px] font-semibold text-[#778079] hover:text-[#29483d]"
      >
        Sign out
      </button>
    </div>
  );
}

export function AccountPortal() {
  const { user } = useUser();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refreshWorkspace = useCallback(async () => {
    setError("");
    try {
      const [conversationResponse, documentResponse] = await Promise.all([
        listConversations(),
        listStoredDocuments(),
      ]);
      setConversations(conversationResponse.items);
      setDocuments(documentResponse.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your saved data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  async function addConversation() {
    setCreatingConversation(true);
    setError("");
    try {
      await createConversation({ title: "New chat" });
      await refreshWorkspace();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create a conversation.");
    } finally {
      setCreatingConversation(false);
    }
  }

  async function uploadPdf(file?: File) {
    if (!file) return;
    setError("");
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Choose a PDF file.");
      return;
    }
    if (file.size < 1 || file.size > MAX_PDF_BYTES) {
      setError("PDFs must be no larger than 12 MiB.");
      return;
    }

    setUploading(true);
    try {
      const ticket = await requestStoredDocumentUpload({
        name: file.name,
        size: file.size,
        contentType: "application/pdf",
      });
      const uploadResponse = await fetch(ticket.uploadURL, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: file,
      });
      if (!uploadResponse.ok) {
        throw new Error("The PDF could not be uploaded. Please try again.");
      }
      await completeStoredDocumentUpload(ticket.documentId);
      await refreshWorkspace();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The PDF could not be saved.");
    } finally {
      setUploading(false);
    }
  }

  async function removeDocument(documentId: string) {
    if (!window.confirm("Delete this saved PDF?")) return;
    setDeletingId(documentId);
    setError("");
    try {
      await deleteStoredDocument(documentId);
      await refreshWorkspace();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The PDF could not be deleted.");
    } finally {
      setDeletingId(null);
    }
  }

  async function removeConversation(conversation: Conversation) {
    if (
      !window.confirm(
        "Delete this conversation, its messages, and any PDFs saved to it?",
      )
    ) {
      return;
    }
    setDeletingId(conversation.id);
    setError("");
    try {
      await deleteConversation(conversation.id);
      await refreshWorkspace();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The conversation could not be deleted.",
      );
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="lab-shell min-h-screen">
      <div className="lab-content mx-auto max-w-[1180px] px-5 pb-12 sm:px-8">
        <header className="flex min-h-[76px] items-center justify-between gap-4 border-b border-[#d9d7c9]">
          <Link href="/" className="flex items-center gap-3.5">
            <div className="grid h-9 w-9 place-items-center rounded-[11px] bg-[#29483d] text-[#e8edce]">
              <span className="text-[19px] font-extrabold tracking-[-.08em]">EP</span>
            </div>
            <div>
              <div className="text-[15px] font-extrabold tracking-[-.04em] text-[#293b33]">
                Easy Peasy Docs
              </div>
              <div className="mono mt-0.5 hidden text-[10px] uppercase tracking-[.12em] text-[#778079] sm:block">
                Your saved workspace
              </div>
            </div>
          </Link>
          <AccountActions />
        </header>

        <main className="mx-auto max-w-[1040px]">
          <section className="flex flex-col justify-between gap-5 pb-7 pt-10 sm:flex-row sm:items-end">
            <div>
              <div className="mono mb-3 text-[10px] uppercase tracking-[.18em] text-[#728071]">
                ACCOUNT WORKSPACE
              </div>
              <h1 className="serif text-[38px] leading-[1.02] tracking-[-.04em] text-[#293b33] sm:text-[48px]">
                Saved for you.
              </h1>
              <p className="mt-3 max-w-[580px] text-[13px] leading-[1.7] text-[#68746c]">
                {user?.primaryEmailAddress?.emailAddress
                  ? `Signed in as ${user.primaryEmailAddress.emailAddress}.`
                  : "Your conversations and PDFs are saved to this account."}
              </p>
            </div>
            <Link
              href="/documents"
              className="inline-flex w-fit items-center gap-2 rounded-full border border-[#cfcfbe] bg-[#f6f5ed] px-4 py-2.5 text-[11px] font-semibold text-[#526258] transition hover:bg-white"
            >
              <FileText size={14} />
              Review a PDF
            </Link>
          </section>

          {error && (
            <div
              role="alert"
              className="mb-5 rounded-xl border border-[#e3c4b8] bg-[#fff6f2] px-4 py-3 text-[12px] text-[#8b4536]"
            >
              {error}
            </div>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <section className="panel overflow-hidden rounded-[16px]">
              <div className="flex items-center justify-between border-b border-[#e3e1d6] px-5 py-4">
                <div>
                  <h2 className="text-[14px] font-bold text-[#31433a]">
                    Conversations
                  </h2>
                  <p className="mt-1 text-[10px] text-[#858d82]">
                    Saved across your signed-in devices
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void addConversation()}
                  disabled={creatingConversation}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#29483d] px-3 py-2 text-[10px] font-semibold text-white transition hover:bg-[#203a31] disabled:opacity-60"
                >
                  {creatingConversation ? (
                    <LoaderCircle size={13} className="animate-spin" />
                  ) : (
                    <Plus size={13} />
                  )}
                  New
                </button>
              </div>
              {loading ? (
                <div className="flex items-center gap-2 px-5 py-8 text-[12px] text-[#7e887e]">
                  <LoaderCircle size={15} className="animate-spin" />
                  Loading conversations
                </div>
              ) : conversations.length ? (
                <ul className="divide-y divide-[#eceae1]">
                  {conversations.map((conversation) => (
                    <li
                      key={conversation.id}
                      className="flex items-center justify-between gap-3 px-5 py-4"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[12px] font-semibold text-[#405047]">
                          {conversation.title}
                        </div>
                        <div className="mono mt-1 text-[9px] uppercase tracking-[.1em] text-[#90968b]">
                          Updated {readableDate(conversation.updatedAt)}
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label={`Delete ${conversation.title}`}
                        onClick={() => void removeConversation(conversation)}
                        disabled={deletingId === conversation.id}
                        className="rounded-md p-2 text-[#93968b] transition hover:bg-[#f5e9e4] hover:text-[#9b5140] disabled:opacity-50"
                      >
                        {deletingId === conversation.id ? (
                          <LoaderCircle size={14} className="animate-spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-5 py-8 text-[12px] text-[#808a80]">
                  Saved conversations will appear here.
                </div>
              )}
            </section>

            <section className="panel overflow-hidden rounded-[16px]">
              <div className="flex items-center justify-between gap-3 border-b border-[#e3e1d6] px-5 py-4">
                <div>
                  <h2 className="text-[14px] font-bold text-[#31433a]">
                    Saved PDFs
                  </h2>
                  <p className="mt-1 text-[10px] text-[#858d82]">
                    Private files attached to this account
                  </p>
                </div>
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[#cfcfbe] bg-[#f6f5ed] px-3 py-2 text-[10px] font-semibold text-[#526258] transition hover:bg-white">
                  {uploading ? (
                    <LoaderCircle size={13} className="animate-spin" />
                  ) : (
                    <Upload size={13} />
                  )}
                  {uploading ? "Saving" : "Upload PDF"}
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    disabled={uploading}
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      void uploadPdf(file);
                    }}
                  />
                </label>
              </div>
              {loading ? (
                <div className="flex items-center gap-2 px-5 py-8 text-[12px] text-[#7e887e]">
                  <LoaderCircle size={15} className="animate-spin" />
                  Loading PDFs
                </div>
              ) : documents.length ? (
                <ul className="divide-y divide-[#eceae1]">
                  {documents.map((document) => (
                    <li
                      key={document.id}
                      className="flex items-center justify-between gap-3 px-5 py-4"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#edf0e5] text-[#657b5f]">
                          <FileText size={15} />
                        </span>
                        <div className="min-w-0">
                          {document.status === "ready" ? (
                            <a
                              href={getGetStoredDocumentFileUrl(document.id)}
                              target="_blank"
                              rel="noreferrer"
                              className="block truncate text-[12px] font-semibold text-[#405047] hover:text-[#29483d]"
                            >
                              {document.fileName}
                            </a>
                          ) : (
                            <div className="truncate text-[12px] font-semibold text-[#69756b]">
                              {document.fileName}
                            </div>
                          )}
                          <div className="mono mt-1 text-[9px] uppercase tracking-[.1em] text-[#90968b]">
                            {document.status === "ready"
                              ? `${(document.byteSize / (1024 * 1024)).toFixed(1)} MB · ${readableDate(document.createdAt)}`
                              : document.status.replace("_", " ")}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label={`Delete ${document.fileName}`}
                        onClick={() => void removeDocument(document.id)}
                        disabled={deletingId === document.id}
                        className="rounded-md p-2 text-[#93968b] transition hover:bg-[#f5e9e4] hover:text-[#9b5140] disabled:opacity-50"
                      >
                        {deletingId === document.id ? (
                          <LoaderCircle size={14} className="animate-spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-5 py-8 text-[12px] text-[#808a80]">
                  PDFs you upload here will be saved to your account.
                </div>
              )}
            </section>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 py-7">
            <span className="mono text-[9px] uppercase tracking-[.1em] text-[#989c90]">
              Easy Peasy Docs
            </span>
            <Link
              href="/documents"
              className="mono text-[9px] uppercase tracking-[.08em] text-[#858d84] hover:text-[#425348]"
            >
              Open PDF review
            </Link>
          </footer>
        </main>
      </div>
    </div>
  );
}
