import { useState } from 'react';
import { CheckCircle2, CircleDashed, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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
import { Callout } from '@/components/settings/Callout';
import { WatchTrackingOptionsDialog } from '@/components/WatchTrackingOptionsDialog';
import { HouseholdUsers } from '@/components/users/HouseholdUsers';
import { useConfig } from '@/contexts/ConfigContext';
import type { WatchTrackingService } from '@/contexts/config';
import { navigateToSettingsSection } from '@/lib/settingsRoute';
import { cn } from '@/lib/utils';
import {
  anyServiceConnected,
  openServiceConnect,
  isWatchTrackingMediaTypeSelected,
  scrobblesJellyfin,
  scrobblesStremio,
  WATCH_TRACKING_SERVICE_DEFINITIONS,
  WATCH_TRACKING_SERVICES,
  withStremioEventsSince,
} from '@/lib/watchTracking';

const MODE_KINDS = {
  legacy: { label: 'Legacy', style: 'border-amber-500/40 text-amber-400' },
  scrobble: { label: 'Scrobble', style: 'border-emerald-500/40 text-emerald-400' },
} as const;

function ModeTile({ selected, title, kind, badge, text, onSelect }: { selected: boolean; title: string; kind: keyof typeof MODE_KINDS; badge: string; text: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex flex-1 flex-col gap-1 rounded-lg border p-3 text-left transition-colors',
        selected ? 'border-primary bg-primary/10' : 'hover:bg-accent/50',
      )}
    >
      <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span className={cn('h-3.5 w-3.5 shrink-0 rounded-full border-2', selected ? 'border-primary bg-primary' : 'border-muted-foreground/50')} aria-hidden="true" />
        {title}
        <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', MODE_KINDS[kind].style)}>{MODE_KINDS[kind].label}</span>
        <Badge variant="secondary" className="text-[10px]">{badge}</Badge>
      </span>
      <span className="pl-5 text-xs text-muted-foreground">{text}</span>
    </button>
  );
}

function SwitchRow({ id, label, hint, checked, onChange, nested }: { id: string; label: string; hint: string; checked: boolean; onChange: (on: boolean) => void; nested?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-4 py-3 pr-4', nested ? 'bg-muted/20 pl-10' : 'pl-4')}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor={id} className="font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="shrink-0" />
    </div>
  );
}

