// The host section: read this machine's resource samples and turn them into a
// statusbar section payload.
//
// WHERE THE DATA COMES FROM
//
// The `host-monitor` plugin (bb-plugins, by MateoCerquetella) samples this
// machine every ~10 seconds into its own SQLite store, including network
// throughput, which the Statusbar's built-in reader does not have at all.
//
// It publishes no RPC, no CLI, and no HTTP route, so there is nothing to call:
// reading its database is the only way to use its data. That is a deliberate
// choice over re-sampling `node:os` here, and the cost is stated plainly below.
//
// THE COUPLING
//
// This reads another plugin's PRIVATE schema. Unlike bb-plugin-statusbar-usage
// (which reads bb-plugin-usage) and bb-plugin-statusbar-lanes (which calls
// bb-plugin-lanes' RPC), the owner here is a third party who owes this plugin
// nothing: a future host-monitor release may rename or drop these columns.
//
// Two things make that survivable:
//
//   1. Every read is defensive. A missing table, a missing column, or a missing
//      row produces a visible degraded label, never a thrown error and never a
//      blank bar. There is no bare `SELECT *`.
//   2. The Statusbar keeps its own built-in host reader, so disabling this
//      plugin returns the topic to a working reading.
//
// Pin host-monitor to a version if you want the schema guaranteed.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  metricsSection,
  unavailableSection,
  type SectionMetricInput,
  type SectionPayload,
} from "@robcopeland/bb-statusbar-section-protocol";

const TOPIC = "host";

/** Where host-monitor keeps its samples, relative to the bb data directory. */
export const HOST_MONITOR_DB = join("plugins", "host-monitor", "data.db");

/**
 * Fallback data directory.
 *
 * Only used when the caller cannot supply `bb.server.experimental_dataDir`.
 * That accessor is preferred because the SDK documents why hardcoding is wrong:
 * a dev server derives its data dir from its repo root and instance id, so a
 * plugin that assumes `~/.bb` reads the production file while the dev server
 * reads a different one.
 */
export function defaultDataDir(): string {
  return join(homedir(), ".bb");
}

/**
 * This machine's bb host id, read from `<dataDir>/host-id`.
 *
 * WHY THIS IS NEEDED
 *
 * `fleet_samples` is keyed by `host_id`, and host-monitor is built for a fleet:
 * it can hold samples for several machines. "Newest row wins" would therefore
 * show a REMOTE machine's CPU as if it were local, which is a quietly wrong
 * number rather than a missing one.
 *
 * `host-id` is the authoritative local identity: it is what bb itself writes,
 * and it matches both `bb machine list` and `fleet_samples.host_id` exactly.
 *
 * Returns null when the file is unreadable, so the caller can fall back rather
 * than guess.
 */
