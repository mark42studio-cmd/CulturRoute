import { MetadataRoute } from 'next';
import { createClient } from '@supabase/supabase-js';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://cultureroute.vercel.app';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const { data: events } = await supabase
    .from('events')
    .select('id, start_time')
    .eq('is_published', true);

  const eventUrls: MetadataRoute.Sitemap = (events ?? []).map((e) => ({
    url: `${SITE_URL}/event/${e.id}`,
    lastModified: e.start_time ? new Date(e.start_time) : new Date(),
    changeFrequency: 'weekly',
    priority: 0.7,
  }));

  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1.0,
    },
    {
      url: `${SITE_URL}/itinerary`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    ...eventUrls,
  ];
}
