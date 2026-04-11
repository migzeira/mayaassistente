/**
 * classify.ts — pure intent classification and parser helpers.
 * Extracted from whatsapp-webhook for testability.
 * No external dependencies (no Supabase, no Evolution API).
 */

// INTENT CLASSIFIER (regex first, sem custo IA)
// ─────────────────────────────────────────────
export type Intent =
  | "greeting"
  | "finance_record"
  | "finance_report"
  | "finance_delete"
  | "category_list"
  | "budget_set"
  | "budget_query"
  | "recurring_create"
  | "habit_create"
  | "habit_checkin"
  | "habit_checkin_choose"
  | "notes_delete"
  | "notes_delete_confirm"
  | "agenda_create"
  | "agenda_query"
  | "agenda_lookup"
  | "agenda_edit"
  | "agenda_delete"
  | "notes_save"
  | "reminder_set"
  | "reminder_list"
  | "reminder_cancel"
  | "reminder_edit"
  | "reminder_snooze"
  | "event_followup"
  | "statement_import"
  | "shadow_finance_confirm"
  | "shadow_event_confirm"
  | "shadow_reminder_confirm"
  | "send_to_contact"
  | "schedule_meeting"
  | "contact_save"
  | "contact_save_confirm"
  | "list_contacts"
  | "reminder_delegate"
  | "finance_delete_confirm"
  | "agenda_edit_choose"
  | "ai_chat";

