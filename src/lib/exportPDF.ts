import { jsPDF } from "jspdf"
import { VerificationResult } from "./types"

// ── Colour palette (light professional report) ────────────────────────────
const INK       = "#111827"
const BODY      = "#374151"
const MUTED     = "#6B7280"
const RULE      = "#E5E7EB"
const CARD      = "#F9FAFB"
const HEADER_BG = "#1A1F2E"
const TEAL      = "#0D9488"
const BLUE      = "#2563EB"
const AMBER     = "#D97706"
const RED       = "#DC2626"
const WHITE     = "#FFFFFF"

function sevColor(sev: string): string {
  if (sev === "critical") return RED
  if (sev === "high")     return AMBER
  if (sev === "moderate") return "#CA8A04"
  if (sev === "clean")    return TEAL
  return BLUE
}
function vcColor(vc: string): string {
  if (vc === "teal")  return TEAL
  if (vc === "amber") return AMBER
  return RED
}
function scoreColor(n: number): string {
  return n >= 65 ? TEAL : n >= 40 ? AMBER : RED
}
function phaseColor(s: string): string {
  if (s === "pass") return TEAL
  if (s === "warn") return AMBER
  if (s === "fail") return RED
  return BLUE
}

// Strip markdown links [label](url) and bare URLs for PDF
function stripLinks(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
}

function sanitize(text: string): string {
  if (!text) return ""
  return text
    .replace(/[\u0590-\u05FF\uFB1D-\uFB4F]+/g, "[Hebrew script]")
    .replace(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]+/g, "[Arabic script]")
    .replace(/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]+/g, "[CJK script]")
    .replace(/[^\x00-\xFF]/g, "?")
}

