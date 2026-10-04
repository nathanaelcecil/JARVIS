/**
 * GitHub tool — REST API with a personal access token.
 *
 * Permission tiers:
 *   auto    — read operations (list repos, read files, list issues/PRs)
 *   confirm — write operations (create branch, commit, open PR, comment)
 *   confirm — anything that rewrites history, merges, or deletes (with diff shown)
 *
 * Token: GITHUB_PAT env var, read server-side only, never exposed to browser.
 * API: https://api.github.com (REST v3)
 */

// ── Token management ──

function getToken(): string | null {
  const token = process.env["GITHUB_PAT"] ?? process.env["GITHUB_TOKEN"] ?? null;
  if (!token) {
    console.warn("[GitHub] No GITHUB_PAT or GITHUB_TOKEN env var — GitHub tools will fail");
  }
  return token;
}

// ── Shared fetch wrapper ──

interface GitHubResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

async function githubFetch<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    accept?: string;
    signal?: AbortSignal;
  } = {}
): Promise<GitHubResponse<T>> {
  const token = getToken();
  if (!token) {
    return { ok: false, status: 0, data: null, error: "No GitHub PAT configured. Set GITHUB_PAT env var." };
  }

  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: options.accept ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const fetchOpts: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };

  if (options.body) {
    headers["Content-Type"] = "application/json";
    fetchOpts.body = JSON.stringify(options.body);
  }

  if (options.signal) {
    fetchOpts.signal = options.signal;
  }

  try {
    const res = await fetch(url, fetchOpts);

    // Handle rate limiting
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        const reset = res.headers.get("x-ratelimit-reset");
        const resetTime = reset ? new Date(parseInt(reset) * 1000).toISOString() : "unknown";
        return {
          ok: false,
          status: 403,
          data: null,
          error: `GitHub API rate limit exceeded. Resets at ${resetTime}.`,
        };
      }
    }

    if (res.status === 204) {
      return { ok: true, status: 204, data: null };
    }

    const text = await res.text();
    let data: T | null = null;
    try {
      data = JSON.parse(text) as T;
    } catch {
      // Not JSON
    }

    if (!res.ok) {
      const errMsg = (data as { message?: string })?.message ?? text.slice(0, 500);
      return { ok: false, status: res.status, data, error: `GitHub ${res.status}: ${errMsg}` };
    }

    return { ok: true, status: res.status, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: `GitHub API request failed: ${err instanceof Error ? err.message : err}`,
    };
  }
}

// ── Tool implementations ──

/** List repositories for the authenticated user */
export async function listRepos(args: {
  owner?: string;
  type?: string;
  sort?: string;
  per_page?: number;
}): Promise<{ success: boolean; repos: Array<{ name: string; full_name: string; description: string; url: string; private: boolean }>; error?: string }> {
  const { owner, type = "owner", sort = "updated", per_page = 30 } = args;

  let path: string;
  if (owner) {
    path = `/users/${owner}/repos?type=${type}&sort=${sort}&per_page=${per_page}`;
  } else {
    path = `/user/repos?type=${type}&sort=${sort}&per_page=${per_page}`;
  }

  const res = await githubFetch<Array<{
    name: string;
    full_name: string;
    description: string | null;
    html_url: string;
    private: boolean;
  }>>(path);

  if (!res.ok) {
    return { success: false, repos: [], error: res.error };
  }

  const repos = (res.data ?? []).map((r) => ({
    name: r.name,
    full_name: r.full_name,
    description: r.description ?? "",
    url: r.html_url,
    private: r.private,
  }));

  return { success: true, repos };
}

/** Get a single file from a repo */
export async function getFile(args: {
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}): Promise<{ success: boolean; content?: string; sha?: string; size?: number; error?: string }> {
  const ref = args.ref ?? "HEAD";
  const path = `/repos/${args.owner}/${args.repo}/contents/${args.path}?ref=${ref}`;

  const res = await githubFetch<{
    content: string;
    encoding: string;
    sha: string;
    size: number;
    name: string;
  }>(path, { accept: "application/vnd.github+json" });

  if (!res.ok) {
    return { success: false, error: res.error };
  }

  const data = res.data!;
  if (data.encoding === "base64") {
    return {
      success: true,
      content: Buffer.from(data.content, "base64").toString("utf-8"),
      sha: data.sha,
      size: data.size,
    };
  }

  return { success: true, content: data.content, sha: data.sha, size: data.size };
}

