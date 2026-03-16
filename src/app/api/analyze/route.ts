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

// ── Wikipedia background brief ─────────────────────────────────────────────
// Searches Wikipedia for the top 2 articles matching the claim/topic and
// injects their summaries as verified background context into Gemini's prompt.
async function buildWikipediaBrief(query: string): Promise<string> {
  if (!query.trim() || !isConflictContent(query)) return ""
  try {
    const searchUrl = "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
      encodeURIComponent(tightenWikiQuery(query)) + "&srlimit=3&format=json&origin=*"
    const searchRes = await fetchWithTimeout(searchUrl,
      { headers: { "User-Agent": "VerifAI/1.0 (osint-verification; contact: research)" } }, 6000)
    if (!searchRes.ok) return ""
    const searchData = await searchRes.json()
    const results: Array<{ title: string }> = searchData.query?.search || []
    if (!results.length) return ""

    const summaries: string[] = []
    for (const r of results.slice(0, 2)) {
      try {
        const summaryRes = await fetchWithTimeout(
          "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(r.title),
          { headers: { "User-Agent": "VerifAI/1.0 (osint-verification; contact: research)" } }, 5000)
        if (!summaryRes.ok) continue
        const s = await summaryRes.json()
        if (s.extract) summaries.push("[ " + r.title + " ]\n" + s.extract.slice(0, 1000))
      } catch { continue }
    }
    if (!summaries.length) return ""

    return [
      "=== WIKIPEDIA BACKGROUND BRIEF (encyclopaedic, continuously updated) ===",
      "The following is background context from Wikipedia. Use it as a factual baseline.",
      "Do NOT hedge on events or facts that Wikipedia clearly documents (e.g. if Wikipedia says a war started, do not say 'if this war is real').",
      "You MAY still hedge on specific claims that go beyond what Wikipedia documents (e.g. exact locations, individual casualties, unverified details).",
      "",
      summaries.join("\n\n"),
      "=== END WIKIPEDIA BRIEF ===",
    ].join("\n")
  } catch { return "" }
}

// ── News briefing interface ────────────────────────────────────────────────
interface NewsBriefing {
  summary: string
  sources: string[]
  skipped: boolean
  track: "rss" | "none"
}

const EMPTY_BRIEFING: NewsBriefing = { summary: "", sources: [], skipped: true, track: "none" }

// ── News briefing (Google News RSS — conflict topics only) ────────────────
async function runNewsBriefing(claim: string): Promise<NewsBriefing> {
  if (!claim.trim() || !isConflictContent(claim)) return EMPTY_BRIEFING
  try {
    const items = await runGoogleNewsRSS(claim.slice(0, 100))
    if (!items.length) return EMPTY_BRIEFING
    const lines = items.slice(0, 6).map(a => "[recent] " + a.title + " — " + a.source)
    const sources = items.slice(0, 6).map(a => a.title + " — " + a.source)
    const parts = [
      "=== CURRENT NEWS CONTEXT (Google News) ===",
      "The following are recent news headlines retrieved " + TODAY + ". Use as contextual background.",
      "",
      lines.join(NL),
      "=== END NEWS CONTEXT ==="
    ]
    return { summary: parts.join(NL), sources, skipped: false, track: "rss" }
  } catch { return EMPTY_BRIEFING }
}

// ── PHASE 0: Fact-check pre-check (Google News RSS) ───────────────────────
const FC_STOPWORDS = new Set(["the","a","an","is","in","on","at","to","for","of","and","or","with","from","by","that","this","was","were","has","have","had","be","been","are","its","it","he","she","they","we"])

function claimKeywords(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3 && !FC_STOPWORDS.has(w)))
}