export function classifyIntent(msg: string): Intent {
  const m = msg
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // Saudação simples — deve ser primeira verificação (antes de qualquer outro intent)
  if (
    /^(oi|ola|olá|hello|hi|hey|bom dia|boa tarde|boa noite|hola|buenos dias|buenas tardes|buenas noches|good morning|good afternoon|good evening|good night|e ai|e aí|salve|fala|opa|tudo bem|tudo bom|como vai|como estas|como esta)[\s!,?.]*$/.test(m)
  )
    return "greeting";

  // Definir orçamento/meta
  if (
    /maximo.{0,20}(gastar|gasto)|orcamento.{0,15}(de |pra |para )|meta.{0,15}(de |pra |para )?(gasto|gastar)|limite.{0,15}(de |pra |para )?(gasto|gastar)|definir (orcamento|meta|limite)|criar (orcamento|meta|limite)|quero gastar no maximo/.test(m)
  )
    return "budget_set";

  // Consultar orçamento/meta
  if (
    /como.{0,10}(estou|esta|tá|ta).{0,10}orcamento|meu orcamento|minha meta|status.{0,10}orcamento|orcamento de|meta de (gasto|alimenta|transport|morad|saude|lazer|educa|trabalh)/.test(m)
  )
    return "budget_query";

  // Criar habito
  if (
    /(criar|quero|adicionar|comecar|iniciar|novo).{0,15}(habito|rotina|costume)|habito de .{3,}|rotina de .{3,}/.test(m)
  )
    return "habit_create";

  // Check-in de habito (respostas curtas apos lembrete)
  if (
    /^(fiz|feito|pronto|concluido|completo|done|check|✅|✔️|👍|sim fiz|fiz sim|ja fiz)\s*[!.]?$/.test(m)
  )
    return "habit_checkin";

  // Transação recorrente (antes de finance_record)
  if (
    /todo (dia|mes|m[eê]s|semana|ano).{0,30}(pago|gasto|recebo|ganho|cobr|custa|debito|aluguel|salario|netflix|spotify|gym|academia|assinatura|mensalidade|parcela|fatura|conta de)/i.test(m) ||
    /(aluguel|salario|sal[aá]rio|netflix|spotify|academia|mensalidade|assinatura|parcela|fatura).{0,20}(todo|mensal|semanal|diario)/i.test(m) ||
    /(criar|adicionar|cadastrar|registrar).{0,10}(recorrente|fixo|fixa)/i.test(m)
  )
    return "recurring_create";

  // Listar categorias (antes de finance_report pra priorizar)
  // "quais categorias tenho?" / "mostra minhas categorias" / "lista de categorias"
  if (
    /\b(quais|minhas|liste?|lista(r)?|mostra(r)?|ver|veja|mostre)\s+(s[ãa]o\s+)?(minhas\s+|as\s+|de\s+|das\s+|os\s+)?categorias?\b/.test(m) ||
    /^(categorias?|minhas categorias)\s*\??$/.test(m) ||
    /\b(que|quais)\s+categorias?\s+(eu\s+)?(tenho|existe|temos)\b/.test(m)
  )
    return "category_list";

  // Deletar/apagar transação (antes de finance_record pra priorizar) — EXPANDIDO
  if (
    // Apagar última/últimas transações
    /\b(apaga(r)?|deleta(r)?|remove(r)?|exclui(r)?|cancela(r)?|tira(r)?)\s+(a\s+|o\s+|as\s+|os\s+)?(ultima?|ultimo|ultimas?|ultimos)\s+(transacao|transacoes|gasto|gastos|despesa|despesas|receita|receitas|lancamento|lancamentos)\b/.test(m) ||
    // Apagar transação específica: "apaga o gasto de [X]"
    /\b(apaga(r)?|deleta(r)?|remove(r)?|exclui(r)?|cancela(r)?)\s+(a\s+|o\s+)?(transacao|gasto|despesa|receita|lancamento)\s+(de|do|da)\s+/.test(m) ||
    // Apagar transação com demonstrativo: "apaga esse/aquele gasto"
    /\b(apaga(r)?|deleta(r)?|remove(r)?|exclui(r)?|tira(r)?)\s+(aquele|aquela|esse|essa|esse|esta|este)\s+(gasto|despesa|transacao|receita|lancamento|movimento)/.test(m) ||
    // Variação casual: "tira isso", "remove essa transação"
    /\b(tira|remove|apaga|deleta)\s+(essa transacao|esse movimento|aquele gasto|essa despesa|essa receita)/.test(m) ||
    // "desfaz", "cancela o lançamento"
    /\b(desfaz|desfazer|cancela|cancelo)\s+(o|a)?\s+(lancamento|movimento|transacao|gasto)/.test(m) ||
    // "não quero esse gasto" / "tira isso"
    /\b(nao quero|tira|remove|apaga|deleta)\s+(esse|aquele|isso|esse gasto|essa despesa)\b/.test(m)
  )
    return "finance_delete";

  // Relatório financeiro (antes de finance_record para evitar falso positivo)
  // Expandido: inclui "quanto", "quantos", "quantas", "qual", "mes passado", "semana passada",
  // "ano passado", "media", "gasto medio", nomes de mês, "em [categoria]", etc.
  if (
    /quanto.{0,15}(gastei|ganhei|recebi|devo|entrou|saiu|sobrou|restou)/.test(m) ||
    /quant[ao]s\s+(gastos?|despesas?|receitas?|transacoes?|lancamentos?|reais)\s+/.test(m) ||
    /total (de |dos |das )?(gastos?|despesas?|receitas?)/.test(m) ||
    /\b(relat[oó]rio|resumo)\b.*(financ|gasto|despesa|receita|mes|semana|hoje|ontem)/.test(m) ||
    /^(relat[oó]rio|resumo)\s*(financeiro|do mes|da semana|de hoje|de ontem)?\s*\??$/.test(m) ||
    /\b(meus|minhas)\s+(gastos?|despesas?|receitas?|lancamentos?)\b/.test(m) ||
    /\b(gast[oa]s?\s+)?(de\s+)?(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/.test(m) ||
    /\b(gasto|despesa|receita)\s+(medi[oa]|total|geral)\b/.test(m) ||
    /\b(qual|quanto|como)\s+(e|esta|foi|ficou)\s+(meu|minha)\s+(saldo|balanco|financeiro|extrato)\b/.test(m) ||
    /\bmeu\s+(saldo|balanco|extrato)\b/.test(m) ||
    /\bextrato\b/.test(m) ||
    /\bgastei\s+(mais|menos|muito|pouco)\s+(com|em|de)\s+/.test(m) ||
    // "em alimentação mês passado?" — pergunta implícita
    /\b(em|com|de)\s+\w+\s+(mes\s+passado|semana\s+passada|ano\s+passado|anterior)\b/.test(m)
  )
    return "finance_report";

  // Registro financeiro — expandido com MUITO mais variações coloquiais
  if (
    /gastei|comprei|paguei|recebi|ganhei|custou|vale |custa |despesa|despendi|gasei/.test(m) ||
    // Variações: "gasta", "gastos", "gasto", "tá custando"
    /\b(gasto|gastos?|tá custando|custou|custa|custa|sai|saiu)\b/.test(m) ||
    // Frases coloquiais: "só ontem gasto 100", "meu dinheiro tá saindo"
    /\b(meu|minha)\s+(dinheiro|grana|grana|money)\s+(sai|tá saindo|saiu)/.test(m) ||
    // "de quanto" — "saiu de quanto ontem?"
    /\bde quanto\b/.test(m) ||
    // Números + categorias implícitas: "100 gasolina", "50 almoço"
    /^\d+\s+(de\s+)?(gasolina|uber|netflix|aluguel|mercado|bar|lancamento|transacao)/i.test(m)
  )
    return "finance_record";

  // Salvar contato digitado (nome + número no texto)
  // "salva o contato João 11999" / "adiciona o João: 11999" / "guarda o numero da Cibele 11999"
  if (
    /\b(salva(r)?|adiciona(r)?|cadastra(r)?|guarda(r)?|registra(r)?)\s+(o\s+)?(contato|numero|telefone)\s+(d[oa]\s+)?[A-ZÁÉÍÓÚ]/i.test(m) ||
    /\b(salva(r)?|adiciona(r)?)\s+(o\s+)?[A-ZÁÉÍÓÚ][a-záéíóú]+.{0,20}\d{8,}/i.test(m)
  )
    return "contact_save";

  // Agendar reunião com Google Meet E enviar link para o contato
  // Só dispara quando o usuário explicitamente pede pra mandar/notificar o contato
  // Ex: "marca reunião com Guilherme e manda o link pra ele"
  //     "agenda call com João e avisa ele" / "cria meet com Maria e envia o convite"
  if (
    /\b(marca(r)?|agenda(r)?|cria(r)?|marcar)\s+(uma?\s+)?(reuniao|meeting|call|chamada|videochamada|videoconferencia|conferencia)\s+(com|pra|para)\s+\w/i.test(m) &&
    /\b(manda(r)?|envia(r)?|avisa(r)?|notifica(r)?|compartilha(r)?)\s+(o\s+)?(link|convite|invite|meet|reuniao)\b|\b(e\s+)?(manda|envia|avisa)\s+(pra|para|ele|ela)\b/i.test(m)
  )
    return "schedule_meeting";

  // Listar contatos salvos na Maya
  if (
    /\b(meus|minha|quais|lista(r)?|mostra(r)?|ver|veja|mostre)\s+(os\s+)?(meus\s+)?(contatos?|numeros?|pessoas?)\s*(salvos?|cadastrados?|da maya|que tenho)?\b/i.test(m) ||
    /\bquem\s+(tenho|esta|estao|tenho\s+salvo)\s*(nos\s+)?(contatos?|agenda)?\b/i.test(m) ||
    /\bcontatos?\s+salvos?\b/i.test(m)
  )
    return "list_contacts";

  // Enviar mensagem para um contato salvo — MUITO EXPANDIDO
  // "manda mensagem pra cibele dizendo X" / "manda uma mensagem pro João que..."
  // "fala pra/pro X que..." / "daqui 30min manda pra X..."
  // "manda msg pra [name] meu amor falando X" / "escreve pra [name] que..."
  if (
    // Formas diretas com verbo + (artigo) + (mensagem) + preposição + nome
    /\b(manda(r)?|envia(r)?|fala(r)?|diz(er)?|avisa(r)?|escreve(r)?|manda(r)?)\s+(uma?|a)?\s*(mensagem|msg)\s+(pra|para|pro|ao|ó|à|ao)\s+\w/i.test(m) ||
    // Variação: verbo + preposição + nome (sem "mensagem" explícito)
    /\b(fala(r)?|diz(er)?|avisa(r)?|conta(r)?|comenta(r)?)\s+(pra|para|pro|ao)\s+\w+\s+(que|dizendo|falando|sobre|com)/i.test(m) ||
    // "manda pra X dizendo/falando/contando Y"
    /\b(manda(r)?|envia(r)?|passa(r)?)\s+(pra|para|pro|ao)\s+\w+\s+(dizendo|falando|contando|falando que|dizendo que)/i.test(m) ||
    // Variação com "meu", "minha" (ex: "manda pro João meu amor")
    /\b(manda(r)?|envia(r)?|fala(r)?)\s+(pra|para|pro|ao)\s+\w+\s+(meu|minha)\s+\w+\s+(falando|dizendo|que)\b/i.test(m) ||
    // Imperativo simples: "manda pra [nome]" ou "fala pro [nome]"
    /^\s*(manda|envia|fala|conta|escreve)\s+(pra|para|pro)\s+\w+/i.test(m)
  ) &&
    !/\b(lembrete|reminder|me avisa|me lembra|agenda|marcar|agendar)\b/i.test(m)
  )
    return "send_to_contact";

  // Criar agenda — EXPANDIDO com mais variações naturais
  if (
    // Formas diretas: "marca", "marcar", "agenda", "agendar"
    /\b(marca(r)?|agenda(r)?)\b.*(reuniao|meeting|consulta|compromisso|evento|appointment|call|chamada)/.test(m) ||
    // "marcar/agendar com [pessoa]"
    /\b(marca(r)?|agenda(r)?).*(com|comigo|contigo|pro|pra)\s+\w+/.test(m) ||
    // "tenho reunião/consulta/compromisso em/no/dia"
    /\btenho\s+(reuniao|consulta|compromisso|encontro|meeting)\b.*(em|no|dia|amanha|semana)/.test(m) ||
    // "colocar/adicionar/criar na agenda"
    /\b(coloca(r)?|adiciona(r)?|cria(r)?|bota(r)?|salva(r)?)\s+(na|em)?\s*(agenda|calendário|calendario)/.test(m) ||
    // "vou ao médico/dentista/hospital" + indicação de quando
    /\bvou\s+(ao|a|para o|para a|na)\s+(medico|medica|dentista|hospital|clinica|especialista)\b/.test(m) ||
    // "preciso ir ao/ir para"
    /\b(preciso ir|vou|vou ter que ir|tenho que ir)\s+(ao|a|para|na)\s+(medico|dentista|hospital|clinica)/.test(m) ||
    // "marcar com o médico/dentista"
    /\b(marca(r)?|agenda(r)?|marca|agenda)\s+(com o|com a|pro|pra)\s+(medico|medica|dentista|doutor|doutora|dr|dra)/.test(m) ||
    // Palavras-chave diretas
    /^(reuniao|meeting|compromisso|evento|consulta|encontro)[\s:,]/.test(m) ||
    // "novo/nova compromisso/reunião/consulta/evento"
    /\b(novo|nova)\s+(compromisso|reuniao|consulta|evento|meeting|encontro)\b/.test(m) ||
    // "próxima semana vou ter" / "daqui 3 dias tenho"
    /\b(proxima|semana|daqui|em|amanha)\b.*(tenho|vou ter|vou fazer|preciso)/.test(m)
  )
    return "agenda_create";

  // Consultar agenda — expandido com "quais", "quantos", "primeiro", "próximo"
  if (
    /o que (tenho|tem) (hoje|amanha|marcado|essa semana|semana|na agenda)/.test(m) ||
    /minha agenda/.test(m) ||
    /(proximos?|pr[oó]ximos?) (eventos?|compromissos?|reunioes?|consultas?)/.test(m) ||
    /(agenda de|agenda do|agenda da|agenda dessa|agenda desta) (hoje|amanha|semana|mes)/.test(m) ||
    /meus compromissos/.test(m) ||
    /tem algo marcado/.test(m) ||
    /compromissos de (hoje|amanha|semana)/.test(m) ||
    /agenda dessa semana|compromissos da semana/.test(m) ||
    /eventos? (de|da|do) (hoje|amanha|semana|mes)/.test(m) ||
    /o que tenho marcado/.test(m) ||
    // NOVO: "quais compromissos tenho amanhã?" / "quais eventos" / "quais reuniões"
    /\bquais\s+(s[ãa]o\s+)?(meus\s+)?(compromissos?|eventos?|reunioes?|consultas?|tarefas?)\b/.test(m) ||
    // "quantos compromissos tenho hoje?"
    /\bquantos?\s+(compromissos?|eventos?|reunioes?|consultas?|tarefas?)\b/.test(m) ||
    // "qual é meu próximo/primeiro compromisso?"
    /\b(qual|quando)\s+(e|é|foi)\s+(meu|minha)\s+(proximo|proxima|pr[oó]ximo|pr[oó]xima|primeiro|primeira|ultimo|ultima)\s+(compromisso|evento|reuniao|consulta|tarefa)/.test(m) ||
    /\b(proximo|pr[oó]ximo|primeiro)\s+(compromisso|evento|reuniao|consulta)/.test(m) ||
    // "tenho algum compromisso amanhã?"
    /\btenho\s+(algum|algo)\s+(compromisso|evento|reuniao|consulta)\b/.test(m)
  )
    return "agenda_query";

  // Deletar nota/anotação — ANTES de notes_save pra priorizar
  // "apaga a nota sobre X", "deleta anotacao de reunião", "remove a ultima anotacao"
  if (
    /\b(apaga(r)?|deleta(r)?|remove(r)?|exclui(r)?)\s+(a\s+|o\s+|as\s+|os\s+)?(ultima?|ultimo|ultimas?|ultimos)\s+(nota|notas|anotacao|anotacoes)\b/.test(m) ||
    /\b(apaga(r)?|deleta(r)?|remove(r)?|exclui(r)?)\s+(a\s+|o\s+)?(nota|anotacao)\s+(de|do|da|sobre)\s+/.test(m) ||
    /\b(apaga(r)?|deleta(r)?|remove(r)?|exclui(r)?)\s+(aquela|essa|esta)\s+(nota|anotacao)/.test(m)
  )
    return "notes_delete";

  // Salvar nota — MUITO EXPANDIDO para formas diretas, casuais e indiretas
  if (
    // Formas diretas com palavra-chave no início
    /^(anota|anotacao|anote|salva|escreve|registra|guarda|coloca|bota|grava)[\s:,]/.test(m) ||
    /^nota[\s:,]|^toma nota\b|^presta atencao\b|^memoriza\b|^decora\b/.test(m) ||
    // "anota ai", "salva ai", "guarda isso", "bota ai", "coloca ai", "marca ai", "salva isso"
    /\b(anota|salva|guarda|escreve|registra|bota|coloca|grava|memoriza|decora|marca) (ai|isso|aqui|pra mim|isso ai|nisso)\b/.test(m) ||
    // "marca ai" (sem referência à agenda)
    /^marca (ai|isso|aqui|pra mim)\b/.test(m) ||
    // Formas explícitas de intenção: "quero", "pode", "preciso", "por favor"
    /^(quero|pode|preciso que voce|por favor) (anotar|salvar|registrar|guardar|escrever|decorar|memorizar)\b/.test(m) ||
    /^(pode |por favor )?(anotar|salvar|registrar|guardar|escrever|memorizar) (isso|esse|essa|aqui|ai)\b/.test(m) ||
    // "faz/faca/cria uma anotacao/nota pra mim" — imperativo com substantivo
    /(faz|faca|faça|cria|crie|criar|fazer|me faz|me faca) (uma |a )?(anota(cao|cao|c[aã]o)|nota|anotacao)\b/.test(m) ||
    // "quero criar/fazer uma nota/anotacao"
    /(quero|preciso|pode) (criar|fazer|registrar|salvar|escrever) (uma |a )?(nota|anotacao)\b/.test(m) ||
    // "escreve isso pra mim" / "escreve essa info"
    /\b(escreve|anota|salva|registra|bota|coloca)\s+(essa|esse|aquela|aquele)\s+(info|informacao|coisa|dados|dado)\b/.test(m) ||
    // título de anotação explícito
    /titulo (da|de|dessa?) anota(c[aã]o|cao)|titulo da nota|nome da nota/.test(m) ||
    // Frases de contexto: "pra não esquecer", "preciso lembrar"
    /para nao esquecer|pra nao esquecer|nao quero esquecer|guarda isso|salva pra depois/.test(m) ||
    /preciso lembrar|lembrar de |importante|nao posso esquecer/.test(m) ||
    // Imperativo casual: "documenta", "puxa aí"
    /^\b(documenta|puxa|escreve|coloca|guarda|salva)\b.+/i.test(m)
  )
    return "notes_save";

  // Snooze de lembrete — adiar um lembrete que JÁ foi disparado
  // IMPORTANTE: só ativa com "de novo", "novamente", "isso", "adiar", "snooze" etc.
  // NÃO ativa com "me lembra daqui X sobre Y" (isso é reminder_set)
  if (
    /^snooze\b/.test(m) ||
    /^snooze\s+(por|de|em)?\s*\d+\s*(min|minuto|minutos|h|hora|horas)/.test(m) ||
    m === "adiar" || m === "adia" ||
    /^adiar?\s+\d+\s*(min|minuto|hora)/.test(m) ||
    /^(adia|adiar)\s+(por|em|de)\s*\d+/.test(m) ||
    /me lembra (de novo|novamente) (daqui|em)/.test(m) ||
    /me lembra isso (daqui|em) \d/.test(m) ||
    /me avisa (de novo|novamente) (daqui|em) \d/.test(m) ||
    /manda (de novo|novamente) (daqui|em) \d/.test(m) ||
    /repete (daqui|em) \d/.test(m) ||
    /avisa (de novo|novamente) (daqui|em) \d/.test(m) ||
    /(de novo|novamente) em \d/.test(m) ||
    /daqui a pouco de novo/.test(m)
  ) return "reminder_snooze";

  // Listar lembretes — expandido com "quantos", "próximo", "tem algum"
  if (
    /^(quais|mostra|lista|ver|veja|mostre|me mostra)\s+(s[ãa]o\s+)?(meus\s+)?lembretes?/.test(m) ||
    /^meus lembretes?$/.test(m) ||
    /^(tem|tenho|tenho\s+algum)\s+(lembrete|lembretes)\s*(pendente|ativo|marcado)?/.test(m) ||
    /^(lembretes?\s*(pendentes?|ativos?|marcados?))$/.test(m) ||
    // NOVO: "quantos lembretes tenho?"
    /\bquantos?\s+lembretes?\b/.test(m) ||
    // "qual é meu próximo/primeiro lembrete?"
    /\b(qual|quando)\s+(e|é|foi)\s+(meu|minha)\s+(proximo|proxima|pr[oó]ximo|pr[oó]xima|primeiro|primeira|ultimo|ultima)\s+lembrete/.test(m) ||
    /\b(proximo|pr[oó]ximo|primeiro)\s+lembrete\b/.test(m) ||
    // "quais são meus lembretes de hoje/amanhã/semana"
    /\blembretes?\s+(de|da|do|dessa|desta)\s+(hoje|amanha|semana|mes|tarde|manha|noite)\b/.test(m) ||
    // "lembretes de hoje"
    /^lembretes?\s+(de|da|do|dessa|desta)?\s*(hoje|amanha|semana|mes)\s*\??$/.test(m)
  ) return "reminder_list";

  // Cancelar lembrete — EXPANDIDO
  if (
    // Formas diretas com imperativo
    /^(cancela|cancelar|remove|apaga|deleta|exclui|tira)\s+(o\s+)?(lembrete|aviso|alarme|notificacao)\s+(d[eo]\s+)?.+/.test(m) ||
    /^(cancela|remove|apaga|deleta|tira)\s+lembrete\b/.test(m) ||
    // "cancela esse/aquele lembrete"
    /\b(cancela|remove|apaga|deleta|exclui|tira)\s+(esse|essa|aquele|aquela)\s+(lembrete|aviso|alarme)/.test(m) ||
    // "não preciso desse lembrete"
    /\b(nao preciso|nao quero|tira)\s+(desse|dessa|aquele|aquela)\s+(lembrete|aviso|notificacao)/.test(m) ||
    // "desfaz o lembrete"
    /\b(desfaz|desfazer|cancelo)\s+(o|a)?\s+(lembrete|aviso|alarme)/.test(m) ||
    // Variação casual: "tira isso"
    /^(tira|apaga|deleta|remove|cancela)\s+(isso|aquilo)\b/.test(m)
  ) return "reminder_cancel";

  // Editar lembrete (muda horário ou dia) — EXPANDIDO
  if (
    // Formas diretas: "muda", "altera", "reagenda"
    /^(muda|mudar|alterar|altera|atualiza|reagenda|remarca|atrasa|antecipa)\s+(o\s+)?(lembrete|aviso|notificacao)\s+(d[eo]\s+)?.+/.test(m) ||
    // "lembrete de X para [tempo]"
    /(lembrete\s+d[eo]\s+.+\s+para?\s+\d|lembrete\s+para?\s+\d)/.test(m) ||
    // "muda o horário do lembrete"
    /\bmuda?\s+(o|a)\s+(hora|horario|dia|data|tempo)\s+(do|da|de)?\s+(lembrete|aviso)/.test(m) ||
    // "atrasa o lembrete" / "antecipa o lembrete"
    /\b(atrasa|antecipa|adia|move)\s+(o|a)?\s+(lembrete|aviso|notificacao)/.test(m) ||
    // "remarca/reagenda o lembrete para"
    /\b(reagenda|remarca|altera)\s+(o|a)?\s+(lembrete|aviso)\s+(para|pra)/.test(m) ||
    // Variação casual: "muda pra outro horário"
    /\b(muda|altera|troca)\s+(pra|para)\s+(outro|outra|um outro|uma outra)\s+(horario|hora|dia|tempo)/.test(m)
  ) return "reminder_edit";

  // Lembrete simples — cobre formas imperativas, subjuntivo e indiretas — EXPANDIDO
  if (
    // Formas diretas: "me lembra", "me lembre", "me avisa", etc.
    /^me lembra\b|^me lembre\b|^me avisa\b|^me notifica\b|^me alerta\b/.test(m) ||
    // Formas de criação explícita
    /^quero um lembrete|^cria(r)? (um )?lembrete|^salva (um )?lembrete|^adiciona (um )?lembrete|^lembrete:|^quero ser lembrado\b/.test(m) ||
    // "me lembra/lembre" em qualquer posição com referência de tempo/assunto
    /\bme lembra (de|que|do|da|desse|disso|às|as|amanha|hoje|semana|todo|toda|daqui|em \d|dia \d|sobre)\b/.test(m) ||
    /\bme lembre (de|que|do|da|desse|disso|às|as|amanha|hoje|semana|todo|toda|daqui|em \d|dia \d|sobre)\b/.test(m) ||
    /\bme avisa (às|as|quando|amanha|hoje|dia \d|daqui)\b/.test(m) ||
    // Variações: "te lembra", "você me lembra", "me notifica", "me alerta"
    /\bme notifica (de|que|às|amanha|daqui)\b/.test(m) ||
    /\bme alerta (de|que|para|sobre|daqui)\b/.test(m) ||
    // Formas indiretas: "voce me lembra", "quero que voce me lembra/lembre"
    /\b(voce|você) me (lembra|lembre|avisa|notifica|alerta)\b/.test(m) ||
    /(quero que|pode|preciso que|por favor).*(me lembra|me lembre|me avisa|me notifica|me alerta)\b/.test(m) ||
    // "nao quero esquecer de" + tempo/assunto
    /\b(nao quero esquecer|preciso lembrar|lembrar de|tenho que lembrar)\b.*(daqui|em \d|amanha|hoje)\b/.test(m)
  ) return "reminder_set";

  // Buscar evento específico
  if (/voce lembra (do|da|de) (meu|minha)|lembra (do|da|de) (meu|minha)|tem (meu|minha) .{2,30} marcad|qual (e|é) (meu|minha)|quando (e|é) (meu|minha)|tem algo (marcado|agendado) (dia|no dia|para)/.test(m))
    return "agenda_lookup";

  // Cancelar/excluir evento direto (sem edição) — EXPANDIDO
  if (
    // Formas diretas com imperativo
    /^(cancela|exclui|apaga|deleta|remove|desmarca|tira)\s+(meu|minha|o|a)?\s*.{2,40}$/.test(m) ||
    // "não vou mais ao/a/para"
    /\b(nao vou mais|nao vou|cancela|cancelei|exclui|apaguei)\s+(ao|a|para o|para a|na|no)\s+.{2,30}/.test(m) ||
    // "cancela/deleta o evento/reunião/compromisso/consulta"
    /(cancela|exclui|apaga|deleta|desmarca|tira)\s+(o evento|a reuniao|o compromisso|a consulta|a consulta com|o evento de|a reuniao de|o|a)\s+.{2,30}/.test(m) ||
    // "remove esse/aquele compromisso/evento"
    /(cancela|remove|apaga|deleta|exclui)\s+(esse|essa|aquele|aquela|meu|minha)\s+(compromisso|evento|reuniao|consulta|encontro|meeting)/.test(m) ||
    // "não preciso mais ir" / "não tenho mais"
    /\b(nao preciso|nao vou|nao tenho mais)\s+(ir|comparecer|ir ao|ir para)/.test(m) ||
    // "cancela tudo" / "tira esse agendamento"
    /\b(cancela tudo|tira esse|remove isso|apaga isso)\b/.test(m)
  )
    return "agenda_delete";

  // Editar/remarcar evento — EXPANDIDO
  if (
    // Formas diretas: "muda", "altera", "remarca", "atrasa", "antecipa"
    /(mudei|muda|mude|alterei|altera|altere|remarca|remarcar|atualiza|atrasa|antecipa|adia)\s+.{0,20}(dia|hora|horario|data|evento|compromisso|reuniao|consulta)/.test(m) ||
    // "mudei de data/dia/hora"
    /\bmudei\s+(de|pra|para)\s+(data|dia|hora|horario)/.test(m) ||
    // "não é mais [dia/hora]"
    /\bnao\s+(e|é|será)\s+mais\s+(dia|hora|amanha|segunda)/.test(m) ||
    // "[evento] agora é [dia/hora]" / "[evento] mudou para [dia/hora]"
    /\b(agora|mudou|fica|fica para)\s+(e|é|pra|para)\s+(dia|hora|\d+)/.test(m) ||
    // "muda o dia/hora/horário"
    /\bmuda?\s+(o|a)\s+(dia|hora|horario|data)/i.test(m) ||
    // "move pra outro dia" / "atrasa a reunião"
    /\b(move|move|atrasa|antecipa|adia)\s+(pra|para|em|no)\s+.{2,20}/.test(m) ||
    // "preciso reagendar" / "preciso remarcar"
    /\b(preciso|vou)\s+(reagendar|remarcar|adiar|antecip|mover)/.test(m) ||
    // "trocar o dia/hora de"
    /\b(trocar|mudar|alterar)\s+(o|a)\s+(dia|hora|horario)\s+(de|do|da)/.test(m)
  )
    return "agenda_edit";

  return "ai_chat";
}

