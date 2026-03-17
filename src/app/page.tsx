"use client"
import { useState, useCallback, useRef } from "react"
import exifr from "exifr"
import { VerificationResult, Flag } from "@/lib/types"
import { exportToPDF } from "@/lib/exportPDF"

// ── Severity helpers ──────────────────────────────────────────────────────
const SEV_CONFIG = {
  critical: { label: "CRITICAL", dot: "bg-red-500",    text: "text-red-400",   border: "border-red-500/30",   bg: "bg-red-500/8"   },
  high:     { label: "HIGH",     dot: "bg-amber-400",  text: "text-amber-400", border: "border-amber-400/30", bg: "bg-amber-400/8" },
  moderate: { label: "MODERATE", dot: "bg-amber-300",  text: "text-amber-300", border: "border-amber-300/30", bg: "bg-amber-300/8" },
  clean:    { label: "CLEAN",    dot: "bg-teal-400",   text: "text-teal-400",  border: "border-teal-400/30",  bg: "bg-teal-400/8"  },
  info:     { label: "INFO",     dot: "bg-blue-400",   text: "text-blue-400",  border: "border-blue-400/30",  bg: "bg-blue-400/8"  },
}

const VERDICT_COLOR: Record<string, string> = {
  teal:  "text-teal-400",
  amber: "text-amber-400",
  red:   "text-red-400",
}

const PHASE_STATUS_COLOR: Record<string, string> = {
  pass: "text-teal-400 border-teal-400/40",
  warn: "text-amber-400 border-amber-400/40",
  fail: "text-red-400 border-red-400/40",
  info: "text-blue-400 border-blue-400/40",
}

const WRITING_STYLE_CONFIG: Record<string, { color: string; bg: string }> = {
  neutral:       { color: "text-teal-400",   bg: "bg-teal-400/10 border-teal-400/30" },
  sensationalist:{ color: "text-amber-400",  bg: "bg-amber-400/10 border-amber-400/30" },
  opinion:       { color: "text-blue-400",   bg: "bg-blue-400/10 border-blue-400/30" },
  propaganda:    { color: "text-red-400",    bg: "bg-red-400/10 border-red-400/30" },
  satire:        { color: "text-amber-300",  bg: "bg-amber-300/10 border-amber-300/30" },
}

// ── Score Ring SVG ────────────────────────────────────────────────────────
function ScoreRing({ score, color }: { score: number; color: string }) {
  const r = 54
  const circ = 2 * Math.PI * r
  const offset = circ - (score / 100) * circ
  const strokeColor = color === "teal" ? "#00C8A0" : color === "amber" ? "#F5A623" : "#E84057"

  return (
    <div className="relative flex items-center justify-center" style={{ width: 140, height: 140 }}>
      <svg width="140" height="140" style={{ transform: "rotate(-90deg)" }}>
        <circle cx="70" cy="70" r={r} fill="none" stroke="#1E3048" strokeWidth="8" />
        <circle
          cx="70" cy="70" r={r} fill="none"
          stroke={strokeColor} strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 1.4s cubic-bezier(0.4,0,0.2,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`font-mono font-bold text-3xl ${VERDICT_COLOR[color]}`}>{score}</span>
        <span className="font-mono text-xs text-muted mt-0.5">/ 100</span>
      </div>
    </div>
  )
}

// ── Derive a short 1–3 word label from a URL ──────────────────────────────
const DOMAIN_NAMES: Record<string, string> = {
  "bbc.com": "BBC", "bbc.co.uk": "BBC",
  "reuters.com": "Reuters", "apnews.com": "AP News",
  "theguardian.com": "Guardian", "nytimes.com": "NY Times",
  "washingtonpost.com": "Washington Post", "aljazeera.com": "Al Jazeera",
  "france24.com": "France 24", "dw.com": "DW",
  "haaretz.com": "Haaretz", "timesofisrael.com": "Times of Israel",
  "kyivindependent.com": "Kyiv Independent", "foreignpolicy.com": "Foreign Policy",
  "bellingcat.com": "Bellingcat", "en.wikipedia.org": "Wikipedia",
  "snopes.com": "Snopes", "fullfact.org": "Full Fact",
  "politifact.com": "PolitiFact", "factcheck.org": "FactCheck",
  "afp.com": "AFP", "lemonde.fr": "Le Monde",
}

function domainLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "")
    if (host === "news.google.com") return "article"
    for (const [domain, name] of Object.entries(DOMAIN_NAMES)) {
      if (host.includes(domain)) return name
    }
    return host
  } catch { return "link" }
}

