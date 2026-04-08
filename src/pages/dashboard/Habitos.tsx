import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Flame, Trophy, Target, CheckCircle2, Trash2, Pencil, Zap } from "lucide-react";
import { format, startOfWeek, addDays, isSameDay } from "date-fns";
import { ptBR } from "date-fns/locale";

const ICON_OPTIONS = ["🎯", "💧", "🏃", "📚", "🧘", "💪", "🥗", "💊", "🎵", "✍️", "🧠", "😴"];
const COLOR_OPTIONS = ["#6366f1", "#ec4899", "#22c55e", "#f97316", "#3b82f6", "#14b8a6", "#eab308", "#ef4444"];
const DAY_LABELS = ["D", "S", "T", "Q", "Q", "S", "S"];
const DAY_NAMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];

interface Habit {
  id: string;
  name: string;
  description: string | null;
  frequency: string;
  times_per_day: number;
  reminder_times: string[];
  target_days: number[];
  icon: string;
  color: string;
  is_active: boolean;
  current_streak: number;
  best_streak: number;
  created_at: string;
}

interface HabitLog {
  id: string;
  habit_id: string;
  logged_date: string;
  logged_at: string;
  note: string | null;
}

export default function Habitos() {
  const { user } = useAuth();
  const [habits, setHabits] = useState<Habit[]>([]);
  const [logs, setLogs] = useState<HabitLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Habit | null>(null);
  const [form, setForm] = useState({
    name: "", description: "", frequency: "daily",
    reminder_time: "08:00", icon: "🎯", color: "#6366f1",
    target_days: [0, 1, 2, 3, 4, 5, 6] as number[],
  });

  const loadData = useCallback(async () => {
    if (!user) return;
    const weekStart = format(startOfWeek(new Date(), { weekStartsOn: 0 }), "yyyy-MM-dd");
    const [hRes, lRes] = await Promise.all([
      (supabase.from("habits" as any).select("*").eq("user_id", user.id).order("created_at") as any),
      (supabase.from("habit_logs" as any).select("*").eq("user_id", user.id).gte("logged_date", weekStart).order("logged_date", { ascending: false }) as any),
    ]);
    setHabits(hRes.data ?? []);
    setLogs(lRes.data ?? []);
    setLoading(false);
  }, [user]);

  useEffect(() => { if (user) loadData(); }, [user, loadData]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { toast.error("Nome obrigatorio"); return; }

    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      frequency: form.frequency,
      reminder_times: JSON.stringify([form.reminder_time]),
      target_days: JSON.stringify(form.target_days),
      icon: form.icon,
      color: form.color,
      updated_at: new Date().toISOString(),
    };

    if (editing) {
      const { error } = await (supabase.from("habits" as any).update(payload as any).eq("id", editing.id) as any);
      if (error) toast.error("Erro ao atualizar");
      else { toast.success("Habito atualizado!"); setDialogOpen(false); setEditing(null); loadData(); }
    } else {
      const { error } = await (supabase.from("habits" as any).insert({ ...payload, user_id: user!.id } as any) as any);
      if (error) toast.error("Erro ao criar: " + error.message);
      else { toast.success("Habito criado!"); setDialogOpen(false); loadData(); }
    }
  };

  const toggleActive = async (id: string, active: boolean) => {
    await (supabase.from("habits" as any).update({ is_active: active } as any).eq("id", id) as any);
    loadData();
  };

  const deleteHabit = async (id: string) => {
    await (supabase.from("habits" as any).delete().eq("id", id) as any);
    toast.success("Habito removido!");
    loadData();
  };

  const checkIn = async (habitId: string) => {
    const today = format(new Date(), "yyyy-MM-dd");
    const alreadyLogged = logs.some(l => l.habit_id === habitId && l.logged_date === today);
    if (alreadyLogged) { toast.info("Ja registrado hoje!"); return; }

    const { error } = await (supabase.from("habit_logs" as any).insert({
      habit_id: habitId, user_id: user!.id, logged_date: today,
    } as any) as any);

    if (error) {
      if (error.code === "23505") toast.info("Ja registrado hoje!");
      else toast.error("Erro ao registrar");
      return;
    }

    // Atualiza streak
    const habit = habits.find(h => h.id === habitId);
    if (habit) {
      const newStreak = habit.current_streak + 1;
      const bestStreak = Math.max(newStreak, habit.best_streak);
      await (supabase.from("habits" as any).update({
        current_streak: newStreak, best_streak: bestStreak,
      } as any).eq("id", habitId) as any);
    }

    toast.success("Check-in registrado! 🔥");
    loadData();
  };

  const openEdit = (h: Habit) => {
    setEditing(h);
    const times = Array.isArray(h.reminder_times) ? h.reminder_times : JSON.parse(h.reminder_times as any);
    const days = Array.isArray(h.target_days) ? h.target_days : JSON.parse(h.target_days as any);
    setForm({
      name: h.name, description: h.description || "", frequency: h.frequency,
      reminder_time: times[0] || "08:00", icon: h.icon, color: h.color,
      target_days: days,
    });
    setDialogOpen(true);
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", description: "", frequency: "daily", reminder_time: "08:00", icon: "🎯", color: "#6366f1", target_days: [0, 1, 2, 3, 4, 5, 6] });
    setDialogOpen(true);
  };

  // Stats
  const activeHabits = habits.filter(h => h.is_active).length;
  const longestStreak = habits.reduce((max, h) => Math.max(max, h.best_streak), 0);
  const today = format(new Date(), "yyyy-MM-dd");
  const todayCompletions = logs.filter(l => l.logged_date === today).length;
  const todayTarget = habits.filter(h => h.is_active).length;
  const completionPct = todayTarget > 0 ? Math.round((todayCompletions / todayTarget) * 100) : 0;

  // Week days for progress circles
  const weekStart = startOfWeek(new Date(), { weekStartsOn: 0 });
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  if (loading) return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-3 gap-4">{[1, 2, 3].map(i => <Skeleton key={i} className="h-24" />)}</div>
      <div className="grid sm:grid-cols-2 gap-4">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-40" />)}</div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Habitos</h1>
        <Button onClick={openCreate}><Plus className="mr-2 h-4 w-4" /> Novo habito</Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card border-border">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Hoje</p>
              <Target className="h-5 w-5 text-primary/50" />
            </div>
            <p className="text-2xl font-bold">{todayCompletions}/{todayTarget}</p>
            <Progress value={completionPct} className="h-1.5 mt-2" />
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Habitos ativos</p>
              <Zap className="h-5 w-5 text-yellow-500/50" />
            </div>
            <p className="text-2xl font-bold">{activeHabits}</p>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Maior streak</p>
              <Trophy className="h-5 w-5 text-yellow-500/50" />
            </div>
            <p className="text-2xl font-bold">{longestStreak} dias</p>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Conclusao hoje</p>
              <CheckCircle2 className="h-5 w-5 text-green-500/50" />
            </div>
            <p className="text-2xl font-bold">{completionPct}%</p>
          </CardContent>
        </Card>
      </div>

      {/* Habits grid */}
      {habits.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center">
            <Zap className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground">Nenhum habito criado.</p>
            <p className="text-sm text-muted-foreground/60 mt-1">Crie habitos para acompanhar sua rotina!</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {habits.map(h => {
            const todayDone = logs.some(l => l.habit_id === h.id && l.logged_date === today);
            const habitWeekLogs = logs.filter(l => l.habit_id === h.id);
            const weekCompletions = weekDays.filter(day =>
              habitWeekLogs.some(l => l.logged_date === format(day, "yyyy-MM-dd"))
            ).length;

            return (
              <Card key={h.id} className={`bg-card border-border transition-opacity ${!h.is_active ? "opacity-50" : ""}`}>
                <CardContent className="pt-5">
                  {/* Header */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-2xl">{h.icon}</span>
                      <div>
                        <h3 className="font-semibold">{h.name}</h3>
                        {h.description && <p className="text-xs text-muted-foreground">{h.description}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Switch checked={h.is_active} onCheckedChange={v => toggleActive(h.id, v)} />
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEdit(h)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => deleteHabit(h.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* Streak */}
                  <div className="flex items-center gap-4 mb-3">
                    <div className="flex items-center gap-1">
                      <Flame className={`h-4 w-4 ${h.current_streak > 0 ? "text-orange-500" : "text-muted-foreground/30"}`} />
                      <span className="text-sm font-bold">{h.current_streak}</span>
                      <span className="text-xs text-muted-foreground">streak</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Trophy className="h-3.5 w-3.5 text-yellow-500/60" />
                      <span className="text-xs text-muted-foreground">Recorde: {h.best_streak}</span>
                    </div>
                  </div>

                  {/* Week progress circles */}
                  <div className="flex justify-between mb-3">
                    {weekDays.map((day, idx) => {
                      const dateStr = format(day, "yyyy-MM-dd");
                      const done = habitWeekLogs.some(l => l.logged_date === dateStr);
                      const isToday = isSameDay(day, new Date());
                      return (
                        <div key={idx} className="flex flex-col items-center gap-1">
                          <span className="text-[10px] text-muted-foreground">{DAY_LABELS[idx]}</span>
                          <div
                            className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium border-2 transition-colors ${
                              done
                                ? "border-transparent text-white"
                                : isToday
                                  ? "border-primary/50 text-muted-foreground"
                                  : "border-border text-muted-foreground/40"
                            }`}
                            style={done ? { backgroundColor: h.color } : {}}
                          >
                            {done ? "✓" : format(day, "d")}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Progress bar + check-in */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <Progress value={(weekCompletions / 7) * 100} className="h-2" />
                      <p className="text-[10px] text-muted-foreground mt-1">{weekCompletions}/7 esta semana</p>
                    </div>
                    <Button
                      size="sm"
                      variant={todayDone ? "secondary" : "default"}
                      disabled={todayDone || !h.is_active}
                      onClick={() => checkIn(h.id)}
                      className="shrink-0"
                    >
                      {todayDone ? (
                        <><CheckCircle2 className="h-4 w-4 mr-1" /> Feito</>
                      ) : (
                        <><Target className="h-4 w-4 mr-1" /> Check-in</>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={v => { setDialogOpen(v); if (!v) setEditing(null); }}>
        <DialogContent className="bg-card border-border">
          <DialogHeader><DialogTitle>{editing ? "Editar" : "Novo"} habito</DialogTitle></DialogHeader>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-2">
              <Label>Nome</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Ex: Beber agua" required />
            </div>
            <div className="space-y-2">
              <Label>Descricao (opcional)</Label>
              <Input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Ex: 2 litros por dia" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Horario do lembrete</Label>
                <Input type="time" value={form.reminder_time}
                  onChange={e => setForm(f => ({ ...f, reminder_time: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Icone</Label>
                <div className="flex flex-wrap gap-1.5">
                  {ICON_OPTIONS.map(icon => (
                    <button key={icon} type="button"
                      className={`w-8 h-8 rounded-md text-lg flex items-center justify-center transition-colors ${form.icon === icon ? "bg-primary/20 ring-2 ring-primary" : "bg-muted hover:bg-muted/80"}`}
                      onClick={() => setForm(f => ({ ...f, icon }))}
                    >{icon}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Dias da semana</Label>
              <div className="flex gap-1.5">
                {DAY_NAMES.map((d, idx) => (
                  <button key={idx} type="button"
                    className={`flex-1 py-2 rounded-md text-xs font-medium transition-colors ${
                      form.target_days.includes(idx)
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                    onClick={() => setForm(f => ({
                      ...f,
                      target_days: f.target_days.includes(idx)
                        ? f.target_days.filter(d => d !== idx)
                        : [...f.target_days, idx].sort(),
                    }))}
                  >{d}</button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Cor</Label>
              <div className="flex gap-2">
                {COLOR_OPTIONS.map(c => (
                  <button key={c} type="button"
                    className={`w-7 h-7 rounded-full transition-transform ${form.color === c ? "ring-2 ring-primary scale-110" : "hover:scale-105"}`}
                    style={{ backgroundColor: c }}
                    onClick={() => setForm(f => ({ ...f, color: c }))}
                  />
                ))}
              </div>
            </div>
            <Button type="submit" className="w-full">{editing ? "Atualizar" : "Criar"} habito</Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
