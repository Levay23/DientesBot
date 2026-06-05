import Layout from "@/components/layout";
import { 
  useListPatients, 
  useListQuotations, 
  useCreateQuotation, 
  useUpdateQuotation, 
  useListTreatments,
  getListQuotationsQueryKey,
  customFetch
} from "@workspace/api-client-react";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, FileText, Send, Trash2, Pencil, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

type QuotationItem = { service: string; price: number; quantity: number };

function formatPriceCop(price: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0 }).format(price);
}

export default function Quotations() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedPatientId, setSelectedPatientId] = useState<string>("");
  const [items, setItems] = useState<QuotationItem[]>([{ service: "", price: 0, quantity: 1 }]);
  const [sending, setSending] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [customServiceRows, setCustomServiceRows] = useState<Set<number>>(new Set());
  const [observations, setObservations] = useState("");
  
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: patients } = useListPatients();
  const { data: catalogTreatments } = useListTreatments();
  const { data: quotations, isLoading } = useListQuotations();

  const activeTreatments = useMemo(
    () => (catalogTreatments ?? []).filter(t => t.active).sort((a, b) => a.name.localeCompare(b.name, "es")),
    [catalogTreatments],
  );

  const treatmentPriceByName = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of activeTreatments) map.set(t.name.toLowerCase(), Math.round(t.price));
    return map;
  }, [activeTreatments]);
  const createQuotation = useCreateQuotation();
  const updateQuotation = useUpdateQuotation();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListQuotationsQueryKey() });

  const addItem = () => setItems([...items, { service: "", price: 0, quantity: 1 }]);
  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));
  const updateItem = (idx: number, field: keyof QuotationItem, value: string | number) => {
    const newItems = [...items];
    let finalValue: string | number = value;
    if (field === "price" || field === "quantity") {
      finalValue = typeof value === "number" ? value : parseInt(String(value), 10) || 0;
    }
    newItems[idx] = { ...newItems[idx], [field]: finalValue };
    setItems(newItems);
  };

  const selectCatalogTreatment = (idx: number, treatmentName: string) => {
    if (treatmentName === "__custom__") {
      setCustomServiceRows(prev => new Set(prev).add(idx));
      return;
    }
    const catalog = activeTreatments.find(t => t.name === treatmentName);
    const newItems = [...items];
    newItems[idx] = {
      ...newItems[idx],
      service: treatmentName,
      price: catalog ? Math.round(catalog.price) : newItems[idx].price,
    };
    setItems(newItems);
    setCustomServiceRows(prev => {
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
  };

  const openEdit = (q: any) => {
    setEditingId(q.id);
    setSelectedPatientId(q.patientId.toString());
    const mapped = q.items.map((i: any) => ({ ...i, quantity: i.quantity || 1 }));
    setItems(mapped);
    const custom = new Set<number>();
    mapped.forEach((item: QuotationItem, idx: number) => {
      if (item.service && !treatmentPriceByName.has(item.service.toLowerCase())) {
        custom.add(idx);
      }
    });
    setCustomServiceRows(custom);
    setObservations((q as { observations?: string }).observations ?? "");
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingId(null);
    setItems([{ service: "", price: 0, quantity: 1 }]);
    setSelectedPatientId("");
    setCustomServiceRows(new Set());
    setObservations("");
  };

  const handleDelete = async (id: number) => {
    if (!confirm("¿Estás seguro de eliminar este presupuesto?")) return;
    
    try {
      await customFetch(`/api/clinical/quotations/${id}`, { method: "DELETE" });
      toast({ title: "Presupuesto eliminado" });
      invalidate();
    } catch (err) {
      toast({ variant: "destructive", title: "Error al eliminar" });
    }
  };

  const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  const filteredQuotations = (quotations ?? []).filter(q => {
    if (!search) return true;
    const term = search.toLowerCase();
    const patientName = q.patientName?.toLowerCase() ?? "";
    const patientPhone = (q as any).patientPhone?.toLowerCase?.() ?? "";
    const idText = String(q.id);
    const itemsText = q.items.map(i => i.service).join(" ").toLowerCase();
    const totalText = q.total.toString();

    return (
      patientName.includes(term) ||
      patientPhone.includes(term) ||
      idText.includes(term) ||
      itemsText.includes(term) ||
      totalText.includes(term)
    );
  });

  const handleCreate = (sendToWhatsApp: boolean) => {
    if (!selectedPatientId) {
      toast({ variant: "destructive", title: "Selecciona un paciente" });
      return;
    }
    if (items.some(i => !i.service || i.price <= 0)) {
      toast({ variant: "destructive", title: "Completa los servicios y precios" });
      return;
    }

    setSending(sendToWhatsApp);
    
    const payload = {
      patientId: parseInt(selectedPatientId),
      items,
      total,
      observations: observations.trim() || undefined,
      sendToWhatsApp,
    };

    if (editingId) {
      updateQuotation.mutate({ id: editingId, data: payload as any }, {
        onSuccess: () => {
          toast({ title: sendToWhatsApp ? "Presupuesto actualizado y enviado" : "Presupuesto actualizado" });
          closeDialog();
          invalidate();
        },
        onSettled: () => setSending(false)
      });
    } else {
      createQuotation.mutate({ data: payload as any }, {
        onSuccess: () => {
          toast({ title: sendToWhatsApp ? "Presupuesto enviado por WhatsApp" : "Presupuesto creado" });
          closeDialog();
          invalidate();
        },
        onSettled: () => setSending(false)
      });
    }
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Presupuestos</h1>
            <p className="text-muted-foreground mt-1">Genera y envía cotizaciones profesionales</p>
          </div>
          <Button onClick={() => setDialogOpen(true)} className="bg-primary hover:bg-primary/90">
            <Plus className="h-4 w-4 mr-2" />
            Nuevo Presupuesto
          </Button>
        </div>

        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nombre, teléfono, ID o tratamiento..."
            className="pl-9 bg-card border-border"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {isLoading ? (
          <div className="space-y-4">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
        ) : !filteredQuotations.length ? (
          <div className="text-center py-16 text-muted-foreground border-2 border-dashed border-border/50 rounded-xl">
            <FileText className="h-12 w-12 mx-auto mb-3 opacity-20" />
            <p>No se encontraron presupuestos con ese criterio</p>
          </div>
        ) : (
          <div className="grid gap-4">
            {filteredQuotations.map(q => (
              <Card key={q.id} className="bg-card/80 border-border/50 overflow-hidden group">
                <CardContent className="p-0">
                  <div className="flex items-center justify-between p-4 bg-muted/20">
                    <div className="flex items-center gap-4">
                      <div className="p-2 bg-primary/10 rounded-lg">
                        <FileText className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-semibold">{q.patientName}</h3>
                        <p className="text-xs text-muted-foreground">ID: #{q.id} · {new Date(q.createdAt).toLocaleDateString()}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="text-sm font-bold text-accent">${q.total.toLocaleString()}</p>
                        <Badge className={q.status === "sent" ? "bg-green-500/20 text-green-400" : "bg-muted text-muted-foreground"}>
                          {q.status === "sent" ? "Enviado" : "Borrador"}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(q)}>
                          <Pencil className="h-4 w-4 mr-1" /> Editar
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(q.id)} className="text-destructive hover:bg-destructive/10">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="p-4 border-t border-border/30">
                    <div className="text-xs text-muted-foreground space-y-1">
                      {q.items.map((item: any, i: number) => (
                        <div key={i} className="flex justify-between">
                          <span>{item.service} {item.quantity > 1 && `(x${item.quantity})`}</span>
                          <span>${(item.price * (item.quantity || 1)).toLocaleString()}</span>
                        </div>
                      ))}
                      {(q as { observations?: string }).observations && (
                        <p className="mt-2 pt-2 border-t border-border/20 text-foreground/80 italic">
                          Obs: {(q as { observations?: string }).observations}
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={o => !o && closeDialog()}>
        <DialogContent className="max-w-3xl bg-card border-border">
          <DialogHeader>
            <DialogTitle>{editingId ? "Editar Presupuesto" : "Generar Presupuesto Profesional"}</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-6 py-4">
            <div className="space-y-2">
              <Label>Seleccionar Paciente</Label>
              <Select value={selectedPatientId} onValueChange={setSelectedPatientId} disabled={!!editingId}>
                <SelectTrigger className="bg-background">
                  <SelectValue placeholder="Busca un paciente..." />
                </SelectTrigger>
                <SelectContent className="max-h-[300px] overflow-y-auto">
                  {patients?.map(p => (
                    <SelectItem key={p.id} value={p.id.toString()}>{p.name} ({p.phone})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Servicios / Tratamientos</Label>
                <Button variant="ghost" size="sm" onClick={addItem} className="text-accent h-7 px-2">
                  <Plus className="h-3.5 w-3.5 mr-1" /> Añadir Fila
                </Button>
              </div>
              
              <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                {items.map((item, idx) => (
                  <div key={idx} className="flex gap-2 items-end bg-muted/5 p-3 rounded-lg border border-border/30 relative group/row">
                    <div className="flex-[3] space-y-1.5">
                      <Label className="text-[10px] text-muted-foreground ml-1">Tratamiento / Servicio</Label>
                      {customServiceRows.has(idx) ? (
                        <div className="space-y-1">
                          <Input
                            placeholder="Nombre del servicio..."
                            value={item.service}
                            onChange={e => updateItem(idx, "service", e.target.value)}
                            className="bg-background"
                          />
                          {activeTreatments.length > 0 && (
                            <button
                              type="button"
                              className="text-[10px] text-accent hover:underline"
                              onClick={() => {
                                setCustomServiceRows(prev => {
                                  const next = new Set(prev);
                                  next.delete(idx);
                                  return next;
                                });
                              }}
                            >
                              Elegir del catálogo
                            </button>
                          )}
                        </div>
                      ) : (
                        <Select
                          value={item.service || undefined}
                          onValueChange={v => selectCatalogTreatment(idx, v)}
                        >
                          <SelectTrigger className="bg-background h-10">
                            <SelectValue placeholder="Seleccionar tratamiento..." />
                          </SelectTrigger>
                          <SelectContent className="max-h-[280px]">
                            {activeTreatments.map(t => (
                              <SelectItem key={t.id} value={t.name}>
                                <span className="flex justify-between gap-3 w-full">
                                  <span>{t.name}</span>
                                  <span className="text-muted-foreground text-xs">{formatPriceCop(t.price)}</span>
                                </span>
                              </SelectItem>
                            ))}
                            <SelectItem value="__custom__">— Otro (escribir manualmente) —</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                    <div className="w-20 space-y-1.5">
                      <Label className="text-[10px] text-muted-foreground ml-1">Cant.</Label>
                      <Input 
                        type="number" 
                        min="1"
                        value={item.quantity || ""} 
                        onChange={e => updateItem(idx, "quantity", e.target.value)}
                        className="bg-background text-center"
                      />
                    </div>
                    <div className="w-32 space-y-1.5">
                      <Label className="text-[10px] text-muted-foreground ml-1">Precio Unit.</Label>
                      <Input 
                        type="number" 
                        placeholder="Precio" 
                        value={item.price || ""} 
                        onChange={e => updateItem(idx, "price", e.target.value)}
                        className="bg-background text-right"
                      />
                    </div>
                    <div className="w-32 space-y-1.5">
                      <Label className="text-[10px] text-muted-foreground ml-1">Subtotal</Label>
                      <div className="h-10 flex items-center justify-end px-3 bg-muted/20 rounded-md border border-border/30 text-sm font-medium">
                        ${(item.price * item.quantity).toLocaleString()}
                      </div>
                    </div>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      onClick={() => removeItem(idx)} 
                      disabled={items.length === 1} 
                      className="text-muted-foreground hover:text-destructive h-10 w-10 mb-0"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Observaciones del presupuesto</Label>
              <Textarea
                value={observations}
                onChange={(e) => setObservations(e.target.value)}
                className="bg-background"
                rows={3}
                placeholder="Notas, condiciones, validez, recomendaciones para el paciente..."
              />
            </div>

            <div className="pt-4 border-t border-border/50 flex justify-between items-center">
              <div className="text-muted-foreground">
                <p className="text-sm">Total Presupuesto</p>
                <p className="text-3xl font-bold text-accent">${total.toLocaleString()}</p>
              </div>
              <div className="flex gap-3">
                <Button variant="outline" onClick={() => handleCreate(false)}>Solo Guardar</Button>
                <Button 
                  onClick={() => handleCreate(true)} 
                  disabled={createQuotation.isPending || updateQuotation.isPending}
                  className="bg-accent text-accent-foreground hover:bg-accent/90 px-6"
                >
                  <Send className="h-4 w-4 mr-2" />
                  {sending ? "Enviando..." : editingId ? "Actualizar y Enviar" : "Crear y Enviar WhatsApp"}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}