export async function exportToPDF(
  result: VerificationResult,
  imageDataUrl: string | null,
  claim: string
): Promise<void> {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" })
  const PW = 210
  const PH = 297
  const ML = 18
  const MR = 18
  const CW = PW - ML - MR
  let y = 0

  const isArticle = result.mode === "article"

  function newPage() {
    doc.addPage()
    y = 20
    doc.setDrawColor(RULE)
    doc.setLineWidth(0.3)
    doc.line(ML, 15, PW - MR, 15)
  }

  function checkPage(needed: number) {
    if (y + needed > PH - 20) newPage()
  }

  function hRule(yy: number, color = RULE) {
    doc.setDrawColor(color)
    doc.setLineWidth(0.3)
    doc.line(ML, yy, PW - MR, yy)
  }

  function fillRect(x: number, yy: number, w: number, h: number, color: string) {
    doc.setFillColor(color)
    doc.rect(x, yy, w, h, "F")
  }

  function strokeRect(x: number, yy: number, w: number, h: number, color: string, lw = 0.3) {
    doc.setDrawColor(color)
    doc.setLineWidth(lw)
    doc.rect(x, yy, w, h, "S")
  }

  function sectionHeader(title: string, color = BLUE) {
    checkPage(14)
    fillRect(ML, y, 3, 6, color)
    doc.setFontSize(8)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(INK)
    doc.text(title.toUpperCase(), ML + 6, y + 4.4)
    y += 8
    hRule(y)
    y += 5
  }

  function kvRow(label: string, value: string, even: boolean) {
    const rowH = 7
    if (even) fillRect(ML, y, CW, rowH, CARD)
    doc.setFontSize(7.5)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(MUTED)
    doc.text(label.toUpperCase(), ML + 3, y + 4.8)
    doc.setFont("helvetica", "normal")
    doc.setTextColor(BODY)
    doc.text(sanitize(String(value)).slice(0, 90), ML + 48, y + 4.8)
    y += rowH
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COVER BLOCK
  // ══════════════════════════════════════════════════════════════════════════
  fillRect(0, 0, PW, 52, HEADER_BG)
  fillRect(0, 49, PW, 3, vcColor(result.verdictColor))

  fillRect(ML, 10, 10, 10, BLUE)
  doc.setFontSize(7)
  doc.setFont("helvetica", "bold")
  doc.setTextColor(WHITE)
  doc.text("VI", ML + 2.2, 16.4)

  doc.setFontSize(20)
  doc.setFont("helvetica", "bold")
  doc.setTextColor(WHITE)
  doc.text("VERIFAI", ML + 13, 17)

  doc.setFontSize(7.5)
  doc.setFont("helvetica", "normal")
  doc.setTextColor(TEAL)
  doc.text("OSINT VERIFICATION REPORT", ML + 13, 23)

  doc.setFontSize(7)
  doc.setTextColor("#9CA3AF")
  doc.text("Generated: " + new Date(result.checkedAt).toLocaleString(), ML + 13, 30)
  doc.text("For research and journalistic use only · Not for operational decisions", ML + 13, 36)

  y = 62

  // ══════════════════════════════════════════════════════════════════════════
  // VERDICT ROW (full width) + 3 SCORE BOXES
  // ══════════════════════════════════════════════════════════════════════════
  const vc = vcColor(result.verdictColor)

  // Row 1: Verdict full width
  const verdictH = 20
  fillRect(ML, y, CW, verdictH, CARD)
  strokeRect(ML, y, CW, verdictH, RULE)
  fillRect(ML, y, CW, 2, vc)

  doc.setFontSize(15)
  doc.setFont("helvetica", "bold")
  doc.setTextColor(vc)
  doc.text(result.verdict, ML + 5, y + 12)

  doc.setFontSize(7.5)
  doc.setFont("helvetica", "normal")
  doc.setTextColor(MUTED)
  doc.text(result.confidence + " CONFIDENCE", ML + 5, y + 17.5)

  // Writing style badge (article mode)
  if (isArticle && result.writingStyle) {
    const wsLabel = "STYLE: " + result.writingStyle.toUpperCase()
    doc.setFontSize(7)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(BODY)
    const wsW = doc.getTextWidth(wsLabel)
    doc.text(wsLabel, PW - MR - wsW - 3, y + 12)
  }

  y += verdictH + 4

  // Row 2: 3 score boxes
  const scoreBoxW = Math.floor((CW - 8) / 3)
  const boxH = 26

  function scoreBox(label: string, score: number, xOff: number) {
    const bx = ML + xOff
    fillRect(bx, y, scoreBoxW, boxH, CARD)
    strokeRect(bx, y, scoreBoxW, boxH, RULE)
    const sc = scoreColor(score)
    fillRect(bx, y, scoreBoxW, 2, sc)
    doc.setFontSize(6)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(MUTED)
    doc.text(label, bx + 4, y + 9)
    doc.setFontSize(19)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(sc)
    doc.text(String(score), bx + 4, y + 21)
    doc.setFontSize(7)
    doc.setFont("helvetica", "normal")
    doc.setTextColor(MUTED)
    doc.text("/ 100", bx + 4, y + 25)
  }

  const scoreLabel1 = isArticle ? "SOURCE CRED." : "IMAGE AUTH."
  const scoreLabel2 = isArticle ? "CONTENT CRED." : "CLAIM ACCURATE"

  scoreBox("OVERALL", result.overallScore ?? result.score, 0)
  scoreBox(scoreLabel1, result.imageAuthenticityScore ?? result.score, scoreBoxW + 4)
  scoreBox(scoreLabel2, result.claimAccuracyScore ?? result.score, (scoreBoxW + 4) * 2)

  y += boxH + 10

  // ══════════════════════════════════════════════════════════════════════════
  // ARTICLE INFO (article mode only)
  // ══════════════════════════════════════════════════════════════════════════
  if (isArticle && (result.articleTitle || result.articleDomain)) {
    checkPage(30)
    sectionHeader("Article Info", BLUE)

    const infoEntries: [string, string][] = []
    if (result.articleTitle)  infoEntries.push(["Title",  result.articleTitle])
    if (result.articleDomain) infoEntries.push(["Domain", result.articleDomain])
    if (result.articleAuthor) infoEntries.push(["Author", result.articleAuthor])
    if (result.articleDate)   infoEntries.push(["Date",   result.articleDate])

    infoEntries.forEach(([k, v], i) => {
      checkPage(8)
      kvRow(k, v, i % 2 === 0)
    })
    y += 8
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUBMITTED CLAIM
  // ══════════════════════════════════════════════════════════════════════════
  if (claim) {
    checkPage(24)
    sectionHeader("Submitted Claim")
    fillRect(ML, y, CW, 1, BLUE)
    y += 4
    const claimLines = doc.splitTextToSize(sanitize('"' + claim + '"'), CW - 8)
    doc.setFontSize(9.5)
    doc.setFont("helvetica", "italic")
    doc.setTextColor(INK)
    doc.text(claimLines, ML + 4, y)
    y += claimLines.length * 5.5 + 10
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUBMITTED IMAGE (image mode only)
  // ══════════════════════════════════════════════════════════════════════════
  if (!isArticle && imageDataUrl) {
    const imgDims = await new Promise<{ w: number; h: number }>(resolve => {
      const img = new Image()
      img.onload = () => resolve({ w: img.naturalWidth || img.width || 4, h: img.naturalHeight || img.height || 3 })
      img.onerror = () => resolve({ w: 4, h: 3 })
      img.src = imageDataUrl
      if (img.complete && (img.naturalWidth || img.width)) {
        resolve({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height })
      }
    })

    const maxW = CW
    const maxH = 110
    const ratio = imgDims.w / Math.max(imgDims.h, 1)
    let imgW: number, imgH: number
    if (ratio > maxW / maxH) {
      imgW = maxW; imgH = maxW / ratio
    } else {
      imgH = maxH; imgW = maxH * ratio
    }
    imgW = Math.round(imgW)
    imgH = Math.round(imgH)
    const imgX = ML + (CW - imgW) / 2

    checkPage(imgH + 20)
    sectionHeader("Submitted Image")
    try {
      doc.addImage(imageDataUrl, "JPEG", imgX, y, imgW, imgH, undefined, "MEDIUM")
      strokeRect(imgX, y, imgW, imgH, RULE)
      y += imgH + 10
    } catch {
      doc.setFontSize(8)
      doc.setTextColor(MUTED)
      doc.text("[Image could not be embedded]", ML, y + 5)
      y += 12
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTIVE SUMMARY
  // ══════════════════════════════════════════════════════════════════════════
  doc.setFontSize(9)
  doc.setFont("helvetica", "normal")
  const summaryLines = doc.splitTextToSize(sanitize(result.executiveSummary || ""), CW - 22)
  const summaryH = summaryLines.length * 5.8 + 18
  checkPage(summaryH + 16)
  sectionHeader("Executive Summary", TEAL)

  fillRect(ML, y, CW, summaryH, CARD)
  strokeRect(ML, y, CW, summaryH, RULE)
  fillRect(ML, y, 3, summaryH, TEAL)

  doc.setFontSize(9)
  doc.setFont("helvetica", "normal")
  doc.setTextColor(BODY)
  doc.text(summaryLines, ML + 8, y + 8)
  y += summaryH + 10

  // ══════════════════════════════════════════════════════════════════════════
  // KEY CLAIMS (article mode only)
  // ══════════════════════════════════════════════════════════════════════════
  if (isArticle && result.keyClaims && result.keyClaims.length > 0) {
    checkPage(20)
    sectionHeader("Key Claims", BLUE)

    for (let i = 0; i < result.keyClaims.length; i++) {
      const kc = result.keyClaims[i]
      doc.setFontSize(7.5)
      doc.setFont("helvetica", "normal")
      const kcLines = doc.splitTextToSize(sanitize(kc), CW - 14)
      const kcH = kcLines.length * 4.8 + 6
      checkPage(kcH + 2)
      if (i % 2 === 0) fillRect(ML, y, CW, kcH, CARD)
      doc.setFontSize(8)
      doc.setFont("helvetica", "bold")
      doc.setTextColor(BLUE)
      doc.text("•", ML + 3, y + kcH / 2 + 1.5)
      doc.setFontSize(7.5)
      doc.setFont("helvetica", "normal")
      doc.setTextColor(BODY)
      doc.text(kcLines, ML + 8, y + 5)
      y += kcH
    }
    y += 8
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FINDINGS / FLAGS
  // ══════════════════════════════════════════════════════════════════════════
  sectionHeader("Findings (" + result.flags.length + " checks)")

  for (const flag of result.flags) {
    const sc = sevColor(flag.severity)
    const pdfDetail = stripLinks(flag.detail)
    const hadLinks = flag.detail.includes("http")

    const detailText = sanitize(pdfDetail + (hadLinks ? " [see web app for links]" : ""))
    doc.setFontSize(7.5)
    doc.setFont("helvetica", "normal")
    const detailLines = doc.splitTextToSize(detailText, CW - 22)
    const cardH = 9 + detailLines.length * 4.8 + 5
    checkPage(cardH + 3)

    fillRect(ML, y, CW, cardH, "#FFFFFF")
    strokeRect(ML, y, CW, cardH, RULE)
    fillRect(ML, y, 3, cardH, sc)

    doc.setFontSize(6)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(sc)
    doc.text(flag.severity.toUpperCase(), ML + 7, y + 5.5)

    doc.setFont("helvetica", "normal")
    doc.setTextColor(MUTED)
    const sevW = doc.getTextWidth(flag.severity.toUpperCase())
    doc.text("·  " + flag.phase, ML + 7 + sevW + 2, y + 5.5)

    doc.setFontSize(8.5)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(INK)
    doc.text(sanitize(flag.title), ML + 7, y + 11)

    doc.setFontSize(7.5)
    doc.setFont("helvetica", "normal")
    doc.setTextColor(BODY)
    doc.text(detailLines, ML + 7, y + 16.5)

    y += cardH + 3
  }

  y += 6

  // ══════════════════════════════════════════════════════════════════════════
  // DEVIL'S ADVOCATE
  // ══════════════════════════════════════════════════════════════════════════
  doc.setFontSize(8.5)
  doc.setFont("helvetica", "italic")
  const daLines = doc.splitTextToSize(sanitize(result.devilsAdvocate || ""), CW - 22)
  const daH = daLines.length * 5.8 + 18
  checkPage(daH + 16)
  sectionHeader("Devil's Advocate", AMBER)

  fillRect(ML, y, CW, daH, "#FFFBEB")
  strokeRect(ML, y, CW, daH, "#FDE68A")
  fillRect(ML, y, 3, daH, AMBER)

  doc.setFontSize(8.5)
  doc.setFont("helvetica", "italic")
  doc.setTextColor(BODY)
  doc.text(daLines, ML + 8, y + 8)
  y += daH + 10

  // ══════════════════════════════════════════════════════════════════════════
  // VERIFICATION PIPELINE
  // ══════════════════════════════════════════════════════════════════════════
  checkPage(20)
  sectionHeader("Verification Pipeline")

  for (let i = 0; i < result.phases.length; i++) {
    const ph = result.phases[i]
    const pc = phaseColor(ph.status)
    doc.setFontSize(7)
    doc.setFont("helvetica", "normal")
    const summLines = doc.splitTextToSize(sanitize(stripLinks(ph.summary || "")), CW - 38)
    const rowH = Math.max(10, summLines.length * 4.5 + 8)
    checkPage(rowH + 2)

    if (i % 2 === 0) fillRect(ML, y, CW, rowH, CARD)
    hRule(y + rowH, RULE)

    doc.setFontSize(6)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(pc)
    doc.text(ph.status.toUpperCase(), ML + 3, y + rowH / 2 + 2)

    doc.setDrawColor(RULE)
    doc.setLineWidth(0.3)
    doc.line(ML + 16, y + 2, ML + 16, y + rowH - 2)

    doc.setFontSize(8)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(INK)
    doc.text(ph.name, ML + 19, y + 6)

    doc.setFontSize(7)
    doc.setFont("helvetica", "normal")
    doc.setTextColor(MUTED)
    doc.text(summLines, ML + 19, y + 11)

    y += rowH
  }

  y += 8

  // ══════════════════════════════════════════════════════════════════════════
  // EXIF METADATA (image mode only)
  // ══════════════════════════════════════════════════════════════════════════
  if (!isArticle && result.metadata && Object.values(result.metadata).some(Boolean)) {
    checkPage(24)
    sectionHeader("Image Metadata (EXIF)")
    const entries = Object.entries(result.metadata).filter(([, v]) => v)
    entries.forEach(([k, v], i) => {
      checkPage(8)
      kvRow(k, String(v), i % 2 === 0)
    })
    y += 8
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FOOTER on every page
  // ══════════════════════════════════════════════════════════════════════════
  const pageCount = (doc as jsPDF & { internal: { getNumberOfPages: () => number } })
    .internal.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    hRule(PH - 12, RULE)
    doc.setFontSize(6.5)
    doc.setFont("helvetica", "normal")
    doc.setTextColor(MUTED)
    doc.text("VERIFAI · OSINT Verification Engine · For research and journalistic use · Not for operational decisions", ML, PH - 7)
    doc.text("Page " + i + " / " + pageCount, PW - MR - 14, PH - 7)
  }

  const filename = "verifai-report-" + new Date().toISOString().slice(0, 10) + ".pdf"
  doc.save(filename)
}
