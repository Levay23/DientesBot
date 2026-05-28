import Layout from "@/components/layout";
import { useListTreatments, useCreateTreatment, useUpdateTreatment, useDeleteTreatment, getListTreatmentsQueryKey } from "@workspace/api-client-react";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Syringe, Clock, DollarSign, Search, LayoutGrid, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type TreatForm = { name: string; description: string; price: string; duration: string; active: boolean };
const emptyForm: TreatForm = { name: "", description: "", price: "", duration: "60", active: true };

function formatCurrency(v: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0 }).format(v);
}

export default function Treatments() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<TreatForm>(emptyForm);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [viewMode, setViewMode] = useState<"cards" | "table">("table");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: treatments, isLoading } = useListTreatments();
  const createTreat = useCreateTreatment();
  const updateTreat = useUpdateTreatment();
  const deleteTreat = useDeleteTreatment();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListTreatmentsQueryKey() });

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (treatments ?? [])
      .filter(t => (showInactive ? true : t.active))
      .filter(t => {
        if (!term) return true;
        return (
          t.name.toLowerCase().includes(term)
          || (t.description?.toLowerCase().includes(term) ?? false)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [treatments, search, showInactive]);

  const activeCount = (treatments ?? []).filter(t => t.active).length;

  const openCreate = () => { setForm(emptyForm); setEditingId(null); setDialogOpen(true); };
  const openEdit = (t: { id: number; name: string; description?: string | null; price: number; duration: number; active: boolean }) => {
    setForm({ name: t.name, description: t.description ?? "", price: String(t.price), duration: String(t.duration), active: t.active });
    setEditingId(t.id);
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!form.name.trim() || !form.price) {
      toast({ variant: "destructive", title: "Nombre y precio son obligatorios" });
      return;
    }
    const data = {
      name: form.name.trim(),
      description: form.description || undefined,
      price: parseFloat(form.price),
      duration: parseInt(form.duration) || 60,
      active: form.active,
    };
    if (editingId) {
      updateTreat.mutate({ id: editingId, data }, {
        onSuccess: () => { toast({ title: "Tratamiento actualizado" }); setDialogOpen(false); invalidate(); },
      });
    } else {
      createTreat.mutate({ data }, {
        onSuccess: () => { toast({ title: "Tratamiento creado" }); setDialogOpen(false); invalidate(); },
      });
    }
  };

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`¿Eliminar "${name}" del catálogo?`)) return;
    deleteTreat.mutate({ id }, {
      onSuccess: () => { toast({ title: "Tratamiento eliminado" }); invalidate(); },
    });
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Tratamientos</h1>
            <p className="text-muted-foreground mt-1">
              Catálogo de servicios y precios · {activeCount} activos en Agenda y Chat IA
            </p>
          </div>
          <Button onClick={openCreate} className="bg-primary hover:bg-primary/90">
            <Plus className="h-4 w-4 mr-2" />
            Nuevo Tratamiento
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar tratamiento..."
              className="pl-9 bg-card border-border"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Switch checked={showInactive} onCheckedChange={setShowInactive} id="show-inactive" />
            <Label htmlFor="show-inactive" className="text-muted-foreground cursor-pointer">Ver inactivos</Label>
          </div>
          <div className="flex gap-1 bg-muted/30 rounded-lg p-1 ml-auto">
            <Button
              variant={viewMode === "table" ? "default" : "ghost"}
              size="sm"
              onClick={() => setViewMode("table")}
              className={viewMode === "table" ? "bg-primary" : ""}
            >
              <List className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "cards" ? "default" : "ghost"}
              size="sm"
              onClick={() => setViewMode("cards")}
              className={viewMode === "cards" ? "bg-primary" : ""}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : !filtered.length ? (
          <div className="text-center py-16 text-muted-foreground">
            <Syringe className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No hay tratamientos que coincidan</p>
            <p className="text-sm mt-1">Agrega servicios con precios para usarlos en Agenda y consultorio</p>
          </div>
        ) : viewMode === "table" ? (
          <div className="rounded-xl border border-border/50 bg-card/50 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 bg-muted/30 text-muted-foreground uppercase text-[10px] tracking-wider">
                  <th className="p-4 text-left font-semibold">Tratamiento</th>
                  <th className="p-4 text-left font-semibold hidden md:table-cell">Descripción</th>
                  <th className="p-4 text-right font-semibold">Precio</th>
                  <th className="p-4 text-center font-semibold">Duración</th>
                  <th className="p-4 text-center font-semibold">Estado</th>
                  <th className="p-4 text-right font-semibold">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {filtered.map(t => (
                  <tr key={t.id} className={cn("hover:bg-accent/5", !t.active && "opacity-60")}>
                    <td className="p-4 font-medium">{t.name}</td>
                    <td className="p-4 text-muted-foreground hidden md:table-cell max-w-xs truncate">{t.description ?? "—"}</td>
                    <td className="p-4 text-right font-bold text-accent whitespace-nowrap">{formatCurrency(t.price)}</td>
                    <td className="p-4 text-center text-muted-foreground">{t.duration} min</td>
                    <td className="p-4 text-center">
                      <Badge className={t.active ? "bg-green-500/20 text-green-300" : "bg-gray-500/20 text-gray-400"}>
                        {t.active ? "Activo" : "Inactivo"}
                      </Badge>
                    </td>
                    <td className="p-4 text-right space-x-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(t)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => handleDelete(t.id, t.name)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(t => (
              <Card key={t.id} className={cn("border-border/50 bg-card/80 hover:bg-card transition-colors", !t.active && "opacity-60")}>
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="p-2 rounded-lg bg-primary/20">
                        <Syringe className="h-4 w-4 text-primary-foreground/80" />
                      </div>
                      <h3 className="font-semibold text-foreground">{t.name}</h3>
                    </div>
                    <Badge className={t.active ? "bg-green-500/20 text-green-300" : "bg-gray-500/20 text-gray-400"}>
                      {t.active ? "Activo" : "Inactivo"}
                    </Badge>
                  </div>
                  {t.description && <p className="text-sm text-muted-foreground mb-3 line-clamp-2">{t.description}</p>}
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-1.5 text-accent font-bold">
                      <DollarSign className="h-4 w-4" />
                      {formatCurrency(t.price)}
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" />
                      {t.duration} min
                    </div>
                  </div>
                  <div className="flex gap-2 mt-4">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => openEdit(t)}>
                      <Pencil className="h-3.5 w-3.5 mr-1" />
                      Editar
                    </Button>
                    <Button variant="outline" size="sm" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(t.id, t.name)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <p className="text-xs text-muted-foreground border-t border-border/30 pt-4">
          Los tratamientos <strong>activos</strong> aparecen al crear citas en Agenda. La IA usa este catálogo para orientar precios en conversaciones.
          Edita precios aquí cuando cambie el tarifario.
        </p>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>{editingId ? "Editar Tratamiento" : "Nuevo Tratamiento"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Nombre del tratamiento *</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="bg-background" placeholder="Ej: Resina" />
            </div>
            <div className="space-y-1">
              <Label>Descripción</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="bg-background" rows={2} placeholder="Ej: Obturación estética por diente" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Precio (COP) *</Label>
                <Input type="number" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} className="bg-background" placeholder="Ej: 150000" />
              </div>
              <div className="space-y-1">
                <Label>Duración (minutos)</Label>
                <Input type="number" value={form.duration} onChange={e => setForm(f => ({ ...f, duration: e.target.value }))} className="bg-background" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={form.active} onCheckedChange={v => setForm(f => ({ ...f, active: v }))} />
              <Label>Activo (visible en Agenda al agendar citas)</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={createTreat.isPending || updateTreat.isPending} className="bg-primary">
              {editingId ? "Guardar cambios" : "Crear tratamiento"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
