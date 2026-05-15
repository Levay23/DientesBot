import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { 
  useUpdatePatient, 
  useListEvolutionNotes, 
  useCreateEvolutionNote, 
  getListEvolutionNotesQueryKey 
} from "@workspace/api-client-react";

import Odontogram from "./odontogram";
import { useToast } from "@/hooks/use-toast";
import { History, Activity, ClipboardList, Stethoscope } from "lucide-react";

interface PatientClinicalDialogProps {
  patient: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function PatientClinicalDialog({ patient, open, onOpenChange }: PatientClinicalDialogProps) {
  const [odontogram, setOdontogram] = useState<Record<number, any>>(patient?.odontogram || {});
  const [diagnosis, setDiagnosis] = useState(patient?.diagnosis || "");
  const [treatmentPlan, setTreatmentPlan] = useState(patient?.medicalHistory || "");
  const [evolutionNote, setEvolutionNote] = useState("");
  
  const { toast } = useToast();
  const updatePatient = useUpdatePatient();
  const params = { patientId: patient?.id };
  const { data: evolutions, refetch: refetchEvolutions } = useListEvolutionNotes(
    params,
    { query: { enabled: !!patient?.id, queryKey: getListEvolutionNotesQueryKey(params) } }
  );
  const createEvolution = useCreateEvolutionNote();

  useEffect(() => {
    if (patient) {
      setOdontogram(patient.odontogram || {});
      setDiagnosis(patient.diagnosis || "");
      setTreatmentPlan(patient.medicalHistory || "");
    }
  }, [patient]);

  const handleSaveOdontogram = () => {
    updatePatient.mutate({ id: patient.id, data: { odontogram } }, {
      onSuccess: () => toast({ title: "Odontograma guardado" })
    });
  };

  const handleSaveDiagnosis = () => {
    updatePatient.mutate({ id: patient.id, data: { diagnosis } }, {
      onSuccess: () => toast({ title: "Diagnóstico guardado" })
    });
  };

  const handleSavePlan = () => {
    updatePatient.mutate({ id: patient.id, data: { medicalHistory: treatmentPlan } }, {
      onSuccess: () => toast({ title: "Plan de tratamiento guardado" })
    });
  };

  const handleAddEvolution = () => {
    if (!evolutionNote.trim()) return;
    createEvolution.mutate({
      data: { patientId: patient.id, content: evolutionNote, doctorName: "Dr. Admin" }
    }, {
      onSuccess: () => {
        toast({ title: "Evolución registrada" });
        setEvolutionNote("");
        refetchEvolutions();
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl bg-card border-border h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Ficha Clínica: {patient?.name}
            <Badge variant="outline" className="text-[10px] ml-2">Ortodoncia</Badge>
          </DialogTitle>
          <DialogDescription>
            Historial clínico completo, odontograma y notas de evolución del paciente.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="odontogram" className="flex-1 flex flex-col mt-4">
          <TabsList className="grid grid-cols-4 bg-muted/30">
            <TabsTrigger value="odontogram" className="gap-2"><Activity className="h-4 w-4" /> Odontograma</TabsTrigger>
            <TabsTrigger value="diagnosis" className="gap-2"><Stethoscope className="h-4 w-4" /> Diagnóstico</TabsTrigger>
            <TabsTrigger value="plan" className="gap-2"><ClipboardList className="h-4 w-4" /> Plan</TabsTrigger>
            <TabsTrigger value="evolution" className="gap-2"><History className="h-4 w-4" /> Evolución</TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-y-auto mt-4 pr-2">
            <TabsContent value="odontogram" className="m-0 space-y-4">
              <Odontogram 
                data={odontogram} 
                onChange={(id: number, state: any) => setOdontogram(prev => ({ ...prev, [id]: state }))} 
              />
              <div className="flex justify-end">
                <Button onClick={handleSaveOdontogram} disabled={updatePatient.isPending}>Guardar Odontograma</Button>
              </div>
            </TabsContent>

            <TabsContent value="diagnosis" className="m-0 space-y-4">
              <div className="space-y-2">
                <Label>Diagnóstico Clínico General</Label>
                <Textarea 
                  value={diagnosis} 
                  onChange={e => setDiagnosis(e.target.value)} 
                  className="bg-background min-h-[200px]" 
                  placeholder="Describe el estado general y hallazgos..."
                />
              </div>
              <div className="flex justify-end">
                <Button onClick={handleSaveDiagnosis} disabled={updatePatient.isPending}>Guardar Diagnóstico</Button>
              </div>
            </TabsContent>

            <TabsContent value="plan" className="m-0 space-y-4">
              <div className="space-y-2">
                <Label>Plan de Tratamiento Recomendado</Label>
                <Textarea 
                  value={treatmentPlan} 
                  onChange={e => setTreatmentPlan(e.target.value)} 
                  className="bg-background min-h-[200px]" 
                  placeholder="Pasos a seguir para la recuperación dental..."
                />
              </div>
              <div className="flex justify-end">
                <Button onClick={handleSavePlan} disabled={updatePatient.isPending}>Guardar Plan</Button>
              </div>
            </TabsContent>

            <TabsContent value="evolution" className="m-0 space-y-4">
              <div className="space-y-3">
                <Label>Nueva Nota de Evolución</Label>
                <Textarea 
                  value={evolutionNote} 
                  onChange={e => setEvolutionNote(e.target.value)} 
                  className="bg-background" 
                  placeholder="¿Qué se realizó hoy?"
                />
                <Button onClick={handleAddEvolution} disabled={createEvolution.isPending} size="sm" className="bg-accent text-accent-foreground w-full">
                  Registrar Evolución
                </Button>
              </div>

              <div className="space-y-3 mt-8">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Historial de Evolución</Label>
                {evolutions?.map((note: any) => (
                  <div key={note.id} className="p-3 bg-muted/20 rounded-lg border border-border/50 text-sm">
                    <div className="flex justify-between items-start mb-2">
                      <span className="font-semibold text-accent">{note.doctorName || "Dr. Admin"}</span>
                      <span className="text-[10px] text-muted-foreground">{new Date(note.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="text-foreground/80">{note.content}</p>
                  </div>
                ))}
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
