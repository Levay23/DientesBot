import Layout from "@/components/layout";
import { useListAutomations, useCreateAutomation, useUpdateAutomation, useDeleteAutomation, getListAutomationsQueryKey } from "@workspace/api-client-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Pencil, Zap, Play, Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";

const triggerLabels: Record<string, string> = {
  appointment_reminder: "Recordatorio de cita",
  follow_up: "Seguimiento post-cita",
  new_patient_welcome: "Bienvenida nuevo paciente",
  appointment_confirmed: "Cita confirmada",
  missed_appointment: "Cita no atendida",
  reactivation: "Reactivación de paciente",
};

const triggerColors: Record<string, string> = {
  appointment_reminder: "bg-blue-500/20 text-blue-300",
  follow_up: "bg-purple-500/20 text-purple-300",
  new_patient_welcome: "bg-green-500/20 text-green-300",
  appointment_confirmed: "bg-emerald-500/20 text-emerald-300",
  missed_appointment: "bg-orange-500/20 text-orange-300",
  reactivation: "bg-yellow-500/20 text-yellow-300",
};

type AutoForm = { name: string; trigger: string; message: string; delayHours: string; active: boolean };
const emptyForm: AutoForm = { name: "", trigger: "appointment_reminder", message: "", delayHours: "24", active: true };

const delayHelp: Record<string, string> = {
  appointment_reminder: "Horas antes de la cita (ej. 24 = recordatorio un día antes)",
  new_patient_welcome: "Horas después de registrar al paciente (0 = casi al instante)",
  follow_up: "Horas después de que termina la cita completada",
  appointment_confirmed: "No aplica — se envía al confirmar la cita en Agenda",
  missed_appointment: "Horas después de la hora de la cita si no asistió",
  reactivation: "Horas sin cita futura desde registro (720 ≈ 30 días)",
};

const TEMPLATES = [
  {
    name: "Recordatorio 24h",
    trigger: "appointment_reminder",
    delayHours: "24",
    message: "Hola {nombre}, te recordamos tu cita en Dientes Fijos Medellín para el día {fecha} a las {hora} ({tratamiento}). ¡Te esperamos!",
  },
  {
    name: "Bienvenida",
    trigger: "new_patient_welcome",
    delayHours: "0",
    message: "¡Hola {nombre}! Bienvenido(a) a Dientes Fijos Medellín. Es un gusto tenerte con nosotros. ¿En qué podemos ayudarte hoy?",
  },
  {
    name: "Seguimiento Post-Cita",
    trigger: "follow_up",
    delayHours: "48",
    message: "Hola {nombre}, esperamos que te sientas muy bien después de tu cita de {tratamiento}. ¡Cualquier duda estamos para servirte!",
  }
];


