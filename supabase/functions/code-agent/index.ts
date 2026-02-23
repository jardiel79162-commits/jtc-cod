import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function getDefaultBranch(owner: string, name: string, token: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) throw new Error("Cannot access repository");
  const data = await res.json();
  return data.default_branch || "main";
}

async function getRepoTree(owner: string, name: string, branch: string, token: string) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/git/trees/${branch}?recursive=1`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) throw new Error("Cannot read repo tree");
  return res.json();
}

async function getFileContent(owner: string, name: string, path: string, token: string) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.encoding === "base64") {
    try {
      return { content: decodeURIComponent(escape(atob(data.content.replace(/\n/g, "")))), sha: data.sha, path: data.path };
    } catch {
      return { content: atob(data.content.replace(/\n/g, "")), sha: data.sha, path: data.path };
    }
  }
  return null;
}

async function updateFile(owner: string, name: string, path: string, content: string, sha: string, message: string, branch: string, token: string) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`, {
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
      branch,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to update ${path}: ${err}`);
  }
  return res.json();
}

async function createFile(owner: string, name: string, path: string, content: string, message: string, branch: string, token: string) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      branch,
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

    // 1. Get default branch and repo structure
    const branch = await getDefaultBranch(repo_owner, repo_name, github_token);
    const tree = await getRepoTree(repo_owner, repo_name, branch, github_token);
    const allFiles = tree.tree
      ?.filter((f: any) => f.type === "blob")
      ?.map((f: any) => f.path) || [];

    // 2. Step 1: Ask AI which files are relevant to the user's request
    const fileSelectionPrompt = `You are analyzing a GitHub repository to determine which files are relevant to a user's request.

REPOSITORY: ${repo_owner}/${repo_name}
BRANCH: ${branch}

ALL FILES IN REPOSITORY:
${allFiles.join("\n")}

USER REQUEST: "${message}"

Return ONLY a JSON array of file paths that are relevant to this request. Select the files that would need to be read or modified.
Maximum 15 files. Be smart - if the user mentions "cor principal" or "primary color", look for CSS/SCSS/theme files. If they mention a "botão" look for button components. If they mention "header" or "footer" look for layout files.

Return format: ["path/to/file1.ext", "path/to/file2.ext"]
Return ONLY the JSON array, nothing else.`;

    const selectionRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: fileSelectionPrompt }],
        temperature: 0.1,
      }),
    });

    if (!selectionRes.ok) {
      if (selectionRes.status === 429) {
        return new Response(JSON.stringify({ error: "Limite de requisições excedido. Tente novamente em alguns segundos." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (selectionRes.status === 402) {
        return new Response(JSON.stringify({ error: "Créditos esgotados. Adicione mais créditos." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error("AI gateway error on file selection");
    }

    const selectionData = await selectionRes.json();
    let selectedRaw = selectionData.choices?.[0]?.message?.content || "[]";
    selectedRaw = selectedRaw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    
    let selectedFiles: string[] = [];
    try {
      selectedFiles = JSON.parse(selectedRaw);
    } catch {
      // Fallback: grab common files
      const codeExtensions = [".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".json", ".py", ".vue", ".svelte", ".scss", ".sass", ".less"];
      selectedFiles = allFiles.filter((f: string) => codeExtensions.some((ext) => f.endsWith(ext))).slice(0, 10);
    }

    // 3. Load selected files
    const fileContents: { path: string; content: string; sha: string }[] = [];
    for (const filePath of selectedFiles) {
      if (!allFiles.includes(filePath)) continue;
      const file = await getFileContent(repo_owner, repo_name, filePath, github_token);
      if (file && file.content.length < 15000) {
        fileContents.push(file);
      }
    }

    const fileContext = fileContents
      .map((f) => `--- ${f.path} ---\n${f.content}`)
      .join("\n\n");

    // 4. Step 2: Ask AI to make changes
    const systemPrompt = `Você é o JTC COD, um agente inteligente de edição de código. Você analisa repositórios GitHub e faz modificações precisas no código.

REPOSITÓRIO: ${repo_owner}/${repo_name}
BRANCH: ${branch}

ESTRUTURA DE ARQUIVOS:
${allFiles.join("\n")}

CONTEÚDO DOS ARQUIVOS RELEVANTES:
${fileContext}

INSTRUÇÕES:
- Analise cuidadosamente o pedido do usuário
- Identifique EXATAMENTE quais arquivos precisam ser modificados
- Faça APENAS as modificações solicitadas, nada mais
- Mantenha todo o resto do código intacto
- Retorne sua resposta como JSON com esta estrutura exata:
{
  "explanation": "Explicação curta e natural do que foi feito, SEM mostrar código. Exemplo: 'Pronto! Alterei a cor principal do site de vermelho para azul no arquivo styles.css.' ou 'Adicionei um footer simples com links de contato na página principal.'",
  "changes": [
    {
      "path": "caminho/do/arquivo.ext",
      "action": "update" | "create",
      "content": "conteúdo COMPLETO do arquivo com as modificações aplicadas"
    }
  ],
  "commit_message": "mensagem curta do commit em inglês"
}

REGRAS CRÍTICAS:
- A "explanation" deve ser uma resposta NATURAL e CURTA em português, como se fosse uma pessoa falando. NÃO inclua trechos de código na explicação. Apenas diga o que foi feito de forma simples.
- O "content" de cada change deve conter o arquivo INTEIRO com as modificações, não apenas as partes alteradas
- Só modifique os arquivos necessários para atender ao pedido
- Mantenha boas práticas de código
- Nunca delete arquivos críticos
- Se o pedido é apenas uma pergunta, retorne changes como array vazio
- SEMPRE retorne JSON válido`;

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
    rawContent = rawContent.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return new Response(JSON.stringify({
        response: rawContent,
        files_changed: [],
        commit_sha: null,
        commit_message: null,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 5. Apply changes to GitHub
    let lastCommitSha = null;
    const filesChanged: string[] = [];
    const errors: string[] = [];

    if (parsed.changes && parsed.changes.length > 0) {
      for (const change of parsed.changes) {
        try {
          if (change.action === "update") {
            // Always fetch fresh SHA to avoid conflicts
            const file = await getFileContent(repo_owner, repo_name, change.path, github_token);
            if (file) {
              const result = await updateFile(
                repo_owner, repo_name, change.path, change.content,
                file.sha, parsed.commit_message || "update via JTC COD", branch, github_token
              );
              lastCommitSha = result.commit?.sha;
              filesChanged.push(change.path);
            } else {
              errors.push(`Arquivo não encontrado: ${change.path}`);
            }
          } else if (change.action === "create") {
            const result = await createFile(
              repo_owner, repo_name, change.path, change.content,
              parsed.commit_message || "create via JTC COD", branch, github_token
            );
            lastCommitSha = result.commit?.sha;
            filesChanged.push(change.path);
          }
        } catch (e) {
          console.error(`Error applying change to ${change.path}:`, e);
          errors.push(`Erro em ${change.path}: ${e instanceof Error ? e.message : "unknown"}`);
        }
      }
    }

    let response = parsed.explanation || "Pronto!";
    if (filesChanged.length > 0) {
      response += `\n\n✅ Arquivos alterados: ${filesChanged.join(", ")}`;
      if (lastCommitSha) {
        response += `\n📦 Commit: ${lastCommitSha.slice(0, 7)}`;
      }
    }
    if (errors.length > 0) {
      response += `\n\n⚠️ Problemas: ${errors.join("; ")}`;
    }

    return new Response(JSON.stringify({
      response,
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
