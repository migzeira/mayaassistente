import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Bell, Plus, Trash2, Clock, RefreshCw, CheckCircle2, XCircle } from "lucide-react";
import { format, isPast } from "date-fns";
import { ptBR } from "date-fns/locale";

interface Reminder {
  id: string;
  title: string | null;
  message: string;
  send_at: string;
  status: string;
  recurrence: string;
  recurrence_value: number | null;
  source: string;
  created_at: string;
}

const RECURRENCE_LABELS: Record<string, string> = {
  none: "Único",
  daily: "Todo dia",
  weekly: "Toda semana",
  monthly: "Todo mês",
  day_of_month: "Dia do mês",
};

const RECURRENCE_COLORS: Record<string, string> = {
  none: "secondary",
  daily: "default",
  weekly: "default",
  monthly: "default",
  day_of_month: "default",
};

const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

function recurrenceLabel(r: Reminder) {
  if (r.recurrence === "none" || !r.recurrence) return null;
  if (r.recurrence === "weekly" && r.recurrence_value != null) {
    return `Toda ${WEEKDAYS[r.recurrence_value]}`;
  }
  if (r.recurrence === "day_of_month" && r.recurrence_value != null) {
    return `Todo dia ${r.recurrence_value}`;
  }
  return RECURRENCE_LABELS[r.recurrence] ?? r.recurrence;
}

function statusBadge(status: string, sendAt: string) {
  if (status === "sent") return <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-[10px]"><CheckCircle2 className="w-3 h-3 mr-1" />Enviado</Badge>;
  if (status === "failed") return <Badge variant="destructive" className="text-[10px]"><XCircle className="w-3 h-3 mr-1" />Falhou</Badge>;
  if (isPast(new Date(sendAt))) return <Badge variant="secondary" className="text-[10px]">Atrasado</Badge>;
  return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[10px]"><Clock className="w-3 h-3 mr-1" />Pendente</Badge>;
}

