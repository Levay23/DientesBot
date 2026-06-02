import Layout from "@/components/layout";
import { useGetSettings, useUpdateSettings, getGetSettingsQueryKey } from "@workspace/api-client-react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Save, Clock, Bot, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

const DAYS = [
  { id: "monday", label: "Lunes" },
  { id: "tuesday", label: "Martes" },
  { id: "wednesday", label: "Miércoles" },
  { id: "thursday", label: "Jueves" },
  { id: "friday", label: "Viernes" },
  { id: "saturday", label: "Sábado" },
  { id: "sunday", label: "Domingo" },
];

type SettingsForm = {
  clinicName: string;
  clinicPhone: string;
  clinicAddress: string;
  workingHoursStart: string;
  workingHoursEnd: string;
  workingDays: string[];
  defaultAppointmentDuration: string;
  aiGreetingMessage: string;
  aiSignature: string;
  autoConfirmAppointments: boolean;
};

export default function Settings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: settings, isLoading } = useGetSettings();
  const updateSettings = useUpdateSettings();

  const [form, setForm] = useState<SettingsForm>({
    clinicName: "", clinicPhone: "", clinicAddress: "", workingHoursStart: "08:00", workingHoursEnd: "18:00",
    workingDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
    defaultAppointmentDuration: "60", aiGreetingMessage: "", aiSignature: "", autoConfirmAppointments: false,
  });

  useEffect(() => {
    if (settings) {
      setForm({
        clinicName: settings.clinicName ?? "",
        clinicPhone: settings.clinicPhone ?? "",
        clinicAddress: settings.clinicAddress ?? "",
        workingHoursStart: settings.workingHoursStart ?? "08:00",
        workingHoursEnd: settings.workingHoursEnd ?? "18:00",
        workingDays: settings.workingDays ?? [],
        defaultAppointmentDuration: String(settings.defaultAppointmentDuration ?? 60),
        aiGreetingMessage: settings.aiGreetingMessage ?? "",
        aiSignature: settings.aiSignature ?? "",
        autoConfirmAppointments: settings.autoConfirmAppointments ?? false,
      });
    }
  }, [settings]);

  const toggleDay = (day: string) => {
    setForm(f => ({
      ...f,
      workingDays: f.workingDays.includes(day) ? f.workingDays.filter(d => d !== day) : [...f.workingDays, day]
    }));
  };

  const handleSave = () => {
    updateSettings.mutate({
      data: {
        clinicName: form.clinicName,
        clinicPhone: form.clinicPhone || undefined,
        clinicAddress: form.clinicAddress || undefined,
        workingHoursStart: form.workingHoursStart,
        workingHoursEnd: form.workingHoursEnd,
        workingDays: form.workingDays,
        defaultAppointmentDuration: parseInt(form.defaultAppointmentDuration),
        aiGreetingMessage: form.aiGreetingMessage || undefined,
        aiSignature: form.aiSignature || undefined,
        autoConfirmAppointments: form.autoConfirmAppointments,
      }
    }, {
      onSuccess: () => {
        toast({ title: "Configuración guardada correctamente" });
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
      },
      onError: () => toast({ variant: "destructive", title: "Error al guardar la configuración" }),
    });
  };

  return (
    <Layout>
      <div className="space-y-6 max-w-3xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Configuración</h1>
            <p className="text-muted-foreground mt-1">Ajustes generales de la clínica y del sistema</p>
          </div>
          <Button onClick={handleSave} disabled={updateSettings.isPending} className="bg-primary hover:bg-primary/90">
            <Save className="h-4 w-4 mr-2" />
            {updateSettings.isPending ? "Guardando..." : "Guardar cambios"}
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-4">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}</div>
        ) : (
          <div className="space-y-6">
            <Card className="border-border/50 bg-card/80">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Phone className="h-4 w-4 text-accent" />
                  Información de la Clínica
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label>Nombre de la clínica</Label>
                    <Input value={form.clinicName} onChange={e => setForm(f => ({ ...f, clinicName: e.target.value }))} className="bg-background" placeholder="Ej: Dientes Fijos Medellín" />
                  </div>
                  <div className="space-y-1">
                    <Label>Teléfono de contacto</Label>
                    <Input value={form.clinicPhone} onChange={e => setForm(f => ({ ...f, clinicPhone: e.target.value }))} className="bg-background" placeholder="+57 604 000 0000" />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label>Dirección del consultorio (la usa Andrea en WhatsApp)</Label>
                  <Input
                    value={form.clinicAddress}
                    onChange={e => setForm(f => ({ ...f, clinicAddress: e.target.value }))}
                    className="bg-background"
                    placeholder="Calle 51 # 43-05, Centro de Medellín"
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="border-border/50 bg-card/80">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Clock className="h-4 w-4 text-accent" />
                  Horarios de Atención
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <Label>Hora de apertura</Label>
                    <Input type="time" value={form.workingHoursStart} onChange={e => setForm(f => ({ ...f, workingHoursStart: e.target.value }))} className="bg-background" />
                  </div>
                  <div className="space-y-1">
                    <Label>Hora de cierre</Label>
                    <Input type="time" value={form.workingHoursEnd} onChange={e => setForm(f => ({ ...f, workingHoursEnd: e.target.value }))} className="bg-background" />
                  </div>
                  <div className="space-y-1">
                    <Label>Duración de cita (min)</Label>
                    <Input type="number" value={form.defaultAppointmentDuration} onChange={e => setForm(f => ({ ...f, defaultAppointmentDuration: e.target.value }))} className="bg-background" />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Días de atención</Label>
                  <div className="flex flex-wrap gap-2">
                    {DAYS.map(day => (
                      <button
                        key={day.id}
                        onClick={() => toggleDay(day.id)}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
                          form.workingDays.includes(day.id)
                            ? "bg-accent/20 text-accent-foreground border-accent/40"
                            : "bg-background text-muted-foreground border-border hover:border-accent/30"
                        }`}
                      >
                        {day.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={form.autoConfirmAppointments} onCheckedChange={v => setForm(f => ({ ...f, autoConfirmAppointments: v }))} />
                  <Label>Confirmar citas automáticamente al crearlas</Label>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border/50 bg-card/80">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Bot className="h-4 w-4 text-accent" />
                  Asistente de Inteligencia Artificial (Groq / Llama 3.3)
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-3 rounded-lg bg-accent/10 border border-accent/20 text-sm text-accent">
                  La IA usa el modelo <strong>Llama 3.3 70B</strong> a través de Groq para responder mensajes automáticamente en el Chat Center.
                </div>
                <div className="space-y-1">
                  <Label>Mensaje de bienvenida de la IA</Label>
                  <Textarea
                    value={form.aiGreetingMessage}
                    onChange={e => setForm(f => ({ ...f, aiGreetingMessage: e.target.value }))}
                    className="bg-background"
                    rows={3}
                    placeholder="Hola, soy la asistente virtual de la clínica. ¿En qué puedo ayudarte?"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Firma del asistente</Label>
                  <Input
                    value={form.aiSignature}
                    onChange={e => setForm(f => ({ ...f, aiSignature: e.target.value }))}
                    className="bg-background"
                    placeholder="Asistente Virtual - Dientes Fijos Medellín"
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </Layout>
  );
}
