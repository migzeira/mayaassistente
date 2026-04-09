import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Plus, Trash2, UserCircle2, Search, Phone } from "lucide-react";

interface Contact {
  id: string;
  name: string;
  phone: string;
  notes: string | null;
  source: string;
  created_at: string;
}

export default function Contatos() {
  const { user } = useAuth();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) load();
  }, [user]);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("user_id", user!.id)
      .order("name");
    if (error) toast.error("Erro ao carregar contatos");
    else setContacts(data ?? []);
    setLoading(false);
  };

  const handleAdd = async () => {
    if (!newName.trim() || !newPhone.trim()) return;
    setSaving(true);
    // Normaliza telefone
    let phone = newPhone.replace(/\D/g, "");
    if (!phone.startsWith("55") && phone.length <= 11) phone = `55${phone}`;

    const { error } = await supabase.from("contacts").upsert(
      { user_id: user!.id, name: newName.trim(), phone, notes: newNotes.trim() || null, source: "manual" },
      { onConflict: "user_id,phone" }
    );
    setSaving(false);
    if (error) {
      toast.error("Erro ao salvar contato");
    } else {
      toast.success("Contato adicionado!");
      setAdding(false);
      setNewName(""); setNewPhone(""); setNewNotes("");
      load();
    }
  };

  const handleDelete = async (id: string, name: string) => {
    const { error } = await supabase.from("contacts").delete().eq("id", id);
    if (error) toast.error("Erro ao remover");
    else {
      toast.success(`${name} removido`);
      setContacts(c => c.filter(x => x.id !== id));
    }
  };

  const filtered = contacts.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.phone.includes(search)
  );

  const formatPhone = (phone: string) => {
    const n = phone.replace(/\D/g, "");
    if (n.startsWith("55") && n.length === 13) {
      return `+55 (${n.slice(2, 4)}) ${n.slice(4, 9)}-${n.slice(9)}`;
    }
    if (n.startsWith("55") && n.length === 12) {
      return `+55 (${n.slice(2, 4)}) ${n.slice(4, 8)}-${n.slice(8)}`;
    }
    return phone;
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-20" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Contatos</h1>
        <Button onClick={() => setAdding(a => !a)} variant={adding ? "outline" : "default"} size="sm">
          <Plus className="h-4 w-4 mr-2" />
          {adding ? "Cancelar" : "Adicionar"}
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Compartilhe um contato do WhatsApp com a Maya e ela salva automaticamente aqui. Depois é só pedir: <em>"Marca reunião com [Nome]"</em> ou <em>"Manda mensagem pra [Nome] dizendo..."</em>
      </p>

      {adding && (
        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-base">Novo contato</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Nome *</Label>
                <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Ex: Cibele Fernandes" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Telefone (com DDD) *</Label>
                <Input value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder="11 99999-9999" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Observações</Label>
              <Input value={newNotes} onChange={e => setNewNotes(e.target.value)} placeholder="Ex: minha esposa, cliente VIP..." />
            </div>
            <Button
              onClick={handleAdd}
              disabled={saving || !newName.trim() || !newPhone.trim()}
              size="sm"
            >
              {saving ? "Salvando..." : "Salvar contato"}
            </Button>
          </CardContent>
        </Card>
      )}

      {contacts.length > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Buscar por nome ou telefone..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      )}

      {filtered.length === 0 && !adding && (
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center text-muted-foreground space-y-2">
            <UserCircle2 className="h-10 w-10 mx-auto opacity-30" />
            <p className="text-sm">
              {search
                ? "Nenhum contato encontrado."
                : "Nenhum contato ainda. Compartilhe um contato do WhatsApp com a Maya para começar!"}
            </p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {filtered.map(c => (
          <Card key={c.id} className="bg-card border-border">
            <CardContent className="py-3 px-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex-shrink-0 h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
                    <span className="text-sm font-semibold text-primary">
                      {c.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Phone className="h-3 w-3 flex-shrink-0" />
                      <span className="font-mono">{formatPhone(c.phone)}</span>
                    </div>
                    {c.notes && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{c.notes}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Badge variant="outline" className="text-xs hidden sm:flex">
                    {c.source === "whatsapp" ? "📱 WhatsApp" : "✏️ Manual"}
                  </Badge>
                  <button
                    onClick={() => handleDelete(c.id, c.name)}
                    className="text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
