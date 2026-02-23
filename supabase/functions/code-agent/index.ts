import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function getRepoTree(owner: string, name: string, token: string) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/git/trees/main?recursive=1`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) {
    // Try master branch
    const res2 = await fetch(`https://api.github.com/repos/${owner}/${name}/git/trees/master?recursive=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
    });
    if (!res2.ok) throw new Error("Cannot read repo tree");
    return res2.json();
  }
  return res.json();
}

async function getFileContent(owner: string, name: string, path: string, token: string) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.encoding === "base64") {
    return { content: atob(data.content), sha: data.sha, path: data.path };
  }
  return null;
}

async function updateFile(owner: string, name: string, path: string, content: string, sha: string, message: string, token: string) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      sha,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to update ${path}: ${err}`);
  }
  return res.json();
}

async function createFile(owner: string, name: string, path: string, content: string, message: string, token: string) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: btoa(unescape(encodeURIComponent(content))),
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create ${path}: ${err}`);
  }
  return res.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { message, repo_owner, repo_name, github_token, history } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // 1. Get repo structure
    const tree = await getRepoTree(repo_owner, repo_name, github_token);
    const files = tree.tree
      ?.filter((f: any) => f.type === "blob")
      ?.map((f: any) => f.path)
      ?.slice(0, 200) || [];

    // 2. Identify relevant files (read up to 5 key files)
    const codeExtensions = [".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".json", ".md", ".py", ".vue", ".svelte"];
    const relevantFiles = files
      .filter((f: string) => codeExtensions.some((ext) => f.endsWith(ext)))
      .slice(0, 8);

    const fileContents: { path: string; content: string; sha: string }[] = [];
    for (const filePath of relevantFiles) {
      const file = await getFileContent(repo_owner, repo_name, filePath, github_token);
      if (file && file.content.length < 10000) {
        fileContents.push(file);
      }
    }

    const fileContext = fileContents
      .map((f) => `--- ${f.path} ---\n${f.content}`)
      .join("\n\n");

    // 3. Ask AI what to do
    const systemPrompt = `You are JTC COD, an intelligent code editing agent. You analyze GitHub repositories and make precise code modifications.

REPOSITORY: ${repo_owner}/${repo_name}
FILE STRUCTURE:
${files.join("\n")}

CURRENT FILE CONTENTS:
${fileContext}

INSTRUCTIONS:
- Analyze the user's request carefully
- Determine which files need to be modified
- Return your response as JSON with this exact structure:
{
  "explanation": "Brief explanation in Portuguese of what you did",
  "changes": [
    {
      "path": "file/path.ext",
      "action": "update" | "create",
      "content": "full new file content"
    }
  ],
  "commit_message": "short commit message in English"
}

RULES:
- Only modify files that are necessary
- Keep good coding practices
- Never delete critical files (package.json, index.html, etc.)
- Write the explanation in Portuguese
- If the request is just a question or doesn't require code changes, return changes as empty array
- Always return valid JSON`;

    const aiMessages = [
      { role: "system", content: systemPrompt },
      ...(history || []),
      { role: "user", content: message },
    ];

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: aiMessages,
        temperature: 0.2,
      }),
    });

    if (!aiRes.ok) {
      if (aiRes.status === 429) {
        return new Response(JSON.stringify({ error: "Limite de requisições excedido. Tente novamente." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiRes.status === 402) {
        return new Response(JSON.stringify({ error: "Créditos esgotados. Adicione mais créditos." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error("AI gateway error");
    }

    const aiData = await aiRes.json();
    let rawContent = aiData.choices?.[0]?.message?.content || "";
    
    // Clean markdown code blocks if present
    rawContent = rawContent.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      // If AI didn't return JSON, treat as conversational
      return new Response(JSON.stringify({
        response: rawContent,
        files_changed: [],
        commit_sha: null,
        commit_message: null,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Apply changes to GitHub
    let lastCommitSha = null;
    const filesChanged: string[] = [];

    if (parsed.changes && parsed.changes.length > 0) {
      for (const change of parsed.changes) {
        try {
          if (change.action === "update") {
            const existing = fileContents.find((f) => f.path === change.path);
            if (existing) {
              const result = await updateFile(
                repo_owner, repo_name, change.path, change.content,
                existing.sha, parsed.commit_message || "update via JTC COD", github_token
              );
              lastCommitSha = result.commit?.sha;
              filesChanged.push(change.path);
            } else {
              // File exists but wasn't loaded - fetch it
              const file = await getFileContent(repo_owner, repo_name, change.path, github_token);
              if (file) {
                const result = await updateFile(
                  repo_owner, repo_name, change.path, change.content,
                  file.sha, parsed.commit_message || "update via JTC COD", github_token
                );
                lastCommitSha = result.commit?.sha;
                filesChanged.push(change.path);
              }
            }
          } else if (change.action === "create") {
            const result = await createFile(
              repo_owner, repo_name, change.path, change.content,
              parsed.commit_message || "create via JTC COD", github_token
            );
            lastCommitSha = result.commit?.sha;
            filesChanged.push(change.path);
          }
        } catch (e) {
          console.error(`Error applying change to ${change.path}:`, e);
        }
      }
    }

    return new Response(JSON.stringify({
      response: parsed.explanation || "Pronto!",
      files_changed: filesChanged,
      commit_sha: lastCommitSha,
      commit_message: parsed.commit_message,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("code-agent error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
