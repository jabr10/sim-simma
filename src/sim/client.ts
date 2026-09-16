// Front-end helper for running simulations.
// Uses a Web Worker when available (Vite bundles it via the new URL(...) pattern),
// and falls back to chunked main-thread runs otherwise.
import { GameSimulator } from "./engine";
import type { SimOptions, SimResult } from "./engine";
import type { GameData } from "./types";
import type { WorkerRequest, WorkerResponse } from "./sim.worker";

export interface RunOptions extends SimOptions {
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

let worker: Worker | null = null;
let counter = 0;

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    return worker;
  } catch {
    return null;
  }
}

export function runSimulation(game: GameData, options: RunOptions = {}): Promise<SimResult> {
  const { onProgress, signal, ...simOptions } = options;
  const w = getWorker();
  if (!w) return runOnMainThread(game, options);

  const id = `sim-${++counter}`;
  return new Promise<SimResult>((resolve, reject) => {
    const cleanup = () => {
      w.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
    };
    const onMessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.id !== id) return;
      if (msg.type === "progress") onProgress?.(msg.progress);
      else if (msg.type === "result") {
        cleanup();
        resolve(msg.result);
      } else if (msg.type === "error") {
        cleanup();
        reject(new Error(msg.message));
      } else if (msg.type === "cancelled") {
        cleanup();
        reject(new DOMException("Simulation cancelled", "AbortError"));
      }
    };
    const onAbort = () => w.postMessage({ type: "cancel", id } satisfies WorkerRequest);

    if (signal?.aborted) {
      reject(new DOMException("Simulation cancelled", "AbortError"));
      return;
    }
    w.addEventListener("message", onMessage);
    signal?.addEventListener("abort", onAbort);
    w.postMessage({ type: "run", id, game, options: simOptions } satisfies WorkerRequest);
  });
}

export async function runOnMainThread(game: GameData, options: RunOptions = {}): Promise<SimResult> {
  const { onProgress, signal, ...simOptions } = options;
  const sim = new GameSimulator(game, simOptions);
  while (!sim.isDone) {
    if (signal?.aborted) throw new DOMException("Simulation cancelled", "AbortError");
    sim.runBatch(400);
    onProgress?.(sim.progress);
    await new Promise((r) => setTimeout(r, 0));
  }
  return sim.finish();
}
