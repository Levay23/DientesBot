import Layout from "@/components/layout";
import { useListPatients, useCreatePatient, useUpdatePatient, useDeletePatient, getListPatientsQueryKey } from "@workspace/api-client-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Pencil, Trash2, Phone, Mail, Calendar, ClipboardList } from "lucide-react";
import PatientClinicalDialog from "@/components/patient-clinical-dialog";

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

const statusColors: Record<string, string> = {
  new: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  interested: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  scheduled: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  attended: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  in_treatment: "bg-green-500/20 text-green-300 border-green-500/30",
  completed: "bg-gray-500/20 text-gray-300 border-gray-500/30",
};

const statusLabels: Record<string, string> = {
  new: "Nuevo",
  interested: "Interesado",
  scheduled: "Cita Agendada",
  attended: "Atendido",
  in_treatment: "En Tratamiento",
  completed: "Finalizado",
};

const referralSourceOptions = [
  { value: "Instagram", label: "Instagram" },
  { value: "Facebook", label: "Facebook" },
  { value: "Google", label: "Google" },
  { value: "WhatsApp", label: "WhatsApp" },
  { value: "Referido", label: "Referido" },
  { value: "Diagnóstico de paso", label: "Diagnóstico de paso" },
  { value: "Diagnóstico de volante", label: "Diagnóstico de volante" },
  { value: "Diagnóstico de redes sociales", label: "Diagnóstico de redes sociales" },
  { value: "Otro", label: "Otro" },
] as const;

type PatientForm = {
  name: string;
  phone: string;
  email: string;
  age: string;
  treatment: string;
  status: string;
  notes: string;
  medicalHistory: string;
  treatmentPrice: string;
  neighborhood: string;
  referralSource: string;
  city: string;
};

const emptyForm: PatientForm = {
  name: "", phone: "", email: "", age: "", treatment: "", status: "new", notes: "",
  medicalHistory: "", treatmentPrice: "", neighborhood: "", referralSource: "", city: ""
};