/** List issues for a repo */
export async function listIssues(args: {
  owner: string;
  repo: string;
  state?: string;
  per_page?: number;
}): Promise<{ success: boolean; issues: Array<{ number: number; title: string; state: string; user: string; created_at: string; url: string }>; error?: string }> {
  const { owner, repo, state = "open", per_page = 20 } = args;
  const path = `/repos/${owner}/${repo}/issues?state=${state}&per_page=${per_page}`;

  const res = await githubFetch<Array<{
    number: number;
    title: string;
    state: string;
    user: { login: string };
    created_at: string;
    html_url: string;
    pull_request?: unknown;
  }>>(path);

  if (!res.ok) {
    return { success: false, issues: [], error: res.error };
  }

  // Filter out pull requests (they appear in issues endpoint)
  const issues = (res.data ?? [])
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      user: i.user.login,
      created_at: i.created_at,
      url: i.html_url,
    }));

  return { success: true, issues };
}

/** List pull requests for a repo */
export async function listPullRequests(args: {
  owner: string;
  repo: string;
  state?: string;
  per_page?: number;
}): Promise<{ success: boolean; prs: Array<{ number: number; title: string; state: string; user: string; head: string; base: string; url: string }>; error?: string }> {
  const { owner, repo, state = "open", per_page = 20 } = args;
  const path = `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${per_page}`;

  const res = await githubFetch<Array<{
    number: number;
    title: string;
    state: string;
    user: { login: string };
    head: { ref: string };
    base: { ref: string };
    html_url: string;
  }>>(path);

  if (!res.ok) {
    return { success: false, prs: [], error: res.error };
  }

  const prs = (res.data ?? []).map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    user: pr.user.login,
    head: pr.head.ref,
    base: pr.base.ref,
    url: pr.html_url,
  }));

  return { success: true, prs };
}

/** List recent Actions workflow runs */
export async function listWorkflowRuns(args: {
  owner: string;
  repo: string;
  per_page?: number;
}): Promise<{ success: boolean; runs: Array<{ id: number; name: string; status: string; conclusion: string; head_branch: string; created_at: string; url: string }>; error?: string }> {
  const { owner, repo, per_page = 10 } = args;
  const path = `/repos/${owner}/${repo}/actions/runs?per_page=${per_page}`;

  const res = await githubFetch<{
    workflow_runs: Array<{
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      head_branch: string;
      created_at: string;
      html_url: string;
    }>;
  }>(path);

  if (!res.ok) {
    return { success: false, runs: [], error: res.error };
  }

  const runs = (res.data?.workflow_runs ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion ?? "pending",
    head_branch: r.head_branch,
    created_at: r.created_at,
    url: r.html_url,
  }));

  return { success: true, runs };
}

/** Get logs for a specific workflow run */
export async function getWorkflowRunLogs(args: {
  owner: string;
  repo: string;
  run_id: number;
}): Promise<{ success: boolean; logs?: string; error?: string }> {
  const { owner, repo, run_id } = args;
  const path = `/repos/${owner}/${repo}/actions/runs/${run_id}/logs`;

  const token = getToken();
  if (!token) {
    return { success: false, error: "No GitHub PAT configured" };
  }

  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `GitHub ${res.status}: ${text.slice(0, 500)}` };
    }

    // Logs come as a zip — for now just report the download URL
    return {
      success: true,
      logs: `Logs available at: ${res.url}\nNote: Full log download requires streaming the zip response.`,
    };
  } catch (err) {
    return { success: false, error: `Failed to fetch logs: ${err instanceof Error ? err.message : err}` };
  }
}

/** Create a branch */
export async function createBranch(args: {
  owner: string;
  repo: string;
  branch: string;
  from?: string;
}): Promise<{ success: boolean; ref?: string; error?: string }> {
  const { owner, repo, branch, from = "HEAD" } = args;

  // First get the SHA of the source branch
  const refRes = await githubFetch<{ object: { sha: string } }>(
    `/repos/${owner}/${repo}/git/ref/heads/${from}`
  );

  if (!refRes.ok) {
    return { success: false, error: refRes.error };
  }

  const sha = refRes.data!.object.sha;

  // Create the new ref
  const createRes = await githubFetch<{ ref: string }>(
    `/repos/${owner}/${repo}/git/refs`,
    {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha },
    }
  );

  if (!createRes.ok) {
    return { success: false, error: createRes.error };
  }

  return { success: true, ref: createRes.data!.ref };
}

