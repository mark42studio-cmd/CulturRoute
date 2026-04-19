import type { NextConfig } from "next";

/**
 * 台東藝文圖片來源白名單
 * 新增來源請在對應分區追加，並在後面標注來源說明。
 */
const nextConfig: NextConfig = {
  images: {
    remotePatterns: [

      // ── 文化部 & 官方展演平台 ──────────────────────────────────────
      { protocol: "https", hostname: "event.culture.tw" },       // 文化部活動報名平台
      { protocol: "https", hostname: "culture.taitung.gov.tw" }, // 台東縣文化處
      { protocol: "http",  hostname: "culture.taitung.gov.tw" },

      // ── 台東政府機構 ──────────────────────────────────────────────
      { protocol: "https", hostname: "**.gov.tw" },   // 台東縣各鄉鎮公所、博物館（雙星萬用字元，覆蓋所有子域名）
      { protocol: "http",  hostname: "**.gov.tw" },

      // ── 史前博 / 美學館（圖片路徑多在根域名）────────────────────────
      { protocol: "https", hostname: "www.nmp.gov.tw" },
      { protocol: "https", hostname: "www.ttcsec.gov.tw" },
      { protocol: "https", hostname: "www.taitungcity.gov.tw" },
      { protocol: "https", hostname: "www.taimali.gov.tw" },
      { protocol: "https", hostname: "www.cs.gov.tw" },
      { protocol: "https", hostname: "www.donghe.gov.tw" },
      { protocol: "https", hostname: "www.eastcoast-nsa.gov.tw" },
      { protocol: "https", hostname: "www.beinan.gov.tw" },
      { protocol: "https", hostname: "www.chenggong.gov.tw" },

      // ── Meta (Facebook / Instagram) CDN ──────────────────────────
      { protocol: "https", hostname: "www.facebook.com" },   // FB 相簿頁（後端可能保留此連結）
      { protocol: "https", hostname: "**.fbcdn.net" },       // Facebook 靜態圖片（含多層子域名）
      { protocol: "https", hostname: "lookaside.fbsbx.com" },// FB 外部圖片代理
      { protocol: "https", hostname: "**.cdninstagram.com" },// Instagram CDN

      // ── Google ────────────────────────────────────────────────────
      { protocol: "https", hostname: "places.googleapis.com" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      { protocol: "https", hostname: "storage.googleapis.com" },
      { protocol: "https", hostname: "maps.googleapis.com" },

      // ── 通用圖床 ─────────────────────────────────────────────────
      { protocol: "https", hostname: "i.imgur.com" },
      { protocol: "https", hostname: "imgur.com" },

      // ── 台東在地獨立空間常用圖片託管 ─────────────────────────────
      // （FB粉專圖片已由 fbcdn.net 涵蓋，這裡補充常見 Linktree / 個人網站）
      { protocol: "https", hostname: "images.squarespace-cdn.com" },
      { protocol: "https", hostname: "static.wixstatic.com" },
      { protocol: "https", hostname: "**.notion.so" },
    ],

    // 允許未最佳化圖片作為 fallback（避免動態來源爆 500）
    dangerouslyAllowSVG: true,
    contentDispositionType: "attachment",
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
};

export default nextConfig;