export function WatchTrackingSettings() {
  const { config, setConfig } = useConfig();
  const [watchTrackingService, setWatchTrackingService] = useState<WatchTrackingService | null>(null);
  const [connectPrompt, setConnectPrompt] = useState<WatchTrackingService | null>(null);
  const stremioOn = scrobblesStremio(config);
  const jellyfinOn = scrobblesJellyfin(config);

  const setMaster = (service: WatchTrackingService, on: boolean) => {
    const { masterKey, hasCredential } = WATCH_TRACKING_SERVICE_DEFINITIONS[service];
    setConfig(prev => ({ ...prev, [masterKey]: on }));
    if (on && !hasCredential(config)) setConnectPrompt(service);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold">Watch Tracking</h2>
        <p className="text-muted-foreground mt-1">Choose how plays are recorded, which services hear about them, and who is watching.</p>
      </div>

      {!anyServiceConnected(config) ? (
        <Callout variant="warn">
          No tracking service is connected, so plays are kept only on this server. Connect Simkl, AniList or MyAnimeList in{' '}
          <button type="button" className="font-medium underline underline-offset-2" onClick={() => navigateToSettingsSection('catalogs')}>Catalogs</button>
          , or MDBList or PublicMetaDB in{' '}
          <button type="button" className="font-medium underline underline-offset-2" onClick={() => navigateToSettingsSection('integrations')}>Integrations</button>.
        </Callout>
      ) : null}

      <Card id="wt-recording">
        <CardHeader>
          <CardTitle>Recording</CardTitle>
          <CardDescription>When a play counts, for every service and every user.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div id="playback-detection" role="radiogroup" aria-label="When to record" className="flex flex-col gap-2 md:flex-row">
            <ModeTile
              selected={!config.playbackReporting}
              title="When a title is opened"
              kind="legacy"
              badge="Any client"
              text="Works everywhere, but anything opened counts as watched, even if stopped a minute in."
              onSelect={() => setConfig(prev => ({ ...prev, playbackReporting: false }))}
            />
            <ModeTile
              selected={config.playbackReporting === true}
              title="When playback starts and stops"
              kind="scrobble"
              badge="Stremio, Jellyfin"
              text="Something abandoned after a few minutes is kept as a resume point rather than marked watched."
              onSelect={() => setConfig(prev => withStremioEventsSince(prev, { ...prev, playbackReporting: true }))}
            />
          </div>
          {config.playbackReporting ? (
            <div className="divide-y overflow-hidden rounded-lg border">
              <SwitchRow
                id="stremio-scrobbling"
                label="Stremio SDK"
                hint="Plays, pauses and watched marks sent by Stremio. Each user installs their own link from Configuration."
                checked={stremioOn}
                onChange={(on) => setConfig(prev => withStremioEventsSince(prev, { ...prev, stremioScrobbling: on }))}
              />
              {stremioOn ? (
                <SwitchRow
                  nested
                  id="stremio-library-watchlist"
                  label="Sync Stremio library with watchlists"
                  hint="Adding or removing a title in your Stremio library does the same on your watchlists."
                  checked={config.stremioLibraryWatchlist === true}
                  onChange={(on) => setConfig(prev => ({ ...prev, stremioLibraryWatchlist: on }))}
                />
              ) : null}
              <SwitchRow
                id="jellyfin-scrobbling"
                label="Jellyfin"
                hint="Plays on this addon's or AIOStreams' Jellyfin server. A favourite goes to your watchlist; disliking a show marks it dropped."
                checked={jellyfinOn}
                onChange={(on) => setConfig(prev => ({ ...prev, jellyfinScrobbling: on }))}
              />
              <p className={cn('bg-muted/20 px-4 py-2.5 text-xs', !stremioOn && !jellyfinOn ? 'text-amber-400' : 'text-muted-foreground')}>
                {!stremioOn && !jellyfinOn ? 'Both are off, so nothing will be recorded.' : 'A client that reports neither way records nothing.'}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card id="wt-services">
        <CardHeader>
          <CardTitle>Services</CardTitle>
          <CardDescription>Where your plays are recorded. A user with accounts of their own uses those instead.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
            {WATCH_TRACKING_SERVICES.map((service) => {
              const definition = WATCH_TRACKING_SERVICE_DEFINITIONS[service];
              const connected = definition.hasCredential(config);
              const switchId = `${service}-watch-tracking`;
              return (
                <div key={service} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg p-3 transition-colors hover:bg-accent/50">
                  <div className="min-w-[12rem] flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Label htmlFor={switchId} className="font-medium">{definition.label}</Label>
                      {connected ? (
                        <span className="flex items-center gap-1 text-[11px] text-emerald-400"><CheckCircle2 className="h-3 w-3" /> Connected</span>
                      ) : (
                        <button
                          type="button"
                          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                          title={definition.connectHint}
                          onClick={() => openServiceConnect(service)}
                        >
                          <CircleDashed className="h-3 w-3" /> Not connected · <span className="underline underline-offset-2">Connect</span>
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {(['movie', 'series'] as const).map((mediaType) => {
                        const on = isWatchTrackingMediaTypeSelected(config, service, mediaType);
                        return (
                          <span key={mediaType} className={cn('rounded-full border px-1.5 text-[11px]', on ? 'text-foreground' : 'text-muted-foreground line-through opacity-60')}>
                            {mediaType === 'movie' ? definition.movieLabel : definition.seriesLabel}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                      aria-label={`Configure ${definition.label} watch tracking types`}
                      title="Configure media types"
                      onClick={() => setWatchTrackingService(service)}
                    >
                      <Settings2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Switch id={switchId} checked={config[definition.masterKey] === true} onCheckedChange={(on) => setMaster(service, on)} />
                  </div>
                </div>
              );
            })}
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
                    const service = connectPrompt;
                    setConnectPrompt(null);
                    openServiceConnect(service);
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
            Everyone watching, your card first. Each user gets a Stremio install link in Configuration and appears on the Jellyfin sign-in screen. Someone else keeps their own history; a user that is you shares yours.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <HouseholdUsers />
        </CardContent>
      </Card>
    </div>
  );
}
