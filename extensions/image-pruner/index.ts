import type { ExtensionAPI, AgentMessage } from "@earendil-works/pi-coding-agent";

// Prevents "too many images" API errors by pruning excess image content
// blocks from the context before each provider request. Replaces pruned
// images with a text placeholder so the model knows something was there.
//
// Neuralwatt's qwen3.6-35b reports max_images: 4 in its /v1/models metadata,
// but pi doesn't read or enforce that limit. Without this extension, if the
// agent reads 5+ images (via the read tool with image files, or user-
// pasted images), the API returns a 400 error and the agent loop crashes
// — compaction doesn't help because it keeps the recent messages (with all
// their images) intact in the "kept" portion.
//
// This extension hooks the "context" event, which fires before every
// provider request (via runner.emitContext). It counts image content blocks
// across all messages, and if the total exceeds the limit, replaces the
// oldest ones with a text placeholder.
//
// The limit defaults to 4 (Qwen3.6-35B's max_images from the live API).
// Override with LITTLE_CODER_MAX_IMAGES env var. Set to 0 to disable.

const DEFAULT_MAX_IMAGES = 4;
const PLACEHOLDER = "[image pruned: exceeded per-request image limit]";

interface ImageBlock {
  type: "image";
  mimeType?: string;
  data: string;
}

function getMaxImages(): number {
  const v = process.env.LITTLE_CODER_MAX_IMAGES;
  if (v === undefined || v === "") return DEFAULT_MAX_IMAGES;
  const n = parseInt(v, 10);
  if (isNaN(n) || n < 0) return DEFAULT_MAX_IMAGES;
  return n;
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
  let imageCount = 0;
  // Count total images first
  const total = countImages(messages);
  if (total <= maxImages) return messages;

  // How many to prune: keep the newest maxImages, prune the rest
  const toPrune = total - maxImages;
  let pruned = 0;

  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    let previousWasPlaceholder = false;
    const newContent = msg.content.map((block) => {
      if (pruned >= toPrune) return block;
      if ((block as any).type === "image") {
        if (!previousWasPlaceholder) {
          pruned++;
          previousWasPlaceholder = true;
          return { type: "text", text: PLACEHOLDER };
        }
        // Collapse consecutive images into one placeholder
        pruned++;
        return null;
      }
      previousWasPlaceholder = false;
      return block;
    }).filter((b) => b !== null);

    return { ...msg, content: newContent };
  });
}

export default function (pi: ExtensionAPI) {
  const maxImages = getMaxImages();
  if (maxImages === 0) return;

  pi.on("context", async (event, _ctx) => {
    const messages = (event as any).messages as AgentMessage[];
    if (!Array.isArray(messages) || messages.length === 0) return;

    const imageCount = countImages(messages);
    if (imageCount <= maxImages) return;

    const pruned = pruneImages(messages, maxImages);
    const remaining = countImages(pruned);

    if (remaining < imageCount) {
      return { messages: pruned };
    }
  });
}
