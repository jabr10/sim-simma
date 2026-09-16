// Web Worker: runs the simulation off the main thread and streams progress.
/// <reference lib="webworker" />
import { GameSimulator } from "./engine";
import type { SimOptions, SimResult } from "./engine";
import type { GameData } from "./types";

export type WorkerRequest =
  | { type: "run"; id: string; game: GameData; options?: SimOptions }
  | { type: "cancel"; id: string };

export type WorkerResponse =
  | { type: "progress"; id: string; progress: number }
  | { type: "result"; id: string; result: SimResult }
  | { type: "error"; id: string; message: string }
  | { type: "cancelled"; id: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<string>();
const BATCH = 500;

const yieldToEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function run(id: string, game: GameData, options: SimOptions = {}): Promise<void> {
  try {
    const sim = new GameSimulator(game, options);
    while (!sim.isDone) {
      if (cancelled.has(id)) {
        cancelled.delete(id);
        ctx.postMessage({ type: "cancelled", id } satisfies WorkerResponse);
        return;
      }
      sim.runBatch(BATCH);
      ctx.postMessage({ type: "progress", id, progress: sim.progress } satisfies WorkerResponse);
      await yieldToEvents();
    }
    const result = sim.finish();
    const transfer: Transferable[] = [];
    if (result.distributions) {
      // Transfer buffers instead of copying them (copies of 10k-length arrays add up fast).
      const seen = new Set<ArrayBufferLike>();
      const add = (arr: Float32Array | Uint8Array | undefined) => {
        if (arr && !seen.has(arr.buffer)) {
          seen.add(arr.buffer);
          transfer.push(arr.buffer as ArrayBuffer);
        }
      };
      Object.values(result.distributions.players).forEach((p) => Object.values(p).forEach(add));
      Object.values(result.distributions.teams).forEach((t) => Object.values(t).forEach(add));
      Object.values(result.distributions.played).forEach(add);
      add(result.distributions.margin);
    }
    ctx.postMessage({ type: "result", id, result } satisfies WorkerResponse, transfer);
  } catch (err) {
    ctx.postMessage({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === "run") void run(msg.id, msg.game, msg.options);
  else if (msg.type === "cancel") cancelled.add(msg.id);
};
