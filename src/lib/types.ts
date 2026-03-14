export type Severity = "critical" | "high" | "moderate" | "clean" | "info"

export interface Flag {
  phase: string
  severity: Severity
  title: string
  detail: string
}

export interface VerificationResult {
  // Dual scores
  imageAuthenticityScore: number   // Is the photo itself real/unmanipulated? 0-100
  claimAccuracyScore: number       // Does the claim match what the image shows? 0-100
  overallScore: number             // Weighted combined score
  confidence: "HIGH" | "MEDIUM" | "LOW"
  verdict: "VERIFIED" | "LIKELY AUTHENTIC" | "UNVERIFIABLE" | "LIKELY FALSE" | "NEEDS EXPERT REVIEW"
  verdictColor: "teal" | "amber" | "red"
  flags: Flag[]
  executiveSummary: string
  devilsAdvocate: string
  metadata: {
    make?: string; model?: string; software?: string
    dateTime?: string; gps?: string; width?: number; height?: number
  } | null
  elaFindings: string
  phases: {
    name: string; status: "pass" | "warn" | "fail" | "info"; summary: string
  }[]
  checkedAt: string
  // Legacy — kept for UI compat
  score: number
  // Article analysis fields (optional, present when mode === "article")
  mode?: "image" | "article"
  articleTitle?: string
  articleDomain?: string
  articleDate?: string
  articleAuthor?: string
  articleExcerpt?: string
  sourceCredibilityScore?: number
  contentCredibilityScore?: number
  keyClaims?: string[]
  writingStyle?: string
}
