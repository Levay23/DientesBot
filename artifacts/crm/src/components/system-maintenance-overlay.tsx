import { AlertTriangle, CheckCircle2, XCircle, PauseCircle } from "lucide-react";
import ClinicLogo from "@/components/clinic-logo";

const STATUS_ITEMS = [
  { label: "Servidor",      status: "ON",              isOk: true },
  { label: "Base de datos", status: "Límite superado", isOk: false },
  { label: "Hosting",       status: "ON",              isOk: true },
  { label: "Backend",       status: "ON",              isOk: true },
  { label: "Api Key IA",    status: "ON",              isOk: true },
];

export default function SystemMaintenanceOverlay() {
  return (
    <div
      className="fixed inset-0 z-[999999] flex items-center justify-center bg-background/98 backdrop-blur-xl p-4 sm:p-6 select-none"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="maintenance-title"
      aria-describedby="maintenance-desc"
    >
      <div className="max-w-md w-full rounded-2xl border border-destructive/30 bg-card shadow-2xl p-6 sm:p-8 space-y-6 text-center">
        <div className="flex justify-center">
          <ClinicLogo size="md" />
        </div>

        <div className="mx-auto w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center border border-destructive/30 animate-pulse">
          <PauseCircle className="h-9 w-9 text-destructive" />
        </div>

        <div className="space-y-2">
          <h1 id="maintenance-title" className="text-xl font-bold tracking-tight text-foreground">
            Sistema Pausado
          </h1>
          <p id="maintenance-desc" className="text-xs text-muted-foreground">
            Diagnóstico de estado de los servicios del sistema:
          </p>
        </div>

        <div className="rounded-xl border border-border bg-muted/40 p-4 text-left space-y-2.5 text-xs">
          {STATUS_ITEMS.map((item, index) => (
            <div
              key={index}
              className="flex items-center justify-between py-1.5 border-b border-border/40 last:border-0"
            >
              <span className="text-foreground/90 font-medium">
                {item.label}:
              </span>
              <div className="flex items-center gap-1.5">
                {item.isOk ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                      {item.status}
                    </span>
                  </>
                ) : (
                  <>
                    <XCircle className="h-4 w-4 text-destructive shrink-0" />
                    <span className="font-semibold text-destructive">
                      {item.status}
                    </span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-lg bg-destructive/10 border border-destructive/25 p-3 text-xs text-destructive flex items-center gap-2.5 text-left">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <span>
            La base de datos ha alcanzado el límite permitido. Actualice o amplíe el plan para continuar con los servicios.
          </span>
        </div>
      </div>
    </div>
  );
}
