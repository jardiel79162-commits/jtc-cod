import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Send, GitBranch, GitCommit, Unplug, Loader2, Bot, User,
  FileCode, Undo2, History, X, Clock, ChevronUp,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import ReactMarkdown from "react-markdown";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ChatInterfaceProps {
  repo: {
    id: string;
    repo_owner: string;
    repo_name: string;
    github_token: string;
  };
  onDisconnect: () => void;
}

interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  files_changed?: string[];
  created_at?: string;
}

const ChatInterface = ({ repo, onDisconnect }: ChatInterfaceProps) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [status, setStatus] = useState("");
  const [commits, setCommits] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    loadMessages();
    loadCommits();
  }, [repo.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const loadMessages = async () => {
    const { data } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("repository_id", repo.id)
      .order("created_at", { ascending: true });
    if (data) setMessages(data as Message[]);
  };

  const loadCommits = async () => {
    const { data } = await supabase
      .from("agent_commits")
      .select("*")
      .eq("repository_id", repo.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (data) setCommits(data);
  };

  const undoLastCommit = async () => {
    const undoable = commits.find((c) => c.can_undo);
    if (!undoable) {
      toast({ title: "Nada para desfazer", description: "Nenhum commit disponível para reverter.", variant: "destructive" });
      return;
    }

    setIsUndoing(true);
    try {
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/undo-commit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          commit_sha: undoable.commit_sha,
          repo_owner: repo.repo_owner,
          repo_name: repo.repo_name,
          github_token: repo.github_token,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || "Erro ao desfazer");
      }

      const data = await resp.json();

      await supabase
        .from("agent_commits")
        .update({ can_undo: false })
        .eq("id", undoable.id);

      toast({
        title: "Desfeito!",
        description: `${data.files_reverted?.length || 0} arquivo(s) revertido(s).`,
      });

      loadCommits();
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    } finally {
      setIsUndoing(false);
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { role: "user", content: input.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setStatus("Analisando código...");

    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("chat_messages").insert({
      user_id: user!.id,
      repository_id: repo.id,
      role: "user",
      content: userMessage.content,
    });

    try {
      setStatus("Processando com IA...");

      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/code-agent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          message: userMessage.content,
          repo_owner: repo.repo_owner,
          repo_name: repo.repo_name,
          github_token: repo.github_token,
          history: messages.slice(-10).map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || "Erro do agente");
      }

      const data = await resp.json();

      const assistantMessage: Message = {
        role: "assistant",
        content: data.response,
        files_changed: data.files_changed || [],
      };

      setMessages((prev) => [...prev, assistantMessage]);

      await supabase.from("chat_messages").insert({
        user_id: user!.id,
        repository_id: repo.id,
        role: "assistant",
        content: data.response,
        files_changed: data.files_changed || [],
      });

      if (data.commit_sha) {
        await supabase.from("agent_commits").insert({
          user_id: user!.id,
          repository_id: repo.id,
          commit_sha: data.commit_sha,
          commit_message: data.commit_message || "update via JTC COD",
          files_changed: data.files_changed || [],
        });
        loadCommits();
      }

      setStatus("");
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
      setStatus("");
    } finally {
      setIsLoading(false);
    }
  };

  const lastUndoable = commits.find((c) => c.can_undo);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Top bar with repo info + actions - always visible */}
      <div className="border-b border-border px-4 py-2 flex items-center justify-between bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch className="h-4 w-4 text-primary flex-shrink-0" />
          <span className="font-mono text-xs text-primary truncate">
            {repo.repo_owner}/{repo.repo_name}
          </span>
          <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow flex-shrink-0" />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={undoLastCommit}
            disabled={isUndoing || !lastUndoable}
            className="text-xs font-mono border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            {isUndoing ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <Undo2 className="h-3 w-3 mr-1" />
            )}
            Desfazer
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowHistory(true)}
            className="text-xs font-mono"
          >
            <History className="h-3 w-3 mr-1" />
            Histórico
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDisconnect}
            className="text-xs font-mono text-muted-foreground hover:text-destructive"
          >
            <Unplug className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center">
              <Bot className="h-16 w-16 text-primary/30 mx-auto mb-4" />
              <p className="text-muted-foreground font-mono text-sm">
                Envie uma mensagem para começar.
              </p>
              <p className="text-muted-foreground/50 font-mono text-xs mt-2">
                Ex: "Troca a cor principal para azul" ou "Me explica como funciona React"
              </p>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}>
            {msg.role === "assistant" && (
              <div className="w-8 h-8 rounded bg-primary/20 flex items-center justify-center flex-shrink-0">
                <Bot className="h-4 w-4 text-primary" />
              </div>
            )}
            <div
              className={`max-w-[75%] rounded-lg p-3 ${
                msg.role === "user"
                  ? "bg-primary/20 text-foreground"
                  : "bg-card border border-border"
              }`}
            >
              <div className="prose prose-sm prose-invert max-w-none text-sm font-mono">
                <ReactMarkdown>{msg.content}</ReactMarkdown>
              </div>
              {msg.files_changed && msg.files_changed.length > 0 && (
                <div className="mt-2 pt-2 border-t border-border">
                  <p className="text-xs text-muted-foreground mb-1">Arquivos alterados:</p>
                  {msg.files_changed.map((f, j) => (
                    <span key={j} className="inline-flex items-center gap-1 text-xs text-primary mr-2">
                      <FileCode className="h-3 w-3" /> {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {msg.role === "user" && (
              <div className="w-8 h-8 rounded bg-secondary flex items-center justify-center flex-shrink-0">
                <User className="h-4 w-4 text-secondary-foreground" />
              </div>
            )}
          </div>
        ))}

        {isLoading && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded bg-primary/20 flex items-center justify-center flex-shrink-0">
              <Bot className="h-4 w-4 text-primary" />
            </div>
            <div className="bg-card border border-border rounded-lg p-3">
              <div className="flex items-center gap-2 text-primary font-mono text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                {status}
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage();
          }}
          className="flex gap-2"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Descreva a mudança ou converse..."
            className="bg-muted border-border font-mono text-sm"
            disabled={isLoading}
          />
          <Button type="submit" disabled={isLoading || !input.trim()} size="icon">
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>

      {/* History Dialog */}
      <Dialog open={showHistory} onOpenChange={setShowHistory}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-mono">
              <Clock className="h-5 w-5 text-primary" />
              Histórico completo
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Commits */}
            <div>
              <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">
                Commits ({commits.length})
              </p>
              {commits.length === 0 ? (
                <p className="text-xs text-muted-foreground font-mono">Nenhum commit.</p>
              ) : (
                <div className="space-y-2">
                  {commits.map((c) => (
                    <div
                      key={c.id}
                      className={`border rounded p-3 ${
                        c.can_undo ? "border-border" : "border-border/50 opacity-60"
                      }`}
                    >
                      <p className="text-sm font-mono text-foreground">{c.commit_message}</p>
                      <div className="flex items-center justify-between mt-1">
                        <p className="text-xs text-muted-foreground font-mono">
                          {c.commit_sha?.slice(0, 7)}
                        </p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {new Date(c.created_at).toLocaleString("pt-BR", {
                            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
                          })}
                        </p>
                      </div>
                      {!c.can_undo && (
                        <span className="text-xs font-mono text-destructive/70">revertido</span>
                      )}
                      {c.files_changed?.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {c.files_changed.map((f: string, j: number) => (
                            <span key={j} className="text-xs text-primary/70 font-mono bg-primary/5 px-1 rounded">
                              {f.split("/").pop()}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Messages */}
            <div>
              <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">
                Mensagens ({messages.length})
              </p>
              <div className="space-y-2">
                {messages.map((m, i) => (
                  <div key={i} className="border border-border/50 rounded p-2">
                    <div className="flex items-center gap-1 mb-1">
                      {m.role === "user" ? (
                        <User className="h-3 w-3 text-muted-foreground" />
                      ) : (
                        <Bot className="h-3 w-3 text-primary" />
                      )}
                      <span className="text-xs font-mono text-muted-foreground">
                        {m.role === "user" ? "Você" : "Agente"}
                      </span>
                      {m.created_at && (
                        <span className="text-xs font-mono text-muted-foreground/50 ml-auto">
                          {new Date(m.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-mono text-foreground/80 line-clamp-2">
                      {m.content.slice(0, 150)}{m.content.length > 150 ? "..." : ""}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ChatInterface;
