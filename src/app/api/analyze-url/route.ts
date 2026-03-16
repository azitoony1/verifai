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

// ── RSS parser + Google News RSS ───────────────────────────────────────────
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

interface SearchItem { title: string; snippet: string; url: string; source: string; intent: "confirm" | "deny" }

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
      "You are a corroboration analyst. Determine whether these search results support, contradict, contest, or are inconclusive about the claim.",
      "",
      `Claim: "${claim}"`,
      "",
      confirmItems.length ? "CONFIRM QUERY RESULTS (queries: " + queries.confirm.join("; ") + "):\n" + fmt(confirmItems) : "",
      denyItems.length   ? "DENY QUERY RESULTS (queries: " + queries.deny.join("; ") + "):\n" + fmt(denyItems) : "",
      "",
      "STRICT RELEVANCE RULES:",
      "1. An article is ONLY relevant if it describes the SAME specific event: same approximate time, same location, same actors.",
      "2. NOT relevant: Wikipedia background articles, general regional news, articles about different incidents, historical context.",
      "3. If unsure whether an article is about the same event, mark it NOT relevant.",
      "4. Default to 'inconclusive' unless you find at least one article clearly about this specific event.",
      "5. verdict: 'supported'=1+ articles confirm; 'contradicted'=articles deny; 'contested'=conflict; 'inconclusive'=nothing directly relevant.",
      "6. If inconclusive, say so plainly in the summary — do not invent connections.",
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

// ── News briefing (Google News RSS — conflict topics only) ─────────────────
async function runNewsBriefing(query: string): Promise<{ summary: string; skipped: boolean }> {
  if (!query.trim() || !isConflictContent(query)) return { summary: "", skipped: true }
  try {
    const items = await runGoogleNewsRSS(query.slice(0, 100))
    if (!items.length) return { summary: "", skipped: true }
    const lines = items.slice(0, 6).map(a => "[recent] " + a.title + " — " + a.source)
    const summary = [
      "=== CURRENT NEWS CONTEXT (Google News) ===",
      "The following are recent news headlines retrieved " + TODAY + ". Use as contextual background.",
      "",
      lines.join(NL),
      "=== END NEWS CONTEXT ==="
    ].join(NL)
    return { summary, skipped: false }
  } catch { return { summary: "", skipped: true } }
}

// ── Wikipedia query tightener ──────────────────────────────────────────────
function tightenWikiQuery(claim: string): string {
  const text = claim.slice(0, 150)
  const entityRx = /\b(Iran|Iraq|Israel|Palestine|Gaza|West Bank|Ukraine|Russia|Syria|Lebanon|Yemen|Sudan|Afghanistan|Pakistan|China|Taiwan|Kosovo|Libya|Somalia|Ethiopia|Myanmar|NATO|Hamas|Hezbollah|IDF|ISIS|ISIL|Houthi|Wagner|Taliban|Zelensky|Netanyahu|Putin|Khamenei|Kyiv|Kharkiv|Mariupol|Bakhmut|Rafah|Mosul|Raqqa|Aleppo|Kabul|Kherson)\b/gi
  const matches = Array.from(new Set((text.match(entityRx) || []).map(m => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase())))
  if (!matches.length) return text
  return matches.slice(0, 2).map(m => "+" + m).join(" ") + " " + text
}


// ── Gemini article analysis ─────────────────────────────────────────────────
async function runGeminiArticleAnalysis(
  articleData: ArticleData,
  claim: string,
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
    "4. A recent event (days or weeks old) with no web corroboration may simply be too new to be indexed — not fabricated.",
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
    '  "missing_context": "<important context absent from the article, or: No significant omissions identified>",',
    '  "search_queries": {"confirm": ["<specific query 1 to find corroborating news>", "<specific query 2>"], "deny": ["<challenge query — only if specific claims seem uncertain or unverifiable>"]}',
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

    const conflictProbe = [articleData.title, claim].filter(Boolean).join(" ")

    // ── Phase 1: parallel pre-fetch (independent of Gemini) ──────────────
    const [briefing, wikiBrief] = await Promise.all([
      runNewsBriefing(conflictProbe),
      buildWikipediaBrief(conflictProbe),
    ])

    // ── Phase 2: Gemini article analysis (also generates search queries) ──
    const gemini = await runGeminiArticleAnalysis(articleData, claim, briefing.summary, wikiBrief)

    // ── Phase 3: smart web search using Gemini's queries ──────────────────
    const rawQueries = (gemini.search_queries as { confirm?: string[]; deny?: string[] } | undefined) || {}
    const searchQueries = { confirm: rawQueries.confirm?.slice(0, 2) || [], deny: rawQueries.deny?.slice(0, 1) || [] }
    const rawSearchResults = searchQueries.confirm.length
      ? await runSmartWebSearch(searchQueries)
      : { confirmItems: [] as SearchItem[], denyItems: [] as SearchItem[] }

    // ── Phase 4: corroboration synthesis ─────────────────────────────────
    const webSearch = await runCorroborationSynthesis(
      conflictProbe.slice(0, 200), searchQueries,
      rawSearchResults.confirmItems, rawSearchResults.denyItems
    )

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
      flags.push({ phase: "Fact-Check", severity: "high" as Severity, title: webSearch.factChecks + " fact-check(s) found for this topic", detail: webSearch.summary.slice(0, 400) })
    } else if (webSearch.corroborationVerdict === "contradicted") {
      flags.push({ phase: "Web Corroboration", severity: "high" as Severity, title: "Article claims contradicted by search results", detail: webSearch.summary.slice(0, 400) })
    } else if (webSearch.corroborationVerdict === "contested") {
      flags.push({ phase: "Web Corroboration", severity: "moderate" as Severity, title: "Article claims contested — mixed results found", detail: webSearch.summary.slice(0, 400) })
    } else if (webSearch.trusted > 0) {
      flags.push({ phase: "Web Corroboration", severity: "clean" as Severity, title: "Corroborated by " + webSearch.trusted + " trusted source(s)", detail: webSearch.summary.slice(0, 400) })
    } else if (webSearch.fringeOnly) {
      flags.push({ phase: "Web Corroboration", severity: "moderate" as Severity, title: "Topic only in unverified sources", detail: "No coverage from established outlets. Claims appearing only in fringe sources warrant caution." })
    } else {
      flags.push({ phase: "Web Corroboration", severity: "moderate" as Severity, title: "No corroboration found", detail: "No directly relevant results found on Wikipedia or Google News. The event may be too recent, too local, or unverified." })
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
        name: "Web Corroboration",
        status: (webSearch.corroborationVerdict === "contradicted" || webSearch.corroborationVerdict === "contested") ? "warn" : webSearch.trusted > 0 ? "pass" : webSearch.fringeOnly ? "warn" : "info",
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