/** Create or update a file (commit) */
export async function createOrUpdateFile(args: {
  owner: string;
  repo: string;
  path: string;
  message: string;
  content: string;
  branch?: string;
  sha?: string;
}): Promise<{ success: boolean; commit?: { sha: string; message: string; url: string }; error?: string }> {
  const { owner, repo, path, message, content, branch = "main", sha } = args;

  // If no SHA provided, try to get the current one (for updates)
  let fileSha = sha;
  if (!fileSha) {
    const existing = await githubFetch<{ sha: string }>(
      `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`
    );
    if (existing.ok && existing.data) {
      fileSha = existing.data.sha;
    }
  }

  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
  };
  if (fileSha) {
    body.sha = fileSha;
  }

  const res = await githubFetch<{
    commit: { sha: string; message: string; html_url: string };
  }>(`/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    body,
  });

  if (!res.ok) {
    return { success: false, error: res.error };
  }

  return {
    success: true,
    commit: {
      sha: res.data!.commit.sha,
      message: res.data!.commit.message,
      url: res.data!.commit.html_url,
    },
  };
}

/** Create an issue */
export async function createIssue(args: {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
}): Promise<{ success: boolean; issue?: { number: number; title: string; url: string }; error?: string }> {
  const { owner, repo, title, body, labels } = args;

  const issueBody: Record<string, unknown> = { title };
  if (body) issueBody.body = body;
  if (labels && labels.length > 0) issueBody.labels = labels;

  const res = await githubFetch<{
    number: number;
    title: string;
    html_url: string;
  }>(`/repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: issueBody,
  });

  if (!res.ok) {
    return { success: false, error: res.error };
  }

  return {
    success: true,
    issue: {
      number: res.data!.number,
      title: res.data!.title,
      url: res.data!.html_url,
    },
  };
}

/** Create a pull request */
export async function createPullRequest(args: {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  head: string;
  base?: string;
}): Promise<{ success: boolean; pr?: { number: number; title: string; url: string }; error?: string }> {
  const { owner, repo, title, body, head, base = "main" } = args;

  const prBody: Record<string, unknown> = { title, head, base };
  if (body) prBody.body = body;

  const res = await githubFetch<{
    number: number;
    title: string;
    html_url: string;
  }>(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: prBody,
  });

  if (!res.ok) {
    return { success: false, error: res.error };
  }

  return {
    success: true,
    pr: {
      number: res.data!.number,
      title: res.data!.title,
      url: res.data!.html_url,
    },
  };
}

/** Add a comment to an issue or PR */
export async function createComment(args: {
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
}): Promise<{ success: boolean; comment?: { id: number; url: string }; error?: string }> {
  const { owner, repo, issue_number, body } = args;

  const res = await githubFetch<{
    id: number;
    html_url: string;
  }>(`/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
    method: "POST",
    body: { body },
  });

  if (!res.ok) {
    return { success: false, error: res.error };
  }

  return {
    success: true,
    comment: { id: res.data!.id, url: res.data!.html_url },
  };
}

/** Get diff between two commits or branches */
export async function getDiff(args: {
  owner: string;
  repo: string;
  base: string;
  head: string;
}): Promise<{ success: boolean; diff?: string; error?: string }> {
  const { owner, repo, base, head } = args;

  const token = getToken();
  if (!token) {
    return { success: false, error: "No GitHub PAT configured" };
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/compare/${base}...${head}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `GitHub ${res.status}: ${text.slice(0, 500)}` };
    }

    const data = (await res.json()) as { files?: Array<{ patch?: string; filename: string; status: string }> };
    const diff = (data.files ?? [])
      .map((f) => `--- ${f.filename} (${f.status})\n${f.patch ?? "(no patch available)"}`)
      .join("\n\n");

    return { success: true, diff: diff || "No changes in comparison." };
  } catch (err) {
    return { success: false, error: `Failed to get diff: ${err instanceof Error ? err.message : err}` };
  }
}
