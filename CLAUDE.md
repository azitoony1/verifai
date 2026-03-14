# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start dev server at http://localhost:3000
npm run build      # Production build (includes TypeScript type checking)
npm start          # Run production server
npx tsc --noEmit   # Type-check without emitting files
```

No test framework or linter is configured. TypeScript strict mode is the primary safety net.

## Environment

Copy `.env.example` to `.env.local` and set:
- `GEMINI_API_KEY` — **required** (get from aistudio.google.com)
- `GOOGLE_VISION_API_KEY` — optional, enables reverse image search
- `BRAVE_SEARCH_API_KEY` — optional, currently unused (GDELT is used instead)

## Architecture

VerifAI is a Next.js App Router application with two API routes that each run a multi-phase analysis pipeline:

### Two Modes

**Image Mode** (`/api/analyze`) — 8-phase pipeline:
1. Live news briefing via GDELT (triggered by conflict keywords)
2. Fact-check pre-check via GDELT (Snopes, FullFact, PolitiFact, etc.)
3. Gemini Vision analysis (dual scoring: image authenticity + claim accuracy)
4. Deep military analysis via Gemini (conditional — triggered if military equipment detected)
5. Equipment database lookup via GDELT (Oryx, ArmyRecognition, GlobalSecurity)
6. Reverse image search via Google Vision API (optional)
7. Web corroboration via GDELT
8. Weather verification via Open-Meteo (requires GPS + date in EXIF)

**Article Mode** (`/api/analyze-url`) — 6-phase pipeline:
1. HTML fetch + parse (strips nav/scripts/footer, truncates to 6,000 chars)
2. Domain classification (trusted/satire/bad/unknown lists)
3. Gemini article analysis (source credibility + content credibility scores)
4. Web corroboration via GDELT
5. Score adjustment based on domain + corroboration
6. Phase reporting

### Scoring System

All results produce a `VerificationResult` (see `src/lib/types.ts`):
- `imageAuthenticityScore` (0–100): Real/unmanipulated vs AI-generated
- `claimAccuracyScore` (0–100): Visual claim support (images) or content credibility (articles)
- `overallScore`: 40% image/source + 60% claim/content
- `verdict`: VERIFIED / LIKELY AUTHENTIC / UNVERIFIABLE / LIKELY FALSE / NEEDS EXPERT REVIEW

Score adjustments are applied after Gemini: fact-checks found (−25), 3+ trusted sources (+22), fringe-only sources (−12), trusted domain (+15), known bad domain (cap at 25).

### Key Design Decisions

- **Stateless**: No database. Every request is fresh. Images are not stored.
- **Free-tier first**: GDELT (unlimited, no key) + Gemini (1,500 req/day free) are the core.
- **Timeout budgets**: Each external call is capped (GDELT/Vision/Gemini: 6–8s, URL fetch: 10s, weather: 5s). Vercel function timeout is 30s (`vercel.json`).
- **Graceful degradation**: Google Vision and weather phases are skipped if no key / no EXIF GPS.
- **Client-side EXIF**: `exifr` runs in the browser before upload; `next.config.js` also marks it as a server external package.
- **PDF export is fully client-side**: `src/lib/exportPDF.ts` uses jsPDF, no server round-trip.

### File Map

```
src/app/api/analyze/route.ts       Image analysis pipeline
src/app/api/analyze-url/route.ts   Article analysis pipeline
src/app/api/health/route.ts        Health check
src/app/page.tsx                   Main UI (single page, all components inline)
src/app/globals.css                Tailwind + custom scan/pulse/fade-up animations
src/lib/types.ts                   Shared TypeScript interfaces
src/lib/exportPDF.ts               jsPDF report generator
```

### UI Component Structure (all in `page.tsx`)

- `UploadZone` — drag-drop image input
- `ScoreRing` — SVG circular score visualization
- `FlagCard` — severity-tagged finding cards (critical/high/moderate/clean/info)
- `PhaseBadge` — collapsible pipeline phase summaries
- `LinkedText` — renders Markdown links in result text

### Tailwind Theme

Dark OSINT aesthetic defined in `tailwind.config.js`. Key tokens:
- Backgrounds: `ink` (#0A0E14), `panel` (#0F1923), `card` (#141F2E)
- Accents: `accent` (#1E90FF), `teal` (#00C8A0), `amber` (#F5A623), `red` (#E84057)
