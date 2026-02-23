import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { commit_sha, repo_owner, repo_name, github_token } = await req.json();

    if (!commit_sha || !repo_owner || !repo_name || !github_token) {
      throw new Error("Missing required parameters");
    }

    // Get the commit details
    const commitRes = await fetch(
      `https://api.github.com/repos/${repo_owner}/${repo_name}/commits/${commit_sha}`,
      { headers: { Authorization: `Bearer ${github_token}`, Accept: "application/vnd.github.v3+json" } }
    );
    if (!commitRes.ok) throw new Error("Could not fetch commit details");
    const commitData = await commitRes.json();

    // Get parent commit SHA
    const parentSha = commitData.parents?.[0]?.sha;
    if (!parentSha) throw new Error("Cannot revert: no parent commit found");

    // For each file changed in the commit, restore from parent
    const filesReverted: string[] = [];

    for (const file of commitData.files || []) {
      try {
        if (file.status === "added") {
          // Delete file that was added
          const currentRes = await fetch(
            `https://api.github.com/repos/${repo_owner}/${repo_name}/contents/${file.filename}`,
            { headers: { Authorization: `Bearer ${github_token}`, Accept: "application/vnd.github.v3+json" } }
          );
          if (currentRes.ok) {
            const currentData = await currentRes.json();
            await fetch(
              `https://api.github.com/repos/${repo_owner}/${repo_name}/contents/${file.filename}`,
              {
                method: "DELETE",
                headers: {
                  Authorization: `Bearer ${github_token}`,
                  Accept: "application/vnd.github.v3+json",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  message: `revert: undo ${file.filename}`,
                  sha: currentData.sha,
                }),
              }
            );
            filesReverted.push(file.filename);
          }
        } else {
          // Restore file content from parent commit
          const parentFileRes = await fetch(
            `https://api.github.com/repos/${repo_owner}/${repo_name}/contents/${file.filename}?ref=${parentSha}`,
            { headers: { Authorization: `Bearer ${github_token}`, Accept: "application/vnd.github.v3+json" } }
          );
          
          if (parentFileRes.ok) {
            const parentFileData = await parentFileRes.json();
            // Get current file SHA
            const currentRes = await fetch(
              `https://api.github.com/repos/${repo_owner}/${repo_name}/contents/${file.filename}`,
              { headers: { Authorization: `Bearer ${github_token}`, Accept: "application/vnd.github.v3+json" } }
            );
            if (currentRes.ok) {
              const currentData = await currentRes.json();
              await fetch(
                `https://api.github.com/repos/${repo_owner}/${repo_name}/contents/${file.filename}`,
                {
                  method: "PUT",
                  headers: {
                    Authorization: `Bearer ${github_token}`,
                    Accept: "application/vnd.github.v3+json",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    message: `revert: undo changes to ${file.filename}`,
                    content: parentFileData.content.replace(/\n/g, ""),
                    sha: currentData.sha,
                  }),
                }
              );
              filesReverted.push(file.filename);
            }
          }
        }
      } catch (fileErr) {
        console.error(`Error reverting ${file.filename}:`, fileErr);
      }
    }

    return new Response(
      JSON.stringify({ success: true, files_reverted: filesReverted }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("undo-commit error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