export default function Automations() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<AutoForm>(emptyForm);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: automations, isLoading } = useListAutomations();
  const createAuto = useCreateAutomation();
  const updateAuto = useUpdateAutomation();
  const deleteAuto = useDeleteAutomation();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListAutomationsQueryKey() });

  const openCreate = () => { setForm(emptyForm); setEditingId(null); setDialogOpen(true); };
  const openEdit = (a: any) => {
    setForm({ name: a.name, trigger: a.trigger, message: a.message, delayHours: a.delayHours?.toString() ?? "", active: a.active });
    setEditingId(a.id);
    setDialogOpen(true);
  };

  const handleSave = () => {
    const data = {
      name: form.name,
      trigger: form.trigger as any,
      message: form.message,
      delayHours: form.delayHours ? parseInt(form.delayHours) : undefined,
      active: form.active,
    };
    if (editingId) {
      updateAuto.mutate({ id: editingId, data }, {
        onSuccess: () => { toast({ title: "Automatización actualizada" }); setDialogOpen(false); invalidate(); },
      });
    } else {
      createAuto.mutate({ data }, {
        onSuccess: () => { toast({ title: "Automatización creada" }); setDialogOpen(false); invalidate(); },
      });
    }
  };

  const toggleActive = (id: number, active: boolean) => {
    updateAuto.mutate({ id, data: { active } }, { onSuccess: invalidate });
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Automatizaciones</h1>
            <p className="text-muted-foreground mt-1">Mensajes automáticos y flujos de seguimiento</p>
          </div>
          <Button onClick={openCreate} className="bg-primary hover:bg-primary/90">
            <Plus className="h-4 w-4 mr-2" />
            Nueva Automatización
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-4">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}</div>
        ) : !Array.isArray(automations) || !automations.length ? (
          <div className="text-center py-16 text-muted-foreground">
            <Zap className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No hay automatizaciones configuradas</p>
            <p className="text-sm mt-1">Crea mensajes automáticos para recordatorios, seguimientos y más</p>
          </div>
        ) : (
          <div className="space-y-4">
            {automations.map(a => (
              <Card key={a.id} className="border-border/50 bg-card/80 hover:bg-card transition-colors">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-4 flex-1 min-w-0">
                      <div className={`p-2.5 rounded-xl flex-shrink-0 ${a.active ? "bg-accent/15" : "bg-muted"}`}>
                        <Zap className={`h-5 w-5 ${a.active ? "text-accent" : "text-muted-foreground"}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-foreground">{a.name}</h3>
                          <Badge className={`text-xs ${triggerColors[a.trigger] ?? "bg-muted text-muted-foreground"}`}>
                            {triggerLabels[a.trigger] ?? a.trigger}
                          </Badge>
                          {a.delayHours != null && a.trigger !== "appointment_confirmed" && (
                            <span className="text-xs text-muted-foreground">· {a.delayHours}h</span>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground line-clamp-2">{a.message}</p>
                        <p className="text-xs text-muted-foreground mt-1.5">Ejecutada {a.executionCount} veces</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <div className="flex items-center gap-2">
                        {a.active ? <Play className="h-3.5 w-3.5 text-accent" /> : <Pause className="h-3.5 w-3.5 text-muted-foreground" />}
                        <Switch checked={a.active} onCheckedChange={v => toggleActive(a.id, v)} />
                      </div>
                      <Button variant="outline" size="sm" onClick={() => openEdit(a)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => deleteAuto.mutate({ id: a.id }, { onSuccess: invalidate })}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>{editingId ? "Editar Automatización" : "Nueva Automatización"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Nombre *</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="bg-background" placeholder="Ej: Recordatorio 24 horas" />
            </div>
            <div className="space-y-1">
              <Label>Disparador *</Label>
              <Select value={form.trigger} onValueChange={v => setForm(f => ({ ...f, trigger: v }))}>
                <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(triggerLabels).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {form.trigger !== "appointment_confirmed" && (
              <div className="space-y-1">
                <Label>Tiempo (horas)</Label>
                <Input type="number" value={form.delayHours} onChange={e => setForm(f => ({ ...f, delayHours: e.target.value }))} className="bg-background" placeholder="Ej: 24" />
                <p className="text-xs text-muted-foreground">{delayHelp[form.trigger] ?? "Tiempo en horas según el tipo de automatización"}</p>
              </div>
            )}
            <p className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-3">
              El servidor revisa cada 15 minutos. WhatsApp debe estar <strong>Conectado</strong> en la sección WhatsApp.
              Cada paciente/cita recibe el mensaje una sola vez por automatización.
            </p>
            <div className="space-y-1">
              <Label>Mensaje *</Label>
              <Textarea
                value={form.message}
                onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                className="bg-background"
                rows={4}
                placeholder="Ej: Hola {nombre}, te recordamos tu cita mañana a las {hora}..."
              />
              <p className="text-xs text-muted-foreground">Variables disponibles: {"{nombre}"}, {"{fecha}"}, {"{hora}"}, {"{tratamiento}"}</p>
            </div>
            <div className="space-y-3 pt-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">O usar una plantilla rápida</Label>
              <div className="flex flex-wrap gap-2">
                {TEMPLATES.map(t => (
                  <Button
                    key={t.name}
                    variant="outline"
                    size="sm"
                    className="text-[10px] h-7 bg-background/50 hover:bg-accent/10"
                    onClick={() => setForm({ ...t, active: true })}
                  >
                    {t.name}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 pt-2 border-t border-border/30 mt-4">
              <Switch checked={form.active} onCheckedChange={v => setForm(f => ({ ...f, active: v }))} />
              <Label>Automatización Activa</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={createAuto.isPending || updateAuto.isPending} className="bg-primary">
              {editingId ? "Guardar cambios" : "Crear automatización"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