/** Returns true when the user declines a reminder (says "not needed") */
export function isReminderDecline(msg: string): boolean {
  const m = msg.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  return /^(nao|n|nope|nah|sem lembrete|nao precisa|nao quero|dispenso|pode nao|nao obrigado|nao, obrigado|ta bom assim|nao quero lembrete|sem aviso)$/.test(m);
}

/** Returns true when user wants reminder at exact time (not advance) */
export function isReminderAtTime(msg: string): boolean {
  const m = msg.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  return /(so (me avisa|avisa|notifica) na hora|na hora|no horario|quando chegar a hora|so na hora|avisa na hora|me avisa na hora|no momento)/.test(m);
}

/** Returns true when user accepts/wants a reminder (without specifying time) */
export function isReminderAccept(msg: string): boolean {
  const m = msg.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  return /^(sim|s|quero|pode ser|claro|por favor|bora|pode|yes|ok|beleza|blz|com certeza|isso|quero sim|pode|quero ser lembrado)$/.test(m);
}

/**
 * Parses advance notice in minutes from natural language.
 * Returns null if not parseable.
 * Examples: "15 min" → 15, "1 hora" → 60, "meia hora" → 30
 */
export function parseMinutes(msg: string): number | null {
  const m = msg.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // "na hora" ou "no momento" → 0 min (avisa na hora)
  if (/(na hora|no momento|no horario|so na hora)/.test(m)) return 0;
  // "X horas antes" / "X hora antes" / "1h antes" / "2h"
  const hoursMatch = m.match(/(\d+(?:[.,]\d+)?)\s*h(ora)?/);
  if (hoursMatch) return Math.round(parseFloat(hoursMatch[1].replace(",", ".")) * 60);
  // "meia hora"
  if (/meia hora/.test(m)) return 30;
  // "hora e meia"
  if (/hora e meia/.test(m)) return 90;
  // número simples (minutos)
  const numMatch = m.match(/(\d+)/);
  if (numMatch) return parseInt(numMatch[1], 10);
  return null;
}
