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
  getListPaymentsQueryKey,
  getGetBillingSummaryQueryKey,
} from "@workspace/api-client-react";
import { useMemo, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { formatMessageDateTime } from "@/lib/datetime";

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
  amount: number;
  paymentMethod: string;
  paymentType: string;
  concept?: string | null;
  notes?: string | null;
  paymentDate: string;
  createdAt: string;
};

const emptyForm = () => ({
  patientId: "",
  quotationId: "",
  treatmentName: "",
  amount: "",
  paymentMethod: "efectivo",
  paymentType: "abono",
  concept: "",
  notes: "",
  paymentDate: formatColombiaDate(),
});

export default function Billing() {
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PaymentRow | null>(null);
  const [form, setForm] = useState(emptyForm);

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

  const createPayment = useCreatePayment();
  const updatePayment = useUpdatePayment();
  const deletePayment = useDeletePayment();

  const patientQuotations = useMemo(() => {
    if (!form.patientId || !quotations) return [];
    const pid = parseInt(form.patientId, 10);
    return quotations.filter((q) => q.patientId === pid);
  }, [form.patientId, quotations]);

  const selectedQuote = useMemo(() => {
    if (!form.quotationId) return null;
    return patientQuotations.find((q) => q.id === parseInt(form.quotationId, 10));
  }, [form.quotationId, patientQuotations]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListPaymentsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetBillingSummaryQueryKey() });
  };

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setDialogOpen(true);
  };

  const openEdit = (p: PaymentRow) => {
    setEditing(p);
    setForm({
      patientId: String(p.patientId),
      quotationId: p.quotationId ? String(p.quotationId) : "",
      treatmentName: p.treatmentName ?? "",
      amount: String(p.amount),
      paymentMethod: p.paymentMethod,
      paymentType: p.paymentType,
      concept: p.concept ?? "",
      notes: p.notes ?? "",
      paymentDate: p.paymentDate,
    });
    setDialogOpen(true);
  };

  const handleSave = () => {
    const patientId = parseInt(form.patientId, 10);
    const amount = parseInt(form.amount, 10);
    if (!patientId || !amount || amount <= 0) {
      toast({ variant: "destructive", title: "Paciente y monto son obligatorios" });
      return;
    }

    const payload = {
      patientId,
      quotationId: form.quotationId ? parseInt(form.quotationId, 10) : null,
      treatmentName: form.treatmentName || null,
      amount,
      paymentMethod: form.paymentMethod as "efectivo",
      paymentType: form.paymentType as "abono",
      concept: form.concept || null,
      notes: form.notes || null,
      paymentDate: form.paymentDate,
    };

    if (editing) {
      const { patientId: _pid, ...updatePayload } = payload;
      updatePayment.mutate(
        { id: editing.id, data: updatePayload },
        {
          onSuccess: () => {
            toast({ title: "Pago actualizado" });
            setDialogOpen(false);
            invalidate();
          },
          onError: () => toast({ variant: "destructive", title: "Error al actualizar" }),
        },
      );
    } else {
      createPayment.mutate(
        { data: payload },
        {
          onSuccess: () => {
            toast({ title: "Pago registrado" });
            setDialogOpen(false);
            invalidate();
          },
          onError: () => toast({ variant: "destructive", title: "Error al registrar pago" }),
        },
      );
    }
  };

  const handleDelete = (id: number) => {
    if (!confirm("¿Eliminar este registro de pago?")) return;
    deletePayment.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Pago eliminado" });
          invalidate();
        },
        onError: () => toast({ variant: "destructive", title: "No se pudo eliminar" }),
      },
    );
  };

  const activeTreatments = useMemo(
    () => (treatments ?? []).filter((t) => t.active).sort((a, b) => a.name.localeCompare(b.name, "es")),
    [treatments],
  );

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

        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por paciente, teléfono o concepto..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 bg-background"
          />
        </div>

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
              <Card key={p.id} className="border-border/50 bg-card/80">
                <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <p className="font-semibold text-foreground">{p.patientName}</p>
                      <Badge variant="outline">{TYPE_LABELS[p.paymentType] ?? p.paymentType}</Badge>
                      <Badge variant="secondary">{METHOD_LABELS[p.paymentMethod] ?? p.paymentMethod}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {p.concept || p.treatmentName || "Sin concepto"}
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
                  <div className="flex items-center gap-3 flex-shrink-0">
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
                      onClick={() => handleDelete(p.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Editar pago" : "Registrar pago / abono"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Paciente *</Label>
              <Select
                value={form.patientId}
                onValueChange={(v) => setForm((f) => ({ ...f, patientId: v, quotationId: "" }))}
                disabled={!!editing}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Seleccionar paciente" />
                </SelectTrigger>
                <SelectContent>
                  {(patients ?? []).map((pt) => (
                    <SelectItem key={pt.id} value={String(pt.id)}>
                      {pt.name} {pt.phone ? `· ${pt.phone}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {form.patientId && (
              <div className="space-y-1">
                <Label>Presupuesto (opcional)</Label>
                <Select
                  value={form.quotationId || "__none__"}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, quotationId: v === "__none__" ? "" : v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Sin vincular presupuesto" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Sin presupuesto</SelectItem>
                    {patientQuotations.map((q) => (
                      <SelectItem key={q.id} value={String(q.id)}>
                        #{q.id} — {formatPriceCop(q.total)} ({q.status})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedQuote && (
                  <p className="text-xs text-muted-foreground">
                    Total presupuesto: {formatPriceCop(selectedQuote.total)}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-1">
              <Label>Tratamiento / servicio (opcional)</Label>
              <Select
                value={form.treatmentName || "__none__"}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, treatmentName: v === "__none__" ? "" : v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Del catálogo o manual abajo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">—</SelectItem>
                  {activeTreatments.map((t) => (
                    <SelectItem key={t.id} value={t.name}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="O escribe el concepto del tratamiento"
                value={form.treatmentName}
                onChange={(e) => setForm((f) => ({ ...f, treatmentName: e.target.value }))}
                className="mt-1 bg-background"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Monto (COP) *</Label>
                <Input
                  type="number"
                  min={1}
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  className="bg-background"
                />
              </div>
              <div className="space-y-1">
                <Label>Fecha del pago *</Label>
                <Input
                  type="date"
                  value={form.paymentDate}
                  onChange={(e) => setForm((f) => ({ ...f, paymentDate: e.target.value }))}
                  className="bg-background"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
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
              <div className="space-y-1">
                <Label>Método</Label>
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
            </div>

            <div className="space-y-1">
              <Label>Concepto</Label>
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={handleSave}
              disabled={createPayment.isPending || updatePayment.isPending}
            >
              {editing ? "Guardar cambios" : "Registrar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
