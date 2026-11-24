// Ad removal for the Monkeytype window. Monkeytype's ads come from Playwire RAMP (cdn.intergient.com),
// which loads Google's ad stack, header-bidding partners, their consent manager and ID syncs.
// Blocking the loader stops the chain; the rest of the list is defence in depth. The empty slots
// are collapsed by CSS in the Monkeytype preload (see AD_CSS in src/preload/ui.ts).
import type { Session } from 'electron';

/** Hosts (and their subdomains) whose requests never leave the app. Observed on monkeytype.com, 2026-11-24. */
export const AD_HOSTS = [
  // Playwire RAMP and its consent/ID helpers
  'intergient.com', 'playwire.com', 'ccgateway.net', 'consentmanager.net', 'fixedfold.com', 'hadronid.net',
  // Google ads and the ad-blocker recovery message
  'doubleclick.net', 'googlesyndication.com', 'googletagservices.com', 'adservice.google.com',
  'fundingchoicesmessages.google.com', 'googleadservices.com', '2mdn.net',
  // Header bidding, ID syncs and ad analytics
  'amazon-adsystem.com', 'openx.net', 'openxcdn.net', 'criteo.com', 'criteo.net', 'rubiconproject.com', 'pubmatic.com',
  'adnxs.com', 'casalemedia.com', 'indexww.com', 'smartadserver.com', 'id5-sync.com', 'id5-tech.io', 'eyeota.net',
  'crwdcntrl.net', 'tapad.com', 'agkn.com', 'taboola.com', 'outbrain.com', 'creativecdn.com', 'fastclick.net',
  'durationmedia.net', 'connectid.analytics.yahoo.com', 'ups.analytics.yahoo.com', 'adsrvr.org', 'rlcdn.com',
  'bidswitch.net', 'sharethrough.com', 'triplelift.com', '3lift.com', 'yieldmo.com', 'media.net', 'sovrn.com',
  'lijit.com', 'gumgum.com', 'teads.tv', 'moatads.com', 'adsafeprotected.com', 'doubleverify.com', 'quantserve.com',
  'scorecardresearch.com', 'liveintent.com', '33across.com', 'onetag-sys.com', 'seedtag.com', 'kargo.com',
];

export function isAdHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return AD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Match patterns for Electron's webRequest filter (a pattern host "*.x" also matches x itself). */
export const AD_URL_PATTERNS = AD_HOSTS.flatMap((h) => [`*://*.${h}/*`]);

export interface AdBlockStats {
  blocked: number;
  hosts: Set<string>;
}

/** Cancels ad requests in a session; returns live counters (read by the E2E suite). */
export function installAdBlock(ses: Session): AdBlockStats {
  const stats: AdBlockStats = { blocked: 0, hosts: new Set() };
  ses.webRequest.onBeforeRequest({ urls: AD_URL_PATTERNS }, (details, callback) => {
    let host = '';
    try {
      host = new URL(details.url).hostname;
    } catch {}
    if (host && isAdHost(host)) {
      stats.blocked++;
      stats.hosts.add(host);
      return callback({ cancel: true });
    }
    callback({});
  });
  return stats;
}
