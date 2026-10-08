import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentTable } from "@workspace/api-client-react";

export type DocumentSimplificationJobState = {
  status: "idle" | "starting" | "running" | "completed" | "failed";
  jobId: string | null;
  stage: string;
  message: string;
  currentSection: number;
  totalSections: number;
  completedSections: number;
  processedCharacters: number;
  totalCharacters: number;
  partialResult: string;
  tables: DocumentTable[];
  unchangedTables: string[];
  model: string | null;
  error: string | null;
  isReconnecting: boolean;
};

type JobInput = {
  sourceText: string;
  prompt: string;
  documentMode: true;
  tables: DocumentTable[];
};

type JobEvent = Record<string, unknown> & {
  id: number;
  type: string;
};

const INITIAL_STATE: DocumentSimplificationJobState = {
  status: "idle",
  jobId: null,
  stage: "",
  message: "",
  currentSection: 0,
  totalSections: 0,
  completedSections: 0,
  processedCharacters: 0,
  totalCharacters: 0,
  partialResult: "",
  tables: [],
  unchangedTables: [],
  model: null,
  error: null,
  isReconnecting: false,
};

const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mergeTables(current: DocumentTable[], incoming: unknown): DocumentTable[] {
  if (!Array.isArray(incoming)) return current;
  const byToken = new Map(current.map((table) => [table.token, table]));
  for (const value of incoming) {
    if (
      isRecord(value) &&
      typeof value.token === "string" &&
      Array.isArray(value.rows) &&
      value.rows.every(
        (row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"),
      )
    ) {
      byToken.set(value.token, {
        token: value.token,
        rows: value.rows as string[][],
      });
    }
  }
  return [...byToken.values()];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function useDocumentSimplificationJob() {
  const [state, setState] = useState(INITIAL_STATE);
  const [jobId, setJobId] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const requestGenerationRef = useRef(0);

  const start = useCallback(async (input: JobInput): Promise<void> => {
    const generation = ++requestGenerationRef.current;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setJobId(null);
    setState({
      ...INITIAL_STATE,
      status: "starting",
      message: "Starting the document rewrite.",
    });

    try {
      const response = await fetch(`${API_BASE}/documents/simplification-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (generation !== requestGenerationRef.current) return;
      if (!response.ok) {
        const errorMessage =
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : "Could not start the document rewrite.";
        throw new Error(errorMessage);
      }
      if (!isRecord(payload) || typeof payload.jobId !== "string") {
        throw new Error("The server did not return a document job ID.");
      }

      setState((current) => ({
        ...current,
        status: "running",
        jobId: payload.jobId as string,
        message: "Connecting to the live progress feed.",
      }));
      setJobId(payload.jobId);
    } catch (error) {
      if (generation !== requestGenerationRef.current) return;
      setState({
        ...INITIAL_STATE,
        status: "failed",
        message: "The document rewrite could not be started.",
        error:
          error instanceof Error
            ? error.message
            : "Check your connection and try again.",
      });
    }
  }, []);

  useEffect(() => {
    if (!jobId) return;
    const source = new EventSource(
      `${API_BASE}/documents/simplification-jobs/${encodeURIComponent(jobId)}/events`,
    );
    eventSourceRef.current = source;

    source.onopen = () => {
      setState((current) => ({
        ...current,
        isReconnecting: false,
      }));
    };
    source.onmessage = (message) => {
      let event: JobEvent;
      try {
        const parsed: unknown = JSON.parse(message.data);
        if (!isRecord(parsed) || typeof parsed.type !== "string") return;
        event = parsed as JobEvent;
      } catch {
        return;
      }

      setState((current) => {
        switch (event.type) {
          case "stage":
            return {
              ...current,
              status: "running",
              stage: typeof event.stage === "string" ? event.stage : current.stage,
              message: typeof event.message === "string" ? event.message : current.message,
              isReconnecting: false,
            };
          case "started":
            return {
              ...current,
              status: "running",
              totalSections:
                typeof event.totalSections === "number"
                  ? event.totalSections
                  : current.totalSections,
              totalCharacters:
                typeof event.totalCharacters === "number"
                  ? event.totalCharacters
                  : current.totalCharacters,
              stage: "rewrite",
              message: "The document is divided into ordered sections.",
              isReconnecting: false,
            };
          case "section_started":
            return {
              ...current,
              status: "running",
              currentSection:
                typeof event.section === "number" ? event.section : current.currentSection,
              completedSections:
                typeof event.completedSections === "number"
                  ? event.completedSections
                  : current.completedSections,
              processedCharacters:
                typeof event.processedCharacters === "number"
                  ? event.processedCharacters
                  : current.processedCharacters,
              stage: "rewrite",
              message:
                typeof event.section === "number" &&
                typeof event.totalSections === "number"
                  ? `Rewriting section ${event.section} of ${event.totalSections}.`
                  : "Rewriting the next section.",
              isReconnecting: false,
            };
          case "section_retrying":
            return {
              ...current,
              status: "running",
              currentSection:
                typeof event.section === "number" ? event.section : current.currentSection,
              message: "A section is slow. Splitting it and retrying only that section.",
              isReconnecting: false,
            };
          case "table_validation_started":
            return {
              ...current,
              stage: "table_validation",
              message: `Checking the table structure and protected values in section ${typeof event.section === "number" ? event.section : current.currentSection}.`,
              isReconnecting: false,
            };
          case "table_validation_completed":
            return {
              ...current,
              stage: "rewrite",
              message: "Table checks passed. Continuing with the next section.",
              isReconnecting: false,
            };
          case "finalizing":
            return {
              ...current,
              stage: "finalize",
              message: "Assembling the checked sections into the final document.",
              isReconnecting: false,
            };
          case "section_completed": {
            const result =
              typeof event.result === "string" ? event.result : "";
            const partialResult = result
              ? current.partialResult
                ? `${current.partialResult}\n\n${result}`
                : result
              : current.partialResult;
            const incomingUnchanged = readStringArray(event.unchangedTables);
            return {
              ...current,
              status: "running",
              completedSections:
                typeof event.completedSections === "number"
                  ? event.completedSections
                  : current.completedSections + 1,
              currentSection:
                typeof event.section === "number" ? event.section : current.currentSection,
              processedCharacters:
                typeof event.processedCharacters === "number"
                  ? event.processedCharacters
                  : current.processedCharacters,
              totalCharacters:
                typeof event.totalCharacters === "number"
                  ? event.totalCharacters
                  : current.totalCharacters,
              partialResult,
              tables: mergeTables(current.tables, event.tables),
              unchangedTables: [
                ...new Set([...current.unchangedTables, ...incomingUnchanged]),
              ],
              message:
                typeof event.totalSections === "number"
                  ? `Section ${typeof event.section === "number" ? event.section : current.completedSections + 1} of ${event.totalSections} is ready.`
                  : "A section is ready.",
              isReconnecting: false,
            };
          }
          case "completed":
            return {
              ...current,
              status: "completed",
              stage: "complete",
              message: "All sections are ready.",
              currentSection: current.totalSections,
              completedSections: current.totalSections,
              processedCharacters: current.totalCharacters,
              partialResult:
                typeof event.result === "string"
                  ? event.result
                  : current.partialResult,
              tables: mergeTables([], event.tables),
              unchangedTables: readStringArray(event.unchangedTables),
              model: typeof event.model === "string" ? event.model : current.model,
              error: null,
              isReconnecting: false,
            };
          case "failed":
            return {
              ...current,
              status: "failed",
              stage: "failed",
              message: "The rewrite stopped before all sections were complete.",
              error:
                typeof event.message === "string"
                  ? event.message
                  : "Could not complete the document rewrite.",
              isReconnecting: false,
            };
          default:
            return current;
        }
      });

      if (event.type === "completed" || event.type === "failed") {
        source.close();
        if (eventSourceRef.current === source) eventSourceRef.current = null;
      }
    };
    source.onerror = () => {
      setState((current) =>
        current.status === "running"
          ? { ...current, isReconnecting: true }
          : current,
      );
    };

    return () => {
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
    };
  }, [jobId]);

  const clear = useCallback(() => {
    requestGenerationRef.current += 1;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setJobId(null);
    setState(INITIAL_STATE);
  }, []);

  return { state, start, clear };
}
