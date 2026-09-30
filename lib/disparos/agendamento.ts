/**
 * O HORÁRIO de um disparo — digitado no fuso da ORGANIZAÇÃO, gravado em UTC.
 *
 * O editor usava `datetime-local` + `new Date(valor)`, que interpreta a hora no
 * fuso do NAVEGADOR: quem agenda de um notebook em outro fuso (ou com o relógio
 * do sistema errado) mandava o disparo para outra hora, e a tela nunca dizia em
 * que fuso a hora valia. Agora a data e a hora são lidas no fuso da organização
 * (`organizations.timezone`, com o piso de `lib/tempo/fusos.ts`), e a tela
 * mostra qual é.
 *
 * Puro de propósito: é a conta que decide QUANDO milhares de mensagens saem, e
 * ela tem de ser medida sem tela.
 */
import { instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";

/** Folga para o relógio de quem clica: "agora mesmo" não pode virar "passado". */
export const FOLGA_DO_AGENDAMENTO_MS = 60_000;

export function fusoDoAgendamento(fuso: string | null | undefined): string {
  return fuso && fusoValido(fuso) ? fuso : FUSO_PADRAO;
}

const DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
const HORA = /^(\d{2}):(\d{2})$/;

/**
 * `AAAA-MM-DD` + `HH:mm` no fuso → o instante. `null` quando a data ou a hora
 * não são válidas (31/02, 25:00) — nunca um instante "corrigido" em silêncio.
 */
export function instanteDoAgendamento(data: string, hora: string, fuso: string): Date | null {
  const d = DATA.exec(data.trim());
  const h = HORA.exec(hora.trim());
  if (!d || !h) return null;
  const [ano, mes, dia] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [horas, minutos] = [Number(h[1]), Number(h[2])];
  if (mes < 1 || mes > 12 || dia < 1 || horas > 23 || minutos > 59) return null;
  // Dia que não existe no mês (31/04): o `Date.UTC` rolaria para o mês seguinte.
  const conferencia = new Date(Date.UTC(ano, mes - 1, dia));
  if (conferencia.getUTCMonth() !== mes - 1 || conferencia.getUTCDate() !== dia) return null;
  return instanteDe({ ano, mes, dia, hora: horas, minuto: minutos }, fusoDoAgendamento(fuso));
}

/** O instante gravado, de volta para os dois campos da tela, no fuso. */
export function paredeDoAgendamento(iso: string | null | undefined, fuso: string): { data: string; hora: string } {
  if (!iso) return { data: "", hora: "" };
  const instante = new Date(iso);
  if (Number.isNaN(instante.getTime())) return { data: "", hora: "" };
  const p = partesNoFuso(instante, fusoDoAgendamento(fuso));
  const dois = (n: number) => String(n).padStart(2, "0");
  return { data: `${p.ano}-${dois(p.mes)}-${dois(p.dia)}`, hora: `${dois(p.hora)}:${dois(p.minuto)}` };
}

/** O horário já passou (com a folga)? É o que recusa agendar para ontem. */
export function horarioJaPassou(instante: Date | string, agora: Date = new Date()): boolean {
  const t = typeof instante === "string" ? new Date(instante).getTime() : instante.getTime();
  return Number.isNaN(t) || t < agora.getTime() - FOLGA_DO_AGENDAMENTO_MS;
}

/**
 * O que impede o agendamento, em português, ou `null`. `data` e `hora` vazios
 * juntos = "enviar agora", que é válido.
 */
export function problemaDoAgendamento(
  data: string,
  hora: string,
  fuso: string,
  agora: Date = new Date(),
): string | null {
  if (!data.trim() && !hora.trim()) return null;
  if (!data.trim() || !hora.trim()) return "Informe a data e a hora do envio.";
  const instante = instanteDoAgendamento(data, hora, fuso);
  if (!instante) return "Data ou hora inválida.";
  if (horarioJaPassou(instante, agora)) return "Este horário já passou. Escolha um horário futuro.";
  return null;
}
