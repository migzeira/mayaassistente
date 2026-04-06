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
import { Save, Clock, CheckCircle, XCircle, Info, Plus, Trash2, Smartphone } from "lucide-react";

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
  const [extraNumbers, setExtraNumbers] = useState<any[]>([]);
  const [newNumber, setNewNumber] = useState("");
  const [newLabel, setNewLabel] = useState("");

  useEffect(() => { if (user) loadData(); }, [user]);

  const loadData = async () => {
    const [profileRes, numbersRes] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", user!.id).single(),
      (supabase.from("user_phone_numbers" as any).select("*").eq("user_id", user!.id).order("created_at") as any),
    ]);
    setProfile(profileRes.data);
    setExtraNumbers(numbersRes.data ?? []);
    setLoading(false);
  };

  const PLAN_MAX_NUMBERS: Record<string, number> = { starter: 1, pro: 2, business: 5 };
  const maxExtra = (PLAN_MAX_NUMBERS[profile?.plan] ?? 1) - 1; // -1 pelo número principal

  const addExtraNumber = async () => {
    if (!newNumber.trim()) return;
    const clean = newNumber.replace(/\D/g, "");
    const { error } = await supabase.from("user_phone_numbers").insert({
      user_id: user!.id,
      phone_number: clean,
      label: newLabel || null,
    });
    if (error) toast.error(error.message.includes("Limite") ? error.message : "Erro ao adicionar número");
    else {
      toast.success("Número adicionado!");
      setNewNumber("");
      setNewLabel("");
      loadData();
    }
  };

  const removeExtraNumber = async (id: string) => {
    await supabase.from("user_phone_numbers").delete().eq("id", id);
    toast.success("Número removido.");
    loadData();
  };

  const handleSave = async () => {
    const { error } = await supabase.from("profiles").update({
      display_name: profile.display_name,
      phone_number: profile.phone_number?.replace(/\D/g, "") || null,
      timezone: profile.timezone,
    }).eq("id", user!.id);
    if (error) toast.error("Erro ao salvar");
    else toast.success("Perfil atualizado! O admin será notificado para aprovar sua conta.");
  };

  if (loading) return <Skeleton className="h-64 max-w-lg" />;
  if (!profile) return null;

  return (
    <div className="space-y-6 max-w-lg">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Meu Perfil</h1>
        <StatusBadge status={profile.account_status} />
      </div>

      {profile.account_status === "pending" && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm text-yellow-200">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <p>Preencha seu número de WhatsApp abaixo e salve. Após a aprovação do administrador, você receberá o número da IA para começar a conversar.</p>
        </div>
      )}

      {profile.account_status === "active" && profile.phone_number && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-sm text-green-200">
          <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <p>Conta ativa! Envie uma mensagem para o WhatsApp da Maya para começar.</p>
        </div>
      )}

      <Card className="bg-card border-border">
        <CardContent className="pt-6 space-y-4">
          <div className="space-y-2">
            <Label>Nome de exibição</Label>
            <Input value={profile.display_name || ""} onChange={e => setProfile({...profile, display_name: e.target.value})} placeholder="Como quer ser chamado" />
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input value={user?.email ?? ""} disabled className="opacity-60" />
          </div>
          <div className="space-y-2">
            <Label>Telefone / WhatsApp</Label>
            <Input
              value={profile.phone_number || ""}
              onChange={e => setProfile({...profile, phone_number: e.target.value})}
              placeholder="5511999999999 (só números com DDI)"
            />
            <p className="text-xs text-muted-foreground">Formato: DDI + DDD + número. Ex: 5511999999999</p>
          </div>
          <div className="space-y-2">
            <Label>Fuso horário</Label>
            <Select value={profile.timezone} onValueChange={v => setProfile({...profile, timezone: v})}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{timezones.map(tz => <SelectItem key={tz} value={tz}>{tz.replace("America/", "")}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button onClick={handleSave}><Save className="mr-2 h-4 w-4" /> Salvar perfil</Button>
        </CardContent>
      </Card>

      {/* Múltiplos números (Pro = 2, Business = 5) */}
      {profile?.plan !== "starter" && (
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Smartphone className="h-4 w-4" />
              Números adicionais
              <Badge variant="secondary">{profile?.plan}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Seu plano permite até {PLAN_MAX_NUMBERS[profile?.plan] ?? 1} número(s). Números adicionais também ativam o assistente.
            </p>

            {extraNumbers.map(n => (
              <div key={n.id} className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 border border-border">
                <Smartphone className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono">{n.phone_number}</p>
                  {n.label && <p className="text-xs text-muted-foreground">{n.label}</p>}
                </div>
                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => removeExtraNumber(n.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}

            {extraNumbers.length < maxExtra && (
              <div className="flex gap-2">
                <Input
                  value={newNumber}
                  onChange={e => setNewNumber(e.target.value)}
                  placeholder="5511999999999"
                  className="flex-1 font-mono"
                />
                <Input
                  value={newLabel}
                  onChange={e => setNewLabel(e.target.value)}
                  placeholder="Rótulo (ex: Trabalho)"
                  className="w-40"
                />
                <Button size="sm" onClick={addExtraNumber}><Plus className="h-4 w-4" /></Button>
              </div>
            )}

            {extraNumbers.length >= maxExtra && maxExtra > 0 && (
              <p className="text-xs text-muted-foreground italic">Limite de números atingido para o plano {profile?.plan}.</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
