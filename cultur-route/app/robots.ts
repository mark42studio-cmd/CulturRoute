import { MetadataRoute } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://cultureroute.vercel.app';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*',                 allow: '/' },
      { userAgent: 'GPTBot',            allow: '/' },
      { userAgent: 'PerplexityBot',     allow: '/' },
      { userAgent: 'Google-InspectionTool', allow: '/' },
      { userAgent: 'Googlebot',         allow: '/' },
      { userAgent: 'anthropic-ai',      allow: '/' },
      { userAgent: 'ClaudeBot',         allow: '/' },
      { userAgent: 'Applebot',          allow: '/' },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
