"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, RefreshCw } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { v } from "@/lib/validate";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";
import { stripRelPrefix, toMatchKey } from "@/lib/library-paths";

type MediaSampleData = { mountPoint: string; samples: string[] };
type ServerSamples   = { movie: MediaSampleData; tv: MediaSampleData };

function LibraryMatchMediaBlock({
  mediaType, mediaLabel, ariaLabel, data, prefix, onChangePrefix, placeholder,
}: {
  mediaType: "MOVIE" | "TV";
  mediaLabel: string; ariaLabel: string; data: MediaSampleData | null;
  prefix: string; onChangePrefix: (v: string) => void; placeholder: string;
}) {
  const t = useT();
  const inputId = useId();
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{mediaLabel}</p>

      {data && (
        <>
          <div className="rounded bg-zinc-800/60 border border-zinc-700/60 px-3 py-2 space-y-0.5">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wide">{t("settings.form.libraryMatch.mountPoint")}</p>
            <p className="text-xs text-zinc-300 font-mono">{data.mountPoint || t("settings.form.libraryMatch.noneDetected")}</p>
          </div>

          <div className="rounded bg-zinc-800/60 border border-zinc-700/60 px-3 py-2 space-y-1">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1">{t("settings.form.libraryMatch.samplePaths")}</p>
            {data.samples.length === 0
              ? <p className="text-[11px] text-zinc-500 italic">{t("settings.form.libraryMatch.noPaths")}</p>
              : data.samples.map((s, i) => (
                  <p key={i} className="text-[11px] text-zinc-400 font-mono truncate" title={s}>{s}</p>
                ))
            }
          </div>
        </>
      )}

      <div className="space-y-1">
        <Label htmlFor={inputId} className="text-xs text-zinc-400">{t("settings.form.libraryMatch.prefixLabel")}</Label>
        <Input
          id={inputId}
          aria-describedby={`${inputId}-context`}
          value={prefix}
          onChange={(e) => onChangePrefix(e.target.value)}
          placeholder={placeholder}
          className="bg-zinc-800 border-zinc-700 font-mono h-8"
        />
        {/* Which server and media this box is for: a description, so the
            accessible name stays the visible label. */}
        <span id={`${inputId}-context`} className="sr-only">{ariaLabel}</span>
      </div>

      {data && prefix && (
        <div className="rounded bg-zinc-800/60 border border-zinc-700/60 px-3 py-2 space-y-1">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1">{t("settings.form.libraryMatch.preview")}</p>
          {data.samples.map((s, i) => {
            // The server's own rule (library-paths.ts), so the preview can't
            // drift from it: the prefix is stripped, then the match key taken —
            // for TV that is the first folder left, the show the key names.
            const stripped = stripRelPrefix(s, prefix);
            const after    = toMatchKey(stripped, mediaType);
            const changed  = stripped !== s;
            return (
              <p key={i} className={`text-[11px] font-mono truncate ${changed ? "text-green-400" : "text-zinc-500"}`} title={after}>
                {after}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LibraryMatchServerBlock({
  label, accent, data, moviePrefix, tvPrefix,
  onChangeMoviePrefix, onChangeTvPrefix, loading, loadError,
}: {
  label: string; accent: string; data: ServerSamples | null;
  moviePrefix: string; tvPrefix: string;
  onChangeMoviePrefix: (v: string) => void; onChangeTvPrefix: (v: string) => void;
  loading: boolean; loadError: boolean;
}) {
  const t = useT();
  return (
    <div className="space-y-4">
      <p className={`text-xs font-semibold uppercase tracking-wide ${accent}`}>{label}</p>

      {!data && !loading && !loadError && (
        <p className="text-xs text-zinc-500 italic">{t("settings.form.libraryMatch.loadHint")}</p>
      )}

      {/* The prefix boxes always render: the saved values must be visible and
          editable even when the examples were never loaded or failed to load.
          Only the samples and the preview wait on `data`. */}
      <div className="space-y-5">
        <LibraryMatchMediaBlock
          mediaType="MOVIE"
          mediaLabel={t("nav.movies")}
          ariaLabel={t("settings.form.libraryMatch.prefixAriaMovie", { server: label })}
          data={data?.movie ?? null}
          prefix={moviePrefix}
          onChangePrefix={onChangeMoviePrefix}
          placeholder={t("settings.form.libraryMatch.placeholder", { example: "movies/" })}
        />
        <div className="border-t border-zinc-800" />
        <LibraryMatchMediaBlock
          mediaType="TV"
          mediaLabel={t("nav.tvShows")}
          ariaLabel={t("settings.form.libraryMatch.prefixAriaTv", { server: label })}
          data={data?.tv ?? null}
          prefix={tvPrefix}
          onChangePrefix={onChangeTvPrefix}
          placeholder={t("settings.form.libraryMatch.placeholder", { example: "tv/" })}
        />
      </div>
    </div>
  );
}


interface LibraryMatchFormProps {
  initialPlexMoviePrefix:     string;
  initialPlexTvPrefix:        string;
  initialJellyfinMoviePrefix: string;
  initialJellyfinTvPrefix:    string;
}

// The four prefixes, keyed by the Setting each one saves to.
type PrefixKey =
  | "plexMoviePathStripPrefix" | "plexTvPathStripPrefix"
  | "jellyfinMoviePathStripPrefix" | "jellyfinTvPathStripPrefix";

// GET /api/admin/library-sample-paths, checked: a block without its samples
// would otherwise throw in render (`samples.length`).
const MediaSamples = v.object({ mountPoint: v.string(), samples: v.array(v.string()) });
const ServerSamplesSchema = v.object({ movie: MediaSamples, tv: MediaSamples });
const SamplePaths = v.object({ plex: ServerSamplesSchema, jellyfin: ServerSamplesSchema });

export function LibraryMatchForm({
  initialPlexMoviePrefix,
  initialPlexTvPrefix,
  initialJellyfinMoviePrefix,
  initialJellyfinTvPrefix,
}: LibraryMatchFormProps) {
  const t = useT();
  const [prefixes, setPrefixes] = useState<Record<PrefixKey, string>>({
    plexMoviePathStripPrefix:     initialPlexMoviePrefix,
    plexTvPathStripPrefix:        initialPlexTvPrefix,
    jellyfinMoviePathStripPrefix: initialJellyfinMoviePrefix,
    jellyfinTvPathStripPrefix:    initialJellyfinTvPrefix,
  });
  const [samples, setSamples] = useState<{ plex: ServerSamples; jellyfin: ServerSamples } | null>(null);
  const [loadError, setLoadError] = useState("");
  const action = useAsyncAction();
  const loading = action.busy("load");
  // `saveMessage` is the route's own reason (a 429 cooldown, too long), shown
  // in place of the bare "Failed to save".
  const { status: saveStatus, message: saveMessage, save, edited } = useSettingsSave();

  async function loadSamples() {
    setLoadError("");
    const res = await action.run("load", (signal) =>
      // Surface the route's own { error } when it sent one; otherwise a bare
      // "HTTP 500" tells the admin nothing they can act on.
      fetchJson(withBasePath("/api/admin/library-sample-paths"), {
        schema: SamplePaths,
        signal,
        fallbackError: t("settings.form.libraryMatch.loadFailed"),
      }));
    if (!res) return;
    if (!res.ok) {
      setLoadError(res.error);
      return;
    }
    setSamples(res.data);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await save({ ...prefixes });
  }

  const onChangePrefix = (key: PrefixKey) => (value: string) => { setPrefixes((p) => ({ ...p, [key]: value })); edited(); };

  // The <form> wraps the whole block so Enter inside any prefix field saves,
  // like every other form in this folder. "Load examples" is a Button, which
  // defaults to type="button", so it never submits.
  return (
    <form onSubmit={handleSave} className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-zinc-400">
          {t("settings.form.libraryMatch.intro")}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={loadSamples}
          disabled={loading}
          className="border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-2 shrink-0"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {t("settings.form.libraryMatch.loadExamples")}
        </Button>
      </div>

      {loadError && <p role="alert" className="text-xs text-red-400">{loadError}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <LibraryMatchServerBlock
          label="Plex" accent="text-yellow-400"
          data={samples?.plex ?? null}
          moviePrefix={prefixes.plexMoviePathStripPrefix} tvPrefix={prefixes.plexTvPathStripPrefix}
          onChangeMoviePrefix={onChangePrefix("plexMoviePathStripPrefix")} onChangeTvPrefix={onChangePrefix("plexTvPathStripPrefix")}
          loading={loading} loadError={loadError !== ""}
        />
        <LibraryMatchServerBlock
          label="Jellyfin" accent="text-purple-400"
          data={samples?.jellyfin ?? null}
          moviePrefix={prefixes.jellyfinMoviePathStripPrefix} tvPrefix={prefixes.jellyfinTvPathStripPrefix}
          onChangeMoviePrefix={onChangePrefix("jellyfinMoviePathStripPrefix")} onChangeTvPrefix={onChangePrefix("jellyfinTvPathStripPrefix")}
          loading={loading} loadError={loadError !== ""}
        />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Button type="submit" disabled={saveStatus === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {saveStatus === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={saveStatus} errorLabel={saveMessage || t("settings.form.common.saveFailed")} />
      </div>
    </form>
  );
}
