'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

export type AffiliateLink = {
  key: string;
  label: string;
  url: string | null;
  icon: string;
};

export function useAffiliateLinks(): AffiliateLink[] {
  const [links, setLinks] = useState<AffiliateLink[]>([]);
  useEffect(() => {
    const client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    client
      .from('affiliate_links')
      .select('key, label, url, icon')
      .eq('is_active', true)
      .then(({ data }) => {
        if (data && data.length > 0) setLinks(data as AffiliateLink[]);
      });
  }, []);
  return links;
}
