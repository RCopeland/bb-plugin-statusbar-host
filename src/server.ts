// bb-plugin-statusbar-host — a Statusbar section provider.
//
// WHAT THIS IS
//
// One discoverable RPC method that returns this machine's resource readout as a
// statusbar section. The Statusbar plugin finds it on its next discovery tick,
// matches it by topic, and prefers it over its own built-in reader.
//
// WHERE THE NUMBERS COME FROM
//
// The `host-monitor` plugin samples this machine every ~10 seconds into its own
// SQLite store. This plugin reads that store and republishes the sample in the
// section protocol's shape. It does not sample `node:os` itself.
//
// That is a deliberate trade. Re-sampling here would be free of another plugin's
// schema, but it would also be a second, subtly different reading of the same
// machine - and it could never include network throughput, which host-monitor
// already collects and the bar's built-in reader does not have at all.
//
// The cost is a coupling to a THIRD PARTY's private schema. See ./section.ts.
//
// IT CLAIMS THE BUILT-IN `host` TOPIC
//
// `host` is one of the topics the bar ships a fallback reader for, so claiming
// it replaces that reading rather than adding a section beside it. The bar keeps
// its fallback, so disabling this plugin degrades to the built-in rather than
// leaving a gap.
//
// There is no dependency to declare and no install order to respect. BB has no
// plugin dependency mechanism at all:
//
//   You owe it:  one discoverable method returning a valid section payload.
//   It owes you: a slot in the row, and correct degradation if you fail.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  SECTION_METHOD_ACTION,
  SECTION_METHOD_SNAPSHOT,
  sectionActionRequestSchema,
  sectionActionResponseSchema,
  sectionSnapshotResponseSchema,
} from "@robcopeland/bb-statusbar-section-protocol";
import { createHostStore, readHostSection, type HostStore } from "./section.js";

export const rpcContract = defineRpcContract({
  [SECTION_METHOD_SNAPSHOT]: {
    input: z.null(),
    output: sectionSnapshotResponseSchema,
    experimental_description: "This machine's CPU, memory, disk, load, and network, as a statusbar section.",
  },
  /**
   * Declared because the bar routes a section's controls back to the plugin
   * that owns them. This section advertises no `actions`, so this exists only
   * to satisfy the contract and to fail clearly if it is ever reached.
   */
  [SECTION_METHOD_ACTION]: {
    input: sectionActionRequestSchema,
    output: sectionActionResponseSchema,
  },
});

export default async function plugin(bb: BbPluginApi) {
  /**
   * Resolved lazily, inside a handler.
   *
   * `bb.server.experimental_dataDir` is bind-gated - reading it before the
   * server is listening throws - so it cannot be read during the plugin
   * factory. The SDK is explicit that this accessor, not a hardcoded `~/.bb`,
   * is the correct way to find bb-managed files: a dev server derives its data
   * dir from its repo root and instance id, so guessing would read the
   * production file while the dev server reads another one.
   */
  let store: HostStore | null = null;

  function getStore(): HostStore {
    if (store === null) {
      let dataDir: string | undefined;
      try {
        dataDir = bb.server.experimental_dataDir;
      } catch {
        // Falls back to ~/.bb inside createHostStore. Better a reading that
        // might be the wrong data dir than no section at all.
        dataDir = undefined;
      }
      store = createHostStore(dataDir === undefined ? {} : { dataDir });
    }
    return store;
  }

  // The bar polls every 3 seconds. This is one indexed lookup against a local
  // SQLite file, so it is answered directly without a cache on top.
  bb.rpc.register(
    rpcContract,
    {
      [SECTION_METHOD_SNAPSHOT]: () => ({
        generatedAt: new Date().toISOString(),
        section: readHostSection(getStore()),
      }),

      [SECTION_METHOD_ACTION]: ({ actionId }) => {
        // Reachable only if the section advertises actions, which it does not.
        throw new Error(`The host section has no "${actionId}" action.`);
      },
    },
    {
      // THE LINE THAT MAKES THIS A PROVIDER. Without it the method is callable
      // by id, but the bar cannot find it by asking the host which plugins
      // publish section methods.
      experimental_discoverable: true,
      experimental_description: "A host resource section for the Statusbar plugin.",
    },
  );

  bb.onDispose(() => {
    store?.close();
    store = null;
  });

  bb.log.info("ready (host provider; reading host-monitor's samples)");
}
