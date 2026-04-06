import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "sonner";
import { Link2, HelpCircle, ChevronDown, Save } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

interface Integration {
  id: string;
  provider: string;
  is_connected: boolean;
  connected_at: string | null;
  metadata: Record<string, any> | null;
}

const providerConfig: Record<string, { name: string; icon: string; desc: string; group?: string }> = {
  google_calendar: { name: "Google Calendar", icon: "📅", desc: "Sincroniza compromissos e lembretes automaticamente", group: "google" },
  google_sheets: { name: "Google Sheets", icon: "📊", desc: "Registra transações financeiras na sua planilha", group: "google" },
  notion: { name: "Notion", icon: "📝", desc: "Salva notas e informações importantes no seu Notion" },
};

const instructions: Record<string, string[]> = {
  google: [
    "Clique em Conectar Google",
    "Faça login com sua conta Google",
    "Autorize o MayaChat a acessar Calendar e Sheets",
    "Para Sheets: copie o ID da planilha (entre /d/ e /edit na URL)",
  ],
  notion: [
    "Clique em Conectar Notion",
    "Selecione seu workspace e autorize o MayaChat",
    "Cole o ID do database (parte após o último / antes do ? na URL)",
  ],
};

export default function Integracoes() {
  const { user, session } = useAuth();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [sheetId, setSheetId] = useState("");
  const [notionDbId, setNotionDbId] = useState("");
  const [savingField, setSavingField] = useState<string | null>(null);

  // Detect OAuth return params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const success = params.get("success");
    const error = params.get("error");
    if (success) {
      toast.success("Integração conectada com sucesso!");
      window.history.replaceState({}, "", window.location.pathname);
      if (user) loadData();
    }
    if (error) {
      toast.error(`Erro ao conectar: ${error}`);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (user) loadData();
  }, [user]);

  const loadData = async () => {
    const { data } = await supabase
      .from("integrations")
      .select("id, provider, is_connected, connected_at, metadata")
      .eq("user_id", user!.id);
    const items = (data ?? []) as Integration[];
    setIntegrations(items);

    const sheets = items.find((i) => i.provider === "google_sheets");
    if (sheets?.metadata && typeof sheets.metadata === "object") {
      setSheetId((sheets.metadata as any).sheet_id || "");
    }
    const notion = items.find((i) => i.provider === "notion");
    if (notion?.metadata && typeof notion.metadata === "object") {
      setNotionDbId((notion.metadata as any).database_id || "");
    }
    setLoading(false);
  };

  const handleConnect = async (provider: string) => {
    if (!session?.access_token) {
      toast.error("Sessão expirada. Faça login novamente.");
      return;
    }
    setConnecting(provider);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const res = await fetch(
        `${supabaseUrl}/functions/v1/oauth-init?provider=${provider}&user_id=${user!.id}`,
        { headers: { Authorization: `Bearer ${session.access_token}` } }
      );
      const json = await res.json();
      if (json.url) {
        window.location.href = json.url;
      } else {
        toast.error(json.error || "Erro ao iniciar conexão");
        setConnecting(null);
      }
    } catch {
      toast.error("Erro ao conectar");
      setConnecting(null);
    }
  };

  const handleDisconnect = async (provider: string) => {
    const { error } = await supabase
      .from("integrations")
      .update({ is_connected: false, access_token: null, refresh_token: null, connected_at: null })
      .eq("user_id", user!.id)
      .eq("provider", provider);
    if (error) toast.error("Erro ao desconectar");
    else {
      toast.success("Desconectado");
      loadData();
    }
  };

  const saveMetadataField = async (provider: string, field: string, value: string) => {
    setSavingField(provider);
    const integration = integrations.find((i) => i.provider === provider);
    if (!integration) return;
    const currentMeta = (integration.metadata && typeof integration.metadata === "object" ? integration.metadata : {}) as Record<string, any>;
    const newMeta = { ...currentMeta, [field]: value };
    const { error } = await supabase
      .from("integrations")
      .update({ metadata: newMeta as any })
      .eq("user_id", user!.id)
      .eq("provider", provider);
    if (error) toast.error("Erro ao salvar");
    else { toast.success("Salvo!"); loadData(); }
    setSavingField(null);
  };

  const isGoogleConnected = integrations.some(
    (i) => (i.provider === "google_calendar" || i.provider === "google_sheets") && i.is_connected
  );

  if (loading)
    return (
      <div className="grid sm:grid-cols-2 gap-4">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-40" />)}
      </div>
    );

  const renderCard = (integration: Integration) => {
    const config = providerConfig[integration.provider];
    if (!config) return null;
    const isGoogle = config.group === "google";
    const email = integration.metadata && typeof integration.metadata === "object" ? (integration.metadata as any).email : null;
    const workspaceName = integration.metadata && typeof integration.metadata === "object" ? (integration.metadata as any).workspace_name : null;
    const connectedDate = integration.connected_at
      ? format(new Date(integration.connected_at), "dd MMM yyyy, HH:mm", { locale: ptBR })
      : null;

    // For google_sheets or google_calendar, "Conectar Google" triggers google_calendar provider
    const connectProvider = isGoogle ? "google_calendar" : integration.provider;
    // Disable connect button for the second google card if google is already connected
    const hideConnectBtn = isGoogle && isGoogleConnected && !integration.is_connected;

    return (
      <Card key={integration.id} className="bg-card border-border">
        <CardContent className="pt-6">
          <div className="text-3xl mb-3">{config.icon}</div>
          <h3 className="font-semibold mb-1">{config.name}</h3>
          <p className="text-sm text-muted-foreground mb-1">{config.desc}</p>

          {isGoogle && (
            <p className="text-[11px] text-muted-foreground/70 mb-3 italic">
              Ambos usam a mesma conta Google
            </p>
          )}

          <div className="flex items-center justify-between mb-2">
            <div>
              <Badge
                variant={integration.is_connected ? "default" : "secondary"}
                className={integration.is_connected ? "bg-success/20 text-success border-success/30" : ""}
              >
                {integration.is_connected ? "Conectado" : "Desconectado"}
              </Badge>
              {integration.is_connected && email && isGoogle && (
                <p className="text-xs text-muted-foreground mt-1">{email}</p>
              )}
              {integration.is_connected && workspaceName && integration.provider === "notion" && (
                <p className="text-xs text-muted-foreground mt-1">Workspace: {workspaceName}</p>
              )}
              {integration.is_connected && connectedDate && (
                <p className="text-[11px] text-muted-foreground/60 mt-0.5">Conectado em {connectedDate}</p>
              )}
            </div>
            {integration.is_connected ? (
              <Button variant="outline" size="sm" onClick={() => handleDisconnect(integration.provider)}>
                Desconectar
              </Button>
            ) : hideConnectBtn ? null : (
              <Button
                size="sm"
                disabled={connecting !== null}
                onClick={() => handleConnect(connectProvider)}
              >
                {connecting === connectProvider ? "Redirecionando..." : isGoogle ? "Conectar Google" : "Conectar Notion"}
              </Button>
            )}
          </div>

          {/* Google Sheets — sheet ID */}
          {integration.provider === "google_sheets" && integration.is_connected && (
            <div className="mt-3 space-y-1.5">
              <label className="text-xs text-muted-foreground">ID da Planilha</label>
              <p className="text-[11px] text-muted-foreground/60">
                Cole o ID da sua planilha (encontrado na URL: sheets.google.com/d/<strong>ID</strong>/edit)
              </p>
              <div className="flex gap-2">
                <Input
                  value={sheetId}
                  onChange={(e) => setSheetId(e.target.value)}
                  placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
                  className="text-xs font-mono h-8"
                />
                <Button
                  size="sm" variant="outline" className="h-8 px-2"
                  disabled={savingField === "google_sheets"}
                  onClick={() => saveMetadataField("google_sheets", "sheet_id", sheetId)}
                >
                  <Save className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* Notion — database ID */}
          {integration.provider === "notion" && integration.is_connected && (
            <div className="mt-3 space-y-1.5">
              <label className="text-xs text-muted-foreground">ID do Database Notion</label>
              <p className="text-[11px] text-muted-foreground/60">
                Cole o ID do database onde as notas serão salvas
              </p>
              <div className="flex gap-2">
                <Input
                  value={notionDbId}
                  onChange={(e) => setNotionDbId(e.target.value)}
                  placeholder="abc123def456..."
                  className="text-xs font-mono h-8"
                />
                <Button
                  size="sm" variant="outline" className="h-8 px-2"
                  disabled={savingField === "notion"}
                  onClick={() => saveMetadataField("notion", "database_id", notionDbId)}
                >
                  <Save className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* Collapsible instructions */}
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mt-3">
              <HelpCircle className="h-3.5 w-3.5" />
              <span>Como configurar</span>
              <ChevronDown className="h-3 w-3" />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside bg-muted/30 rounded-md p-3">
                {(instructions[isGoogle ? "google" : integration.provider] || []).map((step, idx) => (
                  <li key={idx}>{step}</li>
                ))}
              </ol>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Integrações</h1>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {integrations.map((i) => renderCard(i))}
        {integrations.length === 0 && (
          <Card className="bg-card border-border col-span-full">
            <CardContent className="py-12 text-center">
              <Link2 className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground">Nenhuma integração disponível.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
