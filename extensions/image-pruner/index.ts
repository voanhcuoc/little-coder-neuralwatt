import type { ExtensionAPI, AgentMessage } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

// Per-model image limits sourced from Neuralwatt /v1/models metadata.
// Maps model id → max_images. Updated when models change.
// Path is relative to this file's parent directory (extensions/image-pruner/).
const CONFIG = JSON.parse(
  require(path.join(__dirname, "max-images.json")) as string,
) as Record<string, number>;

const PLACEHOLDER = "[image pruned: exceeded per-request image limit]";

let currentModel: string | undefined;

/**
 * Resolve the max_images limit for the model being used.
 * Falls back to 4 if the model is unknown (conservative default).
 */
function getMaxImages(modelId: string | undefined): number {
  if (!modelId) return 4;
  if (CONFIG[modelId] !== undefined) return CONFIG[modelId];
  // Strip -fast suffix and retry (not all models have a -fast variant)
  const base = modelId.replace(/-fast$/, "");
  if (base !== modelId && CONFIG[base] !== undefined) {
    return CONFIG[base];
  }
  return 4; // conservative fallback
}

function countImages(messages: AgentMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ((block as any).type === "image") count++;
      }
    }
  }
  return count;
}

function pruneImages(messages: AgentMessage[], maxImages: number): AgentMessage[] {
  const total = countImages(messages);
  if (total <= maxImages) return messages;

  const toPrune = total - maxImages;
  let pruned = 0;

  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    let previousWasPlaceholder = false;
    const newContent = msg.content
      .map((block) => {
        if (pruned >= toPrune) return block;
        if ((block as any).type === "image") {
          if (!previousWasPlaceholder) {
            pruned++;
            previousWasPlaceholder = true;
            return { type: "text", text: PLACEHOLDER };
          }
          pruned++;
          return null; // collapse consecutive images
        }
        previousWasPlaceholder = false;
        return block;
      })
      .filter((b) => b !== null);

    return { ...msg, content: newContent };
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", async (event) => {
    const p = (event as any).payload;
    if (p && typeof p === "object") {
      currentModel = (p as any).model;
    }
  });

  pi.on("context", async (event, _ctx) => {
    const messages = (event as any).messages as AgentMessage[];
    if (!Array.isArray(messages) || messages.length === 0) return;

    const maxImages = getMaxImages(currentModel);

    const imageCount = countImages(messages);
    if (imageCount <= maxImages) return;

    const pruned = pruneImages(messages, maxImages);
    const remaining = countImages(pruned);

    if (remaining < imageCount) {
      return { messages: pruned };
    }
  });
}
