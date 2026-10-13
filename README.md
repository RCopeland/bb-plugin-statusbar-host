# bb-plugin-statusbar-host

A [Statusbar](https://github.com/RCopeland/bb-plugin-statusbar) section provider
that shows this machine's resources in the bar:

```
$0.03 today │ OpenRouter 28% │ CPU 2% MEM 63% DISK 10% load 0.37 NET ↓502/s
```

CPU, memory, and disk as percentages; 1-minute load with 5-minute load in the
detail; and **network throughput**, which the Statusbar's built-in host reader
does not have at all.

## What it is, and what it is not

It is a **section provider**, not a bar and not a sampler. It does not draw
anything, does not choose its position in the row, and cannot ship UI into the
bar. It publishes one discoverable RPC method returning data.

It also **does not sample the machine itself.** It reads the samples that
[`host-monitor`](https://github.com/MateoCerquetella/bb-plugins) already
collects. See below for why, and what that costs.

## Install

```sh
git clone <this repo>
cd bb-plugin-statusbar-host
npm install
bb plugin build .
bb plugin install . --yes
```

Requirements:

- **bb ≥ 0.44** (see `engines`).
- **`host-monitor`** — required, see below.
- The **Statusbar** plugin installed and running. This is what renders the
  section; without it nothing calls this plugin.
- Node ≥ 22.5 on the bb server, for `node:sqlite`. bb 0.44 ships a modern Node.

## This plugin requires host-monitor

**`host-monitor` must be installed and sampling. It is not optional.** This
plugin has no sampler of its own — it reads host-monitor's store.

```sh
# Install host-monitor first, if it is not already present.
bb plugin install git:https://github.com/MateoCerquetella/bb-plugins.git@semver:host-monitor/:^0.1.2 --yes
```

If it is missing, the section renders an error label rather than a blank bar or
a wrong number, and the label says which problem it is:

| Situation | What the bar shows |
|---|---|
| host-monitor not installed | `host-monitor not installed - no store at plugins/host-monitor/data.db` |
| store unreadable | `host-monitor store unreadable: file is not a database` |
| host-monitor's schema changed | `host-monitor store unreadable: no such column: memory_percent` |
| running, no sample for this host yet | `No samples for this host (host_…) yet.` (idle, not an error) |
| sampler stalled > 2 min | normal metrics + `Sample is 5m old.` |

## The data source, and the coupling it implies

Reads host-monitor's SQLite store at
`<bb data dir>/plugins/host-monitor/data.db`, from its `fleet_samples` table —
which is where the live data lives. (Its `machine_samples` table exists but is
empty on this build.) Samples arrive every ~10 seconds.

Columns read:

```
host_id, collected_at, cpu_percent, memory_percent, disk_percent,
receive_bytes_per_second, send_bytes_per_second, load1, load5, load15
```

> **Coupling — read this one.** This reads a **third party's private schema**.
> Unlike the sibling providers for `usage` and `lanes`, the owner here is not
> the author of this plugin and owes it nothing: a future host-monitor release
> may rename or drop these columns.
>
> Two things make that survivable:
>
> 1. **Every read is defensive.** There is no `SELECT *`; the columns are named
>    explicitly, so a rename throws and produces a visible "schema changed"
>    label instead of silently rendering wrong numbers. A missing table, a
>    missing column, and a missing row all degrade visibly.
> 2. **The bar keeps its built-in host reader**, so disabling this plugin
>    returns the topic to a working reading.
>
> Pin host-monitor to a version if you want the schema guaranteed.

### Which host is read

`fleet_samples` is keyed by `host_id`, and host-monitor is built for a **fleet**
— it can hold samples for several machines. "Newest row wins" would show a
*remote* machine's CPU as if it were local, which is a quietly wrong number
rather than a missing one.

So this plugin resolves **this machine's own host id** from `<data dir>/host-id`
— the file bb itself writes, which matches `bb machine list` and
`fleet_samples.host_id` exactly — and filters on it.

If that file cannot be read, it falls back to the newest sample from any host
and **says so** in the metric detail (`Newest sample from any host (host_…) -
local host id unresolved.`), so a fleet reading is never mistaken for a local
one.

### Where the data directory comes from

The path is resolved via `bb.server.experimental_dataDir`, not a hardcoded
`~/.bb`. The SDK documents why:

> a plugin that guesses `~/.bb` reads the production file while the dev server
> reads another one.

`~/.bb` remains as a fallback if that accessor is unavailable. The accessor is
bind-gated, so it is read lazily inside a handler rather than during plugin
setup.

## Why not just sample `node:os` here?

Because the point is to use host-monitor's data, and because re-sampling would
be a second, subtly different reading of the same machine — the duplication
problem the section split exists to remove. It also could not include network
throughput, which host-monitor already collects.

## It claims the built-in `host` topic

The Statusbar plugin ships a fallback reader for `host` that samples `node:os`
and `df` itself. Claiming the topic means this plugin **replaces** that reading.

The bar keeps its fallback, so disabling or uninstalling this plugin returns the
slot to the built-in rather than leaving a gap — verified by disabling the
plugin and observing `host` go back to `kind: "builtin"`:

```sh
bb plugin rpc call statusbar providers --json
bb plugin rpc call statusbar snapshot --json   # see `sources`
```

## Design notes

**Metric order and importance.** CPU and MEM are `primary`; DISK and load are
`secondary` so they drop first on a narrow window, matching the built-in's
behavior. NET down is `primary` (it is the direction that stalls work) and NET
up rides in the detail slot, so adding network costs no width.

**Stale sampling is labelled.** host-monitor samples every ~10s, so a stalled
sampler would otherwise leave a plausible-looking stale number on screen with
nothing to indicate it had stopped. Past 2 minutes the detail says how old.

**A traffic spike can read as `0/s`.** host-monitor reports an *instantaneous*
rate, and on an idle machine `0` is the true reading — in one measured hour, 41%
of samples were exactly zero. So the NET value flickers between `0/s` and a
burst figure. That is faithful to the source; a smoothing or peak-hold policy
would be a presentation change and is not done here.

## Development

```sh
npm run typecheck
npm run build
bb plugin install . --yes
bb plugin reload statusbar-host

# Confirm the bar picked it up (up to 10s discovery lag)
bb plugin rpc call statusbar providers --json
bb plugin rpc call statusbar snapshot --json

# Call the section directly, bypassing the bar
bb plugin rpc call statusbar-host section.v1.snapshot --json
```

## License

MIT
