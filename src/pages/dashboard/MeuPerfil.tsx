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
import {
  Save, Clock, CheckCircle, XCircle, Info, Smartphone, Lock, AlertTriangle,
} from "lucide-react";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const SUPPORT_WHATSAPP = "5511999999999"; // TODO: trocar pelo número real de suporte
const MAX_PHONE_CHANGES = 2; // após isso, campo fica bloqueado

const COUNTRIES = [
  { ddi: "55",  flag: "🇧🇷", name: "Brasil",          placeholder: "11 99999-9999",  minLen: 10 },
  { ddi: "1",   flag: "🇺🇸", name: "EUA / Canadá",    placeholder: "555 555-5555",   minLen: 10 },
  { ddi: "351", flag: "🇵🇹", name: "Portugal",         placeholder: "912 345 678",    minLen: 9  },
  { ddi: "54",  flag: "🇦🇷", name: "Argentina",        placeholder: "11 1234-5678",   minLen: 10 },
  { ddi: "52",  flag: "🇲🇽", name: "México",           placeholder: "55 1234-5678",   minLen: 10 },
  { ddi: "57",  flag: "🇨🇴", name: "Colômbia",         placeholder: "300 123 4567",   minLen: 10 },
  { ddi: "56",  flag: "🇨🇱", name: "Chile",            placeholder: "9 1234 5678",    minLen: 9  },
  { ddi: "595", flag: "🇵🇾", name: "Paraguai",         placeholder: "981 123 456",    minLen: 9  },
  { ddi: "598", flag: "🇺🇾", name: "Uruguai",          placeholder: "094 123 456",    minLen: 9  },
  { ddi: "58",  flag: "🇻🇪", name: "Venezuela",        placeholder: "412 123 4567",   minLen: 10 },
  { ddi: "51",  flag: "🇵🇪", name: "Peru",             placeholder: "912 345 678",    minLen: 9  },
  { ddi: "593", flag: "🇪🇨", name: "Equador",          placeholder: "99 123 4567",    minLen: 9  },
  { ddi: "244", flag: "🇦🇴", name: "Angola",           placeholder: "923 123 456",    minLen: 9  },
  { ddi: "258", flag: "🇲🇿", name: "Moçambique",       placeholder: "82 123 4567",    minLen: 9  },
  { ddi: "44",  flag: "🇬🇧", name: "Reino Unido",      placeholder: "7911 123456",    minLen: 10 },
  { ddi: "49",  flag: "🇩🇪", name: "Alemanha",         placeholder: "151 23456789",   minLen: 10 },
  { ddi: "34",  flag: "🇪🇸", name: "Espanha",          placeholder: "612 345 678",    minLen: 9  },
  { ddi: "33",  flag: "🇫🇷", name: "França",           placeholder: "6 12 34 56 78",  minLen: 9  },
  { ddi: "39",  flag: "🇮🇹", name: "Itália",           placeholder: "312 345 6789",   minLen: 9  },
];

const timezones = [
  "America/Sao_Paulo", "America/Fortaleza", "America/Manaus", "America/Cuiaba",
  "America/Belem", "America/Recife", "America/Bahia", "America/Porto_Velho",
  "America/Rio_Branco", "America/Noronha",
];

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Extracts DDI and local part from a stored full phone number (digits only) */
function extractDDI(fullNumber: string): { ddi: string; local: string } {
  const digits = (fullNumber ?? "").replace(/\D/g, "");
  if (!digits) return { ddi: "55", local: "" };
  // Try longest DDI first to avoid false prefix matches (e.g. "595" before "59")
  const sorted = [...COUNTRIES].sort((a, b) => b.ddi.length - a.ddi.length);
  for (const c of sorted) {
    if (digits.startsWith(c.ddi)) {
      return { ddi: c.ddi, local: digits.slice(c.ddi.length) };
    }
  }
  return { ddi: "55", local: digits };
}