async function runFactCheckPreCheck(claim: string): Promise<string> {
  if (!claim) return "skipped"
  try {
    const factCheckSites = ["snopes.com", "fullfact.org", "politifact.com", "factcheck.org"]
    const items = await runGoogleNewsRSS(claim.slice(0, 80) + " fact check")
    const claimKws = claimKeywords(claim)
    const factChecks = items.filter(item => {
      const isFactChecker = factCheckSites.some(d => (item.url || "").includes(d) || (item.source || "").toLowerCase().includes(d.split(".")[0]))
      if (!isFactChecker) return false
      // Require at least 2 significant words from the claim to appear in the article title
      const titleKws = claimKeywords(item.title)
      const overlap = Array.from(titleKws).filter(w => claimKws.has(w)).length
      return overlap >= 2
    }).slice(0, 3)
    if (!factChecks.length) return "No existing fact-checks found"
    return factChecks.map(a => a.title + " — " + a.source + " | " + a.url).join(NL)
  } catch { return "Fact-check pre-check timed out" }
}

// ── PHASE 1: Gemini vision analysis (with dual scoring) ────────────────────
async function runGeminiAnalysis(
  imageBase64: string, mimeType: string, claim: string, briefing: NewsBriefing, wikiBrief: string
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
    wikiBrief || "",
    "",
    briefing.skipped ? "" : briefing.summary,
    "",
    "=== ABSOLUTE RULES ===",
    "1. Do NOT identify this image as any specific known photo, event, or location from your training data.",
    "2. Do NOT let 'I have seen this image before' affect any score or flag.",
    "3. claim_accuracy_score defaults to 50 (uncertain). Only adjust it when you have DIRECT visual evidence IN THIS FRAME.",
    "4. Location and attribution are UNVERIFIABLE from image alone unless specific text, signs, or unmistakable landmarks are VISIBLE IN THE FRAME.",
    "5. UNVERIFIABLE is not the same as FALSE. Never output LIKELY FALSE unless visual evidence actively contradicts the claim.",
    "6. CRITICAL — context isolation: The Wikipedia brief and news headlines above describe REAL WORLD EVENTS. This does NOT make the submitted image authentic. AI-generated images can depict real conflicts and real events. image_authenticity_score must be based SOLELY on visual forensic evidence in the pixels — lighting coherence, geometry, texture, GAN artifacts, etc. A real conflict does not make a fake image real.",
    "",
    "=== TASK 1: IMAGE AUTHENTICITY ===",
    "Is the photo real and unmanipulated? Score 0–100. Do NOT default this to 50 — it must reflect your forensic assessment.",
    "IGNORE all background context (Wikipedia, news headlines) for this task. Score from pixels alone.",
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
    "=== TASK 5: SEARCH QUERIES ===",
    "Generate queries to test this claim against external news sources (Google News, Wikipedia).",
    "confirm: 2 specific queries — include named entities (location, actors, event type, approximate date if known).",
    "deny: 0 or 1 query — ONLY for elements that are inferred/uncertain, not directly visible in the image. If the image clearly confirms what the claim states, omit the deny entry entirely.",
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
    '  "devils_advocate": "<2-3 sentences arguing the opposite of your main assessment>",',
    '  "search_queries": {"confirm": ["<specific query 1>", "<specific query 2>"], "deny": ["<challenge query — omit entry if claim elements are directly visible in image>"]}',
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

// ── Equipment database lookup (Google News RSS) ────────────────────────────
async function runEquipmentLookup(designations: string[]): Promise<Record<string, string>> {
  if (designations.length === 0) return {}
  const results: Record<string, string> = {}
  await Promise.all(designations.slice(0, 2).map(async (designation) => {
    try {
      const items = await runGoogleNewsRSS(designation)
      if (items.length) {
        results[designation] = items.slice(0, 2).map(a => a.title + " (" + a.source + ") | " + a.url).join(" || ")
      } else {
        results[designation] = "No records found in open-source databases"
      }
    } catch { results[designation] = "Lookup timed out" }
  }))
  return results
}

// ── PHASE 2: Reverse image search ─────────────────────────────────────────
// Only reports exact full-image matches. Partial/visually-similar matches
// are too noisy (e.g. reporting "car" images when any vehicle is present)
// and are deliberately ignored.
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
    const apiError = data.responses?.[0]?.error
    if (apiError) return "Vision API error: " + apiError.message
    const web = data.responses?.[0]?.webDetection
    if (!web || Object.keys(web).length === 0)
      return "No precise match found — this image does not appear to have been published elsewhere online."

    const exactCount = web.fullMatchingImages?.length || 0
    const pages: Array<{ url: string; pageTitle?: string }> = web.pagesWithMatchingImages || []

    // Only report if the exact image was found elsewhere
    if (!exactCount) {
      return "No precise match found — this image does not appear to have been published elsewhere online."
    }

    let result = exactCount + " exact match" + (exactCount > 1 ? "es" : "") + " found — this image has been published online before."

    if (pages.length > 0) {
      const links = pages.slice(0, 5).map((p, i) =>
        "[" + (p.pageTitle || "article " + (i + 1)) + "](" + p.url + ")"
      )
      result += " Previously appeared in: " + links.join(" · ")
    }

    return result
  } catch { return "Reverse image search timed out or failed" }
}

