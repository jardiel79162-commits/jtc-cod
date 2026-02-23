import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { GitBranch, Link, Key, Check, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ConnectRepoProps {
  userId: string;
  onConnected: () => void;
}

const ConnectRepo = ({ userId, onConnected }: ConnectRepoProps) => {
  const [repoUrl, setRepoUrl] = useState("");
  const [token, setToken] = useState("");
  const [isPublicChecked, setIsPublicChecked] = useState(false);
  const [hasRepoPermission, setHasRepoPermission] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const parseRepoUrl = (url: string) => {
    const match = url.match(/github\.com\/([^/]+)\/([^/\s]+)/);
    if (!match) return null;
    return { owner: match[1], name: match[2].replace(/\.git$/, "") };
  };

  const handleConnect = async () => {
    const parsed = parseRepoUrl(repoUrl);
    if (!parsed) {
      toast({ title: "URL inválida", description: "Insira uma URL válida do GitHub.", variant: "destructive" });
      return;
    }

    if (!isPublicChecked || !hasRepoPermission) {
      toast({ title: "Confirmação necessária", description: "Marque os checkboxes.", variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      // Validate repo is public
      const repoRes = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.name}`);
      if (!repoRes.ok) throw new Error("Repositório não encontrado.");
      const repoData = await repoRes.json();
      if (repoData.private) throw new Error("O repositório é privado. Use apenas repositórios públicos.");

      // Validate token
      const tokenRes = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!tokenRes.ok) throw new Error("Token inválido.");

      // Save repository
      const { error } = await supabase.from("repositories").insert({
        user_id: userId,
        repo_url: repoUrl,
        repo_owner: parsed.owner,
        repo_name: parsed.name,
        github_token: token,
      });

      if (error) throw error;

      toast({ title: "Conectado!", description: `${parsed.owner}/${parsed.name} está pronto.` });
      onConnected();
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <GitBranch className="h-12 w-12 text-primary mx-auto mb-4" />
          <h2 className="text-2xl font-mono font-bold text-foreground mb-2">Conectar Repositório</h2>
          <p className="text-muted-foreground text-sm font-mono">
            Conecte um repositório público do GitHub para começar
          </p>
        </div>

        <div className="bg-card border border-border rounded-lg p-6 space-y-5">
          <div>
            <label className="text-sm font-mono text-muted-foreground mb-1.5 flex items-center gap-2">
              <Link className="h-3.5 w-3.5" /> Link do Repositório
            </label>
            <Input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/usuario/repositorio"
              className="bg-muted border-border font-mono text-sm"
            />
          </div>

          <div>
            <label className="text-sm font-mono text-muted-foreground mb-1.5 flex items-center gap-2">
              <Key className="h-3.5 w-3.5" /> GitHub Token (Personal Access Token)
            </label>
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              className="bg-muted border-border font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1 font-mono">
              O token deve ter a permissão <span className="text-primary">repo</span>
            </p>
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            <label className="flex items-center gap-3 cursor-pointer">
              <Checkbox checked={isPublicChecked} onCheckedChange={(v) => setIsPublicChecked(v === true)} />
              <span className="text-sm font-mono text-secondary-foreground">O repositório é público</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <Checkbox checked={hasRepoPermission} onCheckedChange={(v) => setHasRepoPermission(v === true)} />
              <span className="text-sm font-mono text-secondary-foreground">O token possui permissão <span className="text-primary">repo</span></span>
            </label>
          </div>

          <Button
            onClick={handleConnect}
            disabled={loading || !repoUrl || !token}
            className="w-full font-mono"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Validando...
              </>
            ) : (
              <>
                <Check className="h-4 w-4 mr-2" />
                Conectar Repositório
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ConnectRepo;
