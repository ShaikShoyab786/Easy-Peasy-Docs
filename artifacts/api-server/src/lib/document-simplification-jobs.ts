import { randomUUID } from "node:crypto";

export type DocumentSimplificationJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type DocumentSimplificationJobEvent = {
  id: number;
  type: string;
  [key: string]: unknown;
};

type JobRecord = {
  id: string;
  createdAt: number;
  finishedAt: number | null;
  status: DocumentSimplificationJobStatus;
  events: DocumentSimplificationJobEvent[];
  listeners: Set<(event: DocumentSimplificationJobEvent) => void>;
};

export class DocumentJobCapacityError extends Error {
  readonly statusCode = 429;

  constructor(message: string) {
    super(message);
    this.name = "DocumentJobCapacityError";
  }
}

const jobs = new Map<string, JobRecord>();
const MAX_ACTIVE_JOBS = 3;
const MAX_RETAINED_JOBS = 20;
const JOB_TTL_MS = 30 * 60 * 1_000;
const TERMINAL_STATUSES = new Set<DocumentSimplificationJobStatus>([
  "completed",
  "failed",
]);

function pruneJobs(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (
      TERMINAL_STATUSES.has(job.status) &&
      now - (job.finishedAt ?? job.createdAt) > JOB_TTL_MS
    ) {
      jobs.delete(id);
    }
  }

  while (jobs.size >= MAX_RETAINED_JOBS) {
    const oldestTerminal = [...jobs.values()]
      .filter((job) => TERMINAL_STATUSES.has(job.status))
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!oldestTerminal) break;
    jobs.delete(oldestTerminal.id);
  }
}

export function createDocumentSimplificationJob(): JobRecord {
  pruneJobs();
  const activeJobs = [...jobs.values()].filter((job) =>
    !TERMINAL_STATUSES.has(job.status),
  ).length;
  if (activeJobs >= MAX_ACTIVE_JOBS) {
    throw new DocumentJobCapacityError(
      "Three PDF simplification jobs are already running. Wait for one to finish, then try again.",
    );
  }
  if (jobs.size >= MAX_RETAINED_JOBS) {
    throw new DocumentJobCapacityError(
      "The PDF simplification service is temporarily full. Try again shortly.",
    );
  }

  const job: JobRecord = {
    id: randomUUID(),
    createdAt: Date.now(),
    finishedAt: null,
    status: "queued",
    events: [],
    listeners: new Set(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getDocumentSimplificationJob(
  jobId: string,
): JobRecord | undefined {
  pruneJobs();
  return jobs.get(jobId);
}

export function publishDocumentSimplificationJobEvent(
  jobId: string,
  data: Record<string, unknown>,
): DocumentSimplificationJobEvent | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;

  const event: DocumentSimplificationJobEvent = {
    ...data,
    id: job.events.length ? job.events[job.events.length - 1].id + 1 : 1,
    type: typeof data.type === "string" ? data.type : "unknown",
  };
  job.events.push(event);
  for (const listener of job.listeners) listener(event);
  return event;
}

export function setDocumentSimplificationJobStatus(
  jobId: string,
  status: DocumentSimplificationJobStatus,
): void {
  const job = jobs.get(jobId);
  if (job) {
    job.status = status;
    job.finishedAt = TERMINAL_STATUSES.has(status) ? Date.now() : null;
  }
}

export function getDocumentSimplificationJobEventsAfter(
  jobId: string,
  eventId: number,
): DocumentSimplificationJobEvent[] {
  const job = jobs.get(jobId);
  return job ? job.events.filter((event) => event.id > eventId) : [];
}

export function subscribeToDocumentSimplificationJob(
  jobId: string,
  listener: (event: DocumentSimplificationJobEvent) => void,
): (() => void) | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}