export function readLocalHostId(dataDir: string = defaultDataDir()): string | null {
  try {
    const value = readFileSync(join(dataDir, "host-id"), "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** One `fleet_samples` row, as this plugin consumes it. */
export interface HostSample {
  collected_at: number;
  cpu_percent: number | null;
  memory_percent: number | null;
  disk_percent: number | null;
  receive_bytes_per_second: number | null;
  send_bytes_per_second: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
}

/**
 * The exact columns read, named rather than `SELECT *`.
 *
 * If host-monitor renames one of these the query throws, which the reader turns
 * into a visible "schema changed" label. A `SELECT *` would instead silently
 * return whatever happens to be there and render wrong numbers.
 */
const SAMPLE_COLUMNS = [
  "collected_at",
  "cpu_percent",
  "memory_percent",
  "disk_percent",
  "receive_bytes_per_second",
  "send_bytes_per_second",
  "load1",
  "load5",
  "load15",
].join(", ");

export interface HostStoreOptions {
  /** bb data dir; the caller passes `bb.server.experimental_dataDir`. */
  dataDir?: string;
  /** Override the database path entirely (tests, non-standard installs). */
  databasePath?: string;
}

export function createHostStore(options: HostStoreOptions = {}) {
  const dataDir = options.dataDir ?? defaultDataDir();
  const databasePath = options.databasePath ?? join(dataDir, HOST_MONITOR_DB);
  let handle: DatabaseSync | null = null;

  function connection(): DatabaseSync {
    if (handle === null) {
      // Read-only, and WAL means a reader never blocks host-monitor's writer.
      handle = new DatabaseSync(databasePath, { readOnly: true });
      handle.exec("PRAGMA busy_timeout = 2000");
    }
    return handle;
  }

  /**
   * The newest sample for one host, or null when there is none.
   *
   * Preferred path: filtered by this machine's host id.
   */
  function latestForHost(hostId: string): HostSample | null {
    const row = connection()
      .prepare(
        `SELECT ${SAMPLE_COLUMNS} FROM fleet_samples
          WHERE host_id = ?
          ORDER BY collected_at DESC
          LIMIT 1`,
      )
      .get(hostId) as HostSample | undefined;
    return row ?? null;
  }

  /**
   * The newest sample from ANY host.
   *
   * Only used when the local host id could not be resolved. On a single-host
   * install (the common case) this is exactly right; on a fleet it could show
   * another machine, so the section labels which host it used.
   */
  function latestAnyHost(): { sample: HostSample; hostId: string } | null {
    const row = connection()
      .prepare(
        `SELECT ${SAMPLE_COLUMNS}, host_id FROM fleet_samples
          ORDER BY collected_at DESC
          LIMIT 1`,
      )
      .get() as (HostSample & { host_id: string }) | undefined;
    if (row === undefined) return null;
    const { host_id, ...sample } = row;
    return { sample: sample as HostSample, hostId: host_id };
  }

  function close(): void {
    handle?.close();
    handle = null;
  }

  return { latestForHost, latestAnyHost, databasePath, dataDir, close };
}

export type HostStore = ReturnType<typeof createHostStore>;

/** What a read produced, including which host it came from. */
export interface HostReading {
  sample: HostSample | null;
  /** The host the sample belongs to, when known. */
  hostId: string | null;
  /**
   * True when the sample could not be attributed to this machine and fell back
   * to "newest row from any host".
   */
  fallback: boolean;
  /** Set when nothing could be read, e.g. the store is missing. */
  error: string | null;
}

/** Mirrors the bar's tone vocabulary: attention at 75%, critical at 90%. */
function toneForPercent(value: number | null): "neutral" | "attention" | "critical" {
  if (value === null) return "neutral";
  if (value >= 90) return "critical";
  if (value >= 75) return "attention";
  return "neutral";
}

export function percent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value > 0 && value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

/**
 * `1.2M/s` / `340k/s` / `512/s`.
 *
 * Byte rates are wide numbers, and the bar is 24px tall, so they are compacted
 * the same way token counts are elsewhere. Decimal SI units (1 kB = 1000 B) are
 * used because that is what network tooling reports and what a NIC link speed
 * is quoted in, not the 1024-based units of memory.
 */
export function bytesPerSecond(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "—";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}G/s`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M/s`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k/s`;
  return `${Math.round(value)}/s`;
}

/**
 * Build the section metrics from a sample.
 *
 * `detail` names the sample's age, because host-monitor samples every ~10s and
 * a stalled sampler would otherwise leave a plausible-looking stale number on
 * screen with nothing to indicate it had stopped.
 */
export function toMetrics(reading: HostReading, now: Date = new Date()): SectionMetricInput[] {
  const s = reading.sample;
  if (s === null) return [];

  const ageSeconds = Number.isFinite(s.collected_at)
    ? Math.max(0, Math.round((now.getTime() - s.collected_at) / 1000))
    : null;

  // Only worth saying when the sampler has clearly stopped rather than merely
  // being one tick behind.
  const stale = ageSeconds !== null && ageSeconds > STALE_AFTER_SECONDS;
  const age = stale ? `Sample is ${describeAge(ageSeconds)} old.` : null;

  // Which host these numbers belong to, when it is not certain they are local.
  const hostNote = reading.fallback
    ? `Newest sample from any host (${reading.hostId ?? "unknown"}) - local host id unresolved.`
    : null;

  return [
    {
      label: "CPU",
      value: percent(s.cpu_percent),
      tone: toneForPercent(s.cpu_percent),
      detail: age ?? hostNote,
      importance: "primary",
    },
    {
      label: "MEM",
      value: percent(s.memory_percent),
      tone: toneForPercent(s.memory_percent),
      detail: age ?? hostNote,
      importance: "primary",
    },
    {
      label: "DISK",
      value: percent(s.disk_percent),
      tone: toneForPercent(s.disk_percent),
      // DISK is the first to go on a narrow window, matching the built-in.
      detail: null,
      importance: "secondary",
    },
    {
      label: "load",
      value: s.load1 === null || !Number.isFinite(s.load1) ? "—" : s.load1.toFixed(2),
      tone: "neutral",
      // load5 adds trend at no width cost, since it rides in the detail slot.
      detail:
        s.load5 === null || !Number.isFinite(s.load5)
          ? (age ?? hostNote)
          : `5m ${s.load5.toFixed(2)}${age === null ? "" : ` · ${age}`}`,
      importance: "secondary",
    },
    // The reason this plugin exists: the built-in host reader has no network
    // figure at all. Down is primary (it is the direction that stalls work),
    // up is secondary.
    {
      label: "NET",
      value: `↓${bytesPerSecond(s.receive_bytes_per_second)}`,
      tone: "neutral",
      detail:
        s.send_bytes_per_second === null
          ? null
          : `↑${bytesPerSecond(s.send_bytes_per_second)}`,
      importance: "primary",
    },
  ];
}

/** Comfortably longer than host-monitor's ~10s cadence. */
const STALE_AFTER_SECONDS = 120;

function describeAge(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Read the store, resolving this host, and build a section.
 *
 * Any failure becomes a degraded section rather than a thrown error: a section
 * is independently degradable by design, and one broken provider must not blank
 * the bar.
 */
export function readHostSection(store: HostStore, now: Date = new Date()): SectionPayload {
  let reading: HostReading;
  try {
    const localId = readLocalHostId(store.dataDir);
    if (localId !== null) {
      const sample = store.latestForHost(localId);
      if (sample !== null) {
        reading = { sample, hostId: localId, fallback: false, error: null };
      } else {
        // The id resolved but this host has no rows yet: a host-monitor that
        // has only just started, or a host id that was rotated. Falling back
        // to any host would risk showing another machine, so this stays empty
        // and says why.
        reading = {
          sample: null,
          hostId: localId,
          fallback: false,
          error: `No samples for this host (${localId}) yet.`,
        };
      }
    } else {
      const any = store.latestAnyHost();
      reading =
        any === null
          ? { sample: null, hostId: null, fallback: false, error: "No samples recorded yet." }
          : { sample: any.sample, hostId: any.hostId, fallback: true, error: null };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A missing database means host-monitor is not installed, which is by far
    // the likeliest failure and needs a different action from a schema change.
    const missing = /unable to open database file/i.test(message);
    return unavailableSection({
      topic: TOPIC,
      status: "error",
      detail: missing
        ? "host-monitor not installed - no store at plugins/host-monitor/data.db"
        : `host-monitor store unreadable: ${message}`,
    });
  }

  if (reading.sample === null) {
    return unavailableSection({
      topic: TOPIC,
      status: "idle",
      detail: reading.error ?? "No samples recorded yet.",
    });
  }

  return metricsSection({ topic: TOPIC, metrics: toMetrics(reading, now) });
}