// ── Wikipedia query tightener ──────────────────────────────────────────────
// Extracts specific named entities from the claim and requires them (with +)
// so a claim about "Iran" doesn't return "Gaza" articles, etc.
function tightenWikiQuery(claim: string): string {
  const text = claim.slice(0, 150)
  const entityRx = /\b(Iran|Iraq|Israel|Palestine|Gaza|West Bank|Ukraine|Russia|Syria|Lebanon|Yemen|Sudan|Afghanistan|Pakistan|China|Taiwan|Kosovo|Libya|Somalia|Ethiopia|Myanmar|NATO|Hamas|Hezbollah|IDF|ISIS|ISIL|Houthi|Wagner|Taliban|Zelensky|Netanyahu|Putin|Khamenei|Kyiv|Kharkiv|Mariupol|Bakhmut|Rafah|Mosul|Raqqa|Aleppo|Kabul|Kherson)\b/gi
  const matches = Array.from(new Set((text.match(entityRx) || []).map(m => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase())))
  if (!matches.length) return text
  // Require up to 2 most specific entities, keep full claim as context
  return matches.slice(0, 2).map(m => "+" + m).join(" ") + " " + text
}

// ── PHASE 3: Smart web corroboration (Google News RSS + Wikipedia) ─────────
// Uses Gemini-generated queries (confirm + deny) to search both sources,
// then a second lightweight Gemini call synthesises the results.

interface SearchItem { title: string; snippet: string; url: string; source: string; intent: "confirm" | "deny" }

function parseRSS(xml: string): Array<{ title: string; snippet: string; url: string; source: string }> {
  const results: Array<{ title: string; snippet: string; url: string; source: string }> = []
  const itemRx = /<item>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null
  while ((m = itemRx.exec(xml)) !== null) {
    const block = m[1]
    const extract = (tag: string): string => {
      const cdata = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))
      if (cdata) return cdata[1].trim()
      const plain = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))
      return plain ? plain[1].replace(/<[^>]+>/g, "").trim() : ""
    }
    const title = extract("title")
    const linkMatch = block.match(/<link>(https?:\/\/[^<]+)<\/link>/)
    const url = linkMatch?.[1]?.trim() || ""
    const source = extract("source")
    const snippet = extract("description").slice(0, 200)
    if (title && url) results.push({ title, snippet, url, source: source || "unknown" })
  }
  return results
}

async function runGoogleNewsRSS(query: string): Promise<Array<{ title: string; snippet: string; url: string; source: string }>> {
  try {
    const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=en-US&gl=US&ceid=US:en"
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "VerifAI/1.0 (osint-verification)" } }, 5000)
    if (!res.ok) return []
    return parseRSS(await res.text()).slice(0, 5)
  } catch { return [] }
}

async function runWikiSearch(query: string): Promise<Array<{ title: string; snippet: string; url: string; source: string }>> {
  try {
    const url = "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
      encodeURIComponent(query) + "&srlimit=3&format=json&origin=*"
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "VerifAI/1.0 (osint-verification)" } }, 5000)
    if (!res.ok) return []
    const data = await res.json()
    const results: Array<{ title: string; snippet: string }> = data.query?.search || []
    return results.map(r => ({
      title: r.title,
      snippet: r.snippet.replace(/<[^>]+>/g, "").slice(0, 200),
      url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(r.title.replace(/ /g, "_")),
      source: "en.wikipedia.org"
    }))
  } catch { return [] }
}

