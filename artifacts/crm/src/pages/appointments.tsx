import Layout from "@/components/layout";
import { useListAppointments, useCreateAppointment, useUpdateAppointment, useDeleteAppointment, useListPatients, useListTreatments, getListAppointmentsQueryKey } from "@workspace/api-client-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, ChevronLeft, ChevronRight, Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

function to12h(time24: string): string {
  if (!time24) return time24;
  const [hStr, mStr] = time24.split(":");
  let h = parseInt(hStr, 10);
  const m = mStr ?? "00";
  const ampm = h >= 12 ? "p.m." : "a.m.";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${m} ${ampm}`;
}

/** Fecha YYYY-MM-DD en zona horaria Colombia (evita desfase con toISOString UTC) */
function formatColombiaDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

const statusColors: Record<string, string> = {
  scheduled: "bg-blue-500/20 text-blue-300",
  confirmed: "bg-green-500/20 text-green-300",
  completed: "bg-gray-500/20 text-gray-300",
  cancelled: "bg-red-500/20 text-red-300",
  no_show: "bg-orange-500/20 text-orange-300",
};

const statusLabels: Record<string, string> = {
  scheduled: "Programada",
  confirmed: "Confirmada",
  completed: "Completada",
  cancelled: "Cancelada",
  no_show: "No asistió",
};

function formatPriceCop(price: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0 }).format(price);
}

type AppointmentForm = {
  patientId: string;
  treatment: string;
  date: string;
  startTime: string;
  duration: string;
  notes: string;
  status?: string;
};

const emptyForm: AppointmentForm = {
  patientId: "", treatment: "", date: formatColombiaDate(new Date()),
  startTime: "09:00", duration: "60", notes: "",
};

export default function Appointments() {
  const [view, setView] = useState<"day" | "week" | "list">("week");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [patientOpen, setPatientOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<AppointmentForm>(emptyForm);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const dateStr = formatColombiaDate(currentDate);
  const todayStr = formatColombiaDate(new Date());

  const { data: appointments, isLoading } = useListAppointments(
    { date: view === "day" ? dateStr : undefined },
    { query: { queryKey: getListAppointmentsQueryKey({ date: view === "day" ? dateStr : undefined }) } }
  );
  const { data: patients } = useListPatients();
  const { data: catalogTreatments } = useListTreatments();
  const activeTreatments = (catalogTreatments ?? [])
    .filter(t => t.active)
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  const createAppointment = useCreateAppointment();
  const updateAppointment = useUpdateAppointment();
  const deleteAppointment = useDeleteAppointment();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListAppointmentsQueryKey() });

  const navigate = (dir: number) => {
    const d = new Date(currentDate);
    if (view === "day") d.setDate(d.getDate() + dir);
    else d.setDate(d.getDate() + dir * 7);
    setCurrentDate(d);
  };

  const openCreate = () => { setForm({ ...emptyForm, date: dateStr }); setEditingId(null); setDialogOpen(true); };
  const openEdit = (a: any) => {
    setForm({ patientId: String(a.patientId), treatment: a.treatment, date: a.date, startTime: a.startTime, duration: "60", notes: a.notes ?? "", status: a.status });
    setEditingId(a.id);
    setDialogOpen(true);
  };

  const handleSave = () => {
    const data = {
      patientId: parseInt(form.patientId),
      treatment: form.treatment,
      date: form.date,
      startTime: form.startTime,
      duration: parseInt(form.duration),
      notes: form.notes || undefined,
      ...(editingId ? { status: form.status as any } : {}),
    };
    if (editingId) {
      updateAppointment.mutate({ id: editingId, data }, {
        onSuccess: () => { toast({ title: "Cita actualizada" }); setDialogOpen(false); invalidate(); },
        onError: () => toast({ variant: "destructive", title: "Error al actualizar la cita" }),
      });
    } else {
      createAppointment.mutate({ data }, {
        onSuccess: () => { toast({ title: "Cita creada correctamente" }); setDialogOpen(false); invalidate(); },
        onError: (e: any) => toast({ variant: "destructive", title: e?.data?.error === "Time slot conflict" ? "Conflicto de horario: ya hay una cita en ese horario" : "Error al crear la cita" }),
      });
    }
  };

  const apptsByDate: Record<string, any[]> = {};
  for (const a of appointments ?? []) {
    if (!apptsByDate[a.date]) apptsByDate[a.date] = [];
    apptsByDate[a.date].push(a);
  }

  const weekDays: Date[] = [];
  const start = new Date(currentDate);
  start.setDate(start.getDate() - start.getDay() + 1);
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i); weekDays.push(d);
  }

  const formatDateLabel = () => {
    if (view === "day") return currentDate.toLocaleDateString("es-CO", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    return `Semana del ${weekDays[0].toLocaleDateString("es-CO", { day: "numeric", month: "short" })} al ${weekDays[6].toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric" })}`;
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Agenda</h1>
            <p className="text-muted-foreground mt-1">Gestión de citas y disponibilidad</p>
          </div>
          <Button onClick={openCreate} className="bg-primary hover:bg-primary/90">
            <Plus className="h-4 w-4 mr-2" />
            Nueva Cita
          </Button>
        </div>

        <div className="flex items-center justify-between bg-card/80 rounded-xl p-4 border border-border/50 gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}><ChevronLeft className="h-5 w-5" /></Button>
          <p className="font-medium text-sm capitalize text-center">{formatDateLabel()}</p>
          <Button variant="ghost" size="icon" onClick={() => navigate(1)}><ChevronRight className="h-5 w-5" /></Button>
          <div className="flex gap-1 bg-background rounded-lg p-1 ml-auto">
            {(["day", "week", "list"] as const).map(v => (
              <Button key={v} variant={view === v ? "default" : "ghost"} size="sm" onClick={() => setView(v)} className={view === v ? "bg-primary text-primary-foreground" : ""}>
                {v === "day" ? "Día" : v === "week" ? "Semana" : "Lista"}
              </Button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
        ) : view === "day" ? (
          <div className="max-h-[calc(100vh-16rem)] min-h-[12rem] overflow-y-auto space-y-3 pr-1">
            {!(apptsByDate[dateStr]?.length) ? (
              <div className="text-center py-16 text-muted-foreground">
                <p className="font-medium">No hay citas para este día</p>
                <p className="text-sm mt-1">Usa el botón "Nueva Cita" para agendar una</p>
              </div>
            ) : (apptsByDate[dateStr] ?? []).map(a => (
              <Card key={a.id} className="border-border/50 bg-card/80 hover:bg-card transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className="flex flex-col items-center gap-1 w-20">
                        <span className="text-xs font-mono text-accent font-semibold">{to12h(a.startTime)}</span>
                        <div className="w-px h-4 bg-border" />
                        <span className="text-xs font-mono text-muted-foreground">{to12h(a.endTime)}</span>
                      </div>
                      <div>
                        <p className="font-semibold text-foreground">{a.patientName}</p>
                        <p className="text-sm text-muted-foreground">{a.treatment}</p>
                        <p className="text-sm font-medium text-accent mt-0.5">{a.patientPhone}</p>
                        {a.notes && <p className="text-xs text-muted-foreground/70 mt-1 italic">{a.notes}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge className={`text-xs ${statusColors[a.status] ?? ""}`}>{statusLabels[a.status] ?? a.status}</Badge>
                      <Button variant="outline" size="sm" onClick={() => openEdit(a)}>Editar</Button>
                      <Button variant="outline" size="sm" className="text-destructive" onClick={() => deleteAppointment.mutate({ id: a.id }, { onSuccess: () => { toast({ title: "Cita cancelada" }); invalidate(); } })}>Cancelar</Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : view === "list" ? (
          <div className="space-y-4">
            {!(appointments?.length) ? (
              <div className="text-center py-16 text-muted-foreground">
                <p className="font-medium">No hay citas agendadas</p>
              </div>
            ) : (
              <div className="rounded-xl border border-border/50 bg-card/50 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/50 bg-muted/30 text-muted-foreground uppercase text-[10px] tracking-wider">
                      <th className="p-4 text-left font-semibold">Fecha / Hora</th>
                      <th className="p-4 text-left font-semibold">Paciente</th>
                      <th className="p-4 text-left font-semibold">Tratamiento</th>
                      <th className="p-4 text-left font-semibold">Estado</th>
                      <th className="p-4 text-right font-semibold">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {(appointments ?? []).sort((a,b) => b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime)).map(a => (
                      <tr key={a.id} className="hover:bg-accent/5 transition-colors">
                        <td className="p-4">
                          <p className="font-medium">{new Date(a.date).toLocaleDateString("es-CO", { day: "numeric", month: "short" })}</p>
                          <p className="text-xs text-muted-foreground">{to12h(a.startTime)}</p>
                        </td>
                        <td className="p-4">
                          <p className="font-medium">{a.patientName}</p>
                          <p className="text-sm font-semibold text-accent">{a.patientPhone}</p>
                        </td>
                        <td className="p-4 text-muted-foreground">{a.treatment}</td>
                        <td className="p-4">
                          <Badge className={`text-[10px] h-5 ${statusColors[a.status] ?? ""}`}>{statusLabels[a.status] ?? a.status}</Badge>
                        </td>
                        <td className="p-4 text-right space-x-2">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(a)}>Editar</Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:bg-destructive/10"
                            onClick={() => {
                              if (confirm("¿Estás seguro de eliminar esta cita?")) {
                                deleteAppointment.mutate({ id: a.id }, { onSuccess: () => { toast({ title: "Cita eliminada" }); invalidate(); } });
                              }
                            }}
                          >
                            Eliminar
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <div className="flex gap-2 h-[calc(100vh-16rem)] min-h-[20rem] max-h-[calc(100vh-16rem)] overflow-hidden">
            {weekDays.map((day, i) => {
              const ds = formatColombiaDate(day);
              const dayAppts = (apptsByDate[ds] ?? []).sort((a, b) => a.startTime.localeCompare(b.startTime));
              const isToday = ds === todayStr;
              return (
                <div
                  key={i}
                  className={cn(
                    "flex-1 min-w-0 h-full rounded-xl border p-2 flex flex-col overflow-hidden",
                    isToday ? "border-accent/50 bg-accent/5" : "border-border/50 bg-card/50",
                  )}
                >
                  <p className={cn("text-xs font-semibold mb-2 capitalize shrink-0", isToday ? "text-accent" : "text-muted-foreground")}>
                    {day.toLocaleDateString("es-CO", { weekday: "short", day: "numeric", timeZone: "America/Bogota" })}
                    {dayAppts.length > 0 && (
                      <span className="ml-1 text-[10px] font-normal opacity-70">({dayAppts.length})</span>
                    )}
                  </p>
                  <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain space-y-1 pr-1">
                    {dayAppts.length === 0 ? (
                      <p className="text-[10px] text-muted-foreground/50 text-center py-2">Sin citas</p>
                    ) : dayAppts.map(a => (
                      <div
                        key={a.id}
                        className="text-xs p-1.5 rounded-md bg-primary/20 text-primary-foreground/90 cursor-pointer hover:bg-primary/30"
                        onClick={() => openEdit(a)}
                      >
                        <p className="font-semibold truncate">{to12h(a.startTime)}</p>
                        <p className="truncate">{a.patientName}</p>
                        <p className="truncate text-primary-foreground/60">{a.treatment}</p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>{editingId ? "Editar Cita" : "Nueva Cita"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div className="col-span-2 space-y-1">
              <div className="flex justify-between items-center mb-1">
                <Label className="text-sm">Paciente *</Label>
                {form.patientId && (
                  <Badge variant="outline" className="text-sm font-bold text-accent bg-accent/5 border-accent/20 px-3 py-1">
                    📞 {patients?.find(p => String(p.id) === form.patientId)?.phone}
                  </Badge>
                )}
              </div>
              <Popover open={patientOpen} onOpenChange={setPatientOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={patientOpen}
                    className="w-full justify-between bg-background font-normal"
                  >
                    {form.patientId
                      ? patients?.find((p) => String(p.id) === form.patientId)?.name
                      : "Seleccionar paciente..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[400px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Buscar paciente..." />
                    <CommandList>
                      <CommandEmpty>No se encontró ningún paciente.</CommandEmpty>
                      <CommandGroup>
                        {(patients ?? []).map((p) => (
                          <CommandItem
                            key={p.id}
                            value={p.name}
                            onSelect={() => {
                              setForm(f => ({ ...f, patientId: String(p.id) }));
                              setPatientOpen(false);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                form.patientId === String(p.id) ? "opacity-100" : "opacity-0"
                              )}
                            />
                            {p.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="col-span-2 space-y-1">
              <Label>Tratamiento *</Label>
              <Select
                value={form.treatment}
                onValueChange={v => {
                  const selected = activeTreatments.find(t => t.name === v);
                  setForm(f => ({
                    ...f,
                    treatment: v,
                    duration: selected?.duration ? String(selected.duration) : f.duration,
                  }));
                }}
              >
                <SelectTrigger className="bg-background"><SelectValue placeholder="Seleccionar tratamiento" /></SelectTrigger>
                <SelectContent className="max-h-[320px]">
                  {activeTreatments.length ? activeTreatments.map(t => (
                    <SelectItem key={t.id} value={t.name}>
                      <span className="flex flex-col items-start gap-0.5">
                        <span>{t.name}</span>
                        <span className="text-[10px] text-muted-foreground">{formatPriceCop(t.price)} · {t.duration} min</span>
                      </span>
                    </SelectItem>
                  )) : (
                    <SelectItem value="Valoración general">Valoración general</SelectItem>
                  )}
                </SelectContent>
              </Select>
              {form.treatment && (() => {
                const sel = activeTreatments.find(t => t.name === form.treatment);
                return sel ? (
                  <p className="text-xs text-accent">Referencia: {formatPriceCop(sel.price)}</p>
                ) : null;
              })()}
            </div>
            <div className="space-y-1">
              <Label>Fecha *</Label>
              <Input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className="bg-background" />
            </div>
            <div className="space-y-1">
              <Label>Hora</Label>
              <Input
                type="time"
                step={900}
                value={form.startTime}
                onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))}
                className="bg-background"
              />
            </div>
            <div className="space-y-1">
              <Label>Duración</Label>
              <Select value={form.duration} onValueChange={v => setForm(f => ({ ...f, duration: v }))}>
                <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="15">15 minutos</SelectItem>
                  <SelectItem value="30">30 minutos</SelectItem>
                  <SelectItem value="45">45 minutos</SelectItem>
                  <SelectItem value="60">1 hora</SelectItem>
                  <SelectItem value="90">1.5 horas</SelectItem>
                  <SelectItem value="120">2 horas</SelectItem>
                  <SelectItem value="180">3 horas</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {editingId && (
              <div className="space-y-1">
                <Label>Estado</Label>
                <Select value={form.status ?? "scheduled"} onValueChange={v => setForm(f => ({ ...f, status: v }))}>
                  <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(statusLabels).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
            <div className="col-span-2 space-y-1">
              <Label>Notas</Label>
              <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="bg-background" rows={2} placeholder="Observaciones o indicaciones especiales..." />
            </div>
          </div>
          <DialogFooter className="flex justify-between items-center w-full">
            {editingId && (
              <Button
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 mr-auto"
                onClick={() => {
                  if (confirm("¿Estás seguro de eliminar esta cita?")) {
                    deleteAppointment.mutate({ id: editingId }, { onSuccess: () => { toast({ title: "Cita eliminada" }); setDialogOpen(false); invalidate(); } });
                  }
                }}
              >
                Eliminar Cita
              </Button>
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
              <Button onClick={handleSave} disabled={createAppointment.isPending || updateAppointment.isPending} className="bg-primary">
                {editingId ? "Guardar cambios" : "Crear cita"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