export default function Lembretes() {
  const { user } = useAuth();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "pending" | "sent">("all");

  // Form state
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [sendAt, setSendAt] = useState("");
  const [recurrence, setRecurrence] = useState("none");
  const [recurrenceValue, setRecurrenceValue] = useState<string>("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (user) load(); }, [user]);

  const load = async () => {
    const { data } = await supabase
      .from("reminders")
      .select("*")
      .eq("user_id", user!.id)
      .order("send_at", { ascending: true });
    setReminders(data ?? []);
    setLoading(false);
  };

  const handleCreate = async () => {
    if (!title.trim() || !message.trim() || !sendAt) {
      toast.error("Preencha título, mensagem e data/hora");
      return;
    }

    setSaving(true);

    // Busca o número de WhatsApp do perfil
    const { data: profile } = await supabase
      .from("profiles")
      .select("phone_number")
      .eq("id", user!.id)
      .single();

    const phone = profile?.phone_number ?? "";
    if (!phone) {
      toast.error("Cadastre seu número de WhatsApp em Meu Perfil primeiro");
      setSaving(false);
      return;
    }

    const rv = recurrenceValue ? parseInt(recurrenceValue) : null;

    const { error } = await supabase.from("reminders").insert({
      user_id: user!.id,
      whatsapp_number: phone,
      title: title.trim(),
      message: message.trim(),
      send_at: new Date(sendAt).toISOString(),
      recurrence,
      recurrence_value: rv,
      source: "manual",
      status: "pending",
    });

    if (error) {
      toast.error("Erro ao criar lembrete");
    } else {
      toast.success("Lembrete criado!");
      setTitle(""); setMessage(""); setSendAt(""); setRecurrence("none"); setRecurrenceValue("");
      setOpen(false);
      load();
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("reminders").delete().eq("id", id);
    if (error) toast.error("Erro ao excluir");
    else { toast.success("Lembrete excluído"); load(); }
  };

  const filtered = reminders.filter(r => {
    if (filter === "pending") return r.status === "pending";
    if (filter === "sent") return r.status === "sent";
    return true;
  });

  const pendingCount = reminders.filter(r => r.status === "pending").length;

  if (loading) return <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-20" />)}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bell className="h-6 w-6 text-primary" /> Lembretes
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            A Maya te avisa no WhatsApp no horário certo — mesmo com o app fechado.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="h-4 w-4" /> Novo lembrete</Button>
          </DialogTrigger>
          <DialogContent className="bg-card border-border max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><Bell className="h-4 w-4" /> Criar lembrete manual</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <p className="text-xs text-muted-foreground bg-muted/30 rounded-md p-3 border border-border">
                💡 <strong>Dica:</strong> Você também pode criar lembretes diretamente no WhatsApp! Basta dizer:<br />
                <em>"me lembra de X amanhã às 10h"</em> ou <em>"me lembra todo dia 10 de pagar aluguel"</em>
              </p>

              <div className="space-y-2">
                <Label>Título</Label>
                <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Ex: Pagar aluguel" />
              </div>
              <div className="space-y-2">
                <Label>Mensagem que será enviada</Label>
                <Textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  placeholder="⏰ Lembrete: Pagar aluguel!"
                  rows={2}
                />
              </div>
              <div className="space-y-2">
                <Label>Data e hora</Label>
                <Input type="datetime-local" value={sendAt} onChange={e => setSendAt(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Recorrência</Label>
                <Select value={recurrence} onValueChange={v => { setRecurrence(v); setRecurrenceValue(""); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Único (não repetir)</SelectItem>
                    <SelectItem value="daily">Todo dia</SelectItem>
                    <SelectItem value="weekly">Toda semana (mesmo dia)</SelectItem>
                    <SelectItem value="monthly">Todo mês (mesmo dia)</SelectItem>
                    <SelectItem value="day_of_month">Dia fixo do mês</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {recurrence === "weekly" && (
                <div className="space-y-2">
                  <Label>Dia da semana</Label>
                  <Select value={recurrenceValue} onValueChange={setRecurrenceValue}>
                    <SelectTrigger><SelectValue placeholder="Escolha o dia" /></SelectTrigger>
                    <SelectContent>
                      {WEEKDAYS.map((d, i) => <SelectItem key={i} value={String(i)}>{d}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {recurrence === "day_of_month" && (
                <div className="space-y-2">
                  <Label>Dia do mês (1-31)</Label>
                  <Input type="number" min="1" max="31" value={recurrenceValue} onChange={e => setRecurrenceValue(e.target.value)} placeholder="Ex: 10" />
                </div>
              )}

              <Button onClick={handleCreate} disabled={saving} className="w-full">
                {saving ? "Criando..." : "Criar lembrete"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Filtros */}
      <div className="flex gap-2 flex-wrap">
        {(["all","pending","sent"] as const).map(f => (
          <Button
            key={f}
            variant={filter === f ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f === "all" && "Todos"}
            {f === "pending" && <>Pendentes {pendingCount > 0 && <Badge className="ml-1.5 text-[10px] h-4 px-1">{pendingCount}</Badge>}</>}
            {f === "sent" && "Enviados"}
          </Button>
        ))}
      </div>

      {/* Lista */}
      {filtered.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="py-14 text-center">
            <Bell className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground font-medium">
              {filter === "all" ? "Nenhum lembrete ainda." : "Nenhum lembrete nesta categoria."}
            </p>
            <p className="text-sm text-muted-foreground/60 mt-1">
              Crie um acima ou mande mensagem no WhatsApp: <em>"me lembra de X às 10h"</em>
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(r => {
            const rec = recurrenceLabel(r);
            return (
              <Card key={r.id} className="bg-card border-border hover:border-primary/20 transition-colors">
                <CardContent className="py-4 flex items-start gap-4">
                  <div className={`mt-0.5 w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center ${
                    r.status === "sent" ? "bg-green-500/10" :
                    r.status === "failed" ? "bg-red-500/10" : "bg-primary/10"
                  }`}>
                    {r.status === "sent" ? <CheckCircle2 className="h-4 w-4 text-green-500" /> :
                     r.status === "failed" ? <XCircle className="h-4 w-4 text-red-500" /> :
                     rec ? <RefreshCw className="h-4 w-4 text-primary" /> :
                     <Bell className="h-4 w-4 text-primary" />}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-0.5">
                      <p className="font-medium text-sm">{r.title || r.message.slice(0, 60)}</p>
                      {statusBadge(r.status, r.send_at)}
                      {rec && (
                        <Badge variant="outline" className="text-[10px] gap-1">
                          <RefreshCw className="w-2.5 h-2.5" />{rec}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{r.message}</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">
                      📅 {format(new Date(r.send_at), "dd 'de' MMMM 'às' HH:mm", { locale: ptBR })}
                      {r.source === "whatsapp" && <span className="ml-2 text-green-500/70">• via WhatsApp</span>}
                      {r.source === "manual" && <span className="ml-2 text-blue-500/70">• manual</span>}
                    </p>
                  </div>

                  <button
                    onClick={() => handleDelete(r.id)}
                    className="text-muted-foreground hover:text-destructive transition-colors mt-1 flex-shrink-0"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