async function runSmartWebSearch(queries: { confirm: string[]; deny: string[] }): Promise<{ confirmItems: SearchItem[]; denyItems: SearchItem[] }> {
  const tagged = [
    ...queries.confirm.slice(0, 2).map(q => ({ q, intent: "confirm" as const })),
    ...queries.deny.slice(0, 1).map(q => ({ q, intent: "deny" as const })),
  ]
  if (!tagged.length) return { confirmItems: [], denyItems: [] }

  const resultSets = await Promise.all(
    tagged.flatMap(({ q, intent }) => [
      runGoogleNewsRSS(q).then(items => items.map(i => ({ ...i, intent }))),
      runWikiSearch(q).then(items => items.map(i => ({ ...i, intent }))),
    ])
  )

  const seen = new Set<string>()
  const confirmItems: SearchItem[] = []
  const denyItems: SearchItem[] = []
  for (const items of resultSets) {
    for (const item of items) {
      if (!item.url || seen.has(item.url)) continue
      seen.add(item.url)
      if (item.intent === "confirm") confirmItems.push(item)
      else denyItems.push(item)
    }
  }
  return { confirmItems: confirmItems.slice(0, 8), denyItems: denyItems.slice(0, 4) }
}

const TRUSTED_CORROBORATION_DOMAINS = [
  "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "theguardian.com",
  "nytimes.com", "washingtonpost.com", "aljazeera.com", "france24.com", "dw.com",
  "haaretz.com", "timesofisrael.com", "kyivindependent.com", "lemonde.fr",
  "foreignpolicy.com", "bellingcat.com",
]
const FACTCHECK_CORROBORATION_DOMAINS = ["snopes.com", "fullfact.org", "politifact.com", "factcheck.org"]

