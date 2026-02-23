import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import ConnectRepo from "@/components/ConnectRepo";
import ChatInterface from "@/components/ChatInterface";
import { Terminal, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

const Dashboard = () => {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const [activeRepo, setActiveRepo] = useState<any>(null);
  const [loadingRepo, setLoadingRepo] = useState(true);

  useEffect(() => {
    if (!loading && !user) {
      navigate("/auth");
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    if (user) {
      fetchActiveRepo();
    }
  }, [user]);

  const fetchActiveRepo = async () => {
    const { data } = await supabase
      .from("repositories")
      .select("*")
      .eq("user_id", user!.id)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setActiveRepo(data);
    setLoadingRepo(false);
  };

  const handleDisconnect = async () => {
    if (activeRepo) {
      await supabase
        .from("repositories")
        .update({ is_active: false })
        .eq("id", activeRepo.id);
      setActiveRepo(null);
    }
  };

  if (loading || loadingRepo) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-primary font-mono animate-pulse-glow">Carregando...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal className="h-6 w-6 text-primary" />
          <span className="font-mono font-bold text-primary text-lg">JTC COD</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs font-mono hidden sm:inline">
            {user?.email}
          </span>
          <Button variant="ghost" size="sm" onClick={signOut} className="text-muted-foreground hover:text-destructive">
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 flex overflow-hidden">
        {activeRepo ? (
          <ChatInterface repo={activeRepo} onDisconnect={handleDisconnect} />
        ) : (
          <ConnectRepo userId={user!.id} onConnected={fetchActiveRepo} />
        )}
      </main>
    </div>
  );
};

export default Dashboard;
