import { useState } from 'react';
import { ArrowDown, ArrowRight, Check, Clipboard, FileText, RotateCcw, Sparkles, X } from 'lucide-react';
import './_group.css';

const DEFAULT_PROMPT = 'Please explain the above in easy layman language with examples';

function useHealthCheck() {
  return { isLoading: true, isSuccess: false, isError: false };
}

function useSimplifyText() {
  const [error, setError] = useState<Error | null>(null);
  return {
    isPending: false,
    isError: !!error,
    error,
    mutate: (..._args: unknown[]) => setError(new Error('Text generation is unavailable in this static mockup.')),
    reset: () => setError(null),
  };
}

export function CurrentHome() {
  const [sourceText, setSourceText] = useState('');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [result, setResult] = useState<{ result: string; model: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const health = useHealthCheck();
  const simplify = useSimplifyText();

  const canGenerate = sourceText.trim().length > 0 && prompt.trim().length > 0 && !simplify.isPending;

  function generate() {
    if (!canGenerate) return;
    setCopied(false);
    setResult(null);
    simplify.mutate(
      { data: { sourceText, prompt } },
      { onSuccess: (response: { result: string; model: string }) => setResult(response) },
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
    <div className="easy-peasy-docs lab-shell">
      <div className="lab-content mx-auto max-w-[1440px] px-5 pb-10 sm:px-8 lg:px-12">
        <header className="flex h-[76px] items-center justify-between border-b border-[#d9d7c9]">
          <div className="flex items-center gap-3.5">
            <div className="grid h-9 w-9 place-items-center rounded-[11px] bg-[#29483d] text-[#e8edce]">
              <span className="serif text-[23px] leading-none">p.</span>
            </div>
            <div>
              <div className="text-[14px] font-semibold tracking-[-.025em] text-[#293b33]">Plain Language Lab</div>
              <div className="mono mt-0.5 text-[9px] uppercase tracking-[.16em] text-[#778079]">A document testing workspace</div>
            </div>
          </div>
          <div className="flex items-center gap-3 sm:gap-5">
            <a href="#" onClick={(event) => event.preventDefault()} data-testid="link-create-document" className="group max-w-[138px] text-right leading-tight text-[#42594b] transition-colors hover:text-[#29483d] sm:max-w-none sm:text-left">
              <span className="block text-[11px] font-semibold sm:text-[12px]">Create a simplified document</span>
              <span className="mt-1 block max-w-[132px] text-[8px] leading-[1.35] text-[#879087] sm:max-w-none sm:text-[10px]">Review extracted text, tables, and images from a PDF</span>
            </a>
            <div className="flex shrink-0 items-center gap-2 rounded-full border border-[#d9d7c9] bg-[#f7f5ec]/75 px-2.5 py-1.5 sm:px-3">
              <span className={`h-1.5 w-1.5 rounded-full ${isServiceReady ? 'bg-[#708d55]' : health.isError ? 'bg-[#b75f4d]' : 'bg-[#c6a54d]'}`} />
              <span className="mono hidden text-[10px] uppercase tracking-[.12em] text-[#68746c] sm:inline">
                {health.isLoading ? 'Connecting' : isServiceReady ? 'Ready to test' : health.isError ? 'Service offline' : 'Starting'}
              </span>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-[1170px]">
          <section className="fade-up relative flex flex-col justify-between gap-7 pb-8 pt-10 sm:flex-row sm:items-end sm:pb-9 sm:pt-[54px]">
            <div className="max-w-[700px]">
              <div className="mono mb-4 flex items-center gap-2 text-[10px] uppercase tracking-[.19em] text-[#728071]">
                <span className="h-px w-6 bg-[#a9b294]" />
                Make the complicated make sense
              </div>
              <h1 className="serif text-[42px] leading-[.99] tracking-[-.045em] text-[#293b33] sm:text-[55px]">
                Clarity, put<br className="hidden sm:block" /> to the test.
              </h1>
              <p className="mt-4 max-w-[445px] text-[14px] leading-[1.7] text-[#68746c]">
                Try your plain-language prompt against the real thing. Read the result, decide if it feels right, then refine.
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
                  <h2 className="text-[13px] font-semibold tracking-[-.01em] text-[#31433a]">Source document</h2>
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
                  <h2 className="text-[13px] font-semibold tracking-[-.01em] text-[#31433a]">Plain-language result</h2>
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
        .easy-peasy-docs .skeleton-line {
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
