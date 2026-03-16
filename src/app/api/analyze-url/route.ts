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

// ── Safe fetch with timeout ─────────────────────────────────────────────────
async function fetchWithTimeout(url: string, options: RequestInit = {}, ms = 6000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

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

// ── Domain classification lists ─────────────────────────────────────────────
const TRUSTED_DOMAINS = [
  "bbc.co", "bbc.com", "reuters.com", "apnews.com", "nytimes.com",
  "theguardian.com", "washingtonpost.com", "aljazeera.com", "dw.com", "france24.com",
  "bellingcat.com", "rferl.org", "haaretz.com", "timesofisrael.com", "ynetnews.com",
  "axios.com", "afp.com", "lemonde.fr", "spiegel.de", "thetimes.co.uk",
  "cnn.com", "nbcnews.com", "cbsnews.com", "abcnews.go.com", "npr.org",
  "pbs.org", "politico.com", "theatlantic.com", "economist.com", "time.com",
  "newsweek.com", "foreignpolicy.com", "euronews.com", "skynews.com",
  "independent.co.uk", "ft.com", "bloomberg.com", "businessinsider.com",
  "middleeasteye.net", "jpost.com", "arabnews.com", "trtworld.com"
]

const SATIRE_DOMAINS = [
  "theonion.com", "babylonbee.com", "waterfordwhispersnews.com", "thedailymash.co.uk"
]

const KNOWN_BAD_DOMAINS = [
  "infowars.com", "naturalnews.com", "beforeitsnews.com", "yournewswire.com", "newspunch.com"
]

type DomainClassification = "trusted" | "satire" | "bad" | "unknown"

function classifyDomain(domain: string): DomainClassification {
  const d = domain.toLowerCase()
  if (SATIRE_DOMAINS.some(sd => d.includes(sd))) return "satire"
  if (KNOWN_BAD_DOMAINS.some(bd => d.includes(bd))) return "bad"
  if (TRUSTED_DOMAINS.some(td => d.includes(td))) return "trusted"
  return "unknown"
}

// ── HTML text extraction (regex-based, no external libs) ────────────────────
interface ArticleData {
  title: string
  domain: string
  author: string
  date: string
  ogImage: string
  text: string
}

function extractDomain(url: string): string {
  try {
    const m = url.match(/^https?:\/\/([^/?#]+)/)
    return m ? m[1].replace(/^www\./, "") : url
  } catch {
    return url
  }
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

function parseArticleHtml(html: string, url: string): ArticleData {
  const domain = extractDomain(url)

  // Title: try og:title first, then <title>
  const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
  const titleTagMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const title = decodeHtmlEntities(
    (ogTitleMatch?.[1] || titleTagMatch?.[1] || "").trim()
  )

  // Author: try various meta patterns
  const authorPatterns = [
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author["']/i,
    /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:author["']/i,
    /class=["'][^"']*author[^"']*["'][^>]*>([^<]{3,60})</i,
    /itemprop=["']author["'][^>]*>([^<]{3,60})</i,
  ]
  let author = ""
  for (const pat of authorPatterns) {
    const m = html.match(pat)
    if (m?.[1]?.trim()) { author = decodeHtmlEntities(m[1].trim()); break }
  }

  // Date: try various meta patterns
  const datePatterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
    /<meta[^>]+name=["']publication_date["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
    /itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i,
  ]
  let date = ""
  for (const pat of datePatterns) {
    const m = html.match(pat)
    if (m?.[1]?.trim()) { date = m[1].trim().slice(0, 10); break }
  }

  // og:image
  const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
  const ogImage = ogImageMatch?.[1]?.trim() || ""

  // Main text: strip scripts/styles/nav/header/footer, then strip all tags
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()

  cleaned = decodeHtmlEntities(cleaned)

  // Truncate to 6000 chars
  const text = cleaned.slice(0, 6000)

  return { title, domain, author, date, ogImage, text }
}

// ── Conflict detection + live news briefing (mirrors analyze/route.ts) ─────
const CONFLICT_KEYWORDS = [
  "war", "conflict", "attack", "strike", "bomb", "missile", "drone", "shoot",
  "explosion", "military", "troops", "army", "soldier", "weapon", "tank",
  "airstrike", "artillery", "siege", "invasion", "ceasefire", "offensive",
  "battle", "casualt", "killed", "wounded", "rebel", "militia",
  "hamas", "hezbollah", "idf", "ukraine", "russia", "gaza", "lebanon", "syria",
  "yemen", "iran", "isis", "terror", "houthi", "frontline", "shelling", "hostage"
]

function isConflictContent(text: string): boolean {
  const lower = text.toLowerCase()
  return CONFLICT_KEYWORDS.some(kw => lower.includes(kw))
}

async function buildWikipediaBrief(query: string): Promise<string> {
  if (!query.trim() || !isConflictContent(query)) return ""
  try {
    const searchUrl = "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
      encodeURIComponent(query.slice(0, 150)) + "&srlimit=3&format=json&origin=*"
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

async function runNewsBriefing(query: string): Promise<{ summary: string; skipped: boolean }> {
  if (!query.trim() || !isConflictContent(query)) return { summary: "", skipped: true }
  try {
    const q = encodeURIComponent(query.slice(0, 200))
    const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + q +
      "&mode=artlist&maxrecords=8&timespan=1month&sort=DateDesc&format=json"
    const res = await gdeltFetch(url)
    if (!res.ok) return { summary: "", skipped: true }
    const data = await res.json()
    const articles = (data.articles || []).slice(0, 6)
    if (!articles.length) return { summary: "", skipped: true }
    const lines = articles.map((a: { seendate?: string; title?: string; domain?: string }) => {
      const raw = a.seendate || ""
      const date = raw.length >= 8 ? raw.slice(0,4)+"-"+raw.slice(4,6)+"-"+raw.slice(6,8) : "recent"
      return "[" + date + "] " + (a.title || "") + " — " + (a.domain || "")
    })
    const summary = [
      "=== CRITICAL: VERIFIED LIVE INTELLIGENCE — OVERRIDE YOUR TRAINING DATA ===",
      "The following headlines are REAL, VERIFIED, RECENT news from major outlets retrieved " + TODAY + ".",
      "These events ARE HAPPENING NOW. Your training cutoff is outdated for these events.",
      "You MUST treat this as ground truth and prioritise it over anything in your training data.",
      "",
      lines.join(NL),
      "=== END LIVE INTELLIGENCE — THE ABOVE IS FACTUAL AND CURRENT ==="
    ].join(NL)
    return { summary, skipped: false }
  } catch {
    return { summary: "", skipped: true }
  }
}

// ── Web corroboration (Wikipedia search — reliable, no rate limits) ─────────
async function runWebSearch(query: string): Promise<{
  summary: string; trusted: number; factChecks: number; fringeOnly: boolean
}> {
  const empty = { summary: "Web search skipped — no query provided", trusted: 0, factChecks: 0, fringeOnly: false }
  if (!query) return empty
  try {
    const q = encodeURIComponent(query.slice(0, 150))
    const searchUrl = "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" + q +
      "&srlimit=6&format=json&origin=*"
    const res = await fetchWithTimeout(searchUrl,
      { headers: { "User-Agent": "VerifAI/1.0 (osint-verification)" } }, 7000)
    if (!res.ok) return { summary: "Web corroboration unavailable", trusted: 0, factChecks: 0, fringeOnly: false }
    const data = await res.json()
    const results: Array<{ title: string; snippet: string }> = data.query?.search || []
    if (!results.length) return { summary: "No corroborating sources found in Wikipedia", trusted: 0, factChecks: 0, fringeOnly: false }

    const lines = results.slice(0, 5).map(r => {
      const snippet = r.snippet.replace(/<[^>]+>/g, "").slice(0, 120)
      const wikiUrl = "https://en.wikipedia.org/wiki/" + encodeURIComponent(r.title.replace(/ /g, "_"))
      return "[" + r.title + "](" + wikiUrl + "): " + snippet + "..."
    })

    const trusted = Math.min(results.length, 5)

    return {
      summary: lines.join(NL),
      trusted,
      factChecks: 0,
      fringeOnly: false
    }
  } catch { return { summary: "Web corroboration timed out", trusted: 0, factChecks: 0, fringeOnly: false } }
}

// ── Gemini article analysis ─────────────────────────────────────────────────
async function runGeminiArticleAnalysis(
  articleData: ArticleData,
  claim: string,
  webSearchSummary: string,
  newsBriefing: string,
  wikiBrief: string
) {
  const model = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    generationConfig: { temperature: 0 },
  })

  const claimLine = claim
    ? ('The submitter wants to verify this specific claim: "' + claim + '"')
    : "No specific claim provided — analyze the article objectively."

  const promptParts = [
    "You are a professional OSINT media analyst and fact-checker.",
    "Today's date: " + TODAY + ". Your training data has a cutoff — do NOT assume events are false just because they are recent or unknown to you.",
    "",
    wikiBrief || "",
    "",
    newsBriefing || "",
    "",
    "=== ABSOLUTE RULES ===",
    "1. Do NOT mark an article as LIKELY FALSE solely because you lack training data about the event it describes.",
    "2. If the article is from a recognized news outlet and describes an ongoing conflict, default to UNVERIFIABLE or NEEDS EXPERT REVIEW if you cannot confirm — not LIKELY FALSE.",
    "3. War coverage legitimately uses strong language. Do not penalize credibility for reporting intensity or urgency.",
    "4. A recent event (days or weeks old) with no web corroboration may simply be too new for GDELT — not fabricated.",
    "",
    "=== ARTICLE TO ANALYZE ===",
    "Title: " + articleData.title,
    "Domain: " + articleData.domain,
    "Author: " + (articleData.author || "Unknown"),
    "Date: " + (articleData.date || "Unknown"),
    "",
    "Article text (may be truncated):",
    articleData.text,
    "",
    "=== WEB CORROBORATION ===",
    webSearchSummary || "No web corroboration data available.",
    "",
    "=== TASK ===",
    claimLine,
    "",
    "Assess the source credibility and content credibility of this article.",
    "",
    "SOURCE CREDIBILITY SCORE (0-100):",
    "  80-100: Established news outlet with editorial standards, verifiable authorship",
    "  60-79: Generally reliable, minor quality issues",
    "  40-59: Unknown outlet, heavy opinion, unverifiable authorship",
    "  20-39: Known for misinformation, extreme bias, or anonymous fabrications",
    "  0-19: Confirmed propaganda/satire/fabrication",
    "",
    "CONTENT CREDIBILITY SCORE (0-100):",
    "  Start at 60 (benefit of the doubt). Adjust based on:",
    "  -10 to -20: anonymous sources for key claims",
    "  -10 to -15: statistics without citations",
    "  -10 to -20: emotional manipulation / sensationalist language",
    "  -5 to -15: missing dates or important context",
    "  -15 to -25: contradicts known facts or web corroboration",
    "  +10 to +20: multiple named sources, cited statistics, factual consistency",
    "  +10 to +20: corroborated by trusted outlets in web search",
    "",
    "Respond ONLY with valid JSON. No markdown. No text outside the JSON:",
    "{",
    '  "source_credibility_score": <0-100>,',
    '  "content_credibility_score": <0-100>,',
    '  "confidence": "<HIGH|MEDIUM|LOW>",',
    '  "verdict": "<VERIFIED|LIKELY AUTHENTIC|UNVERIFIABLE|LIKELY FALSE|NEEDS EXPERT REVIEW>",',
    '  "flags": [{"phase": "<Source Analysis|Content Analysis|Fact-Check|Web Corroboration|Writing Style>", "severity": "<critical|high|moderate|clean|info>", "title": "<string>", "detail": "<string>"}],',
    '  "key_claims": ["<main factual claim 1>", "<main factual claim 2>"],',
    '  "writing_style": "<neutral|sensationalist|opinion|propaganda|satire>",',
    '  "executive_summary": "<3-4 sentences summarizing the article, its credibility, and what can be confirmed>",',
    '  "devils_advocate": "<2-3 sentences arguing the opposite of your main assessment>",',
    '  "emotional_language": "<description of emotional or loaded language found, or: None detected>",',
    '  "missing_context": "<important context absent from the article, or: No significant omissions identified>"',
    "}"
  ]

  const result = await model.generateContent(promptParts.join(NL))
  return JSON.parse(stripJsonFences(result.response.text()))
}

// ── GET health check ────────────────────────────────────────────────────────
export async function GET() {
  return NextResponse.json({ status: "ok" })
}

// ── POST handler ────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { url?: string; text?: string; claim?: string }
    const { url, text, claim = "" } = body

    if (!url && !text) {
      return NextResponse.json({ error: "Provide a url or text to analyze" }, { status: 400 })
    }

    let articleData: ArticleData

    if (url) {
      // Fetch the URL with a 10s timeout
      let html: string
      try {
        const res = await fetchWithTimeout(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
          }
        }, 10000)
        if (!res.ok) {
          const hint = res.status === 403
            ? " The site may be blocking automated access — try pasting the article text directly."
            : res.status === 429
            ? " Rate limited — wait a moment and try again, or paste the article text directly."
            : " The page may be paywalled or unavailable."
          return NextResponse.json(
            { error: "Could not fetch the URL (HTTP " + res.status + ")." + hint },
            { status: 422 }
          )
        }
        const contentType = res.headers.get("content-type") || ""
        if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml")) {
          return NextResponse.json(
            { error: "URL does not return readable HTML content (got: " + contentType + ")." },
            { status: 422 }
          )
        }
        html = await res.text()
      } catch (fetchErr: unknown) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
        if (msg.includes("abort") || msg.includes("timeout")) {
          return NextResponse.json(
            { error: "URL fetch timed out after 10 seconds. Try pasting the article text directly." },
            { status: 422 }
          )
        }
        if (msg.includes("certificate") || msg.includes("SSL") || msg.includes("CERT") || msg.includes("self-signed")) {
          return NextResponse.json(
            { error: "HTTPS certificate error fetching the URL. Try pasting the article text directly." },
            { status: 422 }
          )
        }
        return NextResponse.json(
          { error: "Failed to fetch URL: " + msg },
          { status: 422 }
        )
      }

      articleData = parseArticleHtml(html, url)

      // If text is also provided, append it (helps with JS-heavy / paywalled pages)
      if (text) {
        articleData.text = (articleData.text + " " + text).slice(0, 6000)
      }
    } else {
      // text-only path
      articleData = {
        title: "",
        domain: "",
        author: "",
        date: "",
        ogImage: "",
        text: (text || "").slice(0, 6000),
      }
    }

    if (articleData.text.trim().length < 200) {
      return NextResponse.json(
        { error: "Could not extract enough readable text from the URL (got " + articleData.text.trim().length + " characters). The page is likely JavaScript-rendered or paywalled. Try pasting the article text directly." },
        { status: 422 }
      )
    }

    // Build GDELT search query from title + claim
    const searchQuery = [articleData.title, claim].filter(Boolean).join(" ").slice(0, 200)

    // Use title + claim only for conflict probe — article body text is too noisy for GDELT
    const conflictProbe = [articleData.title, claim].filter(Boolean).join(" ")

    // Stagger GDELT calls, fetch Wikipedia in parallel (no rate limit)
    const [webSearch, briefing, wikiBrief] = await Promise.all([
      runWebSearch(searchQuery),
      new Promise(r => setTimeout(r, 700)).then(() => runNewsBriefing(conflictProbe)),
      buildWikipediaBrief(conflictProbe),
    ]) as [Awaited<ReturnType<typeof runWebSearch>>, Awaited<ReturnType<typeof runNewsBriefing>>, string]

    // Run Gemini analysis
    const gemini = await runGeminiArticleAnalysis(articleData, claim, webSearch.summary, briefing.summary, wikiBrief)

    // Domain classification
    const domainClass = articleData.domain ? classifyDomain(articleData.domain) : "unknown"

    // Adjust scores based on domain classification
    let sourceScore: number = Math.round(gemini.source_credibility_score ?? 50)
    let contentScore: number = Math.round(gemini.content_credibility_score ?? 60)

    if (domainClass === "bad") {
      sourceScore = Math.min(sourceScore, 25)
    } else if (domainClass === "satire") {
      sourceScore = 10
    } else if (domainClass === "trusted") {
      sourceScore = Math.min(100, sourceScore + 15)
    }

    // Adjust content score based on web corroboration
    if (webSearch.factChecks > 0) {
      contentScore = Math.max(10, contentScore - 25)
    } else if (webSearch.trusted >= 3) {
      contentScore = Math.min(90, contentScore + 20)
    } else if (webSearch.trusted >= 1) {
      contentScore = Math.min(80, contentScore + 10)
    } else if (webSearch.fringeOnly) {
      contentScore = Math.max(20, contentScore - 10)
    }

    sourceScore = Math.max(0, Math.min(100, sourceScore))
    contentScore = Math.max(0, Math.min(100, contentScore))

    const overallScore = Math.round(sourceScore * 0.4 + contentScore * 0.6)

    // For trusted outlets, don't allow LIKELY FALSE unless a fact-check was actually found
    let derivedVerdict = gemini.verdict as VerificationResult["verdict"]
    if (domainClass === "trusted" && derivedVerdict === "LIKELY FALSE" && webSearch.factChecks === 0) {
      derivedVerdict = "NEEDS EXPERT REVIEW"
    }

    // Build flags
    const flags: Flag[] = [...(gemini.flags as Flag[])]

    // Satire domain flag
    if (domainClass === "satire") {
      flags.unshift({
        phase: "Source Analysis",
        severity: "high" as Severity,
        title: "Known satire publication",
        detail: articleData.domain + " is a known satire/parody outlet. Content is not intended as factual reporting."
      })
    }

    // Known bad domain flag
    if (domainClass === "bad") {
      flags.unshift({
        phase: "Source Analysis",
        severity: "critical" as Severity,
        title: "Known misinformation source",
        detail: articleData.domain + " is a known source of misinformation, pseudoscience, or fabricated content. Treat all claims with extreme skepticism."
      })
    }

    // Trusted domain flag
    if (domainClass === "trusted") {
      flags.push({
        phase: "Source Analysis",
        severity: "clean" as Severity,
        title: "Established trusted outlet",
        detail: articleData.domain + " is a recognized news organization with editorial standards."
      })
    }

    // Web corroboration flag
    if (webSearch.factChecks > 0) {
      flags.push({
        phase: "Fact-Check",
        severity: "high" as Severity,
        title: webSearch.factChecks + " fact-check(s) found for this topic",
        detail: webSearch.summary.slice(0, 400)
      })
    } else if (webSearch.trusted > 0) {
      flags.push({
        phase: "Web Corroboration",
        severity: "clean" as Severity,
        title: "Corroborated by " + webSearch.trusted + " trusted outlet(s)",
        detail: webSearch.summary.slice(0, 400)
      })
    } else if (webSearch.fringeOnly) {
      flags.push({
        phase: "Web Corroboration",
        severity: "moderate" as Severity,
        title: "Topic only in unverified sources",
        detail: "No coverage from established outlets. Claims appearing only in fringe sources warrant caution."
      })
    } else if (searchQuery) {
      flags.push({
        phase: "Web Corroboration",
        severity: "moderate" as Severity,
        title: "No corroboration found",
        detail: "GDELT found no matching coverage for this article/topic. The event may be too recent, too local, or unverified."
      })
    }

    // Emotional language flag
    if (gemini.emotional_language && gemini.emotional_language !== "None detected") {
      flags.push({
        phase: "Writing Style",
        severity: "moderate" as Severity,
        title: "Emotional / loaded language detected",
        detail: String(gemini.emotional_language)
      })
    }

    // Missing context flag
    if (gemini.missing_context && !String(gemini.missing_context).includes("No significant")) {
      flags.push({
        phase: "Content Analysis",
        severity: "info" as Severity,
        title: "Missing context",
        detail: String(gemini.missing_context)
      })
    }

    // Determine verdict color
    const verdictColor: "teal" | "amber" | "red" =
      overallScore >= 65 ? "teal" : overallScore >= 40 ? "amber" : "red"

    // Pipeline phases
    const writingStyle = String(gemini.writing_style || "unknown")
    const phases: VerificationResult["phases"] = [
      {
        name: "URL Fetch & Extraction",
        status: "pass",
        summary: url
          ? "Fetched " + articleData.domain + " — extracted " + articleData.text.length + " chars of content"
          : "Article text provided directly (" + articleData.text.length + " chars)"
      },
      {
        name: "Domain Credibility",
        status: domainClass === "bad" ? "fail" : domainClass === "satire" ? "fail" : domainClass === "trusted" ? "pass" : "info",
        summary: "Domain: " + (articleData.domain || "unknown") + " — classified as: " + domainClass.toUpperCase()
      },
      {
        name: "Source Analysis",
        status: sourceScore >= 65 ? "pass" : sourceScore >= 40 ? "warn" : "fail",
        summary: "Source credibility score: " + sourceScore + "/100"
      },
      {
        name: "Content Analysis",
        status: contentScore >= 65 ? "pass" : contentScore >= 40 ? "warn" : "fail",
        summary: "Content credibility score: " + contentScore + "/100. Writing style: " + writingStyle
      },
      {
        name: "Writing Style",
        status: writingStyle === "neutral" ? "pass" : writingStyle === "sensationalist" || writingStyle === "propaganda" ? "warn" : "info",
        summary: "Detected style: " + writingStyle + ". " + (gemini.emotional_language || "")
      },
      {
        name: "Web Corroboration (GDELT)",
        status: webSearch.trusted > 0 ? "pass" : webSearch.fringeOnly ? "warn" : "info",
        summary: webSearch.summary.slice(0, 200)
      },
      {
        name: "Key Claims",
        status: "info",
        summary: Array.isArray(gemini.key_claims) && gemini.key_claims.length > 0
          ? (gemini.key_claims as string[]).slice(0, 3).join(" | ")
          : "No key claims extracted"
      },
      {
        name: "Missing Context",
        status: gemini.missing_context && !String(gemini.missing_context).includes("No significant") ? "warn" : "pass",
        summary: String(gemini.missing_context || "No significant omissions identified")
      },
      {
        name: "Devil's Advocate",
        status: "info",
        summary: String(gemini.devils_advocate || "")
      }
    ]

    const articleExcerpt = articleData.text.slice(0, 300)

    const result: VerificationResult = {
      // Standard VerificationResult fields
      imageAuthenticityScore: sourceScore,
      claimAccuracyScore: contentScore,
      overallScore,
      score: overallScore,
      confidence: gemini.confidence as "HIGH" | "MEDIUM" | "LOW",
      verdict: derivedVerdict,
      verdictColor,
      flags,
      executiveSummary: String(gemini.executive_summary || ""),
      devilsAdvocate: String(gemini.devils_advocate || ""),
      metadata: null,
      elaFindings: "",
      phases,
      checkedAt: new Date().toISOString(),
      // Article-specific fields
      mode: "article",
      articleTitle: articleData.title,
      articleDomain: articleData.domain,
      articleDate: articleData.date,
      articleAuthor: articleData.author,
      articleExcerpt,
      sourceCredibilityScore: sourceScore,
      contentCredibilityScore: contentScore,
      keyClaims: Array.isArray(gemini.key_claims) ? (gemini.key_claims as string[]) : [],
      writingStyle,
    }

    return NextResponse.json(result)

  } catch (err) {
    console.error("Article analysis error:", err)
    return NextResponse.json({ error: "Analysis failed", detail: String(err) }, { status: 500 })
  }
}
