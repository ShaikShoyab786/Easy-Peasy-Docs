import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  FileSpreadsheet,
  FileText,
  LoaderCircle,
  Pin,
  Plus,
  Search,
  ShieldCheck,
  UploadCloud,
  X,
} from "lucide-react";
import {
  getListKnowledgeDocumentsQueryKey,
  useCompleteKnowledgeDocumentUpload,
  useDeleteKnowledgeDocument,
  useListKnowledgeDocuments,
  useRequestKnowledgeDocumentUploadUrl,
  useSetKnowledgeDocumentPinned,
} from "@workspace/api-client-react";
import type { KnowledgeDocument } from "@workspace/api-client-react";
import { getKnowledgeHubFileType, trackEvent } from "../lib/analytics";
import "./knowledge-hub-dashboard.css";

export interface KnowledgeHubDashboardProps {
  isGuest: boolean;
  onSignIn: () => void;
  onViewChat: (document: KnowledgeDocument) => Promise<void>;
  onUseInChat?: (document: KnowledgeDocument) => Promise<void>;
  activeDocumentId?: string;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = [".pdf", ".txt", ".csv"];

type UploadStage = "idle" | "requesting" | "uploading" | "completing";
type Notice = { kind: "success" | "error"; text: string } | null;
type SearchResultCountBucket = "0" | "1" | "2_to_5" | "6_plus";

function getSearchResultCountBucket(resultCount: number): SearchResultCountBucket {
  if (resultCount === 0) return "0";
  if (resultCount === 1) return "1";
  if (resultCount <= 5) return "2_to_5";
  return "6_plus";
}

function formatBytes(byteSize: number) {
  if (byteSize < 1024 * 1024) return `${Math.max(1, Math.round(byteSize / 1024))} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function fileKind(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "csv") return "CSV";
  if (extension === "txt") return "TXT";
  return "PDF";
}

function FileGlyph({ fileName, small = false }: { fileName: string; small?: boolean }) {
  const Icon = fileKind(fileName) === "CSV" ? FileSpreadsheet : FileText;
  return (
    <span className={`kh-file-glyph kh-file-${fileKind(fileName).toLowerCase()}${small ? " kh-file-glyph-small" : ""}`} aria-hidden="true">
      <Icon size={small ? 17 : 21} strokeWidth={1.8} />
    </span>
  );
}

function uploadFileToUrl(uploadUrl: string, file: File, contentType: string, onProgress: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", uploadUrl);
    request.setRequestHeader("Content-Type", contentType);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`The file transfer failed (${request.status}). Please try again.`));
    };
    request.onerror = () => reject(new Error("The file could not reach secure storage. Check your connection and try again."));
    request.onabort = () => reject(new Error("The file transfer was interrupted."));
    request.send(file);
  });
}

export function KnowledgeHubDashboard({
  isGuest,
  onSignIn,
  onViewChat,
  onUseInChat,
  activeDocumentId,
}: KnowledgeHubDashboardProps) {
  const queryClient = useQueryClient();
  const documentsQuery = useListKnowledgeDocuments({
    query: {
      queryKey: getListKnowledgeDocumentsQueryKey(),
      enabled: !isGuest,
      refetchInterval: (query) =>
        query.state.data?.items.some(
          (document) =>
            document.status === "ready" && !document.semanticSearchIndexed,
        )
          ? 30_000
          : false,
    },
  });
  const requestUpload = useRequestKnowledgeDocumentUploadUrl();
  const completeUpload = useCompleteKnowledgeDocumentUpload();
  const setPinned = useSetKnowledgeDocumentPinned();
  const deleteDocument = useDeleteKnowledgeDocument();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [stage, setStage] = useState<UploadStage>("idle");
  const [progress, setProgress] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const [search, setSearch] = useState("");
  const searchSessionRef = useRef<{ query: string; hasQuery: boolean } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busyDocumentId, setBusyDocumentId] = useState<string | null>(null);

  const documents = isGuest ? [] : documentsQuery.data?.items ?? [];
  const pinnedDocuments = useMemo(() => documents.filter((document) => document.isPinned), [documents]);
  const filteredDocuments = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return documents;
    return documents.filter((document) => document.fileName.toLowerCase().includes(term));
  }, [documents, search]);
  const isUploading = stage !== "idle";

  const completeSearchSession = () => {
    const session = searchSessionRef.current;
    if (!session?.hasQuery) return;

    const term = session.query.trim().toLowerCase();
    session.hasQuery = false;
    if (!term) return;

    const resultCount = documents.filter((document) => document.fileName.toLowerCase().includes(term)).length;
    trackEvent("knowledge_hub_search_completed", {
      result_count_bucket: getSearchResultCountBucket(resultCount),
    });
  };

  const clearSearch = () => {
    completeSearchSession();
    setSearch("");
  };

  const openUpload = () => {
    if (isGuest) {
      onSignIn();
      return;
    }
    setUploadError("");
    setSelectedFile(null);
    setIsDialogOpen(true);
  };

  const closeDialog = () => {
    if (isUploading) return;
    setIsDialogOpen(false);
    setSelectedFile(null);
    setUploadError("");
  };

  const validateFile = (file: File) => {
    const extension = `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`;
    if (!ACCEPTED_EXTENSIONS.includes(extension)) return "Choose a PDF, TXT, or CSV file.";
    if (file.size > MAX_FILE_BYTES) return "This file is over the 10 MB limit.";
    if (file.size === 0) return "This file is empty. Choose a document with content.";
    return "";
  };

  const onChooseFile = (file?: File) => {
    if (!file) return;
    const error = validateFile(file);
    setUploadError(error);
    setSelectedFile(error ? null : file);
  };

  const invalidateDocuments = async () => {
    await queryClient.invalidateQueries({ queryKey: getListKnowledgeDocumentsQueryKey() });
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    if (isGuest) {
      onSignIn();
      return;
    }
    setUploadError("");
    setNotice(null);
    setProgress(0);
    let pendingDocumentId: string | null = null;
    try {
      setStage("requesting");
      const session = await requestUpload.mutateAsync({
        data: { fileName: selectedFile.name, byteSize: selectedFile.size },
      });
      pendingDocumentId = session.document.id;
      setStage("uploading");
      await uploadFileToUrl(session.uploadUrl, selectedFile, session.document.contentType, setProgress);
      setStage("completing");
      await completeUpload.mutateAsync({ documentId: session.document.id });
      pendingDocumentId = null;
      await invalidateDocuments();
      trackEvent("knowledge_hub_upload_completed", {
        file_type: getKnowledgeHubFileType(selectedFile.name),
      });
      setNotice({ kind: "success", text: `${selectedFile.name} is ready in your hub.` });
      setStage("idle");
      setSelectedFile(null);
      setIsDialogOpen(false);
    } catch (error) {
      setStage("idle");
      if (pendingDocumentId) {
        try {
          await deleteDocument.mutateAsync({ documentId: pendingDocumentId });
        } catch {
          // Keep the incomplete item visible so the user can remove it.
        }
        await invalidateDocuments();
      }
      setUploadError(error instanceof Error ? error.message : "Upload failed. Please try again.");
    }
  };

  const handlePin = async (document: KnowledgeDocument) => {
    setNotice(null);
    setBusyDocumentId(document.id);
    try {
      await setPinned.mutateAsync({ documentId: document.id, data: { isPinned: !document.isPinned } });
      await invalidateDocuments();
      trackEvent("knowledge_hub_pin_changed", {
        file_type: getKnowledgeHubFileType(document.fileName),
        is_pinned: !document.isPinned,
      });
      setNotice({ kind: "success", text: `${document.fileName} ${document.isPinned ? "removed from" : "pinned to"} your quick access.` });
    } catch {
      setNotice({ kind: "error", text: `Could not update the pin for ${document.fileName}. Please try again.` });
    } finally {
      setBusyDocumentId(null);
    }
  };

  const handleDelete = async (document: KnowledgeDocument) => {
    if (!window.confirm(`Delete “${document.fileName}” from your Knowledge Hub?`)) return;
    setNotice(null);
    setBusyDocumentId(document.id);
    try {
      await deleteDocument.mutateAsync({ documentId: document.id });
      await invalidateDocuments();
      trackEvent("knowledge_hub_document_deleted", {
        file_type: getKnowledgeHubFileType(document.fileName),
      });
      setNotice({ kind: "success", text: `${document.fileName} was deleted.` });
    } catch {
      setNotice({ kind: "error", text: `Could not delete ${document.fileName}. Please try again.` });
    } finally {
      setBusyDocumentId(null);
    }
  };

  const handleViewChat = async (document: KnowledgeDocument) => {
    setNotice(null);
    setBusyDocumentId(document.id);
    try {
      await onViewChat(document);
    } catch {
      setNotice({ kind: "error", text: `Could not open a chat about ${document.fileName}. Please try again.` });
    } finally {
      setBusyDocumentId(null);
    }
  };

  const handleUseInChat = async (document: KnowledgeDocument) => {
    if (!onUseInChat) return;
    setNotice(null);
    setBusyDocumentId(document.id);
    try {
      await onUseInChat(document);
    } catch {
      setNotice({ kind: "error", text: `Could not use ${document.fileName} in this chat. Please try again.` });
    } finally {
      setBusyDocumentId(null);
    }
  };

  return (
    <div className="kh-dashboard" data-testid="page-knowledge-hub-dashboard">
      <div className="kh-content">
        <header className="kh-header">
          <div className="kh-heading-copy">
            <p className="kh-eyebrow"><span className="kh-eyebrow-dot" /> YOUR PRIVATE LIBRARY</p>
            <h1 data-testid="text-knowledge-hub-title">Knowledge Hub</h1>
            <p className="kh-subtitle">Keep your policies and reports close. Ask questions whenever you need a clearer answer.</p>
          </div>
          <button className="kh-primary-button kh-header-upload" type="button" onClick={openUpload} data-testid="button-upload-document">
            <Plus size={17} strokeWidth={2.2} />
            Upload New Document
          </button>
        </header>

        {notice && (
          <div className={`kh-notice kh-notice-${notice.kind}`} role="status" data-testid="status-document-feedback">
            {notice.kind === "success" ? <Check size={16} /> : <AlertCircle size={16} />}
            <span>{notice.text}</span>
            <button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)} data-testid="button-dismiss-feedback"><X size={15} /></button>
          </div>
        )}

        {isGuest ? (
          <section className="kh-empty-state" data-testid="state-empty-library">
            <div className="kh-empty-art" aria-hidden="true">
              <div className="kh-empty-sheet kh-empty-sheet-back"><span /><span /><span /></div>
              <div className="kh-empty-sheet"><span /><span /><span /><i /></div>
              <div className="kh-empty-lock"><ShieldCheck size={20} /></div>
            </div>
            <p className="kh-section-overline">A LITTLE ROOM FOR YOUR REFERENCE</p>
            <h2>Your library, all in one place.</h2>
            <p className="kh-empty-message">No documents in your hub yet. Upload your first policy or report to get started.</p>
            <button className="kh-primary-button kh-empty-upload" type="button" onClick={openUpload} data-testid="button-upload-first-document">
              <Plus size={18} /> Upload New Document
            </button>
          </section>
        ) : documentsQuery.isLoading ? (
          <section className="kh-loading-state" aria-label="Loading documents" data-testid="state-documents-loading">
            <div className="kh-loading-intro"><i /><i /><i /></div>
            <div className="kh-loading-row"><i /><div><i /><i /></div><i /></div>
            <div className="kh-loading-row"><i /><div><i /><i /></div><i /></div>
            <div className="kh-loading-row"><i /><div><i /><i /></div><i /></div>
          </section>
        ) : documentsQuery.isError ? (
          <section className="kh-error-state" role="alert" data-testid="state-documents-error">
            <span className="kh-error-icon"><AlertCircle size={20} /></span>
            <h2>Your library didn’t load</h2>
            <p>We couldn’t reach your documents just now. Give it another try.</p>
            <button type="button" className="kh-secondary-button" onClick={() => void documentsQuery.refetch()} data-testid="button-retry-documents">Try again</button>
          </section>
        ) : documents.length === 0 ? (
          <section className="kh-empty-state" data-testid="state-empty-library">
            <div className="kh-empty-art" aria-hidden="true">
              <div className="kh-empty-sheet kh-empty-sheet-back"><span /><span /><span /></div>
              <div className="kh-empty-sheet"><span /><span /><span /><i /></div>
              <div className="kh-empty-lock"><ShieldCheck size={20} /></div>
            </div>
            <p className="kh-section-overline">A LITTLE ROOM FOR YOUR REFERENCE</p>
            <h2>Your library, all in one place.</h2>
            <p className="kh-empty-message">No documents in your hub yet. Upload your first policy or report to get started.</p>
            <button className="kh-primary-button kh-empty-upload" type="button" onClick={openUpload} data-testid="button-upload-first-document">
              <Plus size={18} /> Upload New Document
            </button>
          </section>
        ) : (
          <div className="kh-library-content">
            {pinnedDocuments.length > 0 && (
              <section className="kh-pinned-section" aria-labelledby="kh-pinned-title">
                <div className="kh-section-heading">
                  <div>
                    <p className="kh-section-overline">QUICK ACCESS</p>
                    <h2 id="kh-pinned-title">Pinned documents <span>{pinnedDocuments.length}</span></h2>
                  </div>
                  <span className="kh-section-note"><Pin size={13} /> Ready when you are</span>
                </div>
                <div className="kh-pinned-strip">
                  {pinnedDocuments.map((document, index) => (
                    <article className={`kh-pin-card kh-pin-card-${index % 3}`} key={document.id} data-testid={`card-pinned-document-${document.id}`}>
                      <div className="kh-pin-card-top">
                        <FileGlyph fileName={document.fileName} />
                        <span className="kh-pin-indicator"><Pin size={13} fill="currentColor" /></span>
                      </div>
                      <h3 title={document.fileName}>{document.fileName}</h3>
                      <p>{fileKind(document.fileName)} <span /> {formatBytes(document.byteSize)}</p>
                      <button type="button" onClick={() => void handleViewChat(document)} disabled={busyDocumentId === document.id} data-testid={`button-view-chat-pinned-${document.id}`}>
                        View chat <ArrowUpRight size={15} />
                      </button>
                      {onUseInChat && (
                        <button
                          type="button"
                          onClick={() => void handleUseInChat(document)}
                          disabled={busyDocumentId === document.id || document.status !== "ready"}
                          data-testid={`button-use-document-pinned-${document.id}`}
                        >
                          {activeDocumentId === document.id ? "In this chat" : "Use in chat"}
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            )}

            <section className="kh-documents-section" aria-labelledby="kh-documents-title">
              <div className="kh-section-heading kh-documents-heading">
                <div>
                  <p className="kh-section-overline">YOUR COLLECTION</p>
                  <h2 id="kh-documents-title">All documents <span>{documents.length}</span></h2>
                </div>
                <label className="kh-search-box">
                  <Search size={16} aria-hidden="true" />
                  <input
                    type="search"
                    placeholder="Search documents"
                    value={search}
                    onFocus={() => {
                      searchSessionRef.current = { query: "", hasQuery: false };
                    }}
                    onChange={(event) => {
                      const query = event.target.value;
                      const session = searchSessionRef.current ?? { query: "", hasQuery: false };
                      searchSessionRef.current = session;
                      if (!query.trim()) {
                        completeSearchSession();
                        session.query = "";
                        session.hasQuery = false;
                      } else {
                        session.query = query;
                        session.hasQuery = true;
                      }
                      setSearch(query);
                    }}
                    onBlur={completeSearchSession}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") completeSearchSession();
                    }}
                    aria-label="Search documents"
                    data-testid="input-search-documents"
                  />
                  {search && <button type="button" onClick={clearSearch} aria-label="Clear search" data-testid="button-clear-search"><X size={14} /></button>}
                </label>
              </div>
              <div className="kh-table-wrap">
                <table className="kh-documents-table">
                  <thead><tr><th scope="col">Document</th><th scope="col">Added</th><th scope="col">Size</th><th scope="col">Semantic search</th><th scope="col">Status</th><th scope="col"><span className="kh-sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {filteredDocuments.map((document) => (
                      <tr key={document.id} data-testid={`row-document-${document.id}`}>
                        <td className="kh-document-cell">
                          <FileGlyph fileName={document.fileName} small />
                          <span className="kh-document-name" title={document.fileName} data-testid={`text-document-name-${document.id}`}>{document.fileName}</span>
                        </td>
                        <td className="kh-date-cell">{formatDate(document.createdAt)}</td>
                        <td className="kh-size-cell">{formatBytes(document.byteSize)}</td>
                        <td><span
                          className={`kh-search-status ${
                            document.status !== "ready"
                              ? "kh-search-status-pending"
                              : document.semanticSearchIndexed
                                ? "kh-search-status-ready"
                                : "kh-search-status-fallback"
                          }`}
                          data-testid={`status-semantic-search-${document.id}`}
                        >
                          <i />
                          {document.status !== "ready"
                            ? "Unavailable"
                            : document.semanticSearchIndexed
                              ? "Search ready"
                              : "Using saved file"}
                        </span></td>
                        <td><span className={`kh-status-pill ${document.status === "ready" ? "kh-status-ready" : "kh-status-pending"}`} data-testid={`status-document-${document.id}`}>
                          <i />{document.status === "ready" ? "Ready" : "Upload incomplete"}
                        </span></td>
                        <td>
                          <div className="kh-row-actions">
                            <button type="button" onClick={() => void handlePin(document)} disabled={busyDocumentId === document.id || document.status !== "ready"} aria-label={`${document.isPinned ? "Unpin" : "Pin"} ${document.fileName}`} data-testid={`button-pin-document-${document.id}`}>
                              <Pin size={15} fill={document.isPinned ? "currentColor" : "none"} /><span>{document.isPinned ? "Unpin" : "Pin"}</span>
                            </button>
                            <button type="button" onClick={() => void handleDelete(document)} disabled={busyDocumentId === document.id} aria-label={`Delete ${document.fileName}`} data-testid={`button-delete-document-${document.id}`}>
                              <X size={15} /><span>Delete</span>
                            </button>
                            <button className="kh-view-action" type="button" onClick={() => void handleViewChat(document)} disabled={busyDocumentId === document.id || document.status !== "ready"} data-testid={`button-view-chat-${document.id}`}>
                              View Chat <ArrowUpRight size={14} />
                            </button>
                            {onUseInChat && (
                              <button
                                className="kh-view-action"
                                type="button"
                                onClick={() => void handleUseInChat(document)}
                                disabled={busyDocumentId === document.id || document.status !== "ready" || activeDocumentId === document.id}
                                data-testid={`button-use-document-${document.id}`}
                              >
                                {activeDocumentId === document.id ? "In this chat" : "Use in chat"}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredDocuments.length === 0 && (
                  <div className="kh-no-results" data-testid="state-no-search-results">
                    <Search size={19} />
                    <p>No documents match “{search}”</p>
                    <button type="button" onClick={clearSearch} data-testid="button-reset-search">Clear search</button>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </div>

      {isDialogOpen && (
        <div className="kh-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
          <section className="kh-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="kh-upload-title" data-testid="dialog-upload-document">
            <button className="kh-dialog-close" type="button" onClick={closeDialog} disabled={isUploading} aria-label="Close upload dialog" data-testid="button-close-upload"><X size={18} /></button>
            <div className="kh-dialog-symbol"><UploadCloud size={21} /></div>
            <p className="kh-section-overline">ADD TO YOUR PRIVATE LIBRARY</p>
            <h2 id="kh-upload-title">Upload a document</h2>
            <p className="kh-dialog-copy">Choose one policy or report. PDF, TXT, or CSV up to 10 MB.</p>
            <input
              ref={inputRef}
              className="kh-file-input"
              type="file"
              accept=".pdf,.txt,.csv,application/pdf,text/plain,text/csv"
              onChange={(event) => onChooseFile(event.target.files?.[0])}
              disabled={isUploading}
              data-testid="input-upload-document"
            />
            <button className={`kh-dropzone${selectedFile ? " kh-dropzone-selected" : ""}`} type="button" onClick={() => inputRef.current?.click()} disabled={isUploading} data-testid="button-choose-document">
              {selectedFile ? <FileGlyph fileName={selectedFile.name} /> : <span className="kh-dropzone-upload"><UploadCloud size={19} /></span>}
              <span className="kh-dropzone-copy">
                <strong>{selectedFile ? selectedFile.name : "Choose a file to upload"}</strong>
                <small>{selectedFile ? `${formatBytes(selectedFile.size)} · ${fileKind(selectedFile.name)}` : "PDF, TXT, or CSV · Maximum 10 MB"}</small>
              </span>
              {!selectedFile && <span className="kh-browse-label">Browse</span>}
            </button>
            {uploadError && <p className="kh-upload-error" role="alert" data-testid="status-upload-error"><AlertCircle size={15} />{uploadError}</p>}
            {isUploading && (
              <div className="kh-upload-progress" role="status" data-testid="status-upload-progress">
                <div className="kh-progress-copy">
                  <span>{stage === "requesting" ? "Preparing secure upload…" : stage === "completing" ? "Finishing up…" : "Uploading document…"}</span>
                  <span>{stage === "uploading" ? `${progress}%` : <LoaderCircle size={14} className="kh-spinning" />}</span>
                </div>
                <div className="kh-progress-track"><i style={{ width: stage === "requesting" ? "8%" : stage === "completing" ? "96%" : `${Math.max(progress, 2)}%` }} /></div>
              </div>
            )}
            <div className="kh-dialog-actions">
              <button className="kh-secondary-button" type="button" onClick={closeDialog} disabled={isUploading} data-testid="button-cancel-upload">Cancel</button>
              <button className="kh-primary-button" type="button" onClick={() => void handleUpload()} disabled={!selectedFile || isUploading} data-testid="button-confirm-upload">
                {isUploading ? <><LoaderCircle size={16} className="kh-spinning" /> Adding…</> : <><UploadCloud size={16} /> Upload document</>}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default KnowledgeHubDashboard;
