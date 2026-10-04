/**
 * Model router — classifies each request and selects the optimal model.
 *
 * Classes:
 *   FAST      → quick factual/math/conversational (cheapest, lowest latency)
 *   SMART     → complex reasoning, nuanced analysis
 *   RESEARCH  → deep research, long-context analysis
 *   CODING    → code generation, debugging, technical implementation
 *   VISION    → image/video understanding
 *   AGENT     → multi-step agentic tasks, tool orchestration
 */

export type RouteClass = "FAST" | "SMART" | "RESEARCH" | "CODING" | "VISION" | "AGENT";

export interface RouteResult {
  route: RouteClass;
  model: string;
  reason: string;
}

// Local Ollama backend (2026-09): every class runs qwen2.5:14b, except
// VISION which uses a dedicated local vision model (env-overridable).
const LOCAL_MODEL = "qwen2.5:14b";
const VISION_MODEL = process.env["OLLAMA_VISION_MODEL"] ?? "qwen2.5vl:7b";

const ROUTE_MODEL_MAP: Record<RouteClass, string> = {
  FAST:      LOCAL_MODEL,
  SMART:     LOCAL_MODEL,
  RESEARCH:  LOCAL_MODEL,
  CODING:    LOCAL_MODEL,
  VISION:    VISION_MODEL,
  AGENT:     LOCAL_MODEL,
  // Previous Z.ai mapping, kept for restore:
  // FAST: "glm-4.7-flash", SMART: "glm-4.7", RESEARCH: "glm-5.2",
  // CODING: "glm-5.3-flash", VISION: "glm-4.6v-flash", AGENT: "glm-5.3",
};

interface ClassPattern {
  route: RouteClass;
  patterns: RegExp[];
  keywords: string[];
  reason: string;
}

const CLASS_PATTERNS: ClassPattern[] = [
  {
    route: "VISION",
    patterns: [],
    keywords: ["image", "picture", "photo", "screenshot", "describe this", "look at"],
    reason: "image/vision content detected",
  },
  {
    route: "AGENT",
    patterns: [
      /\b(open|launch|start|close|quit|send|create|schedule|post|deploy)\b.*\b(app|chrome|slack|email|calendar|notion|github|server|finder|terminal|spotify|safari|firefox|vs ?code)\b/i,
      /\b(open|launch)\b.*\b(chrome|firefox|safari|terminal|finder|spotify|music|vs ?code|slack|discord|zoom|teams|notion)\b/i,
      /\b(quit|close|kill)\b.*\b(app|chrome|firefox|safari|terminal|spotify)\b/i,
      /\bwhat are you doing\b/i,
      /\bwhat tasks?\s*(are|is)\s*(running|active|in progress)\b/i,
      /\bwhat(applications?|apps?)\s*(are|is)\s*running\b/i,
      /\b(set|change|adjust|turn|put).+\b(volume|brightness|brightness)\b/i,
      /\b(get|what('s| is)|show|check|read).+\b(volume|battery|ram|storage|disk|memory)\b/i,
      /\blist\b.*\b(files?|folders?|directories|apps?|programs?)\b/i,
      /\b(open|show|find)\b.*\b(downloads?|documents?|desktop|applications?|music|pictures|downloads)\b/i,
      /\bwhat's my battery\b/i,
      /\bhow much (battery|storage|ram|memory|space)\b/i,
    ],
    keywords: ["volume", "brightness", "battery", "storage", "finder", "terminal", "launch", "quit app", "open app", "list apps", "list files"],
    reason: "agentic/action request detected",
  },
  {
    route: "CODING",
    patterns: [
      /\b(code|program|function|class|api|endpoint|component|debug|refactor|implement|build a|fix this|fix the)\b/i,
      /\b(typescript|javascript|python|rust|sql|html|css|react|node)\b/i,
      /\b(compile|deploy|test|lint)\b/i,
      /`{3}/,
    ],
    keywords: [],
    reason: "coding/technical request detected",
  },
  {
    route: "RESEARCH",
    patterns: [
      /\b(research|analyze|compare|evaluate|investigate|deep dive|explore)\b/i,
      /\b(explain in detail|tell me about|how does .* work|what is the history)\b/i,
      /\b(pros? and cons?|trade-?offs?|alternatives?)\b/i,
    ],
    keywords: ["research", "analysis", "deep", "compare", "investigate"],
    reason: "research/analysis request detected",
  },
  {
    route: "SMART",
    patterns: [
      /\b(why|explain|reason|think|consider|suggest|recommend|plan|strategy)\b/i,
      /\b(opinion|thoughts?|perspective|approach|design|architecture)\b/i,
      /\b(would you|should I|what if|how would)\b/i,
    ],
    keywords: [],
    reason: "reasoning/analysis request detected",
  },
];

function classifyRequest(message: string): RouteResult {
  const msg = message.trim();

  for (const cp of CLASS_PATTERNS) {
    for (const p of cp.patterns) {
      if (p.test(msg)) {
        return { route: cp.route, model: ROUTE_MODEL_MAP[cp.route], reason: cp.reason };
      }
    }
    if (cp.keywords.length > 0) {
      const lower = msg.toLowerCase();
      if (cp.keywords.some((k) => lower.includes(k))) {
        return { route: cp.route, model: ROUTE_MODEL_MAP[cp.route], reason: cp.reason };
      }
    }
  }

  if (msg.length > 500) {
    return { route: "SMART", model: ROUTE_MODEL_MAP.SMART, reason: "long message (>500 chars), defaulting to SMART" };
  }

  return { route: "FAST", model: ROUTE_MODEL_MAP.FAST, reason: "simple/short request, using FAST for speed" };
}

export function routeRequest(message: string, hasImage: boolean): RouteResult {
  if (hasImage) {
    return { route: "VISION", model: ROUTE_MODEL_MAP.VISION, reason: "image attached, using VISION model" };
  }
  return classifyRequest(message);
}

export function getModelForRoute(route: RouteClass): string {
  return ROUTE_MODEL_MAP[route];
}
