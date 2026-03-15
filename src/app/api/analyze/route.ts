import { NextRequest, NextResponse } from "next/server"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { VerificationResult, Flag, Severity } from "@/lib/types"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")

const TODAY = new Date().toLocaleDateString("en-GB", {
  weekday: "long", year: "numeric", month: "long", day: "numeric"
})

const NL = "\n"

function stripJsonFences(text: string): string {
  return text.replace(/^```json\s*/m, "").replace(/^```\s*/m, "").replace(/```$/m, "").trim()
}

// Safe fetch with timeout — prevents slow external calls blocking the pipeline
async function fetchWithTimeout(url: string, options: RequestInit = {}, ms = 6000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// GDELT fetch with retry — handles 429 rate limiting from shared Render IPs
async function gdeltFetch(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 800 * i))
    try {
      const res = await fetchWithTimeout(url, {}, 8000)
      if (res.status !== 429) return res
    } catch { /* timeout — fall through to retry */ }
  }
  return new Response(null, { status: 429 })
}

// ── Conflict detection ─────────────────────────────────────────────────────
const CONFLICT_KEYWORDS = [
  "war", "conflict", "attack", "strike", "bomb", "missile", "drone", "shoot",
  "explosion", "military", "troops", "army", "soldier", "weapon", "gun", "tank",
  "airstrike", "artillery", "siege", "invasion", "occupied", "ceasefire", "offensive",
  "battle", "front", "casualt", "killed", "wounded", "rebel", "militia", "faction",
  "hamas", "hezbollah", "idf", "ukraine", "russia", "gaza", "lebanon", "syria",
  "yemen", "sudan", "iran", "isis", "terror", "insurgent", "guerrilla", "dubai",
  "houthi", "wagner", "frontline", "shelling", "mortar", "sniper", "hostage"
]

function isConflictContent(text: string): boolean {
  const lower = text.toLowerCase()
  return CONFLICT_KEYWORDS.some(kw => lower.includes(kw))
}

// ── News briefing interface ────────────────────────────────────────────────
interface NewsBriefing {
  summary: string
  sources: string[]
  skipped: boolean
  track: "gdelt" | "none"
}

const EMPTY_BRIEFING: NewsBriefing = { summary: "", sources: [], skipped: true, track: "none" }

// ── GDELT briefing (conflict only, free, no key) ───────────────────────────
async function runNewsBriefing(claim: string): Promise<NewsBriefing> {
  if (!claim.trim() || !isConflictContent(claim)) return EMPTY_BRIEFING
  try {
    const q = encodeURIComponent(claim.slice(0, 200))
    const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + q +
      "&mode=artlist&maxrecords=8&timespan=1month&sort=DateDesc&format=json"
    const res = await gdeltFetch(url)
    if (!res.ok) return EMPTY_BRIEFING
    const data = await res.json()
    const articles = data.articles || []
    if (articles.length === 0) return EMPTY_BRIEFING

    const lines: string[] = []
    const sources: string[] = []
    for (const a of articles.slice(0, 6)) {
      const raw = a.seendate || ""
      const date = raw.length >= 8 ? raw.slice(0,4)+"-"+raw.slice(4,6)+"-"+raw.slice(6,8) : ""
      lines.push("[" + (date || "recent") + "] " + (a.title || "") + " — " + (a.domain || ""))
      if (a.url) sources.push(a.url)
    }

    const parts = [
      "=== CRITICAL: VERIFIED LIVE INTELLIGENCE — OVERRIDE YOUR TRAINING DATA ===",
      "The following headlines are REAL, VERIFIED, RECENT news from major outlets retrieved " + TODAY + ".",
      "These events ARE HAPPENING NOW. Your training cutoff is outdated for these events.",
      "You MUST treat this as ground truth and prioritise it over anything in your training data.",
      "",
      lines.join(NL),
      "=== END LIVE INTELLIGENCE — THE ABOVE IS FACTUAL AND CURRENT ==="
    ]
    return { summary: parts.join(NL), sources, skipped: false, track: "gdelt" }
  } catch {
    return EMPTY_BRIEFING
  }
}

// ── PHASE 0: Fact-check pre-check (GDELT — free, no key) ──────────────────
// Searches GDELT for coverage by known fact-check outlets
async function runFactCheckPreCheck(claim: string): Promise<string> {
  if (!claim) return "skipped"
  try {
    // Query GDELT restricting to known fact-check domains
    const factCheckDomains = "snopes.com OR fullfact.org OR politifact.com OR factcheck.org OR afp.com OR reuters.com/fact-check"
    const q = encodeURIComponent(claim.slice(0, 120) + " (" + factCheckDomains + ")")
    const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + q +
      "&mode=artlist&maxrecords=5&timespan=6months&sort=DateDesc&format=json"
    const res = await gdeltFetch(url)
    if (!res.ok) return "Fact-check pre-check unavailable"
    const data = await res.json()
    const articles = data.articles || []
    if (!articles.length) return "No existing fact-checks found"
    return articles.slice(0, 3).map((a: { title: string; url: string; domain: string; seendate?: string }) => {
      const raw = a.seendate || ""
      const date = raw.length >= 8 ? raw.slice(0,4)+"-"+raw.slice(4,6)+"-"+raw.slice(6,8) : ""
      return a.title + " — " + a.domain + (date ? " (" + date + ")" : "") + " | " + a.url
    }).join(NL)
  } catch { return "Fact-check pre-check timed out" }
}

// ── PHASE 1: Gemini vision analysis (with dual scoring) ────────────────────
async function runGeminiAnalysis(
  imageBase64: string, mimeType: string, claim: string, briefing: NewsBriefing
) {
  const model = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    generationConfig: { temperature: 0 },
  })
  const claimText = claim
    ? ('The submitter claims: "' + claim + '"')
    : "No claim provided — describe and analyze the image objectively."

  const promptParts = [
    "You are a professional OSINT forensic analyst. Your ONLY evidence is what you directly observe in this image.",
    "Today's date: " + TODAY + ". Any date on or before today is NOT suspicious. Only flag a date as anachronistic if it is in the future relative to today.",
    "",
    briefing.skipped ? "" : briefing.summary,
    "",
    "=== ABSOLUTE RULES ===",
    "1. Do NOT identify this image as any specific known photo, event, or location from your training data.",
    "2. Do NOT let 'I have seen this image before' affect any score or flag.",
    "3. claim_accuracy_score defaults to 50 (uncertain). Only adjust it when you have DIRECT visual evidence IN THIS FRAME.",
    "4. Location and attribution are UNVERIFIABLE from image alone unless specific text, signs, or unmistakable landmarks are VISIBLE IN THE FRAME.",
    "5. UNVERIFIABLE is not the same as FALSE. Never output LIKELY FALSE unless visual evidence actively contradicts the claim.",
    "",
    "=== TASK 1: IMAGE AUTHENTICITY ===",
    "Is the photo real and unmanipulated? Score 0–100. Do NOT default this to 50 — it must reflect your forensic assessment.",
    "Scoring bands:",
    "  0–25:  Clearly AI-generated (GAN face artifacts, synthetic skin textures, impossible geometry, Midjourney/DALL-E style, missing fingers, inconsistent reflections)",
    "  26–45: Strong composite or manipulation indicators (lighting mismatch between subject and background, halo/masking artefacts, cloned regions, metadata-content conflict, known landmark visible but at wrong scale or with missing structural elements)",
    "  46–60: Inconclusive — suspicious elements present but not definitive",
    "  61–80: Likely genuine with minor processing (portrait mode, filters) — no clear manipulation",
    "  81–100: Clearly genuine unmanipulated photograph",
    "If you find ANY of the 0–45 indicators, your score MUST be in that range. Do not soften the score.",
    "",
    "=== TASK 2: SCENE DESCRIPTION (visual facts only) ===",
    "List ONLY what is objectively visible:",
    "- Event type (fire, explosion, combat, protest...)",
    "- Structures (describe shape/function, do NOT name specific locations)",
    "- Any text, signs, flags, number plates, insignia VISIBLE IN FRAME",
    "- Environment: vegetation type, architecture style, season, weather, time of day",
    "- People, vehicles, equipment",
    "",
    "=== TASK 3: CLAIM ACCURACY SCORE ===",
    claimText,
    "Start claim_accuracy_score at 50.",
    "+10 per VISUALLY CONFIRMED element (max +40).",
    "-15 per VISUALLY CONTRADICTED element.",
    "Location = UNVERIFIABLE unless specific place-identifying text or unmistakable landmark is visible. Do not adjust score for location.",
    "Attribution (who did it) = ALWAYS UNVERIFIABLE from image alone.",
    "If the image shows what the claim describes generically (explosion, fire, attack) with no visual contradiction: score stays near 50 (uncertain, not false).",
    "",
    "=== TASK 4: FLAGS ===",
    "Only flag things with DIRECT visual evidence. Do not flag unverifiable elements as suspicious.",
    "",
    "Respond ONLY with valid JSON. No markdown. No text outside the JSON:",
    "{",
    '  "image_authenticity_score": <0-100>,',
    '  "claim_accuracy_score": <0-100, default 50, only adjust with direct visual evidence>,',
    '  "confidence": "<HIGH|MEDIUM|LOW>",',
    '  "verdict": "<VERIFIED|LIKELY AUTHENTIC|UNVERIFIABLE|LIKELY FALSE|NEEDS EXPERT REVIEW>",',
    '  "flags": [{"phase": "<Image Forensics|Physical Verification|Military Analysis|Linguistic|Temporal>", "severity": "<critical|high|moderate|clean|info>", "title": "<string>", "detail": "<string — cite specific visual evidence>"}],',
    '  "scene_description": "<factual list of what is visually present>",',
    '  "visual_artifacts": "<specific AI/manipulation tells found, or: No signs of manipulation detected>",',
    '  "military_analysis": "<weapons/vehicles/ordnance/uniforms visible: type, model, calibre, markings, insignia; or: No military equipment visible>",',
    '  "has_military_equipment": <true|false>,',
    '  "geolocation_clues": "<ONLY text/signs/landmarks/flags VISIBLE IN FRAME, or: No identifying visual clues in frame>",',
    '  "physical_consistency": "<shadow direction, lighting coherence, perspective — any inconsistencies?>",',
    '  "temporal_analysis": "<any date/time indicators visible — only flag dates that are in the future relative to today>",',
    '  "emotional_framing": "<manipulation via framing, cropping, saturation — assess objectively>",',
    '  "linguistic_analysis": "<if text visible in image: assess it; else: No text visible>",',
    '  "executive_summary": "<3-4 sentences: what the image shows, authenticity assessment, what can and cannot be confirmed about the claim>",',
    '  "devils_advocate": "<2-3 sentences arguing the opposite of your main assessment>"',
    "}"
  ]

  const result = await model.generateContent([
    { inlineData: { data: imageBase64, mimeType } },
    promptParts.filter(p => p !== "").join(NL)
  ])
  return JSON.parse(stripJsonFences(result.response.text()))
}

// ── PHASE 1b: Deep military analysis (conditional) ─────────────────────────
interface MilitaryItem {
  designation: string
  type: string
  calibreOrSpec: string
  knownOperators: string[]
  activeConflicts: string[]
  attributionAssessment: string
  scaleEstimation: string
  markingsFound: string
  craterOrBlastAnalysis: string
  supplyChainNotes: string
  confidenceLevel: string
}

interface MilitaryAnalysisResult {
  skipped: boolean
  equipment: MilitaryItem[]
  overallAttribution: string
  redFlags: string[]
  deepSummary: string
}

async function runDeepMilitaryAnalysis(
  imageBase64: string, mimeType: string,
  initialMilitaryText: string, claim: string
): Promise<MilitaryAnalysisResult> {
  const empty: MilitaryAnalysisResult = {
    skipped: true, equipment: [], overallAttribution: "", redFlags: [], deepSummary: ""
  }
  if (!initialMilitaryText || initialMilitaryText.includes("No military equipment visible")) return empty

  const model = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    generationConfig: { temperature: 0 },
  })
  const claimLine = claim ? ('Claimed context: "' + claim + '"') : ""

  const promptParts = [
    "You are a specialist military equipment analyst with Bellingcat-level expertise.",
    "Today's date: " + TODAY + ". Any date on or before today is NOT suspicious. Only flag a date as anachronistic if it is in the future relative to today.",
    "",
    "STRICT RULES:",
    "1. Do NOT claim an image is 'recycled', 'reused', or 'from a previous conflict' unless you can cite a specific visible detail that proves it (e.g. a visible watermark, a date stamp in frame, a known-unique landmark). If you have no verifiable visual proof, omit the claim entirely.",
    "2. Do NOT flag dates in 2025 or 2026 as anachronistic or suspicious. They are current.",
    "3. Only assess attribution plausibility from equipment VISIBLE IN THE FRAME. Do not infer from geopolitical context or training-data associations.",
    "",
    'Initial scan identified: "' + initialMilitaryText + '"',
    claimLine,
    "",
    "Deep analysis — for every weapon, vehicle, ordnance, or uniform visible:",
    "- Specific model/designation",
    "- Known operators by country/faction",
    "- Active conflict associations",
    "- Attribution plausibility vs claim (visual evidence only)",
    "- Scale/calibre from reference objects",
    "- Crater/blast pattern analysis if applicable",
    "- Markings, insignia, serial fragments",
    "- Supply chain / grey-market availability",
    "",
    "Respond ONLY with valid JSON. No markdown:",
    "{",
    '  "skipped": false,',
    '  "equipment": [{',
    '    "designation": "<model e.g. T-72B3, 9M133 Kornet, AK-74M>",',
    '    "type": "<MBT|IFV|APC|Artillery|ATGM|MANPADS|Small Arms|Drone|Aircraft|Naval|Ordnance|Uniform|Other>",',
    '    "calibreOrSpec": "<e.g. 125mm, 5.45x39mm>",',
    '    "knownOperators": ["<country or faction>"],',
    '    "activeConflicts": ["<conflict>"],',
    '    "attributionAssessment": "<Plausible/Implausible/Uncertain + why>",',
    '    "scaleEstimation": "<from reference objects, or: Not applicable>",',
    '    "markingsFound": "<markings/insignia, or: None visible>",',
    '    "craterOrBlastAnalysis": "<munition inference, or: Not applicable>",',
    '    "supplyChainNotes": "<export/grey-market notes>",',
    '    "confidenceLevel": "<HIGH|MEDIUM|LOW>"',
    '  }],',
    '  "overallAttribution": "<equipment supports or contradicts claimed attribution?>",',
    '  "redFlags": ["<attribution red flag — ONLY include if backed by specific visual evidence in this image; omit date-based or recycled-imagery flags without visual proof>"],',
    '  "deepSummary": "<2-3 sentence expert military summary>"',
    "}"
  ]

  try {
    const result = await model.generateContent([
      { inlineData: { data: imageBase64, mimeType } },
      promptParts.join(NL)
    ])
    return JSON.parse(stripJsonFences(result.response.text()))
  } catch {
    return { ...empty, deepSummary: "Deep military analysis parse failed" }
  }
}

// ── Equipment database lookup (direct Oryx fetch — free, no key) ──────────
// Fetches Oryx's public loss tracking pages directly for equipment verification
async function runEquipmentLookup(designations: string[]): Promise<Record<string, string>> {
  if (designations.length === 0) return {}
  const results: Record<string, string> = {}

  await Promise.all(designations.slice(0, 2).map(async (designation) => {
    try {
      // Use GDELT to search Oryx and armyrecognition directly
      const q = encodeURIComponent(designation + " (oryxspioenkop.com OR armyrecognition.com OR globalsecurity.org)")
      const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + q +
        "&mode=artlist&maxrecords=3&timespan=24months&sort=Relevance&format=json"
      const res = await gdeltFetch(url)
      if (!res.ok) {
        results[designation] = "Lookup unavailable"
        return
      }
      const data = await res.json()
      const articles = data.articles || []
      if (articles.length > 0) {
        results[designation] = articles.slice(0, 2).map((a: { title: string; domain: string; url: string }) =>
          a.title + " (" + a.domain + ") | " + a.url
        ).join(" || ")
      } else {
        results[designation] = "No records found in open-source databases"
      }
    } catch {
      results[designation] = "Lookup timed out"
    }
  }))
  return results
}

// ── PHASE 2: Reverse image search ─────────────────────────────────────────
async function runReverseImageSearch(imageBase64: string): Promise<string> {
  const apiKey = process.env.GOOGLE_VISION_API_KEY
  if (!apiKey) return "Reverse image search skipped — API key not configured"
  try {
    const res = await fetchWithTimeout(
      "https://vision.googleapis.com/v1/images:annotate?key=" + apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests: [{ image: { content: imageBase64 }, features: [{ type: "WEB_DETECTION", maxResults: 10 }] }] })
      },
      8000
    )
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}))
      return "Vision API error: " + (errData?.error?.message || "HTTP " + res.status)
    }
    const data = await res.json()
    // Check for API-level error in response body
    const apiError = data.responses?.[0]?.error
    if (apiError) return "Vision API error: " + apiError.message
    const web = data.responses?.[0]?.webDetection
    // Empty or missing webDetection = no indexed matches
    if (!web || Object.keys(web).length === 0)
      return "No prior web appearances — not indexed on the open web"
    const hasMatches = web.fullMatchingImages?.length || web.partialMatchingImages?.length || web.pagesWithMatchingImages?.length
    if (!hasMatches) return "No prior web appearances — not indexed on the open web"

    const matches: string[] = []
    if (web.fullMatchingImages?.length)
      matches.push(web.fullMatchingImages.length + " exact match(es) found online")
    if (web.partialMatchingImages?.length)
      matches.push(web.partialMatchingImages.length + " partial/similar match(es)")
    if (web.bestGuessLabels?.length) {
      // Filter out generic image-type labels (poster, screenshot, photo, etc.) — only show meaningful subject labels
      const NOISE = ["poster", "screenshot", "photo", "image", "picture", "illustration", "drawing", "painting", "artwork", "graphic", "banner", "thumbnail"]
      const meaningful = web.bestGuessLabels.filter((l: { label: string }) => !NOISE.some(n => l.label.toLowerCase().includes(n)))
      if (meaningful.length) matches.push("Best guess: " + meaningful.map((l: { label: string }) => l.label).join(", "))
    }
    if (web.pagesWithMatchingImages?.length) {
      matches.push("Found in: " + web.pagesWithMatchingImages.slice(0, 5)
        .map((p: { url: string; pageTitle?: string }) => "[" + (p.pageTitle || "article") + "](" + p.url + ")").join(" · "))
    } else if (web.fullMatchingImages?.length) {
      matches.push("Image URLs: " + web.fullMatchingImages.slice(0, 3)
        .map((i: { url: string }, idx: number) => "[source " + (idx + 1) + "](" + i.url + ")").join(" "))
    }
    return matches.join(". ")
  } catch { return "Reverse image search timed out or failed" }
}

// ── PHASE 3: Web corroboration (GDELT — free, no key) ─────────────────────
// Uses GDELT news search to find trusted outlet coverage of the claim
async function runWebSearch(claim: string): Promise<{
  summary: string; trusted: number; factChecks: number; fringeOnly: boolean
}> {
  const empty = { summary: "Web search skipped — no claim provided", trusted: 0, factChecks: 0, fringeOnly: false }
  if (!claim) return empty
  try {
    const q = encodeURIComponent(claim.slice(0, 200))
    const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + q +
      "&mode=artlist&maxrecords=10&timespan=12months&sort=DateDesc&format=json"
    const res = await gdeltFetch(url)
    if (!res.ok) return { summary: "Web corroboration unavailable", trusted: 0, factChecks: 0, fringeOnly: false }
    const data = await res.json()
    const articles = data.articles || []
    if (!articles.length) return { summary: "No corroborating sources found", trusted: 0, factChecks: 0, fringeOnly: false }

    const trustedDomains = ["bbc.co", "bbc.com", "reuters.com", "apnews.com", "nytimes.com",
      "theguardian.com", "washingtonpost.com", "aljazeera.com", "dw.com", "france24.com",
      "bellingcat.com", "rferl.org", "haaretz.com", "timesofisrael.com", "ynetnews.com",
      "axios.com", "afp.com", "lemonde.fr", "spiegel.de", "thetimes.co.uk"]
    const factCheckDomains = ["snopes.com", "politifact.com", "factcheck.org", "fullfact.org", "afp.com"]

    let trusted = 0, factChecks = 0
    const lines: string[] = []

    for (const a of articles.slice(0, 8)) {
      const domain = (a.domain || "").toLowerCase()
      const isTrusted = trustedDomains.some(d => domain.includes(d))
      const isFactCheck = factCheckDomains.some(d => domain.includes(d))
      if (isTrusted) trusted++
      if (isFactCheck) factChecks++
      const raw = a.seendate || ""
      const date = raw.length >= 8 ? raw.slice(0,4)+"-"+raw.slice(4,6)+"-"+raw.slice(6,8) : ""
      const prefix = isFactCheck ? "[FACT-CHECK] " : isTrusted ? "[TRUSTED] " : "[SOURCE] "
      lines.push(prefix + a.title + (date ? " (" + date + ")" : "") + " — " + a.domain + " | " + a.url)
    }

    return {
      summary: lines.join(NL),
      trusted,
      factChecks,
      fringeOnly: trusted === 0 && factChecks === 0 && articles.length > 0
    }
  } catch { return { summary: "Web corroboration timed out", trusted: 0, factChecks: 0, fringeOnly: false } }
}

// ── PHASE 4: Weather verification ─────────────────────────────────────────
async function runWeatherCheck(lat: number, lon: number, dateStr: string): Promise<string> {
  try {
    const date = new Date(dateStr)
    if (isNaN(date.getTime())) return "skipped — could not parse date"
    const d = date.toISOString().split("T")[0]
    const url = "https://archive-api.open-meteo.com/v1/archive?latitude=" + lat +
      "&longitude=" + lon + "&start_date=" + d + "&end_date=" + d +
      "&daily=weathercode,temperature_2m_max,precipitation_sum&timezone=auto"
    const res = await fetchWithTimeout(url, {}, 5000)
    const data = await res.json()
    if (data.daily?.weathercode?.[0] === undefined) return "unavailable for this location/date"
    const wcode = data.daily.weathercode[0]
    const temp = data.daily.temperature_2m_max?.[0]
    const rain = data.daily.precipitation_sum?.[0]
    const cond = wcode === 0 ? "clear/sunny" : wcode <= 3 ? "partly cloudy" :
      wcode <= 48 ? "foggy" : wcode <= 67 ? "rainy" : wcode <= 77 ? "snowy" : "stormy"
    return "On " + d + " at (" + lat.toFixed(2) + ", " + lon.toFixed(2) + "): " +
      cond + ", max " + temp + "C, rain " + rain + "mm"
  } catch { return "timed out" }
}

// ── PHASE 4b: Historical incident check ───────────────────────────────────
// Reverse-geocodes the GPS coordinates, then searches GDELT for military
// incidents at that location in a ±10-day window around the EXIF date.
async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const url = "https://nominatim.openstreetmap.org/reverse?lat=" + lat + "&lon=" + lon + "&format=json"
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "VerifAI/1.0 (osint-verification)" } }, 5000)
    if (!res.ok) return ""
    const data = await res.json()
    const a = data.address || {}
    return [a.city || a.town || a.village || a.county, a.state, a.country].filter(Boolean).join(", ")
  } catch { return "" }
}

async function runHistoricalIncidentCheck(lat: number, lon: number, dateStr: string): Promise<string> {
  try {
    const location = await reverseGeocode(lat, lon)
    if (!location) return "skipped — could not resolve GPS to location"

    const date = new Date(dateStr)
    if (isNaN(date.getTime())) return "skipped — could not parse EXIF date"

    const start = new Date(date); start.setDate(start.getDate() - 10)
    const end   = new Date(date); end.setDate(end.getDate() + 10)
    const fmt = (d: Date) => d.toISOString().replace(/\D/g, "").slice(0, 14)

    const terms = encodeURIComponent(
      "(missile OR strike OR attack OR shelling OR bombing OR airstrike OR explosion OR rocket OR artillery) " + location
    )
    const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + terms +
      "&mode=artlist&maxrecords=5&STARTDATETIME=" + fmt(start) + "&ENDDATETIME=" + fmt(end) +
      "&sort=DateDesc&format=json"

    const res = await gdeltFetch(url)
    if (!res.ok) return "Historical incident lookup unavailable"
    const data = await res.json()
    const articles = data.articles || []

    if (!articles.length) {
      return "No open-source military incident records found for " + location + " around " + date.toISOString().slice(0, 10)
    }

    const lines = articles.slice(0, 4).map((a: { seendate?: string; title?: string; domain?: string; url?: string }) => {
      const raw = a.seendate || ""
      const d = raw.length >= 8 ? raw.slice(0,4)+"-"+raw.slice(4,6)+"-"+raw.slice(6,8) : "?"
      return "[" + d + "] [" + (a.title || "article") + "](" + (a.url || "") + ") — " + (a.domain || "")
    })
    return "Incidents recorded near " + location + " (±10 days of " + date.toISOString().slice(0, 10) + "):\n" + lines.join("\n")
  } catch { return "Historical incident check failed" }
}

// ── Derive verdict from all signals (not just Gemini) ─────────────────────
function deriveVerdict(
  imageScore: number, claimScore: number, hasClaim: boolean,
  trusted: number, factChecks: number, fringeOnly: boolean
): VerificationResult["verdict"] {
  // Fact-checks are the strongest signal
  if (factChecks > 0) return "LIKELY FALSE"
  // Clearly fake image
  if (imageScore <= 30) return "LIKELY FALSE"
  if (!hasClaim) {
    if (imageScore >= 72) return "LIKELY AUTHENTIC"
    if (imageScore <= 40) return "NEEDS EXPERT REVIEW"
    return "UNVERIFIABLE"
  }
  // Has claim
  if (claimScore <= 30) return "LIKELY FALSE"           // visual contradiction
  if (imageScore >= 70 && claimScore >= 72 && trusted >= 2) return "VERIFIED"
  if (imageScore >= 65 && claimScore >= 62) return "LIKELY AUTHENTIC"
  if (fringeOnly && claimScore < 55) return "LIKELY FALSE"
  if (claimScore >= 42 && claimScore <= 62) return "UNVERIFIABLE"
  return "NEEDS EXPERT REVIEW"
}

// ── Assemble final result ──────────────────────────────────────────────────
function assembleResult(
  gemini: Record<string, unknown>,
  reverseSearch: string,
  webSearch: { summary: string; trusted: number; factChecks: number; fringeOnly: boolean },
  exifData: Record<string, unknown> | null,
  factCheckPreCheck: string,
  weatherResult: string,
  incidentResult: string,
  militaryDeep: MilitaryAnalysisResult,
  equipmentLookup: Record<string, string>,
  briefing: NewsBriefing,
  claim: string
): VerificationResult {
  const flags: Flag[] = [...(gemini.flags as Flag[])]

  // Fact-check pre-check
  if (factCheckPreCheck && factCheckPreCheck !== "skipped" &&
      factCheckPreCheck !== "No existing fact-checks found" &&
      !factCheckPreCheck.includes("failed") && !factCheckPreCheck.includes("timed")) {
    flags.unshift({
      phase: "Triage", severity: "high" as Severity,
      title: "Existing fact-check found",
      detail: "Previously fact-checked: " + factCheckPreCheck.slice(0, 250)
    })
  }

  // News briefing flag
  if (!briefing.skipped) {
    flags.push({
      phase: "Current Intelligence", severity: "info" as Severity,
      title: "Live conflict news injected (GDELT)",
      detail: "Real-time news context: " + briefing.sources.slice(0, 2).join(", ")
    })
  }

  // Deep military flags
  if (!militaryDeep.skipped && militaryDeep.equipment?.length > 0) {
    for (const eq of militaryDeep.equipment) {
      const isImplausible = eq.attributionAssessment?.toLowerCase().includes("implausible")
      flags.push({
        phase: "Military Analysis",
        severity: (isImplausible ? "high" : "info") as Severity,
        title: eq.designation + " — " + eq.type,
        detail: [
          eq.calibreOrSpec ? "Spec: " + eq.calibreOrSpec + "." : "",
          eq.knownOperators?.length ? "Operators: " + eq.knownOperators.join(", ") + "." : "",
          eq.attributionAssessment ? "Attribution: " + eq.attributionAssessment + "." : "",
          eq.markingsFound && eq.markingsFound !== "None visible" ? "Markings: " + eq.markingsFound + "." : "",
          eq.scaleEstimation && !eq.scaleEstimation.includes("Not applicable") ? "Scale: " + eq.scaleEstimation + "." : "",
          eq.craterOrBlastAnalysis && !eq.craterOrBlastAnalysis.includes("Not applicable") ? "Blast: " + eq.craterOrBlastAnalysis + "." : "",
        ].filter(Boolean).join(" ")
      })
      const lookup = equipmentLookup[eq.designation]
      if (lookup && !lookup.includes("timed") && !lookup.includes("No open-source")) {
        flags.push({
          phase: "Military Analysis", severity: "info" as Severity,
          title: "Database: " + eq.designation,
          detail: "Records: " + lookup.slice(0, 300)
        })
      }
    }
    if (militaryDeep.redFlags?.length > 0) {
      flags.push({
        phase: "Military Analysis", severity: "high" as Severity,
        title: "Attribution red flags",
        detail: militaryDeep.redFlags.join("; ")
      })
    }
  }

  // Reverse image search
  const reverseSkipped = reverseSearch.includes("skipped") || reverseSearch.includes("not configured")
  if (reverseSkipped) {
    flags.push({
      phase: "Reverse Image Search", severity: "info" as Severity,
      title: "Manual reverse image search — drag your image to:",
      detail: "[Google Lens](https://lens.google.com) · [Yandex Images](https://yandex.com/images) · [TinEye](https://tineye.com) — upload or drag the image on each site. Add GOOGLE_VISION_API_KEY to .env.local for automated search."
    })
  } else if (reverseSearch.includes("exact match")) {
    flags.push({ phase: "Reverse Image Search", severity: "high" as Severity, title: "Prior appearances found online", detail: reverseSearch })
  } else if (reverseSearch.includes("No prior") || reverseSearch.includes("consistent with original")) {
    flags.push({ phase: "Reverse Image Search", severity: "clean" as Severity, title: "No prior web appearances", detail: "Not found in web indexes — consistent with original material." })
  } else {
    flags.push({ phase: "Reverse Image Search", severity: "info" as Severity, title: "Reverse search result", detail: reverseSearch })
  }

  // EXIF
  if (exifData && Object.keys(exifData).length > 0) {
    flags.push({
      phase: "Metadata (EXIF)", severity: "info" as Severity,
      title: exifData.dateTime ? "Metadata present — " + exifData.dateTime : "Metadata present",
      detail: "Device: " + (exifData.make || "unknown") + " " + (exifData.model || "") +
        ". Software: " + (exifData.software || "none") + ". " +
        (exifData.gps ? "GPS: " + exifData.gps + "." : "No GPS.")
    })
  } else {
    flags.push({ phase: "Metadata (EXIF)", severity: "info" as Severity, title: "No EXIF metadata", detail: "Stripped — consistent with social media upload. Not suspicious alone." })
  }

  // Web corroboration
  if (claim && !webSearch.summary.includes("skipped")) {
    if (webSearch.factChecks > 0) {
      flags.push({ phase: "Web Corroboration", severity: "high" as Severity, title: webSearch.factChecks + " fact-check(s) found", detail: webSearch.summary.slice(0, 400) })
    } else if (webSearch.trusted > 0) {
      flags.push({ phase: "Web Corroboration", severity: "clean" as Severity, title: "Corroborated by " + webSearch.trusted + " trusted outlet(s)", detail: webSearch.summary.slice(0, 400) })
    } else if (webSearch.fringeOnly) {
      flags.push({ phase: "Web Corroboration", severity: "moderate" as Severity, title: "Claim only in unverified sources", detail: "No coverage from established outlets. Claims appearing only in fringe sources warrant caution." })
    } else {
      flags.push({ phase: "Web Corroboration", severity: "moderate" as Severity, title: "No corroboration found", detail: "GDELT found no matching coverage. This may mean the event is too recent, too localised, or unverified." })
    }
  }

  // Weather
  if (weatherResult && !weatherResult.includes("skipped") &&
      !weatherResult.includes("timed") && !weatherResult.includes("unavailable")) {
    flags.push({ phase: "Physical Verification", severity: "info" as Severity, title: "Historical weather", detail: weatherResult })
  }

  // Historical incident records
  if (incidentResult && !incidentResult.includes("skipped") && !incidentResult.includes("failed")) {
    const hasIncidents = incidentResult.includes("Incidents recorded")
    flags.push({
      phase: "Physical Verification", severity: hasIncidents ? "high" as Severity : "clean" as Severity,
      title: hasIncidents ? "Military incidents found near this location/date" : "No incident records found near this location/date",
      detail: incidentResult
    })
  }

  // ── Score computation ────────────────────────────────────────────────────
  const imageAuthenticityScore = Math.round((gemini.image_authenticity_score as number) ?? 50)

  // Gemini's visual-only claim score (conservative, defaults to 50)
  let claimAccuracyScore = Math.round((gemini.claim_accuracy_score as number) ?? 50)

  // Adjust claim accuracy based on web corroboration — the most reliable external signal
  if (claim) {
    if (webSearch.factChecks > 0) {
      claimAccuracyScore = Math.max(10, claimAccuracyScore - 25)   // fact-checks usually debunk
    } else if (webSearch.trusted >= 3) {
      claimAccuracyScore = Math.min(88, claimAccuracyScore + 22)   // strong corroboration
    } else if (webSearch.trusted >= 1) {
      claimAccuracyScore = Math.min(78, claimAccuracyScore + 12)   // some corroboration
    } else if (webSearch.fringeOnly) {
      claimAccuracyScore = Math.max(22, claimAccuracyScore - 12)   // fringe-only is suspicious
    }
  }

  const overallScore = claim
    ? Math.round(imageAuthenticityScore * 0.4 + claimAccuracyScore * 0.6)
    : imageAuthenticityScore
  // When no claim is given, overall = image auth score by design (nothing to verify against)

  const verdict = deriveVerdict(
    imageAuthenticityScore, claimAccuracyScore, !!claim,
    webSearch.trusted, webSearch.factChecks, webSearch.fringeOnly
  )
  const verdictColor = overallScore >= 65 ? "teal" : overallScore >= 40 ? "amber" : "red"

  const phases = [
    { name: "Live News Briefing", status: briefing.skipped ? "info" as const : "pass" as const, summary: briefing.skipped ? "Not a conflict topic — skipped" : "GDELT conflict news injected (" + briefing.sources.length + " sources)" },
    { name: "Triage & Pre-Check", status: (factCheckPreCheck.length > 30 && !factCheckPreCheck.includes("No existing") && !factCheckPreCheck.includes("failed")) ? "warn" as const : "pass" as const, summary: factCheckPreCheck !== "skipped" ? factCheckPreCheck.slice(0, 200) : "Emotional framing: " + ((gemini.emotional_framing as string) || "assessed") },
    { name: "Image Forensics", status: (gemini.visual_artifacts as string)?.toLowerCase().includes("no sign") ? "pass" as const : "warn" as const, summary: (gemini.visual_artifacts as string) || "Assessed" },
    { name: "Scene Description", status: "info" as const, summary: (gemini.scene_description as string) || "See flags" },
    { name: "Physical Verification", status: incidentResult.includes("Incidents recorded") ? "warn" as const : "info" as const, summary: [(gemini.physical_consistency as string), weatherResult, incidentResult].filter(s => s && !s.includes("skipped") && !s.includes("timed") && !s.includes("failed")).join(" | ") || "Assessed" },
    { name: "Military Analysis", status: (!militaryDeep.skipped && militaryDeep.redFlags?.length > 0) ? "warn" as const : (gemini.military_analysis as string)?.includes("No military") ? "pass" as const : "info" as const, summary: militaryDeep.deepSummary || (gemini.military_analysis as string) || "No equipment identified" },
    { name: "Temporal Analysis", status: "info" as const, summary: (gemini.temporal_analysis as string) || "No inconsistencies detected" },
    { name: "Geolocation Clues", status: "info" as const, summary: (gemini.geolocation_clues as string) || "No identifying visual clues in frame" },
    { name: "Linguistic Analysis", status: "info" as const, summary: (gemini.linguistic_analysis as string) || "No text to analyze" },
    { name: "Reverse Image Search", status: reverseSearch.includes("exact match") ? "warn" as const : reverseSkipped ? "info" as const : "pass" as const, summary: reverseSkipped ? "Manual search required — see Google Lens / Yandex / TinEye" : reverseSearch.slice(0, 200) },
    { name: "Web Corroboration", status: webSearch.trusted > 0 ? "pass" as const : webSearch.fringeOnly ? "warn" as const : "info" as const, summary: webSearch.summary.slice(0, 200) },
    { name: "Devil's Advocate", status: "info" as const, summary: (gemini.devils_advocate as string) || "" },
  ]

  return {
    imageAuthenticityScore,
    claimAccuracyScore,
    overallScore,
    score: overallScore,
    confidence: gemini.confidence as "HIGH" | "MEDIUM" | "LOW",
    verdict,
    verdictColor,
    flags,
    executiveSummary: gemini.executive_summary as string,
    devilsAdvocate: gemini.devils_advocate as string,
    metadata: exifData as VerificationResult["metadata"],
    elaFindings: gemini.visual_artifacts as string,
    phases,
    checkedAt: new Date().toISOString()
  }
}

// ── Main handler ───────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get("image") as File | null
    const claim = (formData.get("claim") as string) || ""
    if (!file) return NextResponse.json({ error: "No image provided" }, { status: 400 })

    const bytes = await file.arrayBuffer()
    const imageBase64 = Buffer.from(bytes).toString("base64")
    const mimeType = file.type || "image/jpeg"
    const exifRaw = formData.get("exif")
    const exifData = exifRaw ? JSON.parse(exifRaw as string) : null

    // ── Fetch briefing + reverse search in parallel, stagger GDELT calls ────
    // GDELT rate-limits on shared IPs — stagger the 3 calls by 600ms each
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
    const [briefing, reverseSearch, webSearch, factCheckPreCheck] = await Promise.all([
      claim ? runNewsBriefing(claim) : Promise.resolve(EMPTY_BRIEFING),
      runReverseImageSearch(imageBase64),
      claim ? delay(600).then(() => runWebSearch(claim)) : Promise.resolve({ summary: "No claim — web search skipped", trusted: 0, factChecks: 0, fringeOnly: false }),
      claim ? delay(1200).then(() => runFactCheckPreCheck(claim)) : Promise.resolve("skipped"),
    ])

    // ── Gemini vision analysis — now receives live briefing ───────────────
    const geminiResult = await runGeminiAnalysis(imageBase64, mimeType, claim, briefing)

    // ── Conditional deep military pass ────────────────────────────────────
    const hasMilitary = geminiResult.has_military_equipment === true ||
      (geminiResult.military_analysis && !String(geminiResult.military_analysis).includes("No military"))

    const militaryDeep: MilitaryAnalysisResult = hasMilitary
      ? await runDeepMilitaryAnalysis(imageBase64, mimeType, geminiResult.military_analysis || "", claim)
      : { skipped: true, equipment: [], overallAttribution: "", redFlags: [], deepSummary: "" }

    const designations = (militaryDeep.equipment || []).map((e: MilitaryItem) => e.designation)
    const equipmentLookup = designations.length > 0 ? await runEquipmentLookup(designations) : {}

    // ── Weather + historical incident check — only if GPS + date in EXIF ────
    let weatherResult = "skipped — no GPS in metadata"
    let incidentResult = "skipped — no GPS in metadata"
    if (exifData?.gps && exifData?.dateTime) {
      const parts = String(exifData.gps).split(",").map((s: string) => s.trim())
      const lat = parseFloat(parts[0])
      const lon = parseFloat(parts[1])
      if (!isNaN(lat) && !isNaN(lon)) {
        ;[weatherResult, incidentResult] = await Promise.all([
          runWeatherCheck(lat, lon, exifData.dateTime),
          runHistoricalIncidentCheck(lat, lon, exifData.dateTime),
        ])
      }
    }

    const result = assembleResult(
      geminiResult, reverseSearch, webSearch, exifData,
      factCheckPreCheck, weatherResult, incidentResult, militaryDeep, equipmentLookup, briefing, claim
    )
    return NextResponse.json(result)

  } catch (err) {
    console.error("Analysis error:", err)
    return NextResponse.json({ error: "Analysis failed", detail: String(err) }, { status: 500 })
  }
}
