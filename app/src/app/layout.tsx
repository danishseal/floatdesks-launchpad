import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { Providers } from "@/components/providers";
import { PixelFrame } from "@/components/layout/pixel-frame";
import "./globals.css";

// Single typeface across the app: body, display and numerics all Geist.
const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

const SITE_TITLE = "ANSEM";
const SITE_DESCRIPTION =
  "Launch and trade tokens on the ANSEM bonding curve. Attach Horns, split fees, stake the Horn Vault. On-chain, no presale.";

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  icons: {
    icon: "/logo.png",
    shortcut: "/logo.png",
    apple: "/logo.png",
  },
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [],
  },
  twitter: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={geist.variable}>
      <body className="antialiased">
        <Providers>
          <PixelFrame>{children}</PixelFrame>
        </Providers>
      </body>
    </html>
  );
}
