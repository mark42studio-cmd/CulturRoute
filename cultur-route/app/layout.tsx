import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Serif_TC } from "next/font/google";
import Image from "next/image";
import "./globals.css";
import ItinerarySidebar from '@/components/ItinerarySidebar';

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

export const metadata: Metadata = {
  title: {
    default: "CulturRoute 臺東藝文｜探索此時此地的文化路徑",
    template: "%s｜CulturRoute 臺東藝文",
  },
  description: "聚合台東在地藝文、節慶與展覽，為你策展專屬的台東文化路徑。",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon.png",
    apple: "/apple-icon.png",
  },
  themeColor: "#1e3a5f",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "CulturRoute",
  },
  openGraph: {
    title: "CulturRoute 臺東藝文｜探索此時此地的文化路徑",
    description: "聚合台東在地藝文、節慶與展覽，為你策展專屬的台東文化路徑。",
    locale: "zh_TW",
    type: "website",
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
        
        {/* 🌟 把側邊欄元件放在這裡，children 的上面 */}
        <ItinerarySidebar /> 
        
        {children}

        <footer className="mt-auto py-6 flex flex-col items-center gap-2 text-xs text-gray-500">
          <Image src="/logo.png" alt="一圈工作室" width={32} height={32} className="opacity-70" />
          一圈工作室 mark42studio@gmail.com
        </footer>
      </body>
    </html>
  );
}
