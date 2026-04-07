import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Save, Clock, CheckCircle, XCircle, Info, Smartphone } from "lucide-react";

const timezones = [
  "America/Sao_Paulo", "America/Fortaleza", "America/Manaus", "America/Cuiaba",
  "America/Belem", "America/Recife", "America/Bahia", "America/Porto_Velho",
  "America/Rio_Branco", "America/Noronha",
];

function StatusBadge({ status }: { status: string | null }) {
  if (status === "active") return (
    <Badge className="bg-green-500/20 text-green-300 border-green-500/30 flex items-center gap-1">
      <CheckCircle className="h-3 w-3" /> Ativa
    </Badge>
  );
  if (status === "suspended") return (
    <Badge className="bg-red-500/20 text-red-300 border-red-500/30 flex items-center gap-1">
      <XCircle className="h-3 w-3" /> Suspensa
    </Badge>
  );
  return (
    <Badge className="bg-yellow-500/20 text-yellow-300 border-yellow-500/30 flex items-center gap-1">
      <Clock className="h-3 w-3" /> Aguardando aprovação
    </Badge>
  );
}

export default function MeuPerfil() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { if (user) loadData(); }, [user]);

  const loadData = async () => {
    const { data } = await supabase.from("profiles").select("*").eq("id", user!.id).single();
    setProfile(data);
    setLoading(false);
  };

  const handleSave = async () => {
    const cleanPhone = profile.phone_number?.replace(/\D/g, "") || null;
    const shouldActivate = !!cleanPhone && profile.account_status === "pending";
    const { error } = await supabase.from("profiles").update({
      display_name: profile.display_name,
      phone_number: cleanPhone,
      timezone: profile.timezone,
      ...(shouldActivate && { account_status: "active" }),
    }).eq("id", user!.id);
    if (error) toast.error("Erro ao salvar");
    else {
      if (shouldActivate) {
        setProfile({ ...profile, phone_number: cleanPhone, account_status: "active" });
        toast.success("Perfil salvo! A Maya já pode responder no seu WhatsApp. 🎉");
      } else {
        setProfile({ ...profile, phone_number: cleanPhone });
        toast.success("Perfil atualizado!");
      }
    }
  };

  if (loading) return <Skeleton className="h-64 max-w-lg" />;
  if (!profile) return null;

  return (
    <div className="space-y-6 max-w-lg">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Meu Perfil</h1>
        <StatusBadge status={profile.account_status} />
      </div>

      {/* ── Dados pessoais ── */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base">Dados pessoais</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Nome de exibição</Label>
            <Input
              value={profile.display_name || ""}
              onChange={e => setProfile({ ...profile, display_name: e.target.value })}
              placeholder="Como quer ser chamado"
            />
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input value={user?.email ?? ""} disabled className="opacity-60" />
          </div>
          <div className="space-y-2">
            <Label>Fuso horário</Label>
            <Select value={profile.timezone} onValueChange={v => setProfile({ ...profile, timezone: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {timezones.map(tz => <SelectItem key={tz} value={tz}>{tz.replace("America/", "")}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* ── WhatsApp — destaque especial ── */}
      <Card className={`border-2 ${profile.phone_number ? "border-green-500/40 bg-green-500/5" : "border-primary/40 bg-primary/5"}`}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Smartphone className={`h-5 w-5 ${profile.phone_number ? "text-green-400" : "text-primary"}`} />
            Número do WhatsApp
            {profile.phone_number
              ? <Badge className="bg-green-500/20 text-green-300 border-green-500/30 text-xs">Vinculado</Badge>
              : <Badge className="bg-primary/20 text-primary border-primary/30 text-xs">Obrigatório</Badge>
            }
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!profile.phone_number && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-primary/10 border border-primary/20 text-sm text-primary">
              <Info className="h-4 w-4 shrink-0 mt-0.5" />
              <p>Preencha seu número abaixo e salve — a Maya será ativada automaticamente para responder no seu WhatsApp.</p>
            </div>
          )}
          {profile.phone_number && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-sm text-green-200">
              <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <p>Maya ativa! Envie uma mensagem para o WhatsApp da Maya e ela te responderá.</p>
            </div>
          )}
          <Input
            value={profile.phone_number || ""}
            onChange={e => setProfile({ ...profile, phone_number: e.target.value })}
            placeholder="5511999999999"
            className="font-mono text-base"
          />
          <p className="text-xs text-muted-foreground">
            Formato: DDI + DDD + número, somente dígitos. Exemplo: <span className="font-mono">5511999999999</span>
          </p>
        </CardContent>
      </Card>

      <Button onClick={handleSave} className="w-full">
        <Save className="mr-2 h-4 w-4" /> Salvar
      </Button>
    </div>
  );
}
