import { useEffect, useRef, useState, type DragEvent, type ChangeEvent } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useHealthCheck, useSimplifyText, useExtractPdfDocument, getHealthCheckQueryKey } from '@workspace/api-client-react';
import type { DocumentExtraction } from '@workspace/api-client-react';
import { ArrowDown, ArrowRight, Check, Clipboard, FileText, RotateCcw, Sparkles, X, Upload, FileSearch, Image as ImageIcon, Table2, ChevronRight } from 'lucide-react';
import { Link, Route, Switch } from 'wouter';

const queryClient = new QueryClient();
const DEFAULT_PROMPT = 'Please explain the above in easy layman language with examples';

function Home() {
  const [sourceText, setSourceText] = useState('');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [result, setResult] = useState<{ result: string; model: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const health = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30_000 },
  });
  const simplify = useSimplifyText();

  const canGenerate = sourceText.trim().length > 0 && prompt.trim().length > 0 && !simplify.isPending;

  function generate() {
    if (!canGenerate) return;
    setCopied(false);
    setResult(null);
    simplify.mutate(
      { data: { sourceText, prompt } },
      { onSuccess: (response) => setResult(response) },
    );
  }

  function clearSource() {
    setSourceText('');
    setResult(null);
    setCopied(false);
    simplify.reset();
  }

  async function copyOutput() {
    if (!result?.result) return;
    try {
      await navigator.clipboard.writeText(result.result);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  const isServiceReady = health.isSuccess;

  return (
    <div className="lab-shell">
      <div className="lab-content mx-auto max-w-[1440px] px-5 pb-10 sm:px-8 lg:px-12">
        <header className="flex h-[76px] items-center justify-between border-b border-[#d9d7c9]">
          <div className="flex items-center gap-3.5">
            <div className="grid h-9 w-9 place-items-center rounded-[11px] bg-[#29483d] text-[#e8edce]">
              <span className="text-[19px] font-extrabold tracking-[-.08em]">EP</span>
            </div>
            <div>
              <div className="text-[15px] font-extrabold tracking-[-.04em] text-[#293b33]">Easy Peasy Docs</div>
              <div className="mono mt-0.5 hidden text-[10px] uppercase tracking-[.12em] text-[#778079] sm:block">Policy clarity workspace</div>
            </div>
          </div>
          <div className="flex items-center gap-3 sm:gap-5">
            <Link href="/documents" data-testid="link-create-document" className="group max-w-[138px] text-right leading-tight text-[#42594b] transition-colors hover:text-[#29483d] sm:max-w-none sm:text-left">
              <span className="block text-[12px] font-bold sm:text-[13px]">Review a PDF</span>
              <span className="mt-1 hidden max-w-[132px] text-[10px] leading-[1.4] text-[#879087] sm:block sm:max-w-none sm:text-[11px]">Inspect extracted text, tables, and images</span>
            </Link>
            <div className="flex shrink-0 items-center gap-2 rounded-full border border-[#d9d7c9] bg-[#f7f5ec]/75 px-2.5 py-1.5 sm:px-3">
              <span className={`h-1.5 w-1.5 rounded-full ${isServiceReady ? 'bg-[#708d55]' : health.isError ? 'bg-[#b75f4d]' : 'bg-[#c6a54d]'}`} />
              <span className="mono text-[10px] uppercase tracking-[.12em] text-[#68746c]">
                {health.isLoading ? 'Connecting' : isServiceReady ? 'Ready' : health.isError ? 'Service offline' : 'Starting'}
              </span>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-[1170px]">
          <section className="fade-up relative flex flex-col justify-between gap-7 pb-8 pt-10 sm:flex-row sm:items-end sm:pb-9 sm:pt-[54px]">
            <div className="max-w-[700px]">
              <div className="mono mb-4 flex items-center gap-2 text-[10px] uppercase tracking-[.19em] text-[#728071]">
                <span className="h-px w-6 bg-[#a9b294]" />
                MAKE IT EASY PEASY
              </div>
              <h1 className="serif text-[42px] leading-[.99] tracking-[-.045em] text-[#293b33] sm:text-[55px]">
                Policies simplified,<br className="hidden sm:block" /> in seconds.
              </h1>
              <p className="mt-4 max-w-[445px] text-[14px] leading-[1.7] text-[#68746c]">
                Paste a policy to generate a plain-language rewrite, or inspect a text-based PDF in the review workspace. No emojis, no fluff, just pure clarity.
              </p>
            </div>
            <div className="hidden min-w-[186px] items-center gap-3 pb-1 sm:flex">
              <div className="relative h-[44px] w-[44px] rounded-full border border-[#d6d8c8]">
                <span className="absolute left-[10px] top-[9px] h-[24px] w-[15px] rotate-[-22deg] rounded-[2px] border border-[#6f8069] bg-[#e5e9d7]" />
                <span className="absolute bottom-[8px] right-[8px] h-[18px] w-[13px] rotate-[18deg] rounded-[2px] border border-[#b28b5e] bg-[#f1e6d2]" />
              </div>
              <div className="mono text-[9px] leading-[1.7] tracking-[.08em] text-[#788179]">
                SOURCE → SENSE<br />ONE PASS AT A TIME
              </div>
            </div>
          </section>

          <section className="fade-up-delay grid gap-5 lg:grid-cols-[1fr_1fr]" aria-label="Text testing workspace">
            <article className="panel overflow-hidden rounded-[17px]">
              <div className="flex h-[62px] items-center justify-between border-b border-[#e3e1d6] px-5 sm:px-6">
                <div className="flex items-center gap-3">
                  <span className="mono text-[10px] tracking-[.12em] text-[#9b9a87]">01</span>
                  <h2 className="text-[15px] font-bold tracking-[-.02em] text-[#31433a]">Source Document</h2>
                </div>
                {sourceText.length > 0 && (
                  <button
                    type="button"
                    onClick={clearSource}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-[#7d847c] transition-colors hover:bg-[#f0efe6] hover:text-[#32453a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d8560]"
                    data-testid="button-clear-input"
                    aria-label="Clear source text"
                  >
                    <X size={13} strokeWidth={1.8} /> Clear
                  </button>
                )}
              </div>
              <div className="px-5 pt-4 sm:px-6">
                <label htmlFor="source-text" className="mono text-[9px] uppercase tracking-[.14em] text-[#8b9288]">Paste the difficult bit</label>
                <textarea
                  id="source-text"
                  value={sourceText}
                  onChange={(event) => {
                    setSourceText(event.target.value.slice(0, 60_000));
                    setCopied(false);
                  }}
                  placeholder="Paste a policy, benefits note, or any company text you want to make clearer…"
                  maxLength={60000}
                  className="textarea-reset mt-3 min-h-[245px] w-full rounded-none border-0 bg-transparent p-0 text-[14px] leading-[1.75] text-[#35463d] placeholder:text-[#a6aaa0] focus-visible:ring-0 sm:min-h-[274px]"
                  data-testid="input-source-text"
                />
                <div className="flex items-center justify-between border-t border-[#ebe9df] py-3.5">
                  <span className="flex items-center gap-1.5 text-[11px] text-[#878d83]">
                    <FileText size={12} strokeWidth={1.7} />
                    Source text
                  </span>
                  <span className="mono text-[10px] tabular-nums text-[#858d84]" data-testid="text-character-count">
                    {sourceText.length.toLocaleString()} <span className="text-[#b0b2a8]">/ 60,000</span>
                  </span>
                </div>
              </div>
              <div className="border-t border-[#e3e1d6] bg-[#f5f3eb] px-5 py-4 sm:px-6">
                <label htmlFor="prompt-text" className="mb-2 flex items-center justify-between">
                  <span className="mono text-[9px] uppercase tracking-[.14em] text-[#858d82]">Your prompt</span>
                  <span className="mono text-[9px] text-[#a0a397]">EDITABLE</span>
                </label>
                <textarea
                  id="prompt-text"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value.slice(0, 2000))}
                  maxLength={2000}
                  rows={2}
                  className="textarea-reset w-full rounded-[8px] border border-[#deded1] bg-[#faf9f3] px-3 py-2.5 text-[12px] leading-[1.6] text-[#3d4b42] placeholder:text-[#a6aaa0] focus-visible:border-[#8fa17c]"
                  data-testid="input-prompt"
                />
                <div className="mt-4 flex items-center justify-between gap-3">
                  <span className="hidden text-[10px] text-[#8b9087] sm:inline">Same prompt. Real output.</span>
                  <button
                    type="button"
                    onClick={generate}
                    disabled={!canGenerate}
                    className="group flex min-h-[42px] w-full items-center justify-center gap-2 rounded-[9px] bg-[#29483d] px-5 text-[12px] font-semibold text-[#f5f5e9] shadow-[0_3px_0_#1c372e] transition-all hover:bg-[#36584b] active:translate-y-[2px] active:shadow-none disabled:cursor-not-allowed disabled:bg-[#a4ada2] disabled:shadow-none sm:w-auto sm:min-w-[153px]"
                    data-testid="button-generate"
                  >
                    {simplify.isPending ? (
                      <>
                        <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-[#c5d0c2] border-t-transparent" />
                        Working
                      </>
                    ) : (
                      <>
                        <Sparkles size={14} strokeWidth={1.8} />
                        Generate
                        <ArrowRight className="transition-transform group-hover:translate-x-0.5" size={14} strokeWidth={1.8} />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </article>

            <article className="panel flex min-h-[540px] flex-col overflow-hidden rounded-[17px] lg:min-h-0">
              <div className="flex h-[62px] shrink-0 items-center justify-between border-b border-[#e3e1d6] px-5 sm:px-6">
                <div className="flex items-center gap-3">
                  <span className="mono text-[10px] tracking-[.12em] text-[#9b9a87]">02</span>
                  <h2 className="text-[15px] font-bold tracking-[-.02em] text-[#31433a]">Easy Layman Language Output</h2>
                </div>
                {result && (
                  <button
                    type="button"
                    onClick={copyOutput}
                    className="flex items-center gap-1.5 rounded-md border border-[#dedfd3] bg-[#faf9f3] px-2.5 py-1.5 text-[11px] font-medium text-[#526255] transition-colors hover:border-[#b9c0ad] hover:bg-[#f0f2e7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d8560]"
                    data-testid="button-copy-output"
                  >
                    {copied ? <Check size={13} /> : <Clipboard size={13} strokeWidth={1.7} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                )}
              </div>
              <div className="relative flex flex-1 flex-col px-5 py-5 sm:px-6">
                {simplify.isPending ? (
                  <div className="flex flex-1 flex-col gap-4 pt-2" role="status" aria-label="Generating plain-language result" data-testid="status-generating">
                    <div className="flex items-center gap-2 pb-2">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-[#91a575]" />
                      <span className="mono text-[10px] uppercase tracking-[.12em] text-[#879080]">Finding the clear version</span>
                    </div>
                    <div className="skeleton-line w-[94%]" />
                    <div className="skeleton-line w-[88%]" />
                    <div className="skeleton-line w-[72%]" />
                    <div className="skeleton-line mt-4 w-[91%]" />
                    <div className="skeleton-line w-[63%]" />
                    <div className="skeleton-line mt-4 w-[82%]" />
                    <div className="skeleton-line w-[49%]" />
                  </div>
                ) : simplify.isError ? (
                  <div className="flex flex-1 flex-col items-center justify-center px-4 text-center" data-testid="status-generation-error">
                    <div className="mb-4 grid h-11 w-11 place-items-center rounded-full border border-[#e3d3c4] bg-[#f8eee4] text-[#a9604d]">
                      <RotateCcw size={17} strokeWidth={1.6} />
                    </div>
                    <h3 className="serif text-[23px] tracking-[-.02em] text-[#38483e]">That didn’t come through.</h3>
                    <p className="mt-2 max-w-[295px] text-[12px] leading-[1.65] text-[#788078]">
                      {simplify.error instanceof Error ? simplify.error.message : 'Please try generating the result again.'}
                    </p>
                    <button
                      type="button"
                      onClick={generate}
                      disabled={!canGenerate}
                      className="mt-5 inline-flex items-center gap-2 rounded-md border border-[#d8dacd] bg-[#fbfaf5] px-3.5 py-2 text-[11px] font-semibold text-[#526255] transition-colors hover:bg-[#f0f1e7] disabled:opacity-50"
                      data-testid="button-retry"
                    >
                      <RotateCcw size={12} /> Try again
                    </button>
                  </div>
                ) : result ? (
                  <>
                    <div className="mb-4 flex items-center justify-between">
                      <span className="mono flex items-center gap-2 text-[9px] uppercase tracking-[.13em] text-[#829079]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[#82965e]" /> Result
                      </span>
                      <span className="mono max-w-[52%] truncate text-[9px] tracking-[.04em] text-[#a0a397]" title={result.model}>
                        {result.model}
                      </span>
                    </div>
                    <div className="whitespace-pre-wrap text-[14px] leading-[1.85] text-[#39493f]" data-testid="text-generated-output">
                      {result.result}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center py-12 text-center" data-testid="empty-generated-output">
                    <div className="relative mb-5 grid h-[62px] w-[62px] place-items-center rounded-full border border-[#e0e1d5] bg-[#f6f5ed]">
                      <div className="absolute inset-[7px] rounded-full border border-dashed border-[#d3d8c7]" />
                      <ArrowDown size={19} strokeWidth={1.45} className="text-[#71826d]" />
                    </div>
                    <h3 className="serif text-[25px] tracking-[-.025em] text-[#46564a]">The clearer version<br />will appear here.</h3>
                    <p className="mt-3 max-w-[235px] text-[12px] leading-[1.7] text-[#8b9187]">
                      Add a source document, then run your prompt to see how it reads.
                    </p>
                  </div>
                )}
              </div>
              <div className="flex h-[48px] shrink-0 items-center justify-between border-t border-[#e3e1d6] bg-[#f8f7f0] px-5 sm:px-6">
                <span className="mono text-[9px] uppercase tracking-[.12em] text-[#999d91]">
                  {result ? 'Generated text' : 'Output'}
                </span>
                {result && (
                  <span className="mono text-[10px] tabular-nums text-[#858d84]" data-testid="text-output-count">
                    {result.result.length.toLocaleString()} characters
                  </span>
                )}
              </div>
            </article>
          </section>
          <footer className="flex items-center justify-between py-6">
            <span className="mono text-[9px] uppercase tracking-[.14em] text-[#9a9e92]">Plain words. Better understanding.</span>
            <span className="mono text-[9px] tracking-[.08em] text-[#a5a89c]">01 / 01</span>
          </footer>
        </main>
      </div>
      <style>{`
        .skeleton-line {
          height: 10px;
          max-width: 100%;
          border-radius: 99px;
          background: linear-gradient(90deg, #e9e9df 0%, #f1f1e9 48%, #e9e9df 100%);
          background-size: 200% 100%;
          animation: skeletonFade 1.3s ease-in-out infinite alternate;
        }
        @keyframes skeletonFade {
          from { opacity: .56; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function Documents() {
  const [extraction, setExtraction] = useState<DocumentExtraction | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [fileError, setFileError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const extract = useExtractPdfDocument({
    request: {
      headers: selectedFile ? { 'X-File-Name': selectedFile.name } : undefined,
    },
  });

  useEffect(() => {
    if (!selectedFile) return;
    extract.mutate({ data: selectedFile }, {
      onSuccess: (response) => setExtraction(response),
    });
  }, [selectedFile, extract.mutate]);

  function processFile(file?: File) {
    if (!file) return;
    setFileError('');
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setFileError('Choose a PDF file to continue. Only text-based PDFs are supported.');
      return;
    }
    setSelectedFile(file);
    setExtraction(null);
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

  function resetDocument() {
    setExtraction(null);
    setSelectedFile(null);
    setFileError('');
    extract.reset();
  }

  const blocks = extraction?.blocks ?? [];
  const hasContent = !!extraction && (blocks.length > 0 || extraction.extractedText.length > 0);

  return (
    <div className="lab-shell document-page">
      <div className="lab-content mx-auto max-w-[1440px] px-5 pb-10 sm:px-8 lg:px-12">
        <header className="flex min-h-[76px] items-center justify-between gap-4 border-b border-[#d9d7c9] py-3">
          <Link href="/" data-testid="link-home" className="flex items-center gap-3.5">
            <div className="grid h-9 w-9 place-items-center rounded-[11px] bg-[#29483d] text-[#e8edce]">
              <span className="text-[19px] font-extrabold tracking-[-.08em]">EP</span>
            </div>
            <div>
              <div className="text-[15px] font-extrabold tracking-[-.04em] text-[#293b33]">Easy Peasy Docs</div>
              <div className="mono mt-0.5 hidden text-[10px] uppercase tracking-[.12em] text-[#778079] sm:block">Policy clarity workspace</div>
            </div>
          </Link>
          <Link href="/" data-testid="link-back-to-text" className="flex items-center gap-2 whitespace-nowrap rounded-full border border-[#d9d7c9] bg-[#f7f5ec]/75 px-3.5 py-2 text-[11px] font-medium text-[#637267] transition-colors hover:bg-[#eff0e6] hover:text-[#29483d]">
            <ArrowRight size={13} className="rotate-180" /> Text workspace
          </Link>
        </header>

        <main className="mx-auto max-w-[1170px]">
          <section className="fade-up flex flex-col justify-between gap-7 pb-8 pt-10 sm:flex-row sm:items-end sm:pb-9 sm:pt-[54px]">
            <div className="max-w-[740px]">
            <div className="mono mb-4 flex items-center gap-2 text-[11px] uppercase tracking-[.16em] text-[#728071]">
                <span className="h-px w-6 bg-[#a9b294]" />
                PDF review workspace
              </div>
              <h1 className="serif text-[42px] leading-[.99] tracking-[-.045em] text-[#293b33] sm:text-[55px]">
                See what your<br className="hidden sm:block" /> PDF contains.
              </h1>
              <p className="mt-4 max-w-[510px] text-[14px] leading-[1.7] text-[#68746c]">
                Upload a text-based PDF to review extracted text, tables, embedded images, and source pages.
              </p>
            </div>
            <div className="hidden min-w-[190px] items-center gap-3 pb-1 sm:flex">
              <div className="grid h-[44px] w-[44px] place-items-center rounded-full border border-[#d6d8c8] bg-[#f3f2e9] text-[#647a68]">
                <FileSearch size={19} strokeWidth={1.5} />
              </div>
              <div className="mono text-[9px] leading-[1.7] tracking-[.08em] text-[#788179]">SOURCE FIRST<br />REVIEW EVERY PART</div>
            </div>
          </section>

          {!extraction && (
            <section className="fade-up-delay grid gap-5 lg:grid-cols-[.84fr_1.16fr]" aria-label="PDF upload and extraction preview">
              <article className="panel overflow-hidden rounded-[17px]">
                <div className="flex h-[62px] items-center gap-3 border-b border-[#e3e1d6] px-5 sm:px-6">
                  <span className="mono text-[10px] tracking-[.12em] text-[#9b9a87]">01</span>
                  <h2 className="text-[15px] font-bold tracking-[-.02em] text-[#31433a]">Choose a source PDF</h2>
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
                  <h2 className="text-[15px] font-bold tracking-[-.02em] text-[#31433a]">Extraction preview</h2>
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
          )}

          {extraction && (
            <section className="fade-up-delay" aria-label="Extracted document preview">
              <div className="mb-5 flex flex-col justify-between gap-4 rounded-[14px] border border-[#d9d7c9] bg-[#f9f8f1] px-4 py-4 sm:flex-row sm:items-center sm:px-5">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-[#e8ecdf] text-[#4f6b58]"><FileText size={18} /></div>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-[#34463a]" data-testid="text-document-name">{extraction.fileName}</div>
                    <div className="mono mt-1 text-[9px] uppercase tracking-[.11em] text-[#8b9288]" data-testid="text-page-count">{extraction.pageCount} {extraction.pageCount === 1 ? 'page' : 'pages'} · Extraction complete</div>
                  </div>
                </div>
                <button type="button" onClick={resetDocument} className="inline-flex min-h-[36px] shrink-0 items-center justify-center gap-2 rounded-[8px] border border-[#d8dacd] bg-[#fbfaf5] px-3 text-[11px] font-semibold text-[#526255] transition-colors hover:bg-[#f0f1e7]" data-testid="button-upload-another">
                  <RotateCcw size={13} /> Choose another PDF
                </button>
              </div>

              <div className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <div className="rounded-[11px] border border-[#e0dfd4] bg-[#f8f7f0] px-3.5 py-3">
                  <div className="mono text-[9px] uppercase tracking-[.1em] text-[#90968b]">Pages omitted</div>
                  <div className="mt-1.5 text-[19px] font-semibold tracking-[-.04em] text-[#425348]" data-testid="count-skipped-pages">{extraction.summary.skippedIndexPages}</div>
                  <div className="text-[10px] text-[#8a9187]">Index pages</div>
                </div>
                <div className="rounded-[11px] border border-[#e0dfd4] bg-[#f8f7f0] px-3.5 py-3">
                  <div className="mono text-[9px] uppercase tracking-[.1em] text-[#90968b]">Page numbers</div>
                  <div className="mt-1.5 text-[19px] font-semibold tracking-[-.04em] text-[#425348]" data-testid="count-removed-page-numbers">{extraction.summary.removedPageNumberLines}</div>
                  <div className="text-[10px] text-[#8a9187]">Lines removed</div>
                </div>
                <div className="rounded-[11px] border border-[#e0dfd4] bg-[#f8f7f0] px-3.5 py-3">
                  <div className="mono text-[9px] uppercase tracking-[.1em] text-[#90968b]">Bylines</div>
                  <div className="mt-1.5 text-[19px] font-semibold tracking-[-.04em] text-[#425348]" data-testid="count-removed-bylines">{extraction.summary.removedAuthorBylines}</div>
                  <div className="text-[10px] text-[#8a9187]">Lines removed</div>
                </div>
                <div className="rounded-[11px] border border-[#e0dfd4] bg-[#f8f7f0] px-3.5 py-3">
                  <div className="mono text-[9px] uppercase tracking-[.1em] text-[#90968b]">Included</div>
                  <div className="mt-1.5 flex items-baseline gap-2 text-[19px] font-semibold tracking-[-.04em] text-[#425348]">
                    <span data-testid="count-images">{extraction.summary.imageCount}</span><span className="text-[10px] font-normal tracking-normal text-[#8a9187]">images</span>
                    <span className="text-[10px] font-normal tracking-normal text-[#b0b2a8]">·</span>
                    <span data-testid="count-tables">{extraction.summary.tableCount}</span><span className="text-[10px] font-normal tracking-normal text-[#8a9187]">tables</span>
                  </div>
                  <div className="text-[10px] text-[#8a9187]">Found in source</div>
                </div>
              </div>

              <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
                <article className="panel overflow-hidden rounded-[17px]">
                  <div className="flex min-h-[62px] items-center justify-between gap-3 border-b border-[#e3e1d6] px-5 sm:px-6">
                    <div className="flex items-center gap-3">
                      <span className="mono text-[10px] tracking-[.12em] text-[#9b9a87]">01</span>
                      <h2 className="text-[13px] font-semibold text-[#31433a]">Extracted content</h2>
                    </div>
                    <span className="mono text-[9px] uppercase tracking-[.1em] text-[#969b90]" data-testid="text-block-count">{blocks.length || (extraction.extractedText ? 1 : 0)} items</span>
                  </div>
                  <div className="divide-y divide-[#e8e6dc]">
                    {blocks.map((block, index) => (
                      <section className="document-block px-5 py-5 sm:px-6" key={`${block.sequence}-${index}`} data-testid={`extracted-block-${index}`}>
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <span className="grid h-6 w-6 place-items-center rounded-[7px] bg-[#f0f1e8] text-[#70806f]">
                              {block.type === 'table' ? <Table2 size={13} /> : block.type === 'image' ? <ImageIcon size={13} /> : <FileText size={13} />}
                            </span>
                            <span className="mono text-[9px] uppercase tracking-[.12em] text-[#818b80]">{block.type} · {String(block.sequence).padStart(2, '0')}</span>
                          </div>
                          <span className="mono shrink-0 text-[9px] uppercase tracking-[.08em] text-[#9a9e92]">Page {block.pageIndex + 1}</span>
                        </div>
                        {block.type === 'text' && <p className="whitespace-pre-wrap text-[13px] leading-[1.85] text-[#46564b]" data-testid={`extracted-text-${index}`}>{block.text}</p>}
                        {block.type === 'table' && (
                          block.rows?.length ? <div className="overflow-x-auto rounded-[8px] border border-[#e4e2d7]">
                            <table className="document-table w-full min-w-[360px] border-collapse text-[11px]" data-testid={`extracted-table-${index}`}>
                              <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
                            </table>
                          </div> : <p className="text-[11px] italic text-[#899087]">No table cells were returned for this item.</p>
                        )}
                        {block.type === 'image' && (
                          <div className="rounded-[10px] border border-[#e5e4db] bg-[#f7f6ef] p-3">
                            {block.imageDataUrl ? <img src={block.imageDataUrl} alt={`Extracted image from page ${block.pageIndex + 1}`} className="mx-auto max-h-[560px] max-w-full object-contain" data-testid={`extracted-image-${index}`} /> : <div className="flex min-h-[110px] flex-col items-center justify-center gap-2 text-center text-[#879187]"><ImageIcon size={22} strokeWidth={1.5} /><span className="text-[11px]">Image preview unavailable</span></div>}
                            {(block.imageWidth || block.imageHeight || block.imageMimeType) && <div className="mono mt-3 text-center text-[9px] uppercase tracking-[.1em] text-[#939a90]">{block.imageMimeType || 'Image'}{block.imageWidth && block.imageHeight ? ` · ${block.imageWidth} × ${block.imageHeight}` : ''}</div>}
                          </div>
                        )}
                      </section>
                    ))}
                    {!blocks.length && extraction.extractedText && (
                      <section className="px-5 py-5 sm:px-6" data-testid="extracted-text-fallback">
                        <div className="mono mb-3 text-[9px] uppercase tracking-[.12em] text-[#818b80]">Extracted text</div>
                        <p className="whitespace-pre-wrap text-[13px] leading-[1.85] text-[#46564b]">{extraction.extractedText}</p>
                      </section>
                    )}
                    {!hasContent && (
                      <div className="px-6 py-14 text-center" data-testid="empty-extracted-content">
                        <div className="serif text-[22px] text-[#46564a]">No readable content found.</div>
                        <p className="mx-auto mt-2 max-w-[330px] text-[12px] leading-[1.7] text-[#8b9187]">This file may contain scanned pages. Image-based OCR is not part of this preview.</p>
                      </div>
                    )}
                  </div>
                </article>

                <aside className="panel rounded-[15px] p-5 sm:p-5">
                  <div className="mono mb-3 text-[9px] uppercase tracking-[.14em] text-[#858d82]">How to read this</div>
                  <h3 className="serif text-[21px] leading-tight tracking-[-.02em] text-[#38483e]">The source stays in charge.</h3>
                  <p className="mt-2 text-[11px] leading-[1.75] text-[#737d73]">Items are shown in the order they were found. Page references help you compare each part with the original PDF.</p>
                  <div className="my-4 h-px bg-[#e8e6dc]" />
                  <ul className="space-y-3 text-[11px] leading-[1.6] text-[#768076]">
                    <li className="flex gap-2.5"><FileText size={14} className="mt-0.5 shrink-0 text-[#788874]" /><span>Text is extracted as readable content.</span></li>
                    <li className="flex gap-2.5"><Table2 size={14} className="mt-0.5 shrink-0 text-[#788874]" /><span>Tables preserve their rows and cells.</span></li>
                    <li className="flex gap-2.5"><ImageIcon size={14} className="mt-0.5 shrink-0 text-[#788874]" /><span>Embedded images appear when available.</span></li>
                  </ul>
                  <div className="mt-5 rounded-[9px] bg-[#f1f2e9] px-3 py-3 text-[10px] leading-[1.65] text-[#758073]">This is an extraction preview only. No rewriting or document export happens here.</div>
                </aside>
              </div>
            </section>
          )}
          <footer className="flex items-center justify-between py-6">
            <span className="mono text-[10px] uppercase tracking-[.12em] text-[#9a9e92]">Easy Peasy Docs · PDF review</span>
            <Link href="/" className="mono text-[9px] tracking-[.08em] text-[#858d84] hover:text-[#425348]">BACK TO TEXT WORKSPACE</Link>
          </footer>
        </main>
      </div>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/documents" component={Documents} />
        <Route><Home /></Route>
      </Switch>
    </QueryClientProvider>
  );
}

export default App;
