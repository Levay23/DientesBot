import Layout from "@/components/layout";
import {
  useGetBillingSummary,
  useListPayments,
  useCreatePayment,
  useUpdatePayment,
  useDeletePayment,
  useListPatients,
  useListQuotations,
  useListTreatments,
  useGetPatientBilling,
  useSendPaymentReceiptWhatsapp,
  getListPaymentsQueryKey,
  getGetBillingSummaryQueryKey,
  getGetPatientBillingQueryKey,
} from "@workspace/api-client-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Search,
  Wallet,
  TrendingUp,
  AlertCircle,
  Pencil,
  Trash2,
  Calendar,
  Check,
  ChevronsUpDown,
  Banknote,
  X,
  History,
  User,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { formatMessageDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";

function formatColombiaDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function formatPriceCop(price: number) {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    minimumFractionDigits: 0,
  }).format(price);
}

function formatPaymentDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-");
  if (!y || !m || !d) return dateStr;
  return `${d}/${m}/${y}`;
}

let lineIdSeq = 0;
function newLineId() {
  lineIdSeq += 1;
  return `line-${lineIdSeq}`;
}

const METHOD_LABELS: Record<string, string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  tarjeta_debito: "Tarjeta débito",
  tarjeta_credito: "Tarjeta crédito",
  nequi: "Nequi",
  daviplata: "Daviplata",
  otro: "Otro",
};

const TYPE_LABELS: Record<string, string> = {
  abono: "Abono",
  pago_completo: "Pago completo",
  anticipo: "Anticipo",
  devolucion: "Devolución",
};

type PaymentRow = {
  id: number;
  patientId: number;
  patientName: string;
  patientPhone?: string;
  quotationId?: number | null;
  quotationTotal?: number | null;
  quotationBalance?: number | null;
  treatmentName?: string | null;
  expectedTotal?: number | null;
  amount: number;
  paymentMethod: string;
  paymentType: string;
  concept?: string | null;
  notes?: string | null;
  paymentDate: string;
  createdAt: string;
};

type PaymentLine = {
  id: string;
  treatmentName: string;
  expectedTotal: number;
  linePaid: number;
  lineBalance: number;
  abono: string;
};

const emptyMetaForm = () => ({
  patientId: "",
  quotationId: "",
  paymentMethod: "efectivo",
  paymentType: "abono",
  concept: "",
  notes: "",
  paymentDate: formatColombiaDate(),
});

function emptyCatalogLine(): PaymentLine {
  return {
    id: newLineId(),
    treatmentName: "",
    expectedTotal: 0,
    linePaid: 0,
    lineBalance: 0,
    abono: "",
  };
}

function paidForTreatment(
  payments: { treatmentName?: string | null; quotationId?: number | null; amount: number; paymentType: string }[] | undefined,
  treatmentName: string,
  quotationId?: number | null,
) {
  if (!payments?.length || !treatmentName) return 0;
  const key = treatmentName.toLowerCase();
  let sum = 0;
  for (const p of payments) {
    if (p.treatmentName?.toLowerCase() !== key) continue;
    if (quotationId != null) {
      if (p.quotationId !== quotationId) continue;
    } else if (p.quotationId != null) {
      continue;
    }
    sum += p.paymentType === "devolucion" ? -p.amount : p.amount;
  }
  return Math.max(0, sum);
}

