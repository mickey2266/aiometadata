import { useState } from 'react';
import { Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { WatchTrackingOptionsDialog } from '@/components/WatchTrackingOptionsDialog';
import { HouseholdUsers } from '@/components/users/HouseholdUsers';
import { useConfig } from '@/contexts/ConfigContext';
import type { WatchTrackingService } from '@/contexts/config';
import { navigateToSettingsSection } from '@/lib/settingsRoute';
import {
  getWatchTrackingMediaTypeSummary,
  scrobblesJellyfin,
  scrobblesStremio,
  stremioLinkState,
  WATCH_TRACKING_SERVICE_DEFINITIONS,
} from '@/lib/watchTracking';
import { useStremioLinkStatus } from '@/hooks/useStremioLinkStatus';

export function WatchTrackingSettings() {
  const { config, setConfig } = useConfig();
  const [watchTrackingService, setWatchTrackingService] = useState<WatchTrackingService | null>(null);
  const stremioOn = scrobblesStremio(config);
  const stremioStatus = useStremioLinkStatus(stremioOn);
  const stremioLabel = stremioStatus ? stremioLinkState(config.stremioScrobblingSince, stremioStatus['']) : null;
  const [connectPrompt, setConnectPrompt] = useState<WatchTrackingService | null>(null);

  const handleMDBListTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, mdblistWatchTracking: checked }));
  };

  const handleAniListTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, anilistWatchTracking: checked }));
  };

  const handleMalTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, malWatchTracking: checked }));
  };

  const handleSimklTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, simklWatchTracking: checked }));
  };

  const handlePublicMetaDBTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, publicmetadbWatchTracking: checked }));
  };

  const renderWatchTrackingControls = (
    service: WatchTrackingService,
    switchId: string,
    checked: boolean,
    onCheckedChange: (checked: boolean) => void,
  ) => {
    const handleToggle = (next: boolean) => {
      onCheckedChange(next);
      if (next && !WATCH_TRACKING_SERVICE_DEFINITIONS[service].hasCredential(config)) {
        setConnectPrompt(service);
      }
    };

    return (
    <div className="flex items-center gap-1 shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-9 w-9"
        aria-label={`Configure ${WATCH_TRACKING_SERVICE_DEFINITIONS[service].label} watch tracking types`}
        title="Configure media types"
        onClick={() => setWatchTrackingService(service)}
      >
        <Settings2 className="h-4 w-4 text-muted-foreground" />
      </Button>
      <Switch id={switchId} checked={checked} onCheckedChange={handleToggle} />
    </div>
    );
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold">Watch Tracking</h2>
        <p className="text-muted-foreground mt-1">Choose how plays are recorded, which services hear about them, and who is watching.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>How plays are recorded</CardTitle>
          <CardDescription>Record what you watch to the services you have connected below.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="min-w-[12rem] flex-1">
                <div className="flex items-center gap-2">
                  <Label htmlFor="playback-detection" className="font-medium">When to record</Label>
                </div>
                <p className="text-sm text-muted-foreground">
                  Applies to every service below.
                </p>
              </div>
              <Select
                value={config.playbackReporting ? 'reported' : 'opened'}
                onValueChange={(v) => setConfig(prev => ({ ...prev, playbackReporting: v === 'reported' }))}
              >
                <SelectTrigger id="playback-detection" className="w-full sm:w-[260px] shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="opened">
                    <span className="flex items-center gap-2">
                      When a title is opened
                      <Badge variant="secondary" className="text-[10px]">Any client</Badge>
                    </span>
                  </SelectItem>
                  <SelectItem value="reported">
                    <span className="flex items-center gap-2">
                      When playback starts and stops
                      <Badge variant="secondary" className="text-[10px]">Stremio, Jellyfin</Badge>
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {config.playbackReporting ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Recorded from what the client reports: something you abandon after a few minutes is kept as a resume point rather than being marked watched. <span className="text-amber-400">A client that reports neither way below records nothing.</span>
                </p>
                <div className="space-y-1 pt-1">
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg p-2 hover:bg-accent/50 transition-colors">
                    <div className="min-w-[12rem] flex-1">
                      <Label htmlFor="stremio-scrobbling" className="font-medium">Stremio SDK</Label>
                      <p className="text-xs text-muted-foreground">Plays, pauses and watched marks Stremio sends to the addon.</p>
                      {stremioOn && stremioLabel === 'reinstall' ? (
                        <p className="text-xs text-amber-400">Reinstall required</p>
                      ) : stremioOn && stremioLabel === 'waiting' ? (
                        <p className="text-xs text-muted-foreground">No playback from Stremio yet</p>
                      ) : null}
                    </div>
                    <Switch
                      id="stremio-scrobbling"
                      checked={stremioOn}
                      onCheckedChange={(on) => setConfig(prev => ({ ...prev, stremioScrobbling: on, ...(on ? { stremioScrobblingSince: Date.now() } : {}) }))}
                    />
                  </div>
                  {stremioOn ? (
                    <div className="ml-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-r-lg border-l border-border p-2 pl-4 hover:bg-accent/50 transition-colors">
                      <div className="min-w-[12rem] flex-1">
                        <Label htmlFor="stremio-library-watchlist" className="font-medium">Sync Stremio library with watchlists</Label>
                        <p className="text-xs text-muted-foreground">Adding a title to your Stremio library adds it to your watchlists; removing it removes it.</p>
                      </div>
                      <Switch
                        id="stremio-library-watchlist"
                        checked={config.stremioLibraryWatchlist === true}
                        onCheckedChange={(on) => setConfig(prev => ({ ...prev, stremioLibraryWatchlist: on }))}
                      />
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg p-2 hover:bg-accent/50 transition-colors">
                    <div className="min-w-[12rem] flex-1">
                      <Label htmlFor="jellyfin-scrobbling" className="font-medium">Jellyfin</Label>
                      <p className="text-xs text-muted-foreground">This addon's Jellyfin server and AIOStreams' Jellyfin server. A favourite goes to your watchlist, and disliking a show marks it dropped.</p>
                    </div>
                    <Switch
                      id="jellyfin-scrobbling"
                      checked={scrobblesJellyfin(config)}
                      onCheckedChange={(on) => setConfig(prev => ({ ...prev, jellyfinScrobbling: on }))}
                    />
                  </div>
                  {!stremioOn && !scrobblesJellyfin(config) ? (
                    <p className="px-2 text-xs text-muted-foreground">Nothing will be recorded.</p>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Recorded as soon as you open a title, which is the only signal most clients give. Simple and works everywhere, but anything you open counts as watched even if you stop a minute in.
              </p>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="simkl-watch-tracking" className="font-medium">Simkl</Label>
                <p className="text-sm text-muted-foreground">{getWatchTrackingMediaTypeSummary(config, 'simkl')}</p>
              </div>
              {renderWatchTrackingControls('simkl', 'simkl-watch-tracking', !!config.simklWatchTracking, handleSimklTrackingChange)}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="anilist-watch-tracking" className="font-medium">AniList</Label>
                <p className="text-sm text-muted-foreground">{getWatchTrackingMediaTypeSummary(config, 'anilist')}</p>
              </div>
              {renderWatchTrackingControls('anilist', 'anilist-watch-tracking', !!config.anilistWatchTracking, handleAniListTrackingChange)}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="mal-watch-tracking" className="font-medium">MyAnimeList</Label>
                <p className="text-sm text-muted-foreground">{getWatchTrackingMediaTypeSummary(config, 'mal')}</p>
              </div>
              {renderWatchTrackingControls('mal', 'mal-watch-tracking', !!config.malWatchTracking, handleMalTrackingChange)}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="mdblist-watch-tracking" className="font-medium">MDBList</Label>
                <p className="text-sm text-muted-foreground">{getWatchTrackingMediaTypeSummary(config, 'mdblist')}</p>
              </div>
              {renderWatchTrackingControls('mdblist', 'mdblist-watch-tracking', !!config.mdblistWatchTracking, handleMDBListTrackingChange)}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="publicmetadb-watch-tracking" className="font-medium">PublicMetaDB</Label>
                <p className="text-sm text-muted-foreground">{getWatchTrackingMediaTypeSummary(config, 'publicmetadb')}</p>
              </div>
              {renderWatchTrackingControls('publicmetadb', 'publicmetadb-watch-tracking', !!config.publicmetadbWatchTracking, handlePublicMetaDBTrackingChange)}
            </div>
          </div>
        </CardContent>
      </Card>

      <WatchTrackingOptionsDialog
        service={watchTrackingService}
        open={watchTrackingService !== null}
        onOpenChange={(open) => {
          if (!open) setWatchTrackingService(null);
        }}
      />

      <AlertDialog open={connectPrompt !== null} onOpenChange={(open) => { if (!open) setConnectPrompt(null); }}>
        <AlertDialogContent>
          {connectPrompt && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Connect {WATCH_TRACKING_SERVICE_DEFINITIONS[connectPrompt].label} to start tracking
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {WATCH_TRACKING_SERVICE_DEFINITIONS[connectPrompt].connectHint} The setting is on and will
                  start working as soon as the account is connected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Later</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    const { connectSection } = WATCH_TRACKING_SERVICE_DEFINITIONS[connectPrompt];
                    setConnectPrompt(null);
                    navigateToSettingsSection(connectSection);
                  }}
                >
                  Take me there
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      <Card id="household-users">
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            Everyone watching on this configuration. Your own card comes first. Each user gets their own install link for Stremio under Configuration, and appears on the sign-in screen of this addon's Jellyfin server. A user is made of the tags picked for it: it sees the catalogs carrying any of them, under their rating limit. Someone else gets their own watch history and Continue Watching; a user that is you shares yours. Tags themselves are made in Catalogs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <HouseholdUsers />
        </CardContent>
      </Card>
    </div>
  );
}
