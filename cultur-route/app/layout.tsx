import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Serif_TC } from "next/font/google";
import Image from "next/image";
import "./globals.css";
import ItinerarySidebar from '@/components/ItinerarySidebar';
import TourGuide from '@/components/TourGuide';
import { GoogleAnalytics } from '@next/third-parties/google';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const notoSerifTC = Noto_Serif_TC({
  variable: "--font-noto-serif-tc",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://cultureroute.vercel.app';

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "name": "CultureRoute 臺東藝文導覽系統",
      "applicationCategory": ["TravelApplication", "GuideApplication"],
      "operatingSystem": "Web, iOS",
      "description": "專為臺東設計的 AI 藝文行程導覽平台，提供山線、海線及市區的一站式行程規劃。聚合台東在地藝文活動、節慶展覽與隱藏景點，探索太平洋藝術廊道。",
      "url": SITE_URL,
      "inLanguage": "zh-TW",
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "TWD" },
      "featureList": ["台東藝文活動聚合", "多日行程規劃", "互動地圖視覺化", "AI 資料清洗"],
      "author": {
        "@type": "Organization",
        "name": "一圈工作室 One Circle Studio",
        "email": "mark42studio@gmail.com",
      },
    },
    {
      "@type": "WebSite",
      "name": "CultureRoute 臺東藝文",
      "url": SITE_URL,
      "description": "台東藝文行程 AI 規劃平台，探索此時此地的文化路徑。",
      "inLanguage": "zh-TW",
      "publisher": {
        "@type": "Organization",
        "name": "一圈工作室 One Circle Studio",
      },
    },
  ],
};

export const metadata: Metadata = {
  title: {
    default: "CultureRoute 臺東藝文｜探索此時此地的文化路徑",
    template: "%s｜CultureRoute 臺東藝文",
  },
  description: "台東藝文行程 AI 規劃平台。聚合台東在地藝文活動、台東隱藏景點與太平洋藝術廊道路線，一站式台東 AI 行程規劃，探索山線、海線與市區文化節點。",
  keywords: ["台東藝文行程", "台東 AI 規劃", "台東隱藏景點", "太平洋藝術廊道", "台東旅遊", "臺東文化活動", "台東行程規劃", "台東展覽"],
  manifest: "/manifest.json",
  metadataBase: new URL(SITE_URL),
  icons: {
    icon: "/icon.png",
    apple: "/apple-icon.png",
  },
  themeColor: "#1e3a5f",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "CultureRoute",
  },
  openGraph: {
    title: "CultureRoute 臺東藝文｜探索此時此地的文化路徑",
    description: "台東藝文行程 AI 規劃平台。聚合藝文活動、隱藏景點與太平洋藝術廊道路線。",
    locale: "zh_TW",
    type: "website",
    siteName: "CultureRoute 臺東藝文",
    url: SITE_URL,
  },
  twitter: {
    card: "summary_large_image",
    title: "CultureRoute 臺東藝文",
    description: "台東藝文行程 AI 規劃平台，探索此時此地的文化路徑。",
  },
  other: {
    "agd-partner-manual-verification": "",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-TW" className={`${geistSans.variable} ${geistMono.variable} ${notoSerifTC.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <GoogleAnalytics gaId="G-09SQ3LJ9GM" />

        {/* 🌟 把側邊欄元件放在這裡，children 的上面 */}
        <ItinerarySidebar />
        <TourGuide />

        {children}

        <footer className="mt-auto py-6 flex items-center justify-center gap-2 text-xs text-gray-500">
          <Image src="/icon.png" alt="一圈工作室" width={24} height={24} className="opacity-70" />
          一圈工作室 | mark42studio@gmail.com
        </footer>
      </body>
    </html>
  );
}
