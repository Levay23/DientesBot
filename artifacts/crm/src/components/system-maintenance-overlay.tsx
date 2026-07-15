import { AlertTriangle } from "lucide-react";
import ClinicLogo from "@/components/clinic-logo";
import { MAINTENANCE_MESSAGE, MAINTENANCE_TITLE } from "@/lib/maintenance";

export default function SystemMaintenanceOverlay() {
  return (
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center bg-background/95 backdrop-blur-md p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="maintenance-title"
      aria-describedby="maintenance-desc"
    >
      <div className="max-w-lg w-full rounded-2xl border border-amber-500/40 bg-card shadow-2xl p-8 text-center space-y-5">
        <div className="flex justify-center">
          <ClinicLogo size="md" />
        </div>
        <div className="mx-auto w-14 h-14 rounded-full bg-amber-500/15 flex items-center justify-center">
          <AlertTriangle className="h-8 w-8 text-amber-500" />
        </div>
        <div className="space-y-3">
          <h1 id="maintenance-title" className="text-xl font-bold text-foreground">
            {MAINTENANCE_TITLE}
          </h1>
          <p id="maintenance-desc" className="text-sm text-muted-foreground leading-relaxed">
            {MAINTENANCE_MESSAGE}
          </p>
        </div>
        <p className="text-xs text-muted-foreground/80 pt-2 border-t border-border/50">
          API de IA agotada · Sistema suspendido hasta renovación
        </p>
      </div>
    </div>
  );
}
