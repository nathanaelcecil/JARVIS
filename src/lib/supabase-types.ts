export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  image_url: string | null;
  created_at: string;
}

export interface Memory {
  id: string;
  content: string;
  category: string;
  relevance_keywords: string[];
  created_at: string;
  last_accessed: string;
}

export interface LearnedBehavior {
  id: string;
  behavior: string;
  source: string;
  created_at: string;
}

export interface ActivityLog {
  id: string;
  tool_name: string;
  input: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  approval_status: string;
  created_at: string;
}
