import { sendGAEvent } from '@next/third-parties/google';

export function trackAffiliateClick(key: string, label: string, url: string) {
  sendGAEvent('event', 'affiliate_click', {
    resource_key: key,
    resource_label: label,
    destination_url: url,
  });
}
