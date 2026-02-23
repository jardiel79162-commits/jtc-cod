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
  if (!res.ok) throw new Error("Não consegui acessar o repositório. Verifique se o token é válido.");
  const data = await res.json();
  return data.default_branch || "main";
}

async function getRepoTree(owner: string, name: string, branch: string, token: string) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/git/trees/${branch}?recursive=1`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) throw new Error(`Não consegui ler a árvore do repositório na branch ${branch}`);
  return res.json();
}

async function getFileContent(owner: string, name: string, path: string, token: string) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) {
    console.error(`Failed to get file ${path}: ${res.status}`);
    return null;
  }
  const data = await res.json();
  if (data.encoding === "base64") {
    try {
      const raw = atob(data.content.replace(/\n/g, ""));
      return { content: decodeURIComponent(escape(raw)), sha: data.sha, path: data.path };
    } catch {
      return { content: atob(data.content.replace(/\n/g, "")), sha: data.sha, path: data.path };
    }
  }
  return null;
}

async function commitFile(
  owner: string, name: string, path: string, content: string,
  sha: string | null, message: string, branch: string, token: string
) {
  const body: any = {
    message,
    content: btoa(unescape(encodeURIComponent(content))),
    branch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`GitHub API error for ${path} [${res.status}]: ${errText}`);
    throw new Error(`Falha ao salvar ${path} no GitHub (status ${res.status})`);
  }
  return res.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { message, repo_owner, repo_name, github_token, history } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Step 1: Determine if this is a code change request or just conversation
    const intentRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          {
            role: "system",
            content: `Analyze the user message and determine if they want to modify code in a GitHub repository, or if they just want to chat/ask a question.
Return ONLY "code" if they want code changes, or "chat" if they just want to talk.
Examples of "code": "muda a cor para azul", "adiciona um footer", "refatora o componente", "cria um novo arquivo"
Examples of "chat": "o que você acha de React?", "me explica como funciona CSS", "oi tudo bem?", "quero criar um novo repositório"`,
          },
          { role: "user", content: message },
        ],
        temperature: 0,
        max_tokens: 10,
      }),
    });

    if (!intentRes.ok) throw new Error("Erro ao processar sua mensagem");
    const intentData = await intentRes.json();
    const intent = (intentData.choices?.[0]?.message?.content || "").trim().toLowerCase();

    // CHAT MODE: Just respond naturally
    if (intent !== "code") {
      const chatRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [
            {
              role: "system",
              content: `Você é o JTC COD, um assistente inteligente de programação. Você conversa de forma natural, amigável e direta em português brasileiro.

Você está conectado ao repositório GitHub: ${repo_owner}/${repo_name}

Você pode:
- Conversar sobre qualquer assunto
- Tirar dúvidas sobre programação
- Dar sugestões sobre o projeto
- Explicar conceitos técnicos
- Ajudar a planejar features

Quando o usuário quiser que você modifique o código, ele vai pedir diretamente. Aí sim você age.

Seja natural, como um amigo programador. Não seja robótico. Use emojis quando fizer sentido.`,
            },
            ...(history || []),
            { role: "user", content: message },
          ],
          temperature: 0.7,
        }),
      });

      if (!chatRes.ok) {
        if (chatRes.status === 429) return new Response(JSON.stringify({ error: "Muitas requisições, espera um pouquinho! 😅" }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        if (chatRes.status === 402) return new Response(JSON.stringify({ error: "Créditos esgotados 😢" }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        throw new Error("Erro na IA");
      }

      const chatData = await chatRes.json();
      const chatResponse = chatData.choices?.[0]?.message?.content || "Desculpa, não entendi. Pode repetir?";

      return new Response(JSON.stringify({
        response: chatResponse,
        files_changed: [],
        commit_sha: null,
        commit_message: null,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // CODE MODE: Analyze repo, find files, make changes, commit
    console.log(`[CODE MODE] User wants code changes: "${message}"`);

    const branch = await getDefaultBranch(repo_owner, repo_name, github_token);
    const tree = await getRepoTree(repo_owner, repo_name, branch, github_token);
    const allFiles = tree.tree
      ?.filter((f: any) => f.type === "blob")
      ?.map((f: any) => f.path) || [];

    console.log(`[CODE MODE] Found ${allFiles.length} files in ${branch}`);

    // Step 2: Ask AI which files to load
    const selectionRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{
          role: "user",
          content: `Repository files:\n${allFiles.join("\n")}\n\nUser request: "${message}"\n\nReturn a JSON array of file paths that are relevant to this request. Max 15 files. Only return the JSON array, nothing else.\nExample: ["src/App.css", "src/index.html"]`,
        }],
        temperature: 0.1,
      }),
    });

    let selectedFiles: string[] = [];
    if (selectionRes.ok) {
      const selData = await selectionRes.json();
      let raw = selData.choices?.[0]?.message?.content || "[]";
      raw = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      try { selectedFiles = JSON.parse(raw); } catch { /* fallback below */ }
    }

    if (selectedFiles.length === 0) {
      const codeExts = [".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".json", ".py", ".vue", ".svelte", ".scss"];
      selectedFiles = allFiles.filter((f: string) => codeExts.some((ext) => f.endsWith(ext))).slice(0, 12);
    }

    console.log(`[CODE MODE] Selected files: ${selectedFiles.join(", ")}`);

    // Step 3: Load file contents
    const fileContents: { path: string; content: string; sha: string }[] = [];
    for (const fp of selectedFiles) {
      if (!allFiles.includes(fp)) continue;
      const file = await getFileContent(repo_owner, repo_name, fp, github_token);
      if (file && file.content.length < 20000) {
        fileContents.push(file);
      }
    }

    console.log(`[CODE MODE] Loaded ${fileContents.length} files`);

    const fileContext = fileContents.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n\n");

    // Step 4: Ask AI to generate changes
    const codeRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `Você é o JTC COD, agente de edição de código. Você modifica código em repositórios GitHub.