export default function Billing() {
  const [search, setSearch] = useState("");
  const [selectedPatientId, setSelectedPatientId] = useState<number | null>(null);
  const [anchorPaymentId, setAnchorPaymentId] = useState<number | null>(null);
  const [listPatientOpen, setListPatientOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [patientOpen, setPatientOpen] = useState(false);
  const [editing, setEditing] = useState<PaymentRow | null>(null);
  const [form, setForm] = useState(emptyMetaForm);
  const [lines, setLines] = useState<PaymentLine[]>([emptyCatalogLine()]);
  const [saving, setSaving] = useState(false);
  const [sendingReceiptId, setSendingReceiptId] = useState<number | null>(null);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const listParams = { search: search.trim() || undefined };
  const { data: summary, isLoading: summaryLoading } = useGetBillingSummary();
  const { data: payments, isLoading } = useListPayments(listParams, {
    query: { queryKey: getListPaymentsQueryKey(listParams) },
  });
  const { data: patients } = useListPatients();
  const { data: quotations } = useListQuotations();
  const { data: treatments } = useListTreatments();

  const patientIdNum = form.patientId ? parseInt(form.patientId, 10) : 0;
  const { data: patientBilling, isLoading: patientBillingLoading } = useGetPatientBilling(
    patientIdNum,
    { query: { enabled: patientIdNum > 0 && dialogOpen } },
  );

  const { data: selectedPatientBilling, isLoading: selectedPatientBillingLoading } =
    useGetPatientBilling(selectedPatientId ?? 0, {
      query: { enabled: (selectedPatientId ?? 0) > 0 },
    });

  const selectedPatient = useMemo(
    () => patients?.find((p) => p.id === selectedPatientId) ?? null,
    [patients, selectedPatientId],
  );

  const patientHistory = useMemo(() => {
    const list = selectedPatientBilling?.payments ?? [];
    return [...list].sort((a, b) => {
      const dateCmp = b.paymentDate.localeCompare(a.paymentDate);
      if (dateCmp !== 0) return dateCmp;
      return b.id - a.id;
    });
  }, [selectedPatientBilling?.payments]);

  const createPayment = useCreatePayment();
  const updatePayment = useUpdatePayment();
  const deletePayment = useDeletePayment();
  const sendPaymentReceipt = useSendPaymentReceiptWhatsapp();

  const treatmentPriceByName = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of treatments ?? []) {
      if (t.active) map.set(t.name.toLowerCase(), t.price);
    }
    return map;
  }, [treatments]);

  const activeTreatments = useMemo(
    () => (treatments ?? []).filter((t) => t.active).sort((a, b) => a.name.localeCompare(b.name, "es")),
    [treatments],
  );

  const patientQuotations = useMemo(() => {
    if (!form.patientId) return [];
    const pid = parseInt(form.patientId, 10);
    const fromBilling = patientBilling?.quotations ?? [];
    if (fromBilling.length) return fromBilling;
    return (quotations ?? []).filter((q) => q.patientId === pid);
  }, [form.patientId, quotations, patientBilling?.quotations]);

  const selectedQuoteBilling = useMemo(() => {
    if (!form.quotationId || !patientBilling?.quotations) return null;
    return patientBilling.quotations.find((q) => q.id === parseInt(form.quotationId, 10)) ?? null;
  }, [form.quotationId, patientBilling?.quotations]);

  const loadLinesFromQuotation = useCallback(
    (quotationId: string) => {
      if (!quotationId) {
        setLines([emptyCatalogLine()]);
        return;
      }
      if (!patientBilling?.quotations) return;
      const quote = patientBilling.quotations.find((q) => q.id === parseInt(quotationId, 10));
      if (!quote?.items?.length) {
        setLines([emptyCatalogLine()]);
        return;
      }
      setLines(
        quote.items.map((item) => ({
          id: newLineId(),
          treatmentName: item.service ?? "",
          expectedTotal: item.lineTotal ?? Math.round((item.price ?? 0) * (item.quantity ?? 1)),
          linePaid: item.paid ?? 0,
          lineBalance: item.balance ?? 0,
          abono: "",
        })),
      );
    },
    [patientBilling?.quotations],
  );

  useEffect(() => {
    if (!dialogOpen || editing || !form.quotationId) return;
    loadLinesFromQuotation(form.quotationId);
  }, [dialogOpen, editing, form.quotationId, loadLinesFromQuotation, patientBilling?.quotations]);

  const totalAbonoToday = useMemo(
    () => lines.reduce((s, l) => s + (parseInt(l.abono, 10) || 0), 0),
    [lines],
  );

  const quoteBalanceAfter = useMemo(() => {
    if (!selectedQuoteBilling) return null;
    return Math.max(0, (selectedQuoteBilling.balance ?? 0) - totalAbonoToday);
  }, [selectedQuoteBilling, totalAbonoToday]);

  const invalidate = (patientId?: number) => {
    queryClient.invalidateQueries({ queryKey: getListPaymentsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetBillingSummaryQueryKey() });
    if (patientId) {
      queryClient.invalidateQueries({ queryKey: getGetPatientBillingQueryKey(patientId) });
    }
  };

  const openCreate = () => {
    setEditing(null);
    setForm(emptyMetaForm());
    setLines([emptyCatalogLine()]);
    setDialogOpen(true);
  };

  const openCreateForPatient = (patientId: number) => {
    setEditing(null);
    setForm({ ...emptyMetaForm(), patientId: String(patientId) });
    setLines([emptyCatalogLine()]);
    setDialogOpen(true);
  };

  const closePatient = () => {
    setSelectedPatientId(null);
    setAnchorPaymentId(null);
  };

  const openPatient = (patientId: number, paymentId?: number) => {
    const anchor = paymentId ?? null;
    if (selectedPatientId === patientId && anchorPaymentId === anchor) {
      closePatient();
      return;
    }
    setSelectedPatientId(patientId);
    setAnchorPaymentId(anchor);
  };

  const openEdit = (p: PaymentRow) => {
    setEditing(p);
    setForm({
      patientId: String(p.patientId),
      quotationId: p.quotationId ? String(p.quotationId) : "",
      paymentMethod: p.paymentMethod,
      paymentType: p.paymentType,
      concept: p.concept ?? "",
      notes: p.notes ?? "",
      paymentDate: p.paymentDate,
    });
    setLines([
      {
        id: "edit",
        treatmentName: p.treatmentName ?? "",
        expectedTotal: p.expectedTotal ?? 0,
        linePaid: 0,
        lineBalance: 0,
        abono: String(p.amount),
      },
    ]);
    setDialogOpen(true);
  };

  const updateLine = (idx: number, patch: Partial<PaymentLine>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  const onTreatmentSelect = (idx: number, name: string) => {
    const price = treatmentPriceByName.get(name.toLowerCase()) ?? 0;
    const qid = form.quotationId ? parseInt(form.quotationId, 10) : null;
    const paid = paidForTreatment(patientBilling?.payments, name, qid);
    const balance = Math.max(0, price - paid);
    updateLine(idx, {
      treatmentName: name,
      expectedTotal: price,
      linePaid: paid,
      lineBalance: balance,
    });
  };

  const payFullBalance = (idx: number) => {
    const line = lines[idx];
    if (!line) return;
    const amount = line.lineBalance > 0 ? line.lineBalance : line.expectedTotal;
    updateLine(idx, { abono: String(amount) });
  };

  const payAllBalances = () => {
    setLines((prev) =>
      prev.map((l) => ({
        ...l,
        abono: String(l.lineBalance > 0 ? l.lineBalance : l.expectedTotal > 0 ? l.expectedTotal : ""),
      })),
    );
  };

  const handleSave = async () => {
    const patientId = parseInt(form.patientId, 10);
    if (!patientId) {
      toast({ variant: "destructive", title: "Selecciona un paciente" });
      return;
    }

    const quotationId = form.quotationId ? parseInt(form.quotationId, 10) : null;

    if (editing) {
      const amount = parseInt(lines[0]?.abono ?? "", 10);
      if (!amount || amount <= 0) {
        toast({ variant: "destructive", title: "El monto del abono es obligatorio" });
        return;
      }
      const line = lines[0];
      updatePayment.mutate(
        {
          id: editing.id,
          data: {
            quotationId,
            treatmentName: line?.treatmentName || null,
            expectedTotal: line?.expectedTotal || null,
            amount,
            paymentMethod: form.paymentMethod as "efectivo",
            paymentType: form.paymentType as "abono",
            concept: form.concept || null,
            notes: form.notes || null,
            paymentDate: form.paymentDate,
          },
        },
        {
          onSuccess: () => {
            toast({ title: "Pago actualizado" });
            setDialogOpen(false);
            invalidate(patientId);
          },
          onError: () => toast({ variant: "destructive", title: "Error al actualizar" }),
        },
      );
      return;
    }

    const toSave = lines
      .map((l) => ({
        ...l,
        amount: parseInt(l.abono, 10) || 0,
      }))
      .filter((l) => l.amount > 0);

    if (!toSave.length) {
      toast({ variant: "destructive", title: "Ingresa al menos un monto a abonar" });
      return;
    }

    for (const line of toSave) {
      if (line.lineBalance > 0 && line.amount > line.lineBalance) {
        toast({
          variant: "destructive",
          title: `El abono de "${line.treatmentName || "tratamiento"}" supera el saldo pendiente`,
        });
        return;
      }
    }

    setSaving(true);
    try {
      for (const line of toSave) {
        const isFullPay = line.lineBalance > 0 && line.amount >= line.lineBalance;
        await createPayment.mutateAsync({
          data: {
            patientId,
            quotationId,
            treatmentName: line.treatmentName || null,
            expectedTotal: line.expectedTotal || null,
            amount: line.amount,
            paymentMethod: form.paymentMethod as "efectivo",
            paymentType: isFullPay ? "pago_completo" : (form.paymentType as "abono"),
            concept:
              form.concept ||
              (line.treatmentName ? `Abono — ${line.treatmentName}` : null),
            notes: form.notes || null,
            paymentDate: form.paymentDate,
          },
        });
      }
      toast({
        title: toSave.length === 1 ? "Abono registrado" : `${toSave.length} abonos registrados`,
      });
      setSelectedPatientId(patientId);
      setDialogOpen(false);
      invalidate(patientId);
    } catch {
      toast({ variant: "destructive", title: "Error al registrar pago(s)" });
    } finally {
      setSaving(false);
    }
  };

  const handleSendReceipt = (paymentId: number, patientPhone?: string | null) => {
    if (!patientPhone?.trim()) {
      toast({
        variant: "destructive",
        title: "El paciente no tiene teléfono registrado para WhatsApp",
      });
      return;
    }
    setSendingReceiptId(paymentId);
    sendPaymentReceipt.mutate(
      { id: paymentId },
      {
        onSuccess: () => {
          toast({ title: "Recibo enviado por WhatsApp al paciente" });
          setSendingReceiptId(null);
        },
        onError: (err: { message?: string }) => {
          toast({
            variant: "destructive",
            title: err?.message || "No se pudo enviar el recibo. Verifica que WhatsApp esté conectado.",
          });
          setSendingReceiptId(null);
        },
      },
    );
  };

  const handleDelete = (id: number, patientId?: number) => {
    if (!confirm("¿Eliminar este registro de pago?")) return;
    deletePayment.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Pago eliminado" });
          invalidate(patientId ?? selectedPatientId ?? undefined);
        },
        onError: () => toast({ variant: "destructive", title: "No se pudo eliminar" }),
      },
    );
  };

  const showQuotationLines = !!form.quotationId && !editing;

  const patientHistoryPanel = selectedPatientId ? (
    <Card className="border-border/50 bg-card/80 border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <CardTitle className="text-lg">{selectedPatient?.name ?? "Paciente"}</CardTitle>
            {selectedPatient?.phone && (
              <p className="text-sm text-muted-foreground mt-0.5">{selectedPatient.phone}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={closePatient}>
              Cerrar
            </Button>
            <Button size="sm" onClick={() => openCreateForPatient(selectedPatientId)}>
              <Plus className="h-4 w-4 mr-1" />
              Nuevo abono
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {selectedPatientBillingLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : selectedPatientBilling ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <div className="rounded-lg border border-border/40 p-3 bg-muted/10">
              <p className="text-xs text-muted-foreground">Total abonado</p>
              <p className="font-semibold text-emerald-500">
                {formatPriceCop(selectedPatientBilling.totalPaid ?? 0)}
              </p>
            </div>
            <div className="rounded-lg border border-border/40 p-3 bg-muted/10">
              <p className="text-xs text-muted-foreground">Deuda pendiente</p>
              <p className="font-semibold text-amber-500">
                {formatPriceCop(selectedPatientBilling.totalDebt ?? 0)}
              </p>
            </div>
            <div className="rounded-lg border border-border/40 p-3 bg-muted/10 col-span-2 sm:col-span-1">
              <p className="text-xs text-muted-foreground">Abonos registrados</p>
              <p className="font-semibold">{patientHistory.length}</p>
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-semibold text-sm">Historial de abonos</h3>
          </div>
          {selectedPatientBillingLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !patientHistory.length ? (
            <p className="text-sm text-muted-foreground py-6 text-center border border-dashed border-border/50 rounded-lg">
              Este paciente aún no tiene abonos. Usa &quot;Nuevo abono&quot; para registrar el primero.
            </p>
          ) : (
            <div className="border border-border/40 rounded-lg overflow-hidden">
              <div className="hidden sm:grid sm:grid-cols-[110px_1fr_120px_100px_100px_150px] gap-2 px-3 py-2 bg-muted/30 text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                <span>Fecha abono</span>
                <span>Tratamiento / concepto</span>
                <span className="text-right">Monto</span>
                <span>Tipo</span>
                <span>Método</span>
                <span className="text-center">Recibo</span>
              </div>
              <div className="divide-y divide-border/30 max-h-[360px] overflow-y-auto">
                {patientHistory.map((p) => (
                  <div
                    key={p.id}
                    className="grid grid-cols-1 sm:grid-cols-[110px_1fr_120px_100px_100px_150px] gap-2 px-3 py-3 text-sm hover:bg-muted/10"
                  >
                    <div className="flex sm:block items-center gap-2">
                      <span className="text-[10px] uppercase text-muted-foreground sm:hidden">Fecha</span>
                      <span className="font-medium flex items-center gap-1">
                        <Calendar className="h-3.5 w-3.5 text-muted-foreground sm:hidden" />
                        {formatPaymentDate(p.paymentDate)}
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-muted-foreground sm:hidden">
                        Tratamiento
                      </span>
                      <p className="font-medium">{p.treatmentName || p.concept || "Sin concepto"}</p>
                      {p.quotationId != null && (
                        <p className="text-xs text-muted-foreground">Presupuesto #{p.quotationId}</p>
                      )}
                      {p.expectedTotal != null && p.expectedTotal > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Total tratamiento: {formatPriceCop(p.expectedTotal)}
                        </p>
                      )}
                    </div>
                    <div className="sm:text-right">
                      <span className="text-[10px] uppercase text-muted-foreground sm:hidden">Monto</span>
                      <p
                        className={cn(
                          "font-bold tabular-nums",
                          p.paymentType === "devolucion" ? "text-red-400" : "text-emerald-400",
                        )}
                      >
                        {p.paymentType === "devolucion" ? "−" : "+"}
                        {formatPriceCop(p.amount)}
                      </p>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-muted-foreground sm:hidden">Tipo</span>
                      <Badge variant="outline" className="text-xs">
                        {TYPE_LABELS[p.paymentType] ?? p.paymentType}
                      </Badge>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-muted-foreground sm:hidden">Método</span>
                      <p className="text-muted-foreground text-xs">
                        {METHOD_LABELS[p.paymentMethod] ?? p.paymentMethod}
                      </p>
                    </div>
                    <div className="flex sm:justify-center items-center">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs gap-1.5 text-emerald-600 border-emerald-600/30 hover:bg-emerald-500/10"
                        disabled={sendingReceiptId === p.id || sendPaymentReceipt.isPending}
                        onClick={() => handleSendReceipt(p.id, selectedPatient?.phone)}
                      >
                        <Send className="h-3.5 w-3.5" />
                        {sendingReceiptId === p.id ? "Enviando..." : "Enviar por WhatsApp"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  ) : null;

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Facturación</h1>
            <p className="text-muted-foreground mt-1">
              Control de pagos, abonos y saldos vinculados a pacientes y presupuestos
            </p>
          </div>
          <Button onClick={openCreate} className="bg-primary hover:bg-primary/90">
            <Plus className="h-4 w-4 mr-2" />
            Registrar pago / abono
          </Button>
        </div>

        {summaryLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : summary ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="border-border/50 bg-card/80">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-accent" />
                  Recaudado hoy
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatPriceCop(summary.collectedToday)}</p>
              </CardContent>
            </Card>
            <Card className="border-border/50 bg-card/80">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-emerald-500" />
                  Este mes
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatPriceCop(summary.totalThisMonth)}</p>
              </CardContent>
            </Card>
            <Card className="border-border/50 bg-card/80">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total histórico</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatPriceCop(summary.totalCollected)}</p>
                <p className="text-xs text-muted-foreground">{summary.paymentsCount} movimientos</p>
              </CardContent>
            </Card>
            <Card className="border-border/50 bg-card/80">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-500" />
                  Por cobrar (presupuestos)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatPriceCop(summary.outstandingBalance)}</p>
                <p className="text-xs text-muted-foreground">
                  {summary.outstandingQuotations} presupuesto(s) con saldo
                </p>
              </CardContent>
            </Card>
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              <User className="h-3.5 w-3.5" />
              Buscar paciente (historial y abonos)
            </Label>
            <Popover open={listPatientOpen} onOpenChange={setListPatientOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  className="w-full justify-between bg-background font-normal"
                >
                  {selectedPatient
                    ? `${selectedPatient.name}${selectedPatient.phone ? ` · ${selectedPatient.phone}` : ""}`
                    : "Buscar paciente por nombre o teléfono..."}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Buscar paciente..." />
                  <CommandList className="max-h-[280px] overflow-y-auto">
                    <CommandEmpty>No se encontró el paciente.</CommandEmpty>
                    <CommandGroup>
                      {(patients ?? []).map((pt) => (
                        <CommandItem
                          key={pt.id}
                          value={`${pt.name} ${pt.phone ?? ""}`}
                          onSelect={() => {
                            openPatient(pt.id);
                            setListPatientOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              selectedPatientId === pt.id ? "opacity-100" : "opacity-0",
                            )}
                          />
                          {pt.name} {pt.phone ? `· ${pt.phone}` : ""}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              <Search className="h-3.5 w-3.5" />
              Buscar movimientos
            </Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Por paciente, teléfono o concepto..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 bg-background"
              />
            </div>
          </div>
        </div>

        {selectedPatientId && anchorPaymentId === null ? patientHistoryPanel : null}

        {isLoading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : !payments?.length ? (
          <Card className="border-border/50">
            <CardContent className="py-12 text-center text-muted-foreground">
              No hay pagos registrados. Usa &quot;Registrar pago / abono&quot; para el primer movimiento.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {(payments as PaymentRow[]).map((p) => (
              <Fragment key={p.id}>
              <Card
                className={cn(
                  "border-border/50 bg-card/80",
                  selectedPatientId === p.patientId && anchorPaymentId === p.id && "ring-1 ring-primary/40",
                )}
              >
                <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <button
                        type="button"
                        onClick={() => openPatient(p.patientId, p.id)}
                        className={cn(
                          "font-semibold text-left hover:text-primary hover:underline",
                          selectedPatientId === p.patientId && anchorPaymentId === p.id
                            ? "text-primary"
                            : "text-foreground",
                        )}
                      >
                        {p.patientName}
                      </button>
                      <Badge variant="outline">{TYPE_LABELS[p.paymentType] ?? p.paymentType}</Badge>
                      <Badge variant="secondary">{METHOD_LABELS[p.paymentMethod] ?? p.paymentMethod}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {p.concept || p.treatmentName || "Sin concepto"}
                      {p.expectedTotal != null && p.expectedTotal > 0 && (
                        <span className="ml-2 text-xs">
                          · Total tratamiento: {formatPriceCop(p.expectedTotal)}
                        </span>
                      )}
                      {p.quotationId != null && (
                        <span className="ml-2">
                          · Presupuesto #{p.quotationId}
                          {p.quotationBalance != null && p.quotationBalance > 0 && (
                            <span className="text-amber-600">
                              {" "}
                              (saldo: {formatPriceCop(p.quotationBalance)})
                            </span>
                          )}
                          {p.quotationBalance === 0 && (
                            <span className="text-emerald-600"> (pagado)</span>
                          )}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {p.paymentDate} · Registrado {formatMessageDateTime(p.createdAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                    <p
                      className={`text-xl font-bold ${
                        p.paymentType === "devolucion" ? "text-red-400" : "text-emerald-400"
                      }`}
                    >
                      {p.paymentType === "devolucion" ? "−" : "+"}
                      {formatPriceCop(p.amount)}
                    </p>
                    <Button variant="ghost" size="icon" onClick={() => openEdit(p)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      onClick={() => handleDelete(p.id, p.patientId)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
              {selectedPatientId === p.patientId && anchorPaymentId === p.id ? patientHistoryPanel : null}
              </Fragment>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Editar pago" : "Registrar pago / abono"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Paciente *</Label>
              <Popover open={patientOpen} onOpenChange={setPatientOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    disabled={!!editing}
                    className="w-full justify-between bg-background font-normal"
                  >
                    {form.patientId
                      ? (() => {
                          const p = patients?.find((pt) => String(pt.id) === form.patientId);
                          return p ? `${p.name}${p.phone ? ` · ${p.phone}` : ""}` : "Seleccionar paciente";
                        })()
                      : "Buscar paciente por nombre o teléfono..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Buscar paciente..." />
                    <CommandList className="max-h-[280px] overflow-y-auto">
                      <CommandEmpty>No se encontró el paciente.</CommandEmpty>
                      <CommandGroup>
                        {(patients ?? []).map((pt) => (
                          <CommandItem
                            key={pt.id}
                            value={`${pt.name} ${pt.phone ?? ""}`}
                            onSelect={() => {
                              setForm((f) => ({ ...f, patientId: String(pt.id), quotationId: "" }));
                              setLines([emptyCatalogLine()]);
                              setPatientOpen(false);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                form.patientId === String(pt.id) ? "opacity-100" : "opacity-0",
                              )}
                            />
                            {pt.name} {pt.phone ? `· ${pt.phone}` : ""}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            {form.patientId && (
              <>
                {patientBillingLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : patientBilling ? (
                  <Card className="border-border/50 bg-muted/20">
                    <CardContent className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">Total abonado</p>
                        <p className="font-semibold text-emerald-500">
                          {formatPriceCop(patientBilling.totalPaid ?? 0)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Deuda presupuestos</p>
                        <p className="font-semibold text-amber-500">
                          {formatPriceCop(patientBilling.totalDebt ?? 0)}
                        </p>
                      </div>
                      {selectedQuoteBilling && (
                        <>
                          <div>
                            <p className="text-xs text-muted-foreground">
                              Presupuesto #{selectedQuoteBilling.id}
                            </p>
                            <p className="font-semibold">{formatPriceCop(selectedQuoteBilling.total ?? 0)}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Saldo presupuesto</p>
                            <p className="font-semibold text-amber-500">
                              {formatPriceCop(selectedQuoteBilling.balance ?? 0)}
                            </p>
                          </div>
                        </>
                      )}
                      {totalAbonoToday > 0 && (
                        <div className="col-span-2 sm:col-span-4 pt-2 border-t border-border/40 flex flex-wrap gap-4">
                          <div>
                            <p className="text-xs text-muted-foreground">Abono en este registro</p>
                            <p className="font-semibold text-primary">{formatPriceCop(totalAbonoToday)}</p>
                          </div>
                          {quoteBalanceAfter != null && (
                            <div>
                              <p className="text-xs text-muted-foreground">Saldo después del abono</p>
                              <p
                                className={cn(
                                  "font-semibold",
                                  quoteBalanceAfter === 0 ? "text-emerald-500" : "text-amber-500",
                                )}
                              >
                                {formatPriceCop(quoteBalanceAfter)}
                                {quoteBalanceAfter === 0 && " — ¡Pagado!"}
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ) : null}

                <div className="space-y-1">
                  <Label>Presupuesto (opcional)</Label>
                  <Select
                    value={form.quotationId || "__none__"}
                    disabled={!!editing}
                    onValueChange={(v) => {
                      const qid = v === "__none__" ? "" : v;
                      setForm((f) => ({ ...f, quotationId: qid }));
                      if (!qid) setLines([emptyCatalogLine()]);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Sin vincular presupuesto" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Sin presupuesto — catálogo de precios</SelectItem>
                      {patientQuotations.map((q) => (
                        <SelectItem key={q.id} value={String(q.id)}>
                          #{q.id} — {formatPriceCop(q.total ?? 0)}
                          {"balance" in q && q.balance != null && q.balance > 0
                            ? ` · Saldo ${formatPriceCop(q.balance)}`
                            : ""}{" "}
                          ({q.status})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Tratamientos y abonos *</Label>
                {!editing && showQuotationLines && lines.some((l) => l.lineBalance > 0) && (
                  <Button type="button" variant="outline" size="sm" onClick={payAllBalances}>
                    <Banknote className="h-3.5 w-3.5 mr-1" />
                    Pagar todos los saldos
                  </Button>
                )}
              </div>

              <div className="hidden sm:grid sm:grid-cols-[1fr_110px_90px_90px_120px_36px] gap-2 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                <span>Tratamiento</span>
                <span className="text-right">Precio</span>
                <span className="text-right">Pagado</span>
                <span className="text-right">Saldo</span>
                <span className="text-right">Abono hoy</span>
                <span />
              </div>

              <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                {lines.map((line, idx) => (
                  <div
                    key={line.id}
                    className="grid grid-cols-1 sm:grid-cols-[1fr_110px_90px_90px_120px_36px] gap-2 items-end bg-muted/10 p-3 rounded-lg border border-border/30"
                  >
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground sm:hidden">Tratamiento</Label>
                      {showQuotationLines ? (
                        <p className="text-sm font-medium py-2 px-1 truncate" title={line.treatmentName}>
                          {line.treatmentName || "—"}
                        </p>
                      ) : (
                        <Select
                          value={line.treatmentName || "__none__"}
                          onValueChange={(v) => {
                            if (v === "__none__") {
                              updateLine(idx, {
                                treatmentName: "",
                                expectedTotal: 0,
                                linePaid: 0,
                                lineBalance: 0,
                              });
                            } else {
                              onTreatmentSelect(idx, v);
                            }
                          }}
                        >
                          <SelectTrigger className="bg-background">
                            <SelectValue placeholder="Seleccionar del catálogo" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">—</SelectItem>
                            {activeTreatments.map((t) => (
                              <SelectItem key={t.id} value={t.name}>
                                {t.name} — {formatPriceCop(t.price)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {!showQuotationLines && (
                        <Input
                          placeholder="O escribe el nombre del tratamiento"
                          value={line.treatmentName}
                          onChange={(e) => {
                            const name = e.target.value;
                            const price = treatmentPriceByName.get(name.toLowerCase()) ?? line.expectedTotal;
                            const qid = form.quotationId ? parseInt(form.quotationId, 10) : null;
                            const paid = paidForTreatment(patientBilling?.payments, name, qid);
                            updateLine(idx, {
                              treatmentName: name,
                              expectedTotal: price,
                              linePaid: paid,
                              lineBalance: Math.max(0, price - paid),
                            });
                          }}
                          className="bg-background text-sm"
                        />
                      )}
                    </div>

                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground sm:hidden">Precio</Label>
                      <Input
                        type="number"
                        min={0}
                        readOnly={showQuotationLines}
                        value={line.expectedTotal || ""}
                        onChange={(e) => {
                          const price = parseInt(e.target.value, 10) || 0;
                          const paid = line.linePaid;
                          updateLine(idx, {
                            expectedTotal: price,
                            lineBalance: Math.max(0, price - paid),
                          });
                        }}
                        className="bg-background text-right"
                        placeholder="0"
                      />
                    </div>

                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground sm:hidden">Pagado</Label>
                      <p className="text-sm text-right py-2 text-muted-foreground tabular-nums">
                        {line.linePaid > 0 ? formatPriceCop(line.linePaid) : "—"}
                      </p>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground sm:hidden">Saldo</Label>
                      <p
                        className={cn(
                          "text-sm text-right py-2 tabular-nums font-medium",
                          line.lineBalance > 0 ? "text-amber-500" : "text-emerald-500",
                        )}
                      >
                        {line.expectedTotal > 0
                          ? formatPriceCop(line.lineBalance)
                          : "—"}
                      </p>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground sm:hidden">Abono hoy</Label>
                      <div className="flex gap-1">
                        <Input
                          type="number"
                          min={0}
                          value={line.abono}
                          onChange={(e) => updateLine(idx, { abono: e.target.value })}
                          className="bg-background text-right"
                          placeholder="0"
                        />
                        {(line.lineBalance > 0 || line.expectedTotal > 0) && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="shrink-0"
                            title="Pagar saldo completo"
                            onClick={() => payFullBalance(idx)}
                          >
                            <Banknote className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>

                    {!showQuotationLines && lines.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-destructive shrink-0"
                        onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                    {(showQuotationLines || lines.length === 1) && <div className="hidden sm:block" />}
                  </div>
                ))}
              </div>

              {!editing && !showQuotationLines && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setLines((prev) => [...prev, emptyCatalogLine()])}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Añadir tratamiento
                </Button>
              )}

              {totalAbonoToday > 0 && (
                <p className="text-sm text-right font-semibold text-primary">
                  Total a registrar: {formatPriceCop(totalAbonoToday)}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Fecha del pago *</Label>
                <Input
                  type="date"
                  value={form.paymentDate}
                  onChange={(e) => setForm((f) => ({ ...f, paymentDate: e.target.value }))}
                  className="bg-background"
                />
              </div>
              <div className="space-y-1">
                <Label>Tipo</Label>
                <Select
                  value={form.paymentType}
                  onValueChange={(v) => setForm((f) => ({ ...f, paymentType: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(TYPE_LABELS).map(([k, label]) => (
                      <SelectItem key={k} value={k}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              <Label>Método de pago</Label>
              <Select
                value={form.paymentMethod}
                onValueChange={(v) => setForm((f) => ({ ...f, paymentMethod: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(METHOD_LABELS).map(([k, label]) => (
                    <SelectItem key={k} value={k}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>Concepto (opcional)</Label>
              <Input
                value={form.concept}
                onChange={(e) => setForm((f) => ({ ...f, concept: e.target.value }))}
                placeholder="Ej: Abono diseño de sonrisa"
                className="bg-background"
              />
            </div>

            <div className="space-y-1">
              <Label>Notas internas</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                className="bg-background"
                rows={2}
              />
            </div>

            {form.patientId && !editing && patientBilling?.payments?.length ? (
              <div className="space-y-2 pt-2 border-t border-border/40">
                <div className="flex items-center gap-2">
                  <History className="h-4 w-4 text-muted-foreground" />
                  <Label className="text-sm font-semibold">Historial de abonos anteriores</Label>
                </div>
                <div className="border border-border/40 rounded-lg divide-y divide-border/30 max-h-[200px] overflow-y-auto">
                  {[...patientBilling.payments]
                    .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate) || b.id - a.id)
                    .map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <p className="font-medium truncate">
                            {p.treatmentName || p.concept || "Sin concepto"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatPaymentDate(p.paymentDate)} · {TYPE_LABELS[p.paymentType] ?? p.paymentType}
                          </p>
                        </div>
                        <p
                          className={cn(
                            "font-semibold shrink-0 tabular-nums",
                            p.paymentType === "devolucion" ? "text-red-400" : "text-emerald-400",
                          )}
                        >
                          {p.paymentType === "devolucion" ? "−" : "+"}
                          {formatPriceCop(p.amount)}
                        </p>
                      </div>
                    ))}
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || createPayment.isPending || updatePayment.isPending}
            >
              {editing ? "Guardar cambios" : saving ? "Registrando..." : "Registrar abono(s)"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
