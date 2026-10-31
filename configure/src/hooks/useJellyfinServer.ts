import { useEffect, useState } from 'react';

/** Whether this instance runs the Jellyfin server, and the address clients reach it at. */
export function useJellyfinServer(): { enabled: boolean; baseUrl: string } {
  const [server, setServer] = useState({ enabled: false, baseUrl: window.location.origin });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const baseUrl = typeof data.jellyfinBaseUrl === 'string' && data.jellyfinBaseUrl.trim() ? data.jellyfinBaseUrl.trim() : window.location.origin;
        setServer({ enabled: Boolean(data.jellyfinEnabled), baseUrl });
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  return server;
}

export function jellyfinServerAddress(baseUrl: string, userUUID: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/jellyfin/${userUUID}`;
}
