import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createProvider, type ChatMessage } from "../lib/ai/provider";
import { buildSystemPrompt } from "../lib/ai/system-prompt";
import { supabaseAdmin } from "../lib/supabase-server";
import { isKillSwitchActive, logActivity } from "../lib/guardrails";
import { getEnabledTools } from "../lib/mcp/registry";

const chatInputSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().min(1),
  image: z.string().optional(),
});

function extractKeywords(text: string): string[] {
  const stopwords = new Set([
    "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
    "they", "them", "is", "am", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "shall", "can", "need", "dare",
    "a", "an", "the", "and", "or", "but", "if", "then", "so", "for",
    "of", "in", "to", "at", "by", "on", "with", "from", "that", "this",
    "these", "those", "not", "no", "nor", "as", "what", "which", "who",
    "how", "when", "where", "why", "all", "each", "every", "both",
    "few", "more", "most", "other", "some", "such", "than", "too",
    "very", "just", "about", "above", "after", "again", "also", "any",
    "before", "between", "come", "don't", "get", "got", "here", "into",
    "know", "let", "like", "make", "much", "new", "now", "only",
    "out", "over", "really", "right", "said", "same", "see", "tell",
    "think", "thing", "time", "two", "up", "us", "want", "way",
    "well", "give", "going", "back", "still", "even", "though",
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopwords.has(w))
    .slice(0, 15);
}

function getTimeOfDay(): string {
  const hour = new Date().getUTCHours();
  return hour >= 9 && hour < 17 ? "work" : "personal";
}

export const chat = createServerFn({ method: "POST" })
  .validator(chatInputSchema)
  .handler(async ({ data }) => {
    if (isKillSwitchActive()) {
      return { text: "Operation halted by kill switch.", inferredPattern: undefined };
    }

    const { message, sessionId, image } = data;
    const provider = createProvider();

    // ── Step 1: Parallel DB reads ──────────────────────────────
    const keywords = extractKeywords(message);

    const [memoriesResult, behaviorsResult, historyResult] = await Promise.all([
      supabaseAdmin
        .from("memory")
        .select("*")
        .order("last_accessed", { ascending: false })
        .limit(50),
      supabaseAdmin
        .from("learned_behaviors")
        .select("*")
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("messages")
        .select("role, content")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    // Include all memories (up to limit). The model determines relevance from context.
    // With 50 short memories max, this is well within token limits.
    const allMemories = memoriesResult.data ?? [];
    const relevantMemories = allMemories.slice(0, 10);

    console.log("[Chat] Query keywords:", keywords);
    console.log("[Chat] Total memories:", allMemories.length, "| Injecting:", relevantMemories.length, "into context");
    for (const m of relevantMemories) {
      console.log("[Chat]   Memory:", m.content?.substring(0, 60), "| keywords:", JSON.stringify(m.relevance_keywords));
    }

    // Update last_accessed on relevant memories (fire-and-forget)
    if (relevantMemories.length > 0) {
      supabaseAdmin
        .from("memory")
        .update({ last_accessed: new Date().toISOString() })
        .in("id", relevantMemories.map((m) => m.id));
    }

    const learnedBehaviors = behaviorsResult.data ?? [];

    // Build messages array for GLM
    const systemPrompt = buildSystemPrompt({
      memories: relevantMemories,
      learnedBehaviors,
      timeOfDay: getTimeOfDay(),
    });

    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

    const history = historyResult.data ?? [];
    const chronological = [...history].reverse();
    for (const msg of chronological) {
      const role = msg.role as "user" | "assistant" | "system";
      messages.push({ role, content: msg.content });
    }

    if (image) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: message },
          { type: "image_url", image_url: { url: image } },
        ],
      });
    } else {
      messages.push({ role: "user", content: message });
    }

    // ── Step 2: Save user message + call LLM in parallel ───────
    // Local Ollama backend (2026-09): single model for all requests.
    // Previous Z.ai models: image ? "glm-4.6v-flash" : "glm-4.7-flash"
    const model = "qwen2.5:14b";

    console.log("[Chat] User message:", message.substring(0, 100));

    const [, result] = await Promise.all([
      supabaseAdmin.from("messages").insert({
        session_id: sessionId,
        role: "user",
        content: message,
        image_url: image ?? null,
      }).then((r) => {
        if (r.error) console.error("[DB] messages (user) FAILED:", r.error.message);
        else console.log("[DB] messages (user) OK");
        return r;
      }),
      provider.chat({ messages, model }),
    ]);

    // ── Step 3: Log what the model returned ────────────────────
    console.log("[Chat] Response:", result.content.substring(0, 150));
    console.log("[Chat] Metadata:", result.metadata ? JSON.stringify(result.metadata) : "NONE");

    // ── Step 4: Post-GLM writes — each logged individually ─────
    const writes: { label: string; promise: Promise<unknown> }[] = [
      {
        label: "messages (assistant)",
        promise: Promise.resolve(supabaseAdmin.from("messages").insert({
          session_id: sessionId,
          role: "assistant",
          content: result.content,
        }).then((r) => {
          if (r.error) console.error("[DB] messages (assistant) FAILED:", r.error.message);
          else console.log("[DB] messages (assistant) OK");
          return r;
        })),
      },
      {
        label: "activity_log",
        promise: logActivity({
          toolName: "chat.respond",
          input: { message, model, hasImage: !!image },
          result: { responseLength: result.content.length, hasMetadata: !!result.metadata },
        }).then(() => console.log("[DB] activity_log OK")).catch((e: unknown) => {
          console.error("[DB] activity_log FAILED:", e);
        }),
      },
    ];

    // Save corrections to learned_behaviors
    console.log("[Chat] Correction data:", JSON.stringify(result.metadata?.correction));
    if (result.metadata?.correction?.behavior) {
      console.log("[Chat] Saving correction:", result.metadata.correction.behavior);
      writes.push({
        label: "learned_behaviors (correction)",
        promise: Promise.resolve(supabaseAdmin.from("learned_behaviors").insert({
          behavior: result.metadata.correction.behavior,
          source: "user_correction",
        }).then((r) => {
          if (r.error) console.error("[DB] learned_behaviors FAILED:", r.error.message);
          else console.log("[DB] learned_behaviors OK");
          return r;
        })),
      });
    }

    // Save memories
    console.log("[Chat] Memory data:", JSON.stringify(result.metadata?.memory));
    if (result.metadata?.memory && Array.isArray(result.metadata.memory) && result.metadata.memory.length > 0) {
      for (const mem of result.metadata.memory) {
        if (!mem.fact) {
          console.warn("[Chat] Skipping memory entry with no fact:", JSON.stringify(mem));
          continue;
        }
        console.log("[Chat] Saving memory:", mem.fact, "| category:", mem.category ?? "general");
        const memKeywords = extractKeywords(mem.fact);
        writes.push({
          label: "memory: " + mem.fact.substring(0, 40),
          promise: Promise.resolve(supabaseAdmin.from("memory").insert({
            content: mem.fact,
            category: mem.category ?? "general",
            relevance_keywords: memKeywords,
            last_accessed: new Date().toISOString(),
          }).then((r) => {
            if (r.error) console.error("[DB] memory FAILED:", r.error.message, "fact:", mem.fact);
            else console.log("[DB] memory OK:", mem.fact.substring(0, 50));
            return r;
          })),
        });
      }
    } else if (result.metadata?.memory && Array.isArray(result.metadata.memory)) {
      console.log("[Chat] Memory array was empty — model did not identify any facts to save");
    }

    // Execute all writes and log results
    const results = await Promise.allSettled(writes.map((w) => w.promise));
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const w = writes[i];
        if (w) console.error("[DB] Write '" + w.label + "' REJECTED:", r.reason);
      }
    });

    return {
      text: result.content,
      inferredPattern: result.metadata?.inferredPattern,
    };
  });
