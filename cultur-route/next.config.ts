import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      // ── 允許所有 HTTPS 外部圖片 ──────────────────────────────────
      // 爬蟲來源網域持續變動（縣府官網、售票平台、FB、活動管理系統…），
      // 無法逐一列舉，統一以雙星萬用字元開放 https，由前端的 isFbPageUrl
      // 守門員與 onError fallback 處理壞連結，不依賴白名單做安全邊界。
      { protocol: "https", hostname: "**" },

      // ── 保留 HTTP 僅限已知政府網域（部分縣府主機仍用 http）────────
      { protocol: "http", hostname: "**.gov.tw" },
      { protocol: "http", hostname: "culture.taitung.gov.tw" },
    ],

    dangerouslyAllowSVG: true,
    contentDispositionType: "attachment",
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
};

export default nextConfig;