function shortLabel(label: string, url: string): string {
  // Bare URL passed as label — always derive a short name from the domain
  if (!label || label.startsWith("http")) return domainLabel(url)
  const words = label.trim().split(/\s+/)
  if (words.length <= 3) return label
  return domainLabel(url)
}

// ── Render text with clickable URLs and [label](url) markdown links ───────
function LinkedText({ text }: { text: string }) {
  const TOKEN_RE = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)|https?:\/\/[^\s|>\]]+/g
  const parts: React.ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = TOKEN_RE.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const label = match[1] || ""
    const url = (match[2] || match[0]).replace(/[.,;)]+$/, "")
    const display = shortLabel(label || url, url)
    parts.push(
      <a key={match.index} href={url} target="_blank" rel="noopener noreferrer"
        className="text-accent underline underline-offset-2 hover:text-blue-300 whitespace-nowrap">
        {display}
      </a>
    )
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

// ── Flag Card ─────────────────────────────────────────────────────────────
function FlagCard({ flag, index }: { flag: Flag; index: number }) {
  const cfg = SEV_CONFIG[flag.severity]
  return (
    <div
      className={`flag-row flex gap-3 p-3 rounded border ${cfg.border} ${cfg.bg}`}
      style={{ animationDelay: `${index * 0.1}s` }}
    >
      <div className="flex-shrink-0 mt-1.5">
        <div className={`w-2 h-2 rounded-full ${cfg.dot}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
          <span className={`font-mono text-xs font-semibold ${cfg.text}`}>{cfg.label}</span>
          <span className="text-muted font-mono text-xs">·</span>
          <span className="text-muted font-mono text-xs">{flag.phase}</span>
        </div>
        <p className="text-bright text-sm font-medium">{flag.title}</p>
        <p className="text-text text-xs mt-0.5 leading-relaxed">
          <LinkedText text={flag.detail} />
        </p>
      </div>
    </div>
  )
}

// ── Phase Badge ───────────────────────────────────────────────────────────
function PhaseBadge({ name, status, summary }: { name: string; status: string; summary: string }) {
  const [open, setOpen] = useState(false)
  const cfg = PHASE_STATUS_COLOR[status] || PHASE_STATUS_COLOR.info
  const icon = status === "pass" ? "✓" : status === "warn" ? "!" : status === "fail" ? "✗" : "·"
  return (
    <button
      onClick={() => setOpen(o => !o)}
      className={`w-full text-left p-2.5 rounded border ${cfg} bg-card/50 hover:bg-card transition-colors`}
    >
      <div className="flex items-center gap-2">
        <span className={`font-mono text-xs font-bold w-4 flex-shrink-0 ${cfg.split(" ")[0]}`}>{icon}</span>
        <span className="text-bright text-xs font-medium flex-1">{name}</span>
        <span className="text-muted text-xs font-mono">{open ? "▲" : "▼"}</span>
      </div>
      {open && <p className="text-text text-xs mt-2 leading-relaxed pl-6">{summary}</p>}
    </button>
  )
}

// ── Upload Zone ───────────────────────────────────────────────────────────
function UploadZone({ onFile }: { onFile: (f: File) => void }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handle = (f: File) => {
    if (f.type.startsWith("image/")) onFile(f)
  }

  return (
    <div
      className={`relative border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all duration-300
        ${dragging ? "border-accent bg-accent/5" : "border-border hover:border-accent/50 hover:bg-card/50"}`}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handle(f) }}
      onClick={() => inputRef.current?.click()}
    >
      <div className="scanline rounded-xl" />
      <div className="relative z-10">
        <div className="text-4xl mb-3">🔍</div>
        <p className="text-bright font-semibold text-lg mb-1">Drop image to analyze</p>
        <p className="text-muted text-sm">or click to browse · JPG, PNG, WEBP, GIF</p>
      </div>
      <input ref={inputRef} type="file" accept="image/*" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handle(f) }} />
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────
export default function Home() {
  const [mode, setMode] = useState<"image" | "article">("image")

  // Image mode state
  const [image, setImage] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  // Article mode state
  const [articleUrl, setArticleUrl] = useState("")
  const [articleText, setArticleText] = useState("")

  // Shared state
  const [claim, setClaim] = useState("")
  const [eventDate, setEventDate] = useState("")
  const [loading, setLoading] = useState(false)
  const [loadingStep, setLoadingStep] = useState("")
  const [result, setResult] = useState<VerificationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pdfExporting, setPdfExporting] = useState(false)

  const handleFile = useCallback((f: File) => {
    setImage(f)
    setResult(null)
    setError(null)
    const url = URL.createObjectURL(f)
    setPreview(url)
  }, [])

  const switchMode = (m: "image" | "article") => {
    setMode(m)
    // Reset form on mode switch
    setImage(null)
    setPreview(null)
    setArticleUrl("")
    setArticleText("")
    setClaim("")
    setEventDate("")
    setResult(null)
    setError(null)
  }

  const analyzeImage = async () => {
    if (!image) return
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      setLoadingStep("Extracting metadata...")
      let exifData: Record<string, unknown> | null = null
      try {
        const raw = await exifr.parse(image, {
          tiff: true, exif: true, gps: true, icc: false, iptc: false
        })
        if (raw) {
          exifData = {
            make: raw.Make,
            model: raw.Model,
            software: raw.Software,
            dateTime: raw.DateTimeOriginal?.toString() || raw.DateTime?.toString(),
            gps: raw.latitude ? `${raw.latitude?.toFixed(4)}, ${raw.longitude?.toFixed(4)}` : null,
            width: raw.ImageWidth || raw.ExifImageWidth,
            height: raw.ImageHeight || raw.ExifImageHeight,
          }
        }
      } catch { /* EXIF not available */ }

      setLoadingStep("Running forensic analysis...")
      const fd = new FormData()
      fd.append("image", image)
      fd.append("claim", claim)
      if (eventDate.trim()) fd.append("eventDate", eventDate.trim())
      if (exifData) fd.append("exif", JSON.stringify(exifData))

      setLoadingStep("Consulting AI analysis engine...")
      const res = await fetch("/api/analyze", { method: "POST", body: fd })

      setLoadingStep("Checking web sources...")
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Analysis failed")
      }

      setLoadingStep("Assembling verdict...")
      const data: VerificationResult = await res.json()
      setResult(data)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
      setLoadingStep("")
    }
  }

  const analyzeArticle = async () => {
    if (!articleUrl.trim() && !articleText.trim()) return
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      setLoadingStep("Fetching article...")
      const res = await fetch("/api/analyze-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: articleUrl.trim() || undefined,
          text: articleText.trim() || undefined,
          claim: claim.trim() || undefined,
        }),
      })

      setLoadingStep("Running AI analysis...")
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Analysis failed")
      }

      setLoadingStep("Assembling verdict...")
      const data: VerificationResult = await res.json()
      setResult(data)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
      setLoadingStep("")
    }
  }

  const reset = () => {
    setImage(null); setPreview(null); setResult(null); setError(null); setClaim("")
    setArticleUrl(""); setArticleText("")
  }

  const handleExportPDF = useCallback(async () => {
    if (!result) return
    setPdfExporting(true)
    try {
      await exportToPDF(result, preview, claim)
    } catch (e) {
      console.error("PDF export failed:", e)
    } finally {
      setPdfExporting(false)
    }
  }, [result, preview, claim])

  const criticalCount = result?.flags.filter(f => f.severity === "critical" || f.severity === "high").length || 0
  const cleanCount    = result?.flags.filter(f => f.severity === "clean").length || 0

  const isArticleMode = result?.mode === "article"

  return (
    <div className="min-h-screen grid-bg">
      {/* Header */}
      <header className="border-b border-border/50 bg-ink/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-mono font-bold text-xl text-bright tracking-widest">VERIF<span className="text-accent">AI</span></span>
            <span className="hidden sm:block text-muted text-xs font-mono border border-border rounded px-2 py-0.5">OSINT ENGINE v1.0</span>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono text-muted">
            <div className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" />
            OPERATIONAL
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">

        {/* Hero */}
        {!result && !loading && (
          <div className="text-center mb-10">
            <h1 className="text-4xl sm:text-5xl font-bold text-bright mb-3 tracking-tight">
              Forensic Verification<br />
              <span className="text-accent">at OSINT depth.</span>
            </h1>
            <p className="text-muted text-lg max-w-xl mx-auto">
              Multi-layer analysis: image forensics, military equipment identification,
              geolocation, source tracing, and a built-in devil's advocate.
            </p>
          </div>
        )}

        {/* Input panel */}
        {!result && (
          <div className="max-w-2xl mx-auto">

            {/* Mode toggle */}
            <div className="flex gap-2 mb-5 p-1 bg-card border border-border rounded-xl">
              <button
                onClick={() => switchMode("image")}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold font-mono transition-all duration-200
                  ${mode === "image"
                    ? "bg-accent text-white"
                    : "border border-border text-muted hover:text-bright"}`}
              >
                Image
              </button>
              <button
                onClick={() => switchMode("article")}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold font-mono transition-all duration-200
                  ${mode === "article"
                    ? "bg-accent text-white"
                    : "border border-border text-muted hover:text-bright"}`}
              >
                Article / URL
              </button>
            </div>

            {/* Image mode inputs */}
            {mode === "image" && (
              <>
                <UploadZone onFile={handleFile} />

                {preview && (
                  <div className="mt-4 relative rounded-xl overflow-hidden border border-border">
                    <img src={preview} alt="Preview" className="w-full max-h-72 object-contain bg-card" />
                    <button onClick={reset}
                      className="absolute top-2 right-2 bg-ink/80 text-text rounded-full w-7 h-7 flex items-center justify-center hover:text-bright text-sm">✕</button>
                  </div>
                )}
              </>
            )}

            {/* Article mode inputs */}
            {mode === "article" && (
              <>
                <div className="mb-3">
                  <label className="block text-xs font-mono text-muted mb-1.5 uppercase tracking-wider">
                    Article URL
                  </label>
                  <input
                    type="url"
                    value={articleUrl}
                    onChange={e => setArticleUrl(e.target.value)}
                    placeholder="https://... paste article URL"
                    className="w-full bg-card border border-border rounded-lg px-3 py-2.5 text-sm text-bright
                      placeholder:text-muted focus:outline-none focus:border-accent/60"
                  />
                </div>
                <div className="mb-3">
                  <label className="block text-xs font-mono text-muted mb-1.5 uppercase tracking-wider">
                    Article Text (optional)
                  </label>
                  <textarea
                    value={articleText}
                    onChange={e => setArticleText(e.target.value)}
                    placeholder="Or paste article text directly if the URL is paywalled/inaccessible"
                    rows={6}
                    className="w-full bg-card border border-border rounded-lg px-3 py-2.5 text-sm text-bright
                      placeholder:text-muted focus:outline-none focus:border-accent/60 resize-none"
                  />
                </div>
              </>
            )}

            {/* Shared claim field */}
            <div className="mt-4">
              <label className="block text-xs font-mono text-muted mb-1.5 uppercase tracking-wider">
                Claim or context (optional but improves analysis)
              </label>
              <textarea
                value={claim}
                onChange={e => setClaim(e.target.value)}
                placeholder={mode === "article"
                  ? 'e.g. "Article claims a ceasefire was announced in Gaza, March 2026"'
                  : 'e.g. "Drone strike on Kherson bridge, March 2026"'}
                rows={2}
                className="w-full bg-card border border-border rounded-lg px-3 py-2.5 text-sm text-bright
                  placeholder:text-muted focus:outline-none focus:border-accent/60 resize-none"
              />
            </div>

            {/* Event date field — image mode only */}
            {mode === "image" && (
              <div className="mt-3">
                <label className="block text-xs font-mono text-muted mb-1.5 uppercase tracking-wider">
                  Approximate date of event (optional)
                </label>
                <input
                  type="text"
                  value={eventDate}
                  onChange={e => setEventDate(e.target.value)}
                  placeholder="e.g. March 2026 — leave blank if unknown"
                  className="w-full bg-card border border-border rounded-lg px-3 py-2.5 text-sm text-bright
                    placeholder:text-muted focus:outline-none focus:border-accent/60"
                />
              </div>
            )}

            <button
              onClick={mode === "image" ? analyzeImage : analyzeArticle}
              disabled={mode === "image" ? (!image || loading) : ((!articleUrl.trim() && !articleText.trim()) || loading)}
              className="mt-4 w-full py-3 rounded-lg font-semibold text-sm transition-all duration-200
                bg-accent text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed
                relative overflow-hidden"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {loadingStep || "Analyzing..."}
                </span>
              ) : "Run Verification →"}
            </button>

            {error && (
              <div className="mt-4 p-3 rounded-lg border border-red-500/30 bg-red-500/8 text-red-400 text-sm">
                ⚠ {error}
              </div>
            )}
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="animate-fade-up">
            {/* Score bar */}
            <div className="flex items-center gap-4 mb-6">
              <button onClick={reset} className="text-muted hover:text-bright text-sm font-mono transition-colors">
                ← New analysis
              </button>
              <div className="flex-1 border-t border-border" />
              <span className="text-muted font-mono text-xs">{new Date(result.checkedAt).toLocaleString()}</span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
              {/* Score — dual display */}
              <div className="bg-card border border-border rounded-xl p-5 flex flex-col items-center justify-center gap-3">
                <ScoreRing score={result.overallScore ?? result.score} color={result.verdictColor} />
                <div className="flex items-center gap-2 flex-wrap justify-center">
                  <div className={`font-mono font-bold text-lg ${VERDICT_COLOR[result.verdictColor]}`}>
                    {result.verdict}
                  </div>
                  {/* Writing style badge (article mode only) */}
                  {isArticleMode && result.writingStyle && (() => {
                    const style = result.writingStyle.toLowerCase()
                    const cfg = WRITING_STYLE_CONFIG[style] || WRITING_STYLE_CONFIG.opinion
                    return (
                      <span className={`font-mono text-xs font-semibold px-2 py-0.5 rounded border ${cfg.bg} ${cfg.color}`}>
                        {result.writingStyle.toUpperCase()}
                      </span>
                    )
                  })()}
                </div>
                <div className="text-muted font-mono text-xs">{result.confidence} CONFIDENCE</div>
                {/* Dual score breakdown */}
                <div className="w-full border-t border-border pt-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted font-mono">
                      {isArticleMode ? "SOURCE CREDIBILITY" : "IMAGE AUTHENTIC"}
                    </span>
                    <span className={`font-mono font-bold ${
                      (result.imageAuthenticityScore ?? result.score) >= 65 ? "text-teal-400" :
                      (result.imageAuthenticityScore ?? result.score) >= 40 ? "text-amber-400" : "text-red-400"
                    }`}>{result.imageAuthenticityScore ?? "—"}/100</span>
                  </div>
                  <div className="w-full bg-border rounded-full h-1">
                    <div className={`h-1 rounded-full transition-all duration-700 ${
                      (result.imageAuthenticityScore ?? 50) >= 65 ? "bg-teal-400" :
                      (result.imageAuthenticityScore ?? 50) >= 40 ? "bg-amber-400" : "bg-red-400"
                    }`} style={{ width: (result.imageAuthenticityScore ?? 50) + "%" }} />
                  </div>
                  <div className="flex items-center justify-between text-xs mt-1">
                    <span className="text-muted font-mono">
                      {isArticleMode ? "CONTENT CREDIBILITY" : "CLAIM ACCURATE"}
                    </span>
                    <span className={`font-mono font-bold ${
                      (result.claimAccuracyScore ?? result.score) >= 65 ? "text-teal-400" :
                      (result.claimAccuracyScore ?? result.score) >= 40 ? "text-amber-400" : "text-red-400"
                    }`}>{result.claimAccuracyScore ?? "—"}/100</span>
                  </div>
                  <div className="w-full bg-border rounded-full h-1">
                    <div className={`h-1 rounded-full transition-all duration-700 ${
                      (result.claimAccuracyScore ?? 50) >= 65 ? "bg-teal-400" :
                      (result.claimAccuracyScore ?? 50) >= 40 ? "bg-amber-400" : "bg-red-400"
                    }`} style={{ width: (result.claimAccuracyScore ?? 50) + "%" }} />
                  </div>
                </div>
              </div>

              {/* Summary */}
              <div className="lg:col-span-2 bg-card border border-border rounded-xl p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="font-mono text-xs text-accent uppercase tracking-wider">Executive Summary</span>
                  {/* Image mode: thumbnail; Article mode: nothing in this slot */}
                  {!isArticleMode && preview && (
                    <img src={preview} alt="" className="w-10 h-10 rounded object-cover border border-border ml-auto" />
                  )}
                </div>
                <p className="text-bright text-sm leading-relaxed mb-4">{result.executiveSummary}</p>

                <div className="flex items-center gap-3 text-xs font-mono pt-3 border-t border-border">
                  <span className="text-red-400">⚑ {criticalCount} critical/high</span>
                  <span className="text-muted">·</span>
                  <span className="text-teal-400">✓ {cleanCount} clean</span>
                  <span className="text-muted">·</span>
                  <span className="text-muted">{result.flags.length} total checks</span>
                </div>
              </div>
            </div>

            {/* Article Info card (article mode only) */}
            {isArticleMode && (result.articleTitle || result.articleDomain || result.articleExcerpt) && (
              <div className="bg-card border border-border rounded-xl p-5 mb-4">
                <p className="font-mono text-xs text-accent uppercase tracking-wider mb-3">Article Info</p>
                <div className="space-y-2">
                  {result.articleTitle && (
                    <p className="text-bright font-semibold text-sm leading-snug">{result.articleTitle}</p>
                  )}
                  <div className="flex flex-wrap gap-4 text-xs font-mono text-muted">
                    {result.articleDomain && (
                      <span>Domain: <span className="text-bright">{result.articleDomain}</span></span>
                    )}
                    {result.articleAuthor && (
                      <span>Author: <span className="text-bright">{result.articleAuthor}</span></span>
                    )}
                    {result.articleDate && (
                      <span>Date: <span className="text-bright">{result.articleDate}</span></span>
                    )}
                  </div>
                  {result.articleExcerpt && (
                    <p className="text-text text-xs leading-relaxed border-t border-border pt-2 mt-2">
                      {result.articleExcerpt.slice(0, 200)}{result.articleExcerpt.length > 200 ? "…" : ""}
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Flags */}
              <div className="lg:col-span-2 space-y-2">
                <h2 className="font-mono text-xs text-muted uppercase tracking-wider mb-3">Findings</h2>

                {/* Key Claims (article mode only) */}
                {isArticleMode && result.keyClaims && result.keyClaims.length > 0 && (
                  <div className="mb-3 p-4 rounded-xl border border-blue-400/25 bg-blue-400/5">
                    <p className="font-mono text-xs text-blue-400 font-semibold uppercase tracking-wider mb-2">Key Claims</p>
                    <ul className="space-y-1">
                      {result.keyClaims.map((kc, i) => (
                        <li key={i} className="text-text text-sm leading-relaxed flex gap-2">
                          <span className="text-blue-400 flex-shrink-0">•</span>
                          <span>{kc}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {result.flags.map((flag, i) => (
                  <FlagCard key={i} flag={flag} index={i} />
                ))}

                {/* Devil's Advocate */}
                <div className="mt-4 p-4 rounded-xl border border-amber-400/25 bg-amber-400/5">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg">😈</span>
                    <span className="font-mono text-xs text-amber-400 font-semibold uppercase tracking-wider">Devil&apos;s Advocate</span>
                  </div>
                  <p className="text-text text-sm leading-relaxed">{result.devilsAdvocate}</p>
                </div>
              </div>

              {/* Phases + metadata */}
              <div className="space-y-2">
                <h2 className="font-mono text-xs text-muted uppercase tracking-wider mb-3">Pipeline Phases</h2>
                {result.phases.map((ph, i) => (
                  <PhaseBadge key={i} name={ph.name} status={ph.status} summary={ph.summary} />
                ))}

                {/* EXIF metadata (image mode only) */}
                {!isArticleMode && result.metadata && Object.values(result.metadata).some(Boolean) && (
                  <div className="mt-4 p-3 rounded-xl border border-border bg-card">
                    <p className="font-mono text-xs text-muted uppercase tracking-wider mb-2">EXIF Metadata</p>
                    {Object.entries(result.metadata).map(([k, v]) =>
                      v ? (
                        <div key={k} className="flex gap-2 text-xs mb-1">
                          <span className="text-muted font-mono w-20 flex-shrink-0 capitalize">{k}</span>
                          <span className="text-bright font-mono truncate">{String(v)}</span>
                        </div>
                      ) : null
                    )}
                  </div>
                )}

                <button
                  onClick={handleExportPDF}
                  disabled={pdfExporting}
                  className="w-full mt-2 py-2.5 rounded-lg border border-teal-400/40 text-teal-400 text-sm font-medium
                    hover:bg-teal-400/10 transition-colors flex items-center justify-center gap-2
                    disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {pdfExporting ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-teal-400/30 border-t-teal-400 rounded-full animate-spin" />
                      Generating PDF...
                    </>
                  ) : (
                    <>
                      ↓ Export Report as PDF
                    </>
                  )}
                </button>

                <button
                  onClick={reset}
                  className="w-full mt-2 py-2.5 rounded-lg border border-accent/40 text-accent text-sm font-medium
                    hover:bg-accent/10 transition-colors"
                >
                  {isArticleMode ? "Analyze another article" : "Analyze another image"}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-border/30 mt-16 py-6 text-center text-muted font-mono text-xs">
        VERIFAI · OSINT VERIFICATION ENGINE · FOR RESEARCH AND JOURNALISTIC USE
      </footer>
    </div>
  )
}
