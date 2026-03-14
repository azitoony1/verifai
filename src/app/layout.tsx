import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "VerifAI — OSINT Verification Engine",
  description: "Multi-layer forensic fact-checking for images and claims",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
