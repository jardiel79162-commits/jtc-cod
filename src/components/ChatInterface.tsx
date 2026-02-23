import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, GitBranch, GitCommit, Unplug, Loader2, Bot, User, FileCode } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import ReactMarkdown from "react-markdown";

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
  const [status, setStatus] = useState("");
  const [commits, setCommits] = useState<any[]>([]);
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
      .limit(10);
    if (data) setCommits(data);
  };

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { role: "user", content: input.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setStatus("Analisando código...");

    // Save user message
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

      // Save assistant message
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

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Chat area */}
      <div className="flex-1 flex flex-col">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex-1 flex items-center justify-center h-full">
              <div className="text-center">
                <Bot className="h-16 w-16 text-primary/30 mx-auto mb-4" />
                <p className="text-muted-foreground font-mono text-sm">
                  Envie uma mensagem para começar a editar o código.
                </p>
                <p className="text-muted-foreground/50 font-mono text-xs mt-2">
                  Ex: "Troca a cor principal para azul" ou "Adiciona um footer"
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
              placeholder="Descreva a mudança no código..."
              className="bg-muted border-border font-mono text-sm"
              disabled={isLoading}
            />
            <Button type="submit" disabled={isLoading || !input.trim()} size="icon">
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </div>

      {/* Sidebar */}
      <div className="w-72 border-l border-border bg-card hidden lg:flex flex-col">
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2 mb-3">
            <GitBranch className="h-4 w-4 text-primary" />
            <span className="font-mono text-sm font-bold text-foreground">Repositório</span>
          </div>
          <p className="font-mono text-xs text-primary truncate">
            {repo.repo_owner}/{repo.repo_name}
          </p>
          <div className="flex items-center gap-2 mt-2">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
            <span className="text-xs font-mono text-muted-foreground">Agente ativo</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDisconnect}
            className="w-full mt-3 text-xs font-mono text-muted-foreground hover:text-destructive"
          >
            <Unplug className="h-3 w-3 mr-1" /> Desconectar
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex items-center gap-2 mb-3">
            <GitCommit className="h-4 w-4 text-primary" />
            <span className="font-mono text-sm font-bold text-foreground">Commits recentes</span>
          </div>
          {commits.length === 0 ? (
            <p className="text-xs text-muted-foreground font-mono">Nenhum commit ainda.</p>
          ) : (
            <div className="space-y-3">
              {commits.map((c) => (
                <div key={c.id} className="border border-border rounded p-2">
                  <p className="text-xs font-mono text-foreground truncate">{c.commit_message}</p>
                  <p className="text-[10px] text-muted-foreground font-mono mt-1">
                    {c.commit_sha?.slice(0, 7)} • {new Date(c.created_at).toLocaleDateString("pt-BR")}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;