/** Formats Brazilian local number as (XX) XXXXX-XXXX for display */
function formatBRLocal(digits: string): string {
  const d = digits.replace(/\D/g, "");
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7, 11)}`;
}

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
      <Clock className="h-3 w-3" /> Aguardando ativação
    </Badge>
  );
}

// ─────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────

export default function MeuPerfil() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Phone fields (split from stored number)
  const [selectedDdi, setSelectedDdi] = useState("55");
  const [localNumber, setLocalNumber] = useState("");

  useEffect(() => { if (user) loadData(); }, [user]);

  const loadData = async () => {
    const { data } = await supabase.from("profiles").select("*").eq("id", user!.id).single();
    setProfile(data);

    // Extract DDI + local from stored phone_number
    if (data?.phone_number) {
      const { ddi, local } = extractDDI(data.phone_number);
      setSelectedDdi(ddi);
      setLocalNumber(local);
    }
    setLoading(false);
  };

  // ── Derived state ──
  const selectedCountry = COUNTRIES.find(c => c.ddi === selectedDdi) ?? COUNTRIES[0];
  const localDigits = localNumber.replace(/\D/g, "");
  const isValidLocal = localDigits.length >= selectedCountry.minLen;
  const builtPhone = isValidLocal ? selectedDdi + localDigits : null;

  const storedPhone = profile?.phone_number ?? null;
  const isPhoneChanging = builtPhone !== storedPhone && !(builtPhone === null && storedPhone === null);
  const changesCount = profile?.phone_changes_count ?? 0;

  // Locked: already set a number AND exhausted change allowance
  const isPhoneLocked = storedPhone !== null && changesCount >= MAX_PHONE_CHANGES;

  // ── Save ──
  const handleSave = async () => {
    if (!profile) return;

    // If trying to change a locked phone → block
    if (isPhoneLocked && isPhoneChanging) {
      toast.error("Número bloqueado para alteração. Entre em contato com o suporte.");
      return;
    }

    // If phone provided but invalid format → block
    if (localDigits.length > 0 && !isValidLocal) {
      toast.error(`Número inválido. Informe pelo menos ${selectedCountry.minLen} dígitos após o DDI.`);
      return;
    }

    setSaving(true);

    try {
      // Increment change counter only when actually changing to a different number
      const newPhone = isValidLocal ? builtPhone : null;
      const isRealChange = newPhone !== storedPhone;
      const newChangesCount = isRealChange && newPhone !== null
        ? changesCount + 1
        : changesCount;

      // Determine account_status
      // - Has number + was pending → activate
      // - Has number + already active → keep active
      // - Number cleared → will be set to pending by DB trigger
      const shouldActivate = !!newPhone && profile.account_status === "pending";

      const { error } = await supabase.from("profiles").update({
        display_name: profile.display_name?.trim() || null,
        phone_number: newPhone,
        timezone: profile.timezone,
        phone_changes_count: newChangesCount,
        ...(shouldActivate && { account_status: "active" }),
      }).eq("id", user!.id);

      if (error) {
        toast.error("Erro ao salvar. Tente novamente.");
        return;
      }

      // Update local state
      const updatedProfile = {
        ...profile,
        phone_number: newPhone,
        phone_changes_count: newChangesCount,
        ...(shouldActivate && { account_status: "active" }),
        ...(!newPhone && { account_status: "pending" }),
      };
      setProfile(updatedProfile);

      if (shouldActivate) {
        toast.success("🎉 Número salvo! A Maya já pode responder no seu WhatsApp.");
      } else if (isRealChange && newPhone) {
        const remaining = MAX_PHONE_CHANGES - newChangesCount;
        if (remaining <= 0) {
          toast.success("Número atualizado! ⚠️ Este foi seu último ajuste permitido.");
        } else {
          toast.success(`Número atualizado! Você ainda pode alterá-lo mais ${remaining} vez${remaining === 1 ? "" : "es"}.`);
        }
      } else if (!newPhone) {
        toast.success("Número removido. A Maya não responderá até você adicionar um número.");
      } else {
        toast.success("Perfil atualizado!");
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Skeleton className="h-64 max-w-lg" />;
  if (!profile) return null;

  const changesRemaining = Math.max(0, MAX_PHONE_CHANGES - changesCount);

  return (
    <div className="space-y-6 max-w-lg">
      {/* ── Header ── */}
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
              placeholder="Como quer ser chamado pela Maya"
            />
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input value={user?.email ?? ""} disabled className="opacity-50 cursor-not-allowed" />
          </div>
          <div className="space-y-2">
            <Label>Fuso horário</Label>
            <Select
              value={profile.timezone}
              onValueChange={v => setProfile({ ...profile, timezone: v })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {timezones.map(tz => (
                  <SelectItem key={tz} value={tz}>{tz.replace("America/", "")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* ── WhatsApp ── */}
      <Card className={`border-2 transition-colors ${
        profile.phone_number
          ? isPhoneLocked
            ? "border-amber-500/40 bg-amber-500/5"
            : "border-green-500/40 bg-green-500/5"
          : "border-primary/40 bg-primary/5"
      }`}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Smartphone className={`h-5 w-5 ${profile.phone_number ? isPhoneLocked ? "text-amber-400" : "text-green-400" : "text-primary"}`} />
            Número do WhatsApp
            {profile.phone_number
              ? isPhoneLocked
                ? <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30 text-xs flex items-center gap-1"><Lock className="h-3 w-3" /> Bloqueado</Badge>
                : <Badge className="bg-green-500/20 text-green-300 border-green-500/30 text-xs">Vinculado</Badge>
              : <Badge className="bg-primary/20 text-primary border-primary/30 text-xs">Obrigatório</Badge>
            }
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">

          {/* Status messages */}
          {!profile.phone_number && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-primary/10 border border-primary/20 text-sm text-primary">
              <Info className="h-4 w-4 shrink-0 mt-0.5" />
              <p>Preencha seu número abaixo e salve — a Maya será ativada automaticamente para responder no seu WhatsApp.</p>
            </div>
          )}

          {profile.phone_number && !isPhoneLocked && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-sm text-green-200">
              <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p>Maya ativa! Envie uma mensagem para o WhatsApp da Maya e ela te responderá.</p>
                {changesRemaining > 0 && changesRemaining < MAX_PHONE_CHANGES && (
                  <p className="mt-1 text-green-300/70 text-xs">
                    Você ainda pode alterar o número mais {changesRemaining} vez{changesRemaining === 1 ? "" : "es"}.
                  </p>
                )}
              </div>
            </div>
          )}

          {isPhoneLocked && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm text-amber-200">
              <Lock className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Alteração de número bloqueada.</p>
                <p className="mt-1 text-amber-300/80 text-xs">
                  Para alterar seu número, entre em contato com o suporte pelo WhatsApp:{" "}
                  <a
                    href={`https://wa.me/${SUPPORT_WHATSAPP}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline font-mono"
                  >
                    {SUPPORT_WHATSAPP}
                  </a>
                </p>
              </div>
            </div>
          )}

          {/* DDI + Number input */}
          <div className="space-y-2">
            <Label>País / DDI</Label>
            <Select
              value={selectedDdi}
              onValueChange={v => { setSelectedDdi(v); setLocalNumber(""); }}
              disabled={isPhoneLocked}
            >
              <SelectTrigger className={isPhoneLocked ? "opacity-50 cursor-not-allowed" : ""}>
                <SelectValue>
                  <span className="flex items-center gap-2">
                    <span>{selectedCountry.flag}</span>
                    <span className="font-mono text-muted-foreground">+{selectedCountry.ddi}</span>
                    <span>{selectedCountry.name}</span>
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {COUNTRIES.map(c => (
                  <SelectItem key={c.ddi} value={c.ddi}>
                    <span className="flex items-center gap-2">
                      <span>{c.flag}</span>
                      <span className="font-mono text-muted-foreground w-10">+{c.ddi}</span>
                      <span>{c.name}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Número (sem DDI)</Label>
            <div className="flex items-center gap-2">
              {/* DDI badge */}
              <div className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-muted border border-border text-sm font-mono shrink-0 text-muted-foreground select-none">
                {selectedCountry.flag} +{selectedCountry.ddi}
              </div>
              {/* Local number */}
              <Input
                value={selectedDdi === "55" ? formatBRLocal(localNumber) : localNumber}
                onChange={e => {
                  const raw = e.target.value.replace(/\D/g, "");
                  setLocalNumber(raw);
                }}
                placeholder={selectedCountry.placeholder}
                disabled={isPhoneLocked}
                className={`font-mono flex-1 ${isPhoneLocked ? "opacity-50 cursor-not-allowed" : ""}`}
                inputMode="numeric"
                maxLength={selectedDdi === "55" ? 15 : 18}
              />
            </div>

            {/* Validation feedback */}
            {localDigits.length > 0 && !isValidLocal && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Número incompleto — informe DDD + número completo.
              </p>
            )}
            {isValidLocal && (
              <p className="text-xs text-muted-foreground font-mono">
                Será salvo como: <span className="text-foreground">+{selectedDdi} {localDigits}</span>
              </p>
            )}
            {!localDigits && !isPhoneLocked && (
              <p className="text-xs text-muted-foreground">
                Digite apenas DDD + número. Ex: <span className="font-mono">{selectedCountry.placeholder}</span>
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Save button ── */}
      <Button
        onClick={handleSave}
        className="w-full"
        disabled={saving || (localDigits.length > 0 && !isValidLocal)}
      >
        <Save className="mr-2 h-4 w-4" />
        {saving ? "Salvando..." : "Salvar"}
      </Button>
    </div>
  );
}