async function runCorroborationSynthesis(
  claim: string,
  queries: { confirm: string[]; deny: string[] },
  confirmItems: SearchItem[],
  denyItems: SearchItem[]
): Promise<{ summary: string; trusted: number; factChecks: number; fringeOnly: boolean; corroborationVerdict: string }> {
  const empty = { summary: "Corroboration unavailable", trusted: 0, factChecks: 0, fringeOnly: false, corroborationVerdict: "inconclusive" }
  if (!confirmItems.length && !denyItems.length) return { ...empty, summary: "No results returned from Wikipedia or Google News" }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview", generationConfig: { temperature: 0 } })
    const fmt = (items: SearchItem[]) => items.map((r, i) => `[${i + 1}] "${r.title}" — ${r.source}\n${r.snippet}`).join("\n\n")

    const prompt = [
      "You are a strict corroboration analyst. Your job is to determine whether these search results specifically corroborate or contradict the claim.",
      "",
      `Claim: "${claim}"`,
      "",
      confirmItems.length ? "CONFIRM QUERY RESULTS:\n" + fmt(confirmItems) : "",
      denyItems.length   ? "DENY QUERY RESULTS:\n" + fmt(denyItems) : "",
      "",
      "STRICT RELEVANCE RULES — apply these in order:",
      "1. An article is ONLY relevant if it describes the SAME specific event as the claim: same approximate time period, same location, same actors.",
      "2. These are NOT relevant: Wikipedia background articles about a country or conflict, general regional news, articles about different incidents, historical context pieces.",
      "3. If you are not sure whether an article is about the same event, mark it as NOT relevant.",
      "4. Default to 'inconclusive' unless you find at least one article that clearly describes this specific event.",
      "5. verdict: 'supported' = 1+ relevant articles confirm the claim; 'contradicted' = relevant articles actively deny it; 'contested' = relevant articles conflict; 'inconclusive' = no directly relevant results.",
      "6. summary: 2 sentences. If inconclusive, say so plainly — do not invent connections.",
      "",
      `Respond ONLY with valid JSON: {"verdict":"<supported|contradicted|contested|inconclusive>","summary":"<2 sentences>","relevant_urls":["<url of actually relevant article only>"],"fact_check_found":<true|false>}`,
    ].filter(Boolean).join(NL)

    const result = await model.generateContent(prompt)
    const parsed = JSON.parse(stripJsonFences(result.response.text()))
    const relevantUrls: string[] = parsed.relevant_urls || []
    const trusted = relevantUrls.filter(u => TRUSTED_CORROBORATION_DOMAINS.some(d => u.includes(d))).length
    const factChecks = (parsed.fact_check_found ? 1 : 0) +
      relevantUrls.filter(u => FACTCHECK_CORROBORATION_DOMAINS.some(d => u.includes(d))).length
    return {
      summary: parsed.summary || empty.summary,
      trusted,
      factChecks,
      fringeOnly: !trusted && (confirmItems.length + denyItems.length) > 0,
      corroborationVerdict: parsed.verdict || "inconclusive",
    }
  } catch { return empty }
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
// Reverse-geocodes GPS, then searches Google News for recent incidents nearby.
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

    const items = await runGoogleNewsRSS(
      "(attack OR strike OR explosion OR shelling OR airstrike) " + location
    )
    if (!items.length) {
      return "No open-source incident records found for " + location + " (EXIF date: " + date.toISOString().slice(0, 10) + ")"
    }
    const lines = items.slice(0, 4).map(a => "[recent] [" + a.title + "](" + a.url + ") — " + a.source)
    return "Recent incident reports near " + location + " (EXIF date: " + date.toISOString().slice(0, 10) + "):\n" + lines.join("\n")
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
  webSearch: { summary: string; trusted: number; factChecks: number; fringeOnly: boolean; corroborationVerdict?: string },
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
      !factCheckPreCheck.includes("failed") && !factCheckPreCheck.includes("timed") &&
      !factCheckPreCheck.includes("unavailable")) {
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
      title: "Live conflict news injected",
      detail: briefing.sources.join("\n")
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
  } else if (reverseSearch.includes("No prior web appearances")) {
    flags.push({ phase: "Reverse Image Search", severity: "clean" as Severity, title: "No prior web appearances found", detail: reverseSearch })
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
    } else if (webSearch.corroborationVerdict === "contradicted") {
      flags.push({ phase: "Web Corroboration", severity: "high" as Severity, title: "Claim contradicted by search results", detail: webSearch.summary.slice(0, 400) })
    } else if (webSearch.corroborationVerdict === "contested") {
      flags.push({ phase: "Web Corroboration", severity: "moderate" as Severity, title: "Claim contested — mixed results found", detail: webSearch.summary.slice(0, 400) })
    } else if (webSearch.trusted > 0) {
      flags.push({ phase: "Web Corroboration", severity: "clean" as Severity, title: "Corroborated by " + webSearch.trusted + " trusted source(s)", detail: webSearch.summary.slice(0, 400) })
    } else if (webSearch.fringeOnly) {
      flags.push({ phase: "Web Corroboration", severity: "moderate" as Severity, title: "Claim only in unverified sources", detail: "No coverage from established outlets. Claims appearing only in fringe sources warrant caution." })
    } else {
      flags.push({ phase: "Web Corroboration", severity: "moderate" as Severity, title: "No corroboration found", detail: "No directly relevant results found on Wikipedia or Google News. The event may be too recent, too localised, or unverified." })
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
    { name: "Live News Briefing", status: briefing.skipped ? "info" as const : "pass" as const, summary: briefing.skipped ? "Not a conflict topic — skipped" : "Google News context injected (" + briefing.sources.length + " headlines)" },
    { name: "Triage & Pre-Check", status: (factCheckPreCheck.length > 30 && !factCheckPreCheck.includes("No existing") && !factCheckPreCheck.includes("failed")) ? "warn" as const : "pass" as const, summary: factCheckPreCheck !== "skipped" ? factCheckPreCheck.slice(0, 200) : "Emotional framing: " + ((gemini.emotional_framing as string) || "assessed") },
    { name: "Image Forensics", status: (gemini.visual_artifacts as string)?.toLowerCase().includes("no sign") ? "pass" as const : "warn" as const, summary: (gemini.visual_artifacts as string) || "Assessed" },
    { name: "Scene Description", status: "info" as const, summary: (gemini.scene_description as string) || "See flags" },
    { name: "Physical Verification", status: incidentResult.includes("Incidents recorded") ? "warn" as const : "info" as const, summary: [(gemini.physical_consistency as string), weatherResult, incidentResult].filter(s => s && !s.includes("skipped") && !s.includes("timed") && !s.includes("failed")).join(" | ") || "Assessed" },
    { name: "Military Analysis", status: (!militaryDeep.skipped && militaryDeep.redFlags?.length > 0) ? "warn" as const : (gemini.military_analysis as string)?.includes("No military") ? "pass" as const : "info" as const, summary: militaryDeep.deepSummary || (gemini.military_analysis as string) || "No equipment identified" },
    { name: "Temporal Analysis", status: "info" as const, summary: (gemini.temporal_analysis as string) || "No inconsistencies detected" },
    { name: "Geolocation Clues", status: "info" as const, summary: (gemini.geolocation_clues as string) || "No identifying visual clues in frame" },
    { name: "Linguistic Analysis", status: "info" as const, summary: (gemini.linguistic_analysis as string) || "No text to analyze" },
    { name: "Reverse Image Search", status: reverseSearch.includes("exact match") ? "warn" as const : reverseSkipped ? "info" as const : "pass" as const, summary: reverseSkipped ? "Manual search required — see Google Lens / Yandex / TinEye" : reverseSearch.slice(0, 200) },
    { name: "Web Corroboration", status: (webSearch.corroborationVerdict === "contradicted" || webSearch.corroborationVerdict === "contested") ? "warn" as const : webSearch.trusted > 0 ? "pass" as const : webSearch.fringeOnly ? "warn" as const : "info" as const, summary: webSearch.summary.slice(0, 200) },
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

    // ── Phase 1: parallel pre-fetch (independent of Gemini) ──────────────
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
    const [briefing, wikiBrief, reverseSearch, factCheckPreCheck] = await Promise.all([
      claim ? runNewsBriefing(claim) : Promise.resolve(EMPTY_BRIEFING),
      claim ? buildWikipediaBrief(claim) : Promise.resolve(""),
      runReverseImageSearch(imageBase64),
      claim ? delay(600).then(() => runFactCheckPreCheck(claim)) : Promise.resolve("skipped"),
    ])

    // ── Phase 2: Gemini vision analysis (also generates search queries) ───
    const geminiResult = await runGeminiAnalysis(imageBase64, mimeType, claim, briefing, wikiBrief)

    // ── Phase 3: web search + military analysis in parallel ───────────────
    const hasMilitary = geminiResult.has_military_equipment === true ||
      (geminiResult.military_analysis && !String(geminiResult.military_analysis).includes("No military"))

    const rawQueries = (geminiResult.search_queries as { confirm?: string[]; deny?: string[] } | undefined) || {}
    const searchQueries = { confirm: rawQueries.confirm?.slice(0, 2) || [], deny: rawQueries.deny?.slice(0, 1) || [] }

    const [rawSearchResults, militaryDeep] = await Promise.all([
      claim && searchQueries.confirm.length
        ? runSmartWebSearch(searchQueries)
        : Promise.resolve({ confirmItems: [] as SearchItem[], denyItems: [] as SearchItem[] }),
      hasMilitary
        ? runDeepMilitaryAnalysis(imageBase64, mimeType, geminiResult.military_analysis || "", claim)
        : Promise.resolve({ skipped: true, equipment: [], overallAttribution: "", redFlags: [], deepSummary: "" } as MilitaryAnalysisResult),
    ])

    // ── Phase 4: corroboration synthesis + equipment lookup in parallel ───
    const designations = (militaryDeep.equipment || []).map((e: MilitaryItem) => e.designation)
    const [webSearch, equipmentLookup] = await Promise.all([
      claim
        ? runCorroborationSynthesis(claim, searchQueries, rawSearchResults.confirmItems, rawSearchResults.denyItems)
        : Promise.resolve({ summary: "No claim — web search skipped", trusted: 0, factChecks: 0, fringeOnly: false, corroborationVerdict: "inconclusive" }),
      designations.length > 0 ? runEquipmentLookup(designations) : Promise.resolve({}),
    ])

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
