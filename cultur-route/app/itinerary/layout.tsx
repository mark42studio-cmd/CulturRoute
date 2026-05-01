import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '行程規劃',
  description: '使用 CultureRoute 規劃你的台東藝文行程。支援多日行程拖拉排序、地圖可視化，一站式串聯台東山線、海線與市區藝文場域，打造專屬太平洋藝術廊道路線。',
  keywords: ['台東行程規劃', '台東藝文行程', '台東多日遊', '台東 AI 行程', '太平洋藝術廊道', '台東隱藏景點'],
  openGraph: {
    title: '台東藝文行程規劃｜CultureRoute',
    description: '多日行程拖拉排序、互動地圖可視化，打造你的專屬台東文化路徑。',
    type: 'website',
  },
};

export default function ItineraryLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
