import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { ArrowRight, ChevronRight, FileSearch, FileText, RotateCcw, Upload } from 'lucide-react';
import './_group.css';

function useExtractPdfDocument() {
  const [error, setError] = useState<Error | null>(null);
  const mutate = useCallback((_file: File) => {
    setError(new Error('PDF extraction is unavailable in this static mockup.'));
  }, []);
  const reset = useCallback(() => setError(null), []);

  return { mutate, reset, isPending: false, isError: !!error, error };
}

export function CurrentDocuments() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [fileError, setFileError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const extract = useExtractPdfDocument();

  useEffect(() => {
    if (!selectedFile) return;
    extract.mutate(selectedFile);
  }, [selectedFile, extract.mutate]);

  function processFile(file?: File) {
    if (!file) return;
    setFileError('');
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setFileError('Choose a PDF file to continue. Only text-based PDFs are supported.');
      return;
    }
    setSelectedFile(file);
    extract.reset();
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    processFile(event.target.files?.[0]);
    event.target.value = '';
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    processFile(event.dataTransfer.files?.[0]);
  }

  return (
    <div className="easy-peasy-docs lab-shell document-page">
      <div className="lab-content mx-auto max-w-[1440px] px-5 pb-10 sm:px-8 lg:px-12">
        <header className="flex min-h-[76px] items-center justify-between gap-4 border-b border-[#d9d7c9] py-3">
          <a href="#" onClick={(event) => event.preventDefault()} data-testid="link-home" className="flex items-center gap-3.5">
            <div className="grid h-9 w-9 place-items-center rounded-[11px] bg-[#29483d] text-[#e8edce]">
              <span className="serif text-[23px] leading-none">p.</span>
            </div>
            <div>
              <div className="text-[14px] font-semibold tracking-[-.025em] text-[#293b33]">Plain Language Lab</div>
              <div className="mono mt-0.5 text-[9px] uppercase tracking-[.16em] text-[#778079]">A document testing workspace</div>
            </div>
          </a>
          <a href="#" onClick={(event) => event.preventDefault()} data-testid="link-back-to-text" className="flex items-center gap-2 rounded-full border border-[#d9d7c9] bg-[#f7f5ec]/75 px-3.5 py-2 text-[11px] font-medium text-[#637267] transition-colors hover:bg-[#eff0e6] hover:text-[#29483d]">
            <ArrowRight size={13} className="rotate-180" /> Text workspace
          </a>
        </header>

        <main className="mx-auto max-w-[1170px]">
          <section className="fade-up flex flex-col justify-between gap-7 pb-8 pt-10 sm:flex-row sm:items-end sm:pb-9 sm:pt-[54px]">
            <div className="max-w-[740px]">
              <div className="mono mb-4 flex items-center gap-2 text-[10px] uppercase tracking-[.19em] text-[#728071]">
                <span className="h-px w-6 bg-[#a9b294]" />
                Document workspace · Phase 1
              </div>
              <h1 className="serif text-[42px] leading-[.99] tracking-[-.045em] text-[#293b33] sm:text-[55px]">
                See what the<br className="hidden sm:block" /> document says.
              </h1>
              <p className="mt-4 max-w-[510px] text-[14px] leading-[1.7] text-[#68746c]">
                Upload a text-based PDF to inspect its extracted words, tables, and images before any plain-language work begins.
              </p>
            </div>
            <div className="hidden min-w-[190px] items-center gap-3 pb-1 sm:flex">
              <div className="grid h-[44px] w-[44px] place-items-center rounded-full border border-[#d6d8c8] bg-[#f3f2e9] text-[#647a68]">
                <FileSearch size={19} strokeWidth={1.5} />
              </div>
              <div className="mono text-[9px] leading-[1.7] tracking-[.08em] text-[#788179]">SOURCE FIRST<br />REVIEW EVERY PART</div>
            </div>
          </section>

          <section className="fade-up-delay grid gap-5 lg:grid-cols-[.84fr_1.16fr]" aria-label="PDF upload and extraction preview">
            <article className="panel overflow-hidden rounded-[17px]">
              <div className="flex h-[62px] items-center gap-3 border-b border-[#e3e1d6] px-5 sm:px-6">
                <span className="mono text-[10px] tracking-[.12em] text-[#9b9a87]">01</span>
                <h2 className="text-[13px] font-semibold tracking-[-.01em] text-[#31433a]">Choose a source</h2>
              </div>
              <div className="p-5 sm:p-6">
                <div
                  className={`drop-zone ${isDragging ? 'is-dragging' : ''} rounded-[13px] px-5 py-8 text-center sm:px-7 sm:py-10`}
                  onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false); }}
                  onDrop={onDrop}
                  data-testid="dropzone-pdf"
                >
                  <input
                    ref={inputRef}
                    id="pdf-upload"
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={onInputChange}
                    className="sr-only"
                    data-testid="input-pdf"
                    aria-label="Choose a text-based PDF"
                  />
                  <div className="mx-auto mb-4 grid h-[52px] w-[52px] place-items-center rounded-full border border-[#d9ddcf] bg-[#f3f4eb] text-[#526d5c]">
                    <Upload size={20} strokeWidth={1.6} />
                  </div>
                  <h3 className="serif text-[23px] tracking-[-.02em] text-[#38483e]">One document, in view.</h3>
                  <p className="mx-auto mt-2 max-w-[280px] text-[12px] leading-[1.7] text-[#788078]">
                    Drop a PDF here, or browse your files to inspect its contents.
                  </p>
                  <label htmlFor="pdf-upload" className="mt-5 inline-flex min-h-[41px] cursor-pointer items-center justify-center gap-2 rounded-[9px] bg-[#29483d] px-4 text-[11px] font-semibold text-[#f5f5e9] shadow-[0_3px_0_#1c372e] transition-colors hover:bg-[#36584b] focus-within:outline-none focus-within:ring-2 focus-within:ring-[#6d8560]" data-testid="button-choose-pdf">
                    <FileText size={14} strokeWidth={1.7} />
                    Choose PDF
                  </label>
                  <div className="mono mt-5 text-[9px] uppercase tracking-[.13em] text-[#9a9f94]">PDF only · Text-based documents</div>
                </div>
                {selectedFile && extract.isPending && (
                  <div className="mt-4 flex items-center gap-3 rounded-[10px] border border-[#e2e2d7] bg-[#f7f7ef] px-3.5 py-3" role="status" data-testid="status-extracting">
                    <span className="h-4 w-4 animate-spin rounded-full border-[1.5px] border-[#99a78d] border-t-transparent" />
                    <div className="min-w-0">
                      <div className="truncate text-[11px] font-medium text-[#4d5d51]">Reading {selectedFile.name}</div>
                      <div className="mono mt-1 text-[9px] uppercase tracking-[.1em] text-[#92998e]">Extracting document structure</div>
                    </div>
                  </div>
                )}
                {fileError && <p className="mt-4 rounded-[9px] border border-[#ead5c9] bg-[#faf1eb] px-3.5 py-3 text-[11px] leading-relaxed text-[#995c4b]" role="alert" data-testid="status-file-error">{fileError}</p>}
                {extract.isError && (
                  <div className="mt-4 rounded-[10px] border border-[#ead5c9] bg-[#faf1eb] p-4" role="alert" data-testid="status-extraction-error">
                    <div className="text-[12px] font-semibold text-[#8f5545]">We couldn’t read this PDF.</div>
                    <p className="mt-1 text-[11px] leading-[1.6] text-[#956c5d]">{extract.error instanceof Error ? extract.error.message : 'Try another text-based PDF.'}</p>
                    <label htmlFor="pdf-upload" className="mt-3 inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold text-[#526d5c] hover:text-[#29483d]" data-testid="button-retry-upload">
                      Choose another file <ChevronRight size={13} />
                    </label>
                  </div>
                )}
              </div>
              <div className="border-t border-[#e3e1d6] bg-[#f5f3eb] px-5 py-4 sm:px-6">
                <div className="mono mb-2 text-[9px] uppercase tracking-[.14em] text-[#858d82]">What happens here</div>
                <p className="text-[11px] leading-[1.7] text-[#737d73]">We extract the document’s existing text, tables, and embedded images for your review. Nothing is rewritten, and scanned-image OCR is not included.</p>
              </div>
            </article>

            <article className="panel flex min-h-[405px] flex-col overflow-hidden rounded-[17px]">
              <div className="flex h-[62px] items-center gap-3 border-b border-[#e3e1d6] px-5 sm:px-6">
                <span className="mono text-[10px] tracking-[.12em] text-[#9b9a87]">02</span>
                <h2 className="text-[13px] font-semibold tracking-[-.01em] text-[#31433a]">Extraction preview</h2>
              </div>
              <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center" data-testid="empty-extraction-preview">
                <div className="relative mb-5 grid h-[62px] w-[62px] place-items-center rounded-full border border-[#e0e1d5] bg-[#f6f5ed]">
                  <div className="absolute inset-[7px] rounded-full border border-dashed border-[#d3d8c7]" />
                  <FileSearch size={19} strokeWidth={1.45} className="text-[#71826d]" />
                </div>
                <h3 className="serif text-[25px] tracking-[-.025em] text-[#46564a]">Your source, made visible.</h3>
                <p className="mt-3 max-w-[290px] text-[12px] leading-[1.7] text-[#8b9187]">
                  After upload, each extracted element appears in reading order with its page reference.
                </p>
              </div>
              <div className="flex h-[48px] items-center justify-between border-t border-[#e3e1d6] bg-[#f8f7f0] px-5 sm:px-6">
                <span className="mono text-[9px] uppercase tracking-[.12em] text-[#999d91]">Reviewable source content</span>
                <span className="mono text-[9px] text-[#a5a89c]">WAITING FOR PDF</span>
              </div>
            </article>
          </section>
          <footer className="flex items-center justify-between py-6">
            <span className="mono text-[9px] uppercase tracking-[.14em] text-[#9a9e92]">Plain words. Better understanding.</span>
            <a href="#" onClick={(event) => event.preventDefault()} className="mono text-[9px] tracking-[.08em] text-[#858d84] hover:text-[#425348]">BACK TO TEXT WORKSPACE</a>
          </footer>
        </main>
      </div>
    </div>
  );
}