REPOSITÓRIO: ${repo_owner}/${repo_name} (branch: ${branch})

TODOS OS ARQUIVOS:
${allFiles.join("\n")}

CONTEÚDO DOS ARQUIVOS CARREGADOS:
${fileContext}

Retorne APENAS um JSON válido com esta estrutura:
{
  "explanation": "frase curta e natural explicando o que você fez, SEM código",
  "changes": [
    {
      "path": "caminho/arquivo.ext",
      "action": "update",
      "content": "CONTEÚDO COMPLETO DO ARQUIVO INTEIRO COM AS MUDANÇAS"
    }
  ],
  "commit_message": "mensagem curta em inglês tipo: fix: change primary color"
}

REGRAS:
1. O campo "content" DEVE conter o arquivo INTEIRO, não só a parte modificada
2. Faça SOMENTE o que o usuário pediu, nada a mais
3. A "explanation" deve ser natural e curta, sem código
4. Se precisar criar arquivo novo, use action "create"
5. NUNCA retorne nada além do JSON`,
          },
          ...(history || []),
          { role: "user", content: message },
        ],
        temperature: 0.15,
      }),
    });

    if (!codeRes.ok) {
      if (codeRes.status === 429) return new Response(JSON.stringify({ error: "Muitas requisições, espera um pouquinho!" }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      if (codeRes.status === 402) return new Response(JSON.stringify({ error: "Créditos esgotados." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      throw new Error("Erro na IA ao gerar mudanças");
    }

    const codeData = await codeRes.json();
    let rawContent = codeData.choices?.[0]?.message?.content || "";
    rawContent = rawContent.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

    console.log(`[CODE MODE] AI raw response length: ${rawContent.length}`);

    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch (parseErr) {
      console.error(`[CODE MODE] Failed to parse AI response: ${rawContent.substring(0, 500)}`);
      return new Response(JSON.stringify({
        response: "Desculpa, tive um problema interno ao processar a mudança. Tenta de novo com mais detalhes? 😅",
        files_changed: [],
        commit_sha: null,
        commit_message: null,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Step 5: Apply changes to GitHub
    if (!parsed.changes || parsed.changes.length === 0) {
      return new Response(JSON.stringify({
        response: parsed.explanation || "Não identifiquei nenhuma mudança necessária. Pode detalhar melhor o que quer?",
        files_changed: [],
        commit_sha: null,
        commit_message: null,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let lastCommitSha: string | null = null;
    const filesChanged: string[] = [];
    const errors: string[] = [];

    for (const change of parsed.changes) {
      if (!change.path || !change.content) {
        console.error(`[CODE MODE] Invalid change entry: missing path or content`);
        continue;
      }

      try {
        // Always get fresh SHA right before committing
        const freshFile = await getFileContent(repo_owner, repo_name, change.path, github_token);
        const sha = freshFile?.sha || null;

        console.log(`[CODE MODE] Committing ${change.path} (sha: ${sha ? sha.slice(0, 7) : "new file"}, content length: ${change.content.length})`);

        const result = await commitFile(
          repo_owner, repo_name, change.path, change.content,
          sha, parsed.commit_message || "update via JTC COD", branch, github_token
        );

        lastCommitSha = result.commit?.sha || null;
        filesChanged.push(change.path);
        console.log(`[CODE MODE] ✅ Successfully committed ${change.path} (commit: ${lastCommitSha?.slice(0, 7)})`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[CODE MODE] ❌ Failed to commit ${change.path}: ${errMsg}`);
        errors.push(`${change.path}: ${errMsg}`);
      }
    }

    // Build honest response
    let response = "";
    if (filesChanged.length > 0) {
      response = parsed.explanation || "Modificações aplicadas!";
      response += `\n\n✅ Commitei com sucesso: ${filesChanged.join(", ")}`;
      if (lastCommitSha) response += `\n🔗 Commit: \`${lastCommitSha.slice(0, 7)}\``;
    }

    if (errors.length > 0) {
      if (filesChanged.length === 0) {
        response = `❌ Não consegui fazer as modificações. Erros:\n${errors.map(e => `- ${e}`).join("\n")}\n\nPode ser um problema de permissão do token. Verifica se o token tem a permissão "repo" habilitada.`;
      } else {
        response += `\n\n⚠️ Alguns arquivos falharam:\n${errors.map(e => `- ${e}`).join("\n")}`;
      }
    }

    if (!response) {
      response = "Algo deu errado, não consegui processar. Tenta de novo?";
    }

    return new Response(JSON.stringify({
      response,
      files_changed: filesChanged,
      commit_sha: lastCommitSha,
      commit_message: parsed.commit_message,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    console.error("code-agent error:", e);
    const msg = e instanceof Error ? e.message : "Erro desconhecido";
    return new Response(JSON.stringify({ error: `Erro: ${msg}` }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