export default function Patients() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [neighborhoodFilter, setNeighborhoodFilter] = useState("");
  const [referralFilter, setReferralFilter] = useState("");
  const [minAgeFilter, setMinAgeFilter] = useState("");
  const [maxAgeFilter, setMaxAgeFilter] = useState("");
  const [cityFilter, setCityFilter] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [clinicalPatient, setClinicalPatient] = useState<any | null>(null);
  const [form, setForm] = useState<PatientForm>(emptyForm);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const params = {
    search: search || undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
    neighborhood: neighborhoodFilter || undefined,
    referralSource: referralFilter || undefined,
    city: cityFilter || undefined,
    minAge: minAgeFilter ? parseInt(minAgeFilter) || undefined : undefined,
    maxAge: maxAgeFilter ? parseInt(maxAgeFilter) || undefined : undefined,
  };

  const { data: patients, isLoading } = useListPatients(params, {
    query: { queryKey: getListPatientsQueryKey(params) }
  });
  const createPatient = useCreatePatient();
  const updatePatient = useUpdatePatient();
  const deletePatient = useDeletePatient();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListPatientsQueryKey() });

  const openCreate = () => { setForm(emptyForm); setEditingId(null); setDialogOpen(true); };
  const openEdit = (p: any) => {
    setForm({
      name: p.name,
      phone: p.phone,
      email: p.email ?? "",
      age: p.age?.toString() ?? "",
      treatment: p.treatment ?? "",
      status: p.status,
      notes: p.notes ?? "",
      medicalHistory: p.medicalHistory ?? "",
      treatmentPrice: p.treatmentPrice?.toString() ?? "",
      neighborhood: p.neighborhood ?? "",
      referralSource: p.referralSource ?? "",
      city: p.city ?? "",
    });
    setEditingId(p.id);
    setDialogOpen(true);
  };


  const handleSave = () => {
    const data = {
      name: form.name,
      phone: form.phone,
      email: form.email || undefined,
      age: form.age ? parseInt(form.age) : undefined,
      treatment: form.treatment || undefined,
      status: form.status as any,
      notes: form.notes || undefined,
      medicalHistory: form.medicalHistory || undefined,
      treatmentPrice: form.treatmentPrice ? parseInt(form.treatmentPrice) : undefined,
      neighborhood: form.neighborhood || undefined,
      referralSource: form.referralSource || undefined,
      city: form.city || undefined,
    };

    if (editingId) {
      updatePatient.mutate({ id: editingId, data }, {
        onSuccess: () => { toast({ title: "Paciente actualizado" }); setDialogOpen(false); invalidate(); },
        onError: () => toast({ variant: "destructive", title: "Error al actualizar el paciente" }),
      });
    } else {
      createPatient.mutate({ data }, {
        onSuccess: () => { toast({ title: "Paciente creado correctamente" }); setDialogOpen(false); invalidate(); },
        onError: () => toast({ variant: "destructive", title: "Error al crear el paciente" }),
      });
    }
  };

  const handleDelete = (id: number) => {
    deletePatient.mutate({ id }, {
      onSuccess: () => { toast({ title: "Paciente eliminado" }); invalidate(); },
    });
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Pacientes</h1>
            <p className="text-muted-foreground mt-1">Gestión y seguimiento de pacientes</p>
          </div>
          <Button onClick={openCreate} className="bg-primary hover:bg-primary/90">
            <Plus className="h-4 w-4 mr-2" />
            Nuevo Paciente
          </Button>
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Buscar por nombre..." className="pl-9 bg-card border-border" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48 bg-card border-border">
              <SelectValue placeholder="Estado" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los estados</SelectItem>
              {Object.entries(statusLabels).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input
            placeholder="Barrio"
            className="w-40 bg-card border-border"
            value={neighborhoodFilter}
            onChange={e => setNeighborhoodFilter(e.target.value)}
          />
          <Select
            value={referralFilter || "all"}
            onValueChange={v => setReferralFilter(v === "all" ? "" : v)}
          >
            <SelectTrigger className="w-40 bg-card border-border">
              <SelectValue placeholder="Cómo llegó" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los orígenes</SelectItem>
              {referralSourceOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Edad mín."
              type="number"
              className="w-24 bg-card border-border"
              value={minAgeFilter}
              onChange={e => setMinAgeFilter(e.target.value)}
            />
            <Input
              placeholder="Edad máx."
              type="number"
              className="w-24 bg-card border-border"
              value={maxAgeFilter}
              onChange={e => setMaxAgeFilter(e.target.value)}
            />
          </div>
          <Input
            placeholder="Ciudad / Ubicación"
            className="w-44 bg-card border-border"
            value={cityFilter}
            onChange={e => setCityFilter(e.target.value)}
          />
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
          </div>
        ) : !Array.isArray(patients) || !patients.length ? (
          <div className="text-center py-16 text-muted-foreground">
            <p className="font-medium">No se encontraron pacientes</p>
            <p className="text-sm mt-1">Agrega el primer paciente con el botón de arriba</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {patients.map(p => (
              <Card key={p.id} className="border-border/50 bg-card/80 hover:bg-card transition-colors">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-semibold text-foreground">{p.name}</h3>
                      {p.treatment && <p className="text-xs text-muted-foreground mt-0.5">{p.treatment}</p>}
                    </div>
                    <Badge className={`text-xs border ${statusColors[p.status] ?? ""}`}>{statusLabels[p.status] ?? p.status}</Badge>
                  </div>
                  <div className="space-y-1.5 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2"><Phone className="h-3.5 w-3.5" />{p.phone}</div>
                    {p.email && <div className="flex items-center gap-2"><Mail className="h-3.5 w-3.5" />{p.email}</div>}
                    {p.nextAppointment && (
                      <div className="flex items-center gap-2 text-accent">
                        <Calendar className="h-3.5 w-3.5" />
                        Próxima cita: {new Date(p.nextAppointment).toLocaleDateString("es-CO")}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 mt-4">
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" className="flex-1" onClick={() => openEdit(p)}>
                        <Pencil className="h-3.5 w-3.5 mr-1" />
                        Editar
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          if (confirm(`¿Estás seguro de eliminar a ${p.name}? Se borrará toda su información y citas.`)) {
                            handleDelete(p.id);
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <Button 
                      variant="secondary" 
                      size="sm" 
                      className="w-full bg-accent/10 text-accent hover:bg-accent/20 border-accent/20"
                      onClick={() => setClinicalPatient(p)}
                    >
                      <ClipboardList className="h-3.5 w-3.5 mr-1" />
                      Ficha Clínica
                    </Button>
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
            <DialogTitle>{editingId ? "Editar Paciente" : "Nuevo Paciente"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div className="col-span-2 space-y-1">
              <Label>Nombre completo *</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="bg-background" placeholder="Ej: Juan Pérez" />
            </div>
            <div className="space-y-1">
              <Label>Teléfono / WhatsApp *</Label>
              <Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="bg-background" placeholder="+57 300 000 0000" />
            </div>
            <div className="space-y-1">
              <Label>Correo electrónico</Label>
              <Input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="bg-background" placeholder="email@ejemplo.com" />
            </div>
            <div className="space-y-1">
              <Label>Edad</Label>
              <Input type="number" value={form.age} onChange={e => setForm(f => ({ ...f, age: e.target.value }))} className="bg-background" placeholder="Ej: 35" />
            </div>
            <div className="space-y-1">
              <Label>Estado</Label>
              <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v }))}>
                <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(statusLabels).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1">
              <Label>Tratamiento de interés</Label>
              <Input value={form.treatment} onChange={e => setForm(f => ({ ...f, treatment: e.target.value }))} className="bg-background" placeholder="Ej: Implantes, Prótesis removible..." />
            </div>
            <div className="space-y-1">
              <Label>Barrio</Label>
              <Input
                value={form.neighborhood}
                onChange={e => setForm(f => ({ ...f, neighborhood: e.target.value }))}
                className="bg-background"
                placeholder="Ej: Laureles"
              />
            </div>
            <div className="space-y-1">
              <Label>Cómo llegó a la clínica</Label>
              <Select
                value={form.referralSource}
                onValueChange={v => setForm(f => ({ ...f, referralSource: v }))}
              >
                <SelectTrigger className="bg-background">
                  <SelectValue placeholder="Selecciona una opción" />
                </SelectTrigger>
                <SelectContent>
                  {referralSourceOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Ciudad / Ubicación</Label>
              <Input
                value={form.city}
                onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
                className="bg-background"
                placeholder="Ej: Medellín"
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>Notas Generales</Label>
              <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="bg-background" rows={2} placeholder="Observaciones generales, preferencias, etc." />
            </div>

            {/* Nueva sección: Plan de Tratamiento */}
            <div className="col-span-2 mt-4 pt-4 border-t border-border/50">
              <h3 className="text-sm font-semibold text-accent mb-3 uppercase tracking-wider">Plan de Tratamiento (Historial Clínico)</h3>
              <div className="space-y-4">
                <div className="space-y-1">
                  <Label>Recomendación del Doctor / Diagnóstico</Label>
                  <Textarea
                    value={form.medicalHistory}
                    onChange={e => setForm(f => ({ ...f, medicalHistory: e.target.value }))}
                    className="bg-background"
                    rows={4}
                    placeholder="Escribe aquí lo que el doctor recomendó en la cita..."
                  />
                </div>
                <div className="space-y-1">
                  <Label>Precio Estimado ($)</Label>
                  <Input
                    type="number"
                    value={form.treatmentPrice}
                    onChange={e => setForm(f => ({ ...f, treatmentPrice: e.target.value }))}
                    className="bg-background"
                    placeholder="Ej: 2500000"
                  />
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={createPatient.isPending || updatePatient.isPending} className="bg-primary">
              {editingId ? "Guardar cambios" : "Crear paciente"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PatientClinicalDialog 
        patient={clinicalPatient} 
        open={!!clinicalPatient} 
        onOpenChange={o => !o && setClinicalPatient(null)} 
      />
    </Layout>

  );
}
