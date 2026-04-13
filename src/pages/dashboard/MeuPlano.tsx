import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, Zap, ExternalLink } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

const FEATURES = [
  "Assistente pessoal 24/7 no WhatsApp",
  "Agenda e compromissos inteligentes",
  "Lembretes automáticos",
  "Anotações e notas rápidas",
  "Controle financeiro",
  "Briefing diário personalizado",
  "Sem limite de mensagens",
];

export default function MeuPlano() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { if (user) loadData(); }, [user]);

  const loadData = async () => {
    const { data } = await supabase.from("profiles").select("account_status, access_until, kirvano_subscription_id, plan, created_at").eq("id", user!.id).single();
    setProfile(data);
    setLoading(false);
  };

  if (loading) return <div className="space-y-4 max-w-lg"><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;
  if (!profile) return null;

  const isActive = profile.account_status === "active";
  const isSuspended = profile.account_status === "suspended";
  const accessUntil = profile.access_until ? new Date(profile.access_until) : null;
  const isCancelling = isActive && accessUntil && accessUntil > new Date();
  const isAnnual = (profile.plan as string)?.includes("anual") || (profile.plan as string)?.includes("annual") || (profile.plan as string)?.includes("annually");

  return (
    <div className="space-y-6 max-w-lg">
      <h1 className="text-2xl font-bold">Minha Assinatura</h1>

      {/* Status card */}
      <Card className="bg-card border-border">
        <CardContent className="pt-6">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-primary" />
                <h2 className="text-xl font-bold">Jarvis</h2>
                {isAnnual
                  ? <Badge className="bg-primary/20 text-primary border-primary/30">Anual</Badge>
                  : <Badge className="bg-blue-500/20 text-blue-300 border-blue-500/30">Mensal</Badge>
                }
              </div>
              <p className="text-sm text-muted-foreground">Acesso completo a todos os recursos</p>
            </div>

            {isActive && !isCancelling && (
              <Badge className="bg-green-500/20 text-green-300 border-green-500/30 shrink-0">Ativa</Badge>
            )}
            {isCancelling && (
              <Badge className="bg-yellow-500/20 text-yellow-300 border-yellow-500/30 shrink-0">Cancelada</Badge>
            )}
            {isSuspended && (
              <Badge className="bg-red-500/20 text-red-300 border-red-500/30 shrink-0">Suspensa</Badge>
            )}
          </div>

          {isCancelling && accessUntil && (
            <p className="mt-4 text-sm text-yellow-300 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
              ⚠️ Assinatura cancelada. Seu acesso continua até{" "}
              <span className="font-semibold">{format(accessUntil, "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}</span>.
            </p>
          )}

          {isSuspended && (
            <p className="mt-4 text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              🚫 Acesso suspenso. Para reativar, renove sua assinatura abaixo.
            </p>
          )}

          {isActive && !isCancelling && (
            <p className="mt-4 text-sm text-green-300 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
              ✅ Tudo ativo! O Jarvis está disponível 24/7 para você no WhatsApp.
            </p>
          )}
        </CardContent>
      </Card>

      {/* O que está incluso */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base">O que está incluso</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {FEATURES.map((f, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <Check className="h-4 w-4 text-primary shrink-0" />
                <span className="text-muted-foreground">{f}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Ação */}
      {(isSuspended || isCancelling) && (
        <Button className="w-full" onClick={() => window.open("https://pay.kirvano.com/maya", "_blank")}>
          <ExternalLink className="h-4 w-4 mr-2" />
          {isSuspended ? "Reativar assinatura" : "Renovar assinatura"}
        </Button>
      )}

      <p className="text-xs text-muted-foreground text-center">
        Sua assinatura é gerenciada pela Kirvano. Em caso de dúvidas sobre cobranças, acesse o painel da Kirvano ou fale com nosso suporte.
      </p>
    </div>
  );
}
