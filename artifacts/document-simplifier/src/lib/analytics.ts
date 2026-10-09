type AnalyticsData = Record<string, string | number | boolean>;

export type KnowledgeHubFileType = "pdf" | "txt" | "csv" | "other";

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void;
    };
  }
}

export function trackEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === "undefined") return;

  try {
    window.umami?.track(name, data);
  } catch {
    // Analytics must never break the app.
  }
}

export function getKnowledgeHubFileType(fileName: string): KnowledgeHubFileType {
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "pdf" || extension === "txt" || extension === "csv") return extension;
  return "other";
}
